const ARRAY_IS_ARRAY_EXACT = Array.isArray;
const ARRAY_EVERY_EXACT = Array.prototype.every;
const ARRAY_INCLUDES_EXACT = Array.prototype.includes;
const ARRAY_SOME_EXACT = Array.prototype.some;
const ARRAY_SORT_EXACT = Array.prototype.sort;
const BUFFER_BYTE_LENGTH_EXACT = Buffer.byteLength;
const JSON_PARSE_EXACT = JSON.parse;
const MAP_EXACT = Map;
const MAP_GET_EXACT = Map.prototype.get;
const MAP_SET_EXACT = Map.prototype.set;
const NUMBER_IS_SAFE_INTEGER_EXACT = Number.isSafeInteger;
const OBJECT_CREATE_EXACT = Object.create;
const OBJECT_DEFINE_PROPERTY_EXACT = Object.defineProperty;
const OBJECT_FREEZE_EXACT = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT =
  Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF_EXACT = Object.getPrototypeOf;
const OBJECT_HAS_OWN_EXACT = Object.hasOwn;
const REFLECT_APPLY_EXACT = Reflect.apply;
const REFLECT_OWN_KEYS_EXACT = Reflect.ownKeys;
const REGEXP_EXEC_EXACT = RegExp.prototype.exec;
const SET_EXACT = Set;
const SET_ADD_EXACT = Set.prototype.add;
const SET_HAS_EXACT = Set.prototype.has;
const SET_SIZE_EXACT = Object.getOwnPropertyDescriptor(
  Set.prototype,
  "size",
)?.get;
const STRING_INCLUDES_EXACT = String.prototype.includes;
const STRING_INDEX_OF_EXACT = String.prototype.indexOf;
const STRING_LAST_INDEX_OF_EXACT = String.prototype.lastIndexOf;
const STRING_SLICE_EXACT = String.prototype.slice;
const STRING_TRIM_EXACT = String.prototype.trim;
const WEAK_SET_ADD_EXACT = WeakSet.prototype.add;
const WEAK_SET_HAS_EXACT = WeakSet.prototype.has;

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_STATE =
  "HARD_DISABLED_LIVE_FIXTURES_REQUIRED" as const;

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK =
  OBJECT_FREEZE_EXACT({
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    productionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    allowedVariableNames: OBJECT_FREEZE_EXACT([
      "GOOGLE_MAPS_API_KEY",
      "GOOGLE_MAPS_MAP_ID",
      "GOOGLE_PLACES_API_KEY",
      "OPENAI_API_KEY",
    ] as const),
    expectedIsSealed: false,
    expectedReferences: OBJECT_FREEZE_EXACT([] as const),
  } as const);

export type PermanentStagingProviderVariableName =
  typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
    .allowedVariableNames[number];

const STRICT_JSON_CANDIDATE = "strict-json-candidate" as const;
const COMPLETE_PAGINATION_CANDIDATE =
  "complete-pagination-candidate" as const;
const CREATE_ONLY_PREFLIGHT_CANDIDATE =
  "create-only-preflight-candidate" as const;
const CREATE_ONLY_POSTFLIGHT_CANDIDATE =
  "create-only-postflight-candidate" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PAGE_ROWS = 100;
const MAX_PAGES = 20;
const MAX_INVENTORY_ROWS = 2_000;
const MAX_OPAQUE_ID_BYTES = 256;
const MAX_CURSOR_BYTES = 512;
const DEPLOYMENT_STATUSES = new SET_EXACT([
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "REMOVED",
  "SKIPPED",
  "SUCCESS",
  "WAITING",
] as const);

const VARIABLE_PAGE_AUTHORITIES = new WeakSet<object>();
const DEPLOYMENT_PAGE_AUTHORITIES = new WeakSet<object>();
const VARIABLE_INVENTORY_AUTHORITIES = new WeakSet<object>();
const DEPLOYMENT_INVENTORY_AUTHORITIES = new WeakSet<object>();
const PREFLIGHT_AUTHORITIES = new WeakSet<object>();

function arrayEvery<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): boolean {
  return REFLECT_APPLY_EXACT(ARRAY_EVERY_EXACT, values, [predicate]) as boolean;
}

function arrayIncludes<T>(values: readonly T[], value: T): boolean {
  return REFLECT_APPLY_EXACT(ARRAY_INCLUDES_EXACT, values, [value]) as boolean;
}

function arrayPush<T>(values: T[], value: T): number {
  const index = values.length;
  OBJECT_DEFINE_PROPERTY_EXACT(values, String(index), {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  if (values.length !== index + 1 || values[index] !== value) {
    throw new Error("array_publication_invalid");
  }
  return values.length;
}

function arraySome<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): boolean {
  return REFLECT_APPLY_EXACT(ARRAY_SOME_EXACT, values, [predicate]) as boolean;
}

function arraySort<T>(
  values: T[],
  compare: (left: T, right: T) => number,
): T[] {
  return REFLECT_APPLY_EXACT(ARRAY_SORT_EXACT, values, [compare]) as T[];
}

function setAdd<T>(values: Set<T>, value: T): void {
  REFLECT_APPLY_EXACT(SET_ADD_EXACT, values, [value]);
}

function setHas<T>(values: Set<T>, value: T): boolean {
  return REFLECT_APPLY_EXACT(SET_HAS_EXACT, values, [value]) === true;
}

function setSize<T>(values: Set<T>): number {
  if (typeof SET_SIZE_EXACT !== "function") return -1;
  return REFLECT_APPLY_EXACT(SET_SIZE_EXACT, values, []) as number;
}

function mapGet<K, V>(values: Map<K, V>, key: K): V | undefined {
  return REFLECT_APPLY_EXACT(MAP_GET_EXACT, values, [key]) as V | undefined;
}

function mapSet<K, V>(values: Map<K, V>, key: K, value: V): void {
  REFLECT_APPLY_EXACT(MAP_SET_EXACT, values, [key, value]);
}

function regexpTest(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY_EXACT(REGEXP_EXEC_EXACT, pattern, [value]) !== null;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): boolean {
  const seen = new SET_EXACT<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) return false;
    const candidate = key(value);
    if (setHas(seen, candidate)) return false;
    setAdd(seen, candidate);
  }
  return setSize(seen) === values.length;
}

