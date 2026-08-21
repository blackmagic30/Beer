import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const VOLATILE_WORK_ROOT = "/run/pintpath-production-backup";
export const EPHEMERAL_RUNNER_POLICY_FILE =
  "/etc/pintpath/production-backup-ephemeral-runner.json";
const TMPFS_MAGIC = 0x01021994;
const REQUIRED_MOUNT_OPTIONS = Object.freeze(["nodev", "noexec", "nosuid", "rw"]);

function fail(code) {
  throw new Error(`production_backup_volatile_work_root_${code}`);
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
}

export function parseMountInfo(source) {
  if (typeof source !== "string") fail("mountinfo_invalid");
  return source
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const halves = line.split(" - ");
      if (halves.length !== 2) fail("mountinfo_invalid");
      const before = halves[0].split(" ");
      const after = halves[1].split(" ");
      if (before.length < 6 || after.length < 3) fail("mountinfo_invalid");
      return {
        root: decodeMountPath(before[3]),
        mountPoint: decodeMountPath(before[4]),
        options: new Set([...before[5].split(","), ...after[2].split(",")]),
        filesystemType: after[0],
        source: decodeMountPath(after[1]),
      };
    });
}

function assertCanonicalPrivateDirectory(target, expectedDevice) {
  const stat = fs.lstatSync(target, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("directory_type_invalid");
  if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o777n) !== 0o700n) {
    fail("directory_authority_invalid");
  }
  if (expectedDevice !== undefined && stat.dev !== expectedDevice) {
    fail("directory_cross_device");
  }
  if (fs.realpathSync(target) !== target) fail("directory_path_invalid");
  return stat;
}

function readPinnedPolicy(expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) fail("policy_sha256_invalid");
  const descriptor = fs.openSync(
    EPHEMERAL_RUNNER_POLICY_FILE,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const pathStat = fs.lstatSync(EPHEMERAL_RUNNER_POLICY_FILE, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== 0n ||
      (before.mode & 0o777n) !== 0o644n ||
      before.nlink !== 1n ||
      before.dev !== pathStat.dev ||
      before.ino !== pathStat.ino ||
      fs.realpathSync(EPHEMERAL_RUNNER_POLICY_FILE) !== EPHEMERAL_RUNNER_POLICY_FILE
    ) {
      fail("policy_file_authority_invalid");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      fail("policy_file_changed");
    }
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      fail("policy_sha256_mismatch");
    }
    let policy;
    try {
      policy = JSON.parse(bytes.toString("utf8"));
    } finally {
      bytes.fill(0);
    }
    const expected = {
      schemaVersion: 1,
      kind: "pintpath-production-backup-ephemeral-runner-policy",
      runnerMode: "jit-ephemeral-one-job",
      volatileWorkRoot: VOLATILE_WORK_ROOT,
      filesystemType: "tmpfs",
      requiredMountOptions: [...REQUIRED_MOUNT_OPTIONS],
      unencryptedSwapAllowed: false,
      concurrentSameUidWorkloadAllowed: false,
    };
    if (JSON.stringify(policy) !== JSON.stringify(expected)) fail("policy_contract_invalid");
    return policy;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function expectedWorkRoot(operation, runId, runAttempt) {
  if (!new Set(["backup", "restore", "recovery"]).has(operation)) fail("operation_invalid");
  if (!/^[1-9][0-9]{0,19}$/.test(runId) || !/^[1-9][0-9]{0,9}$/.test(runAttempt)) {
    fail("run_identity_invalid");
  }
  return path.join(
    VOLATILE_WORK_ROOT,
    `pintpath-production-${operation}-${runId}-${runAttempt}`,
  );
}

export function verifyVolatileRoot(expectedPolicySha256, { requireEmpty = false } = {}) {
  if (process.platform !== "linux" || typeof process.getuid !== "function") {
    fail("platform_invalid");
  }
  if (process.getuid() === 0) fail("root_runner_forbidden");
  readPinnedPolicy(expectedPolicySha256);
  const rootStat = assertCanonicalPrivateDirectory(VOLATILE_WORK_ROOT);
  const filesystem = fs.statfsSync(VOLATILE_WORK_ROOT, { bigint: true });
  if (Number(filesystem.type) !== TMPFS_MAGIC) fail("filesystem_not_tmpfs");
  const mounts = parseMountInfo(fs.readFileSync("/proc/self/mountinfo", "utf8"));
  const matching = mounts.filter((entry) => entry.mountPoint === VOLATILE_WORK_ROOT);
  if (
    matching.length !== 1 ||
    matching[0].root !== "/" ||
    matching[0].filesystemType !== "tmpfs" ||
    matching[0].source !== "tmpfs" ||
    !REQUIRED_MOUNT_OPTIONS.every((option) => matching[0].options.has(option))
  ) {
    fail("mount_contract_invalid");
  }
  const swaps = fs.readFileSync("/proc/swaps", "utf8").trimEnd().split("\n");
  if (swaps.length !== 1 || !/^Filename\s+Type\s+Size\s+Used\s+Priority$/.test(swaps[0])) {
    fail("unencrypted_swap_present");
  }
  if (requireEmpty && fs.readdirSync(VOLATILE_WORK_ROOT).length !== 0) {
    fail("concurrent_or_stale_work_present");
  }
  return rootStat.dev;
}

