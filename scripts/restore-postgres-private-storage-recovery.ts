import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPrivateSecretFile } from "../src/lib/offsite-backup-download.js";
import { assertSupabaseServerApiKey } from "../src/lib/supabase-key-format.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  openPostgresRailwayStockLocalhostCaTransport,
  parsePostgresRailwayStockLocalhostCaUrl,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  PostgresRailwayStockLocalhostCaError,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  POSTGRES_PRIVATE_STORAGE_BUCKET,
  POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV,
  POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE,
  PostgresPrivateStorageRecoveryError,
  createPostgresPrivateStorageDatabaseInspector,
  createSupabasePrivateStorageRestoreBoundary,
  restorePostgresPrivateStorageRecovery,
  type PostgresPrivateStorageBoundary,
  type PostgresPrivateStorageRecoveryFailureCode,
  type RestorePostgresPrivateStorageRecoveryResult,
} from "../src/lib/postgres-private-storage-recovery.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

const ARGUMENTS = new Set([
  "--backup-directory",
  "--backup-manifest-sha256",
  "--bucket-name-sha256",
  "--destination-origin-sha256",
  "--destination-authority-file",
  "--destination-authority-sha256",
  "--destination-authority-public-key-file",
  "--destination-authority-public-key-sha256",
  "--expected-candidate-sha",
  "--expected-root-ca-der-sha256",
  "--forbidden-origin-sha256s",
  "--recovery-manifest-sha256",
  "--recovery-set-directory",
  "--recovery-set-sha256",
  "--root-ca-file",
  "--service-role-key-file",
  "--target-connection-url-file",
  "--target-connection-url-sha256",
  "--target-database-identity-sha256",
  "--target-railway-project-id",
  "--target-railway-environment-id",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^[a-f0-9]{40}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type PostgresPrivateStorageRestoreCliFailureCode =
  | PostgresPrivateStorageRecoveryFailureCode
  | "configuration_missing_or_unsafe"
  | "confirmation_required"
  | "operator_guard_rejected"
  | "secret_file_unsafe"
  | "database_transport_unsafe"
  | "database_transport_drift"
  | "database_transport_close_failed"
  | "unexpected_failure";

export type PostgresPrivateStorageRestoreCliResult =
  | (RestorePostgresPrivateStorageRecoveryResult & {
      readonly databaseTransportProfile:
        typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
      readonly databaseTransportRootCaDerSha256: string;
      readonly databaseEffectiveRole: "pintpath_migrator";
      readonly candidateSha: string;
      readonly destinationConnectionUrlSha256: string;
      readonly destinationOriginSha256: string;
      readonly destinationBucketNameSha256: string;
      readonly destinationAuthoritySha256: string;
      readonly destinationAuthorityPublicKeySha256: string;
      readonly destinationAuthorityReviewerIdSha256: string;
      readonly destinationRailwayProjectIdSha256: string;
      readonly destinationRailwayEnvironmentIdSha256: string;
    })
  | {
      readonly schemaVersion: 1;
      readonly kind: "pintpath-postgres-private-storage-recovery-restore";
      readonly ok: false;
      readonly failureCode: PostgresPrivateStorageRestoreCliFailureCode;
      readonly destinationDisposalRequired: boolean;
    };

export interface PostgresPrivateStorageRestoreCliDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly readSecretFile: (filePath: string) => Promise<string>;
  readonly now: () => Date;
  readonly getUid: () => number | null;
  readonly openDatabaseTransport: (
    options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  ) => Promise<PostgresRailwayStockLocalhostCaTransport>;
  readonly assertDestinationOriginApproved: (origin: string) => void;
  readonly createInspector: typeof createPostgresPrivateStorageDatabaseInspector;
  readonly createStorage: (input: {
    readonly supabaseUrl: string;
    readonly serviceRoleKey: string;
    readonly bucketName: string;
  }) => PostgresPrivateStorageBoundary;
  readonly restore: typeof restorePostgresPrivateStorageRecovery;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly writeOutput: (value: string) => void;
}

const DEFAULT_DEPENDENCIES: PostgresPrivateStorageRestoreCliDependencies = {
  environment: process.env,
  readSecretFile: readPrivateSecretFile,
  now: () => new Date(),
  getUid: () => process.getuid?.() ?? null,
  openDatabaseTransport: openPostgresRailwayStockLocalhostCaTransport,
  assertDestinationOriginApproved: () => undefined,
  createInspector: createPostgresPrivateStorageDatabaseInspector,
  createStorage: createSupabasePrivateStorageRestoreBoundary,
  restore: restorePostgresPrivateStorageRecovery,
  assertMutationAllowed: assertOperatorMutationAllowed,
  writeOutput: (value) => process.stdout.write(value),
};

class RestoreCliError extends Error {
  constructor(readonly code: PostgresPrivateStorageRestoreCliFailureCode) {
    super(code);
    this.name = "RestoreCliError";
  }
}

function exactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: "RESTORE_SUPABASE_URL",
): string {
  const value = environment[name];
  if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) {
    throw new RestoreCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function forbiddenHashes(value: string): readonly string[] {
  const hashes = value.split(",");
  if (
    hashes.length < 1 ||
    hashes.some((hash) => !SHA256_PATTERN.test(hash)) ||
    new Set(hashes).size !== hashes.length
  )
    throw new RestoreCliError("invalid_arguments");
  return Object.freeze(hashes);
}

function exactSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new RestoreCliError("invalid_arguments");
  return value;
}

