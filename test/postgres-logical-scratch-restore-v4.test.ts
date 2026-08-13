import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildPostgresLogicalScratchRestoreV4Contract,
  canonicalPostgresLogicalScratchRestoreV4Contract,
  completePostgresLogicalScratchRestoreV4,
  parsePostgresLogicalScratchRestoreV4Contract,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_APPLICATION_TRIGGER_PROOF,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ARCHIVED_RELATIONS,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CAPABILITY,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT_SHA256,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_CATALOG_COUNTS,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_FOREIGN_KEY_SET_SHA256,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEY_SET_SHA256,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_CONTRACT_BYTES,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SCHEMA_METADATA_SEED,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL,
  PostgresLogicalScratchRestoreV4Error,
  projectPostgresLogicalScratchRestoreV4OfflineArtifact,
  projectPostgresLogicalScratchRestoreV4V2ShapeComparison,
  rejectPostgresLogicalScratchRestoreV4CurrentSourceAuthority,
  validatePostgresLogicalScratchRestoreV4CatalogCounts,
  validatePostgresLogicalScratchRestoreV4DisposalObservation,
  validatePostgresLogicalScratchRestoreV4PostLoadObservation,
  validatePostgresLogicalScratchRestoreV4PreLoadObservation,
} from "../src/lib/postgres-logical-scratch-restore-v4.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const H = (character: string) => character.repeat(64);

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PostgresLogicalScratchRestoreV4Error);
    expect((error as PostgresLogicalScratchRestoreV4Error).code).toBe(code);
    return;
  }
  throw new Error(`expected_${code}`);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string"
    || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}

