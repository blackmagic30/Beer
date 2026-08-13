import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_CAPABILITY,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_DATA_FILES,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY_SHA256,
} from "../src/lib/postgres-tool-runtime-closure-v4.js";
import {
  fetchPostgresToolRuntimeClosureV4RegistryResponse,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REGISTRY,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REPOSITORY,
} from "../src/lib/postgres-tool-runtime-closure-v4-registry.js";

const REQUIRED_ENV = "PINTPATH_POSTGRES_TOOL_RUNTIME_CLOSURE_V4_TEST_REQUIRED";
const DOCKER_ENV = "PINTPATH_POSTGRES_TOOL_RUNTIME_CLOSURE_V4_TEST_DOCKER";
const EVIDENCE_ENV = "PINTPATH_POSTGRES_TOOL_RUNTIME_CLOSURE_V4_TEST_EVIDENCE_PATH";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";
const configuredDocker = process.env[DOCKER_ENV]?.trim() ?? "";
const configuredEvidencePath = process.env[EVIDENCE_ENV]?.trim() ?? "";
const enabled = configuredRequired === "true";
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LABEL_KEY = "au.pintpath.contract";
const LABEL_PREFIX = "postgres-tool-runtime-closure-v4-observation-";
const REGISTRY = POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REGISTRY;
const REPOSITORY = POSTGRES_TOOL_RUNTIME_CLOSURE_V4_REPOSITORY;
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";
const MAX_CHILD_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const MAX_LAYER_UNCOMPRESSED_BYTES = 512 * 1_024 * 1_024;

