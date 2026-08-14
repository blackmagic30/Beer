import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  DISPOSABLE_RESTORE_DELETE_MUTATION,
  DISPOSABLE_RESTORE_INVENTORY_QUERY,
  protectedDisposableRestoreTeardownInternals,
} from "./execute-protected-disposable-restore-teardown.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";
import {
  emergencyCleanupSha256,
  parseEmergencyCleanupState,
  priorAcknowledgementFor,
  type EmergencyCleanupState,
} from "./lib/production-promotion-recovery-emergency-cleanup-state.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
  type HeldPrivateDirectoryIdentity,
} from "./lib/trusted-filesystem.js";

export const PRODUCTION_RECOVERY_RAILWAY_TEARDOWN_KIND =
  "pintpath-production-recovery-railway-teardown" as const;
export const PRODUCTION_RECOVERY_RAILWAY_TEARDOWN_TERMINAL_SCHEMA =
  "pintpath-production-recovery-railway-teardown-terminal/v1" as const;

const POLICY_PATH =
  "ops/railway/protected-production-recovery-cleanup-policy.json";
const POLICY_SHA256 =
  "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef";
const REPOSITORY = "blackmagic30/Beer";
const ACTIVATION_WORKFLOW_PATH =
  ".github/workflows/activate-production-promotion-recovery.yml";
const EMERGENCY_CLEANUP_WORKFLOW_PATH =
  ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const FORBIDDEN_PROJECT_IDS = Object.freeze([
  "48d8c6cd-1c66-4148-874b-20877f48e1a5",
]);
const FORBIDDEN_ENVIRONMENT_IDS = Object.freeze([
  "13dab015-df74-45c6-b26f-69323daea99a",
  "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
]);
const ARGUMENTS = new Set([
  "--candidate-sha",
  "--activation-run-id",
  "--project-id",
  "--project-name",
  "--environment-id",
  "--environment-name",
  "--inventory-sha256",
  "--workspace-id",
  "--workspace-name",
  "--workspace-project-inventory-sha256",
  "--emergency-cleanup-arm-authority-sha256",
  "--emergency-cleanup-state-file",
  "--emergency-cleanup-state-sha256",
  "--teardown-authority-file",
  "--teardown-authority-sha256",
  "--teardown-authority-public-key-file",
  "--teardown-authority-public-key-sha256",
  "--read-token-file",
  "--delete-token-file",
  "--evidence-dir",
  "--output",
]);
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^pintpath-disposable-restore-[a-z0-9][a-z0-9-]{0,79}$/;
const TOKEN = /^[^\r\n\0\s]{16,4096}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const WORKSPACE_PAGE_SIZE = 100;
const MAX_WORKSPACE_PROJECTS = 10_000;

export const PRODUCTION_RECOVERY_RAILWAY_WORKSPACE_INVENTORY_QUERY = `query PintPathRecoveryWorkspaceInventory($workspaceId:String!,$after:String){
  workspace(workspaceId:$workspaceId){id name}
  projects(workspaceId:$workspaceId,first:100,after:$after){
    edges{node{id name}}
    pageInfo{hasNextPage endCursor}
  }
}`;

type Json = Record<string, unknown>;

interface Args {
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly inventorySha256: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceProjectInventorySha256: string;
  readonly emergencyCleanupArmAuthoritySha256: string;
  readonly emergencyCleanupStateFile: string | null;
  readonly emergencyCleanupStateSha256: string | null;
  readonly teardownAuthorityFile: string;
  readonly teardownAuthoritySha256: string;
  readonly teardownAuthorityPublicKeyFile: string;
  readonly teardownAuthorityPublicKeySha256: string;
  readonly readTokenFile: string;
  readonly deleteTokenFile: string;
  readonly evidenceDir: string;
  readonly output: string;
}

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  targetNotProtected: boolean;
  signedAuthorityExact: boolean;
  credentialsSeparatedExact: boolean;
  metadataAuthoritiesAgree: boolean;
  completeInventoryExact: boolean;
  signedServiceInventoryExact: boolean;
  workspaceAuthoritiesExact: boolean;
  completeWorkspaceInventoryExact: boolean;
  signedWorkspaceInventoryExact: boolean;
  durableIntentExact: boolean;
  deleteAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  targetAbsentExact: boolean;
  terminalEvidenceExact: boolean;
}

interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
}

interface WorkspaceInventory {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly projects: readonly WorkspaceProject[];
}

type Outcome =
  | "deleted"
  | "reconciled_from_prior_ack"
  | "deleted_reconciled"
  | "already_absent"
  | "failed_before_attempt"
  | "mutation_uncertain";

export class ProductionRecoveryRailwayTeardownError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProductionRecoveryRailwayTeardownError";
  }
}

function fail(code: string): never {
  throw new ProductionRecoveryRailwayTeardownError(code);
}

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function exactAbsolute(value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  ) {
    fail("arguments_invalid");
  }
  return value;
}

function exactAbsoluteOrNone(value: string): string | null {
  return value === "none" ? null : exactAbsolute(value);
}

function canonicalInventory(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseCanonical(source: string, code: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail(code);
  }
  if (!record(value) || canonicalPostgresBackupJson(value) !== source)
    fail(code);
  return value;
}

function exactTimestamp(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(code);
  return value;
}

