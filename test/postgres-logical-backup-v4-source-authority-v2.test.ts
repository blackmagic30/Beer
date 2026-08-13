import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildPostgresLogicalBackupV4SourceAuthorityReceiptV2,
  canonicalPostgresLogicalBackupV4SourceAuthorityPolicyV2Json,
  canonicalPostgresLogicalBackupV4SourceAuthorityReceiptV2,
  parsePostgresLogicalBackupV4SourceAuthorityCompletionObservationV2,
  parsePostgresLogicalBackupV4SourceAuthorityReceiptV2,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CAPABILITY,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_RELATION_DISPOSITION_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_REQUIRED_EMPTY_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_RECEIPT_BYTES,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CLEANUP_RESERVE_MILLISECONDS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_DUMP_WATCHDOG_MILLISECONDS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_LIFETIME_SECONDS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_STATEMENT_TIMEOUT_MILLISECONDS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITION_SET_SHA256,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_RELATIONS,
  POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_SET_SHA256,
  postgresLogicalBackupV4SourceAuthorityReceiptV2Sha256,
  PostgresLogicalBackupV4SourceAuthorityV2Error,
  type BuildPostgresLogicalBackupV4SourceAuthorityReceiptV2Input,
  type PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2,
  type PostgresLogicalBackupV4SourceAuthorityReceiptV2,
} from "../src/lib/postgres-logical-backup-v4-source-authority-v2.js";
import {
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
} from "../src/lib/postgres-logical-backup-v4-table-data-contract.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right));
  return `{${entries.map(([key, entry]) => (
    `${JSON.stringify(key)}:${canonicalize(entry)}`
  )).join(",")}}`;
}

function canonicalJson(value: unknown): string {
  return `${canonicalize(value)}\n`;
}

function domainHash(kind: string, value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson({
    kind,
    version: 2,
    value,
  }), "utf8").digest("hex");
}

function validInput(): BuildPostgresLogicalBackupV4SourceAuthorityReceiptV2Input {
  const phases = [
    "provisioned", "detached-for-capture", "regranted-for-pg-dump", "cleaned-up",
  ] as const;
  const times = [
    "2026-08-12T00:00:00.000Z",
    "2026-08-12T00:00:01.000Z",
    "2026-08-12T00:00:02.000Z",
    "2026-08-12T00:00:03.000Z",
  ] as const;
  return {
    createdAt: times[3],
    sourceDatabaseOid: "12345",
    sourceDatabaseName: "pintpath_source",
    ephemeralLoginVersionToken: "202608120001",
    backupGroupClaimedRoleOid: "22345",
    ephemeralLoginClaimedRoleOid: "32345",
    claimedDatabaseIdentitySha256: hash("database-identity"),
    claimedSourceUrlSha256: hash("source-url"),
    claimedBackupGroupCatalogEvidenceSha256: hash("backup-group-catalog"),
    claimedEphemeralLoginCatalogEvidenceSha256: hash("ephemeral-login-catalog"),
    membershipClaims: phases.map((phase, index) => ({
      phase,
      claimedObservedAt: [
        "2026-08-12T00:00:00.100Z",
        "2026-08-12T00:00:00.300Z",
        "2026-08-12T00:00:00.700Z",
        "2026-08-12T00:00:03.000Z",
      ][index]!,
      claimedEvidenceSha256: hash(`membership-${phase}`),
    })) as BuildPostgresLogicalBackupV4SourceAuthorityReceiptV2Input["membershipClaims"],
    claimedSourceStateCaptureSha256: hash("source-state-capture"),
    claimedExportedSnapshotBindingSha256: hash("exported-snapshot-binding"),
    claimedPgDumpArgumentsBindingSha256: hash("pg-dump-arguments-binding"),
    claimedPgDumpExecutableSha256: hash("pg-dump-executable"),
    claimedPgRestoreExecutableSha256: hash("pg-restore-executable"),
    claimedArchiveSha256: hash("archive"),
    claimedArchiveListingSha256: hash("archive-listing"),
    claimedArchiveByteLength: 987_654,
  };
}

function validReceipt(): PostgresLogicalBackupV4SourceAuthorityReceiptV2 {
  return buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(validInput());
}

function expectCode(
  work: () => unknown,
  code: PostgresLogicalBackupV4SourceAuthorityV2Error["code"],
): void {
  let captured: unknown;
  try {
    work();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresLogicalBackupV4SourceAuthorityV2Error);
  expect(captured).toMatchObject({ code });
}

function receiptBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function rebindReceipt(value: unknown): Record<string, unknown> {
  const receipt = structuredClone(value) as Record<string, unknown>;
  delete receipt.receiptBindingSha256;
  receipt.receiptBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-source-archive-record",
    receipt,
  );
  return receipt;
}

function rebindCompletedReceipt(value: Record<string, unknown>): Record<string, unknown> {
  const completion = value.operationalCompletion as Record<string, unknown>;
  const authorityEvidence = completion.authorityEvidence as Record<string, unknown>;
  delete authorityEvidence.authorityEvidenceBindingSha256;
  authorityEvidence.authorityEvidenceBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-completed-authority-evidence",
    authorityEvidence,
  );
  const sessions = completion.sessions as Record<string, unknown>;
  delete sessions.sessionEvidenceBindingSha256;
  sessions.sessionEvidenceBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-completed-session-evidence",
    sessions,
  );
  const capture = completion.v2Capture as Record<string, unknown>;
  delete capture.captureBindingSha256;
  capture.captureBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-completed-v2-capture",
    capture,
  );
  const tools = completion.tools as Record<string, unknown>;
  delete tools.toolRuntimeBindingSha256;
  tools.toolRuntimeBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-tool-runtime-evidence",
    tools,
  );
  const custody = completion.archiveCustody as Record<string, unknown>;
  const tocProjection = {
    listingSha256: custody.listingSha256,
    listingByteLength: custody.listingByteLength,
    archiveCreatedAt: custody.archiveCreatedAt,
    databaseName: custody.databaseName,
    dumpedFromDatabaseVersion: custody.dumpedFromDatabaseVersion,
    dumpedByPgDumpVersion: custody.dumpedByPgDumpVersion,
    tocEntryCount: custody.tocEntryCount,
    tocTableDataEntryCount: custody.tocTableDataEntryCount,
    tocTableDataSetSha256: custody.tocTableDataSetSha256,
  };
  custody.tocEvidenceSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-strict-toc-semantic-evidence",
    tocProjection,
  );
  custody.tocBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-toc-evidence-binding",
    { ...tocProjection, tocEvidenceSha256: custody.tocEvidenceSha256 },
  );
  delete custody.archiveCustodyBindingSha256;
  custody.archiveCustodyBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-archive-custody-and-toc",
    custody,
  );
  delete completion.completionBindingSha256;
  completion.completionBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-operational-completion-evidence-projection",
    completion,
  );
  return rebindReceipt(value);
}

