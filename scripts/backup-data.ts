import path from "node:path";

import dotenv from "dotenv";

import { createDataBackup } from "../src/lib/data-backup.js";

dotenv.config({ quiet: true });

function argumentValue(name: string): string | null {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const sourceDatabase = path.resolve(process.env.DATABASE_PATH || "./data/pint-path.sqlite");
const sourceEvidence = path.resolve(process.env.SOURCE_EVIDENCE_STORAGE_DIR || "./data/source-evidence");
const backupRoot = path.resolve(argumentValue("--output") || `./backups/pint-path-${timestamp}`);
const manifest = await createDataBackup({ sourceDatabase, sourceEvidence, backupRoot });

console.log(JSON.stringify({ ok: true, backupRoot, ...manifest }, null, 2));
