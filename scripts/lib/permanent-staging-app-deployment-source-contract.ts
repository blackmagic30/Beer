import crypto from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

// This module is intentionally capability-pure. It parses offline fixture
// bytes and computes commitments, but cannot inspect Git, touch a source tree,
// invoke Railway, or authorize a deployment.
const BUFFER_CONSTRUCTOR = Buffer;
const JSON_OBJECT = JSON;
const OBJECT_CONSTRUCTOR = Object;
const REFLECT_OBJECT = Reflect;
const REFLECT_APPLY = REFLECT_OBJECT.apply;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_PROTOTYPE = Array.prototype;
const BUFFER_BYTE_LENGTH = BUFFER_CONSTRUCTOR.byteLength;
const BUFFER_COMPARE = BUFFER_CONSTRUCTOR.compare;
const BUFFER_FROM = BUFFER_CONSTRUCTOR.from;
const CRYPTO_CREATE_HASH = crypto.createHash;
const HASH_PROBE = CRYPTO_CREATE_HASH("sha256");
const HASH_UPDATE = HASH_PROBE.update;
const HASH_DIGEST = HASH_PROBE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);
const JSON_PARSE = JSON_OBJECT.parse;
const JSON_STRINGIFY = JSON_OBJECT.stringify;
const MAP_CONSTRUCTOR = Map;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = OBJECT_CONSTRUCTOR.freeze;
const OBJECT_DEFINE_PROPERTY = OBJECT_CONSTRUCTOR.defineProperty;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  OBJECT_CONSTRUCTOR.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = OBJECT_CONSTRUCTOR.getPrototypeOf;
const OBJECT_HAS_OWN = OBJECT_CONSTRUCTOR.hasOwn;
const OBJECT_PROTOTYPE = OBJECT_CONSTRUCTOR.prototype;
const REFLECT_OWN_KEYS = REFLECT_OBJECT.ownKeys;
const REGEXP_EXEC = RegExp.prototype.exec;
const SET_CONSTRUCTOR = Set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const SET_SIZE = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Set.prototype, "size")?.get;
const STRING_LAST_INDEX_OF = String.prototype.lastIndexOf;
const STRING_INCLUDES = String.prototype.includes;
const STRING_NORMALIZE = String.prototype.normalize;
const STRING_SLICE = String.prototype.slice;
const STRING_SPLIT = String.prototype.split;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_CONSTRUCTOR = String;
const TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const TEXT_ENCODER_ENCODE = TextEncoder.prototype.encode;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export const PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA =
  "pintpath-permanent-staging-app-source-snapshot-fixture/v1" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CANDIDATE_SCHEMA =
  "pintpath-permanent-staging-app-source-snapshot-candidate/v1" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_STATE =
  "HARD_DISABLED_OFFLINE_STRUCTURAL_FIXTURE_ONLY" as const;
export const PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM =
  "sha256-json-depth-first-bytewise-siblings-path-type-mode-size-content-v1" as const;

export const PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK =
  OBJECT_FREEZE({
    railwayConfigPath: "railway.toml",
    railwayConfigSha256:
      "85dc659ebec2e0132092d917505d71678e92b8441b54bcefc80c6a082e3b967b",
    packageLockPath: "package-lock.json",
    packageLockSha256:
      "2d916b16b3072ca5b6ede6da33752bf76654dc73e8d09b5a01351af71e33c22b",
    futureUploadPathMode: "explicit-snapshot-path",
    futurePathAsRootFlag: "--path-as-root",
    futureNoGitignoreFlag: "--no-gitignore",
    futurePathAsRootRequired: true,
    futureNoGitignoreRequired: true,
    uploaderEntrySetBindingAvailable: false,
    ancestorIgnoreIndependentUploadAvailable: false,
    providerCandidateBindingAvailable: false,
    activationAuthorized: false,
  } as const);

const FIXTURE_AUTHORITY = "offline-strict-json-fixture-candidate" as const;
const SOURCE_AUTHORITY = "offline-structural-source-candidate" as const;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const NUL_PATTERN = /\u0000/;
const PORTABLE_PATH_PATTERN = /^[A-Za-z0-9._\/@+-]+$/;
const FORBIDDEN_SOURCE_BASENAMES = OBJECT_FREEZE([
  ".ignore",
  ".gitattributes",
  ".gitmodules",
  ".railwayignore",
  "node_modules",
] as const);