if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if ((configuredDocker || configuredEvidencePath) && !enabled) {
  throw new Error(`${REQUIRED_ENV} must be true when runtime observation inputs are set.`);
}
if (enabled && (!configuredDocker || !configuredEvidencePath)) {
  throw new Error(`${DOCKER_ENV} and ${EVIDENCE_ENV} are mandatory when ${REQUIRED_ENV}=true.`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name] ?? "";
  if (!value || value.trim() !== value || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is unsafe.`);
  }
  return value;
}

function exactExecutable(value: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value
    || path.resolve(value) !== value || fs.realpathSync.native(value) !== value) {
    throw new Error("runtime_observation_executable_unsafe");
  }
  const status = fs.statSync(value);
  if (!status.isFile() || (status.mode & 0o022) !== 0) {
    throw new Error("runtime_observation_executable_unsafe");
  }
  return value;
}

function resolvedHostExecutable(value: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value
    || path.resolve(value) !== value) {
    throw new Error("runtime_observation_executable_unsafe");
  }
  const resolved = fs.realpathSync.native(value);
  if (!path.isAbsolute(resolved) || path.normalize(resolved) !== resolved
    || path.resolve(resolved) !== resolved) {
    throw new Error("runtime_observation_executable_unsafe");
  }
  const status = fs.statSync(resolved);
  if (!status.isFile() || (status.mode & 0o022) !== 0) {
    throw new Error("runtime_observation_executable_unsafe");
  }
  return resolved;
}

const DOCKER = enabled ? exactExecutable(configuredDocker) : "";
const RUNNER_TEMP = enabled ? fs.realpathSync.native(requiredEnvironment("RUNNER_TEMP")) : "";
const EVIDENCE_PATH = enabled ? configuredEvidencePath : "";
if (enabled) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("runtime_observation_requires_linux_amd64");
  }
  if (!path.isAbsolute(RUNNER_TEMP) || !fs.statSync(RUNNER_TEMP).isDirectory()
    || fs.lstatSync(RUNNER_TEMP).isSymbolicLink()) {
    throw new Error("runtime_observation_temp_unsafe");
  }
  if (EVIDENCE_PATH !== path.join(
    RUNNER_TEMP,
    "pintpath-postgres-tool-runtime-closure-v4-observation.json",
  ) || path.dirname(EVIDENCE_PATH) !== RUNNER_TEMP || fs.existsSync(EVIDENCE_PATH)
    || fs.lstatSync(path.dirname(EVIDENCE_PATH)).isSymbolicLink()) {
    throw new Error("runtime_observation_evidence_path_unsafe");
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function withoutAlgorithm(value: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error("runtime_observation_digest_unsafe");
  return value.slice("sha256:".length);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime_observation_json_invalid");
  }
  return value as Record<string, unknown>;
}

function json(bytes: Buffer): Record<string, unknown> {
  return record(JSON.parse(bytes.toString("utf8")) as unknown);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number"
    || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const valueRecord = record(value);
  return `{${Object.keys(valueRecord).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(valueRecord[key])}`).join(",")}}`;
}

function writeObservationEvidence(dockerServerVersion: string): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(dockerServerVersion)) {
    throw new Error("runtime_observation_docker_version_unsafe");
  }
  const observation = {
    schemaVersion: 1,
    kind: "pintpath-postgres-tool-runtime-closure-v4-observation",
    classification: "UNVERIFIED_CI_OBSERVATION_ONLY",
    observedAt: new Date().toISOString(),
    policySha256: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_POLICY_SHA256,
    dockerServerVersion,
    platform: "linux/amd64",
    imageIndexDigest: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.indexDigest,
    platformManifestDigest: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest,
    configDigest: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configDigest,
    attestationManifestDigest:
      POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.attestationManifestDigest,
    layerCount: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.length,
    runtimeFileCount: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.length,
    runtimeSymlinkCount: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.filter(
      ({ nodeKind }) => nodeKind === "symlink",
    ).length,
    dataFileCount: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_DATA_FILES.length,
    registryBytesHashed: true,
    compressedLayersAndDiffIdsHashed: true,
    attestationSubjectsMatched: true,
    rootfsNodesAndElfClosureMatched: true,
    pgDumpVersionObserved: "17.10",
    pgRestoreVersionObserved: "17.10",
    disposableSandboxObserved: true,
    cleanupComplete: true,
    imageSignatureVerified: false,
    vulnerabilityDispositionVerified: false,
    sourceSpecificNetworkTlsAndCredentialInputsVerified: false,
    independentLiveRuntimeRecorderBrandCreated: false,
    nativeRuntimeClosureVerified: false,
    operationalToolAuthorityGranted: false,
    artifactEmissionAuthorized: false,
    productionCutoverAuthorized: false,
  } as const;
  const observationBindingSha256 = sha256(Buffer.from(
    `${canonicalJson({
      kind: "pintpath-postgres-tool-runtime-closure-v4-observation-binding",
      version: 1,
      observation,
    })}\n`,
    "utf8",
  ));
  const bytes = Buffer.from(`${canonicalJson({
    ...observation,
    observationBindingSha256,
  })}\n`, "utf8");
  if (bytes.length < 1 || bytes.length > 16_384) {
    throw new Error("runtime_observation_evidence_unsafe");
  }
  const descriptor = fs.openSync(EVIDENCE_PATH, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || (status.mode & 0o777) !== 0o600 || status.nlink !== 1
      || status.size !== bytes.length) {
      throw new Error("runtime_observation_evidence_unsafe");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

async function registryToken(): Promise<string> {
  const url = new URL("https://auth.docker.io/token");
  url.searchParams.set("service", "registry.docker.io");
  url.searchParams.set("scope", `repository:${REPOSITORY}:pull`);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.url !== url.href) {
    throw new Error("runtime_observation_registry_auth_failed");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > 32_768) {
    throw new Error("runtime_observation_registry_auth_failed");
  }
  const payload = json(bytes);
  const token = payload.token;
  if (typeof token !== "string" || token.length < 100 || token.length > 16_384
    || /[\0\r\n]/.test(token)) {
    throw new Error("runtime_observation_registry_auth_failed");
  }
  return token;
}

async function registryResponse(
  token: string,
  kind: "manifests" | "blobs",
  digest: string,
  accept: string,
): Promise<Response> {
  const response = await fetchPostgresToolRuntimeClosureV4RegistryResponse({
    token,
    kind,
    digest,
    accept,
  });
  const observedDigest = response.headers.get("docker-content-digest");
  if (observedDigest !== null && observedDigest !== digest) {
    throw new Error("runtime_observation_registry_digest_mismatch");
  }
  return response;
}

async function exactRegistryBytes(
  token: string,
  kind: "manifests" | "blobs",
  digest: string,
  expectedBytes: number,
  accept: string,
): Promise<Buffer> {
  const response = await registryResponse(token, kind, digest, accept);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && contentLength !== String(expectedBytes)) {
    throw new Error("runtime_observation_registry_size_mismatch");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expectedBytes || sha256(bytes) !== withoutAlgorithm(digest)) {
    throw new Error("runtime_observation_registry_digest_mismatch");
  }
  return bytes;
}

