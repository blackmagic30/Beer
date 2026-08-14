import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "./postgres-migration-schema.js";

export const POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SCHEMA =
  "pintpath-postgres-migration-verifier-authority-policy/v1" as const;
export const POSTGRES_MIGRATION_VERIFIER_AUTHORITY_RECEIPT_SCHEMA =
  "pintpath-postgres-migration-verifier-authority-receipt/v1" as const;
export const POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE =
  "pintpath_migration_verifier_authority" as const;
export const POSTGRES_MIGRATION_VERIFIER_AUTHORITY_TABLE =
  "migration_verifier_authority" as const;
export const POSTGRES_MIGRATION_VERIFIER_AUTHORITY_SINGLETON_ID = "active" as const;
export const POSTGRES_MIGRATION_ADVISORY_LOCK_KEY = "721426590137322906" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const TIMESTAMP = z.string().datetime({ offset: false, precision: 3 }).refine(
  (value) => new Date(value).toISOString() === value,
);
const sha256 = z.string().regex(SHA256_PATTERN);
const environment = z.enum(["permanent-staging", "production"]);

export type PostgresMigrationVerifierAuthorityEnvironment = z.infer<typeof environment>;

export const postgresMigrationVerifierAuthorityPolicySchema = z.object({
  schemaVersion: z.literal(POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SCHEMA),
  policyId: z.literal("pintpath-postgres-migration-independent-verifier-authority"),
  activationState: z.literal("GITHUB_ENVIRONMENT_PROTECTED"),
  requiredGitRef: z.literal("refs/heads/main"),
  requiredWorkflow: z.literal(
    ".github/workflows/provision-postgres-migration-verifier-authority.yml",
  ),
  requiredRunAttempt: z.literal(1),
  githubEnvironments: z.object({
    "permanent-staging": z.literal(
      "permanent-staging-postgres-migration-verifier-authority",
    ),
    production: z.literal("production-postgres-migration-verifier-authority"),
  }).strict(),
  concurrency: z.object({
    group: z.literal("pintpath-postgres-migration-verifier-authority"),
    cancelInProgress: z.literal(false),
  }).strict(),
  databaseContract: z.object({
    schema: z.literal("pintpath_ops"),
    table: z.literal(POSTGRES_MIGRATION_VERIFIER_AUTHORITY_TABLE),
    singletonId: z.literal(POSTGRES_MIGRATION_VERIFIER_AUTHORITY_SINGLETON_ID),
    provisionerRole: z.literal(POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE),
    importerRole: z.literal("pintpath_migrator"),
    advisoryLockKey: z.literal(POSTGRES_MIGRATION_ADVISORY_LOCK_KEY),
    candidateAndEnvironmentBound: z.literal(true),
    operatorAndVerifierBound: z.literal(true),
    importerSelectOnly: z.literal(true),
    provisionerExactPrivileges: z.tuple([
      z.literal("INSERT"), z.literal("SELECT"), z.literal("UPDATE"),
    ]),
  }).strict(),
  verifierContract: z.object({
    algorithm: z.literal("Ed25519"),
    publicKeyEncoding: z.literal("SPKI_PEM"),
    operatorVerifierSeparationRequired: z.literal(true),
    maximumApprovalLifetimeSeconds: z.literal(86_400),
  }).strict(),
  mutationContract: z.object({
    exactPreflightRequired: z.literal(true),
    compareAndSwapRequired: z.literal(true),
    durableIntentRequired: z.literal(true),
    writesPerDispatch: z.literal(1),
    automaticRetries: z.literal(0),
    unconditionalPostflightRequired: z.literal(true),
    lostAcknowledgementReadOnlyReconciliation: z.literal(true),
  }).strict(),
  transportContract: z.object({
    profile: z.literal("railway-stock-localhost-ca-v1"),
    privateRailwayHostnameRequired: z.literal(true),
    port: z.literal(5_432),
    sslMode: z.literal("verify-full"),
    startupRoleRequired: z.literal(true),
  }).strict(),
  evidence: z.object({
    canonicalJsonRequired: z.literal(true),
    mode0600CurrentUidFilesRequired: z.literal(true),
    secretMaterialAllowedInReceipts: z.literal(false),
    retentionDays: z.literal(90),
  }).strict(),
}).strict();

