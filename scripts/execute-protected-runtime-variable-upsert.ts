import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

import { runRailwayMutationBoundaryCheck } from "./check-railway-mutation-boundary.js";

export const PROTECTED_RUNTIME_VARIABLE_SCHEMA =
  "pintpath-protected-runtime-variable-upsert/v1" as const;
export const PROTECTED_RUNTIME_VARIABLE_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const TARGETS = Object.freeze({
  "permanent-staging": Object.freeze({
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    forbiddenEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    githubEnvironment: "permanent-staging-provider-mutation",
  }),
  production: Object.freeze({
    environmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    forbiddenEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    githubEnvironment: "production-runtime-configuration",
  }),
} as const);
const ALLOWED_VARIABLES = Object.freeze([
  "DATABASE_URL",
  "DATABASE_MAINTENANCE_URL",
  "PINTPATH_POSTGRES_ROOT_CA_PEM",
  "PINTPATH_POSTGRES_ROOT_CA_DER_SHA256",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_MAPS_MAP_ID",
  "GOOGLE_PLACES_API_KEY",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REDIS_URL",
  "RESEND_TRANSACTIONAL_API_KEY",
  "RESEND_WEBHOOK_SIGNING_SECRET",
  "SOURCE_EVIDENCE_SIGNING_SECRET",
  "ACCOUNT_DELETION_NOTICE_KEYRING_JSON",
] as const);
const POLICY_PATH = "ops/railway/protected-runtime-variable-policy.json";
const POLICY_SHA256 =
  "0f4d958c85027433ae4747987f9e26499d022c5b2cc1543c765007346a2862fe";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 1024 * 1024;

export const PROTECTED_RUNTIME_VARIABLE_MUTATION = `mutation PintPathProtectedRuntimeVariable(
  $projectId: String!
  $serviceId: String!
  $environmentId: String!
  $variables: EnvironmentVariables!
  $skipDeploys: Boolean
) {
  variableCollectionUpsert(input: {projectId:$projectId,serviceId:$serviceId,environmentId:$environmentId,variables:$variables,skipDeploys:$skipDeploys})
}`;
export const PROTECTED_RUNTIME_VARIABLE_METADATA = `query PintPathProtectedRuntimeVariableMetadata(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
) {
  environment(id:$environmentId,projectId:$projectId) {
    id
    variables(first:100) {
      edges { node { id name environmentId serviceId isSealed references } }
      pageInfo { hasNextPage endCursor }
    }
  }
  staged: environmentStagedChanges(environmentId:$environmentId) {
    environmentId
    patch(decryptVariables:false)
  }
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
    id
    serviceId
    environmentId
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
  }
}`;
export const PROTECTED_RUNTIME_VARIABLE_SCOPE = `query PintPathProtectedRuntimeVariableScope { projectToken { projectId environmentId } }`;

type TargetName = keyof typeof TARGETS;
type AllowedVariable = (typeof ALLOWED_VARIABLES)[number];

interface Row {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly string[];
}

interface Snapshot {
  readonly environmentId: string;
  readonly rows: readonly Row[];
  readonly patchEmpty: true;
  readonly deploymentCanonical: string;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly boundaryCheck: () => Promise<0 | 1>;
  readonly readValue: (filename: string) => Buffer;
  readonly writeDurable: (
    directory: string,
    leaf: string,
    source: string,
  ) => string;
  readonly writeOutput: (source: string) => void;
}

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  tokenScopesExact: boolean;
  boundaryPreflightExact: boolean;
  targetPreflightExact: boolean;
  durableIntentExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  targetPostflightExact: boolean;
  deploymentUnchanged: boolean;
  boundaryPostflightExact: boolean;
  inputZeroized: boolean;
  terminalEvidenceExact: boolean;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key)
  );
}
function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    tokenScopesExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    durableIntentExact: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    targetPostflightExact: false,
    deploymentUnchanged: false,
    boundaryPostflightExact: false,
    inputZeroized: false,
    terminalEvidenceExact: false,
  };
}

