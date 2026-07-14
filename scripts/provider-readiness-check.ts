import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

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
    label: "Google/Apple OAuth provider callback URL",
    status: callbackUrl ? "pass" : isProduction() ? "fail" : "warn",
    action: callbackUrl
      ? null
      : "Set SUPABASE_URL so the provider callback URL can be derived for Google/Apple OAuth consoles.",
    details: callbackUrl
      ? `Add this exact URL to Google Authorized redirect URIs and Apple Sign in Return URLs: ${callbackUrl}`
      : null,
  };
}

async function checkPrivateStorageBucket(input: {
  id: string;
  label: string;
  bucketName: string;
}): Promise<ProviderCheck> {
  if (!isProduction()) {
    return { id: input.id, label: input.label, status: "pass", action: null };
  }

  const supabaseUrl = getValue("SUPABASE_URL");
  const serviceRoleKey = getValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return {
      id: input.id,
      label: input.label,
      status: "fail",
      action: `Configure Supabase server credentials and create the private ${input.bucketName} bucket.`,
    };
  }

  try {
    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.storage.getBucket(input.bucketName);
    const privateBucket = !error && data && data.public === false;
    return {
      id: input.id,
      label: input.label,
      status: privateBucket ? "pass" : "fail",
      action: privateBucket
        ? null
        : `Create ${input.bucketName} in Supabase Storage and keep public access disabled.`,
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

const sourceEvidenceBucketCheck = await checkPrivateStorageBucket({
  id: "SOURCE_EVIDENCE_BUCKET",
  label: "Private source-evidence bucket",
  bucketName: "beermap-source-evidence",
});
const offsiteBackupBucketName = getValue("OFFSITE_BACKUP_BUCKET") || "pintpath-backups";
const offsiteBackupBucketCheck = await checkPrivateStorageBucket({
  id: "OFFSITE_BACKUP_BUCKET",
  label: "Private off-site backup bucket",
  bucketName: offsiteBackupBucketName,
});
const reportEmailMode = getValue("REPORT_EMAIL_MODE") || "disabled";
const reportScheduleEnabled = getValue("REPORT_DELIVERY_SCHEDULE_ENABLED") === "true";
const reportEmailModeCheck: ProviderCheck = {
  id: "REPORT_EMAIL_MODE",
  label: "Report email delivery mode",
  status: !["disabled", "mock", "resend"].includes(reportEmailMode)
    ? "fail"
    : isProduction() && reportEmailMode === "mock"
      ? "fail"
      : isProduction() && reportEmailMode !== "resend"
        ? "warn"
        : "pass",
  action: reportEmailMode === "resend"
    ? null
    : isProduction()
      ? "Set REPORT_EMAIL_MODE=resend only after the Resend sending domain, API key, and sender address are verified."
      : null,
};
const reportScheduleCheck: ProviderCheck = {
  id: "REPORT_DELIVERY_SCHEDULE_ENABLED",
  label: "Automatic monthly report schedule",
  status: reportScheduleEnabled && reportEmailMode !== "resend"
    ? "fail"
    : isProduction() && !reportScheduleEnabled
      ? "warn"
      : "pass",
  action: reportScheduleEnabled
    ? null
    : isProduction()
      ? "After a successful Resend dry run, set REPORT_DELIVERY_SCHEDULE_ENABLED=true."
      : null,
};
const resendApiKeyCheck: ProviderCheck = reportEmailMode === "resend" || reportScheduleEnabled
  ? checkRequired("RESEND_API_KEY", "Resend report-email API key", "Create a sending-only Resend API key and set RESEND_API_KEY.")
  : { id: "RESEND_API_KEY", label: "Resend report-email API key", status: "pass", action: null };
const reportEmailFromCheck: ProviderCheck = reportEmailMode === "resend" || reportScheduleEnabled
  ? checkRequired("REPORT_EMAIL_FROM", "Verified report sender address", "Set REPORT_EMAIL_FROM to an address on the verified Resend sending domain.")
  : { id: "REPORT_EMAIL_FROM", label: "Verified report sender address", status: "pass", action: null };

const checks: ProviderCheck[] = [
  checkRequired("GOOGLE_MAPS_API_KEY", "Google Maps browser API key", "Create/restrict a browser key and set GOOGLE_MAPS_API_KEY."),
  checkRequired("GOOGLE_MAPS_MAP_ID", "Google Maps JavaScript vector map ID", "Create a JavaScript Map ID in Google Maps Platform and set GOOGLE_MAPS_MAP_ID."),
  checkRequired("GOOGLE_PLACES_API_KEY", "Google Places server API key", "Set GOOGLE_PLACES_API_KEY on the Railway app service for admin venue lookup and future request flows."),
  checkRequired("OPENAI_API_KEY", "OpenAI menu OCR key", "Set OPENAI_API_KEY on the Railway app service and redeploy so menu photo OCR can initialise."),
  checkRequired("SUPABASE_URL", "Supabase project URL", "Set SUPABASE_URL for OAuth and provider-backed auth."),
  checkRequired("SUPABASE_ANON_KEY", "Supabase publishable/anon key", "Set the browser-safe Supabase publishable/anon key."),
  checkRequired("SUPABASE_SERVICE_ROLE_KEY", "Supabase server service-role key", "Set SUPABASE_SERVICE_ROLE_KEY for private capture history and off-site backups."),
  checkSupabaseProviderCallbackUrl(),
  sourceEvidenceBucketCheck,
  checkRequired("REDIS_URL", "Redis-backed rate limiter", "Provision Railway Redis/Upstash and set REDIS_URL before broad production."),
  checkRequired("SOURCE_EVIDENCE_SIGNING_SECRET", "Source evidence signing secret", "Generate a unique 32+ character secret for signed evidence URLs."),
  checkRequired("STRIPE_SECRET_KEY", "Stripe secret key", "Use Stripe test mode first; set STRIPE_SECRET_KEY before paid checkout."),
  checkRequired("STRIPE_WEBHOOK_SECRET", "Stripe webhook secret", "Forward signed Stripe CLI/webhook events and set STRIPE_WEBHOOK_SECRET."),
  checkRequired("STRIPE_PRICE_MONTHLY", "Stripe paid user monthly price ID", "Create the user monthly recurring price and set STRIPE_PRICE_MONTHLY."),
  checkRequired("STRIPE_PRICE_YEARLY", "Stripe paid user yearly price ID", "Create the user yearly recurring price and set STRIPE_PRICE_YEARLY."),
  checkRequired("STRIPE_PRO_PRICE_ID", "Stripe Pro venue price ID", "Create the Pro recurring price and set STRIPE_PRO_PRICE_ID."),
  checkRequired("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "Stripe publishable key", "Set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY so browser checkout can initialise safely."),
  checkRequired("POS_WEBHOOK_SIGNING_SECRET", "POS webhook signing secret", "Generate a unique 32+ character POS_WEBHOOK_SIGNING_SECRET before enabling POS integrations."),
  checkNoTestKeyInProduction("STRIPE_SECRET_KEY", "Stripe secret key is live-mode in production", "sk_test_"),
  checkNoTestKeyInProduction("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "Stripe publishable key is live-mode in production", "pk_test_"),
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
  offsiteBackupBucketCheck,
  {
    id: "REPORT_TIMEZONE",
    label: "Monthly report timezone",
    status: process.env.REPORT_TIMEZONE === "Australia/Melbourne" ? "pass" : "warn",
    action: process.env.REPORT_TIMEZONE === "Australia/Melbourne"
      ? null
      : "Set REPORT_TIMEZONE=Australia/Melbourne unless you intentionally change the reporting market.",
  },
  reportEmailModeCheck,
  reportScheduleCheck,
  resendApiKeyCheck,
  reportEmailFromCheck,
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

const failed = checks.filter((check) => check.status === "fail");
const warned = checks.filter((check) => check.status === "warn");
const strict = isStrictLaunchCheck();
const blockingWarnings = strict ? warned : [];

console.log(JSON.stringify({
  ok: failed.length === 0 && blockingWarnings.length === 0,
  environment: process.env.NODE_ENV ?? "development",
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
