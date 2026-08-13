import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
  resolveMenuDiscoveryEnvironmentTarget,
} from "../scripts/lib/menu-discovery-environment-target.js";
import {
  PERMANENT_STAGING_SUPABASE_ORIGIN,
  PRODUCTION_SUPABASE_AUTH_ORIGIN,
} from "../src/lib/supabase-key-format.js";

const STAGING_DOMAIN = "pint-path-permanent-staging.up.railway.app";
const STAGING_ORIGIN = `https://${STAGING_DOMAIN}`;
const STAGING_PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const STAGING_SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";

const permanentStagingEnvironment = Object.freeze({
  NODE_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_PROJECT_ID: STAGING_PROJECT_ID,
  RAILWAY_ENVIRONMENT_ID: STAGING_ENVIRONMENT_ID,
  RAILWAY_SERVICE_ID: STAGING_SERVICE_ID,
  RAILWAY_PUBLIC_DOMAIN: STAGING_DOMAIN,
  PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID: STAGING_PROJECT_ID,
  PINTPATH_PERMANENT_STAGING_RAILWAY_ENVIRONMENT_ID: STAGING_ENVIRONMENT_ID,
  PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID: STAGING_SERVICE_ID,
  SUPABASE_URL: PERMANENT_STAGING_SUPABASE_ORIGIN,
  PUBLIC_BASE_URL: STAGING_ORIGIN,
});

