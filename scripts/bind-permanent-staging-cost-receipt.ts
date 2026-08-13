import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERMANENT_STAGING_COST_POLICY_PATH,
  bindPermanentStagingCostReceipt,
  canonicalPermanentStagingCostJson,
} from "./lib/permanent-staging-cost-policy.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_ID_PATTERN = /^PP-LAUNCH-\d{4}-[A-Z0-9][A-Z0-9_-]{2,31}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const MAX_INPUT_BYTES = 1024 * 1024;
const ARGUMENTS = new Set([
  "--policy",
  "--expected-policy-sha256",
  "--pre-observation",
  "--expected-pre-observation-sha256",
  "--post-observation",
  "--expected-post-observation-sha256",
  "--private-manifest",
  "--expected-private-manifest-sha256",
  "--expected-release-id",
  "--expected-candidate-sha",
  "--output",
]);

interface TrustedInput {
  readonly source: string;
  readonly sha256: string;
}

class SafeCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SafeCliError";
  }
}

function exactAbsolutePath(value: string): string {
  if (
    !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
    || value.includes("\0")
  ) throw new SafeCliError("invalid_arguments");
  return value;
}

function expectedSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new SafeCliError("invalid_arguments");
  return value;
}

function readTrustedInput(
  filenameInput: string,
  expectedDigest: string,
  privateInput: boolean,
): TrustedInput {
  const filename = exactAbsolutePath(filenameInput);
  const expected = expectedSha256(expectedDigest);
  try {
    const bytes = readTrustedRegularFile(filename, {
      minBytes: 3,
      maxBytes: MAX_INPUT_BYTES,
      requireOwner: true,
      requirePrivate: privateInput,
    });
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expected) throw new SafeCliError("input_digest_mismatch");
    return Object.freeze({ source: bytes.toString("utf8"), sha256 });
  } catch (error) {
    if (error instanceof SafeCliError) throw error;
    throw new SafeCliError("unsafe_input_file");
  }
}

function writeReceipt(filenameInput: string, receipt: unknown): string {
  const filename = exactAbsolutePath(filenameInput);
  const parent = path.dirname(filename);
  const bytes = Buffer.from(canonicalPermanentStagingCostJson(receipt), "utf8");
  try {
    writePrivateExclusiveFile(parent, path.basename(filename), bytes, {
      requireExactDirectoryMode: true,
      requireOwner: true,
    });
  } catch {
    throw new SafeCliError("unsafe_output_file");
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function runPermanentStagingCostReceiptBinder(
  argv: readonly string[],
  now = new Date(),
): 0 | 1 {
  try {
    const args = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: ARGUMENTS,
    });
    const expectedReleaseId = args.get("--expected-release-id")!;
    const expectedCandidateSha = args.get("--expected-candidate-sha")!;
    if (
      !RELEASE_ID_PATTERN.test(expectedReleaseId)
      || !COMMIT_SHA_PATTERN.test(expectedCandidateSha)
    ) throw new SafeCliError("invalid_arguments");
    const policyPath = exactAbsolutePath(args.get("--policy")!);
    if (policyPath !== path.resolve(PERMANENT_STAGING_COST_POLICY_PATH)) {
      throw new SafeCliError("policy_path_mismatch");
    }
    const policy = readTrustedInput(
      policyPath,
      args.get("--expected-policy-sha256")!,
      false,
    );
    const pre = readTrustedInput(
      args.get("--pre-observation")!,
      args.get("--expected-pre-observation-sha256")!,
      true,
    );
    const post = readTrustedInput(
      args.get("--post-observation")!,
      args.get("--expected-post-observation-sha256")!,
      true,
    );
    const manifest = readTrustedInput(
      args.get("--private-manifest")!,
      args.get("--expected-private-manifest-sha256")!,
      true,
    );
    const result = bindPermanentStagingCostReceipt({
      policySource: policy.source,
      policySha256: policy.sha256,
      preObservationSource: pre.source,
      preObservationSha256: pre.sha256,
      postObservationSource: post.source,
      postObservationSha256: post.sha256,
      privateManifestSource: manifest.source,
      privateManifestSha256: manifest.sha256,
      now: now.toISOString(),
    });
    if (!result.passed || !result.receipt) {
      process.stdout.write(canonicalPermanentStagingCostJson({
        schemaVersion: 1,
        ok: false,
        failureCodes: result.errors,
      }));
      return 1;
    }
    if (
      result.receipt.releaseId !== expectedReleaseId
      || result.receipt.candidateSha !== expectedCandidateSha
    ) throw new SafeCliError("expected_release_binding_mismatch");
    const receiptSha256 = writeReceipt(args.get("--output")!, result.receipt);
    process.stdout.write(canonicalPermanentStagingCostJson({
      schemaVersion: 1,
      ok: true,
      candidateSha: result.receipt.candidateSha,
      releaseId: result.receipt.releaseId,
      totalUpperBoundMonthlyCents: result.receipt.totalUpperBoundMonthlyCents,
      observedHeadroomMonthlyCents: result.receipt.observedHeadroomMonthlyCents,
      receiptSha256,
    }));
    return 0;
  } catch (error) {
    process.stdout.write(canonicalPermanentStagingCostJson({
      schemaVersion: 1,
      ok: false,
      failureCodes: [error instanceof SafeCliError ? error.code : "unexpected_failure"],
    }));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runPermanentStagingCostReceiptBinder(process.argv.slice(2));
}