for (const pattern of [
  SHA1_PATTERN,
  SHA256_PATTERN,
  CONTROL_PATTERN,
  NUL_PATTERN,
  PORTABLE_PATH_PATTERN,
]) {
  OBJECT_FREEZE(pattern);
}

export const PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS =
  OBJECT_FREEZE({
    maximumFixtureBytes: 2 * 1_024 * 1_024,
    maximumManifestBytes: 1 * 1_024 * 1_024,
    maximumEntries: 4_096,
    maximumDepth: 64,
    maximumPathBytes: 4_096,
    maximumComponentBytes: 255,
    maximumFileBytes: 32 * 1_024 * 1_024,
    maximumTotalFileBytes: 64 * 1_024 * 1_024,
  } as const);

export type PermanentStagingAppDeploymentSourceManifestEntry =
  | readonly [path: string, type: "d", mode: 448, size: 0, sha256: null]
  | readonly [
    path: string,
    type: "f",
    mode: 384 | 448,
    size: number,
    sha256: string,
  ];

export interface PermanentStagingAppDeploymentSourceFixtureCandidate {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA;
  readonly authority: typeof FIXTURE_AUTHORITY;
  readonly activationAuthorized: false;
  readonly providerCandidateBindingAvailable: false;
  readonly candidateSha: string;
  readonly treeSha: string;
  readonly git: {
    readonly objectFormat: "sha1";
    readonly headBefore: string;
    readonly treeBefore: string;
    readonly porcelainV2: "";
    readonly materializedCommitSha: string;
    readonly materializedTreeSha: string;
    readonly headAfter: string;
    readonly treeAfter: string;
    readonly committedObjectEnumerationComplete: true;
    readonly blobObjectIdsVerified: true;
    readonly treeObjectIdVerified: true;
    readonly committedEntryModesExact: true;
    readonly symlinkEntryCount: 0;
    readonly gitlinkEntryCount: 0;
    readonly worktreeAttributesUsed: false;
  };
  readonly upload: {
    readonly futureMode: "explicit-snapshot-path";
    readonly explicitSnapshotPathRequired: true;
    readonly pathAsRootFlag: "--path-as-root";
    readonly noGitignoreFlag: "--no-gitignore";
    readonly pathAsRootRequired: true;
    readonly noGitignoreRequired: true;
    readonly railwayIgnoreAbsent: true;
    readonly gitAttributesAbsent: true;
    readonly gitmodulesAbsent: true;
    readonly dotIgnoreAbsent: true;
    readonly nodeModulesAbsent: true;
    readonly uploaderEntrySetBindingAvailable: false;
    readonly ancestorIgnoreIndependentUploadAvailable: false;
    readonly allIgnoreAndParentFiltersDisabled: false;
    readonly reviewedUploaderEntrySetSha256: null;
  };
  readonly snapshot: {
    readonly absoluteCanonicalPath: true;
    readonly directChildOfPrivateTmp: true;
    readonly exclusiveCreation: true;
    readonly atomicPublication: true;
    readonly rootCurrentUid: true;
    readonly rootMode0700: true;
    readonly rootNonSymlink: true;
    readonly rootSameDeviceAsPrivateTmp: true;
    readonly privateTmpRootOwnedSticky01777: true;
    readonly privateAncestorsRootOwnedNonWritable: true;
    readonly identityHeld: true;
    readonly identityReasserted: true;
    readonly allDirectoriesCurrentUidMode0700: true;
    readonly allFilesCurrentUidMode0600Or0700: true;
    readonly allFilesNlinkOne: true;
    readonly specialFilesAbsent: true;
    readonly aclAuthorityInspected: true;
    readonly aclEntriesAbsent: true;
  };
  readonly manifest: {
    readonly algorithm:
      typeof PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM;
    /** Complete committed-object snapshot tree; not a Railway upload entry set. */
    readonly complete: true;
    readonly entries: readonly PermanentStagingAppDeploymentSourceManifestEntry[];
    readonly sha256: string;
    readonly entryCount: number;
    readonly directoryCount: number;
    readonly fileCount: number;
    readonly fileBytes: number;
  };
}