function completedReceipt(): PostgresLogicalBackupV4SourceAuthorityReceiptV2 & {
  operationalCompletion: PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2;
} {
  const pending = structuredClone(validReceipt()) as unknown as Record<string, unknown>;
  const source = pending.source as Record<string, unknown>;
  const authority = pending.authorityProjection as {
    backupGroup: Record<string, unknown>;
    ephemeralLogin: Record<string, unknown>;
  };
  const archiveClaims = pending.archiveClaims as Record<string, unknown>;
  const lifecycle = {
    startedAt: "2026-08-12T00:00:00.000Z",
    expiresAt: "2026-08-12T00:10:00.000Z",
    maxLifetimeSeconds: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_LIFETIME_SECONDS,
    serverClockObservedAt: "2026-08-12T00:00:00.000Z",
    serverClockEvidenceSha256: hash("server-clock"),
    loginValidUntil: "2026-08-12T00:10:00.000Z",
    loginProvisionedAt: "2026-08-12T00:00:00.100Z",
    sourceAuthenticatedAt: "2026-08-12T00:00:00.200Z",
    membershipDetachedAt: "2026-08-12T00:00:00.300Z",
    sourceTransactionBeganAt: "2026-08-12T00:00:00.400Z",
    v2CaptureCompletedAt: "2026-08-12T00:00:00.500Z",
    snapshotExportedAt: "2026-08-12T00:00:00.600Z",
    membershipRegrantedAt: "2026-08-12T00:00:00.700Z",
    pgDumpStartedAt: "2026-08-12T00:00:00.800Z",
    pgDumpAuthenticatedAt: "2026-08-12T00:00:00.850Z",
    pgDumpSnapshotImportedAt: "2026-08-12T00:00:00.900Z",
    pgDumpCompletedAt: "2026-08-12T00:00:01.000Z",
    archiveListedAt: "2026-08-12T00:00:01.100Z",
    sourceTransactionEndedAt: "2026-08-12T00:00:01.200Z",
    cleanupStartedAt: "2026-08-12T00:00:01.300Z",
    loginDisabledAt: "2026-08-12T00:00:01.400Z",
    loginDroppedAt: "2026-08-12T00:00:01.500Z",
    cleanupCompletedAt: "2026-08-12T00:00:03.000Z",
    pgDumpWatchdogMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_DUMP_WATCHDOG_MILLISECONDS,
    cleanupReserveMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CLEANUP_RESERVE_MILLISECONDS,
    absoluteDeadline: "2026-08-12T00:05:00.700Z",
    lifecycleEvidenceSha256: hash("lifecycle-evidence"),
  } as const;
  const sessionsWithoutBinding = {
    sourceSessionIdentitySha256: hash("source-session"),
    independentAdminSessionIdentitySha256: hash("independent-admin-session"),
    pgDumpSessionIdentitySha256: hash("pg-dump-session"),
    sourceSessionIdentityVerified: true as const,
    independentAdminSessionIdentityVerified: true as const,
    pgDumpSessionIdentityVerified: true as const,
    sourceScramAuthenticationVerified: true as const,
    pgDumpScramAuthenticationVerified: true as const,
    sourceAuthenticationEvidenceSha256: hash("source-scram-authentication"),
    pgDumpAuthenticationEvidenceSha256: hash("pg-dump-scram-authentication"),
    sourceAuthenticatedAt: lifecycle.sourceAuthenticatedAt,
    pgDumpAuthenticatedAt: lifecycle.pgDumpAuthenticatedAt,
    sourceDatabaseVersion: "17.6",
    sourceCurrentUserRoleName: authority.backupGroup.roleName as string,
    sourceSessionUserRoleName: authority.ephemeralLogin.roleName as string,
    pgDumpCurrentUserRoleName: authority.backupGroup.roleName as string,
    pgDumpSessionUserRoleName: authority.ephemeralLogin.roleName as string,
    sourceTransactionIsolation: "repeatable read" as const,
    sourceTransactionReadOnly: true as const,
    sourceStatementTimeoutMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_STATEMENT_TIMEOUT_MILLISECONDS,
    sourceIdleInTransactionSessionTimeoutMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS,
    sourceIdleSessionTimeoutMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS,
    sourceTransactionTimeoutMilliseconds:
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_SESSION_TIMEOUT_MILLISECONDS,
  };
  const sessions = {
    ...sessionsWithoutBinding,
    sessionEvidenceBindingSha256: domainHash(
      "pintpath-postgres-logical-backup-v4-completed-session-evidence",
      sessionsWithoutBinding,
    ),
  };
  const captureWithoutBinding = {
    sourceDatabaseOid: source.databaseOid as string,
    captureSha256: archiveClaims.claimedSourceStateCaptureSha256 as string,
    portableReadBoundarySha256: source.portableReadBoundarySha256 as string,
    sourcePhysicalReadBoundarySha256: hash("physical-read-boundary"),
    sourcePhysicalReadBoundaryClassification:
      "OID_OWNER_SENSITIVE_SELECTED_DATA_READ_SAFETY_EVIDENCE_ONLY" as const,
    overallStateSha256: hash("overall-state"),
    independentFullV2ValidationPerformed: true as const,
    v2ValidatorProfile: "pintpath-postgres-logical-state-v2-full-validator" as const,
    v2ValidatorVersion: 2 as const,
    v2ValidatorSourceSha256:
      "84634059f74f30299596838f9d45602d7d0624e17fce3c58edeb9b701359aa99" as const,
    independentLiveV2ValidatorBrandRequired: true as const,
    sameSourceSessionVerified: true as const,
    sourceSessionIdentitySha256: sessions.sourceSessionIdentitySha256,
    capturedAt: lifecycle.v2CaptureCompletedAt,
    captureSequence: 1 as const,
  };
  const v2Capture = {
    ...captureWithoutBinding,
    captureBindingSha256: domainHash(
      "pintpath-postgres-logical-backup-v4-completed-v2-capture",
      captureWithoutBinding,
    ),
  };
  const snapshotIdentifierSha256 = hash("raw-snapshot-identifier-never-persisted");
  const snapshotSemantic = {
    sourceDatabaseOid: source.databaseOid as string,
    databaseIdentitySha256: source.claimedDatabaseIdentitySha256 as string,
    sourceUrlSha256: source.claimedSourceUrlSha256 as string,
    effectiveRoleName: authority.backupGroup.roleName as string,
    snapshotIdentifierSha256,
  };
  const roleArgumentSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-pg-dump-role-argument",
    { argument: `--role=${authority.backupGroup.roleName}` },
  );
  const exportedSnapshotBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-exported-snapshot-binding",
    { ...snapshotSemantic, transactionIsolation: "repeatable read", transactionReadOnly: true },
  );
  archiveClaims.claimedExportedSnapshotBindingSha256 = exportedSnapshotBindingSha256;
  const pgDumpSnapshotSemanticBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-pg-dump-snapshot-semantic-binding",
    { snapshotIdentifierSha256 },
  );
  const semanticHandoffBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-snapshot-handoff-semantic-binding",
    {
      ...snapshotSemantic,
      exportedSnapshotBindingSha256,
      pgDumpSnapshotSemanticBindingSha256,
    },
  );
  const snapshotHandoff = {
    snapshotIdentifierSha256,
    rawSnapshotIdentifierPersisted: false as const,
    exportedAt: lifecycle.snapshotExportedAt,
    exportSequence: 2 as const,
    pgDumpImportedAt: lifecycle.pgDumpSnapshotImportedAt,
    sourceSessionIdentitySha256: sessions.sourceSessionIdentitySha256,
    pgDumpSessionIdentitySha256: sessions.pgDumpSessionIdentitySha256,
    roleArgumentSha256,
    exportedSnapshotBindingSha256,
    pgDumpSnapshotSemanticBindingSha256,
    semanticHandoffBindingSha256,
    sameSnapshotSemanticBindingVerified: true as const,
  };
  const pgDumpExactArgumentsSha256 = hash("exact-pg-dump-arguments");
  const pgDumpArgumentsBindingSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-pg-dump-arguments-binding",
    {
      pgDumpExactArgumentsSha256,
      roleArgumentSha256,
      pgDumpSnapshotSemanticBindingSha256,
      semanticHandoffBindingSha256,
    },
  );
  archiveClaims.claimedPgDumpArgumentsBindingSha256 = pgDumpArgumentsBindingSha256;
  const toolsWithoutBinding = {
    pgDumpExecutableSha256: archiveClaims.claimedPgDumpExecutableSha256 as string,
    pgDumpExecutableProvenanceVerified: true as const,
    pgDumpExecutableProvenanceEvidenceSha256: hash("pg-dump-provenance"),
    pgDumpNativeRuntimeClosureVerified: true as const,
    pgDumpNativeRuntimeClosureEvidenceSha256: hash("pg-dump-runtime-closure"),
    pgDumpVersion: "17.6",
    pgDumpVersionEvidenceSha256: hash("pg-dump-version"),
    pgDumpRuntimeEvidenceSha256: hash("pg-dump-runtime"),
    pgDumpExactArgumentsSha256,
    pgDumpArgumentsBindingSha256,
    pgDumpExitCode: 0 as const,
    pgDumpStdoutByteLength: 0 as const,
    pgDumpStderrByteLength: 0 as const,
    pgDumpRequireAuth: "scram-sha-256" as const,
    pgDumpDatabaseArgumentKind: "CANONICAL_DATABASE_IDENTIFIER" as const,
    pgRestoreExecutableSha256: archiveClaims.claimedPgRestoreExecutableSha256 as string,
    pgRestoreExecutableProvenanceVerified: true as const,
    pgRestoreExecutableProvenanceEvidenceSha256: hash("pg-restore-provenance"),
    pgRestoreNativeRuntimeClosureVerified: true as const,
    pgRestoreNativeRuntimeClosureEvidenceSha256: hash("pg-restore-runtime-closure"),
    pgRestoreVersion: "17.6",
    pgRestoreVersionEvidenceSha256: hash("pg-restore-version"),
    listRuntimeEvidenceSha256: hash("list-runtime"),
    listExactArgumentsSha256: hash("exact-list-arguments"),
    listArgumentsBindingSha256: domainHash(
      "pintpath-postgres-logical-backup-v4-list-arguments-binding",
      {
        listExactArgumentsSha256: hash("exact-list-arguments"),
        pgRestoreExecutableSha256: archiveClaims.claimedPgRestoreExecutableSha256,
        operation: "list-v4",
        stdoutMode: "raw",
      },
    ),
    listExitCode: 0 as const,
    listStderrByteLength: 0 as const,
    rawListingBytesPreserved: true as const,
  };
  const tools = {
    ...toolsWithoutBinding,
    toolRuntimeBindingSha256: domainHash(
      "pintpath-postgres-logical-backup-v4-tool-runtime-evidence",
      toolsWithoutBinding,
    ),
  };
  const archiveIdentityBeforeSha256 = hash("archive-stable-identity");
  const stableIdentityProjection = {
    archiveIdentityBeforeSha256,
    archiveIdentityBeforeDigestSha256: archiveIdentityBeforeSha256,
    archiveIdentityAfterDigestSha256: archiveIdentityBeforeSha256,
    archiveIdentityBeforeListingSha256: archiveIdentityBeforeSha256,
    archiveIdentityAfterListingSha256: archiveIdentityBeforeSha256,
    archiveIdentityAfterSha256: archiveIdentityBeforeSha256,
    archiveByteLength: archiveClaims.claimedArchiveByteLength as number,
    dumpAndListUsedSameRetainedArchiveDescriptor: true as const,
  };
  const tocProjection = {
    listingSha256: archiveClaims.claimedArchiveListingSha256 as string,
    listingByteLength: 12_345,
    archiveCreatedAt: "2026-08-12 00:00:01 UTC",
    databaseName: source.databaseName as string,
    dumpedFromDatabaseVersion: sessions.sourceDatabaseVersion,
    dumpedByPgDumpVersion: toolsWithoutBinding.pgDumpVersion,
    tocEntryCount: 63 as const,
    tocTableDataEntryCount: 59 as const,
    tocTableDataSetSha256: POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
  };
  const tocEvidenceSha256 = domainHash(
    "pintpath-postgres-logical-backup-v4-strict-toc-semantic-evidence",
    tocProjection,
  );
  const custodyWithoutBinding = {
    archiveSha256: archiveClaims.claimedArchiveSha256 as string,
    archiveByteLength: archiveClaims.claimedArchiveByteLength as number,
    archiveIdentityBeforeSha256,
    archiveIdentityBeforeDigestSha256: archiveIdentityBeforeSha256,
    archiveIdentityAfterDigestSha256: archiveIdentityBeforeSha256,
    archiveIdentityBeforeListingSha256: archiveIdentityBeforeSha256,
    archiveIdentityAfterListingSha256: archiveIdentityBeforeSha256,
    archiveIdentityAfterSha256: archiveIdentityBeforeSha256,
    stableArchiveIdentitySha256: domainHash(
      "pintpath-postgres-logical-backup-v4-stable-archive-identity",
      stableIdentityProjection,
    ),
    archiveIdentityStable: true as const,
    dumpAndListUsedSameRetainedArchiveDescriptor: true as const,
    ...tocProjection,
    tocEvidenceSha256,
    tocBindingSha256: domainHash(
      "pintpath-postgres-logical-backup-v4-toc-evidence-binding",
      { ...tocProjection, tocEvidenceSha256 },
    ),
    strictTocParserValidationPerformed: true as const,
    strictTocParserProfile:
      "pintpath-postgres-logical-backup-v4-strict-toc-parser" as const,
    strictTocParserVersion: 1 as const,
    strictTocParserSourceSha256:
      "996bd6190a4680346a65dacfe05a6f97bef90586a9d269d38a9cfb626bf55c5f" as const,
    independentStrictTocParserBrandRequired: true as const,
    rawListingHashMatchesTocEvidence: true as const,
  };
  const archiveCustody = {
    ...custodyWithoutBinding,
    archiveCustodyBindingSha256: domainHash(
      "pintpath-postgres-logical-backup-v4-archive-custody-and-toc",
      custodyWithoutBinding,
    ),
  };
  const completionWithoutBinding = {
    state: "COMPLETED_EVIDENCE_PROJECTION" as const,
    completed: true as const,
    independentLiveRecorderBrandRequired: true as const,
    independentLiveRecorderBrandSerialized: false as const,
    serializedCompletionObservationOnly: true as const,
    completionObservationVerifiedByThisModule: false as const,
    passivePolicyRecordSha256: pending.policySha256 as string,
    authorityEvidence: (() => {
      const withoutBinding = {
        backupGroupCatalogProjectionVerified: true as const,
        ephemeralLoginCatalogProjectionVerified: true as const,
        membershipCeremonyVerified: true as const,
        authorityProjectionSha256: (
          pending.authorityProjection as Record<string, unknown>
        ).authorityProjectionSha256 as string,
        membershipCeremonyBindingSha256: (
          pending.membershipCeremony as Record<string, unknown>
        ).ceremonyBindingSha256 as string,
        backupGroupCatalogEvidenceSha256:
          authority.backupGroup.claimedCatalogEvidenceSha256 as string,
        ephemeralLoginCatalogEvidenceSha256:
          authority.ephemeralLogin.claimedCatalogEvidenceSha256 as string,
        ephemeralLoginValidUntil: lifecycle.expiresAt,
      };
      return {
        ...withoutBinding,
        authorityEvidenceBindingSha256: domainHash(
          "pintpath-postgres-logical-backup-v4-completed-authority-evidence",
          withoutBinding,
        ),
      };
    })(),
    lifecycle,
    sessions,
    v2Capture,
    snapshotHandoff,
    tools,
    archiveCustody,
    cleanup: {
      membershipRevoked: true as const,
      exactSetOnlyMembershipCount: 0 as const,
      loginDisabledNoLogin: true as const,
      loginDropped: true as const,
      backendTerminationAttempted: true as const,
      terminatedBackendCount: 2,
      activeSessionCount: 0 as const,
      cleanupEvidenceSha256: hash("cleanup-evidence"),
      cleanupComplete: true as const,
    },
  };
  pending.operationalCompletion = {
    ...completionWithoutBinding,
    completionBindingSha256: domainHash(
      "pintpath-postgres-logical-backup-v4-operational-completion-evidence-projection",
      completionWithoutBinding,
    ),
  };
  return rebindReceipt(pending) as unknown as
    PostgresLogicalBackupV4SourceAuthorityReceiptV2 & {
      operationalCompletion: PostgresLogicalBackupV4SourceAuthorityCompletedEvidenceV2;
    };
}

