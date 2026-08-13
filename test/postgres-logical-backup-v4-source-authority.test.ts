import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildPostgresLogicalBackupV4SnapshotHandoffBinding,
  buildPostgresLogicalBackupV4SourceAuthorityReceipt,
  buildPostgresLogicalBackupV4SourceCaptureBinding,
  canonicalPostgresLogicalBackupV4SourceAuthorityPolicyJson,
  canonicalPostgresLogicalBackupV4SourceAuthorityReceiptJson,
  parsePostgresLogicalBackupV4SourceAuthorityPolicy,
  parsePostgresLogicalBackupV4SourceAuthorityReceipt,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_CAPABILITY,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_RECEIPT_BYTES,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY_SHA256,
  postgresLogicalBackupV4SourceAuthorityReceiptSha256,
  PostgresLogicalBackupV4SourceAuthorityError,
  type BuildPostgresLogicalBackupV4SourceAuthorityReceiptInput,
  type PostgresLogicalBackupV4SourceAuthorityReceipt,
} from "../src/lib/postgres-logical-backup-v4-source-authority.js";
import {
  canonicalPostgresLogicalStateJson,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateCaptureV2,
} from "../src/lib/postgres-logical-state.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawSnapshotIdentifier = "00000003-000000B1-1";

function hash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function fakeCapture(databaseOid = "12345"): PostgresLogicalStateCaptureV2 {
  return {
    inventory: {
      sourceReadBoundarySha256: hash("portable-boundary"),
      overallStateSha256: hash("overall-state"),
    },
    sourceDatabaseOid: databaseOid,
    sourcePhysicalReadBoundarySha256: hash("physical-boundary"),
  } as unknown as PostgresLogicalStateCaptureV2;
}

function eventTimes() {
  return {
    loginProvisionedAt: "2026-08-12T00:00:00.000Z",
    sourceRoleSetAt: "2026-08-12T00:00:01.000Z",
    membershipRevokedAt: "2026-08-12T00:00:02.000Z",
    sourceTransactionBeganAt: "2026-08-12T00:00:03.000Z",
    v2CaptureCompletedAt: "2026-08-12T00:00:04.000Z",
    snapshotExportedAt: "2026-08-12T00:00:05.000Z",
    membershipRegrantedAt: "2026-08-12T00:00:06.000Z",
    pgDumpSnapshotImportedAt: "2026-08-12T00:00:07.000Z",
    sourceTransactionEndedAt: "2026-08-12T00:00:08.000Z",
    cleanupCompletedAt: "2026-08-12T00:00:09.000Z",
  } as const;
}

function validInput(): BuildPostgresLogicalBackupV4SourceAuthorityReceiptInput {
  const sourceDatabaseOid = "12345";
  const databaseIdentitySha256 = hash("database-identity");
  const sourceUrlSha256 = hash("source-url");
  return {
    createdAt: "2026-08-12T00:00:09.000Z",
    startedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-12T00:10:00.000Z",
    sourceDatabaseOid,
    databaseIdentitySha256,
    sourceUrlSha256,
    backupGroupRoleOid: "22345",
    ephemeralLoginRoleOid: "32345",
    ephemeralLoginVersion: "202608120001",
    backupGroupCatalogEvidenceSha256: hash("backup-group-catalog"),
    ephemeralLoginCatalogEvidenceSha256: hash("ephemeral-login-catalog"),
    effectiveConnectableDatabaseCount: 3,
    effectiveDatabaseScopeEvidenceSha256: hash("effective-database-scope"),
    sourceSessionIdentitySha256: hash("source-session"),
    independentAdminSessionIdentitySha256: hash("admin-session"),
    pgDumpSessionIdentitySha256: hash("pg-dump-session"),
    sourceAuthenticationEvidenceSha256: hash("source-scram-authentication"),
    pgDumpAuthenticationEvidenceSha256: hash("pg-dump-scram-authentication"),
    sourceSessionTimeoutEvidenceSha256: hash("source-session-timeouts"),
    pgDumpExternalWatchdogEvidenceSha256: hash("pg-dump-external-watchdog"),
    serverClockEvidenceSha256: hash("server-clock-validity"),
    eventTimes: eventTimes(),
    membershipEvidenceSha256: {
      provisioned: hash("membership-provisioned"),
      detachedForV2: hash("membership-detached"),
      regrantedForPgDump: hash("membership-regranted"),
      cleanedUp: hash("membership-cleaned"),
    },
    sourceTransactionEvidenceSha256: hash("source-transaction"),
    captureToExportSequenceEvidenceSha256: hash("capture-to-export-sequence"),
    sourceCapture: buildPostgresLogicalBackupV4SourceCaptureBinding(
      fakeCapture(sourceDatabaseOid),
    ),
    snapshotHandoff: buildPostgresLogicalBackupV4SnapshotHandoffBinding({
      sourceDatabaseOid,
      databaseIdentitySha256,
      sourceUrlSha256,
      effectiveRoleName: `pintpath_logical_backup_d${sourceDatabaseOid}`,
      snapshotIdentifier: rawSnapshotIdentifier,
    }),
    pgDumpSnapshotVisibilityEvidenceSha256: hash("pg-dump-snapshot-visibility"),
    pgDumpExactRawArgumentsEvidenceSha256: hash("pg-dump-exact-raw-arguments"),
    cleanupEvidenceSha256: hash("cleanup"),
    terminatedBackendCount: 0,
  };
}

