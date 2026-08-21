import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const ARCHIVE_LEAF = ".production-rollout-artifact.zip";
const RELEASE_POLICY_SHA256 =
  "b47f562d94b462ed7d2b1d9df317ac239a607d517bb487c109585e09213ba4fd";
const STAGE_CONTRACTS = Object.freeze({
  deploy: Object.freeze({
    phases: Object.freeze(["close", "activation", "promotion-recovery"]),
    chainStage: "deploy",
    namePrefix: "pintpath-production-deployment-",
    producerCheck: "Deploy protected production",
    receiptEntry:
      "pintpath-production-deployment-evidence/deployment-receipt.json",
  }),
  scale: Object.freeze({
    phases: Object.freeze(["close", "activation", "promotion-recovery"]),
    chainStage: "scale",
    namePrefix: "pintpath-production-scale-evidence-",
    producerCheck: "Converge exact production deployment to two replicas",
    receiptEntry: "converge-production-two-receipt.json",
  }),
  close: Object.freeze({
    phases: Object.freeze(["activation", "promotion-recovery", "open"]),
    chainStage: "close",
    namePrefix: "pintpath-production-route-close-",
    producerCheck: "Close exact production route",
    receiptEntry: "receipt.json",
  }),
  "close-terminal": Object.freeze({
    phases: Object.freeze(["promotion-recovery"]),
    chainStage: "close",
    namePrefix: "pintpath-production-route-close-",
    producerCheck: "Close exact production route",
    receiptEntry: "terminal.json",
  }),
  activation: Object.freeze({
    phases: Object.freeze(["promotion-recovery"]),
    chainStage: "activation",
    namePrefix: "pintpath-production-promotion-recovery-activation-",
    producerCheck: "Activate exact production promotion recovery",
    receiptEntry: "activation-receipt.json",
  }),
  "promotion-recovery": Object.freeze({
    phases: Object.freeze(["open"]),
    chainStage: "promotion-recovery",
    namePrefix: "pintpath-production-promotion-recovery-",
    producerCheck: "Attest protected production promotion and recovery",
    receiptEntry: "production-promotion-recovery-receipt.json",
  }),
});

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key, index) => Object.keys(value)[index] === key)
  );
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function reviewedPullRequestExact(value, candidateSha) {
  return exact(value, [
    "number",
    "reviewedPrHeadSha",
    "mergeCommitSha",
    "treeSha",
    "mergedAt",
    "authorId",
    "mergedById",
    "githubMergeExact",
    "reviewedTreeExact",
    "pullRequestApprovalRequirement",
    "pullRequestApprovalRequirementExact",
    "linearHistoryExact",
  ]) && positiveInteger(value.number)
    && SHA.test(value.reviewedPrHeadSha)
    && value.mergeCommitSha === candidateSha
    && SHA.test(value.treeSha)
    && typeof value.mergedAt === "string"
    && ISO_TIMESTAMP.test(value.mergedAt)
    && Number.isFinite(Date.parse(value.mergedAt))
    && positiveInteger(value.authorId)
    && positiveInteger(value.mergedById)
    && value.githubMergeExact === true
    && value.reviewedTreeExact === true
    && value.pullRequestApprovalRequirement === "not_required"
    && value.pullRequestApprovalRequirementExact === true
    && value.linearHistoryExact === true;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 8)
    throw new Error("argument_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !["--authority", "--candidate-sha", "--stage", "--output"].includes(
        key,
      ) ||
      values.has(key) ||
      typeof value !== "string" ||
      value.length === 0
    ) {
      throw new Error("argument_invalid");
    }
    values.set(key, value);
  }
  const authority = values.get("--authority");
  const candidateSha = values.get("--candidate-sha");
  const stage = values.get("--stage");
  const output = values.get("--output");
  if (
    !path.isAbsolute(authority) ||
    !SHA.test(candidateSha) ||
    !Object.hasOwn(STAGE_CONTRACTS, stage) ||
    !path.isAbsolute(output)
  ) {
    throw new Error("argument_invalid");
  }
  return { authority, candidateSha, stage, output };
}

