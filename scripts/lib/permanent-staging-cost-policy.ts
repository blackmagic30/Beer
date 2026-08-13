export const PERMANENT_STAGING_COST_POLICY_SCHEMA =
  "pintpath-permanent-staging-cost-policy/v1" as const;
export const PERMANENT_STAGING_COST_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cost-receipt/v1" as const;
export const PERMANENT_STAGING_COST_POLICY_ID =
  "pintpath-permanent-staging-recurring-cost" as const;
export const PERMANENT_STAGING_COST_POLICY_PATH =
  "ops/railway/permanent-staging-cost-policy.json" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const PERMANENT_STAGING_COST_POLICY_LOCK = Object.freeze({
  policyId: PERMANENT_STAGING_COST_POLICY_ID,
  activationState: "SCAFFOLD_ONLY_PROVIDER_OBSERVATION_REQUIRED",
  environment: "permanent-staging",
  currency: "USD",
  maximumRecurringMonthlyCents: 5_000,
  calculationContract: Object.freeze({
    amountUnit: "integer-cents",
    lineItemRounding: "ceiling",
    aggregate: "sum",
    creditsOrNegativeAmountsAllowed: false,
  }),
  evidenceContract: Object.freeze({
    providerCollectorImplemented: false,
    providerObservationBindingImplemented: false,
    scope: "permanent-staging-only",
    providerInventoryRequired: true,
    completeProviderInventoryRequired: true,
    priceCatalogRequired: true,
    completePriceCatalogRequired: true,
    maximumUnknownResourceCount: 0,
    maximumUnpricedResourceCount: 0,
    productionOperationalCopyExcluded: true,
    disposableRestoreExcluded: true,
    preDeploymentReceiptRequired: true,
    postDeploymentReceiptRequired: true,
    receiptSchemaVersion: PERMANENT_STAGING_COST_RECEIPT_SCHEMA,
  }),
} as const);

/**
 * Public-price planning evidence reviewed on 2026-08-13. This is deliberately
 * not provider observation: it cannot prove the live plan, resource limits,
 * volume use, spend-cap state, add-ons, or external-provider configuration.
 *
 * The subtotal is still useful as a fail-closed design check. It applies the
 * checked-in permanent-staging maxima to the providers' published prices. A
 * complete live receipt cannot pass while this static configured subtotal is
 * already above the policy ceiling, even if every currently unknown item were
 * free.
 */
export const PERMANENT_STAGING_COST_PUBLIC_PLANNING_REVIEW = Object.freeze({
  classification: "REVIEWED_PUBLIC_PRICING_PLANNING_ONLY",
  reviewedAt: "2026-08-13T00:00:00.000Z",
  providerObservationPerformed: false,
  liveResourceInventoryVerified: false,
  livePriceCatalogVerified: false,
  recurringCostAuthorityGranted: false,
  sources: Object.freeze({
    railwayPricing: "https://docs.railway.com/pricing",
    railwayPlans: "https://docs.railway.com/pricing/plans",
    railwayVolumes: "https://docs.railway.com/volumes/reference",
    railwayCostControl: "https://docs.railway.com/pricing/cost-control",
    supabaseCompute:
      "https://supabase.com/docs/guides/platform/manage-your-usage/compute",
    supabaseCostControl:
      "https://supabase.com/docs/guides/platform/cost-control",
  }),
  railwayPublishedPrices: Object.freeze({
    proPlanMonthlyCents: 2_000,
    cpuPerVcpuMonthCents: 2_000,
    memoryPerGbMonthCents: 1_000,
    volumePerGbMonthCents: 15,
    egressPerGbCents: 5,
  }),
  reviewedRailwayStagingMaxima: Object.freeze({
    beer: Object.freeze({
      replicaCount: 1,
      cpuMilliVcpuPerReplica: 100,
      memoryMbPerReplica: 500,
    }),
    postgres: Object.freeze({
      replicaCount: 1,
      cpuMilliVcpuPerReplica: 100,
      memoryMbPerReplica: 500,
      volumeMaximumGb: 50,
    }),
    redis: Object.freeze({
      replicaCount: 1,
      cpuMilliVcpuPerReplica: 100,
      memoryMbPerReplica: 250,
    }),
  }),
  supabasePublishedPrices: Object.freeze({
    proPlanMonthlyCents: 2_500,
    microComputeMaximumMonthlyCents: 1_000,
    standardMonthlyComputeEntitlementCents: 1_000,
  }),
  unresolvedRecurringCategories: Object.freeze([
    "railway-environment-egress",
    "railway-non-postgres-volume-storage",
    "railway-volume-backup-snapshots",
    "supabase-spend-cap-and-uncovered-addon-inventory",
    "google-maps-and-places",
    "openai-menu-ocr",
    "resend-email",
  ] as const),
} as const);

