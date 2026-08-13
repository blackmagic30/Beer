import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Client, ClientConfig } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../src/db/database.js";
import {
  POSTGRES_MIGRATION_LEDGER_CURRENT_FILE,
  writePostgresMigrationLedgerAuthority,
} from "../src/db/postgres-migration-ledger.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import type { VerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";
import {
  inspectPostgresMigrationSchema,
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
  type PostgresMigrationColumnContract,
  type PostgresMigrationTableContract,
} from "../src/db/postgres-migration-schema.js";
import {
  POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY,
  POSTGRES_MIGRATION_SNAPSHOT_EVIDENCE_DIRECTORY,
  createPostgresMigrationPlan,
  createPostgresMigrationSnapshot,
} from "../src/db/postgres-migration-source.js";
import {
  applyPostgresMigrationWithConnection as applyPostgresMigrationWithConnectionCore,
  postgresMigrationTargetInternals,
  safePostgresMigrationTargetFailure,
  verifyPostgresMigrationWithConnection as verifyPostgresMigrationWithConnectionCore,
  type PostgresMigrationReceipt,
  type PostgresMigrationTargetConnection,
  type PostgresMigrationTargetInput,
  type PostgresMigrationTargetQueryResult,
} from "../src/db/postgres-migration-target.js";
import {
  POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_OBJECT_COUNT,
  POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_SHA256,
} from "../src/db/postgres-migration-live-schema.js";
import {
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
  postgresMigrationVerifierAuthoritySchema,
  sha256PostgresMigrationAuthorityIdentity,
  sha256PostgresMigrationVerifierAuthorityBinding,
} from "../src/db/postgres-migration-verifier-authority.js";
import {
  POSTGRES_MIGRATION_VERIFICATION_APPROVAL_KIND,
  POSTGRES_MIGRATION_VERIFICATION_APPROVAL_VERSION,
  type PostgresMigrationApplyReceipt,
} from "../src/db/postgres-migration-receipt.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  checkPostgresRailwayStockLocalhostServerIdentity,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
  TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
} from "./postgres-railway-stock-localhost-ca.fixtures.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-08-08T00:00:00.000Z";
const TARGET_URL = "postgresql://migration-user:migration-password@migration-target.railway.internal:5432/pintpath?sslmode=verify-full";
const VERIFIER_KEY_PAIR = crypto.generateKeyPairSync("ed25519");
const VERIFIER_PUBLIC_KEY_BYTES = VERIFIER_KEY_PAIR.publicKey.export({
  format: "pem",
  type: "spki",
});
const VERIFIER_PUBLIC_KEY_SHA256 = sha256PostgresMigrationBytes(VERIFIER_PUBLIC_KEY_BYTES);
const VERIFIER_AUTHORITY_BINDING = {
  expectedEnvironment: "permanent-staging" as const,
  candidateSha: "a".repeat(40),
  operatorIdSha256: sha256PostgresMigrationAuthorityIdentity(
    "migration-operator-target-test",
    "operator-id",
  ),
  verifierIdSha256: sha256PostgresMigrationAuthorityIdentity(
    "migration-verifier-target-test",
    "verifier-id",
  ),
  verifierPublicKeySha256: VERIFIER_PUBLIC_KEY_SHA256,
  authorityPolicySha256: POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
};
const VERIFIER_AUTHORITY = postgresMigrationVerifierAuthoritySchema.parse({
  ...VERIFIER_AUTHORITY_BINDING,
  authoritySha256: sha256PostgresMigrationVerifierAuthorityBinding(
    VERIFIER_AUTHORITY_BINDING,
  ),
  installedAt: NOW,
});
const APPLY_RECEIPTS = new WeakMap<PostgresMigrationTargetConnection, PostgresMigrationApplyReceipt>();
const LIVE_SCHEMA_DEPENDENCIES = Object.freeze({
  inspectLiveSchema: async () => ({
    objectCount: POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_OBJECT_COUNT,
    sha256: POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_SHA256,
  }),
});

async function applyPostgresMigrationWithConnection(
  input: PostgresMigrationTargetInput,
  connection: PostgresMigrationTargetConnection,
) {
  const receipt = await applyPostgresMigrationWithConnectionCore(
    input,
    connection,
    LIVE_SCHEMA_DEPENDENCIES,
  );
  APPLY_RECEIPTS.set(connection, receipt);
  return receipt;
}

async function verifyPostgresMigrationWithConnection(
  input: PostgresMigrationTargetInput,
  connection: PostgresMigrationTargetConnection,
) {
  const applyReceipt = APPLY_RECEIPTS.get(connection);
  if (!applyReceipt) throw new Error("missing apply receipt fixture");
  const payload = {
    applyReceiptSha256: applyReceipt.receiptSha256,
    approvedAt: NOW,
    candidateSha: applyReceipt.candidateSha,
    expectedEnvironment: applyReceipt.expectedEnvironment,
    expiresAt: "2026-08-08T00:10:00.000Z",
    liveSchemaSha256: applyReceipt.liveSchemaSha256,
    targetIdentitySha256: applyReceipt.targetIdentitySha256,
    verifierIdSha256: applyReceipt.verifierIdSha256,
    verifierAuthoritySha256: applyReceipt.verifierAuthoritySha256,
    verifierAuthorityPolicySha256: applyReceipt.verifierAuthorityPolicySha256,
    verifierPublicKeySha256: VERIFIER_PUBLIC_KEY_SHA256,
  };
  const approval = {
    kind: POSTGRES_MIGRATION_VERIFICATION_APPROVAL_KIND,
    version: POSTGRES_MIGRATION_VERIFICATION_APPROVAL_VERSION,
    payload,
    signatureBase64: crypto.sign(
      null,
      serializeCanonicalPostgresMigrationJson(payload),
      VERIFIER_KEY_PAIR.privateKey,
    ).toString("base64"),
  };
  const applyReceiptBytes = serializeCanonicalPostgresMigrationJson(applyReceipt);
  const approvalBytes = serializeCanonicalPostgresMigrationJson(approval);
  return verifyPostgresMigrationWithConnectionCore({
    ...input,
    verificationAuthority: {
      applyReceipt,
      applyReceiptFileSha256: sha256PostgresMigrationBytes(applyReceiptBytes),
      expectedApplyReceiptFileSha256: sha256PostgresMigrationBytes(applyReceiptBytes),
      approval,
      approvalFileSha256: sha256PostgresMigrationBytes(approvalBytes),
      expectedApprovalFileSha256: sha256PostgresMigrationBytes(approvalBytes),
      verifierPublicKeyBytes: VERIFIER_PUBLIC_KEY_BYTES,
      now: new Date("2026-08-08T00:05:00.000Z"),
    },
  }, connection, LIVE_SCHEMA_DEPENDENCIES);
}

