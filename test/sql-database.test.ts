import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { Client, Pool, types as postgresTypes, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresDatabase,
  sqlDatabaseInternals,
} from "../src/db/sql-database.js";
import { checkPostgresRailwayStockLocalhostServerIdentity } from "../src/lib/postgres-railway-stock-localhost-ca.js";

const {
  buildPostgresStartupOptions,
  compilePostgresQuery,
  normalizePostgresClientUrl,
  postgresRailwayStockLocalhostPoolConnection,
} = sqlDatabaseInternals;

function parsedClientSsl(clientUrl: string): Record<string, unknown> {
  const client = new Client({ connectionString: clientUrl });
  return (client as unknown as { ssl: Record<string, unknown> }).ssl;
}

describe("Postgres SQL compilation", () => {
  it("compiles positional placeholders in binding order", () => {
    expect(compilePostgresQuery(
      "SELECT * FROM accounts WHERE id = ? AND trust_score > ?",
      ["account-1", 50],
    )).toEqual({
      text: "SELECT * FROM accounts WHERE id = $1 AND trust_score > $2",
      values: ["account-1", 50],
    });
  });

  it("compiles named placeholders once and reuses their parameter number", () => {
    expect(compilePostgresQuery(
      `UPDATE accounts
       SET updated_at = @now
       WHERE id = @accountId OR public_account_id = @accountId`,
      { accountId: "account-1", now: "2026-08-08T00:00:00.000Z" },
    )).toEqual({
      text: `UPDATE accounts
       SET updated_at = $1
       WHERE id = $2 OR public_account_id = $2`,
      values: ["2026-08-08T00:00:00.000Z", "account-1"],
    });
  });

  it("does not compile placeholder-looking text inside literals, identifiers, or comments", () => {
    const sql = `SELECT '?' AS literal, 'it''s @ignored' AS escaped, "column?" AS "@alias"
FROM accounts
WHERE id = ? -- ? and @ignored stay comments
  AND public_account_id = ? /* ? and @ignored stay comments */`;

    expect(compilePostgresQuery(sql, ["account-1", "public-1"])).toEqual({
      text: `SELECT '?' AS literal, 'it''s @ignored' AS escaped, "column?" AS "@alias"
FROM accounts
WHERE id = $1 -- ? and @ignored stay comments
  AND public_account_id = $2 /* ? and @ignored stay comments */`,
      values: ["account-1", "public-1"],
    });
  });

  it("rejects missing, excess, mixed-style, and unterminated bindings", () => {
    expect(() => compilePostgresQuery("SELECT ?", []))
      .toThrow("Missing positional SQL binding.");
    expect(() => compilePostgresQuery("SELECT 1", ["unused"]))
      .toThrow("Received 1 SQL bindings but used 0.");
    expect(() => compilePostgresQuery("SELECT ?", { value: "wrong-style" }))
      .toThrow("Positional SQL placeholder used with named bindings.");
    expect(() => compilePostgresQuery("SELECT @value", ["wrong-style"]))
      .toThrow("Named SQL placeholder used with positional bindings.");
    expect(() => compilePostgresQuery("SELECT @missing", {}))
      .toThrow("Missing named SQL binding: missing");
    expect(() => compilePostgresQuery("SELECT ? /* unfinished", [1]))
      .toThrow("SQL contains an unterminated quote or comment.");
  });

  it("translates INSERT OR IGNORE with and without RETURNING", () => {
    expect(compilePostgresQuery(
      "INSERT OR IGNORE INTO revoked_provider_sessions (user_id) VALUES (?);",
      ["account-1"],
    )).toEqual({
      text: "INSERT INTO revoked_provider_sessions (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      values: ["account-1"],
    });
    expect(compilePostgresQuery(
      "INSERT OR IGNORE INTO stripe_webhook_events (id) VALUES (?) RETURNING id;",
      ["event-1"],
    )).toEqual({
      text: "INSERT INTO stripe_webhook_events (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id",
      values: ["event-1"],
    });
  });

  it("translates parameterized SQLite IS semantics without changing IS NULL", () => {
    expect(compilePostgresQuery(
      "SELECT * FROM events WHERE venue_id IS ? AND user_id IS NOT ? AND suburb IS NULL",
      [null, "account-1"],
    )).toEqual({
      text: "SELECT * FROM events WHERE venue_id IS NOT DISTINCT FROM $1 AND user_id IS DISTINCT FROM $2 AND suburb IS NULL",
      values: [null, "account-1"],
    });
  });

  it("removes SQLite NOCASE and translates the known scalar min/max forms", () => {
    expect(compilePostgresQuery(
      `SELECT min(1, confidence), min(100, trust_score + ?), max(0, trust_score - ?)
       FROM accounts
       ORDER BY display_name COLLATE NOCASE ASC`,
      [3, 4],
    )).toEqual({
      text: `SELECT least(1, confidence), least(100, trust_score + $1), greatest(0, trust_score - $2)
       FROM accounts
       ORDER BY display_name ASC`,
      values: [3, 4],
    });
  });
});

