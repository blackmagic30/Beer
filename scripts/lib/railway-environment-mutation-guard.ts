export const RAILWAY_MUTATION_POLICY_SCHEMA =
  "pintpath-railway-production-staging-mutation-policy/v1" as const;
export const RAILWAY_MUTATION_POLICY_ID =
  "pintpath-production-staging-mutation-boundary" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_POLICY_BYTES = 64 * 1_024;

export interface RailwayMutationEnvironmentPolicy {
  readonly name: "production" | "staging";
  readonly environmentId: string;
}

export interface RailwayProductionPostgresPolicy {
  readonly environmentId: string;
  readonly serviceId: string;
  readonly deploymentId: string;
  readonly snapshotId: string;
  readonly sourceImage: string;
  readonly imageDigest: string;
  readonly requireImmutableSource: true;
}

export interface RailwayMutationPolicy {
  readonly schemaVersion: typeof RAILWAY_MUTATION_POLICY_SCHEMA;
  readonly policyId: typeof RAILWAY_MUTATION_POLICY_ID;
  readonly projectId: string;
  readonly environments: readonly [
    RailwayMutationEnvironmentPolicy,
    RailwayMutationEnvironmentPolicy,
  ];
  readonly productionPostgres: RailwayProductionPostgresPolicy;
}