function temporaryDirectory(): string {
  const result = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-postgres-apply-test-")));
  temporaryDirectories.push(result);
  return result;
}

function canonicalSha256(value: unknown): string {
  return sha256PostgresMigrationBytes(serializeCanonicalPostgresMigrationJson(value));
}

function targetType(column: PostgresMigrationColumnContract): string {
  switch (column[2]) {
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
  }
}

function valueKey(value: unknown): string {
  if (value === null) return "N";
  if (Buffer.isBuffer(value)) return `X${value.toString("base64")}`;
  if (typeof value === "number") {
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    return `F${bytes.toString("hex")}`;
  }
  if (typeof value === "boolean") return value ? "B1" : "B0";
  return `T${String(value)}`;
}

function primaryKey(table: PostgresMigrationTableContract): PostgresMigrationColumnContract[] {
  return table.columns.filter((column) => column[4] > 0).sort((left, right) => left[4] - right[4]);
}

function targetForeignKeyRows(): Array<Record<string, unknown>> {
  const database = createDatabase(":memory:");
  try {
    const descriptor = inspectPostgresMigrationSchema(database).descriptor;
    const action = (value: string) => ({
      "NO ACTION": "a",
      RESTRICT: "r",
      CASCADE: "c",
      "SET NULL": "n",
      "SET DEFAULT": "d",
    })[value]!;
    return descriptor.tables.flatMap((table) => table.foreignKeys.map((foreignKey) => ({
      childTable: table.name,
      parentTable: foreignKey.table,
      childColumn: foreignKey.from,
      parentColumn: foreignKey.to,
      columnPosition: foreignKey.seq + 1,
      onUpdate: action(foreignKey.on_update),
      onDelete: action(foreignKey.on_delete),
      matchType: foreignKey.match === "NONE" ? "s" : foreignKey.match.toLowerCase().slice(0, 1),
      deferrable: false,
    })));
  } finally {
    database.close();
  }
}

function rowKey(table: PostgresMigrationTableContract, values: readonly unknown[]): string {
  return primaryKey(table).map((column) => {
    const index = table.columns.findIndex((candidate) => candidate[0] === column[0]);
    return valueKey(values[index]);
  }).join("\0");
}

type FakeRun = {
  runId: string;
  sourceSnapshotSha256: string;
  sourceSchemaFingerprint: string;
  contractSha256: string;
  manifestSha256: string;
  targetDdlSha256: string;
  sourceSchemaVersion: number;
  candidateSha: string;
  targetBindingSha256: string;
  expectedEnvironment: string;
  approvalReferenceSha256: string;
  operatorIdSha256: string;
  verifierIdSha256: string | null;
  status: "planned" | "importing" | "verifying" | "ready" | "failed";
  receiptSha256: string | null;
  failureCode: string | null;
};

type FakeChunk = {
  runId: string;
  tableName: string;
  chunkOrdinal: number;
  rowCount: number;
  sourceTransformedSha256: string;
  targetSha256: string;
};

type FakeSnapshot = {
  metadata: Map<string, string>;
  rows: Map<string, Map<string, unknown[]>>;
  run: FakeRun | null;
  chunks: Map<string, FakeChunk>;
};

class StrictFakePostgresTarget implements PostgresMigrationTargetConnection {
  readonly identity = {
    systemIdentifier: "7391827364518273645",
    databaseOid: "16422",
    databaseName: "pintpath",
    sessionUser: "migration-user",
    currentUser: "pintpath_migrator",
    serverVersionNum: "170010",
  };

  readonly identitySha256 = canonicalSha256(this.identity);
  readonly metadata = new Map<string, string>([
    ["schema_version", "1"],
    ["import_state", "empty"],
    ["source_schema_sha256", "f".repeat(64)],
    ["migration_contract_sha256", canonicalSha256(POSTGRES_MIGRATION_CONTRACT)],
    ["migration_candidate_sha", ""],
    ["migration_manifest_sha256", ""],
    ["migration_plan_sha256", ""],
    ["migration_run_sha256", ""],
    ["source_schema_fingerprint", ""],
    ["source_schema_version", "0"],
    ["source_snapshot_sha256", ""],
    ["target_ddl_sha256", ""],
    ["live_schema_sha256", ""],
  ]);

  readonly rows = new Map<string, Map<string, unknown[]>>(
    POSTGRES_MIGRATION_CONTRACT.tables.map((table) => [table.name, new Map()]),
  );

  run: FakeRun | null = null;
  readonly chunks = new Map<string, FakeChunk>();
  authorityRows: Record<string, unknown>[] = [{ ...VERIFIER_AUTHORITY }];
  insertChunkCalls = 0;
  interruptOnInsertCall: number | null = null;
  onInsertCall: ((call: number) => void) | null = null;
  private transactionSnapshot: FakeSnapshot | null = null;
  private locked = false;

  tamper(tableName: string, columnName: string, value: unknown): void {
    const table = POSTGRES_MIGRATION_CONTRACT.tables.find((candidate) => candidate.name === tableName)!;
    const row = [...this.rows.get(tableName)!.values()][0]!;
    row[table.columns.findIndex((column) => column[0] === columnName)] = value;
  }

  private cloneState(): FakeSnapshot {
    return {
      metadata: new Map(this.metadata),
      rows: new Map([...this.rows].map(([table, rows]) => [
        table,
        new Map([...rows].map(([key, values]) => [key, values.map((value) => Buffer.isBuffer(value) ? Buffer.from(value) : value)])),
      ])),
      run: this.run ? { ...this.run } : null,
      chunks: new Map([...this.chunks].map(([key, chunk]) => [key, { ...chunk }])),
    };
  }

