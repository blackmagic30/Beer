import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HOSTED_PILOT_ACCEPTANCE_SCHEMA = "pintpath-hosted-bar-pilot-acceptance/v1";
export const HOSTED_PILOT_ORIGIN = "https://beer-staging.up.railway.app";
export const HOSTED_PILOT_CHECKS = Object.freeze([
  "google_sign_in", "consent", "session_persistence", "manager_dashboard",
  "venue_details", "opening_hours", "beers_prices", "stock_tap",
  "consumer_publication", "customer_account", "wallet", "rotating_identity",
  "staff_identification", "purchase_plus_one", "duplicate_purchase",
  "restricted_threshold", "reward_available", "redemption_minus_fifty",
  "redemption_awards_zero", "reward_replay_rejected", "venue_history",
  "award_reversal", "unauthorised_account_rejected", "desktop_map_search_details",
  "iphone_map_list_details", "maps_failure_fallback",
]);
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const RUN = /^[1-9][0-9]*$/;
const ROLES = ["ownerAdmin", "manager", "staff", "customer"];
const MAX_BYTES = 128 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function isoTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

/** A protected operator record of actual hosted observations, never a fixture receipt. */
export function parseHostedBarPilotAcceptance(value, expected) {
  if (!expected || !SHA.test(expected.candidateSha) || !RUN.test(String(expected.stagingRunId))
    || !HASH.test(expected.stagingDeploymentIdSha256) || !HASH.test(expected.sourceIdentitySha256)) return null;
  const now = expected.now instanceof Date ? expected.now.getTime() : Date.parse(expected.now);
  if (!Number.isFinite(now) || !exact(value, [
    "schemaVersion", "runtime", "candidateSha", "origin", "stagingRunId",
    "stagingDeploymentIdSha256", "sourceIdentitySha256", "startedAt", "completedAt",
    "accountHashes", "viewport", "checks",
  ]) || value.schemaVersion !== HOSTED_PILOT_ACCEPTANCE_SCHEMA || value.runtime !== "hosted-staging"
    || value.candidateSha !== expected.candidateSha || value.origin !== HOSTED_PILOT_ORIGIN
    || value.stagingRunId !== String(expected.stagingRunId)
    || value.stagingDeploymentIdSha256 !== expected.stagingDeploymentIdSha256
    || value.sourceIdentitySha256 !== expected.sourceIdentitySha256) return null;
  const start = isoTime(value.startedAt), end = isoTime(value.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > now
    || now - start > MAX_AGE_MS || !exact(value.viewport, ["width", "height"])
    || value.viewport.width !== 390 || value.viewport.height !== 844
    || !exact(value.accountHashes, ROLES)
    || !ROLES.every((role) => typeof value.accountHashes[role] === "string" && HASH.test(value.accountHashes[role]))
    || new Set(Object.values(value.accountHashes)).size !== ROLES.length
    || !Array.isArray(value.checks) || value.checks.length !== HOSTED_PILOT_CHECKS.length) return null;
  const ids = new Set();
  for (const check of value.checks) {
    if (!exact(check, ["id", "status", "evidenceSha256"])
      || !HOSTED_PILOT_CHECKS.includes(check.id) || ids.has(check.id)
      || check.status !== "PASS" || typeof check.evidenceSha256 !== "string"
      || !HASH.test(check.evidenceSha256)) return null;
    ids.add(check.id);
  }
  return value;
}

/** Re-read immediately before upload; the independently pinned bytes cannot change. */
export function assertHostedBarPilotAcceptance(input) {
  let descriptor;
  try {
    if (!path.isAbsolute(input.filePath) || !HASH.test(input.expectedSha256)) throw new Error();
    descriptor = fs.openSync(input.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_BYTES
      || (before.mode & 0o077) !== 0) throw new Error();
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.length !== before.size || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || hash(bytes) !== input.expectedSha256) throw new Error();
    const value = JSON.parse(bytes.toString("utf8"));
    if (bytes.toString("utf8") !== `${JSON.stringify(value, null, 2)}\n`) throw new Error();
    const report = parseHostedBarPilotAcceptance(value, input);
    if (!report) throw new Error();
    return Object.freeze({
      schemaVersion: HOSTED_PILOT_ACCEPTANCE_SCHEMA,
      reportSha256: input.expectedSha256,
      candidateSha: report.candidateSha,
      stagingRunId: report.stagingRunId,
      stagingDeploymentIdSha256: report.stagingDeploymentIdSha256,
      sourceIdentitySha256: report.sourceIdentitySha256,
      completedAt: report.completedAt,
      checksPassed: report.checks.length,
    });
  } catch {
    // Do not expose private paths, report contents, account references or parser errors.
    throw new Error("hosted_bar_pilot_acceptance_required");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
