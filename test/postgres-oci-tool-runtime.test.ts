import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  POSTGRES_OCI_TOOL_RUNTIME_DOCKER_ARCHIVE_SHA256,
  POSTGRES_OCI_TOOL_RUNTIME_DOCKER_FILE,
  POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256,
  POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SOURCE,
  POSTGRES_OCI_TOOL_RUNTIME_DOCKER_VERSION,
  POSTGRES_OCI_TOOL_RUNTIME_IMAGE,
  POSTGRES_OCI_TOOL_RUNTIME_PROFILE,
  POSTGRES_OCI_TOOL_RUNTIME_RESTORE_CA_SHA256_ENV,
  buildPostgresOciCreateArguments,
  executePostgresOciContainerLifecycle,
  validatePostgresOciContainerInspection,
  validatePostgresOciDockerInfo,
  validatePostgresOciImageInspection,
  validatePostgresOciNetworkInspection,
  validatePostgresOciNetworkPluginInspection,
  type PostgresOciContainerLifecycleDependencies,
} from "../src/lib/postgres-oci-tool-runtime.js";
import {
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS,
} from "../src/lib/postgres-tool-runtime-closure-v4.js";
import type { PostgresToolProcessResult } from "../src/lib/postgres-tool-authority.js";

const HASH = "a".repeat(64);
const NAME = `pintpath-pg-dump-${"b".repeat(24)}`;
const LABEL = "c".repeat(64);
const CONTAINER_ID = "d".repeat(64);
const POLICY_HASH = "e".repeat(64);
const NETWORK_ID = "f".repeat(64);
const PLUGIN_ID = "1".repeat(64);
const SECRET = "a password that must never enter config";
const NETWORK = "pintpath-production-backup-postgres-egress";
const SECURITY_OPTIONS = [
  "name=apparmor",
  "name=cgroupns",
  "name=seccomp,profile=builtin",
];

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const policy = {
  operationClass: "backup" as const,
  containerdCommitSha256: HASH,
  daemonIdSha256: HASH,
  daemonNameSha256: HASH,
  dockerRootDirSha256: HASH,
  kernelVersionSha256: HASH,
  networkId: NETWORK_ID,
  networkName: NETWORK,
  networkPluginId: PLUGIN_ID,
  operatingSystemSha256: HASH,
  runcCommitSha256: HASH,
  securityOptionsSha256: HASH,
  host: "postgres.railway.internal",
  hostAddress: "fd00::12",
  port: "5432",
};

function result(
  stdout = "",
  exitCode = 0,
  stderr = "",
): PostgresToolProcessResult {
  return { exitCode, stdout, stderr };
}

function plan() {
  return {
    tool: "pg_dump" as const,
    toolArguments: ["--format=custom"],
    toolEnvironment: Object.freeze({
      LC_ALL: "C",
      PGHOST: policy.host,
      PGPASSFILE: "/run/pintpath/pgpass",
    }),
    mounts: Object.freeze([{
      source: "/proc/123/fd/44",
      destination: "/run/pintpath/pgpass",
      input: {} as never,
    }]),
    networkName: NETWORK,
    forbiddenSecret: SECRET,
    runAsUid: 1001,
    runAsGid: 1001,
  };
}

function createArgs() {
  return buildPostgresOciCreateArguments({ name: NAME, label: LABEL, plan: plan() });
}

