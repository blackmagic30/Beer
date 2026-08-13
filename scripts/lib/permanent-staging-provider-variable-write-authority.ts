import crypto from "node:crypto";

import type {
  PermanentStagingProviderVariableTargetPostflight,
  PermanentStagingProviderVariableTargetPreflight,
} from "./permanent-staging-provider-variable-write-kernel.js";
import {
  evaluatePermanentStagingProviderVariableCreatePostflight,
  evaluatePermanentStagingProviderVariableCreatePreflight,
  type PermanentStagingProviderDeploymentInventoryCandidate,
  type PermanentStagingProviderVariableCreatePreflightCandidate,
  type PermanentStagingProviderVariableInventoryCandidate,
} from "./permanent-staging-provider-variable-write-railway-contract.js";

const ARRAY_IS_ARRAY_EXACT = Array.isArray;
const ARRAY_PROTOTYPE_EXACT = Array.prototype;
const ARRAY_BUFFER_EXACT = ArrayBuffer;
const ARRAY_BUFFER_IS_VIEW_EXACT = ArrayBuffer.isView;
const BUFFER_EXACT = Buffer;
const BUFFER_IS_BUFFER_EXACT = Buffer.isBuffer;
const BUFFER_PROTOTYPE_EXACT = Buffer.prototype;
const CRYPTO_CREATE_HASH_EXACT = crypto.createHash;
const ERROR_EXACT = Error;
const REFLECT_APPLY_EXACT = Reflect.apply;
const HASH_PROBE = CRYPTO_CREATE_HASH_EXACT("sha256");
const HASH_DIGEST_EXACT = HASH_PROBE.digest;
const HASH_UPDATE_EXACT = HASH_PROBE.update;
REFLECT_APPLY_EXACT(HASH_DIGEST_EXACT, HASH_PROBE, []);
const JSON_STRINGIFY_EXACT = JSON.stringify;
const JSON_EXACT = JSON;
const NUMBER_IS_FINITE_EXACT = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER_EXACT = Number.isSafeInteger;
const OBJECT_CREATE_EXACT = Object.create;
const OBJECT_DEFINE_PROPERTY_EXACT = Object.defineProperty;
const OBJECT_FREEZE_EXACT = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT =
  Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF_EXACT = Object.getPrototypeOf;