function requiredFilesystemFlag(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("filesystem_capability_unavailable");
  }
  return value;
}

function currentUid() {
  const uid = process.geteuid?.() ?? process.getuid?.();
  return Number.isSafeInteger(uid) && uid >= 0 ? BigInt(uid) : null;
}

function exactAbsolutePath(filename) {
  return path.isAbsolute(filename) && path.normalize(filename) === filename &&
    path.resolve(filename) === filename && !filename.includes("\0");
}

function sameFilesystemNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.mode === right.mode && left.uid === right.uid &&
    left.gid === right.gid;
}

function sameFileSnapshot(left, right) {
  return sameFilesystemNode(left, right) && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function pathnameMatchesDescriptor(filename, descriptorStat, directory) {
  const before = fs.lstatSync(filename, { bigint: true });
  if (before.isSymbolicLink() || directory !== before.isDirectory() ||
    !sameFilesystemNode(before, descriptorStat) ||
    (!directory && !sameFileSnapshot(before, descriptorStat)) ||
    fs.realpathSync(filename) !== filename) return false;
  const after = fs.lstatSync(filename, { bigint: true });
  return !after.isSymbolicLink() && directory === after.isDirectory() &&
    sameFilesystemNode(before, after) &&
    sameFilesystemNode(after, descriptorStat) &&
    (directory || sameFileSnapshot(before, after) &&
      sameFileSnapshot(after, descriptorStat));
}

function consumeHeldAuthoritySource(filename, consume) {
  let descriptor = null;
  let bytes = null;
  let result = null;
  let exactRead = false;
  try {
    if (!exactAbsolutePath(filename) || typeof consume !== "function") {
      throw new Error("authority_invalid");
    }
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY |
        requiredFilesystemFlag(fs.constants.O_NOFOLLOW) |
        requiredFilesystemFlag(fs.constants.O_NONBLOCK),
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const uid = currentUid();
    if (!before.isFile() || before.nlink !== 1n || before.size <= 1n ||
      before.size > BigInt(MAX_RECEIPT_BYTES) || uid === null ||
      before.uid !== uid || (before.mode & 0o777n) !== 0o600n ||
      !pathnameMatchesDescriptor(filename, before, false)) {
      throw new Error("authority_invalid");
    }
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error("authority_invalid");
      }
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after) ||
      !pathnameMatchesDescriptor(filename, after, false)) {
      throw new Error("authority_invalid");
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    result = consume(source);
    const final = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(after, final) ||
      !pathnameMatchesDescriptor(filename, final, false)) {
      throw new Error("authority_invalid");
    }
    exactRead = true;
  } catch {
    exactRead = false;
  } finally {
    bytes?.fill(0);
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        exactRead = false;
      }
    }
  }
  if (!exactRead || result === null) throw new Error("authority_invalid");
  return result;
}

