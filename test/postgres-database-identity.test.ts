import { describe, expect, it } from "vitest";

import {
  POSTGRES_DATABASE_IDENTITY_KIND,
  POSTGRES_DATABASE_IDENTITY_VERSION,
  buildPostgresDatabaseIdentity,
  canonicalPostgresDatabaseIdentityJson,
  parsePostgresDatabaseIdentity,
  sha256PostgresDatabaseIdentity,
} from "../src/lib/postgres-database-identity.js";

const PHYSICAL_IDENTITY = Object.freeze({
  systemIdentifier: "7568999345281279000",
  databaseOid: "16655",
  databaseName: "pintpath",
  serverVersionNum: "170006",
});

const CANONICAL_IDENTITY = Object.freeze({
  kind: POSTGRES_DATABASE_IDENTITY_KIND,
  version: POSTGRES_DATABASE_IDENTITY_VERSION,
  ...PHYSICAL_IDENTITY,
});

const CANONICAL_JSON =
  '{"databaseName":"pintpath","databaseOid":"16655","kind":"pintpath-postgres-logical-source-database","serverVersionNum":"170006","systemIdentifier":"7568999345281279000","version":1}\n';
const LEGACY_SHA256 =
  "1a396fa58dc6dce6c52d62845ee9acadb3b3f501f16d7a6a167a9e9ffc621d2e";

describe("canonical PostgreSQL physical database identity", () => {
  it("preserves the existing logical-source canonical bytes and SHA-256", () => {
    const identity = buildPostgresDatabaseIdentity(PHYSICAL_IDENTITY);

    expect(identity).toEqual(CANONICAL_IDENTITY);
    expect(canonicalPostgresDatabaseIdentityJson(identity)).toBe(CANONICAL_JSON);
    expect(sha256PostgresDatabaseIdentity(PHYSICAL_IDENTITY)).toBe(LEGACY_SHA256);
  });

  it("derives the same physical identity across distinct database roles", () => {
    const migratorIdentity = {
      ...PHYSICAL_IDENTITY,
      currentUser: "pintpath_migration_operator",
      sessionUser: "pintpath_migration_operator",
    };
    const plannerIdentity = {
      ...PHYSICAL_IDENTITY,
      currentUser: "pintpath_reviewed_price_planner",
      sessionUser: "pintpath_reviewed_price_planner",
    };

    expect(sha256PostgresDatabaseIdentity(migratorIdentity)).toBe(LEGACY_SHA256);
    expect(sha256PostgresDatabaseIdentity(plannerIdentity)).toBe(LEGACY_SHA256);
    expect(buildPostgresDatabaseIdentity(migratorIdentity)).toEqual(
      buildPostgresDatabaseIdentity(plannerIdentity),
    );
  });

  it.each([
    ["systemIdentifier", "7568999345281279001"],
    ["databaseOid", "16656"],
    ["databaseName", "pintpath_restore"],
    ["serverVersionNum", "170007"],
  ] as const)("changes the digest when %s drifts", (field, value) => {
    expect(sha256PostgresDatabaseIdentity({
      ...PHYSICAL_IDENTITY,
      [field]: value,
    })).not.toBe(LEGACY_SHA256);
  });

  it("strictly parses only the canonical identity envelope", () => {
    expect(parsePostgresDatabaseIdentity(CANONICAL_IDENTITY)).toEqual(
      CANONICAL_IDENTITY,
    );
    expect(() => parsePostgresDatabaseIdentity({
      ...CANONICAL_IDENTITY,
      currentUser: "pintpath_runtime",
    })).toThrow();
    expect(() => parsePostgresDatabaseIdentity({
      ...CANONICAL_IDENTITY,
      kind: "pintpath-postgres-database",
    })).toThrow();
    expect(() => parsePostgresDatabaseIdentity({
      ...CANONICAL_IDENTITY,
      version: 2,
    })).toThrow();
    expect(() => parsePostgresDatabaseIdentity({
      ...CANONICAL_IDENTITY,
      systemIdentifier: "not-decimal",
    })).toThrow();
    expect(() => parsePostgresDatabaseIdentity({
      ...CANONICAL_IDENTITY,
      databaseOid: "-1",
    })).toThrow();
    expect(() => parsePostgresDatabaseIdentity({
      ...CANONICAL_IDENTITY,
      databaseName: "unsafe\nname",
    })).toThrow();
    expect(() => parsePostgresDatabaseIdentity({
      ...CANONICAL_IDENTITY,
      serverVersionNum: "160010",
    })).toThrow();
    const { databaseOid: _missing, ...withoutDatabaseOid } = CANONICAL_IDENTITY;
    expect(() => parsePostgresDatabaseIdentity(withoutDatabaseOid)).toThrow();
  });
});