export interface PermanentStagingAppDeploymentSourceCandidate {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CANDIDATE_SCHEMA;
  readonly authority: typeof SOURCE_AUTHORITY;
  readonly contractState:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_STATE;
  readonly activationAuthorized: false;
  readonly providerCandidateBindingAvailable: false;
  readonly candidateSha: string;
  readonly treeSha: string;
  readonly porcelainV2Empty: true;
  readonly committedObjectMaterializationFixtureExact: true;
  readonly privateSnapshotFixtureExact: true;
  readonly futureUploadPathMode: "explicit-snapshot-path";
  readonly futurePathAsRootFlag: "--path-as-root";
  readonly futureNoGitignoreFlag: "--no-gitignore";
  readonly futurePathAsRootRequired: true;
  readonly futureNoGitignoreRequired: true;
  readonly exclusionControlFilesAbsent: true;
  readonly uploaderEntrySetBindingAvailable: false;
  readonly ancestorIgnoreIndependentUploadAvailable: false;
  readonly allIgnoreAndParentFiltersDisabled: false;
  readonly reviewedUploaderEntrySetSha256: null;
  readonly sourceManifestBoundToUploaderEntrySet: false;
  readonly sourceManifestAlgorithm:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM;
  readonly sourceManifestSha256: string;
  readonly sourceEntryCount: number;
  readonly sourceDirectoryCount: number;
  readonly sourceFileCount: number;
  readonly sourceFileBytes: number;
  readonly railwayConfigSha256:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK.railwayConfigSha256;
  readonly packageLockSha256:
    typeof PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK.packageLockSha256;
}

interface ParsedManifest {
  readonly entries: readonly PermanentStagingAppDeploymentSourceManifestEntry[];
  readonly sha256: string;
  readonly entryCount: number;
  readonly directoryCount: number;
  readonly fileCount: number;
  readonly fileBytes: number;
}

const FIXTURE_AUTHORITIES = new WeakSet<object>();
const SOURCE_AUTHORITIES = new WeakSet<object>();

function regexpTest(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function arraySetExact<T>(values: T[], index: number, value: T): void {
  const beforeLength = values.length;
  if (!NUMBER_IS_SAFE_INTEGER(index) || index < 0 || index > beforeLength) {
    throw new Error("array_index_invalid");
  }
  REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, OBJECT_CONSTRUCTOR, [
    values,
    STRING_CONSTRUCTOR(index),
    {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    },
  ]);
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [values, STRING_CONSTRUCTOR(index)],
  ) as PropertyDescriptor | undefined;
  if (
    values.length !== (index === beforeLength ? beforeLength + 1 : beforeLength)
    || descriptor === undefined
    || descriptor.enumerable !== true
    || descriptor.writable !== true
    || descriptor.value !== value
  ) throw new Error("array_publication_invalid");
}

function arrayPush<T>(values: T[], value: T): void {
  arraySetExact(values, values.length, value);
}

function mapGet<K, V>(values: Map<K, V>, key: K): V | undefined {
  return REFLECT_APPLY(MAP_GET, values, [key]) as V | undefined;
}

function mapSet<K, V>(values: Map<K, V>, key: K, value: V): void {
  REFLECT_APPLY(MAP_SET, values, [key, value]);
}

function setAdd<T>(values: Set<T>, value: T): void {
  REFLECT_APPLY(SET_ADD, values, [value]);
}

function setHas<T>(values: Set<T>, value: T): boolean {
  return REFLECT_APPLY(SET_HAS, values, [value]) === true;
}

function setSize<T>(values: Set<T>): number {
  return typeof SET_SIZE === "function"
    ? REFLECT_APPLY(SET_SIZE, values, []) as number
    : -1;
}

function weakSetAdd(values: WeakSet<object>, value: object): void {
  REFLECT_APPLY(WEAK_SET_ADD, values, [value]);
}

function weakSetHas(values: WeakSet<object>, value: object): boolean {
  return REFLECT_APPLY(WEAK_SET_HAS, values, [value]) === true;
}

function sha256(value: string): string {
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [value, "utf8"]);
  return REFLECT_APPLY(HASH_DIGEST, hash, ["hex"]) as string;
}

function jsonString(value: string): string {
  const result = REFLECT_APPLY(JSON_STRINGIFY, JSON_OBJECT, [value]);
  if (typeof result !== "string") throw new Error("json_string_invalid");
  return result;
}

