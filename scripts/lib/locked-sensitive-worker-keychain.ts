import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";
import nodeProcess from "node:process";
import { types as utilTypes } from "node:util";

export const LOCKED_ATTESTOR_KEYCHAIN_SERVICE =
  "au.pintpath.railway.project-upload-token" as const;
export const LOCKED_ATTESTOR_KEYCHAIN_ACCOUNT =
  "permanent-staging:48d8c6cd-1c66-4148-874b-20877f48e1a5:a4e0f507-d6d3-4df9-a818-ad92c0071a35" as const;
export const LOCKED_ATTESTOR_KEYCHAIN_PATH =
  "/Users/zac/Library/Keychains/login.keychain-db" as const;

export type LockedKeychainSpawnSync = (
  file: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => SpawnSyncReturns<Buffer>;

const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const ERROR_CONSTRUCTOR = Error;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const PROCESS_OBJECT = nodeProcess;
const REFLECT_APPLY = Reflect.apply;
const REGEXP_EXEC = RegExp.prototype.exec;
const STRING_CONSTRUCTOR = String;
const STRING_FROM_CHAR_CODE = String.fromCharCode;
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
const CONTROL_PATTERN = /[\r\n\0]/;

function fail(): never {
  throw new ERROR_CONSTRUCTOR("locked_sensitive_worker_keychain_failed");
}

function isProxy(value: object): boolean {
  return REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_OBJECT, [value]) === true;
}

function ownData(object: object, name: PropertyKey): unknown {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [object, name],
  ) as PropertyDescriptor | undefined;
  if (!descriptor || !("value" in descriptor)) fail();
  return descriptor.value;
}

function optionalOwnData(object: object, name: PropertyKey): unknown {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [object, name],
  ) as PropertyDescriptor | undefined;
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) fail();
  return descriptor.value;
}

function controlled(value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, CONTROL_PATTERN, [value]) !== null;
}

function exactHomeEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): {
  readonly environment: NodeJS.ProcessEnv;
  readonly keychainPath: string;
} {
  const home = source.HOME;
  const user = source.USER;
  const logname = source.LOGNAME;
  if (
    home !== "/Users/zac"
    || user !== "zac"
    || logname !== "zac"
    || !REFLECT_APPLY(STRING_STARTS_WITH, home, ["/"])
    || controlled(home)
    || user !== undefined && controlled(user)
    || logname !== undefined && controlled(logname)
  ) fail();
  const environment = REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [{
    HOME: home,
    LANG: "C",
    LOGNAME: logname ?? user ?? "",
    PATH: "/usr/bin:/bin",
    USER: user ?? logname ?? "",
  }]) as NodeJS.ProcessEnv;
  const keychainPath = LOCKED_ATTESTOR_KEYCHAIN_PATH;
  return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [{
    environment,
    keychainPath,
  }]) as {
    readonly environment: NodeJS.ProcessEnv;
    readonly keychainPath: string;
  };
}

export function readFixedAttestorTokenFromKeychain(
  spawnSyncImpl: LockedKeychainSpawnSync,
  platform: NodeJS.Platform = PROCESS_OBJECT.platform,
  environment: Readonly<Record<string, string | undefined>> = PROCESS_OBJECT.env,
): string {
  if (platform !== "darwin" || typeof spawnSyncImpl !== "function") fail();
  const home = exactHomeEnvironment(environment);
  const result = REFLECT_APPLY(spawnSyncImpl, undefined, [
    "/usr/bin/security",
    REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [[
      "find-generic-password",
      "-w",
      "-a",
      LOCKED_ATTESTOR_KEYCHAIN_ACCOUNT,
      "-s",
      LOCKED_ATTESTOR_KEYCHAIN_SERVICE,
      home.keychainPath,
    ]]),
    REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [{
      encoding: "buffer",
      env: home.environment,
      maxBuffer: 8_192,
      stdio: REFLECT_APPLY(OBJECT_FREEZE, OBJECT_CONSTRUCTOR, [[
        "ignore",
        "pipe",
        "ignore",
      ]]),
      timeout: 10_000,
      windowsHide: true,
    }]),
  ]) as unknown;

  let stdoutToWipe: Buffer | null = null;
  try {
    if (
      typeof result !== "object"
      || result === null
      || isProxy(result)
      || typeof TYPED_ARRAY_LENGTH_GETTER !== "function"
    ) fail();
    const stdout = ownData(result, "stdout");
    if (
      typeof stdout === "object"
      && stdout !== null
      && REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_CONSTRUCTOR, [stdout]) === true
      && !isProxy(stdout)
    ) stdoutToWipe = stdout as Buffer;
    if (
      optionalOwnData(result, "error") !== undefined
      || ownData(result, "signal") !== null
      || ownData(result, "status") !== 0
      || stdoutToWipe === null
    ) fail();

    const length = REFLECT_APPLY(
      TYPED_ARRAY_LENGTH_GETTER,
      stdoutToWipe,
      [],
    ) as unknown;
    if (
      typeof length !== "number"
      || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [length])
      || length < 17
      || length > 4_097
      || stdoutToWipe[length - 1] !== 0x0a
    ) fail();
    let token = "";
    for (let index = 0; index < length - 1; index += 1) {
      const byte = stdoutToWipe[index];
      if (typeof byte !== "number" || byte < 0x21 || byte > 0x7e) fail();
      token += REFLECT_APPLY(
        STRING_FROM_CHAR_CODE,
        STRING_CONSTRUCTOR,
        [byte],
      ) as string;
    }
    if (length - 1 < 16 || length - 1 > 4_096) fail();
    return token;
  } finally {
    if (stdoutToWipe !== null) {
      REFLECT_APPLY(TYPED_ARRAY_FILL, stdoutToWipe, [0]);
    }
  }
}