function parseArgs(argv: readonly string[]): Args {
  let values: ReadonlyMap<string, string>;
  try {
    values = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: ARGUMENTS,
    });
  } catch {
    fail("arguments_invalid");
  }
  const candidateSha = values.get("--candidate-sha")!;
  const activationRunId = values.get("--activation-run-id")!;
  const projectId = values.get("--project-id")!;
  const projectName = values.get("--project-name")!;
  const environmentId = values.get("--environment-id")!;
  const environmentName = values.get("--environment-name")!;
  const inventorySha256 = values.get("--inventory-sha256")!;
  const workspaceId = values.get("--workspace-id")!;
  const workspaceName = values.get("--workspace-name")!;
  const workspaceProjectInventorySha256 = values.get(
    "--workspace-project-inventory-sha256",
  )!;
  const emergencyCleanupArmAuthoritySha256 = values.get(
    "--emergency-cleanup-arm-authority-sha256",
  )!;
  const emergencyCleanupStateFile = exactAbsoluteOrNone(
    values.get("--emergency-cleanup-state-file")!,
  );
  const emergencyCleanupStateSha256 =
    values.get("--emergency-cleanup-state-sha256") === "none"
      ? null
      : values.get("--emergency-cleanup-state-sha256")!;
  if (
    !SHA.test(candidateSha) ||
    !/^[1-9]\d{0,19}$/.test(activationRunId) ||
    !UUID.test(projectId) ||
    !NAME.test(projectName) ||
    !UUID.test(environmentId) ||
    !NAME.test(environmentName) ||
    projectName !== environmentName ||
    !SHA256.test(inventorySha256) ||
    !UUID.test(workspaceId) ||
    workspaceName.length < 1 ||
    workspaceName.length > 100 ||
    workspaceName !== workspaceName.trim() ||
    /[\r\n\0]/.test(workspaceName) ||
    !SHA256.test(workspaceProjectInventorySha256) ||
    !SHA256.test(emergencyCleanupArmAuthoritySha256) ||
    (emergencyCleanupStateFile === null) !==
      (emergencyCleanupStateSha256 === null) ||
    (emergencyCleanupStateSha256 !== null &&
      !SHA256.test(emergencyCleanupStateSha256)) ||
    !SHA256.test(values.get("--teardown-authority-sha256")!) ||
    !SHA256.test(values.get("--teardown-authority-public-key-sha256")!)
  ) {
    fail("arguments_invalid");
  }
  return {
    candidateSha,
    activationRunId,
    projectId,
    projectName,
    environmentId,
    environmentName,
    inventorySha256,
    workspaceId,
    workspaceName,
    workspaceProjectInventorySha256,
    emergencyCleanupArmAuthoritySha256,
    emergencyCleanupStateFile,
    emergencyCleanupStateSha256,
    teardownAuthorityFile: exactAbsolute(
      values.get("--teardown-authority-file")!,
    ),
    teardownAuthoritySha256: values.get("--teardown-authority-sha256")!,
    teardownAuthorityPublicKeyFile: exactAbsolute(
      values.get("--teardown-authority-public-key-file")!,
    ),
    teardownAuthorityPublicKeySha256: values.get(
      "--teardown-authority-public-key-sha256",
    )!,
    readTokenFile: exactAbsolute(values.get("--read-token-file")!),
    deleteTokenFile: exactAbsolute(values.get("--delete-token-file")!),
    evidenceDir: exactAbsolute(values.get("--evidence-dir")!),
    output: exactAbsolute(values.get("--output")!),
  };
}

function policyExact(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    const value = JSON.parse(source.toString("utf8")) as unknown;
    return (
      hash(source) === POLICY_SHA256 &&
      record(value) &&
      value.schemaVersion ===
        "pintpath-protected-production-recovery-railway-cleanup-policy/v2" &&
      value.policyId ===
        "pintpath-production-recovery-disposable-railway-cleanup" &&
      value.activationState === "GITHUB_ENVIRONMENT_PROTECTED" &&
      value.githubEnvironment === "production-promotion-recovery-cleanup" &&
      value.repository === REPOSITORY &&
      value.activationWorkflowPath === ACTIVATION_WORKFLOW_PATH &&
      value.emergencyCleanupWorkflowPath === EMERGENCY_CLEANUP_WORKFLOW_PATH &&
      value.requiredGitRef === "refs/heads/main" &&
      value.requiredRunAttempt === 1 &&
      JSON.stringify(value.forbiddenProjectIds) ===
        JSON.stringify(FORBIDDEN_PROJECT_IDS) &&
      JSON.stringify(value.forbiddenEnvironmentIds) ===
        JSON.stringify(FORBIDDEN_ENVIRONMENT_IDS) &&
      record(value.targetContract) &&
      value.targetContract
        .signedProjectEnvironmentAndServiceInventoryRequired === true &&
      value.targetContract
        .signedWorkspaceIdentityAndCompleteProjectInventoryRequired === true &&
      value.targetContract.targetRequiredInSignedWorkspaceInventory === true &&
      value.targetContract.signedAuthorityRequiredActivationRunId === true &&
      value.targetContract.signedEmergencyCleanupArmAuthoritySha256Required ===
        true &&
      value.targetContract.completeInventorySha256Required === true &&
      value.targetContract.allConnectionPaginationMustBeComplete === true &&
      record(value.executionContract) &&
      value.executionContract.observedCleanupRunIdRecorded === true &&
      value.executionContract.activationRunCleanupRequiresSameRunId === true &&
      value.executionContract.emergencyControllerMayUseDistinctRunId === true &&
      value.executionContract.emergencyControllerRequiresArmedAuthority ===
        true &&
      value.executionContract
        .emergencyControllerReceiptsAcceptedForGreenActivation === false &&
      value.executionContract.requiredRunAttempt === 1 &&
      JSON.stringify(value.executionContract.allowedEmergencyEvents) ===
        JSON.stringify(["schedule", "workflow_dispatch", "workflow_run"]) &&
      record(value.providerContract) &&
      value.providerContract.graphqlEndpoint === ENDPOINT &&
      value.providerContract.inventoryOperation === "projectsByIds" &&
      value.providerContract.workspaceIdentityOperation === "workspace" &&
      value.providerContract.workspaceProjectInventoryOperation ===
        "projects(workspaceId)" &&
      value.providerContract.workspaceProjectInventoryPageSize ===
        WORKSPACE_PAGE_SIZE &&
      value.providerContract
        .bothTokensMustProveSameWorkspaceAndCompleteInventory === true &&
      value.providerContract.alreadyAbsentMaySucceed === false &&
      value.providerContract
        .postDeleteRequiresSignedInventoryMinusTargetExact === true &&
      value.providerContract.deleteOperation === "projectDelete" &&
      value.providerContract.maximumDeleteAttempts === 1 &&
      value.providerContract.automaticRetriesAllowed === false &&
      value.providerContract.unconditionalReadReconciliationRequired === true &&
      value.providerContract.exactDeleteAcknowledgementRequiredForSuccess ===
        true &&
      value.providerContract.lostAcknowledgementMaySucceed === false &&
      value.providerContract.workspaceScopedAbsenceIsNotGlobalDeletionProof ===
        true &&
      record(value.credentials) &&
      value.credentials.separateReadAndDeleteTokenFilesRequired === true &&
      value.credentials.workspaceScopedTokensRequired === true &&
      value.credentials.sourceDatabaseCredentialsAllowed === false &&
      value.credentials.wormCredentialsAllowed === false &&
      value.credentials.supabaseCredentialsAllowed === false
    );
  } catch {
    return false;
  }
}