const OBJECT_HAS_OWN_EXACT = Object.hasOwn;
const OBJECT_PROTOTYPE_EXACT = Object.prototype;
const REFLECT_OWN_KEYS_EXACT = Reflect.ownKeys;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF_EXACT(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const STRING_CONSTRUCTOR_EXACT = String;
const LOWERCASE_HEX = "0123456789abcdef";

const VARIABLE_INVENTORY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/variable-inventory/v1\0";
const DEPLOYMENT_INVENTORY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/deployment-inventory/v1\0";
function ownDataReferences(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || ARRAY_IS_ARRAY_EXACT(value)) {
      return null;
    }
    const prototype = OBJECT_GET_PROTOTYPE_OF_EXACT(value);
    if (prototype !== OBJECT_PROTOTYPE_EXACT && prototype !== null) return null;
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(value) as
      unknown as Record<PropertyKey, PropertyDescriptor>;
    const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
    if (
      keys.length !== expectedKeys.length
    ) return null;
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] !== expectedKeys[index]) return null;
    }
    const output = OBJECT_CREATE_EXACT(null) as Record<string, unknown>;
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const key = expectedKeys[index];
      if (key === undefined) return null;
      const descriptor = descriptors[key];
      if (
        !OBJECT_HAS_OWN_EXACT(descriptors, key)
        || descriptor === undefined
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

function exactDenseDescriptorKeys(
  keys: readonly PropertyKey[],
  length: number,
): boolean {
  if (keys.length !== length + 1) return false;
  for (let index = 0; index < length; index += 1) {
    const expected = REFLECT_APPLY_EXACT(
      STRING_CONSTRUCTOR_EXACT,
      undefined,
      [index],
    ) as string;
    if (keys[index] !== expected) return false;
  }
  return keys[length] === "length";
}

function ownDataJson(value: unknown, depth = 0): string | null {
  if (depth > 16) return null;
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return REFLECT_APPLY_EXACT(
      JSON_STRINGIFY_EXACT,
      JSON_EXACT,
      [value],
    ) as string;
  }
  if (typeof value === "number") {
    return NUMBER_IS_FINITE_EXACT(value)
      ? REFLECT_APPLY_EXACT(
        JSON_STRINGIFY_EXACT,
        JSON_EXACT,
        [value],
      ) as string
      : null;
  }
  if (typeof value !== "object") return null;
  if (ARRAY_IS_ARRAY_EXACT(value)) {
    if (OBJECT_GET_PROTOTYPE_OF_EXACT(value) !== ARRAY_PROTOTYPE_EXACT) {
      return null;
    }
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(value) as
      unknown as Record<PropertyKey, PropertyDescriptor>;
    const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (
      !OBJECT_HAS_OWN_EXACT(descriptors, "length")
      || lengthDescriptor === undefined
      || !OBJECT_HAS_OWN_EXACT(lengthDescriptor, "value")
      || !NUMBER_IS_SAFE_INTEGER_EXACT(length)
      || length < 0
      || length > 2_000
      || !exactDenseDescriptorKeys(keys, length)
    ) {
      return null;
    }
    let output = "[";
    for (let index = 0; index < length; index += 1) {
      const key = REFLECT_APPLY_EXACT(
        STRING_CONSTRUCTOR_EXACT,
        undefined,
        [index],
      ) as string;
      const descriptor = descriptors[key];
      if (
        !OBJECT_HAS_OWN_EXACT(descriptors, key)
        || descriptor === undefined
        || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
        || descriptor.enumerable !== true
      ) return null;
      const encoded = ownDataJson(descriptor.value, depth + 1);
      if (encoded === null) return null;
      output += `${index === 0 ? "" : ","}${encoded}`;
    }
    return `${output}]`;
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF_EXACT(value);
  if (prototype !== OBJECT_PROTOTYPE_EXACT && prototype !== null) return null;
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(value);
  const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
  let output = "{";
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return null;
    const descriptor = descriptors[key];
    if (
      !OBJECT_HAS_OWN_EXACT(descriptors, key)
      || descriptor === undefined
      || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
      || descriptor.enumerable !== true
    ) return null;
    const encodedKey = REFLECT_APPLY_EXACT(
      JSON_STRINGIFY_EXACT,
      JSON_EXACT,
      [key],
    ) as string;
    const encodedValue = ownDataJson(descriptor.value, depth + 1);
    if (encodedValue === null) return null;
    output += `${index === 0 ? "" : ","}${encodedKey}:${encodedValue}`;
  }
  return `${output}}`;
}

function canonicalSha256(domain: string, value: unknown): string {
  const canonical = ownDataJson(value);
  if (canonical === null) throw new ERROR_EXACT("authority_invalid");
  const hash = REFLECT_APPLY_EXACT(CRYPTO_CREATE_HASH_EXACT, crypto, ["sha256"]);
  REFLECT_APPLY_EXACT(HASH_UPDATE_EXACT, hash, [domain, "utf8"]);
  REFLECT_APPLY_EXACT(HASH_UPDATE_EXACT, hash, [canonical, "utf8"]);
  const digest = REFLECT_APPLY_EXACT(HASH_DIGEST_EXACT, hash, []);
  if (
    typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function"
    || !REFLECT_APPLY_EXACT(BUFFER_IS_BUFFER_EXACT, BUFFER_EXACT, [digest])
    || !REFLECT_APPLY_EXACT(
      ARRAY_BUFFER_IS_VIEW_EXACT,
      ARRAY_BUFFER_EXACT,
      [digest],
    )
    || OBJECT_GET_PROTOTYPE_OF_EXACT(digest) !== BUFFER_PROTOTYPE_EXACT
    || REFLECT_APPLY_EXACT(TYPED_ARRAY_BYTE_LENGTH_GETTER, digest, []) !== 32
  ) {
    throw new ERROR_EXACT("authority_invalid");
  }
  let hex = "";
  for (let index = 0; index < 32; index += 1) {
    const byte = (digest as Buffer)[index];
    if (
      typeof byte !== "number"
      || !NUMBER_IS_SAFE_INTEGER_EXACT(byte)
      || byte < 0
      || byte > 0xff
    ) {
      throw new ERROR_EXACT("authority_invalid");
    }
    hex += LOWERCASE_HEX[byte >>> 4] ?? "";
    hex += LOWERCASE_HEX[byte & 0x0f] ?? "";
  }
  if (hex.length !== 64) throw new ERROR_EXACT("authority_invalid");
  return hex;
}