export type PermanentStagingProviderDeploymentStatus =
  | "CRASHED"
  | "DEPLOYING"
  | "FAILED"
  | "INITIALIZING"
  | "NEEDS_APPROVAL"
  | "QUEUED"
  | "REMOVED"
  | "SKIPPED"
  | "SUCCESS"
  | "WAITING";

export interface PermanentStagingProviderVariableReferenceCandidate {
  readonly serviceId: string;
  readonly name: string;
}

export interface PermanentStagingProviderVariableRowCandidate {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly PermanentStagingProviderVariableReferenceCandidate[];
}

export interface PermanentStagingProviderVariableInventoryPageCandidate {
  readonly authority: typeof STRICT_JSON_CANDIDATE;
  readonly environmentId: string;
  readonly requestedAfter: string | null;
  readonly edgeCursors: readonly string[];
  readonly rows: readonly PermanentStagingProviderVariableRowCandidate[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface PermanentStagingProviderVariableInventoryCandidate {
  readonly authority: typeof COMPLETE_PAGINATION_CANDIDATE;
  readonly environmentId: string;
  readonly pageCount: number;
  readonly rowCount: number;
  readonly rows: readonly PermanentStagingProviderVariableRowCandidate[];
}

export interface PermanentStagingProviderDeploymentRowCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly status: PermanentStagingProviderDeploymentStatus;
  readonly deploymentStopped: boolean;
  readonly snapshotId: string | null;
}

export interface PermanentStagingProviderDeploymentInventoryPageCandidate {
  readonly authority: typeof STRICT_JSON_CANDIDATE;
  readonly requestedAfter: string | null;
  readonly edgeCursors: readonly string[];
  readonly rows: readonly PermanentStagingProviderDeploymentRowCandidate[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface PermanentStagingProviderDeploymentInventoryCandidate {
  readonly authority: typeof COMPLETE_PAGINATION_CANDIDATE;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly pageCount: number;
  readonly rowCount: number;
  readonly rows: readonly PermanentStagingProviderDeploymentRowCandidate[];
}

export interface PermanentStagingProviderVariableCreatePreflightCandidate {
  readonly authority: typeof CREATE_ONLY_PREFLIGHT_CANDIDATE;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly variableName: PermanentStagingProviderVariableName;
  readonly targetAbsent: true;
  readonly noSharedOrForeignShadow: true;
  readonly variableInventory: PermanentStagingProviderVariableInventoryCandidate;
  readonly deploymentInventory: PermanentStagingProviderDeploymentInventoryCandidate;
}

export interface PermanentStagingProviderVariableCreatePostflightCandidate {
  readonly authority: typeof CREATE_ONLY_POSTFLIGHT_CANDIDATE;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly variableName: PermanentStagingProviderVariableName;
  readonly variableId: string;
  readonly exactSingleCreate: true;
  readonly priorVariablesUnchanged: true;
  readonly deploymentInventoryUnchanged: true;
  readonly expectedIsSealed: false;
  readonly expectedReferences: readonly [];
  readonly beforeVariableRowCount: number;
  readonly afterVariableRowCount: number;
  readonly deploymentRowCount: number;
}

interface PageShape {
  readonly authority: typeof STRICT_JSON_CANDIDATE;
  readonly requestedAfter: string | null;
  readonly edgeCursors: readonly string[];
  readonly rows: readonly unknown[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

interface VariablePageShape extends PageShape {
  readonly environmentId: string;
}

function ownDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || ARRAY_IS_ARRAY_EXACT(value)) {
    return false;
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF_EXACT(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
  if (
    keys.length !== expectedKeys.length
    || arraySome(keys, (key, index) => key !== expectedKeys[index])
  ) return false;
  return arrayEvery(expectedKeys, (key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined
      && OBJECT_HAS_OWN_EXACT(descriptor, "value")
      && descriptor.enumerable === true;
  });
}

function denseArray(value: unknown, maximum: number): value is readonly unknown[] {
  if (!ARRAY_IS_ARRAY_EXACT(value)
    || OBJECT_GET_PROTOTYPE_OF_EXACT(value) !== Array.prototype) {
    return false;
  }
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || !OBJECT_HAS_OWN_EXACT(lengthDescriptor, "value")
    || !NUMBER_IS_SAFE_INTEGER_EXACT(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximum
    || keys.length !== lengthDescriptor.value + 1
  ) return false;
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
      || descriptor.enumerable !== true
    ) return false;
  }
  return arrayEvery(keys, (key) =>
    key === "length"
    || typeof key === "string"
      && regexpTest(/^(?:0|[1-9][0-9]*)$/, key));
}

function ownDataReferences(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof input !== "object" || input === null || ARRAY_IS_ARRAY_EXACT(input)) {
      return null;
    }
    const prototype = OBJECT_GET_PROTOTYPE_OF_EXACT(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(input) as unknown as
      Record<PropertyKey, PropertyDescriptor>;
    const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
    if (
      keys.length !== expectedKeys.length
      || arraySome(keys, (key, index) => key !== expectedKeys[index])
    ) return null;
    const output = OBJECT_CREATE_EXACT(null) as Record<string, unknown>;
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const key = expectedKeys[index];
      if (key === undefined) return null;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
        || descriptor.enumerable !== true
      ) return null;
      OBJECT_DEFINE_PROPERTY_EXACT(output, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: descriptor.value,
      });
    }
    return OBJECT_FREEZE_EXACT(output);
  } catch {
    return null;
  }
}

