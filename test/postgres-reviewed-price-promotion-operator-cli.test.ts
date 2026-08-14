import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  postgresReviewedPricePromotionOperatorInternals,
} from "../scripts/postgres-reviewed-price-promotion-operator.js";
import {
  checkPostgresRailwayStockLocalhostServerIdentity,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const COMMON = [
  "approval-file", "approval-file-sha256", "database-url-file",
  "database-url-file-sha256", "output-receipt",
  "expected-root-ca-der-sha256",
  "plan-file", "plan-file-sha256", "review-packet-file", "review-packet-file-sha256",
  "reviewer-public-key-file", "reviewer-public-key-file-sha256", "root-ca-file",
  "root-ca-file-sha256",
] as const;

function argumentsFor(command: string): string[] {
  const keys = [...COMMON];
  if (command.endsWith("quarantine")) {
    keys.push("apply-receipt-file", "apply-receipt-file-sha256");
  }
  return [command, ...keys.map((key) => key === "expected-root-ca-der-sha256"
    ? `--${key}=${"a".repeat(64)}`
    : `--${key}=/private/${key}`)];
}

describe("Postgres reviewed-price operator CLI contract", () => {
  it.each([
    "authorize-apply", "apply", "authorize-quarantine", "quarantine",
  ])("accepts the exact %s command surface", (command) => {
    expect(postgresReviewedPricePromotionOperatorInternals.parseArguments(
      argumentsFor(command),
    ).command).toBe(command);
  });

  it("rejects missing, duplicate, and unknown operator arguments", () => {
    const valid = argumentsFor("apply");
    expect(() => postgresReviewedPricePromotionOperatorInternals.parseArguments(
      valid.slice(0, -1),
    )).toThrowError("argument_invalid");
    expect(() => postgresReviewedPricePromotionOperatorInternals.parseArguments([
      ...valid,
      valid[1]!,
    ])).toThrowError("argument_invalid");
    expect(() => postgresReviewedPricePromotionOperatorInternals.parseArguments([
      ...valid.slice(0, -1),
      "--unknown=/private/value",
    ])).toThrowError("argument_invalid");
  });

  it("uses SERIALIZABLE, explicit rollback, TLS verification, and no automatic retry", () => {
    const source = fs.readFileSync(path.join(
      process.cwd(),
      "scripts/postgres-reviewed-price-promotion-operator.ts",
    ), "utf8");
    expect(source).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(source).toContain("await client.query(\"ROLLBACK\")");
    expect(source).toContain("ssl: transport.nodeConnection.ssl");
    expect(source).toContain("fsyncParentDirectory(resolved)");
    expect(source).toContain("pg_catalog.pg_auth_members AS membership");
    expect(source).toContain("membership.inherit_option");
    expect(source).toContain("membership.set_option");
    expect(source).toContain("WITH RECURSIVE");
    expect(source).toContain("pg_catalog.pg_shdepend AS dependency");
    expect(source).toContain("openPostgresRailwayStockLocalhostCaTransport");
    expect(source).toContain("transport.nodeConnection.ssl");
    expect(source).toContain("expectedRootCaDerSha256");
    expect(source).toContain("await transport.assertExact()");
    expect(source).not.toMatch(/for\s*\([^)]*retry|setTimeout\s*\(/);
  });

  it("accepts only an exact Railway private verify-full URL authority", () => {
    const parse = postgresReviewedPricePromotionOperatorInternals.parseDatabaseUrl;
    expect(parse(Buffer.from(
      "postgresql://operator:secret@postgres-staging.railway.internal:5432/pintpath?sslmode=verify-full",
    )).hostname).toBe("postgres-staging.railway.internal");
    for (const value of [
      "postgresql://operator:secret@localhost:5432/pintpath?sslmode=verify-full",
      "postgresql://operator:secret@postgres-staging.railway.internal/pintpath?sslmode=verify-full",
      "postgresql://operator:secret@postgres-staging.railway.internal:5433/pintpath?sslmode=verify-full",
      "postgresql://operator:secret@POSTGRES-STAGING.railway.internal:5432/pintpath?sslmode=verify-full",
      "postgresql://operator:secret@postgres-staging.railway.internal:5432/pintpath?sslmode=require",
    ]) {
      expect(() => parse(Buffer.from(value))).toThrow("database_url_invalid");
    }
  });

  it("dials only through the held fd12 localhost-certificate transport", async () => {
    const assertExact = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const ssl = Object.freeze({
      checkServerIdentity: checkPostgresRailwayStockLocalhostServerIdentity,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      servername: "localhost",
    });
    const openTransport = vi.fn(async () => ({
      profile: "railway-stock-localhost-ca-v1",
      rootCaDerSha256: "a".repeat(64),
      sourceUrlAuthority: {
        hostname: "postgres-staging.railway.internal",
        port: 5_432,
      },
      resolvedAddress: "fd12:3456:789a::1",
      nodeConnection: {
        host: "fd12:3456:789a::1",
        port: 5_432,
        ssl,
      },
      assertExact,
      close,
    }));
    let clientConfig: Record<string, unknown> | undefined;
    const end = vi.fn(async () => undefined);
    const createPostgresClient = vi.fn((config: Record<string, unknown>) => {
      clientConfig = config;
      return {
        connect: vi.fn(async () => {
          throw new Error("connect_probe");
        }),
        end,
      };
    });
    const databaseUrl = postgresReviewedPricePromotionOperatorInternals
      .parseDatabaseUrl(Buffer.from(
        "postgresql://operator:secret@postgres-staging.railway.internal:5432/pintpath?sslmode=verify-full",
      ));

    await expect(
      postgresReviewedPricePromotionOperatorInternals
        .executeDatabaseWithDependencies({
          command: "apply",
          databaseUrl,
          expectedRootCaDerSha256: "a".repeat(64),
          request: {} as never,
          rootCaFile: "/private/railway-root-ca.pem",
        }, {
          createPostgresClient: createPostgresClient as never,
          getEuid: () => 501,
          getUid: () => 501,
          openTransport: openTransport as never,
        }),
    ).rejects.toThrow("connect_probe");
    expect(openTransport).toHaveBeenCalledWith({
      expectedRootCaDerSha256: "a".repeat(64),
      expectedUid: 501,
      profile: "railway-stock-localhost-ca-v1",
      rootCaFile: "/private/railway-root-ca.pem",
      sourceUrlAuthority: {
        hostname: "postgres-staging.railway.internal",
        port: 5_432,
      },
    });
    expect(clientConfig).toMatchObject({
      connectionTimeoutMillis: 10_000,
      host: "fd12:3456:789a::1",
      port: 5_432,
      ssl,
    });
    expect(clientConfig).not.toHaveProperty("connectionString");
    expect(assertExact).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rolls back when the held transport drifts before commit", async () => {
    let exactCall = 0;
    const assertExact = vi.fn(async () => {
      exactCall += 1;
      if (exactCall === 3) throw new Error("transport_drift");
    });
    const close = vi.fn(async () => undefined);
    const transport = {
      profile: "railway-stock-localhost-ca-v1",
      rootCaDerSha256: "a".repeat(64),
      sourceUrlAuthority: {
        hostname: "postgres-staging.railway.internal",
        port: 5_432,
      },
      resolvedAddress: "fd12:3456:789a::1",
      nodeConnection: {
        host: "fd12:3456:789a::1",
        port: 5_432,
        ssl: Object.freeze({
          checkServerIdentity: checkPostgresRailwayStockLocalhostServerIdentity,
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
          servername: "localhost",
        }),
      },
      assertExact,
      close,
    };
    const queries: string[] = [];
    const query = vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes('AS "databaseOid"')) {
        return {
          rows: [{
            currentUser: "reviewer",
            databaseOid: "123",
            sessionUser: "reviewer",
          }],
        };
      }
      if (text.startsWith("WITH RECURSIVE")) return { rows: [{ safe: true }] };
      if (text.includes('AS "currentUser"')) {
        return {
          rows: [{ currentUser: "pintpath_reviewed_price_reviewer_execute_d123" }],
        };
      }
      if (text.includes("pintpath_ops.authorize_reviewed_price_promotion")) {
        return {
          rows: [{
            response: {
              authorization: {
                approvalFileSha256: "b".repeat(64),
                approvalPayloadSha256: "c".repeat(64),
                authorizationId: "11111111-1111-4111-8111-111111111111",
                authorizedAt: "2026-08-14T00:00:00.000Z",
                kind: "pintpath-postgres-reviewed-price-operation-authorization-receipt",
                operationId: "22222222-2222-4222-8222-222222222222",
                operationKind: "apply",
                reviewerIdSha256: "d".repeat(64),
                version: 1,
              },
              replayed: false,
            },
          }],
        };
      }
      return { rows: [] };
    });
    const databaseUrl = postgresReviewedPricePromotionOperatorInternals
      .parseDatabaseUrl(Buffer.from(
        "postgresql://reviewer:secret@postgres-staging.railway.internal:5432/pintpath?sslmode=verify-full",
      ));

    await expect(
      postgresReviewedPricePromotionOperatorInternals
        .executeDatabaseWithDependencies({
          command: "authorize-apply",
          databaseUrl,
          expectedRootCaDerSha256: "a".repeat(64),
          request: {} as never,
          rootCaFile: "/private/railway-root-ca.pem",
        }, {
          createPostgresClient: (() => ({
            connect: vi.fn(async () => undefined),
            end: vi.fn(async () => undefined),
            query,
          })) as never,
          getEuid: () => 501,
          getUid: () => 501,
          openTransport: (async () => transport) as never,
        }),
    ).rejects.toThrow("transport_drift");
    expect(queries.filter((text) => text.startsWith("WITH RECURSIVE")))
      .toHaveLength(2);
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(assertExact).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledOnce();
  });
});
