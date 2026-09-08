import crypto from "node:crypto";

const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 60_000;
export const RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME =
  "PintPathEnvironmentPatchCommit" as const;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const ACKNOWLEDGEMENT_PATTERN = /^[\x20-\x7e]{1,1024}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export const RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION =
  `mutation PintPathEnvironmentPatchCommit(
  $environmentId: String!
  $patch: EnvironmentConfig!
  $commitMessage: String
) {
  environmentPatchCommit(
    environmentId: $environmentId
    patch: $patch
    commitMessage: $commitMessage
  )
}` as const;

export interface RailwayRegionReplicaTarget {
  readonly region: string;
  readonly numReplicas: number;
}

export interface RailwayEnvironmentPatchCommitInput {
  readonly environmentId: string;
  readonly serviceId: string;
  readonly regions: readonly RailwayRegionReplicaTarget[];
  readonly commitMessage: string;
}

export interface RailwayEnvironmentPatchCommitAttempt {
  readonly outcome:
    | "acknowledged"
    | "provider_rejected"
    | "transport_uncertain";
  readonly operationName: typeof RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME;
  readonly querySha256: string;
  readonly variablesSha256: string;
  readonly requestBodySha256: string;
  readonly responseBodySha256: string | null;
  readonly acknowledgementSha256: string | null;
  readonly acknowledgementExact: boolean;
  readonly zeroRegionsEncodedAsJsonNull: boolean;
}

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

async function boundedBody(response: Response): Promise<string> {
  if (response.body === null) throw new Error("response_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response_body_too_large");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

export function buildRailwayReplicaEnvironmentPatch(
  serviceId: string,
  regions: readonly RailwayRegionReplicaTarget[],
): Record<string, unknown> | null {
  if (
    !UUID_PATTERN.test(serviceId) ||
    regions.length < 1 ||
    regions.length > 50
  ) return null;
  const sorted = [...regions].sort((left, right) =>
    left.region.localeCompare(right.region));
  if (
    sorted.some((entry, index) =>
      !REGION_PATTERN.test(entry.region) ||
      !Number.isSafeInteger(entry.numReplicas) ||
      entry.numReplicas < 0 ||
      entry.numReplicas > 50 ||
      (index > 0 && sorted[index - 1]?.region === entry.region)) ||
    sorted.reduce((total, entry) => total + entry.numReplicas, 0) > 50
  ) return null;
  return {
    services: {
      [serviceId]: {
        deploy: {
          multiRegionConfig: Object.fromEntries(sorted.map((entry) => [
            entry.region,
            entry.numReplicas === 0 ? null : { numReplicas: entry.numReplicas },
          ])),
        },
      },
    },
  };
}

export function railwayEnvironmentPatchCommitVariables(
  input: RailwayEnvironmentPatchCommitInput,
): Record<string, unknown> | null {
  const patch = buildRailwayReplicaEnvironmentPatch(
    input.serviceId,
    input.regions,
  );
  if (
    patch === null ||
    !UUID_PATTERN.test(input.environmentId) ||
    input.commitMessage.length < 1 ||
    input.commitMessage.length > 256 ||
    /[\r\n\0]/.test(input.commitMessage)
  ) return null;
  return {
    environmentId: input.environmentId,
    patch,
    commitMessage: input.commitMessage,
  };
}

export async function commitRailwayReplicaEnvironmentPatch(
  fetchImpl: typeof fetch,
  token: string,
  input: RailwayEnvironmentPatchCommitInput,
  timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
): Promise<RailwayEnvironmentPatchCommitAttempt> {
  if (
    !TOKEN_PATTERN.test(token) ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > DEFAULT_TIMEOUT_MILLISECONDS
  ) throw new Error("railway_environment_patch_commit_input_invalid");
  const variables = railwayEnvironmentPatchCommitVariables(input);
  if (variables === null) {
    throw new Error("railway_environment_patch_commit_input_invalid");
  }
  const requestBody = canonicalJson({
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
    variables,
  });
  const base = {
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    querySha256: sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
    variablesSha256: sha256(canonicalJson(variables)),
    requestBodySha256: sha256(requestBody),
    zeroRegionsEncodedAsJsonNull: input.regions
      .filter((entry) => entry.numReplicas === 0)
      .every((entry) => {
        const patch = variables.patch as Record<string, unknown>;
        const services = record(patch.services)
          ? patch.services as Record<string, unknown>
          : null;
        const target = services && record(services[input.serviceId])
          ? services[input.serviceId] as Record<string, unknown>
          : null;
        const deploy = target && record(target.deploy) ? target.deploy : null;
        const topology = deploy && record(deploy.multiRegionConfig)
          ? deploy.multiRegionConfig
          : null;
        return topology !== null && Object.hasOwn(topology, entry.region) &&
          topology[entry.region] === null;
      }),
  } as const;
  try {
    const response = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Project-Access-Token": token,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: requestBody,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    let source: string;
    try {
      source = await boundedBody(response);
    } catch {
      return {
        ...base,
        outcome: "transport_uncertain",
        responseBodySha256: null,
        acknowledgementSha256: null,
        acknowledgementExact: false,
      };
    }
    const responseBodySha256 = sha256(source);
    if (!/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )) return {
      ...base,
      outcome: "transport_uncertain",
      responseBodySha256,
      acknowledgementSha256: null,
      acknowledgementExact: false,
    };
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      return {
        ...base,
        outcome: "transport_uncertain",
        responseBodySha256,
        acknowledgementSha256: null,
        acknowledgementExact: false,
      };
    }
    const providerErrors = record(value) && Array.isArray(value.errors) &&
      value.errors.length > 0;
    if (!response.ok) {
      return {
        ...base,
        // Without a provider-pinned pre-execution error code, an HTTP failure
        // cannot prove the resolver did not commit before the response failed.
        outcome: "transport_uncertain",
        responseBodySha256,
        acknowledgementSha256: null,
        acknowledgementExact: false,
      };
    }
    if (providerErrors) {
      return {
        ...base,
        outcome: "transport_uncertain",
        responseBodySha256,
        acknowledgementSha256: null,
        acknowledgementExact: false,
      };
    }
    const acknowledgement = exactKeys(value, ["data"]) &&
        exactKeys(value.data, ["environmentPatchCommit"]) &&
        typeof value.data.environmentPatchCommit === "string" &&
        ACKNOWLEDGEMENT_PATTERN.test(value.data.environmentPatchCommit)
      ? value.data.environmentPatchCommit
      : null;
    if (acknowledgement === null) {
      return {
        ...base,
        outcome: "transport_uncertain",
        responseBodySha256,
        acknowledgementSha256: null,
        acknowledgementExact: false,
      };
    }
    return {
      ...base,
      outcome: "acknowledged",
      responseBodySha256,
      acknowledgementSha256: sha256(acknowledgement),
      acknowledgementExact: true,
    };
  } catch {
    return {
      ...base,
      outcome: "transport_uncertain",
      responseBodySha256: null,
      acknowledgementSha256: null,
      acknowledgementExact: false,
    };
  }
}