export type PostgresMigrationVerifierAuthorityPolicy = z.infer<
  typeof postgresMigrationVerifierAuthorityPolicySchema
>;

export const postgresMigrationVerifierAuthorityBindingSchema = z.object({
  expectedEnvironment: environment,
  candidateSha: z.string().regex(CANDIDATE_PATTERN),
  operatorIdSha256: sha256,
  verifierIdSha256: sha256,
  verifierPublicKeySha256: sha256,
  authorityPolicySha256: sha256,
}).strict();

export type PostgresMigrationVerifierAuthorityBinding = z.infer<
  typeof postgresMigrationVerifierAuthorityBindingSchema
>;

export const postgresMigrationVerifierAuthoritySchema =
  postgresMigrationVerifierAuthorityBindingSchema.extend({
    authoritySha256: sha256,
    installedAt: TIMESTAMP,
  }).strict().superRefine((value, context) => {
    const expected = sha256PostgresMigrationVerifierAuthorityBinding({
      expectedEnvironment: value.expectedEnvironment,
      candidateSha: value.candidateSha,
      operatorIdSha256: value.operatorIdSha256,
      verifierIdSha256: value.verifierIdSha256,
      verifierPublicKeySha256: value.verifierPublicKeySha256,
      authorityPolicySha256: value.authorityPolicySha256,
    });
    if (value.authoritySha256 !== expected) {
      context.addIssue({ code: "custom", message: "verifier authority hash mismatch" });
    }
  });

export type PostgresMigrationVerifierAuthority = z.infer<
  typeof postgresMigrationVerifierAuthoritySchema
>;

export function sha256PostgresMigrationVerifierAuthorityBinding(
  value: PostgresMigrationVerifierAuthorityBinding,
): string {
  const parsed = postgresMigrationVerifierAuthorityBindingSchema.parse(value);
  return sha256PostgresMigrationBytes(serializeCanonicalPostgresMigrationJson(parsed));
}

export function normalizePostgresMigrationAuthorityIdentity(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 3 || normalized.length > 160 || /[\r\n\0]/.test(normalized)) {
    throw new TypeError("Postgres migration authority identity is invalid.");
  }
  return normalized;
}

export function sha256PostgresMigrationAuthorityIdentity(
  value: string,
  kind: "operator-id" | "verifier-id",
): string {
  return sha256PostgresMigrationBytes(
    `${kind}\0${normalizePostgresMigrationAuthorityIdentity(value)}`,
  );
}

export const postgresMigrationVerifierAuthorityReceiptWithoutHashSchema = z.object({
  schemaVersion: z.literal(POSTGRES_MIGRATION_VERIFIER_AUTHORITY_RECEIPT_SCHEMA),
  outcome: z.enum(["installed", "rotated", "reconciled_after_lost_ack"]),
  githubEnvironment: z.enum([
    "permanent-staging-postgres-migration-verifier-authority",
    "production-postgres-migration-verifier-authority",
  ]),
  githubRunIdSha256: sha256,
  targetIdentitySha256: sha256,
  targetUrlSha256: sha256,
  transportAuthoritySha256: sha256,
  authorityPolicySha256: sha256,
  expectedPreviousAuthoritySha256: z.union([z.literal("absent"), sha256]),
  authority: postgresMigrationVerifierAuthoritySchema,
  intentSha256: sha256,
  terminalEvidenceSha256: sha256,
  startedAt: TIMESTAMP,
  completedAt: TIMESTAMP,
  checks: z.object({
    githubContextExact: z.literal(true),
    targetIdentityExact: z.literal(true),
    transportExact: z.literal(true),
    provisionerRoleExact: z.literal(true),
    importerReadOnlyExact: z.literal(true),
    preflightExact: z.literal(true),
    oneWriteNoRetryExact: z.literal(true),
    postflightExact: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.startedAt) > Date.parse(value.completedAt)) {
    context.addIssue({ code: "custom", message: "authority receipt chronology mismatch" });
  }
});

