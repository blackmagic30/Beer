import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface BackupManifest {
  version: number;
  database: ManifestFile;
  evidence: { path: string; fileCount: number; bytes: number; files: ManifestFile[] };
}

function argumentValue(name: string): string | null {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function assertFile(root: string, expected: ManifestFile): Promise<void> {
  const filePath = path.resolve(root, expected.path);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe manifest path: ${expected.path}`);
  }
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size !== expected.bytes || await sha256(filePath) !== expected.sha256) {
    throw new Error(`Backup checksum mismatch: ${expected.path}`);
  }
}

const backupArgument = argumentValue("--backup") || process.argv[2];
if (!backupArgument) {
  throw new Error("Pass the backup directory with --backup=/path/to/backup.");
}
const backupRoot = path.resolve(backupArgument);

const manifest = JSON.parse(
  await fs.promises.readFile(path.join(backupRoot, "manifest.json"), "utf8"),
) as BackupManifest;
if (manifest.version !== 1) throw new Error("Unsupported backup manifest version.");

await assertFile(backupRoot, manifest.database);
const evidenceRoot = path.resolve(backupRoot, manifest.evidence.path);
for (const file of manifest.evidence.files) await assertFile(evidenceRoot, file);

const databasePath = path.resolve(backupRoot, manifest.database.path);
const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
try {
  const integrity = database.pragma("integrity_check") as Array<{ integrity_check: string }>;
  const foreignKeys = database.pragma("foreign_key_check") as unknown[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
  }
  if (foreignKeys.length > 0) {
    throw new Error(`SQLite foreign-key check failed: ${JSON.stringify(foreignKeys)}`);
  }
} finally {
  database.close();
}

console.log(JSON.stringify({
  ok: true,
  backupRoot,
  database: manifest.database.path,
  evidenceFiles: manifest.evidence.fileCount,
  evidenceBytes: manifest.evidence.bytes,
}, null, 2));