function createdInspection() {
  const args = createArgs();
  return [{
    Id: CONTAINER_ID,
    Name: `/${NAME}`,
    Image: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configDigest,
    Path: "/usr/bin/env",
    Config: {
      Image: POSTGRES_OCI_TOOL_RUNTIME_IMAGE,
      User: "1001:1001",
      Entrypoint: ["/usr/bin/env"],
      Cmd: args.slice(args.indexOf(POSTGRES_OCI_TOOL_RUNTIME_IMAGE) + 1),
      WorkingDir: "/tmp",
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: false,
      Tty: false,
      StopTimeout: 1,
      Labels: { "au.pintpath.postgres-tool-runtime": LABEL },
      Volumes: { "/var/lib/postgresql/data": {} },
    },
    HostConfig: {
      ReadonlyRootfs: true,
      Privileged: false,
      AutoRemove: false,
      NetworkMode: NETWORK,
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      CgroupnsMode: "private",
      Binds: null,
      Devices: [],
      DeviceRequests: [],
      DeviceCgroupRules: [],
      CapAdd: [],
      CapDrop: ["ALL"],
      GroupAdd: [],
      Links: [],
      VolumesFrom: [],
      SecurityOpt: ["no-new-privileges=true"],
      PidsLimit: 64,
      Memory: 536_870_912,
      MemorySwap: 536_870_912,
      NanoCpus: 1_000_000_000,
      PublishAllPorts: false,
      PortBindings: {},
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      LogConfig: { Type: "none", Config: {} },
      Runtime: "runc",
      MaskedPaths: ["/proc/kcore"],
      ReadonlyPaths: ["/proc/asound"],
      Ulimits: [
        { Name: "nproc", Hard: 64, Soft: 64 },
        { Name: "nofile", Hard: 1024, Soft: 1024 },
      ],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=1001,gid=1001",
        "/var/lib/postgresql/data": "ro,noexec,nosuid,nodev,size=4096,mode=0555,uid=0,gid=0",
      },
    },
    NetworkSettings: { Networks: { [NETWORK]: {} } },
    Mounts: [{
      Type: "bind",
      Source: "/proc/123/fd/44",
      Destination: "/run/pintpath/pgpass",
      RW: false,
    }],
    State: {
      Status: "created",
      Running: false,
      Pid: 0,
      Dead: false,
      OOMKilled: false,
      Error: "",
      ExitCode: 0,
    },
  }];
}

