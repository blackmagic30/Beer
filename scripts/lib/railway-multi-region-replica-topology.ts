export const RAILWAY_MAX_REPLICAS_PER_REGION = 50 as const;
export const RAILWAY_MAX_TOTAL_REPLICAS = 50 as const;

const MAX_REGION_ENTRIES = 256;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const IPV4_PATTERN =
  /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

export type RailwayMultiRegionTopologyFailureCode =
  | "invalid-target-service-id"
  | "invalid-environment-config"
  | "invalid-services"
  | "invalid-target-service"
  | "invalid-deploy"
  | "invalid-multi-region-config"
  | "invalid-region-name"
  | "invalid-region-config"
  | "invalid-replica-count";

export interface RailwayRegionReplicaCount {
  readonly region: string;
  readonly numReplicas: number;
}

interface RailwayMultiRegionTopologyBase {
  readonly regions: readonly RailwayRegionReplicaCount[];
  readonly configuredTotal: number | null;
  readonly effectiveZero: boolean | null;
}

export interface RailwayMultiRegionTopologyInvalid
  extends RailwayMultiRegionTopologyBase {
  readonly kind: "invalid";
  readonly failureCode: RailwayMultiRegionTopologyFailureCode;
  readonly regions: readonly [];
  readonly configuredTotal: null;
  readonly effectiveZero: null;
}

export interface RailwayMultiRegionTopologyAbsent
  extends RailwayMultiRegionTopologyBase {
  readonly kind:
    | "target-service-absent"
    | "deploy-absent"
    | "multi-region-config-absent"
    | "multi-region-config-null";
  readonly regions: readonly [];
  readonly configuredTotal: null;
  readonly effectiveZero: null;
}

export interface RailwayMultiRegionTopologyConfigured
  extends RailwayMultiRegionTopologyBase {
  readonly kind: "configured";
  readonly regions: readonly RailwayRegionReplicaCount[];
  readonly configuredTotal: number;
  readonly effectiveZero: boolean;
}

export type RailwayMultiRegionReplicaTopology =
  | RailwayMultiRegionTopologyInvalid
  | RailwayMultiRegionTopologyAbsent
  | RailwayMultiRegionTopologyConfigured;

type OwnData =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "invalid" };

const EMPTY_REGIONS = Object.freeze([]) as readonly [];

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(record: Record<string, unknown>, key: string): OwnData {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { kind: "absent" };
  if (!("value" in descriptor) || !descriptor.enumerable) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value };
}

function invalid(
  failureCode: RailwayMultiRegionTopologyFailureCode,
): RailwayMultiRegionTopologyInvalid {
  return Object.freeze({
    kind: "invalid",
    failureCode,
    regions: EMPTY_REGIONS,
    configuredTotal: null,
    effectiveZero: null,
  });
}

function absent(
  kind: RailwayMultiRegionTopologyAbsent["kind"],
): RailwayMultiRegionTopologyAbsent {
  return Object.freeze({
    kind,
    regions: EMPTY_REGIONS,
    configuredTotal: null,
    effectiveZero: null,
  });
}

function validStackerAssignment(value: unknown): boolean {
  return value === null || value === "ALL_STACKERS" ||
    typeof value === "string" && IPV4_PATTERN.test(value);
}

function parseRegionCount(
  value: unknown,
): number | RailwayMultiRegionTopologyFailureCode {
  // Railway's environment-config and scale-patch representations use all of
  // these as an effective zero: a null region entry, an omitted/null count,
  // and (during transitions) an explicit numeric zero.
  if (value === null) return 0;
  if (!plainRecord(value)) return "invalid-region-config";

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
    keys.some((key) => key !== "numReplicas" && key !== "stackerAssignment")) {
    return "invalid-region-config";
  }

  const replicaData = ownData(value, "numReplicas");
  if (replicaData.kind === "invalid") return "invalid-region-config";
  const replicaValue = replicaData.kind === "absent" ? null : replicaData.value;
  if (replicaValue !== null &&
    (typeof replicaValue !== "number" ||
      !Number.isSafeInteger(replicaValue) ||
      replicaValue < 0 ||
      replicaValue > RAILWAY_MAX_REPLICAS_PER_REGION)) {
    return "invalid-replica-count";
  }

  const stackerData = ownData(value, "stackerAssignment");
  if (stackerData.kind === "invalid" ||
    stackerData.kind === "value" && !validStackerAssignment(stackerData.value)) {
    return "invalid-region-config";
  }

  return replicaValue ?? 0;
}

