import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const validator = path.resolve(root, "scripts/validate-release-evidence.ts");
const currentSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const oldestSha = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")[0]!;
const releaseId = "PP-LAUNCH-2026-TEST1";
const source = JSON.parse(fs.readFileSync(path.resolve(root, "docs/release-evidence.json"), "utf8")) as {
  version: number;
  release: { id: string | null; candidateSha: string | null; environment: string };
  items: Array<Record<string, unknown>>;
};
const temporaryDirectories: string[] = [];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function allPassed(): typeof source {
  const value = clone(source);
  value.release = { id: releaseId, candidateSha: currentSha, environment: "production" };
  value.items = value.items.map((item) => ({
    ...item,
    status: "pass",
    evidence: `${releaseId}/${String(item.id)}`,
    evidenceSha256: "a".repeat(64),
    verifiedAt: new Date().toISOString(),
    verifiedBy: "Release Owner, independent verifier",
  }));
  return value;
}

function validate(value: unknown, strict = false): { status: number | null; output: Record<string, any>; stderr: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-release-evidence-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "evidence.json");
  fs.writeFileSync(filename, `${JSON.stringify(value)}\n`);
  const result = spawnSync(
    process.execPath,
    ["--import=tsx", validator, ...(strict ? ["--strict"] : [])],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, RELEASE_EVIDENCE_PATH: filename },
    },
  );
  return {
    status: result.status,
    output: JSON.parse(result.stdout) as Record<string, any>,
    stderr: result.stderr,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("release evidence validator", () => {
  it("keeps valid pending evidence informational in normal mode and blocking in strict mode", () => {
    const normal = validate(source);
    const strict = validate(source, true);

    expect(normal.status).toBe(0);
    expect(normal.output).toMatchObject({ valid: true, launchReady: false, strict: false });
    expect(normal.output.incomplete).toHaveLength(12);
    expect(normal.output.incomplete.map((item: { id: string }) => item.id)).not.toContain("android_release");
    expect(normal.output.incomplete[0]).toMatchObject({
      id: "production_public_smoke",
      owner: expect.any(String),
      nextAction: expect.any(String),
    });
    expect(strict.status).toBe(1);
    expect(strict.output).toMatchObject({ valid: true, launchReady: false, strict: true });
  });

  it("accepts a complete file only when every item is bound to one frozen commit and hashed proof", () => {
    const result = validate(allPassed(), true);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.output).toMatchObject({
      valid: true,
      launchReady: true,
      strict: true,
      release: { id: releaseId, candidateSha: currentSha, environment: "production" },
    });
  });

  it("keeps a supported failed gate launch-blocking and rejects not-applicable required gates", () => {
    const failed = allPassed();
    failed.items[0] = { ...failed.items[0], status: "fail" };
    const failedResult = validate(failed, true);
    expect(failedResult.status).toBe(1);
    expect(failedResult.output).toMatchObject({ valid: true, launchReady: false });

    const notApplicable = allPassed();
    notApplicable.items[0] = {
      ...notApplicable.items[0],
      status: "not_applicable",
      evidence: null,
      evidenceSha256: null,
      verifiedAt: null,
      verifiedBy: null,
    };
    const notApplicableResult = validate(notApplicable, true);
    expect(notApplicableResult.status).toBe(1);
    expect(notApplicableResult.output).toMatchObject({ valid: false, launchReady: false });
    expect(notApplicableResult.output.invalidNotApplicable).toContain("production_public_smoke");
  });

  it("rejects unbound, unhashed, anonymous, future, and stale live proof", () => {
    const wrongReference = allPassed();
    wrongReference.items[0] = { ...wrongReference.items[0], evidence: "some note" };
    const missingDigest = allPassed();
    missingDigest.items[0] = { ...missingDigest.items[0], evidenceSha256: null };
    const anonymous = allPassed();
    anonymous.items[0] = { ...anonymous.items[0], verifiedBy: "someone" };
    const future = allPassed();
    future.items[0] = {
      ...future.items[0],
      verifiedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    const stale = allPassed();
    stale.release.candidateSha = oldestSha;
    stale.items[0] = {
      ...stale.items[0],
      verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };

    for (const fixture of [wrongReference, missingDigest, anonymous]) {
      const result = validate(fixture, true);
      expect(result.status).toBe(1);
      expect(result.output.valid).toBe(false);
      expect(result.output.unsupportedProof).toContain("production_public_smoke");
    }

    const futureResult = validate(future, true);
    expect(futureResult.status).toBe(1);
    expect(futureResult.output.futureEvidence).toContain("production_public_smoke");

    const staleInformation = validate(stale);
    expect(staleInformation.status).toBe(0);
    expect(staleInformation.output).toMatchObject({ valid: true, evidenceCurrent: false, launchReady: false });
    expect(staleInformation.output.staleLiveEvidence).toContain("production_public_smoke");

    const staleStrict = validate(stale, true);
    expect(staleStrict.status).toBe(1);
    expect(staleStrict.output.staleLiveEvidence).toContain("production_public_smoke");
  });

  it("rejects proof for an unknown candidate commit and pending items that retain old proof", () => {
    const unknownCandidate = allPassed();
    unknownCandidate.release.candidateSha = "f".repeat(40);
    const unknownResult = validate(unknownCandidate, true);
    expect(unknownResult.status).toBe(1);
    expect(unknownResult.output.repositoryBindingErrors).toContain(
      "release.candidateSha is not a commit in this repository",
    );

    const retained = clone(source);
    retained.items[0] = {
      ...retained.items[0],
      evidence: "old-proof",
      evidenceSha256: "b".repeat(64),
      verifiedAt: new Date().toISOString(),
      verifiedBy: "Old Owner, release verifier",
    };
    const retainedResult = validate(retained);
    expect(retainedResult.status).toBe(1);
    expect(retainedResult.output.pendingWithProof).toContain("production_public_smoke");
  });

  it("rejects malformed schemas, gate drift, and impossible timestamps in both modes", () => {
    const missing = clone(source);
    missing.items = missing.items.slice(1);
    const duplicate = clone(source);
    duplicate.items.push(clone(duplicate.items[0]!));
    const unexpected = clone(source);
    unexpected.items.push({
      id: "unreviewed_gate",
      label: "Unexpected launch gate",
      owner: "Release owner",
      nextAction: "Review the gate.",
      required: false,
      status: "pending",
      evidence: null,
      evidenceSha256: null,
      verifiedAt: null,
      verifiedBy: null,
    });
    const notRequired = clone(source);
    notRequired.items[0] = { ...notRequired.items[0], required: false };
    const impossibleDate = allPassed();
    impossibleDate.items[0] = { ...impossibleDate.items[0], verifiedAt: "2026-02-30T10:00:00.000Z" };
    const extraField = clone(source);
    extraField.items[0] = { ...extraField.items[0], signedOff: true };
    const invalidFixtures: unknown[] = [
      missing,
      duplicate,
      unexpected,
      notRequired,
      impossibleDate,
      extraField,
      { version: "not-a-version", release: source.release, items: source.items },
      { version: 2, release: source.release, items: null },
      { version: 2, release: source.release, items: [null] },
      [],
    ];

    for (const fixture of invalidFixtures) {
      for (const strict of [false, true]) {
        const result = validate(fixture, strict);
        expect(result.status, JSON.stringify({ fixture, strict })).toBe(1);
        expect(result.output).toMatchObject({ valid: false, launchReady: false, strict });
      }
    }
  });
});