function ownArrayReferences(
  input: unknown,
  maximum: number,
): readonly unknown[] | null {
  try {
    if (!ARRAY_IS_ARRAY_EXACT(input)
      || OBJECT_GET_PROTOTYPE_OF_EXACT(input) !== Array.prototype) {
      return null;
    }
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(input) as unknown as
      Record<PropertyKey, PropertyDescriptor>;
    const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined
      || !OBJECT_HAS_OWN_EXACT(lengthDescriptor, "value")
      || !NUMBER_IS_SAFE_INTEGER_EXACT(lengthDescriptor.value)
      || lengthDescriptor.value < 1
      || lengthDescriptor.value > maximum
      || keys.length !== lengthDescriptor.value + 1
    ) return null;
    const output: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined
        || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
        || descriptor.enumerable !== true
      ) return null;
      arrayPush(output, descriptor.value);
    }
    return OBJECT_FREEZE_EXACT(output);
  } catch {
    return null;
  }
}

function brand<T extends object>(registry: WeakSet<object>, value: T): T {
  REFLECT_APPLY_EXACT(WEAK_SET_ADD_EXACT, registry, [value]);
  return value;
}

function hasBrand(registry: WeakSet<object>, value: object): boolean {
  return REFLECT_APPLY_EXACT(WEAK_SET_HAS_EXACT, registry, [value]) === true;
}

function parseBoundedJson(source: unknown): unknown | null {
  if (
    typeof source !== "string"
    || BUFFER_BYTE_LENGTH_EXACT(source, "utf8") === 0
    || BUFFER_BYTE_LENGTH_EXACT(source, "utf8") > MAX_RESPONSE_BYTES
    || REFLECT_APPLY_EXACT(STRING_INCLUDES_EXACT, source, ["\0"])
  ) return null;
  try {
    return REFLECT_APPLY_EXACT(JSON_PARSE_EXACT, JSON, [source]) as unknown;
  } catch {
    return null;
  }
}

function safeOpaqueString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return typeof value === "string"
    && BUFFER_BYTE_LENGTH_EXACT(value, "utf8") >= 1
    && BUFFER_BYTE_LENGTH_EXACT(value, "utf8") <= maximumBytes
    && value === REFLECT_APPLY_EXACT(STRING_TRIM_EXACT, value, [])
    && !regexpTest(/[\r\n\0]/, value);
}

function exactCursor(value: unknown): value is string {
  return safeOpaqueString(value, MAX_CURSOR_BYTES);
}

function allowedVariableName(
  value: unknown,
): value is PermanentStagingProviderVariableName {
  return typeof value === "string"
    && arrayIncludes(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
        .allowedVariableNames,
        value as PermanentStagingProviderVariableName,
    );
}

function bytewiseCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function referenceKey(
  value: PermanentStagingProviderVariableReferenceCandidate,
): string {
  return `${value.serviceId}\0${value.name}`;
}

function variableTupleKey(
  value: PermanentStagingProviderVariableRowCandidate,
): string {
  return `${value.serviceId ?? "shared"}\0${value.name}`;
}

function variableSortKey(
  value: PermanentStagingProviderVariableRowCandidate,
): string {
  return `${variableTupleKey(value)}\0${value.id}`;
}

function freezeReference(
  serviceId: string,
  name: string,
): PermanentStagingProviderVariableReferenceCandidate {
  return OBJECT_FREEZE_EXACT({ serviceId, name });
}

function normalizeReferences(
  value: unknown,
  ownerServiceId: string | null,
): readonly PermanentStagingProviderVariableReferenceCandidate[] | null {
  if (!denseArray(value, MAX_PAGE_ROWS)) return null;
  const references: PermanentStagingProviderVariableReferenceCandidate[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!safeOpaqueString(candidate, 512)) return null;
    if (regexpTest(VARIABLE_NAME_PATTERN, candidate)) {
      if (ownerServiceId === null) return null;
      arrayPush(references, freezeReference(ownerServiceId, candidate));
      continue;
    }
    const separator = REFLECT_APPLY_EXACT(STRING_INDEX_OF_EXACT, candidate, [
      ".",
    ]) as number;
    if (
      separator < 1
      || separator !== REFLECT_APPLY_EXACT(
        STRING_LAST_INDEX_OF_EXACT,
        candidate,
        ["."],
      )
      || !regexpTest(UUID_PATTERN, REFLECT_APPLY_EXACT(
        STRING_SLICE_EXACT,
        candidate,
        [0, separator],
      ) as string)
      || !regexpTest(VARIABLE_NAME_PATTERN, REFLECT_APPLY_EXACT(
        STRING_SLICE_EXACT,
        candidate,
        [separator + 1],
      ) as string)
    ) return null;
    arrayPush(references, freezeReference(
      REFLECT_APPLY_EXACT(STRING_SLICE_EXACT, candidate, [0, separator]) as string,
      REFLECT_APPLY_EXACT(STRING_SLICE_EXACT, candidate, [separator + 1]) as string,
    ));
  }
  arraySort(references, (left, right) =>
    bytewiseCompare(referenceKey(left), referenceKey(right)));
  if (!uniqueBy(references, referenceKey)) {
    return null;
  }
  return OBJECT_FREEZE_EXACT(references);
}

