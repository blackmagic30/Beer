import { isIP } from "node:net";

import {
  PERMANENT_STAGING_SUPABASE_ORIGIN,
  PRODUCTION_SUPABASE_AUTH_ORIGIN,
} from "../../src/lib/supabase-key-format.js";

export const PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN = "https://pintpath.au";

export type MenuDiscoveryEnvironmentKind =
  | "production"
  | "permanent-staging"
  | "local";

export interface MenuDiscoveryEnvironmentTarget {
  kind: MenuDiscoveryEnvironmentKind;
  adminOrigin: string;
  supabaseOrigin: string | null;
}

interface ResolveMenuDiscoveryEnvironmentTargetOptions {
  adminTransportRequired: boolean;
}

const CANONICAL_PRODUCTION_HOSTS = new Set([
  "pintpath.au",
  "www.pintpath.au",
  "pintpath.com.au",
  "www.pintpath.com.au",
]);

const PERMANENT_STAGING_RAILWAY_IDENTITY = Object.freeze({
  RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  RAILWAY_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
} as const);

const RESOURCE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const UNSAFE_RESOURCE_IDENTITY_PATTERN =
  /(?:^|[._:-])(?:change[-_]?me|dummy|example|fake|fixture|placeholder|replace(?:[-_]?with)?|test)(?:$|[._:-])/i;
const RAILWAY_DOMAIN_PATTERN =
  /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function invalidTarget(reason: string): never {
  throw new Error(
    `Menu discovery environment target is invalid (${reason}); no configured value is emitted.`,
  );
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isReviewedResourceIdentity(value: string): boolean {
  return RESOURCE_IDENTITY_PATTERN.test(value)
    && !UNSAFE_RESOURCE_IDENTITY_PATTERN.test(value);
}

function exactLoopbackOrigin(value: string, reason: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidTarget(reason);
  }
  if (
    parsed.origin !== value
    || !["http:", "https:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    return invalidTarget(reason);
  }
  return parsed.origin;
}

function exactRailwayPublicDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (
    !RAILWAY_DOMAIN_PATTERN.test(domain)
    || !domain.endsWith(".up.railway.app")
    || isIP(domain) !== 0
    || CANONICAL_PRODUCTION_HOSTS.has(domain)
  ) {
    return invalidTarget("railway_public_domain");
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${domain}`);
  } catch {
    return invalidTarget("railway_public_domain");
  }
  if (
    parsed.origin !== `https://${domain}`
    || parsed.hostname !== domain
    || parsed.port
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    return invalidTarget("railway_public_domain");
  }
  return domain;
}

function assertExactPermanentStagingIdentity(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const pairs = [
    ["RAILWAY_PROJECT_ID", "PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID"],
    ["RAILWAY_ENVIRONMENT_ID", "PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID"],
    ["RAILWAY_SERVICE_ID", "PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID"],
  ] as const;
  for (const [actualName, expectedName] of pairs) {
    const actual = optionalValue(environment[actualName]);
    const expected = optionalValue(environment[expectedName]);
    if (
      !actual
      || !expected
      || !isReviewedResourceIdentity(actual)
      || !isReviewedResourceIdentity(expected)
      || actual !== expected
      || actual !== PERMANENT_STAGING_RAILWAY_IDENTITY[actualName]
    ) {
      invalidTarget("permanent_staging_railway_identity");
    }
  }
}

function resolveProductionTarget(
  environment: Readonly<Record<string, string | undefined>>,
  adminTransportRequired: boolean,
): MenuDiscoveryEnvironmentTarget {
  const configuredSupabaseOrigin = optionalValue(environment.SUPABASE_URL);
  if (
    configuredSupabaseOrigin
    && configuredSupabaseOrigin !== PRODUCTION_SUPABASE_AUTH_ORIGIN
  ) {
    invalidTarget("production_supabase_origin");
  }

  const configuredAdminOrigin = optionalValue(
    environment.MENU_DISCOVERY_ADMIN_BASE_URL,
  );
  const publicBaseUrl = optionalValue(environment.PUBLIC_BASE_URL);
  if (adminTransportRequired) {
    if (
      (configuredAdminOrigin
        && configuredAdminOrigin !== PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN)
      || (publicBaseUrl
        && publicBaseUrl !== PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN)
      || (configuredAdminOrigin ?? publicBaseUrl)
        !== PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN
    ) {
      invalidTarget("production_admin_origin");
    }
  }

  return {
    kind: "production",
    adminOrigin: PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
    supabaseOrigin: PRODUCTION_SUPABASE_AUTH_ORIGIN,
  };
}

