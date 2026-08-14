import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from "./check-railway-mutation-boundary.js";
import {
  parseCanaryDirectDeploymentResponse,
  parseCanaryUploadAcknowledgement,
  parseCanonicalBuildOnlyReceipt,
} from "./lib/staging-postgres-build-canary-railway-contract.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const PROTECTED_STAGING_POSTGRES_BUILD_CANARY_SCHEMA =
  "pintpath-protected-staging-postgres-build-canary/v1" as const;
export const PROTECTED_STAGING_POSTGRES_BUILD_CANARY_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "bb84fecc-a125-49ce-853f-d2f25f7019c5";
const SERVICE_INSTANCE_ID = "716b4818-7695-4b9f-b5f9-35249e785a58";
const SERVICE_NAME = "postgres-backup-canary-2d276b6";
const START_COMMAND = "node dist/scripts/staging-postgres-backup-canary.js";
const CONFIG_PATH = "railway.postgres-backup-canary.toml";
const CONFIG_SHA256 =
  "b55463ba68f0f03661b62ad300c8569550505d7394b76d4f1f9cce60ebd20d3c";
const CLI_SHA256 =
  "27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43";
const POLICY_PATH =
  "ops/railway/protected-staging-postgres-build-canary-policy.json";
const POLICY_SHA256 =
  "48b77a6d52cba992db11521333f12d1acfbc7ac728b8dc0b570f1e29ea2ee136";
const BOUNDARY_POLICY = "ops/railway/production-staging-mutation-policy.json";
const GRAPHQL = "https://backboard.railway.com/graphql/v2";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const EXPECTED_VARIABLES = [
  "RAILPACK_PACKAGES",
  "STAGING_POSTGRES_CA_CANARY_MODE",
  "STAGING_POSTGRES_CA_CANARY_RAILWAY_CONFIG_PATH",
] as const;

export const PROTECTED_STAGING_POSTGRES_BUILD_CANARY_SCOPE = `query PintPathProtectedStagingPostgresBuildCanaryScope { projectToken { projectId environmentId } }`;
export const PROTECTED_STAGING_POSTGRES_BUILD_CANARY_TARGET = `query PintPathProtectedStagingPostgresBuildCanaryTarget($projectId:String!,$environmentId:String!,$serviceId:String!){
  environment(id:$environmentId,projectId:$projectId){
    id
    variables(first:100){edges{node{id name environmentId serviceId isSealed references}}pageInfo{hasNextPage endCursor}}
    volumeInstances(first:100){edges{node{serviceId environmentId volume{id}}}pageInfo{hasNextPage endCursor}}
  }
  staged:environmentStagedChanges(environmentId:$environmentId){environmentId patch(decryptVariables:false)}
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId){
    id serviceId serviceName environmentId numReplicas source{repo image}
    domains{serviceDomains{id domain targetPort}customDomains{id domain targetPort}}
    cronSchedule startCommand latestDeployment{id status deploymentStopped snapshotId}
    activeDeployments{id status deploymentStopped}
  }
  tcpProxies(serviceId:$serviceId,environmentId:$environmentId){id}
}`;
export const PROTECTED_STAGING_POSTGRES_BUILD_CANARY_DEPLOYMENT = `query PintPathProtectedStagingPostgresBuildCanaryDeployment($deploymentId:String!){deployment(id:$deploymentId){id projectId environmentId serviceId status deploymentStopped snapshotId meta}}`;
export const PROTECTED_STAGING_POSTGRES_BUILD_CANARY_LOGS = `query PintPathProtectedStagingPostgresBuildCanaryLogs($deploymentId:String!){deploymentLogs(deploymentId:$deploymentId,limit:100){timestamp message attributes{key value}}}`;

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}
interface SourceSnapshot {
  readonly directory: string;
  readonly archiveSha256: string;
  readonly treeSha: string;
  readonly cleanup: () => boolean;
}
interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly runCommand: (
    executable: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Readonly<Record<string, string>>;
      timeoutMs: number;
    },
  ) => Promise<CommandResult>;
  readonly validateCli: (filename: string) => boolean;
  readonly createSnapshot: (
    cwd: string,
    candidateSha: string,
  ) => SourceSnapshot;
  readonly runBoundary: () => Promise<boolean>;
  readonly writeOutput: (source: string) => void;
}
interface TargetSnapshot {
  readonly deploymentId: string | null;
  readonly deploymentStatus: string | null;
  readonly deploymentStopped: boolean | null;
  readonly snapshotId: string | null;
  readonly collateral: string;
}
interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  cliExact: boolean;
  tokenScopesExact: boolean;
  sourceExact: boolean;
  boundaryPreflightExact: boolean;
  targetPreflightExact: boolean;
  durableIntentExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  deploymentExact: boolean;
  buildReceiptExact: boolean;
  collateralUnchanged: boolean;
  boundaryPostflightExact: boolean;
  cleanupExact: boolean;
  terminalEvidenceExact: boolean;
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
    names.every((name) => Object.hasOwn(value, name))
  );
}
function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function checks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    cliExact: false,
    tokenScopesExact: false,
    sourceExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    durableIntentExact: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    deploymentExact: false,
    buildReceiptExact: false,
    collateralUnchanged: false,
    boundaryPostflightExact: false,
    cleanupExact: false,
    terminalEvidenceExact: false,
  };
}

