import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  railwayDeploymentIdentityHashes,
} from "./railway-deployment-identity.js";
import type {
  RailwayApplicationDeploymentAttestationRuntimeResponse,
} from "./railway-application-deployment-attestation.js";

export const PROTECTED_SOURCE_ARCHIVE_FILENAME = ".pintpath-source-archive.json";
const MANIFEST_KEYS = [
  "schemaVersion", "candidateSha", "treeSha", "sourceArchiveSha256",
  "sourceBaseManifestSha256", "uploadNonce",
] as const;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MANIFEST_MAX_BYTES = 2048;
const RUNTIME_MAX_BYTES = 1024 * 1024;
const STAGING_SCOPE = Object.freeze({
  RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  RAILWAY_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
});
const PRODUCTION_SCOPE = Object.freeze({
  ...STAGING_SCOPE,
  RAILWAY_ENVIRONMENT_ID: "13dab015-df74-45c6-b26f-69323daea99a",
});

interface ProtectedSourceArchiveFields {
  readonly candidateSha: string;
  readonly treeSha: string;
  readonly sourceArchiveSha256: string;
  readonly sourceBaseManifestSha256: string;
  readonly uploadNonce: string;
}

export type ProtectedSourceArchiveManifest = ProtectedSourceArchiveFields & (
  | { readonly schemaVersion: "protected-source-archive/v1" }
  | { readonly schemaVersion: "protected-source-archive/v2"; readonly target: "production" }
);

export type ProtectedSourceArchiveIdentity = ProtectedSourceArchiveManifest & {
  readonly sourceIdentitySha256: string;
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key, index) => key === actual[index]);
}

function hash(source: string | Buffer): string {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function validManifest(value: unknown): value is ProtectedSourceArchiveManifest {
  return plainObject(value)
    && (value.schemaVersion === "protected-source-archive/v1"
      ? exactKeys(value, MANIFEST_KEYS)
      : value.schemaVersion === "protected-source-archive/v2" && value.target === "production"
        && exactKeys(value, ["schemaVersion", "target", ...MANIFEST_KEYS.slice(1)]))
    && typeof value.candidateSha === "string" && SHA.test(value.candidateSha)
    && typeof value.treeSha === "string" && SHA.test(value.treeSha)
    && [value.sourceArchiveSha256, value.sourceBaseManifestSha256, value.uploadNonce]
      .every((value) => typeof value === "string" && SHA256.test(value));
}

export function canonicalProtectedSourceArchiveManifest(
  manifest: ProtectedSourceArchiveManifest,
): string {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    ...(manifest.schemaVersion === "protected-source-archive/v2" ? { target: manifest.target } : {}),
    candidateSha: manifest.candidateSha,
    treeSha: manifest.treeSha,
    sourceArchiveSha256: manifest.sourceArchiveSha256,
    sourceBaseManifestSha256: manifest.sourceBaseManifestSha256,
    uploadNonce: manifest.uploadNonce,
  };
  if (!validManifest(ordered)) throw new Error("protected_source_archive_invalid");
  return `${JSON.stringify(ordered)}\n`;
}

/** Exact canonical bytes reject duplicate keys, extra fields and ambiguous spellings. */
export function parseProtectedSourceArchiveManifest(
  source: string,
): ProtectedSourceArchiveManifest | null {
  if (typeof source !== "string" || Buffer.byteLength(source) > MANIFEST_MAX_BYTES) return null;
  try {
    const value: unknown = JSON.parse(source);
    if (!validManifest(value) || canonicalProtectedSourceArchiveManifest(value) !== source) return null;
    return Object.freeze(value);
  } catch {
    return null;
  }
}

/**
 * Read the one packaged file through its descriptor. A path replacement cannot
 * redirect the read, and changes to the opened inode are rejected before use.
 * An absent file is the unchanged ordinary Git deployment path.
 */