function parseVariableRow(
  value: unknown,
): PermanentStagingProviderVariableRowCandidate | null {
  if (!ownDataObject(value, [
    "id",
    "name",
    "environmentId",
    "serviceId",
    "isSealed",
    "references",
  ])) return null;
  if (
    !safeOpaqueString(value.id, MAX_OPAQUE_ID_BYTES)
    || typeof value.name !== "string"
    || !regexpTest(VARIABLE_NAME_PATTERN, value.name)
    || typeof value.environmentId !== "string"
    || !regexpTest(UUID_PATTERN, value.environmentId)
    || !(value.serviceId === null
      || typeof value.serviceId === "string"
        && regexpTest(UUID_PATTERN, value.serviceId))
    || typeof value.isSealed !== "boolean"
  ) return null;
  const references = normalizeReferences(value.references, value.serviceId);
  if (references === null) return null;
  return OBJECT_FREEZE_EXACT({
    id: value.id,
    name: value.name,
    environmentId: value.environmentId,
    serviceId: value.serviceId,
    isSealed: value.isSealed,
    references,
  });
}

function parsePageInfo(value: unknown): {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
} | null {
  if (!ownDataObject(value, ["hasNextPage", "endCursor"])) return null;
  if (
    typeof value.hasNextPage !== "boolean"
    || !(value.endCursor === null || exactCursor(value.endCursor))
    || value.hasNextPage && value.endCursor === null
  ) return null;
  return OBJECT_FREEZE_EXACT({
    hasNextPage: value.hasNextPage,
    endCursor: value.endCursor,
  });
}

function requestedAfterExact(value: unknown): value is string | null {
  return value === null || exactCursor(value);
}

export function parsePermanentStagingProviderVariableInventoryPage(
  source: unknown,
  requestedAfter: string | null,
): PermanentStagingProviderVariableInventoryPageCandidate | null {
  if (!requestedAfterExact(requestedAfter)) return null;
  const parsed = parseBoundedJson(source);
  if (!ownDataObject(parsed, ["data"])) return null;
  if (!ownDataObject(parsed.data, ["environment"])) return null;
  const environment = parsed.data.environment;
  if (!ownDataObject(environment, ["id", "variables"])) return null;
  if (
    environment.id
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
        .stagingEnvironmentId
    || !ownDataObject(environment.variables, ["edges", "pageInfo"])
  ) return null;
  const connection = environment.variables;
  if (!denseArray(connection.edges, MAX_PAGE_ROWS)) return null;
  const pageInfo = parsePageInfo(connection.pageInfo);
  if (pageInfo === null) return null;
  const rows: PermanentStagingProviderVariableRowCandidate[] = [];
  const edgeCursors: string[] = [];
  for (let index = 0; index < connection.edges.length; index += 1) {
    const edge = connection.edges[index];
    if (!ownDataObject(edge, ["cursor", "node"]) || !exactCursor(edge.cursor)) {
      return null;
    }
    const row = parseVariableRow(edge.node);
    if (row === null || row.environmentId !== environment.id) return null;
    arrayPush(edgeCursors, edge.cursor);
    arrayPush(rows, row);
  }
  if (
    !uniqueBy(edgeCursors, (cursor) => cursor)
    || pageInfo.hasNextPage && edgeCursors.length === 0
    || edgeCursors.length === 0 && pageInfo.endCursor !== null
    || edgeCursors.length > 0
      && pageInfo.endCursor !== edgeCursors[edgeCursors.length - 1]
  ) return null;
  return brand(VARIABLE_PAGE_AUTHORITIES, OBJECT_FREEZE_EXACT({
    authority: STRICT_JSON_CANDIDATE,
    environmentId: environment.id,
    requestedAfter,
    edgeCursors: OBJECT_FREEZE_EXACT(edgeCursors),
    rows: OBJECT_FREEZE_EXACT(rows),
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  }));
}

function parseDeploymentStatus(
  value: unknown,
): value is PermanentStagingProviderDeploymentStatus {
  return typeof value === "string"
    && setHas(
      DEPLOYMENT_STATUSES,
      value as PermanentStagingProviderDeploymentStatus,
    );
}

function parseDeploymentRow(
  value: unknown,
): PermanentStagingProviderDeploymentRowCandidate | null {
  if (!ownDataObject(value, [
    "id",
    "projectId",
    "environmentId",
    "serviceId",
    "status",
    "deploymentStopped",
    "snapshotId",
  ])) return null;
  if (
    typeof value.id !== "string"
    || !regexpTest(UUID_PATTERN, value.id)
    || value.projectId
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK.projectId
    || value.environmentId
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
        .stagingEnvironmentId
    || value.serviceId
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK.serviceId
    || !parseDeploymentStatus(value.status)
    || typeof value.deploymentStopped !== "boolean"
    || !(value.snapshotId === null
      || typeof value.snapshotId === "string"
        && regexpTest(UUID_PATTERN, value.snapshotId))
  ) return null;
  return OBJECT_FREEZE_EXACT({
    id: value.id,
    projectId: value.projectId,
    environmentId: value.environmentId,
    serviceId: value.serviceId,
    status: value.status,
    deploymentStopped: value.deploymentStopped,
    snapshotId: value.snapshotId,
  });
}