  private restoreState(snapshot: FakeSnapshot): void {
    this.metadata.clear();
    for (const [key, value] of snapshot.metadata) this.metadata.set(key, value);
    this.rows.clear();
    for (const [table, rows] of snapshot.rows) this.rows.set(table, rows);
    this.run = snapshot.run;
    this.chunks.clear();
    for (const [key, chunk] of snapshot.chunks) this.chunks.set(key, chunk);
  }

  private tableFromSql(sql: string): PostgresMigrationTableContract {
    const match = /pintpath_app\."([a-z][a-z0-9_]*)"/.exec(sql);
    const table = POSTGRES_MIGRATION_CONTRACT.tables.find((candidate) => candidate.name === match?.[1]);
    if (!table) throw new Error("Strict fake received an unknown table identifier.");
    return table;
  }

  private projectedRow(table: PostgresMigrationTableContract, values: readonly unknown[]): Record<string, unknown> {
    return Object.fromEntries(table.columns.map((column, index) => {
      const value = values[index];
      if (value === null || Buffer.isBuffer(value) || typeof value === "boolean") return [column[0], value];
      if (["json-array", "json-object", "decimal", "integer"].includes(column[2])) return [column[0], String(value)];
      if (column[2] === "float64") return [column[0], Object.is(value, -0) ? "-0" : String(value)];
      return [column[0], value];
    }));
  }