/**
 * Credential-free remediation design derived from current public provider
 * documentation on 2026-08-13. This is a target for a future independently
 * observed receipt, not evidence that any account, workspace, cap, quota, or
 * plan currently has this shape. Creating or moving provider resources and
 * changing a spend limit remain separately authorized external mutations.
 */
export const PERMANENT_STAGING_COST_PUBLIC_REMEDIATION_DESIGN = Object.freeze({
  classification: "PUBLIC_DOCUMENTATION_REMEDIATION_DESIGN_ONLY",
  reviewedAt: "2026-08-13T00:00:00.000Z",
  providerObservationPerformed: false,
  providerMutationPerformed: false,
  liveConfigurationVerified: false,
  recurringCostAuthorityGranted: false,
  deploymentAuthorized: false,
  sources: Object.freeze({
    railwayCostControl: "https://docs.railway.com/pricing/cost-control",
    railwayPlans: "https://docs.railway.com/pricing/plans",
    supabaseCostControl:
      "https://supabase.com/docs/guides/platform/cost-control",
    supabaseBilling:
      "https://supabase.com/docs/guides/platform/billing-on-supabase",
    supabaseBillingAddonsApi:
      "https://supabase.com/docs/reference/api/introduction",
    googleMapsCostControl:
      "https://developers.google.com/maps/billing-and-pricing/manage-costs",
    googleMapsPricing:
      "https://developers.google.com/maps/billing-and-pricing/pricing",
    googlePlacesUsageAndBilling:
      "https://developers.google.com/maps/documentation/places/web-service/usage-and-billing",
    googleMapsJavaScriptUsageAndBilling:
      "https://developers.google.com/maps/documentation/javascript/usage-and-billing",
    googleGeocodingUsageAndBilling:
      "https://developers.google.com/maps/documentation/geocoding/usage-and-billing",
    googleDirectionsLegacyUsageAndBilling:
      "https://developers.google.com/maps/documentation/directions/usage-and-billing",
    openAiSpendLimits:
      "https://developers.openai.com/api/docs/guides/spend-limits",
    openAiGpt56Sol:
      "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    openAiGpt41Mini:
      "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
    openAiImageInputs:
      "https://developers.openai.com/api/docs/guides/images-vision",
    resendQuotas:
      "https://resend.com/docs/knowledge-base/account-quotas-and-limits",
  }),
  isolatedInfrastructureTarget: Object.freeze({
    railway: Object.freeze({
      requiredPlan: "Pro",
      dedicatedStagingOnlyWorkspaceRequired: true,
      sharedResourceCountRequired: 0,
      maximumMonthlyCents: 2_000,
      computeHardLimitRequired: true,
      computeHardLimitIncludes: Object.freeze([
        "cpu",
        "memory",
        "storage",
        "network-egress",
      ] as const),
      agentUsageMustBeDisabledOrIndependentlyZeroBounded: true,
      currentConfiguredResourceMaximumFitsTarget: false,
    }),
    supabase: Object.freeze({
      requiredPlan: "Pro",
      dedicatedStagingOnlyOrganizationRequired: true,
      exactProjectCount: 1,
      exactComputeSize: "Micro",
      maximumMonthlyCents: 2_500,
      spendCapRequired: true,
      awsMarketplaceForbidden: true,
      uncoveredAddonCountRequired: 0,
      uncoveredUsageItemsRequiredAbsent: Object.freeze([
        "branching-compute",
        "read-replica-compute",
        "custom-domain",
        "additionally-provisioned-disk-iops",
        "additionally-provisioned-disk-throughput",
        "ipv4-address",
        "log-drain-hours",
        "log-drain-events",
        "mfa-phone",
        "point-in-time-recovery",
      ] as const),
      billingAddonInventoryPermission: "infra_add_ons_read",
    }),
    maximumMonthlyCents: 4_500,
    remainingForAllExternalProvidersCents: 500,
  }),
  externalProviderTarget: Object.freeze({
    resend: Object.freeze({
      requiredPlan: "Free",
      dedicatedStagingTeamRequired: true,
      maximumMonthlyCents: 0,
      transactionalMonthlyQuota: 3_000,
      transactionalDailyQuota: 100,
      paidOverageForbidden: true,
      paidAddonCountRequired: 0,
    }),
    googleMapsAndPlaces: Object.freeze({
      dedicatedStagingProjectRequired: true,
      exactApiAndSkuInventoryRequired: true,
      apiKeyRestrictionsRequired: true,
      adjustableQuotaLimitsStopRequests: true,
      cloudBudgetIsNotAHardCap: true,
      quotaAndBillingCanDiffer: true,
      quotaHeadroomRequired: true,
      documentedMonthlyHardQuotaAvailableForEverySurface: false,
      applicationMonthlyRequestReservationLedgerImplemented: false,
      reviewedSourceSurfaces: Object.freeze([
        Object.freeze({
          surface: "browser-map-rendering",
          api: "Maps JavaScript API",
          sku: "Dynamic Maps",
          sourcePaths: Object.freeze([
            "viewer/index.html",
            "viewer/account.html",
          ] as const),
          documentedQuotaPeriod: "per-minute",
        }),
        Object.freeze({
          surface: "browser-route-preview",
          api: "Directions API (Legacy)",
          sku: "Directions",
          sourcePaths: Object.freeze(["viewer/account.html"] as const),
          documentedQuotaPeriod: "daily-configurable-and-per-minute",
          permanentStagingFeatureMustRemainDisabled: true,
        }),
        Object.freeze({
          surface: "server-geocoding",
          api: "Geocoding API",
          sku: "Geocoding",
          sourcePaths: Object.freeze([
            "src/modules/business/business.service.ts",
          ] as const),
          documentedQuotaPeriod: "daily-and-per-minute",
        }),
        Object.freeze({
          surface: "server-venue-search",
          api: "Places API (New)",
          sku: "Text Search Pro",
          sourcePaths: Object.freeze([
            "src/modules/admin/admin.service.ts",
            "src/modules/business/business.service.ts",
          ] as const),
          documentedQuotaPeriod: "per-method-per-minute",
        }),
        Object.freeze({
          surface: "operator-venue-import-and-discovery-search",
          api: "Places API (New)",
          sku: "Text Search Enterprise",
          sourcePaths: Object.freeze([
            "scripts/import-melbourne-venues.ts",
            "scripts/discover-menu-sources.ts",
          ] as const),
          documentedQuotaPeriod: "per-method-per-minute",
        }),
        Object.freeze({
          surface: "operator-nearby-venue-import",
          api: "Places API (New)",
          sku: "Nearby Search Enterprise",
          sourcePaths: Object.freeze([
            "scripts/import-melbourne-venues.ts",
          ] as const),
          documentedQuotaPeriod: "per-method-per-minute",
        }),
        Object.freeze({
          surface: "server-and-operator-place-details",
          api: "Places API (New)",
          sku: "Place Details Enterprise",
          sourcePaths: Object.freeze([
            "src/modules/admin/admin.service.ts",
            "src/modules/business/business.service.ts",
            "src/lib/venue-open-hours.ts",
            "scripts/import-melbourne-venues.ts",
          ] as const),
          documentedQuotaPeriod: "per-method-per-minute",
        }),
      ] as const),
      maximumMonthlyCents: null,
    }),
    openAiMenuOcr: Object.freeze({
      dedicatedStagingProjectRequired: true,
      restrictedProjectServiceAccountKeyRequired: true,
      exactModelAndRateLimitInventoryRequired: true,
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
      exactAllowedModelIds: Object.freeze([
        "gpt-5.6-sol",
        "gpt-4.1",
        "gpt-4.1-mini-2025-04-14",
      ] as const),
      costBoundRuntimeTarget: Object.freeze({
        activationObserved: false,
        exactModel: "gpt-4.1-mini-2025-04-14",
        budgetWindow: "rolling-31-day",
        windowClockAuthority: "shared-database-clock",
        inputCentsPerMillionTokens: 40,
        outputCentsPerMillionTokens: 160,
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
      }),
      maximumMonthlyCents: null,
    }),
  }),
  unresolvedDesignBlockers: Object.freeze([
    "railway-agent-usage-zero-bound-not-proved",
    "current-railway-resource-maximum-exceeds-workspace-target",
    "google-live-api-sku-quota-and-monthly-billing-upper-bound-not-proved",
    "openai-cost-bound-runtime-and-provider-account-not-live-observed",
    "live-provider-plan-cap-addon-and-isolation-state-not-observed",
  ] as const),
} as const);

