import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  database: BackupFile;
  evidence: {
    path: string;
    fileCount: number;
    bytes: number;
    files: BackupFile[];
  };
}

export interface RestoreRehearsalResult {
  manifest: BackupManifest;
  restoreRoot: string;
  databasePath: string;
  evidencePath: string;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export function sha256Bytes(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function listBackupFiles(root: string, current = root): Promise<BackupFile[]> {
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  const files: BackupFile[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listBackupFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.promises.stat(absolutePath);
    files.push({
      path: path.relative(root, absolutePath),
      bytes: stat.size,
      sha256: await sha256File(absolutePath),
    });
  }
  return files.sort((first, second) => first.path.localeCompare(second.path));
}

export async function createDataBackup(input: {
  sourceDatabase: string;
  sourceEvidence: string;
  backupRoot: string;
}): Promise<BackupManifest> {
  const sourceDatabase = path.resolve(input.sourceDatabase);
  const sourceEvidence = path.resolve(input.sourceEvidence);
  const backupRoot = path.resolve(input.backupRoot);
  const backupDatabase = path.join(backupRoot, "pint-path.sqlite");
  const backupEvidence = path.join(backupRoot, "source-evidence");

  if (!fs.existsSync(sourceDatabase)) {
    throw new Error(`Database does not exist: ${sourceDatabase}`);
  }

  if (fs.existsSync(backupRoot) && (await fs.promises.readdir(backupRoot)).length > 0) {
    throw new Error(`Backup destination is not empty: ${backupRoot}`);
  }

  await fs.promises.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const database = new BetterSqlite3(sourceDatabase, { readonly: true, fileMustExist: true });
  try {
    await database.backup(backupDatabase);
  } finally {
    database.close();
  }

  if (fs.existsSync(sourceEvidence)) {
    await fs.promises.cp(sourceEvidence, backupEvidence, { recursive: true, errorOnExist: true });
  }

  const databaseStat = await fs.promises.stat(backupDatabase);
  const evidenceFiles = fs.existsSync(backupEvidence) ? await listBackupFiles(backupEvidence) : [];
  const manifest: BackupManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    database: {
      path: path.basename(backupDatabase),
      bytes: databaseStat.size,
      sha256: await sha256File(backupDatabase),
    },
    evidence: {
      path: path.basename(backupEvidence),
      fileCount: evidenceFiles.length,
      bytes: evidenceFiles.reduce((sum, file) => sum + file.bytes, 0),
      files: evidenceFiles,
    },
  };

  await fs.promises.writeFile(
    path.join(backupRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );

  return manifest;
}

async function assertBackupFile(root: string, expected: BackupFile): Promise<void> {
  const filePath = path.resolve(root, expected.path);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe manifest path: ${expected.path}`);
  }
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size !== expected.bytes || await sha256File(filePath) !== expected.sha256) {
    throw new Error(`Backup checksum mismatch: ${expected.path}`);
  }
}

function assertSqliteIntegrity(databasePath: string): void {
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
}

export async function verifyDataBackup(backupPath: string): Promise<BackupManifest> {
  const backupRoot = path.resolve(backupPath);
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(backupRoot, "manifest.json"), "utf8"),
  ) as BackupManifest;
  if (
    manifest.version !== 1 ||
    !manifest.database ||
    !manifest.evidence ||
    !Array.isArray(manifest.evidence.files)
  ) {
    throw new Error("Unsupported backup manifest version.");
  }
  const evidenceBytes = manifest.evidence.files.reduce((total, file) => total + file.bytes, 0);
  if (
    manifest.evidence.fileCount !== manifest.evidence.files.length ||
    manifest.evidence.bytes !== evidenceBytes
  ) {
    throw new Error("Backup evidence manifest totals do not match its file list.");
  }

  await assertBackupFile(backupRoot, manifest.database);
  const evidenceRoot = path.resolve(backupRoot, manifest.evidence.path);
  for (const file of manifest.evidence.files) await assertBackupFile(evidenceRoot, file);
  const actualEvidenceFiles = fs.existsSync(evidenceRoot) ? await listBackupFiles(evidenceRoot) : [];
  if (
    actualEvidenceFiles.length !== manifest.evidence.files.length ||
    actualEvidenceFiles.some((file, index) => file.path !== manifest.evidence.files[index]?.path)
  ) {
    throw new Error("Backup evidence contents do not match its manifest.");
  }

  assertSqliteIntegrity(path.resolve(backupRoot, manifest.database.path));

  return manifest;
}

export async function rehearseDataRestore(input: {
  backupPath: string;
  restoreRoot: string;
}): Promise<RestoreRehearsalResult> {
  const backupRoot = path.resolve(input.backupPath);
  const restoreRoot = path.resolve(input.restoreRoot);
  const manifest = await verifyDataBackup(backupRoot);

  if (fs.existsSync(restoreRoot) && (await fs.promises.readdir(restoreRoot)).length > 0) {
    throw new Error(`Restore rehearsal destination is not empty: ${restoreRoot}`);
  }

  await fs.promises.mkdir(restoreRoot, { recursive: true, mode: 0o700 });
  const databasePath = path.join(restoreRoot, "pint-path.sqlite");
  const evidencePath = path.join(restoreRoot, "source-evidence");
  await fs.promises.copyFile(path.join(backupRoot, manifest.database.path), databasePath);
  await fs.promises.chmod(databasePath, 0o600);

  const backupEvidencePath = path.join(backupRoot, manifest.evidence.path);
  if (fs.existsSync(backupEvidencePath)) {
    await fs.promises.cp(backupEvidencePath, evidencePath, { recursive: true, errorOnExist: true });
  }

  await assertBackupFile(restoreRoot, { ...manifest.database, path: path.basename(databasePath) });
  const restoredEvidenceFiles = fs.existsSync(evidencePath) ? await listBackupFiles(evidencePath) : [];
  if (
    restoredEvidenceFiles.length !== manifest.evidence.files.length ||
    restoredEvidenceFiles.some((file, index) => {
      const expected = manifest.evidence.files[index];
      return !expected || file.path !== expected.path || file.bytes !== expected.bytes || file.sha256 !== expected.sha256;
    })
  ) {
    throw new Error("Restored evidence contents do not match the backup manifest.");
  }
  assertSqliteIntegrity(databasePath);

  return { manifest, restoreRoot, databasePath, evidencePath };
}
