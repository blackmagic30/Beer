export const PERMANENT_STAGING_COST_POLICY_SCHEMA =
  "pintpath-permanent-staging-cost-policy/v2" as const;
export const PERMANENT_STAGING_COST_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cost-receipt/v2" as const;
export const PERMANENT_STAGING_COST_OBSERVATION_SCHEMA =
  "pintpath-permanent-staging-cost-observation/v1" as const;
export const PERMANENT_STAGING_COST_GATE_MANIFEST_SCHEMA =
  "pintpath-permanent-staging-cost-gate-manifest/v1" as const;
export const PERMANENT_STAGING_COST_POLICY_ID =
  "pintpath-permanent-staging-recurring-cost" as const;
export const PERMANENT_STAGING_COST_POLICY_PATH =
  "ops/railway/permanent-staging-cost-policy.json" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const PERMANENT_STAGING_COST_POLICY_LOCK = Object.freeze({
  policyId: PERMANENT_STAGING_COST_POLICY_ID,
  activationState: "ACTIVE_READ_ONLY_EXTERNAL_OBSERVATION_BINDER",
  environment: "permanent-staging",
  currency: "USD",
  maximumRecurringMonthlyCents: 5_000,
  maximumObservedRecurringMonthlyCents: 4_700,
  requiredHeadroomMonthlyCents: 300,
  calculationContract: Object.freeze({
    amountUnit: "integer-cents",
    lineItemRounding: "ceiling",
    aggregate: "sum",
    creditsOrNegativeAmountsAllowed: false,
  }),
  evidenceContract: Object.freeze({
    providerCollectorImplemented: false,
    externalProviderExportValidationImplemented: true,
    providerObservationBindingImplemented: true,
    providerNetworkAccessAllowed: false,
    credentialAccessAllowed: false,
    externallyCapturedProviderExportsRequired: true,
    preAndPostDeploymentObservationRequired: true,
    privateApprovalManifestRequired: true,
    observedArtifactSha256VerificationRequired: true,
    scope: "permanent-staging-only",
    providerInventoryRequired: true,
    completeProviderInventoryRequired: true,
    priceCatalogRequired: true,
    completePriceCatalogRequired: true,
    maximumUnknownResourceCount: 0,
    maximumUnpricedResourceCount: 0,
    productionOperationalCopyExcluded: true,
    disposableRestoreExcluded: true,
    singleCombinedReceiptRequired: true,
    receiptMayAuthorizeDeployment: false,
    receiptSchemaVersion: PERMANENT_STAGING_COST_RECEIPT_SCHEMA,
  }),
  topologyContract: Object.freeze({
    railway: Object.freeze({
      maximumRecurringMonthlyCents: 2_000,
      dedicatedStagingOnlyWorkspaceRequired: true,
      exactServiceSet: Object.freeze(["beer", "postgres", "redis"] as const),
      maximumSharedResourceCount: 0,
      agentUsageMustBeDisabledOrZeroBounded: true,
    }),
    stagingSupabase: Object.freeze({
      maximumRecurringMonthlyCents: 2_500,
      dedicatedStagingOnlyOrganizationRequired: true,
      exactProjectCount: 1,
      exactComputeSize: "Micro",
      spendCapRequired: true,
      maximumSharedResourceCount: 0,
    }),
    stagingExternalProviders: Object.freeze({
      maximumRecurringMonthlyCents: 200,
      googleMapsAndPlacesMaximumCents: 100,
      openAiMaximumCents: 100,
      resendMaximumCents: 0,
      unboundedSurfaceCountRequired: 0,
    }),
    configuredMaximumRecurringMonthlyCents: 4_700,
    explicitHeadroomMonthlyCents: 300,
  }),
} as const);

