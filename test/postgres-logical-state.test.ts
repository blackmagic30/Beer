import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import {
  buildPostgresLogicalSourceStateReceipt,
  canonicalPostgresLogicalStateJson,
  computePostgresLogicalStateInventory,
  exactPostgresLogicalStateMatch,
  parsePostgresLogicalSourceStateReceipt,
  postgresLogicalStateInternals,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateConnection,
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

function fakeConnection(
  systemStateValue = "ready",
  pageQueryObserver: (text: string, values: readonly unknown[]) => void = () => undefined,
  controlValues: {
    readonly metadataUpdatedAt?: string;
    readonly migrationRunStatus?: string;
  } = {},
): PostgresLogicalStateConnection {
  return {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<PostgresLogicalStateQueryResult<Row>> => {
      if (text.includes("logical-state:table-set")) return {
        rows: [
          ...POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
            schemaName: "pintpath_app", tableName: table.name,
          })),
          { schemaName: "pintpath_app", tableName: "schema_metadata" },
          { schemaName: "pintpath_ops", tableName: "migration_chunks" },
          { schemaName: "pintpath_ops", tableName: "migration_runs" },
        ] as unknown as Row[],
        rowCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3,
      };
      if (text.includes("logical-state:catalog-counts")) return {
        rows: [{
          columnCount: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns),
          foreignKeyCount: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys),
          rowSecurityTableCount: String(POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3),
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
        rows: controlColumnRows() as unknown as Row[],
        rowCount: controlColumnRows().length,
      };
      if (text.includes("logical-state:control-primary-keys")) return {
        rows: controlPrimaryKeyRows() as unknown as Row[],
        rowCount: controlPrimaryKeyRows().length,
      };
      if (text.includes("logical-state:schema-metadata")) return {
        rows: metadataRows() as unknown as Row[],
        rowCount: metadataRows().length,
      };
      if (text.includes("logical-state:api-isolation")) return {
        rows: [{ unsafe: false } as unknown as Row],
        rowCount: 1,
      };
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
});