async function verifyLayer(
  token: string,
  layer: (typeof POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS)[number],
): Promise<void> {
  const response = await registryResponse(
    token,
    "blobs",
    layer.digest,
    "application/octet-stream",
  );
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && contentLength !== String(layer.bytes)) {
    throw new Error("runtime_observation_registry_size_mismatch");
  }
  if (response.body === null) throw new Error("runtime_observation_registry_fetch_failed");
  const compressed = crypto.createHash("sha256");
  const uncompressed = crypto.createHash("sha256");
  const gunzip = zlib.createGunzip();
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  gunzip.on("data", (chunk: Buffer) => {
    uncompressedBytes += chunk.length;
    if (uncompressedBytes > MAX_LAYER_UNCOMPRESSED_BYTES) {
      gunzip.destroy(new Error("runtime_observation_layer_expansion_unsafe"));
      return;
    }
    uncompressed.update(chunk);
  });
  const completion = finished(gunzip);
  for await (const rawChunk of response.body) {
    const chunk = Buffer.from(rawChunk);
    compressedBytes += chunk.length;
    if (compressedBytes > layer.bytes) {
      gunzip.destroy(new Error("runtime_observation_registry_size_mismatch"));
      break;
    }
    compressed.update(chunk);
    if (!gunzip.write(chunk)) await once(gunzip, "drain");
  }
  gunzip.end();
  await completion;
  if (compressedBytes !== layer.bytes
    || compressed.digest("hex") !== withoutAlgorithm(layer.digest)
    || uncompressed.digest("hex") !== withoutAlgorithm(layer.diffId)) {
    throw new Error("runtime_observation_layer_digest_mismatch");
  }
}

function dockerEnvironment(workDirectory: string): NodeJS.ProcessEnv {
  const inheritedPath = requiredEnvironment("PATH");
  const home = path.join(workDirectory, "home");
  const dockerConfig = path.join(workDirectory, "docker-config");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(dockerConfig, { mode: 0o700 });
  fs.writeFileSync(path.join(dockerConfig, "config.json"), "{\"auths\":{}}\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return Object.freeze({
    PATH: inheritedPath,
    HOME: home,
    DOCKER_CONFIG: dockerConfig,
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
    DOCKER_CLI_HINTS: "false",
  });
}

function run(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = 60_000,
  maxBuffer = MAX_CHILD_OUTPUT_BYTES,
): Buffer {
  const result = spawnSync(command, [...args], {
    encoding: null,
    env: environment,
    killSignal: "SIGKILL",
    maxBuffer,
    timeout,
  });
  if (result.error || result.signal || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.subarray(0, 4_096).toString("utf8")
      : "";
    throw new Error(`runtime_observation_process_failed:${path.basename(command)}:${stderr}`);
  }
  return Buffer.isBuffer(result.stdout) ? Buffer.from(result.stdout) : Buffer.alloc(0);
}

function docker(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeout = 60_000,
): Buffer {
  return run(DOCKER, args, environment, timeout);
}

function createArguments(
  name: string,
  label: string,
  entrypoint: string,
  command: readonly string[],
): string[] {
  return [
    "create",
    "--name", name,
    "--platform", "linux/amd64",
    "--pull", "never",
    "--label", `${LABEL_KEY}=${label}`,
    "--read-only",
    "--user", "65532:65532",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true",
    "--network", "none",
    "--pids-limit", "32",
    "--memory", "128m",
    "--cpus", "1",
    "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,nodev,size=65536,mode=0700,uid=65532,gid=65532",
    "--env", "LC_ALL=C",
    "--env", "TZ=UTC",
    "--entrypoint", entrypoint,
    `docker.io/${REPOSITORY}@${POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest}`,
    ...command,
  ];
}

