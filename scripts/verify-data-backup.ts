import path from "node:path";

import { verifyDataBackup } from "../src/lib/data-backup.js";

function argumentValue(name: string): string | null {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const backupArgument = argumentValue("--backup") || process.argv[2];
if (!backupArgument) {
  throw new Error("Pass the backup directory with --backup=/path/to/backup.");
}
const backupRoot = path.resolve(backupArgument);
const manifest = await verifyDataBackup(backupRoot);

console.log(JSON.stringify({
  ok: true,
  backupRoot,
  database: manifest.database.path,
  evidenceFiles: manifest.evidence.fileCount,
  evidenceBytes: manifest.evidence.bytes,
}, null, 2));
