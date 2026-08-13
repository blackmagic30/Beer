import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { extractData } from "../extract.js";

import {
  PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_COST_PUBLIC_PLANNING_REVIEW,
  PERMANENT_STAGING_COST_PUBLIC_REMEDIATION_DESIGN,
  PERMANENT_STAGING_COST_POLICY_LOCK,
  PERMANENT_STAGING_COST_POLICY_PATH,
  auditPermanentStagingPublicPlanningCost,
  auditPermanentStagingPublicRemediationDesign,
  evaluatePermanentStagingCost,
  parsePermanentStagingCostPolicy,
} from "../scripts/lib/permanent-staging-cost-policy.js";

const INVENTORY_SHA256 = "a".repeat(64);
const PRICE_CATALOG_SHA256 = "b".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
});

function executableProviderSourcesMatching(pattern: RegExp): string[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: process.cwd() },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((filename) => /\.(?:cjs|cts|js|mjs|mts|ts)$/.test(filename))
    .filter((filename) => !filename.startsWith("test/") && !filename.includes("node_modules/"))
    .filter((filename) => pattern.test(fs.readFileSync(path.resolve(filename), "utf8")))
    .sort();
}

function observation() {
  return {
    environment: "permanent-staging",
    scope: "permanent-staging-only",
    currency: "USD",
    lineItemRounding: "ceiling",
    providerInventorySha256: INVENTORY_SHA256,
    priceCatalogSha256: PRICE_CATALOG_SHA256,
    providerInventoryComplete: true,
    priceCatalogComplete: true,
    unknownResourceCount: 0,
    unpricedResourceCount: 0,
    lineItems: [
      {
        resourceIdentitySha256: "c".repeat(64),
        recurringMonthlyCents: 2_900,
      },
      {
        resourceIdentitySha256: "d".repeat(64),
        recurringMonthlyCents: 2_100,
      },
    ],
  };
}