function exactServiceInventory(
  value: unknown,
  kind: "services" | "serviceInstances",
): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!record(entry)) return false;
    if (kind === "services") {
      if (
        !exactKeys(entry, ["id", "name"]) ||
        !UUID.test(String(entry.id)) ||
        typeof entry.name !== "string" ||
        entry.name.length < 1 ||
        entry.name.length > 100
      ) {
        return false;
      }
    } else if (
      !exactKeys(entry, ["id", "serviceId", "serviceName"]) ||
      !UUID.test(String(entry.id)) ||
      !UUID.test(String(entry.serviceId)) ||
      typeof entry.serviceName !== "string" ||
      entry.serviceName.length < 1 ||
      entry.serviceName.length > 100
    )
      return false;
    if (ids.has(String(entry.id))) return false;
    ids.add(String(entry.id));
  }
  return value.every(
    (entry, index) =>
      index === 0 ||
      String((value[index - 1] as Json).id).localeCompare(
        String((entry as Json).id),
      ) < 0,
  );
}

function exactWorkspaceProjects(
  value: unknown,
): value is readonly WorkspaceProject[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_WORKSPACE_PROJECTS
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const entry of value) {
    if (
      !record(entry) ||
      !exactKeys(entry, ["id", "name"]) ||
      !UUID.test(String(entry.id)) ||
      typeof entry.name !== "string" ||
      entry.name.length < 1 ||
      entry.name.length > 100 ||
      entry.name !== entry.name.trim() ||
      /[\r\n\0]/.test(entry.name) ||
      ids.has(String(entry.id))
    ) {
      return false;
    }
    ids.add(String(entry.id));
  }
  return value.every(
    (entry, index) =>
      index === 0 || value[index - 1]!.id.localeCompare(entry.id) < 0,
  );
}

interface VerifiedAuthority {
  readonly reviewerIdSha256: string;
  readonly signedActivationRunId: string;
  readonly services: readonly Json[];
  readonly serviceInstances: readonly Json[];
  readonly workspaceProjects: readonly WorkspaceProject[];
}

function verifyAuthority(input: {
  readonly source: string;
  readonly sourceSha256: string;
  readonly publicKeyPem: string;
  readonly publicKeySha256: string;
  readonly args: Args;
  readonly now: Date;
}): VerifiedAuthority {
  if (
    hash(input.source) !== input.sourceSha256 ||
    hash(input.publicKeyPem) !== input.publicKeySha256
  )
    fail("authority_invalid");
  const envelope = parseCanonical(input.source, "authority_invalid");
  const payload = envelope.payload;
  if (
    !exactKeys(envelope, ["schemaVersion", "payload", "signatureBase64"]) ||
    envelope.schemaVersion !==
      "pintpath-production-recovery-railway-teardown-authority/v2" ||
    !record(payload) ||
    !exactKeys(payload, [
      "schemaVersion",
      "operation",
      "candidateSha",
      "repository",
      "workflowPath",
      "requiredGitRef",
      "requiredRunAttempt",
      "requiredGithubRunId",
      "projectId",
      "projectName",
      "environmentId",
      "environmentName",
      "inventorySha256",
      "workspaceId",
      "workspaceName",
      "workspaceProjects",
      "workspaceProjectInventorySha256",
      "emergencyCleanupArmAuthoritySha256",
      "services",
      "serviceInstances",
      "policySha256",
      "forbiddenProjectIds",
      "forbiddenEnvironmentIds",
      "reviewerIdSha256",
      "reviewerPublicKeySha256",
      "issuedAt",
      "expiresAt",
    ]) ||
    typeof envelope.signatureBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      envelope.signatureBase64,
    ) ||
    !exactServiceInventory(payload.services, "services") ||
    !exactServiceInventory(payload.serviceInstances, "serviceInstances") ||
    !exactWorkspaceProjects(payload.workspaceProjects)
  ) {
    fail("authority_invalid");
  }
  const issuedAt = exactTimestamp(payload.issuedAt, "authority_invalid");
  const expiresAt = exactTimestamp(payload.expiresAt, "authority_invalid");
  const nowMs = input.now.getTime();
  const args = input.args;
  if (
    payload.schemaVersion !==
      "pintpath-production-recovery-railway-teardown-authority-payload/v2" ||
    payload.operation !== "delete-exact-disposable-railway-recovery-project" ||
    payload.candidateSha !== args.candidateSha ||
    payload.repository !== REPOSITORY ||
    payload.workflowPath !== ACTIVATION_WORKFLOW_PATH ||
    payload.requiredGitRef !== "refs/heads/main" ||
    payload.requiredRunAttempt !== 1 ||
    payload.requiredGithubRunId !== args.activationRunId ||
    payload.projectId !== args.projectId ||
    payload.projectName !== args.projectName ||
    payload.environmentId !== args.environmentId ||
    payload.environmentName !== args.environmentName ||
    payload.inventorySha256 !== args.inventorySha256 ||
    payload.workspaceId !== args.workspaceId ||
    payload.workspaceName !== args.workspaceName ||
    payload.workspaceProjectInventorySha256 !==
      args.workspaceProjectInventorySha256 ||
    payload.emergencyCleanupArmAuthoritySha256 !==
      args.emergencyCleanupArmAuthoritySha256 ||
    hash(canonicalPostgresBackupJson(payload.workspaceProjects)) !==
      args.workspaceProjectInventorySha256 ||
    !payload.workspaceProjects.some(
      (project) =>
        project.id === args.projectId && project.name === args.projectName,
    ) ||
    payload.policySha256 !== POLICY_SHA256 ||
    JSON.stringify(payload.forbiddenProjectIds) !==
      JSON.stringify(FORBIDDEN_PROJECT_IDS) ||
    JSON.stringify(payload.forbiddenEnvironmentIds) !==
      JSON.stringify(FORBIDDEN_ENVIRONMENT_IDS) ||
    payload.reviewerPublicKeySha256 !== input.publicKeySha256 ||
    typeof payload.reviewerIdSha256 !== "string" ||
    !SHA256.test(payload.reviewerIdSha256) ||
    !Number.isFinite(nowMs) ||
    Date.parse(issuedAt) > nowMs ||
    Date.parse(expiresAt) <= nowMs ||
    Date.parse(expiresAt) - Date.parse(issuedAt) > 86_400_000
  )
    fail("authority_invalid");
  try {
    const key = crypto.createPublicKey(input.publicKeyPem);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !crypto.verify(
        null,
        Buffer.from(canonicalPostgresBackupJson(payload)),
        key,
        Buffer.from(envelope.signatureBase64, "base64"),
      )
    )
      fail("authority_invalid");
  } catch {
    fail("authority_invalid");
  }
  return {
    reviewerIdSha256: payload.reviewerIdSha256,
    signedActivationRunId: args.activationRunId,
    services: payload.services as readonly Json[],
    serviceInstances: payload.serviceInstances as readonly Json[],
    workspaceProjects: payload.workspaceProjects,
  };
}

