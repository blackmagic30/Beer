import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  parseProductionPromotionRecoveryReceipt,
  type ProductionPromotionRecoveryReceipt,
} from "../src/lib/production-promotion-recovery.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const ARGUMENTS = new Set([
  "--receipt", "--expected-sha256", "--candidate-sha",
  "--expected-close-receipt-sha256", "--expected-close-terminal-sha256",
  "--expected-deployment-id-sha256",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE = /^[a-f0-9]{40}$/;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;

export interface ProductionPromotionRecoveryReceiptExpectation {
  readonly expectedFileSha256: string;
  readonly candidateSha: string;
  readonly expectedCloseReceiptSha256: string;
  readonly expectedCloseTerminalSha256: string;
  readonly expectedDeploymentIdSha256: string;
}

export function verifyProductionPromotionRecoveryReceiptBytes(
  bytes: Buffer,
  expectation: ProductionPromotionRecoveryReceiptExpectation,
): ProductionPromotionRecoveryReceipt {
  if (
    !SHA256.test(expectation.expectedFileSha256)
    || !CANDIDATE.test(expectation.candidateSha)
    || !SHA256.test(expectation.expectedCloseReceiptSha256)
    || !SHA256.test(expectation.expectedCloseTerminalSha256)
    || !SHA256.test(expectation.expectedDeploymentIdSha256)
    || bytes.length < 1 || bytes.length > MAX_RECEIPT_BYTES
    || crypto.createHash("sha256").update(bytes).digest("hex")
      !== expectation.expectedFileSha256
  ) throw new Error("production_promotion_recovery_receipt_invalid");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("production_promotion_recovery_receipt_invalid");
  }
  const receipt = parseProductionPromotionRecoveryReceipt(value);
  if (
    canonicalPostgresBackupJson(receipt) !== bytes.toString("utf8")
    || receipt.outcome !== "verified"
    || receipt.candidateSha !== expectation.candidateSha
    || receipt.productionDeploymentIdSha256 !== expectation.expectedDeploymentIdSha256
    || receipt.closedRouteReceiptSha256 !== expectation.expectedCloseReceiptSha256
    || receipt.closedRouteTerminalEvidenceSha256 !== expectation.expectedCloseTerminalSha256
    || receipt.quarantineReceiptSha256 !== null
    || Object.values(receipt.checks).some((check) => check !== true)
  ) throw new Error("production_promotion_recovery_receipt_invalid");
  return receipt;
}

export function verifyProductionPromotionRecoveryReceiptFile(input: {
  readonly receiptFile: string;
  readonly expectedUid: number;
} & ProductionPromotionRecoveryReceiptExpectation): ProductionPromotionRecoveryReceipt {
  if (
    !path.isAbsolute(input.receiptFile)
    || path.resolve(input.receiptFile) !== input.receiptFile
    || input.receiptFile.includes("\0")
    || !Number.isSafeInteger(input.expectedUid) || input.expectedUid < 0
  ) throw new Error("production_promotion_recovery_receipt_invalid");
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      input.receiptFile,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const pathname = fs.lstatSync(input.receiptFile, { bigint: true });
    if (
      !stat.isFile() || !pathname.isFile() || pathname.isSymbolicLink()
      || stat.uid !== BigInt(input.expectedUid) || pathname.uid !== BigInt(input.expectedUid)
      || Number(stat.mode & 0o7777n) !== 0o600
      || Number(pathname.mode & 0o7777n) !== 0o600
      || stat.nlink !== 1n || pathname.nlink !== 1n
      || stat.dev !== pathname.dev || stat.ino !== pathname.ino
      || stat.size < 1n || stat.size > BigInt(MAX_RECEIPT_BYTES)
      || fs.realpathSync(input.receiptFile) !== input.receiptFile
    ) throw new Error("production_promotion_recovery_receipt_invalid");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
    ) throw new Error("production_promotion_recovery_receipt_invalid");
    return verifyProductionPromotionRecoveryReceiptBytes(bytes, input);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export async function runProductionPromotionRecoveryReceiptVerifier(
  argv: readonly string[] = process.argv.slice(2),
  writeOutput: (source: string) => void = (source) => process.stdout.write(source),
): Promise<0 | 1> {
  try {
    const args = parseStrictArguments(argv, { allowed: ARGUMENTS, required: ARGUMENTS });
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("production_promotion_recovery_receipt_invalid");
    const receipt = verifyProductionPromotionRecoveryReceiptFile({
      receiptFile: args.get("--receipt")!, expectedUid: uid,
      expectedFileSha256: args.get("--expected-sha256")!,
      candidateSha: args.get("--candidate-sha")!,
      expectedCloseReceiptSha256: args.get("--expected-close-receipt-sha256")!,
      expectedCloseTerminalSha256: args.get("--expected-close-terminal-sha256")!,
      expectedDeploymentIdSha256: args.get("--expected-deployment-id-sha256")!,
    });
    writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1, ok: true, candidateSha: receipt.candidateSha,
      receiptSha256: receipt.receiptSha256,
    }));
    return 0;
  } catch {
    writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1, ok: false,
      failureCode: "production_promotion_recovery_receipt_invalid",
    }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductionPromotionRecoveryReceiptVerifier();
}
