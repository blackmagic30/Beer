import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const betterSqlite3Probe = `
  import Database from "better-sqlite3";

  const database = new Database(":memory:");
  try {
    database.prepare("SELECT 1").get();
  } finally {
    database.close();
  }
`;

const rebuildableNativeFailurePatterns = [
  /compiled against a different Node\.js version/i,
  /\bNODE_MODULE_VERSION \d+\b/i,
  /module did not self-register/i,
  /could not locate the bindings file/i,
  /no native build was found\b.*\b(?:abi|runtime)=/is,
  /\binvalid ELF header\b/i,
  /\bwrong ELF class\b/i,
  /\b(?:incompatible|wrong) architecture\b/i,
  /\bnot a valid Win32 application\b/i,
];

export function isRebuildableBetterSqlite3Failure(diagnostic) {
  return (
    typeof diagnostic === "string" &&
    rebuildableNativeFailurePatterns.some((pattern) => pattern.test(diagnostic))
  );
}

function probeDiagnostic(result) {
  return [result.error?.message, result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
}

function probeBetterSqlite3(cwd) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", betterSqlite3Probe],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

function rebuildBetterSqlite3(cwd) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmExecPath
    ? [npmExecPath, "rebuild", "better-sqlite3"]
    : ["rebuild", "better-sqlite3"];

  return spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
}

export function ensureNativeDependencies(cwd = projectRoot) {
  const initialProbe = probeBetterSqlite3(cwd);
  if (initialProbe.status === 0) {
    console.log("[native-dependencies] better-sqlite3 is ready.");
    return;
  }

  const initialDiagnostic = probeDiagnostic(initialProbe);
  if (!isRebuildableBetterSqlite3Failure(initialDiagnostic)) {
    throw new Error(
      [
        "better-sqlite3 failed its startup probe for a reason that is not safe to repair automatically.",
        initialDiagnostic || `Probe exited with status ${String(initialProbe.status)}.`,
      ].join("\n"),
    );
  }

  console.warn(
    `[native-dependencies] better-sqlite3 is incompatible with ${process.version} ` +
      `(ABI ${process.versions.modules}); rebuilding it once.`,
  );

  const rebuild = rebuildBetterSqlite3(cwd);
  if (rebuild.error || rebuild.status !== 0) {
    throw new Error(
      `npm rebuild better-sqlite3 failed${
        rebuild.error?.message ? `: ${rebuild.error.message}` : ` with status ${String(rebuild.status)}`
      }.`,
    );
  }

  const verificationProbe = probeBetterSqlite3(cwd);
  if (verificationProbe.status !== 0) {
    const verificationDiagnostic = probeDiagnostic(verificationProbe);
    throw new Error(
      [
        "better-sqlite3 still failed its startup probe after npm rebuild.",
        verificationDiagnostic || `Probe exited with status ${String(verificationProbe.status)}.`,
      ].join("\n"),
    );
  }

  console.log("[native-dependencies] better-sqlite3 was rebuilt and verified.");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    ensureNativeDependencies();
  } catch (error) {
    console.error(
      `[native-dependencies] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
