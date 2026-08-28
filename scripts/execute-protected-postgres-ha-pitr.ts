import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from "./check-railway-mutation-boundary.js";

export const PROTECTED_POSTGRES_HA_PITR_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;
export const PROTECTED_POSTGRES_HA_PITR_SCHEMA =
  "pintpath-protected-postgres-ha-pitr/v2" as const;
const POLICY_PATH = "ops/railway/protected-postgres-ha-pitr-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const POLICY_SHA256 =
  "1379db72116ad71ccb12df55cc504294f0e2c9fd2296d88e54f583451455d10c";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const PROJECT = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const TARGETS = {
  production: {
    environmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    githubEnvironment: "postgres-ha-pitr-production",
    confirmation: "ENABLE_PITR_PRODUCTION",
  },
  "permanent-staging": {
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    githubEnvironment: "postgres-ha-pitr-permanent-staging",
    confirmation: "ENABLE_PITR_PERMANENT_STAGING",
  },
} as const;
type TargetEnvironment = keyof typeof TARGETS;
const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  SHA = /^[a-f0-9]{40}$/,
  TOKEN = /^[^\r\n\0]{16,4096}$/;

export const POSTGRES_HA_PITR_SCOPE = `query PintPathPostgresHaPitrScope{projectToken{projectId environmentId}}`;
export const POSTGRES_HA_PITR_INVENTORY = `query PintPathPostgresHaPitrInventory($projectId:String!,$environmentId:String!){environment(id:$environmentId,projectId:$projectId){id projectId serviceInstances(first:100){edges{node{environmentId serviceId}}pageInfo{hasNextPage endCursor}}}}`;
export const POSTGRES_HA_PITR_HEALTH = `query PintPathPostgresHaPitrHealth($environmentId:String!,$rootServiceId:String!){pitrHaClusterReplicationHealth(environmentId:$environmentId,rootServiceId:$rootServiceId){allHealthy checkedAt environmentId reachable rootServiceId members{healthy isLeader lagMb patroniName serviceId serviceName state}}}`;
export const POSTGRES_HA_PITR_PROGRESS = `query PintPathPostgresHaPitrProgress($environmentId:String!,$rootServiceId:String!){pitrHaWorkflowProgress(environmentId:$environmentId,rootServiceId:$rootServiceId){workflowId projectId environmentId rootServiceId direction phase clusterMutated startedAt updatedAt completedAt currentMemberServiceId newLeaderServiceId errorMessage failedAtPhase members{serviceId serviceName isLeader status}}}`;
export const POSTGRES_HA_PITR_ENABLE = `mutation PintPathEnablePostgresHaPitr($input:EnablePitrForHaClusterInput!){enablePitrForHaCluster(input:$input){projectId workflowId}}`;

