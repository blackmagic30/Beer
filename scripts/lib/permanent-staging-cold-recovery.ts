import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runRailwayMutationBoundaryCheck } from
  "../check-railway-mutation-boundary.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./trusted-filesystem.js";

export const COLD_RECOVERY_POLICY_PATH =
  "ops/railway/permanent-staging-cold-recovery-policy.json" as const;
export const COLD_RECOVERY_POLICY_SHA256 =
  "1df2038eee8e785f49d35057a701f94a4b7ec41d38987938d658fb1a9744746c" as const;
export const COLD_RECOVERY_BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json" as const;
export const COLD_RECOVERY_BOUNDARY_POLICY_SHA256 =
  "9392f0c605dec43657d4d3a5a6ce40d57fe9beb70fce5ff496bb1a5f2fed3fed" as const;
export const COLD_RECOVERY_CLI_SHA256 =
  "27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43" as const;

export const COLD_RECOVERY_LOCK = Object.freeze({
  repository: "blackmagic30/Beer",
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  forbiddenProductionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
  serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  serviceInstanceId: "5a2f3970-2850-44e0-9b6c-f5c7627dde13",
  deploymentId: "c71fdb35-2be0-4031-b952-85595dfb2913",
  snapshotId: "f1061f4f-e1dd-49f3-b91a-60efbc3d6841",
  sourceSha: "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba",
  domainId: "afbb2417-c6df-48e3-9987-271b10ab2962",
  domain: "beer-staging.up.railway.app",
  targetPort: 8_080,
  region: "asia-southeast1-eqsg3a",
} as const);

export const COLD_RECOVERY_SCOPE_QUERY =
  `query PintPathPermanentStagingColdRecoveryScope { projectToken { projectId environmentId } }`;
export const COLD_RECOVERY_STATE_QUERY =
  `query PintPathPermanentStagingColdRecoveryState(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  environment(id:$environmentId,projectId:$projectId) {
    id
    variables(first:100) {
      edges { node { id name environmentId serviceId isSealed references } }
      pageInfo { hasNextPage endCursor }
    }
  }
  staged: environmentStagedChanges(environmentId:$environmentId) {
    environmentId
    patch(decryptVariables:false)
  }
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
    id
    serviceId
    environmentId
    numReplicas
    source { repo image }
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
    domains {
      serviceDomains { id domain targetPort }
      customDomains { id domain targetPort }
    }
  }
  deployment(id:$deploymentId) {
    id
    projectId
    environmentId
    serviceId
    snapshotId
    meta
  }
}`;
export const COLD_RECOVERY_PREPARE_MUTATION =
  `mutation PintPathPermanentStagingColdPrepare(
  $projectId: String!
  $serviceId: String!
  $environmentId: String!
  $variables: EnvironmentVariables!
  $skipDeploys: Boolean
) {
  variableCollectionUpsert(input:{projectId:$projectId,serviceId:$serviceId,environmentId:$environmentId,variables:$variables,skipDeploys:$skipDeploys})
}`;

const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const MAX_PROVIDER_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{0,255}$/;
const TARGET_VARIABLES = Object.freeze([
  "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED",
  "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
] as const);
const REQUIRED_REFERENCES = Object.freeze({
  DATABASE_URL: Object.freeze([
    "c454955f-263b-4599-aee0-dc447a4d3d15.PINTPATH_RUNTIME_DATABASE_URL",
  ]),
  REDIS_URL: Object.freeze([
    "d6351cec-fe04-4a6f-8e05-1cc164ea1e73.REDIS_URL",
  ]),
} as const);
const REQUIRED_UNREFERENCED = Object.freeze([
  "ALCOHOL_GAMIFICATION_ENABLED",
  "CONSUMER_PAID_ENROLLMENT_ENABLED",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_MAPS_MAP_ID",
  "GOOGLE_PLACES_API_KEY",
  "OPENAI_API_KEY",
  "PINT_POINTS_REWARDS_ENABLED",
  "PUBLIC_BASE_URL",
  "REPORT_DELIVERY_SCHEDULE_ENABLED",
  "SUPABASE_ANON_KEY",
  "SUPABASE_RESULTS_TABLE",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
] as const);
const FORBIDDEN_VARIABLES = Object.freeze([
  "OFFSITE_BACKUP_BUCKET",
  "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
  "OFFSITE_BACKUP_SUPABASE_URL",
] as const);
const SUPABASE_REPLACEMENT_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-variable-mutation/v4" as const;
const SUPABASE_REPLACEMENT_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-variable-mutation-terminal/v4" as const;
const EXTERNAL_MUTATION_FREEZE_ATTESTATION =
  "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN" as const;
const EXTERNAL_MUTATION_FREEZE_ENFORCEMENT =
  "OPERATIONAL_NOT_PROVIDER_VERIFIED" as const;

export interface ColdRecoveryVariableRow {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly string[];
}

