import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Z0-9_]{2,100}$/;
const MAX_RECEIPT_BYTES = 512 * 1024;
const MAXIMUM_AGE_MILLISECONDS = 24 * 60 * 60 * 1000;
const MAXIMUM_FUTURE_SKEW_MILLISECONDS = 5 * 60 * 1000;
const REQUIRED_CHECK_IDS = Object.freeze([
  "RAILWAY_DEPLOYED_READINESS_CONTEXT",
  "POSTGRES_RUNTIME_IMPLEMENTATION",
  "PRODUCTION_POSTGRES_DATABASE_URL",
  "PRODUCTION_POSTGRES_MAINTENANCE_URL",
  "PRODUCTION_POSTGRES_ROOT_CA",
  "PRODUCTION_DATABASE_IDENTITY",
  "PRODUCTION_DATABASE_RESOURCE_IDENTITY",
  "REDIS_URL",
  "PRODUCTION_REDIS_IDENTITY",
  "PRODUCTION_REDIS_RESOURCE_IDENTITY",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_MAPS_MAP_ID",
  "GOOGLE_PLACES_API_KEY",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SOURCE_EVIDENCE_BUCKET",
  "OFFSITE_BACKUP_BUCKET",
  "OFFSITE_BACKUP_OPERATIONAL_COPY_DISTINCT",
  "FREE_LAUNCH_SCOPE",
  "FREE_LAUNCH_DEFERRED_CREDENTIALS_ABSENT",
  "SUPABASE_OAUTH_PROVIDERS",
  "REQUIRE_ADMIN_MFA_IN_PRODUCTION",
  "ACCOUNT_DELETION_NOTICE_MODE",
  "RESEND_WEBHOOK_SIGNING_SECRET",
]);

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key, index) => Object.keys(value)[index] === key);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeText(value, maximumBytes) {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") >= 1
    && Buffer.byteLength(value, "utf8") <= maximumBytes
    && !/[\r\n\0]/.test(value);
}

function parseIsoTimestamp(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? date
    : null;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 8) throw new Error("argument_invalid");
  const allowed = new Set([
    "--receipt",
    "--expected-sha256",
    "--candidate-sha",
    "--output",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || values.has(name) || typeof value !== "string") {
      throw new Error("argument_invalid");
    }
    values.set(name, value);
  }
  const receipt = values.get("--receipt");
  const expectedSha256 = values.get("--expected-sha256");
  const candidateSha = values.get("--candidate-sha");
  const output = values.get("--output");
  if (
    !path.isAbsolute(receipt)
    || !path.isAbsolute(output)
    || !SHA256_PATTERN.test(expectedSha256)
    || !SHA_PATTERN.test(candidateSha)
  ) throw new Error("argument_invalid");
  return { receipt, expectedSha256, candidateSha, output };
}

function assertPrivateFile(filename) {
  const stat = fs.lstatSync(filename);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.size < 1
    || stat.size > MAX_RECEIPT_BYTES
    || (stat.mode & 0o777) !== 0o600
    || (typeof process.geteuid === "function" && stat.uid !== process.geteuid())
  ) throw new Error("receipt_file_unsafe");
}

function assertPrivateOutputParent(filename) {
  const parent = fs.lstatSync(path.dirname(filename));
  if (
    !parent.isDirectory()
    || parent.isSymbolicLink()
    || (parent.mode & 0o777) !== 0o700
    || (typeof process.geteuid === "function" && parent.uid !== process.geteuid())
  ) throw new Error("output_path_unsafe");
}

function parsePostgresAuthority(value) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "applicationUrlSha256",
      "maintenanceUrlSha256",
      "rootCaPemSha256",
      "rootCaDerSha256",
      "applicationUrlExact",
      "maintenanceUrlExact",
      "sameDatabaseTarget",
      "distinctLoginRoles",
      "rootCaExact",
    ])
    || value.schemaVersion
      !== "pintpath-postgres-runtime-authority-readiness/v1"
    || !SHA256_PATTERN.test(value.applicationUrlSha256)
    || !SHA256_PATTERN.test(value.maintenanceUrlSha256)
    || !SHA256_PATTERN.test(value.rootCaPemSha256)
    || !SHA256_PATTERN.test(value.rootCaDerSha256)
    || value.applicationUrlSha256 === value.maintenanceUrlSha256
    || value.applicationUrlExact !== true
    || value.maintenanceUrlExact !== true
    || value.sameDatabaseTarget !== true
    || value.distinctLoginRoles !== true
    || value.rootCaExact !== true
  ) return null;
  return value;
}

