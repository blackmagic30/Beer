import path from "node:path";

import dotenv from "dotenv";

import { runOffsiteBackup } from "../src/lib/offsite-backup.js";

dotenv.config();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for off-site backups.`);
  return value;
}

const result = await runOffsiteBackup({
  databasePath: path.resolve(required("DATABASE_PATH")),
  evidencePath: path.resolve(process.env.SOURCE_EVIDENCE_STORAGE_DIR || "./data/source-evidence"),
  supabaseUrl: required("SUPABASE_URL"),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  bucketName: process.env.OFFSITE_BACKUP_BUCKET?.trim() || "pintpath-backups",
  retentionDays: Number(process.env.OFFSITE_BACKUP_RETENTION_DAYS || 30),
});

console.log(JSON.stringify({ ok: true, ...result }, null, 2));
