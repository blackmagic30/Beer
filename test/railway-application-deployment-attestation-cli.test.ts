import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({
  environment: {} as Readonly<Record<string, string | undefined>>,
  fetchImpl: vi.fn<typeof fetch>(),
  now: vi.fn(() => new Date("2026-08-11T00:00:00.000Z")),
  randomBytes: vi.fn((_size: number) => Buffer.alloc(16, 0x42)),
  output: [] as string[],
  writeOutput: vi.fn((value: string) => { runtimeState.output.push(value); }),
}));

vi.mock(
  "../scripts/lib/railway-application-deployment-attestation-runtime.js",
  () => ({
    RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RUNTIME: Object.freeze({
      get environment() { return runtimeState.environment; },
      fetchImpl: (...args: Parameters<typeof fetch>) => runtimeState.fetchImpl(...args),
      now: () => runtimeState.now(),
      randomBytes: (size: number) => runtimeState.randomBytes(size),
      writeOutput: (value: string) => runtimeState.writeOutput(value),
    }),
  }),
);

import {
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_COMMAND,
  RAILWAY_APPLICATION_DEPLOYMENT_DISCOVERY_QUERY,
  RAILWAY_APPLICATION_DEPLOYMENT_EMPTY_PATCH_QUERY,
  RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY,
  RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY,
  railwayApplicationDeploymentAttestationCliInternals,
  railwayApplicationDeploymentAttestationQueriesAreReadOnly,
  runRailwayApplicationDeploymentAttestation,
} from "../scripts/attest-railway-application-deployment.js";
import {
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES,
  parseRailwayApplicationDeploymentAttestationReceipt,
} from "../src/lib/railway-application-deployment-attestation.js";
import {
  railwayDeploymentIdentityIdSha256,
} from "../src/lib/railway-deployment-identity.js";

const CANDIDATE_SHA = "a".repeat(40);
const TARGET_ORIGIN = "https://pintpath-staging-fixture.up.railway.app";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const SERVICE_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-4444-8444-444444444444";
const IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const REPLICA_ID = "opaque-railway-replica-fixture";
const roots: string[] = [];

function privateRoot(): string {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pintpath-deployment-attestor-"),
  );
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function args(root: string): string[] {
  return [
    "--candidate-sha",
    CANDIDATE_SHA,
    "--target-origin",
    TARGET_ORIGIN,
    "--target-origin-sha256",
    crypto.createHash("sha256").update(TARGET_ORIGIN).digest("hex"),
    "--output-receipt",
    path.join(root, "receipt.json"),
  ];
}

function lastOutput(): Record<string, unknown> {
  const value = runtimeState.output.at(-1);
  if (!value) throw new Error("missing test output");
  return JSON.parse(value) as Record<string, unknown>;
}

function jsonResponse(value: unknown, runtime = false): Response {
  return new Response(new TextEncoder().encode(JSON.stringify(value)), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(runtime ? { "Cache-Control": "no-store" } : {}),
    },
  });
}

