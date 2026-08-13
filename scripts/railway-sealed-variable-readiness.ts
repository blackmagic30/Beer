import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { parseStrictArguments } from "./lib/strict-arguments.js";

export const RAILWAY_SEALED_VARIABLE_POLICY_SCHEMA =
  "pintpath-railway-sealed-variable-policy/v1" as const;
export const RAILWAY_SEALED_VARIABLE_POLICY_ID =
  "permanent-staging-post-rotation" as const;
export const RAILWAY_SEALED_VARIABLE_RECEIPT_SCHEMA =
  "pintpath-railway-sealed-variable-readiness/v1" as const;
export const RAILWAY_VARIABLE_METADATA_QUERY = `query PintPathRailwayVariableMetadata(
  $projectId: String!
  $environmentId: String!
  $after: String
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    variables(first: 100, after: $after) {
      edges {
        cursor
        node {
          id
          name
          environmentId
          serviceId
          isSealed
          references
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const MAX_POLICY_BYTES = 64 * 1_024;
const MAX_QUERY_BYTES = 1024 * 1024;
const MAX_PAGES = 20;
const MAX_VARIABLES = 2_000;
const QUERY_TIMEOUT_MS = 20_000;
const RAILWAY_GRAPHQL_ENDPOINT =
  "https://backboard.railway.com/graphql/v2" as const;

interface RailwayVariableReference {
  serviceId: string;
  name: string;
}

interface SealedVariableExpectation {
  serviceId: string;
  name: string;
  isSealed: true;
  references: RailwayVariableReference[];
}

interface SealedVariablePolicy {
  schemaVersion: typeof RAILWAY_SEALED_VARIABLE_POLICY_SCHEMA;
  policyId: typeof RAILWAY_SEALED_VARIABLE_POLICY_ID;
  projectId: string;
  environmentId: string;
  variables: SealedVariableExpectation[];
  forbiddenVariableNames: string[];
  forbiddenServiceIds: string[];
}

interface RailwayVariableMetadata {
  id: string;
  name: string;
  environmentId: string;
  serviceId: string | null;
  isSealed: boolean;
  references: RailwayVariableReference[];
}

interface RailwayMetadataPage {
  environmentId: string;
  variables: RailwayVariableMetadata[];
  edgeCursors: string[];
  hasNextPage: boolean;
  endCursor: string | null;
  requestedAfter: string | null;
}

interface ReadinessChecks {
  policyValid: boolean;
  metadataQuerySafe: boolean;
  completeInventory: boolean;
  environmentExact: boolean;
  uniqueRows: boolean;
  exactScope: boolean;
  allSealed: boolean;
  exactReferences: boolean;
  noSharedShadows: boolean;
  forbiddenVariablesAbsent: boolean;
  forbiddenServicesAbsent: boolean;
}

interface RailwaySealedVariableReceipt {
  schemaVersion: typeof RAILWAY_SEALED_VARIABLE_RECEIPT_SCHEMA;
  policy: typeof RAILWAY_SEALED_VARIABLE_POLICY_ID | "invalid";
  mode: "post-seal" | "invalid";
  outcome: "passed" | "failed";
  checks: ReadinessChecks;
}

interface RailwayApiVariables {
  projectId: string;
  environmentId: string;
  after: string | null;
}

interface ReadinessDependencies {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl: typeof fetch;
  readPolicy: (filename: string) => string;
  queryMetadataPage: (
    variables: RailwayApiVariables,
  ) => Promise<RailwayMetadataPage>;
  writeOutput: (output: string) => void;
}

function emptyChecks(): ReadinessChecks {
  return {
    policyValid: false,
    metadataQuerySafe: false,
    completeInventory: false,
    environmentExact: false,
    uniqueRows: false,
    exactScope: false,
    allSealed: false,
    exactReferences: false,
    noSharedShadows: false,
    forbiddenVariablesAbsent: false,
    forbiddenServicesAbsent: false,
  };
}

function fixedReceipt(
  checks: ReadinessChecks = emptyChecks(),
): RailwaySealedVariableReceipt {
  const passed = Object.values(checks).every((value) => value === true);
  return {
    schemaVersion: RAILWAY_SEALED_VARIABLE_RECEIPT_SCHEMA,
    policy: checks.policyValid
      ? RAILWAY_SEALED_VARIABLE_POLICY_ID
      : "invalid",
    mode: checks.policyValid ? "post-seal" : "invalid",
    outcome: passed ? "passed" : "failed",
    checks,
  };
}

function writeReceipt(
  writeOutput: (output: string) => void,
  receipt: RailwaySealedVariableReceipt,
): void {
  writeOutput(`${JSON.stringify(receipt)}\n`);
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key, index) => actual[index] === key)
  );
}

function parsePolicyReference(value: unknown): RailwayVariableReference | null {
  if (
    !exactKeys(value, ["serviceId", "name"]) ||
    typeof value.serviceId !== "string" ||
    !UUID_PATTERN.test(value.serviceId) ||
    typeof value.name !== "string" ||
    !VARIABLE_NAME_PATTERN.test(value.name)
  ) {
    return null;
  }
  return { serviceId: value.serviceId, name: value.name };
}

function referenceKey(reference: RailwayVariableReference): string {
  return `${reference.serviceId}\0${reference.name}`;
}

function sortAndValidateReferences(
  references: RailwayVariableReference[],
): RailwayVariableReference[] | null {
  references.sort((left, right) =>
    referenceKey(left).localeCompare(referenceKey(right)),
  );
  return new Set(references.map(referenceKey)).size === references.length
    ? references
    : null;
}

function parsePolicyReferences(value: unknown): RailwayVariableReference[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const references: RailwayVariableReference[] = [];
  for (const candidate of value) {
    const reference = parsePolicyReference(candidate);
    if (!reference) return null;
    references.push(reference);
  }
  return sortAndValidateReferences(references);
}

function normalizeMetadataReferences(
  value: unknown,
  ownerServiceId: string | null,
): RailwayVariableReference[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const references: RailwayVariableReference[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      candidate.length < 1 ||
      candidate.length > 512 ||
      /[\r\n\0]/.test(candidate)
    ) {
      return null;
    }
    if (VARIABLE_NAME_PATTERN.test(candidate)) {
      if (!ownerServiceId) return null;
      references.push({ serviceId: ownerServiceId, name: candidate });
      continue;
    }
    const separator = candidate.indexOf(".");
    if (
      separator < 1 ||
      separator !== candidate.lastIndexOf(".") ||
      !UUID_PATTERN.test(candidate.slice(0, separator)) ||
      !VARIABLE_NAME_PATTERN.test(candidate.slice(separator + 1))
    ) {
      return null;
    }
    references.push({
      serviceId: candidate.slice(0, separator),
      name: candidate.slice(separator + 1),
    });
  }
  return sortAndValidateReferences(references);
}

function parsePolicy(source: string): SealedVariablePolicy | null {
  if (
    Buffer.byteLength(source, "utf8") > MAX_POLICY_BYTES ||
    /[\0]/.test(source)
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(source);
    if (
      !exactKeys(parsed, [
        "schemaVersion",
        "policyId",
        "projectId",
        "environmentId",
        "variables",
        "forbiddenVariableNames",
        "forbiddenServiceIds",
      ]) ||
      parsed.schemaVersion !== RAILWAY_SEALED_VARIABLE_POLICY_SCHEMA ||
      parsed.policyId !== RAILWAY_SEALED_VARIABLE_POLICY_ID ||
      typeof parsed.projectId !== "string" ||
      !UUID_PATTERN.test(parsed.projectId) ||
      typeof parsed.environmentId !== "string" ||
      !UUID_PATTERN.test(parsed.environmentId) ||
      !Array.isArray(parsed.variables) ||
      parsed.variables.length === 0 ||
      parsed.variables.length > 100 ||
      !Array.isArray(parsed.forbiddenVariableNames) ||
      parsed.forbiddenVariableNames.length > 100 ||
      !Array.isArray(parsed.forbiddenServiceIds) ||
      parsed.forbiddenServiceIds.length > 20
    ) {
      return null;
    }

    const variables: SealedVariableExpectation[] = [];
    const expectedRows = new Set<string>();
    for (const candidate of parsed.variables) {
      if (
        !exactKeys(candidate, [
          "serviceId",
          "name",
          "isSealed",
          "references",
        ]) ||
        typeof candidate.serviceId !== "string" ||
        !UUID_PATTERN.test(candidate.serviceId) ||
        typeof candidate.name !== "string" ||
        !VARIABLE_NAME_PATTERN.test(candidate.name) ||
        candidate.isSealed !== true ||
        !Array.isArray(candidate.references)
      ) {
        return null;
      }
      const references = parsePolicyReferences(candidate.references);
      if (!references) return null;
      const rowKey = `${candidate.serviceId}\0${candidate.name}`;
      if (expectedRows.has(rowKey)) return null;
      expectedRows.add(rowKey);
      variables.push({
        serviceId: candidate.serviceId,
        name: candidate.name,
        isSealed: true,
        references,
      });
    }

    const forbiddenVariableNames: string[] = [];
    for (const candidate of parsed.forbiddenVariableNames) {
      if (typeof candidate !== "string" || !VARIABLE_NAME_PATTERN.test(candidate)) {
        return null;
      }
      forbiddenVariableNames.push(candidate);
    }
    if (
      new Set(forbiddenVariableNames).size !== forbiddenVariableNames.length
      || variables.some((variable) => forbiddenVariableNames.includes(variable.name))
    ) return null;

    const forbiddenServiceIds: string[] = [];
    for (const candidate of parsed.forbiddenServiceIds) {
      if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate))
        return null;
      forbiddenServiceIds.push(candidate);
    }
    if (
      new Set(forbiddenServiceIds).size !== forbiddenServiceIds.length ||
      variables.some((variable) =>
        forbiddenServiceIds.includes(variable.serviceId),
      )
    ) {
      return null;
    }

    return {
      schemaVersion: RAILWAY_SEALED_VARIABLE_POLICY_SCHEMA,
      policyId: RAILWAY_SEALED_VARIABLE_POLICY_ID,
      projectId: parsed.projectId,
      environmentId: parsed.environmentId,
      variables,
      forbiddenVariableNames,
      forbiddenServiceIds,
    };
  } catch {
    return null;
  }
}

function queryIsMetadataOnly(query: string): boolean {
  const fields = [
    "id",
    "name",
    "environmentId",
    "serviceId",
    "isSealed",
    "references",
    "hasNextPage",
    "endCursor",
  ];
  const forbidden = [
    /\bvalue\b/,
    /\bdecryptedValue\b/,
    /decryptVariables/,
  ];
  return (
    query.includes("first: 100") &&
    query.includes("after: $after") &&
    fields.every((field) => new RegExp(`\\b${field}\\b`).test(query)) &&
    forbidden.every((pattern) => !pattern.test(query))
  );
}

function exactCursor(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 512
    && !/[\r\n\0]/.test(value);
}

function parseMetadataPage(
  source: string,
  requestedAfter: string | null = null,
): RailwayMetadataPage | null {
  if (Buffer.byteLength(source, "utf8") > MAX_QUERY_BYTES) return null;
  try {
    if (!(requestedAfter === null || exactCursor(requestedAfter))) return null;
    const parsed: unknown = JSON.parse(source);
    if (!exactKeys(parsed, ["data"])) return null;
    const data = parsed.data;
    if (!exactKeys(data, ["environment"])) return null;
    const environment = data.environment;
    if (!exactKeys(environment, ["id", "variables"])) return null;
    const connection = environment.variables;
    if (!exactKeys(connection, ["edges", "pageInfo"])) return null;
    if (!Array.isArray(connection.edges) || connection.edges.length > 100) {
      return null;
    }
    const pageInfo = connection.pageInfo;
    if (!exactKeys(pageInfo, ["hasNextPage", "endCursor"])) return null;
    if (
      typeof environment.id !== "string" ||
      typeof pageInfo.hasNextPage !== "boolean" ||
      !(
        pageInfo.endCursor === null ||
        exactCursor(pageInfo.endCursor)
      )
    ) {
      return null;
    }

    const variables: RailwayVariableMetadata[] = [];
    const edgeCursors: string[] = [];
    for (const edge of connection.edges) {
      if (
        !exactKeys(edge, ["cursor", "node"]) ||
        !exactCursor(edge.cursor)
      ) {
        return null;
      }
      const node = edge.node;
      if (
        !exactKeys(node, [
          "id",
          "name",
          "environmentId",
          "serviceId",
          "isSealed",
          "references",
        ]) ||
        typeof node.id !== "string" ||
        node.id.length < 1 ||
        node.id.length > 256 ||
        typeof node.name !== "string" ||
        !VARIABLE_NAME_PATTERN.test(node.name) ||
        typeof node.environmentId !== "string" ||
        !UUID_PATTERN.test(node.environmentId) ||
        !(
          node.serviceId === null ||
          (typeof node.serviceId === "string" &&
            UUID_PATTERN.test(node.serviceId))
        ) ||
        typeof node.isSealed !== "boolean" ||
        !Array.isArray(node.references)
      ) {
        return null;
      }
      const references = normalizeMetadataReferences(
        node.references,
        node.serviceId,
      );
      if (!references) return null;
      variables.push({
        id: node.id,
        name: node.name,
        environmentId: node.environmentId,
        serviceId: node.serviceId,
        isSealed: node.isSealed,
        references,
      });
      edgeCursors.push(edge.cursor);
    }
    if (
      new Set(edgeCursors).size !== edgeCursors.length
      || (pageInfo.hasNextPage && edgeCursors.length === 0)
      || (edgeCursors.length === 0 && pageInfo.endCursor !== null)
      || (
        edgeCursors.length > 0
        && pageInfo.endCursor !== edgeCursors[edgeCursors.length - 1]
      )
    ) {
      return null;
    }
    return {
      environmentId: environment.id,
      variables,
      edgeCursors,
      hasNextPage: pageInfo.hasNextPage,
      endCursor: pageInfo.endCursor,
      requestedAfter,
    };
  } catch {
    return null;
  }
}

function metadataQueryFailed(): Error {
  return new Error("metadata_query_failed");
}

function cancelResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // The public failure is fixed below; cancellation details are never exposed.
  }
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  const release = (): void => {
    try {
      reader.releaseLock();
    } catch {
      // A still-pending read retains the lock until cancellation settles.
    }
  };
  try {
    void reader.cancel().then(release, release);
  } catch {
    release();
  }
}

async function settleBeforeAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw metadataQueryFailed();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(metadataQueryFailed()));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(metadataQueryFailed())),
    );
    if (signal.aborted) abort();
  });
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body || signal.aborted) throw metadataQueryFailed();
  const reader = response.body.getReader();
  const bytes = Buffer.allocUnsafe(maximumBytes);
  const validator = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  let complete = false;
  try {
    while (true) {
      const result = await settleBeforeAbort(reader.read(), signal);
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength === 0) {
        throw metadataQueryFailed();
      }
      if (result.value.byteLength > maximumBytes - offset) {
        throw metadataQueryFailed();
      }
      validator.decode(result.value, { stream: true });
      Buffer.from(
        result.value.buffer,
        result.value.byteOffset,
        result.value.byteLength,
      ).copy(bytes, offset);
      offset += result.value.byteLength;
    }
    validator.decode();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
    complete = true;
    return decoded;
  } catch {
    cancelReader(reader);
    throw metadataQueryFailed();
  } finally {
    if (complete) reader.releaseLock();
  }
}

async function defaultQueryMetadataPage(
  variables: RailwayApiVariables,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<RailwayMetadataPage> {
  const token = env.PINTPATH_RAILWAY_METADATA_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 16 ||
    token.length > 4_096 ||
    token !== token.trim() ||
    /[\r\n\0]/.test(token)
  ) {
    throw metadataQueryFailed();
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  let response: Response | null = null;
  try {
    let responsePromise: Promise<Response>;
    try {
      responsePromise = Promise.resolve(fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Project-Access-Token": token,
        },
        body: JSON.stringify({
          operationName: "PintPathRailwayVariableMetadata",
          query: RAILWAY_VARIABLE_METADATA_QUERY,
          variables,
        }),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }));
    } catch {
      throw metadataQueryFailed();
    }
    void responsePromise.then((lateResponse) => {
      if (controller.signal.aborted) cancelResponseBody(lateResponse);
    }, () => undefined);
    response = await settleBeforeAbort(responsePromise, controller.signal);
    if (!response.ok) {
      cancelResponseBody(response);
      throw metadataQueryFailed();
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_QUERY_BYTES)
    ) {
      cancelResponseBody(response);
      throw metadataQueryFailed();
    }
    const source = await readBoundedResponseText(
      response,
      MAX_QUERY_BYTES,
      controller.signal,
    );
    if (controller.signal.aborted) throw metadataQueryFailed();
    const parsed = parseMetadataPage(source, variables.after);
    if (!parsed || controller.signal.aborted) throw metadataQueryFailed();
    return parsed;
  } catch {
    controller.abort();
    if (response) cancelResponseBody(response);
    throw metadataQueryFailed();
  } finally {
    clearTimeout(deadline);
  }
}

function cloneRuntimeMetadataVariable(
  value: unknown,
): RailwayVariableMetadata | null {
  if (!exactKeys(value, [
    "id",
    "name",
    "environmentId",
    "serviceId",
    "isSealed",
    "references",
  ])) return null;
  if (
    typeof value.id !== "string"
    || value.id.length < 1
    || value.id.length > 256
    || /[\r\n\0]/.test(value.id)
    || typeof value.name !== "string"
    || !VARIABLE_NAME_PATTERN.test(value.name)
    || typeof value.environmentId !== "string"
    || !UUID_PATTERN.test(value.environmentId)
    || !(value.serviceId === null
      || (typeof value.serviceId === "string" && UUID_PATTERN.test(value.serviceId)))
    || typeof value.isSealed !== "boolean"
    || !Array.isArray(value.references)
    || value.references.length > 100
  ) return null;
  const references: RailwayVariableReference[] = [];
  for (const candidate of value.references) {
    if (
      !exactKeys(candidate, ["serviceId", "name"])
      || typeof candidate.serviceId !== "string"
      || !UUID_PATTERN.test(candidate.serviceId)
      || typeof candidate.name !== "string"
      || !VARIABLE_NAME_PATTERN.test(candidate.name)
    ) return null;
    references.push({
      serviceId: candidate.serviceId,
      name: candidate.name,
    });
  }
  const normalizedReferences = sortAndValidateReferences(references);
  if (!normalizedReferences) return null;
  return {
    id: value.id,
    name: value.name,
    environmentId: value.environmentId,
    serviceId: value.serviceId,
    isSealed: value.isSealed,
    references: normalizedReferences,
  };
}

const DEFAULT_DEPENDENCIES: ReadinessDependencies = {
  argv: process.argv.slice(2),
  env: process.env,
  fetchImpl: fetch,
  readPolicy: (filename) => fs.readFileSync(filename, "utf8"),
  queryMetadataPage: defaultQueryMetadataPage,
  writeOutput: (output) => process.stdout.write(output),
};

async function collectInventory(
  policy: SealedVariablePolicy,
  queryMetadataPage: ReadinessDependencies["queryMetadataPage"],
): Promise<RailwayVariableMetadata[] | null> {
  const variables: RailwayVariableMetadata[] = [];
  const edgeCursors = new Set<string>();
  let after: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    try {
      const page: unknown = await queryMetadataPage({
        projectId: policy.projectId,
        environmentId: policy.environmentId,
        after,
      });
      if (
        !exactKeys(page, [
          "environmentId",
          "variables",
          "edgeCursors",
          "hasNextPage",
          "endCursor",
          "requestedAfter",
        ])
        || page.environmentId !== policy.environmentId
        || page.requestedAfter !== after
        || typeof page.hasNextPage !== "boolean"
        || !(page.endCursor === null || exactCursor(page.endCursor))
        || !Array.isArray(page.variables)
        || !Array.isArray(page.edgeCursors)
        || page.variables.length !== page.edgeCursors.length
        || page.edgeCursors.length > 100
        || page.edgeCursors.some((cursor) => !exactCursor(cursor))
        || new Set(page.edgeCursors).size !== page.edgeCursors.length
        || page.edgeCursors.some((cursor) => edgeCursors.has(cursor))
        || (page.hasNextPage && page.edgeCursors.length === 0)
        || (page.edgeCursors.length === 0 && page.endCursor !== null)
        || (
          page.edgeCursors.length > 0
          && page.endCursor !== page.edgeCursors[page.edgeCursors.length - 1]
        )
      ) return null;
      const clonedVariables: RailwayVariableMetadata[] = [];
      for (const variable of page.variables) {
        const cloned = cloneRuntimeMetadataVariable(variable);
        if (!cloned || cloned.environmentId !== policy.environmentId) return null;
        clonedVariables.push(cloned);
      }
      for (const cursor of page.edgeCursors) edgeCursors.add(cursor);
      variables.push(...clonedVariables);
      if (variables.length > MAX_VARIABLES) return null;
      if (!page.hasNextPage) return variables;
      if (!page.endCursor) return null;
      after = page.endCursor;
    } catch {
      return null;
    }
  }
  return null;
}

function evaluateInventory(
  policy: SealedVariablePolicy,
  inventory: RailwayVariableMetadata[],
): ReadinessChecks {
  const checks = emptyChecks();
  checks.policyValid = true;
  checks.metadataQuerySafe = queryIsMetadataOnly(
    RAILWAY_VARIABLE_METADATA_QUERY,
  );
  checks.completeInventory = true;
  checks.environmentExact = inventory.every(
    (variable) => variable.environmentId === policy.environmentId,
  );
  const inventoryRowKeys = inventory.map(
    (variable) => `${variable.serviceId ?? "shared"}\0${variable.name}`,
  );
  checks.uniqueRows =
    new Set(inventory.map((variable) => variable.id)).size === inventory.length
    && new Set(inventoryRowKeys).size === inventory.length;

  const governedNames = new Set(
    policy.variables.map((variable) => variable.name),
  );
  const expectedRows = new Map(
    policy.variables.map((variable) => [
      `${variable.serviceId}\0${variable.name}`,
      variable,
    ]),
  );
  const governedInventory = inventory.filter((variable) =>
    governedNames.has(variable.name),
  );
  const governedRowKeys = governedInventory.map(
    (variable) => `${variable.serviceId ?? "shared"}\0${variable.name}`,
  );
  checks.noSharedShadows = governedInventory.every(
    (variable) => variable.serviceId !== null,
  );
  checks.exactScope =
    governedInventory.length === policy.variables.length &&
    new Set(governedRowKeys).size === governedInventory.length &&
    governedInventory.every((variable) =>
      variable.serviceId !== null &&
      expectedRows.has(`${variable.serviceId}\0${variable.name}`),
    ) &&
    [...expectedRows.keys()].every((rowKey) =>
      governedRowKeys.includes(rowKey),
    );

  checks.allSealed = checks.exactScope;
  checks.exactReferences = checks.exactScope;
  if (checks.exactScope) {
    for (const variable of governedInventory) {
      const expected = expectedRows.get(
        `${variable.serviceId}\0${variable.name}`,
      );
      if (!expected || variable.isSealed !== true) checks.allSealed = false;
      if (
        !expected ||
        expected.references.length !== variable.references.length ||
        expected.references.some(
          (reference, index) =>
            referenceKey(reference) !==
            referenceKey(variable.references[index]!),
        )
      ) {
        checks.exactReferences = false;
      }
    }
  }
  checks.forbiddenVariablesAbsent = inventory.every(
    (variable) => !policy.forbiddenVariableNames.includes(variable.name),
  );
  checks.forbiddenServicesAbsent = inventory.every(
    (variable) =>
      variable.serviceId === null ||
      !policy.forbiddenServiceIds.includes(variable.serviceId),
  );
  return checks;
}

export async function runRailwaySealedVariableReadiness(
  overrides: Partial<ReadinessDependencies> = {},
): Promise<0 | 1> {
  const dependencies: ReadinessDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  if (!overrides.queryMetadataPage) {
    dependencies.queryMetadataPage = (variables) =>
      defaultQueryMetadataPage(
        variables,
        dependencies.env,
        dependencies.fetchImpl,
      );
  }
  let policy: SealedVariablePolicy | null = null;
  try {
    const parsed = parseStrictArguments(dependencies.argv, {
      allowed: new Set(["--policy"]),
      required: new Set(["--policy"]),
    });
    const policyPath = path.resolve(parsed.get("--policy")!);
    policy = parsePolicy(dependencies.readPolicy(policyPath));
  } catch {
    policy = null;
  }
  if (!policy) {
    writeReceipt(dependencies.writeOutput, fixedReceipt());
    return 1;
  }

  const inventory = await collectInventory(
    policy,
    dependencies.queryMetadataPage,
  );
  if (!inventory) {
    const checks = emptyChecks();
    checks.policyValid = true;
    checks.metadataQuerySafe = queryIsMetadataOnly(
      RAILWAY_VARIABLE_METADATA_QUERY,
    );
    writeReceipt(dependencies.writeOutput, fixedReceipt(checks));
    return 1;
  }
  const receipt = fixedReceipt(evaluateInventory(policy, inventory));
  writeReceipt(dependencies.writeOutput, receipt);
  return receipt.outcome === "passed" ? 0 : 1;
}

export const railwaySealedVariableReadinessInternals = {
  defaultQueryMetadataPage,
  evaluateInventory,
  normalizeMetadataReferences,
  parseMetadataPage,
  parsePolicy,
  queryIsMetadataOnly,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRailwaySealedVariableReadiness();
}