export const postgresMigrationVerifierAuthorityReceiptSchema =
  postgresMigrationVerifierAuthorityReceiptWithoutHashSchema.extend({
    receiptSha256: sha256,
  }).strict().superRefine((value, context) => {
    const { receiptSha256, ...withoutHash } = value;
    const expected = sha256PostgresMigrationBytes(
      serializeCanonicalPostgresMigrationJson(withoutHash),
    );
    if (receiptSha256 !== expected) {
      context.addIssue({ code: "custom", message: "authority receipt hash mismatch" });
    }
  });

export type PostgresMigrationVerifierAuthorityReceipt = z.infer<
  typeof postgresMigrationVerifierAuthorityReceiptSchema
>;

export function finalizePostgresMigrationVerifierAuthorityReceipt(
  value: z.input<typeof postgresMigrationVerifierAuthorityReceiptWithoutHashSchema>,
): PostgresMigrationVerifierAuthorityReceipt {
  const parsed = postgresMigrationVerifierAuthorityReceiptWithoutHashSchema.parse(value);
  return postgresMigrationVerifierAuthorityReceiptSchema.parse({
    ...parsed,
    receiptSha256: sha256PostgresMigrationBytes(
      serializeCanonicalPostgresMigrationJson(parsed),
    ),
  });
}

export const POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../ops/railway/postgres-migration-verifier-authority-policy.json",
);

// Updated only with the reviewed canonical policy file in the same change.
export const POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256 =
  "dc45023348d27abadc4287c28a3e19676c6a7cd3d13f82aea947a111f08367e9" as const;

export function parsePostgresMigrationVerifierAuthorityPolicyBytes(
  bytes: Buffer,
  expectedSha256: string = POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
): PostgresMigrationVerifierAuthorityPolicy {
  if (
    bytes.length < 1
    || bytes.length > 64 * 1_024
    || !SHA256_PATTERN.test(expectedSha256)
    || sha256PostgresMigrationBytes(bytes) !== expectedSha256
  ) throw new TypeError("Postgres migration verifier authority policy mismatch.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("Postgres migration verifier authority policy mismatch.");
  }
  const parsed = postgresMigrationVerifierAuthorityPolicySchema.parse(value);
  if (!bytes.equals(serializeCanonicalPostgresMigrationJson(parsed))) {
    throw new TypeError("Postgres migration verifier authority policy mismatch.");
  }
  return parsed;
}

export function loadPostgresMigrationVerifierAuthorityPolicy(): {
  readonly policy: PostgresMigrationVerifierAuthorityPolicy;
  readonly policySha256: string;
} {
  const bytes = fs.readFileSync(POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_PATH);
  return {
    policy: parsePostgresMigrationVerifierAuthorityPolicyBytes(bytes),
    policySha256: POSTGRES_MIGRATION_VERIFIER_AUTHORITY_POLICY_SHA256,
  };
}

export function assertPostgresMigrationVerifierPublicKey(input: {
  readonly publicKeyBytes: Buffer;
  readonly expectedSha256: string;
}): void {
  if (
    !SHA256_PATTERN.test(input.expectedSha256)
    || sha256PostgresMigrationBytes(input.publicKeyBytes) !== input.expectedSha256
  ) throw new TypeError("Postgres migration verifier public key authority mismatch.");
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(input.publicKeyBytes);
  } catch {
    throw new TypeError("Postgres migration verifier public key authority mismatch.");
  }
  const exportedPem = key.export({ type: "spki", format: "pem" });
  const canonicalPem = typeof exportedPem === "string"
    ? Buffer.from(exportedPem, "utf8")
    : Buffer.from(exportedPem);
  if (
    key.asymmetricKeyType !== "ed25519"
    || !canonicalPem.equals(input.publicKeyBytes)
  ) throw new TypeError("Postgres migration verifier public key authority mismatch.");
}