export function readProtectedSourceArchiveManifest(
  root: string,
): ProtectedSourceArchiveIdentity | null {
  let descriptor: number;
  const filename = path.join(root, PROTECTED_SOURCE_ARCHIVE_FILENAME);
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("protected_source_archive_file_invalid");
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!path.isAbsolute(root) || path.normalize(root) !== root
      || fs.realpathSync(root) !== root
      || !before.isFile() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n
      || before.size < 1n || before.size > BigInt(MANIFEST_MAX_BYTES)) {
      throw new Error("protected_source_archive_file_invalid");
    }
    const buffer = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(descriptor, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    const bytes = buffer.subarray(0, count);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(filename, { bigint: true });
    for (const current of [after, named]) {
      if (!current.isFile() || current.isSymbolicLink()
        || current.dev !== before.dev || current.ino !== before.ino
        || current.mode !== before.mode || current.nlink !== before.nlink
        || current.size !== before.size || current.mtimeNs !== before.mtimeNs
        || current.ctimeNs !== before.ctimeNs || BigInt(bytes.length) !== before.size) {
        throw new Error("protected_source_archive_file_invalid");
      }
    }
    const source = bytes.toString("utf8");
    const manifest = parseProtectedSourceArchiveManifest(source);
    if (!manifest || !Buffer.from(source, "utf8").equals(bytes)) {
      throw new Error("protected_source_archive_invalid");
    }
    return Object.freeze({ ...manifest, sourceIdentitySha256: hash(bytes) });
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Source uses the repository root; compiled code uses its retained dist root. */
export function protectedSourceArchivePackageRoot(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../..");
}

export function loadProtectedSourceArchiveRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  root = protectedSourceArchivePackageRoot(),
): ProtectedSourceArchiveIdentity | null {
  const identity = readProtectedSourceArchiveManifest(root);
  if (!identity) return null;
  const production = identity.schemaVersion === "protected-source-archive/v2";
  const scope = production ? PRODUCTION_SCOPE : STAGING_SCOPE;
  if (environment.NODE_ENV !== "production"
    || environment.RAILWAY_ENVIRONMENT_NAME !== (production ? "production" : "staging")
    || Object.entries(scope).some(([name, value]) => environment[name] !== value)
    || environment.PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA !== identity.candidateSha
    || environment.RESTORE_REHEARSAL_MODE === "true"
    || environment.POSTGRES_RECOVERY_REHEARSAL_MODE === "true") {
    throw new Error("protected_source_archive_runtime_scope_invalid");
  }
  for (const key of ["RAILWAY_GIT_COMMIT_SHA", "GITHUB_SHA", "VERCEL_GIT_COMMIT_SHA"]) {
    const actual = environment[key];
    if (actual !== undefined && actual !== identity.candidateSha) {
      throw new Error("protected_source_archive_git_identity_conflict");
    }
  }
  return identity;
}

type RuntimeRoute = RailwayApplicationDeploymentAttestationRuntimeResponse["route"];
export interface ProtectedSourceArchiveRuntimeResponse extends Omit<
  RailwayApplicationDeploymentAttestationRuntimeResponse, "deployment"
> {
  readonly deployment: RailwayApplicationDeploymentAttestationRuntimeResponse["deployment"] & {
    readonly sourceArchive: ProtectedSourceArchiveIdentity;
  };
}

function allowedRestoreState(value: unknown): boolean {
  return exactKeys(value, [
    "enabled", "externalWritesAllowed", "httpMutationRoutesAllowed",
    "runtimeDatabase", "remoteVenueDirectoryEnabled",
  ]) && value.enabled === false
    && value.externalWritesAllowed === true && value.httpMutationRoutesAllowed === true
    && value.runtimeDatabase === "primary_runtime_database" && value.remoteVenueDirectoryEnabled === true;
}

