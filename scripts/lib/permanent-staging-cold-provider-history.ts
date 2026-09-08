import crypto from "node:crypto";

import {
  COLD_RECOVERY_LOCK,
  fullStateCanonical,
  railwayCall,
  type ColdRecoveryState,
} from "./permanent-staging-cold-recovery.js";

const MAX_PAGES = 8;
const PAGE_SIZE = 100;
const MAX_ROWS = MAX_PAGES * PAGE_SIZE;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const COLD_PROVIDER_HISTORY_QUERY =
  `query PintPathColdProviderHistory(
  $environmentId: String!
  $serviceId: String!
  $after: String
) {
  environmentHistory(
    environmentId: $environmentId
    first: 100
    after: $after
    filter: { serviceIds: [$serviceId] }
  ) {
    edges {
      cursor
      node {
        id
        createdAt
        object
        action
        outcome
        operationKind
        severity
        source
        workflowId
        activityPayload
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}` as const;

export const COLD_PROVIDER_PATCHES_QUERY =
  `query PintPathColdProviderPatches(
  $environmentId: String!
  $after: String
) {
  environmentPatches(
    environmentId: $environmentId
    first: 100
    after: $after
  ) {
    edges {
      cursor
      node {
        id
        environmentId
        status
        createdAt
        updatedAt
        appliedAt
        message
        patch(decryptVariables: false)
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}` as const;

export const COLD_PROVIDER_PATCH_QUERY =
  `query PintPathColdProviderPatch($id: String!) {
  environmentPatch(id: $id) {
    id
    environmentId
    status
    createdAt
    updatedAt
    appliedAt
    message
    patch(decryptVariables: false)
  }
}` as const;

export const COLD_PROVIDER_HISTORY_ANCHOR = Object.freeze({
  historyPrefixThrough: "2026-09-08T04:19:56.336Z",
  historyPrefixCount: 6,
  historyPrefixRowsSha256:
    "f1270eaf4378364f1d91624515f7a0b370f9274254535619704a56d948bf609f",
  patchPrefixThrough: "2026-09-08T04:19:56.526Z",
  patchPrefixCount: 122,
  patchPrefixRowsSha256:
    "a560f185f77fb091da39314eb1f7f9f5ab3a4d2f6593752339649751f6c133db",
  patchPrefixEnvelopeSha256:
    "883f66b23151d4f2acdbe8f8f8f254b0fa5a2ab5bea533bef82ccb3de673c6bc",
  oldestHistoryAt: "2026-09-07T18:38:06.313Z",
  oldestPatchAt: "2026-07-18T06:29:17.109Z",
  historicalScalePatchId: "394651e3-3dff-424c-8c66-942548832b40",
  historicalScalePatchAt: "2026-07-19T00:31:10.794Z",
  legacyQuiesceWindow: Object.freeze({
    startedAt: "2026-09-07T18:51:21.000Z",
    completedAt: "2026-09-07T18:57:20.000Z",
  }),
  priorQuiesceWindow: Object.freeze({
    startedAt: "2026-09-08T04:30:38.868Z",
    completedAt: "2026-09-08T04:32:22.210Z",
  }),
  pinnedVariablePatches: Object.freeze([
    Object.freeze({
      id: "85b5596f-35a6-4d55-b23a-4d8b74dfbe15",
      createdAt: "2026-09-08T02:28:47.021Z",
      variableName: "SUPABASE_SERVICE_ROLE_KEY",
    }),
    Object.freeze({
      id: "5054d3d8-b46d-4b6b-90ca-860b8c264748",
      createdAt: "2026-09-08T04:12:39.161Z",
      variableName: "SUPABASE_SERVICE_ROLE_KEY",
    }),
    Object.freeze({
      id: "86131703-8546-43bf-b968-2c76aaa399df",
      createdAt: "2026-09-08T04:19:56.526Z",
      variableName: "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
    }),
  ]),
} as const);

