import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";

export const PROTECTED_STAGING_VARIABLE_MUTATION_SCHEMA =
  "pintpath-permanent-staging-variable-mutation/v1" as const;
export const PROTECTED_STAGING_VARIABLE_MUTATION_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const APPLICATION_SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const CANARY_SERVICE_ID = "34a312cd-0920-4a7e-90db-8561c1e0746b";
const POLICY_PATH = "ops/railway/permanent-staging-variable-mutation-policy.json";
const BOUNDARY_POLICY_PATH = "ops/railway/production-staging-mutation-policy.json";
const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,220}$/;
const SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9_-]{20,220}$/;

export const PROTECTED_STAGING_VARIABLE_MUTATION_QUERY = `mutation PintPathProtectedVariableCollectionUpsert(
  $projectId: String!
  $serviceId: String!
  $environmentId: String!
  $variables: EnvironmentVariables!
  $skipDeploys: Boolean
) {
  variableCollectionUpsert(input: {
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
    variables: $variables
    skipDeploys: $skipDeploys
  })
}`;

export const PROTECTED_STAGING_VARIABLE_METADATA_QUERY = `query PintPathProtectedVariableMetadata(
  $projectId: String!
  $environmentId: String!
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    variables(first: 100) {
      edges { node { id name environmentId serviceId isSealed references } }
      pageInfo { hasNextPage endCursor }
    }
  }
  staged: environmentStagedChanges(environmentId: $environmentId) {
    environmentId
    patch(decryptVariables: false)
  }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    id
    serviceId
    environmentId
    numReplicas
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
  }
}`;

export const PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY =
  `query PintPathProtectedVariableTokenScope { projectToken { projectId environmentId } }`;

const PROVIDER_OPERATIONS = Object.freeze({
  "provider-google-maps-api-key": "GOOGLE_MAPS_API_KEY",
  "provider-google-maps-map-id": "GOOGLE_MAPS_MAP_ID",
  "provider-google-places-api-key": "GOOGLE_PLACES_API_KEY",
  "provider-openai-api-key": "OPENAI_API_KEY",
} as const);

type ProviderOperation = keyof typeof PROVIDER_OPERATIONS;
export type ProtectedStagingVariableOperation =
  | ProviderOperation
  | "supabase-key-replacement";

interface VariableRow {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly string[];
}

interface MetadataSnapshot {
  readonly environmentId: string;
  readonly variables: readonly VariableRow[];
  readonly stagedPatchEmpty: boolean;
  readonly serviceInstance: {
    readonly id: string;
    readonly serviceId: string;
    readonly environmentId: string;
    readonly numReplicas: number;
    readonly latestDeployment: {
      readonly id: string;
      readonly status: string;
      readonly deploymentStopped: boolean;
      readonly snapshotId: string;
    };
    readonly activeDeployments: readonly {
      readonly id: string;
      readonly status: string;
      readonly deploymentStopped: boolean;
    }[];
  };
}

interface MutationReceipt {
  readonly schemaVersion: typeof PROTECTED_STAGING_VARIABLE_MUTATION_SCHEMA;
  readonly executorState: typeof PROTECTED_STAGING_VARIABLE_MUTATION_STATE;
  readonly operation: ProtectedStagingVariableOperation | null;
  readonly outcome:
    | "acknowledged_pending_runtime_proof"
    | "blocked"
    | "failed_before_attempt"
    | "mutation_uncertain";
  readonly candidateSha: string | null;
  readonly attempts: 0 | 1;
  readonly retryAllowed: false;
  readonly intentSha256: string | null;
  readonly terminalEvidenceSha256: string | null;
  readonly checks: {
    policyExact: boolean;
    githubAuthorityExact: boolean;
    tokenScopesExact: boolean;
    boundaryPreflightExact: boolean;
    targetPreflightExact: boolean;
    durableIntentExact: boolean;
    mutationAttemptedAtMostOnce: boolean;
    acknowledgementExact: boolean;
    postflightAttempted: boolean;
    targetPostflightExact: boolean;
    deploymentUnchanged: boolean;
    boundaryPostflightExact: boolean;
    inputZeroized: boolean;
    terminalEvidenceExact: boolean;
  };
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly boundaryCheck: () => Promise<0 | 1>;
  readonly readSecretFile: (filename: string) => Buffer;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plainRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key, index) => Object.keys(value)[index] === key);
}