function exactCandidateSha(value: string): string {
  if (!CANDIDATE_PATTERN.test(value)) throw new RestoreCliError("invalid_arguments");
  return value;
}

function canonical(value: unknown): string {
  return canonicalPostgresBackupJson(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function verifyPostgresPrivateStorageDestinationAuthority(input: {
  readonly authoritySource: string;
  readonly authoritySha256: string;
  readonly candidateSha: string;
  readonly destinationOrigin: string;
  readonly destinationOriginSha256: string;
  readonly targetConnectionUrlSha256: string;
  readonly targetDatabaseIdentitySha256: string;
  readonly targetRailwayProjectId: string;
  readonly targetRailwayEnvironmentId: string;
  readonly publicKeyPem: string;
  readonly publicKeySha256: string;
  readonly now: Date;
}): string {
  const authorityBytes = Buffer.from(input.authoritySource, "utf8");
  const publicKeyBytes = Buffer.from(input.publicKeyPem, "utf8");
  if (
    crypto.createHash("sha256").update(authorityBytes).digest("hex")
      !== input.authoritySha256
    || crypto.createHash("sha256").update(publicKeyBytes).digest("hex")
      !== input.publicKeySha256
  ) throw new RestoreCliError("configuration_missing_or_unsafe");
  let value: unknown;
  try {
    value = JSON.parse(input.authoritySource);
  } catch {
    throw new RestoreCliError("configuration_missing_or_unsafe");
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["schemaVersion", "payload", "signatureBase64"])
  ) throw new RestoreCliError("configuration_missing_or_unsafe");
  const envelope = value as Record<string, unknown>;
  const payload = envelope.payload;
  if (
    envelope.schemaVersion !== "pintpath-private-storage-disposable-authority/v1"
    || !payload || typeof payload !== "object" || Array.isArray(payload)
    || !exactKeys(payload, [
      "schemaVersion", "candidateSha", "destinationOrigin",
      "destinationOriginSha256", "targetConnectionUrlSha256",
      "targetDatabaseIdentitySha256", "reviewerIdSha256",
      "targetRailwayProjectId", "targetRailwayEnvironmentId",
      "reviewerPublicKeySha256", "issuedAt", "expiresAt",
    ])
    || typeof envelope.signatureBase64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      envelope.signatureBase64,
    )
  ) throw new RestoreCliError("configuration_missing_or_unsafe");
  const authority = payload as Record<string, unknown>;
  const issuedAt = String(authority.issuedAt);
  const expiresAt = String(authority.expiresAt);
  const nowMs = input.now.getTime();
  if (
    authority.schemaVersion !== "pintpath-private-storage-disposable-authority-payload/v1"
    || authority.candidateSha !== input.candidateSha
    || authority.destinationOrigin !== input.destinationOrigin
    || authority.destinationOriginSha256 !== input.destinationOriginSha256
    || authority.targetConnectionUrlSha256 !== input.targetConnectionUrlSha256
    || authority.targetDatabaseIdentitySha256 !== input.targetDatabaseIdentitySha256
    || authority.targetRailwayProjectId !== input.targetRailwayProjectId
    || authority.targetRailwayEnvironmentId !== input.targetRailwayEnvironmentId
    || authority.reviewerPublicKeySha256 !== input.publicKeySha256
    || !SHA256_PATTERN.test(String(authority.reviewerIdSha256))
    || !TIMESTAMP_PATTERN.test(issuedAt)
    || !TIMESTAMP_PATTERN.test(expiresAt)
    || !Number.isFinite(nowMs)
    || Date.parse(issuedAt) > nowMs
    || Date.parse(expiresAt) <= nowMs
    || Date.parse(expiresAt) - Date.parse(issuedAt) > 86_400_000
    || canonical(value) !== input.authoritySource
  ) throw new RestoreCliError("configuration_missing_or_unsafe");
  try {
    const key = crypto.createPublicKey(publicKeyBytes);
    if (
      key.asymmetricKeyType !== "ed25519"
      || !crypto.verify(
        null,
        Buffer.from(canonical(authority), "utf8"),
        key,
        Buffer.from(envelope.signatureBase64, "base64"),
      )
    ) throw new Error("signature mismatch");
  } catch {
    throw new RestoreCliError("configuration_missing_or_unsafe");
  }
  return String(authority.reviewerIdSha256);
}

