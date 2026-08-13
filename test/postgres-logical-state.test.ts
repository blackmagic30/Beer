import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import {
  buildPostgresLogicalSourceStateReceipt,
  canonicalPostgresLogicalStateJson,
  capturePostgresLogicalStateV2,
  computePostgresLogicalStateInventory,
  computePostgresLogicalStateInventoryV2,
  exactPostgresLogicalStateMatch,
  parsePostgresLogicalSourceStateReceipt,
  POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256,
  postgresLogicalStateInternals,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateConnection,
  type PostgresLogicalStateV2Connection,
  type PostgresLogicalStateQueryResult,
} from "../src/lib/postgres-logical-state.js";

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function metadataRows(): Array<{ key: string; value: string }> {
  return Object.entries({
    import_state: "ready",
    migration_candidate_sha: "c".repeat(40),
    migration_contract_sha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    migration_manifest_sha256: "1".repeat(64),
    migration_plan_sha256: "2".repeat(64),
    migration_run_sha256: "3".repeat(64),
    schema_version: "1",
    source_schema_fingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    source_schema_sha256: "4".repeat(64),
    source_schema_version: String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
    source_snapshot_sha256: "5".repeat(64),
    target_ddl_sha256: "6".repeat(64),
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => ({ key, value }));
}

function primaryKeyRows() {
  return POSTGRES_MIGRATION_CONTRACT.tables.flatMap((table) => (
    table.columns.filter((column) => column[4] > 0).map((column) => ({
      tableName: table.name,
      columnName: column[0],
      primaryKeyPosition: column[4],
    }))
  ));
}

function authoritativeColumnRows() {
  const postgresType = (semanticType: string): string => {
    switch (semanticType) {
      case "binary": return "bytea";
      case "boolean": return "boolean";
      case "calendar-month":
      case "text": return "text";
      case "decimal": return "numeric";
      case "float64": return "double precision";
      case "integer": return "bigint";
      case "json-array":
      case "json-object": return "jsonb";
      case "local-time": return "time without time zone";
      case "utc-instant": return "timestamp with time zone";
      default: throw new Error("unexpected semantic type");
    }
  };
  return [...POSTGRES_MIGRATION_CONTRACT.tables]
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .flatMap((table) => table.columns.map((column, index) => ({
      tableName: table.name,
      columnName: column[0],
      dataType: postgresType(column[2]),
      nullable: column[3],
      ordinal: index + 1,
    })));
}

function controlColumnRows() {
  const definitions = [
    ["pintpath_app", "schema_metadata", [
      ["key", "text", false], ["value", "text", false],
      ["updated_at", "timestamp with time zone", false],
    ]],
    ["pintpath_ops", "migration_chunks", [
      ["run_id", "text", false], ["table_name", "text", false],
      ["chunk_ordinal", "integer", false], ["row_count", "integer", false],
      ["source_transformed_sha256", "text", false], ["target_sha256", "text", false],
      ["completed_at", "timestamp with time zone", false],
    ]],
    ["pintpath_ops", "migration_runs", [
      ["run_id", "text", false], ["source_snapshot_sha256", "text", false],
      ["source_schema_fingerprint", "text", false], ["contract_sha256", "text", false],
      ["manifest_sha256", "text", false], ["target_ddl_sha256", "text", false],
      ["source_schema_version", "integer", false], ["candidate_commit_sha", "text", false],
      ["target_binding_sha256", "text", false], ["expected_environment", "text", false],
      ["approval_reference_sha256", "text", false], ["operator_id_sha256", "text", false],
      ["verifier_id_sha256", "text", true], ["status", "text", false],
      ["started_at", "timestamp with time zone", false],
      ["completed_at", "timestamp with time zone", true],
      ["receipt_sha256", "text", true], ["failure_code", "text", true],
    ]],
  ] as const;
  return definitions.flatMap(([schemaName, tableName, columns]) => columns.map(
    ([columnName, dataType, nullable], index) => ({
      schemaName, tableName, columnName, dataType, nullable, ordinal: index + 1,
    }),
  ));
}

function controlPrimaryKeyRows() {
  return [
    { schemaName: "pintpath_app", tableName: "schema_metadata", columnName: "key", primaryKeyPosition: 1 },
    { schemaName: "pintpath_ops", tableName: "migration_chunks", columnName: "run_id", primaryKeyPosition: 1 },
    { schemaName: "pintpath_ops", tableName: "migration_chunks", columnName: "table_name", primaryKeyPosition: 2 },
    { schemaName: "pintpath_ops", tableName: "migration_chunks", columnName: "chunk_ordinal", primaryKeyPosition: 3 },
    { schemaName: "pintpath_ops", tableName: "migration_runs", columnName: "run_id", primaryKeyPosition: 1 },
  ];
}

function controlColumnRowsV2() {
  return [
    ...controlColumnRows(),
    ...[
      ["reviewed_price_promotion_operations", [
        ["operation_id", "uuid", false], ["operation_kind", "text", false],
        ["source_apply_operation_id", "uuid", true], ["candidate_sha", "text", false],
        ["expected_environment", "text", false], ["authority_bundle_sha256", "text", false],
        ["plan_candidate_sha256", "text", false], ["review_packet_candidate_sha256", "text", false],
        ["target_physical_identity_sha256", "text", false], ["source_snapshot_sha256", "text", false],
        ["request_sha256", "text", false], ["requested_row_count", "integer", false],
        ["committed_at", "timestamp with time zone", false], ["result_state_sha256", "text", false],
        ["receipt_sha256", "text", false],
      ]],
      ["reviewed_price_promotion_rows", [
        ["operation_id", "uuid", false], ["row_ordinal", "integer", false],
        ["source_ingestion_id", "uuid", false], ["venue_id", "uuid", false],
        ["price_record_id", "text", false], ["venue_beer_id", "text", false],
        ["normalized_beer_id", "text", false], ["row_request_sha256", "text", false],
        ["before_state_sha256", "text", false], ["after_state_sha256", "text", false],
        ["row_receipt_sha256", "text", false],
      ]],
    ].flatMap(([tableName, columns]) => (columns as readonly (readonly [string, string, boolean])[])
      .map(([columnName, dataType, nullable], index) => ({
        schemaName: "pintpath_ops", tableName, columnName, dataType, nullable,
        ordinal: index + 1,
      }))),
  ];
}

function controlPrimaryKeyRowsV2() {
  return [
    ...controlPrimaryKeyRows(),
    { schemaName: "pintpath_ops", tableName: "reviewed_price_promotion_operations", columnName: "operation_id", primaryKeyPosition: 1 },
    { schemaName: "pintpath_ops", tableName: "reviewed_price_promotion_rows", columnName: "operation_id", primaryKeyPosition: 1 },
    { schemaName: "pintpath_ops", tableName: "reviewed_price_promotion_rows", columnName: "row_ordinal", primaryKeyPosition: 2 },
  ];
}

function rawSourceReadBoundary(databaseOid = "123", databaseOwner = "zac") {
  const expected = postgresLogicalStateInternals.expectedSourceReadBoundaryDescriptor(databaseOwner);
  const substitutions = new Map([
    ["$pintpath_logical_backup_current_database", `pintpath_logical_backup_d${databaseOid}`],
    ["$pintpath_reviewed_price_apply_owner_current_database", `pintpath_reviewed_price_apply_owner_d${databaseOid}`],
    ["$pintpath_reviewed_price_apply_execute_current_database", `pintpath_reviewed_price_apply_execute_d${databaseOid}`],
    ["$pintpath_reviewed_price_quarantine_owner_current_database", `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`],
    ["$pintpath_reviewed_price_quarantine_execute_current_database", `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`],
  ]);
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      let output = value;
      for (const [normalized, raw] of substitutions) output = output.replaceAll(normalized, raw);
      return output;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replace(entry)]),
    );
    return value;
  };
  return replace(expected);
}

