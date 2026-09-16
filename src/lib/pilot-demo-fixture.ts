/** Reserved, isolated fixture identity shared by preparation and publication. */
export const PILOT_DEMO_VENUE_ID = "pintpath-pilot-demo:venue:v1";
export const PILOT_DEMO_NAME = "PintPath Pilot Hotel — DEMO";
export const PILOT_DEMO_FIXTURE_KEY = "pilot-demo:fixture:v1";
export const PILOT_DEMO_STAGING_ORIGIN = "https://beer-staging.up.railway.app";
export const PILOT_DEMO_STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";

export interface PilotDemoBinding {
  version: 1;
  venueId: string;
  operator: string;
  manager: string;
  staff: string;
  customer: string;
}

interface PublicationConfig {
  NODE_ENV: string;
  PUBLIC_BASE_URL: string;
  DATABASE_URL?: string | undefined;
  BAR_PILOT_ENABLED?: boolean;
  BAR_PILOT_DEMO_ENABLED?: boolean;
  BAR_PILOT_VENUE_IDS?: string | undefined;
  BAR_PILOT_DEMO_CUSTOMER_IDS?: string | undefined;
  RESTORE_REHEARSAL_MODE?: boolean;
  POSTGRES_RECOVERY_REHEARSAL_MODE?: boolean;
}

function includesId(value: string | undefined, id: string): boolean {
  return (value ?? "").split(",").some(entry => entry.trim() === id);
}

export function pilotDemoPublicationScopeAllowed(
  config: PublicationConfig,
  runtime: Readonly<Record<string, string | undefined>>,
): boolean {
  if (!config.BAR_PILOT_ENABLED || !config.BAR_PILOT_DEMO_ENABLED
    || !includesId(config.BAR_PILOT_VENUE_IDS, PILOT_DEMO_VENUE_ID)
    || !config.BAR_PILOT_DEMO_CUSTOMER_IDS?.trim()
    || config.RESTORE_REHEARSAL_MODE || config.POSTGRES_RECOVERY_REHEARSAL_MODE) return false;
  let origin: URL;
  try { origin = new URL(config.PUBLIC_BASE_URL); } catch { return false; }
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return false;
  const railwayKeys = ["RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"];
  if (config.NODE_ENV === "test" && origin.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    && railwayKeys.every(key => !runtime[key])) {
    try {
      const database = new URL(config.DATABASE_URL ?? "");
      return ["postgres:", "postgresql:"].includes(database.protocol)
        && ["localhost", "127.0.0.1"].includes(database.hostname)
        && /^\/pintpath_pilot_[a-z0-9_]+$/.test(database.pathname)
        && database.searchParams.get("sslmode") === "disable";
    } catch { return false; }
  }
  return config.NODE_ENV === "production" && origin.origin === PILOT_DEMO_STAGING_ORIGIN
    && runtime.RAILWAY_ENVIRONMENT_NAME === "staging"
    && runtime.RAILWAY_PROJECT_ID === "48d8c6cd-1c66-4148-874b-20877f48e1a5"
    && runtime.RAILWAY_ENVIRONMENT_ID === PILOT_DEMO_STAGING_ENVIRONMENT_ID
    && runtime.RAILWAY_SERVICE_ID === "6816c4a2-e392-4ee5-826f-2584cb599ec0";
}

export function pilotDemoBindingAllowsPublication(value: unknown, customerIds: string | undefined): value is PilotDemoBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const fields = ["version", "venueId", "operator", "manager", "staff", "customer"];
  if (Object.keys(binding).length !== fields.length || fields.some(key => !Object.hasOwn(binding, key))
    || binding.version !== 1 || binding.venueId !== PILOT_DEMO_VENUE_ID) return false;
  const roles = [binding.operator, binding.manager, binding.staff, binding.customer];
  return roles.every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id))
    && new Set(roles).size === 4
    && includesId(customerIds, binding.customer as string);
}
