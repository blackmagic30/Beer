import crypto from "node:crypto";

export const PROTECTED_SCALE_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-scale-operation/v4" as const;

const PRIMARY_REGION = "asia-southeast1-eqsg3a";
const LEGACY_STAGING_REGION = "europe-west4-drams3a";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type ProtectedScaleDirection =
  | "out"
  | "converge-one"
  | "converge-production-two"
  | "quiesce-staging-zero"
  | "bootstrap-staging-one";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is JsonRecord {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

interface ParsedTopologySnapshot {
  readonly configuredReplicas: number;
  readonly configuredRegions: readonly {
    readonly region: string;
    readonly numReplicas: number;
  }[];
  readonly configuredTopologySha256: string;
  readonly legacyAggregateReplicas: number | null;
  readonly serviceSourceSha256: string;
  readonly stagedPatchEmpty: true;
}

function parseSnapshot(
  value: unknown,
  allowedRegions: readonly string[],
): ParsedTopologySnapshot | null {
  if (!exactKeys(value, [
    "configuredReplicas",
    "configuredRegions",
    "configuredTopologySha256",
    "legacyAggregateReplicas",
    "serviceSourceSha256",
    "stagedPatchEmpty",
  ]) || !Number.isSafeInteger(value.configuredReplicas)
    || Number(value.configuredReplicas) < 0
    || Number(value.configuredReplicas) > 50
    || !Array.isArray(value.configuredRegions)
    || !SHA256_PATTERN.test(String(value.configuredTopologySha256))
    || !SHA256_PATTERN.test(String(value.serviceSourceSha256))
    || value.stagedPatchEmpty !== true
    || !(value.legacyAggregateReplicas === null
      || Number.isSafeInteger(value.legacyAggregateReplicas)
        && Number(value.legacyAggregateReplicas) >= 0
        && Number(value.legacyAggregateReplicas) <= 50)) return null;

  const regions: { region: string; numReplicas: number }[] = [];
  for (const entry of value.configuredRegions) {
    if (!exactKeys(entry, ["region", "numReplicas"])
      || typeof entry.region !== "string"
      || !allowedRegions.includes(entry.region)
      || !Number.isSafeInteger(entry.numReplicas)
      || Number(entry.numReplicas) < 0
      || Number(entry.numReplicas) > 50) return null;
    regions.push({ region: entry.region, numReplicas: Number(entry.numReplicas) });
  }
  if (regions.some((entry, index) => index > 0
    && regions[index - 1]!.region >= entry.region)) return null;
  const configuredReplicas = Number(value.configuredReplicas);
  if (regions.reduce((total, entry) => total + entry.numReplicas, 0)
    !== configuredReplicas) return null;
  const configured = { configuredReplicas, configuredRegions: regions };
  if (sha256(canonical(configured)) !== value.configuredTopologySha256) return null;
  return {
    ...configured,
    configuredTopologySha256: String(value.configuredTopologySha256),
    legacyAggregateReplicas: value.legacyAggregateReplicas === null
      ? null
      : Number(value.legacyAggregateReplicas),
    serviceSourceSha256: String(value.serviceSourceSha256),
    stagedPatchEmpty: true,
  };
}

function configuredPlacementExact(
  snapshot: ParsedTopologySnapshot,
  replicas: number,
  placement: "primary" | "any-single",
  allowedRegions: readonly string[],
): boolean {
  if (snapshot.configuredReplicas !== replicas) return false;
  if (placement === "any-single") {
    return snapshot.configuredRegions.filter(({ numReplicas }) => numReplicas > 0)
      .length === 1
      && snapshot.configuredRegions.some(({ numReplicas }) => numReplicas === replicas);
  }
  return replicas === 0
    ? snapshot.configuredRegions.every(({ numReplicas }) => numReplicas === 0)
    : snapshot.configuredRegions.some(({ region, numReplicas }) =>
      region === PRIMARY_REGION && numReplicas === replicas)
      && snapshot.configuredRegions.every(({ region, numReplicas }) =>
        region === PRIMARY_REGION || numReplicas === 0)
      && snapshot.configuredRegions.every(({ region }) =>
        allowedRegions.includes(region));
}

function patchRegionsFor(
  allowedRegions: readonly string[],
  desiredReplicas: number,
): readonly { readonly region: string; readonly numReplicas: number }[] {
  return allowedRegions.map((region) => ({
    region,
    numReplicas: region === PRIMARY_REGION ? desiredReplicas : 0,
  }));
}

function beforeReplicaCount(
  direction: ProtectedScaleDirection,
  attempts: 0 | 1,
  desiredReplicas: 0 | 1 | 2,
): number {
  if (attempts === 0) return desiredReplicas;
  if (direction === "quiesce-staging-zero") return 1;
  if (direction === "bootstrap-staging-one") return 0;
  if (direction === "out" || direction === "converge-production-two") return 1;
  return 2;
}

export function protectedScaleReplicaTopologyExact(
  value: unknown,
  expected: {
    readonly direction: ProtectedScaleDirection;
    readonly attempts: 0 | 1;
    readonly desiredReplicas: 0 | 1 | 2;
    readonly target: "staging" | "production";
  },
): boolean {
  const allowedRegions = expected.target === "staging"
    ? [PRIMARY_REGION, LEGACY_STAGING_REGION]
    : [PRIMARY_REGION];
  if (!exactKeys(value, [
    "authoritySource",
    "primaryRegion",
    "allowedRegions",
    "before",
    "immediatelyBeforeWrite",
    "after",
    "patchRegions",
    "environmentConfigCollateralUnchanged",
  ]) || value.authoritySource !== "environment.config(decryptVariables:false)"
    || value.primaryRegion !== PRIMARY_REGION
    || canonical(value.allowedRegions) !== canonical(allowedRegions)
    || !Array.isArray(value.patchRegions)
    || value.patchRegions.some((entry) => !exactKeys(entry, ["region", "numReplicas"])
      || typeof entry.region !== "string"
      || !Number.isSafeInteger(entry.numReplicas))
    || value.environmentConfigCollateralUnchanged !== true) {
    return false;
  }
  const before = parseSnapshot(value.before, allowedRegions);
  const after = parseSnapshot(value.after, allowedRegions);
  if (!before || !after) return false;
  const beforePlacement = expected.direction === "quiesce-staging-zero"
    ? "any-single"
    : "primary";
  if (!configuredPlacementExact(
    before,
    beforeReplicaCount(
      expected.direction,
      expected.attempts,
      expected.desiredReplicas,
    ),
    beforePlacement,
    allowedRegions,
  ) || !configuredPlacementExact(
    after,
    expected.desiredReplicas,
    "primary",
    allowedRegions,
  )) {
    return false;
  }
  if (expected.attempts === 0) {
    return value.immediatelyBeforeWrite === null
      && value.patchRegions.length === 0
      && before.configuredTopologySha256 === after.configuredTopologySha256
      && before.serviceSourceSha256 === after.serviceSourceSha256;
  }
  const immediatelyBeforeWrite = parseSnapshot(
    value.immediatelyBeforeWrite,
    allowedRegions,
  );
  const expectedPatchRegions = patchRegionsFor(
    allowedRegions,
    expected.desiredReplicas,
  );
  return immediatelyBeforeWrite !== null
    && before.configuredTopologySha256
      === immediatelyBeforeWrite.configuredTopologySha256
    && before.serviceSourceSha256 === immediatelyBeforeWrite.serviceSourceSha256
    && before.serviceSourceSha256 === after.serviceSourceSha256
    && value.patchRegions.length === expectedPatchRegions.length
    && value.patchRegions.every((entry, index) =>
      entry.region === expectedPatchRegions[index]?.region &&
      entry.numReplicas === expectedPatchRegions[index]?.numReplicas);
}
