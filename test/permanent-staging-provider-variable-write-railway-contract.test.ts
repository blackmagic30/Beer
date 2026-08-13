import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK as LOCK,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_STATE,
  evaluatePermanentStagingProviderVariableCreatePostflight,
  evaluatePermanentStagingProviderVariableCreatePreflight,
  foldPermanentStagingProviderDeploymentInventoryPages,
  foldPermanentStagingProviderVariableInventoryPages,
  parsePermanentStagingProviderDeploymentInventoryPage,
  parsePermanentStagingProviderVariableInventoryPage,
  permanentStagingProviderVariableWriteRailwayContractInternals as internals,
  type PermanentStagingProviderDeploymentInventoryCandidate,
  type PermanentStagingProviderDeploymentInventoryPageCandidate,
  type PermanentStagingProviderDeploymentRowCandidate,
  type PermanentStagingProviderVariableCreatePreflightCandidate,
  type PermanentStagingProviderVariableInventoryCandidate,
  type PermanentStagingProviderVariableInventoryPageCandidate,
  type PermanentStagingProviderVariableRowCandidate,
} from "../scripts/lib/permanent-staging-provider-variable-write-railway-contract.js";

const OTHER_SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT_ID = "44444444-4444-4444-8444-444444444444";

function variableNode(
  overrides: Partial<{
    id: string;
    name: string;
    environmentId: string;
    serviceId: string | null;
    isSealed: boolean;
    references: unknown[];
  }> = {},
): Record<string, unknown> {
  return {
    id: "variable-database-url",
    name: "DATABASE_URL",
    environmentId: LOCK.stagingEnvironmentId,
    serviceId: LOCK.serviceId,
    isSealed: true,
    references: [],
    ...overrides,
  };
}

function variablePageSource(input: {
  nodes?: readonly Record<string, unknown>[];
  cursors?: readonly string[];
  hasNextPage?: boolean;
  endCursor?: string | null;
  environmentId?: string;
} = {}): string {
  const nodes = input.nodes ?? [variableNode()];
  const cursors = input.cursors ?? nodes.map((_node, index) => `variable-${index}`);
  const endCursor = input.endCursor === undefined
    ? (cursors.at(-1) ?? null)
    : input.endCursor;
  return JSON.stringify({
    data: {
      environment: {
        id: input.environmentId ?? LOCK.stagingEnvironmentId,
        variables: {
          edges: nodes.map((node, index) => ({
            cursor: cursors[index],
            node,
          })),
          pageInfo: {
            hasNextPage: input.hasNextPage ?? false,
            endCursor,
          },
        },
      },
    },
  });
}

function deploymentNode(
  overrides: Partial<{
    id: string;
    projectId: string;
    environmentId: string;
    serviceId: string;
    status: string;
    deploymentStopped: boolean;
    snapshotId: string | null;
  }> = {},
): Record<string, unknown> {
  return {
    id: DEPLOYMENT_ID,
    projectId: LOCK.projectId,
    environmentId: LOCK.stagingEnvironmentId,
    serviceId: LOCK.serviceId,
    status: "SUCCESS",
    deploymentStopped: false,
    snapshotId: SNAPSHOT_ID,
    ...overrides,
  };
}

function deploymentPageSource(input: {
  nodes?: readonly Record<string, unknown>[];
  cursors?: readonly string[];
  hasNextPage?: boolean;
  endCursor?: string | null;
} = {}): string {
  const nodes = input.nodes ?? [deploymentNode()];
  const cursors = input.cursors ?? nodes.map((_node, index) => `deployment-${index}`);
  const endCursor = input.endCursor === undefined
    ? (cursors.at(-1) ?? null)
    : input.endCursor;
  return JSON.stringify({
    data: {
      deployments: {
        edges: nodes.map((node, index) => ({
          cursor: cursors[index],
          node,
        })),
        pageInfo: {
          hasNextPage: input.hasNextPage ?? false,
          endCursor,
        },
      },
    },
  });
}

function parseVariablePage(input: {
  nodes?: readonly Record<string, unknown>[];
  cursors?: readonly string[];
  hasNextPage?: boolean;
  endCursor?: string | null;
  requestedAfter?: string | null;
} = {}): PermanentStagingProviderVariableInventoryPageCandidate {
  const parsed = parsePermanentStagingProviderVariableInventoryPage(
    variablePageSource(input),
    input.requestedAfter ?? null,
  );
  expect(parsed).not.toBeNull();
  return parsed!;
}

