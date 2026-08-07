import dotenv from "dotenv";

import { createServerSupabaseClient } from "../src/lib/supabase-client.js";
import { parseAccountDeletionNotificationKeyring } from "../src/lib/account-deletion-notification-worker.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";

dotenv.config({ quiet: true });

const ACCOUNT_DELETION_REHEARSAL_RAILWAY_PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ACCOUNT_DELETION_REHEARSAL_RAILWAY_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const ACCOUNT_DELETION_REHEARSAL_BEER_SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const ACCOUNT_DELETION_REHEARSAL_SUPABASE_URL = "https://ibveugyfyzjptyvautlr.supabase.co";

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
      const canaryPrefix = `_readiness/${process.pid}-${Date.now()}`;
      const canaries = [
        { path: `${canaryPrefix}/probe.pdf`, bytes: Buffer.from("%PDF-readiness"), contentType: "application/pdf" },
        { path: `${canaryPrefix}/probe.sqlite`, bytes: Buffer.from("SQLite format 3\0readiness"), contentType: "application/octet-stream" },
        { path: `${canaryPrefix}/probe.jpg`, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), contentType: "image/jpeg" },
      ];
      try {
        for (const canary of canaries) {
          const { error: uploadError } = await client.storage.from(input.bucketName).upload(
            canary.path,
            canary.bytes,
            { contentType: canary.contentType, upsert: false },
          );
          if (uploadError) throw uploadError;
        }
        const { data: listed, error: listError } = await client.storage.from(input.bucketName).list(canaryPrefix);
        if (listError || (listed?.length ?? 0) !== canaries.length) throw listError ?? new Error("canary_list_failed");
        for (const canary of canaries) {
          const { data: downloaded, error: downloadError } = await client.storage.from(input.bucketName).download(canary.path);
          if (downloadError || !downloaded) throw downloadError ?? new Error("canary_download_failed");
          const bytes = Buffer.from(await downloaded.arrayBuffer());
          if (!bytes.equals(canary.bytes)) throw new Error("canary_checksum_failed");
          const contentType = downloaded.type?.split(";", 1)[0]?.trim().toLowerCase();
          if (contentType && contentType !== canary.contentType) throw new Error("canary_mime_failed");
        }
      } finally {
        const { error: removeError } = await client.storage.from(input.bucketName).remove(
          canaries.map((canary) => canary.path),
        );
        if (removeError) throw removeError;
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
const sourceEvidenceBucketCheck = accountDeletionRehearsalEnabled
  ? null
  : await checkPrivateStorageBucket({
    id: "SOURCE_EVIDENCE_BUCKET",
    label: "Private source-evidence bucket",
    bucketName: "beermap-source-evidence",
    urlEnvName: "SUPABASE_URL",
    keyEnvName: "SUPABASE_SERVICE_ROLE_KEY",
    requiredMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"],
    minimumFileSizeBytes: 8 * 1024 * 1024,
  });
const offsiteBackupBucketName = getValue("OFFSITE_BACKUP_BUCKET") || "pintpath-backups";
if (isProduction() && !accountDeletionRehearsalEnabled) {
  assertOperatorMutationAllowed("Provider readiness storage write probe");
}
const offsiteBackupBucketCheck = accountDeletionRehearsalEnabled
  ? null
  : await checkPrivateStorageBucket({
    id: "OFFSITE_BACKUP_BUCKET",
    label: "Private off-site backup bucket",
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
  });
const independentBackupDestinationCheck: ProviderCheck = (() => {
  const source = getValue("SUPABASE_URL");
  const destination = getValue("OFFSITE_BACKUP_SUPABASE_URL");
  if (!source || !destination) {
    return {
      id: "OFFSITE_BACKUP_DESTINATION_INDEPENDENT",
      label: "Independent off-site backup destination",
      status: isProduction() ? "fail" : "warn",
      action: "Configure a backup project/provider that is independent of the production Supabase project.",
    };
  }
  try {
    const independent = new URL(source).origin.toLowerCase() !== new URL(destination).origin.toLowerCase();
    return {
      id: "OFFSITE_BACKUP_DESTINATION_INDEPENDENT",
      label: "Independent off-site backup destination",
      status: independent ? "pass" : "fail",
      action: independent
        ? null
        : "Move backups to a separate Supabase project/provider; the production project is not disaster isolation.",
    };
  } catch {
    return {
      id: "OFFSITE_BACKUP_DESTINATION_INDEPENDENT",
      label: "Independent off-site backup destination",
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

const launchChecks: ProviderCheck[] = [
  checkRequired("GOOGLE_MAPS_API_KEY", "Google Maps browser API key", "Create/restrict a browser key and set GOOGLE_MAPS_API_KEY."),
  checkRequired("GOOGLE_MAPS_MAP_ID", "Google Maps JavaScript vector map ID", "Create a JavaScript Map ID in Google Maps Platform and set GOOGLE_MAPS_MAP_ID."),
  checkRequired("GOOGLE_PLACES_API_KEY", "Google Places server API key", "Set GOOGLE_PLACES_API_KEY on the Railway app service for admin venue lookup and future request flows."),
  checkRequired("OPENAI_API_KEY", "OpenAI menu OCR key", "Set OPENAI_API_KEY on the Railway app service and redeploy so menu photo OCR can initialise."),
  checkRequired("SUPABASE_URL", "Supabase project URL", "Set SUPABASE_URL for OAuth and provider-backed auth."),
  checkRequired("SUPABASE_ANON_KEY", "Supabase publishable/anon key", "Set the browser-safe Supabase publishable/anon key."),
  checkRequired("SUPABASE_SERVICE_ROLE_KEY", "Supabase server service-role key", "Set SUPABASE_SERVICE_ROLE_KEY for private source-evidence capture history."),
  checkSupabaseOauthLaunchProviders(),
  checkRequired("OFFSITE_BACKUP_SUPABASE_URL", "Independent backup project URL", "Set OFFSITE_BACKUP_SUPABASE_URL to a different project/provider from SUPABASE_URL."),
  checkRequired("OFFSITE_BACKUP_SERVICE_ROLE_KEY", "Independent backup service-role key", "Set the service-role key for the independent backup project/provider."),
  independentBackupDestinationCheck,
  checkSupabaseProviderCallbackUrl(),
  ...[sourceEvidenceBucketCheck].filter((check): check is ProviderCheck => check !== null),
  checkRequired("REDIS_URL", "Redis-backed rate limiter", "Provision Railway Redis/Upstash and set REDIS_URL before broad production."),
  checkRequired("SOURCE_EVIDENCE_SIGNING_SECRET", "Source evidence signing secret", "Generate a unique 32+ character secret for signed evidence URLs."),
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
  ...[offsiteBackupBucketCheck].filter((check): check is ProviderCheck => check !== null),
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
      ? "Set DEMO_BILLING_MODE=false for real paid checkout, or explicitly time-box ALLOW_DEMO_BILLING_IN_PRODUCTION=true for a private beta."
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
  label: "Immutable account-deletion rehearsal Railway identity",
  status: isProduction()
      && getValue("RAILWAY_ENVIRONMENT_NAME").toLowerCase() === "staging"
      && getValue("RAILWAY_PROJECT_ID") === ACCOUNT_DELETION_REHEARSAL_RAILWAY_PROJECT_ID
      && getValue("RAILWAY_ENVIRONMENT_ID") === ACCOUNT_DELETION_REHEARSAL_RAILWAY_ENVIRONMENT_ID
      && getValue("RAILWAY_SERVICE_ID") === ACCOUNT_DELETION_REHEARSAL_BEER_SERVICE_ID
    ? "pass"
    : "fail",
  action: "Run this profile only on the immutable Pint Path staging Railway project, environment, and Beer service.",
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

const deletionRehearsalLocalPathsCheck: ProviderCheck = (() => {
  const exact = getValue("RAILWAY_VOLUME_MOUNT_PATH") === "/app/data"
    && getValue("DATABASE_PATH") === "/app/data/pint-path.sqlite"
    && getValue("SOURCE_EVIDENCE_STORAGE_DIR") === "/app/data/source-evidence";
  return {
    id: "ACCOUNT_DELETION_REHEARSAL_LOCAL_PATHS",
    label: "Dedicated account-deletion rehearsal local paths",
    status: exact ? "pass" : "fail",
    action: exact
      ? null
      : "Use only the staging /app/data volume, /app/data/pint-path.sqlite, and /app/data/source-evidence paths.",
  };
})();

const deletionRehearsalSupabaseIdentityCheck: ProviderCheck = (() => {
  try {
    const url = new URL(getValue("SUPABASE_URL"));
    const exact = url.origin.toLowerCase() === ACCOUNT_DELETION_REHEARSAL_SUPABASE_URL
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
      action: exact ? null : "Bind SUPABASE_URL to the immutable non-production rehearsal project.",
    };
  } catch {
    return {
      id: "ACCOUNT_DELETION_REHEARSAL_SUPABASE_IDENTITY",
      label: "Dedicated account-deletion rehearsal Supabase project",
      status: "fail",
      action: "Bind SUPABASE_URL to the immutable non-production rehearsal project.",
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
  const redisVariables = [
    "REDIS_URL",
    "REDIS_KEY_NAMESPACE",
    "RESTORE_REHEARSAL_REDIS_ENVIRONMENT_ID",
    "RESTORE_REHEARSAL_REDIS_SERVICE_ID",
    "RESTORE_REHEARSAL_REDIS_SENTINEL",
  ].filter(hasValue);
  const safe = redisVariables.length === 0
    && !isEnabled("REQUIRE_REDIS_RATE_LIMITING")
    && isEnabled("ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION");
  return {
    id: "ACCOUNT_DELETION_REHEARSAL_REDIS_ISOLATION",
    label: "Account-deletion rehearsal Redis isolation",
    status: safe ? "pass" : "fail",
    action: safe
      ? null
      : "Remove every Redis reference, keep REQUIRE_REDIS_RATE_LIMITING=false, and explicitly enable the single-instance in-memory limiter for this isolated proof.",
    details: redisVariables.length > 0 ? `Remove: ${redisVariables.join(", ")}.` : null,
  };
})();

const deletionRehearsalChecks: ProviderCheck[] = [
  {
    id: "ACCOUNT_DELETION_REHEARSAL_ENABLED",
    label: "Account-deletion rehearsal profile enabled",
    status: accountDeletionRehearsalEnabled ? "pass" : "fail",
    action: accountDeletionRehearsalEnabled ? null : "Set ACCOUNT_DELETION_REHEARSAL_ENABLED=true only in isolated staging.",
  },
  deletionRehearsalRailwayIdentityCheck,
  deletionRehearsalPublicOriginCheck,
  deletionRehearsalLocalPathsCheck,
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

const checks = accountDeletionRehearsalEnabled ? deletionRehearsalChecks : launchChecks;

const failed = checks.filter((check) => check.status === "fail");
const warned = checks.filter((check) => check.status === "warn");
const strict = isStrictLaunchCheck();
const blockingWarnings = strict ? warned : [];

console.log(JSON.stringify({
  ok: failed.length === 0 && blockingWarnings.length === 0,
  environment: process.env.NODE_ENV ?? "development",
  readinessProfile: accountDeletionRehearsalEnabled ? "account_deletion_rehearsal" : "production_launch",
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