function argumentsExact(argv: readonly string[]): {
  target: TargetName;
  variableName: AllowedVariable;
  valueFile: string;
  evidenceDirectory: string;
  candidateSha: string;
} | null {
  if (argv.length !== 10) return null;
  const map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (
      !argv[index]?.startsWith("--") ||
      !argv[index + 1] ||
      map.has(argv[index]!)
    )
      return null;
    map.set(argv[index]!, argv[index + 1]!);
  }
  const target = map.get("--target") as TargetName;
  const variableName = map.get("--variable") as AllowedVariable;
  const valueFile = map.get("--value-file") ?? "";
  const evidenceDirectory = map.get("--evidence-dir") ?? "";
  const candidateSha = map.get("--candidate-sha") ?? "";
  return Object.hasOwn(TARGETS, target) &&
    ALLOWED_VARIABLES.includes(variableName) &&
    path.isAbsolute(valueFile) &&
    path.isAbsolute(evidenceDirectory) &&
    SHA_PATTERN.test(candidateSha)
    ? { target, variableName, valueFile, evidenceDirectory, candidateSha }
    : null;
}

function privateRead(filename: string): Buffer {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 65536,
      requireOwner: true,
      requirePrivate: true,
    });
  } catch {
    throw new Error("value_file_invalid");
  }
}

function durableWrite(directory: string, leaf: string, source: string): string {
  try {
    writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  } catch {
    throw new Error("evidence_invalid");
  }
  return sha256(source);
}

async function call(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await response.text();
  if (!response.ok || Buffer.byteLength(source) > MAX_BYTES)
    throw new Error("provider_invalid");
  return JSON.parse(source) as unknown;
}

