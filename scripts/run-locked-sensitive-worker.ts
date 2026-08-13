import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import nodeProcess from "node:process";
import { types as utilTypes } from "node:util";
import { fileURLToPath } from "node:url";

import {
  activateLockedSensitiveWorkerBoundary,
  assertLockedSensitiveWorkerBoundary,
  type LockedSensitiveWorkerMode,
} from "./lib/locked-sensitive-worker-boundary.js";
import {
  assertLockedSensitiveWorkerFinalization,
  finalizeLockedSensitiveWorkerCapabilities,
} from "./lib/locked-sensitive-worker-finalizer.js";
import {
  readFixedAttestorTokenFromKeychain,
  type LockedKeychainSpawnSync,
} from "./lib/locked-sensitive-worker-keychain.js";
import { runLockedRailwayApplicationDeploymentAttestation } from
  "./attest-railway-application-deployment.js";
import { runPostgresReviewedPricePromotionCli } from
  "./postgres-reviewed-price-promotion.js";

const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_FROM = Buffer.from;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const ERROR_CONSTRUCTOR = Error;
const FS_OBJECT = fs;
const FS_WRITE_SYNC = fs.writeSync;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const PROCESS_OBJECT = nodeProcess;
const PATH_OBJECT = path;
const PATH_RESOLVE = path.resolve;
const REFLECT_APPLY = Reflect.apply;
const SPAWN_SYNC = childProcess.spawnSync as LockedKeychainSpawnSync;
const STRING_STARTS_WITH = String.prototype.startsWith;
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "length",
)?.get;
const UTIL_IS_PROXY = utilTypes.isProxy;
const UTIL_TYPES_OBJECT = utilTypes;

function fixedFailure(
  mode: LockedSensitiveWorkerMode,
  argumentInvalid = false,
): string {
  if (mode === "attestor") {
    return argumentInvalid
      ? '{"command":"attest","failureCode":"argument_invalid","ok":false}\n'
      : '{"command":"attest","failureCode":"environment_not_allowed","ok":false}\n';
  }
  return '{"command":"plan","failureCode":"database_open_failed","ok":false}\n';
}

function writeFixedFailure(
  mode: LockedSensitiveWorkerMode,
  argumentInvalid = false,
): void {
  const bytes = REFLECT_APPLY(BUFFER_FROM, BUFFER_CONSTRUCTOR, [
    fixedFailure(mode, argumentInvalid),
    "utf8",
  ]) as unknown;
  if (
    typeof bytes !== "object"
    || bytes === null
    || typeof TYPED_ARRAY_LENGTH_GETTER !== "function"
    || REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_CONSTRUCTOR, [bytes]) !== true
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_OBJECT, [bytes]) === true
  ) return;
  const exactBytes = bytes as Buffer;
  try {
    const length = REFLECT_APPLY(
      TYPED_ARRAY_LENGTH_GETTER,
      exactBytes,
      [],
    ) as unknown;
    if (
      typeof length !== "number"
      || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [length])
      || length < 1
      || length > 256
    ) return;
    let offset = 0;
    while (offset < length) {
      const written = REFLECT_APPLY(FS_WRITE_SYNC, FS_OBJECT, [
        1,
        exactBytes,
        offset,
        length - offset,
      ]) as unknown;
      if (
        typeof written !== "number"
        || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [written])
        || written <= 0
        || written > length - offset
      ) return;
      offset += written;
    }
  } finally {
    REFLECT_APPLY(TYPED_ARRAY_FILL, exactBytes, [0]);
  }
}

function exactMode(value: string | undefined): LockedSensitiveWorkerMode {
  if (value === "attestor" || value === "planner") return value;
  throw new ERROR_CONSTRUCTOR("locked_sensitive_worker_mode_invalid");
}

function attestorArgumentSlot(name: string): 0 | 1 | 2 | 3 | undefined {
  if (name === "--candidate-sha") return 0;
  if (name === "--output-receipt") return 1;
  if (name === "--target-origin") return 2;
  if (name === "--target-origin-sha256") return 3;
  return undefined;
}

function exactAttestorArgumentShape(argv: readonly string[]): boolean {
  if (argv.length !== 8) return false;
  const seen = [false, false, false, false];
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof name !== "string" || typeof value !== "string") return false;
    const slot = attestorArgumentSlot(name);
    if (
      slot === undefined
      || seen[slot]
      || value.length === 0
      || REFLECT_APPLY(STRING_STARTS_WITH, value, ["--"])
    ) return false;
    seen[slot] = true;
  }
  return seen[0] === true
    && seen[1] === true
    && seen[2] === true
    && seen[3] === true;
}

function childArguments(): string[] {
  const length = PROCESS_OBJECT.argv.length - 3;
  if (length < 0) throw new ERROR_CONSTRUCTOR("locked_sensitive_worker_argv_invalid");
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const value = PROCESS_OBJECT.argv[index + 3];
    if (typeof value !== "string") {
      throw new ERROR_CONSTRUCTOR("locked_sensitive_worker_argv_invalid");
    }
    result[index] = value;
  }
  return result;
}

async function run(): Promise<0 | 1> {
  let mode: LockedSensitiveWorkerMode;
  let delegated = false;
  try {
    mode = exactMode(PROCESS_OBJECT.argv[2]);
  } catch {
    return 1;
  }
  try {
    await finalizeLockedSensitiveWorkerCapabilities();
    assertLockedSensitiveWorkerFinalization();
    activateLockedSensitiveWorkerBoundary(mode);
    const argv = childArguments();
    if (mode === "attestor" && !exactAttestorArgumentShape(argv)) {
      writeFixedFailure(mode, true);
      return 1;
    }
    assertLockedSensitiveWorkerBoundary(mode);
    if (mode === "attestor") {
      delegated = true;
      return await runLockedRailwayApplicationDeploymentAttestation(
        argv,
        () => {
          assertLockedSensitiveWorkerBoundary(mode);
          return readFixedAttestorTokenFromKeychain(SPAWN_SYNC);
        },
      );
    }
    delegated = true;
    return await runPostgresReviewedPricePromotionCli(argv);
  } catch {
    if (!delegated) writeFixedFailure(mode);
    return 1;
  }
}

export const lockedSensitiveWorkerInternals = REFLECT_APPLY(
  OBJECT_FREEZE,
  OBJECT_CONSTRUCTOR,
  [{ exactAttestorArgumentShape }],
);

const invokedPath = PROCESS_OBJECT.argv[1]
  ? REFLECT_APPLY(PATH_RESOLVE, PATH_OBJECT, [PROCESS_OBJECT.argv[1]]) as string
  : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  PROCESS_OBJECT.exitCode = await run();
}