export interface PermanentStagingPublicPlanningAudit {
  readonly passed: false;
  readonly authority: "planning-only";
  readonly maximumRecurringMonthlyCents: 5_000;
  readonly railwayConfiguredMaximumSubtotalCents: number;
  readonly supabaseOneMicroNetPublishedSubtotalCents: number;
  readonly configuredMaximumSubtotalBeforeUnknownsCents: number;
  readonly excessBeforeUnknownsCents: number;
  readonly unresolvedRecurringCategories: readonly string[];
  readonly failureCodes: readonly [
    "provider_observation_not_implemented",
    "configured_maximum_exceeds_ceiling_before_unknowns",
    "unknown_recurring_categories_present",
  ];
}

export interface PermanentStagingPublicRemediationAudit {
  readonly passed: false;
  readonly authority: "design-only";
  readonly maximumRecurringMonthlyCents: 5_000;
  readonly isolatedInfrastructureTargetCents: 4_500;
  readonly remainingForAllExternalProvidersCents: 500;
  readonly externalProviderUpperBoundCents: null;
  readonly unresolvedDesignBlockers: readonly string[];
  readonly failureCodes: readonly [
    "provider_observation_not_implemented",
    "provider_mutation_not_authorized",
    "external_provider_upper_bound_not_proved",
    "current_configuration_does_not_fit_remediation_target",
  ];
}