function canonicalJson(value: unknown): string {
  let nodes = 0;
  const serialize = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > 100_000 || depth > 80) throw new Error("json_bounds_invalid");
    if (candidate === null) return "null";
    if (typeof candidate === "string") return jsonString(candidate);
    if (typeof candidate === "boolean") return candidate ? "true" : "false";
    if (typeof candidate === "number") {
      if (!NUMBER_IS_SAFE_INTEGER(candidate)) throw new Error("json_number_invalid");
      return STRING_CONSTRUCTOR(candidate);
    }
    if (exactArray(candidate)) {
      const items: string[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        arrayPush(items, serialize(candidate[index], depth + 1));
      }
      return `[${REFLECT_APPLY(ARRAY_JOIN, items, [","]) as string}]`;
    }
    if (
      typeof candidate !== "object"
      || candidate === null
      || OBJECT_GET_PROTOTYPE_OF(candidate) !== OBJECT_PROTOTYPE
    ) throw new Error("json_object_invalid");
    const keys = REFLECT_APPLY(
      REFLECT_OWN_KEYS,
      REFLECT_OBJECT,
      [candidate],
    ) as PropertyKey[];
    const members: string[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") throw new Error("json_key_invalid");
      const descriptor = REFLECT_APPLY(
        OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
        OBJECT_CONSTRUCTOR,
        [candidate, key],
      ) as PropertyDescriptor | undefined;
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !OBJECT_HAS_OWN(descriptor, "value")
      ) throw new Error("json_descriptor_invalid");
      arrayPush(
        members,
        `${jsonString(key)}:${serialize(descriptor.value, depth + 1)}`,
      );
    }
    return `{${REFLECT_APPLY(ARRAY_JOIN, members, [","]) as string}}`;
  };
  return serialize(value, 0);
}

function exactObjectKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || ARRAY_IS_ARRAY(value)
    || OBJECT_GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE
  ) return false;
  const keys = REFLECT_APPLY(
    REFLECT_OWN_KEYS,
    REFLECT_OBJECT,
    [value],
  ) as PropertyKey[];
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (keys[index] !== expected[index]) return false;
    const descriptor = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      OBJECT_CONSTRUCTOR,
      [value, expected[index]!],
    ) as PropertyDescriptor | undefined;
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !OBJECT_HAS_OWN(descriptor, "value")
    ) return false;
  }
  return true;
}

function exactArray(value: unknown, length?: number): value is unknown[] {
  if (
    !ARRAY_IS_ARRAY(value)
    || OBJECT_GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE
    || (length !== undefined && value.length !== length)
  ) return false;
  const keys = REFLECT_APPLY(
    REFLECT_OWN_KEYS,
    REFLECT_OBJECT,
    [value],
  ) as PropertyKey[];
  if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== STRING_CONSTRUCTOR(index)) return false;
    const descriptor = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      OBJECT_CONSTRUCTOR,
      [value, STRING_CONSTRUCTOR(index)],
    ) as PropertyDescriptor | undefined;
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !OBJECT_HAS_OWN(descriptor, "value")
    ) return false;
  }
  return true;
}

function exactUtf8(value: string): boolean {
  try {
    const bytes = REFLECT_APPLY(TEXT_ENCODER_ENCODE, UTF8_ENCODER, [value]) as Uint8Array;
    return REFLECT_APPLY(TEXT_DECODER_DECODE, UTF8_DECODER, [bytes]) === value;
  } catch {
    return false;
  }
}

function byteLength(value: string): number {
  return REFLECT_APPLY(
    BUFFER_BYTE_LENGTH,
    BUFFER_CONSTRUCTOR,
    [value, "utf8"],
  ) as number;
}

function stringSlice(value: string, start: number, end?: number): string {
  return end === undefined
    ? REFLECT_APPLY(STRING_SLICE, value, [start]) as string
    : REFLECT_APPLY(STRING_SLICE, value, [start, end]) as string;
}

function parentPath(value: string): string {
  const separator = REFLECT_APPLY(STRING_LAST_INDEX_OF, value, ["/"]) as number;
  return separator < 0 ? "" : stringSlice(value, 0, separator);
}

function basename(value: string): string {
  const separator = REFLECT_APPLY(STRING_LAST_INDEX_OF, value, ["/"]) as number;
  return separator < 0 ? value : stringSlice(value, separator + 1);
}

function pathAlias(value: string): string {
  const normalized = REFLECT_APPLY(STRING_NORMALIZE, value, ["NFD"]) as string;
  return REFLECT_APPLY(STRING_TO_LOWER_CASE, normalized, []) as string;
}

