import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT,
  SourceEvidenceObjectRepository,
  SourceEvidenceObjectRepositoryError,
  sourceEvidenceAccountLockKey,
  type RegisterSourceEvidenceObjectInput,
  type SourceEvidenceStorageProvider,
} from "../src/db/source-evidence-object.repository.js";
import {
  AsyncSqliteDatabase,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const CREATED_AT = "2026-08-09T00:00:00.000Z";
const RETENTION_EXPIRES_AT = "2026-11-07T00:00:00.000Z";
const DELETED_AT = "2026-11-08T00:00:00.000Z";
const BYTES = Buffer.from("private evidence", "utf8");

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: SourceEvidenceObjectRepository;
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  options: { status?: string; authProvider?: string } = {},
): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, auth_provider, role, subscription_status,
       status, created_at, updated_at
     ) VALUES (?, ?, 'hash', ?, 'user', 'free', ?, ?, ?)`,
  ).run(
    id,
    `${id}@example.test`,
    options.authProvider ?? "local",
    options.status ?? "active",
    CREATED_AT,
    CREATED_AT,
  );
}

function lockDeletion(raw: BetterSqlite3.Database, ownerUserId: string, status = "processing"): void {
  raw.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, status, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `deletion-${ownerUserId}`,
    ownerUserId,
    status,
    CREATED_AT,
    RETENTION_EXPIRES_AT,
    CREATED_AT,
    CREATED_AT,
  );
}

function registration(
  overrides: Partial<RegisterSourceEvidenceObjectInput> = {},
): RegisterSourceEvidenceObjectInput {
  const provider = overrides.storageProvider ?? "sqlite_private";
  return {
    id: "evidence-default",
    ownerUserId: "owner-active",
    storageProvider: provider,
    objectPath: provider === "supabase_private"
      ? "owner-active/2026-08/evidence-default.jpg"
      : provider === "filesystem_private"
        ? "evidence/2026-08/evidence-default.jpg"
        : "evidence/evidence-default",
    mimeType: "image/jpeg",
    byteSize: BYTES.length,
    dataBase64: provider === "sqlite_private" ? BYTES.toString("base64") : null,
    externalUrl: null,
    retentionExpiresAt: RETENTION_EXPIRES_AT,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function expectCode(code: SourceEvidenceObjectRepositoryError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof SourceEvidenceObjectRepositoryError && error.code === code;
}

/** Throws after SQLite accepted one evidence insert so the outer transaction must roll back. */
class InsertFaultDatabase implements SqlDatabase {
  readonly dialect = "sqlite" as const;
  private armed = true;

  constructor(private readonly delegate: AsyncSqliteDatabase) {}

  prepare(sql: string): SqlStatement {
    const statement = this.delegate.prepare(sql);
    return {
      run: async (...bindings: unknown[]) => {
        const result = await statement.run(...bindings);
        if (this.armed && /INSERT\s+OR\s+IGNORE\s+INTO\s+source_evidence_objects/i.test(sql)) {
          this.armed = false;
          throw new Error("injected private database detail must never escape");
        }
        return result;
      },
      get: async <Row>(...bindings: unknown[]) => statement.get(...bindings) as Promise<Row | undefined>,
      all: async <Row>(...bindings: unknown[]) => statement.all(...bindings) as Promise<Row[]>,
    } as SqlStatement;
  }

  async exec(sql: string): Promise<void> {
    await this.delegate.exec(sql);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return this.delegate.transaction(work);
  }

  async close(): Promise<void> {
    // The fixture owns the shared connection.
  }

  metrics(): SqlPoolMetrics {
    return this.delegate.metrics();
  }
}

describe("SourceEvidenceObjectRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map(async (database) => {
      if (database.metrics().totalConnections > 0) await database.close();
    }));
  });

  function fixture(): Fixture {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    insertAccount(raw, "owner-active");
    insertAccount(raw, "owner-warned", { status: "warned" });
    const database = new AsyncSqliteDatabase(raw);
    const created = {
      raw,
      database,
      repository: new SourceEvidenceObjectRepository(database),
    };
    databases.push(database);
    return created;
  }

  it("exports one immutable, validated, versioned account lock contract", () => {
    expect(SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT).toEqual({
      version: 1,
      accountPrefix: "source-evidence:account:",
      keyOrder: "distinct-lexicographic-ascending",
      hashFunction: "pg_catalog.hashtext",
      lockFunction: "pg_catalog.pg_advisory_xact_lock",
      order: "sorted-transaction-advisory-locks-before-account-row-before-source-evidence-row",
      deletionCoordination:
        "account-deletion-and-account-privacy-mutations-must-acquire-the-same-account-key-before-account-or-evidence-rows",
    });
    expect(Object.isFrozen(SOURCE_EVIDENCE_OBJECT_LOCK_CONTRACT)).toBe(true);
    expect(sourceEvidenceAccountLockKey("owner-active")).toBe("source-evidence:account:owner-active");
    expect(() => sourceEvidenceAccountLockKey("  ")).toThrow(SourceEvidenceObjectRepositoryError);
    expect(() => sourceEvidenceAccountLockKey("bad\naccount")).toThrow(SourceEvidenceObjectRepositoryError);
    expect(() => sourceEvidenceAccountLockKey("x".repeat(256))).toThrow(SourceEvidenceObjectRepositoryError);
  });

  it("registers every current provider, permits schema-null owners, and replays only exact input", async () => {
    const { raw, repository } = fixture();
    const cases: Array<{
      provider: SourceEvidenceStorageProvider;
      id: string;
      ownerUserId: string | null;
    }> = [
      { provider: "sqlite_private", id: "inline", ownerUserId: "owner-active" },
      { provider: "filesystem_private", id: "filesystem", ownerUserId: null },
      { provider: "supabase_private", id: "supabase", ownerUserId: "owner-warned" },
    ];

    for (const item of cases) {
      const input = registration({
        id: item.id,
        ownerUserId: item.ownerUserId,
        storageProvider: item.provider,
        objectPath: item.provider === "sqlite_private"
          ? `evidence/${item.id}`
          : `evidence/2026-08/${item.id}.jpg`,
        dataBase64: item.provider === "sqlite_private" ? BYTES.toString("base64") : null,
      });
      await expect(repository.registerSourceEvidenceObject(input)).resolves.toMatchObject({
        state: "created",
        object: {
          id: item.id,
          ownerUserId: item.ownerUserId,
          storageProvider: item.provider,
          byteSize: BYTES.length,
          deletedAt: null,
        },
      });
      await expect(repository.registerSourceEvidenceObject(input)).resolves.toMatchObject({
        state: "replayed",
        object: { id: item.id },
      });
      await expect(repository.getSourceEvidenceObject(item.id)).resolves.toEqual(
        expect.objectContaining({ id: item.id, createdAt: CREATED_AT }),
      );
    }
    expect(raw.prepare("SELECT count(*) AS count FROM source_evidence_objects").get()).toEqual({ count: 3 });
    await expect(repository.getSourceEvidenceObject("missing")).resolves.toBeNull();
  });

  it("has one concurrent winner and classifies exact replay separately from identity conflicts", async () => {
    const { raw, repository } = fixture();
    const input = registration({ id: "concurrent", objectPath: "evidence/concurrent" });
    const results = await Promise.all([
      repository.registerSourceEvidenceObject(input),
      repository.registerSourceEvidenceObject(input),
      repository.registerSourceEvidenceObject(input),
    ]);
    expect(results.filter((result) => result.state === "created")).toHaveLength(1);
    expect(results.filter((result) => result.state === "replayed")).toHaveLength(2);
    expect(raw.prepare("SELECT count(*) AS count FROM source_evidence_objects").get()).toEqual({ count: 1 });

    await expect(repository.registerSourceEvidenceObject({
      ...input,
      retentionExpiresAt: "2026-12-01T00:00:00.000Z",
    })).rejects.toSatisfy(expectCode("evidence_conflict"));
    await expect(repository.registerSourceEvidenceObject({
      ...input,
      id: "different-id",
    })).rejects.toSatisfy(expectCode("evidence_conflict"));
  });

  it("locks out missing, suspended, deleted, deletion-processing, and corrupt owner accounts", async () => {
    const { raw, repository } = fixture();
    insertAccount(raw, "owner-suspended", { status: "suspended" });
    insertAccount(raw, "owner-deleted", { authProvider: "deleted", status: "suspended" });
    insertAccount(raw, "owner-deleting");
    insertAccount(raw, "owner-corrupt", { status: "unknown" });
    lockDeletion(raw, "owner-deleting");

    await expect(repository.registerSourceEvidenceObject(registration({
      id: "missing-owner",
      ownerUserId: "missing",
      objectPath: "evidence/missing-owner",
    }))).rejects.toSatisfy(expectCode("account_not_found"));
    await expect(repository.registerSourceEvidenceObject(registration({
      id: "suspended-owner",
      ownerUserId: "owner-suspended",
      objectPath: "evidence/suspended-owner",
    }))).rejects.toSatisfy(expectCode("account_ineligible"));
    await expect(repository.registerSourceEvidenceObject(registration({
      id: "deleted-owner",
      ownerUserId: "owner-deleted",
      objectPath: "evidence/deleted-owner",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.registerSourceEvidenceObject(registration({
      id: "deleting-owner",
      ownerUserId: "owner-deleting",
      objectPath: "evidence/deleting-owner",
    }))).rejects.toSatisfy(expectCode("deletion_locked"));
    await expect(repository.registerSourceEvidenceObject(registration({
      id: "corrupt-owner",
      ownerUserId: "owner-corrupt",
      objectPath: "evidence/corrupt-owner",
    }))).rejects.toSatisfy(expectCode("malformed_record"));
    expect(raw.prepare("SELECT count(*) AS count FROM source_evidence_objects").get()).toEqual({ count: 0 });
  });

  it("rejects unsafe paths, providers, MIME, timestamps, sizes, and provider payload mismatches", async () => {
    const { repository } = fixture();
    const invalid: RegisterSourceEvidenceObjectInput[] = [
      registration({ storageProvider: "unknown" as SourceEvidenceStorageProvider }),
      registration({ objectPath: "../escape" }),
      registration({ objectPath: "evidence/file name.jpg" }),
      registration({ objectPath: `evidence/${"x".repeat(1_025)}` }),
      registration({ mimeType: "text/html" }),
      registration({ byteSize: 0 }),
      registration({ byteSize: 8 * 1024 * 1024 + 1 }),
      registration({ dataBase64: Buffer.from("different").toString("base64") }),
      registration({ dataBase64: "not-base64" }),
      registration({ createdAt: "2026-08-09 00:00:00" }),
      registration({ retentionExpiresAt: CREATED_AT }),
      registration({ retentionExpiresAt: "2037-01-01T00:00:00.000Z" }),
      registration({ externalUrl: "https://private.example/object" as null }),
      registration({ storageProvider: "filesystem_private", dataBase64: BYTES.toString("base64") }),
      registration({ storageProvider: "sqlite_private", dataBase64: null }),
    ];
    for (const input of invalid) {
      await expect(repository.registerSourceEvidenceObject(input))
        .rejects.toSatisfy(expectCode("invalid_input"));
    }
  });

  it("strictly decodes native rows while recognizing only a payload-cleared deletion tombstone", async () => {
    const { raw, repository } = fixture();
    const input = registration({ id: "tombstone", objectPath: "evidence/tombstone" });
    await repository.registerSourceEvidenceObject(input);
    raw.prepare(
      `UPDATE source_evidence_objects
          SET byte_size = NULL, data_base64 = NULL, deleted_at = ?
        WHERE id = ?`,
    ).run(DELETED_AT, input.id);
    await expect(repository.getSourceEvidenceObject(input.id)).resolves.toMatchObject({
      id: input.id,
      byteSize: null,
      dataBase64: null,
      deletedAt: DELETED_AT,
    });
    await expect(repository.registerSourceEvidenceObject(input))
      .rejects.toSatisfy(expectCode("evidence_conflict"));

    const corruptRows = [
      { id: "bad-provider", provider: "public", bytes: BYTES.length, data: BYTES.toString("base64"), external: null, deleted: null },
      { id: "bad-external", provider: "sqlite_private", bytes: BYTES.length, data: BYTES.toString("base64"), external: "https://secret.example", deleted: null },
      { id: "bad-size", provider: "sqlite_private", bytes: 8 * 1024 * 1024 + 1, data: BYTES.toString("base64"), external: null, deleted: null },
      { id: "bad-tombstone", provider: "sqlite_private", bytes: BYTES.length, data: BYTES.toString("base64"), external: null, deleted: DELETED_AT },
    ];
    for (const row of corruptRows) {
      raw.prepare(
        `INSERT INTO source_evidence_objects (
           id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
           data_base64, external_url, retention_expires_at, deleted_at, created_at
         ) VALUES (?, NULL, ?, ?, 'image/jpeg', ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.provider,
        `evidence/${row.id}`,
        row.bytes,
        row.data,
        row.external,
        RETENTION_EXPIRES_AT,
        row.deleted,
        CREATED_AT,
      );
      await expect(repository.getSourceEvidenceObject(row.id))
        .rejects.toSatisfy(expectCode("malformed_record"));
    }
  });

  it("rolls back a post-insert failure and returns no raw database detail", async () => {
    const { raw, database, repository } = fixture();
    const faulty = new SourceEvidenceObjectRepository(new InsertFaultDatabase(database));
    const input = registration({ id: "rollback", objectPath: "evidence/rollback" });
    const error = await faulty.registerSourceEvidenceObject(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SourceEvidenceObjectRepositoryError);
    expect(error).toMatchObject({ code: "persistence_failure" });
    expect((error as Error).message).not.toContain("private database detail");
    expect(raw.prepare("SELECT count(*) AS count FROM source_evidence_objects").get()).toEqual({ count: 0 });
    await expect(repository.registerSourceEvidenceObject(input)).resolves.toMatchObject({ state: "created" });
  });
});