export interface ColdRecoveryState {
  readonly environmentId: string;
  readonly serviceInstanceId: string;
  readonly serviceId: string;
  readonly numReplicas: null | 0;
  readonly source: { readonly repo: null; readonly image: null };
  readonly latestDeployment: {
    readonly id: string;
    readonly status: "FAILED";
    readonly deploymentStopped: true;
    readonly snapshotId: string;
  };
  readonly activeDeployments: readonly [];
  readonly domains: readonly [{
    readonly kind: "service";
    readonly id: string;
    readonly domain: string;
    readonly targetPort: 8_080;
  }];
  readonly deployment: {
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly snapshotId: string;
    readonly commitHash: string;
    readonly imageDigest: null;
    readonly patchId: null;
  };
  readonly rows: readonly ColdRecoveryVariableRow[];
}

export interface BoundaryEvidence {
  readonly passed: boolean;
  readonly receiptSha256: string | null;
}

export interface CommandResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

export interface ColdReconcileReviewedAuthority {
  readonly sha256: string;
  readonly priorQuiesceRunId: string;
  readonly prepareRunId: string;
}

export interface ColdPrepareReconcileReviewedAuthority {
  readonly sha256: string;
  readonly priorPrepareRunId: string;
  readonly replacementRunId: string;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function policyExact(cwd: string): boolean {
  try {
    const policy = fs.readFileSync(path.resolve(cwd, COLD_RECOVERY_POLICY_PATH));
    const boundary = fs.readFileSync(
      path.resolve(cwd, COLD_RECOVERY_BOUNDARY_POLICY_PATH),
    );
    if (
      policy.byteLength > MAX_EVIDENCE_BYTES ||
      sha256(policy) !== COLD_RECOVERY_POLICY_SHA256 ||
      sha256(boundary) !== COLD_RECOVERY_BOUNDARY_POLICY_SHA256
    ) return false;
    const value = JSON.parse(policy.toString("utf8")) as unknown;
    return record(value) &&
      value.schemaVersion === "pintpath-permanent-staging-cold-recovery-policy/v1" &&
      value.policyId === "pintpath-permanent-staging-one-time-cold-recovery" &&
      value.activationState === "GITHUB_ENVIRONMENT_PROTECTED" &&
      value.repository === COLD_RECOVERY_LOCK.repository &&
      record(value.target) &&
      value.target.projectId === COLD_RECOVERY_LOCK.projectId &&
      value.target.environmentId === COLD_RECOVERY_LOCK.environmentId &&
      value.target.forbiddenProductionEnvironmentId ===
        COLD_RECOVERY_LOCK.forbiddenProductionEnvironmentId &&
      value.target.serviceId === COLD_RECOVERY_LOCK.serviceId &&
      value.target.serviceInstanceId === COLD_RECOVERY_LOCK.serviceInstanceId &&
      record(value.deadState) &&
      value.deadState.replicas === null &&
      value.deadState.latestDeploymentId === COLD_RECOVERY_LOCK.deploymentId &&
      value.deadState.snapshotId === COLD_RECOVERY_LOCK.snapshotId &&
      value.deadState.sourceSha === COLD_RECOVERY_LOCK.sourceSha &&
      record(value.requiredVariableRows) &&
      Array.isArray(value.requiredVariableRows.sealedServiceRows) &&
      canonical(value.requiredVariableRows.sealedServiceRows) ===
        canonical(["SUPABASE_SERVICE_ROLE_KEY"]) &&
      record(value.operations) && record(value.operations.prepare) &&
      record(value.operations.prepare.supabaseReplacementPrerequisite) &&
      value.operations.prepare.supabaseReplacementPrerequisite.operation ===
        "supabase-key-replacement" &&
      value.operations.prepare.supabaseReplacementPrerequisite
          .exactInputPairCanaryRequired === true &&
      record(value.operations.reconcilePrepare) &&
      value.operations.reconcilePrepare.replicasBefore === null &&
      value.operations.reconcilePrepare.replicasAfter === null &&
      value.operations.reconcilePrepare.priorAmbiguousPrepareRunRequired === true &&
      value.operations.reconcilePrepare.providerMutationAllowed === false &&
      value.operations.reconcilePrepare.variableMutationCredentialAllowed === false &&
      record(value.operations.quiesce) &&
      value.operations.quiesce
          .lostAcknowledgementMayReconcileOnlyFromExactNullToZeroPostflight === true &&
      record(value.operations.reconcileQuiesce) &&
      value.operations.reconcileQuiesce.replicasBefore === 0 &&
      value.operations.reconcileQuiesce.replicasAfter === 0 &&
      value.operations.reconcileQuiesce.priorAmbiguousQuiesceRunRequired === true &&
      value.operations.reconcileQuiesce.providerMutationAllowed === false &&
      value.operations.reconcileQuiesce.scaleCredentialAllowed === false &&
      record(value.evidence) &&
      value.evidence.supabaseReplacementReceiptHashBindingRequired === true &&
      value.evidence.truthfulNullToZeroReplicaBindingRequired === true &&
      value.evidence.normalOneToZeroReceiptImpersonationForbidden === true &&
      value.evidence.readOnlyRunnerLossReconciliationMustBindPriorRun === true;
  } catch {
    return false;
  }
}

async function boundedBody(response: Response): Promise<string> {
  if (response.body === null) throw new Error("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_PROVIDER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("provider_response_invalid");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

export async function railwayCall(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("token_invalid");
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await boundedBody(response);
  if (!response.ok) throw new Error("provider_response_invalid");
  const value = JSON.parse(source) as unknown;
  if (record(value) && Object.hasOwn(value, "errors")) {
    throw new Error("provider_response_invalid");
  }
  return value;
}

export function tokenScopeExact(value: unknown): boolean {
  return exactKeys(value, ["data"]) &&
    exactKeys(value.data, ["projectToken"]) &&
    exactKeys(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === COLD_RECOVERY_LOCK.projectId &&
    value.data.projectToken.environmentId === COLD_RECOVERY_LOCK.environmentId;
}

function parseVariableRow(value: unknown): ColdRecoveryVariableRow | null {
  if (
    !exactKeys(value, [
      "id",
      "name",
      "environmentId",
      "serviceId",
      "isSealed",
      "references",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    typeof value.name !== "string" ||
    !VARIABLE_PATTERN.test(value.name) ||
    value.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    !(value.serviceId === null ||
      (typeof value.serviceId === "string" && UUID_PATTERN.test(value.serviceId))) ||
    typeof value.isSealed !== "boolean" ||
    !Array.isArray(value.references) ||
    value.references.length > 100 ||
    value.references.some((item) =>
      typeof item !== "string" || item.length > 512 || /[\r\n\0]/.test(item))
  ) return null;
  return {
    id: value.id,
    name: value.name,
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceId: value.serviceId as string | null,
    isSealed: value.isSealed,
    references: [...value.references].sort() as string[],
  };
}

function serviceRowExact(
  rows: readonly ColdRecoveryVariableRow[],
  name: string,
  references: readonly string[],
  expectedSealed: boolean | null = null,
): boolean {
  const matches = rows.filter((row) => row.name === name);
  return matches.length === 1 &&
    matches[0]?.serviceId === COLD_RECOVERY_LOCK.serviceId &&
    (expectedSealed === null || matches[0]?.isSealed === expectedSealed) &&
    canonical(matches[0].references) === canonical([...references].sort());
}

export function requiredRowsExact(rows: readonly ColdRecoveryVariableRow[]): boolean {
  return Object.entries(REQUIRED_REFERENCES).every(([name, references]) =>
    serviceRowExact(rows, name, references)) &&
    REQUIRED_UNREFERENCED.every((name) => serviceRowExact(
      rows,
      name,
      [],
      name === "SUPABASE_SERVICE_ROLE_KEY" ? true : null,
    )) &&
    FORBIDDEN_VARIABLES.every((name) =>
      rows.every((row) => row.name !== name));
}

export function serviceRoleSealedExact(
  rows: readonly ColdRecoveryVariableRow[],
): boolean {
  return serviceRowExact(rows, "SUPABASE_SERVICE_ROLE_KEY", [], true);
}

export function maintenanceRowsBeforeExact(
  rows: readonly ColdRecoveryVariableRow[],
): boolean {
  return TARGET_VARIABLES.every((name) => {
    const matches = rows.filter((row) => row.name === name);
    return matches.length === 0 ||
      (matches.length === 1 &&
        matches[0]?.serviceId === COLD_RECOVERY_LOCK.serviceId &&
        matches[0].references.length === 0);
  });
}

export function maintenanceRowsAfterExact(
  rows: readonly ColdRecoveryVariableRow[],
): boolean {
  return TARGET_VARIABLES.every((name) => serviceRowExact(rows, name, []));
}

export function nonMaintenanceRows(
  rows: readonly ColdRecoveryVariableRow[],
): readonly ColdRecoveryVariableRow[] {
  return rows.filter((row) =>
    !TARGET_VARIABLES.includes(nameAsTarget(row.name)));
}

function nameAsTarget(name: string): (typeof TARGET_VARIABLES)[number] {
  return name as (typeof TARGET_VARIABLES)[number];
}

export function parseColdRecoveryState(
  value: unknown,
  replicas: null | 0,
): ColdRecoveryState | null {
  if (
    !exactKeys(value, ["data"]) ||
    !exactKeys(value.data, ["environment", "staged", "serviceInstance", "deployment"])
  ) return null;
  const environment = value.data.environment;
  const staged = value.data.staged;
  const instance = value.data.serviceInstance;
  const deployment = value.data.deployment;
  if (
    !exactKeys(environment, ["id", "variables"]) ||
    environment.id !== COLD_RECOVERY_LOCK.environmentId ||
    !exactKeys(environment.variables, ["edges", "pageInfo"]) ||
    !Array.isArray(environment.variables.edges) ||
    environment.variables.edges.length > 100 ||
    !exactKeys(environment.variables.pageInfo, ["hasNextPage", "endCursor"]) ||
    environment.variables.pageInfo.hasNextPage !== false ||
    !exactKeys(staged, ["environmentId", "patch"]) ||
    staged.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    !record(staged.patch) ||
    Object.keys(staged.patch).length !== 0 ||
    !exactKeys(instance, [
      "id",
      "serviceId",
      "environmentId",
      "numReplicas",
      "source",
      "latestDeployment",
      "activeDeployments",
      "domains",
    ]) ||
    instance.id !== COLD_RECOVERY_LOCK.serviceInstanceId ||
    instance.serviceId !== COLD_RECOVERY_LOCK.serviceId ||
    instance.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    instance.numReplicas !== replicas ||
    !exactKeys(instance.source, ["repo", "image"]) ||
    instance.source.repo !== null ||
    instance.source.image !== null ||
    !exactKeys(instance.latestDeployment, [
      "id",
      "status",
      "deploymentStopped",
      "snapshotId",
    ]) ||
    instance.latestDeployment.id !== COLD_RECOVERY_LOCK.deploymentId ||
    instance.latestDeployment.status !== "FAILED" ||
    instance.latestDeployment.deploymentStopped !== true ||
    instance.latestDeployment.snapshotId !== COLD_RECOVERY_LOCK.snapshotId ||
    !Array.isArray(instance.activeDeployments) ||
    instance.activeDeployments.length !== 0 ||
    !exactKeys(instance.domains, ["serviceDomains", "customDomains"]) ||
    !Array.isArray(instance.domains.serviceDomains) ||
    instance.domains.serviceDomains.length !== 1 ||
    !Array.isArray(instance.domains.customDomains) ||
    instance.domains.customDomains.length !== 0 ||
    !exactKeys(instance.domains.serviceDomains[0], ["id", "domain", "targetPort"]) ||
    instance.domains.serviceDomains[0].id !== COLD_RECOVERY_LOCK.domainId ||
    instance.domains.serviceDomains[0].domain !== COLD_RECOVERY_LOCK.domain ||
    instance.domains.serviceDomains[0].targetPort !== COLD_RECOVERY_LOCK.targetPort ||
    !exactKeys(deployment, [
      "id",
      "projectId",
      "environmentId",
      "serviceId",
      "snapshotId",
      "meta",
    ]) ||
    deployment.id !== COLD_RECOVERY_LOCK.deploymentId ||
    deployment.projectId !== COLD_RECOVERY_LOCK.projectId ||
    deployment.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    deployment.serviceId !== COLD_RECOVERY_LOCK.serviceId ||
    deployment.snapshotId !== COLD_RECOVERY_LOCK.snapshotId ||
    !record(deployment.meta) ||
    deployment.meta.commitHash !== COLD_RECOVERY_LOCK.sourceSha ||
    (deployment.meta.imageDigest ?? null) !== null ||
    (deployment.meta.patchId ?? null) !== null
  ) return null;
  const rows: ColdRecoveryVariableRow[] = [];
  for (const edge of environment.variables.edges) {
    if (!exactKeys(edge, ["node"])) return null;
    const parsed = parseVariableRow(edge.node);
    if (!parsed) return null;
    rows.push(parsed);
  }
  rows.sort((left, right) =>
    `${left.serviceId ?? ""}:${left.name}:${left.id}`.localeCompare(
      `${right.serviceId ?? ""}:${right.name}:${right.id}`,
    ));
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    new Set(rows.map((row) => `${row.serviceId ?? ""}:${row.name}`)).size !== rows.length ||
    !requiredRowsExact(rows)
  ) return null;
  return {
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceInstanceId: COLD_RECOVERY_LOCK.serviceInstanceId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    numReplicas: replicas,
    source: { repo: null, image: null },
    latestDeployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      status: "FAILED",
      deploymentStopped: true,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
    },
    activeDeployments: [],
    domains: [{
      kind: "service",
      id: COLD_RECOVERY_LOCK.domainId,
      domain: COLD_RECOVERY_LOCK.domain,
      targetPort: 8_080,
    }],
    deployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
      commitHash: COLD_RECOVERY_LOCK.sourceSha,
      imageDigest: null,
      patchId: null,
    },
    rows,
  };
}

export async function readColdRecoveryState(
  fetchImpl: typeof fetch,
  token: string,
  replicas: null | 0,
): Promise<ColdRecoveryState | null> {
  try {
    return parseColdRecoveryState(await railwayCall(
      fetchImpl,
      token,
      COLD_RECOVERY_STATE_QUERY,
      {
        projectId: COLD_RECOVERY_LOCK.projectId,
        environmentId: COLD_RECOVERY_LOCK.environmentId,
        serviceId: COLD_RECOVERY_LOCK.serviceId,
        deploymentId: COLD_RECOVERY_LOCK.deploymentId,
      },
    ), replicas);
  } catch {
    return null;
  }
}

export function coldIdentityCanonical(state: ColdRecoveryState): string {
  return canonical({
    environmentId: state.environmentId,
    serviceInstanceId: state.serviceInstanceId,
    serviceId: state.serviceId,
    source: state.source,
    latestDeployment: state.latestDeployment,
    activeDeployments: state.activeDeployments,
    domains: state.domains,
    deployment: state.deployment,
  });
}

export function fullStateCanonical(state: ColdRecoveryState): string {
  return canonical(state);
}

export interface SupabaseReplacementPrerequisite {
  readonly terminalSha256: string;
  readonly candidateSha: string;
  readonly outcome: "acknowledged_pending_runtime_proof";
}

export function parseSupabaseReplacementPrerequisite(
  source: string,
  candidateSha: string,
): SupabaseReplacementPrerequisite | null {
  try {
    const terminal = JSON.parse(source) as unknown;
    if (!exactKeys(terminal, [
      "schemaVersion",
      "receipt",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ]) || canonical(terminal) !== source ||
      terminal.schemaVersion !== SUPABASE_REPLACEMENT_TERMINAL_SCHEMA ||
      terminal.secretMaterialIncluded !== false ||
      terminal.secretDerivedCommitmentsIncluded !== false ||
      !record(terminal.receipt)) return null;
    const receipt = terminal.receipt;
    if (!exactKeys(receipt, [
      "schemaVersion",
      "executorState",
      "operation",
      "outcome",
      "candidateSha",
      "attempts",
      "retryAllowed",
      "intentSha256",
      "terminalEvidenceSha256",
      "externalMutationFreeze",
      "stagedDeletionPatchId",
      "supabaseKeyCanary",
      "checks",
    ]) || receipt.schemaVersion !== SUPABASE_REPLACEMENT_RECEIPT_SCHEMA ||
      receipt.executorState !== "GITHUB_ENVIRONMENT_PROTECTED" ||
      receipt.operation !== "supabase-key-replacement" ||
      receipt.outcome !== "acknowledged_pending_runtime_proof" ||
      receipt.candidateSha !== candidateSha || receipt.attempts !== 1 ||
      receipt.retryAllowed !== false ||
      !SHA256_PATTERN.test(String(receipt.intentSha256)) ||
      receipt.terminalEvidenceSha256 !== null ||
      !exactKeys(receipt.externalMutationFreeze, [
        "attestation",
        "enforcement",
        "providerCasOrLockVerified",
      ]) || receipt.externalMutationFreeze.attestation !==
        EXTERNAL_MUTATION_FREEZE_ATTESTATION ||
      receipt.externalMutationFreeze.enforcement !==
        EXTERNAL_MUTATION_FREEZE_ENFORCEMENT ||
      receipt.externalMutationFreeze.providerCasOrLockVerified !== false ||
      receipt.stagedDeletionPatchId !== null ||
      !exactKeys(receipt.supabaseKeyCanary, [
        "origin",
        "publishableEndpoint",
        "secretEndpoint",
        "publishableHttpStatus",
        "secretHttpStatus",
        "checks",
        "secretMaterialIncluded",
        "secretDerivedCommitmentsIncluded",
      ])) return null;
    const canary = receipt.supabaseKeyCanary;
    if (canary.origin !== "https://bbfibbadwjxzrcdncavy.supabase.co" ||
      canary.publishableEndpoint !== "/auth/v1/settings" ||
      canary.secretEndpoint !== "/rest/v1/profiles?select=id&limit=1" ||
      canary.publishableHttpStatus !== 200 || canary.secretHttpStatus !== 200 ||
      canary.secretMaterialIncluded !== false ||
      canary.secretDerivedCommitmentsIncluded !== false ||
      !exactKeys(canary.checks, [
        "replacementKeyShapesExact",
        "replacementKeysDistinct",
        "publishableAuthSettingsExact",
        "secretProfilesRelationExact",
        "exactInputPairUsed",
        "evidenceSecretFreeExact",
      ]) || Object.values(canary.checks).some((value) => value !== true) ||
      !exactKeys(receipt.checks, [
        "policyExact",
        "githubAuthorityExact",
        "externalMutationFreezeAttested",
        "tokenScopesExact",
        "boundaryPreflightExact",
        "boundaryPrecommitExact",
        "targetPreflightExact",
        "supabasePairCanaryExact",
        "durableIntentExact",
        "mutationAttemptedAtMostOnce",
        "acknowledgementExact",
        "stageAcknowledgementExact",
        "commitAcknowledgementExact",
        "stagedDeletionPatchExact",
        "committedDeletionPatchExact",
        "deploySuppressionExact",
        "postflightAttempted",
        "targetPostflightExact",
        "deploymentUnchanged",
        "boundaryPostflightExact",
        "inputZeroized",
        "terminalEvidenceExact",
      ])) return null;
    const checks = receipt.checks;
    const requiredTrue = [
      "policyExact",
      "githubAuthorityExact",
      "externalMutationFreezeAttested",
      "tokenScopesExact",
      "boundaryPreflightExact",
      "targetPreflightExact",
      "supabasePairCanaryExact",
      "durableIntentExact",
      "mutationAttemptedAtMostOnce",
      "acknowledgementExact",
      "deploySuppressionExact",
      "postflightAttempted",
      "targetPostflightExact",
      "deploymentUnchanged",
      "boundaryPostflightExact",
      "inputZeroized",
    ] as const;
    const requiredFalse = [
      "boundaryPrecommitExact",
      "stageAcknowledgementExact",
      "commitAcknowledgementExact",
      "stagedDeletionPatchExact",
      "committedDeletionPatchExact",
      "terminalEvidenceExact",
    ] as const;
    if (requiredTrue.some((key) => checks[key] !== true) ||
      requiredFalse.some((key) => checks[key] !== false)) return null;
    return {
      terminalSha256: sha256(source),
      candidateSha,
      outcome: "acknowledged_pending_runtime_proof",
    };
  } catch {
    return null;
  }
}

export function reassertRepositoryState(cwd: string, candidateSha: string): boolean {
  try {
    const run = (args: readonly string[]) => execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", [
      "fetch",
      "--no-tags",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ], { cwd, stdio: ["ignore", "ignore", "ignore"] });
    return run(["rev-parse", "HEAD"]) === candidateSha &&
      run(["rev-parse", "refs/remotes/origin/main"]) === candidateSha &&
      run(["status", "--porcelain=v2", "--untracked-files=all"]) === "";
  } catch {
    return false;
  }
}

export function writeDurable(
  directory: string,
  leaf: string,
  source: string,
): string {
  if (Buffer.byteLength(source) > MAX_EVIDENCE_BYTES) {
    throw new Error("evidence_invalid");
  }
  writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  return sha256(source);
}

export function readPrivateEvidence(filename: string): string {
  return readTrustedRegularFile(filename, {
    minBytes: 2,
    maxBytes: MAX_EVIDENCE_BYTES,
    requireOwner: true,
    requirePrivate: true,
  }).toString("utf8");
}

export function parseColdReconcileReviewedAuthority(
  source: string,
  candidateSha: string,
  currentRunId: string,
  priorQuiesceRunId: string,
  prepareRunId: string,
): ColdReconcileReviewedAuthority | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value) || `${JSON.stringify(value)}\n` !== source ||
      value.command !== "verify-github-reviewed-candidate-authority" ||
      value.ok !== true ||
      value.kind !== "pintpath-github-reviewed-candidate-authority" ||
      value.repository !== COLD_RECOVERY_LOCK.repository ||
      value.candidateSha !== candidateSha ||
      value.operation !== "cold-recovery-reconcile-quiesce" ||
      value.workflowPath !==
        ".github/workflows/recover-permanent-staging-cold-zero.yml" ||
      value.workflowRunId !== currentRunId ||
      value.workflowRunAttempt !== 1 ||
      value.priorAmbiguousColdQuiesceRunId !== priorQuiesceRunId ||
      value.selectedColdPrepareRunId !== prepareRunId ||
      value.exactPriorColdQuiesceCandidateRunBound !== true ||
      value.secondColdScaleWritePreventedExact !== true ||
      !canonicalIsoTimestamp(value.runnerLossRecoveryOriginalRunCompletedAt) ||
      value.runnerLossRecoveryGraceHours !== 24 ||
      value.runnerLossRecoveryWithinGraceExact !== true ||
      value.reviewedAuthorityExact !== true ||
      value.freshDispatchWriteGuardExact !== true) return null;
    return {
      sha256: sha256(source),
      priorQuiesceRunId,
      prepareRunId,
    };
  } catch {
    return null;
  }
}

