import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_PATH,
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE,
  assertPostgresMigrationVerifierPublicKey,
  parsePostgresMigrationVerifierAuthorityPolicyBytes,
  postgresMigrationVerifierAuthorityBindingSchema,
  postgresMigrationVerifierAuthoritySchema,
  sha256PostgresMigrationAuthorityIdentity,
  sha256PostgresMigrationVerifierAuthorityBinding,
  type PostgresMigrationVerifierAuthority,
  type PostgresMigrationVerifierAuthorityBinding,
} from "../src/db/postgres-migration-verifier-authority.js";
import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../src/db/postgres-migration-schema.js";
import {
  sha256PostgresMigrationTargetIdentity,
  type PostgresMigrationTargetIdentity,
} from "../src/db/postgres-migration-receipt.js";
import {
  PostgresMigrationVerifierAuthorityProvisionError,
  provisionPostgresMigrationVerifierAuthorityWithConnection,
  runPostgresMigrationVerifierAuthorityProvisioner,
  type AuthorityConnection,
  type AuthorityQueryResult,
} from "../scripts/provision-postgres-migration-verifier-authority.js";

const CANDIDATE = "c".repeat(40);
const PREVIOUS_CANDIDATE = "b".repeat(40);
const STARTED_AT = "2026-08-13T01:02:03.000Z";
const COMPLETED_AT = "2026-08-13T01:02:04.000Z";
const ROOT_CA_DER_SHA256 = sha256PostgresMigrationBytes("fixture-root-ca-der");
const TARGET_URL =
  "postgres://authority_login:fixture-password@postgres.railway.internal:5432/pintpath?sslmode=verify-full";

const TARGET_IDENTITY: PostgresMigrationTargetIdentity = {
  currentUser: POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE,
  databaseName: "pintpath",
  databaseOid: "16384",
  serverVersionNum: "170010",
  sessionUser: "authority_login",
  systemIdentifier: "7612456389123456789",
};

const TARGET_IDENTITY_SHA256 = sha256PostgresMigrationTargetIdentity(TARGET_IDENTITY);
const AUTHORITY_WORKFLOW_PATH = path.resolve(
  ".github/workflows/provision-postgres-migration-verifier-authority.yml",
);
const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function hash(value: string): string {
  return sha256PostgresMigrationBytes(value);
}

function verifierAuthority(
  overrides: Partial<PostgresMigrationVerifierAuthorityBinding> & {
    readonly installedAt?: string;
  } = {},
): PostgresMigrationVerifierAuthority {
  const { installedAt = STARTED_AT, ...bindingOverrides } = overrides;
  const binding = postgresMigrationVerifierAuthorityBindingSchema.parse({
    expectedEnvironment: "permanent-staging",
    candidateSha: CANDIDATE,
    operatorIdSha256: hash("operator"),
    verifierIdSha256: hash("verifier"),
    verifierPublicKeySha256: hash("verifier-key"),
    authorityPolicySha256: POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
    ...bindingOverrides,
  });
  return postgresMigrationVerifierAuthoritySchema.parse({
    ...binding,
    authoritySha256: sha256PostgresMigrationVerifierAuthorityBinding(binding),
    installedAt,
  });
}

function authorityDatabaseRow(authority: PostgresMigrationVerifierAuthority): QueryResultRow {
  return {
    expectedEnvironment: authority.expectedEnvironment,
    candidateSha: authority.candidateSha,
    operatorIdSha256: authority.operatorIdSha256,
    verifierIdSha256: authority.verifierIdSha256,
    verifierPublicKeySha256: authority.verifierPublicKeySha256,
    authorityPolicySha256: authority.authorityPolicySha256,
    authoritySha256: authority.authoritySha256,
    installedAt: authority.installedAt,
  };
}