export interface RailwayEnvironmentBoundary {
  readonly environmentId: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

export interface RailwayProjectTokenScope {
  readonly projectId: string;
  readonly environmentId: string;
}

export interface RailwayProductionDeploymentBoundary {
  readonly environmentId: string;
  readonly serviceId: string;
  readonly sourceImage: string | null;
  readonly sourceRepo: string | null;
  readonly latestDeployment: {
    readonly id: string;
    readonly status: string;
    readonly deploymentStopped: boolean;
    readonly snapshotId: string;
  } | null;
  readonly activeDeployments: readonly {
    readonly id: string;
    readonly status: string;
    readonly deploymentStopped: boolean;
  }[];
  readonly approvedDeployment: {
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly snapshotId: string;
    readonly sourceImage: string | null;
    readonly imageDigest: string | null;
    readonly patchId: string | null;
  } | null;
}

export interface RailwayMutationBoundaryChecks {
  policyValid: boolean;
  queriesMetadataOnly: boolean;
  productionTokenScopeExact: boolean;
  stagingTokenScopeExact: boolean;
  productionEnvironmentExact: boolean;
  stagingEnvironmentExact: boolean;
  productionPatchEmpty: boolean;
  stagingPatchEmpty: boolean;
  productionPostgresExact: boolean;
  approvedDeploymentCurrent: boolean;
  approvedDeploymentActive: boolean;
  approvedDeploymentHealthy: boolean;
  approvedSnapshotExact: boolean;
  approvedImageDigestExact: boolean;
  deploymentPatchAbsent: boolean;
  sourceImageExact: boolean;
  sourceReferenceImmutable: boolean;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((key, index) => actual[index] === key);
}

function parseEnvironment(
  value: unknown,
  expectedName: "production" | "staging",
): RailwayMutationEnvironmentPolicy | null {
  if (
    !exactKeys(value, ["name", "environmentId"])
    || value.name !== expectedName
    || typeof value.environmentId !== "string"
    || !UUID_PATTERN.test(value.environmentId)
  ) {
    return null;
  }
  return { name: expectedName, environmentId: value.environmentId };
}

function safeSourceImage(value: string): boolean {
  return value.length >= 1
    && value.length <= 512
    && value === value.trim()
    && !/[\r\n\0\s]/.test(value)
    && !value.includes("://")
    && !value.includes("$")
    && !value.includes("\\");
}

export function sourceReferencePinsDigest(
  sourceImage: string,
  imageDigest: string,
): boolean {
  const separator = sourceImage.lastIndexOf("@");
  return separator > 0
    && sourceImage.indexOf("@") === separator
    && sourceImage.slice(separator + 1) === imageDigest;
}

export function parseRailwayMutationPolicy(
  source: string,
): RailwayMutationPolicy | null {
  if (
    Buffer.byteLength(source, "utf8") > MAX_POLICY_BYTES
    || source.includes("\0")
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(source);
    if (
      !exactKeys(parsed, [
        "schemaVersion",
        "policyId",
        "projectId",
        "environments",
        "productionPostgres",
      ])
      || parsed.schemaVersion !== RAILWAY_MUTATION_POLICY_SCHEMA
      || parsed.policyId !== RAILWAY_MUTATION_POLICY_ID
      || typeof parsed.projectId !== "string"
      || !UUID_PATTERN.test(parsed.projectId)
      || !Array.isArray(parsed.environments)
      || parsed.environments.length !== 2
    ) {
      return null;
    }
    const production = parseEnvironment(parsed.environments[0], "production");
    const staging = parseEnvironment(parsed.environments[1], "staging");
    if (!production || !staging || production.environmentId === staging.environmentId) {
      return null;
    }
    const postgres = parsed.productionPostgres;
    if (
      !exactKeys(postgres, [
        "environmentId",
        "serviceId",
        "deploymentId",
        "snapshotId",
        "sourceImage",
        "imageDigest",
        "requireImmutableSource",
      ])
      || typeof postgres.environmentId !== "string"
      || postgres.environmentId !== production.environmentId
      || typeof postgres.serviceId !== "string"
      || !UUID_PATTERN.test(postgres.serviceId)
      || typeof postgres.deploymentId !== "string"
      || !UUID_PATTERN.test(postgres.deploymentId)
      || typeof postgres.snapshotId !== "string"
      || !UUID_PATTERN.test(postgres.snapshotId)
      || typeof postgres.sourceImage !== "string"
      || !safeSourceImage(postgres.sourceImage)
      || typeof postgres.imageDigest !== "string"
      || !IMAGE_DIGEST_PATTERN.test(postgres.imageDigest)
      || postgres.requireImmutableSource !== true
    ) {
      return null;
    }
    return {
      schemaVersion: RAILWAY_MUTATION_POLICY_SCHEMA,
      policyId: RAILWAY_MUTATION_POLICY_ID,
      projectId: parsed.projectId,
      environments: [production, staging],
      productionPostgres: {
        environmentId: postgres.environmentId,
        serviceId: postgres.serviceId,
        deploymentId: postgres.deploymentId,
        snapshotId: postgres.snapshotId,
        sourceImage: postgres.sourceImage,
        imageDigest: postgres.imageDigest,
        requireImmutableSource: true,
      },
    };
  } catch {
    return null;
  }
}

export function emptyRailwayMutationBoundaryChecks(): RailwayMutationBoundaryChecks {
  return {
    policyValid: false,
    queriesMetadataOnly: false,
    productionTokenScopeExact: false,
    stagingTokenScopeExact: false,
    productionEnvironmentExact: false,
    stagingEnvironmentExact: false,
    productionPatchEmpty: false,
    stagingPatchEmpty: false,
    productionPostgresExact: false,
    approvedDeploymentCurrent: false,
    approvedDeploymentActive: false,
    approvedDeploymentHealthy: false,
    approvedSnapshotExact: false,
    approvedImageDigestExact: false,
    deploymentPatchAbsent: false,
    sourceImageExact: false,
    sourceReferenceImmutable: false,
  };
}

export function evaluateRailwayMutationBoundary(input: {
  readonly policy: RailwayMutationPolicy;
  readonly queriesMetadataOnly: boolean;
  readonly productionTokenScope: RailwayProjectTokenScope;
  readonly stagingTokenScope: RailwayProjectTokenScope;
  readonly production: RailwayEnvironmentBoundary;
  readonly staging: RailwayEnvironmentBoundary;
  readonly postgres: RailwayProductionDeploymentBoundary;
}): RailwayMutationBoundaryChecks {
  const { policy, production, staging, postgres } = input;
  const checks = emptyRailwayMutationBoundaryChecks();
  checks.policyValid = true;
  checks.queriesMetadataOnly = input.queriesMetadataOnly;
  checks.productionTokenScopeExact =
    input.productionTokenScope.projectId === policy.projectId
    && input.productionTokenScope.environmentId === policy.environments[0].environmentId;
  checks.stagingTokenScopeExact =
    input.stagingTokenScope.projectId === policy.projectId
    && input.stagingTokenScope.environmentId === policy.environments[1].environmentId;
  checks.productionEnvironmentExact =
    production.environmentId === policy.environments[0].environmentId;
  checks.stagingEnvironmentExact =
    staging.environmentId === policy.environments[1].environmentId;
  checks.productionPatchEmpty =
    checks.productionEnvironmentExact && Object.keys(production.patch).length === 0;
  checks.stagingPatchEmpty =
    checks.stagingEnvironmentExact && Object.keys(staging.patch).length === 0;

  const expected = policy.productionPostgres;
  checks.productionPostgresExact =
    postgres.environmentId === expected.environmentId
    && postgres.serviceId === expected.serviceId
    && postgres.approvedDeployment?.id === expected.deploymentId
    && postgres.approvedDeployment.projectId === policy.projectId
    && postgres.approvedDeployment.environmentId === expected.environmentId
    && postgres.approvedDeployment.serviceId === expected.serviceId;
  checks.approvedDeploymentCurrent =
    checks.productionPostgresExact
    && postgres.latestDeployment?.id === expected.deploymentId;
  checks.approvedDeploymentActive =
    checks.productionPostgresExact
    && postgres.activeDeployments.length === 1
    && postgres.activeDeployments[0]?.id === expected.deploymentId;
  checks.approvedDeploymentHealthy =
    checks.approvedDeploymentCurrent
    && checks.approvedDeploymentActive
    && postgres.latestDeployment?.status === "SUCCESS"
    && postgres.latestDeployment.deploymentStopped === false
    && postgres.activeDeployments[0]?.status === "SUCCESS"
    && postgres.activeDeployments[0].deploymentStopped === false;
  checks.approvedSnapshotExact =
    checks.productionPostgresExact
    && postgres.approvedDeployment?.snapshotId === expected.snapshotId
    && postgres.latestDeployment?.snapshotId === expected.snapshotId;
  checks.approvedImageDigestExact =
    checks.productionPostgresExact
    && postgres.approvedDeployment?.imageDigest === expected.imageDigest;
  checks.deploymentPatchAbsent =
    checks.productionPostgresExact
    && postgres.approvedDeployment?.patchId === null;
  checks.sourceImageExact =
    postgres.sourceRepo === null
    && postgres.sourceImage === expected.sourceImage
    && postgres.approvedDeployment?.sourceImage === expected.sourceImage;
  checks.sourceReferenceImmutable =
    checks.sourceImageExact
    && sourceReferencePinsDigest(expected.sourceImage, expected.imageDigest);
  return checks;
}