export function parsePermanentStagingProviderDeploymentInventoryPage(
  source: unknown,
  requestedAfter: string | null,
): PermanentStagingProviderDeploymentInventoryPageCandidate | null {
  if (!requestedAfterExact(requestedAfter)) return null;
  const parsed = parseBoundedJson(source);
  if (!ownDataObject(parsed, ["data"])) return null;
  if (!ownDataObject(parsed.data, ["deployments"])) return null;
  const connection = parsed.data.deployments;
  if (
    !ownDataObject(connection, ["edges", "pageInfo"])
    || !denseArray(connection.edges, MAX_PAGE_ROWS)
  ) return null;
  const pageInfo = parsePageInfo(connection.pageInfo);
  if (pageInfo === null) return null;
  const rows: PermanentStagingProviderDeploymentRowCandidate[] = [];
  const edgeCursors: string[] = [];
  for (let index = 0; index < connection.edges.length; index += 1) {
    const edge = connection.edges[index];
    if (!ownDataObject(edge, ["cursor", "node"]) || !exactCursor(edge.cursor)) {
      return null;
    }
    const row = parseDeploymentRow(edge.node);
    if (row === null) return null;
    arrayPush(edgeCursors, edge.cursor);
    arrayPush(rows, row);
  }
  if (
    !uniqueBy(edgeCursors, (cursor) => cursor)
    || pageInfo.hasNextPage && edgeCursors.length === 0
    || edgeCursors.length === 0 && pageInfo.endCursor !== null
    || edgeCursors.length > 0
      && pageInfo.endCursor !== edgeCursors[edgeCursors.length - 1]
  ) return null;
  return brand(DEPLOYMENT_PAGE_AUTHORITIES, OBJECT_FREEZE_EXACT({
    authority: STRICT_JSON_CANDIDATE,
    requestedAfter,
    edgeCursors: OBJECT_FREEZE_EXACT(edgeCursors),
    rows: OBJECT_FREEZE_EXACT(rows),
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  }));
}

function strictCommonPageShape(value: Record<string, unknown>): value is
Record<string, unknown> & PageShape {
  return value.authority === STRICT_JSON_CANDIDATE
    && requestedAfterExact(value.requestedAfter)
    && denseArray(value.edgeCursors, MAX_PAGE_ROWS)
    && arrayEvery(value.edgeCursors, (cursor) => exactCursor(cursor))
    && denseArray(value.rows, MAX_PAGE_ROWS)
    && value.rows.length === value.edgeCursors.length
    && typeof value.hasNextPage === "boolean"
    && (value.endCursor === null || exactCursor(value.endCursor));
}

function strictVariablePageShape(value: unknown): value is VariablePageShape {
  if (!ownDataObject(value, [
    "authority",
    "environmentId",
    "requestedAfter",
    "edgeCursors",
    "rows",
    "hasNextPage",
    "endCursor",
  ])) return false;
  return strictCommonPageShape(value)
    && typeof value.environmentId === "string";
}

function strictDeploymentPageShape(value: unknown): value is PageShape {
  if (!ownDataObject(value, [
    "authority",
    "requestedAfter",
    "edgeCursors",
    "rows",
    "hasNextPage",
    "endCursor",
  ])) return false;
  return strictCommonPageShape(value);
}

function paginationSequenceExact(pages: readonly PageShape[]): boolean {
  if (pages.length === 0 || pages.length > MAX_PAGES) return false;
  const cursors = new SET_EXACT<string>();
  let expectedAfter: string | null = null;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    if (
      page.requestedAfter !== expectedAfter
      || page.hasNextPage !== (index < pages.length - 1)
      || page.edgeCursors.length === 0 && page.endCursor !== null
      || page.edgeCursors.length > 0
        && page.endCursor !== page.edgeCursors[page.edgeCursors.length - 1]
      || page.hasNextPage && page.endCursor === null
    ) return false;
    for (let cursorIndex = 0; cursorIndex < page.edgeCursors.length; cursorIndex += 1) {
      const cursor = page.edgeCursors[cursorIndex];
      if (cursor === undefined || setHas(cursors, cursor)) return false;
      setAdd(cursors, cursor);
    }
    expectedAfter = page.endCursor;
  }
  return true;
}

function cloneVariableRow(
  row: PermanentStagingProviderVariableRowCandidate,
): PermanentStagingProviderVariableRowCandidate | null {
  if (!ownDataObject(row, [
    "id",
    "name",
    "environmentId",
    "serviceId",
    "isSealed",
    "references",
  ])) return null;
  if (
    !safeOpaqueString(row.id, MAX_OPAQUE_ID_BYTES)
    || typeof row.name !== "string"
    || !regexpTest(VARIABLE_NAME_PATTERN, row.name)
    || typeof row.environmentId !== "string"
    || row.environmentId
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
        .stagingEnvironmentId
    || !(row.serviceId === null
      || typeof row.serviceId === "string"
        && regexpTest(UUID_PATTERN, row.serviceId))
    || typeof row.isSealed !== "boolean"
    || !denseArray(row.references, MAX_PAGE_ROWS)
  ) return null;
  const references: PermanentStagingProviderVariableReferenceCandidate[] = [];
  for (let index = 0; index < row.references.length; index += 1) {
    const reference = row.references[index];
    if (
      !ownDataObject(reference, ["serviceId", "name"])
      || typeof reference.serviceId !== "string"
      || !regexpTest(UUID_PATTERN, reference.serviceId)
      || typeof reference.name !== "string"
      || !regexpTest(VARIABLE_NAME_PATTERN, reference.name)
    ) return null;
    arrayPush(references, freezeReference(reference.serviceId, reference.name));
  }
  if (
    arraySome(references, (reference, index) => index > 0
      && referenceKey(references[index - 1]!) >= referenceKey(reference))
  ) return null;
  return OBJECT_FREEZE_EXACT({
    id: row.id,
    name: row.name,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    isSealed: row.isSealed,
    references: OBJECT_FREEZE_EXACT(references),
  });
}