export interface VerifiedPostgresPrivateStorageDestinationAuthority {
  readonly reviewerIdSha256: string;
  readonly targetRailwayProjectId: string;
  readonly targetRailwayEnvironmentId: string;
}

function exactSecretFilePath(value: string): string {
  if (
    !value ||
    value.includes("\0") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new RestoreCliError("configuration_missing_or_unsafe");
  }
  return value;
}

function failureCode(
  error: unknown,
): PostgresPrivateStorageRestoreCliFailureCode {
  if (error instanceof RestoreCliError) return error.code;
  if (error instanceof PostgresPrivateStorageRecoveryError) return error.code;
  if (error instanceof PostgresRailwayStockLocalhostCaError) {
    return error.code === "transport_drift"
      ? "database_transport_drift"
      : error.code === "cleanup_failed"
        ? "database_transport_close_failed"
        : "database_transport_unsafe";
  }
  return "unexpected_failure";
}

async function secret(
  dependencies: PostgresPrivateStorageRestoreCliDependencies,
  value: string,
): Promise<string> {
  try {
    return await dependencies.readSecretFile(value);
  } catch {
    throw new RestoreCliError("secret_file_unsafe");
  }
}

export async function runPostgresPrivateStorageRestoreCli(
  argv: readonly string[],
  overrides: Partial<PostgresPrivateStorageRestoreCliDependencies> = {},
): Promise<0 | 1> {
  const dependencies: PostgresPrivateStorageRestoreCliDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  let databaseTransport: PostgresRailwayStockLocalhostCaTransport | null = null;
  let destinationAuthorityReviewerIdSha256 = "";
  try {
    let args: Map<string, string>;
    try {
      args = parseStrictArguments(argv, {
        allowed: ARGUMENTS,
        required: ARGUMENTS,
      });
    } catch {
      throw new RestoreCliError("invalid_arguments");
    }
    if (
      dependencies.environment[
        POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_ENV
      ] !== POSTGRES_PRIVATE_STORAGE_RESTORE_CONFIRMATION_VALUE
    )
      throw new RestoreCliError("confirmation_required");
    try {
      dependencies.assertMutationAllowed(
        "Postgres private Storage recovery restore rehearsal",
      );
    } catch {
      throw new RestoreCliError("operator_guard_rejected");
    }
    const targetConnectionUrlFile = exactSecretFilePath(
      args.get("--target-connection-url-file")!,
    );
    const serviceRoleKeyFile = exactSecretFilePath(
      args.get("--service-role-key-file")!,
    );
    const rootCaFile = exactSecretFilePath(args.get("--root-ca-file")!);
    const authorityFile = exactSecretFilePath(args.get("--destination-authority-file")!);
    const authorityPublicKeyFile = exactSecretFilePath(
      args.get("--destination-authority-public-key-file")!,
    );
    const destinationSupabaseUrl = exactEnvironment(
      dependencies.environment,
      "RESTORE_SUPABASE_URL",
    );
    const candidateSha = exactCandidateSha(args.get("--expected-candidate-sha")!);
    const targetRailwayProjectId = args.get("--target-railway-project-id")!;
    const targetRailwayEnvironmentId = args.get("--target-railway-environment-id")!;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(targetRailwayProjectId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(targetRailwayEnvironmentId)
    ) throw new RestoreCliError("invalid_arguments");
    const [authoritySource, authorityPublicKey] = await Promise.all([
      secret(dependencies, authorityFile),
      secret(dependencies, authorityPublicKeyFile),
    ]);
    destinationAuthorityReviewerIdSha256 = verifyPostgresPrivateStorageDestinationAuthority({
      authoritySource,
      authoritySha256: exactSha256(args.get("--destination-authority-sha256")!),
      candidateSha,
      destinationOrigin: destinationSupabaseUrl,
      destinationOriginSha256: exactSha256(args.get("--destination-origin-sha256")!),
      targetConnectionUrlSha256: exactSha256(
        args.get("--target-connection-url-sha256")!,
      ),
      targetDatabaseIdentitySha256: exactSha256(
        args.get("--target-database-identity-sha256")!,
      ),
      targetRailwayProjectId,
      targetRailwayEnvironmentId,
      publicKeyPem: authorityPublicKey,
      publicKeySha256: exactSha256(
        args.get("--destination-authority-public-key-sha256")!,
      ),
      now: dependencies.now(),
    });
    try {
      dependencies.assertDestinationOriginApproved(destinationSupabaseUrl);
    } catch {
      throw new RestoreCliError("configuration_missing_or_unsafe");
    }
    const [connectionString, serviceRoleKey] = await Promise.all([
      secret(dependencies, targetConnectionUrlFile),
      secret(dependencies, serviceRoleKeyFile),
    ]);
    try {
      assertSupabaseServerApiKey(
        serviceRoleKey,
        "RESTORE_SUPABASE_SERVICE_ROLE_KEY",
      );
    } catch {
      throw new RestoreCliError("secret_file_unsafe");
    }
    let parsedConnection: ReturnType<typeof parsePostgresRailwayStockLocalhostCaUrl>;
    try {
      parsedConnection = parsePostgresRailwayStockLocalhostCaUrl(connectionString);
    } catch {
      throw new RestoreCliError("database_transport_unsafe");
    }
    const uid = dependencies.getUid();
    if (!Number.isSafeInteger(uid) || Number(uid) < 0) {
      throw new RestoreCliError("database_transport_unsafe");
    }
    databaseTransport = await dependencies.openDatabaseTransport({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile,
      expectedRootCaDerSha256: args.get("--expected-root-ca-der-sha256")!,
      expectedUid: uid!,
      sourceUrlAuthority: parsedConnection.sourceUrlAuthority,
    });
    await databaseTransport.assertExact();
    const inspectTargetDatabase = dependencies.createInspector({
      connectionString,
      expectedConnectionUrlSha256: args.get("--target-connection-url-sha256")!,
      railwayStockLocalhostCaConnection: databaseTransport.nodeConnection,
    });
    const destinationStorage = dependencies.createStorage({
      supabaseUrl: destinationSupabaseUrl,
      serviceRoleKey,
      bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
    });
    const result = await dependencies.restore({
      backupDirectory: args.get("--backup-directory")!,
      expectedBackupManifestSha256: args.get("--backup-manifest-sha256")!,
      recoverySetDirectory: args.get("--recovery-set-directory")!,
      expectedRecoverySetSha256: args.get("--recovery-set-sha256")!,
      expectedRecoveryManifestSha256: args.get("--recovery-manifest-sha256")!,
      expectedTargetDatabaseIdentitySha256: args.get(
        "--target-database-identity-sha256",
      )!,
      expectedTargetConnectionUrlSha256: args.get(
        "--target-connection-url-sha256",
      )!,
      destinationSupabaseUrl,
      expectedDestinationOriginSha256: args.get("--destination-origin-sha256")!,
      forbiddenDestinationOriginSha256s: forbiddenHashes(
        args.get("--forbidden-origin-sha256s")!,
      ),
      bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
      expectedBucketNameSha256: args.get("--bucket-name-sha256")!,
      inspectTargetDatabase,
      destinationStorage,
    });
    await databaseTransport.assertExact();
    const databaseTransportProfile = databaseTransport.profile;
    const databaseTransportRootCaDerSha256 = databaseTransport.rootCaDerSha256;
    await databaseTransport.close();
    databaseTransport = null;
    const authenticatedResult: PostgresPrivateStorageRestoreCliResult = {
      ...result,
      databaseTransportProfile,
      databaseTransportRootCaDerSha256,
      databaseEffectiveRole: "pintpath_migrator",
      candidateSha: args.get("--expected-candidate-sha")!,
      destinationConnectionUrlSha256: args.get("--target-connection-url-sha256")!,
      destinationOriginSha256: args.get("--destination-origin-sha256")!,
      destinationBucketNameSha256: args.get("--bucket-name-sha256")!,
      destinationAuthoritySha256: args.get("--destination-authority-sha256")!,
      destinationAuthorityPublicKeySha256:
        args.get("--destination-authority-public-key-sha256")!,
      destinationAuthorityReviewerIdSha256,
      destinationRailwayProjectIdSha256: crypto.createHash("sha256")
        .update(targetRailwayProjectId).digest("hex"),
      destinationRailwayEnvironmentIdSha256: crypto.createHash("sha256")
        .update(targetRailwayEnvironmentId).digest("hex"),
    };
    dependencies.writeOutput(canonicalPostgresBackupJson(authenticatedResult));
    return 0;
  } catch (error) {
    if (databaseTransport) {
      try {
        await databaseTransport.close();
      } catch {
        error = new RestoreCliError("database_transport_close_failed");
      }
      databaseTransport = null;
    }
    const code = failureCode(error);
    const result: PostgresPrivateStorageRestoreCliResult = {
      schemaVersion: 1,
      kind: "pintpath-postgres-private-storage-recovery-restore",
      ok: false,
      failureCode: code,
      destinationDisposalRequired: code.endsWith("_disposal_required"),
    };
    dependencies.writeOutput(canonicalPostgresBackupJson(result));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresPrivateStorageRestoreCli(
    process.argv.slice(2),
  );
}
