import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildPermanentStagingProviderVariableTargetPostflight,
  buildPermanentStagingProviderVariableTargetPreflight,
  permanentStagingProviderVariableWriteAuthorityInternals,
} from "../scripts/lib/permanent-staging-provider-variable-write-authority.js";
import {
  evaluatePermanentStagingProviderVariableCreatePreflight,
  foldPermanentStagingProviderDeploymentInventoryPages,
  foldPermanentStagingProviderVariableInventoryPages,
  parsePermanentStagingProviderDeploymentInventoryPage,
  parsePermanentStagingProviderVariableInventoryPage,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK,
} from "../scripts/lib/permanent-staging-provider-variable-write-railway-contract.js";

const LOCK =
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK;

function variableRow(overrides: Partial<{
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly unknown[];
}> = {}) {
  return {
    id: "variable-openai-api-key",
    name: "OPENAI_API_KEY",
    environmentId: LOCK.stagingEnvironmentId,
    serviceId: LOCK.serviceId,
    isSealed: false,
    references: [],
    ...overrides,
  };
}

function variableInventory(rows: readonly ReturnType<typeof variableRow>[] = []) {
  const page = parsePermanentStagingProviderVariableInventoryPage(
    JSON.stringify({
      data: {
        environment: {
          id: LOCK.stagingEnvironmentId,
          variables: {
            edges: rows.map((node, index) => ({
              cursor: `variable-${index}`,
              node,
            })),
            pageInfo: {
              hasNextPage: false,
              endCursor: rows.length === 0
                ? null
                : `variable-${rows.length - 1}`,
            },
          },
        },
      },
    }),
    null,
  );
  expect(page).not.toBeNull();
  const inventory = foldPermanentStagingProviderVariableInventoryPages([page]);
  expect(inventory).not.toBeNull();
  return inventory!;
}

function deploymentInventory(status = "SUCCESS") {
  const page = parsePermanentStagingProviderDeploymentInventoryPage(
    JSON.stringify({
      data: {
        deployments: {
          edges: [{
            cursor: "deployment-0",
            node: {
              id: "22222222-2222-4222-8222-222222222222",
              projectId: LOCK.projectId,
              environmentId: LOCK.stagingEnvironmentId,
              serviceId: LOCK.serviceId,
              status,
              deploymentStopped: false,
              snapshotId: "44444444-4444-4444-8444-444444444444",
            },
          }],
          pageInfo: {
            hasNextPage: false,
            endCursor: "deployment-0",
          },
        },
      },
    }),
    null,
  );
  expect(page).not.toBeNull();
  const inventory = foldPermanentStagingProviderDeploymentInventoryPages([page]);
  expect(inventory).not.toBeNull();
  return inventory!;
}

