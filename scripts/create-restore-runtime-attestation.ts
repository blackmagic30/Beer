import path from "node:path";

import { writeRestoreRuntimeAttestation } from "../src/lib/restore-rehearsal.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const allowedArguments = new Set([
  "--restore-root",
  "--backup-id",
  "--source-manifest",
  "--source-manifest-sha256",
  "--deletion-ledger-sha256",
  "--deletion-ledger-genesis-sha256",
  "--deletion-ledger-checkpoint-sha256",
]);
const argumentsByName = parseStrictArguments(process.argv.slice(2), {
  allowed: allowedArguments,
  required: allowedArguments,
});
const restoreRoot = argumentsByName.get("--restore-root")!;
const backupId = argumentsByName.get("--backup-id")!;
const sourceManifestPath = argumentsByName.get("--source-manifest")!;
const expectedSourceManifestSha256 = argumentsByName.get("--source-manifest-sha256")!;
const expectedDeletionLedgerSha256 = argumentsByName.get("--deletion-ledger-sha256")!;
const expectedDeletionLedgerGenesisSha256 = argumentsByName.get("--deletion-ledger-genesis-sha256")!;
const expectedDeletionLedgerCheckpointSha256 = argumentsByName.get(
  "--deletion-ledger-checkpoint-sha256",
)!;

const result = await writeRestoreRuntimeAttestation({
  restoreRoot: path.resolve(restoreRoot),
  backupId,
  sourceManifestPath: path.resolve(sourceManifestPath),
  expectedSourceManifestSha256,
  expectedDeletionLedgerSha256,
  expectedDeletionLedgerGenesisSha256,
  expectedDeletionLedgerCheckpointSha256,
});

console.log(JSON.stringify({
  ok: true,
  attestationPath: result.attestationPath,
  attestationSha256: result.attestationSha256,
  backupId: result.attestation.backupId,
  sourceManifestSha256: result.attestation.sourceManifestSha256,
  database: result.attestation.database,
  evidence: {
    path: result.attestation.evidence.path,
    fileCount: result.attestation.evidence.fileCount,
    bytes: result.attestation.evidence.bytes,
  },
  storageEvidence: {
    provider: result.attestation.storageEvidence.provider,
    bucket: result.attestation.storageEvidence.bucket,
    path: result.attestation.storageEvidence.path,
    fileCount: result.attestation.storageEvidence.fileCount,
    bytes: result.attestation.storageEvidence.bytes,
  },
  restoreRehearsal: result.attestation.restoreRehearsal,
}, null, 2));