function variableInventorySha256(
  inventory: PermanentStagingProviderVariableInventoryCandidate,
): string {
  return canonicalSha256(VARIABLE_INVENTORY_HASH_DOMAIN, inventory);
}

function deploymentInventorySha256(
  inventory: PermanentStagingProviderDeploymentInventoryCandidate,
): string {
  return canonicalSha256(DEPLOYMENT_INVENTORY_HASH_DOMAIN, inventory);
}

export function buildPermanentStagingProviderVariableTargetPreflight(
  input: {
    readonly variableName: unknown;
    readonly variableInventory: unknown;
    readonly deploymentInventory: unknown;
  },
): PermanentStagingProviderVariableTargetPreflight | null {
  try {
    const snapshot = ownDataReferences(input, [
      "variableName",
      "variableInventory",
      "deploymentInventory",
    ]);
    if (snapshot === null) return null;
    const candidate = evaluatePermanentStagingProviderVariableCreatePreflight(
      snapshot as Parameters<
        typeof evaluatePermanentStagingProviderVariableCreatePreflight
      >[0],
    );
    if (!candidate) return null;
    return OBJECT_FREEZE_EXACT({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-target-preflight/v1",
      projectId: candidate.projectId,
      environmentId: candidate.environmentId,
      serviceId: candidate.serviceId,
      variableName: candidate.variableName,
      inventoryComplete: true,
      targetAbsent: true,
      sharedShadowAbsent: true,
      metadataInventorySha256: variableInventorySha256(
        candidate.variableInventory,
      ),
      deploymentInventorySha256: deploymentInventorySha256(
        candidate.deploymentInventory,
      ),
      deploymentInventoryComplete: true,
    });
  } catch {
    return null;
  }
}

export function buildPermanentStagingProviderVariableTargetPostflight(
  input: {
    readonly preflight: unknown;
    readonly variableInventory: unknown;
    readonly deploymentInventory: unknown;
  },
): PermanentStagingProviderVariableTargetPostflight | null {
  try {
    const snapshot = ownDataReferences(input, [
      "preflight",
      "variableInventory",
      "deploymentInventory",
    ]);
    if (snapshot === null) return null;
    const candidate = evaluatePermanentStagingProviderVariableCreatePostflight(
      snapshot as Parameters<
        typeof evaluatePermanentStagingProviderVariableCreatePostflight
      >[0],
    );
    if (!candidate) return null;
    const preflight = snapshot.preflight as
      PermanentStagingProviderVariableCreatePreflightCandidate;
    const variableInventory = snapshot.variableInventory as
      PermanentStagingProviderVariableInventoryCandidate;
    const deploymentInventory = snapshot.deploymentInventory as
      PermanentStagingProviderDeploymentInventoryCandidate;
    const beforeDeployment = deploymentInventorySha256(
      preflight.deploymentInventory,
    );
    const currentDeployment = deploymentInventorySha256(deploymentInventory);
    return OBJECT_FREEZE_EXACT({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-target-postflight/v1",
      projectId: candidate.projectId,
      environmentId: candidate.environmentId,
      serviceId: candidate.serviceId,
      variableName: candidate.variableName,
      inventoryComplete: true,
      targetPresent: true,
      sharedShadowAbsent: true,
      expectedMetadataExact: candidate.expectedIsSealed === false
        && candidate.expectedReferences.length === 0,
      metadataDeltaExact: candidate.exactSingleCreate === true
        && candidate.priorVariablesUnchanged === true,
      beforeMetadataInventorySha256: variableInventorySha256(
        preflight.variableInventory,
      ),
      currentMetadataInventorySha256: variableInventorySha256(
        variableInventory,
      ),
      beforeDeploymentInventorySha256: beforeDeployment,
      currentDeploymentInventorySha256: currentDeployment,
      deploymentInventoryComplete: true,
      deploymentUnchanged:
        candidate.deploymentInventoryUnchanged === true
        && beforeDeployment === currentDeployment,
    });
  } catch {
    return null;
  }
}

export const permanentStagingProviderVariableWriteAuthorityInternals =
  OBJECT_FREEZE_EXACT({
    canonicalOwnDataJson: ownDataJson,
    deploymentInventoryHashDomain: DEPLOYMENT_INVENTORY_HASH_DOMAIN,
    variableInventoryHashDomain: VARIABLE_INVENTORY_HASH_DOMAIN,
  });
