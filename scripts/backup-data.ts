import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config();

interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
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

async function listFiles(root: string, current = root): Promise<BackupFile[]> {
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  const files: BackupFile[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.promises.stat(absolutePath);
    files.push({
      path: path.relative(root, absolutePath),
      bytes: stat.size,
      sha256: await sha256(absolutePath),
    });
  }
  return files.sort((first, second) => first.path.localeCompare(second.path));
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const sourceDatabase = path.resolve(process.env.DATABASE_PATH || "./data/pint-path.sqlite");
const sourceEvidence = path.resolve(process.env.SOURCE_EVIDENCE_STORAGE_DIR || "./data/source-evidence");
const backupRoot = path.resolve(argumentValue("--output") || `./backups/pint-path-${timestamp}`);
const backupDatabase = path.join(backupRoot, "pint-path.sqlite");
const backupEvidence = path.join(backupRoot, "source-evidence");

if (!fs.existsSync(sourceDatabase)) {
  throw new Error(`Database does not exist: ${sourceDatabase}`);
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
const evidenceFiles = fs.existsSync(backupEvidence) ? await listFiles(backupEvidence) : [];
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  database: {
    path: path.basename(backupDatabase),
    bytes: databaseStat.size,
    sha256: await sha256(backupDatabase),
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

console.log(JSON.stringify({ ok: true, backupRoot, ...manifest }, null, 2));