export function parseColdPrepareReconcileReviewedAuthority(
  source: string,
  candidateSha: string,
  currentRunId: string,
  priorPrepareRunId: string,
  replacementRunId: string,
): ColdPrepareReconcileReviewedAuthority | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value) || `${JSON.stringify(value)}\n` !== source ||
      value.command !== "verify-github-reviewed-candidate-authority" ||
      value.ok !== true ||
      value.kind !== "pintpath-github-reviewed-candidate-authority" ||
      value.repository !== COLD_RECOVERY_LOCK.repository ||
      value.candidateSha !== candidateSha ||
      value.operation !== "cold-recovery-reconcile-prepare" ||
      value.workflowPath !==
        ".github/workflows/recover-permanent-staging-cold-zero.yml" ||
      value.workflowRunId !== currentRunId ||
      value.workflowRunAttempt !== 1 ||
      value.priorAmbiguousColdPrepareRunId !== priorPrepareRunId ||
      value.selectedSupabaseReplacementRunId !== replacementRunId ||
      value.exactPriorColdPrepareCandidateRunBound !== true ||
      value.secondColdPrepareWritePreventedExact !== true ||
      !canonicalIsoTimestamp(value.runnerLossRecoveryOriginalRunCompletedAt) ||
      value.runnerLossRecoveryGraceHours !== 24 ||
      value.runnerLossRecoveryWithinGraceExact !== true ||
      value.reviewedAuthorityExact !== true ||
      value.freshDispatchWriteGuardExact !== true) return null;
    return {
      sha256: sha256(source),
      priorPrepareRunId,
      replacementRunId,
    };
  } catch {
    return null;
  }
}