function parseArguments(argv: readonly string[]): {
  operation: ProtectedStagingVariableOperation;
  valueFiles: readonly string[];
  evidenceDirectory: string;
} | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) return null;
    values.set(key, value);
  }
  const operation = values.get("--operation") as ProtectedStagingVariableOperation;
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const allowed = new Set([
    "--operation",
    "--evidence-dir",
    "--value-file",
    "--publishable-key-file",
    "--secret-key-file",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))
    || !path.isAbsolute(evidenceDirectory)) return null;
  if (operation === "supabase-key-replacement") {
    const publishable = values.get("--publishable-key-file");
    const secret = values.get("--secret-key-file");
    if (!publishable || !secret || values.has("--value-file")) return null;
    return { operation, evidenceDirectory, valueFiles: [publishable, secret] };
  }
  if (!Object.hasOwn(PROVIDER_OPERATIONS, operation)) return null;
  const value = values.get("--value-file");
  if (!value || values.has("--publishable-key-file") || values.has("--secret-key-file")) {
    return null;
  }
  return { operation, evidenceDirectory, valueFiles: [value] };
}

function readPrivateSecretFile(filename: string): Buffer {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 4096,
      requireOwner: true,
      requirePrivate: true,
    });
  } catch {
    throw new Error("secret_file_invalid");
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

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength)
    || Number(contentLength) > MAX_RESPONSE_BYTES)) throw new Error("provider_response_invalid");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_response_invalid");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("provider_response_invalid");
    }
    chunks.push(next.value);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(source) as unknown;
}

async function graphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !/^application\/json(?:;|$)/i.test(
    response.headers.get("content-type") ?? "",
  )) throw new Error("provider_response_invalid");
  return await readBoundedJson(response);
}

function parseScope(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["projectToken"])
    && exactKeys(value.data.projectToken, ["projectId", "environmentId"])
    && value.data.projectToken.projectId === PROJECT_ID
    && value.data.projectToken.environmentId === STAGING_ENVIRONMENT_ID;
}

function parseVariable(value: unknown): VariableRow | null {
  if (!exactKeys(value, ["id", "name", "environmentId", "serviceId", "isSealed", "references"])
    || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256
    || typeof value.name !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.name)
    || value.environmentId !== STAGING_ENVIRONMENT_ID
    || !(value.serviceId === null || typeof value.serviceId === "string" && UUID_PATTERN.test(value.serviceId))
    || typeof value.isSealed !== "boolean" || !Array.isArray(value.references)
    || value.references.length > 100
    || !value.references.every((entry) => typeof entry === "string"
      && entry.length >= 1 && entry.length <= 512 && !/[\r\n\0]/.test(entry))) return null;
  return {
    id: value.id,
    name: value.name,
    environmentId: value.environmentId as string,
    serviceId: value.serviceId as string | null,
    isSealed: value.isSealed,
    references: [...value.references].sort() as string[],
  };
}

function validDeployment(value: unknown, detailed: boolean): boolean {
  const keys = detailed
    ? ["id", "status", "deploymentStopped", "snapshotId"]
    : ["id", "status", "deploymentStopped"];
  return exactKeys(value, keys)
    && typeof value.id === "string" && UUID_PATTERN.test(value.id)
    && typeof value.status === "string" && /^[A-Z_]{1,32}$/.test(value.status)
    && typeof value.deploymentStopped === "boolean"
    && (!detailed || typeof value.snapshotId === "string" && UUID_PATTERN.test(value.snapshotId));
}