function validPath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || byteLength(value) > PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumPathBytes
    || !exactUtf8(value)
    || regexpTest(CONTROL_PATTERN, value)
    || !regexpTest(PORTABLE_PATH_PATTERN, value)
    || value[0] === "/"
    || value[value.length - 1] === "/"
    || REFLECT_APPLY(STRING_INCLUDES, value, ["\\"]) === true
    || REFLECT_APPLY(STRING_NORMALIZE, value, ["NFC"]) !== value
  ) return false;
  const components = REFLECT_APPLY(STRING_SPLIT, value, ["/"]) as string[];
  if (
    components.length === 0
    || components.length > PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumDepth
  ) return false;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (
      component === undefined
      || component.length === 0
      || component === "."
      || component === ".."
      || byteLength(component)
        > PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumComponentBytes
    ) return false;
  }
  return true;
}

function forbiddenControlPath(value: string): boolean {
  const name = pathAlias(basename(value));
  for (let index = 0; index < FORBIDDEN_SOURCE_BASENAMES.length; index += 1) {
    if (name === FORBIDDEN_SOURCE_BASENAMES[index]) return true;
  }
  return name === ".git";
}

function parseManifestEntry(
  value: unknown,
): PermanentStagingAppDeploymentSourceManifestEntry | null {
  if (!exactArray(value, 5) || !validPath(value[0])) return null;
  if (forbiddenControlPath(value[0])) return null;
  if (value[1] === "d") {
    if (value[2] !== 448 || value[3] !== 0 || value[4] !== null) return null;
    return OBJECT_FREEZE([value[0], "d", 448, 0, null] as const);
  }
  if (
    value[1] !== "f"
    || (value[2] !== 384 && value[2] !== 448)
    || !NUMBER_IS_SAFE_INTEGER(value[3])
    || (value[3] as number) < 0
    || (value[3] as number)
      > PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumFileBytes
    || typeof value[4] !== "string"
    || !regexpTest(SHA256_PATTERN, value[4])
  ) return null;
  return OBJECT_FREEZE([
    value[0],
    "f",
    value[2],
    value[3] as number,
    value[4],
  ] as const);
}

function entryPathOrderExact(
  entries: readonly PermanentStagingAppDeploymentSourceManifestEntry[],
): boolean {
  const entriesByPath = new MAP_CONSTRUCTOR<
    string,
    PermanentStagingAppDeploymentSourceManifestEntry
  >();
  const exactPaths = new SET_CONSTRUCTOR<string>();
  const aliasPaths = new SET_CONSTRUCTOR<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) return false;
    const path = entry[0];
    const alias = pathAlias(path);
    if (setHas(exactPaths, path) || setHas(aliasPaths, alias)) return false;
    setAdd(exactPaths, path);
    setAdd(aliasPaths, alias);
    mapSet(entriesByPath, path, entry);
  }
  if (
    setSize(exactPaths) !== entries.length
    || setSize(aliasPaths) !== entries.length
  ) return false;

  const activeDirectories: string[] = [""];
  let activeLength = 1;
  const lastChildByParent = new MAP_CONSTRUCTOR<string, string>();
  const childCountByParent = new MAP_CONSTRUCTOR<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) return false;
    const parent = parentPath(entry[0]);
    if (parent !== "" && mapGet(entriesByPath, parent)?.[1] !== "d") return false;
    while (
      activeLength > 0
      && activeDirectories[activeLength - 1] !== parent
    ) activeLength -= 1;
    if (activeLength === 0) return false;

    const name = basename(entry[0]);
    const previous = mapGet(lastChildByParent, parent);
    if (previous !== undefined) {
      const order = REFLECT_APPLY(
        BUFFER_COMPARE,
        BUFFER_CONSTRUCTOR,
        [
          REFLECT_APPLY(BUFFER_FROM, BUFFER_CONSTRUCTOR, [previous, "utf8"]),
          REFLECT_APPLY(BUFFER_FROM, BUFFER_CONSTRUCTOR, [name, "utf8"]),
        ],
      ) as number;
      if (order >= 0) return false;
    }
    mapSet(lastChildByParent, parent, name);
    mapSet(childCountByParent, parent, (mapGet(childCountByParent, parent) ?? 0) + 1);
    if (entry[1] === "d") {
      arraySetExact(activeDirectories, activeLength, entry[0]);
      activeLength += 1;
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      entry === undefined
      || (entry[1] === "d" && (mapGet(childCountByParent, entry[0]) ?? 0) < 1)
    ) return false;
  }
  return true;
}