export async function defaultBoundaryCheck(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<BoundaryEvidence> {
  let source = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", COLD_RECOVERY_BOUNDARY_POLICY_PATH],
    env,
    fetchImpl,
    writeOutput: (chunk) => {
      if (Buffer.byteLength(source) + Buffer.byteLength(chunk) > MAX_EVIDENCE_BYTES) {
        throw new Error("boundary_invalid");
      }
      source += chunk;
    },
  });
  return {
    passed: code === 0,
    receiptSha256: source.length > 0 ? sha256(source) : null,
  };
}

export async function probeRuntimeAbsent(
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let round = 0; round < 3; round += 1) {
    for (const route of ["/health", "/startup", "/ready"] as const) {
      try {
        const response = await fetchImpl(
          `https://${COLD_RECOVERY_LOCK.domain}${route}`,
          {
            method: "GET",
            headers: { accept: "application/json" },
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.ok) return false;
        await response.body?.cancel();
      } catch {
        // Connection errors and provider 404/5xx both mean no healthy app route.
      }
    }
    if (round < 2) await sleep(5_000);
  }
  return true;
}

export function validateCli(filename: string): boolean {
  let source: Buffer | null = null;
  try {
    source = readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 128 * 1024 * 1024,
      requireExecutable: true,
    });
    return sha256(source) === COLD_RECOVERY_CLI_SHA256;
  } catch {
    return false;
  } finally {
    source?.fill(0);
  }
}