function parseMetadata(value: unknown): MetadataSnapshot | null {
  if (!exactKeys(value, ["data"])
    || !exactKeys(value.data, ["environment", "staged", "serviceInstance"])) return null;
  const { environment, staged, serviceInstance } = value.data;
  if (!exactKeys(environment, ["id", "variables"])
    || environment.id !== STAGING_ENVIRONMENT_ID
    || !exactKeys(environment.variables, ["edges", "pageInfo"])
    || !Array.isArray(environment.variables.edges)
    || environment.variables.edges.length > 100
    || !exactKeys(environment.variables.pageInfo, ["hasNextPage", "endCursor"])
    || environment.variables.pageInfo.hasNextPage !== false
    || !(environment.variables.pageInfo.endCursor === null
      || typeof environment.variables.pageInfo.endCursor === "string")
    || !exactKeys(staged, ["environmentId", "patch"])
    || staged.environmentId !== STAGING_ENVIRONMENT_ID
    || !plainRecord(staged.patch) || Object.keys(staged.patch).length !== 0
    || !exactKeys(serviceInstance, [
      "id", "serviceId", "environmentId", "numReplicas", "latestDeployment", "activeDeployments",
    ])
    || typeof serviceInstance.id !== "string" || !UUID_PATTERN.test(serviceInstance.id)
    || serviceInstance.serviceId !== APPLICATION_SERVICE_ID
    || serviceInstance.environmentId !== STAGING_ENVIRONMENT_ID
    || typeof serviceInstance.numReplicas !== "number"
    || !Number.isSafeInteger(serviceInstance.numReplicas)
    || serviceInstance.numReplicas < 1 || serviceInstance.numReplicas > 8
    || !validDeployment(serviceInstance.latestDeployment, true)
    || !Array.isArray(serviceInstance.activeDeployments)
    || serviceInstance.activeDeployments.length < 1
    || serviceInstance.activeDeployments.length > 100
    || !serviceInstance.activeDeployments.every((row: unknown) => validDeployment(row, false))) {
    return null;
  }
  const variables: VariableRow[] = [];
  for (const edge of environment.variables.edges) {
    if (!exactKeys(edge, ["node"])) return null;
    const row = parseVariable(edge.node);
    if (!row) return null;
    variables.push(row);
  }
  variables.sort((left, right) => `${left.serviceId}:${left.name}`.localeCompare(
    `${right.serviceId}:${right.name}`,
  ));
  if (new Set(variables.map((row) => `${row.serviceId}:${row.name}`)).size
    !== variables.length) return null;
  return {
    environmentId: STAGING_ENVIRONMENT_ID,
    variables,
    stagedPatchEmpty: true,
    serviceInstance: structuredClone(serviceInstance) as MetadataSnapshot["serviceInstance"],
  };
}

function relevantRows(snapshot: MetadataSnapshot, names: readonly string[]): VariableRow[] {
  return snapshot.variables.filter((row) => names.includes(row.name));
}

function providerPreflightExact(snapshot: MetadataSnapshot, variableName: string): boolean {
  return relevantRows(snapshot, [variableName]).length === 0;
}

function providerPostflightExact(
  before: MetadataSnapshot,
  after: MetadataSnapshot,
  variableName: string,
): boolean {
  const created = relevantRows(after, [variableName]);
  const beforeOthers = before.variables.filter((row) => row.name !== variableName);
  const afterOthers = after.variables.filter((row) => row.name !== variableName);
  return created.length === 1
    && created[0]?.serviceId === APPLICATION_SERVICE_ID
    && created[0].isSealed === false
    && created[0].references.length === 0
    && JSON.stringify(beforeOthers) === JSON.stringify(afterOthers);
}

function supabaseMetadataExact(snapshot: MetadataSnapshot): boolean {
  const names = ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  const rows = relevantRows(snapshot, names);
  if (rows.length !== 4) return false;
  return names.every((name) => {
    const named = rows.filter((row) => row.name === name);
    const target = named.find((row) => row.serviceId === APPLICATION_SERVICE_ID);
    const reference = named.find((row) => row.serviceId === CANARY_SERVICE_ID);
    return named.length === 2 && target !== undefined && reference !== undefined
      && target.references.length === 0
      && target.isSealed === (name === "SUPABASE_SERVICE_ROLE_KEY")
      && reference.isSealed === target.isSealed
      && reference.references.length === 1
      && (reference.references[0] === `${APPLICATION_SERVICE_ID}.${name}`
        || reference.references[0] === name);
  });
}