function parseManifest(value: unknown): ParsedManifest | null {
  if (!exactObjectKeys(value, [
    "algorithm",
    "complete",
    "entries",
    "sha256",
    "entryCount",
    "directoryCount",
    "fileCount",
    "fileBytes",
  ])) return null;
  if (
    value.algorithm !== PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM
    || value.complete !== true
    || !exactArray(value.entries)
    || value.entries.length === 0
    || value.entries.length
      > PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumEntries
    || typeof value.sha256 !== "string"
    || !regexpTest(SHA256_PATTERN, value.sha256)
  ) return null;

  const entries: PermanentStagingAppDeploymentSourceManifestEntry[] = [];
  let directoryCount = 0;
  let fileCount = 0;
  let fileBytes = 0;
  let railwayConfigHash: string | null = null;
  let packageLockHash: string | null = null;
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = parseManifestEntry(value.entries[index]);
    if (entry === null) return null;
    arrayPush(entries, entry);
    if (entry[1] === "d") {
      directoryCount += 1;
    } else {
      fileCount += 1;
      fileBytes += entry[3];
      if (
        !NUMBER_IS_SAFE_INTEGER(fileBytes)
        || fileBytes
          > PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumTotalFileBytes
      ) return null;
      if (entry[0] === PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK.railwayConfigPath) {
        railwayConfigHash = entry[4];
      }
      if (entry[0] === PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK.packageLockPath) {
        packageLockHash = entry[4];
      }
    }
  }
  if (
    !entryPathOrderExact(entries)
    || value.entryCount !== entries.length
    || value.directoryCount !== directoryCount
    || value.fileCount !== fileCount
    || value.fileBytes !== fileBytes
    || railwayConfigHash
      !== PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK.railwayConfigSha256
    || packageLockHash
      !== PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK.packageLockSha256
  ) return null;
  let canonicalEntries: string;
  try {
    canonicalEntries = canonicalJson(entries);
  } catch {
    return null;
  }
  if (
    byteLength(canonicalEntries)
      > PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumManifestBytes
    || sha256(canonicalEntries) !== value.sha256
  ) return null;
  OBJECT_FREEZE(entries);
  return OBJECT_FREEZE({
    entries,
    sha256: value.sha256,
    entryCount: entries.length,
    directoryCount,
    fileCount,
    fileBytes,
  });
}