function compareRegions(
  left: RailwayRegionReplicaCount,
  right: RailwayRegionReplicaCount,
): number {
  return left.region < right.region ? -1 : left.region > right.region ? 1 : 0;
}

/**
 * Extracts only replica topology from a Railway `environment.config` object.
 *
 * The result never retains or returns the source config, sibling service
 * fields, variables, or provider values. Missing structural levels remain
 * distinct from an explicit configuration whose effective total is zero.
 */
export function parseRailwayMultiRegionReplicaTopology(
  environmentConfig: unknown,
  targetServiceId: string,
): RailwayMultiRegionReplicaTopology {
  try {
    if (!UUID_PATTERN.test(targetServiceId)) {
      return invalid("invalid-target-service-id");
    }
    if (!plainRecord(environmentConfig)) {
      return invalid("invalid-environment-config");
    }

    const servicesData = ownData(environmentConfig, "services");
    if (servicesData.kind === "invalid") return invalid("invalid-services");
    if (servicesData.kind === "absent") return absent("target-service-absent");
    if (!plainRecord(servicesData.value)) return invalid("invalid-services");

    const serviceData = ownData(servicesData.value, targetServiceId);
    if (serviceData.kind === "invalid") return invalid("invalid-target-service");
    if (serviceData.kind === "absent") return absent("target-service-absent");
    if (!plainRecord(serviceData.value)) return invalid("invalid-target-service");

    const deployData = ownData(serviceData.value, "deploy");
    if (deployData.kind === "invalid") return invalid("invalid-deploy");
    if (deployData.kind === "absent" || deployData.value === null) {
      return absent("deploy-absent");
    }
    if (!plainRecord(deployData.value)) return invalid("invalid-deploy");

    const multiRegionData = ownData(deployData.value, "multiRegionConfig");
    if (multiRegionData.kind === "invalid") {
      return invalid("invalid-multi-region-config");
    }
    if (multiRegionData.kind === "absent") {
      return absent("multi-region-config-absent");
    }
    if (multiRegionData.value === null) {
      return absent("multi-region-config-null");
    }
    if (!plainRecord(multiRegionData.value)) {
      return invalid("invalid-multi-region-config");
    }

    const regionKeys = Reflect.ownKeys(multiRegionData.value);
    if (regionKeys.length > MAX_REGION_ENTRIES ||
      regionKeys.some((key) => typeof key !== "string")) {
      return invalid("invalid-multi-region-config");
    }

    const regions: RailwayRegionReplicaCount[] = [];
    let configuredTotal = 0;
    for (const key of regionKeys) {
      const region = key as string;
      if (!REGION_PATTERN.test(region)) return invalid("invalid-region-name");
      const regionData = ownData(multiRegionData.value, region);
      if (regionData.kind !== "value") return invalid("invalid-region-config");
      const count = parseRegionCount(regionData.value);
      if (typeof count !== "number") return invalid(count);
      configuredTotal += count;
      if (configuredTotal > RAILWAY_MAX_TOTAL_REPLICAS) {
        return invalid("invalid-replica-count");
      }
      regions.push(Object.freeze({ region, numReplicas: count }));
    }

    regions.sort(compareRegions);
    return Object.freeze({
      kind: "configured",
      regions: Object.freeze(regions),
      configuredTotal,
      effectiveZero: configuredTotal === 0,
    });
  } catch {
    return invalid("invalid-environment-config");
  }
}