function parseArgs(
  argv: readonly string[],
): { candidateSha: string; evidenceDir: string } | null {
  if (argv.length !== 4) return null;
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i],
      value = argv[i + 1];
    if (!flag?.startsWith("--") || !value || map.has(flag)) return null;
    map.set(flag, value);
  }
  const candidateSha = map.get("--candidate-sha") ?? "",
    evidenceDir = map.get("--evidence-dir") ?? "";
  return SHA_PATTERN.test(candidateSha) && path.isAbsolute(evidenceDir)
    ? { candidateSha, evidenceDir }
    : null;
}

function readPolicy(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    if (sha256(source) !== POLICY_SHA256) return false;
    const value = JSON.parse(source.toString("utf8")) as Record<
      string,
      unknown
    >;
    return (
      value.schemaVersion ===
        "pintpath-protected-staging-postgres-build-canary-policy/v1" &&
      value.activationState === PROTECTED_STAGING_POSTGRES_BUILD_CANARY_STATE &&
      value.projectId === PROJECT_ID &&
      value.environmentId === ENVIRONMENT_ID &&
      value.serviceId === SERVICE_ID &&
      value.serviceInstanceId === SERVICE_INSTANCE_ID &&
      value.railwayConfigSha256 === CONFIG_SHA256
    );
  } catch {
    return false;
  }
}

function privateEvidence(
  directory: string,
  leaf: string,
  source: string,
): string {
  try {
    writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  } catch {
    throw new Error("evidence_invalid");
  }
  return sha256(source);
}

function validateCli(filename: string): boolean {
  let bytes: Buffer | null = null;
  try {
    bytes = readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 128 * 1024 * 1024,
      requireExecutable: true,
    });
    return sha256(bytes) === CLI_SHA256;
  } catch {
    return false;
  } finally {
    bytes?.fill(0);
  }
}

function command(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Readonly<Record<string, string>>;
    timeoutMs: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      timedOut = false,
      settled = false;
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = () => {
      if (typeof child.pid === "number")
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* done */
          }
        }
    };
    const add = (current: string, chunk: Buffer) =>
      Buffer.byteLength(current) + chunk.length <= 2 * 1024 * 1024
        ? current + chunk.toString("utf8")
        : current;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = add(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = add(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", () => done(null));
    child.on("close", done);
  });
}