function cloneDeploymentRow(
  row: PermanentStagingProviderDeploymentRowCandidate,
): PermanentStagingProviderDeploymentRowCandidate | null {
  if (!ownDataObject(row, [
    "id",
    "projectId",
    "environmentId",
    "serviceId",
    "status",
    "deploymentStopped",
    "snapshotId",
  ])) return null;
  return parseDeploymentRow(row);
}

export function foldPermanentStagingProviderVariableInventoryPages(
  pagesInput: unknown,
): PermanentStagingProviderVariableInventoryCandidate | null {
  const pageValues = ownArrayReferences(pagesInput, MAX_PAGES);
  if (pageValues === null) return null;
  const pages: PermanentStagingProviderVariableInventoryPageCandidate[] = [];
  for (let index = 0; index < pageValues.length; index += 1) {
    const candidate = pageValues[index];
    if (
      typeof candidate !== "object"
      || candidate === null
      || !hasBrand(VARIABLE_PAGE_AUTHORITIES, candidate)
      || !strictVariablePageShape(candidate)
    ) return null;
    if (
      candidate.environmentId
        !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
          .stagingEnvironmentId
    ) return null;
    arrayPush(
      pages,
      candidate as PermanentStagingProviderVariableInventoryPageCandidate,
    );
  }
  if (!paginationSequenceExact(pages)) return null;
  const rows: PermanentStagingProviderVariableRowCandidate[] = [];
  const allCursors = new SET_EXACT<string>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (page === undefined) return null;
    for (let cursorIndex = 0; cursorIndex < page.edgeCursors.length; cursorIndex += 1) {
      const cursor = page.edgeCursors[cursorIndex];
      if (cursor === undefined || setHas(allCursors, cursor)) return null;
      setAdd(allCursors, cursor);
    }
    for (let rowIndex = 0; rowIndex < page.rows.length; rowIndex += 1) {
      const row = page.rows[rowIndex];
      if (row === undefined) return null;
      const cloned = cloneVariableRow(row);
      if (cloned === null) return null;
      arrayPush(rows, cloned);
      if (rows.length > MAX_INVENTORY_ROWS) return null;
    }
  }
  if (
    !uniqueBy(rows, (row) => row.id)
    || !uniqueBy(rows, variableTupleKey)
  ) return null;
  arraySort(rows, (left, right) =>
    bytewiseCompare(variableSortKey(left), variableSortKey(right)));
  return brand(VARIABLE_INVENTORY_AUTHORITIES, OBJECT_FREEZE_EXACT({
    authority: COMPLETE_PAGINATION_CANDIDATE,
    environmentId:
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
        .stagingEnvironmentId,
    pageCount: pages.length,
    rowCount: rows.length,
    rows: OBJECT_FREEZE_EXACT(rows),
  }));
}

export function foldPermanentStagingProviderDeploymentInventoryPages(
  pagesInput: unknown,
): PermanentStagingProviderDeploymentInventoryCandidate | null {
  const pageValues = ownArrayReferences(pagesInput, MAX_PAGES);
  if (pageValues === null) return null;
  const pages: PermanentStagingProviderDeploymentInventoryPageCandidate[] = [];
  for (let index = 0; index < pageValues.length; index += 1) {
    const candidate = pageValues[index];
    if (
      typeof candidate !== "object"
      || candidate === null
      || !hasBrand(DEPLOYMENT_PAGE_AUTHORITIES, candidate)
      ||
      !strictDeploymentPageShape(candidate)
    ) return null;
    arrayPush(
      pages,
      candidate as PermanentStagingProviderDeploymentInventoryPageCandidate,
    );
  }
  if (!paginationSequenceExact(pages)) return null;
  const rows: PermanentStagingProviderDeploymentRowCandidate[] = [];
  const allCursors = new SET_EXACT<string>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (page === undefined) return null;
    for (let cursorIndex = 0; cursorIndex < page.edgeCursors.length; cursorIndex += 1) {
      const cursor = page.edgeCursors[cursorIndex];
      if (cursor === undefined || setHas(allCursors, cursor)) return null;
      setAdd(allCursors, cursor);
    }
    for (let rowIndex = 0; rowIndex < page.rows.length; rowIndex += 1) {
      const row = page.rows[rowIndex];
      if (row === undefined) return null;
      const cloned = cloneDeploymentRow(row);
      if (cloned === null) return null;
      arrayPush(rows, cloned);
      if (rows.length > MAX_INVENTORY_ROWS) return null;
    }
  }
  if (!uniqueBy(rows, (row) => row.id)) return null;
  arraySort(rows, (left, right) => bytewiseCompare(left.id, right.id));
  const lock =
    PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK;
  return brand(DEPLOYMENT_INVENTORY_AUTHORITIES, OBJECT_FREEZE_EXACT({
    authority: COMPLETE_PAGINATION_CANDIDATE,
    projectId: lock.projectId,
    environmentId: lock.stagingEnvironmentId,
    serviceId: lock.serviceId,
    pageCount: pages.length,
    rowCount: rows.length,
    rows: OBJECT_FREEZE_EXACT(rows),
  }));
}

