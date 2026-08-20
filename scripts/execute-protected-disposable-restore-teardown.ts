import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from "./check-railway-mutation-boundary.js";

export const PROTECTED_DISPOSABLE_RESTORE_TEARDOWN_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;
export const PROTECTED_DISPOSABLE_RESTORE_TEARDOWN_SCHEMA =
  "pintpath-protected-disposable-restore-teardown/v1" as const;

const POLICY_PATH =
  "ops/railway/protected-disposable-restore-teardown-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const POLICY_SHA256 =
  "63503f6672b847549e5599f853ad6f749631529e48191a6d3a8816b3a97c5209";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const FORBIDDEN_PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const FORBIDDEN_ENVIRONMENT_IDS = new Set([
  "13dab015-df74-45c6-b26f-69323daea99a",
  "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const NAME = /^pintpath-disposable-restore-[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_BYTES = 2 * 1024 * 1024;

export const DISPOSABLE_RESTORE_INVENTORY_QUERY = `query PintPathDisposableRestoreInventory($projectId:String!){
  projectsByIds(ids:[$projectId]){
    id name isTempProject baseEnvironmentId primaryEnvironmentId
    environments(first:100){edges{node{id name projectId isEphemeral serviceInstances(first:100){edges{node{id serviceId serviceName environmentId}}pageInfo{hasNextPage endCursor}} volumeInstances(first:100){edges{node{id serviceId environmentId volume{id name projectId}}}pageInfo{hasNextPage endCursor}}}}pageInfo{hasNextPage endCursor}}
    services(first:100){edges{node{id name projectId}}pageInfo{hasNextPage endCursor}}
    volumes(first:100){edges{node{id name projectId}}pageInfo{hasNextPage endCursor}}
    buckets(first:100){edges{node{id name projectId}}pageInfo{hasNextPage endCursor}}
  }
}`;
export const DISPOSABLE_RESTORE_DELETE_MUTATION = `mutation PintPathDeleteDisposableRestore($projectId:String!){projectDelete(id:$projectId)}`;

interface Args {
  readonly candidateSha: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly inventorySha256: string;
  readonly evidenceDir: string;
}
interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly writeDurable: (
    directory: string,
    leaf: string,
    source: string,
  ) => string;
  readonly writeOutput: (source: string) => void;
  readonly runBoundary: () => Promise<boolean>;
}
interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  targetNotProtected: boolean;
  credentialsExact: boolean;
  metadataAuthoritiesAgree: boolean;
  inventoryExact: boolean;
  boundaryPreflightExact: boolean;
  durableIntentExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  targetAbsentExact: boolean;
  boundaryPostflightExact: boolean;
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
function exact(
  value: unknown,
  names: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === names.length &&
    names.every((name, index) => Object.keys(value)[index] === name)
  );
}
function page(value: unknown): value is Record<string, unknown> {
  return (
    exact(value, ["hasNextPage", "endCursor"]) &&
    value.hasNextPage === false &&
    (value.endCursor === null || typeof value.endCursor === "string")
  );
}
function privateWrite(directory: string, leaf: string, source: string): string {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("evidence_invalid");
  const handle = fs.openSync(
    path.join(directory, leaf),
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(handle, source, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return sha256(source);
}
function parseArgs(argv: readonly string[]): Args | null {
  if (argv.length !== 14) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index],
      value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) return null;
    values.set(key, value);
  }
  const candidateSha = values.get("--candidate-sha") ?? "",
    projectId = values.get("--project-id") ?? "",
    projectName = values.get("--project-name") ?? "",
    environmentId = values.get("--environment-id") ?? "",
    environmentName = values.get("--environment-name") ?? "",
    inventorySha256 = values.get("--inventory-sha256") ?? "",
    evidenceDir = values.get("--evidence-dir") ?? "";
  if (
    values.size !== 7 ||
    !SHA.test(candidateSha) ||
    !UUID.test(projectId) ||
    !NAME.test(projectName) ||
    !UUID.test(environmentId) ||
    !NAME.test(environmentName) ||
    !SHA256.test(inventorySha256) ||
    !path.isAbsolute(evidenceDir)
  )
    return null;
  return {
    candidateSha,
    projectId,
    projectName,
    environmentId,
    environmentName,
    inventorySha256,
    evidenceDir,
  };
}
function policyExact(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    if (sha256(source) !== POLICY_SHA256) return false;
    const value = JSON.parse(source.toString("utf8")) as unknown;
    return (
      exact(value, [
        "schemaVersion",
        "policyId",
        "activationState",
        "githubEnvironment",
        "requiredGitRef",
        "forbiddenProjectId",
        "forbiddenEnvironmentIds",
        "targetContract",
        "mutationBoundary",
        "providerContract",
        "evidence",
      ]) &&
      value.schemaVersion ===
        "pintpath-protected-disposable-restore-teardown-policy/v1" &&
      value.policyId === "pintpath-disposable-restore-project-teardown" &&
      value.activationState === PROTECTED_DISPOSABLE_RESTORE_TEARDOWN_STATE &&
      value.githubEnvironment === "disposable-restore-teardown" &&
      value.requiredGitRef === "refs/heads/main" &&
      value.forbiddenProjectId === FORBIDDEN_PROJECT_ID &&
      JSON.stringify(value.forbiddenEnvironmentIds) ===
        JSON.stringify([...FORBIDDEN_ENVIRONMENT_IDS]) &&
      exact(value.targetContract, [
        "separateProjectRequired",
        "projectNamePrefix",
        "exactlyOneEnvironmentRequired",
        "ephemeralEnvironmentRequired",
        "completeInventorySha256Required",
        "allConnectionPaginationMustBeComplete",
      ]) &&
      value.targetContract.separateProjectRequired === true &&
      value.targetContract.projectNamePrefix ===
        "pintpath-disposable-restore-" &&
      value.targetContract.exactlyOneEnvironmentRequired === true &&
      value.targetContract.ephemeralEnvironmentRequired === true &&
      value.targetContract.completeInventorySha256Required === true &&
      value.targetContract.allConnectionPaginationMustBeComplete === true &&
      exact(value.mutationBoundary, [
        "policyPath",
        "policySha256",
        "immediatePreflightRequired",
        "unconditionalPostflightRequired",
      ]) &&
      value.mutationBoundary.policyPath === BOUNDARY_POLICY_PATH &&
      value.mutationBoundary.policySha256 ===
        "9392f0c605dec43657d4d3a5a6ce40d57fe9beb70fce5ff496bb1a5f2fed3fed" &&
      value.mutationBoundary.immediatePreflightRequired === true &&
      value.mutationBoundary.unconditionalPostflightRequired === true &&
      exact(value.providerContract, [
        "graphqlEndpoint",
        "railwayCliSchemaVersion",
        "railwayCliSchemaSha256",
        "mutation",
        "maximumAttempts",
        "automaticRetriesAllowed",
        "rerunsAllowed",
        "unconditionalPostflightRequired",
        "ambiguousOutcomeAction",
      ]) &&
      value.providerContract.graphqlEndpoint === ENDPOINT &&
      value.providerContract.railwayCliSchemaVersion === "5.32.0" &&
      value.providerContract.railwayCliSchemaSha256 ===
        "89530486d77ed677586554085d4ff67e8ae6d3c44a6825d67c94320d4a083285" &&
      value.providerContract.mutation === "projectDelete" &&
      value.providerContract.maximumAttempts === 1 &&
      value.providerContract.automaticRetriesAllowed === false &&
      value.providerContract.rerunsAllowed === false &&
      value.providerContract.unconditionalPostflightRequired === true &&
      value.providerContract.ambiguousOutcomeAction ===
        "READ_ONLY_RECONCILIATION_STOP_NO_RETRY" &&
      exact(value.evidence, [
        "durableIntentRequiredBeforeWrite",
        "terminalEvidenceRequired",
        "providerCredentialsAllowedInEvidence",
        "secretDerivedCommitmentsAllowed",
      ]) &&
      value.evidence.durableIntentRequiredBeforeWrite === true &&
      value.evidence.terminalEvidenceRequired === true &&
      value.evidence.providerCredentialsAllowedInEvidence === false &&
      value.evidence.secretDerivedCommitmentsAllowed === false
    );
  } catch {
    return false;
  }
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
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await response.text();
  if (!response.ok || Buffer.byteLength(source) > MAX_BYTES)
    throw new Error("provider_invalid");
  return JSON.parse(source) as unknown;
}
function sorted<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.sort((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  );
}
function inventory(value: unknown, args: Args): Record<string, unknown> | null {
  if (
    !exact(value, ["data"]) ||
    !exact(value.data, ["projectsByIds"]) ||
    !Array.isArray(value.data.projectsByIds) ||
    value.data.projectsByIds.length !== 1
  )
    return null;
  const project = value.data.projectsByIds[0];
  if (
    !exact(project, [
      "id",
      "name",
      "isTempProject",
      "baseEnvironmentId",
      "primaryEnvironmentId",
      "environments",
      "services",
      "volumes",
      "buckets",
    ]) ||
    project.id !== args.projectId ||
    project.name !== args.projectName ||
    project.isTempProject !== true ||
    project.baseEnvironmentId !== args.environmentId ||
    project.primaryEnvironmentId !== args.environmentId ||
    !exact(project.environments, ["edges", "pageInfo"]) ||
    !page(project.environments.pageInfo) ||
    !Array.isArray(project.environments.edges) ||
    project.environments.edges.length !== 1
  )
    return null;
  for (const name of ["services", "volumes", "buckets"]) {
    const connection = project[name];
    if (
      !exact(connection, ["edges", "pageInfo"]) ||
      !page(connection.pageInfo) ||
      !Array.isArray(connection.edges) ||
      connection.edges.length > 100
    )
      return null;
  }
  const environmentEdge = project.environments.edges[0];
  if (!exact(environmentEdge, ["node"])) return null;
  const environment = environmentEdge.node;
  if (
    !exact(environment, [
      "id",
      "name",
      "projectId",
      "isEphemeral",
      "serviceInstances",
      "volumeInstances",
    ]) ||
    environment.id !== args.environmentId ||
    environment.name !== args.environmentName ||
    environment.projectId !== args.projectId ||
    environment.isEphemeral !== true
  )
    return null;
  for (const name of ["serviceInstances", "volumeInstances"]) {
    const connection = environment[name];
    if (
      !exact(connection, ["edges", "pageInfo"]) ||
      !page(connection.pageInfo) ||
      !Array.isArray(connection.edges) ||
      connection.edges.length > 100
    )
      return null;
  }
  const normalize = (
    connection: Record<string, unknown>,
    kind:
      | "service"
      | "volume"
      | "bucket"
      | "serviceInstance"
      | "volumeInstance",
  ): Record<string, unknown>[] => {
    const result: Record<string, unknown>[] = [];
    for (const edge of connection.edges as unknown[]) {
      if (!exact(edge, ["node"]) || !record(edge.node))
        throw new Error("inventory_invalid");
      const node = edge.node;
      if (
        kind === "service" &&
        (!exact(node, ["id", "name", "projectId"]) ||
          !UUID.test(String(node.id)) ||
          node.projectId !== args.projectId ||
          typeof node.name !== "string")
      )
        throw new Error("inventory_invalid");
      if (
        (kind === "volume" || kind === "bucket") &&
        (!exact(node, ["id", "name", "projectId"]) ||
          !UUID.test(String(node.id)) ||
          node.projectId !== args.projectId ||
          typeof node.name !== "string")
      )
        throw new Error("inventory_invalid");
      if (
        kind === "serviceInstance" &&
        (!exact(node, ["id", "serviceId", "serviceName", "environmentId"]) ||
          !UUID.test(String(node.id)) ||
          !UUID.test(String(node.serviceId)) ||
          node.environmentId !== args.environmentId ||
          typeof node.serviceName !== "string")
      )
        throw new Error("inventory_invalid");
      if (
        kind === "volumeInstance" &&
        (!exact(node, ["id", "serviceId", "environmentId", "volume"]) ||
          !UUID.test(String(node.id)) ||
          !UUID.test(String(node.serviceId)) ||
          node.environmentId !== args.environmentId ||
          !exact(node.volume, ["id", "name", "projectId"]) ||
          !UUID.test(String(node.volume.id)) ||
          node.volume.projectId !== args.projectId ||
          typeof node.volume.name !== "string")
      )
        throw new Error("inventory_invalid");
      result.push(node);
    }
    return sorted(result);
  };
  try {
    const services = normalize(
        project.services as Record<string, unknown>,
        "service",
      ),
      volumes = normalize(project.volumes as Record<string, unknown>, "volume"),
      buckets = normalize(project.buckets as Record<string, unknown>, "bucket"),
      serviceInstances = normalize(
        environment.serviceInstances as Record<string, unknown>,
        "serviceInstance",
      ),
      volumeInstances = normalize(
        environment.volumeInstances as Record<string, unknown>,
        "volumeInstance",
      );
    const serviceIds = new Set(services.map((node) => node.id)),
      volumeIds = new Set(volumes.map((node) => node.id));
    if (
      serviceInstances.some((node) => !serviceIds.has(node.serviceId)) ||
      volumeInstances.some(
        (node) =>
          !serviceIds.has(node.serviceId) ||
          !record(node.volume) ||
          !volumeIds.has(node.volume.id),
      )
    )
      return null;
    return {
      project: {
        id: project.id,
        name: project.name,
        isTempProject: project.isTempProject,
        baseEnvironmentId: project.baseEnvironmentId,
        primaryEnvironmentId: project.primaryEnvironmentId,
      },
      environment: {
        id: environment.id,
        name: environment.name,
        projectId: environment.projectId,
        isEphemeral: true,
      },
      services,
      volumes,
      buckets,
      serviceInstances,
      volumeInstances,
    };
  } catch {
    return null;
  }
}
function absent(value: unknown): boolean {
  return (
    exact(value, ["data"]) &&
    exact(value.data, ["projectsByIds"]) &&
    Array.isArray(value.data.projectsByIds) &&
    value.data.projectsByIds.length === 0
  );
}
async function defaultBoundary(
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  let output = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", BOUNDARY_POLICY_PATH],
    env,
    writeOutput: (source) => {
      output += source;
    },
  });
  try {
    return (
      code === 0 &&
      (JSON.parse(output) as Record<string, unknown>).outcome === "passed"
    );
  } catch {
    return false;
  }
}
function checks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    targetNotProtected: false,
    credentialsExact: false,
    metadataAuthoritiesAgree: false,
    inventoryExact: false,
    boundaryPreflightExact: false,
    durableIntentExact: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    targetAbsentExact: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}