function successfulFetchResponses(): Response[] {
  const projectIdSha256 = railwayDeploymentIdentityIdSha256("project", PROJECT_ID)!;
  const environmentIdSha256 = railwayDeploymentIdentityIdSha256(
    "environment",
    ENVIRONMENT_ID,
  )!;
  const serviceIdSha256 = railwayDeploymentIdentityIdSha256("service", SERVICE_ID)!;
  const deploymentIdSha256 = railwayDeploymentIdentityIdSha256(
    "deployment",
    DEPLOYMENT_ID,
  )!;
  const replicaIdSha256 = railwayDeploymentIdentityIdSha256("replica", REPLICA_ID)!;
  const patch = {
    data: {
      environment: { id: ENVIRONMENT_ID },
      staged: { environmentId: ENVIRONMENT_ID, patch: {} },
    },
  };
  const discovery = {
    data: { serviceInstance: { latestDeployment: { id: DEPLOYMENT_ID } } },
  };
  const snapshot = {
    data: {
      serviceInstance: {
        id: SERVICE_INSTANCE_ID,
        serviceId: SERVICE_ID,
        environmentId: ENVIRONMENT_ID,
        numReplicas: 1,
        latestDeployment: {
          id: DEPLOYMENT_ID,
          status: "SUCCESS",
          deploymentStopped: false,
          snapshotId: SNAPSHOT_ID,
        },
        activeDeployments: [{
          id: DEPLOYMENT_ID,
          status: "SUCCESS",
          deploymentStopped: false,
        }],
        domains: {
          serviceDomains: [{
            id: DOMAIN_ID,
            domain: new URL(TARGET_ORIGIN).hostname,
            targetPort: null,
          }],
          customDomains: [],
        },
      },
      deployment: {
        id: DEPLOYMENT_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        snapshotId: SNAPSHOT_ID,
        meta: {
          commitHash: CANDIDATE_SHA,
          imageDigest: IMAGE_DIGEST,
          patchId: null,
        },
      },
    },
  };
  const deployment = {
    version: "0.1.0",
    commitSha: CANDIDATE_SHA,
    environment: "production",
    projectIdSha256,
    environmentIdSha256,
    serviceIdSha256,
    deploymentIdSha256,
    replicaIdSha256,
  };
  return [
    jsonResponse({
      data: {
        projectToken: {
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
        },
      },
    }),
    jsonResponse(patch),
    jsonResponse(discovery),
    jsonResponse(snapshot),
    jsonResponse({
      ok: true,
      data: {
        service: "pint-path",
        status: "ok",
        deployment,
        automaticMaintenance: { enabled: true, candidateBound: true },
      },
    }, true),
    jsonResponse({
      ok: true,
      data: {
        service: "pint-path",
        status: "startup_ready",
        deployment,
        automaticMaintenance: { enabled: true, candidateBound: true },
        dependencies: {},
      },
    }, true),
    jsonResponse({
      ok: true,
      data: {
        service: "pint-path",
        status: "ready",
        deployment,
        automaticMaintenance: { enabled: true, candidateBound: true },
        dependencies: {
          restoreRehearsal: {
            enabled: false,
            externalWritesAllowed: true,
            httpMutationRoutesAllowed: true,
            runtimeDatabase: "primary_runtime_database",
            remoteVenueDirectoryEnabled: true,
          },
        },
      },
    }, true),
    jsonResponse(discovery),
    jsonResponse(snapshot),
    jsonResponse(patch),
  ];
}

function configureSuccessfulRuntime(): Response[] {
  const responses = successfulFetchResponses();
  runtimeState.environment = {
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
  };
  runtimeState.fetchImpl.mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected_fetch");
    return response;
  });
  return responses;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  runtimeState.environment = {};
  runtimeState.fetchImpl.mockReset();
  runtimeState.now.mockReset();
  runtimeState.now.mockReturnValue(new Date("2026-08-11T00:00:00.000Z"));
  runtimeState.randomBytes.mockReset();
  runtimeState.randomBytes.mockImplementation((_size) => Buffer.alloc(16, 0x42));
  runtimeState.output.length = 0;
  runtimeState.writeOutput.mockReset();
  runtimeState.writeOutput.mockImplementation((value) => {
    runtimeState.output.push(value);
  });
});