function variableRowExact(
  left: PermanentStagingProviderVariableRowCandidate,
  right: PermanentStagingProviderVariableRowCandidate,
): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.environmentId === right.environmentId
    && left.serviceId === right.serviceId
    && left.isSealed === right.isSealed
    && left.references.length === right.references.length
    && arrayEvery(left.references, (reference, index) =>
      referenceKey(reference) === referenceKey(right.references[index]!));
}

function deploymentRowExact(
  left: PermanentStagingProviderDeploymentRowCandidate,
  right: PermanentStagingProviderDeploymentRowCandidate,
): boolean {
  return left.id === right.id
    && left.projectId === right.projectId
    && left.environmentId === right.environmentId
    && left.serviceId === right.serviceId
    && left.status === right.status
    && left.deploymentStopped === right.deploymentStopped
    && left.snapshotId === right.snapshotId;
}

function variableInventoryExact(
  value: unknown,
): value is PermanentStagingProviderVariableInventoryCandidate {
  if (
    typeof value !== "object"
    || value === null
    || !hasBrand(VARIABLE_INVENTORY_AUTHORITIES, value)
  ) return false;
  if (!ownDataObject(value, [
    "authority",
    "environmentId",
    "pageCount",
    "rowCount",
    "rows",
  ])) return false;
  if (
    value.authority !== COMPLETE_PAGINATION_CANDIDATE
    || value.environmentId
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
        .stagingEnvironmentId
    || !NUMBER_IS_SAFE_INTEGER_EXACT(value.pageCount)
    || (value.pageCount as number) < 1
    || (value.pageCount as number) > MAX_PAGES
    || !NUMBER_IS_SAFE_INTEGER_EXACT(value.rowCount)
    || (value.rowCount as number) < 0
    || (value.rowCount as number) > MAX_INVENTORY_ROWS
    || !denseArray(value.rows, MAX_INVENTORY_ROWS)
    || value.rows.length !== value.rowCount
    || (value.rowCount as number) > (value.pageCount as number) * MAX_PAGE_ROWS
    || (value.rowCount === 0 && value.pageCount !== 1)
    || (value.pageCount as number) > (value.rowCount as number) + 1
  ) return false;
  let priorSortKey: string | null = null;
  const ids = new SET_EXACT<string>();
  const tuples = new SET_EXACT<string>();
  for (let index = 0; index < value.rows.length; index += 1) {
    const row = value.rows[index];
    if (row === undefined) return false;
    const cloned = cloneVariableRow(
      row as PermanentStagingProviderVariableRowCandidate,
    );
    if (cloned === null) return false;
    const sortKey = variableSortKey(cloned);
    const tuple = variableTupleKey(cloned);
    if (
      priorSortKey !== null && priorSortKey >= sortKey
      || setHas(ids, cloned.id)
      || setHas(tuples, tuple)
    ) return false;
    priorSortKey = sortKey;
    setAdd(ids, cloned.id);
    setAdd(tuples, tuple);
  }
  return true;
}

function deploymentInventoryExact(
  value: unknown,
): value is PermanentStagingProviderDeploymentInventoryCandidate {
  if (
    typeof value !== "object"
    || value === null
    || !hasBrand(DEPLOYMENT_INVENTORY_AUTHORITIES, value)
  ) return false;
  if (!ownDataObject(value, [
    "authority",
    "projectId",
    "environmentId",
    "serviceId",
    "pageCount",
    "rowCount",
    "rows",
  ])) return false;
  const lock =
    PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK;
  if (
    value.authority !== COMPLETE_PAGINATION_CANDIDATE
    || value.projectId !== lock.projectId
    || value.environmentId !== lock.stagingEnvironmentId
    || value.serviceId !== lock.serviceId
    || !NUMBER_IS_SAFE_INTEGER_EXACT(value.pageCount)
    || (value.pageCount as number) < 1
    || (value.pageCount as number) > MAX_PAGES
    || !NUMBER_IS_SAFE_INTEGER_EXACT(value.rowCount)
    || (value.rowCount as number) < 0
    || (value.rowCount as number) > MAX_INVENTORY_ROWS
    || !denseArray(value.rows, MAX_INVENTORY_ROWS)
    || value.rows.length !== value.rowCount
    || (value.rowCount as number) > (value.pageCount as number) * MAX_PAGE_ROWS
    || (value.rowCount === 0 && value.pageCount !== 1)
    || (value.pageCount as number) > (value.rowCount as number) + 1
  ) return false;
  let priorId: string | null = null;
  for (let index = 0; index < value.rows.length; index += 1) {
    const row = value.rows[index];
    if (row === undefined) return false;
    const cloned = cloneDeploymentRow(
      row as PermanentStagingProviderDeploymentRowCandidate,
    );
    if (cloned === null || priorId !== null && priorId >= cloned.id) return false;
    priorId = cloned.id;
  }
  return true;
}