async function readPrivateFile(filename: string): Promise<string> {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 256 * 1024,
      requireOwner: true,
      requirePrivate: true,
    }).toString("utf8");
  } catch {
    fail("private_file_unsafe");
  }
}

async function providerCall(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  requestTimeoutMs: number,
): Promise<unknown> {
  let bounded;
  try {
    const signal = AbortSignal.timeout(requestTimeoutMs);
    bounded = await fetchBoundedResponseText(
      fetchImpl,
      ENDPOINT,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        cache: "no-store",
      },
      { maximumBytes: MAX_RESPONSE_BYTES, signal },
    );
  } catch {
    fail("provider_invalid");
  }
  const { response, source } = bounded;
  if (
    !response.ok ||
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    fail("provider_invalid");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail("provider_invalid");
  }
}

function parseWorkspacePage(
  value: unknown,
  args: Args,
  expectedAfter: string | null,
): {
  readonly projects: readonly WorkspaceProject[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
} {
  if (
    !record(value) ||
    !exactKeys(value, ["data"]) ||
    !record(value.data) ||
    !exactKeys(value.data, ["workspace", "projects"]) ||
    !record(value.data.workspace) ||
    !exactKeys(value.data.workspace, ["id", "name"]) ||
    value.data.workspace.id !== args.workspaceId ||
    value.data.workspace.name !== args.workspaceName ||
    !record(value.data.projects) ||
    !exactKeys(value.data.projects, ["edges", "pageInfo"]) ||
    !Array.isArray(value.data.projects.edges) ||
    value.data.projects.edges.length > WORKSPACE_PAGE_SIZE ||
    !record(value.data.projects.pageInfo) ||
    !exactKeys(value.data.projects.pageInfo, ["hasNextPage", "endCursor"]) ||
    typeof value.data.projects.pageInfo.hasNextPage !== "boolean"
  ) {
    fail("workspace_inventory_invalid");
  }
  const hasNextPage = value.data.projects.pageInfo.hasNextPage;
  const endCursor = value.data.projects.pageInfo.endCursor;
  if (
    (hasNextPage &&
      (typeof endCursor !== "string" ||
        endCursor.length < 1 ||
        endCursor.length > 512 ||
        /[\r\n\0]/.test(endCursor) ||
        endCursor === expectedAfter)) ||
    (!hasNextPage &&
      endCursor !== null &&
      (typeof endCursor !== "string" ||
        endCursor.length < 1 ||
        endCursor.length > 512 ||
        /[\r\n\0]/.test(endCursor)))
  ) {
    fail("workspace_inventory_invalid");
  }
  const projects = value.data.projects.edges.map((edge) => {
    if (
      !record(edge) ||
      !exactKeys(edge, ["node"]) ||
      !record(edge.node) ||
      !exactKeys(edge.node, ["id", "name"]) ||
      !UUID.test(String(edge.node.id)) ||
      typeof edge.node.name !== "string" ||
      edge.node.name.length < 1 ||
      edge.node.name.length > 100 ||
      edge.node.name !== edge.node.name.trim() ||
      /[\r\n\0]/.test(edge.node.name)
    ) {
      fail("workspace_inventory_invalid");
    }
    return { id: String(edge.node.id), name: edge.node.name };
  });
  if (hasNextPage && projects.length === 0) fail("workspace_inventory_invalid");
  return { projects, hasNextPage, endCursor: endCursor as string | null };
}

async function readWorkspaceInventory(
  fetchImpl: typeof fetch,
  token: string,
  args: Args,
  requestTimeoutMs: number,
): Promise<WorkspaceInventory> {
  const projects: WorkspaceProject[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  while (true) {
    const page = parseWorkspacePage(
      await providerCall(
        fetchImpl,
        token,
        PRODUCTION_RECOVERY_RAILWAY_WORKSPACE_INVENTORY_QUERY,
        { workspaceId: args.workspaceId, after },
        requestTimeoutMs,
      ),
      args,
      after,
    );
    projects.push(...page.projects);
    if (projects.length > MAX_WORKSPACE_PROJECTS)
      fail("workspace_inventory_invalid");
    if (!page.hasNextPage) break;
    if (page.endCursor === null || cursors.has(page.endCursor)) {
      fail("workspace_inventory_invalid");
    }
    cursors.add(page.endCursor);
    after = page.endCursor;
  }
  const sorted = [...projects].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (
    sorted.length !== projects.length ||
    new Set(sorted.map((project) => project.id)).size !== sorted.length
  ) {
    fail("workspace_inventory_invalid");
  }
  return Object.freeze({
    workspaceId: args.workspaceId,
    workspaceName: args.workspaceName,
    projects: Object.freeze(sorted),
  });
}

function normalizedInventory(
  value: unknown,
  args: Args,
): Json | null | "invalid" {
  if (protectedDisposableRestoreTeardownInternals.absent(value)) return null;
  const parsed = protectedDisposableRestoreTeardownInternals.inventory(
    value,
    args,
  );
  return parsed ?? "invalid";
}

function signedServiceInventoryExact(
  value: Json,
  authority: VerifiedAuthority,
): boolean {
  if (!Array.isArray(value.services) || !Array.isArray(value.serviceInstances))
    return false;
  const services = value.services.map((entry) => ({
    id: (entry as Json).id,
    name: (entry as Json).name,
  }));
  const instances = value.serviceInstances.map((entry) => ({
    id: (entry as Json).id,
    serviceId: (entry as Json).serviceId,
    serviceName: (entry as Json).serviceName,
  }));
  return (
    canonicalPostgresBackupJson(services) ===
      canonicalPostgresBackupJson(authority.services) &&
    canonicalPostgresBackupJson(instances) ===
      canonicalPostgresBackupJson(authority.serviceInstances)
  );
}

function initialChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    targetNotProtected: false,
    signedAuthorityExact: false,
    credentialsSeparatedExact: false,
    metadataAuthoritiesAgree: false,
    completeInventoryExact: false,
    signedServiceInventoryExact: false,
    workspaceAuthoritiesExact: false,
    completeWorkspaceInventoryExact: false,
    signedWorkspaceInventoryExact: false,
    durableIntentExact: false,
    deleteAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    targetAbsentExact: false,
    terminalEvidenceExact: false,
  };
}