describe("menu discovery environment target", () => {
  it("pins an explicit non-Railway production run to the canonical origins", () => {
    expect(resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "production",
      SUPABASE_URL: PRODUCTION_SUPABASE_AUTH_ORIGIN,
      PUBLIC_BASE_URL: PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
    }, { adminTransportRequired: true })).toEqual({
      kind: "production",
      adminOrigin: PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
      supabaseOrigin: PRODUCTION_SUPABASE_AUTH_ORIGIN,
    });
  });

  it("accepts a complete Railway production runtime but never its Railway domain as the admin target", () => {
    expect(resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "production",
      RAILWAY_PROJECT_ID: "project_01prod23456789ab",
      RAILWAY_ENVIRONMENT_ID: "environment_01prod23456789ab",
      RAILWAY_SERVICE_ID: "service_01prod23456789ab",
      RAILWAY_PUBLIC_DOMAIN: "pint-path-production.up.railway.app",
      SUPABASE_URL: PRODUCTION_SUPABASE_AUTH_ORIGIN,
      PUBLIC_BASE_URL: PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
    }, { adminTransportRequired: true })).toEqual({
      kind: "production",
      adminOrigin: PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
      supabaseOrigin: PRODUCTION_SUPABASE_AUTH_ORIGIN,
    });
  });

  it("binds permanent staging to its reviewed Railway tuple, Supabase project, and public domain", () => {
    expect(resolveMenuDiscoveryEnvironmentTarget({
      ...permanentStagingEnvironment,
      MENU_DISCOVERY_ADMIN_BASE_URL: STAGING_ORIGIN,
    }, { adminTransportRequired: true })).toEqual({
      kind: "permanent-staging",
      adminOrigin: STAGING_ORIGIN,
      supabaseOrigin: PERMANENT_STAGING_SUPABASE_ORIGIN,
    });
  });

  it("keeps local Supabase reads and admin writes on exact loopback origins", () => {
    expect(resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "development",
      SUPABASE_URL: "http://127.0.0.1:54321",
      MENU_DISCOVERY_ADMIN_BASE_URL: "http://[::1]:3000",
    }, { adminTransportRequired: true })).toEqual({
      kind: "local",
      adminOrigin: "http://[::1]:3000",
      supabaseOrigin: "http://127.0.0.1:54321",
    });
  });

  it("fails closed for partial, preview, or development-mode Railway runtimes", () => {
    expect(() => resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "staging",
    }, { adminTransportRequired: false })).toThrow("partial_railway_runtime");

    expect(() => resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "preview",
      RAILWAY_PROJECT_ID: "project_01preview234567",
      RAILWAY_ENVIRONMENT_ID: "environment_01preview234567",
      RAILWAY_SERVICE_ID: "service_01preview234567",
      RAILWAY_PUBLIC_DOMAIN: "pint-path-preview.up.railway.app",
    }, { adminTransportRequired: false })).toThrow("railway_environment_name");

    expect(() => resolveMenuDiscoveryEnvironmentTarget({
      ...permanentStagingEnvironment,
      NODE_ENV: "development",
    }, { adminTransportRequired: false })).toThrow("railway_node_environment");
  });

  it("rejects every mixed or weak permanent-staging binding", () => {
    const rejectedEnvironments = [
      {
        ...permanentStagingEnvironment,
        PINTPATH_PERMANENT_STAGING_RAILWAY_SERVICE_ID:
          "service_01different234567",
      },
      {
        ...permanentStagingEnvironment,
        SUPABASE_URL: PRODUCTION_SUPABASE_AUTH_ORIGIN,
      },
      {
        ...permanentStagingEnvironment,
        PUBLIC_BASE_URL: `${STAGING_ORIGIN}/`,
      },
      {
        ...permanentStagingEnvironment,
        MENU_DISCOVERY_ADMIN_BASE_URL: PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
      },
      {
        ...permanentStagingEnvironment,
        RAILWAY_PROJECT_ID: "project_01abc234def567gh",
        PINTPATH_PERMANENT_STAGING_RAILWAY_PROJECT_ID:
          "project_01abc234def567gh",
      },
      {
        ...permanentStagingEnvironment,
        RAILWAY_PUBLIC_DOMAIN: "pintpath.au",
        PUBLIC_BASE_URL: PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
      },
      {
        ...permanentStagingEnvironment,
        RAILWAY_PUBLIC_DOMAIN: "attacker.example.com",
        PUBLIC_BASE_URL: "https://attacker.example.com",
        MENU_DISCOVERY_ADMIN_BASE_URL: "https://attacker.example.com",
      },
    ];

    for (const environment of rejectedEnvironments) {
      expect(() => resolveMenuDiscoveryEnvironmentTarget(
        environment,
        { adminTransportRequired: true },
      )).toThrow("Menu discovery environment target is invalid");
    }
  });

  it("rejects cross-environment hosted and non-loopback local transports", () => {
    expect(() => resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "production",
      SUPABASE_URL: PERMANENT_STAGING_SUPABASE_ORIGIN,
      PUBLIC_BASE_URL: PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN,
    }, { adminTransportRequired: true })).toThrow("production_supabase_origin");

    expect(() => resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "production",
      SUPABASE_URL: PRODUCTION_SUPABASE_AUTH_ORIGIN,
      PUBLIC_BASE_URL: `${PRODUCTION_MENU_DISCOVERY_ADMIN_ORIGIN}/`,
    }, { adminTransportRequired: true })).toThrow("production_admin_origin");

    expect(() => resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "test",
      SUPABASE_URL: PRODUCTION_SUPABASE_AUTH_ORIGIN,
    }, { adminTransportRequired: false })).toThrow("local_supabase_origin");

    expect(() => resolveMenuDiscoveryEnvironmentTarget({
      NODE_ENV: "development",
      MENU_DISCOVERY_ADMIN_BASE_URL: "https://staging.example.com",
    }, { adminTransportRequired: true })).toThrow("local_admin_origin");
  });

  it("wires one resolved target into Supabase loading and queue transport", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/discover-menu-sources.ts"),
      "utf8",
    );
    const main = source.slice(source.indexOf("async function main()"));
    const queueTransport = source.slice(
      source.indexOf("async function maybeQueueDirectImage("),
      source.indexOf("async function main()"),
    );

    expect(main.indexOf("resolveMenuDiscoveryEnvironmentTarget(process.env"))
      .toBeLessThan(main.indexOf("loadSupabaseVenues(limit, environmentTarget)"));
    expect(source).toContain("assertExactSupabaseOrigin(supabaseUrl, environmentTarget.supabaseOrigin)");
    expect(source).toContain("maybeQueueDirectImage(candidate, environmentTarget)");
    expect(queueTransport).toContain("environmentTarget.adminOrigin");
    expect(queueTransport).not.toContain('process.env.NODE_ENV === "production"');
  });
});