function expectedHash(domain: string, value: unknown): string {
  return crypto.createHash("sha256")
    .update(domain, "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

describe("permanent staging provider-variable authority bridge", () => {
  it("binds exact preflight and postflight metadata without value material", () => {
    const beforeVariables = variableInventory();
    const deployments = deploymentInventory();
    const contractPreflight =
      evaluatePermanentStagingProviderVariableCreatePreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: beforeVariables,
        deploymentInventory: deployments,
      });
    expect(contractPreflight).not.toBeNull();

    const preflight = buildPermanentStagingProviderVariableTargetPreflight({
      variableName: "OPENAI_API_KEY",
      variableInventory: beforeVariables,
      deploymentInventory: deployments,
    });
    expect(preflight).toEqual({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-target-preflight/v1",
      projectId: LOCK.projectId,
      environmentId: LOCK.stagingEnvironmentId,
      serviceId: LOCK.serviceId,
      variableName: "OPENAI_API_KEY",
      inventoryComplete: true,
      targetAbsent: true,
      sharedShadowAbsent: true,
      metadataInventorySha256: expectedHash(
        permanentStagingProviderVariableWriteAuthorityInternals
          .variableInventoryHashDomain,
        beforeVariables,
      ),
      deploymentInventorySha256: expectedHash(
        permanentStagingProviderVariableWriteAuthorityInternals
          .deploymentInventoryHashDomain,
        deployments,
      ),
      deploymentInventoryComplete: true,
    });

    const afterVariables = variableInventory([variableRow()]);
    const postflight = buildPermanentStagingProviderVariableTargetPostflight({
      preflight: contractPreflight,
      variableInventory: afterVariables,
      deploymentInventory: deployments,
    });
    expect(postflight).toEqual({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-target-postflight/v1",
      projectId: LOCK.projectId,
      environmentId: LOCK.stagingEnvironmentId,
      serviceId: LOCK.serviceId,
      variableName: "OPENAI_API_KEY",
      inventoryComplete: true,
      targetPresent: true,
      sharedShadowAbsent: true,
      expectedMetadataExact: true,
      metadataDeltaExact: true,
      beforeMetadataInventorySha256: expectedHash(
        permanentStagingProviderVariableWriteAuthorityInternals
          .variableInventoryHashDomain,
        beforeVariables,
      ),
      currentMetadataInventorySha256: expectedHash(
        permanentStagingProviderVariableWriteAuthorityInternals
          .variableInventoryHashDomain,
        afterVariables,
      ),
      beforeDeploymentInventorySha256: expectedHash(
        permanentStagingProviderVariableWriteAuthorityInternals
          .deploymentInventoryHashDomain,
        deployments,
      ),
      currentDeploymentInventorySha256: expectedHash(
        permanentStagingProviderVariableWriteAuthorityInternals
          .deploymentInventoryHashDomain,
        deployments,
      ),
      deploymentInventoryComplete: true,
      deploymentUnchanged: true,
    });
    expect(JSON.stringify({ preflight, postflight })).not.toMatch(
      /"(?:value|decryptedValue)":/,
    );
  });

  it("snapshots own data once and never invokes caller getters", () => {
    const source = {
      variableName: "OPENAI_API_KEY",
      variableInventory: variableInventory(),
      deploymentInventory: deploymentInventory(),
    };
    const getter = vi.fn(() => {
      throw new Error("caller getter must not run");
    });
    const proxy = new Proxy(source, { get: getter });
    expect(buildPermanentStagingProviderVariableTargetPreflight(proxy))
      .not.toBeNull();
    expect(getter).not.toHaveBeenCalled();

    const accessor = {};
    Object.defineProperties(accessor, {
      variableName: { enumerable: true, get: getter },
      variableInventory: { enumerable: true, value: variableInventory() },
      deploymentInventory: { enumerable: true, value: deploymentInventory() },
    });
    expect(buildPermanentStagingProviderVariableTargetPreflight(
      accessor as Parameters<
        typeof buildPermanentStagingProviderVariableTargetPreflight
      >[0],
    )).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not let a post-import global Object prototype lookup make invalid preflight or postflight input valid", () => {
    const beforeVariables = variableInventory();
    const deployments = deploymentInventory();
    const genuinePreflight =
      evaluatePermanentStagingProviderVariableCreatePreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: beforeVariables,
        deploymentInventory: deployments,
      });
    expect(genuinePreflight).not.toBeNull();
    const afterVariables = variableInventory([variableRow()]);
    const preflightInput = {
      variableName: "ATTACKER_INVALID",
      variableInventory: beforeVariables,
      deploymentInventory: deployments,
    };
    const postflightInput = {
      preflight: null as unknown,
      variableInventory: afterVariables,
      deploymentInventory: deployments,
    };
    const priorObject = Object.getOwnPropertyDescriptor(globalThis, "Object");
    const defineProperty = Object.defineProperty;
    let prototypeTraps = 0;
    const replacement = new Proxy(Object, {
      get(target, property, receiver) {
        if (property === "prototype") {
          prototypeTraps += 1;
          preflightInput.variableName = "OPENAI_API_KEY";
          postflightInput.preflight = genuinePreflight;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let preflightResult: ReturnType<
      typeof buildPermanentStagingProviderVariableTargetPreflight
    >;
    let postflightResult: ReturnType<
      typeof buildPermanentStagingProviderVariableTargetPostflight
    >;
    try {
      defineProperty(globalThis, "Object", {
        configurable: true,
        value: replacement,
        writable: true,
      });
      preflightResult = buildPermanentStagingProviderVariableTargetPreflight(
        preflightInput,
      );
      postflightResult = buildPermanentStagingProviderVariableTargetPostflight(
        postflightInput,
      );
    } finally {
      if (priorObject === undefined) Reflect.deleteProperty(globalThis, "Object");
      else defineProperty(globalThis, "Object", priorObject);
    }
    expect(prototypeTraps).toBe(0);
    expect(preflightInput.variableName).toBe("ATTACKER_INVALID");
    expect(postflightInput.preflight).toBeNull();
    expect(preflightResult).toBeNull();
    expect(postflightResult).toBeNull();
  });

  it("rejects a sparse canonical array with junk and an inherited descriptor", () => {
    const values = new Array<unknown>(1);
    Object.defineProperty(values, "junk", {
      configurable: true,
      enumerable: true,
      value: "hidden-value",
      writable: true,
    });
    const priorZero = Object.getOwnPropertyDescriptor(Object.prototype, "0");
    Object.defineProperty(Object.prototype, "0", {
      configurable: true,
      value: {
        enumerable: true,
        value: "inherited-value",
      },
      writable: true,
    });
    let canonical: string | null;
    try {
      canonical = permanentStagingProviderVariableWriteAuthorityInternals
        .canonicalOwnDataJson(values);
    } finally {
      if (priorZero === undefined) Reflect.deleteProperty(Object.prototype, "0");
      else Object.defineProperty(Object.prototype, "0", priorZero);
    }
    expect(Object.hasOwn(values, "0")).toBe(false);
    expect(Object.hasOwn(values, "junk")).toBe(true);
    expect(canonical).toBeNull();
  });

  it("uses captured String, Buffer, ArrayBuffer, and JSON globals while hashing", () => {
    const beforeVariables = variableInventory();
    const deployments = deploymentInventory();
    const contractPreflight =
      evaluatePermanentStagingProviderVariableCreatePreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: beforeVariables,
        deploymentInventory: deployments,
      });
    expect(contractPreflight).not.toBeNull();
    const afterVariables = variableInventory([variableRow()]);
    const names = ["String", "Buffer", "ArrayBuffer", "JSON"] as const;
    const originals = names.map((name) =>
      Object.getOwnPropertyDescriptor(globalThis, name));
    const exact = {
      String,
      Buffer,
      ArrayBuffer,
      JSON,
    };
    const reads = {
      String: 0,
      Buffer: 0,
      ArrayBuffer: 0,
      JSON: 0,
    };
    const defineProperty = Object.defineProperty;
    for (const name of names) {
      defineProperty(globalThis, name, {
        configurable: true,
        get() {
          reads[name] += 1;
          return exact[name];
        },
      });
    }
    let preflight: ReturnType<
      typeof buildPermanentStagingProviderVariableTargetPreflight
    >;
    let postflight: ReturnType<
      typeof buildPermanentStagingProviderVariableTargetPostflight
    >;
    try {
      preflight = buildPermanentStagingProviderVariableTargetPreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: beforeVariables,
        deploymentInventory: deployments,
      });
      postflight = buildPermanentStagingProviderVariableTargetPostflight({
        preflight: contractPreflight,
        variableInventory: afterVariables,
        deploymentInventory: deployments,
      });
    } finally {
      for (let index = 0; index < names.length; index += 1) {
        const descriptor = originals[index];
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, names[index]!);
        else defineProperty(globalThis, names[index]!, descriptor);
      }
    }
    expect(preflight).not.toBeNull();
    expect(postflight).not.toBeNull();
    expect(reads).toEqual({
      String: 0,
      Buffer: 0,
      ArrayBuffer: 0,
      JSON: 0,
    });
  });

  it("fails closed when Proxy descriptor enumeration is not stable", () => {
    const ownKeys = vi.fn(() => {
      throw new Error("unstable caller");
    });
    const proxy = new Proxy({
      variableName: "OPENAI_API_KEY",
      variableInventory: variableInventory(),
      deploymentInventory: deploymentInventory(),
    }, { ownKeys });
    expect(buildPermanentStagingProviderVariableTargetPreflight(proxy))
      .toBeNull();
    expect(ownKeys).toHaveBeenCalledTimes(1);
  });

  it("rejects deployment or metadata drift instead of producing authority", () => {
    const beforeVariables = variableInventory();
    const deployments = deploymentInventory();
    const preflight = evaluatePermanentStagingProviderVariableCreatePreflight({
      variableName: "OPENAI_API_KEY",
      variableInventory: beforeVariables,
      deploymentInventory: deployments,
    });
    expect(preflight).not.toBeNull();
    expect(buildPermanentStagingProviderVariableTargetPostflight({
      preflight,
      variableInventory: variableInventory([variableRow()]),
      deploymentInventory: deploymentInventory("FAILED"),
    })).toBeNull();
    expect(buildPermanentStagingProviderVariableTargetPostflight({
      preflight,
      variableInventory: variableInventory([
        variableRow({ isSealed: true }),
      ]),
      deploymentInventory: deployments,
    })).toBeNull();
  });

  it("ignores inherited toJSON and poisoned live hash methods", () => {
    const beforeVariables = variableInventory();
    const deployments = deploymentInventory();
    const contractPreflight =
      evaluatePermanentStagingProviderVariableCreatePreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: beforeVariables,
        deploymentInventory: deployments,
      })!;
    const afterVariables = variableInventory([variableRow()]);
    const expectedBeforeVariables = expectedHash(
      permanentStagingProviderVariableWriteAuthorityInternals
        .variableInventoryHashDomain,
      beforeVariables,
    );
    const expectedAfterVariables = expectedHash(
      permanentStagingProviderVariableWriteAuthorityInternals
        .variableInventoryHashDomain,
      afterVariables,
    );
    const expectedDeployments = expectedHash(
      permanentStagingProviderVariableWriteAuthorityInternals
        .deploymentInventoryHashDomain,
      deployments,
    );
    const hashPrototype = Object.getPrototypeOf(crypto.createHash("sha256")) as {
      update: (...args: unknown[]) => unknown;
      digest: (...args: unknown[]) => unknown;
    };
    const createHash = vi.spyOn(crypto, "createHash").mockImplementation(() => {
      throw new Error("poisoned live createHash");
    });
    const update = vi.spyOn(hashPrototype, "update").mockImplementation(() => {
      throw new Error("poisoned live hash update");
    });
    const digest = vi.spyOn(hashPrototype, "digest").mockImplementation(() => {
      throw new Error("poisoned live hash digest");
    });
    const hexSlice = vi.spyOn(
      Buffer.prototype as Buffer & { hexSlice: () => string },
      "hexSlice",
    ).mockReturnValue("f".repeat(64));
    const priorToJson = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => ({}),
    });
    let preflight: ReturnType<
      typeof buildPermanentStagingProviderVariableTargetPreflight
    >;
    let postflight: ReturnType<
      typeof buildPermanentStagingProviderVariableTargetPostflight
    >;
    try {
      preflight = buildPermanentStagingProviderVariableTargetPreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: beforeVariables,
        deploymentInventory: deployments,
      });
      postflight = buildPermanentStagingProviderVariableTargetPostflight({
        preflight: contractPreflight,
        variableInventory: afterVariables,
        deploymentInventory: deployments,
      });
    } finally {
      if (priorToJson === undefined) {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      } else {
        Object.defineProperty(Object.prototype, "toJSON", priorToJson);
      }
      hexSlice.mockRestore();
      digest.mockRestore();
      update.mockRestore();
      createHash.mockRestore();
    }
    expect(preflight).toMatchObject({
      metadataInventorySha256: expectedBeforeVariables,
      deploymentInventorySha256: expectedDeployments,
    });
    expect(postflight).toMatchObject({
      beforeMetadataInventorySha256: expectedBeforeVariables,
      currentMetadataInventorySha256: expectedAfterVariables,
      beforeDeploymentInventorySha256: expectedDeployments,
      currentDeploymentInventorySha256: expectedDeployments,
    });
    expect(hexSlice).not.toHaveBeenCalled();
  });
});