function disallowedRestoreMarker(value: unknown, route: RuntimeRoute): boolean {
  const allowed = route === "/ready" && plainObject(value) && plainObject(value.data)
    && plainObject(value.data.dependencies) ? value.data.dependencies : null;
  const pending = [value];
  let visited = 0;
  while (pending.length) {
    if (++visited > 20_000) return true;
    const current = pending.pop();
    if (Array.isArray(current)) pending.push(...current);
    else if (plainObject(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (/restore/i.test(key)
          && (current !== allowed || key !== "restoreRehearsal" || !allowedRestoreState(child))) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

/** A separate archive parser: no manufactured Git identity is passed to legacy attestation. */
export function parseProtectedSourceArchiveRuntimeResponse(
  route: RuntimeRoute,
  source: string,
): ProtectedSourceArchiveRuntimeResponse | null {
  if (!["/health", "/startup", "/ready"].includes(route) || typeof source !== "string"
    || Buffer.byteLength(source) > RUNTIME_MAX_BYTES || source.includes("\0")) return null;
  try {
    const value: unknown = JSON.parse(source);
    if (!exactKeys(value, ["ok", "data"]) || value.ok !== true || !plainObject(value.data)
      || disallowedRestoreMarker(value, route)) return null;
    const data = value.data;
    if (!exactKeys(data, route === "/health"
      ? ["service", "status", "deployment", "automaticMaintenance"]
      : ["service", "status", "deployment", "automaticMaintenance", "dependencies"])) return null;
    const status = route === "/health" ? "ok" : route === "/startup" ? "startup_ready" : "ready";
    if (data.service !== "pint-path" || data.status !== status
      || !exactKeys(data.automaticMaintenance, ["enabled", "candidateBound"])
      || typeof data.automaticMaintenance.enabled !== "boolean" || data.automaticMaintenance.candidateBound !== true
      || (route !== "/health" && !plainObject(data.dependencies))) return null;
    const deployment = data.deployment;
    if (!exactKeys(deployment, [
      "version", "commitSha", "environment", "projectIdSha256", "environmentIdSha256",
      "serviceIdSha256", "deploymentIdSha256", "replicaIdSha256", "sourceArchive",
    ]) || typeof deployment.version !== "string" || !/^[a-z0-9._-]{1,80}$/i.test(deployment.version)
      || typeof deployment.commitSha !== "string"
      || !(deployment.commitSha === "unknown" || SHA.test(deployment.commitSha))
      || deployment.environment !== "production"
      || !plainObject(deployment.sourceArchive)
      || !exactKeys(deployment.sourceArchive, [
        ...(deployment.sourceArchive.schemaVersion === "protected-source-archive/v2"
          ? ["schemaVersion", "target", ...MANIFEST_KEYS.slice(1)] : MANIFEST_KEYS),
        "sourceIdentitySha256",
      ])) return null;
    const { sourceIdentitySha256, ...rawManifest } = deployment.sourceArchive;
    const manifest = parseProtectedSourceArchiveManifest(`${JSON.stringify(rawManifest)}\n`);
    if (!manifest || sourceIdentitySha256 !== hash(canonicalProtectedSourceArchiveManifest(manifest))
      || (manifest.schemaVersion === "protected-source-archive/v1" && data.automaticMaintenance.enabled !== false)
      || (deployment.commitSha !== "unknown" && deployment.commitSha !== manifest.candidateSha)) return null;
    const scope = railwayDeploymentIdentityHashes(manifest.schemaVersion === "protected-source-archive/v2"
      ? PRODUCTION_SCOPE : STAGING_SCOPE);
    if (deployment.projectIdSha256 !== scope.projectIdSha256
      || deployment.environmentIdSha256 !== scope.environmentIdSha256
      || deployment.serviceIdSha256 !== scope.serviceIdSha256
      || typeof deployment.deploymentIdSha256 !== "string" || !SHA256.test(deployment.deploymentIdSha256)
      || typeof deployment.replicaIdSha256 !== "string" || !SHA256.test(deployment.replicaIdSha256)) return null;
    return {
      route, service: "pint-path", status,
      deployment: deployment as unknown as ProtectedSourceArchiveRuntimeResponse["deployment"],
      automaticMaintenance: { enabled: data.automaticMaintenance.enabled, candidateBound: true },
      restoreMarkerPresent: false,
      responseSha256: hash(source),
    };
  } catch {
    return null;
  }
}