function readAuthority(filename, candidateSha, stage) {
  const contract = STAGE_CONTRACTS[stage];
  return consumeHeldAuthoritySource(filename, (source) => {
    const value = JSON.parse(source);
    if (
      canonical(value) !== source ||
      !exact(value, [
        "schemaVersion",
        "repository",
        "branch",
        "phase",
        "candidateSha",
        "reviewedPullRequest",
        "policySha256",
        "consumer",
        "checks",
        "artifacts",
        "productionChain",
        "orderedProductionChainSha256",
        "requiredChecksExact",
        "requiredArtifactsExact",
        "chronologyExact",
        "currentConsumerExact",
      ]) ||
      value.schemaVersion !== "pintpath-github-release-candidate-receipt/v5" ||
      value.repository !== "blackmagic30/Beer" ||
      value.branch !== "main" ||
      !contract.phases.includes(value.phase) ||
      value.candidateSha !== candidateSha ||
      !reviewedPullRequestExact(value.reviewedPullRequest, candidateSha) ||
      value.policySha256 !== RELEASE_POLICY_SHA256 ||
      value.requiredChecksExact !== true ||
      value.requiredArtifactsExact !== true ||
      value.chronologyExact !== true ||
      value.currentConsumerExact !== true ||
      !Array.isArray(value.productionChain)
    ) {
      throw new Error("authority_invalid");
    }
    const matches = value.productionChain.filter(
      (item) => item?.stage === contract.chainStage,
    );
    if (matches.length !== 1) throw new Error("authority_invalid");
    const artifact = matches[0]?.artifact;
    if (
      !exact(artifact, [
        "stage",
        "artifactId",
        "name",
        "digest",
        "sizeBytes",
        "runId",
        "producerCheck",
      ]) ||
      artifact.stage !== contract.chainStage ||
      !Number.isSafeInteger(artifact.artifactId) ||
      artifact.artifactId <= 0 ||
      artifact.name !== `${contract.namePrefix}${candidateSha}` ||
      typeof artifact.digest !== "string" ||
      !DIGEST.test(artifact.digest) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0 ||
      artifact.sizeBytes > MAX_ARTIFACT_BYTES ||
      !Number.isSafeInteger(artifact.runId) ||
      artifact.runId <= 0 ||
      artifact.producerCheck !== contract.producerCheck
    ) {
      throw new Error("authority_invalid");
    }
    return { artifact, contract };
  });
}

async function boundedBytes(response, expectedBytes) {
  if (!response.ok || !response.body) throw new Error("github_download_failed");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > expectedBytes || total > MAX_ARTIFACT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("github_download_failed");
    }
    chunks.push(next.value);
  }
  if (total !== expectedBytes) throw new Error("github_download_failed");
  return Buffer.concat(chunks);
}

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error("github_metadata_failed");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RECEIPT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("github_metadata_failed");
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new Error("github_metadata_failed");
  }
}

async function github(fetchImpl, token, endpoint, accept) {
  return fetchImpl(
    `https://api.github.com/repos/blackmagic30/Beer${endpoint}`,
    {
      method: "GET",
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "User-Agent": "pintpath-production-artifact-materializer/1",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    },
  );
}

function descriptorChildPath(parentDescriptor, parent, leaf) {
  // Every workflow that calls this materializer is Linux-bound. The fallback
  // preserves local contract-test coverage; protected consumers always use
  // the descriptor-relative Linux path.
  return process.platform === "linux"
    ? path.posix.join(
      "/proc/self/fd",
      String(parentDescriptor),
      leaf,
    )
    : path.join(parent, leaf);
}

function holdOutputParent(filename) {
  let descriptor = null;
  let held = null;
  try {
    const parent = path.dirname(filename);
    const leaf = path.basename(filename);
    const uid = currentUid();
    if (!exactAbsolutePath(filename) || !exactAbsolutePath(parent) ||
      path.basename(leaf) !== leaf || leaf === "." || leaf === ".." ||
      leaf === ARCHIVE_LEAF || uid === null) {
      throw new Error("output_unsafe");
    }
    descriptor = fs.openSync(
      parent,
      fs.constants.O_RDONLY |
        requiredFilesystemFlag(fs.constants.O_DIRECTORY) |
        requiredFilesystemFlag(fs.constants.O_NOFOLLOW),
    );
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory() || identity.nlink < 1n ||
      identity.uid !== uid || (identity.mode & 0o777n) !== 0o700n ||
      !pathnameMatchesDescriptor(parent, identity, true)) {
      throw new Error("output_unsafe");
    }
    if (process.platform === "linux") {
      const alias = fs.statSync(`/proc/self/fd/${descriptor}`, {
        bigint: true,
      });
      if (!sameFilesystemNode(alias, identity)) {
        throw new Error("output_unsafe");
      }
    }
    held = { descriptor, filename, identity, leaf, parent, uid };
    descriptor = null;
  } catch {
    held = null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        held = null;
      }
    }
  }
  if (held === null) throw new Error("output_unsafe");
  return held;
}