interface Args {
  candidateSha: string;
  targetEnvironment: TargetEnvironment;
  evidenceDir: string;
}
interface TargetAuthority {
  targetEnvironment: TargetEnvironment;
  githubEnvironment: string;
  projectId: string;
  environmentId: string;
  rootServiceId: string;
  authoritySha256: string;
}
interface Dependencies {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  writeDurable: (dir: string, leaf: string, source: string) => string;
  writeOutput: (source: string) => void;
  runBoundary: () => Promise<boolean>;
}
interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  targetExact: boolean;
  protectedTargetAuthorityExact: boolean;
  credentialsExact: boolean;
  tokenScopesExact: boolean;
  providerRootAuthorityExact: boolean;
  healthPreflightExact: boolean;
  priorWorkflowAbsent: boolean;
  boundaryPreflightExact: boolean;
  durableIntentExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  workflowDoneExact: boolean;
  healthPostflightExact: boolean;
  boundaryPostflightExact: boolean;
  terminalEvidenceExact: boolean;
}
function sha256(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(
  value: unknown,
  names: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === names.length &&
    names.every((name, index) => Object.keys(value)[index] === name)
  );
}
function args(argv: readonly string[]): Args | null {
  if (argv.length !== 6) return null;
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i],
      v = argv[i + 1];
    if (!k?.startsWith("--") || !v || m.has(k)) return null;
    m.set(k, v);
  }
  const candidateSha = m.get("--candidate-sha") ?? "",
    targetEnvironment = m.get("--target-environment") ?? "",
    evidenceDir = m.get("--evidence-dir") ?? "";
  return m.size === 3 &&
    SHA.test(candidateSha) &&
    Object.hasOwn(TARGETS, targetEnvironment) &&
    path.isAbsolute(evidenceDir)
    ? {
        candidateSha,
        targetEnvironment: targetEnvironment as TargetEnvironment,
        evidenceDir,
      }
    : null;
}
function resolveTargetAuthority(
  a: Args,
  env: Readonly<Record<string, string | undefined>>,
): TargetAuthority | null {
  const target = TARGETS[a.targetEnvironment];
  const rootServiceId =
    env.PINTPATH_POSTGRES_HA_PITR_EXPECTED_ROOT_SERVICE_ID ?? "";
  if (
    env.PINTPATH_POSTGRES_HA_PITR_AUTHORITY_TARGET !== a.targetEnvironment ||
    !UUID.test(rootServiceId)
  )
    return null;
  const authority = {
    schemaVersion: "pintpath-postgres-ha-pitr-target-authority/v1",
    targetEnvironment: a.targetEnvironment,
    githubEnvironment: target.githubEnvironment,
    projectId: PROJECT,
    environmentId: target.environmentId,
    rootServiceId,
  };
  return {
    targetEnvironment: a.targetEnvironment,
    githubEnvironment: target.githubEnvironment,
    projectId: PROJECT,
    environmentId: target.environmentId,
    rootServiceId,
    authoritySha256: sha256(canonical(authority)),
  };
}
function policy(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    if (sha256(source) !== POLICY_SHA256) return false;
    const value = JSON.parse(source.toString("utf8")) as unknown;
    return (
      exact(value, [
        "schemaVersion",
        "policyId",
        "activationState",
        "githubEnvironments",
        "requiredGitRef",
        "targetContract",
        "mutationBoundary",
        "providerContract",
        "evidence",
      ]) &&
      value.schemaVersion === "pintpath-protected-postgres-ha-pitr-policy/v2" &&
      value.policyId === "pintpath-protected-postgres-ha-pitr-enable" &&
      value.activationState === PROTECTED_POSTGRES_HA_PITR_STATE &&
      exact(value.githubEnvironments, ["production", "permanentStaging"]) &&
      value.githubEnvironments.production === "postgres-ha-pitr-production" &&
      value.githubEnvironments.permanentStaging ===
        "postgres-ha-pitr-permanent-staging" &&
      value.requiredGitRef === "refs/heads/main" &&
      exact(value.targetContract, [
        "operatorTargetSelectorRequired",
        "operatorRootServiceIdAllowed",
        "protectedAuthorityTargetVariable",
        "protectedRootServiceIdVariable",
        "productionEnvironmentId",
        "permanentStagingEnvironmentId",
        "providerDiscoveredRootMustMatchProtectedAuthority",
        "productionAllowed",
        "permanentStagingAllowed",
        "otherTargetsAllowed",
        "haRootRequired",
        "allMembersHealthyRequired",
      ]) &&
      value.targetContract.operatorTargetSelectorRequired === true &&
      value.targetContract.operatorRootServiceIdAllowed === false &&
      value.targetContract.protectedAuthorityTargetVariable ===
        "PINTPATH_POSTGRES_HA_PITR_AUTHORITY_TARGET" &&
      value.targetContract.protectedRootServiceIdVariable ===
        "PINTPATH_POSTGRES_HA_PITR_EXPECTED_ROOT_SERVICE_ID" &&
      value.targetContract.productionEnvironmentId ===
        TARGETS.production.environmentId &&
      value.targetContract.permanentStagingEnvironmentId ===
        TARGETS["permanent-staging"].environmentId &&
      value.targetContract.providerDiscoveredRootMustMatchProtectedAuthority ===
        true &&
      value.targetContract.productionAllowed === true &&
      value.targetContract.permanentStagingAllowed === true &&
      value.targetContract.otherTargetsAllowed === false &&
      value.targetContract.haRootRequired === true &&
      value.targetContract.allMembersHealthyRequired === true &&
      exact(value.mutationBoundary, [
        "policyPath",
        "policySha256",
        "immediatePreflightRequired",
        "unconditionalPostflightRequired",
      ]) &&
      value.mutationBoundary.policyPath === BOUNDARY_POLICY_PATH &&
      value.mutationBoundary.policySha256 ===
        "9392f0c605dec43657d4d3a5a6ce40d57fe9beb70fce5ff496bb1a5f2fed3fed" &&
      value.mutationBoundary.immediatePreflightRequired === true &&
      value.mutationBoundary.unconditionalPostflightRequired === true &&
      exact(value.providerContract, [
        "graphqlEndpoint",
        "railwayCliSchemaVersion",
        "railwayCliSchemaSha256",
        "mutation",
        "maximumAttempts",
        "automaticRetriesAllowed",
        "rerunsAllowed",
        "unconditionalPostflightRequired",
        "ambiguousOutcomeAction",
      ]) &&
      value.providerContract.graphqlEndpoint === ENDPOINT &&
      value.providerContract.railwayCliSchemaVersion === "5.32.0" &&
      value.providerContract.railwayCliSchemaSha256 ===
        "89530486d77ed677586554085d4ff67e8ae6d3c44a6825d67c94320d4a083285" &&
      value.providerContract.mutation === "enablePitrForHaCluster" &&
      value.providerContract.maximumAttempts === 1 &&
      value.providerContract.automaticRetriesAllowed === false &&
      value.providerContract.rerunsAllowed === false &&
      value.providerContract.unconditionalPostflightRequired === true &&
      value.providerContract.ambiguousOutcomeAction ===
        "READ_ONLY_RECONCILIATION_STOP_NO_RETRY" &&
      exact(value.evidence, [
        "durableIntentRequiredBeforeWrite",
        "terminalEvidenceRequired",
        "targetAuthoritySha256Required",
        "providerCredentialsAllowedInEvidence",
        "secretDerivedCommitmentsAllowed",
      ]) &&
      value.evidence.durableIntentRequiredBeforeWrite === true &&
      value.evidence.terminalEvidenceRequired === true &&
      value.evidence.targetAuthoritySha256Required === true &&
      value.evidence.providerCredentialsAllowedInEvidence === false &&
      value.evidence.secretDerivedCommitmentsAllowed === false
    );
  } catch {
    return false;
  }
}
function durable(dir: string, leaf: string, source: string): string {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("evidence_invalid");
  const handle = fs.openSync(
    path.join(dir, leaf),
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(handle, source);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return sha256(source);
}
async function call(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await response.text();
  if (!response.ok || Buffer.byteLength(source) > 1024 * 1024)
    throw new Error("provider_invalid");
  return JSON.parse(source) as unknown;
}
function scope(value: unknown, target: TargetAuthority): boolean {
  return (
    exact(value, ["data"]) &&
    exact(value.data, ["projectToken"]) &&
    exact(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === target.projectId &&
    value.data.projectToken.environmentId === target.environmentId
  );
}
function inventory(value: unknown, target: TargetAuthority): string[] | null {
  if (
    !exact(value, ["data"]) ||
    !exact(value.data, ["environment"]) ||
    !exact(value.data.environment, ["id", "projectId", "serviceInstances"])
  )
    return null;
  const environment = value.data.environment;
  if (
    environment.id !== target.environmentId ||
    environment.projectId !== target.projectId ||
    !exact(environment.serviceInstances, ["edges", "pageInfo"]) ||
    !Array.isArray(environment.serviceInstances.edges) ||
    environment.serviceInstances.edges.length < 2 ||
    environment.serviceInstances.edges.length > 100 ||
    !exact(environment.serviceInstances.pageInfo, [
      "hasNextPage",
      "endCursor",
    ]) ||
    environment.serviceInstances.pageInfo.hasNextPage !== false ||
    !(
      environment.serviceInstances.pageInfo.endCursor === null ||
      typeof environment.serviceInstances.pageInfo.endCursor === "string"
    )
  )
    return null;
  const serviceIds: string[] = [];
  for (const edge of environment.serviceInstances.edges) {
    if (
      !exact(edge, ["node"]) ||
      !exact(edge.node, ["environmentId", "serviceId"]) ||
      edge.node.environmentId !== target.environmentId ||
      !UUID.test(String(edge.node.serviceId)) ||
      serviceIds.includes(String(edge.node.serviceId))
    )
      return null;
    serviceIds.push(String(edge.node.serviceId));
  }
  return serviceIds;
}
function rootHealth(
  value: unknown,
  environmentId: string,
  queriedServiceId: string,
): Record<string, unknown> | null | false {
  if (
    !exact(value, ["data"]) ||
    !exact(value.data, ["pitrHaClusterReplicationHealth"])
  )
    return false;
  const row = value.data.pitrHaClusterReplicationHealth;
  if (row === null) return null;
  return record(row) &&
    row.environmentId === environmentId &&
    row.rootServiceId === queriedServiceId
    ? row
    : false;
}
function discoveredRoot(
  observations: readonly { serviceId: string; value: unknown }[],
  target: TargetAuthority,
): { rootServiceId: string; health: unknown } | null {
  const roots: { rootServiceId: string; health: unknown }[] = [];
  for (const observation of observations) {
    const row = rootHealth(
      observation.value,
      target.environmentId,
      observation.serviceId,
    );
    if (row === false) return null;
    if (row !== null)
      roots.push({
        rootServiceId: observation.serviceId,
        health: observation.value,
      });
  }
  return roots.length === 1 ? roots[0]! : null;
}
function providerRootAuthority(
  value: unknown,
  target: TargetAuthority,
): boolean {
  return (
    exact(value, ["data"]) &&
    exact(value.data, ["pitrHaClusterReplicationHealth"]) &&
    exact(value.data.pitrHaClusterReplicationHealth, [
      "allHealthy",
      "checkedAt",
      "environmentId",
      "reachable",
      "rootServiceId",
      "members",
    ]) &&
    value.data.pitrHaClusterReplicationHealth.environmentId ===
      target.environmentId &&
    value.data.pitrHaClusterReplicationHealth.rootServiceId ===
      target.rootServiceId
  );
}
function health(value: unknown, target: TargetAuthority): boolean {
  if (
    !providerRootAuthority(value, target) ||
    !exact(value, ["data"]) ||
    !exact(value.data, ["pitrHaClusterReplicationHealth"])
  )
    return false;
  const row = value.data.pitrHaClusterReplicationHealth;
  if (
    !exact(row, [
      "allHealthy",
      "checkedAt",
      "environmentId",
      "reachable",
      "rootServiceId",
      "members",
    ]) ||
    row.allHealthy !== true ||
    row.reachable !== true ||
    row.environmentId !== target.environmentId ||
    row.rootServiceId !== target.rootServiceId ||
    typeof row.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(row.checkedAt)) ||
    !Array.isArray(row.members) ||
    row.members.length < 2 ||
    row.members.length > 9
  )
    return false;
  let leaders = 0;
  const ids = new Set<string>();
  for (const member of row.members) {
    if (
      !exact(member, [
        "healthy",
        "isLeader",
        "lagMb",
        "patroniName",
        "serviceId",
        "serviceName",
        "state",
      ]) ||
      member.healthy !== true ||
      typeof member.isLeader !== "boolean" ||
      !(
        member.lagMb === null ||
        (Number.isInteger(member.lagMb) &&
          Number(member.lagMb) >= 0 &&
          Number(member.lagMb) <= 16)
      ) ||
      typeof member.patroniName !== "string" ||
      member.patroniName.length < 1 ||
      member.patroniName.length > 128 ||
      !UUID.test(String(member.serviceId)) ||
      typeof member.serviceName !== "string" ||
      member.serviceName.length < 1 ||
      member.serviceName.length > 128 ||
      typeof member.state !== "string" ||
      !["running", "streaming"].includes(member.state) ||
      ids.has(String(member.serviceId))
    )
      return false;
    ids.add(String(member.serviceId));
    if (member.isLeader) leaders += 1;
  }
  return leaders === 1 && ids.has(target.rootServiceId);
}
function progress(
  value: unknown,
  target: TargetAuthority,
): "done" | "failed" | "pending" | "invalid" {
  if (
    !exact(value, ["data"]) ||
    !exact(value.data, ["pitrHaWorkflowProgress"]) ||
    value.data.pitrHaWorkflowProgress === null
  )
    return "invalid";
  const row = value.data.pitrHaWorkflowProgress;
  if (
    !exact(row, [
      "workflowId",
      "projectId",
      "environmentId",
      "rootServiceId",
      "direction",
      "phase",
      "clusterMutated",
      "startedAt",
      "updatedAt",
      "completedAt",
      "currentMemberServiceId",
      "newLeaderServiceId",
      "errorMessage",
      "failedAtPhase",
      "members",
    ]) ||
    !UUID.test(String(row.workflowId)) ||
    row.projectId !== target.projectId ||
    row.environmentId !== target.environmentId ||
    row.rootServiceId !== target.rootServiceId ||
    row.direction !== "ENABLE" ||
    typeof row.startedAt !== "string" ||
    !Number.isFinite(Date.parse(row.startedAt)) ||
    typeof row.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    !Array.isArray(row.members) ||
    row.members.length < 2 ||
    row.members.length > 9
  )
    return "invalid";
  let leaders = 0;
  const ids = new Set<string>();
  for (const member of row.members) {
    if (
      !exact(member, ["serviceId", "serviceName", "isLeader", "status"]) ||
      !UUID.test(String(member.serviceId)) ||
      typeof member.serviceName !== "string" ||
      member.serviceName.length < 1 ||
      member.serviceName.length > 128 ||
      typeof member.isLeader !== "boolean" ||
      !["HEALTHY", "PENDING", "RESTARTING", "SKIPPED"].includes(
        String(member.status),
      ) ||
      ids.has(String(member.serviceId))
    )
      return "invalid";
    ids.add(String(member.serviceId));
    if (member.isLeader) leaders += 1;
  }
  if (leaders !== 1 || !ids.has(target.rootServiceId)) return "invalid";
  if (row.phase === "FAILED")
    return typeof row.errorMessage === "string" &&
      row.errorMessage.length > 0 &&
      row.errorMessage.length <= 1024 &&
      typeof row.failedAtPhase === "string"
      ? "failed"
      : "invalid";
  if (row.phase === "DONE")
    return row.clusterMutated === true &&
      typeof row.completedAt === "string" &&
      Number.isFinite(Date.parse(row.completedAt)) &&
      row.errorMessage === null &&
      row.failedAtPhase === null &&
      row.members.every(
        (member) => record(member) && member.status === "HEALTHY",
      )
      ? "done"
      : "invalid";
  return typeof row.phase === "string" && row.completedAt === null
    ? "pending"
    : "invalid";
}
function priorAbsent(value: unknown): boolean {
  return (
    exact(value, ["data"]) &&
    exact(value.data, ["pitrHaWorkflowProgress"]) &&
    value.data.pitrHaWorkflowProgress === null
  );
}
async function defaultBoundary(
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  let output = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", BOUNDARY_POLICY_PATH],
    env,
    writeOutput: (source) => {
      output += source;
    },
  });
  try {
    return (
      code === 0 &&
      (JSON.parse(output) as Record<string, unknown>).outcome === "passed"
    );
  } catch {
    return false;
  }
}
function checks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    targetExact: false,
    protectedTargetAuthorityExact: false,
    credentialsExact: false,
    tokenScopesExact: false,
    providerRootAuthorityExact: false,
    healthPreflightExact: false,
    priorWorkflowAbsent: false,
    boundaryPreflightExact: false,
    durableIntentExact: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    workflowDoneExact: false,
    healthPostflightExact: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}