function parseAcknowledgement(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["variableCollectionUpsert"])
    && value.data.variableCollectionUpsert === true;
}

function secretStrings(
  operation: ProtectedStagingVariableOperation,
  buffers: readonly Buffer[],
): Record<string, string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const strings = buffers.map((buffer) => decoder.decode(buffer));
  if (strings.some((value) => value.length < 1 || /[\u0000-\u001f\u007f]/.test(value)
    || value !== value.trim())) throw new Error("secret_input_invalid");
  if (operation === "supabase-key-replacement") {
    if (!PUBLISHABLE_KEY_PATTERN.test(strings[0] ?? "")
      || !SECRET_KEY_PATTERN.test(strings[1] ?? "")
      || strings[0] === strings[1]) throw new Error("secret_input_invalid");
    return {
      SUPABASE_ANON_KEY: strings[0]!,
      SUPABASE_SERVICE_ROLE_KEY: strings[1]!,
    };
  }
  return { [PROVIDER_OPERATIONS[operation as ProviderOperation]]: strings[0]! };
}

function emptyChecks(): MutationReceipt["checks"] {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    tokenScopesExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    durableIntentExact: false,
    mutationAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    targetPostflightExact: false,
    deploymentUnchanged: false,
    boundaryPostflightExact: false,
    inputZeroized: false,
    terminalEvidenceExact: false,
  };
}

function policyExact(cwd: string): boolean {
  try {
    const policy = JSON.parse(fs.readFileSync(path.resolve(cwd, POLICY_PATH), "utf8")) as unknown;
    return exactKeys(policy, [
      "schemaVersion", "policyId", "activationState", "projectId",
      "productionEnvironmentId", "stagingEnvironmentId", "applicationServiceId",
      "supabaseCanaryServiceId", "githubEnvironment", "requiredGitRef",
      "operations", "mutation", "evidence",
    ])
      && policy.schemaVersion === "pintpath-permanent-staging-variable-mutation-policy/v1"
      && policy.activationState === PROTECTED_STAGING_VARIABLE_MUTATION_STATE
      && policy.projectId === PROJECT_ID
      && policy.productionEnvironmentId === PRODUCTION_ENVIRONMENT_ID
      && policy.stagingEnvironmentId === STAGING_ENVIRONMENT_ID
      && policy.applicationServiceId === APPLICATION_SERVICE_ID
      && policy.supabaseCanaryServiceId === CANARY_SERVICE_ID
      && policy.githubEnvironment === "permanent-staging-provider-mutation"
      && policy.requiredGitRef === "refs/heads/main";
  } catch {
    return false;
  }
}

function fixedReceipt(
  operation: ProtectedStagingVariableOperation | null,
  outcome: MutationReceipt["outcome"],
  candidateSha: string | null,
  attempts: 0 | 1,
  intentSha256: string | null,
  terminalEvidenceSha256: string | null,
  checks: MutationReceipt["checks"],
): MutationReceipt {
  return {
    schemaVersion: PROTECTED_STAGING_VARIABLE_MUTATION_SCHEMA,
    executorState: PROTECTED_STAGING_VARIABLE_MUTATION_STATE,
    operation,
    outcome,
    candidateSha,
    attempts,
    retryAllowed: false,
    intentSha256,
    terminalEvidenceSha256,
    checks,
  };
}