function assertHeldOutputParent(held) {
  try {
    const current = fs.fstatSync(held.descriptor, { bigint: true });
    if (!current.isDirectory() || current.nlink < 1n ||
      current.uid !== held.uid || (current.mode & 0o777n) !== 0o700n ||
      !sameFilesystemNode(current, held.identity) ||
      !pathnameMatchesDescriptor(held.parent, current, true)) {
      throw new Error("output_unsafe");
    }
    return current;
  } catch {
    throw new Error("output_unsafe");
  }
}

function closeHeldOutputParent(held) {
  try {
    fs.closeSync(held.descriptor);
  } catch {
    throw new Error("output_unsafe");
  }
}

function sha256HeldDescriptor(descriptor, size) {
  const chunk = Buffer.alloc(Math.min(64 * 1024, size));
  const hash = crypto.createHash("sha256");
  let offset = 0;
  try {
    while (offset < size) {
      const length = Math.min(chunk.length, size - offset);
      const count = fs.readSync(descriptor, chunk, 0, length, offset);
      if (!Number.isSafeInteger(count) || count !== length) {
        throw new Error("artifact_archive_invalid");
      }
      hash.update(chunk.subarray(0, count));
      offset += count;
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    chunk.fill(0);
  }
}

function assertHeldArchiveExact(custody) {
  try {
    const parentBefore = assertHeldOutputParent(custody.parentAuthority);
    const before = fs.fstatSync(custody.descriptor, { bigint: true });
    if (custody.identity === null || !before.isFile() || before.nlink !== 1n ||
      before.uid !== custody.parentAuthority.uid ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size !== BigInt(custody.size) ||
      !sameFileSnapshot(before, custody.identity) ||
      !pathnameMatchesDescriptor(custody.path, before, false) ||
      sha256HeldDescriptor(custody.descriptor, custody.size) !==
        custody.digest) {
      throw new Error("artifact_archive_invalid");
    }
    const after = fs.fstatSync(custody.descriptor, { bigint: true });
    const parentAfter = assertHeldOutputParent(custody.parentAuthority);
    if (!sameFileSnapshot(before, after) ||
      !sameFilesystemNode(parentBefore, parentAfter) ||
      !pathnameMatchesDescriptor(custody.path, after, false)) {
      throw new Error("artifact_archive_invalid");
    }
  } catch {
    throw new Error("artifact_archive_invalid");
  }
}

function pathnameAbsent(filename) {
  try {
    fs.lstatSync(filename);
    return false;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function unlinkHeldArchiveExact(custody) {
  const before = fs.fstatSync(custody.descriptor, { bigint: true });
  const parentBefore = assertHeldOutputParent(custody.parentAuthority);
  if (!before.isFile() || before.nlink !== 1n ||
    before.uid !== custody.parentAuthority.uid ||
    (before.mode & 0o777n) !== 0o600n ||
    !sameFilesystemNode(before, custody.node) ||
    !pathnameMatchesDescriptor(custody.path, before, false)) {
    throw new Error("artifact_archive_invalid");
  }
  fs.unlinkSync(custody.target);
  const after = fs.fstatSync(custody.descriptor, { bigint: true });
  const parentAfter = assertHeldOutputParent(custody.parentAuthority);
  if (!sameFilesystemNode(before, after) || after.nlink !== 0n ||
    !sameFilesystemNode(parentBefore, parentAfter) ||
    !pathnameAbsent(custody.path)) {
    throw new Error("artifact_archive_invalid");
  }
  fs.fsyncSync(custody.parentAuthority.descriptor);
  const final = fs.fstatSync(custody.descriptor, { bigint: true });
  const parentFinal = assertHeldOutputParent(custody.parentAuthority);
  if (!sameFilesystemNode(after, final) || final.nlink !== 0n ||
    !sameFilesystemNode(parentAfter, parentFinal) ||
    !pathnameAbsent(custody.path)) {
    throw new Error("artifact_archive_invalid");
  }
  custody.removed = true;
}

function childArchiveAuthority() {
  return process.platform === "linux" ? "/proc/self/fd/3" : "/dev/fd/3";
}

function defaultExtractEntry(
  archive,
  parentAuthority,
  receiptEntry,
  expectedDigest,
  spawnImpl,
) {
  let custody = null;
  let extractedSource = null;
  let exact = false;
  try {
    if (!Buffer.isBuffer(archive) || archive.length <= 1 ||
      archive.length > MAX_ARTIFACT_BYTES || !DIGEST.test(expectedDigest) ||
      typeof spawnImpl !== "function" ||
      `sha256:${crypto.createHash("sha256").update(archive).digest("hex")}` !==
        expectedDigest) {
      throw new Error("artifact_archive_invalid");
    }
    assertHeldOutputParent(parentAuthority);
    const archivePath = path.join(parentAuthority.parent, ARCHIVE_LEAF);
    const target = descriptorChildPath(
      parentAuthority.descriptor,
      parentAuthority.parent,
      ARCHIVE_LEAF,
    );
    const archiveDescriptor = fs.openSync(
      target,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL |
        requiredFilesystemFlag(fs.constants.O_NOFOLLOW),
      0o600,
    );
    const created = fs.fstatSync(archiveDescriptor, { bigint: true });
    custody = {
      descriptor: archiveDescriptor,
      digest: expectedDigest,
      identity: null,
      node: created,
      parentAuthority,
      path: archivePath,
      removed: false,
      size: archive.length,
      target,
    };
    if (!created.isFile() || created.nlink !== 1n || created.size !== 0n ||
      created.uid !== parentAuthority.uid ||
      (created.mode & 0o777n) !== 0o600n ||
      !pathnameMatchesDescriptor(archivePath, created, false)) {
      throw new Error("artifact_archive_invalid");
    }
    assertHeldOutputParent(parentAuthority);
    let offset = 0;
    while (offset < archive.length) {
      const count = fs.writeSync(
        archiveDescriptor,
        archive,
        offset,
        archive.length - offset,
        offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error("artifact_archive_invalid");
      }
      offset += count;
    }
    fs.fsyncSync(archiveDescriptor);
    const completed = fs.fstatSync(archiveDescriptor, { bigint: true });
    if (!sameFilesystemNode(created, completed) || completed.nlink !== 1n ||
      completed.size !== BigInt(archive.length) ||
      !pathnameMatchesDescriptor(archivePath, completed, false)) {
      throw new Error("artifact_archive_invalid");
    }
    custody.identity = completed;
    assertHeldArchiveExact(custody);
    const childAuthority = childArchiveAuthority();
    const childStdio = ["ignore", "pipe", "pipe", archiveDescriptor];
    const listed = spawnImpl(
      "/usr/bin/unzip",
      ["-Z1", childAuthority],
      {
        encoding: "utf8",
        maxBuffer: MAX_RECEIPT_BYTES,
        shell: false,
        stdio: childStdio,
      },
    );
    assertHeldArchiveExact(custody);
    if (listed.status !== 0 || listed.signal !== null || listed.error ||
      typeof listed.stdout !== "string") {
      throw new Error("artifact_archive_invalid");
    }
    const entries = listed.stdout.trimEnd().split("\n");
    if (
      entries.length < 1 ||
      entries.length > 64 ||
      new Set(entries).size !== entries.length ||
      entries.filter((entry) => entry === receiptEntry).length !== 1 ||
      entries.some((entry) => {
        const candidate = entry.endsWith("/") ? entry.slice(0, -1) : entry;
        return (
          candidate.length < 1 ||
          candidate.length > 512 ||
          candidate.startsWith("/") ||
          candidate.includes("\\") ||
          /[\r\n\0]/.test(candidate) ||
          candidate.split("/").some((part) => part === ".." || part === "")
        );
      })
    ) {
      throw new Error("artifact_archive_invalid");
    }
    assertHeldArchiveExact(custody);
    const extracted = spawnImpl(
      "/usr/bin/unzip",
      ["-p", childAuthority, receiptEntry],
      {
        encoding: null,
        maxBuffer: MAX_RECEIPT_BYTES,
        shell: false,
        stdio: childStdio,
      },
    );
    assertHeldArchiveExact(custody);
    if (
      extracted.status !== 0 ||
      extracted.signal !== null ||
      extracted.error ||
      !Buffer.isBuffer(extracted.stdout) ||
      extracted.stdout.length <= 1 ||
      extracted.stdout.length > MAX_RECEIPT_BYTES
    ) {
      throw new Error("artifact_archive_invalid");
    }
    extractedSource = extracted.stdout;
    unlinkHeldArchiveExact(custody);
    exact = true;
  } catch {
    exact = false;
  } finally {
    if (custody !== null) {
      if (!custody.removed) {
        try {
          unlinkHeldArchiveExact(custody);
        } catch {
          exact = false;
        }
      }
      try {
        fs.closeSync(custody.descriptor);
      } catch {
        exact = false;
      }
    }
  }
  if (!exact || extractedSource === null) {
    throw new Error("artifact_archive_invalid");
  }
  return extractedSource;
}

function writeExclusive(parentAuthority, source) {
  const { descriptor: parentDescriptor, filename, identity: parentBefore,
    leaf, parent, uid } = parentAuthority;
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8");
  let outputDescriptor = null;
  let exactWrite = false;
  try {
    assertHeldOutputParent(parentAuthority);
    const target = descriptorChildPath(parentDescriptor, parent, leaf);
    outputDescriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        requiredFilesystemFlag(fs.constants.O_NOFOLLOW),
      0o600,
    );
    const created = fs.fstatSync(outputDescriptor, { bigint: true });
    const parentPrewrite = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!created.isFile() || created.nlink !== 1n || created.uid !== uid ||
      created.size !== 0n || (created.mode & 0o777n) !== 0o600n ||
      !sameFilesystemNode(parentBefore, parentPrewrite) ||
      !sameFilesystemNode(parentPrewrite, assertHeldOutputParent(
        parentAuthority,
      )) ||
      !pathnameMatchesDescriptor(parent, parentPrewrite, true)) {
      throw new Error("output_unsafe");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(
        outputDescriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error("output_unsafe");
      }
      offset += count;
    }
    fs.fsyncSync(outputDescriptor);
    const completed = fs.fstatSync(outputDescriptor, { bigint: true });
    const parentAfter = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!sameFilesystemNode(created, completed) || completed.nlink !== 1n ||
      completed.uid !== uid || completed.size !== BigInt(bytes.length) ||
      (completed.mode & 0o777n) !== 0o600n ||
      !sameFilesystemNode(parentBefore, parentAfter) ||
      !sameFilesystemNode(parentAfter, assertHeldOutputParent(
        parentAuthority,
      )) ||
      !pathnameMatchesDescriptor(parent, parentAfter, true) ||
      !pathnameMatchesDescriptor(filename, completed, false)) {
      throw new Error("output_unsafe");
    }
    fs.fsyncSync(parentDescriptor);
    const outputFinal = fs.fstatSync(outputDescriptor, { bigint: true });
    const parentFinal = fs.fstatSync(parentDescriptor, { bigint: true });
    exactWrite = sameFileSnapshot(completed, outputFinal) &&
      sameFilesystemNode(parentBefore, parentFinal) &&
      sameFilesystemNode(parentFinal, assertHeldOutputParent(
        parentAuthority,
      )) &&
      pathnameMatchesDescriptor(parent, parentFinal, true) &&
      pathnameMatchesDescriptor(filename, outputFinal, false);
  } catch {
    exactWrite = false;
  } finally {
    if (outputDescriptor !== null) {
      try {
        fs.closeSync(outputDescriptor);
      } catch {
        exactWrite = false;
      }
    }
  }
  if (!exactWrite) throw new Error("output_unsafe");
}