function parseFixtureObject(
  parsed: unknown,
): PermanentStagingAppDeploymentSourceFixtureCandidate | null {
  if (!exactObjectKeys(parsed, [
    "schemaVersion",
    "activationAuthorized",
    "providerCandidateBindingAvailable",
    "candidateSha",
    "treeSha",
    "git",
    "upload",
    "snapshot",
    "manifest",
  ])) return null;
  if (
    parsed.schemaVersion !== PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA
    || parsed.activationAuthorized !== false
    || parsed.providerCandidateBindingAvailable !== false
    || typeof parsed.candidateSha !== "string"
    || !regexpTest(SHA1_PATTERN, parsed.candidateSha)
    || typeof parsed.treeSha !== "string"
    || !regexpTest(SHA1_PATTERN, parsed.treeSha)
  ) return null;
  const git = parsed.git;
  if (!exactObjectKeys(git, [
    "objectFormat",
    "headBefore",
    "treeBefore",
    "porcelainV2",
    "materializedCommitSha",
    "materializedTreeSha",
    "headAfter",
    "treeAfter",
    "committedObjectEnumerationComplete",
    "blobObjectIdsVerified",
    "treeObjectIdVerified",
    "committedEntryModesExact",
    "symlinkEntryCount",
    "gitlinkEntryCount",
    "worktreeAttributesUsed",
  ])) return null;
  if (
    git.objectFormat !== "sha1"
    || git.headBefore !== parsed.candidateSha
    || git.headAfter !== parsed.candidateSha
    || git.materializedCommitSha !== parsed.candidateSha
    || git.treeBefore !== parsed.treeSha
    || git.treeAfter !== parsed.treeSha
    || git.materializedTreeSha !== parsed.treeSha
    || git.porcelainV2 !== ""
    || git.committedObjectEnumerationComplete !== true
    || git.blobObjectIdsVerified !== true
    || git.treeObjectIdVerified !== true
    || git.committedEntryModesExact !== true
    || git.symlinkEntryCount !== 0
    || git.gitlinkEntryCount !== 0
    || git.worktreeAttributesUsed !== false
  ) return null;
  const upload = parsed.upload;
  if (
    !exactObjectKeys(upload, [
      "futureMode",
      "explicitSnapshotPathRequired",
      "pathAsRootFlag",
      "noGitignoreFlag",
      "pathAsRootRequired",
      "noGitignoreRequired",
      "railwayIgnoreAbsent",
      "gitAttributesAbsent",
      "gitmodulesAbsent",
      "dotIgnoreAbsent",
      "nodeModulesAbsent",
      "uploaderEntrySetBindingAvailable",
      "ancestorIgnoreIndependentUploadAvailable",
      "allIgnoreAndParentFiltersDisabled",
      "reviewedUploaderEntrySetSha256",
    ])
    || upload.futureMode !== "explicit-snapshot-path"
    || upload.explicitSnapshotPathRequired !== true
    || upload.pathAsRootFlag !== "--path-as-root"
    || upload.noGitignoreFlag !== "--no-gitignore"
    || upload.pathAsRootRequired !== true
    || upload.noGitignoreRequired !== true
    || upload.railwayIgnoreAbsent !== true
    || upload.gitAttributesAbsent !== true
    || upload.gitmodulesAbsent !== true
    || upload.dotIgnoreAbsent !== true
    || upload.nodeModulesAbsent !== true
    || upload.uploaderEntrySetBindingAvailable !== false
    || upload.ancestorIgnoreIndependentUploadAvailable !== false
    || upload.allIgnoreAndParentFiltersDisabled !== false
    || upload.reviewedUploaderEntrySetSha256 !== null
  ) return null;
  const snapshot = parsed.snapshot;
  const snapshotKeys = [
    "absoluteCanonicalPath",
    "directChildOfPrivateTmp",
    "exclusiveCreation",
    "atomicPublication",
    "rootCurrentUid",
    "rootMode0700",
    "rootNonSymlink",
    "rootSameDeviceAsPrivateTmp",
    "privateTmpRootOwnedSticky01777",
    "privateAncestorsRootOwnedNonWritable",
    "identityHeld",
    "identityReasserted",
    "allDirectoriesCurrentUidMode0700",
    "allFilesCurrentUidMode0600Or0700",
    "allFilesNlinkOne",
    "specialFilesAbsent",
    "aclAuthorityInspected",
    "aclEntriesAbsent",
  ] as const;
  if (!exactObjectKeys(snapshot, snapshotKeys)) return null;
  for (let index = 0; index < snapshotKeys.length; index += 1) {
    if (snapshot[snapshotKeys[index]!] !== true) return null;
  }
  const manifest = parseManifest(parsed.manifest);
  if (manifest === null) return null;

  const candidate = OBJECT_FREEZE({
    schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA,
    authority: FIXTURE_AUTHORITY,
    activationAuthorized: false,
    providerCandidateBindingAvailable: false,
    candidateSha: parsed.candidateSha,
    treeSha: parsed.treeSha,
    git: OBJECT_FREEZE({
      objectFormat: "sha1",
      headBefore: git.headBefore,
      treeBefore: git.treeBefore,
      porcelainV2: "",
      materializedCommitSha: git.materializedCommitSha,
      materializedTreeSha: git.materializedTreeSha,
      headAfter: git.headAfter,
      treeAfter: git.treeAfter,
      committedObjectEnumerationComplete: true,
      blobObjectIdsVerified: true,
      treeObjectIdVerified: true,
      committedEntryModesExact: true,
      symlinkEntryCount: 0,
      gitlinkEntryCount: 0,
      worktreeAttributesUsed: false,
    } as const),
    upload: OBJECT_FREEZE({
      futureMode: "explicit-snapshot-path",
      explicitSnapshotPathRequired: true,
      pathAsRootFlag: "--path-as-root",
      noGitignoreFlag: "--no-gitignore",
      pathAsRootRequired: true,
      noGitignoreRequired: true,
      railwayIgnoreAbsent: true,
      gitAttributesAbsent: true,
      gitmodulesAbsent: true,
      dotIgnoreAbsent: true,
      nodeModulesAbsent: true,
      uploaderEntrySetBindingAvailable: false,
      ancestorIgnoreIndependentUploadAvailable: false,
      allIgnoreAndParentFiltersDisabled: false,
      reviewedUploaderEntrySetSha256: null,
    } as const),
    snapshot: OBJECT_FREEZE({
      absoluteCanonicalPath: true,
      directChildOfPrivateTmp: true,
      exclusiveCreation: true,
      atomicPublication: true,
      rootCurrentUid: true,
      rootMode0700: true,
      rootNonSymlink: true,
      rootSameDeviceAsPrivateTmp: true,
      privateTmpRootOwnedSticky01777: true,
      privateAncestorsRootOwnedNonWritable: true,
      identityHeld: true,
      identityReasserted: true,
      allDirectoriesCurrentUidMode0700: true,
      allFilesCurrentUidMode0600Or0700: true,
      allFilesNlinkOne: true,
      specialFilesAbsent: true,
      aclAuthorityInspected: true,
      aclEntriesAbsent: true,
    } as const),
    manifest: OBJECT_FREEZE({
      algorithm: PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM,
      complete: true,
      entries: manifest.entries,
      sha256: manifest.sha256,
      entryCount: manifest.entryCount,
      directoryCount: manifest.directoryCount,
      fileCount: manifest.fileCount,
      fileBytes: manifest.fileBytes,
    } as const),
  } as const satisfies PermanentStagingAppDeploymentSourceFixtureCandidate);
  weakSetAdd(FIXTURE_AUTHORITIES, candidate);
  return candidate;
}