export async function runProtectedPermanentStagingVariableMutation(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    boundaryCheck: () => runRailwayMutationBoundaryCheck({
      argv: ["--policy", BOUNDARY_POLICY_PATH],
    }),
    readSecretFile: readPrivateSecretFile,
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  const checks = emptyChecks();
  let operation: ProtectedStagingVariableOperation | null = args?.operation ?? null;
  let candidateSha: string | null = null;
  let attempts: 0 | 1 = 0;
  let intentSha: string | null = null;
  let terminalSha: string | null = null;
  let outcome: MutationReceipt["outcome"] = "blocked";
  let buffers: Buffer[] = [];
  let before: MetadataSnapshot | null = null;
  let variables: Record<string, string> | null = null;
  let metadataToken = "";
  try {
    checks.policyExact = policyExact(dependencies.cwd);
    candidateSha = dependencies.env.GITHUB_SHA ?? null;
    const confirmation = operation
      ? `MUTATE_${operation.toUpperCase().replaceAll("-", "_")}_IN_PERMANENT_STAGING`
      : "";
    checks.githubAuthorityExact = dependencies.env.GITHUB_REF === "refs/heads/main"
      && candidateSha !== null && SHA_PATTERN.test(candidateSha)
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && dependencies.env.PINTPATH_MUTATION_CONFIRMATION === confirmation;
    if (!args || !checks.policyExact || !checks.githubAuthorityExact) {
      throw new Error("authority_invalid");
    }
    const activeOperation = args.operation;
    const mutationToken = dependencies.env.PINTPATH_RAILWAY_STAGING_MUTATION_TOKEN ?? "";
    metadataToken = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    if (!TOKEN_PATTERN.test(mutationToken) || !TOKEN_PATTERN.test(metadataToken)
      || mutationToken === metadataToken) throw new Error("token_invalid");
    const [mutationScope, metadataScope] = await Promise.all([
      graphql(dependencies.fetchImpl, mutationToken,
        PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY, {}),
      graphql(dependencies.fetchImpl, metadataToken,
        PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY, {}),
    ]);
    checks.tokenScopesExact = parseScope(mutationScope) && parseScope(metadataScope);
    if (!checks.tokenScopesExact) throw new Error("token_scope_invalid");
    checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
    if (!checks.boundaryPreflightExact) throw new Error("boundary_invalid");
    before = parseMetadata(await graphql(
      dependencies.fetchImpl,
      metadataToken,
      PROTECTED_STAGING_VARIABLE_METADATA_QUERY,
      {
        projectId: PROJECT_ID,
        environmentId: STAGING_ENVIRONMENT_ID,
        serviceId: APPLICATION_SERVICE_ID,
      },
    ));
    const variableName = activeOperation === "supabase-key-replacement"
      ? null
      : PROVIDER_OPERATIONS[activeOperation as ProviderOperation];
    checks.targetPreflightExact = before !== null && before.stagedPatchEmpty
      && (activeOperation === "supabase-key-replacement"
        ? supabaseMetadataExact(before)
        : providerPreflightExact(before, variableName!));
    if (!checks.targetPreflightExact || !before) throw new Error("target_invalid");
    buffers = args.valueFiles.map((filename) => dependencies.readSecretFile(filename));
    variables = secretStrings(activeOperation, buffers);
    const intent = canonical({
      schemaVersion: "pintpath-permanent-staging-variable-mutation-intent/v1",
      operation: activeOperation,
      candidateSha,
      projectId: PROJECT_ID,
      environmentId: STAGING_ENVIRONMENT_ID,
      serviceId: APPLICATION_SERVICE_ID,
      variableNames: Object.keys(variables),
      mutation: "variableCollectionUpsert",
      skipDeploys: true,
      maximumAttempts: 1,
      retryAllowed: false,
      inputByteLengths: buffers.map((value) => value.byteLength),
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
      preflightMetadataSha256: sha256(canonical(before)),
    });
    intentSha = dependencies.writeDurable(args.evidenceDirectory, "intent.json", intent);
    checks.durableIntentExact = intentSha === sha256(intent);
    if (!checks.durableIntentExact) throw new Error("intent_invalid");
    attempts = 1;
    let acknowledgement: unknown = null;
    try {
      acknowledgement = await graphql(
        dependencies.fetchImpl,
        mutationToken,
        PROTECTED_STAGING_VARIABLE_MUTATION_QUERY,
        {
          projectId: PROJECT_ID,
          environmentId: STAGING_ENVIRONMENT_ID,
          serviceId: APPLICATION_SERVICE_ID,
          variables,
          skipDeploys: true,
        },
      );
      checks.acknowledgementExact = parseAcknowledgement(acknowledgement);
    } catch {
      checks.acknowledgementExact = false;
    }
    variables = null;
    for (const buffer of buffers) buffer.fill(0);
    checks.inputZeroized = buffers.every((buffer) => buffer.every((byte) => byte === 0));
    checks.postflightAttempted = true;
    let after: MetadataSnapshot | null = null;
    try {
      after = parseMetadata(await graphql(
        dependencies.fetchImpl,
        metadataToken,
        PROTECTED_STAGING_VARIABLE_METADATA_QUERY,
        {
          projectId: PROJECT_ID,
          environmentId: STAGING_ENVIRONMENT_ID,
          serviceId: APPLICATION_SERVICE_ID,
        },
      ));
    } catch {
      after = null;
    }
    checks.deploymentUnchanged = after !== null
      && JSON.stringify(before.serviceInstance) === JSON.stringify(after.serviceInstance);
    checks.targetPostflightExact = after !== null && after.stagedPatchEmpty
      && (activeOperation === "supabase-key-replacement"
        ? supabaseMetadataExact(after)
          && JSON.stringify(before.variables) === JSON.stringify(after.variables)
        : providerPostflightExact(before, after, variableName!));
    try {
      checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
    } catch {
      checks.boundaryPostflightExact = false;
    }
    outcome = checks.acknowledgementExact && checks.targetPostflightExact
      && checks.deploymentUnchanged && checks.boundaryPostflightExact
      && checks.inputZeroized
      ? "acknowledged_pending_runtime_proof"
      : "mutation_uncertain";
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    variables = null;
    for (const buffer of buffers) buffer.fill(0);
    if (buffers.length > 0) {
      checks.inputZeroized = buffers.every((buffer) => buffer.every((byte) => byte === 0));
    }
    if (attempts === 1 && !checks.postflightAttempted) {
      checks.postflightAttempted = true;
      let after: MetadataSnapshot | null = null;
      try {
        after = parseMetadata(await graphql(
          dependencies.fetchImpl,
          metadataToken,
          PROTECTED_STAGING_VARIABLE_METADATA_QUERY,
          {
            projectId: PROJECT_ID,
            environmentId: STAGING_ENVIRONMENT_ID,
            serviceId: APPLICATION_SERVICE_ID,
          },
        ));
      } catch { after = null; }
      if (before && operation) {
        const variableName = operation === "supabase-key-replacement"
          ? null
          : PROVIDER_OPERATIONS[operation as ProviderOperation];
        checks.targetPostflightExact = after !== null && after.stagedPatchEmpty
          && (operation === "supabase-key-replacement"
            ? supabaseMetadataExact(after)
              && JSON.stringify(before.variables) === JSON.stringify(after.variables)
            : providerPostflightExact(before, after, variableName!));
        checks.deploymentUnchanged = after !== null
          && JSON.stringify(before.serviceInstance) === JSON.stringify(after.serviceInstance);
      }
    }
    if (checks.boundaryPreflightExact && !checks.boundaryPostflightExact) {
      try {
        checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
    }
  }
  const provisional = fixedReceipt(
    operation,
    outcome,
    candidateSha,
    attempts,
    intentSha,
    null,
    checks,
  );
  if (args && checks.durableIntentExact) {
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-permanent-staging-variable-mutation-terminal/v1",
        receipt: provisional,
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
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
  const receipt = fixedReceipt(
    operation,
    outcome,
    candidateSha,
    attempts,
    intentSha,
    terminalSha,
    checks,
  );
  dependencies.writeOutput(`${JSON.stringify(receipt)}\n`);
  return receipt.outcome === "acknowledged_pending_runtime_proof"
    && receipt.checks.terminalEvidenceExact ? 0 : 1;
}

export const protectedPermanentStagingVariableMutationInternals = {
  parseAcknowledgement,
  parseArguments,
  parseMetadata,
  parseScope,
  providerPostflightExact,
  providerPreflightExact,
  secretStrings,
  supabaseMetadataExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingVariableMutation();
}