describe("operational digest-pinned PostgreSQL OCI runtime", () => {
  it("pins the official PG17.10 platform manifest and static Docker client", () => {
    expect(POSTGRES_OCI_TOOL_RUNTIME_PROFILE)
      .toBe("pintpath-postgres-17.10-operational-oci-linux-amd64-v1");
    expect(POSTGRES_OCI_TOOL_RUNTIME_IMAGE).toBe(
      `docker.io/library/postgres@${POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest}`,
    );
    expect(POSTGRES_OCI_TOOL_RUNTIME_DOCKER_FILE)
      .toBe("/usr/local/libexec/pintpath/docker-static-29.7.2");
    expect(POSTGRES_OCI_TOOL_RUNTIME_DOCKER_VERSION).toBe("29.7.2");
    expect(POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(POSTGRES_OCI_TOOL_RUNTIME_DOCKER_ARCHIVE_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SOURCE)
      .toBe("https://download.docker.com/linux/static/stable/x86_64/docker-29.7.2.tgz");
    expect(POSTGRES_OCI_TOOL_RUNTIME_RESTORE_CA_SHA256_ENV)
      .toBe("PINTPATH_POSTGRES_OCI_RESTORE_ROOT_CA_SHA256");
  });

  it("builds a tagless, pull-disabled, non-root, read-only, bounded container", () => {
    const args = createArgs();
    expect(args).toContain("--pull=never");
    expect(args).toContain("--platform=linux/amd64");
    expect(args).toContain("--read-only");
    expect(args).toContain("--user=1001:1001");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges=true");
    expect(args).toContain("--log-driver=none");
    expect(args).toContain(
      "--tmpfs=/var/lib/postgresql/data:ro,noexec,nosuid,nodev,size=4096,mode=0555,uid=0,gid=0",
    );
    expect(args).toContain("--network=pintpath-production-backup-postgres-egress");
    expect(args).toContain(POSTGRES_OCI_TOOL_RUNTIME_IMAGE);
    expect(args).not.toContain("docker.io/library/postgres:17.10-alpine3.23");
    expect(args.join("\n")).not.toContain(SECRET);
    expect(args.join("\n")).toContain("PGPASSFILE=/run/pintpath/pgpass");
    expect(args.join("\n")).toContain("src=/proc/123/fd/44");
  });

  it("accepts only the exact image/config/rootfs projection", () => {
    const image = [{
      Id: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configDigest,
      Architecture: "amd64",
      Os: "linux",
      RepoDigests: [POSTGRES_OCI_TOOL_RUNTIME_IMAGE],
      RootFS: { Layers: POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.map(({ diffId }) => diffId) },
    }];
    expect(() => validatePostgresOciImageInspection(image)).not.toThrow();
    expect(() => validatePostgresOciImageInspection([{ ...image[0], Architecture: "arm64" }]))
      .toThrow("postgres_oci_tool_runtime_rejected");
    expect(() => validatePostgresOciImageInspection([{ ...image[0], RepoDigests: [] }]))
      .toThrow("postgres_oci_tool_runtime_rejected");
  });

  it("requires the exact destination-restricting network plugin and empty network", () => {
    expect(() => validatePostgresOciNetworkPluginInspection([{
      Id: PLUGIN_ID,
      Name: "pintpath-egress-v1",
      Enabled: true,
      Config: { Interface: { Types: ["docker.networkdriver/1.0"] } },
    }], policy)).not.toThrow();
    const network = [{
      Id: NETWORK_ID,
      Name: NETWORK,
      Driver: "pintpath-egress-v1",
      Scope: "local",
      Internal: false,
      EnableIPv6: true,
      Attachable: false,
      Ingress: false,
      ConfigOnly: false,
      Labels: { "au.pintpath.postgres-egress-policy-sha256": POLICY_HASH },
      Options: {
        allowed_host_address: policy.hostAddress,
        allowed_port: "5432",
        deny_dns: "true",
        deny_instance_metadata: "true",
        policy_sha256: POLICY_HASH,
      },
      Containers: {},
    }];
    expect(() => validatePostgresOciNetworkInspection(network, policy, POLICY_HASH))
      .not.toThrow();
    expect(() => validatePostgresOciNetworkInspection([{
      ...network[0], Containers: { unexpected: {} },
    }], policy, POLICY_HASH)).toThrow("postgres_oci_tool_runtime_rejected");
    expect(() => validatePostgresOciNetworkInspection([{
      ...network[0], Driver: "bridge",
    }], policy, POLICY_HASH)).toThrow("postgres_oci_tool_runtime_rejected");
  });

  it("rejects daemon TCB and security-profile drift", () => {
    const exactPolicy = {
      ...policy,
      containerdCommitSha256: hash("containerd"),
      daemonIdSha256: hash("daemon-id"),
      daemonNameSha256: hash("daemon-name"),
      dockerRootDirSha256: hash("/var/lib/docker"),
      kernelVersionSha256: hash("kernel"),
      operatingSystemSha256: hash("os"),
      runcCommitSha256: hash("runc"),
      securityOptionsSha256: hash(`${JSON.stringify([...SECURITY_OPTIONS].sort())}\n`),
    };
    const info = {
      ServerVersion: "29.7.2", OSType: "linux", Architecture: "x86_64",
      Driver: "overlay2", CgroupDriver: "systemd", CgroupVersion: "2",
      DefaultRuntime: "runc", LiveRestoreEnabled: false, ExperimentalBuild: false,
      ID: "daemon-id", Name: "daemon-name", DockerRootDir: "/var/lib/docker",
      KernelVersion: "kernel", OperatingSystem: "os",
      ContainerdCommit: { ID: "containerd" }, RuncCommit: { ID: "runc" },
      SecurityOptions: SECURITY_OPTIONS, Swarm: { LocalNodeState: "inactive" },
      Warnings: [],
    };
    expect(() => validatePostgresOciDockerInfo(info, exactPolicy)).not.toThrow();
    expect(() => validatePostgresOciDockerInfo({ ...info, Warnings: ["unsafe"] }, exactPolicy))
      .toThrow("postgres_oci_tool_runtime_rejected");
  });

  it("deeply accepts only the created sandbox matching the reviewed argv", () => {
    expect(() => validatePostgresOciContainerInspection({
      value: createdInspection(), id: CONTAINER_ID, name: NAME, label: LABEL,
      plan: plan(), createArguments: createArgs(),
    })).not.toThrow();
    const tampered = createdInspection();
    tampered[0]!.Config.Cmd.push(SECRET);
    expect(() => validatePostgresOciContainerInspection({
      value: tampered, id: CONTAINER_ID, name: NAME, label: LABEL,
      plan: plan(), createArguments: createArgs(),
    })).toThrow("postgres_oci_tool_runtime_rejected");
  });
});

function lifecycleHarness(input: {
  readonly createThrows?: boolean;
  readonly startThrows?: boolean;
  readonly removeThrowsButAbsent?: boolean;
  readonly refuseRemoval?: boolean;
  readonly wrongCleanupIdentity?: boolean;
} = {}) {
  let present = false;
  const calls: string[][] = [];
  const invoke = vi.fn(async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "ps") return result(present ? `${CONTAINER_ID}\n` : "");
    if (args[0] === "create") {
      present = true;
      if (input.createThrows) throw new Error("lost create response");
      return result(`${CONTAINER_ID}\n`);
    }
    if (args[0] === "inspect") {
      return result(JSON.stringify([{ Id: CONTAINER_ID, Name: `/${NAME}` }]));
    }
    if (args[0] === "rm") {
      if (input.refuseRemoval) return result("", 1, "refused");
      present = false;
      if (input.removeThrowsButAbsent) throw new Error("lost remove response");
      return result(`${NAME}\n`);
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  const dependencies: PostgresOciContainerLifecycleDependencies = {
    invoke,
    start: vi.fn(async () => {
      if (input.startThrows) throw new Error("ambiguous start failure");
      return result("tool output");
    }),
    validateCreated: vi.fn(),
    validateCompleted: vi.fn(),
    validateCleanupIdentity: vi.fn(() => {
      if (input.wrongCleanupIdentity) throw new Error("wrong identity");
    }),
  };
  return { calls, dependencies, present: () => present };
}

describe("OCI container lifecycle ambiguity and cleanup", () => {
  const input = (dependencies: PostgresOciContainerLifecycleDependencies) => ({
    name: NAME, label: LABEL, createArguments: createArgs(), dependencies,
  });

  it("removes the container after successful completion", async () => {
    const harness = lifecycleHarness();
    await expect(executePostgresOciContainerLifecycle(input(harness.dependencies)))
      .resolves.toEqual(result("tool output"));
    expect(harness.present()).toBe(false);
    expect(harness.calls.some(([command]) => command === "rm")).toBe(true);
  });

  it("rediscovers and removes a container after a lost create response", async () => {
    const harness = lifecycleHarness({ createThrows: true });
    await expect(executePostgresOciContainerLifecycle(input(harness.dependencies)))
      .rejects.toThrow("lost create response");
    expect(harness.present()).toBe(false);
  });

  it("force-removes the container after an ambiguous start failure", async () => {
    const harness = lifecycleHarness({ startThrows: true });
    await expect(executePostgresOciContainerLifecycle(input(harness.dependencies)))
      .rejects.toThrow("ambiguous start failure");
    expect(harness.present()).toBe(false);
  });

  it("accepts a lost remove response only after exact absence", async () => {
    const harness = lifecycleHarness({ removeThrowsButAbsent: true });
    await expect(executePostgresOciContainerLifecycle(input(harness.dependencies)))
      .resolves.toEqual(result("tool output"));
    expect(harness.present()).toBe(false);
  });

  it("fails closed when removal cannot prove absence", async () => {
    const harness = lifecycleHarness({ refuseRemoval: true });
    await expect(executePostgresOciContainerLifecycle(input(harness.dependencies)))
      .rejects.toThrow("postgres_oci_tool_runtime_cleanup_failed");
    expect(harness.present()).toBe(true);
  });

  it("never removes a rediscovered container with the wrong private identity", async () => {
    const harness = lifecycleHarness({ startThrows: true, wrongCleanupIdentity: true });
    await expect(executePostgresOciContainerLifecycle(input(harness.dependencies)))
      .rejects.toThrow("postgres_oci_tool_runtime_cleanup_failed");
    expect(harness.calls.some(([command]) => command === "rm")).toBe(false);
    expect(harness.present()).toBe(true);
  });
});
