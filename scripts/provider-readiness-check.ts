import dotenv from "dotenv";

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

const checks: ProviderCheck[] = [
  checkRequired("GOOGLE_MAPS_API_KEY", "Google Maps browser API key", "Create/restrict a browser key and set GOOGLE_MAPS_API_KEY."),
  checkRequired("GOOGLE_MAPS_MAP_ID", "Google Maps JavaScript vector map ID", "Create a JavaScript Map ID in Google Maps Platform and set GOOGLE_MAPS_MAP_ID."),
  checkRequired("GOOGLE_PLACES_API_KEY", "Google Places server API key", "Set GOOGLE_PLACES_API_KEY on the Railway app service for admin venue lookup and future request flows."),
  checkRequired("OPENAI_API_KEY", "OpenAI menu OCR key", "Set OPENAI_API_KEY on the Railway app service and redeploy so menu photo OCR can initialise."),
  checkRequired("SUPABASE_URL", "Supabase project URL", "Set SUPABASE_URL for OAuth and provider-backed auth."),
  checkRequired("SUPABASE_ANON_KEY", "Supabase publishable/anon key", "Set the browser-safe Supabase publishable/anon key."),
  checkSupabaseProviderCallbackUrl(),
  checkRequired("REDIS_URL", "Redis-backed rate limiter", "Provision Railway Redis/Upstash and set REDIS_URL before broad production."),
  checkRequired("SOURCE_EVIDENCE_SIGNING_SECRET", "Source evidence signing secret", "Generate a unique 32+ character secret for signed evidence URLs."),
  checkRequired("STRIPE_SECRET_KEY", "Stripe secret key", "Use Stripe test mode first; set STRIPE_SECRET_KEY before paid checkout."),
  checkRequired("STRIPE_WEBHOOK_SECRET", "Stripe webhook secret", "Forward signed Stripe CLI/webhook events and set STRIPE_WEBHOOK_SECRET."),
  checkRequired("STRIPE_PRICE_MONTHLY", "Stripe paid user monthly price ID", "Create the user monthly recurring price and set STRIPE_PRICE_MONTHLY."),
  checkRequired("STRIPE_PRICE_YEARLY", "Stripe paid user yearly price ID", "Create the user yearly recurring price and set STRIPE_PRICE_YEARLY."),
  checkRequired("STRIPE_PLUS_PRICE_ID", "Stripe Plus venue price ID", "Create the Plus recurring price and set STRIPE_PLUS_PRICE_ID."),
  checkRequired("STRIPE_PRO_PRICE_ID", "Stripe Pro venue price ID", "Create the Pro recurring price and set STRIPE_PRO_PRICE_ID."),
  checkRequired("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "Stripe publishable key", "Set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY so browser checkout can initialise safely."),
  checkRequired("POS_WEBHOOK_SIGNING_SECRET", "POS webhook signing secret", "Generate a unique 32+ character POS_WEBHOOK_SIGNING_SECRET before enabling POS integrations."),
  checkNoTestKeyInProduction("STRIPE_SECRET_KEY", "Stripe secret key is live-mode in production", "sk_test_"),
  checkNoTestKeyInProduction("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "Stripe publishable key is live-mode in production", "pk_test_"),
  checkRequired("ADMIN_EMAILS", "Production admin allowlist", "Set ADMIN_EMAILS to the verified owner/admin email before enabling admin access."),
  {
    id: "REPORT_TIMEZONE",
    label: "Monthly report timezone",
    status: process.env.REPORT_TIMEZONE === "Australia/Melbourne" ? "pass" : "warn",
    action: process.env.REPORT_TIMEZONE === "Australia/Melbourne"
      ? null
      : "Set REPORT_TIMEZONE=Australia/Melbourne unless you intentionally change the reporting market.",
  },
  {
    id: "REPORT_EMAIL_MODE",
    label: "Report email delivery mode",
    status: process.env.REPORT_EMAIL_MODE === "disabled" || process.env.REPORT_EMAIL_MODE === "mock" ? "pass" : "warn",
    action: process.env.REPORT_EMAIL_MODE === "disabled" || process.env.REPORT_EMAIL_MODE === "mock"
      ? null
      : "Set REPORT_EMAIL_MODE=disabled for production until a real email provider is integrated; use mock only in staging/tests.",
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
      ? "Set ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION=false and use SOURCE_EVIDENCE_STORAGE_DIR for private field-upload evidence."
      : null,
  },
];

const failed = checks.filter((check) => check.status === "fail");
const warned = checks.filter((check) => check.status === "warn");

console.log(JSON.stringify({
  ok: failed.length === 0,
  environment: process.env.NODE_ENV ?? "development",
  summary: {
    passed: checks.filter((check) => check.status === "pass").length,
    warnings: warned.length,
    failures: failed.length,
  },
  checks,
}, null, 2));

if (failed.length > 0) {
  process.exit(1);
}