/**
 * Public-price planning evidence reviewed on 2026-08-13. This is deliberately
 * not provider observation: it cannot prove the live plan, resource limits,
 * volume use, spend-cap state, add-ons, or external-provider configuration.
 *
 * The subtotal is still useful as a fail-closed design check. It applies the
 * checked-in permanent-staging maxima to the providers' published prices. A
 * complete live receipt still requires externally captured observations and
 * hard bounds for every unresolved category. The configured infrastructure
 * target leaves an explicit US$2 allowance for external providers and US$3
 * policy headroom below the US$50 ceiling.
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
  repositoryRailwayStagingTargetMaxima: Object.freeze({
    beer: Object.freeze({
      replicaCount: 1,
      cpuMilliVcpuPerReplica: 100,
      memoryMbPerReplica: 250,
    }),
    postgres: Object.freeze({
      replicaCount: 1,
      cpuMilliVcpuPerReplica: 100,
      memoryMbPerReplica: 250,
      volumeMaximumGb: 10,
    }),
    redis: Object.freeze({
      replicaCount: 1,
      cpuMilliVcpuPerReplica: 50,
      memoryMbPerReplica: 100,
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
      repositoryPlanningMaximumFitsTarget: true,
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
    remainingForAllExternalProvidersCents: 200,
    requiredHeadroomMonthlyCents: 300,
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
    "unknown_recurring_categories_present",
  ];
}

export interface PermanentStagingPublicRemediationAudit {
  readonly passed: false;
  readonly authority: "design-only";
  readonly maximumRecurringMonthlyCents: 5_000;
  readonly isolatedInfrastructureTargetCents: 4_500;
  readonly remainingForAllExternalProvidersCents: 200;
  readonly requiredHeadroomMonthlyCents: 300;
  readonly externalProviderUpperBoundCents: null;
  readonly unresolvedDesignBlockers: readonly string[];
  readonly failureCodes: readonly [
    "provider_observation_not_implemented",
    "provider_mutation_not_authorized",
    "external_provider_upper_bound_not_proved",
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
  const maxima = review.repositoryRailwayStagingTargetMaxima;
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
    requiredHeadroomMonthlyCents:
      design.isolatedInfrastructureTarget.requiredHeadroomMonthlyCents,
    externalProviderUpperBoundCents: null,
    unresolvedDesignBlockers: design.unresolvedDesignBlockers,
    failureCodes: Object.freeze([
      "provider_observation_not_implemented",
      "provider_mutation_not_authorized",
      "external_provider_upper_bound_not_proved",
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
  readonly maximumObservedRecurringMonthlyCents:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.maximumObservedRecurringMonthlyCents;
  readonly requiredHeadroomMonthlyCents:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.requiredHeadroomMonthlyCents;
  readonly calculationContract:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.calculationContract;
  readonly evidenceContract:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.evidenceContract;
  readonly topologyContract:
    typeof PERMANENT_STAGING_COST_POLICY_LOCK.topologyContract;
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
    maximumObservedRecurringMonthlyCents:
      lock.maximumObservedRecurringMonthlyCents,
    requiredHeadroomMonthlyCents: lock.requiredHeadroomMonthlyCents,
    calculationContract: lock.calculationContract,
    evidenceContract: lock.evidenceContract,
    topologyContract: lock.topologyContract,
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

export type PermanentStagingCostProviderName =
  | "railway"
  | "staging-supabase"
  | "staging-external-providers";

export interface PermanentStagingCostProviderObservation {
  readonly provider: PermanentStagingCostProviderName;
  readonly inventoryArtifactSha256: string;
  readonly priceOrCapArtifactSha256: string;
  readonly inventoryComplete: boolean;
  readonly upperBoundComplete: boolean;
  readonly scopeIsolationVerified: boolean;
  readonly hardLimitOrZeroBoundVerified: boolean;
  readonly unknownResourceCount: number;
  readonly unpricedResourceCount: number;
  readonly sharedResourceCount: number;
  readonly unboundedResourceCount: number;
  readonly upperBoundMonthlyCents: number;
}

export interface PermanentStagingExcludedCostScope {
  readonly scope: "production-operational-copy" | "disposable-restore";
  readonly includedInPermanentStagingTotal: false;
  readonly separateAuthorityArtifactSha256: string;
}

export interface PermanentStagingCostObservation {
  readonly schemaVersion: typeof PERMANENT_STAGING_COST_OBSERVATION_SCHEMA;
  readonly releaseId: string;
  readonly candidateSha: string;
  readonly phase: "pre-deployment" | "post-deployment";
  readonly environment: "permanent-staging";
  readonly scope: "permanent-staging-only";
  readonly currency: "USD";
  readonly amountUnit: "integer-cents";
  readonly lineItemRounding: "ceiling";
  readonly observationSource: "provider-read-only-export";
  readonly observedAt: string;
  readonly externalExportSetSha256: string;
  readonly providers: readonly PermanentStagingCostProviderObservation[];
  readonly excludedScopes: readonly PermanentStagingExcludedCostScope[];
}

export interface PermanentStagingCostGateManifest {
  readonly schemaVersion: typeof PERMANENT_STAGING_COST_GATE_MANIFEST_SCHEMA;
  readonly releaseId: string;
  readonly candidateSha: string;
  readonly environment: "permanent-staging";
  readonly gateId: "permanent_staging_cost";
  readonly preObservationSha256: string;
  readonly postObservationSha256: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly independentlyVerifiedBy: string;
}

export interface PermanentStagingCostReceipt {
  readonly schemaVersion: typeof PERMANENT_STAGING_COST_RECEIPT_SCHEMA;
  readonly releaseId: string;
  readonly candidateSha: string;
  readonly gateId: "permanent_staging_cost";
  readonly environment: "permanent-staging";
  readonly scope: "permanent-staging-only";
  readonly currency: "USD";
  readonly amountUnit: "integer-cents";
  readonly lineItemRounding: "ceiling";
  readonly observationSource: "externally-captured-provider-read-only-exports";
  readonly externalProviderExportValidationImplemented: true;
  readonly providerObservationBindingImplemented: true;
  readonly policySha256: string;
  readonly preObservationSha256: string;
  readonly postObservationSha256: string;
  readonly preObservedAt: string;
  readonly postObservedAt: string;
  readonly privateManifestSha256: string;
  readonly totalUpperBoundMonthlyCents: number;
  readonly maximumObservedAcrossPhasesMonthlyCents: number;
  readonly maximumRecurringMonthlyCents: 5_000;
  readonly requiredHeadroomMonthlyCents: 300;
  readonly observedHeadroomMonthlyCents: number;
  readonly providers: readonly PermanentStagingCostProviderObservation[];
  readonly excludedScopes: readonly PermanentStagingExcludedCostScope[];
}

export interface PermanentStagingCostEvaluation {
  readonly passed: boolean;
  readonly evaluatorState: "active-read-only-external-export-validator";
  readonly currency: "USD";
  readonly maximumRecurringMonthlyCents: 5_000;
  readonly maximumObservedRecurringMonthlyCents: 4_700;
  readonly requiredHeadroomMonthlyCents: 300;
  readonly declaredRecurringMonthlyCents: number | null;
  readonly observedHeadroomMonthlyCents: number | null;
  readonly failureCodes: readonly string[];
}

export interface BindPermanentStagingCostReceiptInput {
  readonly policySource: string;
  readonly policySha256: string;
  readonly preObservationSource: string;
  readonly preObservationSha256: string;
  readonly postObservationSource: string;
  readonly postObservationSha256: string;
  readonly privateManifestSource: string;
  readonly privateManifestSha256: string;
  readonly now: string;
}

export interface BindPermanentStagingCostReceiptResult {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly receipt: PermanentStagingCostReceipt | null;
}

const RELEASE_ID_PATTERN = /^PP-LAUNCH-\d{4}-[A-Z0-9][A-Z0-9_-]{2,31}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const PROVIDER_NAMES = Object.freeze([
  "railway",
  "staging-supabase",
  "staging-external-providers",
] as const);
const PROVIDER_LIMITS = Object.freeze({
  railway: 2_000,
  "staging-supabase": 2_500,
  "staging-external-providers": 200,
} as const);

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

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && CANONICAL_TIMESTAMP_PATTERN.test(value)
    && !Number.isNaN(Date.parse(value));
}

function namedVerifier(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const separator = value.indexOf(",");
  return separator >= 2
    && value.slice(0, separator).trim().length >= 2
    && value.slice(separator + 1).trim().length >= 2;
}

function parseCanonicalJson(source: unknown): unknown | null {
  if (typeof source !== "string" || source.length < 3 || source.length > 1024 * 1024) {
    return null;
  }
  try {
    const value = JSON.parse(source) as unknown;
    return `${JSON.stringify(value, null, 2)}\n` === source ? value : null;
  } catch {
    return null;
  }
}

function parseProviderObservation(
  value: unknown,
): PermanentStagingCostProviderObservation | null {
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      "provider",
      "inventoryArtifactSha256",
      "priceOrCapArtifactSha256",
      "inventoryComplete",
      "upperBoundComplete",
      "scopeIsolationVerified",
      "hardLimitOrZeroBoundVerified",
      "unknownResourceCount",
      "unpricedResourceCount",
      "sharedResourceCount",
      "unboundedResourceCount",
      "upperBoundMonthlyCents",
    ])
    || !PROVIDER_NAMES.includes(value.provider as PermanentStagingCostProviderName)
    || typeof value.inventoryArtifactSha256 !== "string"
    || !SHA256_PATTERN.test(value.inventoryArtifactSha256)
    || typeof value.priceOrCapArtifactSha256 !== "string"
    || !SHA256_PATTERN.test(value.priceOrCapArtifactSha256)
    || typeof value.inventoryComplete !== "boolean"
    || typeof value.upperBoundComplete !== "boolean"
    || typeof value.scopeIsolationVerified !== "boolean"
    || typeof value.hardLimitOrZeroBoundVerified !== "boolean"
    || !safeCount(value.unknownResourceCount)
    || !safeCount(value.unpricedResourceCount)
    || !safeCount(value.sharedResourceCount)
    || !safeCount(value.unboundedResourceCount)
    || !safeCount(value.upperBoundMonthlyCents)
  ) return null;
  return Object.freeze({
    provider: value.provider as PermanentStagingCostProviderName,
    inventoryArtifactSha256: value.inventoryArtifactSha256,
    priceOrCapArtifactSha256: value.priceOrCapArtifactSha256,
    inventoryComplete: value.inventoryComplete,
    upperBoundComplete: value.upperBoundComplete,
    scopeIsolationVerified: value.scopeIsolationVerified,
    hardLimitOrZeroBoundVerified: value.hardLimitOrZeroBoundVerified,
    unknownResourceCount: value.unknownResourceCount,
    unpricedResourceCount: value.unpricedResourceCount,
    sharedResourceCount: value.sharedResourceCount,
    unboundedResourceCount: value.unboundedResourceCount,
    upperBoundMonthlyCents: value.upperBoundMonthlyCents,
  });
}

function parseExcludedScope(value: unknown): PermanentStagingExcludedCostScope | null {
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      "scope",
      "includedInPermanentStagingTotal",
      "separateAuthorityArtifactSha256",
    ])
    || !["production-operational-copy", "disposable-restore"].includes(
      String(value.scope),
    )
    || value.includedInPermanentStagingTotal !== false
    || typeof value.separateAuthorityArtifactSha256 !== "string"
    || !SHA256_PATTERN.test(value.separateAuthorityArtifactSha256)
  ) return null;
  return Object.freeze({
    scope: value.scope as PermanentStagingExcludedCostScope["scope"],
    includedInPermanentStagingTotal: false,
    separateAuthorityArtifactSha256: value.separateAuthorityArtifactSha256,
  });
}

export function parsePermanentStagingCostObservation(
  source: unknown,
): PermanentStagingCostObservation | null {
  const value = parseCanonicalJson(source);
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "releaseId",
      "candidateSha",
      "phase",
      "environment",
      "scope",
      "currency",
      "amountUnit",
      "lineItemRounding",
      "observationSource",
      "observedAt",
      "externalExportSetSha256",
      "providers",
      "excludedScopes",
    ])
    || value.schemaVersion !== PERMANENT_STAGING_COST_OBSERVATION_SCHEMA
    || typeof value.releaseId !== "string"
    || !RELEASE_ID_PATTERN.test(value.releaseId)
    || typeof value.candidateSha !== "string"
    || !COMMIT_SHA_PATTERN.test(value.candidateSha)
    || !["pre-deployment", "post-deployment"].includes(String(value.phase))
    || value.environment !== PERMANENT_STAGING_COST_POLICY_LOCK.environment
    || value.scope !== PERMANENT_STAGING_COST_POLICY_LOCK.evidenceContract.scope
    || value.currency !== PERMANENT_STAGING_COST_POLICY_LOCK.currency
    || value.amountUnit !== PERMANENT_STAGING_COST_POLICY_LOCK.calculationContract.amountUnit
    || value.lineItemRounding
      !== PERMANENT_STAGING_COST_POLICY_LOCK.calculationContract.lineItemRounding
    || value.observationSource !== "provider-read-only-export"
    || !canonicalTimestamp(value.observedAt)
    || typeof value.externalExportSetSha256 !== "string"
    || !SHA256_PATTERN.test(value.externalExportSetSha256)
    || !Array.isArray(value.providers)
    || !Array.isArray(value.excludedScopes)
  ) return null;
  const providers = value.providers.map(parseProviderObservation);
  const excludedScopes = value.excludedScopes.map(parseExcludedScope);
  if (providers.some((provider) => provider === null)) return null;
  if (excludedScopes.some((scope) => scope === null)) return null;
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    releaseId: value.releaseId,
    candidateSha: value.candidateSha,
    phase: value.phase as PermanentStagingCostObservation["phase"],
    environment: value.environment,
    scope: value.scope,
    currency: value.currency,
    amountUnit: value.amountUnit,
    lineItemRounding: value.lineItemRounding,
    observationSource: value.observationSource,
    observedAt: value.observedAt,
    externalExportSetSha256: value.externalExportSetSha256,
    providers: Object.freeze(
      providers as PermanentStagingCostProviderObservation[],
    ),
    excludedScopes: Object.freeze(
      excludedScopes as PermanentStagingExcludedCostScope[],
    ),
  });
}

function parseGateManifest(source: unknown): PermanentStagingCostGateManifest | null {
  const value = parseCanonicalJson(source);
  if (
    !plainRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "releaseId",
      "candidateSha",
      "environment",
      "gateId",
      "preObservationSha256",
      "postObservationSha256",
      "approvedAt",
      "approvedBy",
      "independentlyVerifiedBy",
    ])
    || value.schemaVersion !== PERMANENT_STAGING_COST_GATE_MANIFEST_SCHEMA
    || typeof value.releaseId !== "string"
    || !RELEASE_ID_PATTERN.test(value.releaseId)
    || typeof value.candidateSha !== "string"
    || !COMMIT_SHA_PATTERN.test(value.candidateSha)
    || value.environment !== "permanent-staging"
    || value.gateId !== "permanent_staging_cost"
    || typeof value.preObservationSha256 !== "string"
    || !SHA256_PATTERN.test(value.preObservationSha256)
    || typeof value.postObservationSha256 !== "string"
    || !SHA256_PATTERN.test(value.postObservationSha256)
    || !canonicalTimestamp(value.approvedAt)
    || !namedVerifier(value.approvedBy)
    || !namedVerifier(value.independentlyVerifiedBy)
    || value.approvedBy === value.independentlyVerifiedBy
  ) return null;
  return Object.freeze(value as unknown as PermanentStagingCostGateManifest);
}

function observationErrors(
  observation: PermanentStagingCostObservation,
): { readonly errors: readonly string[]; readonly total: number | null } {
  const errors: string[] = [];
  const names = observation.providers.map((provider) => provider.provider);
  if (
    names.length !== PROVIDER_NAMES.length
    || new Set(names).size !== names.length
    || PROVIDER_NAMES.some((name) => !names.includes(name))
  ) errors.push("providers must contain exactly Railway, staging Supabase, and staging external providers");
  let total = 0;
  for (const provider of observation.providers) {
    if (!provider.inventoryComplete) errors.push(`${provider.provider}:inventory_incomplete`);
    if (!provider.upperBoundComplete) errors.push(`${provider.provider}:upper_bound_incomplete`);
    if (!provider.scopeIsolationVerified) errors.push(`${provider.provider}:scope_not_isolated`);
    if (!provider.hardLimitOrZeroBoundVerified) errors.push(`${provider.provider}:hard_limit_not_verified`);
    if (provider.unknownResourceCount !== 0) errors.push(`${provider.provider}:unknown_resources_present`);
    if (provider.unpricedResourceCount !== 0) errors.push(`${provider.provider}:unpriced_resources_present`);
    if (provider.sharedResourceCount !== 0) errors.push(`${provider.provider}:shared_resources_present`);
    if (provider.unboundedResourceCount !== 0) errors.push(`${provider.provider}:unbounded_resources_present`);
    if (provider.upperBoundMonthlyCents > PROVIDER_LIMITS[provider.provider]) {
      errors.push(`${provider.provider}:provider_limit_exceeded`);
    }
    total += provider.upperBoundMonthlyCents;
    if (!Number.isSafeInteger(total)) return { errors: ["provider_total_overflow"], total: null };
  }
  const scopes = observation.excludedScopes.map((scope) => scope.scope);
  if (
    scopes.length !== 2
    || new Set(scopes).size !== scopes.length
    || !scopes.includes("production-operational-copy")
    || !scopes.includes("disposable-restore")
  ) errors.push("excluded scopes must contain separate production-copy and disposable-restore authorities");
  if (
    new Set(observation.excludedScopes.map(
      (scope) => scope.separateAuthorityArtifactSha256,
    )).size !== observation.excludedScopes.length
  ) errors.push("excluded scope authorities must use distinct artifacts");
  if (total > PERMANENT_STAGING_COST_POLICY_LOCK.maximumObservedRecurringMonthlyCents) {
    errors.push("configured_maximum_exceeded");
  }
  if (
    PERMANENT_STAGING_COST_POLICY_LOCK.maximumRecurringMonthlyCents - total
      < PERMANENT_STAGING_COST_POLICY_LOCK.requiredHeadroomMonthlyCents
  ) errors.push("required_headroom_not_met");
  return { errors: Object.freeze(errors), total };
}

export function evaluatePermanentStagingCost(
  source: unknown,
): PermanentStagingCostEvaluation {
  const observation = typeof source === "string"
    ? parsePermanentStagingCostObservation(source)
    : null;
  if (!observation) {
    return Object.freeze({
      passed: false,
      evaluatorState: "active-read-only-external-export-validator",
      currency: "USD",
      maximumRecurringMonthlyCents: 5_000,
      maximumObservedRecurringMonthlyCents: 4_700,
      requiredHeadroomMonthlyCents: 300,
      declaredRecurringMonthlyCents: null,
      observedHeadroomMonthlyCents: null,
      failureCodes: Object.freeze(["observation_invalid"]),
    });
  }
  const evaluation = observationErrors(observation);
  return Object.freeze({
    passed: evaluation.errors.length === 0,
    evaluatorState: "active-read-only-external-export-validator",
    currency: "USD",
    maximumRecurringMonthlyCents: 5_000,
    maximumObservedRecurringMonthlyCents: 4_700,
    requiredHeadroomMonthlyCents: 300,
    declaredRecurringMonthlyCents: evaluation.total,
    observedHeadroomMonthlyCents: evaluation.total === null
      ? null
      : 5_000 - evaluation.total,
    failureCodes: evaluation.errors,
  });
}

export function bindPermanentStagingCostReceipt(
  input: BindPermanentStagingCostReceiptInput,
): BindPermanentStagingCostReceiptResult {
  const errors: string[] = [];
  if (!parsePermanentStagingCostPolicy(input.policySource)) {
    errors.push("policy_invalid");
  }
  for (const [label, digest] of [
    ["policy", input.policySha256],
    ["pre_observation", input.preObservationSha256],
    ["post_observation", input.postObservationSha256],
    ["private_manifest", input.privateManifestSha256],
  ] as const) {
    if (!SHA256_PATTERN.test(digest)) errors.push(`${label}_sha256_invalid`);
  }
  const pre = parsePermanentStagingCostObservation(input.preObservationSource);
  const post = parsePermanentStagingCostObservation(input.postObservationSource);
  const manifest = parseGateManifest(input.privateManifestSource);
  if (!pre) errors.push("pre_observation_invalid");
  if (!post) errors.push("post_observation_invalid");
  if (!manifest) errors.push("private_manifest_invalid");
  if (!canonicalTimestamp(input.now)) errors.push("clock_invalid");
  if (errors.length > 0 || !pre || !post || !manifest) {
    return Object.freeze({ passed: false, errors: Object.freeze(errors), receipt: null });
  }
  if (pre.phase !== "pre-deployment") errors.push("pre_observation_phase_invalid");
  if (post.phase !== "post-deployment") errors.push("post_observation_phase_invalid");
  if (pre.releaseId !== post.releaseId || pre.releaseId !== manifest.releaseId) {
    errors.push("release_id_mismatch");
  }
  if (
    pre.candidateSha !== post.candidateSha
    || pre.candidateSha !== manifest.candidateSha
  ) errors.push("candidate_sha_mismatch");
  if (manifest.preObservationSha256 !== input.preObservationSha256) {
    errors.push("manifest_pre_observation_sha256_mismatch");
  }
  if (manifest.postObservationSha256 !== input.postObservationSha256) {
    errors.push("manifest_post_observation_sha256_mismatch");
  }
  const preEvaluation = observationErrors(pre);
  const postEvaluation = observationErrors(post);
  errors.push(...preEvaluation.errors.map((error) => `pre:${error}`));
  errors.push(...postEvaluation.errors.map((error) => `post:${error}`));
  const preAt = Date.parse(pre.observedAt);
  const postAt = Date.parse(post.observedAt);
  const approvedAt = Date.parse(manifest.approvedAt);
  const now = Date.parse(input.now);
  if (postAt <= preAt) errors.push("observation_order_invalid");
  if (approvedAt < postAt) errors.push("approval_predates_post_observation");
  if (now - preAt > MAX_OBSERVATION_AGE_MS) errors.push("pre_observation_stale");
  if (now - postAt > MAX_OBSERVATION_AGE_MS) errors.push("post_observation_stale");
  if (preAt - now > MAX_FUTURE_CLOCK_SKEW_MS) errors.push("pre_observation_in_future");
  if (postAt - now > MAX_FUTURE_CLOCK_SKEW_MS) errors.push("post_observation_in_future");
  if (approvedAt - now > MAX_FUTURE_CLOCK_SKEW_MS) errors.push("approval_in_future");
  if (errors.length > 0 || preEvaluation.total === null || postEvaluation.total === null) {
    return Object.freeze({ passed: false, errors: Object.freeze(errors), receipt: null });
  }
  const maximumObservedAcrossPhasesMonthlyCents = Math.max(
    preEvaluation.total,
    postEvaluation.total,
  );
  const receipt: PermanentStagingCostReceipt = Object.freeze({
    schemaVersion: PERMANENT_STAGING_COST_RECEIPT_SCHEMA,
    releaseId: manifest.releaseId,
    candidateSha: manifest.candidateSha,
    gateId: "permanent_staging_cost",
    environment: "permanent-staging",
    scope: "permanent-staging-only",
    currency: "USD",
    amountUnit: "integer-cents",
    lineItemRounding: "ceiling",
    observationSource: "externally-captured-provider-read-only-exports",
    externalProviderExportValidationImplemented: true,
    providerObservationBindingImplemented: true,
    policySha256: input.policySha256,
    preObservationSha256: input.preObservationSha256,
    postObservationSha256: input.postObservationSha256,
    preObservedAt: pre.observedAt,
    postObservedAt: post.observedAt,
    privateManifestSha256: input.privateManifestSha256,
    totalUpperBoundMonthlyCents: postEvaluation.total,
    maximumObservedAcrossPhasesMonthlyCents,
    maximumRecurringMonthlyCents: 5_000,
    requiredHeadroomMonthlyCents: 300,
    observedHeadroomMonthlyCents: 5_000 - maximumObservedAcrossPhasesMonthlyCents,
    providers: post.providers,
    excludedScopes: post.excludedScopes,
  });
  return Object.freeze({ passed: true, errors: Object.freeze([]), receipt });
}

export function canonicalPermanentStagingCostJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
