import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_LOGICAL_WORM_AWS_GATE_ENV,
  POSTGRES_LOGICAL_WORM_AWS_GATE_VALUE,
  POSTGRES_LOGICAL_WORM_CONFIRMATION_ENV,
  POSTGRES_LOGICAL_WORM_CONFIRMATION_VALUE,
  loadAwsSdkV3WormProvider,
} from "../scripts/attest-postgres-logical-worm.js";
import {
  attestPostgresLogicalWorm,
} from "../src/lib/postgres-logical-worm.js";
import { writeLogicalOffsiteFixture } from "./postgres-logical-offsite.fixtures.js";

const LIVE_GATE = "PINTPATH_TEST_POSTGRES_LOGICAL_WORM_AWS";
const LIVE_VALUE = "confirmed";
const LIVE = process.env[LIVE_GATE] === LIVE_VALUE
  && process.env[POSTGRES_LOGICAL_WORM_CONFIRMATION_ENV]
    === POSTGRES_LOGICAL_WORM_CONFIRMATION_VALUE
  && process.env[POSTGRES_LOGICAL_WORM_AWS_GATE_ENV]
    === POSTGRES_LOGICAL_WORM_AWS_GATE_VALUE;
const liveDescribe = LIVE ? describe : describe.skip;

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredEnvironment(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (!value || value.trim() !== value || !pattern.test(value)) {
    throw new Error(`Missing or invalid live WORM integration setting: ${name}`);
  }
  return value;
}

liveDescribe("Postgres logical WORM AWS integration", () => {
  it("conditionally writes and independently verifies an exact COMPLIANCE-locked backup", async () => {
    const bucketName = requiredEnvironment(
      "PINTPATH_TEST_WORM_BUCKET",
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    );
    const writerProfile = requiredEnvironment(
      "PINTPATH_TEST_WORM_WRITER_PROFILE",
      /^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,127}$/,
    );
    const readerProfile = requiredEnvironment(
      "PINTPATH_TEST_WORM_READER_PROFILE",
      /^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,127}$/,
    );
    const recoveryAccountId = requiredEnvironment(
      "PINTPATH_TEST_WORM_RECOVERY_ACCOUNT_ID",
      /^\d{12}$/,
    );
    const writerArnSha256 = requiredEnvironment(
      "PINTPATH_TEST_WORM_WRITER_ARN_SHA256",
      /^[a-f0-9]{64}$/,
    );
    const readerArnSha256 = requiredEnvironment(
      "PINTPATH_TEST_WORM_READER_ARN_SHA256",
      /^[a-f0-9]{64}$/,
    );
    expect(writerProfile).not.toBe(readerProfile);
    expect(writerArnSha256).not.toBe(readerArnSha256);

    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-worm-live-")),
    );
    fs.chmodSync(root, 0o700);
    const fixture = writeLogicalOffsiteFixture(root, createdAt);
    expect(fixture.manifest.schemaVersion).toBe(3);
    const loaded = loadAwsSdkV3WormProvider({
      bucketName,
      writerProfile,
      readerProfile,
    });
    try {
      const result = await attestPostgresLogicalWorm({
        backupDirectory: fixture.backupDirectory,
        expectedManifestSha256: fixture.manifestSha256,
        bucketName,
        expectedBucketNameSha256: sha256(bucketName),
        recoveryAccountId,
        expectedRecoveryAccountIdSha256: sha256(recoveryAccountId),
        expectedWriterPrincipalArnSha256: writerArnSha256,
        expectedReaderPrincipalArnSha256: readerArnSha256,
        forbiddenAccountIds: (process.env.PINTPATH_TEST_WORM_FORBIDDEN_ACCOUNT_IDS ?? "")
          .split(",")
          .filter(Boolean),
        operatorId: "vitest-live-worm-integration",
        provider: loaded.provider,
      });
      expect(result).toMatchObject({
        schemaVersion: 1,
        ok: true,
        manifestSha256: fixture.manifestSha256,
        archiveSha256: fixture.archiveSha256,
        stateReceiptSha256: fixture.receiptSha256,
        recoveryAccountIdSha256: sha256(recoveryAccountId),
        bucketNameSha256: sha256(bucketName),
      });
      expect(Date.parse(result.minimumRetainUntil)).toBeGreaterThan(
        Date.now() + 29 * 24 * 60 * 60 * 1000,
      );
    } finally {
      loaded.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30 * 60 * 1000);
});