describe("Postgres connection URL validation", () => {
  const railwayNodeConnection = {
    host: "fd12:3456:789a::10",
    port: 5_432 as const,
    ssl: {
      ca: "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n",
      servername: "localhost" as const,
      rejectUnauthorized: true as const,
      minVersion: "TLSv1.2" as const,
      checkServerIdentity: checkPostgresRailwayStockLocalhostServerIdentity,
    },
  };

  it("pins each application pool to one reviewed effective NOLOGIN role", () => {
    expect(buildPostgresStartupOptions({
      activeRole: "pintpath_runtime",
      statementTimeoutMs: 12_000,
      idleInTransactionTimeoutMs: 13_000,
    })).toBe(
      "-c role=pintpath_runtime -c search_path=pintpath_app,pg_catalog "
      + "-c statement_timeout=12000 -c idle_in_transaction_session_timeout=13000 "
      + "-c lock_timeout=10000 -c synchronous_commit=on",
    );
    expect(buildPostgresStartupOptions({
      activeRole: "pintpath_maintenance",
    })).toContain("-c role=pintpath_maintenance");
  });

  it("rejects an arbitrary effective role before constructing a pool", () => {
    expect(() => buildPostgresStartupOptions({
      activeRole: "postgres" as "pintpath_runtime",
    })).toThrow("exact reviewed application role");
    expect(() => new PostgresDatabase({
      connectionString:
        "postgresql://external:password@example.invalid/pintpath?sslmode=require",
      activeRole: "postgres" as "pintpath_runtime",
    })).toThrow("exact reviewed application role");
  });

  it.each(["require", "verify-full"])(
    "accepts sslmode=%s without opening a connection",
    async (sslmode) => {
      const database = new PostgresDatabase({
        connectionString: `postgresql://runtime:password@example.invalid/pintpath?sslmode=${sslmode}`,
      });
      expect(database.dialect).toBe("postgres");
      await database.close();
    },
  );

  it("retains monotonic capacity-wait evidence after the live queue drains", async () => {
    const database = new PostgresDatabase({
      connectionString:
        "postgresql://runtime:password@example.invalid/pintpath?sslmode=require",
      maxConnections: 1,
    });
    const internals = database as unknown as { pool: Pool };
    const originalPool = internals.pool;
    let releaseCheckout!: (client: PoolClient) => void;
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [{ value: 1 }], rowCount: 1 })),
      release: vi.fn(),
    }) as unknown as PoolClient;
    const fakePool = {
      idleCount: 0,
      totalCount: 1,
      waitingCount: 0,
      connect: vi.fn(() => {
        fakePool.waitingCount = 1;
        return new Promise<PoolClient>((resolve) => {
          releaseCheckout = resolve;
        });
      }),
    };
    internals.pool = fakePool as unknown as Pool;
    try {
      const query = database.prepare("SELECT 1 AS value").get<{ value: number }>();
      await Promise.resolve();
      expect(database.metrics()).toMatchObject({
        waitingRequests: 1,
        capacityWaitEvents: 1,
        capacityWaitHighWater: 1,
      });

      fakePool.waitingCount = 0;
      releaseCheckout(client);
      await expect(query).resolves.toEqual({ value: 1 });
      expect(database.metrics()).toMatchObject({
        waitingRequests: 0,
        capacityWaitEvents: 1,
        capacityWaitHighWater: 1,
        capacityWaitDurationMs: expect.any(Number),
      });
      expect(database.metrics().capacityWaitDurationMs).toBeGreaterThanOrEqual(0);
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.listenerCount("error")).toBe(0);
    } finally {
      internals.pool = originalPool;
      await database.close();
    }
  });

  it.each([
    { priorPendingCheckout: 0, expectedWaitEvents: 0 },
    { priorPendingCheckout: 1, expectedWaitEvents: 1 },
  ])(
    "accounts for idle clients already claimed by $priorPendingCheckout synchronous checkout(s)",
    async ({ priorPendingCheckout, expectedWaitEvents }) => {
      const database = new PostgresDatabase({
        connectionString:
          "postgresql://runtime:password@example.invalid/pintpath?sslmode=require",
        maxConnections: 1,
      });
      const internals = database as unknown as { pool: Pool };
      const originalPool = internals.pool;
      let releaseCheckout!: (client: PoolClient) => void;
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn(async () => ({ rows: [{ value: 1 }], rowCount: 1 })),
        release: vi.fn(),
      }) as unknown as PoolClient;
      const fakePool = {
        idleCount: 1,
        totalCount: 1,
        waitingCount: priorPendingCheckout,
        connect: vi.fn(() => {
          fakePool.waitingCount += 1;
          return new Promise<PoolClient>((resolve) => {
            releaseCheckout = resolve;
          });
        }),
      };
      internals.pool = fakePool as unknown as Pool;
      try {
        const query = database.prepare("SELECT 1 AS value").get<{ value: number }>();
        await Promise.resolve();
        expect(database.metrics()).toMatchObject({
          capacityWaitEvents: expectedWaitEvents,
          capacityWaitHighWater: expectedWaitEvents,
        });

        fakePool.idleCount = 0;
        fakePool.waitingCount = 0;
        releaseCheckout(client);
        await expect(query).resolves.toEqual({ value: 1 });
        expect(client.release).toHaveBeenCalledTimes(1);
      } finally {
        internals.pool = originalPool;
        await database.close();
      }
    },
  );

  it.each(["direct query", "transaction"])(
    "handles a checked-out client error during a %s without an unhandled event",
    async (operation) => {
      const database = new PostgresDatabase({
        connectionString:
          "postgresql://runtime:password@example.invalid/pintpath?sslmode=require",
        maxConnections: 1,
      });
      const internals = database as unknown as { pool: Pool };
      const originalPool = internals.pool;
      const transportError = new Error("socket closed");
      let rejectActiveQuery!: (error: Error) => void;
      let markActiveQueryStarted!: () => void;
      const activeQueryStarted = new Promise<void>((resolve) => {
        markActiveQueryStarted = resolve;
      });
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn((text: string) => {
          if (operation === "transaction" && text === "BEGIN") {
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (operation === "transaction" && text === "ROLLBACK") {
            return Promise.reject(transportError);
          }
          return new Promise((_, reject) => {
            rejectActiveQuery = reject;
            markActiveQueryStarted();
          });
        }),
        release: vi.fn(),
      }) as unknown as PoolClient;
      const fakePool = {
        idleCount: 1,
        totalCount: 1,
        waitingCount: 0,
        connect: vi.fn(async () => client),
      };
      internals.pool = fakePool as unknown as Pool;
      try {
        const pending = operation === "transaction"
          ? database.transaction(() => database.prepare("SELECT 1").get())()
          : database.prepare("SELECT 1").get();
        await activeQueryStarted;
        expect(() => client.emit("error", transportError)).not.toThrow();
        rejectActiveQuery(transportError);
        await expect(pending).rejects.toBe(transportError);
        expect(client.release).toHaveBeenCalledTimes(1);
        expect(client.release).toHaveBeenCalledWith(transportError);
        expect(client.listenerCount("error")).toBe(0);
      } finally {
        internals.pool = originalPool;
        await database.close();
      }
    },
  );

  it("accepts sslmode=verify-ca with an explicit readable trust root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-postgres-ca-test-"));
    const certificatePath = path.join(root, "root-ca.pem");
    try {
      fs.writeFileSync(certificatePath, "PRIVATE_TEST_ROOT_CA", { mode: 0o600 });
      const database = new PostgresDatabase({
        connectionString: "postgresql://runtime:password@example.invalid/pintpath?sslmode=verify-ca",
        sslRootCertificatePath: certificatePath,
      });
      expect(database.dialect).toBe("postgres");
      await database.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes only the Pool-facing URL to stable libpq TLS semantics", () => {
    const originalRequireUrl = "postgresql://runtime:PRIVATE_RUNTIME_PASSWORD@example.invalid/pintpath?sslmode=require";
    const explicitlyCompatibleUrl = `${originalRequireUrl}&uselibpqcompat=true`;
    const requireClientUrl = normalizePostgresClientUrl(originalRequireUrl);
    const compatibleClientUrl = normalizePostgresClientUrl(explicitlyCompatibleUrl);
    const verifyFullClientUrl = normalizePostgresClientUrl(
      "postgresql://runtime:PRIVATE_RUNTIME_PASSWORD@example.invalid/pintpath?sslmode=VERIFY-FULL",
    );

    expect(originalRequireUrl).not.toContain("uselibpqcompat");
    expect(new URL(requireClientUrl).searchParams.getAll("uselibpqcompat")).toEqual(["true"]);
    expect(parsedClientSsl(requireClientUrl)).toEqual({ rejectUnauthorized: false });
    expect(parsedClientSsl(compatibleClientUrl)).toEqual({ rejectUnauthorized: false });
    expect(parsedClientSsl(verifyFullClientUrl).rejectUnauthorized).not.toBe(false);
  });

  it("preserves verify-ca trust-root verification without hostname verification", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-postgres-ca-policy-test-"));
    const certificatePath = path.join(root, "root-ca.pem");
    try {
      fs.writeFileSync(certificatePath, "PRIVATE_TEST_ROOT_CA", { mode: 0o600 });
      const clientUrl = normalizePostgresClientUrl(
        "postgresql://runtime:PRIVATE_RUNTIME_PASSWORD@example.invalid/pintpath?sslmode=verify-ca",
        certificatePath,
      );
      const ssl = parsedClientSsl(clientUrl);
      expect(ssl.ca).toBe("PRIVATE_TEST_ROOT_CA");
      expect(typeof ssl.checkServerIdentity).toBe("function");
      expect(ssl.rejectUnauthorized).not.toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects the Railway transport address and localhost TLS identity without URL override", async () => {
    const clientUrl = normalizePostgresClientUrl(
      "postgresql://runtime:PRIVATE_RUNTIME_PASSWORD@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full",
    );
    const config = postgresRailwayStockLocalhostPoolConnection(
      clientUrl,
      railwayNodeConnection,
    );
    expect(config).toEqual({
      database: "pintpath",
      host: "fd12:3456:789a::10",
      password: "PRIVATE_RUNTIME_PASSWORD",
      port: 5_432,
      ssl: railwayNodeConnection.ssl,
      user: "runtime",
    });
    expect(config).not.toHaveProperty("connectionString");

    const database = new PostgresDatabase({
      connectionString:
        "postgresql://runtime:PRIVATE_RUNTIME_PASSWORD@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full",
      railwayStockLocalhostCaConnection: railwayNodeConnection,
    });
    expect(database.dialect).toBe("postgres");
    await database.close();
  });

  it.each([
    ["non-fd12 address", { ...railwayNodeConnection, host: "2001:db8::10" }],
    ["wrong TLS identity", {
      ...railwayNodeConnection,
      ssl: { ...railwayNodeConnection.ssl, servername: "postgres-production.railway.internal" },
    }],
    ["unverified peer", {
      ...railwayNodeConnection,
      ssl: { ...railwayNodeConnection.ssl, rejectUnauthorized: false },
    }],
    ["foreign identity callback", {
      ...railwayNodeConnection,
      ssl: { ...railwayNodeConnection.ssl, checkServerIdentity: () => undefined },
    }],
  ])("rejects an unsafe Railway transport projection: %s", (_label, connection) => {
    expect(() => postgresRailwayStockLocalhostPoolConnection(
      normalizePostgresClientUrl(
        "postgresql://runtime:password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full",
      ),
      connection as typeof railwayNodeConnection,
    )).toThrow("Invalid Railway stock localhost CA connection authority");
  });

  it("rejects mixing pathname and stock-localhost trust authorities", () => {
    expect(() => new PostgresDatabase({
      connectionString:
        "postgresql://runtime:password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full",
      sslRootCertificatePath: "/private/root-ca.pem",
      railwayStockLocalhostCaConnection: railwayNodeConnection,
    })).toThrow("cannot be combined");
  });

  it.each([
    "http://runtime:password@example.invalid/pintpath?sslmode=require",
    "postgresql://runtime:password@example.invalid/pintpath",
    "postgresql://runtime:password@example.invalid/pintpath?sslmode=disable",
    "postgresql://runtime:password@example.invalid/pintpath?sslmode=require&sslmode=verify-full",
    "postgresql://runtime:password@example.invalid/pintpath?sslmode=require&uselibpqcompat=false",
    "postgresql://runtime:password@example.invalid/pintpath?sslmode=require&uselibpqcompat=true&uselibpqcompat=true",
    "postgresql://runtime:password@example.invalid/pintpath?sslmode=verify-ca",
    "postgresql://runtime:password@example.invalid/pintpath?sslmode=require#fragment",
  ])("rejects a non-TLS or malformed Postgres URL: %s", (connectionString) => {
    expect(() => new PostgresDatabase({ connectionString })).toThrow();
  });
});

