import crypto from "node:crypto";
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_BASE_DDL_SHA256,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CAPABILITY,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_DATABASE_ENVIRONMENT_POLICY,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_CATEGORY_SHA256,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_COUNTS,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_FORBIDDEN_COUNT_KEYS,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_INERT_KERNEL_SHA256,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_BYTES,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_POLICY_SHA256,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PORTABLE_SCHEMA_SHA256,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS,
  POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_SESSION_CONTRACT,
  postgresLogicalPhysicalSchemaV4Internals,
  sha256PostgresLogicalPhysicalSchemaV4Policy,
} from "../src/lib/postgres-logical-physical-schema-v4.js";
import { postgresLogicalStateInternals } from "../src/lib/postgres-logical-state.js";

describe("passive physical-schema V4 contract", () => {
  it("freezes the exact graph, DDL/kernel sources, role mapping, and non-authority posture", () => {
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_COUNTS).toEqual({
      database: 1,
      schemas: 2,
      relations: 61,
      columns: 771,
      constraints: 243,
      indexes: 270,
      triggers: 317,
      policies: 240,
      routines: 10,
      roles: 5,
      aclEntries: 932,
      defaultAcls: 0,
      dependencies: 1_909,
      sharedDependencies: 377,
    });
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS).toHaveLength(61);
    expect(new Set(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS).size).toBe(61);
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES).toHaveLength(14);
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_FORBIDDEN_COUNT_KEYS).toHaveLength(30);
    expect(Object.values(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_CATEGORY_SHA256))
      .toHaveLength(14);
    expect(Object.values(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_CATEGORY_SHA256)
      .every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_PORTABLE_SCHEMA_SHA256)
      .toBe("c4661ad44e3d21f670e3bdf490638476d433923022991dc9ce3c357f58fd693e");
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS).toEqual({
      databaseOwner: "$database_owner",
      logicalBackup: "$pintpath_logical_backup_current_database",
      applyOwner: "$pintpath_reviewed_price_apply_owner_current_database",
      applyExecute: "$pintpath_reviewed_price_apply_execute_current_database",
      quarantineOwner: "$pintpath_reviewed_price_quarantine_owner_current_database",
      quarantineExecute: "$pintpath_reviewed_price_quarantine_execute_current_database",
    });
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_SESSION_CONTRACT).toMatchObject({
      postgresMajorVersion: 17,
      transactionIsolation: "repeatable read",
      transactionReadOnly: true,
      trustedSearchPath: "pg_catalog, pg_temp",
      effectiveFirstSchema: "pg_catalog",
      sameSessionRequired: true,
      privateRelationLockMode: "ACCESS SHARE",
      expectedLockedPrivateRelationCount: 61,
      catalogSnapshotFreshnessRequired: true,
      serializedSessionFieldsAreUnverifiedCallerClaims: true,
    });
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_DATABASE_ENVIRONMENT_POLICY).toMatchObject({
      expectedSha256: null,
      reviewedTargetPinRequired: true,
      verified: false,
    });
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CAPABILITY).toMatchObject({
      catalogCaptureImplemented: false,
      databaseConnectionImplemented: false,
      databaseEnvironmentProfilePinned: false,
      completePhysicalSchemaDigestVerified: false,
      serializedObservationIsAuthority: false,
      artifactEmissionAuthorized: false,
      activationAuthorized: false,
      productionCutoverAuthorized: false,
    });

    expect(crypto.createHash("sha256").update(fs.readFileSync("src/db/postgres-schema.sql")).digest("hex"))
      .toBe(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_BASE_DDL_SHA256);
    expect(crypto.createHash("sha256").update(fs.readFileSync(
      "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
    )).digest("hex")).toBe(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_INERT_KERNEL_SHA256);
    expect(sha256PostgresLogicalPhysicalSchemaV4Policy())
      .toBe(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_POLICY_SHA256);
  });

  it("independently agrees with the reviewed state boundary for all relations, policies, ACLs, and roles", () => {
    const owner = "independent_physical_v4_owner";
    const boundary = postgresLogicalStateInternals.expectedSourceReadBoundaryDescriptor(owner);
    expect(boundary.relations.map(({ qualifiedName }) => qualifiedName))
      .toEqual(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_EXPECTED_RELATIONS);
    expect(boundary.relations).toHaveLength(61);
    expect(boundary.relations.flatMap(({ policies }) => policies)).toHaveLength(240);
    expect(boundary.relations.every((relation) => relation.kind === "r"
      && relation.persistence === "p"
      && relation.rowSecurity === true
      && relation.forceRowSecurity === true
      && relation.accessMethod === "heap"
      && relation.inheritanceEdgeCount === 0
      && relation.isPartition === false
      && relation.acl.some((entry) => entry.grantee
        === POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_ROLE_SYMBOLS.logicalBackup
        && entry.privilege === "SELECT" && entry.grantable === false))).toBe(true);
    expect(boundary.roles).toHaveLength(5);
    expect(boundary.roles.reduce((count, role) => count + role.sharedDependencies.length, 0)).toBe(69);
    expect(boundary.privateSequenceCount).toBe(0);
    expect(boundary.privateRelationPublicationCount).toBe(0);
    expect(boundary.privateSchemaPublicationCount).toBe(0);
    expect(boundary.allTablesPublicationCount).toBe(0);
    expect(boundary.privateRelationExtensionDependencyCount).toBe(0);
  });

  it("declares dump/security-relevant fields for every hashed category", () => {
    for (const category of POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_NAMES) {
      expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS[category].length).toBeGreaterThan(0);
      expect(new Set(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS[category]).size)
        .toBe(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS[category].length);
    }
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS.relations)
      .toEqual(expect.arrayContaining(["owner", "kind", "persistence", "rowSecurity",
        "forceRowSecurity", "accessMethod", "tablespace", "replicaIdentity", "options",
        "partitionBound", "aclIsNull"]));
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS.columns)
      .toEqual(expect.arrayContaining(["formattedType", "notNull", "defaultExpression",
        "generated", "identity", "collation", "storage", "compression", "aclIsNull"]));
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS.indexes)
      .toEqual(expect.arrayContaining(["accessMethod", "unique", "primary", "valid", "ready",
        "live", "predicate", "expressions", "definition"]));
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_CATEGORY_FIELDS.routines)
      .toEqual(expect.arrayContaining(["owner", "language", "securityDefiner", "leakproof",
        "volatility", "parallel", "config", "source", "sqlBody", "aclIsNull"]));
  });

  it("rejects ambiguous role/OID substitution and keeps the environment outside the portable digest", () => {
    const mapping = {
      databaseName: "db_first",
      databaseOid: "12345",
      databaseOwner: "owner_first",
      logicalBackup: "pintpath_logical_backup_d12345",
      applyOwner: "pintpath_reviewed_price_apply_owner_d12345",
      applyExecute: "pintpath_reviewed_price_apply_execute_d12345",
      quarantineOwner: "pintpath_reviewed_price_quarantine_owner_d12345",
      quarantineExecute: "pintpath_reviewed_price_quarantine_execute_d12345",
    } as const;
    expect(postgresLogicalPhysicalSchemaV4Internals.normalizeTaggedValue(
      { tag: "role", value: mapping.databaseOwner }, mapping,
    )).toBe("$database_owner");
    expect(postgresLogicalPhysicalSchemaV4Internals.normalizeTaggedValue(
      { tag: "roleInterpolatedText", value: `owner=${mapping.applyOwner}` }, mapping,
    )).toBe("owner=$pintpath_reviewed_price_apply_owner_current_database");
    expect(() => postgresLogicalPhysicalSchemaV4Internals.normalizeTaggedValue(
      mapping.databaseOid, mapping,
    )).toThrowError(expect.objectContaining({ code: "catalog_invalid" }));
    expect(() => postgresLogicalPhysicalSchemaV4Internals.normalizeTaggedValue(
      mapping.databaseOwner, mapping,
    )).toThrowError(expect.objectContaining({ code: "catalog_invalid" }));
    expect(postgresLogicalPhysicalSchemaV4Internals.staticPolicyValue())
      .toMatchObject({ databaseEnvironmentPolicy: { expectedSha256: null, verified: false } });
  });

  it("keeps imports passive and the byte/parser boundary explicitly bounded", () => {
    const source = fs.readFileSync("src/lib/postgres-logical-physical-schema-v4.ts", "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)].map((match) => match[1]);
    expect(imports).toEqual([
      "node:crypto",
      "node:util",
      "./postgres-logical-backup-v4-table-data-contract.js",
    ]);
    expect(source).not.toMatch(/node:fs|node:child_process|\bfrom "pg"|process\.env|fetch\(|createClient\(/);
    expect(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(source).toContain("byteLength > POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_BYTES");
    expect(source).toContain("UTIL_IS_PROXY(value)");
    expect(source).toContain("TYPED_ARRAY_BYTE_LENGTH");
    expect(source).toContain("fatal: true");
    expect(source).toContain("canonicalJson(snapshot) !== text");

    const parseBytes = postgresLogicalPhysicalSchemaV4Internals.parseBytes;
    expect(parseBytes(Buffer.from("{}"))).toEqual({});
    for (const hostile of [
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      Buffer.from([0xff]),
      Buffer.from("{}\n"),
      Buffer.from("{ \"a\":1}"),
      new Uint8Array(),
      new Uint8Array(POSTGRES_LOGICAL_PHYSICAL_SCHEMA_V4_MAX_BYTES + 1),
      new Proxy(Buffer.from("{}"), {}),
    ]) {
      expect(() => parseBytes(hostile)).toThrowError(
        expect.objectContaining({ code: "record_invalid" }),
      );
    }
  });
});