describe("PostgreSQL logical-backup V4 passive source-authority V2", () => {
  it("freezes exact selected-data, empty-kernel, RLS, policy, and portable-boundary authority", () => {
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_CAPABILITY).toEqual({
      implementationState: "PASSIVE_RECORD_FOUNDATION_ONLY",
      databaseAccessImplemented: false,
      roleProvisioningImplemented: false,
      roleCatalogObservationImplemented: false,
      membershipCeremonyImplemented: false,
      effectiveTargetOnlyDatabaseAccessRequired: false,
      effectiveTargetOnlyDatabaseAccessVerified: false,
      completeRoleGraphVerified: false,
      sourceSnapshotExportImplemented: false,
      pgDumpHandoffImplemented: false,
      operationalCompletionRecorderImplemented: false,
      completedEvidenceProjectionParsableAsUnverifiedObservation: true,
      independentLiveRecorderBrandRequired: true,
      independentLiveRecorderBrandSerialized: false,
      callerEvidenceVerifiedByThisModule: false,
      operationalSourceAuthorityImplemented: false,
      sourceAuthorityGranted: false,
      archiveContentAuthorityGranted: false,
      serializedReceiptIsAuthority: false,
      artifactEmissionAuthorized: false,
      activationAuthorized: false,
      productionCutoverAuthorized: false,
    });
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS)
      .toHaveLength(61);
    expect(new Set(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS
      .map((relation) => relation.qualifiedRelation)).size).toBe(61);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS
      .map((relation) => relation.qualifiedRelation)).toEqual(
      [...POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS]
        .map((relation) => relation.qualifiedRelation).sort(compareText),
    );
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS
      .filter((relation) => relation.disposition === "ARCHIVED_TABLE_DATA")).toHaveLength(59);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS
      .filter((relation) => relation.disposition === "REQUIRED_EMPTY_NOT_ARCHIVED")
      .map((relation) => relation.qualifiedRelation)).toEqual([
      "pintpath_ops.reviewed_price_promotion_operations",
      "pintpath_ops.reviewed_price_promotion_rows",
    ]);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_RELATIONS)
      .toEqual([
        "pintpath_ops.reviewed_price_promotion_operations",
        "pintpath_ops.reviewed_price_promotion_rows",
      ]);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS.every(
      (relation) => relation.rowSecurityRequired && relation.forceRowSecurityRequired,
    )).toBe(true);

    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS)
      .toHaveLength(240);
    expect(new Set(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS
      .map((policy) => `${policy.qualifiedRelation}\u0000${policy.policyName}`)).size).toBe(240);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS
      .filter((policy) => policy.classification === "LOGICAL_BACKUP_SELECT"))
      .toHaveLength(61);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS
      .filter((policy) => policy.classification === "REVIEWED_OTHER"))
      .toHaveLength(179);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS.map(
      (policy) => `${policy.qualifiedRelation}\u0000${policy.policyName}`,
    )).toEqual([...POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS]
      .map((policy) => `${policy.qualifiedRelation}\u0000${policy.policyName}`).sort(compareText));

    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITION_SET_SHA256)
      .toBe(domainHash(
        "pintpath-postgres-logical-backup-v4-source-relation-disposition-set",
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITIONS,
      ));
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_SET_SHA256)
      .toBe(domainHash(
        "pintpath-postgres-logical-backup-v4-required-empty-relation-set",
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_RELATIONS,
      ));
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SET_SHA256)
      .toBe(domainHash(
        "pintpath-postgres-logical-backup-v4-source-policy-set",
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS,
      ));
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_RELATION_DISPOSITION_SET_SHA256)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_RELATION_DISPOSITION_SET_SHA256);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_REQUIRED_EMPTY_SET_SHA256)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_REQUIRED_EMPTY_SET_SHA256);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SET_SHA256)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SET_SHA256);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SHA256)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SHA256);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_EXPECTED_POLICY_SHA256)
      .toBe("a1cc7679f3ae2765e0449242467c93039e88d435acb691d66e3a25d74329b282");
    expect(hash(canonicalPostgresLogicalBackupV4SourceAuthorityPolicyV2Json()))
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_SHA256);
    expect(crypto.createHash("sha256").update(canonicalJson({
      kind: "pintpath-postgres-logical-backup-table-data-set",
      version: 1,
      entries: POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
    })).digest("hex")).toBe(POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256);
    expect(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY).toMatchObject({
      selectedData: {
        archivedRelations: 59,
        requiredEmptyKernelRelations: 2,
        totalSourceRelations: 61,
        portableReadBoundarySha256:
          "a0710c86bde835f493d189f2195ebfc07252bc8cf6ffa87d930a8201328f7abd",
        exactArchivedRelationSelectAclCountForBackupGroup: 59,
        exactRequiredEmptyKernelRelationSelectAclCountForBackupGroup: 2,
        exactTotalRelationSelectAclCountForBackupGroup: 61,
      },
      rowSecurity: {
        exactRlsEnabledRelationCount: 61,
        exactForceRlsRelationCount: 61,
        exactLogicalBackupSelectPolicyCount: 61,
        exactReviewedOtherPolicyCount: 179,
        exactTotalPolicyCount: 240,
      },
      authorization: {
        recordClassification: "CANONICAL_SOURCE_ARCHIVE_RECORD_ONLY",
        serializedReceiptIsAuthority: false,
        sourceAuthorityGranted: false,
      },
    });
    expect(Object.isFrozen(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY)).toBe(true);
    expect(Object.isFrozen(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS[0]))
      .toBe(true);
  });

  it("builds, canonically round-trips, hashes, and freezes only a non-authorizing archive record", () => {
    const receipt = validReceipt();
    expect(receipt.classification).toBe("CANONICAL_SOURCE_ARCHIVE_RECORD_ONLY");
    expect(receipt.source).toEqual({
      databaseOid: "12345",
      databaseName: "pintpath_source",
      claimedDatabaseIdentitySha256: hash("database-identity"),
      claimedSourceUrlSha256: hash("source-url"),
      portableReadBoundarySha256:
        "a0710c86bde835f493d189f2195ebfc07252bc8cf6ffa87d930a8201328f7abd",
    });
    expect(receipt.authorityProjection.backupGroup).toMatchObject({
      roleName: "pintpath_logical_backup_d12345",
      claimedRoleOid: "22345",
      login: false,
      inherit: false,
      connectionLimit: -1,
      validUntil: null,
      expectedSchemaUsageAclCount: 2,
      expectedArchivedRelationSelectAclCount: 59,
      expectedRequiredEmptyKernelSelectAclCount: 2,
      expectedTotalRelationSelectAclCount: 61,
      expectedSharedDependencyCount: 63,
      expectedMembershipsGrantedCount: 0,
      expectedMembershipsReceivedCount: 0,
      expectedRoleSettingCount: 0,
      expectedRelationWriteAclCount: 0,
    });
    expect(receipt.authorityProjection.ephemeralLogin).toMatchObject({
      roleName: "pintpath_logical_backup_d12345_v202608120001",
      claimedRoleOid: "32345",
      login: true,
      inherit: false,
      connectionLimit: 2,
      validUntilRequired: true,
      validUntilBoundToLifecycleAtCompletion: true,
      passwordVerifierFormatRequired: "scram-sha-256",
      expectedDirectTargetDatabaseConnectAclCount: 1,
      expectedSharedDependencyCount: 1,
      effectiveTargetOnlyDatabaseAccessRequired: false,
      effectiveTargetOnlyDatabaseAccessVerified: false,
      completeRoleGraphVerified: false,
    });
    expect(receipt.membershipCeremony.transitions.map((transition) => [
      transition.phase,
      transition.expectedBackupGroupChildMembershipCount,
      transition.expectedLoginParentMembershipCount,
      transition.expectedExactSetOnlyMembershipCount,
    ])).toEqual([
      ["provisioned", 1, 1, 1],
      ["detached-for-capture", 0, 0, 0],
      ["regranted-for-pg-dump", 1, 1, 1],
      ["cleaned-up", 0, 0, 0],
    ]);
    expect(receipt.evidenceSemantics).toEqual({
      allCallerEvidenceHashesAreUnverifiedClaims: true,
      callerEvidenceVerifiedByThisModule: false,
      serializedReceiptIsAuthority: false,
      operationalSourceAuthorityImplemented: false,
      sourceAuthorityGranted: false,
      archiveContentAuthorityGranted: false,
      artifactEmissionAuthorized: false,
      activationAuthorized: false,
      productionCutoverAuthorized: false,
    });
    expect(receipt.operationalCompletion).toMatchObject({
      state: "PENDING_LIVE_RECORDER",
      completed: false,
      pendingReason: "PASSIVE_BUILDER_CANNOT_VERIFY_LIVE_EVIDENCE",
      independentLiveRecorderBrandRequired: true,
      independentLiveRecorderBrandSerialized: false,
      completionObservationVerifiedByThisModule: false,
    });

    const authorityProjection = structuredClone(receipt.authorityProjection) as unknown as
      Record<string, unknown>;
    const authorityProjectionSha256 = authorityProjection.authorityProjectionSha256;
    delete authorityProjection.authorityProjectionSha256;
    expect(authorityProjectionSha256).toBe(domainHash(
      "pintpath-postgres-logical-backup-v4-source-authority-projection",
      authorityProjection,
    ));
    for (const transition of receipt.membershipCeremony.transitions) {
      const withoutBinding = structuredClone(transition) as unknown as Record<string, unknown>;
      const binding = withoutBinding.transitionBindingSha256;
      delete withoutBinding.transitionBindingSha256;
      expect(binding).toBe(domainHash(
        "pintpath-postgres-logical-backup-v4-membership-transition",
        withoutBinding,
      ));
    }
    expect(receipt.membershipCeremony.ceremonyBindingSha256).toBe(domainHash(
      "pintpath-postgres-logical-backup-v4-membership-ceremony",
      {
        expectedSetOnlyMembershipCountSequence: [1, 0, 1, 0],
        transitions: receipt.membershipCeremony.transitions,
      },
    ));
    const withoutReceiptBinding = structuredClone(receipt) as unknown as Record<string, unknown>;
    const receiptBindingSha256 = withoutReceiptBinding.receiptBindingSha256;
    delete withoutReceiptBinding.receiptBindingSha256;
    expect(receiptBindingSha256).toBe(domainHash(
      "pintpath-postgres-logical-backup-v4-source-archive-record",
      withoutReceiptBinding,
    ));

    const canonical = canonicalPostgresLogicalBackupV4SourceAuthorityReceiptV2(receipt);
    expect(canonical.length).toBeLessThan(
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_RECEIPT_BYTES,
    );
    expect(canonical.at(-1)).toBe(0x0a);
    expect(postgresLogicalBackupV4SourceAuthorityReceiptV2Sha256(receipt))
      .toBe(crypto.createHash("sha256").update(canonical).digest("hex"));
    const parsed = parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(canonical);
    expect(parsed).toEqual(receipt);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.authorityProjection.backupGroup)).toBe(true);
    expect(Object.isFrozen(parsed.membershipCeremony.transitions[0])).toBe(true);
  });

  it("durably validates a completed evidence projection only as an unverified observation", () => {
    const completed = completedReceipt();
    const canonical = canonicalPostgresLogicalBackupV4SourceAuthorityReceiptV2(completed);
    const parsed = parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(canonical);
    expect(parsed.operationalCompletion).toMatchObject({
      state: "COMPLETED_EVIDENCE_PROJECTION",
      completed: true,
      independentLiveRecorderBrandSerialized: false,
      serializedCompletionObservationOnly: true,
      completionObservationVerifiedByThisModule: false,
      lifecycle: {
        maxLifetimeSeconds: 600,
        pgDumpWatchdogMilliseconds: 300_000,
        cleanupReserveMilliseconds: 120_000,
      },
      sessions: {
        sourceSessionIdentityVerified: true,
        pgDumpSessionIdentityVerified: true,
        sourceScramAuthenticationVerified: true,
        pgDumpScramAuthenticationVerified: true,
        sourceTransactionIsolation: "repeatable read",
        sourceTransactionReadOnly: true,
      },
      v2Capture: {
        independentFullV2ValidationPerformed: true,
        sourcePhysicalReadBoundaryClassification:
          "OID_OWNER_SENSITIVE_SELECTED_DATA_READ_SAFETY_EVIDENCE_ONLY",
        v2ValidatorProfile: "pintpath-postgres-logical-state-v2-full-validator",
        v2ValidatorVersion: 2,
        independentLiveV2ValidatorBrandRequired: true,
        sameSourceSessionVerified: true,
        captureSequence: 1,
      },
      snapshotHandoff: {
        rawSnapshotIdentifierPersisted: false,
        exportSequence: 2,
        sameSnapshotSemanticBindingVerified: true,
      },
      tools: {
        pgDumpExecutableProvenanceVerified: true,
        pgDumpNativeRuntimeClosureVerified: true,
        pgRestoreExecutableProvenanceVerified: true,
        pgRestoreNativeRuntimeClosureVerified: true,
        pgDumpExitCode: 0,
        pgDumpStdoutByteLength: 0,
        pgDumpStderrByteLength: 0,
        pgDumpRequireAuth: "scram-sha-256",
        listExitCode: 0,
        listStderrByteLength: 0,
        rawListingBytesPreserved: true,
      },
      archiveCustody: {
        archiveIdentityStable: true,
        dumpAndListUsedSameRetainedArchiveDescriptor: true,
        databaseName: "pintpath_source",
        dumpedFromDatabaseVersion: "17.6",
        dumpedByPgDumpVersion: "17.6",
        tocEntryCount: 63,
        tocTableDataEntryCount: 59,
        rawListingHashMatchesTocEvidence: true,
        strictTocParserValidationPerformed: true,
        strictTocParserProfile:
          "pintpath-postgres-logical-backup-v4-strict-toc-parser",
        strictTocParserVersion: 1,
        independentStrictTocParserBrandRequired: true,
      },
      cleanup: {
        membershipRevoked: true,
        exactSetOnlyMembershipCount: 0,
        loginDisabledNoLogin: true,
        loginDropped: true,
        backendTerminationAttempted: true,
        activeSessionCount: 0,
        cleanupComplete: true,
      },
    });
    if (parsed.operationalCompletion.state !== "COMPLETED_EVIDENCE_PROJECTION") {
      throw new Error("completed_projection_expected");
    }
    const completedEvidence = parsed.operationalCompletion;
    expect(completedEvidence.authorityEvidence.ephemeralLoginValidUntil)
      .toBe(completedEvidence.lifecycle.expiresAt);
    expect([
      completedEvidence.lifecycle.pgDumpStartedAt,
      completedEvidence.lifecycle.pgDumpAuthenticatedAt,
      completedEvidence.lifecycle.pgDumpSnapshotImportedAt,
      completedEvidence.lifecycle.pgDumpCompletedAt,
    ].map(Date.parse)).toEqual([...[
      completedEvidence.lifecycle.pgDumpStartedAt,
      completedEvidence.lifecycle.pgDumpAuthenticatedAt,
      completedEvidence.lifecycle.pgDumpSnapshotImportedAt,
      completedEvidence.lifecycle.pgDumpCompletedAt,
    ].map(Date.parse)].sort((left, right) => left - right));
    const toc = completedEvidence.archiveCustody;
    expect(toc.tocEvidenceSha256).toBe(domainHash(
      "pintpath-postgres-logical-backup-v4-strict-toc-semantic-evidence",
      {
        listingSha256: toc.listingSha256,
        listingByteLength: toc.listingByteLength,
        archiveCreatedAt: toc.archiveCreatedAt,
        databaseName: toc.databaseName,
        dumpedFromDatabaseVersion: toc.dumpedFromDatabaseVersion,
        dumpedByPgDumpVersion: toc.dumpedByPgDumpVersion,
        tocEntryCount: 63,
        tocTableDataEntryCount: 59,
        tocTableDataSetSha256: POSTGRES_LOGICAL_BACKUP_V4_TABLE_SET_SHA256,
      },
    ));
    expect(toc.databaseName).toBe(parsed.source.databaseName);
    expect(toc.dumpedFromDatabaseVersion).toBe(completedEvidence.sessions.sourceDatabaseVersion);
    expect(toc.dumpedByPgDumpVersion).toBe(completedEvidence.tools.pgDumpVersion);
    const observation =
      parsePostgresLogicalBackupV4SourceAuthorityCompletionObservationV2(canonical);
    expect(observation).toMatchObject({
      classification: "UNVERIFIED_SERIALIZED_COMPLETION_OBSERVATION",
      completedEvidenceShapeValid: true,
      selfDerivedBindingsRecomputed: true,
      independentLiveRecorderBrandPresent: false,
      serializedObservationIsAuthority: false,
      sourceAuthorityGranted: false,
      archiveContentAuthorityGranted: false,
      artifactEmissionAuthorized: false,
      activationAuthorized: false,
      productionCutoverAuthorized: false,
    });
    expect(observation.receipt).toEqual(parsed);
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it("cannot upgrade a pending record by toggling/rebinding and requires expiry, sessions, and cleanup in completed shape", () => {
    const pendingUpgrade = structuredClone(validReceipt()) as unknown as Record<string, unknown>;
    const pendingCompletion = pendingUpgrade.operationalCompletion as Record<string, unknown>;
    pendingCompletion.state = "COMPLETED_EVIDENCE_PROJECTION";
    pendingCompletion.completed = true;
    delete pendingCompletion.completionBindingSha256;
    pendingCompletion.completionBindingSha256 = domainHash(
      "pintpath-postgres-logical-backup-v4-operational-completion-evidence-projection",
      pendingCompletion,
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(
        receiptBytes(rebindReceipt(pendingUpgrade)),
      ),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityCompletionObservationV2(
        canonicalPostgresLogicalBackupV4SourceAuthorityReceiptV2(validReceipt()),
      ),
      "receipt_invalid",
    );

    const completedMutators: Array<(receipt: Record<string, unknown>) => void> = [
      (receipt) => {
        const lifecycle = (receipt.operationalCompletion as Record<string, unknown>)
          .lifecycle as Record<string, unknown>;
        lifecycle.loginValidUntil = "2026-08-12T00:09:59.999Z";
      },
      (receipt) => {
        const lifecycle = (receipt.operationalCompletion as Record<string, unknown>)
          .lifecycle as Record<string, unknown>;
        lifecycle.absoluteDeadline = "2026-08-12T00:05:00.701Z";
      },
      (receipt) => {
        const ceremony = receipt.membershipCeremony as {
          transitions: Array<Record<string, unknown>>;
        };
        ceremony.transitions[1]!.claimedObservedAt = "2026-08-12T00:00:00.301Z";
      },
      (receipt) => {
        const sessions = (receipt.operationalCompletion as Record<string, unknown>)
          .sessions as Record<string, unknown>;
        sessions.pgDumpScramAuthenticationVerified = false;
      },
      (receipt) => {
        const sessions = (receipt.operationalCompletion as Record<string, unknown>)
          .sessions as Record<string, unknown>;
        sessions.pgDumpSessionIdentitySha256 = sessions.sourceSessionIdentitySha256;
      },
      (receipt) => {
        const cleanup = (receipt.operationalCompletion as Record<string, unknown>)
          .cleanup as Record<string, unknown>;
        cleanup.loginDisabledNoLogin = false;
      },
      (receipt) => {
        const cleanup = (receipt.operationalCompletion as Record<string, unknown>)
          .cleanup as Record<string, unknown>;
        cleanup.activeSessionCount = 1;
      },
      (receipt) => {
        const custody = (receipt.operationalCompletion as Record<string, unknown>)
          .archiveCustody as Record<string, unknown>;
        custody.archiveIdentityAfterSha256 = hash("changed-identity");
      },
      (receipt) => {
        const custody = (receipt.operationalCompletion as Record<string, unknown>)
          .archiveCustody as Record<string, unknown>;
        custody.dumpAndListUsedSameRetainedArchiveDescriptor = false;
      },
      (receipt) => {
        const tools = (receipt.operationalCompletion as Record<string, unknown>)
          .tools as Record<string, unknown>;
        tools.pgDumpNativeRuntimeClosureVerified = false;
      },
    ];
    for (const mutate of completedMutators) {
      const forged = structuredClone(completedReceipt()) as unknown as Record<string, unknown>;
      mutate(forged);
      const ceremony = forged.membershipCeremony as {
        transitions: Array<Record<string, unknown>>;
      };
      if (ceremony.transitions) {
        for (const transition of ceremony.transitions) {
          if (!transition.transitionBindingSha256) continue;
          delete transition.transitionBindingSha256;
          transition.transitionBindingSha256 = domainHash(
            "pintpath-postgres-logical-backup-v4-membership-transition",
            transition,
          );
        }
        const ceremonyRecord = forged.membershipCeremony as Record<string, unknown>;
        delete ceremonyRecord.ceremonyBindingSha256;
        ceremonyRecord.ceremonyBindingSha256 = domainHash(
          "pintpath-postgres-logical-backup-v4-membership-ceremony",
          {
            expectedSetOnlyMembershipCountSequence: [1, 0, 1, 0],
            transitions: ceremony.transitions,
          },
        );
      }
      const completion = forged.operationalCompletion as Record<string, unknown>;
      delete completion.completionBindingSha256;
      completion.completionBindingSha256 = domainHash(
        "pintpath-postgres-logical-backup-v4-operational-completion-evidence-projection",
        completion,
      );
      expectCode(
        () => parsePostgresLogicalBackupV4SourceAuthorityCompletionObservationV2(
          receiptBytes(rebindReceipt(forged)),
        ),
        "receipt_invalid",
      );
    }
  });

  it("rejects self-rebound source, lifecycle, tool, and strict-TOC semantic forgeries", () => {
    const semanticMutators: Array<(receipt: Record<string, unknown>) => void> = [
      (receipt) => {
        (receipt.source as Record<string, unknown>).databaseName = "wrong_database";
      },
      (receipt) => {
        const completion = receipt.operationalCompletion as Record<string, unknown>;
        const authorityEvidence = completion.authorityEvidence as Record<string, unknown>;
        authorityEvidence.ephemeralLoginValidUntil = "2026-08-12T00:09:59.999Z";
      },
      (receipt) => {
        const lifecycle = (receipt.operationalCompletion as Record<string, unknown>)
          .lifecycle as Record<string, unknown>;
        lifecycle.pgDumpAuthenticatedAt = "2026-08-12T00:00:00.799Z";
      },
      (receipt) => {
        const handoff = (receipt.operationalCompletion as Record<string, unknown>)
          .snapshotHandoff as Record<string, unknown>;
        handoff.pgDumpImportedAt = "2026-08-12T00:00:00.901Z";
      },
      (receipt) => {
        const completion = receipt.operationalCompletion as Record<string, unknown>;
        const lifecycle = completion.lifecycle as Record<string, unknown>;
        lifecycle.pgDumpSnapshotImportedAt = "2026-08-12T00:00:00.849Z";
        (completion.snapshotHandoff as Record<string, unknown>).pgDumpImportedAt =
          lifecycle.pgDumpSnapshotImportedAt;
      },
      (receipt) => {
        const tools = (receipt.operationalCompletion as Record<string, unknown>)
          .tools as Record<string, unknown>;
        tools.pgDumpStdoutByteLength = 1;
      },
      (receipt) => {
        const capture = (receipt.operationalCompletion as Record<string, unknown>)
          .v2Capture as Record<string, unknown>;
        capture.sourcePhysicalReadBoundaryClassification = "COMPLETE_PHYSICAL_SCHEMA";
      },
      (receipt) => {
        const custody = (receipt.operationalCompletion as Record<string, unknown>)
          .archiveCustody as Record<string, unknown>;
        custody.databaseName = "wrong_database";
      },
      (receipt) => {
        const custody = (receipt.operationalCompletion as Record<string, unknown>)
          .archiveCustody as Record<string, unknown>;
        custody.dumpedFromDatabaseVersion = "17.7";
      },
      (receipt) => {
        const custody = (receipt.operationalCompletion as Record<string, unknown>)
          .archiveCustody as Record<string, unknown>;
        custody.dumpedByPgDumpVersion = "17.7";
      },
      (receipt) => {
        const custody = (receipt.operationalCompletion as Record<string, unknown>)
          .archiveCustody as Record<string, unknown>;
        custody.archiveCreatedAt = "not-a-strict-toc-instant";
      },
    ];
    for (const mutate of semanticMutators) {
      const forged = structuredClone(completedReceipt()) as unknown as Record<string, unknown>;
      mutate(forged);
      expectCode(
        () => parsePostgresLogicalBackupV4SourceAuthorityCompletionObservationV2(
          receiptBytes(rebindCompletedReceipt(forged)),
        ),
        "receipt_invalid",
      );
    }
  });

  it("rejects the current V1 receipt shape without importing or modifying V1", () => {
    const currentV1 = {
      kind: "pintpath-postgres-logical-backup-source-authority",
      version: 1,
      activationAuthorized: false,
    };
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(currentV1),
      "receipt_v1_rejected",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(receiptBytes(currentV1)),
      "receipt_v1_rejected",
    );
  });

  it("rejects every re-bound derivational-hash forgery while treating changed claims only as claims", () => {
    const base = validReceipt();
    const derivationMutators: Array<(receipt: Record<string, unknown>) => void> = [
      (receipt) => {
        const authority = receipt.authorityProjection as Record<string, unknown>;
        authority.authorityProjectionSha256 = hash("forged-authority-projection");
      },
      ...([0, 1, 2, 3] as const).map((index) => (receipt: Record<string, unknown>) => {
        const ceremony = receipt.membershipCeremony as {
          transitions: Array<Record<string, unknown>>;
        };
        ceremony.transitions[index]!.transitionBindingSha256 = hash(`forged-${index}`);
        (receipt.membershipCeremony as Record<string, unknown>).ceremonyBindingSha256 = domainHash(
          "pintpath-postgres-logical-backup-v4-membership-ceremony",
          {
            expectedSetOnlyMembershipCountSequence: [1, 0, 1, 0],
            transitions: ceremony.transitions,
          },
        );
      }),
      (receipt) => {
        (receipt.membershipCeremony as Record<string, unknown>).ceremonyBindingSha256 =
          hash("forged-ceremony");
      },
    ];
    for (const mutate of derivationMutators) {
      const forged = structuredClone(base) as unknown as Record<string, unknown>;
      mutate(forged);
      expectCode(
        () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(
          receiptBytes(rebindReceipt(forged)),
        ),
        "receipt_invalid",
      );
    }
    const receiptBindingForgery = structuredClone(base) as unknown as Record<string, unknown>;
    receiptBindingForgery.receiptBindingSha256 = hash("forged-receipt-binding");
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(
        receiptBytes(receiptBindingForgery),
      ),
      "receipt_invalid",
    );

    const staticHashPaths = [
      ["policySha256"],
      ["selectedData", "archivedTableSetSha256"],
      ["selectedData", "relationDispositionSetSha256"],
      ["selectedData", "requiredEmptyRelationSetSha256"],
      ["selectedData", "policySetSha256"],
    ] as const;
    for (const pathParts of staticHashPaths) {
      const forged = structuredClone(base) as unknown as Record<string, unknown>;
      let target = forged;
      for (const key of pathParts.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[pathParts.at(-1)!] = hash(`forged-${pathParts.join("-")}`);
      expectCode(
        () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(
          receiptBytes(rebindReceipt(forged)),
        ),
        "receipt_invalid",
      );
    }

    const changedClaim = structuredClone(validInput());
    changedClaim.claimedArchiveSha256 = hash("different-unverified-archive-claim");
    const changedRecord = buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(changedClaim);
    expect(changedRecord.archiveClaims.claimedArchiveSha256)
      .toBe(hash("different-unverified-archive-claim"));
    expect(changedRecord.evidenceSemantics.callerEvidenceVerifiedByThisModule).toBe(false);
    expect(changedRecord.evidenceSemantics.archiveContentAuthorityGranted).toBe(false);
  });

  it("rejects extra, missing, duplicate, reordered, and invalid role or ceremony data", () => {
    const extra = { ...validInput(), extra: false };
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(extra),
      "receipt_invalid",
    );

    const missing = structuredClone(validInput()) as Record<string, unknown>;
    delete missing.claimedArchiveListingSha256;
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(missing),
      "receipt_invalid",
    );

    const duplicatePhase = structuredClone(validInput());
    duplicatePhase.membershipClaims[1].phase = "provisioned";
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(duplicatePhase),
      "receipt_invalid",
    );

    const reversedTime = structuredClone(validInput());
    reversedTime.membershipClaims[2].claimedObservedAt = "2026-08-11T23:59:59.000Z";
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(reversedTime),
      "receipt_invalid",
    );

    const reusedRoleOid = structuredClone(validInput());
    reusedRoleOid.ephemeralLoginClaimedRoleOid = reusedRoleOid.backupGroupClaimedRoleOid;
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(reusedRoleOid),
      "receipt_invalid",
    );

    for (const databaseName of ["", "bad/name", "x".repeat(64)]) {
      const invalidDatabaseName = structuredClone(validInput());
      invalidDatabaseName.sourceDatabaseName = databaseName;
      expectCode(
        () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(invalidDatabaseName),
        "receipt_invalid",
      );
    }

    const canonical = canonicalPostgresLogicalBackupV4SourceAuthorityReceiptV2(validReceipt())
      .toString("utf8");
    const duplicateKey = `{"kind":"pintpath-postgres-logical-backup-source-authority",${canonical.slice(1)}`;
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(Buffer.from(duplicateKey)),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(
        Buffer.from(`${canonical.trim()} `),
      ),
      "receipt_invalid",
    );
  });

  it("rejects hostile JavaScript objects without invoking accessors or proxy traps", () => {
    let getterInvocations = 0;
    const accessor = validInput() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "createdAt", {
      enumerable: true,
      get() {
        getterInvocations += 1;
        return "2026-08-12T00:00:03.000Z";
      },
    });
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(accessor),
      "receipt_invalid",
    );
    expect(getterInvocations).toBe(0);

    let proxyTraps = 0;
    const proxy = new Proxy(validInput(), {
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        proxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(proxy),
      "receipt_invalid",
    );
    expect(proxyTraps).toBe(0);

    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(
        new (class extends Object {})(),
      ),
      "receipt_invalid",
    );

    const sparse = structuredClone(validInput()) as unknown as {
      membershipClaims: unknown[];
    };
    sparse.membershipClaims = new Array(4);
    sparse.membershipClaims[0] = validInput().membershipClaims[0];
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(sparse),
      "receipt_invalid",
    );

    const cyclic = validInput() as unknown as Record<string, unknown>;
    cyclic.cycle = cyclic;
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(cyclic),
      "receipt_invalid",
    );

    const oversized = structuredClone(validInput());
    oversized.claimedSourceUrlSha256 = "x".repeat(64 * 1024 + 1);
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(oversized),
      "receipt_invalid",
    );

    const nonCanonicalNumber = structuredClone(validInput());
    nonCanonicalNumber.claimedArchiveByteLength = -0;
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(nonCanonicalNumber),
      "receipt_invalid",
    );

    const unsafeNumber = structuredClone(validInput());
    unsafeNumber.claimedArchiveByteLength = Number.MAX_SAFE_INTEGER + 1;
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(unsafeNumber),
      "receipt_invalid",
    );

    const tooDeep = structuredClone(validInput()) as unknown as Record<string, unknown>;
    let nested: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    tooDeep.extra = nested;
    for (let index = 0; index < 22; index += 1) {
      const child: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      nested.child = child;
      nested = child;
    }
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(tooDeep),
      "receipt_invalid",
    );

    const tooManyNodes = structuredClone(validInput()) as unknown as Record<string, unknown>;
    tooManyNodes.extra = Array.from({ length: 64 }, () => (
      Array.from({ length: 256 }, () => false)
    ));
    expectCode(
      () => buildPostgresLogicalBackupV4SourceAuthorityReceiptV2(tooManyNodes),
      "receipt_invalid",
    );
  });

  it("rejects hostile, noncanonical, non-Buffer, invalid UTF-8, BOM, and oversized bytes", () => {
    const canonical = canonicalPostgresLogicalBackupV4SourceAuthorityReceiptV2(validReceipt());
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]), canonical,
      ])),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(Buffer.from([0xff])),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(
        Buffer.from(canonical.toString("utf8").replace(/\n$/, "\r\n")),
      ),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(new Uint8Array(canonical)),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(Buffer.alloc(0)),
      "receipt_invalid",
    );
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(
        Buffer.alloc(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_MAX_RECEIPT_BYTES + 1),
      ),
      "receipt_invalid",
    );

    let proxyTraps = 0;
    const proxiedBuffer = new Proxy(canonical, {
      ownKeys(target) {
        proxyTraps += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, property) {
        proxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expectCode(
      () => parsePostgresLogicalBackupV4SourceAuthorityReceiptV2(proxiedBuffer),
      "receipt_invalid",
    );
    expect(proxyTraps).toBe(0);
  });

  it("matches the independent complete V2 boundary policy and backup ACL descriptors", async () => {
    const { postgresLogicalStateInternals } = await import(
      "../src/lib/postgres-logical-state.js"
    );
    const boundary = postgresLogicalStateInternals.expectedSourceReadBoundaryDescriptor(
      "independent_test_owner",
    );
    const command = (value: string): "ALL" | "SELECT" | "INSERT" | "UPDATE" => ({
      "*": "ALL", r: "SELECT", a: "INSERT", w: "UPDATE",
    })[value] as "ALL" | "SELECT" | "INSERT" | "UPDATE";
    const expression = (value: string | null): string => {
      if (value === null) return "NONE";
      if (value === "true") return "TRUE";
      if (value.includes("pintpath_logical_backup_d")) {
        return "CURRENT_USER_EQUALS_DATABASE_OID_SCOPED_BACKUP_GROUP";
      }
      throw new Error(`unexpected independent policy expression: ${value}`);
    };
    const independentlyProjected = boundary.relations.flatMap((relation) => {
      expect(relation.rowSecurity).toBe(true);
      expect(relation.forceRowSecurity).toBe(true);
      expect(relation.columnAclCount).toBe(0);
      expect(relation.acl.filter((acl) => (
        acl.grantee === "$pintpath_logical_backup_current_database"
      ))).toEqual([{
        grantor: "independent_test_owner",
        grantee: "$pintpath_logical_backup_current_database",
        privilege: "SELECT",
        grantable: false,
      }]);
      return relation.policies.map((policy) => ({
        qualifiedRelation: relation.qualifiedName,
        policyName: policy.name,
        classification: policy.name.endsWith("_logical_backup_select")
          ? "LOGICAL_BACKUP_SELECT" : "REVIEWED_OTHER",
        permissive: policy.permissive,
        command: command(policy.command),
        roles: policy.roles,
        usingExpressionProfile: expression(policy.using),
        withCheckExpressionProfile: expression(policy.withCheck),
      }));
    }).sort((left, right) => compareText(
      `${left.qualifiedRelation}\u0000${left.policyName}`,
      `${right.qualifiedRelation}\u0000${right.policyName}`,
    ));
    expect(boundary.relations).toHaveLength(61);
    expect(independentlyProjected).toHaveLength(240);
    expect(independentlyProjected).toEqual(
      POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_V2_POLICY_DESCRIPTORS,
    );
    const backupRole = boundary.roles.find(
      (role) => role.role === "$pintpath_logical_backup_current_database",
    );
    expect(backupRole).toMatchObject({
      login: false,
      inherit: false,
      connectionLimit: -1,
      validUntil: null,
      membershipsGranted: [],
      membershipsReceived: [],
      settings: [],
    });
    expect(backupRole?.sharedDependencies).toHaveLength(63);
  });

  it("keeps the V2 production import graph passive and disjoint from V1 and operational code", () => {
    const source = fs.readFileSync(path.join(
      repositoryRoot,
      "src/lib/postgres-logical-backup-v4-source-authority-v2.ts",
    ), "utf8");
    const importSpecifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1]);
    expect(importSpecifiers).toEqual([
      "node:crypto",
      "node:util",
      "./postgres-logical-backup-v4-table-data-contract.js",
    ]);
    expect(source).not.toMatch(/from ["']node:(?:fs|child_process|net|tls|http|https|process)["']/);
    expect(source).not.toMatch(/from ["'](?:pg|better-sqlite3)["']/);
    expect(source).not.toMatch(/process\.env|fetch\s*\(|execFile|spawn\s*\(|createConnection/);
    expect(source).not.toContain("./postgres-logical-backup-v4-source-authority.js");
    expect(source).not.toContain("./postgres-logical-state.js");
    expect(source).not.toContain("./postgres-logical-backup-v4.js");
    expect(source).not.toContain("./postgres-logical-restore.js");
    expect(source).not.toContain("completePhysicalSchema");
    expect(source).not.toContain("physicalSchema:");
    expect(source).toContain("sourcePhysicalReadBoundarySha256");
    expect(source).toContain(
      "OID_OWNER_SENSITIVE_SELECTED_DATA_READ_SAFETY_EVIDENCE_ONLY",
    );
  });
});