function receipt(
  a: Args | null,
  target: TargetAuthority | null,
  outcome:
    "enabled" | "failed_before_attempt" | "mutation_uncertain" | "blocked",
  attempts: 0 | 1,
  intent: string | null,
  terminal: string | null,
  s: Checks,
) {
  return {
    schemaVersion: PROTECTED_POSTGRES_HA_PITR_SCHEMA,
    executorState: PROTECTED_POSTGRES_HA_PITR_STATE,
    outcome,
    attempts,
    retryAllowed: false,
    candidateSha: a?.candidateSha ?? null,
    targetEnvironment: a?.targetEnvironment ?? null,
    githubEnvironment:
      a === null ? null : TARGETS[a.targetEnvironment].githubEnvironment,
    projectId: target?.projectId ?? null,
    environmentId: target?.environmentId ?? null,
    rootServiceId: target?.rootServiceId ?? null,
    targetAuthoritySha256: target?.authoritySha256 ?? null,
    intentSha256: intent,
    terminalEvidenceSha256: terminal,
    checks: s,
  };
}
export async function runProtectedPostgresHaPitr(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const d: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    writeDurable: durable,
    writeOutput: (source) => process.stdout.write(source),
    runBoundary: () => defaultBoundary(process.env),
    ...overrides,
  };
  const a = args(d.argv),
    s = checks();
  let target: TargetAuthority | null = null,
    attempts: 0 | 1 = 0,
    intentSha: string | null = null,
    terminalSha: string | null = null,
    outcome:
      "enabled" | "failed_before_attempt" | "mutation_uncertain" | "blocked" =
      "blocked",
    metadataToken = "";
  try {
    s.policyExact = policy(d.cwd);
    s.targetExact = a !== null;
    target = a === null ? null : resolveTargetAuthority(a, d.env);
    s.protectedTargetAuthorityExact = target !== null;
    s.githubAuthorityExact =
      a !== null &&
      d.env.GITHUB_REF === "refs/heads/main" &&
      d.env.GITHUB_SHA === a.candidateSha &&
      d.env.GITHUB_RUN_ATTEMPT === "1" &&
      d.env.PINTPATH_POSTGRES_HA_PITR_CONFIRMATION ===
        TARGETS[a.targetEnvironment].confirmation;
    if (
      !a ||
      !target ||
      !s.policyExact ||
      !s.githubAuthorityExact ||
      !s.targetExact ||
      !s.protectedTargetAuthorityExact
    )
      throw new Error("authority_invalid");
    const authorizedTarget = target;
    metadataToken = d.env.PINTPATH_RAILWAY_PITR_METADATA_TOKEN ?? "";
    const writeToken = d.env.PINTPATH_RAILWAY_PITR_ENABLE_TOKEN ?? "";
    s.credentialsExact =
      TOKEN.test(metadataToken) &&
      TOKEN.test(writeToken) &&
      metadataToken !== writeToken;
    if (!s.credentialsExact) throw new Error("credentials_invalid");
    const [metadataScope, writeScope, environmentInventory] = await Promise.all(
      [
        call(d.fetchImpl, metadataToken, POSTGRES_HA_PITR_SCOPE, {}),
        call(d.fetchImpl, writeToken, POSTGRES_HA_PITR_SCOPE, {}),
        call(d.fetchImpl, metadataToken, POSTGRES_HA_PITR_INVENTORY, {
          projectId: authorizedTarget.projectId,
          environmentId: authorizedTarget.environmentId,
        }),
      ],
    );
    s.tokenScopesExact =
      scope(metadataScope, authorizedTarget) &&
      scope(writeScope, authorizedTarget);
    const serviceIds = inventory(environmentInventory, authorizedTarget);
    if (!s.tokenScopesExact || serviceIds === null)
      throw new Error("inventory_invalid");
    const healthObservations = await Promise.all(
      serviceIds.map(async (serviceId) => ({
        serviceId,
        value: await call(d.fetchImpl, metadataToken, POSTGRES_HA_PITR_HEALTH, {
          environmentId: authorizedTarget.environmentId,
          rootServiceId: serviceId,
        }),
      })),
    );
    const discovered = discoveredRoot(healthObservations, authorizedTarget);
    s.providerRootAuthorityExact =
      discovered?.rootServiceId === authorizedTarget.rootServiceId &&
      providerRootAuthority(discovered.health, authorizedTarget);
    s.healthPreflightExact =
      discovered !== null && health(discovered.health, authorizedTarget);
    if (!s.providerRootAuthorityExact || !s.healthPreflightExact)
      throw new Error("provider_root_authority_invalid");
    const preProgress = await call(
      d.fetchImpl,
      metadataToken,
      POSTGRES_HA_PITR_PROGRESS,
      {
        environmentId: authorizedTarget.environmentId,
        rootServiceId: authorizedTarget.rootServiceId,
      },
    );
    s.priorWorkflowAbsent = priorAbsent(preProgress);
    s.boundaryPreflightExact = await d.runBoundary();
    if (!s.priorWorkflowAbsent || !s.boundaryPreflightExact)
      throw new Error("preflight_invalid");
    const intent = canonical({
      schemaVersion: "pintpath-protected-postgres-ha-pitr-intent/v2",
      candidateSha: a.candidateSha,
      targetEnvironment: authorizedTarget.targetEnvironment,
      githubEnvironment: authorizedTarget.githubEnvironment,
      projectId: authorizedTarget.projectId,
      environmentId: authorizedTarget.environmentId,
      rootServiceId: authorizedTarget.rootServiceId,
      targetAuthoritySha256: authorizedTarget.authoritySha256,
      operation: "enablePitrForHaCluster",
      maximumAttempts: 1,
      retryAllowed: false,
      secretMaterialIncluded: false,
    });
    intentSha = d.writeDurable(a.evidenceDir, "intent.json", intent);
    s.durableIntentExact = intentSha === sha256(intent);
    if (!s.durableIntentExact) throw new Error("intent_invalid");
    attempts = 1;
    try {
      const ack = await call(d.fetchImpl, writeToken, POSTGRES_HA_PITR_ENABLE, {
        input: {
          projectId: authorizedTarget.projectId,
          environmentId: authorizedTarget.environmentId,
          rootServiceId: authorizedTarget.rootServiceId,
        },
      });
      s.acknowledgementExact =
        exact(ack, ["data"]) &&
        exact(ack.data, ["enablePitrForHaCluster"]) &&
        exact(ack.data.enablePitrForHaCluster, ["projectId", "workflowId"]) &&
        ack.data.enablePitrForHaCluster.projectId ===
          authorizedTarget.projectId &&
        UUID.test(String(ack.data.enablePitrForHaCluster.workflowId));
    } catch {
      s.acknowledgementExact = false;
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    if (attempts === 1 && a && target) {
      s.postflightAttempted = true;
      const deadline = d.now() + 30 * 60_000;
      for (let poll = 0; poll < 181; poll += 1) {
        try {
          const state = await call(
            d.fetchImpl,
            metadataToken,
            POSTGRES_HA_PITR_PROGRESS,
            {
              environmentId: target.environmentId,
              rootServiceId: target.rootServiceId,
            },
          );
          const parsed = progress(state, target);
          if (parsed === "done") {
            s.workflowDoneExact = true;
            break;
          }
          if (parsed === "failed" || parsed === "invalid") break;
        } catch {
          /* bounded read-only reconciliation */
        }
        if (d.now() >= deadline || poll === 180) break;
        await d.sleep(10_000);
      }
      if (s.workflowDoneExact)
        try {
          s.healthPostflightExact = health(
            await call(d.fetchImpl, metadataToken, POSTGRES_HA_PITR_HEALTH, {
              environmentId: target.environmentId,
              rootServiceId: target.rootServiceId,
            }),
            target,
          );
        } catch {
          s.healthPostflightExact = false;
        }
      outcome =
        s.acknowledgementExact && s.workflowDoneExact && s.healthPostflightExact
          ? "enabled"
          : "mutation_uncertain";
      try {
        s.boundaryPostflightExact = await d.runBoundary();
      } catch {
        s.boundaryPostflightExact = false;
      }
      if (!s.boundaryPostflightExact) outcome = "mutation_uncertain";
    }
  }
  const provisional = receipt(a, target, outcome, attempts, intentSha, null, s);
  if (a && s.durableIntentExact)
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-protected-postgres-ha-pitr-terminal/v2",
        receipt: provisional,
      });
      terminalSha = d.writeDurable(a.evidenceDir, "terminal.json", terminal);
      s.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      s.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  d.writeOutput(
    `${JSON.stringify(receipt(a, target, outcome, attempts, intentSha, terminalSha, s))}\n`,
  );
  return outcome === "enabled" && s.terminalEvidenceExact ? 0 : 1;
}
export const protectedPostgresHaPitrInternals = {
  args,
  resolveTargetAuthority,
  scope,
  inventory,
  rootHealth,
  discoveredRoot,
  providerRootAuthority,
  health,
  progress,
  priorAbsent,
  policy,
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runProtectedPostgresHaPitr();