function sha256Canonical(value: unknown): string {
  return crypto.createHash("sha256").update(`${canonicalize(value)}\n`).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function catalog() {
  return clone(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_CATALOG_COUNTS);
}

function seedRows() {
  return POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SCHEMA_METADATA_SEED.map(([key, value]) => ({
    key,
    value,
    updatedAt: "2026-08-12T10:00:00.000Z",
  }));
}

function relationRows(rowCounts: ReadonlyMap<string, string> = new Map()) {
  return POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS.map((qualifiedName) => ({
    qualifiedName,
    rowCount: rowCounts.get(qualifiedName) ?? "0",
  }));
}

function validPreLoad() {
  return {
    targetDatabaseOid: "22222",
    targetPhysicalReadBoundarySha256: H("2"),
    portableReadBoundarySha256:
      POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority
        .portableReadBoundarySha256,
    currentUserSuperuser: true,
    disposableTargetIdentityVerified: true,
    catalog: catalog(),
    seedRowsBeforeRemoval: seedRows(),
    seedRowsDeleted: seedRows(),
    relationRowsAfterSeedRemoval: relationRows(),
  };
}

function receipt(tableName: string, columnCount: number, rowCount = "0") {
  return {
    tableName,
    columnCount,
    rowCount,
    transformedSha256: H(rowCount === "0" ? "3" : "4"),
    firstPrimaryKeySha256: rowCount === "0" ? null : H("5"),
    lastPrimaryKeySha256: rowCount === "0" ? null : rowCount === "1" ? H("5") : H("f"),
  };
}

function validCapture(databaseOid: string, physicalHash: string) {
  const tables = POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.catalog
    .authoritativeTableColumns.map((table) => receipt(table.tableName, table.columnCount));
  const controlTables = [
    receipt("pintpath_app.schema_metadata", 3, "12"),
    receipt("pintpath_ops.migration_chunks", 7),
    receipt("pintpath_ops.migration_runs", 18),
    receipt("pintpath_ops.reviewed_price_promotion_operations", 15),
    receipt("pintpath_ops.reviewed_price_promotion_rows", 11),
  ];
  const staticAuthority = POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority;
  const withoutOverall = {
    authoritativeTableCount: 56,
    authoritativeColumnCount: 717,
    authoritativeRowCount: "0",
    nonEmptyAuthoritativeTableCount: 0,
    zeroRowAuthoritativeTableCount: 56,
    migrationContractSha256: staticAuthority.migrationContractSha256,
    sourceSchemaFingerprint: staticAuthority.sourceSchemaFingerprint,
    sourceSchemaSha256: staticAuthority.sourceSchemaSha256,
    sourceSnapshotSha256: H("6"),
    targetDdlSha256: staticAuthority.baseDdlSha256,
    schemaMetadataSha256: H("7"),
    tableSetSha256: H("8"),
    transformedDataSha256: H("9"),
    keyRangesSha256: H("a"),
    stateTotalsSha256: H("b"),
    kernelContractSha256: staticAuthority.kernelContractSha256,
    kernelMigrationSha256: staticAuthority.kernelMigrationSha256,
    sourceReadBoundarySha256: staticAuthority.portableReadBoundarySha256,
    controlTableCount: 5,
    controlRowCount: "12",
    controlTableSetSha256: H("c"),
    controlDataSha256: H("d"),
    controlKeyRangesSha256: H("e"),
    tables,
    controlTables,
  };
  return {
    inventory: {
      ...withoutOverall,
      overallStateSha256: sha256Canonical({
        kind: "pintpath-postgres-logical-state-inventory",
        version: 2,
        ...withoutOverall,
      }),
    },
    sourceDatabaseOid: databaseOid,
    sourcePhysicalReadBoundarySha256: physicalHash,
  };
}

function validArtifactProjection() {
  const authority = POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority;
  return {
    manifestSha256: H("1"),
    manifestBindingSha256: H("2"),
    archiveClaimedBytes: 1234,
    archiveClaimedSha256: H("3"),
    listingSha256: H("4"),
    tableDataSetSha256: authority.tableDataSetSha256,
    tableDataEntries: 59,
    sourceDatabaseOid: "11111",
    databaseName: "pintpath_source",
    sourceAuthorityReceiptSha256Claim: H("5"),
    pgDumpVersionClaim: "17.10",
    pgDumpExecutableSha256Claim: H("6"),
    pgRestoreVersionClaim: "17.10",
    pgRestoreExecutableSha256Claim: H("7"),
    baseDdlSha256: authority.baseDdlSha256,
    migrationContractSha256: authority.migrationContractSha256,
    kernelMigrationSha256: authority.kernelMigrationSha256,
    kernelContractSha256: authority.kernelContractSha256,
    portableReadBoundarySha256: authority.portableReadBoundarySha256,
  };
}

describe("offline PostgreSQL logical scratch-restore V4 contract", () => {
  it("is frozen, canonical, bounded, deterministic, and operationally inert", () => {
    const bytes = canonicalPostgresLogicalScratchRestoreV4Contract();
    expect(parsePostgresLogicalScratchRestoreV4Contract(bytes))
      .toEqual(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT);
    expect(buildPostgresLogicalScratchRestoreV4Contract())
      .toEqual(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT);
    expect(crypto.createHash("sha256").update(bytes).digest("hex"))
      .toBe(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT_SHA256);
    expect(Object.isFrozen(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT)).toBe(true);
    expect(bytes.length).toBeLessThan(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_CONTRACT_BYTES);
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CAPABILITY).toEqual({
      implementationState: "OFFLINE_CONTRACT_ONLY",
      databaseAccessImplemented: false,
      archiveArtifactVerificationImplemented: false,
      sourceAuthorityAcceptanceImplemented: false,
      sourceAuthorityReceiptHashAccepted: false,
      toolExecutableVerificationImplemented: false,
      restoreExecutionImplemented: false,
      crossOidScratchLoadImplemented: false,
      operationalScratchRestoreImplemented: false,
      artifactEmissionAuthorized: false,
      restoreAuthorized: false,
      activationAuthorized: false,
      productionCutoverAuthorized: false,
    });
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.cleanup.successReceiptImplemented)
      .toBe(false);
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.postLoad).toMatchObject({
      physicalReadBoundaryMustEqualPreLoadBoundary: true,
      physicalReadBoundaryEqualityIsCallerReportedOnly: true,
      physicalReadBoundaryIndependentlyVerifiedByThisModule: false,
      completePhysicalSchemaCatalogDigestRequired: true,
      completePhysicalSchemaCatalogDigestVerifiedByThisModule: false,
    });
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.targetAuthority).toMatchObject({
      dedicatedExclusiveConnectionRequired: true,
      trustedSearchPathMustBeSetBeforeEveryFixedSqlSequence: true,
      trustedSearchPathSqlMustBeExactlyPgCatalogThenPgTemp: true,
      effectiveFirstSchemaMustBePgCatalog: true,
      trustedSearchPathVerifiedByThisModule: false,
    });
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.blockers)
      .toContain("complete-physical-schema-catalog-digest-verification-unimplemented");
  });

  it("pins exact artifact bytes and independently reviewed semantic hashes", () => {
    const authority = POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority;
    expect(crypto.createHash("sha256").update(fs.readFileSync(
      path.join(repositoryRoot, authority.baseDdlFile),
    )).digest("hex")).toBe(authority.baseDdlSha256);
    expect(crypto.createHash("sha256").update(fs.readFileSync(
      path.join(repositoryRoot, authority.kernelMigrationFile),
    )).digest("hex")).toBe(authority.kernelMigrationSha256);
    expect(authority).toMatchObject({
      manifestSchemaVersion: 4,
      postgresMajor: 17,
      tableDataSetSha256: "505d42cd7ffbe6809aea3e3ed02b33968bf625bde882cdbc0f1a3c69cc94f6d8",
      portableReadBoundarySha256:
        "21ae87b71a458416f62d08749d8fc3368e9ff1621cd7f40550611291502a91ac",
    });
  });

  it("imports only passive modules and has no operational dependency surface", () => {
    const source = fs.readFileSync(
      path.join(repositoryRoot, "src/lib/postgres-logical-scratch-restore-v4.ts"), "utf8",
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual([
      "node:crypto",
      "node:util",
      "./postgres-logical-backup-v4-table-data-contract.js",
    ]);
    expect(source).not.toMatch(/node:fs|node:child_process|better-sqlite|from "pg"|process\.env/);
    expect(source).not.toMatch(/postgres-logical-(?:state|backup-v4-source-authority|restore)\.js/);
  });

  it("freezes exact 59 archive and 61 target relations with exact catalog totals", () => {
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ARCHIVED_RELATIONS).toHaveLength(59);
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS).toHaveLength(61);
    expect(new Set(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS).size).toBe(61);
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ARCHIVED_RELATIONS)
      .not.toContain("pintpath_ops.reviewed_price_promotion_operations");
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_CATALOG_COUNTS).toEqual({
      privateRelations: 61, privateColumns: 771, privatePolicies: 240,
      foreignKeys: 79, validatedForeignKeys: 79, deferrableForeignKeys: 0,
      initiallyDeferredForeignKeys: 0, nonSingleColumnForeignKeys: 0,
      riConstraintTriggers: 316, enabledRiConstraintTriggers: 316,
      applicationTriggers: 1, enabledApplicationTriggers: 1, totalPrivateTriggers: 317,
      scopedRoles: 5, privateSequences: 0, privateRelationPublicationMemberships: 0,
      privateSchemaPublicationMemberships: 0, allTablesPublications: 0,
      privateRelationExtensionDependencies: 0,
    });
    expect(validatePostgresLogicalScratchRestoreV4CatalogCounts(catalog())).toEqual(catalog());
    const wrong = catalog();
    wrong.privatePolicies = 241;
    expectCode(() => validatePostgresLogicalScratchRestoreV4CatalogCounts(wrong),
      "catalog_evidence_invalid");
  });

  it("derives 79 fixed identifier-only FK anti-joins and the rollback trigger proof", () => {
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS).toHaveLength(79);
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEY_SET_SHA256)
      .toBe(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_EXPECTED_FOREIGN_KEY_SET_SHA256);
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEY_SET_SHA256)
      .toBe("c66f81632116e1c76dcf81d828141206b83c34268e1bd4ff7ddc9e721e372ba9");
    expect(new Set(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS.map(
      (entry) => entry.constraintName,
    )).size).toBe(79);
    for (const foreignKey of POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS) {
      expect(foreignKey).toMatchObject({
        validated: true, deferrable: false, initiallyDeferred: false, keyColumnCount: 1,
      });
      expect(foreignKey.antiJoinSql).toContain("FROM ONLY");
      expect(foreignKey.antiJoinSql).toContain("AND NOT EXISTS");
      expect(foreignKey.antiJoinSql).not.toContain("$1");
    }
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_APPLICATION_TRIGGER_PROOF)
      .toMatchObject({
        exactDisabledTriggerCount: 2,
        allOtherRiTriggersMustRemainEnabled: true,
        proofTransactionMustRollback: true,
        fixtureResidueRowsAfterRollback: 0,
      });
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.foreignKeyAntiJoinSql).toHaveLength(79);
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.catalogCountsSql)
      .not.toContain("pg_catalog.integer");
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.catalogCountsSql)
      .toContain("::pg_catalog.int4");
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.trustedSearchPathSql)
      .toBe("SET LOCAL search_path = pg_catalog, pg_temp");
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.trustedSearchPathPreflightSql)
      .toContain('(pg_catalog.current_schemas(true))[1]::pg_catalog.text');
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.relationRowsSql)
      .toContain("FROM (\n");
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.relationRowsSql)
      .toContain(") AS relation_rows\nORDER BY relation_rows.\"qualifiedName\"");
    for (const sql of [
      POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.relationRowsSql,
      POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.seedRowsSql,
      POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.foreignKeyCatalogSql,
      POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.triggerSelectorSql,
    ]) {
      expect(sql).not.toContain('COLLATE "C"');
      expect(sql).toContain('COLLATE pg_catalog."C"');
    }
  });

  it("validates exact seed deletion and all 61 ONLY relations empty before load", () => {
    const result = validatePostgresLogicalScratchRestoreV4PreLoadObservation(validPreLoad());
    expect(result).toMatchObject({
      targetDatabaseOid: "22222", seedRowCountBeforeRemoval: 12,
      deletedSeedRowCount: 12, emptyRelationCount: 61,
      emptyArchivedRelationCount: 59, emptyKernelRelationCount: 2,
      totalRowsAfterSeedRemoval: "0", operationallyAccepted: false,
    });
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SCHEMA_METADATA_SEED).toHaveLength(12);
    expect(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.relationLockSql.match(/ONLY /g))
      .toHaveLength(61);
    const hostile = validPreLoad();
    hostile.relationRowsAfterSeedRemoval[0]!.rowCount = "1";
    expectCode(() => validatePostgresLogicalScratchRestoreV4PreLoadObservation(hostile),
      "pre_load_evidence_invalid");
    const badSeed = validPreLoad();
    badSeed.seedRowsDeleted[0]!.value = "ready";
    expectCode(() => validatePostgresLogicalScratchRestoreV4PreLoadObservation(badSeed),
      "pre_load_evidence_invalid");
  });

  it("never elevates current evidence-only source authority or a claimed receipt hash", () => {
    const current = {
      kind: "pintpath-postgres-logical-backup-source-authority",
      version: 1,
      evidenceOnly: true,
      operationalSourceAuthorityImplemented: false,
      effectiveTargetOnlyDatabaseAccessVerified: false,
      completeRoleGraphVerified: false,
      emitterMustRejectUntilOperationalSourceAuthorityImplemented: true,
      activationAuthorized: false,
      artifactEmissionAuthorized: false,
      productionCutoverAuthorized: false,
    };
    expectCode(() => rejectPostgresLogicalScratchRestoreV4CurrentSourceAuthority(current),
      "source_authority_evidence_only");
    expectCode(() => rejectPostgresLogicalScratchRestoreV4CurrentSourceAuthority({
      ...current, evidenceOnly: false,
    }), "source_authority_unsupported");
    const projection = projectPostgresLogicalScratchRestoreV4OfflineArtifact(
      validArtifactProjection(),
    );
    expect(projection).toMatchObject({
      operationallyUsable: false,
      archive: {
        exactBytesVerified: false,
        listingProjectionShapeAccepted: true,
        listingBytesVerified: false,
      },
      source: {
        databaseNameIdentityVerified: false,
        sourceAuthorityReceiptVerified: false,
        sourceAuthorityReceiptAccepted: false,
      },
      tools: { executableBytesVerified: false },
    });
  });

  it("requires different OIDs/physical identities and exact final V2 inventories", () => {
    const source = validCapture("11111", H("1"));
    const target = validCapture("22222", H("2"));
    expect(projectPostgresLogicalScratchRestoreV4V2ShapeComparison(source, target))
      .toMatchObject({
        sourceDatabaseOid: "11111", targetDatabaseOid: "22222",
        exactInventoryMatch: true, exactOverallStateSha256Match: true,
        shapeAndOverallSelfConsistencyAccepted: true,
        opaqueAggregateDigestsIndependentlyVerified: false,
        independentFullV2ValidationPerformed: false,
        operationallyAccepted: false,
      });
    expectCode(() => projectPostgresLogicalScratchRestoreV4V2ShapeComparison(
      source, validCapture("11111", H("2")),
    ), "target_comparison_invalid");
    expectCode(() => projectPostgresLogicalScratchRestoreV4V2ShapeComparison(
      source, validCapture("22222", H("1")),
    ), "target_comparison_invalid");
    const changed = validCapture("22222", H("2"));
    changed.inventory.sourceSnapshotSha256 = H("f");
    const { overallStateSha256: _ignored, ...withoutOverall } = changed.inventory;
    changed.inventory.overallStateSha256 = sha256Canonical({
      kind: "pintpath-postgres-logical-state-inventory", version: 2, ...withoutOverall,
    });
    expectCode(() => projectPostgresLogicalScratchRestoreV4V2ShapeComparison(source, changed),
      "target_comparison_invalid");
  });

  it("validates post-load row parity, all FK anti-joins, and rollback-only trigger proof", () => {
    const source = validCapture("11111", H("1"));
    const expectedRows = new Map<string, string>();
    for (const table of source.inventory.tables) {
      expectedRows.set(`pintpath_app.${table.tableName}`, table.rowCount);
    }
    for (const table of source.inventory.controlTables.slice(0, 3)) {
      expectedRows.set(table.tableName, table.rowCount);
    }
    const observation = {
      targetDatabaseOid: "22222",
      preLoadPhysicalReadBoundarySha256: H("2"),
      postLoadPhysicalReadBoundarySha256: H("2"),
      portableReadBoundarySha256:
        POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority
          .portableReadBoundarySha256,
      catalog: catalog(),
      relationRows: relationRows(expectedRows),
      expectedArchiveRowCount: "12",
      foreignKeyViolationRows: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS.map(
        ({ constraintName }) => ({ constraintName, violationRowCount: "0" }),
      ),
      applicationTriggerProof: {
        disabledParentRiConstraintNames: [
          "pint_point_drink_records_voided_by_user_id_fkey",
          "venue_claim_requests_reviewed_by_fkey",
        ] as const,
        applicationTriggerName: "clear_added_account_references_before_delete",
        applicationTriggerFunction: "pintpath_app.clear_account_references_before_delete",
        exactDisabledParentRiTriggerCount: 2,
        applicationTriggerEnabled: true,
        fixtureAccountRowsInserted: 2,
        fixtureChildRowsInserted: 2,
        reviewerAccountRowsDeleted: 1,
        survivingChildRows: 2,
        nullReferenceRows: 2,
        transactionRolledBack: true,
        fixtureResidueRows: 0,
        postRollbackEnabledPrivateTriggerCount: 317,
        postRollbackSchemaUnchanged: true,
      },
    };
    expect(validatePostgresLogicalScratchRestoreV4PostLoadObservation(observation, source))
      .toMatchObject({
        reportedPhysicalReadBoundaryHashesEqual: true,
        physicalReadBoundaryIndependentlyVerified: false,
        completePhysicalSchemaCatalogDigestVerified: false,
        archiveRowCount: "12", kernelRowCount: "0",
        foreignKeyViolationRowCount: "0", applicationTriggerProofRolledBack: true,
        operationallyAccepted: false,
      });
    const violation = clone(observation);
    violation.foreignKeyViolationRows[0]!.violationRowCount = "1";
    expectCode(() => validatePostgresLogicalScratchRestoreV4PostLoadObservation(
      violation, source,
    ), "post_load_evidence_invalid");
    const noRollback = clone(observation);
    noRollback.applicationTriggerProof.transactionRolledBack = false;
    expectCode(() => validatePostgresLogicalScratchRestoreV4PostLoadObservation(
      noRollback, source,
    ), "post_load_evidence_invalid");
  });

  it("requires disposal first but still makes success impossible", () => {
    const disposal = {
      allConnectionsClosed: true,
      archiveDescriptorsClosed: true,
      toolProcessReaped: true,
      disposableDatabaseDropped: true,
      fiveTargetOidScopedRolesDropped: true,
      temporaryArtifactsDisposed: true,
      residualDatabaseCount: 0,
      residualScopedRoleCount: 0,
      residualSessionCount: 0,
      residualArtifactCount: 0,
    };
    expect(validatePostgresLogicalScratchRestoreV4DisposalObservation(disposal))
      .toMatchObject({ permitsSuccessReceipt: false });
    expectCode(() => validatePostgresLogicalScratchRestoreV4DisposalObservation({
      ...disposal, residualScopedRoleCount: 1,
    }), "disposal_evidence_invalid");
    expectCode(() => completePostgresLogicalScratchRestoreV4(),
      "operational_completion_unimplemented");
  });

  it("rejects noncanonical, BOM, oversize, unsafe numeric, deep, hostile, and extra-key data", () => {
    const canonical = canonicalPostgresLogicalScratchRestoreV4Contract();
    let proxyTraps = 0;
    const proxy = new Proxy(canonical, {
      get() { proxyTraps += 1; throw new Error("must_not_read_proxy"); },
      ownKeys() { proxyTraps += 1; throw new Error("must_not_read_proxy"); },
    });
    expectCode(() => parsePostgresLogicalScratchRestoreV4Contract(proxy), "contract_invalid");
    expect(proxyTraps).toBe(0);
    let ownValueOfReads = 0;
    const ownValueOf = Buffer.from(canonical);
    Object.defineProperty(ownValueOf, "valueOf", {
      configurable: true,
      get() { ownValueOfReads += 1; throw new Error("must_not_read_value_of"); },
    });
    expectCode(() => parsePostgresLogicalScratchRestoreV4Contract(ownValueOf),
      "contract_invalid");
    expect(ownValueOfReads).toBe(0);
    let exoticLengthReads = 0;
    const exotic = Buffer.from(canonical);
    Object.setPrototypeOf(exotic, Object.create(Buffer.prototype, {
      length: {
        configurable: true,
        get() { exoticLengthReads += 1; throw new Error("must_not_read_length"); },
      },
    }));
    expectCode(() => parsePostgresLogicalScratchRestoreV4Contract(exotic),
      "contract_invalid");
    expect(exoticLengthReads).toBe(0);
    expectCode(() => parsePostgresLogicalScratchRestoreV4Contract(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
    ), "contract_invalid");
    expectCode(() => parsePostgresLogicalScratchRestoreV4Contract(
      Buffer.alloc(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_MAX_CONTRACT_BYTES + 1),
    ), "contract_invalid");
    expectCode(() => parsePostgresLogicalScratchRestoreV4Contract(
      Buffer.from(` ${canonical.toString("utf8")}`),
    ), "contract_invalid");
    expectCode(() => parsePostgresLogicalScratchRestoreV4Contract(
      Buffer.from('{"value":9007199254740992}\n'),
    ), "contract_invalid");
    let deep: unknown = true;
    for (let index = 0; index < 40; index += 1) deep = { deep };
    expectCode(() => parsePostgresLogicalScratchRestoreV4Contract(
      Buffer.from(JSON.stringify(deep)),
    ), "contract_invalid");
    expectCode(() => validatePostgresLogicalScratchRestoreV4CatalogCounts(
      new Proxy(catalog(), {}),
    ), "catalog_evidence_invalid");
    const protoHostile = Object.assign(Object.create(null), validArtifactProjection());
    Object.defineProperty(protoHostile, "__proto__", {
      value: { polluted: true }, enumerable: true,
    });
    expectCode(() => projectPostgresLogicalScratchRestoreV4OfflineArtifact(protoHostile),
      "artifact_evidence_invalid");
    expectCode(() => validatePostgresLogicalScratchRestoreV4CatalogCounts({
      ...catalog(), extra: 0,
    }), "catalog_evidence_invalid");
  });
});
