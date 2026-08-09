import crypto from "node:crypto";

import dotenv from "dotenv";

import { createServerSupabaseClient } from "../src/lib/supabase-client.js";
import { parseAccountDeletionNotificationKeyring } from "../src/lib/account-deletion-notification-worker.js";
import { inspectPostgresRuntimeImplementationContract } from "../src/db/runtime-persistence.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

dotenv.config({ quiet: true });

type CheckStatus = "pass" | "warn" | "fail";

interface ProviderCheck {
  id: string;
  label: string;
  status: CheckStatus;
  action: string | null;
  details?: string | null;
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

function checkRequired(name: string, label: string, action: string): ProviderCheck {
  const present = hasValue(name);
  return {
    id: name,
    label,
    status: present ? "pass" : isProduction() ? "fail" : "warn",
    action: present ? null : action,
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

function checkTlsPostgresUrl(name: string, id: string, label: string, action: string): ProviderCheck {
  const value = getValue(name);
  if (!value) {
    return {
      id,
      label,
      status: isProduction() ? "fail" : "warn",
      action,
      details: `${name} is not configured.`,
    };
  }
  try {
    const url = new URL(value);
    const sslModes = url.searchParams
      .getAll("sslmode")
      .map((sslMode) => sslMode.toLowerCase());
    const valid = ["postgres:", "postgresql:"].includes(url.protocol)
      && Boolean(url.hostname)
      && Boolean(url.username)
      && Boolean(url.pathname.replace(/^\//, ""))
      && sslModes.length === 1
      && ["require", "verify-ca", "verify-full"].includes(sslModes[0] ?? "")
      && !url.hash;
    return {
      id,
      label,
      status: valid ? "pass" : "fail",
      action: valid ? null : action,
      details: valid ? "Postgres connection requires TLS." : `${name} must be a Postgres URL with an explicit TLS sslmode.`,
    };
  } catch {
    return {
      id,
      label,
      status: "fail",
      action,
      details: `${name} is not a valid URL.`,
    };
  }
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
  const supabaseUrl = getValue("SUPABASE_URL");
  if (!supabaseUrl) {
    return null;
  }

  try {
    return new URL("/auth/v1/callback", supabaseUrl).toString();
  } catch {
    return null;
  }
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
      action: `Confirm ${input.bucketName} exists, is private, and is reachable with the service-role key.`,
    };
  }
}

const accountDeletionRehearsalEnabled = isEnabled("ACCOUNT_DELETION_REHEARSAL_ENABLED");
const stagingIdentityBootstrap = getValue("PINTPATH_IDENTITY_REGISTRY_PHASE") === "staging-bootstrap";
const permanentStagingComplete = isProduction()
  && getValue("RAILWAY_ENVIRONMENT_NAME").toLowerCase() === "staging"
  && getValue("PINTPATH_IDENTITY_REGISTRY_PHASE") === "complete"
  && !accountDeletionRehearsalEnabled
  && !isEnabled("RESTORE_REHEARSAL_MODE");
const offsiteBackupBucketName = getValue("OFFSITE_BACKUP_BUCKET") || "pintpath-backups";

async function runProviderStorageCanaries(): Promise<ProviderCheck[]> {
  assertOperatorMutationAllowed("Provider readiness storage write probe");
  return Promise.all([
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
    checkPrivateStorageBucket({
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
    }),
  ]);
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

const productionPostgresCheck: ProviderCheck = (() => {
  const postgres = checkTlsPostgresUrl(
    "DATABASE_URL",
    "PRODUCTION_POSTGRES_DATABASE_URL",
    "Shared TLS Postgres persistence",
    "Set DATABASE_URL to the least-privilege pooled Postgres connection with sslmode=require (or stricter) before a full-scale launch.",
  );
  if (hasValue("DATABASE_PATH")) {
    return {
      ...postgres,
      status: isProduction() ? "fail" : "warn",
      action: "Remove DATABASE_PATH from the production service; keep any sealed SQLite migration source outside the runtime environment.",
      details: "DATABASE_PATH is configured, so the runtime could resume local SQLite writes.",
    };
  }
  return postgres;
})();

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

const permanentStagingPostgresCheck: ProviderCheck = (() => {
  const postgres = checkTlsPostgresUrl(
    "DATABASE_URL",
    "PERMANENT_STAGING_POSTGRES_DATABASE_URL",
    "Permanent-staging shared TLS Postgres persistence",
    "Set DATABASE_URL to the reviewed least-privilege permanent-staging Postgres connection with sslmode=require (or stricter).",
  );
  if (hasValue("DATABASE_PATH")) {
    return {
      ...postgres,
      status: "fail",
      action: "Remove DATABASE_PATH from permanent staging; keep the sealed SQLite source outside the application runtime.",
      details: "DATABASE_PATH is configured, so staging could resume local SQLite writes.",
    };
  }
  return postgres;
})();

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
  productionPostgresCheck,
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
      : "Configure shared staging Redis, require it, and keep the in-memory production fallback disabled.",
  },
  checkPermanentStagingServiceInstances(),
  checkPermanentStagingSelfPins(),
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
    action: "Provision and register real production and restore database/Redis identities, set PINTPATH_IDENTITY_REGISTRY_PHASE=complete, redeploy, and run the full provider gate before any app server starts.",
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
  checkRequired("SUPABASE_URL", "Permanent-staging Supabase project URL", "Set the reviewed permanent-staging Supabase URL."),
  checkRequired("SUPABASE_ANON_KEY", "Permanent-staging Supabase publishable/anon key", "Set the staging project's browser-safe Supabase key."),
  checkRequired("SUPABASE_SERVICE_ROLE_KEY", "Permanent-staging Supabase service-role key", "Set the staging project's server-only service-role key."),
  checkSupabaseOauthLaunchProviders(),
  checkSupabaseProviderCallbackUrl(),
  checkRequired("OFFSITE_BACKUP_SUPABASE_URL", "Staging operational restore-copy URL", "Set an isolated staging operational-copy origin distinct from the staging Supabase project."),
  checkRequired("OFFSITE_BACKUP_SERVICE_ROLE_KEY", "Staging operational restore-copy service-role key", "Set the server-only key for the isolated staging operational copy."),
  operationalRestoreCopyDestinationCheck,
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
  checkRequired("GOOGLE_PLACES_API_KEY", "Google Places server API key", "Set GOOGLE_PLACES_API_KEY on the Railway app service for admin venue lookup and future request flows."),
  checkRequired("OPENAI_API_KEY", "OpenAI menu OCR key", "Set OPENAI_API_KEY on the Railway app service and redeploy so menu photo OCR can initialise."),
  checkRequired("SUPABASE_URL", "Supabase project URL", "Set SUPABASE_URL for OAuth and provider-backed auth."),
  checkRequired("SUPABASE_ANON_KEY", "Supabase publishable/anon key", "Set the browser-safe Supabase publishable/anon key."),
  checkRequired("SUPABASE_SERVICE_ROLE_KEY", "Supabase server service-role key", "Set SUPABASE_SERVICE_ROLE_KEY for private source-evidence capture history."),
  checkSupabaseOauthLaunchProviders(),
  checkRequired("OFFSITE_BACKUP_SUPABASE_URL", "Private operational restore-copy URL", "Set OFFSITE_BACKUP_SUPABASE_URL to an operational restore-copy origin different from SUPABASE_URL; separately prove WORM authority."),
  checkRequired("OFFSITE_BACKUP_SERVICE_ROLE_KEY", "Operational restore-copy service-role key", "Set the service-role key for the private operational restore copy; it is not the WORM recovery credential."),
  operationalRestoreCopyDestinationCheck,
  checkSupabaseProviderCallbackUrl(),
  productionPostgresCheck,
  productionDatabaseIdentityCheck,
  productionDatabaseResourceCheck,
  postgresRuntimeImplementationCheck,
  checkRequired("REDIS_URL", "Redis-backed rate limiter", "Provision Railway Redis/Upstash and set REDIS_URL before broad production."),
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

const deletionRehearsalDatabaseCheck: ProviderCheck = (() => {
  const postgres = checkTlsPostgresUrl(
    "DATABASE_URL",
    "ACCOUNT_DELETION_REHEARSAL_DATABASE",
    "Permanent-staging shared Postgres",
    "Set DATABASE_URL to the permanent-staging pooled Postgres URL with sslmode=require (or stricter), and remove DATABASE_PATH.",
  );
  if (hasValue("DATABASE_PATH")) {
    return {
      ...postgres,
      status: "fail",
      action: "Remove DATABASE_PATH; the full-scale deletion rehearsal must use shared Postgres, never a mounted SQLite file.",
      details: "DATABASE_PATH is configured.",
    };
  }
  return postgres;
})();

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
  deletionRehearsalDatabaseIdentityCheck,
  deletionRehearsalDatabaseResourceCheck,
  checkPermanentStagingServiceInstances(),
  checkPermanentStagingSelfPins(),
  deletionRehearsalReplicaCheck,
  deletionRehearsalSupabaseIdentityCheck,
  checkRequired("SUPABASE_ANON_KEY", "Staging Supabase publishable/anon key", "Set the staging project's browser-safe Supabase key."),
  checkRequired("SUPABASE_SERVICE_ROLE_KEY", "Staging Supabase service-role key", "Set the staging project's server-only service-role key."),
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
    ["OFFSITE_BACKUP_SUPABASE_URL", "OFFSITE_BACKUP_SERVICE_ROLE_KEY"],
    "ACCOUNT_DELETION_REHEARSAL_BACKUP_CREDENTIALS_ABSENT",
    "No off-site backup credentials in account-deletion rehearsal",
    "Remove OFFSITE_BACKUP_SUPABASE_URL and OFFSITE_BACKUP_SERVICE_ROLE_KEY from staging before running the proof.",
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
const readinessProfile = stagingIdentityBootstrap
  ? "permanent_staging_identity_bootstrap_incomplete"
  : accountDeletionRehearsalEnabled
    ? "account_deletion_rehearsal"
    : permanentStagingComplete
      ? "permanent_staging_complete"
      : isProduction()
        ? "production_free_launch"
        : "development_provider_preview";
const preflightChecks = stagingIdentityBootstrap
  ? stagingBootstrapChecks
  : accountDeletionRehearsalEnabled
    ? deletionRehearsalChecks
    : permanentStagingComplete
      ? permanentStagingCompleteChecks
      : launchPreflightChecks;
const preflightFailed = preflightChecks.filter((check) => check.status === "fail");
const preflightWarned = preflightChecks.filter((check) => check.status === "warn");
const preflightBlocked = preflightFailed.length > 0
  || (strict && preflightWarned.length > 0);
const storageCanariesAllowed = isProduction()
  && !stagingIdentityBootstrap
  && !accountDeletionRehearsalEnabled
  && !isEnabled("RESTORE_REHEARSAL_MODE");
const storageChecks = storageCanariesAllowed && !preflightBlocked
  ? await runProviderStorageCanaries()
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
  checks,
}, null, 2));

if (failed.length > 0 || blockingWarnings.length > 0) {
  process.exit(1);
}
