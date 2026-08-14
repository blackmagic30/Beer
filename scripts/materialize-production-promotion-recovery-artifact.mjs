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

function readAuthority(filename, candidateSha, stage) {
  const contract = STAGE_CONTRACTS[stage];
  const stat = fs.lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size <= 1 ||
    stat.size > MAX_RECEIPT_BYTES ||
    fs.realpathSync(filename) !== filename
  )
    throw new Error("authority_invalid");
  const source = fs.readFileSync(filename, "utf8");
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
  )
    throw new Error("authority_invalid");
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

function defaultExtractEntry(archive, parent, receiptEntry) {
  const archivePath = path.join(parent, ".production-rollout-artifact.zip");
  fs.writeFileSync(archivePath, archive, { flag: "wx", mode: 0o600 });
  try {
    const listed = spawnSync("/usr/bin/unzip", ["-Z1", archivePath], {
      encoding: "utf8",
      maxBuffer: MAX_RECEIPT_BYTES,
      shell: false,
    });
    if (listed.status !== 0 || listed.signal !== null || listed.error) {
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
    const extracted = spawnSync(
      "/usr/bin/unzip",
      ["-p", archivePath, receiptEntry],
      {
        encoding: null,
        maxBuffer: MAX_RECEIPT_BYTES,
        shell: false,
      },
    );
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
    return extracted.stdout;
  } finally {
    try {
      fs.unlinkSync(archivePath);
    } catch {
      /* private temporary file may be absent */
    }
  }
}

function writeExclusive(filename, source) {
  const parent = path.dirname(filename);
  const stat = fs.lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(parent) !== path.resolve(parent) ||
    (typeof process.geteuid === "function" && stat.uid !== process.geteuid())
  ) {
    throw new Error("output_unsafe");
  }
  fs.writeFileSync(filename, source, { flag: "wx", mode: 0o600 });
  const fd = fs.openSync(filename, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const parentFd = fs.openSync(parent, "r");
  try {
    fs.fsyncSync(parentFd);
  } finally {
    fs.closeSync(parentFd);
  }
}

export async function runProductionPromotionRecoveryArtifactMaterializer(
  argv,
  dependencies = {},
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const env = dependencies.env ?? process.env;
  const extractEntry = dependencies.extractEntry ?? defaultExtractEntry;
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
    const source = extractEntry(
      archive,
      path.dirname(args.output),
      contract.receiptEntry,
    );
    writeExclusive(args.output, source);
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