function receipt(input: {
  readonly args: Args;
  readonly outcome: Outcome;
  readonly attempts: 0 | 1;
  readonly reviewerIdSha256: string | null;
  readonly observedCleanupRunId: string | null;
  readonly signedActivationRunId: string | null;
  readonly cleanupWorkflowPath: string | null;
  readonly intentSha256: string | null;
  readonly preflightInventorySha256: string | null;
  readonly postflightInventorySha256: string | null;
  readonly preflightWorkspaceProjectInventorySha256: string | null;
  readonly postflightWorkspaceProjectInventorySha256: string | null;
  readonly completedAt: string;
  readonly checks: Checks;
}) {
  const withoutHash = {
    schemaVersion: 1,
    kind: PRODUCTION_RECOVERY_RAILWAY_TEARDOWN_KIND,
    ok: ["deleted", "reconciled_from_prior_ack"].includes(input.outcome),
    outcome: input.outcome,
    completedAt: input.completedAt,
    candidateSha: input.args.candidateSha,
    observedCleanupRunId: input.observedCleanupRunId,
    signedActivationRunId: input.signedActivationRunId,
    cleanupWorkflowPath: input.cleanupWorkflowPath,
    projectId: input.args.projectId,
    projectName: input.args.projectName,
    environmentId: input.args.environmentId,
    environmentName: input.args.environmentName,
    expectedInventorySha256: input.args.inventorySha256,
    workspaceId: input.args.workspaceId,
    workspaceName: input.args.workspaceName,
    expectedWorkspaceProjectInventorySha256:
      input.args.workspaceProjectInventorySha256,
    emergencyCleanupArmAuthoritySha256:
      input.args.emergencyCleanupArmAuthoritySha256,
    policySha256: POLICY_SHA256,
    teardownAuthoritySha256: input.args.teardownAuthoritySha256,
    teardownAuthorityPublicKeySha256:
      input.args.teardownAuthorityPublicKeySha256,
    teardownAuthorityReviewerIdSha256: input.reviewerIdSha256,
    intentSha256: input.intentSha256,
    preflightInventorySha256: input.preflightInventorySha256,
    postflightInventorySha256: input.postflightInventorySha256,
    preflightWorkspaceProjectInventorySha256:
      input.preflightWorkspaceProjectInventorySha256,
    postflightWorkspaceProjectInventorySha256:
      input.postflightWorkspaceProjectInventorySha256,
    deleteAttempts: input.attempts,
    retryAllowed: false,
    checks: input.checks,
  };
  return {
    ...withoutHash,
    receiptSha256: hash(canonicalPostgresBackupJson(withoutHash)),
  };
}

function cleanupWorkflowPath(
  args: Args,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const observedRunId = env.GITHUB_RUN_ID ?? "";
  const workflowRef = env.GITHUB_WORKFLOW_REF ?? "";
  const common =
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.PINTPATH_CHECKED_OUT_CANDIDATE_SHA === args.candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    /^[1-9]\d{0,19}$/.test(observedRunId) &&
    env.PINTPATH_RAILWAY_RECOVERY_TEARDOWN_CONFIRMATION ===
      `DELETE_${args.projectId}`;
  if (!common) return null;
  if (
    workflowRef ===
      `${REPOSITORY}/${ACTIVATION_WORKFLOW_PATH}@refs/heads/main` &&
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_SHA === args.candidateSha &&
    observedRunId === args.activationRunId
  ) {
    return ACTIVATION_WORKFLOW_PATH;
  }
  if (
    workflowRef ===
      `${REPOSITORY}/${EMERGENCY_CLEANUP_WORKFLOW_PATH}@refs/heads/main` &&
    ["schedule", "workflow_dispatch", "workflow_run"].includes(
      env.GITHUB_EVENT_NAME ?? "",
    ) &&
    env.PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARMED === "true" &&
    env.PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_SHA256 ===
      args.emergencyCleanupArmAuthoritySha256
  ) {
    return EMERGENCY_CLEANUP_WORKFLOW_PATH;
  }
  return null;
}

async function loadEmergencyCleanupState(
  args: Args,
  workflowPath: string,
  readPrivateFileImpl: (filename: string) => Promise<string>,
): Promise<EmergencyCleanupState | null> {
  if (workflowPath !== EMERGENCY_CLEANUP_WORKFLOW_PATH) {
    if (
      args.emergencyCleanupStateFile !== null ||
      args.emergencyCleanupStateSha256 !== null
    )
      fail("authority_invalid");
    return null;
  }
  if (
    args.emergencyCleanupStateFile === null ||
    args.emergencyCleanupStateSha256 === null
  )
    fail("authority_invalid");
  const source = await readPrivateFileImpl(
    args.emergencyCleanupStateFile,
  ).catch(() => fail("private_file_unsafe"));
  if (emergencyCleanupSha256(source) !== args.emergencyCleanupStateSha256)
    fail("authority_invalid");
  const state = parseEmergencyCleanupState(source);
  if (
    state.status !== "open" ||
    state.currentArmAuthoritySha256 !==
      args.emergencyCleanupArmAuthoritySha256 ||
    state.candidateSha !== args.candidateSha ||
    state.activationRunId !== args.activationRunId ||
    state.projectId !== args.projectId ||
    state.projectName !== args.projectName ||
    state.environmentId !== args.environmentId ||
    state.environmentName !== args.environmentName ||
    state.inventorySha256 !== args.inventorySha256 ||
    state.workspaceId !== args.workspaceId ||
    state.workspaceName !== args.workspaceName ||
    state.workspaceProjectInventorySha256 !==
      args.workspaceProjectInventorySha256
  )
    fail("authority_invalid");
  return state;
}

export interface ProductionRecoveryRailwayTeardownDependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly now: () => Date;
  readonly fetchImpl: typeof fetch;
  readonly requestTimeoutMs: number;
  readonly readPrivateFile: (filename: string) => Promise<string>;
  readonly holdEvidenceDirectory: (
    directory: string,
  ) => HeldPrivateDirectoryIdentity;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly writeOutput: (source: string) => void;
}

export async function runProductionRecoveryRailwayTeardown(
  overrides: Partial<ProductionRecoveryRailwayTeardownDependencies> = {},
): Promise<0 | 1> {
  const dependencies: ProductionRecoveryRailwayTeardownDependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    fetchImpl: fetch,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    readPrivateFile,
    assertMutationAllowed: assertOperatorMutationAllowed,
    holdEvidenceDirectory: (directory) =>
      holdPrivateDirectoryIdentity(directory, {
        requireExactDirectoryMode: true,
        requireOwner: true,
      }),
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  let args: Args;
  try {
    args = parseArgs(dependencies.argv);
  } catch (error) {
    dependencies.writeOutput(
      canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: false,
        failureCode:
          error instanceof ProductionRecoveryRailwayTeardownError
            ? error.code
            : "unexpected_failure",
      }),
    );
    return 1;
  }
  const state = initialChecks();
  let attempts: 0 | 1 = 0;
  let outcome: Outcome = "failed_before_attempt";
  let reviewerIdSha256: string | null = null;
  let signedActivationRunId: string | null = null;
  let observedWorkflowPath: string | null = null;
  let intentSha256: string | null = null;
  let preflightInventorySha256: string | null = null;
  let postflightInventorySha256: string | null = null;
  let preflightWorkspaceProjectInventorySha256: string | null = null;
  let postflightWorkspaceProjectInventorySha256: string | null = null;
  let readToken = "";
  let outputReady = false;
  let evidenceDirectory: HeldPrivateDirectoryIdentity | null = null;
  let evidenceDirectoryIdentity:
    HeldPrivateDirectoryIdentity["identity"] | null = null;
  let emergencyState: EmergencyCleanupState | null = null;
  try {
    evidenceDirectory = dependencies.holdEvidenceDirectory(args.evidenceDir);
    evidenceDirectoryIdentity = evidenceDirectory.identity;
    evidenceDirectory.assertExact();
    if (
      path.dirname(args.output) !== evidenceDirectory.path ||
      fs.existsSync(args.output) ||
      fs.existsSync(path.join(args.evidenceDir, "railway-delete-intent.json"))
    ) {
      fail("output_unsafe");
    }
    outputReady = true;
    state.policyExact = policyExact(dependencies.cwd);
    observedWorkflowPath = cleanupWorkflowPath(args, dependencies.env);
    state.githubAuthorityExact = observedWorkflowPath !== null;
    state.targetNotProtected =
      !FORBIDDEN_PROJECT_IDS.includes(args.projectId) &&
      !FORBIDDEN_ENVIRONMENT_IDS.includes(args.environmentId);
    if (
      !state.policyExact ||
      !state.githubAuthorityExact ||
      !state.targetNotProtected
    ) {
      fail("authority_invalid");
    }
    emergencyState = await loadEmergencyCleanupState(
      args,
      observedWorkflowPath!,
      dependencies.readPrivateFile,
    );
    const [authoritySource, publicKeyPem] = await Promise.all([
      dependencies.readPrivateFile(args.teardownAuthorityFile),
      dependencies.readPrivateFile(args.teardownAuthorityPublicKeyFile),
    ]).catch(() => fail("private_file_unsafe"));
    const authority = verifyAuthority({
      source: authoritySource,
      sourceSha256: args.teardownAuthoritySha256,
      publicKeyPem,
      publicKeySha256: args.teardownAuthorityPublicKeySha256,
      args,
      now: dependencies.now(),
    });
    reviewerIdSha256 = authority.reviewerIdSha256;
    signedActivationRunId = authority.signedActivationRunId;
    state.signedAuthorityExact = true;
    const [loadedReadToken, deleteToken] = await Promise.all([
      dependencies.readPrivateFile(args.readTokenFile),
      dependencies.readPrivateFile(args.deleteTokenFile),
    ]).catch(() => fail("private_file_unsafe"));
    state.credentialsSeparatedExact =
      TOKEN.test(loadedReadToken) &&
      TOKEN.test(deleteToken) &&
      loadedReadToken !== deleteToken &&
      args.readTokenFile !== args.deleteTokenFile;
    if (!state.credentialsSeparatedExact) fail("credentials_invalid");
    readToken = loadedReadToken;
    dependencies.assertMutationAllowed(
      "Delete exact disposable Railway recovery project",
    );
    const [readWorkspace, deleteWorkspace, readView, deleteView] =
      await Promise.all([
        readWorkspaceInventory(
          dependencies.fetchImpl,
          readToken,
          args,
          dependencies.requestTimeoutMs,
        ),
        readWorkspaceInventory(
          dependencies.fetchImpl,
          deleteToken,
          args,
          dependencies.requestTimeoutMs,
        ),
        providerCall(
          dependencies.fetchImpl,
          readToken,
          DISPOSABLE_RESTORE_INVENTORY_QUERY,
          { projectId: args.projectId },
          dependencies.requestTimeoutMs,
        ),
        providerCall(
          dependencies.fetchImpl,
          deleteToken,
          DISPOSABLE_RESTORE_INVENTORY_QUERY,
          { projectId: args.projectId },
          dependencies.requestTimeoutMs,
        ),
      ]);
    const before = normalizedInventory(readView, args);
    const deleteBefore = normalizedInventory(deleteView, args);
    if (before === "invalid" || deleteBefore === "invalid")
      fail("inventory_invalid");
    state.metadataAuthoritiesAgree =
      canonicalInventory(before) === canonicalInventory(deleteBefore);
    state.workspaceAuthoritiesExact =
      canonicalPostgresBackupJson(readWorkspace) ===
      canonicalPostgresBackupJson(deleteWorkspace);
    if (!state.metadataAuthoritiesAgree || !state.workspaceAuthoritiesExact) {
      fail("inventory_invalid");
    }
    const signedWorkspaceProjects = authority.workspaceProjects;
    const expectedCurrentWorkspaceProjects =
      before === null
        ? signedWorkspaceProjects.filter(
            (project) => project.id !== args.projectId,
          )
        : signedWorkspaceProjects;
    preflightWorkspaceProjectInventorySha256 = hash(
      canonicalPostgresBackupJson(readWorkspace.projects),
    );
    state.signedWorkspaceInventoryExact =
      hash(canonicalPostgresBackupJson(signedWorkspaceProjects)) ===
        args.workspaceProjectInventorySha256 &&
      signedWorkspaceProjects.filter((project) => project.id === args.projectId)
        .length === 1 &&
      signedWorkspaceProjects.some(
        (project) =>
          project.id === args.projectId && project.name === args.projectName,
      );
    state.completeWorkspaceInventoryExact =
      canonicalPostgresBackupJson(readWorkspace.projects) ===
      canonicalPostgresBackupJson(expectedCurrentWorkspaceProjects);
    if (before === null) {
      state.completeInventoryExact = true;
      state.signedServiceInventoryExact = true;
      preflightInventorySha256 = hash(canonicalInventory(null));
    } else {
      preflightInventorySha256 = hash(canonicalInventory(before));
      state.completeInventoryExact =
        preflightInventorySha256 === args.inventorySha256;
      state.signedServiceInventoryExact = signedServiceInventoryExact(
        before,
        authority,
      );
    }
    if (
      !state.completeInventoryExact ||
      !state.signedServiceInventoryExact ||
      !state.signedWorkspaceInventoryExact ||
      !state.completeWorkspaceInventoryExact
    ) {
      fail("inventory_invalid");
    }
    const intent = {
      schemaVersion: "pintpath-production-recovery-railway-teardown-intent/v2",
      candidateSha: args.candidateSha,
      projectId: args.projectId,
      signedActivationRunId,
      observedCleanupRunId: dependencies.env.GITHUB_RUN_ID!,
      cleanupWorkflowPath: observedWorkflowPath,
      projectName: args.projectName,
      environmentId: args.environmentId,
      environmentName: args.environmentName,
      inventorySha256: args.inventorySha256,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      workspaceProjectInventorySha256: args.workspaceProjectInventorySha256,
      emergencyCleanupArmAuthoritySha256:
        args.emergencyCleanupArmAuthoritySha256,
      teardownAuthoritySha256: args.teardownAuthoritySha256,
      preflightInventorySha256,
      preflightWorkspaceProjectInventorySha256,
      targetPresentBefore: before !== null,
      operation: "delete-exact-disposable-railway-recovery-project",
      maximumDeleteAttempts: 1,
      retryAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
    const intentSource = canonicalPostgresBackupJson(intent);
    evidenceDirectory.assertExact();
    writePrivateExclusiveFile(
      args.evidenceDir,
      "railway-delete-intent.json",
      intentSource,
      {
        requireExactDirectoryMode: true,
        requireOwner: true,
      },
    );
    evidenceDirectory.assertExact();
    intentSha256 = hash(intentSource);
    state.durableIntentExact = true;
    if (before === null) {
      state.postflightAttempted = true;
      try {
        const [
          readWorkspaceAfter,
          deleteWorkspaceAfter,
          readAfterView,
          deleteAfterView,
        ] = await Promise.all([
          readWorkspaceInventory(
            dependencies.fetchImpl,
            readToken,
            args,
            dependencies.requestTimeoutMs,
          ),
          readWorkspaceInventory(
            dependencies.fetchImpl,
            deleteToken,
            args,
            dependencies.requestTimeoutMs,
          ),
          providerCall(
            dependencies.fetchImpl,
            readToken,
            DISPOSABLE_RESTORE_INVENTORY_QUERY,
            { projectId: args.projectId },
            dependencies.requestTimeoutMs,
          ),
          providerCall(
            dependencies.fetchImpl,
            deleteToken,
            DISPOSABLE_RESTORE_INVENTORY_QUERY,
            { projectId: args.projectId },
            dependencies.requestTimeoutMs,
          ),
        ]);
        const readAfter = normalizedInventory(readAfterView, args);
        const deleteAfter = normalizedInventory(deleteAfterView, args);
        const workspaceAfterExact =
          canonicalPostgresBackupJson(readWorkspaceAfter) ===
            canonicalPostgresBackupJson(deleteWorkspaceAfter) &&
          canonicalPostgresBackupJson(readWorkspaceAfter.projects) ===
            canonicalPostgresBackupJson(expectedCurrentWorkspaceProjects);
        state.targetAbsentExact =
          readAfter === null && deleteAfter === null && workspaceAfterExact;
        postflightInventorySha256 =
          readAfter === "invalid" ? null : hash(canonicalInventory(readAfter));
        postflightWorkspaceProjectInventorySha256 = hash(
          canonicalPostgresBackupJson(readWorkspaceAfter.projects),
        );
      } catch {
        state.targetAbsentExact = false;
      }
      const priorAcknowledgement = emergencyState
        ? priorAcknowledgementFor(emergencyState, "railway")
        : null;
      state.acknowledgementExact = priorAcknowledgement !== null;
      outcome = state.targetAbsentExact
        ? priorAcknowledgement
          ? "reconciled_from_prior_ack"
          : "already_absent"
        : "failed_before_attempt";
    } else {
      const [
        readWorkspaceReasserted,
        deleteWorkspaceReasserted,
        reassertedView,
      ] = await Promise.all([
        readWorkspaceInventory(
          dependencies.fetchImpl,
          readToken,
          args,
          dependencies.requestTimeoutMs,
        ),
        readWorkspaceInventory(
          dependencies.fetchImpl,
          deleteToken,
          args,
          dependencies.requestTimeoutMs,
        ),
        providerCall(
          dependencies.fetchImpl,
          readToken,
          DISPOSABLE_RESTORE_INVENTORY_QUERY,
          { projectId: args.projectId },
          dependencies.requestTimeoutMs,
        ),
      ]);
      const reasserted = normalizedInventory(reassertedView, args);
      if (
        reasserted === "invalid" ||
        reasserted === null ||
        canonicalInventory(reasserted) !== canonicalInventory(before) ||
        canonicalPostgresBackupJson(readWorkspaceReasserted) !==
          canonicalPostgresBackupJson(readWorkspace) ||
        canonicalPostgresBackupJson(deleteWorkspaceReasserted) !==
          canonicalPostgresBackupJson(deleteWorkspace)
      ) {
        fail("concurrent_inventory_change");
      }
      evidenceDirectory.assertExact();
      attempts = 1;
      try {
        const acknowledgement = await providerCall(
          dependencies.fetchImpl,
          deleteToken,
          DISPOSABLE_RESTORE_DELETE_MUTATION,
          { projectId: args.projectId },
          dependencies.requestTimeoutMs,
        );
        state.acknowledgementExact =
          record(acknowledgement) &&
          exactKeys(acknowledgement, ["data"]) &&
          record(acknowledgement.data) &&
          exactKeys(acknowledgement.data, ["projectDelete"]) &&
          acknowledgement.data.projectDelete === true;
      } catch {
        state.acknowledgementExact = false;
      }
      state.postflightAttempted = true;
      try {
        const [
          readWorkspaceAfter,
          deleteWorkspaceAfter,
          afterView,
          deleteAfterView,
        ] = await Promise.all([
          readWorkspaceInventory(
            dependencies.fetchImpl,
            readToken,
            args,
            dependencies.requestTimeoutMs,
          ),
          readWorkspaceInventory(
            dependencies.fetchImpl,
            deleteToken,
            args,
            dependencies.requestTimeoutMs,
          ),
          providerCall(
            dependencies.fetchImpl,
            readToken,
            DISPOSABLE_RESTORE_INVENTORY_QUERY,
            { projectId: args.projectId },
            dependencies.requestTimeoutMs,
          ),
          providerCall(
            dependencies.fetchImpl,
            deleteToken,
            DISPOSABLE_RESTORE_INVENTORY_QUERY,
            { projectId: args.projectId },
            dependencies.requestTimeoutMs,
          ),
        ]);
        const after = normalizedInventory(afterView, args);
        const deleteAfter = normalizedInventory(deleteAfterView, args);
        const expectedAfterProjects = signedWorkspaceProjects.filter(
          (project) => project.id !== args.projectId,
        );
        const workspaceAfterExact =
          canonicalPostgresBackupJson(readWorkspaceAfter) ===
            canonicalPostgresBackupJson(deleteWorkspaceAfter) &&
          canonicalPostgresBackupJson(readWorkspaceAfter.projects) ===
            canonicalPostgresBackupJson(expectedAfterProjects);
        state.targetAbsentExact =
          after === null && deleteAfter === null && workspaceAfterExact;
        postflightInventorySha256 =
          after === "invalid" ? null : hash(canonicalInventory(after));
        postflightWorkspaceProjectInventorySha256 = hash(
          canonicalPostgresBackupJson(readWorkspaceAfter.projects),
        );
      } catch {
        state.targetAbsentExact = false;
      }
      outcome =
        state.targetAbsentExact && state.acknowledgementExact
          ? "deleted"
          : "mutation_uncertain";
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  }
  const now = dependencies.now();
  const completedAt = Number.isFinite(now.getTime())
    ? now.toISOString()
    : "1970-01-01T00:00:00.000Z";
  let terminalWritten = false;
  let evidenceDirectoryClosed = false;
  try {
    evidenceDirectory?.assertExact();
    evidenceDirectory?.close();
    evidenceDirectory = null;
    evidenceDirectoryClosed = true;
  } catch {
    state.terminalEvidenceExact = false;
    if (attempts === 1) outcome = "mutation_uncertain";
  }
  if (outputReady && evidenceDirectoryClosed && evidenceDirectoryIdentity) {
    try {
      state.terminalEvidenceExact = true;
      const provisional = receipt({
        args,
        outcome,
        attempts,
        reviewerIdSha256,
        observedCleanupRunId: dependencies.env.GITHUB_RUN_ID ?? null,
        signedActivationRunId,
        cleanupWorkflowPath: observedWorkflowPath,
        intentSha256,
        preflightInventorySha256,
        postflightInventorySha256,
        preflightWorkspaceProjectInventorySha256,
        postflightWorkspaceProjectInventorySha256,
        completedAt,
        checks: state,
      });
      writePrivateExclusiveFile(
        args.evidenceDir,
        path.basename(args.output),
        canonicalPostgresBackupJson({
          schemaVersion: PRODUCTION_RECOVERY_RAILWAY_TEARDOWN_TERMINAL_SCHEMA,
          receipt: provisional,
        }),
        {
          requireExactDirectoryMode: true,
          requireOwner: true,
          expectedDirectoryIdentity: evidenceDirectoryIdentity,
        },
      );
      terminalWritten = true;
    } catch {
      terminalWritten = false;
      state.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  const finalReceipt = receipt({
    args,
    outcome,
    attempts,
    reviewerIdSha256,
    observedCleanupRunId: dependencies.env.GITHUB_RUN_ID ?? null,
    signedActivationRunId,
    cleanupWorkflowPath: observedWorkflowPath,
    intentSha256,
    preflightInventorySha256,
    postflightInventorySha256,
    preflightWorkspaceProjectInventorySha256,
    postflightWorkspaceProjectInventorySha256,
    completedAt,
    checks: state,
  });
  dependencies.writeOutput(
    canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: finalReceipt.ok && terminalWritten,
      outcome,
      receiptSha256: finalReceipt.receiptSha256,
    }),
  );
  return finalReceipt.ok && terminalWritten ? 0 : 1;
}

export const productionRecoveryRailwayTeardownInternals = {
  parseArgs,
  policyExact,
  verifyAuthority,
  signedServiceInventoryExact,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProductionRecoveryRailwayTeardown();
}
