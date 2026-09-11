import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertHostedBarPilotAcceptance, HOSTED_PILOT_ACCEPTANCE_SCHEMA,
  HOSTED_PILOT_CHECKS, parseHostedBarPilotAcceptance } from "../scripts/lib/hosted-bar-pilot-acceptance.mjs";

const expected = {
  candidateSha: "a".repeat(40), stagingRunId: "12345",
  stagingDeploymentIdSha256: "b".repeat(64), sourceIdentitySha256: "c".repeat(64),
  now: "2026-09-11T09:00:00.000Z",
};
function report() {
  return {
    schemaVersion: HOSTED_PILOT_ACCEPTANCE_SCHEMA, runtime: "hosted-staging",
    candidateSha: expected.candidateSha, origin: "https://beer-staging.up.railway.app",
    stagingRunId: expected.stagingRunId, stagingDeploymentIdSha256: expected.stagingDeploymentIdSha256,
    sourceIdentitySha256: expected.sourceIdentitySha256,
    startedAt: "2026-09-11T08:00:00.000Z", completedAt: "2026-09-11T08:30:00.000Z",
    accountHashes: { ownerAdmin: "1".repeat(64), manager: "2".repeat(64), staff: "3".repeat(64), customer: "4".repeat(64) },
    viewport: { width: 390, height: 844 },
    checks: HOSTED_PILOT_CHECKS.map((id: string) => ({ id, status: "PASS", evidenceSha256: "d".repeat(64) })),
  };
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function privateReport(value = report()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-hosted-receipt-test-")); roots.push(root);
  const filePath = path.join(root, "acceptance.json");
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  return { ...expected, filePath, expectedSha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}
describe("protected hosted bar-pilot acceptance", () => {
  it("accepts only complete observations bound to the independently verified live staging identity", () => {
    expect(parseHostedBarPilotAcceptance(report(), expected)).not.toBeNull();
    expect(assertHostedBarPilotAcceptance(privateReport())).toMatchObject({ checksPassed: HOSTED_PILOT_CHECKS.length, candidateSha: expected.candidateSha });
  });
  it.each(["candidateSha", "stagingRunId", "stagingDeploymentIdSha256", "sourceIdentitySha256"] as const)("rejects a different %s", (field) => {
    const value = report(); value[field] = field === "stagingRunId" ? "98765" : "e".repeat(value[field].length);
    expect(parseHostedBarPilotAcceptance(value, expected)).toBeNull();
  });
  it.each(["http://127.0.0.1:3217", "https://pintpath.au", "https://beer-staging.up.railway.app.evil.test"])("rejects substitute runtime %s", (origin) => {
    expect(parseHostedBarPilotAcceptance({ ...report(), origin }, expected)).toBeNull();
  });
  it("rejects local browser results, missing checks, repeated checks and owner-pending checks", () => {
    expect(parseHostedBarPilotAcceptance({ ...report(), runtime: "disposable loopback PostgreSQL 17" }, expected)).toBeNull();
    const missing = report(); missing.checks.pop(); expect(parseHostedBarPilotAcceptance(missing, expected)).toBeNull();
    const duplicate = report(); duplicate.checks[0] = duplicate.checks[1]!; expect(parseHostedBarPilotAcceptance(duplicate, expected)).toBeNull();
    const pending = report(); pending.checks[0]!.status = "OWNER_ACTION_REQUIRED"; expect(parseHostedBarPilotAcceptance(pending, expected)).toBeNull();
  });
  it("rejects reused identities, raw account fields and missing evidence references", () => {
    const same = report(); same.accountHashes.staff = same.accountHashes.manager;
    expect(parseHostedBarPilotAcceptance(same, expected)).toBeNull();
    expect(parseHostedBarPilotAcceptance({ ...report(), email: "not-for-release@example.invalid" }, expected)).toBeNull();
    const unproved = report(); unproved.checks[0]!.evidenceSha256 = "";
    expect(parseHostedBarPilotAcceptance(unproved, expected)).toBeNull();
  });
  it("rejects old, future, reversed or invalid observation times and desktop-only evidence", () => {
    for (const change of [{ startedAt: "2026-09-10T08:00:00.000Z" }, { completedAt: "2026-09-11T10:00:00.000Z" },
      { startedAt: "2026-09-11T08:45:00.000Z" }, { startedAt: "bad" }, { viewport: { width: 1280, height: 800 } }]) {
      expect(parseHostedBarPilotAcceptance({ ...report(), ...change }, expected)).toBeNull();
    }
  });
  it("rejects wrong digests and edits between gate invocations", () => {
    const input = privateReport();
    expect(() => assertHostedBarPilotAcceptance({ ...input, expectedSha256: "0".repeat(64) })).toThrow("hosted_bar_pilot_acceptance_required");
    assertHostedBarPilotAcceptance(input);
    fs.appendFileSync(input.filePath, " ");
    expect(() => assertHostedBarPilotAcceptance(input)).toThrow("hosted_bar_pilot_acceptance_required");
  });
  it("rejects duplicate JSON fields even when the supplied byte digest matches", () => {
    const input = privateReport();
    const bytes = fs.readFileSync(input.filePath, "utf8").replace('  "runtime": "hosted-staging",', '  "runtime": "loopback",\n  "runtime": "hosted-staging",');
    fs.writeFileSync(input.filePath, bytes);
    input.expectedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    expect(() => assertHostedBarPilotAcceptance(input)).toThrow("hosted_bar_pilot_acceptance_required");
  });
  it("rejects symlinks, hardlinks and public permissions", () => {
    const input = privateReport();
    const link = `${input.filePath}.link`; fs.symlinkSync(input.filePath, link);
    expect(() => assertHostedBarPilotAcceptance({ ...input, filePath: link })).toThrow("hosted_bar_pilot_acceptance_required");
    fs.linkSync(input.filePath, `${input.filePath}.hardlink`);
    expect(() => assertHostedBarPilotAcceptance(input)).toThrow("hosted_bar_pilot_acceptance_required");
    const publicInput = privateReport(); fs.chmodSync(publicInput.filePath, 0o644);
    expect(() => assertHostedBarPilotAcceptance(publicInput)).toThrow("hosted_bar_pilot_acceptance_required");
  });
});