function scopeExact(value: unknown, environmentId: string): boolean {
  return (
    keys(value, ["data"]) &&
    keys(value.data, ["projectToken"]) &&
    keys(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === PROJECT_ID &&
    value.data.projectToken.environmentId === environmentId
  );
}

function row(value: unknown, environmentId: string): Row | null {
  if (
    !keys(value, [
      "id",
      "name",
      "environmentId",
      "serviceId",
      "isSealed",
      "references",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    typeof value.name !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.name) ||
    value.environmentId !== environmentId ||
    !(
      value.serviceId === null ||
      (typeof value.serviceId === "string" &&
        UUID_PATTERN.test(value.serviceId))
    ) ||
    typeof value.isSealed !== "boolean" ||
    !Array.isArray(value.references) ||
    !value.references.every(
      (item) => typeof item === "string" && item.length <= 512,
    )
  )
    return null;
  return {
    id: value.id,
    name: value.name,
    environmentId,
    serviceId: value.serviceId as string | null,
    isSealed: value.isSealed,
    references: [...value.references].sort() as string[],
  };
}

function snapshot(value: unknown, environmentId: string): Snapshot | null {
  if (
    !keys(value, ["data"]) ||
    !keys(value.data, ["environment", "staged", "serviceInstance"])
  )
    return null;
  const environment = value.data.environment;
  const staged = value.data.staged;
  const instance = value.data.serviceInstance;
  if (
    !keys(environment, ["id", "variables"]) ||
    environment.id !== environmentId ||
    !keys(environment.variables, ["edges", "pageInfo"]) ||
    !Array.isArray(environment.variables.edges) ||
    environment.variables.edges.length > 100 ||
    !keys(environment.variables.pageInfo, ["hasNextPage", "endCursor"]) ||
    environment.variables.pageInfo.hasNextPage !== false ||
    !keys(staged, ["environmentId", "patch"]) ||
    staged.environmentId !== environmentId ||
    !record(staged.patch) ||
    Object.keys(staged.patch).length !== 0 ||
    !keys(instance, [
      "id",
      "serviceId",
      "environmentId",
      "latestDeployment",
      "activeDeployments",
    ]) ||
    typeof instance.id !== "string" ||
    !UUID_PATTERN.test(instance.id) ||
    instance.serviceId !== SERVICE_ID ||
    instance.environmentId !== environmentId ||
    !record(instance.latestDeployment) ||
    !Array.isArray(instance.activeDeployments)
  )
    return null;
  const rows: Row[] = [];
  for (const edge of environment.variables.edges) {
    if (!keys(edge, ["node"])) return null;
    const parsed = row(edge.node, environmentId);
    if (!parsed) return null;
    rows.push(parsed);
  }
  rows.sort((left, right) =>
    `${left.serviceId}:${left.name}`.localeCompare(
      `${right.serviceId}:${right.name}`,
    ),
  );
  if (
    new Set(rows.map((item) => `${item.serviceId}:${item.name}`)).size !==
    rows.length
  )
    return null;
  return {
    environmentId,
    rows,
    patchEmpty: true,
    deploymentCanonical: canonical(instance),
  };
}

function targetBeforeExact(before: Snapshot, variableName: string): boolean {
  const rows = before.rows.filter((item) => item.name === variableName);
  return (
    rows.length === 0 ||
    (rows.length === 1 &&
      rows[0]?.serviceId === SERVICE_ID &&
      rows[0].references.length === 0)
  );
}

function targetAfterExact(
  before: Snapshot,
  after: Snapshot,
  variableName: string,
): boolean {
  const beforeTarget = before.rows.filter((item) => item.name === variableName);
  const afterTarget = after.rows.filter((item) => item.name === variableName);
  const beforeOthers = before.rows.filter((item) => item.name !== variableName);
  const afterOthers = after.rows.filter((item) => item.name !== variableName);
  return (
    beforeTarget.length <= 1 &&
    afterTarget.length === 1 &&
    afterTarget[0]?.serviceId === SERVICE_ID &&
    afterTarget[0].references.length === 0 &&
    JSON.stringify(beforeOthers) === JSON.stringify(afterOthers)
  );
}

function policyExact(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    if (sha256(source) !== POLICY_SHA256) return false;
    const value = JSON.parse(source.toString("utf8")) as unknown;
    return (
      keys(value, [
        "schemaVersion",
        "policyId",
        "activationState",
        "projectId",
        "serviceId",
        "targets",
        "allowedVariables",
        "mutation",
        "evidence",
      ]) &&
      value.schemaVersion === "pintpath-protected-runtime-variable-policy/v1" &&
      value.activationState === PROTECTED_RUNTIME_VARIABLE_STATE &&
      value.projectId === PROJECT_ID &&
      value.serviceId === SERVICE_ID &&
      Array.isArray(value.allowedVariables) &&
      JSON.stringify(value.allowedVariables) === JSON.stringify(ALLOWED_VARIABLES)
    );
  } catch {
    return false;
  }
}

function fixed(
  target: TargetName | null,
  variableName: AllowedVariable | null,
  outcome:
    | "updated"
    | "failed_before_attempt"
    | "mutation_uncertain"
    | "blocked",
  attempts: 0 | 1,
  candidateSha: string | null,
  intentSha256: string | null,
  terminalEvidenceSha256: string | null,
  checks: Checks,
) {
  return {
    schemaVersion: PROTECTED_RUNTIME_VARIABLE_SCHEMA,
    executorState: PROTECTED_RUNTIME_VARIABLE_STATE,
    target,
    variableName,
    outcome,
    attempts,
    retryAllowed: false as const,
    candidateSha,
    intentSha256,
    terminalEvidenceSha256,
    checks,
  };
}

export async function runProtectedRuntimeVariableUpsert(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    boundaryCheck: () =>
      runRailwayMutationBoundaryCheck({
        argv: ["--policy", BOUNDARY_POLICY_PATH],
      }),
    readValue: privateRead,
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = argumentsExact(dependencies.argv);
  const checks = emptyChecks();
  let attempts: 0 | 1 = 0;
  let intentSha: string | null = null;
  let terminalSha: string | null = null;
  let outcome:
    | "updated"
    | "failed_before_attempt"
    | "mutation_uncertain"
    | "blocked" = "blocked";
  let held: Buffer | null = null;
  let before: Snapshot | null = null;
  let metadataToken = "";
  let activeTarget: (typeof TARGETS)[TargetName] | null = null;
  try {
    checks.policyExact = policyExact(dependencies.cwd);
    const target = args ? TARGETS[args.target] : null;
    activeTarget = target;
    checks.githubAuthorityExact =
      args !== null &&
      target !== null &&
      dependencies.env.GITHUB_REF === "refs/heads/main" &&
      dependencies.env.GITHUB_SHA === args.candidateSha &&
      dependencies.env.GITHUB_RUN_ATTEMPT === "1" &&
      dependencies.env.PINTPATH_RUNTIME_VARIABLE_CONFIRMATION ===
        `UPSERT_${args.variableName}_IN_${args.target.toUpperCase().replaceAll("-", "_")}`;
    if (!args || !target || !checks.policyExact || !checks.githubAuthorityExact)
      throw new Error("authority_invalid");
    metadataToken =
      dependencies.env.PINTPATH_RAILWAY_TARGET_METADATA_TOKEN ?? "";
    const mutationToken =
      dependencies.env.PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN ?? "";
    if (
      !TOKEN_PATTERN.test(metadataToken) ||
      !TOKEN_PATTERN.test(mutationToken) ||
      metadataToken === mutationToken
    )
      throw new Error("token_invalid");
    const [metadataScope, mutationScope] = await Promise.all([
      call(
        dependencies.fetchImpl,
        metadataToken,
        PROTECTED_RUNTIME_VARIABLE_SCOPE,
        {},
      ),
      call(
        dependencies.fetchImpl,
        mutationToken,
        PROTECTED_RUNTIME_VARIABLE_SCOPE,
        {},
      ),
    ]);
    checks.tokenScopesExact =
      scopeExact(metadataScope, target.environmentId) &&
      scopeExact(mutationScope, target.environmentId);
    checks.boundaryPreflightExact = (await dependencies.boundaryCheck()) === 0;
    if (!checks.tokenScopesExact || !checks.boundaryPreflightExact)
      throw new Error("preflight_invalid");
    before = snapshot(
      await call(
        dependencies.fetchImpl,
        metadataToken,
        PROTECTED_RUNTIME_VARIABLE_METADATA,
        {
          projectId: PROJECT_ID,
          environmentId: target.environmentId,
          serviceId: SERVICE_ID,
        },
      ),
      target.environmentId,
    );
    checks.targetPreflightExact =
      before !== null && targetBeforeExact(before, args.variableName);
    if (!before || !checks.targetPreflightExact)
      throw new Error("target_invalid");
    held = dependencies.readValue(args.valueFile);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(held);
    const multilinePem = args.variableName === "PINTPATH_POSTGRES_ROOT_CA_PEM";
    const canonicalPem = multilinePem && decoded.endsWith("\n")
      ? decoded.slice(0, -1)
      : decoded;
    if (
      decoded.length < 1 ||
      decoded.length > 65536 ||
      (multilinePem
        ? canonicalPem !== canonicalPem.trim()
        : decoded !== decoded.trim()) ||
      (multilinePem
        ? /[\u0000\r\u000b\u000c\u007f]/.test(decoded)
          || !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----$/.test(canonicalPem)
        : /[\u0000-\u001f\u007f]/.test(decoded))
    )
      throw new Error("value_invalid");
    const intent = canonical({
      schemaVersion: "pintpath-protected-runtime-variable-intent/v1",
      target: args.target,
      variableName: args.variableName,
      candidateSha: args.candidateSha,
      projectId: PROJECT_ID,
      environmentId: target.environmentId,
      serviceId: SERVICE_ID,
      operationName: "variableCollectionUpsert",
      skipDeploys: true,
      maximumAttempts: 1,
      retryAllowed: false,
      valueByteLength: held.byteLength,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
      preflightMetadataSha256: sha256(canonical(before)),
    });
    intentSha = dependencies.writeDurable(
      args.evidenceDirectory,
      "intent.json",
      intent,
    );
    checks.durableIntentExact = intentSha === sha256(intent);
    if (!checks.durableIntentExact) throw new Error("intent_invalid");
    attempts = 1;
    let acknowledged = false;
    try {
      const mutation = await call(
        dependencies.fetchImpl,
        mutationToken,
        PROTECTED_RUNTIME_VARIABLE_MUTATION,
        {
          projectId: PROJECT_ID,
          serviceId: SERVICE_ID,
          environmentId: target.environmentId,
          variables: { [args.variableName]: decoded },
          skipDeploys: true,
        },
      );
      acknowledged =
        keys(mutation, ["data"]) &&
        keys(mutation.data, ["variableCollectionUpsert"]) &&
        mutation.data.variableCollectionUpsert === true;
    } catch {
      acknowledged = false;
    }
    checks.acknowledgementExact = acknowledged;
    held.fill(0);
    checks.inputZeroized = held.every((byte) => byte === 0);
    checks.postflightAttempted = true;
    let after: Snapshot | null = null;
    try {
      after = snapshot(
        await call(
          dependencies.fetchImpl,
          metadataToken,
          PROTECTED_RUNTIME_VARIABLE_METADATA,
          {
            projectId: PROJECT_ID,
            environmentId: target.environmentId,
            serviceId: SERVICE_ID,
          },
        ),
        target.environmentId,
      );
    } catch {
      after = null;
    }
    checks.targetPostflightExact =
      after !== null && targetAfterExact(before, after, args.variableName);
    checks.deploymentUnchanged =
      after !== null &&
      before.deploymentCanonical === after.deploymentCanonical;
    try {
      checks.boundaryPostflightExact =
        (await dependencies.boundaryCheck()) === 0;
    } catch {
      checks.boundaryPostflightExact = false;
    }
    outcome =
      checks.acknowledgementExact &&
      checks.targetPostflightExact &&
      checks.deploymentUnchanged &&
      checks.boundaryPostflightExact &&
      checks.inputZeroized
        ? "updated"
        : "mutation_uncertain";
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    if (held) {
      held.fill(0);
      checks.inputZeroized = held.every((byte) => byte === 0);
    }
    if (
      attempts === 1 &&
      !checks.postflightAttempted &&
      args &&
      activeTarget &&
      before
    ) {
      checks.postflightAttempted = true;
      let after: Snapshot | null = null;
      try {
        after = snapshot(
          await call(
            dependencies.fetchImpl,
            metadataToken,
            PROTECTED_RUNTIME_VARIABLE_METADATA,
            {
              projectId: PROJECT_ID,
              environmentId: activeTarget.environmentId,
              serviceId: SERVICE_ID,
            },
          ),
          activeTarget.environmentId,
        );
      } catch {
        after = null;
      }
      checks.targetPostflightExact =
        after !== null && targetAfterExact(before, after, args.variableName);
      checks.deploymentUnchanged =
        after !== null &&
        before.deploymentCanonical === after.deploymentCanonical;
    }
    if (checks.boundaryPreflightExact && !checks.boundaryPostflightExact) {
      try {
        checks.boundaryPostflightExact =
          (await dependencies.boundaryCheck()) === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
    }
  }
  const provisional = fixed(
    args?.target ?? null,
    args?.variableName ?? null,
    outcome,
    attempts,
    args?.candidateSha ?? null,
    intentSha,
    null,
    checks,
  );
  if (args && checks.durableIntentExact) {
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-protected-runtime-variable-terminal/v1",
        receipt: provisional,
        secretMaterialIncluded: false,
      });
      terminalSha = dependencies.writeDurable(
        args.evidenceDirectory,
        "terminal.json",
        terminal,
      );
      checks.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  const receipt = fixed(
    args?.target ?? null,
    args?.variableName ?? null,
    outcome,
    attempts,
    args?.candidateSha ?? null,
    intentSha,
    terminalSha,
    checks,
  );
  dependencies.writeOutput(`${JSON.stringify(receipt)}\n`);
  return outcome === "updated" && checks.terminalEvidenceExact ? 0 : 1;
}

export const protectedRuntimeVariableInternals = {
  argumentsExact,
  scopeExact,
  snapshot,
  targetBeforeExact,
  targetAfterExact,
  policyExact,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProtectedRuntimeVariableUpsert();
}
