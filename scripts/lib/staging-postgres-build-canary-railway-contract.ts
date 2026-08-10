import crypto from "node:crypto";

export const STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_STATE =
  "HARD_DISABLED_LIVE_FIXTURES_REQUIRED" as const;

const STRUCTURAL_CANDIDATE = "structural-candidate" as const;
const PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE =
  "page-info-sequence-shape-candidate" as const;

// This module is intentionally capability-pure. These public, non-secret pins
// are duplicated here so importing a parser cannot initialize operational
// modules, ambient fetch/process.env defaults, filesystem callbacks, or a
// provider client. Tests bind every duplicate to the reviewed runtime locks.
export const STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK = Object.freeze({
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  serviceId: "bb84fecc-a125-49ce-853f-d2f25f7019c5",
  serviceInstanceId: "716b4818-7695-4b9f-b5f9-35249e785a58",
  serviceName: "postgres-backup-canary-2d276b6",
  railwayConfigPath: "/railway.postgres-backup-canary.toml",
  expectedStartCommand: "node dist/scripts/staging-postgres-backup-canary.js",
  canarySchema: "pintpath-staging-postgres-backup-canary/v2",
  canaryScope: "permanent-staging-postgres-backup-authority-candidates",
  transportProfile: "railway-stock-localhost-ca-v1",
  rootCaDerSha256:
    "7f57985264fc79c7e85a8c0a5a954b538dd47d5d7f1481c0eb30908acd999ba9",
  expectedVariableNames: Object.freeze([
    "RAILPACK_PACKAGES",
    "STAGING_POSTGRES_CA_CANARY_MODE",
    "STAGING_POSTGRES_CA_CANARY_RAILWAY_CONFIG_PATH",
  ] as const),
} as const);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ACKNOWLEDGEMENT_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_PAGES = 20;
const MAX_ROWS = 2_000;
const MAX_DOMAINS = 100;
const MAX_ACTIVE_DEPLOYMENTS = 100;
const MAX_TCP_PROXIES = 100;

const DEPLOYMENT_STATUSES = new Set([
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "REMOVED",
  "SKIPPED",
  "SUCCESS",
  "WAITING",
] as const);

export type CanaryDeploymentStatus =
  | "CRASHED"
  | "DEPLOYING"
  | "FAILED"
  | "INITIALIZING"
  | "NEEDS_APPROVAL"
  | "QUEUED"
  | "REMOVED"
  | "SKIPPED"
  | "SUCCESS"
  | "WAITING";