export function parsePermanentStagingAppDeploymentSourceFixture(
  source: unknown,
): PermanentStagingAppDeploymentSourceFixtureCandidate | null {
  if (
    typeof source !== "string"
    || source.length === 0
    || byteLength(source)
      > PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumFixtureBytes
    || regexpTest(NUL_PATTERN, source)
  ) return null;
  let parsed: unknown;
  try {
    parsed = REFLECT_APPLY(JSON_PARSE, JSON_OBJECT, [source]);
  } catch {
    return null;
  }
  let candidate: PermanentStagingAppDeploymentSourceFixtureCandidate | null;
  try {
    candidate = parseFixtureObject(parsed);
  } catch {
    return null;
  }
  if (candidate === null) return null;
  try {
    if (`${canonicalJson(parsed)}\n` !== source) return null;
  } catch {
    return null;
  }
  return candidate;
}

export function evaluatePermanentStagingAppDeploymentSourceFixture(
  fixture: unknown,
): PermanentStagingAppDeploymentSourceCandidate | null {
  if (
    typeof fixture !== "object"
    || fixture === null
    || !weakSetHas(FIXTURE_AUTHORITIES, fixture)
  ) return null;
  const exact = fixture as PermanentStagingAppDeploymentSourceFixtureCandidate;
  const candidate = OBJECT_FREEZE({
    schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CANDIDATE_SCHEMA,
    authority: SOURCE_AUTHORITY,
    contractState: PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_STATE,
    activationAuthorized: false,
    providerCandidateBindingAvailable: false,
    candidateSha: exact.candidateSha,
    treeSha: exact.treeSha,
    porcelainV2Empty: true,
    committedObjectMaterializationFixtureExact: true,
    privateSnapshotFixtureExact: true,
    futureUploadPathMode: "explicit-snapshot-path",
    futurePathAsRootFlag: "--path-as-root",
    futureNoGitignoreFlag: "--no-gitignore",
    futurePathAsRootRequired: true,
    futureNoGitignoreRequired: true,
    exclusionControlFilesAbsent: true,
    uploaderEntrySetBindingAvailable: false,
    ancestorIgnoreIndependentUploadAvailable: false,
    allIgnoreAndParentFiltersDisabled: false,
    reviewedUploaderEntrySetSha256: null,
    sourceManifestBoundToUploaderEntrySet: false,
    sourceManifestAlgorithm:
      PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM,
    sourceManifestSha256: exact.manifest.sha256,
    sourceEntryCount: exact.manifest.entryCount,
    sourceDirectoryCount: exact.manifest.directoryCount,
    sourceFileCount: exact.manifest.fileCount,
    sourceFileBytes: exact.manifest.fileBytes,
    railwayConfigSha256:
      PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK.railwayConfigSha256,
    packageLockSha256:
      PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK.packageLockSha256,
  } as const satisfies PermanentStagingAppDeploymentSourceCandidate);
  weakSetAdd(SOURCE_AUTHORITIES, candidate);
  return candidate;
}

export function isPermanentStagingAppDeploymentSourceCandidate(
  value: unknown,
): value is PermanentStagingAppDeploymentSourceCandidate {
  return typeof value === "object"
    && value !== null
    && weakSetHas(SOURCE_AUTHORITIES, value);
}
