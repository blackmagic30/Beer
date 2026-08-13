import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { runOffsiteBackup } from "../src/lib/offsite-backup.js";
import {
  assertExactSupabaseOrigin,
  assertSupabaseServerApiKey,
  resolveExactOperationalOffsiteBackupBucket,
} from "../src/lib/supabase-key-format.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

dotenv.config({ quiet: true });

export interface BackupDataOffsiteCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly runBackup: typeof runOffsiteBackup;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: BackupDataOffsiteCliDependencies = {
  env: process.env,
  assertMutationAllowed: assertOperatorMutationAllowed,
  runBackup: runOffsiteBackup,
  writeOutput: (value) => process.stdout.write(value),
};

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for off-site backups.`);
  return value;
}

function write(
  dependencies: BackupDataOffsiteCliDependencies,
  value: Readonly<Record<string, unknown>>,
): void {
  dependencies.writeOutput(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runBackupDataOffsiteCli(
  dependencies: BackupDataOffsiteCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  try {
    dependencies.assertMutationAllowed("Off-site backup upload and retention");

    const sourceSupabaseUrl = dependencies.env.SUPABASE_URL ?? "";
    const sourceServiceRoleKey = dependencies.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    const destinationSupabaseUrl = dependencies.env.OFFSITE_BACKUP_SUPABASE_URL ?? "";
    const destinationServiceRoleKey = dependencies.env.OFFSITE_BACKUP_SERVICE_ROLE_KEY ?? "";
    assertExactSupabaseOrigin(sourceSupabaseUrl, "https://auth.pintpath.au", "SUPABASE_URL");
    assertSupabaseServerApiKey(sourceServiceRoleKey, "SUPABASE_SERVICE_ROLE_KEY");
    assertExactSupabaseOrigin(
      destinationSupabaseUrl,
      "https://hfbmhdxrwtihukmixxta.supabase.co",
      "OFFSITE_BACKUP_SUPABASE_URL",
    );
    assertSupabaseServerApiKey(
      destinationServiceRoleKey,
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    );

    const result = await dependencies.runBackup({
      databasePath: path.resolve(required(dependencies.env, "DATABASE_PATH")),
      evidencePath: path.resolve(
        dependencies.env.SOURCE_EVIDENCE_STORAGE_DIR || "./data/source-evidence",
      ),
      sourceSupabaseUrl,
      sourceServiceRoleKey,
      destinationSupabaseUrl,
      destinationServiceRoleKey,
      bucketName: resolveExactOperationalOffsiteBackupBucket(
        dependencies.env.OFFSITE_BACKUP_BUCKET,
      ),
      retentionDays: Number(dependencies.env.OFFSITE_BACKUP_RETENTION_DAYS || 30),
    });

    write(dependencies, { ok: true, ...result });
    return 0;
  } catch {
    // Provider and SDK errors are deliberately not reflected into CLI output.
    write(dependencies, { ok: false, failureCode: "backup_failed" });
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBackupDataOffsiteCli();
}
