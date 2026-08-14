import crypto from "node:crypto";

import dotenv from "dotenv";

import { createServerSupabaseClient } from "../src/lib/supabase-client.js";
import { isCanonicalProductionRuntime } from "../src/lib/deployment-environment.js";
import {
  OPERATIONAL_OFFSITE_BACKUP_BUCKET,
  resolveExactOperationalOffsiteBackupBucket,
} from "../src/lib/supabase-key-format.js";
import { parseAccountDeletionNotificationKeyring } from "../src/lib/account-deletion-notification-worker.js";
import { inspectPostgresRuntimeImplementationContract } from "../src/db/runtime-persistence.js";
import {
  assertPostgresRailwayStockLocalhostRootCaPem,
  parsePostgresRailwayStockLocalhostCaUrl,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

dotenv.config({ quiet: true });

const PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au";
const PERMANENT_STAGING_SUPABASE_ORIGIN = "https://bbfibbadwjxzrcdncavy.supabase.co";
const OPERATIONAL_OFFSITE_SUPABASE_ORIGIN = "https://hfbmhdxrwtihukmixxta.supabase.co";

type CheckStatus = "pass" | "warn" | "fail";

interface ProviderCheck {
  id: string;
  label: string;
  status: CheckStatus;
  action: string | null;
  details?: string | null;
}

interface PostgresRuntimeAuthorityReadiness {
  readonly schemaVersion: "pintpath-postgres-runtime-authority-readiness/v1";
  readonly applicationUrlSha256: string | null;
  readonly maintenanceUrlSha256: string | null;
  readonly rootCaPemSha256: string | null;
  readonly rootCaDerSha256: string | null;
  readonly applicationUrlExact: boolean;
  readonly maintenanceUrlExact: boolean;
  readonly sameDatabaseTarget: boolean;
  readonly distinctLoginRoles: boolean;
  readonly rootCaExact: boolean;
}

function hasValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function getValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function isEnabled(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(getValue(name).toLowerCase());
}

function connectionUrlSha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function checkPinnedConnectionIdentity(input: {
  urlName: "DATABASE_URL" | "REDIS_URL";
  expectedDigestName: "PINTPATH_EXPECTED_DATABASE_URL_SHA256" | "PINTPATH_EXPECTED_REDIS_URL_SHA256";
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S" | "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S";
  id: string;
  label: string;
  action: string;
  minimumForbidden?: number;
  requireForbiddenAbsent?: boolean;
  requiredForbiddenDigestName?: "PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256" | "PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256";
}): ProviderCheck {
  const connectionUrl = getValue(input.urlName);
  const expected = getValue(input.expectedDigestName).toLowerCase();
  const forbidden = getValue(input.forbiddenDigestsName)
    .split(",")
    .map((digest) => digest.trim().toLowerCase())
    .filter(Boolean);
  const uniqueForbidden = [...new Set(forbidden)];
  const minimumForbidden = input.minimumForbidden ?? 2;
  const requiredForbidden = input.requiredForbiddenDigestName
    ? getValue(input.requiredForbiddenDigestName).toLowerCase()
    : "";
  const digestInputsValid = /^[a-f0-9]{64}$/.test(expected)
    && forbidden.length >= minimumForbidden
    && uniqueForbidden.length === forbidden.length
    && forbidden.every((digest) => /^[a-f0-9]{64}$/.test(digest))
    && (!input.requireForbiddenAbsent || forbidden.length === 0)
    && (!input.requiredForbiddenDigestName || (
      /^[a-f0-9]{64}$/.test(requiredForbidden)
      && forbidden.includes(requiredForbidden)
    ));
  const actual = connectionUrl ? connectionUrlSha256(connectionUrl) : "";
  const exactAndDistinct = digestInputsValid
    && actual === expected
    && !forbidden.includes(actual)
    && !forbidden.includes(expected);
  return {
    id: input.id,
    label: input.label,
    status: exactAndDistinct ? "pass" : isProduction() ? "fail" : "warn",
    action: exactAndDistinct ? null : input.action,
    details: exactAndDistinct
      ? "The live connection URL matches its protected SHA-256 identity pin and differs from every registered forbidden environment."
      : "The identity proof is absent, malformed, mismatched, or aliases a forbidden environment; no URL or digest is emitted.",
  };
}

function checkPinnedResourceIdentity(input: {
  actualName: "PINTPATH_DATABASE_RESOURCE_ID" | "PINTPATH_REDIS_RESOURCE_ID";
  expectedName: "PINTPATH_EXPECTED_DATABASE_RESOURCE_ID" | "PINTPATH_EXPECTED_REDIS_RESOURCE_ID";
  forbiddenName: "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS" | "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS";
  id: string;
  label: string;
  action: string;
  minimumForbidden?: number;
  requireForbiddenAbsent?: boolean;
  requiredForbiddenResourceName?: "PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID" | "PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID";
}): ProviderCheck {
  const actual = getValue(input.actualName);
  const expected = getValue(input.expectedName);
  const forbidden = getValue(input.forbiddenName).split(",").map((value) => value.trim()).filter(Boolean);
  const uniqueForbidden = [...new Set(forbidden)];
  const minimumForbidden = input.minimumForbidden ?? 2;
  const requiredForbidden = input.requiredForbiddenResourceName
    ? getValue(input.requiredForbiddenResourceName)
    : "";
  const validIdentity = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)
    && !/(?:^|[._:-])(?:change[-_]?me|dummy|example|fake|fixture|placeholder|replace(?:[-_]?with)?|test)(?:$|[._:-])/i.test(value);
  const exactAndDistinct = validIdentity(actual)
    && validIdentity(expected)
    && actual === expected
    && forbidden.length >= minimumForbidden
    && uniqueForbidden.length === forbidden.length
    && forbidden.every(validIdentity)
    && (!input.requireForbiddenAbsent || forbidden.length === 0)
    && (!input.requiredForbiddenResourceName || (
      validIdentity(requiredForbidden)
      && forbidden.includes(requiredForbidden)
    ))
    && !forbidden.includes(actual)
    && !forbidden.includes(expected);
  return {
    id: input.id,
    label: input.label,
    status: exactAndDistinct ? "pass" : isProduction() ? "fail" : "warn",
    action: exactAndDistinct ? null : input.action,
    details: exactAndDistinct
      ? "The live provider resource ID exactly matches the protected environment pin and differs from the registered staging/production/restore resources."
      : "The provider resource identity is absent, malformed, mismatched, duplicated, or aliases another environment.",
  };
}

function checkPermanentStagingRailwayIdentity(): ProviderCheck {
  const exact = isProduction()
    && getValue("RAILWAY_ENVIRONMENT_NAME").toLowerCase() === "staging"
    && Boolean(getValue("PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID"))
    && Boolean(getValue("PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID"))
    && Boolean(getValue("PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID"))
    && getValue("RAILWAY_PROJECT_ID") === getValue("PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID")
    && getValue("RAILWAY_ENVIRONMENT_ID") === getValue("PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID")
    && getValue("RAILWAY_SERVICE_ID") === getValue("PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID");
  return {
    id: "PERMANENT_STAGING_RAILWAY_IDENTITY",
    label: "Reviewed permanent-staging Railway identity tuple",
    status: exact ? "pass" : "fail",
    action: exact
      ? null
      : "Run only in the exact permanent-staging Railway project/environment/service tuple loaded from the protected identity register.",
  };
}

function checkPermanentStagingSelfPins(): ProviderCheck {
  const exact = /^[a-f0-9]{64}$/.test(getValue("PINTPATH_EXPECTED_DATABASE_URL_SHA256"))
    && getValue("PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256") === getValue("PINTPATH_EXPECTED_DATABASE_URL_SHA256")
    && /^[a-f0-9]{64}$/.test(getValue("PINTPATH_EXPECTED_REDIS_URL_SHA256"))
    && getValue("PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256") === getValue("PINTPATH_EXPECTED_REDIS_URL_SHA256")
    && getValue("PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID") === getValue("PINTPATH_EXPECTED_DATABASE_RESOURCE_ID")
    && getValue("PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID") === getValue("PINTPATH_EXPECTED_REDIS_RESOURCE_ID");
  return {
    id: "PERMANENT_STAGING_NAMED_SELF_PINS",
    label: "Named permanent-staging database and Redis self pins",
    status: exact ? "pass" : "fail",
    action: exact
      ? null
      : "Bind each named permanent-staging URL digest and environment-specific service-instance ID to the matching reviewed live/expected staging pin.",
  };
}

function checkPermanentStagingServiceInstances(): ProviderCheck {
  const environmentId = getValue("RAILWAY_ENVIRONMENT_ID");
  const valid = (value: string) => {
    const parts = value.split(":");
    return Boolean(environmentId)
      && parts.length === 3
      && parts[0] === "railway"
      && parts[1] === environmentId
      && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(parts[2] ?? "")
      && !/(?:^|[._:-])(?:change[-_]?me|dummy|example|fake|fixture|placeholder|replace(?:[-_]?with)?|test)(?:$|[._:-])/i.test(parts[2] ?? "");
  };
  const exact = valid(getValue("PINTPATH_DATABASE_RESOURCE_ID"))
    && valid(getValue("PINTPATH_REDIS_RESOURCE_ID"));
  return {
    id: "PERMANENT_STAGING_SERVICE_INSTANCE_IDENTITIES",
    label: "Environment-specific staging database and Redis service instances",
    status: exact ? "pass" : "fail",
    action: exact
      ? null
      : "Use railway:<environment-id>:<service-id> for both resources; a shared top-level Railway service ID is not an environment identity.",
  };
}