describe("Postgres native result normalization", () => {
  const parse = (oid: number, value: string): unknown => sqlDatabaseInternals
    .createPostgresTypeOverrides()
    .getTypeParser(oid, "text")(value);

  it("returns ordinary int8 values as numbers but preserves unsafe integers as canonical strings", () => {
    expect(parse(postgresTypes.builtins.INT8, "42")).toBe(42);
    expect(parse(postgresTypes.builtins.INT8, "9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parse(postgresTypes.builtins.INT8, "9007199254740992")).toBe("9007199254740992");
    expect(parse(postgresTypes.builtins.INT8, "-9007199254740992")).toBe("-9007199254740992");
  });

  it("only converts numeric values that have a conservative, stable number round trip", () => {
    expect(parse(postgresTypes.builtins.NUMERIC, "12.50")).toBe(12.5);
    expect(parse(postgresTypes.builtins.NUMERIC, "0.1")).toBe(0.1);
    expect(parse(postgresTypes.builtins.NUMERIC, "9007199254740991.0")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parse(postgresTypes.builtins.NUMERIC, "9007199254740992.0")).toBe("9007199254740992");
    expect(parse(postgresTypes.builtins.NUMERIC, "123456789012345.67")).toBe("123456789012345.67");
    expect(parse(postgresTypes.builtins.NUMERIC, "0.100000000000000005")).toBe("0.100000000000000005");
    expect(() => parse(postgresTypes.builtins.NUMERIC, "NaN")).toThrow("non-finite or invalid numeric");
  });

  it("keeps JSONB as compact, lossless text for the SQLite-compatible repository contract", () => {
    expect(parse(
      postgresTypes.builtins.JSONB,
      `{ "unsafe": 9007199254740993, "message": "spaces stay here", "items": [ true, null ] }`,
    )).toBe(`{"unsafe":9007199254740993,"message":"spaces stay here","items":[true,null]}`);
  });

  it("normalizes timestamps to canonical UTC milliseconds without using the host timezone", () => {
    expect(parse(
      postgresTypes.builtins.TIMESTAMPTZ,
      "2026-08-08 10:30:00.123456+10",
    )).toBe("2026-08-08T00:30:00.123Z");
    expect(parse(
      postgresTypes.builtins.TIMESTAMPTZ,
      "2026-08-08 00:30:00+00",
    )).toBe("2026-08-08T00:30:00.000Z");
    expect(parse(
      postgresTypes.builtins.TIMESTAMP,
      "2026-08-08 00:30:00.999999",
    )).toBe("2026-08-08T00:30:00.999Z");
    expect(parse(postgresTypes.builtins.DATE, "2026-08-08")).toBe("2026-08-08");
    expect(parse(postgresTypes.builtins.TIME, "17:30:00.125")).toBe("17:30:00.125");
  });

  it("returns native booleans and Buffers", () => {
    expect(parse(postgresTypes.builtins.BOOL, "t")).toBe(true);
    expect(parse(postgresTypes.builtins.BOOL, "f")).toBe(false);
    expect(parse(postgresTypes.builtins.BYTEA, "\\x0001ff")).toEqual(Buffer.from([0, 1, 255]));
    expect(() => parse(postgresTypes.builtins.BOOL, "1")).toThrow("invalid boolean");
  });

  it("does not mutate process-wide pg parsers used by the migration importer", () => {
    const globalNumericParser = postgresTypes.getTypeParser(postgresTypes.builtins.NUMERIC, "text");
    const globalTimestampParser = postgresTypes.getTypeParser(postgresTypes.builtins.TIMESTAMPTZ, "text");
    sqlDatabaseInternals.createPostgresTypeOverrides();
    expect(postgresTypes.getTypeParser(postgresTypes.builtins.NUMERIC, "text"))
      .toBe(globalNumericParser);
    expect(postgresTypes.getTypeParser(postgresTypes.builtins.TIMESTAMPTZ, "text"))
      .toBe(globalTimestampParser);
  });
});