export async function runProductionPromotionRecoveryArtifactMaterializer(
  argv,
  dependencies = {},
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const env = dependencies.env ?? process.env;
  const extractEntry = dependencies.extractEntry;
  const spawnImpl = dependencies.spawnSyncImpl ?? spawnSync;
  const writeOutput =
    dependencies.writeOutput ?? ((value) => process.stdout.write(value));
  try {
    const args = parseArguments(argv);
    if (
      env.GITHUB_ACTIONS !== "true" ||
      env.GITHUB_REPOSITORY !== "blackmagic30/Beer" ||
      env.GITHUB_SHA !== args.candidateSha ||
      env.GITHUB_RUN_ATTEMPT !== "1" ||
      typeof env.GITHUB_TOKEN !== "string" ||
      env.GITHUB_TOKEN.length < 16 ||
      /[\r\n\0]/.test(env.GITHUB_TOKEN)
    )
      throw new Error("github_context_invalid");
    const { artifact, contract } = readAuthority(
      args.authority,
      args.candidateSha,
      args.stage,
    );
    const metadataResponse = await github(
      fetchImpl,
      env.GITHUB_TOKEN,
      `/actions/artifacts/${artifact.artifactId}`,
      "application/vnd.github+json",
    );
    const metadata = await boundedJson(metadataResponse);
    if (
      metadata?.id !== artifact.artifactId ||
      metadata?.name !== artifact.name ||
      metadata?.digest !== artifact.digest ||
      metadata?.size_in_bytes !== artifact.sizeBytes ||
      metadata?.expired !== false ||
      metadata?.workflow_run?.id !== artifact.runId ||
      metadata?.workflow_run?.head_sha !== args.candidateSha ||
      metadata?.archive_download_url !==
        `https://api.github.com/repos/blackmagic30/Beer/actions/artifacts/${artifact.artifactId}/zip`
    ) {
      throw new Error("github_metadata_failed");
    }
    const downloadResponse = await github(
      fetchImpl,
      env.GITHUB_TOKEN,
      `/actions/artifacts/${artifact.artifactId}/zip`,
      "application/octet-stream",
    );
    const archive = await boundedBytes(downloadResponse, artifact.sizeBytes);
    if (
      `sha256:${crypto.createHash("sha256").update(archive).digest("hex")}` !==
      artifact.digest
    )
      throw new Error("artifact_digest_mismatch");
    const parentAuthority = holdOutputParent(args.output);
    let source = null;
    let operationError = null;
    try {
      source = extractEntry === undefined
        ? defaultExtractEntry(
          archive,
          parentAuthority,
          contract.receiptEntry,
          artifact.digest,
          spawnImpl,
        )
        : extractEntry(
          archive,
          parentAuthority.parent,
          contract.receiptEntry,
        );
      assertHeldOutputParent(parentAuthority);
      writeExclusive(parentAuthority, source);
    } catch (error) {
      operationError = error;
    } finally {
      try {
        closeHeldOutputParent(parentAuthority);
      } catch (error) {
        operationError = error;
      }
    }
    if (operationError !== null || source === null) {
      throw operationError ?? new Error("artifact_archive_invalid");
    }
    writeOutput(
      `${JSON.stringify({
        artifactId: artifact.artifactId,
        stage: args.stage,
        command: "materialize-production-promotion-recovery-artifact",
        ok: true,
        receiptSha256: crypto.createHash("sha256").update(source).digest("hex"),
      })}\n`,
    );
    return 0;
  } catch (error) {
    writeOutput(
      `${JSON.stringify({
        command: "materialize-production-promotion-recovery-artifact",
        failureCode:
          error instanceof Error
            ? error.message.split(":", 1)[0]
            : "unexpected_failure",
        ok: false,
      })}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProductionPromotionRecoveryArtifactMaterializer(
    process.argv.slice(2),
  );
}