function assertSandboxInspection(value: unknown, name: string, label: string): void {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("runtime_observation_container_inspect_invalid");
  }
  const inspected = record(value[0]);
  const config = record(inspected.Config);
  const host = record(inspected.HostConfig);
  const state = record(inspected.State);
  const labels = record(config.Labels);
  expect(inspected.Name).toBe(`/${name}`);
  expect(labels[LABEL_KEY]).toBe(label);
  expect(config.User).toBe("65532:65532");
  expect(host.ReadonlyRootfs).toBe(true);
  expect(host.Privileged).toBe(false);
  expect(host.NetworkMode).toBe("none");
  expect(host.PidMode).toBe("");
  expect(host.IpcMode).toBe("private");
  expect(host.UTSMode).toBe("");
  expect(host.Binds).toBeNull();
  expect(host.Devices === null || Array.isArray(host.Devices)).toBe(true);
  expect(host.Devices ?? []).toEqual([]);
  expect(host.DeviceRequests === null || Array.isArray(host.DeviceRequests)).toBe(true);
  expect(host.DeviceRequests ?? []).toEqual([]);
  expect(host.CapDrop).toEqual(["ALL"]);
  expect(host.SecurityOpt).toContain("no-new-privileges=true");
  const tmpfs = record(host.Tmpfs);
  expect(Object.keys(tmpfs)).toEqual(["/var/lib/postgresql/data"]);
  expect(String(tmpfs["/var/lib/postgresql/data"])).toContain("noexec");
  expect(String(tmpfs["/var/lib/postgresql/data"])).toContain("nosuid");
  expect(String(tmpfs["/var/lib/postgresql/data"])).toContain("nodev");
  expect(state.Running).toBe(false);
  expect(state.Pid).toBe(0);
  const env = config.Env;
  expect(Array.isArray(env)).toBe(true);
  expect(env).toContain("LC_ALL=C");
  expect(env).toContain("TZ=UTC");
  expect((env as unknown[]).some((entry) => typeof entry === "string"
    && /^(?:PGPASSWORD|PGPASSFILE)=/.test(entry))).toBe(false);
}

function verifyRootfs(rootfs: string): void {
  for (const entry of POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES) {
    const filename = `${rootfs}${entry.path}`;
    const status = fs.lstatSync(filename);
    expect(status.isSymbolicLink()).toBe(entry.nodeKind === "symlink");
    if (entry.nodeKind === "symlink") {
      if (entry.linkTarget === null) {
        throw new Error("runtime_observation_symlink_target_missing");
      }
      expect(fs.readlinkSync(filename)).toBe(entry.linkTarget);
      const relativeResolved = path.posix.normalize(path.posix.join(
        path.posix.dirname(entry.path),
        entry.linkTarget,
      ));
      expect(relativeResolved).toBe(entry.resolvedPath);
    } else {
      expect(status.isFile()).toBe(true);
      expect(entry.resolvedPath).toBe(entry.path);
    }
    const bytes = fs.readFileSync(`${rootfs}${entry.resolvedPath}`);
    expect(bytes.length).toBe(entry.bytes);
    expect(sha256(bytes)).toBe(entry.sha256);
  }
  for (const entry of POSTGRES_TOOL_RUNTIME_CLOSURE_V4_DATA_FILES) {
    const filename = `${rootfs}${entry.path}`;
    expect(fs.lstatSync(filename).isFile()).toBe(true);
    const bytes = fs.readFileSync(filename);
    expect(bytes.length).toBe(entry.bytes);
    expect(sha256(bytes)).toBe(entry.sha256);
  }
}

