import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchVerifiedAccountDeletionLedger,
} from "../src/lib/offsite-backup.js";
import { readPrivateSecretFile } from "../src/lib/offsite-backup-download.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  OPERATIONAL_OFFSITE_BACKUP_BUCKET,
  OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
  PRODUCTION_SUPABASE_AUTH_ORIGIN,
  assertExactSupabaseOrigin,
  assertSupabaseServerApiKey,
} from "../src/lib/supabase-key-format.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const ARGUMENTS = new Set([
  "--expected-checkpoint-sha256",
  "--expected-current-sha256",
  "--expected-genesis-sha256",
  "--expected-immutable-set-sha256",
  "--expected-tombstone-count",
  "--output-directory",
  "--service-role-key-file",
]);
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code: string): never {
  throw new Error(`postgres_deletion_authority_retrieval_${code}`);
}

function exactAbsolute(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    fail("arguments_invalid");
  }
  return value;
}

function exactSha(value: string): string {
  if (!SHA256.test(value)) fail("arguments_invalid");
  return value;
}

function exactCount(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) fail("arguments_invalid");
  const count = Number(value);
  if (!Number.isSafeInteger(count)) fail("arguments_invalid");
  return count;
}

function assertPrivateDirectory(directory: string, uid: number): void {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid)
    || Number(stat.mode & 0o7777n) !== 0o700 || fs.realpathSync(directory) !== directory
    || fs.readdirSync(directory).length !== 0) fail("output_unsafe");
}

function privateWrite(directory: string, leaf: string, bytes: Buffer): void {
  const handle = fs.openSync(
    path.join(directory, leaf),
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

export async function retrievePostgresAccountDeletionAuthority(
  argv: readonly string[],
): Promise<object> {
  let args: ReadonlyMap<string, string>;
  try {
    args = parseStrictArguments(argv, { allowed: ARGUMENTS, required: ARGUMENTS });
  } catch {
    fail("arguments_invalid");
  }
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) fail("output_unsafe");
  const outputDirectory = exactAbsolute(args.get("--output-directory")!);
  assertPrivateDirectory(outputDirectory, uid);
  const serviceRoleKey = await readPrivateSecretFile(
    exactAbsolute(args.get("--service-role-key-file")!),
  );
  assertSupabaseServerApiKey(serviceRoleKey, "operational deletion authority key");
  assertExactSupabaseOrigin(
    process.env.SUPABASE_URL ?? "",
    PRODUCTION_SUPABASE_AUTH_ORIGIN,
    "SUPABASE_URL",
  );
  assertExactSupabaseOrigin(
    process.env.OFFSITE_BACKUP_SUPABASE_URL ?? "",
    OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
    "OFFSITE_BACKUP_SUPABASE_URL",
  );
  if (process.env.OFFSITE_BACKUP_BUCKET !== OPERATIONAL_OFFSITE_BACKUP_BUCKET) {
    fail("boundary_invalid");
  }
  const verified = await fetchVerifiedAccountDeletionLedger({
    sourceSupabaseUrl: PRODUCTION_SUPABASE_AUTH_ORIGIN,
    destinationSupabaseUrl: OPERATIONAL_OFFSITE_SUPABASE_ORIGIN,
    destinationServiceRoleKey: serviceRoleKey,
    bucketName: OPERATIONAL_OFFSITE_BACKUP_BUCKET,
  });
  serviceRoleKey.split("").fill?.("");
  const expected = {
    current: exactSha(args.get("--expected-current-sha256")!),
    genesis: exactSha(args.get("--expected-genesis-sha256")!),
    checkpoint: exactSha(args.get("--expected-checkpoint-sha256")!),
    immutable: exactSha(args.get("--expected-immutable-set-sha256")!),
    count: exactCount(args.get("--expected-tombstone-count")!),
  };
  if (verified.sha256 !== expected.current
    || verified.genesisSha256 !== expected.genesis
    || verified.checkpointSha256 !== expected.checkpoint
    || verified.checkpoint.immutableSetSha256 !== expected.immutable
    || verified.checkpoint.tombstoneCount !== expected.count) fail("authority_mismatch");
  privateWrite(outputDirectory, "current.json", verified.bytes);
  privateWrite(outputDirectory, "genesis.json", verified.genesisBytes);
  privateWrite(outputDirectory, "checkpoint.json", verified.checkpointBytes);
  const authoritySetSha256 = crypto.createHash("sha256").update(
    canonicalPostgresBackupJson({
      kind: "pintpath-postgres-private-storage-deletion-authority-set",
      version: 1,
      currentSha256: verified.sha256,
      genesisSha256: verified.genesisSha256,
      checkpointSha256: verified.checkpointSha256,
      immutableSetSha256: verified.checkpoint.immutableSetSha256,
      tombstoneCount: verified.checkpoint.tombstoneCount,
      latestCompletedAt: verified.checkpoint.latestCompletedAt,
    }),
  ).digest("hex");
  return {
    schemaVersion: 1,
    kind: "pintpath-postgres-account-deletion-authority-retrieval",
    ok: true,
    currentSha256: verified.sha256,
    genesisSha256: verified.genesisSha256,
    checkpointSha256: verified.checkpointSha256,
    immutableSetSha256: verified.checkpoint.immutableSetSha256,
    authoritySetSha256,
    tombstoneCount: verified.checkpoint.tombstoneCount,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(canonicalPostgresBackupJson(
      await retrievePostgresAccountDeletionAuthority(process.argv.slice(2)),
    ));
  } catch (error) {
    process.stdout.write(canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: false,
      failureCode: error instanceof Error ? error.message : "unexpected_failure",
    }));
    process.exitCode = 1;
  }
}
