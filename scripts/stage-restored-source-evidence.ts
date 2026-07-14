import path from "node:path";

function argumentValue(name: string): string | null {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim() || null;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

function requiredEnvironment(name:
  | "STAGING_SUPABASE_URL"
  | "STAGING_SUPABASE_SERVICE_ROLE_KEY"
  | "SUPABASE_URL"
  | "OFFSITE_BACKUP_SUPABASE_URL"
): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const backup = argumentValue("--backup");
  const restore = argumentValue("--restore");
  if (!backup || !restore) {
    throw new Error("Pass both --backup=/verified/backup and --restore=/completed/rehearsal.");
  }
  const stagingSupabaseUrl = requiredEnvironment("STAGING_SUPABASE_URL");
  const stagingServiceRoleKey = requiredEnvironment("STAGING_SUPABASE_SERVICE_ROLE_KEY");
  const productionSupabaseUrl = requiredEnvironment("SUPABASE_URL");
  const offsiteBackupSupabaseUrl = requiredEnvironment("OFFSITE_BACKUP_SUPABASE_URL");
  const { stageRestoredSourceEvidence } = await import("../src/lib/stage-restored-source-evidence.js");
  const result = await stageRestoredSourceEvidence({
    backupPath: path.resolve(backup),
    restorePath: path.resolve(restore),
    stagingSupabaseUrl,
    stagingServiceRoleKey,
    productionSupabaseUrl,
    offsiteBackupSupabaseUrl,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
});