function railwayReplicaMaximumCents(input: {
  readonly replicaCount: number;
  readonly cpuMilliVcpuPerReplica: number;
  readonly memoryMbPerReplica: number;
}): number {
  const prices = PERMANENT_STAGING_COST_PUBLIC_PLANNING_REVIEW
    .railwayPublishedPrices;
  const cpuCents = Math.ceil(
    input.replicaCount
      * input.cpuMilliVcpuPerReplica
      * prices.cpuPerVcpuMonthCents
      / 1_000,
  );
  const memoryCents = Math.ceil(
    input.replicaCount
      * input.memoryMbPerReplica
      * prices.memoryPerGbMonthCents
      / 1_000,
  );
  return cpuCents + memoryCents;
}

export function auditPermanentStagingPublicPlanningCost():
PermanentStagingPublicPlanningAudit {
  const review = PERMANENT_STAGING_COST_PUBLIC_PLANNING_REVIEW;
  const maxima = review.reviewedRailwayStagingMaxima;
  const railwayResourceMaximumCents =
    railwayReplicaMaximumCents(maxima.beer)
    + railwayReplicaMaximumCents(maxima.postgres)
    + railwayReplicaMaximumCents(maxima.redis)
    + Math.ceil(
      maxima.postgres.volumeMaximumGb
        * review.railwayPublishedPrices.volumePerGbMonthCents,
    );
  const railwayConfiguredMaximumSubtotalCents = Math.max(
    review.railwayPublishedPrices.proPlanMonthlyCents,
    railwayResourceMaximumCents,
  );
  const supabaseOneMicroNetPublishedSubtotalCents =
    review.supabasePublishedPrices.proPlanMonthlyCents
    + review.supabasePublishedPrices.microComputeMaximumMonthlyCents
    - review.supabasePublishedPrices.standardMonthlyComputeEntitlementCents;
  const configuredMaximumSubtotalBeforeUnknownsCents =
    railwayConfiguredMaximumSubtotalCents
    + supabaseOneMicroNetPublishedSubtotalCents;
  const maximumRecurringMonthlyCents =
    PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents;

  return Object.freeze({
    passed: false,
    authority: "planning-only",
    maximumRecurringMonthlyCents,
    railwayConfiguredMaximumSubtotalCents,
    supabaseOneMicroNetPublishedSubtotalCents,
    configuredMaximumSubtotalBeforeUnknownsCents,
    excessBeforeUnknownsCents: Math.max(
      0,
      configuredMaximumSubtotalBeforeUnknownsCents
        - maximumRecurringMonthlyCents,
    ),
    unresolvedRecurringCategories:
      review.unresolvedRecurringCategories,
    failureCodes: Object.freeze([
      "provider_observation_not_implemented",
      "configured_maximum_exceeds_ceiling_before_unknowns",
      "unknown_recurring_categories_present",
    ] as const),
  });
}