interface PageInfoCandidate {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface CanaryDeploymentSummaryCandidate {
  readonly id: string;
  readonly status: CanaryDeploymentStatus;
  readonly deploymentStopped: boolean;
}

export interface CanaryServiceCandidate {
  readonly serviceInstanceId: string;
  readonly serviceId: string;
  readonly serviceNameExact: boolean;
  readonly environmentId: string;
  readonly replicaCount: number;
  readonly latestDeployment: CanaryDeploymentSummaryCandidate | null;
  readonly activeDeployments: readonly CanaryDeploymentSummaryCandidate[];
  readonly sourceAbsent: boolean;
  readonly domainIds: readonly string[];
  readonly cronScheduleAbsent: boolean;
  readonly startCommandExact: boolean;
}

export interface CanaryServiceInventoryPageCandidate extends PageInfoCandidate {
  readonly environmentId: string;
  readonly services: readonly CanaryServiceCandidate[];
}

export interface CanaryTargetServiceInventoryCandidate {
  readonly authority: typeof STRUCTURAL_CANDIDATE;
  readonly pageInfoSequenceShape: typeof PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE;
  readonly serviceRowCount: number;
  readonly target: CanaryServiceCandidate;
}

export interface CanaryVolumeCandidate {
  readonly volumeId: string;
  readonly serviceId: string | null;
  readonly environmentId: string;
}

export interface CanaryVolumeInventoryPageCandidate extends PageInfoCandidate {
  readonly environmentId: string;
  readonly volumes: readonly CanaryVolumeCandidate[];
}

export interface CanaryTargetVolumeInventoryCandidate {
  readonly authority: typeof STRUCTURAL_CANDIDATE;
  readonly pageInfoSequenceShape: typeof PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE;
  readonly volumeRowCount: number;
  readonly targetVolumeIds: readonly string[];
}

export interface CanaryDeploymentInventoryPageCandidate extends PageInfoCandidate {
  readonly deploymentIds: readonly string[];
}

export interface CanaryDeploymentInventoryCandidate {
  readonly authority: typeof STRUCTURAL_CANDIDATE;
  readonly pageInfoSequenceShape: typeof PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE;
  readonly deploymentIds: readonly string[];
}

export interface CanaryTcpProxyInventoryCandidate {
  readonly authority: typeof STRUCTURAL_CANDIDATE;
  readonly tcpProxyIds: readonly string[];
}

export interface CanaryVariableMetadataCandidate {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly unknown[];
}

export interface CanaryVariableInventoryPageCandidate extends PageInfoCandidate {
  readonly environmentId: string;
  readonly variables: readonly CanaryVariableMetadataCandidate[];
}

export interface CanaryVariableInventoryCandidate {
  readonly authority: typeof STRUCTURAL_CANDIDATE;
  readonly pageInfoSequenceShape: typeof PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE;
  readonly variableNames: readonly string[];
  readonly variableMetadataExact: true;
}

export interface CanaryUploadAcknowledgementCandidate {
  readonly authority: typeof STRUCTURAL_CANDIDATE;
  readonly deploymentId: string;
}

export interface CanaryDirectDeploymentCandidate {
  readonly authority: typeof STRUCTURAL_CANDIDATE;
  readonly deploymentId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly status: CanaryDeploymentStatus;
  readonly deploymentStopped: boolean;
  readonly snapshotId: string | null;
  readonly imageDigest: string | null;
}

export interface CanaryBuildOnlyReceiptCandidate {
  readonly authority: typeof STRUCTURAL_CANDIDATE;
  readonly deploymentId: string;
  readonly buildOnlyReceiptPassed: true;
  readonly buildOnlyReceiptSha256: string;
  readonly credentialCandidatesNull: true;
  readonly dedicatedRailwayConfig: true;
  readonly runtimePublicConfigurationExact: true;
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

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoundedJson(source: string, maximumBytes = MAX_RESPONSE_BYTES): unknown | null {
  if (
    Buffer.byteLength(source, "utf8") === 0
    || Buffer.byteLength(source, "utf8") > maximumBytes
    || source.includes("\0")
  ) return null;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

function safeString(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && Buffer.byteLength(value, "utf8") <= maximumBytes
    && value === value.trim()
    && !/[\r\n\0]/.test(value);
}

function nullableSafeString(value: unknown, maximumBytes: number): value is string | null {
  return value === null || safeString(value, maximumBytes);
}

function deploymentStatus(value: unknown): value is CanaryDeploymentStatus {
  return typeof value === "string" && DEPLOYMENT_STATUSES.has(
    value as CanaryDeploymentStatus,
  );
}

function bytewiseSorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function exactStringArray(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length
    && expected.every((value, index) => actual[index] === value);
}

function parsePageInfo(value: unknown): PageInfoCandidate | null {
  if (
    !exactKeys(value, ["hasNextPage", "endCursor"])
    || typeof value.hasNextPage !== "boolean"
    || !(value.endCursor === null || safeString(value.endCursor, 512))
  ) return null;
  if (value.hasNextPage && value.endCursor === null) return null;
  return {
    hasNextPage: value.hasNextPage,
    endCursor: value.endCursor,
  };
}

function pageInfoSequenceShapeCandidate(
  pages: unknown,
): pages is readonly PageInfoCandidate[] {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > MAX_PAGES) {
    return false;
  }
  const cursors = new Set<string>();
  for (let index = 0; index < pages.length; index += 1) {
    const page: unknown = pages[index];
    if (
      !plainObject(page)
      || typeof page.hasNextPage !== "boolean"
      || !(page.endCursor === null || safeString(page.endCursor, 512))
    ) return false;
    const shouldHaveNext = index < pages.length - 1;
    if (page.hasNextPage !== shouldHaveNext) return false;
    if (shouldHaveNext && page.endCursor === null) return false;
    if (page.endCursor !== null) {
      if (cursors.has(page.endCursor)) return false;
      cursors.add(page.endCursor);
    }
  }
  return true;
}

function parseDeploymentSummary(value: unknown): CanaryDeploymentSummaryCandidate | null {
  if (
    !exactKeys(value, ["id", "status", "deploymentStopped"])
    || typeof value.id !== "string"
    || !UUID_PATTERN.test(value.id)
    || !deploymentStatus(value.status)
    || typeof value.deploymentStopped !== "boolean"
  ) return null;
  return {
    id: value.id,
    status: value.status,
    deploymentStopped: value.deploymentStopped,
  };
}

function parseDomainIds(value: unknown): string[] | null {
  if (!exactKeys(value, ["serviceDomains", "customDomains"])) return null;
  if (
    !Array.isArray(value.serviceDomains)
    || !Array.isArray(value.customDomains)
    || value.serviceDomains.length > MAX_DOMAINS
    || value.customDomains.length > MAX_DOMAINS
  ) return null;
  const ids: string[] = [];
  for (const candidate of [...value.serviceDomains, ...value.customDomains]) {
    if (
      !exactKeys(candidate, ["id"])
      || typeof candidate.id !== "string"
      || !UUID_PATTERN.test(candidate.id)
    ) return null;
    ids.push(candidate.id);
  }
  if (new Set(ids).size !== ids.length) return null;
  return bytewiseSorted(ids);
}

function parseService(value: unknown): CanaryServiceCandidate | null {
  if (!exactKeys(value, [
    "id",
    "serviceId",
    "serviceName",
    "environmentId",
    "numReplicas",
    "latestDeployment",
    "activeDeployments",
    "source",
    "domains",
    "cronSchedule",
    "startCommand",
  ])) return null;
  if (
    typeof value.id !== "string"
    || !UUID_PATTERN.test(value.id)
    || typeof value.serviceId !== "string"
    || !UUID_PATTERN.test(value.serviceId)
    || !safeString(value.serviceName, 128)
    || typeof value.environmentId !== "string"
    || !UUID_PATTERN.test(value.environmentId)
    || !Number.isSafeInteger(value.numReplicas)
    || (value.numReplicas as number) < 0
    || (value.numReplicas as number) > 50
    || !Array.isArray(value.activeDeployments)
    || value.activeDeployments.length > MAX_ACTIVE_DEPLOYMENTS
    || !nullableSafeString(value.cronSchedule, 512)
    || !nullableSafeString(value.startCommand, 4_096)
  ) return null;
  let sourceAbsent = value.source === null;
  if (value.source !== null) {
    if (
      !exactKeys(value.source, ["repo", "image"])
      || !nullableSafeString(value.source.repo, 512)
      || !nullableSafeString(value.source.image, 512)
    ) return null;
    sourceAbsent = value.source.repo === null && value.source.image === null;
  }
  let latestDeployment: CanaryDeploymentSummaryCandidate | null = null;
  if (value.latestDeployment !== null) {
    latestDeployment = parseDeploymentSummary(value.latestDeployment);
    if (!latestDeployment) return null;
  }
  const activeDeployments: CanaryDeploymentSummaryCandidate[] = [];
  for (const candidate of value.activeDeployments) {
    const parsed = parseDeploymentSummary(candidate);
    if (!parsed) return null;
    activeDeployments.push(parsed);
  }
  if (
    new Set(activeDeployments.map((deployment) => deployment.id)).size
      !== activeDeployments.length
  ) return null;
  const domainIds = parseDomainIds(value.domains);
  if (!domainIds) return null;
  return {
    serviceInstanceId: value.id,
    serviceId: value.serviceId,
    serviceNameExact:
      value.serviceName
      === STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.serviceName,
    environmentId: value.environmentId,
    replicaCount: value.numReplicas as number,
    latestDeployment,
    activeDeployments,
    sourceAbsent,
    domainIds,
    cronScheduleAbsent: value.cronSchedule === null,
    startCommandExact:
      value.startCommand
      === STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.expectedStartCommand,
  };
}

export function parseCanaryServiceInventoryPage(
  source: string,
): CanaryServiceInventoryPageCandidate | null {
  const parsed = parseBoundedJson(source);
  if (!exactKeys(parsed, ["data"])) return null;
  if (!exactKeys(parsed.data, ["environment"])) return null;
  const environment = parsed.data.environment;
  if (
    !exactKeys(environment, ["id", "serviceInstances"])
    || typeof environment.id !== "string"
    || !UUID_PATTERN.test(environment.id)
    || !exactKeys(environment.serviceInstances, ["edges", "pageInfo"])
    || !Array.isArray(environment.serviceInstances.edges)
    || environment.serviceInstances.edges.length > 100
  ) return null;
  const pageInfo = parsePageInfo(environment.serviceInstances.pageInfo);
  if (!pageInfo) return null;
  const services: CanaryServiceCandidate[] = [];
  for (const edge of environment.serviceInstances.edges) {
    if (!exactKeys(edge, ["node"])) return null;
    const service = parseService(edge.node);
    if (!service || service.environmentId !== environment.id) return null;
    services.push(service);
  }
  return {
    environmentId: environment.id,
    services,
    ...pageInfo,
  };
}

export function foldCanaryServiceInventoryPages(
  pages: readonly CanaryServiceInventoryPageCandidate[],
): CanaryTargetServiceInventoryCandidate | null {
  if (!pageInfoSequenceShapeCandidate(pages)) return null;
  const services = pages.flatMap((page) => {
    if (
      page.environmentId
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.environmentId
    ) {
      return [];
    }
    return [...page.services];
  });
  if (
    pages.some((page) =>
      page.environmentId
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.environmentId
    )
    || services.length > MAX_ROWS
    || services.some((service) => service.environmentId !== pageEnvironmentId())
    || new Set(services.map((service) => service.serviceInstanceId)).size
      !== services.length
    || new Set(services.map((service) => service.serviceId)).size !== services.length
  ) return null;
  const targets = services.filter((service) =>
    service.serviceId === STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.serviceId
  );
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  if (
    target.serviceInstanceId
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.serviceInstanceId
    || target.serviceNameExact !== true
  ) return null;
  return {
    authority: STRUCTURAL_CANDIDATE,
    pageInfoSequenceShape: PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE,
    serviceRowCount: services.length,
    target,
  };
}

function pageEnvironmentId(): string {
  return STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.environmentId;
}

export function parseCanaryVolumeInventoryPage(
  source: string,
): CanaryVolumeInventoryPageCandidate | null {
  const parsed = parseBoundedJson(source);
  if (!exactKeys(parsed, ["data"])) return null;
  if (!exactKeys(parsed.data, ["environment"])) return null;
  const environment = parsed.data.environment;
  if (
    !exactKeys(environment, ["id", "volumeInstances"])
    || typeof environment.id !== "string"
    || !UUID_PATTERN.test(environment.id)
    || !exactKeys(environment.volumeInstances, ["edges", "pageInfo"])
    || !Array.isArray(environment.volumeInstances.edges)
    || environment.volumeInstances.edges.length > 100
  ) return null;
  const pageInfo = parsePageInfo(environment.volumeInstances.pageInfo);
  if (!pageInfo) return null;
  const volumes: CanaryVolumeCandidate[] = [];
  for (const edge of environment.volumeInstances.edges) {
    if (!exactKeys(edge, ["node"])) return null;
    const node = edge.node;
    if (
      !exactKeys(node, ["serviceId", "environmentId", "volume"])
      || !(node.serviceId === null
        || (typeof node.serviceId === "string" && UUID_PATTERN.test(node.serviceId)))
      || typeof node.environmentId !== "string"
      || node.environmentId !== environment.id
      || !exactKeys(node.volume, ["id"])
      || typeof node.volume.id !== "string"
      || !UUID_PATTERN.test(node.volume.id)
    ) return null;
    volumes.push({
      volumeId: node.volume.id,
      serviceId: node.serviceId,
      environmentId: node.environmentId,
    });
  }
  return {
    environmentId: environment.id,
    volumes,
    ...pageInfo,
  };
}

export function foldCanaryVolumeInventoryPages(
  pages: readonly CanaryVolumeInventoryPageCandidate[],
): CanaryTargetVolumeInventoryCandidate | null {
  if (
    !pageInfoSequenceShapeCandidate(pages)
    || pages.some((page) => page.environmentId !== pageEnvironmentId())
  ) return null;
  const volumes = pages.flatMap((page) => [...page.volumes]);
  if (
    volumes.length > MAX_ROWS
    || volumes.some((volume) => volume.environmentId !== pageEnvironmentId())
    || new Set(volumes.map((volume) => volume.volumeId)).size !== volumes.length
  ) return null;
  return {
    authority: STRUCTURAL_CANDIDATE,
    pageInfoSequenceShape: PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE,
    volumeRowCount: volumes.length,
    targetVolumeIds: bytewiseSorted(volumes
      .filter((volume) =>
        volume.serviceId
        === STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.serviceId
      )
      .map((volume) => volume.volumeId)),
  };
}

export function parseCanaryDeploymentInventoryPage(
  source: string,
): CanaryDeploymentInventoryPageCandidate | null {
  const parsed = parseBoundedJson(source);
  if (!exactKeys(parsed, ["data"])) return null;
  if (!exactKeys(parsed.data, ["deployments"])) return null;
  const connection = parsed.data.deployments;
  if (
    !exactKeys(connection, ["edges", "pageInfo"])
    || !Array.isArray(connection.edges)
    || connection.edges.length > 100
  ) return null;
  const pageInfo = parsePageInfo(connection.pageInfo);
  if (!pageInfo) return null;
  const deploymentIds: string[] = [];
  for (const edge of connection.edges) {
    if (
      !exactKeys(edge, ["node"])
      || !exactKeys(edge.node, ["id"])
      || typeof edge.node.id !== "string"
      || !UUID_PATTERN.test(edge.node.id)
    ) return null;
    deploymentIds.push(edge.node.id);
  }
  if (new Set(deploymentIds).size !== deploymentIds.length) return null;
  return { deploymentIds, ...pageInfo };
}

export function foldCanaryDeploymentInventoryPages(
  pages: readonly CanaryDeploymentInventoryPageCandidate[],
): CanaryDeploymentInventoryCandidate | null {
  if (!pageInfoSequenceShapeCandidate(pages)) return null;
  const deploymentIds = pages.flatMap((page) => [...page.deploymentIds]);
  if (
    deploymentIds.length > MAX_ROWS
    || new Set(deploymentIds).size !== deploymentIds.length
  ) return null;
  return {
    authority: STRUCTURAL_CANDIDATE,
    pageInfoSequenceShape: PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE,
    deploymentIds: bytewiseSorted(deploymentIds),
  };
}

export function parseCanaryTcpProxyInventoryResponse(
  source: string,
): CanaryTcpProxyInventoryCandidate | null {
  const parsed = parseBoundedJson(source);
  if (!exactKeys(parsed, ["data"])) return null;
  if (
    !exactKeys(parsed.data, ["tcpProxies"])
    || !Array.isArray(parsed.data.tcpProxies)
    || parsed.data.tcpProxies.length > MAX_TCP_PROXIES
  ) return null;
  const ids: string[] = [];
  for (const proxy of parsed.data.tcpProxies) {
    if (
      !exactKeys(proxy, ["id", "serviceId", "environmentId", "deletedAt"])
      || typeof proxy.id !== "string"
      || !UUID_PATTERN.test(proxy.id)
      || proxy.serviceId
        !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.serviceId
      || proxy.environmentId
        !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.environmentId
      || !(proxy.deletedAt === null || safeString(proxy.deletedAt, 128))
    ) return null;
    ids.push(proxy.id);
  }
  if (new Set(ids).size !== ids.length) return null;
  return {
    authority: STRUCTURAL_CANDIDATE,
    tcpProxyIds: bytewiseSorted(ids),
  };
}

export function evaluateCanaryVariableInventory(
  pages: readonly CanaryVariableInventoryPageCandidate[],
): CanaryVariableInventoryCandidate | null {
  if (
    !pageInfoSequenceShapeCandidate(pages)
    || pages.some((page) => page.environmentId !== pageEnvironmentId())
  ) return null;
  const variables = pages.flatMap((page) => [...page.variables]);
  if (
    variables.length > MAX_ROWS
    || variables.some((variable) => variable.environmentId !== pageEnvironmentId())
    || new Set(variables.map((variable) => variable.id)).size !== variables.length
  ) return null;
  const tupleKeys = variables.map((variable) =>
    `${variable.serviceId ?? "shared"}\0${variable.name}`
  );
  if (new Set(tupleKeys).size !== tupleKeys.length) return null;
  const target = variables.filter((variable) =>
    variable.serviceId === STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.serviceId
  );
  const governedNames = new Set<string>(
    STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.expectedVariableNames,
  );
  const sharedShadowPresent = variables.some((variable) =>
    variable.serviceId === null && governedNames.has(variable.name)
  );
  const names = bytewiseSorted(target.map((variable) => variable.name));
  if (
    sharedShadowPresent
    || target.some((variable) =>
      variable.isSealed !== false || variable.references.length !== 0
    )
    || new Set(names).size !== names.length
    || !exactStringArray(
      names,
      STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.expectedVariableNames,
    )
  ) return null;
  return {
    authority: STRUCTURAL_CANDIDATE,
    pageInfoSequenceShape: PAGE_INFO_SEQUENCE_SHAPE_CANDIDATE,
    variableNames: [
      ...STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.expectedVariableNames,
    ],
    variableMetadataExact: true,
  };
}

function exactRailwayLogsUrl(value: unknown, deploymentId: string): boolean {
  if (!safeString(value, 4_096)) return false;
  const expected = `https://railway.com/project/${
    STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.projectId
  }/service/${STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.serviceId}?environmentId=${
    STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.environmentId
  }&id=${deploymentId}`;
  if (value !== expected) return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === "https://railway.com"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

export function parseCanaryUploadAcknowledgement(
  source: string,
): CanaryUploadAcknowledgementCandidate | null {
  if (
    Buffer.byteLength(source, "utf8") > MAX_ACKNOWLEDGEMENT_BYTES
    || !source.endsWith("\n")
    || source.slice(0, -1).includes("\n")
  ) return null;
  const parsed = parseBoundedJson(source, MAX_ACKNOWLEDGEMENT_BYTES);
  if (
    !exactKeys(parsed, ["deploymentId", "logsUrl"])
    || typeof parsed.deploymentId !== "string"
    || !UUID_PATTERN.test(parsed.deploymentId)
    || !exactRailwayLogsUrl(parsed.logsUrl, parsed.deploymentId)
    || `${JSON.stringify(parsed)}\n` !== source
  ) return null;
  return {
    authority: STRUCTURAL_CANDIDATE,
    deploymentId: parsed.deploymentId,
  };
}

export function parseCanaryDirectDeploymentResponse(
  source: string,
  expectedDeploymentId: string,
): CanaryDirectDeploymentCandidate | null {
  if (!UUID_PATTERN.test(expectedDeploymentId)) return null;
  const parsed = parseBoundedJson(source);
  if (!exactKeys(parsed, ["data"])) return null;
  if (!exactKeys(parsed.data, ["deployment"])) return null;
  const deployment = parsed.data.deployment;
  if (
    !exactKeys(deployment, [
      "id",
      "projectId",
      "environmentId",
      "serviceId",
      "status",
      "deploymentStopped",
      "snapshotId",
      "meta",
    ])
    || deployment.id !== expectedDeploymentId
    || deployment.projectId
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.projectId
    || deployment.environmentId
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.environmentId
    || deployment.serviceId
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.serviceId
    || !deploymentStatus(deployment.status)
    || typeof deployment.deploymentStopped !== "boolean"
    || !(deployment.snapshotId === null
      || (typeof deployment.snapshotId === "string"
        && UUID_PATTERN.test(deployment.snapshotId)))
    || !plainObject(deployment.meta)
  ) return null;
  const imageDigest = Object.hasOwn(deployment.meta, "imageDigest")
    ? deployment.meta.imageDigest
    : undefined;
  if (
    !(imageDigest === undefined
      || imageDigest === null
      || (typeof imageDigest === "string" && IMAGE_DIGEST_PATTERN.test(imageDigest)))
  ) return null;
  return {
    authority: STRUCTURAL_CANDIDATE,
    deploymentId: deployment.id,
    projectId: deployment.projectId,
    environmentId: deployment.environmentId,
    serviceId: deployment.serviceId,
    status: deployment.status,
    deploymentStopped: deployment.deploymentStopped,
    snapshotId: deployment.snapshotId,
    imageDigest: typeof imageDigest === "string" ? imageDigest : null,
  };
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "scope",
  "mode",
  "outcome",
  "deploymentId",
  "transport",
  "candidates",
  "identity",
] as const;
const IDENTITY_KEYS = [
  "railwayProject",
  "railwayEnvironment",
  "railwayService",
  "railwayServiceName",
  "railwayDeployment",
  "dedicatedRailwayConfig",
  "forbiddenEnvironmentAbsent",
  "node22_23_2",
  "credentialEnvironmentCleared",
  "credentialInputsExact",
  "runtimeUidExact",
  "adminUrlAuthority",
  "rootCaAuthority",
  "transportAuthority",
  "tlsScram",
  "readOnlyTransaction",
  "stagingDatabase",
  "administrator",
] as const;
const TRUE_BUILD_ONLY_IDENTITIES = new Set<string>([
  "railwayProject",
  "railwayEnvironment",
  "railwayService",
  "railwayServiceName",
  "railwayDeployment",
  "dedicatedRailwayConfig",
  "forbiddenEnvironmentAbsent",
  "node22_23_2",
  "credentialEnvironmentCleared",
  "credentialInputsExact",
  "runtimeUidExact",
] as const);

export function parseCanonicalBuildOnlyReceipt(
  source: string,
  expectedDeploymentId: string,
): CanaryBuildOnlyReceiptCandidate | null {
  if (
    !UUID_PATTERN.test(expectedDeploymentId)
    || Buffer.byteLength(source, "utf8") > MAX_RECEIPT_BYTES
    || !source.endsWith("\n")
    || source.slice(0, -1).includes("\n")
  ) return null;
  const parsed = parseBoundedJson(source, MAX_RECEIPT_BYTES);
  if (
    !exactKeys(parsed, RECEIPT_KEYS)
    || parsed.schemaVersion
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.canarySchema
    || parsed.scope !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.canaryScope
    || parsed.mode !== "build-only"
    || parsed.outcome !== "passed"
    || parsed.deploymentId !== expectedDeploymentId
  ) return null;
  const transport = parsed.transport;
  const candidates = parsed.candidates;
  const identity = parsed.identity;
  if (
    !exactKeys(transport, ["profile", "rootCaDerSha256"])
    || transport.profile
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.transportProfile
    || transport.rootCaDerSha256
      !== STAGING_POSTGRES_BUILD_CANARY_RAILWAY_CONTRACT_LOCK.rootCaDerSha256
    || !exactKeys(candidates, [
      "adminUrlSha256",
      "databaseIdentitySha256",
    ])
    || candidates.adminUrlSha256 !== null
    || candidates.databaseIdentitySha256 !== null
    || !exactKeys(identity, IDENTITY_KEYS)
  ) return null;
  if (
    IDENTITY_KEYS.some((key) =>
      identity[key] !== TRUE_BUILD_ONLY_IDENTITIES.has(key)
    )
    || `${JSON.stringify(parsed)}\n` !== source
  ) return null;
  return {
    authority: STRUCTURAL_CANDIDATE,
    deploymentId: expectedDeploymentId,
    buildOnlyReceiptPassed: true,
    buildOnlyReceiptSha256: crypto.createHash("sha256").update(source, "utf8").digest("hex"),
    credentialCandidatesNull: true,
    dedicatedRailwayConfig: true,
    runtimePublicConfigurationExact: true,
  };
}

export function assembleAuthoritativePreflight(
  ..._candidates: readonly unknown[]
): null {
  return null;
}

export function assembleAuthoritativePostflight(
  ..._candidates: readonly unknown[]
): null {
  return null;
}