export function evaluatePermanentStagingProviderVariableCreatePreflight(input: {
  readonly variableName: unknown;
  readonly variableInventory: unknown;
  readonly deploymentInventory: unknown;
}): PermanentStagingProviderVariableCreatePreflightCandidate | null {
  const snapshot = ownDataReferences(input, [
    "variableName",
    "variableInventory",
    "deploymentInventory",
  ]);
  if (snapshot === null) return null;
  if (
    !allowedVariableName(snapshot.variableName)
    || !variableInventoryExact(snapshot.variableInventory)
    || !deploymentInventoryExact(snapshot.deploymentInventory)
    || arraySome(snapshot.variableInventory.rows, (row) =>
      row.name === snapshot.variableName)
  ) return null;
  const lock =
    PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK;
  return brand(PREFLIGHT_AUTHORITIES, OBJECT_FREEZE_EXACT({
    authority: CREATE_ONLY_PREFLIGHT_CANDIDATE,
    projectId: lock.projectId,
    environmentId: lock.stagingEnvironmentId,
    serviceId: lock.serviceId,
    variableName: snapshot.variableName,
    targetAbsent: true,
    noSharedOrForeignShadow: true,
    variableInventory: snapshot.variableInventory,
    deploymentInventory: snapshot.deploymentInventory,
  }));
}

function preflightExact(
  value: unknown,
): value is PermanentStagingProviderVariableCreatePreflightCandidate {
  if (
    typeof value !== "object"
    || value === null
    || !hasBrand(PREFLIGHT_AUTHORITIES, value)
  ) return false;
  if (!ownDataObject(value, [
    "authority",
    "projectId",
    "environmentId",
    "serviceId",
    "variableName",
    "targetAbsent",
    "noSharedOrForeignShadow",
    "variableInventory",
    "deploymentInventory",
  ])) return false;
  const lock =
    PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK;
  return value.authority === CREATE_ONLY_PREFLIGHT_CANDIDATE
    && value.projectId === lock.projectId
    && value.environmentId === lock.stagingEnvironmentId
    && value.serviceId === lock.serviceId
    && allowedVariableName(value.variableName)
    && value.targetAbsent === true
    && value.noSharedOrForeignShadow === true
    && variableInventoryExact(value.variableInventory)
    && deploymentInventoryExact(value.deploymentInventory)
    && !arraySome(value.variableInventory.rows, (row) =>
      row.name === value.variableName);
}

export function evaluatePermanentStagingProviderVariableCreatePostflight(input: {
  readonly preflight: unknown;
  readonly variableInventory: unknown;
  readonly deploymentInventory: unknown;
}): PermanentStagingProviderVariableCreatePostflightCandidate | null {
  const snapshot = ownDataReferences(input, [
    "preflight",
    "variableInventory",
    "deploymentInventory",
  ]);
  if (snapshot === null) return null;
  const preflight = snapshot.preflight;
  const variableInventory = snapshot.variableInventory;
  const deploymentInventory = snapshot.deploymentInventory;
  if (
    !preflightExact(preflight)
    || !variableInventoryExact(variableInventory)
    || !deploymentInventoryExact(deploymentInventory)
  ) return null;
  const beforeVariables = preflight.variableInventory.rows;
  const afterVariables = variableInventory.rows;
  if (afterVariables.length !== beforeVariables.length + 1) return null;
  const targetRows: PermanentStagingProviderVariableRowCandidate[] = [];
  for (let index = 0; index < afterVariables.length; index += 1) {
    const row = afterVariables[index];
    if (row === undefined) return null;
    if (row.name === preflight.variableName) arrayPush(targetRows, row);
  }
  if (targetRows.length !== 1) return null;
  const target = targetRows[0]!;
  if (
    target.environmentId !== preflight.environmentId
    || target.serviceId !== preflight.serviceId
    || target.isSealed !== false
    || target.references.length !== 0
    || arraySome(beforeVariables, (row) => row.id === target.id)
  ) return null;
  const afterById = new MAP_EXACT<
    string,
    PermanentStagingProviderVariableRowCandidate
  >();
  for (let index = 0; index < afterVariables.length; index += 1) {
    const row = afterVariables[index];
    if (row === undefined) return null;
    mapSet(afterById, row.id, row);
  }
  if (arraySome(beforeVariables, (row) => {
    const after = mapGet(afterById, row.id);
    return after === undefined || !variableRowExact(row, after);
  })) return null;

  const beforeDeployments = preflight.deploymentInventory.rows;
  const afterDeployments = deploymentInventory.rows;
  if (
    beforeDeployments.length !== afterDeployments.length
    || arraySome(beforeDeployments, (row, index) =>
      !deploymentRowExact(row, afterDeployments[index]!))
  ) return null;

  return OBJECT_FREEZE_EXACT({
    authority: CREATE_ONLY_POSTFLIGHT_CANDIDATE,
    projectId: preflight.projectId,
    environmentId: preflight.environmentId,
    serviceId: preflight.serviceId,
    variableName: preflight.variableName,
    variableId: target.id,
    exactSingleCreate: true,
    priorVariablesUnchanged: true,
    deploymentInventoryUnchanged: true,
    expectedIsSealed: false,
    expectedReferences:
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
        .expectedReferences,
    beforeVariableRowCount: beforeVariables.length,
    afterVariableRowCount: afterVariables.length,
    deploymentRowCount: beforeDeployments.length,
  });
}

export const permanentStagingProviderVariableWriteRailwayContractInternals =
  OBJECT_FREEZE_EXACT({
    maxInventoryRows: MAX_INVENTORY_ROWS,
    maxPageRows: MAX_PAGE_ROWS,
    maxPages: MAX_PAGES,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  });