function validReceipt(): PostgresLogicalBackupV4SourceAuthorityReceipt {
  return buildPostgresLogicalBackupV4SourceAuthorityReceipt(validInput());
}

function expectCode(work: () => unknown, code: PostgresLogicalBackupV4SourceAuthorityError["code"]): void {
  let captured: unknown;
  try {
    work();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresLogicalBackupV4SourceAuthorityError);
  expect(captured).toMatchObject({ code });
}

describe("PostgreSQL logical-backup V4 source-authority contract", () => {
  it("publishes a frozen, offline-only, non-authorizing policy", () => {
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_CAPABILITY).toEqual({
      implementationState: "OFFLINE_CONTRACT_ONLY",
      sourceRoleProvisioningImplemented: false,
      sourceSnapshotExportImplemented: false,
      pgDumpHandoffImplemented: false,
      operationalSourceAuthorityImplemented: false,
      effectiveTargetOnlyDatabaseAccessVerified: false,
      completeRoleGraphVerified: false,
      artifactEmissionAuthorized: false,
      activationAuthorized: false,
      productionCutoverAuthorized: false,
    });
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY).toMatchObject({
      implementationState: "OFFLINE_CONTRACT_ONLY",
      maxLifetimeSeconds: 600,
      ephemeralLogin: {
        login: true,
        inherit: false,
        connectionLimit: 2,
        validUntilRequired: true,
        passwordVerifierFormat: "scram-sha-256",
        directTargetDatabaseConnectGrantCount: 1,
        directFunctionPrivilegeCount: 0,
        directPrivateObjectPrivilegeCount: 0,
      },
      membership: { setOption: true, inheritOption: false, adminOption: false },
      sourceTransaction: {
        roleSetBeforeBegin: true,
        membershipRevokedBeforeBegin: true,
        isolation: "repeatable read",
        readOnly: true,
        v2CaptureSequence: 1,
        snapshotExportSequence: 2,
      },
      snapshot: { rawIdentifierPersisted: false },
      authorization: {
        evidenceOnly: true,
        activationAuthorized: false,
        artifactEmissionAuthorized: false,
        productionCutoverAuthorized: false,
      },
    });
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS).toBe(600);
    expect(Object.isFrozen(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY)).toBe(true);
    expect(Object.isFrozen(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY.membership)).toBe(true);

    const canonical = canonicalPostgresLogicalBackupV4SourceAuthorityPolicyJson();
    expect(canonical.endsWith("\n")).toBe(true);
    expect(crypto.createHash("sha256").update(canonical).digest("hex"))
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY_SHA256);
    expect(parsePostgresLogicalBackupV4SourceAuthorityPolicy(Buffer.from(canonical)))
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY);
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityPolicy(Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical),
      ])),
      "policy_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityPolicy(
        Buffer.from(`${canonical.trim()} `),
      ),
      "policy_invalid",
    );
  });

  it("derives V2 and snapshot handoff bindings without retaining the raw snapshot identifier", () => {
    const capture = fakeCapture();
    const captureBinding = buildPostgresLogicalBackupV4SourceCaptureBinding(capture);
    expect(captureBinding).toEqual({
      profile: "opaque-logical-state-v2-capture-digest-v1",
      captureSha256: sha256CanonicalPostgresLogicalState(capture),
      sourceDatabaseOid: "12345",
      portableReadBoundarySha256: hash("portable-boundary"),
      physicalReadBoundarySha256: hash("physical-boundary"),
      overallStateSha256: hash("overall-state"),
      requiresIndependentFullV2Validation: true,
    });
    expect(Object.isFrozen(captureBinding)).toBe(true);

    const first = validInput().snapshotHandoff;
    const second = buildPostgresLogicalBackupV4SnapshotHandoffBinding({
      sourceDatabaseOid: "12345",
      databaseIdentitySha256: hash("database-identity"),
      sourceUrlSha256: hash("source-url"),
      effectiveRoleName: "pintpath_logical_backup_d12345",
      snapshotIdentifier: "00000003-000000B1-2",
    });
    expect(first.exportedSnapshotBindingSha256).not.toBe(second.exportedSnapshotBindingSha256);
    expect(first.pgDumpSnapshotSemanticBindingSha256)
      .not.toBe(second.pgDumpSnapshotSemanticBindingSha256);
    expect(first.semanticHandoffBindingSha256).not.toBe(second.semanticHandoffBindingSha256);
    expect(JSON.stringify(first)).not.toContain(rawSnapshotIdentifier);

    const spliced = structuredClone(validInput());
    spliced.snapshotHandoff.exportedSnapshotBindingSha256 =
      second.exportedSnapshotBindingSha256;
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(spliced),
      "receipt_invalid",
    );
    const rebound = structuredClone(validInput());
    rebound.snapshotHandoff = buildPostgresLogicalBackupV4SnapshotHandoffBinding({
      sourceDatabaseOid: "54321",
      databaseIdentitySha256: hash("other-database-identity"),
      sourceUrlSha256: hash("other-source-url"),
      effectiveRoleName: "pintpath_logical_backup_d54321",
      snapshotIdentifier: rawSnapshotIdentifier,
    });
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(rebound),
      "receipt_invalid",
    );
    expectCode(() => buildPostgresLogicalBackupV4SnapshotHandoffBinding({
      sourceDatabaseOid: "12345",
      databaseIdentitySha256: hash("database-identity"),
      sourceUrlSha256: hash("source-url"),
      effectiveRoleName: "pintpath_logical_backup_d99999",
      snapshotIdentifier: rawSnapshotIdentifier,
    }), "snapshot_binding_invalid");
    for (const snapshotIdentifier of [
      "-", "00000003-000000b1-1", "00000003-000000B1-0", "00000003-000000B1-01",
      "00000003-000000B1-2147483648",
    ]) {
      expectCode(() => buildPostgresLogicalBackupV4SnapshotHandoffBinding({
        sourceDatabaseOid: "12345",
        databaseIdentitySha256: hash("database-identity"),
        sourceUrlSha256: hash("source-url"),
        effectiveRoleName: "pintpath_logical_backup_d12345",
        snapshotIdentifier,
      }), "snapshot_binding_invalid");
    }
  });

  it("builds, self-binds, canonicalizes, hashes, parses, and freezes an evidence-only receipt", () => {
    const receipt = validReceipt();
    expect(receipt.roles).toEqual({
      backupGroup: {
        roleName: "pintpath_logical_backup_d12345",
        roleOid: "22345",
        login: false,
        inherit: false,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        catalogEvidenceSha256: hash("backup-group-catalog"),
      },
      ephemeralLogin: {
        roleName: "pintpath_logical_backup_d12345_v202608120001",
        roleOid: "32345",
        login: true,
        inherit: false,
        connectionLimit: 2,
        validUntil: "2026-08-12T00:10:00.000Z",
        passwordVerifierFormat: "scram-sha-256",
        sourceAuthenticationEvidenceSha256: hash("source-scram-authentication"),
        pgDumpAuthenticationEvidenceSha256: hash("pg-dump-scram-authentication"),
        directTargetDatabaseConnectGrantCount: 1,
        directFunctionPrivilegeCount: 0,
        directPrivateObjectPrivilegeCount: 0,
        effectiveConnectableDatabaseCount: 3,
        effectiveTargetOnlyDatabaseScopeVerified: false,
        effectiveDatabaseScopeEvidenceSha256: hash("effective-database-scope"),
        operationalizationBlockedUntilEffectiveDatabaseScopeVerified: true,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        catalogEvidenceSha256: hash("ephemeral-login-catalog"),
      },
    });
    expect(receipt.membershipTransitions.map((transition) => [
      transition.phase,
      transition.backupGroupChildMembershipCount,
      transition.loginParentMembershipCount,
      transition.exactSetOnlyMembershipCount,
    ])).toEqual([
      ["provisioned", 1, 1, 1],
      ["detached-for-v2", 0, 0, 0],
      ["regranted-for-pg-dump", 1, 1, 1],
      ["cleaned-up", 0, 0, 0],
    ]);
    expect(receipt.membershipTransitions.every(
      (transition) => transition.observerSessionIdentitySha256
        === receipt.sessions.independentAdmin.identitySha256,
    )).toBe(true);
    expect(receipt.sourceTransaction).toMatchObject({
      currentUserRoleName: receipt.roles.backupGroup.roleName,
      sessionUserRoleName: receipt.roles.ephemeralLogin.roleName,
      backupGroupChildMembershipCount: 0,
      loginParentMembershipCount: 0,
      sourceSessionIdentitySha256: receipt.sessions.source.identitySha256,
    });
    expect(receipt.v2Capture.captureSequence).toBe(1);
    expect(receipt.exportedSnapshot.exportSequence).toBe(2);
    expect(receipt.v2Capture.sourceSessionIdentitySha256)
      .toBe(receipt.exportedSnapshot.sourceSessionIdentitySha256);
    expect(receipt.pgDumpHandoff.pgDumpSessionIdentitySha256)
      .toBe(receipt.sessions.pgDump.identitySha256);
    expect(receipt.activationAuthorized).toBe(false);
    expect(receipt.artifactEmissionAuthorized).toBe(false);
    expect(receipt.productionCutoverAuthorized).toBe(false);
    expect(receipt.operationalSourceAuthorityImplemented).toBe(false);
    expect(receipt.effectiveTargetOnlyDatabaseAccessVerified).toBe(false);
    expect(receipt.completeRoleGraphVerified).toBe(false);
    expect(receipt.emitterMustRejectUntilOperationalSourceAuthorityImplemented).toBe(true);
    expect(receipt.roles.ephemeralLogin).toMatchObject({
      effectiveConnectableDatabaseCount: 3,
      effectiveTargetOnlyDatabaseScopeVerified: false,
      operationalizationBlockedUntilEffectiveDatabaseScopeVerified: true,
    });

    const canonical = canonicalPostgresLogicalBackupV4SourceAuthorityReceiptJson(receipt);
    expect(Buffer.byteLength(canonical)).toBeLessThan(
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_RECEIPT_BYTES,
    );
    expect(canonical).not.toContain(rawSnapshotIdentifier);
    expect(postgresLogicalBackupV4SourceAuthorityReceiptSha256(receipt))
      .toBe(crypto.createHash("sha256").update(canonical).digest("hex"));
    const parsed = parsePostgresLogicalBackupV4SourceAuthorityReceipt(Buffer.from(canonical));
    expect(parsed).toEqual(receipt);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.membershipTransitions[0])).toBe(true);
  });

  it("rejects invalid lifetime, sequence, identity, OID, capture, and role inputs", () => {
    const tooLong = structuredClone(validInput());
    tooLong.expiresAt = "2026-08-12T00:10:00.001Z";
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(tooLong),
      "receipt_invalid",
    );

    const reversed = structuredClone(validInput());
    reversed.eventTimes.snapshotExportedAt = "2026-08-12T00:00:03.500Z";
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(reversed),
      "receipt_invalid",
    );

    const reusedSession = structuredClone(validInput());
    reusedSession.pgDumpSessionIdentitySha256 = reusedSession.sourceSessionIdentitySha256;
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(reusedSession),
      "receipt_invalid",
    );

    const reusedRoleOid = structuredClone(validInput());
    reusedRoleOid.ephemeralLoginRoleOid = reusedRoleOid.backupGroupRoleOid;
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(reusedRoleOid),
      "receipt_invalid",
    );

    const mismatchedCapture = structuredClone(validInput());
    mismatchedCapture.sourceCapture.sourceDatabaseOid = "54321";
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(mismatchedCapture),
      "receipt_invalid",
    );

    expectCode(
      () => buildPostgresLogicalBackupV4SourceCaptureBinding({
        ...fakeCapture(),
        sourcePhysicalReadBoundarySha256: "A".repeat(64),
      }),
      "capture_binding_invalid",
    );
  });

  it("rejects authority escalation, membership drift, argument drift, and canonical-byte drift", () => {
    const authority = structuredClone(validReceipt()) as unknown as Record<string, unknown>;
    authority.activationAuthorized = true;
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceipt(
        Buffer.from(canonicalPostgresLogicalStateJson(authority)),
      ),
      "receipt_invalid",
    );

    const membership = structuredClone(validReceipt()) as unknown as {
      membershipTransitions: Array<{ exactSetOnlyMembershipCount: number }>;
    };
    membership.membershipTransitions[1]!.exactSetOnlyMembershipCount = 1;
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceipt(
        Buffer.from(canonicalPostgresLogicalStateJson(membership)),
      ),
      "receipt_invalid",
    );

    const argumentsDrift = structuredClone(validReceipt()) as unknown as {
      pgDumpHandoff: { snapshotArgumentSemanticBindingSha256: string };
    };
    argumentsDrift.pgDumpHandoff.snapshotArgumentSemanticBindingSha256 =
      hash("other-snapshot-argument");
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceipt(
        Buffer.from(canonicalPostgresLogicalStateJson(argumentsDrift)),
      ),
      "receipt_invalid",
    );

    const reboundDerivations = structuredClone(validReceipt()) as unknown as Record<string, unknown> & {
      exportedSnapshot: {
        bindingSha256: string;
        semanticHandoffBindingSha256: string;
      };
      pgDumpHandoff: {
        importedSnapshotBindingSha256: string;
        snapshotArgumentSemanticBindingSha256: string;
        semanticHandoffBindingSha256: string;
        argumentsBindingSha256: string;
      };
      receiptBindingSha256: string;
    };
    reboundDerivations.exportedSnapshot.bindingSha256 = hash("forged-exported-binding");
    reboundDerivations.exportedSnapshot.semanticHandoffBindingSha256 = hash("forged-handoff");
    reboundDerivations.pgDumpHandoff.importedSnapshotBindingSha256 = hash("forged-exported-binding");
    reboundDerivations.pgDumpHandoff.snapshotArgumentSemanticBindingSha256 = hash(
      "forged-snapshot-semantic",
    );
    reboundDerivations.pgDumpHandoff.semanticHandoffBindingSha256 = hash("forged-handoff");
    reboundDerivations.pgDumpHandoff.argumentsBindingSha256 = sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-backup-v4-pg-dump-argument-binding",
      version: 1,
      roleArgumentSha256: (reboundDerivations.pgDumpHandoff as unknown as {
        roleArgumentSha256: string;
      }).roleArgumentSha256,
      snapshotArgumentSemanticBindingSha256:
        reboundDerivations.pgDumpHandoff.snapshotArgumentSemanticBindingSha256,
      semanticHandoffBindingSha256:
        reboundDerivations.pgDumpHandoff.semanticHandoffBindingSha256,
    });
    const { receiptBindingSha256: _oldBinding, ...reboundWithoutBinding } = reboundDerivations;
    reboundDerivations.receiptBindingSha256 = sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-backup-v4-source-authority-receipt-binding",
      version: 1,
      receipt: reboundWithoutBinding,
    });
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceipt(
        Buffer.from(canonicalPostgresLogicalStateJson(reboundDerivations)),
      ),
      "receipt_invalid",
    );

    const canonical = canonicalPostgresLogicalBackupV4SourceAuthorityReceiptJson(validReceipt());
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceipt(Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical),
      ])),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceipt(
        Buffer.from(`${canonical.trim()} `),
      ),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceipt(Buffer.from([0xff])),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceipt(
        Buffer.alloc(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_RECEIPT_BYTES + 1, 0x20),
      ),
      "receipt_invalid",
    );
  });

  it("snapshots inputs without invoking getters and rejects unsupported prototypes", () => {
    let invoked = false;
    const input = validInput() as unknown as Record<string, unknown>;
    Object.defineProperty(input, "createdAt", {
      enumerable: true,
      get() {
        invoked = true;
        return "2026-08-12T00:00:09.000Z";
      },
    });
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(
        input as unknown as BuildPostgresLogicalBackupV4SourceAuthorityReceiptInput,
      ),
      "receipt_invalid",
    );
    expect(invoked).toBe(false);

    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(
        new (class extends Object {})() as BuildPostgresLogicalBackupV4SourceAuthorityReceiptInput,
      ),
      "receipt_invalid",
    );

    let proxyTraps = 0;
    const proxied = new Proxy(validInput(), {
      getOwnPropertyDescriptor(target, property) {
        proxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceipt(proxied),
      "receipt_invalid",
    );
    expect(proxyTraps).toBe(0);
  });

  it("keeps the production module passive and independent of emitters, restore, and transports", () => {
    const source = fs.readFileSync(path.join(
      repositoryRoot,
      "src/lib/postgres-logical-backup-v4-source-authority.ts",
    ), "utf8");
    expect(source).not.toMatch(/from ["']node:(?:fs|child_process|net|tls|http|https)["']/);
    expect(source).not.toMatch(/from ["']pg["']/);
    expect(source).not.toMatch(/process\.env|fetch\s*\(|createPostgresLogicalBackup|restorePostgres/);
    expect(source).not.toContain("./postgres-logical-backup-v4.js");
    expect(source).not.toContain("./postgres-logical-backup.js");
    expect(source).not.toContain("./postgres-logical-restore.js");
  });
});