  private selectedKeys(table: PostgresMigrationTableContract, values: readonly unknown[]): Set<string> {
    const keys = primaryKey(table);
    const result = new Set<string>();
    for (let offset = 0; offset < values.length; offset += keys.length) {
      const keyValues = new Array<unknown>(table.columns.length).fill(null);
      keys.forEach((column, index) => {
        const columnIndex = table.columns.findIndex((candidate) => candidate[0] === column[0]);
        keyValues[columnIndex] = values[offset + index];
      });
      result.add(rowKey(table, keyValues));
    }
    return result;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresMigrationTargetQueryResult<Row>> {
    const result = (rows: Record<string, unknown>[], rowCount: number | null = rows.length) => ({
      rows: rows as Row[],
      rowCount,
    });
    if (text.includes("pintpath:migration:target-identity")) {
      return result([{
        ...this.identity,
        sessionSuperuser: false,
        currentSuperuser: false,
        sessionBypassRls: false,
        currentBypassRls: false,
        activeRoleExact: true,
        loginAttributesSafe: true,
        loginMembershipExact: true,
        migratorRoleSafe: true,
        migratorRoleParentsAbsent: true,
        migratorRoleChildrenExact: true,
        loginRoleChildrenAbsent: true,
        roleSettingsAbsent: true,
        databaseAuthorityExact: true,
        migratorDatabaseAuthorityExact: true,
        migratorSchemaAuthorityExact: true,
        migratorTableAuthorityExact: true,
        migratorColumnPrivilegesAbsent: true,
        migratorRoutinePrivilegesAbsent: true,
        migratorSequencePrivilegesAbsent: true,
        unsafeDirectLoginAclAbsent: true,
        unsafeDirectMigratorAclAbsent: true,
        roleOwnershipAbsent: true,
        defaultPrivilegesAbsent: true,
        verifierAuthorityRoleBoundaryExact: true,
        migratorMember: true,
        runtimeMember: false,
        applicationSchemaUsage: true,
        operationsSchemaUsage: true,
        forbiddenMutationPrivilege: false,
      }]);
    }
    if (text.includes("pintpath:migration:target-columns")) {
      return result(POSTGRES_MIGRATION_CONTRACT.tables.flatMap((table) => table.columns.map((column, index) => ({
        tableName: table.name,
        columnName: column[0],
        dataType: targetType(column),
        ordinalPosition: index + 1,
        isNullable: column[3],
        rlsEnabled: true,
        rlsForced: true,
      }))));
    }
    if (text.includes("pintpath:migration:target-primary-keys")) {
      return result(POSTGRES_MIGRATION_CONTRACT.tables.flatMap((table) => primaryKey(table).map((column) => ({
        tableName: table.name,
        columnName: column[0],
        primaryKeyPosition: column[4],
      }))));
    }
    if (text.includes("pintpath:migration:target-constraints")) {
      return result([{ foreignKeyCount: 76, unvalidatedCount: 0 }]);
    }
    if (text.includes("pintpath:migration:target-foreign-keys")) {
      return result(targetForeignKeyRows());
    }
    if (text.includes("pintpath:migration:target-control-tables")) {
      return result([
        { schemaName: "pintpath_app", tableName: "schema_metadata", rlsEnabled: true, rlsForced: true },
        { schemaName: "pintpath_ops", tableName: "migration_chunks", rlsEnabled: true, rlsForced: true },
        { schemaName: "pintpath_ops", tableName: "migration_runs", rlsEnabled: true, rlsForced: true },
        { schemaName: "pintpath_ops", tableName: "migration_verifier_authority", rlsEnabled: true, rlsForced: true },
      ]);
    }
    if (text.includes("pintpath:migration:load-independent-verifier-authority")) {
      return result(this.authorityRows);
    }
    if (text.includes("pintpath:migration:lock")) {
      if (this.locked) return result([{ acquired: false }]);
      this.locked = true;
      return result([{ acquired: true }]);
    }
    if (text.includes("pintpath:migration:unlock")) {
      this.locked = false;
      return result([{ pg_advisory_unlock: true }]);
    }
    if (text.includes("pintpath:migration:begin")) {
      if (this.transactionSnapshot) throw new Error("Nested transaction in strict fake.");
      this.transactionSnapshot = this.cloneState();
      return result([], null);
    }
    if (text.includes("pintpath:migration:commit")) {
      if (!this.transactionSnapshot) throw new Error("Commit without transaction in strict fake.");
      this.transactionSnapshot = null;
      return result([], null);
    }
    if (text.includes("pintpath:migration:rollback")) {
      if (!this.transactionSnapshot) throw new Error("Rollback without transaction in strict fake.");
      this.restoreState(this.transactionSnapshot);
      this.transactionSnapshot = null;
      return result([], null);
    }
    if (text.includes("pintpath:migration:metadata")) {
      return result([...this.metadata].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, value })));
    }
    if (text.includes("pintpath:migration:runs")) return result(this.run ? [{ ...this.run }] : []);
    if (text.includes("pintpath:migration:create-run")) {
      if (this.run) return result([], 0);
      this.run = {
        runId: String(values[0]),
        sourceSnapshotSha256: String(values[1]),
        sourceSchemaFingerprint: String(values[2]),
        contractSha256: String(values[3]),
        manifestSha256: String(values[4]),
        targetDdlSha256: String(values[5]),
        sourceSchemaVersion: Number(values[6]),
        candidateSha: String(values[7]),
        targetBindingSha256: String(values[8]),
        expectedEnvironment: String(values[9]),
        approvalReferenceSha256: String(values[10]),
        operatorIdSha256: String(values[11]),
        verifierIdSha256: null,
        status: "planned",
        receiptSha256: null,
        failureCode: null,
      };
      return result([], 1);
    }
    if (text.includes("pintpath:migration:set-import-state")) {
      if (this.metadata.get("import_state") !== "empty") return result([], 0);
      this.metadata.set("import_state", "importing");
      return result([], 1);
    }
    if (text.includes("pintpath:migration:chunks")) return result([...this.chunks.values()].map((chunk) => ({ ...chunk })));
    if (text.includes("pintpath:migration:update-run-status")) {
      if (!this.run || this.run.runId !== values[0]) return result([], 0);
      this.run.status = String(values[1]) as FakeRun["status"];
      this.run.failureCode = null;
      return result([], 1);
    }
    if (text.includes("pintpath:migration:update-import-state")) {
      this.metadata.set("import_state", String(values[0]));
      return result([], 1);
    }
    if (text.includes("pintpath:migration:fail-run")) {
      if (!this.run || this.run.runId !== values[0]) return result([], 0);
      this.run.status = "failed";
      this.run.failureCode = String(values[1]);
      return result([], 1);
    }
    if (text.includes("pintpath:migration:fail-import-state")) {
      this.metadata.set("import_state", "failed");
      return result([], 1);
    }
    if (text.includes("pintpath:migration:table-count")) {
      const table = this.tableFromSql(text);
      return result([{ rowCount: String(this.rows.get(table.name)!.size) }]);
    }
    if (text.includes("pintpath:migration:insert-target-chunk")) {
      this.insertChunkCalls += 1;
      this.onInsertCall?.(this.insertChunkCalls);
      if (this.interruptOnInsertCall === this.insertChunkCalls) throw new Error("simulated connection interruption");
      const table = this.tableFromSql(text);
      const tableRows = this.rows.get(table.name)!;
      let inserted = 0;
      for (let offset = 0; offset < values.length; offset += table.columns.length) {
        const row = [...values.slice(offset, offset + table.columns.length)];
        const key = rowKey(table, row);
        if (!tableRows.has(key)) {
          tableRows.set(key, row);
          inserted += 1;
        }
      }
      return result([], inserted);
    }
    if (text.includes("pintpath:migration:fetch-target-chunk")) {
      const table = this.tableFromSql(text);
      const selected = this.selectedKeys(table, values);
      const rows = [...this.rows.get(table.name)!]
        .filter(([key]) => selected.has(key))
        .map(([, row]) => this.projectedRow(table, row));
      return result(rows);
    }
    if (text.includes("pintpath:migration:count-target-keys")) {
      const table = this.tableFromSql(text);
      const selected = this.selectedKeys(table, values);
      const count = [...this.rows.get(table.name)!.keys()].filter((key) => selected.has(key)).length;
      return result([{ rowCount: String(count) }]);
    }
    if (text.includes("pintpath:migration:checkpoint-chunk")) {
      const chunk: FakeChunk = {
        runId: String(values[0]),
        tableName: String(values[1]),
        chunkOrdinal: Number(values[2]),
        rowCount: Number(values[3]),
        sourceTransformedSha256: String(values[4]),
        targetSha256: String(values[5]),
      };
      const key = `${chunk.tableName}\0${chunk.chunkOrdinal}`;
      if (this.chunks.has(key)) return result([], 0);
      this.chunks.set(key, chunk);
      return result([], 1);
    }
    if (text.includes("pintpath:migration:orphan-check")) return result([{ hasOrphan: false }]);
    if (text.includes("pintpath:migration:write-verifying-metadata")) {
      const key = String(values[0]);
      if (!this.metadata.has(key)) return result([], 0);
      this.metadata.set(key, String(values[1]));
      return result([], 1);
    }
    if (text.includes("pintpath:migration:await-independent-verification")) {
      if (!this.run || this.run.runId !== values[0]) return result([], 0);
      this.run.status = "verifying";
      this.run.verifierIdSha256 = String(values[1]);
      this.run.receiptSha256 = String(values[2]);
      this.run.failureCode = null;
      return result([], 1);
    }
    if (text.includes("pintpath:migration:write-ready-metadata")) {
      const key = String(values[0]);
      if (!this.metadata.has(key)) return result([], 0);
      this.metadata.set(key, String(values[1]));
      return result([], 1);
    }
    if (text.includes("pintpath:migration:ready-run")) {
      if (!this.run || this.run.runId !== values[0]) return result([], 0);
      this.run.status = "ready";
      this.run.verifierIdSha256 = String(values[1]);
      this.run.receiptSha256 = String(values[2]);
      this.run.failureCode = null;
      return result([], 1);
    }
    throw new Error(`Strict fake received unsupported SQL marker: ${text.slice(0, 100)}`);
  }
}

