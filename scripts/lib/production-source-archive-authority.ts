import crypto from "node:crypto";

import {
  canonicalProtectedSourceArchiveManifest,
  parseProtectedSourceArchiveManifest,
  parseProtectedSourceArchiveRuntimeResponse,
  type ProtectedSourceArchiveIdentity,
} from "../../src/lib/protected-source-archive.js";

/** Only identities carried by a separately verified production receipt are authority. */
export function productionSourceArchiveIdentity(
  value: unknown,
  candidateSha: string,
): ProtectedSourceArchiveIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { sourceIdentitySha256, ...raw } = value as Record<string, unknown>;
  const manifest = parseProtectedSourceArchiveManifest(`${JSON.stringify(raw)}\n`);
  if (!manifest || manifest.schemaVersion !== "protected-source-archive/v2"
    || manifest.target !== "production" || manifest.candidateSha !== candidateSha
    || sourceIdentitySha256 !== crypto.createHash("sha256")
      .update(canonicalProtectedSourceArchiveManifest(manifest)).digest("hex")) return null;
  return { ...manifest, sourceIdentitySha256 } as ProtectedSourceArchiveIdentity;
}

export function productionArchiveRuntime(
  route: "/health" | "/startup" | "/ready",
  source: string,
  candidateSha: string,
  expectedArchive: ProtectedSourceArchiveIdentity,
) {
  const authority = productionSourceArchiveIdentity(expectedArchive, candidateSha);
  const runtime = parseProtectedSourceArchiveRuntimeResponse(route, source);
  if (!authority || !runtime
    || runtime.deployment.sourceArchive.sourceIdentitySha256 !== authority.sourceIdentitySha256
    || !productionSourceArchiveIdentity(runtime.deployment.sourceArchive, candidateSha)) return null;
  return runtime;
}

/** Missing Git metadata is accepted only with an independently bound archive. */
export function productionProviderSourceExact(
  commitHash: string | null,
  candidateSha: string,
  expectedArchive?: ProtectedSourceArchiveIdentity,
): boolean {
  return expectedArchive
    ? productionSourceArchiveIdentity(expectedArchive, candidateSha) !== null
      && (commitHash === null || commitHash === candidateSha)
    : commitHash === candidateSha;
}