describe("permanent staging cost policy", () => {
  it("pins canonical policy bytes, an integer-cent USD ceiling, and excluded non-staging scopes", () => {
    const checkedIn = fs.readFileSync(
      path.resolve(PERMANENT_STAGING_COST_POLICY_PATH),
      "utf8",
    );
    expect(checkedIn).toBe(PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE);
    expect(crypto.createHash("sha256").update(checkedIn).digest("hex")).toBe(
      "895d5bdcfe0fb05d17b3fa7cab6c525a80f3beacf0ff0cbd1bafdb54c979c8ca",
    );
    expect(PERMANENT_STAGING_COST_POLICY_LOCK).toMatchObject({
      activationState: "SCAFFOLD_ONLY_PROVIDER_OBSERVATION_REQUIRED",
      environment: "permanent-staging",
      currency: "USD",
      maximumRecurringMonthlyCents: 5_000,
      calculationContract: {
        amountUnit: "integer-cents",
        lineItemRounding: "ceiling",
        creditsOrNegativeAmountsAllowed: false,
      },
      evidenceContract: {
        providerCollectorImplemented: false,
        providerObservationBindingImplemented: false,
        scope: "permanent-staging-only",
        productionOperationalCopyExcluded: true,
        disposableRestoreExcluded: true,
        preDeploymentReceiptRequired: true,
        postDeploymentReceiptRequired: true,
      },
    });
    expect(Number.isSafeInteger(
      PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents,
    )).toBe(true);
    expect(Object.isFrozen(PERMANENT_STAGING_COST_POLICY_LOCK)).toBe(true);
    expect(Object.isFrozen(
      PERMANENT_STAGING_COST_POLICY_LOCK.calculationContract,
    )).toBe(true);
    expect(Object.isFrozen(
      PERMANENT_STAGING_COST_POLICY_LOCK.evidenceContract,
    )).toBe(true);
  });

  it("accepts only the exact canonical policy source", () => {
    const parsed = parsePermanentStagingCostPolicy(
      PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE,
    );
    expect(parsed).not.toBeNull();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsePermanentStagingCostPolicy(
      PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE.trimEnd(),
    )).toBeNull();
    expect(parsePermanentStagingCostPolicy(JSON.stringify(parsed))).toBeNull();
    expect(parsePermanentStagingCostPolicy({ toString: () => "trusted" }))
      .toBeNull();
    expect(parsePermanentStagingCostPolicy(
      PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE.replace(
        '  "policyId":',
        '  "schemaVersion": "pintpath-permanent-staging-cost-policy/v1",\n  "policyId":',
      ),
    )).toBeNull();
  });

  it("never turns a caller-declared observation into cost proof", () => {
    expect(evaluatePermanentStagingCost(observation())).toEqual({
      passed: false,
      evaluatorState: "scaffold-only",
      currency: "USD",
      maximumRecurringMonthlyCents: 5_000,
      declaredRecurringMonthlyCents: 5_000,
      failureCodes: ["provider_observation_not_implemented"],
    });
  });

  it("proves the reviewed configuration is already over budget before unknown recurring items", () => {
    expect(PERMANENT_STAGING_COST_PUBLIC_PLANNING_REVIEW).toMatchObject({
      classification: "REVIEWED_PUBLIC_PRICING_PLANNING_ONLY",
      providerObservationPerformed: false,
      liveResourceInventoryVerified: false,
      livePriceCatalogVerified: false,
      recurringCostAuthorityGranted: false,
      railwayPublishedPrices: {
        proPlanMonthlyCents: 2_000,
        cpuPerVcpuMonthCents: 2_000,
        memoryPerGbMonthCents: 1_000,
        volumePerGbMonthCents: 15,
        egressPerGbCents: 5,
      },
      reviewedRailwayStagingMaxima: {
        beer: {
          replicaCount: 1,
          cpuMilliVcpuPerReplica: 100,
          memoryMbPerReplica: 500,
        },
        postgres: {
          replicaCount: 1,
          cpuMilliVcpuPerReplica: 100,
          memoryMbPerReplica: 500,
          volumeMaximumGb: 50,
        },
        redis: {
          replicaCount: 1,
          cpuMilliVcpuPerReplica: 100,
          memoryMbPerReplica: 250,
        },
      },
      supabasePublishedPrices: {
        proPlanMonthlyCents: 2_500,
        microComputeMaximumMonthlyCents: 1_000,
        standardMonthlyComputeEntitlementCents: 1_000,
      },
    });
    expect(auditPermanentStagingPublicPlanningCost()).toEqual({
      passed: false,
      authority: "planning-only",
      maximumRecurringMonthlyCents: 5_000,
      railwayConfiguredMaximumSubtotalCents: 2_600,
      supabaseOneMicroNetPublishedSubtotalCents: 2_500,
      configuredMaximumSubtotalBeforeUnknownsCents: 5_100,
      excessBeforeUnknownsCents: 100,
      unresolvedRecurringCategories: [
        "railway-environment-egress",
        "railway-non-postgres-volume-storage",
        "railway-volume-backup-snapshots",
        "supabase-spend-cap-and-uncovered-addon-inventory",
        "google-maps-and-places",
        "openai-menu-ocr",
        "resend-email",
      ],
      failureCodes: [
        "provider_observation_not_implemented",
        "configured_maximum_exceeds_ceiling_before_unknowns",
        "unknown_recurring_categories_present",
      ],
    });
  });

  it("keeps the documented US$45 infrastructure redesign non-authorizing until every external upper bound is proved", () => {
    expect(PERMANENT_STAGING_COST_PUBLIC_REMEDIATION_DESIGN).toMatchObject({
      classification: "PUBLIC_DOCUMENTATION_REMEDIATION_DESIGN_ONLY",
      providerObservationPerformed: false,
      providerMutationPerformed: false,
      liveConfigurationVerified: false,
      recurringCostAuthorityGranted: false,
      deploymentAuthorized: false,
      sources: {
        openAiGpt41Mini:
          "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
      },
      isolatedInfrastructureTarget: {
        railway: {
          requiredPlan: "Pro",
          dedicatedStagingOnlyWorkspaceRequired: true,
          sharedResourceCountRequired: 0,
          maximumMonthlyCents: 2_000,
          computeHardLimitRequired: true,
          agentUsageMustBeDisabledOrIndependentlyZeroBounded: true,
          currentConfiguredResourceMaximumFitsTarget: false,
        },
        supabase: {
          requiredPlan: "Pro",
          dedicatedStagingOnlyOrganizationRequired: true,
          exactProjectCount: 1,
          exactComputeSize: "Micro",
          maximumMonthlyCents: 2_500,
          spendCapRequired: true,
          awsMarketplaceForbidden: true,
          uncoveredAddonCountRequired: 0,
          billingAddonInventoryPermission: "infra_add_ons_read",
        },
        maximumMonthlyCents: 4_500,
        remainingForAllExternalProvidersCents: 500,
      },
      externalProviderTarget: {
        resend: {
          requiredPlan: "Free",
          maximumMonthlyCents: 0,
          transactionalMonthlyQuota: 3_000,
          transactionalDailyQuota: 100,
          paidOverageForbidden: true,
        },
        googleMapsAndPlaces: {
          adjustableQuotaLimitsStopRequests: true,
          cloudBudgetIsNotAHardCap: true,
          quotaAndBillingCanDiffer: true,
          documentedMonthlyHardQuotaAvailableForEverySurface: false,
          applicationMonthlyRequestReservationLedgerImplemented: false,
          reviewedSourceSurfaces: [
            expect.objectContaining({
              api: "Maps JavaScript API",
              sku: "Dynamic Maps",
              documentedQuotaPeriod: "per-minute",
            }),
            expect.objectContaining({
              api: "Directions API (Legacy)",
              sku: "Directions",
              permanentStagingFeatureMustRemainDisabled: true,
            }),
            expect.objectContaining({ api: "Geocoding API", sku: "Geocoding" }),
            expect.objectContaining({ api: "Places API (New)", sku: "Text Search Pro" }),
            expect.objectContaining({ api: "Places API (New)", sku: "Text Search Enterprise" }),
            expect.objectContaining({ api: "Places API (New)", sku: "Nearby Search Enterprise" }),
            expect.objectContaining({ api: "Places API (New)", sku: "Place Details Enterprise" }),
          ],
          maximumMonthlyCents: null,
        },
        openAiMenuOcr: {
          enforcedHardSpendLimitRequired: true,
          hardLimitEnforcementIsInstantaneous: false,
          documentedOvershootMaximumCents: null,
          requestHardeningImplemented: true,
          sdkAutomaticRetryCount: 0,
          imageDetail: "high",
          maximumOutputTokensPerCall: 8_192,
          maximumAdminModelCallsPerSubmission: 3,
          maximumDiscoveryModelCallsPerImage: 2,
          applicationRollingRequestReservationLedgerImplemented: true,
          environmentModelOverrideAllowlistImplemented: true,
          exactAllowedModelIds: [
            "gpt-5.6-sol",
            "gpt-4.1",
            "gpt-4.1-mini-2025-04-14",
          ],
          costBoundRuntimeTarget: {
            activationObserved: false,
            exactModel: "gpt-4.1-mini-2025-04-14",
            budgetWindow: "rolling-31-day",
            windowClockAuthority: "shared-database-clock",
            maximumImagePatchBudget: 1_536,
            imageTokenMultiplierHundredths: 162,
            maximumImagesPerCall: 6,
            pdfInputsAllowed: false,
            maximumPromptAndSchemaBytes: 49_152,
            protocolTokenHeadroom: 10_000,
            maximumOutputTokensPerCall: 8_192,
            reservedCentsPerAttempt: 5,
            maximumMonthlyCents: 100,
            standaloneDiscoveryOcrAllowed: false,
            labelledCorpusBenchmarkRequired: true,
            livePriceCatalogVerificationRequired: true,
          },
          maximumMonthlyCents: null,
        },
      },
    });
    expect(auditPermanentStagingPublicRemediationDesign()).toEqual({
      passed: false,
      authority: "design-only",
      maximumRecurringMonthlyCents: 5_000,
      isolatedInfrastructureTargetCents: 4_500,
      remainingForAllExternalProvidersCents: 500,
      externalProviderUpperBoundCents: null,
      unresolvedDesignBlockers: [
        "railway-agent-usage-zero-bound-not-proved",
        "current-railway-resource-maximum-exceeds-workspace-target",
        "google-live-api-sku-quota-and-monthly-billing-upper-bound-not-proved",
        "openai-cost-bound-runtime-and-provider-account-not-live-observed",
        "live-provider-plan-cap-addon-and-isolation-state-not-observed",
      ],
      failureCodes: [
        "provider_observation_not_implemented",
        "provider_mutation_not_authorized",
        "external_provider_upper_bound_not_proved",
        "current_configuration_does_not_fit_remediation_target",
      ],
    });
  });

  it("pins finite OpenAI OCR request bounds while keeping live cost authority fail-closed", () => {
    const adminSource = fs.readFileSync(
      path.resolve("src/modules/admin/admin.service.ts"),
      "utf8",
    );
    const discoverySource = fs.readFileSync(
      path.resolve("scripts/discover-menu-sources.ts"),
      "utf8",
    );
    const budgetSource = fs.readFileSync(
      path.resolve("src/lib/external-provider-cost-budget.ts"),
      "utf8",
    );
    const legacyExtractSource = fs.readFileSync(path.resolve("extract.js"), "utf8");

    for (const source of [adminSource, discoverySource]) {
      expect(source).toContain("max_output_tokens:");
      expect(source).toMatch(/detail:\s*"high"/);
      expect(source).toContain("maxRetries: 0");
    }
    expect(adminSource).toContain("OPENAI_MENU_OCR_COST_BOUND_MAX_OUTPUT_TOKENS");
    expect(discoverySource).toMatch(/MAX_OUTPUT_TOKENS\s*=\s*8_192/);
    expect(adminSource).not.toContain('detail: "original"');
    expect(budgetSource).toContain("rolling-31-day");
    expect(budgetSource).toContain("pg_catalog.clock_timestamp()");
    expect(legacyExtractSource).not.toMatch(/require\(["']openai["']\)|OPENAI_API_KEY|responses\.create|chat\.completions/);
    expect(
      PERMANENT_STAGING_COST_PUBLIC_REMEDIATION_DESIGN.externalProviderTarget
        .openAiMenuOcr.maximumMonthlyCents,
    ).toBeNull();
    expect(executableProviderSourcesMatching(/\bnew\s+OpenAI\s*\(/)).toEqual([
      "scripts/discover-menu-sources.ts",
      "src/modules/admin/admin.service.ts",
    ]);
    expect(executableProviderSourcesMatching(/\.responses\.create\s*\(/)).toEqual([
      "scripts/discover-menu-sources.ts",
      "src/modules/admin/admin.service.ts",
    ]);
    expect(executableProviderSourcesMatching(/\.chat\.completions\.create\s*\(/))
      .toEqual([]);
  });

  it("keeps the legacy ESM extractor callable but fails before provider access", async () => {
    const providerFetch = vi.fn(async () => {
      throw new Error("provider transport must remain unreachable");
    });
    vi.stubGlobal("fetch", providerFetch);

    await expect(extractData()).rejects.toThrow(
      "Legacy extractData provider access is disabled; use the reviewed menu OCR service boundary.",
    );
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed for incomplete evidence, unknown prices, and a breached ceiling", () => {
    const value = observation();
    value.providerInventoryComplete = false;
    value.priceCatalogComplete = false;
    value.unknownResourceCount = 1;
    value.unpricedResourceCount = 2;
    value.lineItems[1]!.recurringMonthlyCents = 2_101;
    expect(evaluatePermanentStagingCost(value)).toEqual({
      passed: false,
      evaluatorState: "scaffold-only",
      currency: "USD",
      maximumRecurringMonthlyCents: 5_000,
      declaredRecurringMonthlyCents: 5_001,
      failureCodes: [
        "provider_observation_not_implemented",
        "provider_inventory_incomplete",
        "price_catalog_incomplete",
        "unknown_resources_present",
        "unpriced_resources_present",
        "ceiling_exceeded",
      ],
    });
  });

  it.each([
    ["wrong currency", { currency: "AUD" }],
    ["wrong environment", { environment: "production" }],
    ["wrong scope", { scope: "combined-staging-and-production-copy" }],
    ["non-ceiling rounding", { lineItemRounding: "nearest" }],
    ["invalid inventory hash", { providerInventorySha256: "a" }],
    ["negative unknown count", { unknownResourceCount: -1 }],
    ["fractional unpriced count", { unpricedResourceCount: 0.5 }],
    ["empty line items", { lineItems: [] }],
    ["unknown key", { unknown: true }],
  ])("rejects an invalid observation: %s", (_label, override) => {
    expect(evaluatePermanentStagingCost({
      ...observation(),
      ...override,
    })).toMatchObject({
      passed: false,
      evaluatorState: "scaffold-only",
      declaredRecurringMonthlyCents: null,
      failureCodes: ["observation_invalid"],
    });
  });

  it("rejects duplicate resource identities, non-integer amounts, and aggregate overflow", () => {
    const duplicate = observation();
    duplicate.lineItems[1]!.resourceIdentitySha256 =
      duplicate.lineItems[0]!.resourceIdentitySha256;
    expect(evaluatePermanentStagingCost(duplicate).failureCodes)
      .toEqual(["observation_invalid"]);

    const fractional = observation();
    fractional.lineItems[0]!.recurringMonthlyCents = 1.1;
    expect(evaluatePermanentStagingCost(fractional).failureCodes)
      .toEqual(["observation_invalid"]);

    const overflow = observation();
    overflow.lineItems[0]!.recurringMonthlyCents = Number.MAX_SAFE_INTEGER;
    overflow.lineItems[1]!.recurringMonthlyCents = 1;
    expect(evaluatePermanentStagingCost(overflow)).toMatchObject({
      declaredRecurringMonthlyCents: null,
      failureCodes: ["observation_invalid"],
    });
  });

  it("has no provider, environment, credential, filesystem, or network capability", () => {
    const source = fs.readFileSync(path.resolve(
      "scripts/lib/permanent-staging-cost-policy.ts",
    ), "utf8");
    expect(source).not.toMatch(/^import\s/m);
    for (const forbidden of [
      "process.env",
      "process.argv",
      "node:fs",
      "fetch(",
      "https.request",
      "RAILWAY_TOKEN",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]) expect(source).not.toContain(forbidden);
  });
});