export interface ColdProviderAuthorizedRunWindow {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ColdProviderNoWriteProofInput {
  readonly replacement: ColdProviderAuthorizedRunWindow;
  readonly prepare: ColdProviderAuthorizedRunWindow;
  readonly observedAt: string;
  readonly liveState: ColdRecoveryState;
}

interface PageEvidence {
  readonly requestAfter: string | null;
  readonly count: number;
  readonly endCursor: string;
  readonly hasNextPage: boolean;
}

interface HistoryProjection {
  readonly id: string;
  readonly createdAt: string;
  readonly object: string;
  readonly action: string;
  readonly outcome: string;
  readonly operationKind: string;
  readonly severity: string;
  readonly source: string;
  readonly workflowId: string | null;
  readonly activityPayload: {
    readonly keys: readonly string[];
    readonly count: number;
    readonly names: readonly string[];
    readonly serviceId: string;
  };
}

interface PatchProjection {
  readonly id: string;
  readonly environmentId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt: string | null;
  readonly message: string | null;
  readonly patchKeyShape: unknown;
}

export interface ColdProviderNoWriteProof {
  readonly schemaVersion:
    "pintpath-permanent-staging-cold-provider-no-write-proof/v1";
  readonly observedAt: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly querySha256: {
    readonly history: string;
    readonly patches: string;
    readonly patch: string;
  };
  readonly history: {
    readonly pages: readonly PageEvidence[];
    readonly count: number;
    readonly rowsSha256: string;
    readonly prefixCount: number;
    readonly prefixRowsSha256: string;
    readonly suffixEventIds: readonly [string, string];
  };
  readonly patches: {
    readonly pages: readonly PageEvidence[];
    readonly count: number;
    readonly rowsSha256: string;
    readonly prefixCount: number;
    readonly prefixRowsSha256: string;
    readonly suffixPatchIds: readonly [string, string];
    readonly crossFetchProjectionSha256: string;
  };
  readonly incidentWindows: readonly (
    | typeof COLD_PROVIDER_HISTORY_ANCHOR.legacyQuiesceWindow
    | typeof COLD_PROVIDER_HISTORY_ANCHOR.priorQuiesceWindow
  )[];
  readonly liveStateSha256: string;
  readonly checks: {
    readonly paginationCompleteExact: true;
    readonly chronologicalOrderExact: true;
    readonly historicalPrefixesExact: true;
    readonly historicalScalePositiveControlExact: true;
    readonly legacyUnauthorizedRunNoWriteExact: true;
    readonly priorUnauthorizedRunNoWriteExact: true;
    readonly authorizedSuffixExact: true;
    readonly targetDeployAbsentFromSuffixExact: true;
    readonly crossFetchedPatchesExact: true;
    readonly ledgerRecheckExact: true;
    readonly liveTopologyContinuityExact: true;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

function fail(code: string): never {
  throw new Error(`cold_provider_history_${code}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    sortKeys(value[key]),
  ]));
}

function canonical(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function liveStateExact(state: ColdRecoveryState): boolean {
  return state.environmentId === COLD_RECOVERY_LOCK.environmentId &&
    state.serviceInstanceId === COLD_RECOVERY_LOCK.serviceInstanceId &&
    state.serviceId === COLD_RECOVERY_LOCK.serviceId &&
    state.numReplicas === null && state.configuredReplicas === 1 &&
    canonical(state.configuredRegions) === canonical([{
      region: COLD_RECOVERY_LOCK.configuredRegionBefore,
      numReplicas: 1,
    }]) &&
    canonical(state.deploymentRegions) === canonical([{
      region: COLD_RECOVERY_LOCK.region,
      numReplicas: 1,
    }]) &&
    canonical(state.source) === canonical({ repo: null, image: null }) &&
    state.latestDeployment.id === COLD_RECOVERY_LOCK.deploymentId &&
    state.latestDeployment.status === "FAILED" &&
    state.latestDeployment.deploymentStopped === true &&
    state.latestDeployment.snapshotId === COLD_RECOVERY_LOCK.snapshotId &&
    state.activeDeployments.length === 0 &&
    state.domains.length === 1 &&
    state.domains[0]?.kind === "service" &&
    state.domains[0]?.id === COLD_RECOVERY_LOCK.domainId &&
    state.domains[0]?.domain === COLD_RECOVERY_LOCK.domain &&
    state.domains[0]?.targetPort === COLD_RECOVERY_LOCK.targetPort &&
    state.deployment.id === COLD_RECOVERY_LOCK.deploymentId &&
    state.deployment.projectId === COLD_RECOVERY_LOCK.projectId &&
    state.deployment.environmentId === COLD_RECOVERY_LOCK.environmentId &&
    state.deployment.serviceId === COLD_RECOVERY_LOCK.serviceId &&
    state.deployment.snapshotId === COLD_RECOVERY_LOCK.snapshotId &&
    state.deployment.commitHash === COLD_RECOVERY_LOCK.sourceSha &&
    state.deployment.imageDigest === null && state.deployment.patchId === null &&
    Array.isArray(state.rows) && state.rows.length > 0 &&
    state.rows.every((row) =>
      row.environmentId === COLD_RECOVERY_LOCK.environmentId &&
      (row.serviceId === null || row.serviceId === COLD_RECOVERY_LOCK.serviceId));
}

export function railwayPatchKeyShape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.map(railwayPatchKeyShape),
    };
  }
  if (!record(value)) return typeof value;
  const keys = Object.keys(value).sort();
  return {
    type: "object",
    keys,
    children: Object.fromEntries(keys.map((key) => [
      key,
      railwayPatchKeyShape(value[key]),
    ])),
  };
}

function historyProjection(value: unknown): HistoryProjection | null {
  if (!exactKeys(value, [
    "id",
    "createdAt",
    "object",
    "action",
    "outcome",
    "operationKind",
    "severity",
    "source",
    "workflowId",
    "activityPayload",
  ]) || !UUID_PATTERN.test(String(value.id)) || timestamp(value.createdAt) === null ||
    !["object", "action", "outcome", "operationKind", "severity", "source"]
      .every((key) => typeof value[key] === "string") ||
    !(value.workflowId === null || typeof value.workflowId === "string") ||
    !exactKeys(value.activityPayload, ["count", "names", "serviceId"]) ||
    value.activityPayload.count !== 1 ||
    !Array.isArray(value.activityPayload.names) ||
    value.activityPayload.names.length !== 1 ||
    value.activityPayload.names.some((name) => typeof name !== "string") ||
    value.activityPayload.serviceId !== COLD_RECOVERY_LOCK.serviceId) return null;
  return {
    id: String(value.id),
    createdAt: String(value.createdAt),
    object: String(value.object),
    action: String(value.action),
    outcome: String(value.outcome),
    operationKind: String(value.operationKind),
    severity: String(value.severity),
    source: String(value.source),
    workflowId: value.workflowId as string | null,
    activityPayload: {
      keys: Object.keys(value.activityPayload).sort(),
      count: 1,
      names: [...value.activityPayload.names] as string[],
      serviceId: COLD_RECOVERY_LOCK.serviceId,
    },
  };
}

function patchProjection(value: unknown): PatchProjection | null {
  if (!exactKeys(value, [
    "id",
    "environmentId",
    "status",
    "createdAt",
    "updatedAt",
    "appliedAt",
    "message",
    "patch",
  ]) || !UUID_PATTERN.test(String(value.id)) ||
    value.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    typeof value.status !== "string" || timestamp(value.createdAt) === null ||
    timestamp(value.updatedAt) === null ||
    !(value.appliedAt === null || timestamp(value.appliedAt) !== null) ||
    !(value.message === null || typeof value.message === "string") ||
    !record(value.patch)) return null;
  return {
    id: String(value.id),
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    status: value.status,
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    appliedAt: value.appliedAt as string | null,
    message: value.message as string | null,
    patchKeyShape: railwayPatchKeyShape(value.patch),
  };
}

function pageInfo(value: unknown): { hasNextPage: boolean; endCursor: string } | null {
  return exactKeys(value, ["hasNextPage", "endCursor"]) &&
      typeof value.hasNextPage === "boolean" &&
      typeof value.endCursor === "string" && value.endCursor.length > 0 &&
      value.endCursor.length <= 1024 && !/[\r\n\0]/.test(value.endCursor)
    ? { hasNextPage: value.hasNextPage, endCursor: value.endCursor }
    : null;
}

async function collectHistory(fetchImpl: typeof fetch, token: string): Promise<{
  readonly pages: readonly PageEvidence[];
  readonly rows: readonly HistoryProjection[];
}> {
  const pages: PageEvidence[] = [];
  const rows: HistoryProjection[] = [];
  const cursors = new Set<string>();
  const edgeCursors = new Set<string>();
  const ids = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const value = await railwayCall(fetchImpl, token, COLD_PROVIDER_HISTORY_QUERY, {
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      after,
    });
    if (!exactKeys(value, ["data"]) ||
      !exactKeys(value.data, ["environmentHistory"]) ||
      !exactKeys(value.data.environmentHistory, ["edges", "pageInfo"]) ||
      !Array.isArray(value.data.environmentHistory.edges) ||
      value.data.environmentHistory.edges.length < 1 ||
      value.data.environmentHistory.edges.length > PAGE_SIZE) fail("response_invalid");
    const parsedPage = pageInfo(value.data.environmentHistory.pageInfo);
    if (parsedPage === null || cursors.has(parsedPage.endCursor) ||
      (parsedPage.hasNextPage &&
        value.data.environmentHistory.edges.length !== PAGE_SIZE)) {
      fail("pagination_invalid");
    }
    const projected = value.data.environmentHistory.edges.map((edge) => {
      if (!exactKeys(edge, ["cursor", "node"]) ||
        typeof edge.cursor !== "string" || edge.cursor.length < 1 ||
        edge.cursor.length > 1024 || /[\r\n\0]/.test(edge.cursor) ||
        edgeCursors.has(edge.cursor)) {
        fail("response_invalid");
      }
      edgeCursors.add(edge.cursor);
      const row = historyProjection(edge.node);
      if (row === null || ids.has(row.id)) fail("response_invalid");
      ids.add(row.id);
      return row;
    });
    if (value.data.environmentHistory.edges.at(-1)?.cursor !==
      parsedPage.endCursor) fail("pagination_invalid");
    rows.push(...projected);
    if (rows.length > MAX_ROWS) fail("pagination_invalid");
    pages.push({
      requestAfter: after,
      count: projected.length,
      endCursor: parsedPage.endCursor,
      hasNextPage: parsedPage.hasNextPage,
    });
    cursors.add(parsedPage.endCursor);
    if (!parsedPage.hasNextPage) return { pages, rows };
    after = parsedPage.endCursor;
  }
  fail("pagination_invalid");
}

async function collectPatches(fetchImpl: typeof fetch, token: string): Promise<{
  readonly pages: readonly PageEvidence[];
  readonly rows: readonly PatchProjection[];
}> {
  const pages: PageEvidence[] = [];
  const rows: PatchProjection[] = [];
  const cursors = new Set<string>();
  const edgeCursors = new Set<string>();
  const ids = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const value = await railwayCall(fetchImpl, token, COLD_PROVIDER_PATCHES_QUERY, {
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      after,
    });
    if (!exactKeys(value, ["data"]) ||
      !exactKeys(value.data, ["environmentPatches"]) ||
      !exactKeys(value.data.environmentPatches, ["edges", "pageInfo"]) ||
      !Array.isArray(value.data.environmentPatches.edges) ||
      value.data.environmentPatches.edges.length < 1 ||
      value.data.environmentPatches.edges.length > PAGE_SIZE) fail("response_invalid");
    const parsedPage = pageInfo(value.data.environmentPatches.pageInfo);
    if (parsedPage === null || cursors.has(parsedPage.endCursor) ||
      (parsedPage.hasNextPage &&
        value.data.environmentPatches.edges.length !== PAGE_SIZE)) {
      fail("pagination_invalid");
    }
    const projected = value.data.environmentPatches.edges.map((edge) => {
      if (!exactKeys(edge, ["cursor", "node"]) ||
        typeof edge.cursor !== "string" || edge.cursor.length < 1 ||
        edge.cursor.length > 1024 || /[\r\n\0]/.test(edge.cursor) ||
        edgeCursors.has(edge.cursor)) fail("response_invalid");
      edgeCursors.add(edge.cursor);
      const row = patchProjection(edge.node);
      if (row === null || ids.has(row.id)) fail("response_invalid");
      ids.add(row.id);
      return row;
    });
    if (value.data.environmentPatches.edges.at(-1)?.cursor !==
      parsedPage.endCursor) fail("pagination_invalid");
    rows.push(...projected);
    if (rows.length > MAX_ROWS) fail("pagination_invalid");
    pages.push({
      requestAfter: after,
      count: projected.length,
      endCursor: parsedPage.endCursor,
      hasNextPage: parsedPage.hasNextPage,
    });
    cursors.add(parsedPage.endCursor);
    if (!parsedPage.hasNextPage) return { pages, rows };
    after = parsedPage.endCursor;
  }
  fail("pagination_invalid");
}

function chronological(rows: readonly { readonly createdAt: string }[]): boolean {
  return rows.every((row, index) => index === 0 ||
    Date.parse(rows[index - 1]!.createdAt) > Date.parse(row.createdAt));
}

function variableNamesFromShape(shape: unknown): readonly string[] | null {
  if (!record(shape) || shape.type !== "object" || !record(shape.children)) {
    return null;
  }
  const services = shape.children.services;
  if (!record(services) || services.type !== "object" ||
    !Array.isArray(services.keys) ||
    JSON.stringify(services.keys) !== JSON.stringify([COLD_RECOVERY_LOCK.serviceId]) ||
    !record(services.children)) return null;
  const target = services.children[COLD_RECOVERY_LOCK.serviceId];
  if (!record(target) || target.type !== "object" ||
    !Array.isArray(target.keys) ||
    JSON.stringify(target.keys) !== JSON.stringify(["variables"]) ||
    !record(target.children)) return null;
  const variables = target.children.variables;
  if (!record(variables) || variables.type !== "object" ||
    !Array.isArray(variables.keys) || variables.keys.length !== 1 ||
    typeof variables.keys[0] !== "string" ||
    !record(variables.children)) return null;
  const variableName = variables.keys[0];
  const variableShape = variables.children[variableName];
  return record(variableShape) &&
      canonical(variableShape) === canonical({
        type: "object",
        keys: ["value"],
        children: { value: "string" },
      }) &&
      Array.isArray(variables.keys) &&
      variables.keys.every((name) => typeof name === "string")
    ? variables.keys as string[]
    : null;
}

function scalePositiveControlExact(row: PatchProjection | undefined): boolean {
  if (!row || row.id !== COLD_PROVIDER_HISTORY_ANCHOR.historicalScalePatchId ||
    row.createdAt !== COLD_PROVIDER_HISTORY_ANCHOR.historicalScalePatchAt ||
    !record(row.patchKeyShape) || !record(row.patchKeyShape.children)) return false;
  const services = row.patchKeyShape.children.services;
  if (!record(services) || !record(services.children)) return false;
  const target = services.children[COLD_RECOVERY_LOCK.serviceId];
  if (!record(target) || !record(target.children)) return false;
  const deploy = target.children.deploy;
  return record(deploy) && record(deploy.children) &&
    Object.hasOwn(deploy.children, "multiRegionConfig");
}

function inWindow(createdAt: string, window: {
  readonly startedAt: string;
  readonly completedAt: string;
}): boolean {
  const value = Date.parse(createdAt);
  return value >= Date.parse(window.startedAt) &&
    value <= Date.parse(window.completedAt);
}

function suffixEventExact(
  row: HistoryProjection,
  variableName: string,
  window: ColdProviderAuthorizedRunWindow,
): boolean {
  return inWindow(row.createdAt, window) && row.object === "Variable" &&
    row.action === "updated" && row.outcome === "" &&
    row.operationKind === "" && row.severity === "INFO" &&
    row.source === "event" && row.workflowId === null &&
    JSON.stringify(row.activityPayload.keys) ===
      JSON.stringify(["count", "names", "serviceId"]) &&
    JSON.stringify(row.activityPayload.names) === JSON.stringify([variableName]);
}

function suffixPatchExact(
  row: PatchProjection,
  variableName: string,
  window: ColdProviderAuthorizedRunWindow,
): boolean {
  const createdAt = Date.parse(row.createdAt);
  const appliedAt = row.appliedAt === null ? Number.NaN : Date.parse(row.appliedAt);
  return inWindow(row.createdAt, window) && row.status === "COMMITTED" &&
    row.updatedAt === row.createdAt && row.message === "Setting 2 variables" &&
    Number.isFinite(appliedAt) && appliedAt <= createdAt &&
    createdAt - appliedAt <= 5_000 &&
    JSON.stringify(variableNamesFromShape(row.patchKeyShape)) ===
      JSON.stringify([variableName]);
}

async function crossFetchPatch(
  fetchImpl: typeof fetch,
  token: string,
  id: string,
): Promise<PatchProjection> {
  const value = await railwayCall(fetchImpl, token, COLD_PROVIDER_PATCH_QUERY, {
    id,
  });
  if (!exactKeys(value, ["data"]) ||
    !exactKeys(value.data, ["environmentPatch"])) fail("cross_fetch_invalid");
  const projection = patchProjection(value.data.environmentPatch);
  if (projection === null || projection.id !== id) fail("cross_fetch_invalid");
  return projection;
}

export async function readPermanentStagingColdProviderNoWriteProof(
  fetchImpl: typeof fetch,
  token: string,
  input: ColdProviderNoWriteProofInput,
): Promise<ColdProviderNoWriteProof> {
  if (
    !liveStateExact(input.liveState) ||
    timestamp(input.observedAt) === null ||
    input.replacement.runId === input.prepare.runId ||
    !/^[1-9][0-9]{0,19}$/.test(input.replacement.runId) ||
    !/^[1-9][0-9]{0,19}$/.test(input.prepare.runId) ||
    timestamp(input.replacement.startedAt) === null ||
    timestamp(input.replacement.completedAt) === null ||
    timestamp(input.prepare.startedAt) === null ||
    timestamp(input.prepare.completedAt) === null ||
    Date.parse(input.replacement.startedAt) >=
      Date.parse(input.replacement.completedAt) ||
    Date.parse(input.replacement.completedAt) >=
      Date.parse(input.prepare.startedAt) ||
    Date.parse(input.prepare.startedAt) >= Date.parse(input.prepare.completedAt) ||
    Date.parse(input.prepare.completedAt) >= Date.parse(input.observedAt)
  ) fail("input_invalid");

  const liveStateSha256 = sha256(fullStateCanonical(input.liveState));

  const [history, patches] = await Promise.all([
    collectHistory(fetchImpl, token),
    collectPatches(fetchImpl, token),
  ]);
  if (!chronological(history.rows) || !chronological(patches.rows)) {
    fail("chronology_invalid");
  }
  const historyPrefix = history.rows.filter((row) =>
    row.createdAt <= COLD_PROVIDER_HISTORY_ANCHOR.historyPrefixThrough);
  const historySuffix = history.rows.filter((row) =>
    row.createdAt > COLD_PROVIDER_HISTORY_ANCHOR.historyPrefixThrough);
  const patchPrefix = patches.rows.filter((row) =>
    row.createdAt <= COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixThrough);
  const patchSuffix = patches.rows.filter((row) =>
    row.createdAt > COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixThrough);
  const prefixEnvelope = {
    schemaVersion: "pintpath-railway-environment-patches-key-only-prefix/v1",
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    throughCreatedAtInclusive: COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixThrough,
    rows: patchPrefix,
  };
  if (
    historyPrefix.length !== COLD_PROVIDER_HISTORY_ANCHOR.historyPrefixCount ||
    sha256(canonical(historyPrefix)) !==
      COLD_PROVIDER_HISTORY_ANCHOR.historyPrefixRowsSha256 ||
    patchPrefix.length !== COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixCount ||
    sha256(canonical(patchPrefix)) !==
      COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixRowsSha256 ||
    sha256(canonical(prefixEnvelope)) !==
      COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixEnvelopeSha256 ||
    historyPrefix.at(-1)?.createdAt !==
      COLD_PROVIDER_HISTORY_ANCHOR.oldestHistoryAt ||
    patchPrefix.at(-1)?.createdAt !== COLD_PROVIDER_HISTORY_ANCHOR.oldestPatchAt
  ) fail("historical_prefix_invalid");
  if (!scalePositiveControlExact(patchPrefix.find((row) =>
    row.id === COLD_PROVIDER_HISTORY_ANCHOR.historicalScalePatchId))) {
    fail("positive_control_invalid");
  }
  for (const expected of COLD_PROVIDER_HISTORY_ANCHOR.pinnedVariablePatches) {
    const row = patchPrefix.find((candidate) => candidate.id === expected.id);
    if (!row || row.createdAt !== expected.createdAt ||
      JSON.stringify(variableNamesFromShape(row.patchKeyShape)) !==
        JSON.stringify([expected.variableName])) fail("pinned_patch_invalid");
  }
  const incidentWindows = [
    COLD_PROVIDER_HISTORY_ANCHOR.legacyQuiesceWindow,
    COLD_PROVIDER_HISTORY_ANCHOR.priorQuiesceWindow,
  ];
  if ([...historyPrefix, ...historySuffix].some((row) =>
    incidentWindows.some((window) => inWindow(row.createdAt, window))) ||
    [...patchPrefix, ...patchSuffix].some((row) =>
      incidentWindows.some((window) => inWindow(row.createdAt, window)))) {
    fail("incident_write_observed");
  }
  if (
    historySuffix.length !== 2 || patchSuffix.length !== 2 ||
    !suffixEventExact(
      historySuffix[0]!,
      "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
      input.prepare,
    ) ||
    !suffixEventExact(
      historySuffix[1]!,
      "SUPABASE_SERVICE_ROLE_KEY",
      input.replacement,
    ) ||
    !suffixPatchExact(
      patchSuffix[0]!,
      "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
      input.prepare,
    ) ||
    !suffixPatchExact(
      patchSuffix[1]!,
      "SUPABASE_SERVICE_ROLE_KEY",
      input.replacement,
    ) ||
    historySuffix[0]!.createdAt > patchSuffix[0]!.createdAt ||
    historySuffix[1]!.createdAt > patchSuffix[1]!.createdAt ||
    Date.parse(patchSuffix[0]!.createdAt) -
        Date.parse(historySuffix[0]!.createdAt) > 5_000 ||
    Date.parse(patchSuffix[1]!.createdAt) -
        Date.parse(historySuffix[1]!.createdAt) > 5_000
  ) fail("authorized_suffix_invalid");
  const crossFetched = await Promise.all(patchSuffix.map((row) =>
    crossFetchPatch(fetchImpl, token, row.id)));
  if (canonical(crossFetched) !== canonical(patchSuffix)) {
    fail("cross_fetch_invalid");
  }
  const [recheckedHistory, recheckedPatches] = await Promise.all([
    collectHistory(fetchImpl, token),
    collectPatches(fetchImpl, token),
  ]);
  if (
    canonical(recheckedHistory) !== canonical(history) ||
    canonical(recheckedPatches) !== canonical(patches)
  ) fail("ledger_changed_during_proof");
  return Object.freeze({
    schemaVersion: "pintpath-permanent-staging-cold-provider-no-write-proof/v1",
    observedAt: input.observedAt,
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    querySha256: {
      history: sha256(COLD_PROVIDER_HISTORY_QUERY),
      patches: sha256(COLD_PROVIDER_PATCHES_QUERY),
      patch: sha256(COLD_PROVIDER_PATCH_QUERY),
    },
    history: {
      pages: history.pages,
      count: history.rows.length,
      rowsSha256: sha256(canonical(history.rows)),
      prefixCount: historyPrefix.length,
      prefixRowsSha256: sha256(canonical(historyPrefix)),
      suffixEventIds: [historySuffix[0]!.id, historySuffix[1]!.id] as const,
    },
    patches: {
      pages: patches.pages,
      count: patches.rows.length,
      rowsSha256: sha256(canonical(patches.rows)),
      prefixCount: patchPrefix.length,
      prefixRowsSha256: sha256(canonical(patchPrefix)),
      suffixPatchIds: [patchSuffix[0]!.id, patchSuffix[1]!.id] as const,
      crossFetchProjectionSha256: sha256(canonical(crossFetched)),
    },
    incidentWindows,
    liveStateSha256,
    checks: {
      paginationCompleteExact: true,
      chronologicalOrderExact: true,
      historicalPrefixesExact: true,
      historicalScalePositiveControlExact: true,
      legacyUnauthorizedRunNoWriteExact: true,
      priorUnauthorizedRunNoWriteExact: true,
      authorizedSuffixExact: true,
      targetDeployAbsentFromSuffixExact: true,
      crossFetchedPatchesExact: true,
      ledgerRecheckExact: true,
      liveTopologyContinuityExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  } as const);
}