function parseDeploymentPage(input: {
  nodes?: readonly Record<string, unknown>[];
  cursors?: readonly string[];
  hasNextPage?: boolean;
  endCursor?: string | null;
  requestedAfter?: string | null;
} = {}): PermanentStagingProviderDeploymentInventoryPageCandidate {
  const parsed = parsePermanentStagingProviderDeploymentInventoryPage(
    deploymentPageSource(input),
    input.requestedAfter ?? null,
  );
  expect(parsed).not.toBeNull();
  return parsed!;
}

function variableInventory(
  nodes: readonly Record<string, unknown>[] = [variableNode()],
): PermanentStagingProviderVariableInventoryCandidate {
  const parsed = foldPermanentStagingProviderVariableInventoryPages([
    parseVariablePage({ nodes }),
  ]);
  expect(parsed).not.toBeNull();
  return parsed!;
}

function deploymentInventory(
  nodes: readonly Record<string, unknown>[] = [deploymentNode()],
): PermanentStagingProviderDeploymentInventoryCandidate {
  const parsed = foldPermanentStagingProviderDeploymentInventoryPages([
    parseDeploymentPage({ nodes }),
  ]);
  expect(parsed).not.toBeNull();
  return parsed!;
}

function exactPreflight(
  variables = variableInventory(),
  deployments = deploymentInventory(),
): PermanentStagingProviderVariableCreatePreflightCandidate {
  const result = evaluatePermanentStagingProviderVariableCreatePreflight({
    variableName: "OPENAI_API_KEY",
    variableInventory: variables,
    deploymentInventory: deployments,
  });
  expect(result).not.toBeNull();
  return result!;
}

function createdTarget(
  overrides: Partial<ReturnType<typeof variableNode>> = {},
): Record<string, unknown> {
  return variableNode({
    id: "variable-openai-api-key",
    name: "OPENAI_API_KEY",
    isSealed: false,
    references: [],
    ...overrides,
  });
}