export function auditPermanentStagingPublicRemediationDesign():
PermanentStagingPublicRemediationAudit {
  const design = PERMANENT_STAGING_COST_PUBLIC_REMEDIATION_DESIGN;
  return Object.freeze({
    passed: false,
    authority: "design-only",
    maximumRecurringMonthlyCents:
      PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents,
    isolatedInfrastructureTargetCents:
      design.isolatedInfrastructureTarget.maximumMonthlyCents,
    remainingForAllExternalProvidersCents:
      design.isolatedInfrastructureTarget.remainingForAllExternalProvidersCents,
    externalProviderUpperBoundCents: null,
    unresolvedDesignBlockers: design.unresolvedDesignBlockers,
    failureCodes: Object.freeze([
      "provider_observation_not_implemented",
      "provider_mutation_not_authorized",
      "external_provider_upper_bound_not_proved",
      "current_configuration_does_not_fit_remediation_target",
    ] as const),
  });
}

export interface PermanentStagingCostPolicy {
  readonly schemaVersion: typeof PERMANENT_STAGING_COST_POLICY_SCHEMA;
  readonly policyId: typeof PERMANENT_STAGING_COST_POLICY_ID;
  readonly activationState:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.activationState;
  readonly environment: typeof PERMANENT_STAGING_COST_POLICY_LOCK.environment;
  readonly currency: typeof PERMANENT_STAGING_COST_POLICY_LOCK.currency;
  readonly maximumRecurringMonthlyCents:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents;
  readonly calculationContract:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.calculationContract;
  readonly evidenceContract:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.evidenceContract;
}

function buildCanonicalPolicy(): PermanentStagingCostPolicy {
  const lock = PERMANENT_STAGING_COST_POLICY_LOCK;
  return Object.freeze({
    schemaVersion: PERMANENT_STAGING_COST_POLICY_SCHEMA,
    policyId: lock.policyId,
    activationState: lock.activationState,
    environment: lock.environment,
    currency: lock.currency,
    maximumRecurringMonthlyCents: lock.maximumRecurringMonthlyCents,
    calculationContract: lock.calculationContract,
    evidenceContract: lock.evidenceContract,
  });
}

export const PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE =
  `${JSON.stringify(buildCanonicalPolicy(), null, 2)}\n`;

export function parsePermanentStagingCostPolicy(
  source: unknown,
): PermanentStagingCostPolicy | null {
  return typeof source === "string"
    && source === PERMANENT_STAGING_COST_CANONICAL_POLICY_SOURCE
    ? buildCanonicalPolicy()
    : null;
}

export interface PermanentStagingCostLineItem {
  readonly resourceIdentitySha256: string;
  readonly recurringMonthlyCents: number;
}

export interface PermanentStagingCostObservation {
  readonly environment: "permanent-staging";
  readonly scope: "permanent-staging-only";
  readonly currency: "USD";
  readonly lineItemRounding: "ceiling";
  readonly providerInventorySha256: string;
  readonly priceCatalogSha256: string;
  readonly providerInventoryComplete: boolean;
  readonly priceCatalogComplete: boolean;
  readonly unknownResourceCount: number;
  readonly unpricedResourceCount: number;
  readonly lineItems: readonly PermanentStagingCostLineItem[];
}

export type PermanentStagingCostFailureCode =
  | "observation_invalid"
  | "provider_observation_not_implemented"
  | "provider_inventory_incomplete"
  | "price_catalog_incomplete"
  | "unknown_resources_present"
  | "unpriced_resources_present"
  | "ceiling_exceeded";

export interface PermanentStagingCostEvaluation {
  readonly passed: false;
  readonly evaluatorState: "scaffold-only";
  readonly currency: "USD";
  readonly maximumRecurringMonthlyCents: 5_000;
  readonly declaredRecurringMonthlyCents: number | null;
  readonly failureCodes: readonly PermanentStagingCostFailureCode[];
}