function resolvePermanentStagingTarget(
  environment: Readonly<Record<string, string | undefined>>,
): MenuDiscoveryEnvironmentTarget {
  assertExactPermanentStagingIdentity(environment);
  if (optionalValue(environment.SUPABASE_URL) !== PERMANENT_STAGING_SUPABASE_ORIGIN) {
    invalidTarget("permanent_staging_supabase_origin");
  }

  const railwayPublicDomain = optionalValue(environment.RAILWAY_PUBLIC_DOMAIN);
  if (!railwayPublicDomain) {
    invalidTarget("railway_public_domain");
  }
  const expectedAdminOrigin = `https://${exactRailwayPublicDomain(railwayPublicDomain)}`;
  if (optionalValue(environment.PUBLIC_BASE_URL) !== expectedAdminOrigin) {
    invalidTarget("permanent_staging_public_base_url");
  }
  const configuredAdminOrigin = optionalValue(
    environment.MENU_DISCOVERY_ADMIN_BASE_URL,
  );
  if (configuredAdminOrigin && configuredAdminOrigin !== expectedAdminOrigin) {
    invalidTarget("permanent_staging_admin_origin");
  }

  return {
    kind: "permanent-staging",
    adminOrigin: expectedAdminOrigin,
    supabaseOrigin: PERMANENT_STAGING_SUPABASE_ORIGIN,
  };
}

function resolveLocalTarget(
  environment: Readonly<Record<string, string | undefined>>,
  adminTransportRequired: boolean,
): MenuDiscoveryEnvironmentTarget {
  const configuredSupabaseOrigin = optionalValue(environment.SUPABASE_URL);
  const supabaseOrigin = configuredSupabaseOrigin
    ? exactLoopbackOrigin(configuredSupabaseOrigin, "local_supabase_origin")
    : null;
  const configuredAdminOrigin = optionalValue(
    environment.MENU_DISCOVERY_ADMIN_BASE_URL,
  ) ?? optionalValue(environment.PUBLIC_BASE_URL)
    ?? "http://localhost:3000";
  const adminOrigin = adminTransportRequired
    ? exactLoopbackOrigin(configuredAdminOrigin, "local_admin_origin")
    : "http://localhost:3000";

  return {
    kind: "local",
    adminOrigin,
    supabaseOrigin,
  };
}

export function resolveMenuDiscoveryEnvironmentTarget(
  environment: Readonly<Record<string, string | undefined>>,
  options: ResolveMenuDiscoveryEnvironmentTargetOptions,
): MenuDiscoveryEnvironmentTarget {
  const nodeEnvironment = optionalValue(environment.NODE_ENV)?.toLowerCase()
    ?? "development";
  if (!["development", "test", "production"].includes(nodeEnvironment)) {
    invalidTarget("node_environment");
  }

  const actualRailwayNames = [
    "RAILWAY_ENVIRONMENT_NAME",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_ENVIRONMENT_ID",
    "RAILWAY_SERVICE_ID",
    "RAILWAY_PUBLIC_DOMAIN",
  ] as const;
  const actualRailwayValues = actualRailwayNames.map((name) =>
    optionalValue(environment[name])
  );
  const railwaySignalCount = actualRailwayValues.filter(Boolean).length;
  const railwayEnvironmentName = optionalValue(
    environment.RAILWAY_ENVIRONMENT_NAME,
  )?.toLowerCase();

  if (railwaySignalCount > 0 && railwaySignalCount !== actualRailwayNames.length) {
    invalidTarget("partial_railway_runtime");
  }
  if (railwaySignalCount > 0 && nodeEnvironment !== "production") {
    invalidTarget("railway_node_environment");
  }
  if (
    railwaySignalCount > 0
    && railwayEnvironmentName !== "production"
    && railwayEnvironmentName !== "staging"
  ) {
    invalidTarget("railway_environment_name");
  }

  if (railwayEnvironmentName === "staging") {
    return resolvePermanentStagingTarget(environment);
  }
  if (railwayEnvironmentName === "production" || nodeEnvironment === "production") {
    return resolveProductionTarget(
      environment,
      options.adminTransportRequired,
    );
  }
  return resolveLocalTarget(environment, options.adminTransportRequired);
}