function hasValidResendWebhookSecret(): boolean {
  const encoded = getValue("RESEND_WEBHOOK_SIGNING_SECRET").match(/^whsec_([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!encoded) return false;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.byteLength >= 24
    && decoded.byteLength <= 64
    && decoded.toString("base64").replace(/=+$/, "") === encoded.replace(/=+$/, "");
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isStrictLaunchCheck(): boolean {
  return process.env.LAUNCH_READINESS_STRICT === "true"
    || process.argv.includes("--strict")
    || process.argv.includes("--launch");
}

function checkDeployedReadinessContext(): ProviderCheck {
  const deployed = isProduction()
    && [
      "RAILWAY_PROJECT_ID",
      "RAILWAY_ENVIRONMENT_ID",
      "RAILWAY_SERVICE_ID",
      "RAILWAY_DEPLOYMENT_ID",
      "RAILWAY_REPLICA_ID",
    ].every(hasValue);
  return {
    id: "RAILWAY_DEPLOYED_READINESS_CONTEXT",
    label: "Deployed Railway provider-readiness context",
    status: deployed ? "pass" : "fail",
    action: deployed
      ? null
      : "Run secret-aware readiness only inside the deployed Railway service or a Railway one-shot deployment; local variable injection and railway run are not evidence.",
    details: deployed
      ? "Platform project, environment, service, deployment, and replica identity are present."
      : "One or more required platform runtime identities are absent; no identity value is emitted.",
  };
}

function checkRequired(name: string, label: string, action: string): ProviderCheck {
  const present = hasValue(name);
  return {
    id: name,
    label,
    status: present ? "pass" : isProduction() ? "fail" : "warn",
    action: present ? null : action,
  };
}

function checkExactSupabaseOrigin(
  name: "SUPABASE_URL" | "OFFSITE_BACKUP_SUPABASE_URL",
  expectedOrigin: string,
  label: string,
  action: string,
): ProviderCheck {
  const exact = process.env[name] === expectedOrigin;
  return {
    id: name,
    label,
    status: exact ? "pass" : isProduction() ? "fail" : "warn",
    action: exact ? null : action,
    details: exact
      ? "Configured URL matches the exact reviewed HTTPS origin; no URL value is emitted."
      : "URL is absent, normalized, or differs from the reviewed origin; no URL value is emitted.",
  };
}

type SupabaseKeyFormat = "publishable" | "secret";

const SUPABASE_KEY_MAXIMUM_BYTES = 256;
const SUPABASE_KEY_SUFFIX_MINIMUM_LENGTH = 20;
const SUPABASE_KEY_SUFFIX_MAXIMUM_LENGTH = 220;

function hasExactSupabaseKeyShape(
  value: string,
  format: SupabaseKeyFormat,
): boolean {
  const prefix = format === "publishable" ? "sb_publishable_" : "sb_secret_";
  const suffixLength = value.length - prefix.length;
  if (
    Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > SUPABASE_KEY_MAXIMUM_BYTES
    || !value.startsWith(prefix)
    || suffixLength < SUPABASE_KEY_SUFFIX_MINIMUM_LENGTH
    || suffixLength > SUPABASE_KEY_SUFFIX_MAXIMUM_LENGTH
  ) return false;

  for (let index = prefix.length; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const allowed = (code >= 0x30 && code <= 0x39)
      || (code >= 0x41 && code <= 0x5a)
      || code === 0x5f
      || (code >= 0x61 && code <= 0x7a)
      || code === 0x2d;
    if (!allowed) return false;
  }
  return true;
}

function checkSupabaseKeyFormat(
  name: "SUPABASE_ANON_KEY" | "SUPABASE_SERVICE_ROLE_KEY" | "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
  format: SupabaseKeyFormat,
  label: string,
  action: string,
): ProviderCheck {
  const exact = hasExactSupabaseKeyShape(process.env[name] ?? "", format);
  return {
    id: name,
    label,
    status: exact ? "pass" : isProduction() ? "fail" : "warn",
    action: exact ? null : action,
    details: exact
      ? `Configured key uses the reviewed sb_${format}_ format; no key value is emitted.`
      : `Key is absent, malformed, or legacy; expected the reviewed sb_${format}_ format and no key value is emitted.`,
  };
}

function checkDistinctSupabaseSecretKeys(): ProviderCheck {
  const primary = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const offsite = process.env.OFFSITE_BACKUP_SERVICE_ROLE_KEY ?? "";
  const exactAndDistinct = hasExactSupabaseKeyShape(primary, "secret")
    && hasExactSupabaseKeyShape(offsite, "secret")
    && primary !== offsite;
  return {
    id: "SUPABASE_SERVICE_ROLE_KEYS_DISTINCT",
    label: "Distinct primary and operational restore Supabase secret keys",
    status: exactAndDistinct ? "pass" : isProduction() ? "fail" : "warn",
    action: exactAndDistinct
      ? null
      : "Configure exact sb_secret_ keys from two separate projects and ensure the primary and operational restore keys differ.",
    details: exactAndDistinct
      ? "The two reviewed project secret keys are distinct; no key value is emitted."
      : "One or both secret keys are absent, malformed, legacy, or reused; no key value is emitted.",
  };
}

function checkOptionalStrongSecret(name: string, label: string, action: string): ProviderCheck {
  const value = getValue(name);
  if (!value) {
    return {
      id: name,
      label,
      status: "pass",
      action: null,
      details: "Disabled because no signing secret is configured.",
    };
  }
  const documentedPlaceholder = /(?:replace[_ -]?with|change[_ -]?me|placeholder|your[_ -].*secret)/i.test(value);
  const repeatedCharacter = new Set(value).size < 4;
  const strong = Buffer.byteLength(value, "utf8") >= 32 && !documentedPlaceholder && !repeatedCharacter;
  return {
    id: name,
    label,
    status: strong ? "pass" : isProduction() ? "fail" : "warn",
    action: strong ? null : action,
  };
}

function checkRequiredStrongSecret(name: string, label: string, action: string): ProviderCheck {
  const value = getValue(name);
  const documentedPlaceholder = /(?:replace[_ -]?with|change[_ -]?me|placeholder|your[_ -].*secret)/i.test(value);
  const repeatedCharacter = value.length > 0 && new Set(value).size < 4;
  const strong = Buffer.byteLength(value, "utf8") >= 32 && !documentedPlaceholder && !repeatedCharacter;
  return {
    id: name,
    label,
    status: strong ? "pass" : isProduction() ? "fail" : "warn",
    action: strong ? null : action,
  };
}

function checkAbsent(names: string[], id: string, label: string, action: string): ProviderCheck {
  const configured = names.filter(hasValue);
  return {
    id,
    label,
    status: configured.length === 0 ? "pass" : "fail",
    action: configured.length === 0 ? null : action,
    details: configured.length === 0
      ? "No inherited credentials are configured."
      : `Remove: ${configured.join(", ")}.`,
  };
}

function optionalSha256(value: string): string | null {
  return value.length > 0 ? connectionUrlSha256(value) : null;
}

function inspectPostgresRuntimeAuthority(): PostgresRuntimeAuthorityReadiness {
  const applicationValue = process.env.DATABASE_URL ?? "";
  const maintenanceValue = process.env.DATABASE_MAINTENANCE_URL ?? "";
  const rootCaPem = process.env.PINTPATH_POSTGRES_ROOT_CA_PEM ?? "";
  const rootCaDerSha256 = getValue(
    "PINTPATH_POSTGRES_ROOT_CA_DER_SHA256",
  ).toLowerCase();
  let applicationUrlExact = false;
  let maintenanceUrlExact = false;
  let sameDatabaseTarget = false;
  let distinctLoginRoles = false;
  let rootCaExact = false;
  let application: URL | null = null;
  let maintenance: URL | null = null;

  try {
    parsePostgresRailwayStockLocalhostCaUrl(applicationValue);
    application = new URL(applicationValue);
    applicationUrlExact = true;
  } catch {
    application = null;
  }
  try {
    parsePostgresRailwayStockLocalhostCaUrl(maintenanceValue);
    maintenance = new URL(maintenanceValue);
    maintenanceUrlExact = true;
  } catch {
    maintenance = null;
  }
  if (application && maintenance) {
    sameDatabaseTarget = application.protocol === maintenance.protocol
      && application.hostname === maintenance.hostname
      && application.port === maintenance.port
      && application.pathname === maintenance.pathname;
    try {
      distinctLoginRoles = Boolean(application.username)
        && Boolean(maintenance.username)
        && decodeURIComponent(application.username)
          !== decodeURIComponent(maintenance.username);
    } catch {
      distinctLoginRoles = false;
    }
  }
  try {
    assertPostgresRailwayStockLocalhostRootCaPem(
      rootCaPem,
      rootCaDerSha256,
    );
    rootCaExact = true;
  } catch {
    rootCaExact = false;
  }

  return Object.freeze({
    schemaVersion: "pintpath-postgres-runtime-authority-readiness/v1",
    applicationUrlSha256: optionalSha256(applicationValue),
    maintenanceUrlSha256: optionalSha256(maintenanceValue),
    rootCaPemSha256: optionalSha256(rootCaPem),
    rootCaDerSha256: /^[a-f0-9]{64}$/.test(rootCaDerSha256)
      ? rootCaDerSha256
      : null,
    applicationUrlExact,
    maintenanceUrlExact,
    sameDatabaseTarget,
    distinctLoginRoles,
    rootCaExact,
  });
}

const postgresRuntimeAuthority = inspectPostgresRuntimeAuthority();

function postgresRuntimeAuthorityChecks(input: {
  applicationId: string;
  maintenanceId: string;
  rootCaId: string;
  labelPrefix: string;
}): readonly [ProviderCheck, ProviderCheck, ProviderCheck] {
  const applicationExact = postgresRuntimeAuthority.applicationUrlExact
    && !hasValue("DATABASE_PATH");
  const maintenanceExact = postgresRuntimeAuthority.maintenanceUrlExact
    && postgresRuntimeAuthority.sameDatabaseTarget
    && postgresRuntimeAuthority.distinctLoginRoles;
  return [
    {
      id: input.applicationId,
      label: `${input.labelPrefix} application Postgres authority`,
      status: applicationExact ? "pass" : isProduction() ? "fail" : "warn",
      action: applicationExact
        ? null
        : "Set DATABASE_URL to the exact lower-case Railway private :5432 application-login URL with only sslmode=verify-full, and remove DATABASE_PATH.",
      details: applicationExact
        ? "The application URL has the exact Railway stock-localhost CA transport shape and writable SQLite is absent."
        : "The application Postgres authority is absent or does not match the canonical runtime contract; no URL is emitted.",
    },
    {
      id: input.maintenanceId,
      label: `${input.labelPrefix} maintenance Postgres authority`,
      status: maintenanceExact ? "pass" : isProduction() ? "fail" : "warn",
      action: maintenanceExact
        ? null
        : "Set DATABASE_MAINTENANCE_URL to the exact lower-case Railway private :5432 maintenance-login URL with only sslmode=verify-full, targeting the same database through a distinct login.",
      details: maintenanceExact
        ? "The maintenance URL targets the application database through a distinct exact login authority."
        : "The maintenance Postgres authority is absent, mismatched, or not login-separated; no URL is emitted.",
    },
    {
      id: input.rootCaId,
      label: `${input.labelPrefix} Railway root CA authority`,
      status: postgresRuntimeAuthority.rootCaExact
        ? "pass"
        : isProduction() ? "fail" : "warn",
      action: postgresRuntimeAuthority.rootCaExact
        ? null
        : "Set PINTPATH_POSTGRES_ROOT_CA_PEM to the one valid self-signed Railway root CA and match its independently reviewed PINTPATH_POSTGRES_ROOT_CA_DER_SHA256 pin.",
      details: postgresRuntimeAuthority.rootCaExact
        ? "The bounded root CA PEM is valid and matches its reviewed DER SHA-256 pin."
        : "The root CA authority is absent, invalid, expired, or mismatched; no PEM is emitted.",
    },
  ];
}

function checkNoTestKeyInProduction(name: string, label: string, testPrefix: string): ProviderCheck {
  const value = getValue(name);
  if (!isProduction() || !value) {
    return {
      id: `${name}_MODE`,
      label,
      status: "pass",
      action: null,
    };
  }

  const isTest = value.startsWith(testPrefix);
  return {
    id: `${name}_MODE`,
    label,
    status: isTest ? "fail" : "pass",
    action: isTest
      ? `Replace ${name} with a live-mode Stripe key before enabling production paid checkout.`
      : null,
  };
}

function getSupabaseProviderCallbackUrl(): string | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (
    supabaseUrl !== PRODUCTION_SUPABASE_ORIGIN
    && supabaseUrl !== PERMANENT_STAGING_SUPABASE_ORIGIN
  ) return null;
  return `${supabaseUrl}/auth/v1/callback`;
}

function checkSupabaseProviderCallbackUrl(): ProviderCheck {
  const callbackUrl = getSupabaseProviderCallbackUrl();
  return {
    id: "SUPABASE_PROVIDER_CALLBACK_URL",
    label: "Google OAuth provider callback URL",
    status: callbackUrl ? "pass" : isProduction() ? "fail" : "warn",
    action: callbackUrl
      ? null
      : "Set SUPABASE_URL so the provider callback URL can be derived for the Google OAuth console.",
    details: callbackUrl
      ? `Add this exact URL to Google Authorized redirect URIs: ${callbackUrl}`
      : null,
  };
}

function checkSupabaseOauthLaunchProviders(): ProviderCheck {
  const providers = getValue("SUPABASE_OAUTH_PROVIDERS")
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
  const launchSafe = providers.length === 1 && providers[0] === "google";
  return {
    id: "SUPABASE_OAUTH_PROVIDERS",
    label: "Launch OAuth provider scope",
    status: isProduction() && !launchSafe ? "fail" : "pass",
    action: isProduction() && !launchSafe
      ? "Set SUPABASE_OAUTH_PROVIDERS=google. Keep Apple disabled until authorization-token revocation is implemented and tested."
      : null,
    details: launchSafe ? "Google enabled; Apple disabled for this launch." : null,
  };
}

function hasExactRemovedStoragePaths(
  value: unknown,
  expectedPaths: readonly string[],
): boolean {
  if (!Array.isArray(value) || value.length !== expectedPaths.length) return false;
  const names: string[] = [];
  for (const entry of value) {
    if (
      !entry
      || typeof entry !== "object"
      || typeof (entry as { readonly name?: unknown }).name !== "string"
    ) return false;
    names.push((entry as { readonly name: string }).name);
  }
  const expected = new Set(expectedPaths);
  return new Set(names).size === names.length
    && names.every((name) => expected.has(name));
}

async function checkPrivateStorageBucket(input: {
  id: string;
  label: string;
  bucketName: string;
  urlEnvName: string;
  keyEnvName: string;
  requiredMimeTypes?: string[];
  minimumFileSizeBytes?: number;
  requireNoBucketSizeLimit?: boolean;
  probeReadWrite?: boolean;
  setupSqlPath?: string;
}): Promise<ProviderCheck> {
  const setupHint = input.setupSqlPath ? ` Run ${input.setupSqlPath} against that project.` : "";
  if (!isProduction()) {
    return { id: input.id, label: input.label, status: "pass", action: null };
  }

  const supabaseUrl = getValue(input.urlEnvName);
  const serviceRoleKey = getValue(input.keyEnvName);
  if (!supabaseUrl || !serviceRoleKey) {
    return {
      id: input.id,
      label: input.label,
      status: "fail",
      action: `Configure ${input.urlEnvName}/${input.keyEnvName} and create the private ${input.bucketName} bucket.${setupHint}`,
    };
  }

  try {
    const client = createServerSupabaseClient(supabaseUrl, serviceRoleKey, { timeoutMs: 15_000 });
    const { data, error } = await client.storage.getBucket(input.bucketName);
    const privateBucket = !error && data && data.public === false;
    if (!privateBucket) {
      return {
        id: input.id,
        label: input.label,
        status: "fail",
        action: `Create ${input.bucketName} in Supabase Storage and keep public access disabled.${setupHint}`,
      };
    }
    const bucket = data as typeof data & {
      file_size_limit?: number | null;
      allowed_mime_types?: string[] | null;
    };
    const allowedMimeTypes = new Set(bucket.allowed_mime_types ?? []);
    if (input.requiredMimeTypes?.some((mimeType) => !allowedMimeTypes.has(mimeType))) {
      return {
        id: input.id,
        label: input.label,
        status: "fail",
        action: `Allow every required backup MIME type in ${input.bucketName}, including application/pdf and application/octet-stream.`,
      };
    }
    if (
      input.minimumFileSizeBytes !== undefined &&
      bucket.file_size_limit !== null &&
      (!Number.isFinite(Number(bucket.file_size_limit)) || Number(bucket.file_size_limit) < input.minimumFileSizeBytes)
    ) {
      return {
        id: input.id,
        label: input.label,
        status: "fail",
        action: `Set ${input.bucketName} file_size_limit to at least ${input.minimumFileSizeBytes} bytes.`,
      };
    }
    if (input.requireNoBucketSizeLimit && bucket.file_size_limit !== null) {
      return {
        id: input.id,
        label: input.label,
        status: "fail",
        action: `Remove the bucket-level file_size_limit from ${input.bucketName}; growing SQLite snapshots must not hit a 100 MiB cap.`,
      };
    }
    if (input.probeReadWrite) {
      const canaryPrefix = `_readiness/${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
      const supportedCanaries = [
        { path: `${canaryPrefix}/probe.pdf`, bytes: Buffer.from("%PDF-readiness"), contentType: "application/pdf" },
        { path: `${canaryPrefix}/probe.sqlite`, bytes: Buffer.from("SQLite format 3\0readiness"), contentType: "application/octet-stream" },
        { path: `${canaryPrefix}/probe.jpg`, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg" },
      ];
      const requiredMimeTypes = new Set(input.requiredMimeTypes ?? []);
      const canaries = input.requiredMimeTypes
        ? supportedCanaries.filter((canary) =>
          requiredMimeTypes.has(canary.contentType))
        : supportedCanaries;
      if (canaries.length === 0) throw new Error("canary_mime_set_empty");
      const bucketClient = client.storage.from(input.bucketName);
      try {
        for (const canary of canaries) {
          const { error: uploadError } = await bucketClient.upload(
            canary.path,
            canary.bytes,
            { contentType: canary.contentType, upsert: false },
          );
          if (uploadError) throw uploadError;
        }
        const { data: listed, error: listError } = await bucketClient.list(canaryPrefix);
        if (listError || (listed?.length ?? 0) !== canaries.length) throw listError ?? new Error("canary_list_failed");
        for (const canary of canaries) {
          const { data: downloaded, error: downloadError } = await bucketClient.download(canary.path);
          if (downloadError || !downloaded) throw downloadError ?? new Error("canary_download_failed");
          const bytes = Buffer.from(await downloaded.arrayBuffer());
          if (!bytes.equals(canary.bytes)) throw new Error("canary_checksum_failed");
          const contentType = downloaded.type?.split(";", 1)[0]?.trim().toLowerCase();
          if (contentType && contentType !== canary.contentType) throw new Error("canary_mime_failed");
        }
      } finally {
        const canaryPaths = canaries.map((canary) => canary.path);
        let exactRemovalResult = false;
        try {
          const { data: removed, error: removeError } = await bucketClient.remove(canaryPaths);
          exactRemovalResult = !removeError
            && hasExactRemovedStoragePaths(removed, canaryPaths);
        } catch {
          exactRemovalResult = false;
        }

        let invocationPrefixEmpty = false;
        try {
          const { data: remaining, error: remainingError } = await bucketClient.list(
            canaryPrefix,
            {
              limit: canaries.length + 1,
              offset: 0,
              sortBy: { column: "name", order: "asc" },
            },
          );
          invocationPrefixEmpty = !remainingError
            && Array.isArray(remaining)
            && remaining.length === 0;
        } catch {
          invocationPrefixEmpty = false;
        }

        if (!exactRemovalResult || !invocationPrefixEmpty) {
          throw new Error("canary_cleanup_failed");
        }
      }
    }
    return {
      id: input.id,
      label: input.label,
      status: "pass",
      action: null,
    };
  } catch {
    return {
      id: input.id,
      label: input.label,
      status: "fail",
      action: `Confirm ${input.bucketName} exists, is private, and is reachable with the configured server secret key.`,
    };
  }
}

const accountDeletionRehearsalEnabled = isEnabled("ACCOUNT_DELETION_REHEARSAL_ENABLED");
const stagingIdentityBootstrap = getValue("PINTPATH_IDENTITY_REGISTRY_PHASE") === "staging-bootstrap";
const canonicalProductionRuntime = isCanonicalProductionRuntime({
  nodeEnv: process.env.NODE_ENV ?? "development",
  railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
});
const permanentStagingComplete = isProduction()
  && getValue("RAILWAY_ENVIRONMENT_NAME").toLowerCase() === "staging"
  && getValue("PINTPATH_IDENTITY_REGISTRY_PHASE") === "complete"
  && !accountDeletionRehearsalEnabled
  && !isEnabled("RESTORE_REHEARSAL_MODE");
let offsiteBackupBucketName = OPERATIONAL_OFFSITE_BACKUP_BUCKET;
let offsiteBackupBucketNameExact = true;
try {
  offsiteBackupBucketName = resolveExactOperationalOffsiteBackupBucket(
    process.env.OFFSITE_BACKUP_BUCKET,
  );
} catch {
  offsiteBackupBucketNameExact = false;
}
const offsiteBackupBucketNameCheck: ProviderCheck = {
  id: "OFFSITE_BACKUP_BUCKET_NAME",
  label: "Reviewed operational restore-copy bucket name",
  status: offsiteBackupBucketNameExact ? "pass" : isProduction() ? "fail" : "warn",
  action: offsiteBackupBucketNameExact
    ? null
    : "Set OFFSITE_BACKUP_BUCKET to the exact reviewed operational restore-copy bucket name; no configured value is emitted.",
};

async function runProviderStorageCanaries(input: {
  includeOperationalOffsite: boolean;
}): Promise<ProviderCheck[]> {
  assertOperatorMutationAllowed("Provider readiness storage write probe");
  const canaries = [
    checkPrivateStorageBucket({
      id: "SOURCE_EVIDENCE_BUCKET",
      label: "Private source-evidence bucket",
      bucketName: "beermap-source-evidence",
      urlEnvName: "SUPABASE_URL",
      keyEnvName: "SUPABASE_SERVICE_ROLE_KEY",
      requiredMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"],
      minimumFileSizeBytes: 8 * 1024 * 1024,
      probeReadWrite: true,
    }),
  ];
  if (input.includeOperationalOffsite) {
    canaries.push(checkPrivateStorageBucket({
      id: "OFFSITE_BACKUP_BUCKET",
      label: "Private operational restore-copy bucket",
      bucketName: offsiteBackupBucketName,
      urlEnvName: "OFFSITE_BACKUP_SUPABASE_URL",
      keyEnvName: "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      requiredMimeTypes: [
        "application/json", "application/octet-stream", "application/pdf",
        "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
      ],
      requireNoBucketSizeLimit: true,
      probeReadWrite: true,
      setupSqlPath: "ops/supabase/independent-backup-project-storage.sql",
    }));
  }
  return Promise.all(canaries);
}
const operationalRestoreCopyDestinationCheck: ProviderCheck = (() => {
  const source = getValue("SUPABASE_URL");
  const destination = getValue("OFFSITE_BACKUP_SUPABASE_URL");
  if (!source || !destination) {
    return {
      id: "OFFSITE_BACKUP_OPERATIONAL_COPY_DISTINCT",
      label: "Distinct private operational restore-copy destination",
      status: isProduction() ? "fail" : "warn",
      action: "Configure a private operational restore copy on an origin distinct from production; separately prove WORM disaster-recovery authority.",
    };
  }
  try {
    const distinct = new URL(source).origin.toLowerCase() !== new URL(destination).origin.toLowerCase();
    return {
      id: "OFFSITE_BACKUP_OPERATIONAL_COPY_DISTINCT",
      label: "Distinct private operational restore-copy destination",
      status: distinct ? "pass" : "fail",
      action: distinct
        ? null
        : "Move the operational restore copy to a different origin; production cannot be its own restore destination. This still does not prove WORM disaster recovery.",
    };
  } catch {
    return {
      id: "OFFSITE_BACKUP_OPERATIONAL_COPY_DISTINCT",
      label: "Distinct private operational restore-copy destination",
      status: "fail",
      action: "Set valid source and destination Supabase URLs.",
    };
  }
})();
const reportEmailMode = getValue("REPORT_EMAIL_MODE") || "disabled";
const reportScheduleEnabled = isEnabled("REPORT_DELIVERY_SCHEDULE_ENABLED");
const reportDeliveryEnabled = reportEmailMode === "resend" || reportScheduleEnabled;
const reportEmailModeCheck: ProviderCheck = {
  id: "REPORT_EMAIL_MODE",
  label: "Report email delivery mode",
  status: !["disabled", "mock", "resend"].includes(reportEmailMode)
    ? "fail"
    : isProduction() && reportEmailMode === "mock"
      ? "fail"
      : "pass",
  action: !["disabled", "mock", "resend"].includes(reportEmailMode)
    ? "Set REPORT_EMAIL_MODE to disabled or resend in production."
    : isProduction() && reportEmailMode === "mock"
      ? "Use REPORT_EMAIL_MODE=disabled or resend; mock delivery is test-only."
      : null,
  details: reportEmailMode === "disabled" ? "Report email delivery is intentionally disabled." : null,
};
const reportScheduleCheck: ProviderCheck = {
  id: "REPORT_DELIVERY_SCHEDULE_ENABLED",
  label: "Automatic monthly report schedule",
  status: reportScheduleEnabled && reportEmailMode !== "resend"
    ? "fail"
    : "pass",
  action: reportScheduleEnabled && reportEmailMode !== "resend"
    ? "Set REPORT_EMAIL_MODE=resend before enabling the automatic report schedule."
    : null,
  details: reportScheduleEnabled ? null : "Automatic report delivery is intentionally disabled.",
};
const resendApiKeyCheck: ProviderCheck = reportDeliveryEnabled
  ? checkRequired("RESEND_API_KEY", "Resend report-email API key", "Create a sending-only Resend API key and set RESEND_API_KEY.")
  : {
    id: "RESEND_API_KEY",
    label: "Resend report-email API key",
    status: "pass",
    action: null,
    details: "Not required while report email delivery is disabled.",
  };
const reportEmailFromCheck: ProviderCheck = reportDeliveryEnabled
  ? checkRequired("REPORT_EMAIL_FROM", "Verified report sender address", "Set REPORT_EMAIL_FROM to an address on the verified Resend sending domain.")
  : {
    id: "REPORT_EMAIL_FROM",
    label: "Verified report sender address",
    status: "pass",
    action: null,
    details: "Not required while report email delivery is disabled.",
  };
const reportTimezoneCheck: ProviderCheck = !reportDeliveryEnabled
  ? {
    id: "REPORT_TIMEZONE",
    label: "Monthly report timezone",
    status: "pass",
    action: null,
    details: "Not required while report email delivery is disabled.",
  }
  : {
    id: "REPORT_TIMEZONE",
    label: "Monthly report timezone",
    status: process.env.REPORT_TIMEZONE === "Australia/Melbourne" ? "pass" : "warn",
    action: process.env.REPORT_TIMEZONE === "Australia/Melbourne"
      ? null
      : "Set REPORT_TIMEZONE=Australia/Melbourne unless you intentionally change the reporting market.",
  };

const freeLaunchExpectedValues = {
  COMMERCIAL_LAUNCH_ENABLED: "false",
  CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
  VENUE_PRO_TRIAL_DAYS: "0",
  VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: "false",
  PINT_POINTS_REWARDS_ENABLED: "false",
  ALCOHOL_GAMIFICATION_ENABLED: "false",
  FIELD_TEST_MODE: "false",
  REPORT_EMAIL_MODE: "disabled",
  REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
  PINTPATH_REPORT_DELIVER: "false",
  DEMO_BILLING_MODE: "false",
  ALLOW_DEMO_BILLING_IN_PRODUCTION: "false",
  REQUIRE_REDIS_RATE_LIMITING: "true",
  ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION: "false",
} as const;

const freeLaunchScopeCheck: ProviderCheck = (() => {
  const mismatches = Object.entries(freeLaunchExpectedValues)
    .filter(([name, expected]) => getValue(name).toLowerCase() !== expected)
    .map(([name, expected]) => `${name}=${expected}`);
  return {
    id: "FREE_LAUNCH_SCOPE",
    label: "Frozen Free-launch feature scope",
    status: mismatches.length === 0 ? "pass" : isProduction() ? "fail" : "warn",
    action: mismatches.length === 0
      ? null
      : `Set the following explicit production values: ${mismatches.join(", ")}.`,
    details: mismatches.length === 0
      ? "Commercial enrolment, trials, rewards, gamification, reports, field-test mode, and demo billing are explicitly disabled; shared Redis rate limiting is required and in-memory fallback is disabled."
      : "The current production configuration is outside the frozen Free-launch scope.",
  };
})();

const freeLaunchDeferredCredentialsCheck: ProviderCheck = (() => {
  const names = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_MONTHLY",
    "STRIPE_PRICE_YEARLY",
    "STRIPE_PRO_PRICE_ID",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    "POS_WEBHOOK_SIGNING_SECRET",
    "RESEND_API_KEY",
    "REPORT_EMAIL_FROM",
    "REPORT_EMAIL_REPLY_TO",
  ];
  const configured = names.filter(hasValue);
  return {
    id: "FREE_LAUNCH_DEFERRED_CREDENTIALS_ABSENT",
    label: "Deferred commercial, POS, and report credentials absent",
    status: configured.length === 0 ? "pass" : isProduction() ? "fail" : "warn",
    action: configured.length === 0
      ? null
      : "Remove all Stripe, POS, and venue-report credentials from the production service for the frozen Free launch.",
    details: configured.length === 0
      ? "No deferred credentials are configured."
      : `Remove before production: ${configured.join(", ")}.`,
  };
})();

const [
  productionPostgresCheck,
  productionPostgresMaintenanceCheck,
  productionPostgresRootCaCheck,
] = postgresRuntimeAuthorityChecks({
  applicationId: "PRODUCTION_POSTGRES_DATABASE_URL",
  maintenanceId: "PRODUCTION_POSTGRES_MAINTENANCE_URL",
  rootCaId: "PRODUCTION_POSTGRES_ROOT_CA",
  labelPrefix: "Production",
});

const productionDatabaseIdentityCheck = checkPinnedConnectionIdentity({
  urlName: "DATABASE_URL",
  expectedDigestName: "PINTPATH_EXPECTED_DATABASE_URL_SHA256",
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
  id: "PRODUCTION_DATABASE_IDENTITY",
  label: "Reviewed production database identity",
  action: "Hash the exact live production DATABASE_URL into PINTPATH_EXPECTED_DATABASE_URL_SHA256 and register permanent-staging/restore digests in PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S; never print or duplicate the URL.",
  requiredForbiddenDigestName: "PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256",
});

const productionDatabaseResourceCheck = checkPinnedResourceIdentity({
  actualName: "PINTPATH_DATABASE_RESOURCE_ID",
  expectedName: "PINTPATH_EXPECTED_DATABASE_RESOURCE_ID",
  forbiddenName: "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
  id: "PRODUCTION_DATABASE_RESOURCE_IDENTITY",
  label: "Reviewed production database provider resource",
  action: "Bind PINTPATH_DATABASE_RESOURCE_ID from the live database service, match its protected production pin, and register distinct permanent-staging and restore resource IDs as forbidden.",
  requiredForbiddenResourceName: "PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID",
});

const productionRedisIdentityCheck = checkPinnedConnectionIdentity({
  urlName: "REDIS_URL",
  expectedDigestName: "PINTPATH_EXPECTED_REDIS_URL_SHA256",
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
  id: "PRODUCTION_REDIS_IDENTITY",
  label: "Reviewed production Redis identity",
  action: "Hash the exact live production REDIS_URL into PINTPATH_EXPECTED_REDIS_URL_SHA256 and register permanent-staging/restore digests in PINTPATH_FORBIDDEN_REDIS_URL_SHA256S; never print or duplicate the URL.",
  requiredForbiddenDigestName: "PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256",
});

const productionRedisResourceCheck = checkPinnedResourceIdentity({
  actualName: "PINTPATH_REDIS_RESOURCE_ID",
  expectedName: "PINTPATH_EXPECTED_REDIS_RESOURCE_ID",
  forbiddenName: "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
  id: "PRODUCTION_REDIS_RESOURCE_IDENTITY",
  label: "Reviewed production Redis provider resource",
  action: "Bind PINTPATH_REDIS_RESOURCE_ID from the live Redis service, match its protected production pin, and register distinct permanent-staging and restore resource IDs as forbidden.",
  requiredForbiddenResourceName: "PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID",
});

const [
  permanentStagingPostgresCheck,
  permanentStagingPostgresMaintenanceCheck,
  permanentStagingPostgresRootCaCheck,
] = postgresRuntimeAuthorityChecks({
  applicationId: "PERMANENT_STAGING_POSTGRES_DATABASE_URL",
  maintenanceId: "PERMANENT_STAGING_POSTGRES_MAINTENANCE_URL",
  rootCaId: "PERMANENT_STAGING_POSTGRES_ROOT_CA",
  labelPrefix: "Permanent-staging",
});

const permanentStagingDatabaseIdentityCheck = checkPinnedConnectionIdentity({
  urlName: "DATABASE_URL",
  expectedDigestName: "PINTPATH_EXPECTED_DATABASE_URL_SHA256",
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
  id: "PERMANENT_STAGING_DATABASE_IDENTITY",
  label: "Reviewed permanent-staging database identity",
  action: "Match the exact staging DATABASE_URL digest to its expected and named staging pins, and register the distinct production and restore digests as forbidden siblings.",
});

const permanentStagingDatabaseResourceCheck = checkPinnedResourceIdentity({
  actualName: "PINTPATH_DATABASE_RESOURCE_ID",
  expectedName: "PINTPATH_EXPECTED_DATABASE_RESOURCE_ID",
  forbiddenName: "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
  id: "PERMANENT_STAGING_DATABASE_RESOURCE_IDENTITY",
  label: "Reviewed permanent-staging database provider resource",
  action: "Match the live staging database service instance to its expected and named staging pins, and register distinct production and restore resources as forbidden siblings.",
});

const permanentStagingRedisIdentityCheck = checkPinnedConnectionIdentity({
  urlName: "REDIS_URL",
  expectedDigestName: "PINTPATH_EXPECTED_REDIS_URL_SHA256",
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
  id: "PERMANENT_STAGING_REDIS_IDENTITY",
  label: "Reviewed permanent-staging Redis identity",
  action: "Match the exact staging REDIS_URL digest to its expected and named staging pins, and register the distinct production and restore digests as forbidden siblings.",
});

const permanentStagingRedisResourceCheck = checkPinnedResourceIdentity({
  actualName: "PINTPATH_REDIS_RESOURCE_ID",
  expectedName: "PINTPATH_EXPECTED_REDIS_RESOURCE_ID",
  forbiddenName: "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
  id: "PERMANENT_STAGING_REDIS_RESOURCE_IDENTITY",
  label: "Reviewed permanent-staging Redis provider resource",
  action: "Match the live staging Redis service instance to its expected and named staging pins, and register distinct production and restore resources as forbidden siblings.",
});

// This executes the credential-free runtime-selection and fail-closed legacy
// contract. The protected release workflow also runs the injected orchestration
// tests that prove the SQLite loader is never called on the production path.
const postgresRuntimeImplementation =
  inspectPostgresRuntimeImplementationContract();
const postgresRuntimeImplementationCheck: ProviderCheck = {
  id: "POSTGRES_RUNTIME_IMPLEMENTATION",
  label: "Shared Postgres application runtime implemented",
  status: postgresRuntimeImplementation.ready ? "pass" : "fail",
  action: postgresRuntimeImplementation.ready
    ? null
    : "Restore the production-only PostgreSQL selector, explicit restore-only SQLite branch, and fail-closed legacy repository contract before release.",
  details: postgresRuntimeImplementation.ready
    ? "The executable selector chooses PostgreSQL for every production non-restore runtime even before credentials are read, reserves SQLite for development/test or attested restore, and the legacy repository rejects access."
    : "The executable runtime-selection contract is incomplete; no environment override can mark it implemented.",
};

const stagingBootstrapDatabaseIdentityCheck = checkPinnedConnectionIdentity({
  urlName: "DATABASE_URL",
  expectedDigestName: "PINTPATH_EXPECTED_DATABASE_URL_SHA256",
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
  id: "PERMANENT_STAGING_BOOTSTRAP_DATABASE_IDENTITY",
  label: "Permanent-staging bootstrap database self identity",
  action: "Bind the exact staging DATABASE_URL digest to its expected and named permanent-staging pin; leave sibling lists absent until real sibling resources exist.",
  minimumForbidden: 0,
  requireForbiddenAbsent: true,
});

const stagingBootstrapDatabaseResourceCheck = checkPinnedResourceIdentity({
  actualName: "PINTPATH_DATABASE_RESOURCE_ID",
  expectedName: "PINTPATH_EXPECTED_DATABASE_RESOURCE_ID",
  forbiddenName: "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
  id: "PERMANENT_STAGING_BOOTSTRAP_DATABASE_RESOURCE",
  label: "Permanent-staging bootstrap database service instance",
  action: "Bind the live staging database service-instance ID to its exact expected and named staging pin; leave sibling lists absent.",
  minimumForbidden: 0,
  requireForbiddenAbsent: true,
});

const stagingBootstrapRedisIdentityCheck = checkPinnedConnectionIdentity({
  urlName: "REDIS_URL",
  expectedDigestName: "PINTPATH_EXPECTED_REDIS_URL_SHA256",
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
  id: "PERMANENT_STAGING_BOOTSTRAP_REDIS_IDENTITY",
  label: "Permanent-staging bootstrap Redis self identity",
  action: "Bind the exact staging REDIS_URL digest to its expected and named permanent-staging pin; leave sibling lists absent until real sibling resources exist.",
  minimumForbidden: 0,
  requireForbiddenAbsent: true,
});

const stagingBootstrapRedisResourceCheck = checkPinnedResourceIdentity({
  actualName: "PINTPATH_REDIS_RESOURCE_ID",
  expectedName: "PINTPATH_EXPECTED_REDIS_RESOURCE_ID",
  forbiddenName: "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
  id: "PERMANENT_STAGING_BOOTSTRAP_REDIS_RESOURCE",
  label: "Permanent-staging bootstrap Redis service instance",
  action: "Bind the live staging Redis service-instance ID to its exact expected and named staging pin; leave sibling lists absent.",
  minimumForbidden: 0,
  requireForbiddenAbsent: true,
});

const stagingBootstrapInertScopeCheck: ProviderCheck = (() => {
  const unsafe = [
    isEnabled("COMMERCIAL_LAUNCH_ENABLED") ? "COMMERCIAL_LAUNCH_ENABLED" : null,
    isEnabled("CONSUMER_PAID_ENROLLMENT_ENABLED") ? "CONSUMER_PAID_ENROLLMENT_ENABLED" : null,
    isEnabled("DEMO_BILLING_MODE") ? "DEMO_BILLING_MODE" : null,
    isEnabled("PINT_POINTS_REWARDS_ENABLED") ? "PINT_POINTS_REWARDS_ENABLED" : null,
    isEnabled("ALCOHOL_GAMIFICATION_ENABLED") ? "ALCOHOL_GAMIFICATION_ENABLED" : null,
    getValue("REPORT_EMAIL_MODE") !== "disabled" ? "REPORT_EMAIL_MODE" : null,
    isEnabled("REPORT_DELIVERY_SCHEDULE_ENABLED") ? "REPORT_DELIVERY_SCHEDULE_ENABLED" : null,
    getValue("ACCOUNT_DELETION_NOTICE_MODE") !== "disabled" ? "ACCOUNT_DELETION_NOTICE_MODE" : null,
    isEnabled("MENU_DISCOVERY_QUEUE_OCR") ? "MENU_DISCOVERY_QUEUE_OCR" : null,
    isEnabled("ALLOW_MENU_DISCOVERY_QUEUE") ? "ALLOW_MENU_DISCOVERY_QUEUE" : null,
    isEnabled("PINTPATH_REPORT_DELIVER") ? "PINTPATH_REPORT_DELIVER" : null,
  ].filter((name): name is string => name !== null);
  return {
    id: "PERMANENT_STAGING_BOOTSTRAP_INERT_SCOPE",
    label: "Operator-only staging bootstrap scope",
    status: unsafe.length === 0 ? "pass" : "fail",
    action: unsafe.length === 0
      ? null
      : "Disable every commercial, report, notification, discovery, and scheduled/provider-write feature during identity bootstrap.",
    details: unsafe.length === 0 ? "Normal application routes and workers remain forbidden by the server startup guard." : null,
  };
})();

const stagingBootstrapChecks: ProviderCheck[] = [
  postgresRuntimeImplementationCheck,
  checkPermanentStagingRailwayIdentity(),
  permanentStagingPostgresCheck,
  permanentStagingPostgresMaintenanceCheck,
  permanentStagingPostgresRootCaCheck,
  stagingBootstrapDatabaseIdentityCheck,
  stagingBootstrapDatabaseResourceCheck,
  checkRequired("REDIS_URL", "Permanent-staging bootstrap Redis", "Configure the isolated staging Redis URL."),
  stagingBootstrapRedisIdentityCheck,
  stagingBootstrapRedisResourceCheck,
  {
    id: "PERMANENT_STAGING_BOOTSTRAP_REDIS_FAIL_CLOSED",
    label: "Shared fail-closed staging Redis",
    status: hasValue("REDIS_URL")
      && isEnabled("REQUIRE_REDIS_RATE_LIMITING")
      && !isEnabled("ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION")
      ? "pass"
      : "fail",
    action: hasValue("REDIS_URL")
      && isEnabled("REQUIRE_REDIS_RATE_LIMITING")
      && !isEnabled("ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION")
      ? null
      : "Use the reviewed Railway mutation-boundary executor to configure shared staging Redis, require it, and keep the in-memory production fallback disabled.",
  },
  checkPermanentStagingServiceInstances(),
  checkPermanentStagingSelfPins(),
  checkAbsent(
    [
      "OFFSITE_BACKUP_SUPABASE_URL",
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      "OFFSITE_BACKUP_BUCKET",
    ],
    "PERMANENT_STAGING_OFFSITE_CREDENTIALS_ABSENT",
    "No production operational-backup authority in permanent staging",
    "Remove OFFSITE_BACKUP_SUPABASE_URL, OFFSITE_BACKUP_SERVICE_ROLE_KEY, and OFFSITE_BACKUP_BUCKET before continuing staging bootstrap.",
  ),
  checkRequiredStrongSecret(
    "SOURCE_EVIDENCE_SIGNING_SECRET",
    "Unique staging source-evidence signing secret",
    "Set a unique staging-only high-entropy signing secret of at least 32 bytes.",
  ),
  stagingBootstrapInertScopeCheck,
  {
    id: "PERMANENT_STAGING_BOOTSTRAP_NOT_CUTOVER_READY",
    label: "Staging bootstrap is not launch-ready",
    status: "fail",
    action: "Use the reviewed Railway mutation-boundary executor to provision and register real production and restore database/Redis identities, set PINTPATH_IDENTITY_REGISTRY_PHASE=complete, deploy the exact reviewed image, and run the full provider gate before any app server starts.",
    details: "This operator-only profile performs no Supabase/Storage canary and can never satisfy launch readiness.",
  },
];

const permanentStagingCompleteScopeCheck: ProviderCheck = (() => {
  const unsafe = [
    isEnabled("RESTORE_REHEARSAL_MODE") ? "RESTORE_REHEARSAL_MODE" : null,
    isEnabled("COMMERCIAL_LAUNCH_ENABLED") ? "COMMERCIAL_LAUNCH_ENABLED" : null,
    isEnabled("CONSUMER_PAID_ENROLLMENT_ENABLED") ? "CONSUMER_PAID_ENROLLMENT_ENABLED" : null,
    isEnabled("DEMO_BILLING_MODE") ? "DEMO_BILLING_MODE" : null,
    isEnabled("PINT_POINTS_REWARDS_ENABLED") ? "PINT_POINTS_REWARDS_ENABLED" : null,
    isEnabled("ALCOHOL_GAMIFICATION_ENABLED") ? "ALCOHOL_GAMIFICATION_ENABLED" : null,
    getValue("REPORT_EMAIL_MODE") !== "disabled" ? "REPORT_EMAIL_MODE" : null,
    isEnabled("REPORT_DELIVERY_SCHEDULE_ENABLED") ? "REPORT_DELIVERY_SCHEDULE_ENABLED" : null,
    getValue("ACCOUNT_DELETION_NOTICE_MODE") !== "disabled" ? "ACCOUNT_DELETION_NOTICE_MODE" : null,
    isEnabled("PINTPATH_REPORT_DELIVER") ? "PINTPATH_REPORT_DELIVER" : null,
    isEnabled("ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION") ? "ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION" : null,
  ].filter((name): name is string => name !== null);
  return {
    id: "PERMANENT_STAGING_COMPLETE_SCOPE",
    label: "Permanent-staging Free integration scope",
    status: unsafe.length === 0 ? "pass" : "fail",
    action: unsafe.length === 0
      ? null
      : "Disable restore, commercial, report-delivery, deletion-notice, reward, gamification, demo billing, and inline-image modes in ordinary permanent staging.",
    details: unsafe.length === 0
      ? "Ordinary permanent staging is launchable for the frozen Free integration scope; notification and destructive restore proofs use their dedicated profiles."
      : `Unsafe: ${unsafe.join(", ")}.`,
  };
})();

const permanentStagingRedisFailClosedCheck: ProviderCheck = {
  id: "PERMANENT_STAGING_REDIS_FAIL_CLOSED",
  label: "Shared fail-closed permanent-staging Redis",
  status: hasValue("REDIS_URL")
    && isEnabled("REQUIRE_REDIS_RATE_LIMITING")
    && !isEnabled("ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION")
    ? "pass"
    : "fail",
  action: hasValue("REDIS_URL")
    && isEnabled("REQUIRE_REDIS_RATE_LIMITING")
    && !isEnabled("ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION")
    ? null
    : "Configure shared permanent-staging Redis, require it, and keep the in-memory production fallback disabled.",
};

const permanentStagingCompleteChecks: ProviderCheck[] = [
  postgresRuntimeImplementationCheck,
  {
    id: "PINTPATH_IDENTITY_REGISTRY_PHASE",
    label: "Complete cross-environment identity registry",
    status: getValue("PINTPATH_IDENTITY_REGISTRY_PHASE") === "complete" ? "pass" : "fail",
    action: getValue("PINTPATH_IDENTITY_REGISTRY_PHASE") === "complete"
      ? null
      : "Register the real production and restore database/Redis siblings before ordinary permanent staging starts.",
  },
  checkPermanentStagingRailwayIdentity(),
  permanentStagingPostgresCheck,
  permanentStagingPostgresMaintenanceCheck,
  permanentStagingPostgresRootCaCheck,
  permanentStagingDatabaseIdentityCheck,
  permanentStagingDatabaseResourceCheck,
  checkRequired("REDIS_URL", "Permanent-staging Redis", "Configure the isolated permanent-staging Redis URL."),
  permanentStagingRedisIdentityCheck,
  permanentStagingRedisResourceCheck,
  permanentStagingRedisFailClosedCheck,
  checkPermanentStagingServiceInstances(),
  checkPermanentStagingSelfPins(),
  checkRequired("GOOGLE_MAPS_API_KEY", "Staging Google Maps browser API key", "Set the staging-origin-restricted Google Maps browser key."),
  checkRequired("GOOGLE_MAPS_MAP_ID", "Staging Google Maps vector map ID", "Set the staging JavaScript vector Map ID."),
  checkRequired("GOOGLE_PLACES_API_KEY", "Staging Google Places server API key", "Set the staging-only server Places key."),
  checkRequired("OPENAI_API_KEY", "Staging OpenAI menu OCR key", "Set the staging-only menu OCR key."),
  checkExactSupabaseOrigin("SUPABASE_URL", PERMANENT_STAGING_SUPABASE_ORIGIN, "Permanent-staging Supabase project URL", "Set the exact reviewed permanent-staging Supabase origin."),
  checkSupabaseKeyFormat("SUPABASE_ANON_KEY", "publishable", "Permanent-staging Supabase publishable key", "Set the staging project's exact sb_publishable_ key."),
  checkSupabaseKeyFormat("SUPABASE_SERVICE_ROLE_KEY", "secret", "Permanent-staging Supabase secret key", "Set the staging project's exact server-only sb_secret_ key."),
  checkSupabaseOauthLaunchProviders(),
  checkSupabaseProviderCallbackUrl(),
  checkAbsent(
    [
      "OFFSITE_BACKUP_SUPABASE_URL",
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      "OFFSITE_BACKUP_BUCKET",
    ],
    "PERMANENT_STAGING_OFFSITE_CREDENTIALS_ABSENT",
    "No production operational-backup authority in permanent staging",
    "Remove OFFSITE_BACKUP_SUPABASE_URL, OFFSITE_BACKUP_SERVICE_ROLE_KEY, and OFFSITE_BACKUP_BUCKET. Register a separate isolated staging destination before adding an off-site proof.",
  ),
  checkRequiredStrongSecret(
    "SOURCE_EVIDENCE_SIGNING_SECRET",
    "Unique permanent-staging source-evidence signing secret",
    "Set a unique staging-only high-entropy signing secret of at least 32 bytes.",
  ),
  checkRequired("ADMIN_EMAILS", "Permanent-staging admin allowlist", "Set the verified staging admin allowlist for role and MFA smoke tests."),
  {
    id: "REQUIRE_ADMIN_MFA_IN_PRODUCTION",
    label: "Admin MFA enforced in permanent staging",
    status: getValue("REQUIRE_ADMIN_MFA_IN_PRODUCTION") === "true" ? "pass" : "fail",
    action: getValue("REQUIRE_ADMIN_MFA_IN_PRODUCTION") === "true"
      ? null
      : "Enroll and prove a staging admin TOTP factor, then require admin MFA in permanent staging.",
  },
  permanentStagingCompleteScopeCheck,
];

const paidEnrollmentEnabled = isEnabled("COMMERCIAL_LAUNCH_ENABLED")
  || isEnabled("CONSUMER_PAID_ENROLLMENT_ENABLED");
const stripeRequirements = [
  ["STRIPE_SECRET_KEY", "Stripe secret key", "Use Stripe test mode first; set STRIPE_SECRET_KEY before paid checkout."],
  ["STRIPE_WEBHOOK_SECRET", "Stripe webhook secret", "Forward signed Stripe CLI/webhook events and set STRIPE_WEBHOOK_SECRET."],
  ["STRIPE_PRICE_MONTHLY", "Stripe paid user monthly price ID", "Create the user monthly recurring price and set STRIPE_PRICE_MONTHLY."],
  ["STRIPE_PRICE_YEARLY", "Stripe paid user yearly price ID", "Create the user yearly recurring price and set STRIPE_PRICE_YEARLY."],
  ["STRIPE_PRO_PRICE_ID", "Stripe Pro venue price ID", "Create the Pro recurring price and set STRIPE_PRO_PRICE_ID."],
] as const;
const stripeChecks: ProviderCheck[] = stripeRequirements.map(([id, label, action]) =>
  paidEnrollmentEnabled
    ? checkRequired(id, label, action)
    : {
      id,
      label,
      status: "pass",
      action: null,
      details: "Not required while commercial and consumer paid enrollment are both disabled.",
    },
);
const stripeModeCheck: ProviderCheck = paidEnrollmentEnabled
  ? checkNoTestKeyInProduction("STRIPE_SECRET_KEY", "Stripe secret key is live-mode in production", "sk_test_")
  : {
    id: "STRIPE_SECRET_KEY_MODE",
    label: "Stripe secret key is live-mode in production",
    status: "pass",
    action: null,
    details: "Not required while paid enrollment is deferred.",
  };
const posWebhookSigningCheck = checkOptionalStrongSecret(
  "POS_WEBHOOK_SIGNING_SECRET",
  "POS webhook signing secret",
  "Replace POS_WEBHOOK_SIGNING_SECRET with a unique high-entropy secret of at least 32 bytes, or remove it to keep POS webhooks disabled.",
);
const deletionNoticeMode = getValue("ACCOUNT_DELETION_NOTICE_MODE") || "disabled";
const deletionNoticeModeCheck: ProviderCheck = {
  id: "ACCOUNT_DELETION_NOTICE_MODE",
  label: "Account deletion completion notices",
  status: !["disabled", "mock", "resend"].includes(deletionNoticeMode)
    ? "fail"
    : isProduction() && deletionNoticeMode !== "resend"
      ? "fail"
      : "pass",
  action: isProduction() && deletionNoticeMode !== "resend"
    ? "Set ACCOUNT_DELETION_NOTICE_MODE=resend after configuring the encrypted outbox, transactional sender, and signed webhook."
    : null,
};
const deletionNoticeKeyringCheck: ProviderCheck = (() => {
  const activeKeyId = getValue("ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID");
  const keyringJson = getValue("ACCOUNT_DELETION_NOTICE_KEYRING_JSON");
  if (!activeKeyId || !keyringJson) {
    return {
      id: "ACCOUNT_DELETION_NOTICE_KEYRING",
      label: "Encrypted deletion-notice recipient keyring",
      status: isProduction() ? "fail" : "warn",
      action: "Generate a 32-byte base64 key and set ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID plus ACCOUNT_DELETION_NOTICE_KEYRING_JSON.",
    };
  }
  try {
    parseAccountDeletionNotificationKeyring({ activeKeyId, keyringJson });
    return {
      id: "ACCOUNT_DELETION_NOTICE_KEYRING",
      label: "Encrypted deletion-notice recipient keyring",
      status: "pass",
      action: null,
    };
  } catch {
    return {
      id: "ACCOUNT_DELETION_NOTICE_KEYRING",
      label: "Encrypted deletion-notice recipient keyring",
      status: "fail",
      action: "Replace the keyring with valid JSON containing the active key ID and an exactly 32-byte base64 key.",
    };
  }
})();

const launchPreflightChecks: ProviderCheck[] = [
  checkRequired("GOOGLE_MAPS_API_KEY", "Google Maps browser API key", "Create/restrict a browser key and set GOOGLE_MAPS_API_KEY."),
  checkRequired("GOOGLE_MAPS_MAP_ID", "Google Maps JavaScript vector map ID", "Create a JavaScript Map ID in Google Maps Platform and set GOOGLE_MAPS_MAP_ID."),
  checkRequired("GOOGLE_PLACES_API_KEY", "Google Places server API key", "Use the reviewed Railway mutation-boundary executor to set GOOGLE_PLACES_API_KEY on the app service for admin venue lookup and future request flows."),
  checkRequired("OPENAI_API_KEY", "OpenAI menu OCR key", "Use the reviewed Railway mutation-boundary executor to set OPENAI_API_KEY and deploy the exact reviewed image so menu photo OCR can initialise."),
  checkExactSupabaseOrigin("SUPABASE_URL", PRODUCTION_SUPABASE_ORIGIN, "Supabase project URL", "Set SUPABASE_URL to the exact reviewed production Supabase origin."),
  checkSupabaseKeyFormat("SUPABASE_ANON_KEY", "publishable", "Supabase publishable key", "Set SUPABASE_ANON_KEY to the project's exact browser-safe sb_publishable_ key."),
  checkSupabaseKeyFormat("SUPABASE_SERVICE_ROLE_KEY", "secret", "Supabase server secret key", "Set SUPABASE_SERVICE_ROLE_KEY to the project's exact server-only sb_secret_ key for private source-evidence capture history."),
  checkSupabaseOauthLaunchProviders(),
  checkExactSupabaseOrigin("OFFSITE_BACKUP_SUPABASE_URL", OPERATIONAL_OFFSITE_SUPABASE_ORIGIN, "Private operational restore-copy URL", "Set OFFSITE_BACKUP_SUPABASE_URL to the exact reviewed operational-copy Supabase origin; separately prove WORM authority."),
  checkSupabaseKeyFormat("OFFSITE_BACKUP_SERVICE_ROLE_KEY", "secret", "Operational restore-copy secret key", "Set OFFSITE_BACKUP_SERVICE_ROLE_KEY to the operational-copy project's exact sb_secret_ key; it is not the WORM recovery credential."),
  offsiteBackupBucketNameCheck,
  checkDistinctSupabaseSecretKeys(),
  operationalRestoreCopyDestinationCheck,
  checkSupabaseProviderCallbackUrl(),
  productionPostgresCheck,
  productionPostgresMaintenanceCheck,
  productionPostgresRootCaCheck,
  productionDatabaseIdentityCheck,
  productionDatabaseResourceCheck,
  postgresRuntimeImplementationCheck,
  checkRequired("REDIS_URL", "Redis-backed rate limiter", "Provision the reviewed Redis authority, then use the Railway mutation-boundary executor to set REDIS_URL before broad production."),
  productionRedisIdentityCheck,
  productionRedisResourceCheck,
  checkRequired("SOURCE_EVIDENCE_SIGNING_SECRET", "Source evidence signing secret", "Generate a unique 32+ character secret for signed evidence URLs."),
  freeLaunchScopeCheck,
  freeLaunchDeferredCredentialsCheck,
  ...stripeChecks,
  posWebhookSigningCheck,
  stripeModeCheck,
  checkRequired("ADMIN_EMAILS", "Production admin allowlist", "Set ADMIN_EMAILS to the verified owner/admin email before enabling admin access."),
  {
    id: "REQUIRE_ADMIN_MFA_IN_PRODUCTION",
    label: "Admin MFA enforced in production",
    status: isProduction() && process.env.REQUIRE_ADMIN_MFA_IN_PRODUCTION !== "true" ? "fail" : "pass",
    action: isProduction() && process.env.REQUIRE_ADMIN_MFA_IN_PRODUCTION !== "true"
      ? "Enroll the admin TOTP factor, verify an AAL2 login, then set REQUIRE_ADMIN_MFA_IN_PRODUCTION=true."
      : null,
  },
  {
    id: "FIELD_TEST_MODE",
    label: "Field-test mode disabled for full launch",
    status: isProduction() && process.env.FIELD_TEST_MODE === "true" ? "warn" : "pass",
    action: isProduction() && process.env.FIELD_TEST_MODE === "true"
      ? "Set FIELD_TEST_MODE=false after the final pilot smoke test."
      : null,
  },
  reportTimezoneCheck,
  reportEmailModeCheck,
  reportScheduleCheck,
  resendApiKeyCheck,
  reportEmailFromCheck,
  deletionNoticeModeCheck,
  deletionNoticeKeyringCheck,
  checkRequired(
    "RESEND_TRANSACTIONAL_API_KEY",
    "Resend transactional deletion-notice key",
    "Create a sending-only Resend key dedicated to transactional account deletion notices.",
  ),
  checkRequired(
    "ACCOUNT_DELETION_NOTICE_FROM",
    "Verified account deletion sender",
    "Set ACCOUNT_DELETION_NOTICE_FROM to an address on the verified Resend sending domain.",
  ),
  checkRequired(
    "ACCOUNT_DELETION_NOTICE_REPLY_TO",
    "Monitored account deletion reply-to",
    "Set ACCOUNT_DELETION_NOTICE_REPLY_TO to the monitored privacy/support inbox.",
  ),
  {
    id: "RESEND_WEBHOOK_SIGNING_SECRET",
    label: "Signed Resend delivery webhook",
    status: !isProduction() || hasValidResendWebhookSecret()
      ? "pass"
      : "fail",
    action: !isProduction() || hasValidResendWebhookSecret()
      ? null
      : "Create a Resend webhook for the production endpoint and set its whsec_ signing secret.",
  },
  {
    id: "DEMO_BILLING_MODE",
    label: "Demo billing disabled for production",
    status: isProduction() && process.env.DEMO_BILLING_MODE === "true" && process.env.ALLOW_DEMO_BILLING_IN_PRODUCTION !== "true"
      ? "fail"
      : "pass",
    action: isProduction() && process.env.DEMO_BILLING_MODE === "true" && process.env.ALLOW_DEMO_BILLING_IN_PRODUCTION !== "true"
      ? "Set DEMO_BILLING_MODE=false; the frozen Free production profile does not permit simulated billing or a production override."
      : null,
  },
  {
    id: "ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION",
    label: "Inline demo image storage disabled for production",
    status: isProduction() && process.env.ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION === "true" ? "fail" : "pass",
    action: isProduction() && process.env.ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION === "true"
      ? "Set ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false and use the private Supabase evidence bucket for field uploads."
      : null,
  },
];

const deletionRehearsalRailwayIdentityCheck: ProviderCheck = {
  id: "ACCOUNT_DELETION_REHEARSAL_RAILWAY_IDENTITY",
  label: "Reviewed permanent-staging Railway identity",
  status: isProduction()
      && getValue("RAILWAY_ENVIRONMENT_NAME").toLowerCase() === "staging"
      && hasValue("ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID")
      && hasValue("ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID")
      && hasValue("ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID")
      && getValue("RAILWAY_PROJECT_ID") === getValue("ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID")
      && getValue("RAILWAY_ENVIRONMENT_ID") === getValue("ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID")
      && getValue("RAILWAY_SERVICE_ID") === getValue("ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID")
    ? "pass"
    : "fail",
  action: "Load the reviewed permanent-staging Railway pins and run this profile only where every runtime identity matches them.",
};
if (deletionRehearsalRailwayIdentityCheck.status === "pass") {
  deletionRehearsalRailwayIdentityCheck.action = null;
}

const deletionRehearsalPublicOriginCheck: ProviderCheck = (() => {
  const railwayDomain = getValue("RAILWAY_PUBLIC_DOMAIN").toLowerCase();
  try {
    const publicBaseUrl = new URL(getValue("PUBLIC_BASE_URL"));
    const productionHostname = [
      "pintpath.au",
      "www.pintpath.au",
      "pintpath.com.au",
      "www.pintpath.com.au",
    ].includes(publicBaseUrl.hostname.toLowerCase());
    const matches = Boolean(railwayDomain)
      && publicBaseUrl.protocol === "https:"
      && publicBaseUrl.origin.toLowerCase() === `https://${railwayDomain}`
      && publicBaseUrl.pathname === "/"
      && !publicBaseUrl.search
      && !publicBaseUrl.hash
      && !publicBaseUrl.username
      && !publicBaseUrl.password
      && !productionHostname;
    return {
      id: "ACCOUNT_DELETION_REHEARSAL_PUBLIC_ORIGIN",
      label: "Isolated account-deletion rehearsal public origin",
      status: matches ? "pass" : "fail",
      action: matches
        ? null
        : "Set PUBLIC_BASE_URL to the exact non-production HTTPS origin derived from RAILWAY_PUBLIC_DOMAIN.",
    };
  } catch {
    return {
      id: "ACCOUNT_DELETION_REHEARSAL_PUBLIC_ORIGIN",
      label: "Isolated account-deletion rehearsal public origin",
      status: "fail",
      action: "Set PUBLIC_BASE_URL to the exact non-production HTTPS origin derived from RAILWAY_PUBLIC_DOMAIN.",
    };
  }
})();

const [
  deletionRehearsalDatabaseCheck,
  deletionRehearsalMaintenanceDatabaseCheck,
  deletionRehearsalPostgresRootCaCheck,
] = postgresRuntimeAuthorityChecks({
  applicationId: "ACCOUNT_DELETION_REHEARSAL_DATABASE",
  maintenanceId: "ACCOUNT_DELETION_REHEARSAL_MAINTENANCE_DATABASE",
  rootCaId: "ACCOUNT_DELETION_REHEARSAL_POSTGRES_ROOT_CA",
  labelPrefix: "Account-deletion rehearsal",
});

const deletionRehearsalDatabaseIdentityCheck = checkPinnedConnectionIdentity({
  urlName: "DATABASE_URL",
  expectedDigestName: "PINTPATH_EXPECTED_DATABASE_URL_SHA256",
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
  id: "ACCOUNT_DELETION_REHEARSAL_DATABASE_IDENTITY",
  label: "Reviewed permanent-staging database identity",
  action: "Load the exact permanent-staging DATABASE_URL digest as the expected pin and production/restore digests as forbidden identities before any destructive deletion proof.",
});

const deletionRehearsalDatabaseResourceCheck = checkPinnedResourceIdentity({
  actualName: "PINTPATH_DATABASE_RESOURCE_ID",
  expectedName: "PINTPATH_EXPECTED_DATABASE_RESOURCE_ID",
  forbiddenName: "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
  id: "ACCOUNT_DELETION_REHEARSAL_DATABASE_RESOURCE_IDENTITY",
  label: "Reviewed permanent-staging database provider resource",
  action: "Bind the live staging database resource ID, match its protected staging pin, and register production plus restore database resource IDs as forbidden before deletion.",
});

const deletionRehearsalSupabaseIdentityCheck: ProviderCheck = (() => {
  try {
    const url = new URL(getValue("SUPABASE_URL"));
    const expected = new URL(getValue("ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL"));
    const production = new URL(getValue("ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL"));
    const exact = url.origin.toLowerCase() === expected.origin.toLowerCase()
      && url.origin.toLowerCase() !== production.origin.toLowerCase()
      && url.protocol === "https:"
      && url.pathname === "/"
      && !url.port
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
    return {
      id: "ACCOUNT_DELETION_REHEARSAL_SUPABASE_IDENTITY",
      label: "Dedicated account-deletion rehearsal Supabase project",
      status: exact ? "pass" : "fail",
      action: exact ? null : "Bind SUPABASE_URL to the reviewed permanent-staging pin and prove it differs from the registered production Supabase origin.",
    };
  } catch {
    return {
      id: "ACCOUNT_DELETION_REHEARSAL_SUPABASE_IDENTITY",
      label: "Dedicated account-deletion rehearsal Supabase project",
      status: "fail",
      action: "Set valid reviewed staging and production Supabase URL pins, then bind SUPABASE_URL to staging.",
    };
  }
})();

const deletionRehearsalScopeCheck: ProviderCheck = (() => {
  const unsafe = [
    isEnabled("RESTORE_REHEARSAL_MODE") ? "RESTORE_REHEARSAL_MODE" : null,
    isEnabled("COMMERCIAL_LAUNCH_ENABLED") ? "COMMERCIAL_LAUNCH_ENABLED" : null,
    isEnabled("CONSUMER_PAID_ENROLLMENT_ENABLED") ? "CONSUMER_PAID_ENROLLMENT_ENABLED" : null,
    isEnabled("REPORT_DELIVERY_SCHEDULE_ENABLED") ? "REPORT_DELIVERY_SCHEDULE_ENABLED" : null,
    getValue("REPORT_EMAIL_MODE") !== "disabled" ? "REPORT_EMAIL_MODE" : null,
    isEnabled("DEMO_BILLING_MODE") ? "DEMO_BILLING_MODE" : null,
  ].filter((name): name is string => name !== null);
  const stripeSecret = getValue("STRIPE_SECRET_KEY");
  if (stripeSecret && !/^(?:sk|rk)_test_/.test(stripeSecret)) unsafe.push("STRIPE_SECRET_KEY");
  return {
    id: "ACCOUNT_DELETION_REHEARSAL_FEATURE_SCOPE",
    label: "Notification-only account-deletion rehearsal feature scope",
    status: unsafe.length === 0 ? "pass" : "fail",
    action: unsafe.length === 0
      ? null
      : "Disable paid enrollment, report delivery, restore mode, and demo billing; use only Stripe test mode or no Stripe secret.",
    details: unsafe.length === 0 ? "Commercial providers and report delivery are outside this profile." : `Unsafe: ${unsafe.join(", ")}.`,
  };
})();

const deletionRehearsalRedisCheck: ProviderCheck = (() => {
  const namespace = getValue("REDIS_KEY_NAMESPACE").toLowerCase();
  const safe = hasValue("REDIS_URL")
    && namespace.includes("staging")
    && !namespace.includes("production")
    && !namespace.includes(":prod:")
    && isEnabled("REQUIRE_REDIS_RATE_LIMITING")
    && !isEnabled("ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION");
  return {
    id: "ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION",
    label: "Permanent-staging shared Redis and fail-closed rate limiting",
    status: safe ? "pass" : "fail",
    action: safe
      ? null
      : "Set the permanent-staging REDIS_URL and a staging-only REDIS_KEY_NAMESPACE, require Redis rate limiting, and disable the in-memory production fallback.",
    details: safe ? "Shared Redis is required for the two-replica rehearsal." : null,
  };
})();

const deletionRehearsalRedisIdentityCheck = checkPinnedConnectionIdentity({
  urlName: "REDIS_URL",
  expectedDigestName: "PINTPATH_EXPECTED_REDIS_URL_SHA256",
  forbiddenDigestsName: "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
  id: "ACCOUNT_DELETION_REHEARSAL_REDIS_IDENTITY",
  label: "Reviewed permanent-staging Redis identity",
  action: "Load the exact permanent-staging REDIS_URL digest as the expected pin and production/restore digests as forbidden identities before the two-replica deletion proof.",
});

const deletionRehearsalRedisResourceCheck = checkPinnedResourceIdentity({
  actualName: "PINTPATH_REDIS_RESOURCE_ID",
  expectedName: "PINTPATH_EXPECTED_REDIS_RESOURCE_ID",
  forbiddenName: "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
  id: "ACCOUNT_DELETION_REHEARSAL_REDIS_RESOURCE_IDENTITY",
  label: "Reviewed permanent-staging Redis provider resource",
  action: "Bind the live staging Redis resource ID, match its protected staging pin, and register production plus restore Redis resource IDs as forbidden before deletion.",
});

const deletionRehearsalReplicaCheck: ProviderCheck = (() => {
  const count = Number.parseInt(getValue("ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT"), 10);
  const safe = hasValue("RAILWAY_REPLICA_ID") && Number.isInteger(count) && count >= 2;
  return {
    id: "ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT",
    label: "Permanent-staging replica count",
    status: safe ? "pass" : "fail",
    action: safe ? null : "Run inside a Railway replica and set ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT to the independently verified deployed count of at least 2.",
  };
})();

const deletionRehearsalChecks: ProviderCheck[] = [
  postgresRuntimeImplementationCheck,
  {
    id: "PINTPATH_IDENTITY_REGISTRY_PHASE",
    label: "Complete cross-environment identity registry",
    status: getValue("PINTPATH_IDENTITY_REGISTRY_PHASE") === "complete" ? "pass" : "fail",
    action: getValue("PINTPATH_IDENTITY_REGISTRY_PHASE") === "complete"
      ? null
      : "Complete the permanent-staging/production/restore identity registry before account-deletion rehearsal.",
  },
  checkPermanentStagingRailwayIdentity(),
  {
    id: "ACCOUNT_DELETION_REHEARSAL_ENABLED",
    label: "Account-deletion rehearsal profile enabled",
    status: accountDeletionRehearsalEnabled ? "pass" : "fail",
    action: accountDeletionRehearsalEnabled ? null : "Set ACCOUNT_DELETION_REHEARSAL_ENABLED=true only in isolated staging.",
  },
  deletionRehearsalRailwayIdentityCheck,
  deletionRehearsalPublicOriginCheck,
  deletionRehearsalDatabaseCheck,
  deletionRehearsalMaintenanceDatabaseCheck,
  deletionRehearsalPostgresRootCaCheck,
  deletionRehearsalDatabaseIdentityCheck,
  deletionRehearsalDatabaseResourceCheck,
  checkPermanentStagingServiceInstances(),
  checkPermanentStagingSelfPins(),
  deletionRehearsalReplicaCheck,
  checkExactSupabaseOrigin("SUPABASE_URL", PERMANENT_STAGING_SUPABASE_ORIGIN, "Account-deletion rehearsal Supabase origin", "Set SUPABASE_URL to the exact reviewed permanent-staging Supabase origin."),
  deletionRehearsalSupabaseIdentityCheck,
  checkSupabaseKeyFormat("SUPABASE_ANON_KEY", "publishable", "Staging Supabase publishable key", "Set the staging project's exact browser-safe sb_publishable_ key."),
  checkSupabaseKeyFormat("SUPABASE_SERVICE_ROLE_KEY", "secret", "Staging Supabase secret key", "Set the staging project's exact server-only sb_secret_ key."),
  {
    id: "SUPABASE_OAUTH_PROVIDERS",
    label: "Staging OAuth provider scope",
    status: getValue("SUPABASE_OAUTH_PROVIDERS") === "google" ? "pass" : "fail",
    action: getValue("SUPABASE_OAUTH_PROVIDERS") === "google"
      ? null
      : "Set SUPABASE_OAUTH_PROVIDERS=google and keep Apple disabled for this launch.",
  },
  deletionRehearsalScopeCheck,
  checkAbsent(
    [
      "OFFSITE_BACKUP_SUPABASE_URL",
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
      "OFFSITE_BACKUP_BUCKET",
    ],
    "ACCOUNT_DELETION_REHEARSAL_BACKUP_CREDENTIALS_ABSENT",
    "No off-site backup authority in account-deletion rehearsal",
    "Remove OFFSITE_BACKUP_SUPABASE_URL, OFFSITE_BACKUP_SERVICE_ROLE_KEY, and OFFSITE_BACKUP_BUCKET from staging before running the proof.",
  ),
  deletionRehearsalRedisCheck,
  deletionRehearsalRedisIdentityCheck,
  deletionRehearsalRedisResourceCheck,
  checkRequiredStrongSecret(
    "SOURCE_EVIDENCE_SIGNING_SECRET",
    "Staging source-evidence signing secret",
    "Set a unique staging-only source-evidence signing secret of at least 32 bytes.",
  ),
  deletionNoticeModeCheck,
  deletionNoticeKeyringCheck,
  checkRequired(
    "RESEND_TRANSACTIONAL_API_KEY",
    "Staging Resend transactional deletion-notice key",
    "Set the staging-only sending key dedicated to account deletion notices.",
  ),
  checkRequired(
    "ACCOUNT_DELETION_NOTICE_FROM",
    "Verified staging account deletion sender",
    "Set the staging deletion-notice sender on the verified Resend domain.",
  ),
  checkRequired(
    "ACCOUNT_DELETION_NOTICE_REPLY_TO",
    "Monitored staging account deletion reply-to",
    "Set the monitored staging privacy/support reply-to.",
  ),
  {
    id: "RESEND_WEBHOOK_SIGNING_SECRET",
    label: "Signed staging Resend delivery webhook",
    status: hasValidResendWebhookSecret() ? "pass" : "fail",
    action: hasValidResendWebhookSecret()
      ? null
      : "Create the staging-only Resend webhook and set its whsec_ signing secret.",
  },
  {
    id: "ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES",
    label: "Account deletion notification worker interval",
    status: (getValue("ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES") || "5") === "5" ? "pass" : "fail",
    action: (getValue("ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES") || "5") === "5"
      ? null
      : "Set ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES=5 for the rehearsal.",
  },
];

const strict = isStrictLaunchCheck();
const unsupportedProductionRuntime = isProduction()
  && !canonicalProductionRuntime
  && !stagingIdentityBootstrap
  && !accountDeletionRehearsalEnabled
  && !permanentStagingComplete;
const unsupportedProductionRuntimeCheck: ProviderCheck = {
  id: "PROVIDER_READINESS_RUNTIME_IDENTITY",
  label: "Recognized provider-readiness runtime identity",
  status: "fail",
  action: "Run provider readiness only in canonical production or an explicitly selected permanent-staging profile. Preview, cloned, and incomplete staging environments are fail-closed.",
  details: "The production-like runtime is not an authorized provider-readiness profile; no environment name or provider value is emitted.",
};
const readinessProfile = unsupportedProductionRuntime
  ? "unsupported_production_runtime"
  : stagingIdentityBootstrap
  ? "permanent_staging_identity_bootstrap_incomplete"
  : accountDeletionRehearsalEnabled
    ? "account_deletion_rehearsal"
    : permanentStagingComplete
      ? "permanent_staging_complete"
      : isProduction()
        ? "production_free_launch"
        : "development_provider_preview";
const selectedPreflightChecks = unsupportedProductionRuntime
  ? [unsupportedProductionRuntimeCheck]
  : stagingIdentityBootstrap
  ? stagingBootstrapChecks
  : accountDeletionRehearsalEnabled
    ? deletionRehearsalChecks
    : permanentStagingComplete
      ? permanentStagingCompleteChecks
      : launchPreflightChecks;
const preflightChecks = strict && isProduction()
  ? [checkDeployedReadinessContext(), ...selectedPreflightChecks]
  : selectedPreflightChecks;
const preflightFailed = preflightChecks.filter((check) => check.status === "fail");
const preflightWarned = preflightChecks.filter((check) => check.status === "warn");
const preflightBlocked = preflightFailed.length > 0
  || (strict && preflightWarned.length > 0);
const storageCanariesAllowed = (canonicalProductionRuntime || permanentStagingComplete)
  && !stagingIdentityBootstrap
  && !accountDeletionRehearsalEnabled
  && !isEnabled("RESTORE_REHEARSAL_MODE");
const storageChecks = storageCanariesAllowed && !preflightBlocked
  ? await runProviderStorageCanaries({
      includeOperationalOffsite: !permanentStagingComplete,
    })
  : [];
const checks = [...preflightChecks, ...storageChecks];
const failed = checks.filter((check) => check.status === "fail");
const warned = checks.filter((check) => check.status === "warn");
const blockingWarnings = strict ? warned : [];

console.log(JSON.stringify({
  ok: failed.length === 0 && blockingWarnings.length === 0,
  environment: process.env.NODE_ENV ?? "development",
  readinessProfile,
  strictLaunchCheck: strict,
  summary: {
    passed: checks.filter((check) => check.status === "pass").length,
    warnings: warned.length,
    blockingWarnings: blockingWarnings.length,
    failures: failed.length,
  },
  postgresAuthority: postgresRuntimeAuthority,
  checks,
}, null, 2));

if (failed.length > 0 || blockingWarnings.length > 0) {
  process.exit(1);
}