function sourceSnapshot(cwd: string, candidateSha: string): SourceSnapshot {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  const tree = spawnSync("git", ["rev-parse", `${candidateSha}^{tree}`], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (
    head.status !== 0 ||
    head.stdout.trim() !== candidateSha ||
    tree.status !== 0 ||
    !SHA_PATTERN.test(tree.stdout.trim())
  )
    throw new Error("source_invalid");
  const archive = spawnSync("git", ["archive", "--format=tar", candidateSha], {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  if (
    archive.status !== 0 ||
    !Buffer.isBuffer(archive.stdout) ||
    archive.stdout.length < 1024
  )
    throw new Error("source_invalid");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-pg-build-canary-"),
  );
  fs.chmodSync(directory, 0o700);
  const digest = sha256(archive.stdout);
  const extraction = spawnSync(
    "tar",
    ["--extract", "--file", "-", "--directory", directory],
    { input: archive.stdout, encoding: "buffer", timeout: 30_000 },
  );
  archive.stdout.fill(0);
  if (
    extraction.status !== 0 ||
    sha256(fs.readFileSync(path.join(directory, CONFIG_PATH))) !== CONFIG_SHA256
  ) {
    fs.rmSync(directory, { recursive: true });
    throw new Error("source_invalid");
  }
  return {
    directory,
    archiveSha256: digest,
    treeSha: tree.stdout.trim(),
    cleanup: () => {
      try {
        const stat = fs.lstatSync(directory);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          !path.basename(directory).startsWith("pintpath-pg-build-canary-")
        )
          return false;
        fs.rmSync(directory, { recursive: true });
        return !fs.existsSync(directory);
      } catch {
        return false;
      }
    },
  };
}

async function query(
  fetchImpl: typeof fetch,
  token: string,
  operationName: string,
  querySource: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(GRAPHQL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operationName, query: querySource, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await response.text();
  if (!response.ok || Buffer.byteLength(source) > 1024 * 1024)
    throw new Error("provider_invalid");
  return JSON.parse(source) as unknown;
}

function scope(value: unknown): boolean {
  return (
    exact(value, ["data"]) &&
    exact(value.data, ["projectToken"]) &&
    exact(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === PROJECT_ID &&
    value.data.projectToken.environmentId === ENVIRONMENT_ID
  );
}
function deployment(value: unknown): {
  id: string;
  status: string;
  deploymentStopped: boolean;
  snapshotId: string | null;
} | null {
  if (value === null) return null;
  if (
    !exact(value, ["id", "status", "deploymentStopped", "snapshotId"]) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.status !== "string" ||
    typeof value.deploymentStopped !== "boolean" ||
    !(
      value.snapshotId === null ||
      (typeof value.snapshotId === "string" &&
        UUID_PATTERN.test(value.snapshotId))
    )
  )
    return null;
  return {
    id: value.id,
    status: value.status,
    deploymentStopped: value.deploymentStopped,
    snapshotId: value.snapshotId as string | null,
  };
}
function target(value: unknown): TargetSnapshot | null {
  if (
    !exact(value, ["data"]) ||
    !exact(value.data, [
      "environment",
      "staged",
      "serviceInstance",
      "tcpProxies",
    ])
  )
    return null;
  const env = value.data.environment,
    staged = value.data.staged,
    service = value.data.serviceInstance;
  if (
    !exact(env, ["id", "variables", "volumeInstances"]) ||
    env.id !== ENVIRONMENT_ID ||
    !exact(staged, ["environmentId", "patch"]) ||
    staged.environmentId !== ENVIRONMENT_ID ||
    !record(staged.patch) ||
    Object.keys(staged.patch).length !== 0 ||
    !exact(service, [
      "id",
      "serviceId",
      "serviceName",
      "environmentId",
      "numReplicas",
      "source",
      "domains",
      "cronSchedule",
      "startCommand",
      "latestDeployment",
      "activeDeployments",
    ]) ||
    service.id !== SERVICE_INSTANCE_ID ||
    service.serviceId !== SERVICE_ID ||
    service.serviceName !== SERVICE_NAME ||
    service.environmentId !== ENVIRONMENT_ID ||
    service.numReplicas !== 1 ||
    !(
      service.source === null ||
      (exact(service.source, ["repo", "image"]) &&
        service.source.repo === null &&
        service.source.image === null)
    ) ||
    service.cronSchedule !== null ||
    service.startCommand !== START_COMMAND ||
    !Array.isArray(service.activeDeployments) ||
    service.activeDeployments.length !== 0 ||
    !exact(service.domains, ["serviceDomains", "customDomains"]) ||
    !Array.isArray(service.domains.serviceDomains) ||
    service.domains.serviceDomains.length !== 0 ||
    !Array.isArray(service.domains.customDomains) ||
    service.domains.customDomains.length !== 0 ||
    !Array.isArray(value.data.tcpProxies) ||
    value.data.tcpProxies.length !== 0
  )
    return null;
  const variablesCollection = env.variables,
    volumeCollection = env.volumeInstances;
  for (const collection of [variablesCollection, volumeCollection])
    if (
      !exact(collection, ["edges", "pageInfo"]) ||
      !Array.isArray(collection.edges) ||
      collection.edges.length > 100 ||
      !exact(collection.pageInfo, ["hasNextPage", "endCursor"]) ||
      collection.pageInfo.hasNextPage !== false
    )
      return null;
  if (
    !exact(variablesCollection, ["edges", "pageInfo"]) ||
    !Array.isArray(variablesCollection.edges) ||
    !exact(volumeCollection, ["edges", "pageInfo"]) ||
    !Array.isArray(volumeCollection.edges)
  )
    return null;
  const variables: string[] = [];
  for (const edge of variablesCollection.edges) {
    if (
      !exact(edge, ["node"]) ||
      !exact(edge.node, [
        "id",
        "name",
        "environmentId",
        "serviceId",
        "isSealed",
        "references",
      ]) ||
      edge.node.environmentId !== ENVIRONMENT_ID ||
      typeof edge.node.name !== "string" ||
      !Array.isArray(edge.node.references)
    )
      return null;
    if (
      EXPECTED_VARIABLES.includes(
        edge.node.name as (typeof EXPECTED_VARIABLES)[number],
      ) &&
      edge.node.serviceId !== SERVICE_ID
    )
      return null;
    if (edge.node.serviceId === SERVICE_ID) {
      if (edge.node.references.length !== 0 || edge.node.isSealed !== false)
        return null;
      variables.push(edge.node.name);
    }
  }
  variables.sort();
  if (
    JSON.stringify(variables) !== JSON.stringify([...EXPECTED_VARIABLES].sort())
  )
    return null;
  for (const edge of volumeCollection.edges) {
    if (
      !exact(edge, ["node"]) ||
      !exact(edge.node, ["serviceId", "environmentId", "volume"]) ||
      edge.node.environmentId !== ENVIRONMENT_ID ||
      !exact(edge.node.volume, ["id"]) ||
      edge.node.serviceId === SERVICE_ID
    )
      return null;
  }
  const latest = deployment(service.latestDeployment);
  if (
    service.latestDeployment !== null &&
    (!latest || latest.deploymentStopped !== true)
  )
    return null;
  const collateral = canonical({
    variables: variablesCollection.edges,
    volumes: volumeCollection.edges,
    service: { ...service, latestDeployment: null },
  });
  return {
    deploymentId: latest?.id ?? null,
    deploymentStatus: latest?.status ?? null,
    deploymentStopped: latest?.deploymentStopped ?? null,
    snapshotId: latest?.snapshotId ?? null,
    collateral,
  };
}

async function getTarget(
  fetchImpl: typeof fetch,
  token: string,
): Promise<TargetSnapshot | null> {
  return target(
    await query(
      fetchImpl,
      token,
      "PintPathProtectedStagingPostgresBuildCanaryTarget",
      PROTECTED_STAGING_POSTGRES_BUILD_CANARY_TARGET,
      {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
      },
    ),
  );
}

function buildReceipt(value: unknown, deploymentId: string): boolean {
  if (
    !exact(value, ["data"]) ||
    !exact(value.data, ["deploymentLogs"]) ||
    !Array.isArray(value.data.deploymentLogs) ||
    value.data.deploymentLogs.length > 100
  )
    return false;
  let matches = 0;
  for (const log of value.data.deploymentLogs) {
    if (
      !exact(log, ["timestamp", "message", "attributes"]) ||
      typeof log.message !== "string" ||
      !Array.isArray(log.attributes)
    )
      return false;
    const source = log.message.endsWith("\n")
      ? log.message
      : `${log.message}\n`;
    if (parseCanonicalBuildOnlyReceipt(source, deploymentId)) matches += 1;
  }
  return matches === 1;
}

async function defaultBoundary(
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  let output = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", BOUNDARY_POLICY],
    env: {
      PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
        env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN,
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN:
        env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN,
    },
    writeOutput: (value) => {
      output += value;
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

function fixed(
  outcome: "passed" | "failed_before_attempt" | "mutation_uncertain",
  attempts: 0 | 1,
  candidateSha: string | null,
  deploymentId: string | null,
  intentSha: string | null,
  terminalSha: string | null,
  state: Checks,
) {
  return {
    schemaVersion: PROTECTED_STAGING_POSTGRES_BUILD_CANARY_SCHEMA,
    executorState: PROTECTED_STAGING_POSTGRES_BUILD_CANARY_STATE,
    outcome,
    attempts,
    retryAllowed: false as const,
    candidateSha,
    deploymentId,
    intentSha256: intentSha,
    terminalEvidenceSha256: terminalSha,
    checks: state,
  };
}

export async function runProtectedStagingPostgresBuildCanary(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    runCommand: command,
    validateCli,
    createSnapshot: sourceSnapshot,
    runBoundary: () => defaultBoundary(process.env),
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArgs(dependencies.argv),
    state = checks();
  let attempts: 0 | 1 = 0,
    outcome: "passed" | "failed_before_attempt" | "mutation_uncertain" =
      "failed_before_attempt",
    deploymentId: string | null = null,
    intentSha: string | null = null,
    terminalSha: string | null = null,
    snapshot: SourceSnapshot | null = null,
    metadataToken = "";
  try {
    state.policyExact = readPolicy(dependencies.cwd);
    state.githubAuthorityExact =
      args !== null &&
      dependencies.env.GITHUB_REF === "refs/heads/main" &&
      dependencies.env.GITHUB_SHA === args.candidateSha &&
      dependencies.env.GITHUB_RUN_ATTEMPT === "1" &&
      dependencies.env.PINTPATH_POSTGRES_BUILD_CANARY_CONFIRMATION ===
        "RUN_PERMANENT_STAGING_POSTGRES_BUILD_CANARY";
    if (!args || !state.policyExact || !state.githubAuthorityExact)
      throw new Error("authority_invalid");
    const cli = dependencies.env.PINTPATH_RAILWAY_CLI_PATH ?? "",
      metadata = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "",
      writeToken =
        dependencies.env
          .PINTPATH_RAILWAY_STAGING_POSTGRES_CANARY_DEPLOY_TOKEN ?? "";
    metadataToken = metadata;
    state.cliExact = dependencies.validateCli(cli);
    if (
      !state.cliExact ||
      !TOKEN_PATTERN.test(metadata) ||
      !TOKEN_PATTERN.test(writeToken) ||
      metadata === writeToken
    )
      throw new Error("credentials_invalid");
    const [metadataScope, writeScope] = await Promise.all([
      query(
        dependencies.fetchImpl,
        metadata,
        "PintPathProtectedStagingPostgresBuildCanaryScope",
        PROTECTED_STAGING_POSTGRES_BUILD_CANARY_SCOPE,
        {},
      ),
      query(
        dependencies.fetchImpl,
        writeToken,
        "PintPathProtectedStagingPostgresBuildCanaryScope",
        PROTECTED_STAGING_POSTGRES_BUILD_CANARY_SCOPE,
        {},
      ),
    ]);
    state.tokenScopesExact = scope(metadataScope) && scope(writeScope);
    snapshot = dependencies.createSnapshot(dependencies.cwd, args.candidateSha);
    state.sourceExact =
      SHA256_PATTERN.test(snapshot.archiveSha256) &&
      SHA_PATTERN.test(snapshot.treeSha) &&
      sha256(fs.readFileSync(path.join(snapshot.directory, CONFIG_PATH))) ===
        CONFIG_SHA256;
    state.boundaryPreflightExact = await dependencies.runBoundary();
    const before = await getTarget(dependencies.fetchImpl, metadata);
    state.targetPreflightExact = before !== null;
    if (
      !state.tokenScopesExact ||
      !state.sourceExact ||
      !state.boundaryPreflightExact ||
      !before
    )
      throw new Error("preflight_invalid");
    const intent = canonical({
      schemaVersion:
        "pintpath-protected-staging-postgres-build-canary-intent/v1",
      candidateSha: args.candidateSha,
      treeSha: snapshot.treeSha,
      sourceArchiveSha256: snapshot.archiveSha256,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      operation: "single-source-upload",
      maximumAttempts: 1,
      retryAllowed: false,
      createdAtEpochMs: dependencies.now(),
    });
    intentSha = privateEvidence(args.evidenceDir, "intent.json", intent);
    state.durableIntentExact = intentSha === sha256(intent);
    if (!state.durableIntentExact) throw new Error("intent_invalid");
    attempts = 1;
    const result = await dependencies.runCommand(
      cli,
      [
        "up",
        snapshot.directory,
        "--path-as-root",
        "--no-gitignore",
        "--detach",
        "--json",
        "--project",
        PROJECT_ID,
        "--environment",
        ENVIRONMENT_ID,
        "--service",
        SERVICE_ID,
        "--message",
        `pintpath:postgres-build-canary:${args.candidateSha}:${intentSha}`,
      ],
      {
        cwd: snapshot.directory,
        timeoutMs: 120_000,
        env: { CI: "true", NO_COLOR: "1", RAILWAY_TOKEN: writeToken },
      },
    );
    const ack =
      result.code === 0 && !result.timedOut
        ? parseCanaryUploadAcknowledgement(result.stdout)
        : null;
    state.acknowledgementExact = ack !== null;
    deploymentId = ack?.deploymentId ?? null;
    state.postflightAttempted = true;
    const deadline = dependencies.now() + 900_000;
    let after: TargetSnapshot | null = null;
    do {
      after = await getTarget(dependencies.fetchImpl, metadata);
      const observed =
        deploymentId ??
        (after?.deploymentId !== before.deploymentId
          ? (after?.deploymentId ?? null)
          : null);
      if (observed) {
        deploymentId = observed;
        const direct = await query(
          dependencies.fetchImpl,
          metadata,
          "PintPathProtectedStagingPostgresBuildCanaryDeployment",
          PROTECTED_STAGING_POSTGRES_BUILD_CANARY_DEPLOYMENT,
          { deploymentId: observed },
        );
        const parsed = parseCanaryDirectDeploymentResponse(
          canonical(direct),
          observed,
        );
        if (
          parsed?.status === "SUCCESS" &&
          parsed.deploymentStopped &&
          parsed.snapshotId &&
          parsed.imageDigest
        ) {
          const meta = (
            direct as {
              data?: { deployment?: { meta?: Record<string, unknown> } };
            }
          ).data?.deployment?.meta;
          state.deploymentExact = meta?.commitHash === args.candidateSha;
          const logs = await query(
            dependencies.fetchImpl,
            metadata,
            "PintPathProtectedStagingPostgresBuildCanaryLogs",
            PROTECTED_STAGING_POSTGRES_BUILD_CANARY_LOGS,
            { deploymentId: observed },
          );
          state.buildReceiptExact = buildReceipt(logs, observed);
          if (state.deploymentExact && state.buildReceiptExact) break;
        }
        if (parsed && ["FAILED", "CRASHED", "REMOVED"].includes(parsed.status))
          break;
      }
      if (dependencies.now() >= deadline) break;
      await dependencies.sleep(10_000);
    } while (true);
    state.collateralUnchanged =
      after !== null && after.collateral === before.collateral;
    state.boundaryPostflightExact = await dependencies.runBoundary();
    outcome =
      state.acknowledgementExact &&
      state.deploymentExact &&
      state.buildReceiptExact &&
      state.collateralUnchanged &&
      state.boundaryPostflightExact
        ? "passed"
        : "mutation_uncertain";
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    if (attempts === 1 && !state.postflightAttempted) {
      state.postflightAttempted = true;
      try {
        await getTarget(dependencies.fetchImpl, metadataToken);
      } catch {
        /* terminal outcome remains uncertain */
      }
    }
    if (attempts === 1 && !state.boundaryPostflightExact)
      try {
        state.boundaryPostflightExact = await dependencies.runBoundary();
      } catch {
        state.boundaryPostflightExact = false;
      }
    state.cleanupExact = snapshot?.cleanup() ?? true;
    state.writeAttemptedAtMostOnce = attempts <= 1;
    if (!state.cleanupExact && attempts === 1) outcome = "mutation_uncertain";
  }
  const provisional = fixed(
    outcome,
    attempts,
    args?.candidateSha ?? null,
    deploymentId,
    intentSha,
    null,
    state,
  );
  if (args && state.durableIntentExact)
    try {
      const terminal = canonical({
        schemaVersion:
          "pintpath-protected-staging-postgres-build-canary-terminal/v1",
        receipt: provisional,
      });
      terminalSha = privateEvidence(
        args.evidenceDir,
        "terminal.json",
        terminal,
      );
      state.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      state.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  const receipt = fixed(
    outcome,
    attempts,
    args?.candidateSha ?? null,
    deploymentId,
    intentSha,
    terminalSha,
    state,
  );
  dependencies.writeOutput(`${JSON.stringify(receipt)}\n`);
  return outcome === "passed" && state.terminalEvidenceExact ? 0 : 1;
}

export const protectedStagingPostgresBuildCanaryInternals = {
  parseArgs,
  scope,
  target,
  buildReceipt,
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runProtectedStagingPostgresBuildCanary();