function receipt(
  args: Args | null,
  outcome:
    | "deleted"
    | "failed_before_attempt"
    | "mutation_uncertain"
    | "blocked",
  attempts: 0 | 1,
  intent: string | null,
  terminal: string | null,
  state: Checks,
) {
  return {
    schemaVersion: PROTECTED_DISPOSABLE_RESTORE_TEARDOWN_SCHEMA,
    executorState: PROTECTED_DISPOSABLE_RESTORE_TEARDOWN_STATE,
    outcome,
    attempts,
    retryAllowed: false,
    candidateSha: args?.candidateSha ?? null,
    projectId: args?.projectId ?? null,
    environmentId: args?.environmentId ?? null,
    expectedInventorySha256: args?.inventorySha256 ?? null,
    intentSha256: intent,
    terminalEvidenceSha256: terminal,
    checks: state,
  };
}

export async function runProtectedDisposableRestoreTeardown(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    writeDurable: privateWrite,
    writeOutput: (source) => process.stdout.write(source),
    runBoundary: () => defaultBoundary(process.env),
    ...overrides,
  };
  const args = parseArgs(dependencies.argv),
    state = checks();
  let attempts: 0 | 1 = 0,
    intentSha: string | null = null,
    terminalSha: string | null = null,
    outcome:
      | "deleted"
      | "failed_before_attempt"
      | "mutation_uncertain"
      | "blocked" = "blocked";
  let metadataToken = "";
  let before: Record<string, unknown> | null = null;
  try {
    state.policyExact = policyExact(dependencies.cwd);
    state.githubAuthorityExact =
      args !== null &&
      dependencies.env.GITHUB_REF === "refs/heads/main" &&
      dependencies.env.GITHUB_SHA === args.candidateSha &&
      dependencies.env.GITHUB_RUN_ATTEMPT === "1" &&
      dependencies.env.PINTPATH_RESTORE_TEARDOWN_CONFIRMATION ===
        `DELETE_${args.projectId}`;
    state.targetNotProtected =
      args !== null &&
      args.projectId !== FORBIDDEN_PROJECT_ID &&
      !FORBIDDEN_ENVIRONMENT_IDS.has(args.environmentId) &&
      args.projectName === args.environmentName;
    if (
      !args ||
      !state.policyExact ||
      !state.githubAuthorityExact ||
      !state.targetNotProtected
    )
      throw new Error("authority_invalid");
    metadataToken =
      dependencies.env.PINTPATH_RAILWAY_RESTORE_METADATA_TOKEN ?? "";
    const deleteToken =
      dependencies.env.PINTPATH_RAILWAY_RESTORE_DELETE_TOKEN ?? "";
    state.credentialsExact =
      TOKEN.test(metadataToken) &&
      TOKEN.test(deleteToken) &&
      metadataToken !== deleteToken;
    if (!state.credentialsExact) throw new Error("credentials_invalid");
    const [metadataView, deleteView] = await Promise.all([
      call(
        dependencies.fetchImpl,
        metadataToken,
        DISPOSABLE_RESTORE_INVENTORY_QUERY,
        { projectId: args.projectId },
      ),
      call(
        dependencies.fetchImpl,
        deleteToken,
        DISPOSABLE_RESTORE_INVENTORY_QUERY,
        { projectId: args.projectId },
      ),
    ]);
    before = inventory(metadataView, args);
    const deleteBefore = inventory(deleteView, args);
    state.metadataAuthoritiesAgree =
      before !== null &&
      deleteBefore !== null &&
      canonical(before) === canonical(deleteBefore);
    state.inventoryExact =
      before !== null && sha256(canonical(before)) === args.inventorySha256;
    state.boundaryPreflightExact = await dependencies.runBoundary();
    if (
      !state.metadataAuthoritiesAgree ||
      !state.inventoryExact ||
      !state.boundaryPreflightExact
    )
      throw new Error("inventory_invalid");
    const intent = canonical({
      schemaVersion: "pintpath-protected-disposable-restore-teardown-intent/v1",
      candidateSha: args.candidateSha,
      projectId: args.projectId,
      environmentId: args.environmentId,
      inventorySha256: args.inventorySha256,
      operation: "projectDelete",
      maximumAttempts: 1,
      retryAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    intentSha = dependencies.writeDurable(
      args.evidenceDir,
      "intent.json",
      intent,
    );
    state.durableIntentExact = intentSha === sha256(intent);
    if (!state.durableIntentExact) throw new Error("intent_invalid");
    attempts = 1;
    try {
      const result = await call(
        dependencies.fetchImpl,
        deleteToken,
        DISPOSABLE_RESTORE_DELETE_MUTATION,
        { projectId: args.projectId },
      );
      state.acknowledgementExact =
        exact(result, ["data"]) &&
        exact(result.data, ["projectDelete"]) &&
        result.data.projectDelete === true;
    } catch {
      state.acknowledgementExact = false;
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    if (attempts === 1 && args) {
      state.postflightAttempted = true;
      try {
        state.targetAbsentExact = absent(
          await call(
            dependencies.fetchImpl,
            metadataToken,
            DISPOSABLE_RESTORE_INVENTORY_QUERY,
            { projectId: args.projectId },
          ),
        );
      } catch {
        state.targetAbsentExact = false;
      }
      outcome =
        state.acknowledgementExact && state.targetAbsentExact
          ? "deleted"
          : "mutation_uncertain";
      try {
        state.boundaryPostflightExact = await dependencies.runBoundary();
      } catch {
        state.boundaryPostflightExact = false;
      }
      if (!state.boundaryPostflightExact) outcome = "mutation_uncertain";
    }
  }
  const provisional = receipt(args, outcome, attempts, intentSha, null, state);
  if (args && state.durableIntentExact) {
    try {
      const terminal = canonical({
        schemaVersion:
          "pintpath-protected-disposable-restore-teardown-terminal/v1",
        receipt: provisional,
      });
      terminalSha = dependencies.writeDurable(
        args.evidenceDir,
        "terminal.json",
        terminal,
      );
      state.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      state.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  dependencies.writeOutput(
    `${JSON.stringify(receipt(args, outcome, attempts, intentSha, terminalSha, state))}\n`,
  );
  return outcome === "deleted" && state.terminalEvidenceExact ? 0 : 1;
}

export const protectedDisposableRestoreTeardownInternals = {
  parseArgs,
  inventory,
  absent,
  policyExact,
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProtectedDisposableRestoreTeardown();
}
