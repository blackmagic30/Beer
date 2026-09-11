import crypto from "node:crypto";
import { canonicalProtectedSourceArchiveManifest } from "../src/lib/protected-source-archive.js";

export function productionArchiveFixture(candidateSha = "a".repeat(40)) {
  const manifest = {
    schemaVersion: "protected-source-archive/v2" as const,
    target: "production" as const,
    candidateSha,
    treeSha: "b".repeat(40),
    sourceArchiveSha256: "c".repeat(64),
    sourceBaseManifestSha256: "d".repeat(64),
    uploadNonce: "e".repeat(64),
  };
  return { ...manifest, sourceIdentitySha256: crypto.createHash("sha256")
    .update(canonicalProtectedSourceArchiveManifest(manifest)).digest("hex") };
}

export function productionArchiveReceiptFixture(value: Record<string, unknown>) {
  return { ...value,
    schemaVersion: "pintpath-railway-application-deployment-executor/v7",
    sourceArchive: productionArchiveFixture(String(value.candidateSha)),
    migrationEvidence: { pinsFileSha256: "a".repeat(64), verificationReceiptFileSha256: "b".repeat(64),
      sourceSnapshotSha256: "c".repeat(64), targetIdentitySha256: "d".repeat(64) },
    hostedAcceptance: { reportSha256: "a".repeat(64), requiredChecksSha256: "b".repeat(64),
      stagingRunId: "1234", stagingDeploymentIdSha256: "c".repeat(64), sourceIdentitySha256: "d".repeat(64) },
  };
}
