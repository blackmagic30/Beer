import path from "node:path";

import { activateVerifiedRestoreRuntime } from "../src/lib/restore-rehearsal.js";

const ALLOWED_ARGUMENTS = new Set([
  "--incoming-root",
  "--final-root",
  "--backup-id",
  "--attestation-sha256",
  "--source-manifest-sha256",
]);

function parseArguments(): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const raw = process.argv[index]!;
    const equalsIndex = raw.indexOf("=");
    const name = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
    if (!ALLOWED_ARGUMENTS.has(name)) {
      throw new Error("Unsupported restore activation argument.");
    }
    if (parsed.has(name)) {
      throw new Error(`Restore activation argument ${name} was provided more than once.`);
    }
    const value = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : process.argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Restore activation argument ${name} is missing its value.`);
    }
    parsed.set(name, value);
  }
  for (const name of ALLOWED_ARGUMENTS) {
    if (!parsed.has(name)) throw new Error(`Restore activation argument ${name} is required.`);
  }
  return parsed;
}

function sanitizeError(error: unknown, sensitivePaths: string[]): string {
  let message = error instanceof Error ? error.message : "Restore activation failed.";
  for (const sensitivePath of sensitivePaths) {
    if (sensitivePath) message = message.split(sensitivePath).join("[restore-path]");
  }
  return message
    .replace(/: [^\r\n]+$/g, ": [redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
}

let sensitivePaths: string[] = [];
try {
  const argumentsByName = parseArguments();
  const incomingRoot = path.resolve(argumentsByName.get("--incoming-root")!);
  const finalRoot = path.resolve(argumentsByName.get("--final-root")!);
  sensitivePaths = [
    incomingRoot,
    finalRoot,
    path.dirname(incomingRoot),
    path.dirname(finalRoot),
  ].sort((first, second) => second.length - first.length);
  const result = await activateVerifiedRestoreRuntime({
    incomingRoot,
    finalRoot,
    expectedBackupId: argumentsByName.get("--backup-id")!,
    expectedAttestationSha256: argumentsByName.get("--attestation-sha256")!,
    expectedSourceManifestSha256: argumentsByName.get("--source-manifest-sha256")!,
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: "RESTORE_ACTIVATION_FAILED",
    error: sanitizeError(error, sensitivePaths),
  }, null, 2));
  process.exitCode = 1;
}
