import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, types as postgresTypes } from "pg";
import { describe, expect, it } from "vitest";

import {
  PostgresDatabase,
  sqlDatabaseInternals,
} from "../src/db/sql-database.js";

const { compilePostgresQuery, normalizePostgresClientUrl } = sqlDatabaseInternals;

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