describe("permanent staging provider-variable Railway contract", () => {
  it("is capability-pure and remains blocked on live fixtures", () => {
    const source = fs.readFileSync(path.resolve(
      "scripts/lib/permanent-staging-provider-variable-write-railway-contract.ts",
    ), "utf8");
    expect(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_STATE)
      .toBe("HARD_DISABLED_LIVE_FIXTURES_REQUIRED");
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("variableCollectionUpsert");
    expect(source).not.toContain("decryptVariables");
    expect(source).not.toContain("decryptedValue");
  });

  it("pins only the reviewed staging app target and four names", () => {
    expect(LOCK).toEqual({
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      productionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
      stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      allowedVariableNames: [
        "GOOGLE_MAPS_API_KEY",
        "GOOGLE_MAPS_MAP_ID",
        "GOOGLE_PLACES_API_KEY",
        "OPENAI_API_KEY",
      ],
      expectedIsSealed: false,
      expectedReferences: [],
    });
    expect(Object.isFrozen(LOCK)).toBe(true);
    expect(Object.isFrozen(LOCK.allowedVariableNames)).toBe(true);
    expect(Object.isFrozen(LOCK.expectedReferences)).toBe(true);
  });

  it("strictly parses and freezes a value-free variable page", () => {
    const page = parseVariablePage({
      nodes: [variableNode({
        references: [
          `${OTHER_SERVICE_ID}.POSTGRES_PASSWORD`,
          "PINTPATH_RUNTIME_DATABASE_URL",
        ],
      })],
      cursors: ["cursor-one"],
    });
    expect(page).toEqual({
      authority: "strict-json-candidate",
      environmentId: LOCK.stagingEnvironmentId,
      requestedAfter: null,
      edgeCursors: ["cursor-one"],
      rows: [{
        id: "variable-database-url",
        name: "DATABASE_URL",
        environmentId: LOCK.stagingEnvironmentId,
        serviceId: LOCK.serviceId,
        isSealed: true,
        references: [
          { serviceId: OTHER_SERVICE_ID, name: "POSTGRES_PASSWORD" },
          { serviceId: LOCK.serviceId, name: "PINTPATH_RUNTIME_DATABASE_URL" },
        ],
      }],
      hasNextPage: false,
      endCursor: "cursor-one",
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.rows)).toBe(true);
    expect(Object.isFrozen(page.rows[0])).toBe(true);
    expect(Object.isFrozen(page.rows[0]!.references)).toBe(true);
  });

  it.each([
    ["a value field", () => variablePageSource({
      nodes: [{ ...variableNode(), value: "forbidden-secret" }],
    })],
    ["a reordered node schema", () => variablePageSource({
      nodes: [{
        name: "DATABASE_URL",
        id: "variable-database-url",
        environmentId: LOCK.stagingEnvironmentId,
        serviceId: LOCK.serviceId,
        isSealed: true,
        references: [],
      }],
    })],
    ["an environment mismatch", () => variablePageSource({
      environmentId: LOCK.productionEnvironmentId,
    })],
    ["a row environment mismatch", () => variablePageSource({
      nodes: [variableNode({ environmentId: LOCK.productionEnvironmentId })],
    })],
    ["a duplicate reference", () => variablePageSource({
      nodes: [variableNode({ references: ["DATABASE_URL", "DATABASE_URL"] })],
    })],
    ["a shared bare reference", () => variablePageSource({
      nodes: [variableNode({ serviceId: null, references: ["DATABASE_URL"] })],
    })],
    ["a missing end cursor", () => variablePageSource({ endCursor: null })],
    ["an unrelated end cursor", () => variablePageSource({ endCursor: "other" })],
    ["a duplicate edge cursor", () => variablePageSource({
      nodes: [variableNode(), variableNode({ id: "second", name: "REDIS_URL" })],
      cursors: ["same", "same"],
      endCursor: "same",
    })],
    ["an errors envelope", () => JSON.stringify({
      errors: [{ message: "raw-provider-error" }],
      data: null,
    })],
    ["malformed JSON", () => "{"],
  ])("rejects variable metadata with %s", (_label, source) => {
    expect(parsePermanentStagingProviderVariableInventoryPage(source(), null))
      .toBeNull();
  });

  it("bounds variable pages, response bytes, and requested cursor provenance", () => {
    const nodes = Array.from({ length: internals.maxPageRows + 1 }, (_, index) =>
      variableNode({ id: `variable-${index}`, name: `VARIABLE_${index}` }));
    expect(parsePermanentStagingProviderVariableInventoryPage(
      variablePageSource({ nodes }),
      null,
    )).toBeNull();
    expect(parsePermanentStagingProviderVariableInventoryPage(
      "x".repeat(internals.maxResponseBytes + 1),
      null,
    )).toBeNull();
    expect(parsePermanentStagingProviderVariableInventoryPage(
      variablePageSource(),
      " cursor ",
    )).toBeNull();
  });

  it("strictly parses and freezes deployment authority rows", () => {
    const page = parseDeploymentPage();
    expect(page).toEqual({
      authority: "strict-json-candidate",
      requestedAfter: null,
      edgeCursors: ["deployment-0"],
      rows: [{
        id: DEPLOYMENT_ID,
        projectId: LOCK.projectId,
        environmentId: LOCK.stagingEnvironmentId,
        serviceId: LOCK.serviceId,
        status: "SUCCESS",
        deploymentStopped: false,
        snapshotId: SNAPSHOT_ID,
      }],
      hasNextPage: false,
      endCursor: "deployment-0",
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.rows[0])).toBe(true);
  });

  it.each([
    ["an extra field", deploymentNode({})],
    ["the wrong project", deploymentNode({ projectId: OTHER_SERVICE_ID })],
    ["the production environment", deploymentNode({
      environmentId: LOCK.productionEnvironmentId,
    })],
    ["another service", deploymentNode({ serviceId: OTHER_SERVICE_ID })],
    ["an unknown status", deploymentNode({ status: "MYSTERY" })],
    ["a malformed snapshot", deploymentNode({ snapshotId: "latest" })],
  ])("rejects deployment metadata with %s", (label, node) => {
    const candidate = label === "an extra field"
      ? { ...node, createdAt: "2026-08-11T00:00:00.000Z" }
      : node;
    expect(parsePermanentStagingProviderDeploymentInventoryPage(
      deploymentPageSource({ nodes: [candidate] }),
      null,
    )).toBeNull();
  });

  it("folds only a contiguous, terminal variable pagination sequence", () => {
    const first = parseVariablePage({
      nodes: [variableNode()],
      cursors: ["variables-1"],
      hasNextPage: true,
    });
    const second = parseVariablePage({
      nodes: [variableNode({ id: "variable-redis", name: "REDIS_URL" })],
      cursors: ["variables-2"],
      requestedAfter: "variables-1",
    });
    const inventory = foldPermanentStagingProviderVariableInventoryPages([
      first,
      second,
    ]);
    expect(inventory).toMatchObject({
      authority: "complete-pagination-candidate",
      environmentId: LOCK.stagingEnvironmentId,
      pageCount: 2,
      rowCount: 2,
    });
    expect(inventory?.rows.map((row) => row.name)).toEqual([
      "DATABASE_URL",
      "REDIS_URL",
    ]);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory?.rows)).toBe(true);

    expect(foldPermanentStagingProviderVariableInventoryPages([
      { ...first, hasNextPage: false },
      second,
    ])).toBeNull();
    expect(foldPermanentStagingProviderVariableInventoryPages([
      first,
      { ...second, requestedAfter: "wrong" },
    ])).toBeNull();
    expect(foldPermanentStagingProviderVariableInventoryPages([
      first,
      { ...second, edgeCursors: ["variables-1"], endCursor: "variables-1" },
    ])).toBeNull();
    expect(foldPermanentStagingProviderVariableInventoryPages([
      { ...first, requestedAfter: "unexpected" },
    ])).toBeNull();
    expect(foldPermanentStagingProviderVariableInventoryPages([
      { ...second, requestedAfter: null, hasNextPage: true },
    ])).toBeNull();
  });

  it("rejects duplicate IDs, tuples, sparse pages, and excessive page counts", () => {
    const duplicateId = parseVariablePage({
      nodes: [
        variableNode(),
        variableNode({ name: "REDIS_URL" }),
      ],
      cursors: ["one", "two"],
    });
    const duplicateTuple = parseVariablePage({
      nodes: [
        variableNode(),
        variableNode({ id: "other-id" }),
      ],
      cursors: ["one", "two"],
    });
    expect(foldPermanentStagingProviderVariableInventoryPages([duplicateId]))
      .toBeNull();
    expect(foldPermanentStagingProviderVariableInventoryPages([duplicateTuple]))
      .toBeNull();
    const sparse = new Array(1);
    expect(foldPermanentStagingProviderVariableInventoryPages(sparse)).toBeNull();
    expect(foldPermanentStagingProviderVariableInventoryPages(
      Array.from({ length: internals.maxPages + 1 }, () => parseVariablePage()),
    )).toBeNull();
  });

  it("folds deployment pages with the same exact pagination provenance", () => {
    const first = parseDeploymentPage({
      nodes: [deploymentNode()],
      cursors: ["deployments-1"],
      hasNextPage: true,
    });
    const second = parseDeploymentPage({
      nodes: [deploymentNode({ id: SECOND_DEPLOYMENT_ID, snapshotId: null })],
      cursors: ["deployments-2"],
      requestedAfter: "deployments-1",
    });
    const inventory = foldPermanentStagingProviderDeploymentInventoryPages([
      first,
      second,
    ]);
    expect(inventory).toMatchObject({
      authority: "complete-pagination-candidate",
      projectId: LOCK.projectId,
      environmentId: LOCK.stagingEnvironmentId,
      serviceId: LOCK.serviceId,
      pageCount: 2,
      rowCount: 2,
    });
    expect(inventory?.rows.map((row) => row.id)).toEqual([
      DEPLOYMENT_ID,
      SECOND_DEPLOYMENT_ID,
    ]);
    expect(foldPermanentStagingProviderDeploymentInventoryPages([
      first,
      { ...second, requestedAfter: "wrong" },
    ])).toBeNull();
    expect(foldPermanentStagingProviderDeploymentInventoryPages([
      first,
      { ...second, edgeCursors: ["deployments-1"], endCursor: "deployments-1" },
    ])).toBeNull();
  });

  it("accepts a create-only preflight only when the governed name is absent", () => {
    const preflight = exactPreflight();
    expect(preflight).toMatchObject({
      authority: "create-only-preflight-candidate",
      projectId: LOCK.projectId,
      environmentId: LOCK.stagingEnvironmentId,
      serviceId: LOCK.serviceId,
      variableName: "OPENAI_API_KEY",
      targetAbsent: true,
      noSharedOrForeignShadow: true,
    });
    expect(Object.isFrozen(preflight)).toBe(true);

    for (const serviceId of [LOCK.serviceId, null, OTHER_SERVICE_ID]) {
      expect(evaluatePermanentStagingProviderVariableCreatePreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: variableInventory([
          variableNode(),
          variableNode({
            id: `shadow-${serviceId ?? "shared"}`,
            name: "OPENAI_API_KEY",
            serviceId,
            isSealed: false,
          }),
        ]),
        deploymentInventory: deploymentInventory(),
      })).toBeNull();
    }
    expect(evaluatePermanentStagingProviderVariableCreatePreflight({
      variableName: "DATABASE_URL",
      variableInventory: variableInventory([]),
      deploymentInventory: deploymentInventory(),
    })).toBeNull();
  });

  it("proves exactly one new unsealed target row and a frozen deployment inventory", () => {
    const preflight = exactPreflight();
    const postflight = evaluatePermanentStagingProviderVariableCreatePostflight({
      preflight,
      variableInventory: variableInventory([
        variableNode(),
        createdTarget(),
      ]),
      deploymentInventory: deploymentInventory(),
    });
    expect(postflight).toEqual({
      authority: "create-only-postflight-candidate",
      projectId: LOCK.projectId,
      environmentId: LOCK.stagingEnvironmentId,
      serviceId: LOCK.serviceId,
      variableName: "OPENAI_API_KEY",
      variableId: "variable-openai-api-key",
      exactSingleCreate: true,
      priorVariablesUnchanged: true,
      deploymentInventoryUnchanged: true,
      expectedIsSealed: false,
      expectedReferences: [],
      beforeVariableRowCount: 1,
      afterVariableRowCount: 2,
      deploymentRowCount: 1,
    });
    expect(Object.isFrozen(postflight)).toBe(true);
  });

  it.each([
    ["sealed target", [variableNode(), createdTarget({ isSealed: true })]],
    ["referencing target", [
      variableNode(),
      createdTarget({ references: ["DATABASE_URL"] }),
    ]],
    ["shared target", [variableNode(), createdTarget({ serviceId: null })]],
    ["foreign target", [
      variableNode(),
      createdTarget({ serviceId: OTHER_SERVICE_ID }),
    ]],
    ["reused ID", [variableNode(), createdTarget({ id: "variable-database-url" })]],
    ["changed prior row", [
      variableNode({ isSealed: false }),
      createdTarget(),
    ]],
    ["unrelated extra row", [
      variableNode(),
      createdTarget(),
      variableNode({ id: "extra", name: "REDIS_URL" }),
    ]],
    ["second target shadow", [
      variableNode(),
      createdTarget(),
      createdTarget({ id: "second-target", serviceId: OTHER_SERVICE_ID }),
    ]],
  ])("rejects postflight variable drift: %s", (_label, nodes) => {
    const inventory = (() => {
      try {
        return variableInventory(nodes);
      } catch {
        return null;
      }
    })();
    if (inventory === null) return;
    expect(evaluatePermanentStagingProviderVariableCreatePostflight({
      preflight: exactPreflight(),
      variableInventory: inventory,
      deploymentInventory: deploymentInventory(),
    })).toBeNull();
  });

  it.each([
    ["status", [deploymentNode({ status: "FAILED" })]],
    ["stopped state", [deploymentNode({ deploymentStopped: true })]],
    ["snapshot", [deploymentNode({ snapshotId: null })]],
    ["addition", [
      deploymentNode(),
      deploymentNode({ id: SECOND_DEPLOYMENT_ID, snapshotId: null }),
    ]],
    ["removal", []],
  ])("rejects postflight deployment %s drift", (_label, nodes) => {
    expect(evaluatePermanentStagingProviderVariableCreatePostflight({
      preflight: exactPreflight(),
      variableInventory: variableInventory([
        variableNode(),
        createdTarget(),
      ]),
      deploymentInventory: deploymentInventory(nodes),
    })).toBeNull();
  });

  it("rejects accessor-backed candidates without invoking accessors", () => {
    const getter = vi.fn(() => "OPENAI_API_KEY");
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(input, {
      variableName: { enumerable: true, get: getter },
      variableInventory: { enumerable: true, value: variableInventory() },
      deploymentInventory: { enumerable: true, value: deploymentInventory() },
    });
    expect(evaluatePermanentStagingProviderVariableCreatePreflight(
      input as unknown as Parameters<
        typeof evaluatePermanentStagingProviderVariableCreatePreflight
      >[0],
    )).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("detaches data descriptors without invoking Proxy getters", () => {
    const target = {
      variableName: "OPENAI_API_KEY",
      variableInventory: variableInventory(),
      deploymentInventory: deploymentInventory(),
    };
    const getter = vi.fn(() => {
      throw new Error("proxy getter must not run");
    });
    const proxy = new Proxy(target, { get: getter });
    expect(evaluatePermanentStagingProviderVariableCreatePreflight(proxy))
      .not.toBeNull();
    expect(getter).not.toHaveBeenCalled();

    const ownKeys = vi.fn(() => {
      throw new Error("proxy ownKeys failure");
    });
    expect(evaluatePermanentStagingProviderVariableCreatePreflight(
      new Proxy(target, { ownKeys }),
    )).toBeNull();
    expect(ownKeys).toHaveBeenCalledTimes(1);
  });

  it("rejects forged complete inventories with inconsistent provenance", () => {
    const variables = variableInventory();
    const deployments = deploymentInventory();
    expect(evaluatePermanentStagingProviderVariableCreatePreflight({
      variableName: "OPENAI_API_KEY",
      variableInventory: { ...variables, pageCount: 2, rowCount: 0, rows: [] },
      deploymentInventory: deployments,
    })).toBeNull();
    expect(evaluatePermanentStagingProviderVariableCreatePreflight({
      variableName: "OPENAI_API_KEY",
      variableInventory: variables,
      deploymentInventory: {
        ...deployments,
        pageCount: 2,
        rowCount: 0,
        rows: [],
      },
    })).toBeNull();
  });

  it("rejects structurally exact markers without parser and folder lineage", () => {
    const parsedVariablePage = parseVariablePage({ nodes: [] });
    const parsedDeploymentPage = parseDeploymentPage();
    const forgedVariablePage = JSON.parse(JSON.stringify(parsedVariablePage));
    const forgedDeploymentPage = JSON.parse(JSON.stringify(parsedDeploymentPage));
    expect(foldPermanentStagingProviderVariableInventoryPages([
      forgedVariablePage,
    ])).toBeNull();
    expect(foldPermanentStagingProviderDeploymentInventoryPages([
      forgedDeploymentPage,
    ])).toBeNull();

    const variables = variableInventory([]);
    const deployments = deploymentInventory();
    expect(evaluatePermanentStagingProviderVariableCreatePreflight({
      variableName: "OPENAI_API_KEY",
      variableInventory: JSON.parse(JSON.stringify(variables)),
      deploymentInventory: deployments,
    })).toBeNull();
    expect(evaluatePermanentStagingProviderVariableCreatePreflight({
      variableName: "OPENAI_API_KEY",
      variableInventory: variables,
      deploymentInventory: JSON.parse(JSON.stringify(deployments)),
    })).toBeNull();
  });

  it("does not let a post-import global Array prototype lookup substitute a branded page", () => {
    const genuine = parseVariablePage({ nodes: [] });
    const unbranded = {
      ...genuine,
    } as PermanentStagingProviderVariableInventoryPageCandidate;
    const pages: PermanentStagingProviderVariableInventoryPageCandidate[] = [
      unbranded,
    ];
    const priorArray = Object.getOwnPropertyDescriptor(globalThis, "Array");
    const defineProperty = Object.defineProperty;
    let prototypeTraps = 0;
    const replacement = new Proxy(Array, {
      get(target, property, receiver) {
        if (property === "prototype") {
          prototypeTraps += 1;
          pages[0] = genuine;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let folded: PermanentStagingProviderVariableInventoryCandidate | null;
    try {
      defineProperty(globalThis, "Array", {
        configurable: true,
        value: replacement,
        writable: true,
      });
      folded = foldPermanentStagingProviderVariableInventoryPages(pages);
    } finally {
      if (priorArray === undefined) Reflect.deleteProperty(globalThis, "Array");
      else defineProperty(globalThis, "Array", priorArray);
    }
    expect(prototypeTraps).toBe(0);
    expect(pages[0]).toBe(unbranded);
    expect(folded).toBeNull();
  });

  it("does not let a post-import global Object prototype lookup make invalid evaluator input valid", () => {
    const input = {
      variableName: "ATTACKER_INVALID",
      variableInventory: variableInventory([]),
      deploymentInventory: deploymentInventory(),
    };
    const priorObject = Object.getOwnPropertyDescriptor(globalThis, "Object");
    const defineProperty = Object.defineProperty;
    let prototypeTraps = 0;
    const replacement = new Proxy(Object, {
      get(target, property, receiver) {
        if (property === "prototype") {
          prototypeTraps += 1;
          input.variableName = "OPENAI_API_KEY";
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let evaluated: PermanentStagingProviderVariableCreatePreflightCandidate
      | null;
    try {
      defineProperty(globalThis, "Object", {
        configurable: true,
        value: replacement,
        writable: true,
      });
      evaluated = evaluatePermanentStagingProviderVariableCreatePreflight(
        input,
      );
    } finally {
      if (priorObject === undefined) Reflect.deleteProperty(globalThis, "Object");
      else defineProperty(globalThis, "Object", priorObject);
    }
    expect(prototypeTraps).toBe(0);
    expect(input.variableName).toBe("ATTACKER_INVALID");
    expect(evaluated).toBeNull();
  });

  it("does not let a live String callable hide a sparse page behind a non-index property", () => {
    const genuine = parseVariablePage({ nodes: [] });
    const pages = new Array<
      PermanentStagingProviderVariableInventoryPageCandidate
    >(1);
    Object.defineProperty(pages, "4294967295", {
      configurable: true,
      enumerable: true,
      value: genuine,
      writable: true,
    });
    const priorString = Object.getOwnPropertyDescriptor(globalThis, "String");
    const defineProperty = Object.defineProperty;
    const exactString = String;
    let calls = 0;
    const replacement = (value: unknown): string => {
      calls += 1;
      return calls === 1
        ? "4294967295"
        : Reflect.apply(exactString, undefined, [value]) as string;
    };
    let folded: PermanentStagingProviderVariableInventoryCandidate | null;
    try {
      defineProperty(globalThis, "String", {
        configurable: true,
        value: replacement,
        writable: true,
      });
      folded = foldPermanentStagingProviderVariableInventoryPages(pages);
    } finally {
      if (priorString === undefined) Reflect.deleteProperty(globalThis, "String");
      else defineProperty(globalThis, "String", priorString);
    }
    expect(calls).toBe(0);
    expect(Object.hasOwn(pages, "0")).toBe(false);
    expect(Object.hasOwn(pages, "4294967295")).toBe(true);
    expect(folded).toBeNull();
  });

  it("rejects a hole plus junk key even when Object.prototype supplies a descriptor-shaped index", () => {
    const genuine = parseVariablePage({ nodes: [] });
    const pages = new Array<
      PermanentStagingProviderVariableInventoryPageCandidate
    >(1);
    Object.defineProperty(pages, "junk", {
      configurable: true,
      enumerable: true,
      value: genuine,
      writable: true,
    });
    const priorZero = Object.getOwnPropertyDescriptor(Object.prototype, "0");
    Object.defineProperty(Object.prototype, "0", {
      configurable: true,
      value: {
        enumerable: true,
        value: genuine,
      },
      writable: true,
    });
    let folded: PermanentStagingProviderVariableInventoryCandidate | null;
    try {
      folded = foldPermanentStagingProviderVariableInventoryPages(pages);
    } finally {
      if (priorZero === undefined) Reflect.deleteProperty(Object.prototype, "0");
      else Object.defineProperty(Object.prototype, "0", priorZero);
    }
    expect(Object.hasOwn(pages, "0")).toBe(false);
    expect(Object.hasOwn(pages, "junk")).toBe(true);
    expect(folded).toBeNull();
  });

  it("does not trust a poisoned live WeakSet lineage method", () => {
    const variables = variableInventory([]);
    const deployments = deploymentInventory();
    const has = vi.spyOn(WeakSet.prototype, "has").mockReturnValue(true);
    try {
      expect(evaluatePermanentStagingProviderVariableCreatePreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: variables,
        deploymentInventory: deployments,
      })).not.toBeNull();
      expect(evaluatePermanentStagingProviderVariableCreatePreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: { ...variables },
        deploymentInventory: deployments,
      })).toBeNull();
    } finally {
      has.mockRestore();
    }
  });

  it("does not let a poisoned Array.prototype.some hide an existing target", () => {
    const variables = variableInventory([
      variableNode(),
      createdTarget(),
    ]);
    const deployments = deploymentInventory();
    const originalSome = Array.prototype.some;
    let result: ReturnType<
      typeof evaluatePermanentStagingProviderVariableCreatePreflight
    >;
    Array.prototype.some = () => false;
    try {
      result = evaluatePermanentStagingProviderVariableCreatePreflight({
        variableName: "OPENAI_API_KEY",
        variableInventory: variables,
        deploymentInventory: deployments,
      });
    } finally {
      Array.prototype.some = originalSome;
    }
    expect(result!).toBeNull();
  });

  it("does not let a poisoned Map.get hide prior-variable drift", () => {
    const preflight = exactPreflight();
    const after = variableInventory([
      variableNode({ name: "MUTATED_PRIOR_VARIABLE" }),
      createdTarget(),
    ]);
    const deployments = deploymentInventory();
    const prior = preflight.variableInventory.rows[0]!;
    const originalGet = Map.prototype.get;
    let result: ReturnType<
      typeof evaluatePermanentStagingProviderVariableCreatePostflight
    >;
    Map.prototype.get = function (key: unknown) {
      if (key === prior.id) return prior;
      return Reflect.apply(originalGet, this, [key]);
    };
    try {
      result = evaluatePermanentStagingProviderVariableCreatePostflight({
        preflight,
        variableInventory: after,
        deploymentInventory: deployments,
      });
    } finally {
      Map.prototype.get = originalGet;
    }
    expect(result!).toBeNull();
  });

  it("does not let a poisoned Array species fabricate a target row", () => {
    const preflight = exactPreflight();
    const after = variableInventory([
      variableNode(),
      variableNode({ id: "variable-redis", name: "REDIS_URL" }),
    ]);
    const deployments = deploymentInventory();
    const priorSpecies = Object.getOwnPropertyDescriptor(Array, Symbol.species);
    Object.defineProperty(Array, Symbol.species, {
      configurable: true,
      value: function () {
        return [createdTarget()];
      },
    });
    let result: ReturnType<
      typeof evaluatePermanentStagingProviderVariableCreatePostflight
    >;
    try {
      result = evaluatePermanentStagingProviderVariableCreatePostflight({
        preflight,
        variableInventory: after,
        deploymentInventory: deployments,
      });
    } finally {
      if (priorSpecies === undefined) {
        delete (Array as { [Symbol.species]?: unknown })[Symbol.species];
      } else {
        Object.defineProperty(Array, Symbol.species, priorSpecies);
      }
    }
    expect(result!).toBeNull();
  });

  it("does not let an inherited numeric setter replace a target row", () => {
    const preflight = exactPreflight();
    const foreignTarget = createdTarget({ serviceId: OTHER_SERVICE_ID });
    const after = variableInventory([
      variableNode(),
      foreignTarget,
    ]);
    const deployments = deploymentInventory();
    const priorIndex = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      set() {
        Object.defineProperty(this, "0", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: createdTarget({ id: "fabricated-openai" }),
        });
      },
    });
    let result: ReturnType<
      typeof evaluatePermanentStagingProviderVariableCreatePostflight
    >;
    try {
      result = evaluatePermanentStagingProviderVariableCreatePostflight({
        preflight,
        variableInventory: after,
        deploymentInventory: deployments,
      });
    } finally {
      if (priorIndex === undefined) {
        delete (Array.prototype as unknown as Record<string, unknown>)["0"];
      } else {
        Object.defineProperty(Array.prototype, "0", priorIndex);
      }
    }
    expect(result!).toBeNull();
  });

  it("does not trust a poisoned live RegExp.exec for strict row schemas", () => {
    const malformedVariables = variablePageSource({
      nodes: [variableNode({
        name: "lower case name",
        serviceId: "not-a-uuid",
      })],
    });
    const malformedDeployments = deploymentPageSource({
      nodes: [deploymentNode({
        id: "not-a-uuid",
        snapshotId: "not-a-uuid",
      })],
    });
    const exec = vi.spyOn(RegExp.prototype, "exec").mockReturnValue([
      "fabricated-match",
    ] as unknown as RegExpExecArray);
    let variables: ReturnType<
      typeof parsePermanentStagingProviderVariableInventoryPage
    >;
    let deployments: ReturnType<
      typeof parsePermanentStagingProviderDeploymentInventoryPage
    >;
    try {
      variables = parsePermanentStagingProviderVariableInventoryPage(
        malformedVariables,
        null,
      );
      deployments = parsePermanentStagingProviderDeploymentInventoryPage(
        malformedDeployments,
        null,
      );
    } finally {
      exec.mockRestore();
    }
    expect(variables!).toBeNull();
    expect(deployments!).toBeNull();
  });

  it("never exposes a value-shaped field in candidates", () => {
    const preflight = exactPreflight();
    const postflight = evaluatePermanentStagingProviderVariableCreatePostflight({
      preflight,
      variableInventory: variableInventory([variableNode(), createdTarget()]),
      deploymentInventory: deploymentInventory(),
    });
    for (const candidate of [
      preflight.variableInventory,
      preflight.deploymentInventory,
      preflight,
      postflight,
    ]) {
      expect(JSON.stringify(candidate)).not.toContain("forbidden-secret");
      expect(JSON.stringify(candidate)).not.toMatch(/"(?:value|decryptedValue)":/);
    }
  });
});