function fakeConnection(
  systemStateValue = "ready",
  pageQueryObserver: (text: string, values: readonly unknown[]) => void = () => undefined,
  controlValues: {
    readonly metadataUpdatedAt?: string;
    readonly migrationRunStatus?: string;
    readonly successor?: boolean;
    readonly databaseOwner?: string;
    readonly sourceReadBoundaryMutation?: (descriptor: Record<string, unknown>) => void;
    readonly sourceReadBoundaryWire?: unknown;
    readonly effectiveSchemas?: readonly string[];
    readonly backendPid?: number;
    readonly queryObserver?: (text: string) => void;
    readonly transactionIsolation?: string;
    readonly transactionReadOnly?: string;
    readonly serverVersionNum?: string;
    readonly transactionIds?: readonly string[];
    readonly currentUsers?: readonly string[];
    readonly sessionUsers?: readonly string[];
    readonly nonemptyKernel?: boolean;
    readonly ownRowCountOverride?: {
      readonly schemaName: string;
      readonly tableName: string;
      readonly rowCount: string;
    };
  } = {},
): PostgresLogicalStateV2Connection {
  let preflightCount = 0;
  return {
    processID: 12345,
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<PostgresLogicalStateQueryResult<Row>> => {
      controlValues.queryObserver?.(text);
      if (text.startsWith("SET TRANSACTION ISOLATION LEVEL ")) {
        return { rows: [], rowCount: null };
      }
      if (text.includes("logical-state:v2:relation-lock")) return {
        rows: [],
        rowCount: null,
      };
      if (text.includes("logical-state:v2:session-preflight")) {
        const preflightIndex = preflightCount++;
        return {
        rows: [{
          firstSchema: (controlValues.effectiveSchemas ?? ["pg_catalog"])[0],
          backendPid: controlValues.backendPid ?? 12345,
          currentUser: controlValues.currentUsers?.[preflightIndex]
            ?? "pintpath_logical_backup_d123",
          sessionUser: controlValues.sessionUsers?.[preflightIndex] ?? "pintpath_test_owner",
          transactionIsolation: controlValues.transactionIsolation ?? "repeatable read",
          transactionReadOnly: controlValues.transactionReadOnly ?? "on",
          serverVersionNum: controlValues.serverVersionNum ?? "170006",
          transactionId: controlValues.transactionIds?.[preflightIndex] ?? "123456",
        } as unknown as Row],
        rowCount: 1,
        };
      }
      if (text.includes("logical-state:table-set")) return {
        rows: [
          ...POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
            schemaName: "pintpath_app", tableName: table.name,
          })),
          { schemaName: "pintpath_app", tableName: "schema_metadata" },
          { schemaName: "pintpath_ops", tableName: "migration_chunks" },
          { schemaName: "pintpath_ops", tableName: "migration_runs" },
          ...(controlValues.successor ? [
            { schemaName: "pintpath_ops", tableName: "reviewed_price_promotion_operations" },
            { schemaName: "pintpath_ops", tableName: "reviewed_price_promotion_rows" },
          ] : []),
        ] as unknown as Row[],
        rowCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
          + (controlValues.successor ? 5 : 3),
      };
      if (text.includes("logical-state:catalog-counts")) return {
        rows: [{
          columnCount: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns),
          foreignKeyCount: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys),
          rowSecurityTableCount: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
            + (controlValues.successor ? 5 : 3)),
        } as unknown as Row],
        rowCount: 1,
      };
      if (text.includes("logical-state:primary-keys")) return {
        rows: primaryKeyRows() as unknown as Row[],
        rowCount: primaryKeyRows().length,
      };
      if (text.includes("logical-state:authoritative-column-contract")) return {
        rows: authoritativeColumnRows() as unknown as Row[],
        rowCount: authoritativeColumnRows().length,
      };
      if (text.includes("logical-state:control-columns")) return {
        rows: (controlValues.successor ? controlColumnRowsV2() : controlColumnRows()) as unknown as Row[],
        rowCount: (controlValues.successor ? controlColumnRowsV2() : controlColumnRows()).length,
      };
      if (text.includes("logical-state:control-primary-keys")) return {
        rows: (controlValues.successor ? controlPrimaryKeyRowsV2() : controlPrimaryKeyRows()) as unknown as Row[],
        rowCount: (controlValues.successor ? controlPrimaryKeyRowsV2() : controlPrimaryKeyRows()).length,
      };
      if (text.includes("logical-state:schema-metadata")) return {
        rows: metadataRows() as unknown as Row[],
        rowCount: metadataRows().length,
      };
      if (text.includes("logical-state:api-isolation")) return {
        rows: [{ unsafe: false } as unknown as Row],
        rowCount: 1,
      };
      if (text.includes("logical-state:v2:source-read-boundary")) {
        const descriptor = rawSourceReadBoundary(
          "123", controlValues.databaseOwner ?? "zac",
        ) as Record<string, unknown>;
        controlValues.sourceReadBoundaryMutation?.(descriptor);
        return {
          rows: [{
            databaseOid: "123",
            descriptorJson: controlValues.sourceReadBoundaryWire
              ?? canonicalPostgresLogicalStateJson(descriptor),
          } as unknown as Row],
          rowCount: 1,
        };
      }
      const ownRowCount = /logical-state:v2:own-row-count:([a-z0-9_]+):([a-z0-9_]+)/
        .exec(text);
      if (ownRowCount) {
        const [, schemaName, tableName] = ownRowCount;
        const rowCount = controlValues.ownRowCountOverride?.schemaName === schemaName
            && controlValues.ownRowCountOverride.tableName === tableName
          ? controlValues.ownRowCountOverride.rowCount
          : schemaName === "pintpath_app" && tableName === "system_state"
          ? "1"
          : schemaName === "pintpath_app" && tableName === "schema_metadata"
            ? String(metadataRows().length)
            : schemaName === "pintpath_ops" && tableName === "migration_runs"
              ? "1"
              : schemaName === "pintpath_ops" && tableName === "migration_chunks"
                ? "1"
                : "0";
        return {
          rows: [{
            rowCount,
            currentUser: controlValues.currentUsers?.[0] ?? "pintpath_logical_backup_d123",
            sessionUser: controlValues.sessionUsers?.[0] ?? "pintpath_test_owner",
          } as unknown as Row],
          rowCount: 1,
        };
      }
      const page = /logical-state:page:([a-z0-9_]+):([a-z0-9_]+)/.exec(text);
      if (page) {
        pageQueryObserver(text, values);
        const [, schemaName, tableName] = page;
        if (schemaName === "pintpath_app" && tableName === "system_state" && values.length === 1) return {
          rows: [{
            key: "logical-state-test",
            value_json: `{"state":"${systemStateValue}","unsafe":9007199254740993}`,
            updated_at: "2026-08-08T01:02:03.123456Z",
            revision: "9007199254740993",
          } as unknown as Row],
          rowCount: 1,
        };
        if (schemaName === "pintpath_app" && tableName === "schema_metadata" && values.length === 1) {
          return {
            rows: metadataRows().map((row) => ({
              ...row,
              updated_at: controlValues.metadataUpdatedAt
                ?? "2026-08-08T01:02:03.123456Z",
            })) as unknown as Row[],
            rowCount: metadataRows().length,
          };
        }
        if (schemaName === "pintpath_ops" && tableName === "migration_runs" && values.length === 1) {
          return {
            rows: [{
              run_id: "run-1",
              source_snapshot_sha256: "1".repeat(64),
              source_schema_fingerprint: "2".repeat(64),
              contract_sha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
              manifest_sha256: "3".repeat(64),
              target_ddl_sha256: "4".repeat(64),
              source_schema_version: "16",
              candidate_commit_sha: "c".repeat(40),
              target_binding_sha256: "5".repeat(64),
              expected_environment: "permanent-staging",
              approval_reference_sha256: "6".repeat(64),
              operator_id_sha256: "7".repeat(64),
              verifier_id_sha256: "8".repeat(64),
              status: controlValues.migrationRunStatus ?? "ready",
              started_at: "2026-08-08T01:02:03.123456Z",
              completed_at: "2026-08-08T01:03:04.123456Z",
              receipt_sha256: "9".repeat(64),
              failure_code: null,
            } as unknown as Row],
            rowCount: 1,
          };
        }
        if (schemaName === "pintpath_ops" && tableName === "migration_chunks" && values.length === 1) {
          return {
            rows: [{
              run_id: "run-1",
              table_name: "system_state",
              chunk_ordinal: "7",
              row_count: "1",
              source_transformed_sha256: "a".repeat(64),
              target_sha256: "a".repeat(64),
              completed_at: "2026-08-08T01:03:04.123456Z",
            } as unknown as Row],
            rowCount: 1,
          };
        }
        if (schemaName === "pintpath_ops"
            && tableName === "reviewed_price_promotion_operations" && values.length === 1) {
          if (controlValues.successor && !controlValues.nonemptyKernel) {
            return { rows: [], rowCount: 0 };
          }
          return {
            rows: [{
              operation_id: "00000000-0000-0000-0000-000000000001",
              operation_kind: "apply", source_apply_operation_id: null,
              candidate_sha: "c".repeat(40), expected_environment: "permanent-staging",
              authority_bundle_sha256: "1".repeat(64), plan_candidate_sha256: "2".repeat(64),
              review_packet_candidate_sha256: "3".repeat(64),
              target_physical_identity_sha256: "4".repeat(64),
              source_snapshot_sha256: "5".repeat(64), request_sha256: "6".repeat(64),
              requested_row_count: "1", committed_at: "2026-08-08T01:03:04.123456Z",
              result_state_sha256: "7".repeat(64), receipt_sha256: "8".repeat(64),
            } as unknown as Row], rowCount: 1,
          };
        }
        if (schemaName === "pintpath_ops"
            && tableName === "reviewed_price_promotion_rows" && values.length === 1) {
          if (controlValues.successor && !controlValues.nonemptyKernel) {
            return { rows: [], rowCount: 0 };
          }
          return {
            rows: [{
              operation_id: "00000000-0000-0000-0000-000000000001", row_ordinal: "0",
              source_ingestion_id: "00000000-0000-0000-0000-000000000002",
              venue_id: "00000000-0000-0000-0000-000000000003",
              price_record_id: "price-1", venue_beer_id: "venue-beer-1",
              normalized_beer_id: "beer-1", row_request_sha256: "9".repeat(64),
              before_state_sha256: "a".repeat(64), after_state_sha256: "b".repeat(64),
              row_receipt_sha256: "c".repeat(64),
            } as unknown as Row], rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error("unexpected query");
    },
  };
}