function verifyElfClosure(rootfs: string, environment: NodeJS.ProcessEnv): void {
  const objdump = resolvedHostExecutable("/usr/bin/objdump");
  const readelf = resolvedHostExecutable("/usr/bin/readelf");
  const bySoname = new Map(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.map(
    (entry) => [path.posix.basename(entry.path), entry] as const,
  ));
  expect(bySoname.size).toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.length);
  const queue = ["/usr/local/bin/pg_dump", "/usr/local/bin/pg_restore"];
  const observed = new Set<string>();
  while (queue.length > 0) {
    const logicalPath = queue.shift()!;
    if (observed.has(logicalPath)) continue;
    observed.add(logicalPath);
    const entry = POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.find(
      ({ path: candidate }) => candidate === logicalPath,
    );
    if (!entry) throw new Error("runtime_observation_elf_dependency_missing");
    const output = run(objdump, ["-p", `${rootfs}${entry.resolvedPath}`], environment)
      .toString("utf8");
    for (const match of output.matchAll(/^\s*NEEDED\s+(\S+)\s*$/gm)) {
      const dependency = bySoname.get(match[1]!);
      if (!dependency) throw new Error("runtime_observation_elf_dependency_missing");
      queue.push(dependency.path);
    }
  }
  for (const executable of ["/usr/local/bin/pg_dump", "/usr/local/bin/pg_restore"]) {
    const output = run(readelf, ["-l", `${rootfs}${executable}`], environment)
      .toString("utf8");
    expect(output).toContain("[Requesting program interpreter: /lib/ld-musl-x86_64.so.1]");
  }
  observed.add("/lib/ld-musl-x86_64.so.1");
  expect([...observed].sort()).toEqual(
    POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES.map(({ path: file }) => file),
  );
}

