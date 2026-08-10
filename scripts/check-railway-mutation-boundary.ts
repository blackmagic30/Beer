import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RAILWAY_MUTATION_POLICY_ID,
  emptyRailwayMutationBoundaryChecks,
  evaluateRailwayMutationBoundary,
  parseRailwayMutationPolicy,
  type RailwayEnvironmentBoundary,
  type RailwayMutationBoundaryChecks,
  type RailwayMutationPolicy,
  type RailwayProjectTokenScope,
  type RailwayProductionDeploymentBoundary,
} from "./lib/railway-environment-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const RAILWAY_ENVIRONMENT_MUTATION_BOUNDARY_QUERY = `query PintPathRailwayEnvironmentMutationBoundary(
  $projectId: String!
  $environmentId: String!
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
  }
  staged: environmentStagedChanges(environmentId: $environmentId) {
    id
    environmentId
    status
    createdAt
    updatedAt
    appliedAt
    message
    patch(decryptVariables: false)
  }
}`;

export const RAILWAY_PROJECT_TOKEN_SCOPE_QUERY = `query PintPathRailwayProjectTokenScope {
  projectToken {
    project {
      id
    }
    environment {
      id
    }
  }
}`;

export const RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY = `query PintPathRailwayProductionPostgresPin(
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    id
    serviceId
    environmentId
    source {
      image
      repo
    }
    latestDeployment {
      id
      status
      deploymentStopped
      snapshotId
    }
    activeDeployments {
      id
      status
      deploymentStopped
    }
  }
  approvedDeployment: deployment(id: $deploymentId) {
    id
    projectId
    environmentId
    serviceId
    snapshotId
    meta
  }
}`;

export const RAILWAY_MUTATION_BOUNDARY_RECEIPT_SCHEMA =
  "pintpath-railway-mutation-boundary-readiness/v1" as const;

const PRODUCTION_TOKEN_NAME =
  "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN" as const;
const STAGING_TOKEN_NAME =
  "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN" as const;
const RAILWAY_GRAPHQL_ENDPOINT =
  "https://backboard.railway.com/graphql/v2" as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const QUERY_TIMEOUT_MS = 20_000;

interface BoundaryReceipt {
  readonly schemaVersion: typeof RAILWAY_MUTATION_BOUNDARY_RECEIPT_SCHEMA;
  readonly policy: typeof RAILWAY_MUTATION_POLICY_ID | "invalid";
  readonly mode: "read-only-boundary" | "invalid";
  readonly outcome: "passed" | "failed";
  readonly checks: RailwayMutationBoundaryChecks;
}

interface EnvironmentVariables {
  readonly projectId: string;
  readonly environmentId: string;
}

interface PostgresVariables {
  readonly environmentId: string;
  readonly serviceId: string;
  readonly deploymentId: string;
}

interface BoundaryDependencies {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl: typeof fetch;
  readPolicy: (filename: string) => string;
  queryEnvironment: (
    variables: EnvironmentVariables,
    tokenName: typeof PRODUCTION_TOKEN_NAME | typeof STAGING_TOKEN_NAME,
  ) => Promise<RailwayEnvironmentBoundary>;
  queryTokenScope: (
    tokenName: typeof PRODUCTION_TOKEN_NAME | typeof STAGING_TOKEN_NAME,
  ) => Promise<RailwayProjectTokenScope>;
  queryPostgres: (
    variables: PostgresVariables,
  ) => Promise<RailwayProductionDeploymentBoundary>;
  writeOutput: (output: string) => void;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((key, index) => actual[index] === key);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableBoundedString(value: unknown): boolean {
  return value === null
    || (typeof value === "string"
      && value.length <= 1_024
      && !/[\r\n\0]/.test(value));
}

function validToken(value: string | undefined): value is string {
  return typeof value === "string"
    && value.length >= 16
    && value.length <= 4_096
    && value === value.trim()
    && !/[\r\n\0]/.test(value);
}

function fixedReceipt(
  policyValid: boolean,
  checks: RailwayMutationBoundaryChecks,
): BoundaryReceipt {
  const passed = Object.values(checks).every((value) => value === true);
  return {
    schemaVersion: RAILWAY_MUTATION_BOUNDARY_RECEIPT_SCHEMA,
    policy: policyValid ? RAILWAY_MUTATION_POLICY_ID : "invalid",
    mode: policyValid ? "read-only-boundary" : "invalid",
    outcome: passed ? "passed" : "failed",
    checks,
  };
}

function writeReceipt(
  writeOutput: (output: string) => void,
  receipt: BoundaryReceipt,
): void {
  writeOutput(`${JSON.stringify(receipt)}\n`);
}

export function railwayMutationQueriesAreMetadataOnly(): boolean {
  const joined = `${RAILWAY_PROJECT_TOKEN_SCOPE_QUERY}\n${RAILWAY_ENVIRONMENT_MUTATION_BOUNDARY_QUERY}\n${RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY}`;
  return joined.includes("patch(decryptVariables: false)")
    && joined.includes("projectToken")
    && joined.includes("image\n")
    && joined.includes("snapshotId")
    && joined.includes("meta\n")
    && !/decryptVariables\s*:\s*true/.test(joined)
    && !/\bvariables\b/.test(joined)
    && !/\bvalue\b/.test(joined)
    && !/\bconfig\b/.test(joined)
    && !/mutation\s+/i.test(joined);
}

export function parseProjectTokenScopeResponse(
  source: string,
): RailwayProjectTokenScope | null {
  if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    if (!exactKeys(parsed, ["data"])) return null;
    const data = parsed.data;
    if (!exactKeys(data, ["projectToken"])) return null;
    const projectToken = data.projectToken;
    if (
      !exactKeys(projectToken, ["project", "environment"])
      || !exactKeys(projectToken.project, ["id"])
      || typeof projectToken.project.id !== "string"
      || !UUID_PATTERN.test(projectToken.project.id)
      || !exactKeys(projectToken.environment, ["id"])
      || typeof projectToken.environment.id !== "string"
      || !UUID_PATTERN.test(projectToken.environment.id)
    ) {
      return null;
    }
    return {
      projectId: projectToken.project.id,
      environmentId: projectToken.environment.id,
    };
  } catch {
    return null;
  }
}

export function parseEnvironmentBoundaryResponse(
  source: string,
): RailwayEnvironmentBoundary | null {
  if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    if (!exactKeys(parsed, ["data"])) return null;
    const data = parsed.data;
    if (!exactKeys(data, ["environment", "staged"])) return null;
    const environment = data.environment;
    const staged = data.staged;
    if (
      !exactKeys(environment, ["id"])
      || typeof environment.id !== "string"
      || !UUID_PATTERN.test(environment.id)
      || !exactKeys(staged, [
        "id",
        "environmentId",
        "status",
        "createdAt",
        "updatedAt",
        "appliedAt",
        "message",
        "patch",
      ])
      || typeof staged.id !== "string"
      || staged.id.length > 256
      || typeof staged.environmentId !== "string"
      || staged.environmentId !== environment.id
      || typeof staged.status !== "string"
      || staged.status.length > 64
      || !nullableBoundedString(staged.createdAt)
      || !nullableBoundedString(staged.updatedAt)
      || !nullableBoundedString(staged.appliedAt)
      || !nullableBoundedString(staged.message)
      || !plainObject(staged.patch)
    ) {
      return null;
    }
    return { environmentId: environment.id, patch: staged.patch };
  } catch {
    return null;
  }
}

function parseDeploymentSummary(value: unknown): {
  id: string;
  status: string;
  deploymentStopped: boolean;
} | null {
  if (
    !exactKeys(value, ["id", "status", "deploymentStopped"])
    || typeof value.id !== "string"
    || !UUID_PATTERN.test(value.id)
    || typeof value.status !== "string"
    || value.status.length > 64
    || typeof value.deploymentStopped !== "boolean"
  ) {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
    deploymentStopped: value.deploymentStopped,
  };
}

export function parseProductionPostgresResponse(
  source: string,
): RailwayProductionDeploymentBoundary | null {
  if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    if (!exactKeys(parsed, ["data"])) return null;
    const data = parsed.data;
    if (!exactKeys(data, ["serviceInstance", "approvedDeployment"])) return null;
    const instance = data.serviceInstance;
    const approved = data.approvedDeployment;
    if (
      !exactKeys(instance, [
        "id",
        "serviceId",
        "environmentId",
        "source",
        "latestDeployment",
        "activeDeployments",
      ])
      || typeof instance.id !== "string"
      || !UUID_PATTERN.test(instance.id)
      || typeof instance.serviceId !== "string"
      || !UUID_PATTERN.test(instance.serviceId)
      || typeof instance.environmentId !== "string"
      || !UUID_PATTERN.test(instance.environmentId)
      || !Array.isArray(instance.activeDeployments)
      || instance.activeDeployments.length > 20
      || !exactKeys(instance.source, ["image", "repo"])
      || !(instance.source.image === null
        || (typeof instance.source.image === "string"
          && instance.source.image.length <= 512
          && !/[\r\n\0]/.test(instance.source.image)))
      || !(instance.source.repo === null
        || (typeof instance.source.repo === "string"
          && instance.source.repo.length <= 512
          && !/[\r\n\0]/.test(instance.source.repo)))
    ) {
      return null;
    }
    let latestDeployment: RailwayProductionDeploymentBoundary["latestDeployment"] = null;
    if (instance.latestDeployment !== null) {
      const latest = instance.latestDeployment;
      if (
        !exactKeys(latest, ["id", "status", "deploymentStopped", "snapshotId"])
        || typeof latest.id !== "string"
        || !UUID_PATTERN.test(latest.id)
        || typeof latest.status !== "string"
        || latest.status.length > 64
        || typeof latest.deploymentStopped !== "boolean"
        || typeof latest.snapshotId !== "string"
        || !UUID_PATTERN.test(latest.snapshotId)
      ) {
        return null;
      }
      latestDeployment = {
        id: latest.id,
        status: latest.status,
        deploymentStopped: latest.deploymentStopped,
        snapshotId: latest.snapshotId,
      };
    }
    const activeDeployments = instance.activeDeployments.map(parseDeploymentSummary);
    if (activeDeployments.some((deployment) => deployment === null)) return null;

    let approvedDeployment: RailwayProductionDeploymentBoundary["approvedDeployment"] = null;
    if (approved !== null) {
      if (
        !exactKeys(approved, [
          "id",
          "projectId",
          "environmentId",
          "serviceId",
          "snapshotId",
          "meta",
        ])
        || typeof approved.id !== "string"
        || !UUID_PATTERN.test(approved.id)
        || typeof approved.projectId !== "string"
        || !UUID_PATTERN.test(approved.projectId)
        || typeof approved.environmentId !== "string"
        || !UUID_PATTERN.test(approved.environmentId)
        || typeof approved.serviceId !== "string"
        || !UUID_PATTERN.test(approved.serviceId)
        || typeof approved.snapshotId !== "string"
        || !UUID_PATTERN.test(approved.snapshotId)
        || !plainObject(approved.meta)
      ) {
        return null;
      }
      const imageDigest = approved.meta.imageDigest;
      const sourceImage = approved.meta.image;
      const patchId = approved.meta.patchId;
      if (
        !(sourceImage === undefined
          || sourceImage === null
          || (typeof sourceImage === "string"
            && sourceImage.length >= 1
            && sourceImage.length <= 512
            && sourceImage === sourceImage.trim()
            && !/[\r\n\0\s]/.test(sourceImage)))
        || !(imageDigest === undefined
          || imageDigest === null
          || (typeof imageDigest === "string"
            && IMAGE_DIGEST_PATTERN.test(imageDigest)))
        || !(patchId === undefined
          || patchId === null
          || (typeof patchId === "string" && UUID_PATTERN.test(patchId)))
      ) {
        return null;
      }
      approvedDeployment = {
        id: approved.id,
        projectId: approved.projectId,
        environmentId: approved.environmentId,
        serviceId: approved.serviceId,
        snapshotId: approved.snapshotId,
        sourceImage: typeof sourceImage === "string" ? sourceImage : null,
        imageDigest: typeof imageDigest === "string" ? imageDigest : null,
        patchId: typeof patchId === "string" ? patchId : null,
      };
    }
    return {
      environmentId: instance.environmentId,
      serviceId: instance.serviceId,
      sourceImage: instance.source.image,
      sourceRepo: instance.source.repo,
      latestDeployment,
      activeDeployments: activeDeployments as RailwayProductionDeploymentBoundary["activeDeployments"],
      approvedDeployment,
    };
  } catch {
    return null;
  }
}

async function boundedRequest(
  query: string,
  operationName: string,
  variables: Record<string, string>,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const signal = AbortSignal.timeout(QUERY_TIMEOUT_MS);
  const response = await fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Project-Access-Token": token,
    },
    body: JSON.stringify({ operationName, query, variables }),
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("metadata_query_failed");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("metadata_query_failed");
  }
  return readBoundedResponseBody(response, signal);
}

async function readBoundedResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) throw new Error("metadata_query_failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let abortedBySignal = false;
  let rejectAborted: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => {
      abortedBySignal = true;
      void reader.cancel().catch(() => undefined);
      reject(new Error("metadata_query_failed"));
    };
    if (signal.aborted) rejectAborted();
    else signal.addEventListener("abort", rejectAborted, { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (abortedBySignal || signal.aborted) {
        throw new Error("metadata_query_failed");
      }
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error("metadata_query_failed");
      }
      chunks.push(next.value);
    }
  } catch {
    throw new Error("metadata_query_failed");
  } finally {
    if (rejectAborted) signal.removeEventListener("abort", rejectAborted);
    try {
      reader.releaseLock();
    } catch {
      // The fixed failure path already owns any unsettled reader state.
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("metadata_query_failed");
  }
}

async function defaultQueryEnvironment(
  variables: EnvironmentVariables,
  tokenName: typeof PRODUCTION_TOKEN_NAME | typeof STAGING_TOKEN_NAME,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<RailwayEnvironmentBoundary> {
  const token = env[tokenName];
  if (!validToken(token)) throw new Error("metadata_query_failed");
  const source = await boundedRequest(
    RAILWAY_ENVIRONMENT_MUTATION_BOUNDARY_QUERY,
    "PintPathRailwayEnvironmentMutationBoundary",
    { ...variables },
    token,
    fetchImpl,
  );
  const parsed = parseEnvironmentBoundaryResponse(source);
  if (!parsed) throw new Error("metadata_query_failed");
  return parsed;
}

async function defaultQueryTokenScope(
  tokenName: typeof PRODUCTION_TOKEN_NAME | typeof STAGING_TOKEN_NAME,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<RailwayProjectTokenScope> {
  const token = env[tokenName];
  if (!validToken(token)) throw new Error("metadata_query_failed");
  const source = await boundedRequest(
    RAILWAY_PROJECT_TOKEN_SCOPE_QUERY,
    "PintPathRailwayProjectTokenScope",
    {},
    token,
    fetchImpl,
  );
  const parsed = parseProjectTokenScopeResponse(source);
  if (!parsed) throw new Error("metadata_query_failed");
  return parsed;
}

async function defaultQueryPostgres(
  variables: PostgresVariables,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<RailwayProductionDeploymentBoundary> {
  const token = env[PRODUCTION_TOKEN_NAME];
  if (!validToken(token)) throw new Error("metadata_query_failed");
  const source = await boundedRequest(
    RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY,
    "PintPathRailwayProductionPostgresPin",
    { ...variables },
    token,
    fetchImpl,
  );
  const parsed = parseProductionPostgresResponse(source);
  if (!parsed) throw new Error("metadata_query_failed");
  return parsed;
}

const DEFAULT_DEPENDENCIES: BoundaryDependencies = {
  argv: process.argv.slice(2),
  env: process.env,
  fetchImpl: fetch,
  readPolicy: (filename) => fs.readFileSync(filename, "utf8"),
  queryEnvironment: async () => {
    throw new Error("metadata_query_failed");
  },
  queryTokenScope: async () => {
    throw new Error("metadata_query_failed");
  },
  queryPostgres: async () => {
    throw new Error("metadata_query_failed");
  },
  writeOutput: (output) => process.stdout.write(output),
};

export async function runRailwayMutationBoundaryCheck(
  overrides: Partial<BoundaryDependencies> = {},
): Promise<0 | 1> {
  const dependencies: BoundaryDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  if (!overrides.queryEnvironment) {
    dependencies.queryEnvironment = (variables, tokenName) =>
      defaultQueryEnvironment(
        variables,
        tokenName,
        dependencies.env,
        dependencies.fetchImpl,
      );
  }
  if (!overrides.queryTokenScope) {
    dependencies.queryTokenScope = (tokenName) =>
      defaultQueryTokenScope(
        tokenName,
        dependencies.env,
        dependencies.fetchImpl,
      );
  }
  if (!overrides.queryPostgres) {
    dependencies.queryPostgres = (variables) =>
      defaultQueryPostgres(
        variables,
        dependencies.env,
        dependencies.fetchImpl,
      );
  }

  let policy: RailwayMutationPolicy | null = null;
  try {
    const args = parseStrictArguments(dependencies.argv, {
      allowed: new Set(["--policy"]),
      required: new Set(["--policy"]),
    });
    policy = parseRailwayMutationPolicy(
      dependencies.readPolicy(path.resolve(args.get("--policy")!)),
    );
  } catch {
    policy = null;
  }

  if (!policy) {
    writeReceipt(
      dependencies.writeOutput,
      fixedReceipt(false, emptyRailwayMutationBoundaryChecks()),
    );
    return 1;
  }

  const queriesMetadataOnly = railwayMutationQueriesAreMetadataOnly();
  const failedChecks = emptyRailwayMutationBoundaryChecks();
  failedChecks.policyValid = true;
  failedChecks.queriesMetadataOnly = queriesMetadataOnly;
  const productionToken = dependencies.env[PRODUCTION_TOKEN_NAME];
  const stagingToken = dependencies.env[STAGING_TOKEN_NAME];
  if (
    !overrides.queryEnvironment
    && (!validToken(productionToken)
      || !validToken(stagingToken)
      || productionToken === stagingToken)
  ) {
    writeReceipt(dependencies.writeOutput, fixedReceipt(true, failedChecks));
    return 1;
  }

  try {
    const [
      productionTokenScope,
      stagingTokenScope,
      production,
      staging,
      postgres,
    ] = await Promise.all([
      dependencies.queryTokenScope(PRODUCTION_TOKEN_NAME),
      dependencies.queryTokenScope(STAGING_TOKEN_NAME),
      dependencies.queryEnvironment(
        {
          projectId: policy.projectId,
          environmentId: policy.environments[0].environmentId,
        },
        PRODUCTION_TOKEN_NAME,
      ),
      dependencies.queryEnvironment(
        {
          projectId: policy.projectId,
          environmentId: policy.environments[1].environmentId,
        },
        STAGING_TOKEN_NAME,
      ),
      dependencies.queryPostgres({
        environmentId: policy.productionPostgres.environmentId,
        serviceId: policy.productionPostgres.serviceId,
        deploymentId: policy.productionPostgres.deploymentId,
      }),
    ]);
    const checks = evaluateRailwayMutationBoundary({
      policy,
      queriesMetadataOnly,
      productionTokenScope,
      stagingTokenScope,
      production,
      staging,
      postgres,
    });
    const receipt = fixedReceipt(true, checks);
    writeReceipt(dependencies.writeOutput, receipt);
    return receipt.outcome === "passed" ? 0 : 1;
  } catch {
    writeReceipt(dependencies.writeOutput, fixedReceipt(true, failedChecks));
    return 1;
  }
}

export const railwayMutationBoundaryInternals = {
  defaultQueryEnvironment,
  defaultQueryPostgres,
  defaultQueryTokenScope,
  parseEnvironmentBoundaryResponse,
  parseProductionPostgresResponse,
  parseProjectTokenScopeResponse,
  readBoundedResponseBody,
  railwayMutationQueriesAreMetadataOnly,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRailwayMutationBoundaryCheck();
}