function sameEnvironmentFileIdentity(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink;
}

function validEnvironmentFile(stat, uid) {
  const permissions = stat.mode & 0o777n;
  return stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === uid &&
    stat.nlink === 1n &&
    (permissions === 0o600n || permissions === 0o640n || permissions === 0o644n);
}

export function appendEnvironment(filename, name, value) {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (
    typeof process.getuid !== "function" ||
    typeof noFollow !== "number" ||
    typeof nonBlock !== "number"
  ) {
    fail("github_environment_file_invalid");
  }
  const uid = BigInt(process.getuid());
  const source = Buffer.from(`${name}=${value}\n`, "utf8");
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow | nonBlock,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const beforePath = fs.lstatSync(filename, { bigint: true });
    if (
      !validEnvironmentFile(before, uid) ||
      !validEnvironmentFile(beforePath, uid) ||
      !sameEnvironmentFileIdentity(before, beforePath)
    ) {
      fail("github_environment_file_invalid");
    }

    let offset = 0;
    while (offset < source.length) {
      const written = fs.writeSync(descriptor, source, offset, source.length - offset);
      if (written < 1) fail("github_environment_file_invalid");
      offset += written;
    }
    fs.fsyncSync(descriptor);

    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(filename, { bigint: true });
    const expectedSize = before.size + BigInt(source.length);
    if (
      !validEnvironmentFile(after, uid) ||
      !validEnvironmentFile(afterPath, uid) ||
      !sameEnvironmentFileIdentity(before, after) ||
      !sameEnvironmentFileIdentity(before, afterPath) ||
      after.size !== expectedSize ||
      afterPath.size !== expectedSize
    ) {
      fail("github_environment_file_invalid");
    }
  } catch {
    fail("github_environment_file_invalid");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function prepareWorkRoot({ operation, runId, runAttempt, policySha256, githubEnv }) {
  const baseDevice = verifyVolatileRoot(policySha256, { requireEmpty: true });
  const target = expectedWorkRoot(operation, runId, runAttempt);
  if (fs.existsSync(target)) fail("work_root_already_exists");
  fs.mkdirSync(target, { mode: 0o700 });
  assertCanonicalPrivateDirectory(target, baseDevice);
  appendEnvironment(
    githubEnv,
    operation === "backup"
      ? "PINTPATH_BACKUP_WORK_ROOT"
      : operation === "restore"
        ? "PINTPATH_RESTORE_WORK_ROOT"
        : "PINTPATH_RECOVERY_WORK_ROOT",
    target,
  );
  return target;
}

function removeTree(target, expectedDevice, state, depth = 0) {
  if (depth > 64 || state.entries > 100_000) fail("cleanup_bounds_exceeded");
  const stat = fs.lstatSync(target, { bigint: true });
  if (stat.dev !== expectedDevice) fail("cleanup_cross_device");
  state.entries += 1;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const entry of fs.readdirSync(target)) {
      removeTree(path.join(target, entry), expectedDevice, state, depth + 1);
    }
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

export function cleanupWorkRoot({
  operation,
  runId,
  runAttempt,
  policySha256,
  exportedWorkRoot = "",
}) {
  const baseDevice = verifyVolatileRoot(policySha256);
  const target = expectedWorkRoot(operation, runId, runAttempt);
  const exportMismatch = exportedWorkRoot !== "" && exportedWorkRoot !== target;
  if (fs.existsSync(target)) {
    assertCanonicalPrivateDirectory(target, baseDevice);
    removeTree(target, baseDevice, { entries: 0 });
  }
  if (fs.existsSync(target)) fail("cleanup_incomplete");
  if (fs.readdirSync(VOLATILE_WORK_ROOT).length !== 0) {
    fail("stale_or_concurrent_work_after_cleanup");
  }
  if (exportMismatch) fail("exported_work_root_mismatch");
}

function parseArgs(argv) {
  const [command, ...raw] = argv;
  const args = { command };
  for (const value of raw) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(value);
    if (!match || Object.hasOwn(args, match[1])) fail("argument_invalid");
    args[match[1]] = match[2];
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.command === "verify") {
    verifyVolatileRoot(args["policy-sha256"], { requireEmpty: true });
    return;
  }
  if (args.command === "prepare") {
    const target = prepareWorkRoot({
      operation: args.operation,
      runId: args["run-id"],
      runAttempt: args["run-attempt"],
      policySha256: args["policy-sha256"],
      githubEnv: args["github-env"],
    });
    process.stdout.write(target);
    return;
  }
  if (args.command === "cleanup") {
    cleanupWorkRoot({
      operation: args.operation,
      runId: args["run-id"],
      runAttempt: args["run-attempt"],
      policySha256: args["policy-sha256"],
      exportedWorkRoot: args["exported-work-root"] ?? "",
    });
    return;
  }
  fail("command_invalid");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "volatile_work_root_error"}\n`);
    process.exitCode = 1;
  }
}