function createSource(root: string): { databasePath: string; evidencePath: string } {
  const databasePath = path.join(root, "live.sqlite");
  const evidencePath = path.join(root, "evidence");
  fs.mkdirSync(evidencePath, { mode: 0o700 });
  fs.writeFileSync(path.join(evidencePath, "private-evidence.bin"), "PRIVATE_EVIDENCE_DO_NOT_RECEIPT", { mode: 0o600 });
  const database = createDatabase(databasePath);
  for (const suffix of ["one", "two"]) {
    database.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, display_name, is_over_18_verified,
         contribution_points_current_month, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `account-${suffix}`,
      `${suffix}-private@example.test`,
      `PRIVATE_PASSWORD_${suffix}`,
      `Private ${suffix}`,
      suffix === "one" ? 1 : 0,
      suffix === "one" ? 1.25 : -0,
      NOW,
      NOW,
    );
  }
  database.prepare(
    `INSERT INTO account_preferences (
       user_id, preferred_suburbs_json, preferred_beers_json, preferred_use_cases_json,
       onboarding_completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("account-one", '["Fitzroy"]', '["PRIVATE_STOUT"]', '["map"]', NOW, NOW, NOW);
  database.prepare(
    "INSERT INTO system_state (key, value_json, updated_at, revision) VALUES (?, ?, ?, ?)",
  ).run("PRIVATE_STATE_KEY", '{"z":1.00,"a":2e0}', NOW, `${NOW}#target`);
  database.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("deletion-one", "account-one", NOW, "2026-08-15T00:00:00.000Z", NOW, NOW);
  database.prepare(
    `INSERT INTO account_deletion_completion_outbox (
       request_id, template_version, idempotency_key, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("deletion-one", "account-deletion-complete-v1", "PRIVATE_CORRELATION_SECRET", "held", NOW, NOW);
  database.prepare(
    `INSERT INTO account_deletion_notice_recipient_secrets (
       request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "deletion-one",
    "PRIVATE_KEY_ID",
    Buffer.alloc(12, 7),
    Buffer.from("PRIVATE_CIPHERTEXT_PRESERVED", "utf8"),
    Buffer.alloc(16, 8),
    NOW,
    "2026-10-07T00:00:00.000Z",
  );
  database.prepare(
    `INSERT INTO leaderboard_prize_campaigns (
       month_key, title, starts_at, ends_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("2026-08", "Private campaign", NOW, "2026-08-31T23:59:59.999Z", NOW, NOW);
  database.prepare(
    `INSERT INTO venue_location_cache (venue_id, venue_name, latitude, longitude, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("venue-one", "Private Venue", -37.8136, 144.9631, NOW);
  database.prepare(
    `INSERT INTO venue_profiles (
       venue_id, name, opening_hours_json, venue_tags_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("venue-one", "Private Venue", "{}", '["pub"]', NOW, NOW);
  database.prepare(
    `INSERT INTO venue_happy_hours (
       id, venue_id, title, days_of_week_json, start_time, end_time,
       description, happy_hour_beers_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "happy-one", "venue-one", "Private happy hour", '["monday"]', "16:30", "18:00:00",
    "Private description", '["Lager"]', NOW, NOW,
  );
  database.close();
  return { databasePath, evidencePath };
}

function serializedJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function verifiedLedgerFixture(): VerifiedAccountDeletionLedger {
  const tombstones = [{
    requestId: "PRIVATE_LEDGER_REQUEST",
    userId: "PRIVATE_LEDGER_USER",
    completedAt: "2026-08-07T01:02:03.000Z",
  }];
  const current = serializedJson({
    version: 1,
    generatedAt: "2026-08-07T01:02:03.000Z",
    tombstones,
  });
  const genesis = serializedJson({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: "2026-07-01T00:00:00.000Z",
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  });
  const checkpoint = {
    version: 2 as const,
    generatedAt: "2026-08-07T01:02:03.000Z",
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256: sha256PostgresMigrationBytes(genesis),
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: sha256PostgresMigrationBytes(current),
    immutableObjectCount: 1,
    immutableSetSha256: "e".repeat(64),
    tombstoneCount: 1,
    latestCompletedAt: "2026-08-07T01:02:03.000Z",
  };
  const checkpointBytes = serializedJson(checkpoint);
  return {
    bytes: current,
    sha256: sha256PostgresMigrationBytes(current),
    genesisBytes: genesis,
    genesisSha256: sha256PostgresMigrationBytes(genesis),
    checkpointBytes,
    checkpointSha256: sha256PostgresMigrationBytes(checkpointBytes),
    tombstones,
    checkpoint,
  };
}

async function createInput(root: string): Promise<{
  input: PostgresMigrationTargetInput;
  fake: StrictFakePostgresTarget;
  secrets: string[];
}> {
  const source = createSource(root);
  const ledgerAuthority = await writePostgresMigrationLedgerAuthority({
    sourceSupabaseUrl: "https://production-project.supabase.co",
    destinationSupabaseUrl: "https://independent-backup.supabase.co",
    bucketName: "pintpath-backups",
    outputDirectory: path.join(root, "ledger-authority"),
    verified: verifiedLedgerFixture(),
  });
  const artifactParent = path.join(root, "artifacts");
  fs.mkdirSync(artifactParent, { mode: 0o700 });
  const snapshot = await createPostgresMigrationSnapshot({
    sourceSqlite: source.databasePath,
    sourceEvidence: source.evidencePath,
    deletionLedgerAuthorityManifest: ledgerAuthority.manifestPath,
    outputDirectory: path.join(artifactParent, "snapshot"),
    candidateSha: "a".repeat(40),
    operatorId: "migration-operator-target-test",
    maintenanceReference: "approved-maintenance-target-test",
    maintenanceConfirmed: true,
    capturedAt: NOW,
  });
  const planned = await createPostgresMigrationPlan({
    snapshotManifestPath: snapshot.manifestPath,
    expectedSnapshotManifestSha256: snapshot.manifestSha256,
    outputPlanPath: path.join(snapshot.snapshotDirectory, "migration-plan.json"),
    chunkRows: 1,
  });
  const targetDdlPath = path.join(root, "target-ddl.sql");
  fs.writeFileSync(targetDdlPath, "-- exact native target DDL fixture\n", { mode: 0o600 });
  const targetDdlSha256 = sha256PostgresMigrationBytes(fs.readFileSync(targetDdlPath));
  const rootCaFile = path.join(root, "railway-root-ca.pem");
  fs.writeFileSync(rootCaFile, TEST_POSTGRES_RAILWAY_ROOT_CA_PEM, { mode: 0o600 });
  const fake = new StrictFakePostgresTarget();
  return {
    fake,
    input: {
      snapshotManifestPath: snapshot.manifestPath,
      expectedSnapshotManifestSha256: snapshot.manifestSha256,
      planPath: planned.planPath,
      expectedPlanSha256: planned.planSha256,
      targetDdlPath,
      expectedTargetDdlSha256: targetDdlSha256,
      targetUrl: TARGET_URL,
      expectedTargetUrlSha256: sha256PostgresMigrationBytes(TARGET_URL),
      rootCaFile,
      expectedRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
      expectedTransportAuthoritySha256:
        postgresMigrationTargetInternals.transportAuthoritySha256({
          targetUrl: TARGET_URL,
          expectedRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
        }),
      expectedTargetIdentitySha256: fake.identitySha256,
      expectedEnvironment: "permanent-staging",
      candidateSha: "a".repeat(40),
      approvalReference: "approved-target-apply-reference",
      operatorId: "migration-operator-target-test",
    },
    secrets: [
      root,
      "one-private@example.test",
      "PRIVATE_PASSWORD_one",
      "PRIVATE_STOUT",
      "PRIVATE_STATE_KEY",
      "PRIVATE_CORRELATION_SECRET",
      "PRIVATE_KEY_ID",
      "PRIVATE_CIPHERTEXT_PRESERVED",
      "PRIVATE_EVIDENCE_DO_NOT_RECEIPT",
      "PRIVATE_LEDGER_REQUEST",
      "PRIVATE_LEDGER_USER",
    ],
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("direct Postgres migration TLS authority", () => {
  it("accepts only the exact Railway private verify-full URL and binds the CA authority", () => {
    const validated = postgresMigrationTargetInternals.validateTargetUrl(TARGET_URL);
    const authoritySha256 = postgresMigrationTargetInternals.transportAuthoritySha256({
      targetUrl: TARGET_URL,
      expectedRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
    });

    expect(validated.digest).toBe(sha256PostgresMigrationBytes(TARGET_URL));
    expect(validated.sourceUrlAuthority).toEqual({
      hostname: "migration-target.railway.internal",
      port: 5432,
    });
    expect(authoritySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(postgresMigrationTargetInternals.transportAuthoritySha256({
      targetUrl: TARGET_URL,
      expectedRootCaDerSha256: "0".repeat(64),
    })).not.toBe(authoritySha256);
  });

  it("fails closed on unauthenticated, ambiguous, proxy, and non-Railway inputs", () => {
    for (const targetUrl of [
      "postgresql://user:secret@db.example.test:5432/db?sslmode=require&uselibpqcompat=false",
      "postgresql://user:secret@db.example.test:5432/db?sslmode=require&uselibpqcompat=true&uselibpqcompat=true",
      "postgresql://user:secret@db.example.test:5432/db?sslmode=verify-ca",
      "postgresql://user:secret@db.example.test:5432/db?sslmode=verify-ca&sslrootcert=",
      "postgresql://user:secret@migration-target.railway.internal:5432/db?sslmode=require",
      "postgresql://user:secret@migration-target.railway.internal:5432/db?sslmode=verify-ca",
      "postgresql://user:secret@migration-target.railway.internal:5432/db?sslmode=verify-full&application_name=changed",
      "postgresql://user%0Aadmin:secret@migration-target.railway.internal:5432/db?sslmode=verify-full",
      "postgresql://user:secret@migration-target.railway.internal:5432/db%2Fshadow?sslmode=verify-full",
      "postgresql://user:secret@pooler.railway.internal:6543/db?sslmode=verify-full",
      "postgresql://user:secret@127.0.0.1:5432/db?sslmode=disable",
    ]) {
      expect(() => postgresMigrationTargetInternals.validateTargetUrl(targetUrl)).toThrowError(
        expect.objectContaining({ code: "TARGET_UNSAFE" }),
      );
    }
  });

  it("dials only the pinned fd12 address with localhost identity and fences every query", async () => {
    const assertExact = vi.fn(async () => undefined);
    const closeTransport = vi.fn(async () => undefined);
    const transport: PostgresRailwayStockLocalhostCaTransport = {
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
      sourceUrlAuthority: {
        hostname: "migration-target.railway.internal",
        port: 5432,
      },
      resolvedAddress: "fd12:3456:789a::1",
      temporaryDirectory: "/private/tmp/pintpath-migration-transport",
      passwordFileDirectory: "/private/tmp/pintpath-migration-transport",
      passwordFileHost: "localhost",
      nodeConnection: {
        host: "fd12:3456:789a::1",
        port: 5432,
        ssl: {
          ca: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
          servername: "localhost",
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          checkServerIdentity:
            checkPostgresRailwayStockLocalhostServerIdentity,
        },
      },
      libpqEnvironment: {
        PGHOST: "localhost",
        PGHOSTADDR: "fd12:3456:789a::1",
        PGPORT: "5432",
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: "/private/tmp/pintpath-migration-transport/railway-root-ca.pem",
        PGSSLMINPROTOCOLVERSION: "TLSv1.2",
        PGSSLSNI: "1",
      },
      assertExact,
      close: closeTransport,
    };
    const query = vi.fn(async (text: string) => ({
      rows: text.includes("session-hardening") ? [] : [{ ok: true }],
      rowCount: text.includes("session-hardening") ? null : 1,
    }));
    const client = {
      connect: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
      query,
    } as unknown as Client;
    const createPgClient = vi.fn((_config: ClientConfig) => client);
    const openTransport = vi.fn(async () => transport);

    const connection = await postgresMigrationTargetInternals.openDirectConnection({
      targetUrl: TARGET_URL,
      rootCaFile: "/private/tmp/reviewed-railway-root-ca.pem",
      expectedRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
    }, {
      createPgClient,
      getUid: () => 501,
      getEuid: () => 501,
      openTransport,
    });
    const result = await connection.query<{ ok: boolean }>("SELECT true AS ok");
    await connection.close();

    expect(openTransport).toHaveBeenCalledWith(expect.objectContaining({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      expectedRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
      expectedUid: 501,
      sourceUrlAuthority: {
        hostname: "migration-target.railway.internal",
        port: 5432,
      },
    }));
    expect(createPgClient).toHaveBeenCalledWith(expect.objectContaining({
      application_name: "pintpath-postgres-migration",
      database: "pintpath",
      host: "fd12:3456:789a::1",
      options: "-c role=pintpath_migrator",
      password: "migration-password",
      port: 5432,
      ssl: transport.nodeConnection.ssl,
      user: "migration-user",
    }));
    expect(createPgClient.mock.calls[0]![0]).not.toHaveProperty("connectionString");
    expect(result).toEqual({ rows: [{ ok: true }], rowCount: 1 });
    expect(assertExact).toHaveBeenCalledTimes(6);
    expect(client.end).toHaveBeenCalledOnce();
    expect(closeTransport).toHaveBeenCalledOnce();
  });
});

describe("deterministic Postgres migration target conversion", () => {
  it("converts every semantic source type without losing exact values", () => {
    const cases: Array<[PostgresMigrationColumnContract, unknown, unknown]> = [
      [["flag", "INTEGER", "boolean", false, 0], 1n, true],
      [["json", "TEXT", "json-object", false, 0], '{"z":1.00,"a":2e0}', '{"a":2,"z":1}'],
      [["instant", "TEXT", "utc-instant", false, 0], "2026-08-08T01:02:03.4+10:00", "2026-08-07T15:02:03.400000Z"],
      [["time", "TEXT", "local-time", false, 0], "16:30", "16:30:00.000000"],
      [["decimal", "REAL", "decimal", false, 0], 1.25, "125e-2"],
      [["float", "REAL", "float64", false, 0], -0, -0],
      [["binary", "BLOB", "binary", false, 0], Buffer.from("PRIVATE_BINARY"), Buffer.from("PRIVATE_BINARY")],
      [["integer", "INTEGER", "integer", false, 0], 9_223_372_036_854_775_807n, "9223372036854775807"],
      [["month", "TEXT", "calendar-month", false, 0], "2026-08", "2026-08"],
      [["text", "TEXT", "text", false, 0], "PRIVATE_ID", "PRIVATE_ID"],
    ];
    for (const [column, source, expected] of cases) {
      const actual = postgresMigrationTargetInternals.transformSourceValue(source, column);
      if (Object.is(expected, -0)) expect(Object.is(actual, -0)).toBe(true);
      else expect(actual).toEqual(expected);
    }
    expect(() => postgresMigrationTargetInternals.transformSourceValue(
      9_223_372_036_854_775_808n,
      ["integer", "INTEGER", "integer", false, 0],
    )).toThrowError(expect.objectContaining({ code: "SOURCE_DATA_INVALID" }));
    expect(() => postgresMigrationTargetInternals.validateTargetUrl(
      "postgresql://user:secret@pooler.example.test:6543/db?sslmode=require",
    )).toThrowError(expect.objectContaining({ code: "TARGET_UNSAFE" }));
    expect(() => postgresMigrationTargetInternals.validateTargetUrl(
      "postgresql://user:secret@db.example.test:5432/db",
    )).toThrowError(expect.objectContaining({ code: "TARGET_UNSAFE" }));
    expect(safePostgresMigrationTargetFailure(new Error("PRIVATE_DATABASE_PASSWORD"))).toEqual({
      code: "UNEXPECTED_FAILURE",
      message: "Postgres migration target command failed unexpectedly; inspect protected application logs.",
      exitCode: 3,
      retryable: false,
    });
  });
});

describe("resumable Postgres migration apply and reconciliation", () => {
  it("imports every table, preserves private/correlation secrets, and emits only hashes and counts", async () => {
    const root = temporaryDirectory();
    const { input, fake, secrets } = await createInput(root);
    const receipt = await applyPostgresMigrationWithConnection(input, fake);
    const verifiedReceipt = await verifyPostgresMigrationWithConnection(input, fake);

    expect(receipt).toMatchObject({
      kind: "pint-path-postgres-migration-receipt",
      version: 3,
      status: "awaiting-verification",
      tableCount: 56,
      columnCount: 717,
      foreignKeyCount: 76,
      expectedEnvironment: "permanent-staging",
    });
    expect(receipt.zeroRowTableCount).toBeGreaterThan(0);
    expect(receipt.chunkCount).toBe(fake.chunks.size);
    expect(fake.run?.status).toBe("ready");
    expect(fake.metadata.get("import_state")).toBe("ready");
    expect(verifiedReceipt.status).toBe("ready");
    expect(verifiedReceipt.applyReceiptSha256).toBe(receipt.receiptSha256);
    const readyReceiptSha256 = fake.run?.receiptSha256;
    await expect(applyPostgresMigrationWithConnection(input, fake))
      .rejects.toMatchObject({ code: "RESUME_MISMATCH" });
    expect(fake.run?.status).toBe("ready");
    expect(fake.run?.receiptSha256).toBe(readyReceiptSha256);
    expect(fake.metadata.get("import_state")).toBe("ready");
    expect([...fake.rows.values()].reduce((total, rows) => total + rows.size, 0)).toBe(receipt.rowCount);

    const secretTable = POSTGRES_MIGRATION_CONTRACT.tables.find(
      (table) => table.name === "account_deletion_notice_recipient_secrets",
    )!;
    const secretRow = [...fake.rows.get(secretTable.name)!.values()][0]!;
    expect(secretRow[secretTable.columns.findIndex((column) => column[0] === "ciphertext")]).toEqual(
      Buffer.from("PRIVATE_CIPHERTEXT_PRESERVED", "utf8"),
    );
    const outbox = POSTGRES_MIGRATION_CONTRACT.tables.find(
      (table) => table.name === "account_deletion_completion_outbox",
    )!;
    const outboxRow = [...fake.rows.get(outbox.name)!.values()][0]!;
    expect(outboxRow[outbox.columns.findIndex((column) => column[0] === "idempotency_key")]).toBe(
      "PRIVATE_CORRELATION_SECRET",
    );

    const receiptText = JSON.stringify(receipt);
    for (const secret of secrets) expect(receiptText).not.toContain(secret);
    for (const [key, value] of Object.entries(receipt)) {
      if (key.endsWith("Sha256") || key === "candidateSha" || key === "sourceSchemaFingerprint") {
        expect(value).toMatch(/^[a-f0-9]{40,64}$/);
      }
      else expect(["kind", "version", "status", "expectedEnvironment", "tableCount", "columnCount", "rowCount", "chunkCount", "zeroRowTableCount", "foreignKeyCount"]).toContain(key);
    }
    expect(fs.readFileSync(input.snapshotManifestPath, "utf8")).not.toContain("PRIVATE_CIPHERTEXT_PRESERVED");
    expect(fs.readFileSync(input.planPath, "utf8")).not.toContain("PRIVATE_CIPHERTEXT_PRESERVED");
  });

  it("commits checkpoints independently, resumes after interruption, and reruns idempotently", async () => {
    const root = temporaryDirectory();
    const { input, fake } = await createInput(root);
    fake.interruptOnInsertCall = 2;

    await expect(applyPostgresMigrationWithConnection(input, fake)).rejects.toMatchObject({ code: "IMPORT_FAILED" });
    expect(fake.run?.status).toBe("failed");
    expect(fake.metadata.get("import_state")).toBe("failed");
    expect(fake.chunks.size).toBe(1);
    const firstCheckpoint = [...fake.chunks.values()][0]!;
    expect(firstCheckpoint.targetSha256).toBe(firstCheckpoint.sourceTransformedSha256);

    fake.interruptOnInsertCall = null;
    const resumed = await applyPostgresMigrationWithConnection(input, fake);
    expect(resumed.status).toBe("awaiting-verification");
    expect(fake.run?.status).toBe("verifying");
    const checkpointCount = fake.chunks.size;
    const rowCount = resumed.rowCount;

    const rerun = await applyPostgresMigrationWithConnection(input, fake);
    expect(rerun).toEqual(resumed);
    expect(fake.chunks.size).toBe(checkpointCount);
    expect([...fake.rows.values()].reduce((total, rows) => total + rows.size, 0)).toBe(rowCount);
  });

  it("rejects a changed completed chunk and leaves the run not ready", async () => {
    const root = temporaryDirectory();
    const { input, fake } = await createInput(root);
    await applyPostgresMigrationWithConnection(input, fake);
    fake.tamper("accounts", "email", "externally-changed@example.test");

    await expect(applyPostgresMigrationWithConnection(input, fake)).rejects.toMatchObject({ code: "TARGET_CHANGED" });
    expect(fake.run?.status).toBe("failed");
    expect(fake.run?.failureCode).toBe("TARGET_CHANGED");
    expect(fake.metadata.get("import_state")).toBe("failed");
  });

  it("fails the run if the sealed deletion-ledger authority changes during import", async () => {
    const root = temporaryDirectory();
    const { input, fake } = await createInput(root);
    const currentLedger = path.join(
      path.dirname(input.snapshotManifestPath),
      POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY,
      POSTGRES_MIGRATION_LEDGER_CURRENT_FILE,
    );
    fake.onInsertCall = (call) => {
      if (call === 1) fs.appendFileSync(currentLedger, "tampered");
    };

    await expect(applyPostgresMigrationWithConnection(input, fake)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fake.run?.status).toBe("failed");
    expect(fake.run?.failureCode).toBe("SOURCE_CHANGED");
    expect(fake.metadata.get("import_state")).toBe("failed");
  });

  it("rejects copied source-evidence drift before apply and during verification", async () => {
    const root = temporaryDirectory();
    const first = await createInput(root);
    const evidenceFile = path.join(
      path.dirname(first.input.snapshotManifestPath),
      POSTGRES_MIGRATION_SNAPSHOT_EVIDENCE_DIRECTORY,
      "private-evidence.bin",
    );
    fs.appendFileSync(evidenceFile, "tampered");
    await expect(applyPostgresMigrationWithConnection(first.input, first.fake))
      .rejects.toMatchObject({ code: "ARTIFACT_INVALID" });

    const second = await createInput(temporaryDirectory());
    await applyPostgresMigrationWithConnection(second.input, second.fake);
    const secondEvidence = path.join(
      path.dirname(second.input.snapshotManifestPath),
      POSTGRES_MIGRATION_SNAPSHOT_EVIDENCE_DIRECTORY,
      "private-evidence.bin",
    );
    fs.appendFileSync(secondEvidence, "tampered-after-apply");
    await expect(verifyPostgresMigrationWithConnection(second.input, second.fake))
      .rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });

  it("fails closed on target URL, identity, candidate, and approval/operator binding changes", async () => {
    const root = temporaryDirectory();
    const { input, fake } = await createInput(root);
    await expect(applyPostgresMigrationWithConnection({
      ...input,
      targetUrl: TARGET_URL.replace("migration-password", "changed-password"),
    }, fake)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    await expect(applyPostgresMigrationWithConnection({
      ...input,
      expectedTargetIdentitySha256: "0".repeat(64),
    }, fake)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    await expect(applyPostgresMigrationWithConnection({
      ...input,
      candidateSha: "b".repeat(40),
    }, fake)).rejects.toMatchObject({ code: "PLAN_MISMATCH" });
    await expect(applyPostgresMigrationWithConnection({
      ...input,
      operatorId: "different-migration-operator",
    }, fake)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });

    const first = await applyPostgresMigrationWithConnection(input, fake);
    await expect(applyPostgresMigrationWithConnection({
      ...input,
      approvalReference: "different-approved-reference",
    }, fake)).rejects.toMatchObject({ code: "RESUME_MISMATCH" });
    expect(first.status).toBe("awaiting-verification");
  });

  it("derives verifier trust only from one exact candidate-bound database authority row", async () => {
    const missing = await createInput(temporaryDirectory());
    missing.fake.authorityRows = [];
    await expect(applyPostgresMigrationWithConnection(missing.input, missing.fake))
      .rejects.toMatchObject({ code: "TARGET_UNSAFE" });

    const duplicate = await createInput(temporaryDirectory());
    duplicate.fake.authorityRows = [
      { ...VERIFIER_AUTHORITY },
      { ...VERIFIER_AUTHORITY },
    ];
    await expect(applyPostgresMigrationWithConnection(duplicate.input, duplicate.fake))
      .rejects.toMatchObject({ code: "TARGET_UNSAFE" });

    const wrongCandidate = await createInput(temporaryDirectory());
    wrongCandidate.fake.authorityRows = [{
      ...VERIFIER_AUTHORITY,
      candidateSha: "b".repeat(40),
    }];
    await expect(applyPostgresMigrationWithConnection(
      wrongCandidate.input,
      wrongCandidate.fake,
    )).rejects.toMatchObject({ code: "TARGET_UNSAFE" });

    const wrongEnvironment = await createInput(temporaryDirectory());
    wrongEnvironment.fake.authorityRows = [{
      ...VERIFIER_AUTHORITY,
      expectedEnvironment: "production",
    }];
    await expect(applyPostgresMigrationWithConnection(
      wrongEnvironment.input,
      wrongEnvironment.fake,
    )).rejects.toMatchObject({ code: "TARGET_UNSAFE" });
  });

  it("has no dependency on the sanitized data:backup path", () => {
    const source = fs.readFileSync(
      path.resolve("src/db/postgres-migration-target.ts"),
      "utf8",
    );
    expect(source).not.toContain("backup-data");
    expect(source).not.toContain("sanitizeAccountDeletionRecipientSecretsInBackup");
    expect(source).toContain("POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE");
  });
});
