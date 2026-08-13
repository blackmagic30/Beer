function argumentValue(name: string): string | null {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim() || null;
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

async function main(): Promise<void> {
  const backup = argumentValue("--backup");
  const restore = argumentValue("--restore");
  if (!backup || !restore) {
    throw new Error("Pass both --backup=/verified/backup and --restore=/completed/rehearsal.");
  }
  // A disposable restore-staging project has not yet been registered in a
  // repository-owned, candidate-bound authority. The permanent integration
  // staging project is not an acceptable destination for restored production
  // evidence. Keep this command blocked before reading a credential or any
  // backup/restore file until that independent authority exists.
  throw new Error(
    "Restore-staging evidence transport is unavailable until a reviewed disposable-project authority is registered.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
});