describe("Railway application deployment attestation CLI", () => {
  it("contains only fixed metadata queries and no mutation or value surface", () => {
    expect(railwayApplicationDeploymentAttestationQueriesAreReadOnly()).toBe(true);
    const queries = [
      RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY,
      RAILWAY_APPLICATION_DEPLOYMENT_EMPTY_PATCH_QUERY,
      RAILWAY_APPLICATION_DEPLOYMENT_DISCOVERY_QUERY,
      RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY,
    ].join("\n");
    expect(queries).toContain("patch(decryptVariables: false)");
    expect(queries).not.toMatch(/\bmutation\s+/i);
    expect(queries).not.toMatch(/decryptVariables\s*:\s*true/);
    expect(queries).not.toMatch(/\blogs\b/i);
    expect(queries).not.toMatch(/\bvariables\s*\(/i);
  });

  it("fails malformed arguments before fetch or output-file creation", async () => {
    const root = privateRoot();
    const exit = await runRailwayApplicationDeploymentAttestation([
      ...args(root),
      "--unsupported",
      "value",
    ]);

    expect(exit).toBe(1);
    expect(runtimeState.fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
    expect(lastOutput()).toEqual({
      command: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_COMMAND,
      failureCode: "argument_invalid",
      ok: false,
    });
  });

  it("requires only the staging metadata token before any query", async () => {
    const root = privateRoot();
    const exit = await runRailwayApplicationDeploymentAttestation(args(root));

    expect(exit).toBe(1);
    expect(runtimeState.fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
    expect(lastOutput()).toEqual({
      command: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_COMMAND,
      failureCode: "token_invalid",
      ok: false,
    });
  });

  it("rejects forbidden ambient production, generic, proxy, and TLS authority", async () => {
    for (const name of [
      "ALL_PROXY",
      "DEBUG",
      "DEBUG_FD",
      "HTTP_PROXY",
      "NO_PROXY",
      "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
      "PINTPATH_RAILWAY_METADATA_TOKEN",
      "RAILWAY_TOKEN",
      "RAILWAY_API_TOKEN",
      "HTTPS_PROXY",
      "NODE_USE_ENV_PROXY",
      "NODE_USE_SYSTEM_CA",
      "NODE_OPTIONS",
      "OPENSSL_CONF",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "all_proxy",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "NODE_DEBUG",
      "NODE_DEBUG_NATIVE",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
    ]) {
      runtimeState.environment = {
        PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
        [name]: "forbidden-fixture",
      };
      const root = privateRoot();
      const exit = await runRailwayApplicationDeploymentAttestation(args(root));
      expect(exit, name).toBe(1);
      expect(runtimeState.fetchImpl, name).not.toHaveBeenCalled();
      expect(lastOutput(), name).toEqual({
        command: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_COMMAND,
        failureCode: "environment_not_allowed",
        ok: false,
      });
      runtimeState.output.length = 0;
    }
  });

  it("rejects an unsafe output parent before reading provider metadata", async () => {
    const root = privateRoot();
    fs.chmodSync(root, 0o755);
    runtimeState.environment = {
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
    };

    const exit = await runRailwayApplicationDeploymentAttestation(args(root));
    expect(exit).toBe(1);
    expect(runtimeState.fetchImpl).not.toHaveBeenCalled();
    expect(lastOutput()).toEqual({
      command: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_COMMAND,
      failureCode: "output_file_unsafe",
      ok: false,
    });
  });

  it("keeps the public runner fixed-runtime and direct-invocation guarded", () => {
    expect(railwayApplicationDeploymentAttestationCliInternals.ARGUMENT_COUNT).toBe(4);
    const source = fs.readFileSync(
      path.resolve("scripts/attest-railway-application-deployment.ts"),
      "utf8",
    );
    expect(source).toContain("RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RUNTIME");
    expect(source).toContain("invokedPath === fileURLToPath(import.meta.url)");
    expect(source).not.toContain("export { runWithDependencies");
  });

  it("never overwrites an existing receipt and does not query Railway", async () => {
    const root = privateRoot();
    const outputReceipt = path.join(root, "receipt.json");
    fs.writeFileSync(outputReceipt, "existing-fixture", { mode: 0o600 });
    runtimeState.environment = {
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
    };

    expect(await runRailwayApplicationDeploymentAttestation(args(root))).toBe(1);
    expect(runtimeState.fetchImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(outputReceipt, "utf8")).toBe("existing-fixture");
    expect(lastOutput()).toMatchObject({ failureCode: "output_file_unsafe", ok: false });
  });

  it("maps provider and runtime transport failures to fixed failure codes", async () => {
    const providerRoot = privateRoot();
    runtimeState.environment = {
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
    };
    runtimeState.fetchImpl.mockResolvedValueOnce(new Response("failed", { status: 503 }));
    expect(await runRailwayApplicationDeploymentAttestation(args(providerRoot))).toBe(1);
    expect(lastOutput()).toMatchObject({ failureCode: "metadata_query_failed", ok: false });

    runtimeState.output.length = 0;
    runtimeState.fetchImpl.mockReset();
    const runtimeRoot = privateRoot();
    const responses = successfulFetchResponses();
    responses[4] = jsonResponse({
      ok: true,
      data: { service: "pint-path", status: "ok", deployment: {} },
    });
    runtimeState.fetchImpl.mockImplementation(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected_fetch");
      return response;
    });
    expect(await runRailwayApplicationDeploymentAttestation(args(runtimeRoot))).toBe(1);
    expect(lastOutput()).toMatchObject({ failureCode: "runtime_probe_failed", ok: false });
  });

  it("bounds provider bytes, requires fatal UTF-8, and enforces one global window", async () => {
    for (const body of [
      "x".repeat(
        RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_MAX_PROVIDER_RESPONSE_BYTES + 1,
      ),
      new Uint8Array([0xff]),
    ]) {
      const root = privateRoot();
      runtimeState.environment = {
        PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
      };
      runtimeState.fetchImpl.mockResolvedValueOnce(new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      expect(await runRailwayApplicationDeploymentAttestation(args(root))).toBe(1);
      expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
      expect(lastOutput()).toMatchObject({ failureCode: "metadata_query_failed", ok: false });
      runtimeState.output.length = 0;
      runtimeState.fetchImpl.mockReset();
    }

    const deadlineRoot = privateRoot();
    const responses = configureSuccessfulRuntime();
    let nowCalls = 0;
    runtimeState.now.mockImplementation(() => {
      nowCalls += 1;
      return new Date(nowCalls <= 2
        ? "2026-08-11T00:00:00.000Z"
        : "2026-08-11T00:02:00.000Z");
    });
    expect(await runRailwayApplicationDeploymentAttestation(args(deadlineRoot))).toBe(1);
    expect(runtimeState.fetchImpl).toHaveBeenCalledTimes(1);
    expect(responses).toHaveLength(9);
    expect(lastOutput()).toMatchObject({ failureCode: "attestation_failed", ok: false });
  });

  it("rejects provider drift after the runtime probes without publishing", async () => {
    const root = privateRoot();
    const responses = successfulFetchResponses();
    const drifted = await responses[8]!.clone().json() as {
      data: { deployment: { snapshotId: string } };
    };
    drifted.data.deployment.snapshotId = "55555555-5555-4555-8555-555555555555";
    responses[8] = jsonResponse(drifted);
    runtimeState.environment = {
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
    };
    runtimeState.fetchImpl.mockImplementation(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected_fetch");
      return response;
    });

    expect(await runRailwayApplicationDeploymentAttestation(args(root))).toBe(1);
    expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
    expect(lastOutput()).toMatchObject({ failureCode: "attestation_failed", ok: false });
  });

  it("rolls back on summary failure and invalidates a receipt if unlink also fails", async () => {
    const root = privateRoot();
    const outputReceipt = path.join(root, "receipt.json");
    configureSuccessfulRuntime();
    runtimeState.writeOutput.mockImplementationOnce(() => {
      fs.chmodSync(root, 0o500);
      throw new Error("summary-write-fixture");
    });
    const exit = await runRailwayApplicationDeploymentAttestation(args(root));
    fs.chmodSync(root, 0o700);
    expect(exit).toBe(1);
    expect(fs.existsSync(outputReceipt)).toBe(true);
    expect(fs.statSync(outputReceipt).size).toBe(0);
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      fs.readFileSync(outputReceipt),
    )).toBeNull();
    expect(lastOutput()).toMatchObject({ failureCode: "output_file_unsafe", ok: false });
  });

  it("invalidates a receipt moved to an alias when stdout fails", async () => {
    const root = privateRoot();
    const outputReceipt = path.join(root, "receipt.json");
    const alias = path.join(root, "receipt-moved.json");
    configureSuccessfulRuntime();
    runtimeState.writeOutput.mockImplementationOnce(() => {
      fs.renameSync(outputReceipt, alias);
      throw new Error("summary-write-fixture");
    });

    expect(await runRailwayApplicationDeploymentAttestation(args(root))).toBe(1);
    expect(fs.existsSync(outputReceipt)).toBe(false);
    expect(fs.existsSync(alias)).toBe(true);
    expect(fs.statSync(alias).size).toBe(0);
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      fs.readFileSync(alias),
    )).toBeNull();
    expect(lastOutput()).toMatchObject({ failureCode: "unexpected_failure", ok: false });
  });

  it("reasserts mode and link count after stdout and invalidates every alias", async () => {
    const root = privateRoot();
    const outputReceipt = path.join(root, "receipt.json");
    const alias = path.join(root, "receipt-alias.json");
    configureSuccessfulRuntime();
    runtimeState.writeOutput.mockImplementationOnce((value) => {
      runtimeState.output.push(value);
      fs.chmodSync(outputReceipt, 0o644);
      fs.linkSync(outputReceipt, alias);
    });

    expect(await runRailwayApplicationDeploymentAttestation(args(root))).toBe(1);
    expect(fs.existsSync(outputReceipt)).toBe(false);
    expect(fs.existsSync(alias)).toBe(true);
    expect(fs.statSync(alias).size).toBe(0);
    expect(lastOutput()).toMatchObject({ failureCode: "output_file_unsafe", ok: false });
  });

  it("cannot serialize a poisoned inherited toJSON into a Railway mutation", async () => {
    const root = privateRoot();
    const outputReceipt = path.join(root, "receipt.json");
    configureSuccessfulRuntime();
    const originalToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const originalStringify = JSON.stringify;
    const random = Buffer.alloc(16, 0x51);
    Object.defineProperty(random, "toString", {
      configurable: true,
      value: () => { throw new Error("random-to-string-poison"); },
    });
    runtimeState.randomBytes.mockReturnValue(random);
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => ({
          operationName: "InjectedMutation",
          query: "mutation InjectedMutation { forbiddenWrite }",
          variables: {},
        }),
      });
      JSON.stringify = (() => "raw-poisoned-json") as typeof JSON.stringify;
      expect(await runRailwayApplicationDeploymentAttestation(args(root))).toBe(0);
    } finally {
      JSON.stringify = originalStringify;
      if (originalToJson) {
        Object.defineProperty(Object.prototype, "toJSON", originalToJson);
      } else {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      }
    }

    expect(fs.existsSync(outputReceipt)).toBe(true);
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      fs.readFileSync(outputReceipt),
    )).not.toBeNull();
    for (const [, init] of runtimeState.fetchImpl.mock.calls.slice(0, 4)) {
      expect(String(init?.body)).not.toContain("mutation InjectedMutation");
      expect(String(init?.body)).not.toContain("forbiddenWrite");
    }
  });

  it("does not let a poisoned Array push substitute provider body bytes", async () => {
    const response = new Response("EVIL", {
      headers: { "Content-Type": "application/json" },
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push")!;
    const originalPush = originalDescriptor.value as typeof Array.prototype.push;
    const replacement = new Uint8Array([0x47, 0x4f, 0x4f, 0x44]);
    let substitutions = 0;
    let result: string | undefined;
    try {
      Object.defineProperty(Array.prototype, "push", {
        ...originalDescriptor,
        value(this: unknown[], ...items: unknown[]) {
          const item = items.length === 1 ? items[0] : undefined;
          if (
            item instanceof Uint8Array
            && item.byteLength === 4
            && item[0] === 0x45
            && item[1] === 0x56
            && item[2] === 0x49
            && item[3] === 0x4c
          ) {
            substitutions += 1;
            return Reflect.apply(originalPush, this, [replacement]);
          }
          return Reflect.apply(originalPush, this, items);
        },
      });
      result = await railwayApplicationDeploymentAttestationCliInternals
        .readBoundedBody(response, 16);
    } finally {
      Object.defineProperty(Array.prototype, "push", originalDescriptor);
    }
    expect(result).toBe("EVIL");
    expect(substitutions).toBe(0);
  });

  it("uses captured response, decoder, reader, and abort primitives after fetch", async () => {
    const root = privateRoot();
    const outputReceipt = path.join(root, "receipt.json");
    const responses = successfulFetchResponses();
    runtimeState.environment = {
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
    };
    const restorations: Array<() => void> = [];
    let poisonCalls = 0;
    let firstPoison = "";
    const poisonError = new Error("post-fetch-transport-primitive-poison");
    const poisonFor = (key: PropertyKey) => function poison(): never {
      poisonCalls += 1;
      if (firstPoison === "") firstPoison = String(key);
      throw poisonError;
    };
    const replaceValue = (target: object, key: PropertyKey): void => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.value !== "function") {
        throw new Error(`missing poison target: ${String(key)}`);
      }
      Object.defineProperty(target, key, { ...descriptor, value: poisonFor(key) });
      restorations.push(() => Object.defineProperty(target, key, descriptor));
    };
    const replaceGetter = (target: object, key: PropertyKey): void => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.get !== "function") {
        throw new Error(`missing poison getter: ${String(key)}`);
      }
      Object.defineProperty(target, key, { ...descriptor, get: poisonFor(key) });
      restorations.push(() => Object.defineProperty(target, key, descriptor));
    };
    let installed = false;
    runtimeState.fetchImpl.mockImplementation(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected_fetch");
      if (!installed) {
        installed = true;
        for (const [target, names] of [
          [TextDecoder.prototype, ["decode"]],
          [Headers.prototype, ["get"]],
          [ReadableStream.prototype, ["cancel", "getReader"]],
          [ReadableStreamDefaultReader.prototype, ["cancel", "read", "releaseLock"]],
          [AbortSignal, ["timeout"]],
        ] as const) {
          for (const name of names) replaceValue(target, name);
        }
        for (const name of ["body", "headers", "ok", "status"] as const) {
          replaceGetter(Response.prototype, name);
        }
      }
      return response;
    });

    let exit: 0 | 1 | undefined;
    try {
      exit = await runRailwayApplicationDeploymentAttestation(args(root));
    } finally {
      for (let index = restorations.length - 1; index >= 0; index -= 1) {
        restorations[index]!();
      }
    }
    expect(poisonCalls, firstPoison).toBe(0);
    expect(exit).toBe(0);
    expect(responses).toHaveLength(0);
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      fs.readFileSync(outputReceipt),
    )).not.toBeNull();
  });

  it("uses captured hashing, Buffer, URL, RegExp, and fs primitives after observation", async () => {
    const root = privateRoot();
    const outputReceipt = path.join(root, "receipt.json");
    const fixedArgs = args(root);
    const responses = successfulFetchResponses();
    const fixedRandom = Buffer.alloc(16, 0x63);
    const originalCallbacks = {
      fetchImpl: runtimeState.fetchImpl,
      now: runtimeState.now,
      randomBytes: runtimeState.randomBytes,
      writeOutput: runtimeState.writeOutput,
    };
    const localOutput: string[] = [];
    runtimeState.environment = {
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "staging-metadata-token-fixture",
    };
    runtimeState.fetchImpl = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected_fetch");
      return response;
    }) as typeof runtimeState.fetchImpl;
    runtimeState.randomBytes = (() => fixedRandom) as typeof runtimeState.randomBytes;
    runtimeState.writeOutput = ((value: string) => {
      localOutput.push(value);
    }) as typeof runtimeState.writeOutput;

    const hashPrototype = Object.getPrototypeOf(crypto.createHash("sha256")) as object;
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
    const urlPrototype = URL.prototype;
    const restorations: Array<() => void> = [];
    let poisonCalls = 0;
    let firstPoison = "";
    const poisonError = new Error("post-import-primitive-poison");
    const poisonFor = (key: PropertyKey) => function poison(): never {
      poisonCalls += 1;
      if (firstPoison === "") firstPoison = String(key);
      throw poisonError;
    };
    const replaceValue = (target: object, key: PropertyKey): void => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.value !== "function") {
        throw new Error(`missing poison target: ${String(key)}`);
      }
      Object.defineProperty(target, key, { ...descriptor, value: poisonFor(key) });
      restorations.push(() => Object.defineProperty(target, key, descriptor));
    };
    const replaceGetter = (target: object, key: PropertyKey): void => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.get !== "function") {
        throw new Error(`missing poison getter: ${String(key)}`);
      }
      Object.defineProperty(target, key, { ...descriptor, get: poisonFor(key) });
      restorations.push(() => Object.defineProperty(target, key, descriptor));
    };

    let installed = false;
    const installPoisons = (): void => {
      if (installed) return;
      installed = true;
      for (const [target, names] of [
        [crypto, ["createHash"]],
        [hashPrototype, ["update", "digest"]],
        [Buffer, ["alloc", "from", "byteLength", "isBuffer"]],
        [JSON, ["parse", "stringify"]],
        [fs, [
          "closeSync",
          "fchmodSync",
          "fstatSync",
          "fsyncSync",
          "ftruncateSync",
          "linkSync",
          "lstatSync",
          "openSync",
          "readFileSync",
          "readSync",
          "realpathSync",
          "unlinkSync",
          "writeSync",
        ]],
        [RegExp.prototype, ["exec"]],
        [typedArrayPrototype, ["fill", "set"]],
      ] as const) {
        for (const name of names) replaceValue(target, name);
      }
      for (const name of [
        "hash",
        "hostname",
        "origin",
        "password",
        "pathname",
        "port",
        "protocol",
        "search",
        "username",
      ] as const) {
        replaceGetter(urlPrototype, name);
      }
    };
    runtimeState.now = (() => {
      if (responses.length === 0) installPoisons();
      return new Date("2026-08-11T00:00:00.000Z");
    }) as typeof runtimeState.now;

    let exit: 0 | 1 | undefined;
    try {
      exit = await runRailwayApplicationDeploymentAttestation(fixedArgs);
    } finally {
      for (let index = restorations.length - 1; index >= 0; index -= 1) {
        restorations[index]!();
      }
      runtimeState.fetchImpl = originalCallbacks.fetchImpl;
      runtimeState.now = originalCallbacks.now;
      runtimeState.randomBytes = originalCallbacks.randomBytes;
      runtimeState.writeOutput = originalCallbacks.writeOutput;
    }

    expect(installed).toBe(true);
    expect(poisonCalls, firstPoison).toBe(0);
    expect(exit).toBe(0);
    expect(responses).toHaveLength(0);
    expect(localOutput).toHaveLength(1);
    expect(parseRailwayApplicationDeploymentAttestationReceipt(
      fs.readFileSync(outputReceipt),
    )).not.toBeNull();
  });

  it("publishes one private canonical receipt from stable provider and runtime evidence", async () => {
    const root = privateRoot();
    const outputReceipt = path.join(root, "receipt.json");
    const responses = configureSuccessfulRuntime();

    const exit = await runRailwayApplicationDeploymentAttestation(args(root));
    expect(exit).toBe(0);
    expect(responses).toHaveLength(0);
    expect(runtimeState.fetchImpl).toHaveBeenCalledTimes(10);
    const expectedGraphql = [
      [
        "PintPathRailwayApplicationDeploymentTokenScope",
        RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY,
        {},
      ],
      [
        "PintPathRailwayApplicationDeploymentEmptyPatch",
        RAILWAY_APPLICATION_DEPLOYMENT_EMPTY_PATCH_QUERY,
        { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID },
      ],
      [
        "PintPathRailwayApplicationDeploymentDiscovery",
        RAILWAY_APPLICATION_DEPLOYMENT_DISCOVERY_QUERY,
        { environmentId: ENVIRONMENT_ID, serviceId: SERVICE_ID },
      ],
      [
        "PintPathRailwayApplicationDeploymentSnapshot",
        RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY,
        {
          environmentId: ENVIRONMENT_ID,
          serviceId: SERVICE_ID,
          deploymentId: DEPLOYMENT_ID,
        },
      ],
    ] as const;
    expect(RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY).toContain("projectId");
    expect(RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY).toContain("environmentId");
    expect(RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY).not.toContain("project {");
    expect(RAILWAY_APPLICATION_DEPLOYMENT_TOKEN_SCOPE_QUERY).not.toContain("environment {");
    const graphqlCalls = [
      [0, expectedGraphql[0]],
      [1, expectedGraphql[1]],
      [2, expectedGraphql[2]],
      [3, expectedGraphql[3]],
      [7, expectedGraphql[2]],
      [8, expectedGraphql[3]],
      [9, expectedGraphql[1]],
    ] as const;
    for (const [callIndex, expected] of graphqlCalls) {
      const [url, init] = runtimeState.fetchImpl.mock.calls[callIndex]!;
      expect(url).toBe("https://backboard.railway.com/graphql/v2");
      expect(init).toMatchObject({ method: "POST", cache: "no-store", redirect: "error" });
      expect(new Headers(init!.headers).get("Project-Access-Token")).toBe(
        "staging-metadata-token-fixture",
      );
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      expect(body.operationName).toBe(expected[0]);
      expect(body.query).toBe(expected[1]);
      expect(body.variables).toEqual(expected[2]);
      const declared = Array.from(
        expected[1].matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\s*:/g),
        (match) => match[1]!,
      );
      expect(declared).toEqual(Object.keys(expected[2]));
      for (const variable of declared) {
        expect(
          expected[1].match(new RegExp(`\\$${variable}\\b`, "g"))?.length,
        ).toBeGreaterThan(1);
      }
      expect(String(init!.body)).not.toContain("staging-metadata-token-fixture");
    }
    expect(RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY).not.toContain("$projectId");
    for (const [callIndex, route] of [[4, "/health"], [5, "/startup"], [6, "/ready"]] as const) {
      const [url, init] = runtimeState.fetchImpl.mock.calls[callIndex]!;
      expect(url).toBe(`${TARGET_ORIGIN}${route}`);
      expect(init).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      expect(new Headers(init!.headers).has("Project-Access-Token")).toBe(false);
    }
    expect(fs.statSync(outputReceipt).mode & 0o777).toBe(0o600);
    const bytes = fs.readFileSync(outputReceipt);
    const receipt = parseRailwayApplicationDeploymentAttestationReceipt(bytes);
    expect(receipt).not.toBeNull();
    expect(receipt).toMatchObject({
      candidateSha: CANDIDATE_SHA,
      expectedEnvironment: "permanent-staging",
      readOnlyEvidence: true,
      activationAuthorized: false,
      launchBlockerRemoved: false,
    });
    expect(Object.values(receipt!.checks).every((value) => value === true)).toBe(true);
    const serialized = bytes.toString("utf8");
    for (const raw of [
      PROJECT_ID,
      ENVIRONMENT_ID,
      SERVICE_ID,
      SERVICE_INSTANCE_ID,
      DEPLOYMENT_ID,
      SNAPSHOT_ID,
      DOMAIN_ID,
      IMAGE_DIGEST,
      TARGET_ORIGIN,
      REPLICA_ID,
      "staging-metadata-token-fixture",
    ]) {
      expect(serialized).not.toContain(raw);
      expect(JSON.stringify(lastOutput())).not.toContain(raw);
    }
    expect(lastOutput()).toMatchObject({
      activationAuthorized: false,
      candidateSha: CANDIDATE_SHA,
      command: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_COMMAND,
      expectedEnvironment: "permanent-staging",
      launchBlockerRemoved: false,
      mutationEnabled: false,
      ok: true,
      receiptFileSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  });
});