export function runScaleCommand(
  executable: string,
  token: string,
  timeoutMilliseconds = 60_000,
  terminationGraceMilliseconds = 5_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let forcedSettlement: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(executable, [
      "service",
      "scale",
      `${COLD_RECOVERY_LOCK.region}=0`,
      "--project",
      COLD_RECOVERY_LOCK.projectId,
      "--environment",
      COLD_RECOVERY_LOCK.environmentId,
      "--service",
      COLD_RECOVERY_LOCK.serviceId,
      "--json",
    ], {
      shell: false,
      detached: true,
      env: {
        HOME: "/nonexistent",
        LANG: "C",
        LC_ALL: "C",
        RAILWAY_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      if (forcedSettlement !== null) clearTimeout(forcedSettlement);
      resolve({
        code,
        timedOut,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
      });
    };
    const terminate = (timeoutReached: boolean) => {
      if (settled) return;
      timedOut ||= timeoutReached;
      try { process.kill(-child.pid!, "SIGTERM"); } catch { /* reconciled */ }
      forcedSettlement ??= setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* reconciled */ }
        finish(null);
      }, terminationGraceMilliseconds);
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = `${current}${chunk.toString("utf8")}`;
      if (Buffer.byteLength(next) > MAX_PROVIDER_BYTES) {
        terminate(false);
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    timeout = setTimeout(() => terminate(true), timeoutMilliseconds);
    child.on("error", () => finish(null));
    child.on("close", finish);
  });
}

