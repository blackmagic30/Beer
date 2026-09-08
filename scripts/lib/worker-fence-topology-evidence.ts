import crypto from "node:crypto";

import type { RailwayRegionReplicaCount } from
  "./railway-multi-region-replica-topology.js";

const PRIMARY_REGION = "asia-southeast1-eqsg3a";
const LEGACY_STAGING_REGION = "europe-west4-drams3a";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

export interface WorkerFenceTopologySource {
  readonly configuredTopology: {
    readonly configuredReplicas: number;
    readonly regions: readonly RailwayRegionReplicaCount[];
  };
  readonly numReplicas: number | null;
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is JsonRecord {
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

export function workerFenceTopologySnapshot(
  source: WorkerFenceTopologySource | null,
) {
  if (source === null) return null;
  const configuredReplicas = source.configuredTopology.configuredReplicas;
  const configuredRegions = source.configuredTopology.regions.map(
    ({ region, numReplicas }) => ({ region, numReplicas }),
  );
  const configured = { configuredReplicas, configuredRegions };
  return {
    ...configured,
    configuredTopologySha256: sha256(canonical(configured)),
    legacyAggregateReplicas: source.numReplicas,
  };
}

export function workerFenceTopologyEvidence(
  target: "permanent-staging" | "production",
  before: WorkerFenceTopologySource | null,
  immediatelyBeforeWrite: WorkerFenceTopologySource | null,
  after: WorkerFenceTopologySource | null,
) {
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: PRIMARY_REGION,
    allowedRegions: target === "permanent-staging"
      ? [PRIMARY_REGION, LEGACY_STAGING_REGION]
      : [PRIMARY_REGION],
    before: workerFenceTopologySnapshot(before),
    immediatelyBeforeWrite: workerFenceTopologySnapshot(immediatelyBeforeWrite),
    after: workerFenceTopologySnapshot(after),
  };
}

interface ParsedSnapshot {
  readonly configuredReplicas: number;
  readonly configuredRegions: readonly RailwayRegionReplicaCount[];
  readonly configuredTopologySha256: string;
}

function parseSnapshot(value: unknown, allowedRegions: readonly string[]): ParsedSnapshot | null {
  if (!exact(value, [
    "configuredReplicas",
    "configuredRegions",
    "configuredTopologySha256",
    "legacyAggregateReplicas",
  ]) || !Number.isSafeInteger(value.configuredReplicas)
    || Number(value.configuredReplicas) < 0
    || Number(value.configuredReplicas) > 50
    || !Array.isArray(value.configuredRegions)
    || !SHA256_PATTERN.test(String(value.configuredTopologySha256))
    || !(value.legacyAggregateReplicas === null
      || Number.isSafeInteger(value.legacyAggregateReplicas)
        && Number(value.legacyAggregateReplicas) >= 0
        && Number(value.legacyAggregateReplicas) <= 50)) return null;
  const regions: RailwayRegionReplicaCount[] = [];
  for (const item of value.configuredRegions) {
    if (!exact(item, ["region", "numReplicas"])
      || typeof item.region !== "string"
      || !allowedRegions.includes(item.region)
      || !Number.isSafeInteger(item.numReplicas)
      || Number(item.numReplicas) < 0
      || Number(item.numReplicas) > 50) return null;
    regions.push({ region: item.region, numReplicas: Number(item.numReplicas) });
  }
  if (regions.some((item, index) => index > 0
    && regions[index - 1]!.region >= item.region)) return null;
  const configuredReplicas = Number(value.configuredReplicas);
  if (regions.reduce((total, item) => total + item.numReplicas, 0)
    !== configuredReplicas) return null;
  const configured = { configuredReplicas, configuredRegions: regions };
  if (sha256(canonical(configured)) !== value.configuredTopologySha256) return null;
  return {
    ...configured,
    configuredTopologySha256: String(value.configuredTopologySha256),
  };
}

function placementExact(
  snapshot: ParsedSnapshot,
  allowLegacyStagingRegion: boolean,
): boolean {
  if (snapshot.configuredReplicas !== 1) return false;
  if (allowLegacyStagingRegion) {
    return snapshot.configuredRegions.filter(({ numReplicas }) => numReplicas > 0)
      .length === 1
      && snapshot.configuredRegions.some(({ numReplicas }) => numReplicas === 1);
  }
  return snapshot.configuredRegions.some(({ region, numReplicas }) =>
    region === PRIMARY_REGION && numReplicas === 1)
    && snapshot.configuredRegions.every(({ region, numReplicas }) =>
      region === PRIMARY_REGION || numReplicas === 0);
}

export function workerFenceTopologyEvidenceExact(
  value: unknown,
  expected: {
    readonly target: "permanent-staging" | "production";
    readonly operation: "prepare" | "fence" | "activate" | "restore";
    readonly writeAttempted: boolean;
  },
): boolean {
  const allowedRegions = expected.target === "permanent-staging"
    ? [PRIMARY_REGION, LEGACY_STAGING_REGION]
    : [PRIMARY_REGION];
  if (!exact(value, [
    "authoritySource",
    "primaryRegion",
    "allowedRegions",
    "before",
    "immediatelyBeforeWrite",
    "after",
  ]) || value.authoritySource !== "environment.config(decryptVariables:false)"
    || value.primaryRegion !== PRIMARY_REGION
    || canonical(value.allowedRegions) !== canonical(allowedRegions)) return false;
  const before = parseSnapshot(value.before, allowedRegions);
  const after = parseSnapshot(value.after, allowedRegions);
  if (!before || !after) return false;
  const legacyPlacement = expected.target === "permanent-staging"
    && expected.operation === "prepare";
  if (!placementExact(before, legacyPlacement)
    || !placementExact(after, legacyPlacement)
    || before.configuredTopologySha256 !== after.configuredTopologySha256) {
    return false;
  }
  if (!expected.writeAttempted) return value.immediatelyBeforeWrite === null;
  const prewrite = parseSnapshot(value.immediatelyBeforeWrite, allowedRegions);
  return prewrite !== null
    && placementExact(prewrite, legacyPlacement)
    && before.configuredTopologySha256 === prewrite.configuredTopologySha256;
}
