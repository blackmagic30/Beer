import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

export type RailwayDeploymentIdentityKind =
  | "project"
  | "environment"
  | "service"
  | "deployment"
  | "replica";

export interface RailwayDeploymentIdentitySource {
  readonly RAILWAY_PROJECT_ID?: string | undefined;
  readonly RAILWAY_ENVIRONMENT_ID?: string | undefined;
  readonly RAILWAY_SERVICE_ID?: string | undefined;
  readonly RAILWAY_DEPLOYMENT_ID?: string | undefined;
  readonly RAILWAY_REPLICA_ID?: string | undefined;
}

export interface RailwayDeploymentIdentityHashes {
  readonly projectIdSha256?: string | undefined;
  readonly environmentIdSha256?: string | undefined;
  readonly serviceIdSha256?: string | undefined;
  readonly deploymentIdSha256?: string | undefined;
  readonly replicaIdSha256?: string | undefined;
}

const CRYPTO_CREATE_HASH = crypto.createHash;
const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_BYTE_LENGTH = BUFFER_CONSTRUCTOR.byteLength;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_FREEZE = OBJECT_CONSTRUCTOR.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = OBJECT_CONSTRUCTOR.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = OBJECT_CONSTRUCTOR.getPrototypeOf;
const OBJECT_HAS_OWN = OBJECT_CONSTRUCTOR.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REGEXP_EXEC = RegExp.prototype.exec;
const STRING_TRIM = String.prototype.trim;
const CANONICAL_RAILWAY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const MAXIMUM_RAILWAY_REPLICA_ID_BYTES = 256;
const PROCESS_ENV = process.env;
const UTIL_IS_PROXY = utilTypes.isProxy;

export const RAILWAY_DEPLOYMENT_IDENTITY_SHA256_DOMAINS = OBJECT_FREEZE({
  project: "pintpath/railway-project-evidence/v1\0",
  environment: "pintpath/railway-environment-evidence/v1\0",
  service: "pintpath/railway-service-evidence/v1\0",
  deployment: "pintpath/railway-deployment-evidence/v1\0",
  replica: "pintpath/replica-evidence/v1\0",
} as const);

const HASH_PROBE = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(HASH_PROBE) as {
  readonly update: (...args: never[]) => unknown;
  readonly digest: (...args: never[]) => unknown;
};
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);

function domainForKind(kind: RailwayDeploymentIdentityKind): string | undefined {
  switch (kind) {
    case "project": return RAILWAY_DEPLOYMENT_IDENTITY_SHA256_DOMAINS.project;
    case "environment": return RAILWAY_DEPLOYMENT_IDENTITY_SHA256_DOMAINS.environment;
    case "service": return RAILWAY_DEPLOYMENT_IDENTITY_SHA256_DOMAINS.service;
    case "deployment": return RAILWAY_DEPLOYMENT_IDENTITY_SHA256_DOMAINS.deployment;
    case "replica": return RAILWAY_DEPLOYMENT_IDENTITY_SHA256_DOMAINS.replica;
  }
}

function exactOwnString(
  source: RailwayDeploymentIdentitySource,
  key: keyof RailwayDeploymentIdentitySource,
): string | undefined {
  if (
    typeof source !== "object"
    || source === null
    || REFLECT_APPLY(UTIL_IS_PROXY, utilTypes, [source]) === true
  ) return undefined;
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [source, key],
  ) as PropertyDescriptor | undefined;
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || REFLECT_APPLY(OBJECT_HAS_OWN, OBJECT_CONSTRUCTOR, [descriptor, "value"])
      !== true
    || typeof descriptor.value !== "string"
  ) return undefined;
  return descriptor.value;
}

/**
 * Returns a non-reversible, domain-separated public binding. Railway resource
 * IDs require their exact canonical lowercase UUID spelling. Replica IDs are
 * opaque platform values and retain the legacy trim-before-hashing behavior.
 */
export function railwayDeploymentIdentityIdSha256(
  kind: RailwayDeploymentIdentityKind,
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value;
  if (kind === "replica") {
    normalized = REFLECT_APPLY(STRING_TRIM, value, []) as string;
    if (
      normalized.length === 0
      || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_CONSTRUCTOR, [normalized, "utf8"])
        > MAXIMUM_RAILWAY_REPLICA_ID_BYTES
      || REFLECT_APPLY(REGEXP_EXEC, CONTROL_CHARACTER_PATTERN, [normalized]) !== null
    ) return undefined;
  } else if (
    REFLECT_APPLY(REGEXP_EXEC, CANONICAL_RAILWAY_UUID_PATTERN, [normalized]) === null
  ) {
    return undefined;
  }

  const domain = domainForKind(kind);
  if (domain === undefined) return undefined;
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [domain, "utf8"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [normalized, "utf8"]);
  return REFLECT_APPLY(HASH_DIGEST, hash, ["hex"]) as string;
}

export function replicaIdSha256(
  replicaId = exactOwnString(PROCESS_ENV, "RAILWAY_REPLICA_ID"),
): string | undefined {
  return railwayDeploymentIdentityIdSha256("replica", replicaId);
}

export function railwayDeploymentIdentityHashes(
  source: RailwayDeploymentIdentitySource = PROCESS_ENV,
): RailwayDeploymentIdentityHashes {
  const projectIdSha256 = railwayDeploymentIdentityIdSha256(
    "project",
    exactOwnString(source, "RAILWAY_PROJECT_ID"),
  );
  const environmentIdSha256 = railwayDeploymentIdentityIdSha256(
    "environment",
    exactOwnString(source, "RAILWAY_ENVIRONMENT_ID"),
  );
  const serviceIdSha256 = railwayDeploymentIdentityIdSha256(
    "service",
    exactOwnString(source, "RAILWAY_SERVICE_ID"),
  );
  const deploymentIdSha256 = railwayDeploymentIdentityIdSha256(
    "deployment",
    exactOwnString(source, "RAILWAY_DEPLOYMENT_ID"),
  );
  const replicaIdSha256 = railwayDeploymentIdentityIdSha256(
    "replica",
    exactOwnString(source, "RAILWAY_REPLICA_ID"),
  );

  return OBJECT_FREEZE({
    ...(projectIdSha256 ? { projectIdSha256 } : {}),
    ...(environmentIdSha256 ? { environmentIdSha256 } : {}),
    ...(serviceIdSha256 ? { serviceIdSha256 } : {}),
    ...(deploymentIdSha256 ? { deploymentIdSha256 } : {}),
    ...(replicaIdSha256 ? { replicaIdSha256 } : {}),
  });
}