export function argumentsExact(
  argv: readonly string[],
  includePrepareEvidence: boolean,
): {
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly evidenceDirectory: string;
  readonly replacementRunId: string | null;
  readonly replacementTerminalFile: string | null;
  readonly prepareRunId: string | null;
  readonly prepareVerificationFile: string | null;
} | null {
  const expectedLength = 10;
  if (argv.length !== expectedLength) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = includePrepareEvidence
    ? [
      "--candidate-sha",
      "--expected-deployment-sha",
      "--evidence-dir",
      "--prepare-run-id",
      "--prepare-verification-file",
    ]
    : [
      "--candidate-sha",
      "--expected-deployment-sha",
      "--evidence-dir",
      "--replacement-run-id",
      "--replacement-terminal-file",
    ];
  if ([...values.keys()].some((key) => !allowed.includes(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const replacementRunId = values.get("--replacement-run-id") ?? null;
  const replacementTerminalFile =
    values.get("--replacement-terminal-file") ?? null;
  const prepareRunId = values.get("--prepare-run-id") ?? null;
  const prepareVerificationFile = values.get("--prepare-verification-file") ?? null;
  if (
    !SHA_PATTERN.test(candidateSha) ||
    expectedDeploymentSha !== COLD_RECOVERY_LOCK.sourceSha ||
    candidateSha === expectedDeploymentSha ||
    !path.isAbsolute(evidenceDirectory) ||
    (!includePrepareEvidence &&
      (!replacementRunId || !/^[1-9][0-9]{0,19}$/.test(replacementRunId) ||
        !replacementTerminalFile || !path.isAbsolute(replacementTerminalFile) ||
        path.resolve(replacementTerminalFile) !== replacementTerminalFile ||
        path.basename(replacementTerminalFile) !== "terminal.json")) ||
    (includePrepareEvidence &&
      (!prepareRunId || !/^[1-9][0-9]{0,19}$/.test(prepareRunId) ||
        !prepareVerificationFile || !path.isAbsolute(prepareVerificationFile))) ||
    (!includePrepareEvidence &&
      (prepareRunId !== null || prepareVerificationFile !== null))
  ) return null;
  return {
    candidateSha,
    expectedDeploymentSha,
    evidenceDirectory,
    replacementRunId,
    replacementTerminalFile,
    prepareRunId,
    prepareVerificationFile,
  };
}

export function reconcileArgumentsExact(argv: readonly string[]): {
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly evidenceDirectory: string;
  readonly prepareRunId: string;
  readonly prepareVerificationFile: string;
  readonly priorQuiesceRunId: string;
  readonly reviewedAuthorityFile: string;
} | null {
  if (argv.length !== 14) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = [
    "--candidate-sha",
    "--expected-deployment-sha",
    "--evidence-dir",
    "--prepare-run-id",
    "--prepare-verification-file",
    "--prior-quiesce-run-id",
    "--reviewed-authority-file",
  ];
  if ([...values.keys()].some((key) => !allowed.includes(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const prepareRunId = values.get("--prepare-run-id") ?? "";
  const prepareVerificationFile = values.get("--prepare-verification-file") ?? "";
  const priorQuiesceRunId = values.get("--prior-quiesce-run-id") ?? "";
  const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
  if (!SHA_PATTERN.test(candidateSha) ||
    expectedDeploymentSha !== COLD_RECOVERY_LOCK.sourceSha ||
    candidateSha === expectedDeploymentSha ||
    !path.isAbsolute(evidenceDirectory) ||
    !/^[1-9][0-9]{0,19}$/.test(prepareRunId) ||
    !/^[1-9][0-9]{0,19}$/.test(priorQuiesceRunId) ||
    prepareRunId === priorQuiesceRunId ||
    !path.isAbsolute(prepareVerificationFile) ||
    path.basename(prepareVerificationFile) !== "prerequisites-verification.json" ||
    !path.isAbsolute(reviewedAuthorityFile) ||
    path.basename(reviewedAuthorityFile) !== "reviewed-authority.json") return null;
  return {
    candidateSha,
    expectedDeploymentSha,
    evidenceDirectory,
    prepareRunId,
    prepareVerificationFile,
    priorQuiesceRunId,
    reviewedAuthorityFile,
  };
}

export function reconcilePrepareArgumentsExact(argv: readonly string[]): {
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly evidenceDirectory: string;
  readonly replacementRunId: string;
  readonly replacementTerminalFile: string;
  readonly priorPrepareRunId: string;
  readonly reviewedAuthorityFile: string;
} | null {
  if (argv.length !== 14) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = [
    "--candidate-sha",
    "--expected-deployment-sha",
    "--evidence-dir",
    "--replacement-run-id",
    "--replacement-terminal-file",
    "--prior-prepare-run-id",
    "--reviewed-authority-file",
  ];
  if ([...values.keys()].some((key) => !allowed.includes(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const replacementRunId = values.get("--replacement-run-id") ?? "";
  const replacementTerminalFile = values.get("--replacement-terminal-file") ?? "";
  const priorPrepareRunId = values.get("--prior-prepare-run-id") ?? "";
  const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
  if (!SHA_PATTERN.test(candidateSha) ||
    expectedDeploymentSha !== COLD_RECOVERY_LOCK.sourceSha ||
    candidateSha === expectedDeploymentSha ||
    !path.isAbsolute(evidenceDirectory) ||
    !/^[1-9][0-9]{0,19}$/.test(replacementRunId) ||
    !/^[1-9][0-9]{0,19}$/.test(priorPrepareRunId) ||
    replacementRunId === priorPrepareRunId ||
    !path.isAbsolute(replacementTerminalFile) ||
    path.basename(replacementTerminalFile) !== "terminal.json" ||
    !path.isAbsolute(reviewedAuthorityFile) ||
    path.basename(reviewedAuthorityFile) !== "reviewed-authority.json") return null;
  return {
    candidateSha,
    expectedDeploymentSha,
    evidenceDirectory,
    replacementRunId,
    replacementTerminalFile,
    priorPrepareRunId,
    reviewedAuthorityFile,
  };
}

export function authorityExact(
  env: Readonly<Record<string, string | undefined>>,
  operation: "prepare" | "reconcile-prepare" | "quiesce" | "reconcile-quiesce",
  candidateSha: string,
  expectedDeploymentSha: string,
): boolean {
  const expectedEnvironment = operation === "prepare" || operation === "reconcile-prepare"
    ? "permanent-staging-provider-mutation"
    : "permanent-staging-scale-evidence";
  const expectedConfirmation = operation === "prepare"
    ? `PREPARE_PERMANENT_STAGING_COLD_RECOVERY_FOR_${candidateSha}_FROM_${expectedDeploymentSha}`
    : operation === "reconcile-prepare"
    ? `RECONCILE_PERMANENT_STAGING_COLD_PREPARE_FOR_${candidateSha}_FROM_${expectedDeploymentSha}`
    : operation === "quiesce"
    ? `QUIESCE_PERMANENT_STAGING_COLD_RECOVERY_TO_ZERO_FOR_${candidateSha}_FROM_${expectedDeploymentSha}`
    : `RECONCILE_PERMANENT_STAGING_COLD_RECOVERY_AT_ZERO_FOR_${candidateSha}_FROM_${expectedDeploymentSha}`;
  return env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === COLD_RECOVERY_LOCK.repository &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_SHA === candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    env.PINTPATH_PROTECTED_ENVIRONMENT === expectedEnvironment &&
    env.PINTPATH_COLD_RECOVERY_CONFIRMATION === expectedConfirmation;
}

export function readOnlyTokensExact(
  env: Readonly<Record<string, string | undefined>>,
): { readonly metadata: string } | null {
  const metadata = env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
  const production = env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
  const scale = env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
  const variable = env.PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN ?? "";
  const generic = env.RAILWAY_TOKEN ?? "";
  const stagingMutation = env.PINTPATH_RAILWAY_STAGING_MUTATION_TOKEN ?? "";
  if (!TOKEN_PATTERN.test(metadata) || !TOKEN_PATTERN.test(production) ||
    metadata === production || scale !== "" || variable !== "" ||
    generic !== "" || stagingMutation !== "") return null;
  return { metadata };
}

export function tokensExact(
  env: Readonly<Record<string, string | undefined>>,
  operation: "prepare" | "quiesce",
): {
  readonly metadata: string;
  readonly mutation: string;
} | null {
  const metadata = env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
  const production = env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
  const mutation = operation === "prepare"
    ? env.PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN ?? ""
    : env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
  if (
    !TOKEN_PATTERN.test(metadata) ||
    !TOKEN_PATTERN.test(production) ||
    !TOKEN_PATTERN.test(mutation) ||
    metadata === production ||
    mutation === metadata ||
    mutation === production
  ) return null;
  return { metadata, mutation };
}

export function shaPatternsExact(value: unknown): boolean {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}