function column(conversion: string) {
  for (const table of POSTGRES_MIGRATION_CONTRACT.tables) {
    const found = table.columns.find((entry) => entry[2] === conversion);
    if (found) return found;
  }
  throw new Error(`missing conversion ${conversion}`);
}

describe("Postgres logical state receipts", () => {
  it("hashes all 56 tables in contract PK order with bounded keyset pages", async () => {
    let pageQueries = 0;
    const inventory = await computePostgresLogicalStateInventory(
      fakeConnection("ready", (text) => {
        pageQueries += 1;
        expect(text).toContain('COLLATE "C" ASC');
        expect(text).toMatch(/LIMIT \$\d+::integer/);
      }),
    );

    expect(inventory.authoritativeTableCount).toBe(56);
    expect(inventory.authoritativeColumnCount).toBe(717);
    expect(inventory.authoritativeRowCount).toBe("1");
    expect(inventory.tables).toHaveLength(56);
    expect(inventory.tables.map((table) => table.tableName)).toEqual(
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => table.name),
    );
    expect(inventory.tables.find((table) => table.tableName === "system_state")).toMatchObject({
      rowCount: "1",
      firstPrimaryKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      lastPrimaryKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(pageQueries).toBe(59);
    expect(inventory.archivedControlTableCount).toBe(3);
    expect(inventory.archivedControlRowCount).toBe("14");
    expect(inventory.archivedControlTables.map((table) => table.tableName)).toEqual([
      "pintpath_app.schema_metadata",
      "pintpath_ops.migration_chunks",
      "pintpath_ops.migration_runs",
    ]);
    expect(inventory.overallStateSha256).toMatch(/^[a-f0-9]{64}$/);

    const changed = await computePostgresLogicalStateInventory(fakeConnection("changed"));
    expect(exactPostgresLogicalStateMatch(inventory, changed)).toBe(false);
    expect(changed.transformedDataSha256).not.toBe(inventory.transformedDataSha256);

    const changedRun = await computePostgresLogicalStateInventory(fakeConnection(
      "ready",
      () => undefined,
      { migrationRunStatus: "failed" },
    ));
    expect(changedRun.transformedDataSha256).toBe(inventory.transformedDataSha256);
    expect(changedRun.archivedControlDataSha256).not.toBe(inventory.archivedControlDataSha256);
    expect(exactPostgresLogicalStateMatch(inventory, changedRun)).toBe(false);

    const changedMetadataTimestamp = await computePostgresLogicalStateInventory(fakeConnection(
      "ready",
      () => undefined,
      { metadataUpdatedAt: "2026-08-08T01:02:03.123457Z" },
    ));
    expect(changedMetadataTimestamp.schemaMetadataSha256).toBe(inventory.schemaMetadataSha256);
    expect(changedMetadataTimestamp.archivedControlDataSha256)
      .not.toBe(inventory.archivedControlDataSha256);
    expect(exactPostgresLogicalStateMatch(inventory, changedMetadataTimestamp)).toBe(false);
  });

  it("uses exact native canonical encodings without unsafe bigint or numeric coercion", () => {
    const canonical = postgresLogicalStateInternals.canonicalNativeValue;
    expect(canonical(true, column("boolean"))).toBe("B1");
    expect(canonical("9007199254740993123", column("integer")))
      .toBe("I9007199254740993123");
    expect(canonical("12345678901234567890.0100", column("decimal")))
      .toBe("D1234567890123456789001e-2");
    expect(canonical('{"z":9007199254740993,"a":1}', column("json-object")))
      .toBe('J{"a":1,"z":9007199254740993}');
    expect(canonical("[9007199254740993,1.2300]", column("json-array")))
      .toBe("J[9007199254740993,123e-2]");
    expect(canonical(Buffer.from([0, 255]), column("binary"))).toBe("XAP8=");
    expect(canonical("2026-08", column("calendar-month"))).toBe("T2026-08");
    expect(canonical("07:08:09.123456", column("local-time"))).toBe("t07:08:09.123456");
    expect(canonical("2026-08-08T01:02:03.123456Z", column("utc-instant")))
      .toBe("Z2026-08-08T01:02:03.123456Z");
    expect(canonical(-0, column("float64"))).toBe("F8000000000000000");

    const first = postgresLogicalStateInternals.canonicalPrimaryKey(["a", "b"]).toString("hex");
    const reversed = postgresLogicalStateInternals.canonicalPrimaryKey(["b", "a"]).toString("hex");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reversed).not.toBe(first);
    const compositeColumns = [
      ["run_id", "TEXT", "text", false, 1],
      ["table_name", "TEXT", "text", false, 2],
      ["chunk_ordinal", "INTEGER", "integer", false, 3],
    ] as const;
    const composite = postgresLogicalStateInternals.canonicalPrimaryKey(
      ["run-1", "system_state", "7"],
      compositeColumns,
    ).toString("hex");
    expect(composite).not.toBe(postgresLogicalStateInternals.canonicalPrimaryKey(
      ["run-1", "system_state", "8"],
      compositeColumns,
    ).toString("hex"));
    const controlPage = postgresLogicalStateInternals.pageSql({
      name: "migration_chunks",
      dependencies: [],
      columns: compositeColumns,
    }, true, "pintpath_ops");
    expect(controlPage).toContain('ROW("run_id" COLLATE "C", "table_name" COLLATE "C", "chunk_ordinal")');
    expect(controlPage).toContain('$3::bigint');
    expect(controlPage).toContain('LIMIT $4::integer');
    expect(() => canonical(9_007_199_254_740_992, column("integer"))).toThrow("state_invalid");
  });

  it("accepts only exact canonical receipts and detects binding tampering", async () => {
    const state = await computePostgresLogicalStateInventory(fakeConnection());
    const receipt = buildPostgresLogicalSourceStateReceipt({
      capturedAt: "2026-08-08T01:02:03.000Z",
      databaseIdentitySha256: "a".repeat(64),
      sourceUrlSha256: "b".repeat(64),
      snapshotBindingSha256: "c".repeat(64),
      archiveBytes: 123,
      archiveSha256: "d".repeat(64),
      archiveListingSha256: "e".repeat(64),
      manifestBindingSha256: "f".repeat(64),
      state,
    });
    const bytes = Buffer.from(canonicalPostgresLogicalStateJson(receipt));
    expect(parsePostgresLogicalSourceStateReceipt(bytes)).toEqual(receipt);
    expect(sha256CanonicalPostgresLogicalState(receipt)).toBe(sha256(bytes));

    const tampered = structuredClone(receipt);
    (tampered.state.tables[0] as { rowCount: string }).rowCount = "1";
    expect(() => parsePostgresLogicalSourceStateReceipt(
      Buffer.from(canonicalPostgresLogicalStateJson(tampered)),
    )).toThrow("receipt_invalid");
    expect(() => parsePostgresLogicalSourceStateReceipt(
      Buffer.from(`${canonicalPostgresLogicalStateJson(receipt).trim()}  \n`),
    )).toThrow("receipt_invalid");
  });

  it("keeps the v1 canonical wire receipt frozen while v2 remains opt-in", async () => {
    const state = await computePostgresLogicalStateInventory(fakeConnection());
    const receipt = buildPostgresLogicalSourceStateReceipt({
      capturedAt: "2026-08-08T01:02:03.000Z",
      databaseIdentitySha256: "a".repeat(64),
      sourceUrlSha256: "b".repeat(64),
      snapshotBindingSha256: "c".repeat(64),
      archiveBytes: 123,
      archiveSha256: "d".repeat(64),
      archiveListingSha256: "e".repeat(64),
      manifestBindingSha256: "f".repeat(64),
      state,
    });
    expect(sha256CanonicalPostgresLogicalState(receipt)).toBe(
      "f984c4ab83156fa278bbe76bd3ad8e716070a79e419c8131f41c8d8aec061854",
    );
    expect(parsePostgresLogicalSourceStateReceipt(
      Buffer.from(canonicalPostgresLogicalStateJson(receipt)),
    )).toEqual(receipt);
  });

  it("captures five v2 controls after exact data-only source-boundary validation", async () => {
    const v1 = await computePostgresLogicalStateInventory(fakeConnection());
    const v2PageQueries: string[] = [];
    const capture = await capturePostgresLogicalStateV2(fakeConnection(
      "ready", (text) => v2PageQueries.push(text), { successor: true },
    ));
    const inventory = capture.inventory;
    expect(capture.sourceDatabaseOid).toBe("123");
    expect(capture.sourcePhysicalReadBoundarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.controlTableCount).toBe(5);
    expect(inventory.controlTables.map((table) => table.tableName)).toEqual([
      "pintpath_app.schema_metadata",
      "pintpath_ops.migration_chunks",
      "pintpath_ops.migration_runs",
      "pintpath_ops.reviewed_price_promotion_operations",
      "pintpath_ops.reviewed_price_promotion_rows",
    ]);
    expect(inventory.controlRowCount).toBe("14");
    expect(inventory.schemaMetadataSha256).not.toBe(v1.schemaMetadataSha256);
    expect(inventory.tableSetSha256).not.toBe(v1.tableSetSha256);
    expect(inventory.transformedDataSha256).not.toBe(v1.transformedDataSha256);
    expect(inventory.kernelContractSha256).toBe(POSTGRES_LOGICAL_STATE_KERNEL_CONTRACT_SHA256);
    expect(v2PageQueries.length).toBeGreaterThan(0);
    expect(v2PageQueries.every((text) => text.includes("FROM ONLY"))).toBe(true);
    expect(await computePostgresLogicalStateInventoryV2(fakeConnection(
      "ready", () => undefined, { successor: true },
    ))).toEqual(inventory);

    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, {
        successor: true,
        sourceReadBoundaryMutation: (descriptor) => {
          descriptor.privateSchemaPublicationCount = 1;
        },
      },
    ))).rejects.toThrow("contract_invalid");

    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, {
        successor: true,
        sourceReadBoundaryMutation: (descriptor) => {
          descriptor.privateRelationPublicationCount = 1;
        },
      },
    ))).rejects.toThrow("contract_invalid");

    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, {
        successor: true,
        sourceReadBoundaryMutation: (descriptor) => {
          descriptor.privateRelationExtensionDependencyCount = 1;
        },
      },
    ))).rejects.toThrow("contract_invalid");

    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, {
        successor: true,
        ownRowCountOverride: {
          schemaName: "pintpath_app", tableName: "system_state", rowCount: "2",
        },
      },
    ))).rejects.toThrow("state_invalid");

    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, { successor: false },
    ))).rejects.toThrow("contract_invalid");

    for (const sourceReadBoundaryWire of [{}, "not-json"]) {
      await expect(capturePostgresLogicalStateV2(fakeConnection(
        "ready", () => undefined, { successor: true, sourceReadBoundaryWire },
      ))).rejects.toThrow("contract_invalid");
    }

    const kernelPages: string[] = [];
    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", (text) => {
        if (text.includes("reviewed_price_promotion")) kernelPages.push(text);
      }, { successor: true, nonemptyKernel: true },
    ))).rejects.toThrow("contract_invalid");
    expect(kernelPages).toHaveLength(1);
    expect(kernelPages[0]).toContain("reviewed_price_promotion_operations");
  });

  it("locks every row source before one pinned safe PG17 snapshot", async () => {
    const queries: string[] = [];
    await capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, { successor: true, queryObserver: (text) => queries.push(text) },
    ));
    expect(queries[0]).toContain("logical-state:v2:relation-lock");
    expect(queries[0]).toContain("ONLY \"pintpath_app\".");
    expect(queries[0].match(/\bONLY\b/g)).toHaveLength(61);
    expect(queries[1]).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(queries[2]).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(queries[3]).toContain("logical-state:v2:session-preflight");
    expect(queries[4]).toContain("logical-state:v2:source-read-boundary");
    expect(queries.at(-1)).toContain("logical-state:v2:session-preflight");

    for (const unsafe of [
      { effectiveSchemas: ["evil", "pg_catalog"] },
      { backendPid: 12346 },
      { transactionIsolation: "read committed" },
      { transactionReadOnly: "off" },
      { serverVersionNum: "180000" },
    ] as const) {
      let queryCount = 0;
      await expect(capturePostgresLogicalStateV2(fakeConnection(
        "ready", () => undefined,
        { successor: true, ...unsafe, queryObserver: () => { queryCount += 1; } },
      ))).rejects.toThrow("contract_invalid");
      expect(queryCount).toBe(4);
    }
    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, { successor: true, transactionIds: ["123", "124"] },
    ))).rejects.toThrow("contract_invalid");
    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, {
        successor: true,
        currentUsers: ["pintpath_logical_backup_d123", "pintpath_logical_backup_d124"],
      },
    ))).rejects.toThrow("contract_invalid");
    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, {
        successor: true,
        currentUsers: ["pintpath_runtime", "pintpath_runtime"],
      },
    ))).rejects.toThrow("contract_invalid");
  });

  it("uses UUID-aware v2 control pagination and PostgreSQL byte ordering", () => {
    const operations = {
      name: "reviewed_price_promotion_operations",
      dependencies: [],
      columns: [["operation_id", "TEXT", "text", false, 1]],
    } as const;
    const rows = {
      name: "reviewed_price_promotion_rows",
      dependencies: [],
      columns: [
        ["operation_id", "TEXT", "text", false, 1],
        ["row_ordinal", "INTEGER", "integer", false, 2],
      ],
    } as const;
    expect(postgresLogicalStateInternals.pageSql(operations, true, "pintpath_ops"))
      .toContain('$1::uuid');
    expect(postgresLogicalStateInternals.pageSql(rows, true, "pintpath_ops"))
      .toContain('ROW("operation_id", "row_ordinal") > ROW($1::uuid, $2::bigint)');
    expect(postgresLogicalStateInternals.compareKey(
      ["00000000-0000-0000-0000-0000000000ff"],
      ["00000000-0000-0000-0000-000000000100"],
      operations.columns,
      ["uuid"],
    )).toBeLessThan(0);
    expect(() => postgresLogicalStateInternals.compareKey(
      ["00000000-0000-0000-0000-0000000000FF"],
      ["00000000-0000-0000-0000-000000000100"],
      operations.columns,
      ["uuid"],
    )).toThrow("state_invalid");
  });

  it("normalizes only exact current-database scoped role identities", () => {
    const expected = postgresLogicalStateInternals.expectedSourceReadBoundaryDescriptor("zac");
    const raw = structuredClone(expected) as unknown as Record<string, unknown>;
    const replace = (value: unknown): unknown => {
      if (typeof value === "string") return value
        .replaceAll("$pintpath_logical_backup_current_database", "pintpath_logical_backup_d123")
        .replaceAll("$pintpath_reviewed_price_apply_owner_current_database", "pintpath_reviewed_price_apply_owner_d123")
        .replaceAll("$pintpath_reviewed_price_apply_execute_current_database", "pintpath_reviewed_price_apply_execute_d123")
        .replaceAll("$pintpath_reviewed_price_quarantine_owner_current_database", "pintpath_reviewed_price_quarantine_owner_d123")
        .replaceAll("$pintpath_reviewed_price_quarantine_execute_current_database", "pintpath_reviewed_price_quarantine_execute_d123");
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, replace(entry)]),
      );
      return value;
    };
    const normalized = postgresLogicalStateInternals.normalizeSourceReadBoundaryValue(
      replace(raw), "123",
    );
    expect(canonicalPostgresLogicalStateJson(normalized))
      .toBe(canonicalPostgresLogicalStateJson(expected));
    expect(() => postgresLogicalStateInternals.normalizeSourceReadBoundaryValue(
      replace(raw), "124",
    )).toThrow("contract_invalid");
  });

  it("schema-qualifies every callable in the v2 source-boundary query", () => {
    const callable = [
      "acldefault", "aclexplode", "count", "current_database", "format",
      "format_type", "jsonb_agg", "jsonb_build_object", "pg_get_constraintdef",
      "pg_get_expr", "pg_get_function_identity_arguments", "pg_get_function_result",
      "pg_get_indexdef", "to_jsonb", "unnest",
    ].join("|");
    expect(postgresLogicalStateInternals.sourceReadBoundarySql).not.toMatch(
      new RegExp(`(?:^|[^.A-Za-z0-9_])(?:${callable})\\s*\\(`, "i"),
    );
  });

  it("projects only exact validated database-owner positions out of the portable hash", async () => {
    const captures = await Promise.all([
      "another_owner", "owner", "postgres", "zac",
    ].map((databaseOwner) => capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, { successor: true, databaseOwner },
    ))));
    expect(new Set(captures.map((capture) => capture.inventory.sourceReadBoundarySha256)))
      .toHaveLength(1);
    expect(new Set(captures.map((capture) => capture.sourcePhysicalReadBoundarySha256)).size)
      .toBe(captures.length);

    await expect(capturePostgresLogicalStateV2(fakeConnection(
      "ready", () => undefined, {
        successor: true,
        databaseOwner: "zac",
        sourceReadBoundaryMutation: (descriptor) => {
          const relations = descriptor.relations;
          if (!Array.isArray(relations) || !relations[0]
              || typeof relations[0] !== "object") throw new Error("fixture_invalid");
          (relations[0] as Record<string, unknown>).owner = "postgres";
        },
      },
    ))).rejects.toThrow("contract_invalid");

    for (const databaseOwner of [
      "PUBLIC",
      "$database_owner",
      "$pintpath_logical_backup_current_database",
      "pintpath_logical_backup_d123",
      "pintpath_migrator",
      "pintpath_reviewed_price_apply_owner_d123",
      "pintpath_runtime",
    ]) {
      await expect(capturePostgresLogicalStateV2(fakeConnection(
        "ready", () => undefined, { successor: true, databaseOwner },
      ))).rejects.toThrow("contract_invalid");
    }
  });
});
