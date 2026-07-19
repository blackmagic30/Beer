import path from "node:path";

import { verifyRestoreRuntimeAttestation } from "../src/lib/restore-rehearsal.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const allowedArguments = new Set([
  "--restore-root",
  "--backup-id",
  "--attestation-sha256",
  "--source-manifest-sha256",
]);

try {
  const argumentsByName = parseStrictArguments(process.argv.slice(2), {
    allowed: allowedArguments,
    required: allowedArguments,
  });
  const verified = await verifyRestoreRuntimeAttestation({
    restoreRoot: path.resolve(argumentsByName.get("--restore-root")!),
    expectedBackupId: argumentsByName.get("--backup-id")!,
    expectedAttestationSha256: argumentsByName.get("--attestation-sha256")!,
    expectedSourceManifestSha256: argumentsByName.get("--source-manifest-sha256")!,
  });
  console.log(JSON.stringify({
    ok: true,
    verified: true,
    backupId: verified.attestation.backupId,
    attestationSha256: verified.attestationSha256,
    sourceManifestSha256: verified.attestation.sourceManifestSha256,
    runtimeDatabaseSha256: verified.attestation.database.sha256,
    evidenceFileCount: verified.attestation.evidence.fileCount,
    storageEvidenceFileCount: verified.attestation.storageEvidence.fileCount,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    verified: false,
    code: "RESTORE_RUNTIME_VERIFICATION_FAILED",
    error: error instanceof Error ? error.message.replace(/[\r\n\t]+/g, " ").slice(0, 300) : "Verification failed.",
  }, null, 2));
  process.exitCode = 1;
}