function targetInspectionRow(): QueryResultRow {
  return {
    ...TARGET_IDENTITY,
    loginSafe: true,
    membershipExact: true,
    roleSafe: true,
    roleParentsAbsent: true,
    roleChildrenExact: true,
    roleSettingsAbsent: true,
    databaseAuthorityExact: true,
    schemaAuthorityExact: true,
    tableAuthorityExact: true,
    columnPrivilegesAbsent: true,
    routinePrivilegesAbsent: true,
    sequencePrivilegesAbsent: true,
    ownershipAbsent: true,
    defaultPrivilegesAbsent: true,
    migratorReadOnlyExact: true,
    rowSecurityExact: true,
  };
}

interface SharedAuthorityState {
  authority: PostgresMigrationVerifierAuthority | null;
  writeAttempts: number;
}

type WriteOutcome = "acknowledged" | "lost_ack" | "rejected" | "stale_postflight";

class FakeAuthorityConnection implements AuthorityConnection {
  readonly queries: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];
  assertExactCalls = 0;
  closeCalls = 0;
  readCalls = 0;
  lockCalls = 0;
  unlockCalls = 0;

  constructor(
    readonly shared: SharedAuthorityState,
    public writtenAuthority: PostgresMigrationVerifierAuthority,
    readonly options: {
      readonly lockAvailable?: boolean;
      readonly writeOutcome?: WriteOutcome;
      readonly driftOnRead?: {
        readonly call: number;
        readonly authority: PostgresMigrationVerifierAuthority | null;
      };
    } = {},
  ) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<AuthorityQueryResult<Row>> {
    this.queries.push({ text, values: [...values] });
    if (text.includes("pintpath:migration-verifier-authority:lock")) {
      this.lockCalls += 1;
      return {
        rows: [{ acquired: this.options.lockAvailable !== false }] as Row[],
        rowCount: 1,
      };
    }
    if (text.includes("pintpath:migration-verifier-authority:unlock")) {
      this.unlockCalls += 1;
      return { rows: [{ released: true }] as Row[], rowCount: 1 };
    }
    if (text.includes("pintpath:migration-verifier-authority:target-boundary")) {
      return { rows: [targetInspectionRow()] as Row[], rowCount: 1 };
    }
    if (text.includes("pintpath:migration-verifier-authority:read")) {
      this.readCalls += 1;
      if (this.options.driftOnRead?.call === this.readCalls) {
        this.shared.authority = this.options.driftOnRead.authority;
      }
      return this.shared.authority === null
        ? { rows: [], rowCount: 0 }
        : { rows: [authorityDatabaseRow(this.shared.authority)] as Row[], rowCount: 1 };
    }
    if (text.includes("pintpath:migration-verifier-authority:write-once")) {
      this.shared.writeAttempts += 1;
      if (this.options.writeOutcome === "rejected") return { rows: [], rowCount: 0 };
      if (this.options.writeOutcome !== "stale_postflight") {
        this.shared.authority = this.writtenAuthority;
      }
      if (this.options.writeOutcome === "lost_ack") throw new Error("fixture_lost_ack");
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected authority query: ${text}`);
  }

  async assertExact(): Promise<void> {
    this.assertExactCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function expectProvisionError(code: string) {
  return expect.objectContaining({
    name: PostgresMigrationVerifierAuthorityProvisionError.name,
    code,
  });
}

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pintpath-verifier-authority-test-"),
  ));
  fs.chmodSync(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

function writePrivateFile(root: string, name: string, bytes: string | Buffer): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function stubGithubAuthorityEnvironment(candidateSha = CANDIDATE): void {
  vi.stubEnv("GITHUB_ACTIONS", "true");
  vi.stubEnv("GITHUB_REF", "refs/heads/main");
  vi.stubEnv("GITHUB_REPOSITORY", "pintpath/beer");
  vi.stubEnv(
    "GITHUB_WORKFLOW_REF",
    "pintpath/beer/.github/workflows/provision-postgres-migration-verifier-authority.yml@refs/heads/main",
  );
  vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
  vi.stubEnv("GITHUB_RUN_ID", "123456789");
  vi.stubEnv(
    "PINTPATH_POSTGRES_MIGRATION_VERIFIER_GITHUB_ENVIRONMENT",
    "permanent-staging-postgres-migration-verifier-authority",
  );
  vi.stubEnv("GITHUB_SHA", candidateSha);
}

async function runLostAcknowledgementFixture(
  previous: PostgresMigrationVerifierAuthority | null,
) {
  stubGithubAuthorityEnvironment();
  const root = temporaryRoot();
  const outputDirectory = path.join(root, "evidence");
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  fs.chmodSync(outputDirectory, 0o700);
  const targetUrlFile = writePrivateFile(root, "target-url", TARGET_URL);
  const rootCaFile = writePrivateFile(root, "root-ca.pem", "fixture-root-ca");
  const operatorIdFile = writePrivateFile(root, "operator-id", "migration-operator");
  const verifierIdFile = writePrivateFile(root, "verifier-id", "independent-verifier");
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKeyBytes = Buffer.from(keyPair.publicKey.export({
    format: "pem",
    type: "spki",
  }));
  const publicKeyFile = writePrivateFile(root, "verifier-public-key.pem", publicKeyBytes);
  const shared: SharedAuthorityState = { authority: previous, writeAttempts: 0 };
  const connections: FakeAuthorityConnection[] = [];
  let nowCalls = 0;
  const connect = async (): Promise<AuthorityConnection> => {
    const writtenAuthority = shared.authority ?? verifierAuthority();
    const connection = new FakeAuthorityConnection(
      shared,
      writtenAuthority,
      { writeOutcome: connections.length === 0 ? "lost_ack" : "acknowledged" },
    );
    if (connections.length === 0) {
      const originalQuery = connection.query.bind(connection);
      connection.query = async <Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<AuthorityQueryResult<Row>> => {
        if (text.includes(":write-once")) {
          const installedAt = String(values[7]);
          const binding = postgresMigrationVerifierAuthorityBindingSchema.parse({
            expectedEnvironment: values[0],
            candidateSha: values[1],
            operatorIdSha256: values[2],
            verifierIdSha256: values[3],
            verifierPublicKeySha256: values[4],
            authorityPolicySha256: values[5],
          });
          connection.writtenAuthority = postgresMigrationVerifierAuthoritySchema.parse({
            ...binding,
            authoritySha256: values[6],
            installedAt,
          });
        }
        return originalQuery<Row>(text, values);
      };
    }
    connections.push(connection);
    return connection;
  };

  const expectedPreviousAuthoritySha256 = previous?.authoritySha256 ?? "absent";
  const receipt = await runPostgresMigrationVerifierAuthorityProvisioner([
    "--candidate-sha", CANDIDATE,
    "--confirmation", "PROVISION_POSTGRES_MIGRATION_VERIFIER_AUTHORITY",
    "--expected-environment", "permanent-staging",
    "--expected-previous-authority-sha256", expectedPreviousAuthoritySha256,
    "--operator-id-file", operatorIdFile,
    "--output-dir", outputDirectory,
    "--root-ca-der-sha256", ROOT_CA_DER_SHA256,
    "--root-ca-file", rootCaFile,
    "--target-identity-sha256", TARGET_IDENTITY_SHA256,
    "--target-url-file", targetUrlFile,
    "--target-url-sha256", sha256PostgresMigrationBytes(TARGET_URL),
    "--verifier-id-file", verifierIdFile,
    "--verifier-public-key", publicKeyFile,
  ], {
    // The production DI type is nominally narrowed to the private direct
    // connection class even though the implementation consumes this interface.
    connect: connect as never,
    now: () => new Date(nowCalls++ === 0 ? STARTED_AT : COMPLETED_AT),
    reassertRepository: async (candidateSha) => {
      expect(candidateSha).toBe(CANDIDATE);
    },
  });
  return { connections, outputDirectory, publicKeyBytes, receipt, shared };
}

describe("Postgres migration verifier authority artifacts", () => {
  it("loads the pinned policy with strict schema and deterministic canonical bytes", () => {
    const bytes = fs.readFileSync(POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_PATH);
    expect(sha256PostgresMigrationBytes(bytes))
      .toBe(POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256);
    const policy = parsePostgresMigrationVerifierAuthorityPolicyBytes(bytes);
    expect(policy.mutationContract).toMatchObject({
      writesPerDispatch: 1,
      automaticRetries: 0,
      compareAndSwapRequired: true,
      unconditionalPostflightRequired: true,
      lostAcknowledgementReadOnlyReconciliation: true,
    });
    expect(serializeCanonicalPostgresMigrationJson(policy)).toEqual(bytes);

    const nonCanonicalBytes = Buffer.from(`${JSON.stringify(policy)}\n`, "utf8");
    expect(nonCanonicalBytes).not.toEqual(bytes);
    expect(() => parsePostgresMigrationVerifierAuthorityPolicyBytes(
      nonCanonicalBytes,
      sha256PostgresMigrationBytes(nonCanonicalBytes),
    )).toThrow(/policy mismatch/);

    const bytesWithUnknownField = serializeCanonicalPostgresMigrationJson({
      ...policy,
      unexpectedAuthority: true,
    });
    expect(() => parsePostgresMigrationVerifierAuthorityPolicyBytes(
      bytesWithUnknownField,
      sha256PostgresMigrationBytes(bytesWithUnknownField),
    )).toThrow();
  });

  it.each([
    ["candidate", { candidateSha: "d".repeat(40) }],
    ["environment", { expectedEnvironment: "production" }],
    ["operator", { operatorIdSha256: hash("different-operator") }],
    ["key", { verifierPublicKeySha256: hash("different-key") }],
  ] as const)("rejects a stale self-hash after the %s binding changes", (_name, patch) => {
    const valid = verifierAuthority();
    expect(() => postgresMigrationVerifierAuthoritySchema.parse({
      ...valid,
      ...patch,
    })).toThrow(/verifier authority hash mismatch/);
  });

  it("domain-separates normalized operator and verifier identities", () => {
    expect(sha256PostgresMigrationAuthorityIdentity(
      "  Independent   Reviewer  ",
      "operator-id",
    )).toBe(sha256PostgresMigrationAuthorityIdentity(
      "Independent Reviewer",
      "operator-id",
    ));
    expect(sha256PostgresMigrationAuthorityIdentity(
      "Independent Reviewer",
      "operator-id",
    )).not.toBe(sha256PostgresMigrationAuthorityIdentity(
      "Independent Reviewer",
      "verifier-id",
    ));
  });

  it("accepts only the exact canonical Ed25519 SPKI PEM bytes", () => {
    const ed25519 = crypto.generateKeyPairSync("ed25519");
    const publicKeyBytes = Buffer.from(ed25519.publicKey.export({
      format: "pem",
      type: "spki",
    }));
    expect(() => assertPostgresMigrationVerifierPublicKey({
      publicKeyBytes,
      expectedSha256: hash(publicKeyBytes.toString("utf8")),
    })).not.toThrow();
    expect(() => assertPostgresMigrationVerifierPublicKey({
      publicKeyBytes,
      expectedSha256: hash("wrong-key"),
    })).toThrow(/public key authority mismatch/);

    const nonCanonical = Buffer.concat([publicKeyBytes, Buffer.from("\n")]);
    expect(() => assertPostgresMigrationVerifierPublicKey({
      publicKeyBytes: nonCanonical,
      expectedSha256: sha256PostgresMigrationBytes(nonCanonical),
    })).toThrow(/public key authority mismatch/);

    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const rsaBytes = Buffer.from(rsa.publicKey.export({ format: "pem", type: "spki" }));
    expect(() => assertPostgresMigrationVerifierPublicKey({
      publicKeyBytes: rsaBytes,
      expectedSha256: sha256PostgresMigrationBytes(rsaBytes),
    })).toThrow(/public key authority mismatch/);
  });
});

describe("Postgres migration verifier authority database executor", () => {
  it("installs with one insert, reasserted preflight, and exact postflight", async () => {
    const next = verifierAuthority();
    const shared: SharedAuthorityState = { authority: null, writeAttempts: 0 };
    const connection = new FakeAuthorityConnection(shared, next);

    const result = await provisionPostgresMigrationVerifierAuthorityWithConnection({
      authority: next,
      expectedPreviousAuthoritySha256: "absent",
      expectedTargetIdentitySha256: TARGET_IDENTITY_SHA256,
    }, connection);

    expect(result).toEqual({ before: null, writeAttempts: 1 });
    expect(shared).toEqual({ authority: next, writeAttempts: 1 });
    expect(connection.assertExactCalls).toBe(3);
    expect(connection.readCalls).toBe(3);
    expect(connection.lockCalls).toBe(1);
    expect(connection.unlockCalls).toBe(1);
    const phases = connection.queries.map(({ text }) => {
      if (text.includes(":lock")) return "lock";
      if (text.includes(":target-boundary")) return "boundary";
      if (text.includes(":read")) return "read";
      if (text.includes(":write-once")) return "write";
      if (text.includes(":unlock")) return "unlock";
      return "unknown";
    });
    expect(phases).toEqual([
      "lock", "boundary", "read", "read", "write", "read", "unlock",
    ]);
    const writes = connection.queries.filter((query) => query.text.includes(":write-once"));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.text).toContain("INSERT INTO");
    expect(writes[0]?.values).toEqual([
      next.expectedEnvironment,
      next.candidateSha,
      next.operatorIdSha256,
      next.verifierIdSha256,
      next.verifierPublicKeySha256,
      next.authorityPolicySha256,
      next.authoritySha256,
      next.installedAt,
    ]);
  });

  it("rotates only through the expected previous authority CAS", async () => {
    const previous = verifierAuthority({
      candidateSha: PREVIOUS_CANDIDATE,
      installedAt: "2026-08-12T01:02:03.000Z",
    });
    const next = verifierAuthority();
    const shared: SharedAuthorityState = { authority: previous, writeAttempts: 0 };
    const connection = new FakeAuthorityConnection(shared, next);

    const result = await provisionPostgresMigrationVerifierAuthorityWithConnection({
      authority: next,
      expectedPreviousAuthoritySha256: previous.authoritySha256,
      expectedTargetIdentitySha256: TARGET_IDENTITY_SHA256,
    }, connection);

    expect(result.before).toEqual(previous);
    expect(shared.writeAttempts).toBe(1);
    const write = connection.queries.find((query) => query.text.includes(":write-once"));
    expect(write?.text).toContain("UPDATE pintpath_ops.migration_verifier_authority");
    expect(write?.text).toContain("authority_sha256 = $9");
    expect(write?.values).toHaveLength(9);
    expect(write?.values.at(-1)).toBe(previous.authoritySha256);

    const rejected = new FakeAuthorityConnection(
      { authority: previous, writeAttempts: 0 },
      next,
    );
    await expect(provisionPostgresMigrationVerifierAuthorityWithConnection({
      authority: next,
      expectedPreviousAuthoritySha256: hash("wrong-previous-authority"),
      expectedTargetIdentitySha256: TARGET_IDENTITY_SHA256,
    }, rejected)).rejects.toEqual(expectProvisionError("preflight_mismatch"));
    expect(rejected.shared.writeAttempts).toBe(0);
    expect(rejected.unlockCalls).toBe(1);
  });

  it("uses the same session advisory lock as importer apply and verify", () => {
    const importer = fs.readFileSync(
      path.resolve("src/db/postgres-migration-target.ts"),
      "utf8",
    );
    const provisioner = fs.readFileSync(
      path.resolve("scripts/provision-postgres-migration-verifier-authority.ts"),
      "utf8",
    );
    expect(importer).toContain(
      "const MIGRATION_LOCK_KEY = POSTGRES_MIGRATION_ADVISORY_LOCK_KEY;",
    );
    expect(provisioner).toContain(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    );
    expect(provisioner).not.toContain("pg_try_advisory_xact_lock");
    expect(provisioner.indexOf("const after = await loadAuthority(connection)"))
      .toBeLessThan(provisioner.indexOf("await releaseLock(connection)"));
  });

  it("rejects authority rotation while importer apply or verify holds the shared lock", async () => {
    const previous = verifierAuthority({ candidateSha: PREVIOUS_CANDIDATE });
    const next = verifierAuthority();
    const shared: SharedAuthorityState = { authority: previous, writeAttempts: 0 };
    const connection = new FakeAuthorityConnection(shared, next, {
      lockAvailable: false,
    });

    await expect(provisionPostgresMigrationVerifierAuthorityWithConnection({
      authority: next,
      expectedPreviousAuthoritySha256: previous.authoritySha256,
      expectedTargetIdentitySha256: TARGET_IDENTITY_SHA256,
    }, connection)).rejects.toEqual(expectProvisionError("target_busy"));
    expect(shared).toEqual({ authority: previous, writeAttempts: 0 });
    expect(connection.queries).toHaveLength(1);
    expect(connection.unlockCalls).toBe(0);
  });

  it("fails closed on preflight drift before the single write", async () => {
    const previous = verifierAuthority({ candidateSha: PREVIOUS_CANDIDATE });
    const drifted = verifierAuthority({ candidateSha: "d".repeat(40) });
    const next = verifierAuthority();
    const shared: SharedAuthorityState = { authority: previous, writeAttempts: 0 };
    const connection = new FakeAuthorityConnection(shared, next, {
      driftOnRead: { call: 2, authority: drifted },
    });

    await expect(provisionPostgresMigrationVerifierAuthorityWithConnection({
      authority: next,
      expectedPreviousAuthoritySha256: previous.authoritySha256,
      expectedTargetIdentitySha256: TARGET_IDENTITY_SHA256,
    }, connection)).rejects.toEqual(expectProvisionError("preflight_drift"));
    expect(shared.writeAttempts).toBe(0);
    expect(connection.readCalls).toBe(2);
    expect(connection.unlockCalls).toBe(1);
  });

  it.each([
    ["rejected", "write_rejected", 2],
    ["stale_postflight", "postflight_mismatch", 3],
  ] as const)(
    "does not retry a %s write and requires successful postflight",
    async (writeOutcome, expectedCode, expectedReads) => {
      const next = verifierAuthority();
      const shared: SharedAuthorityState = { authority: null, writeAttempts: 0 };
      const connection = new FakeAuthorityConnection(shared, next, { writeOutcome });

      await expect(provisionPostgresMigrationVerifierAuthorityWithConnection({
        authority: next,
        expectedPreviousAuthoritySha256: "absent",
        expectedTargetIdentitySha256: TARGET_IDENTITY_SHA256,
      }, connection)).rejects.toEqual(expectProvisionError(expectedCode));
      expect(shared.writeAttempts).toBe(1);
      expect(connection.readCalls).toBe(expectedReads);
      expect(connection.queries.filter((query) => query.text.includes(":write-once")))
        .toHaveLength(1);
      expect(connection.unlockCalls).toBe(1);
    },
  );

  it("reconciles a lost insert acknowledgement through a second read-only connection", async () => {
    const { connections, outputDirectory, publicKeyBytes, receipt, shared } =
      await runLostAcknowledgementFixture(null);

    expect(receipt.outcome).toBe("reconciled_after_lost_ack");
    expect(receipt.authority).toEqual(shared.authority);
    expect(shared.writeAttempts).toBe(1);
    expect(connections).toHaveLength(2);
    expect(connections[0]?.closeCalls).toBe(1);
    expect(connections[1]?.closeCalls).toBe(1);
    expect(connections[1]?.queries.some((query) => query.text.includes(":write-once")))
      .toBe(false);
    expect(connections[1]?.lockCalls).toBe(0);

    const terminal = JSON.parse(fs.readFileSync(
      path.join(outputDirectory, "terminal.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(terminal).toMatchObject({
      outcome: "reconciled_after_lost_ack",
      mutationAcknowledged: false,
      writeAttempts: 1,
    });
    expect(fs.readdirSync(outputDirectory).sort()).toEqual([
      "intent.json",
      "receipt.json",
      "terminal.json",
    ]);
    for (const fileName of fs.readdirSync(outputDirectory)) {
      expect(fs.statSync(path.join(outputDirectory, fileName)).mode & 0o777).toBe(0o600);
    }
    const receiptText = fs.readFileSync(path.join(outputDirectory, "receipt.json"), "utf8");
    expect(receiptText).not.toContain("fixture-password");
    expect(receiptText).not.toContain("migration-operator");
    expect(receiptText).not.toContain("independent-verifier");
    expect(receiptText).not.toContain(publicKeyBytes.toString("utf8"));
  });

  it("reconciles a lost rotation acknowledgement without retrying the CAS write", async () => {
    const previous = verifierAuthority({
      candidateSha: PREVIOUS_CANDIDATE,
      installedAt: "2026-08-12T01:02:03.000Z",
    });
    const { connections, receipt, shared } =
      await runLostAcknowledgementFixture(previous);

    expect(receipt.outcome).toBe("reconciled_after_lost_ack");
    expect(shared.authority).toEqual(receipt.authority);
    expect(shared.writeAttempts).toBe(1);
    expect(connections).toHaveLength(2);
    const write = connections[0]?.queries.find((query) => query.text.includes(":write-once"));
    expect(write?.text).toContain("UPDATE pintpath_ops.migration_verifier_authority");
    expect(write?.values.at(-1)).toBe(previous.authoritySha256);
    expect(connections[1]?.queries.some((query) => query.text.includes(":write-once")))
      .toBe(false);
    expect(connections[1]?.lockCalls).toBe(0);
  });
});

describe("Postgres migration verifier authority protected workflow", () => {
  it("uses least privilege, one shared concurrency lane, and exact protected environments", () => {
    const source = fs.readFileSync(AUTHORITY_WORKFLOW_PATH, "utf8");
    const permissions = source.match(/^permissions:\n(?: {2}[^\n]+\n)+/m)?.[0];
    expect(permissions).toBe("permissions:\n  contents: read\n");
    expect(source).toContain(
      "concurrency:\n"
      + "  group: pintpath-postgres-migration-verifier-authority\n"
      + "  cancel-in-progress: false\n",
    );
    expect(source).toContain(
      "target_environment:\n"
      + "        description: Exact target for the independent verifier authority\n"
      + "        required: true\n"
      + "        type: choice\n"
      + "        options:\n"
      + "          - permanent-staging\n"
      + "          - production\n",
    );
    const environmentExpression = "${{ inputs.target_environment == 'production'"
      + " && 'production-postgres-migration-verifier-authority'"
      + " || 'permanent-staging-postgres-migration-verifier-authority' }}";
    expect(source.split(environmentExpression)).toHaveLength(3);
    expect(source).toContain(
      "case \"$TARGET_ENVIRONMENT\" in permanent-staging|production) ;; *) exit 1 ;; esac",
    );
    expect(source).toContain("test \"$DISPATCH_REF\" = refs/heads/main");
    expect(source).toContain("test \"$RUN_ATTEMPT\" = 1");
    expect(source).not.toMatch(/^\s+[a-z-]+: write\s*$/m);
  });

  it("pins every external action to the reviewed immutable commit", () => {
    const source = fs.readFileSync(AUTHORITY_WORKFLOW_PATH, "utf8");
    const uses = [...source.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gm)]
      .map((match) => match[1]);
    expect(uses).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    ]);
    for (const action of uses) expect(action).toMatch(/@[a-f0-9]{40}$/);
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("ref: ${{ inputs.candidate_sha }}");
    expect(source.match(/git fetch --no-tags origin/g)).toHaveLength(2);
    expect(source.match(/test \"\$\(git rev-parse refs\/remotes\/origin\/main\)\"/g))
      .toHaveLength(2);
  });

  it("keeps private inputs in mode-0600 custody and invokes the executor once", () => {
    const source = fs.readFileSync(AUTHORITY_WORKFLOW_PATH, "utf8");
    const secretNames = [...source.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)]
      .map((match) => match[1]);
    expect(secretNames).toEqual([
      "PINTPATH_POSTGRES_MIGRATION_VERIFIER_TARGET_URL",
      "PINTPATH_POSTGRES_MIGRATION_VERIFIER_ROOT_CA_PEM",
      "PINTPATH_POSTGRES_MIGRATION_OPERATOR_ID",
      "PINTPATH_POSTGRES_MIGRATION_VERIFIER_ID",
      "PINTPATH_POSTGRES_MIGRATION_VERIFIER_PUBLIC_KEY_PEM",
    ]);
    expect(source).not.toContain("PINTPATH_POSTGRES_MIGRATION_VERIFIER_PRIVATE_KEY");
    expect(source).not.toMatch(/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/);
    expect(source).toContain("umask 077");
    expect(source).toContain("mkdir -m 700 \"$custody\" \"$custody/evidence\"");
    for (const fileName of [
      "target-url.secret",
      "root-ca.pem",
      "operator-id.secret",
      "verifier-id.secret",
      "verifier-public-key.pem",
    ]) {
      expect(source).toContain(`"$custody/${fileName}"`);
    }
    expect(source.match(
      /\.\/node_modules\/\.bin\/tsx scripts\/provision-postgres-migration-verifier-authority\.ts/g,
    )).toHaveLength(1);
    const invocation = source.slice(
      source.indexOf("./node_modules/.bin/tsx scripts/provision-postgres-migration-verifier-authority.ts"),
      source.indexOf("- name: Upload secret-free authority evidence"),
    );
    expect(invocation).not.toContain("secrets.");
    expect(invocation).toContain("--target-url-file \"$custody/target-url.secret\"");
    expect(invocation).toContain("--operator-id-file \"$custody/operator-id.secret\"");
    expect(invocation).toContain("--verifier-id-file \"$custody/verifier-id.secret\"");
    expect(invocation).toContain(
      "--verifier-public-key \"$custody/verifier-public-key.pem\"",
    );
  });

  it("uploads only secret-free evidence before unconditional custody cleanup", () => {
    const source = fs.readFileSync(AUTHORITY_WORKFLOW_PATH, "utf8");
    const uploadIndex = source.indexOf("- name: Upload secret-free authority evidence");
    const cleanupIndex = source.indexOf("- name: Remove private authority custody");
    expect(uploadIndex).toBeGreaterThan(0);
    expect(cleanupIndex).toBeGreaterThan(uploadIndex);
    const upload = source.slice(uploadIndex, cleanupIndex);
    expect(upload).toContain("if: always()");
    expect(upload).toContain(
      "path: ${{ runner.temp }}/pintpath-migration-verifier-authority/evidence/",
    );
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).toContain("retention-days: 90");
    expect(upload).not.toContain("target-url.secret");
    expect(upload).not.toContain("root-ca.pem");
    expect(upload).not.toContain("operator-id.secret");
    expect(upload).not.toContain("verifier-id.secret");
    expect(upload).not.toContain("verifier-public-key.pem");

    const cleanup = source.slice(cleanupIndex);
    expect(cleanup).toContain("if: always()");
    for (const fileName of [
      "target-url.secret",
      "root-ca.pem",
      "operator-id.secret",
      "verifier-id.secret",
      "verifier-public-key.pem",
      "evidence/intent.json",
      "evidence/terminal.json",
      "evidence/receipt.json",
    ]) {
      expect(cleanup).toContain(`"$custody/${fileName}"`);
    }
    expect(cleanup).toContain(
      "if [[ -d \"$custody/evidence\" ]]; then rmdir \"$custody/evidence\"; fi",
    );
    expect(cleanup).toContain(
      "if [[ -d \"$custody\" ]]; then rmdir \"$custody\"; fi",
    );
    expect(cleanup).not.toMatch(/rmdir[^\n]*(?:\|\|\s*true|2>\/dev\/null)/);
  });
});