describe.runIf(enabled)("PostgreSQL V4 exact OCI runtime closure observation", () => {
  it("hashes the published OCI graph and runs exact PG17 tools in a disposable sandbox", {
    timeout: 10 * 60_000,
  }, async () => {
    const workDirectory = fs.mkdtempSync(path.join(
      RUNNER_TEMP,
      "pintpath-postgres-tool-runtime-v4-",
    ));
    fs.chmodSync(workDirectory, 0o700);
    const environment = dockerEnvironment(workDirectory);
    const label = `${LABEL_PREFIX}${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    const containerNames: string[] = [];
    let primaryFailure: unknown = null;
    let dockerServerVersion = "";
    try {
      expect(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_CAPABILITY).toMatchObject({
        implementationState: "PASSIVE_PINNED_OCI_RUNTIME_CONTRACT_ONLY",
        nativeRuntimeClosureVerified: false,
        operationalToolAuthorityGranted: false,
        artifactEmissionAuthorized: false,
        productionCutoverAuthorized: false,
      });

      const dockerVersion = json(docker(["version", "--format", "{{json .}}"], environment));
      const server = record(dockerVersion.Server);
      expect(server.Os).toBe("linux");
      expect(server.Arch).toBe("amd64");
      expect(typeof server.Version).toBe("string");
      dockerServerVersion = server.Version as string;
      const dockerInfo = json(docker(["info", "--format", "{{json .}}"], environment));
      expect(dockerInfo.OSType).toBe("linux");
      expect(["amd64", "x86_64"]).toContain(dockerInfo.Architecture);
      const securityOptions = dockerInfo.SecurityOptions;
      expect(Array.isArray(securityOptions)).toBe(true);
      expect((securityOptions as unknown[]).some(
        (entry) => typeof entry === "string" && entry.includes("seccomp"),
      )).toBe(true);

      const token = await registryToken();
      const indexBytes = await exactRegistryBytes(
        token,
        "manifests",
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.indexDigest,
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.indexBytes,
        OCI_INDEX,
      );
      const index = json(indexBytes);
      expect(index.mediaType).toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.indexMediaType);
      expect(index.schemaVersion).toBe(2);
      const manifests = index.manifests;
      expect(Array.isArray(manifests)).toBe(true);
      const platformDescriptor = (manifests as unknown[]).map(record).find(
        ({ digest }) => digest === POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest,
      );
      expect(platformDescriptor).toMatchObject({
        digest: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest,
        mediaType: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestMediaType,
        size: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestBytes,
        platform: { os: "linux", architecture: "amd64" },
      });
      const annotations = record(platformDescriptor?.annotations);
      expect(annotations["org.opencontainers.image.base.name"])
        .toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.baseImageReference);
      expect(annotations["org.opencontainers.image.base.digest"])
        .toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.baseImageDigest);
      expect(annotations["org.opencontainers.image.revision"])
        .toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.sourceRevision);

      const manifestBytes = await exactRegistryBytes(
        token,
        "manifests",
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest,
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestBytes,
        OCI_MANIFEST,
      );
      const manifest = json(manifestBytes);
      expect(manifest.mediaType).toBe(OCI_MANIFEST);
      expect(manifest.schemaVersion).toBe(2);
      expect(record(manifest.config)).toEqual({
        mediaType: OCI_CONFIG,
        digest: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configDigest,
        size: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configBytes,
      });
      expect(manifest.layers).toEqual(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.map(
        ({ digest, bytes }) => ({ mediaType: OCI_LAYER, digest, size: bytes }),
      ));

      const configBytes = await exactRegistryBytes(
        token,
        "blobs",
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configDigest,
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configBytes,
        OCI_CONFIG,
      );
      const config = json(configBytes);
      expect(config.architecture).toBe("amd64");
      expect(config.os).toBe("linux");
      expect(record(config.rootfs).diff_ids).toEqual(
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.map(({ diffId }) => diffId),
      );
      const imageConfig = record(config.config);
      expect(imageConfig.Env).toContain("PG_VERSION=17.10");
      expect(imageConfig.User).toBeUndefined();

      const attestationManifestBytes = await exactRegistryBytes(
        token,
        "manifests",
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.attestationManifestDigest,
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.attestationManifestBytes,
        OCI_MANIFEST,
      );
      const attestationManifest = json(attestationManifestBytes);
      expect(record(attestationManifest.config)).toEqual({
        mediaType: OCI_CONFIG,
        digest: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.attestationConfigDigest,
        size: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.attestationConfigBytes,
      });
      expect(attestationManifest.layers).toEqual([
        expect.objectContaining({
          mediaType: "application/vnd.in-toto+json",
          digest: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.sbomLayerDigest,
          size: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.sbomLayerBytes,
        }),
        expect.objectContaining({
          mediaType: "application/vnd.in-toto+json",
          digest: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.provenanceLayerDigest,
          size: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.provenanceLayerBytes,
        }),
      ]);
      await exactRegistryBytes(
        token,
        "blobs",
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.attestationConfigDigest,
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.attestationConfigBytes,
        OCI_CONFIG,
      );
      const sbomBytes = await exactRegistryBytes(
        token,
        "blobs",
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.sbomLayerDigest,
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.sbomLayerBytes,
        "application/vnd.in-toto+json",
      );
      const provenanceBytes = await exactRegistryBytes(
        token,
        "blobs",
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.provenanceLayerDigest,
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.provenanceLayerBytes,
        "application/vnd.in-toto+json",
      );
      for (const statement of [json(sbomBytes), json(provenanceBytes)]) {
        expect(statement._type).toBe("https://in-toto.io/Statement/v0.1");
        expect(Array.isArray(statement.subject)).toBe(true);
        expect((statement.subject as unknown[]).map(record).every((subject) =>
          record(subject.digest).sha256
            === withoutAlgorithm(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest)))
          .toBe(true);
      }
      const sbom = json(sbomBytes);
      expect(sbom.predicateType).toBe("https://spdx.dev/Document");
      const packages = record(sbom.predicate).packages;
      expect(Array.isArray(packages)).toBe(true);
      expect((packages as unknown[]).map(record).some((entry) =>
        entry.name === "postgresql" && entry.versionInfo === "17.10")).toBe(true);
      const provenance = json(provenanceBytes);
      expect(provenance.predicateType).toBe("https://slsa.dev/provenance/v0.2");
      const predicate = record(provenance.predicate);
      expect(predicate.buildType).toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.provenanceBuildType);
      expect(record(predicate.builder).id)
        .toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.provenanceBuilder);

      for (const layer of POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS) {
        await verifyLayer(token, layer);
      }

      const exactImage = `docker.io/${REPOSITORY}@${POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest}`;
      docker(["pull", "--platform", "linux/amd64", exactImage], environment, 5 * 60_000);
      const imageInspection = JSON.parse(
        docker(["image", "inspect", exactImage], environment).toString("utf8"),
      ) as unknown;
      expect(Array.isArray(imageInspection)).toBe(true);
      const inspectedImage = record((imageInspection as unknown[])[0]);
      expect(inspectedImage.Id).toBe(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configDigest);
      expect(inspectedImage.Architecture).toBe("amd64");
      expect(inspectedImage.Os).toBe("linux");
      expect(record(inspectedImage.RootFS).Layers).toEqual(
        POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.map(({ diffId }) => diffId),
      );
      const inspectedConfig = record(inspectedImage.Config);
      expect(inspectedConfig.Env).toEqual(imageConfig.Env);
      expect(inspectedConfig.Entrypoint).toEqual(imageConfig.Entrypoint);
      expect(inspectedConfig.Cmd).toEqual(imageConfig.Cmd);

      const exportName = `pintpath-runtime-v4-export-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      containerNames.push(exportName);
      expect(docker(["ps", "-aq", "--filter", `name=^/${exportName}$`], environment)
        .toString("utf8").trim()).toBe("");
      docker(createArguments(exportName, label, "/bin/true", []), environment);
      const exportInspection = JSON.parse(
        docker(["inspect", exportName], environment).toString("utf8"),
      ) as unknown;
      assertSandboxInspection(exportInspection, exportName, label);
      const rootfsTar = path.join(workDirectory, "rootfs.tar");
      docker(["export", "--output", rootfsTar, exportName], environment, 3 * 60_000);
      const tarStatus = fs.statSync(rootfsTar);
      expect(tarStatus.isFile()).toBe(true);
      expect(tarStatus.size).toBeGreaterThan(100 * 1_024 * 1_024);
      expect(tarStatus.size).toBeLessThan(1 * 1_024 * 1_024 * 1_024);
      const rootfs = path.join(workDirectory, "rootfs");
      fs.mkdirSync(rootfs, { mode: 0o700 });
      run(resolvedHostExecutable("/usr/bin/tar"), ["-xf", rootfsTar, "-C", rootfs], environment,
        3 * 60_000, MAX_CHILD_OUTPUT_BYTES);
      verifyRootfs(rootfs);
      verifyElfClosure(rootfs, environment);

      for (const [tool, version] of [
        ["/usr/local/bin/pg_dump", "pg_dump (PostgreSQL) 17.10\n"],
        ["/usr/local/bin/pg_restore", "pg_restore (PostgreSQL) 17.10\n"],
      ] as const) {
        const name = `pintpath-runtime-v4-tool-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
        containerNames.push(name);
        docker(createArguments(name, label, tool, ["--version"]), environment);
        const inspection = JSON.parse(docker(["inspect", name], environment).toString("utf8")) as unknown;
        assertSandboxInspection(inspection, name, label);
        const output = docker(["start", "--attach", name], environment);
        expect(output.toString("utf8")).toBe(version);
        const completed = record((JSON.parse(
          docker(["inspect", name], environment).toString("utf8"),
        ) as unknown[])[0]);
        const state = record(completed.State);
        expect(state.Running).toBe(false);
        expect(state.ExitCode).toBe(0);
        expect(state.OOMKilled).toBe(false);
        expect(state.Error).toBe("");
      }
    } catch (error) {
      primaryFailure = error;
    } finally {
      const cleanupFailures: unknown[] = [];
      for (const name of [...containerNames].reverse()) {
        try {
          const present = docker(["ps", "-aq", "--filter", `name=^/${name}$`], environment)
            .toString("utf8").trim();
          if (present) {
            const inspection = JSON.parse(
              docker(["inspect", name], environment).toString("utf8"),
            ) as unknown[];
            const labels = record(record(record(inspection[0]).Config).Labels);
            if (labels[LABEL_KEY] !== label) {
              throw new Error("runtime_observation_cleanup_identity_mismatch");
            }
            docker(["rm", "--force", "--volumes", name], environment);
          }
          expect(docker(["ps", "-aq", "--filter", `name=^/${name}$`], environment)
            .toString("utf8").trim()).toBe("");
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      try {
        expect(docker(["ps", "-aq", "--filter", `label=${LABEL_KEY}=${label}`], environment)
          .toString("utf8").trim()).toBe("");
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        fs.rmSync(workDirectory, { force: false, recursive: true });
        expect(fs.existsSync(workDirectory)).toBe(false);
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          primaryFailure === null ? cleanupFailures : [primaryFailure, ...cleanupFailures],
          "runtime_observation_cleanup_failed",
        );
      }
      if (primaryFailure !== null) throw primaryFailure;
    }
    writeObservationEvidence(dockerServerVersion);
  });
});