function parseReadiness(value) {
  if (
    !exactKeys(value, [
      "ok",
      "environment",
      "readinessProfile",
      "strictLaunchCheck",
      "summary",
      "postgresAuthority",
      "checks",
    ])
    || value.ok !== true
    || value.environment !== "production"
    || value.readinessProfile !== "production_free_launch"
    || value.strictLaunchCheck !== true
    || !exactKeys(value.summary, [
      "passed",
      "warnings",
      "blockingWarnings",
      "failures",
    ])
    || !Array.isArray(value.checks)
    || value.checks.length < REQUIRED_CHECK_IDS.length
    || value.checks.length > 128
    || value.summary.passed !== value.checks.length
    || value.summary.warnings !== 0
    || value.summary.blockingWarnings !== 0
    || value.summary.failures !== 0
    || !parsePostgresAuthority(value.postgresAuthority)
  ) return null;
  const ids = [];
  for (const check of value.checks) {
    const keys = check && typeof check === "object" && !Array.isArray(check)
      ? Object.keys(check)
      : [];
    if (
      !(keys.length === 4 || keys.length === 5)
      || !["id", "label", "status", "action"].every(
        (key, index) => keys[index] === key,
      )
      || (keys.length === 5 && keys[4] !== "details")
      || typeof check.id !== "string"
      || !ID_PATTERN.test(check.id)
      || !safeText(check.label, 512)
      || check.status !== "pass"
      || check.action !== null
      || ("details" in check
        && check.details !== null
        && !safeText(check.details, 2_048))
    ) return null;
    ids.push(check.id);
  }
  if (
    new Set(ids).size !== ids.length
    || REQUIRED_CHECK_IDS.some((id) => !ids.includes(id))
  ) return null;
  return value;
}

export function parseProductionProviderReadinessEnvelope(source) {
  if (
    typeof source !== "string"
    || Buffer.byteLength(source, "utf8") > MAX_RECEIPT_BYTES
    || source.includes("\0")
  ) return null;
  try {
    const value = JSON.parse(source);
    if (
      !exactKeys(value, [
        "schemaVersion",
        "candidateSha",
        "observedAt",
        "observedProductionDeploymentSha",
        "readinessSha256",
        "readiness",
      ])
      || value.schemaVersion
        !== "pintpath-production-provider-readiness-envelope/v2"
      || !SHA_PATTERN.test(value.candidateSha)
      || !parseIsoTimestamp(value.observedAt)
      || !SHA_PATTERN.test(value.observedProductionDeploymentSha)
      || !SHA256_PATTERN.test(value.readinessSha256)
      || !parseReadiness(value.readiness)
      || sha256(canonicalJson(value.readiness)) !== value.readinessSha256
      || canonicalJson(value) !== source
    ) return null;
    return Object.freeze(value);
  } catch {
    return null;
  }
}

function writeExclusive(filename, source) {
  assertPrivateOutputParent(filename);
  fs.writeFileSync(filename, source, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const fd = fs.openSync(filename, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parentFd = fs.openSync(path.dirname(filename), "r");
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
}

export async function runProductionProviderReadinessReceiptVerification(
  argv,
  dependencies = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const writeOutput = dependencies.writeOutput
    ?? ((value) => process.stdout.write(value));
  try {
    const args = parseArguments(argv);
    assertPrivateFile(args.receipt);
    const source = fs.readFileSync(args.receipt, "utf8");
    if (sha256(source) !== args.expectedSha256) throw new Error("receipt_hash_mismatch");
    const envelope = parseProductionProviderReadinessEnvelope(source);
    if (!envelope || envelope.candidateSha !== args.candidateSha) {
      throw new Error("receipt_invalid");
    }
    const observed = parseIsoTimestamp(envelope.observedAt);
    const age = now().getTime() - observed.getTime();
    if (age < -MAXIMUM_FUTURE_SKEW_MILLISECONDS || age > MAXIMUM_AGE_MILLISECONDS) {
      throw new Error("receipt_stale");
    }
    const verified = Object.freeze({
      schemaVersion: "pintpath-production-provider-readiness-verification/v2",
      candidateSha: envelope.candidateSha,
      observedAt: envelope.observedAt,
      observedProductionDeploymentSha:
        envelope.observedProductionDeploymentSha,
      envelopeSha256: args.expectedSha256,
      readinessSha256: envelope.readinessSha256,
      checkCount: envelope.readiness.checks.length,
      postgresAuthority: Object.freeze({
        ...envelope.readiness.postgresAuthority,
      }),
      strictProductionProviderReadinessExact: true,
    });
    const verifiedSource = canonicalJson(verified);
    writeExclusive(args.output, verifiedSource);
    writeOutput(`${JSON.stringify({
      candidateSha: args.candidateSha,
      command: "verify-production-provider-readiness-receipt",
      ok: true,
      receiptSha256: sha256(verifiedSource),
    })}\n`);
    return 0;
  } catch (error) {
    writeOutput(`${JSON.stringify({
      command: "verify-production-provider-readiness-receipt",
      failureCode: error instanceof Error
        ? error.message.split(":", 1)[0]
        : "unexpected_failure",
      ok: false,
    })}\n`);
    return 1;
  }
}

export const productionProviderReadinessReceiptInternals = Object.freeze({
  MAXIMUM_AGE_MILLISECONDS,
  REQUIRED_CHECK_IDS,
  canonicalJson,
});

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductionProviderReadinessReceiptVerification(
    process.argv.slice(2),
  );
}