const OBSERVATION_INVALID_FAILURE_CODES = Object.freeze(
  ["observation_invalid"] as PermanentStagingCostFailureCode[],
);

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort())
    === JSON.stringify([...expected].sort());
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseObservation(value: unknown): PermanentStagingCostObservation | null {
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      "environment",
      "scope",
      "currency",
      "lineItemRounding",
      "providerInventorySha256",
      "priceCatalogSha256",
      "providerInventoryComplete",
      "priceCatalogComplete",
      "unknownResourceCount",
      "unpricedResourceCount",
      "lineItems",
    ])
    || value.environment !== PERMANENT_STAGING_COST_POLICY_LOCK.environment
    || value.scope !== PERMANENT_STAGING_COST_POLICY_LOCK.evidenceContract.scope
    || value.currency !== PERMANENT_STAGING_COST_POLICY_LOCK.currency
    || value.lineItemRounding
      !== PERMANENT_STAGING_COST_POLICY_LOCK.calculationContract.lineItemRounding
    || typeof value.providerInventorySha256 !== "string"
    || !SHA256_PATTERN.test(value.providerInventorySha256)
    || typeof value.priceCatalogSha256 !== "string"
    || !SHA256_PATTERN.test(value.priceCatalogSha256)
    || typeof value.providerInventoryComplete !== "boolean"
    || typeof value.priceCatalogComplete !== "boolean"
    || !safeCount(value.unknownResourceCount)
    || !safeCount(value.unpricedResourceCount)
    || !Array.isArray(value.lineItems)
    || value.lineItems.length < 1
  ) return null;

  const identities = new Set<string>();
  const lineItems: PermanentStagingCostLineItem[] = [];
  for (const lineItem of value.lineItems) {
    if (
      !plainRecord(lineItem)
      || !exactKeys(lineItem, [
        "resourceIdentitySha256",
        "recurringMonthlyCents",
      ])
      || typeof lineItem.resourceIdentitySha256 !== "string"
      || !SHA256_PATTERN.test(lineItem.resourceIdentitySha256)
      || identities.has(lineItem.resourceIdentitySha256)
      || !safeCount(lineItem.recurringMonthlyCents)
    ) return null;
    identities.add(lineItem.resourceIdentitySha256);
    lineItems.push(Object.freeze({
      resourceIdentitySha256: lineItem.resourceIdentitySha256,
      recurringMonthlyCents: lineItem.recurringMonthlyCents,
    }));
  }

  return Object.freeze({
    environment: value.environment,
    scope: value.scope,
    currency: value.currency,
    lineItemRounding: value.lineItemRounding,
    providerInventorySha256: value.providerInventorySha256,
    priceCatalogSha256: value.priceCatalogSha256,
    providerInventoryComplete: value.providerInventoryComplete,
    priceCatalogComplete: value.priceCatalogComplete,
    unknownResourceCount: value.unknownResourceCount,
    unpricedResourceCount: value.unpricedResourceCount,
    lineItems: Object.freeze(lineItems),
  });
}

export function evaluatePermanentStagingCost(
  value: unknown,
): PermanentStagingCostEvaluation {
  const observation = parseObservation(value);
  if (!observation) {
    return Object.freeze({
      passed: false,
      evaluatorState: "scaffold-only",
      currency: PERMANENT_STAGING_COST_POLICY_LOCK.currency,
      maximumRecurringMonthlyCents:
        PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents,
      declaredRecurringMonthlyCents: null,
      failureCodes: OBSERVATION_INVALID_FAILURE_CODES,
    });
  }

  let recurringMonthlyCents = 0;
  for (const lineItem of observation.lineItems) {
    recurringMonthlyCents += lineItem.recurringMonthlyCents;
    if (!Number.isSafeInteger(recurringMonthlyCents)) {
      return Object.freeze({
        passed: false,
        evaluatorState: "scaffold-only",
        currency: PERMANENT_STAGING_COST_POLICY_LOCK.currency,
        maximumRecurringMonthlyCents:
          PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents,
        declaredRecurringMonthlyCents: null,
        failureCodes: OBSERVATION_INVALID_FAILURE_CODES,
      });
    }
  }

  const failureCodes: PermanentStagingCostFailureCode[] = [
    "provider_observation_not_implemented",
  ];
  if (!observation.providerInventoryComplete) {
    failureCodes.push("provider_inventory_incomplete");
  }
  if (!observation.priceCatalogComplete) {
    failureCodes.push("price_catalog_incomplete");
  }
  if (observation.unknownResourceCount !== 0) {
    failureCodes.push("unknown_resources_present");
  }
  if (observation.unpricedResourceCount !== 0) {
    failureCodes.push("unpriced_resources_present");
  }
  if (
    recurringMonthlyCents
      > PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents
  ) failureCodes.push("ceiling_exceeded");

  return Object.freeze({
    passed: false,
    evaluatorState: "scaffold-only",
    currency: PERMANENT_STAGING_COST_POLICY_LOCK.currency,
    maximumRecurringMonthlyCents:
      PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents,
    declaredRecurringMonthlyCents: recurringMonthlyCents,
    failureCodes: Object.freeze(failureCodes),
  });
}
