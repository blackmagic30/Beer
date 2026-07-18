import path from "node:path";

import { redactSecrets } from "../src/lib/redact.js";

let loadedCredential: string | null = null;

const ALLOWED_ARGUMENTS = new Set([
  "--backup-id",
  "--expected-manifest-sha256",
  "--output",
  "--service-role-key-file",
]);

function argumentValue(name: string): string | null {
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]!;
    const argumentName = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
    if (!ALLOWED_ARGUMENTS.has(argumentName)) {
      throw new Error(`Unknown argument: ${argumentName}`);
    }
    if (argumentName !== name) {
      if (!argument.includes("=")) index += 1;
      continue;
    }
    if (argument.includes("=")) {
      values.push(argument.slice(argument.indexOf("=") + 1));
    } else {
      values.push(process.argv[index + 1] ?? "");
      index += 1;
    }
  }
  if (values.length > 1) throw new Error(`Pass ${name} exactly once.`);
  const value = values[0]?.trim();
  return value || null;
}

function requiredEnvironment(name: "OFFSITE_BACKUP_SUPABASE_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const backupId = argumentValue("--backup-id");
  const expectedManifestSha256 = argumentValue("--expected-manifest-sha256");
  const output = argumentValue("--output");
  const serviceRoleKeyFile = argumentValue("--service-role-key-file");
  if (!backupId || !expectedManifestSha256 || !output) {
    throw new Error(
      "Pass --backup-id, --expected-manifest-sha256, and --output exactly once.",
    );
  }

  const {
    downloadOffsiteBackup,
    readPrivateSecretFile,
  } = await import("../src/lib/offsite-backup-download.js");
  if (!serviceRoleKeyFile) {
    throw new Error("Pass --service-role-key-file=<mode-600-file>.");
  }
  const destinationServiceRoleKey = await readPrivateSecretFile(serviceRoleKeyFile);
  loadedCredential = destinationServiceRoleKey;

  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Off-site backup download was interrupted."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await downloadOffsiteBackup({
      destinationSupabaseUrl: requiredEnvironment("OFFSITE_BACKUP_SUPABASE_URL"),
      destinationServiceRoleKey,
      bucketName: process.env.OFFSITE_BACKUP_BUCKET?.trim() || "pintpath-backups",
      backupId,
      expectedManifestSha256,
      outputPath: path.resolve(output),
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    loadedCredential = null;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const withoutLoadedCredential = loadedCredential
    ? message.split(loadedCredential).join("[REDACTED]")
    : message;
  loadedCredential = null;
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: redactSecrets(withoutLoadedCredential).slice(0, 500),
  })}\n`);
  process.exitCode = 1;
});
