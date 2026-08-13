import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  RAILWAY_SEALED_VARIABLE_RECEIPT_SCHEMA,
  RAILWAY_VARIABLE_METADATA_QUERY,
  railwaySealedVariableReadinessInternals,
  runRailwaySealedVariableReadiness,
} from "../scripts/railway-sealed-variable-readiness.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_A = "33333333-3333-4333-8333-333333333333";
const SERVICE_B = "44444444-4444-4444-8444-444444444444";
const FORBIDDEN_SERVICE = "55555555-5555-4555-8555-555555555555";

interface ReferenceFixture {
  serviceId: string;
  name: string;
}

interface VariableFixture {
  id: string;
  name: string;
  environmentId: string;
  serviceId: string | null;
  isSealed: boolean;
  references: ReferenceFixture[];
}

function policyFixture(): Record<string, unknown> {
  return {
    schemaVersion: "pintpath-railway-sealed-variable-policy/v1",
    policyId: "permanent-staging-post-rotation",
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    variables: [
      {
        serviceId: SERVICE_A,
        name: "SOURCE_SECRET",
        isSealed: true,
        references: [],
      },
      {
        serviceId: SERVICE_A,
        name: "DERIVED_SECRET",
        isSealed: true,
        references: [{ serviceId: SERVICE_A, name: "SOURCE_SECRET" }],
      },
      {
        serviceId: SERVICE_B,
        name: "CONSUMER_SECRET",
        isSealed: true,
        references: [{ serviceId: SERVICE_A, name: "DERIVED_SECRET" }],
      },
    ],
    forbiddenVariableNames: ["FORBIDDEN_SECRET"],
    forbiddenServiceIds: [FORBIDDEN_SERVICE],
  };
}

function governedInventory(): VariableFixture[] {
  return [
    {
      id: "variable-source",
      name: "SOURCE_SECRET",
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_A,
      isSealed: true,
      references: [],
    },
    {
      id: "variable-derived",
      name: "DERIVED_SECRET",
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_A,
      isSealed: true,
      references: [{ serviceId: SERVICE_A, name: "SOURCE_SECRET" }],
    },
    {
      id: "variable-consumer",
      name: "CONSUMER_SECRET",
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_B,
      isSealed: true,
      references: [{ serviceId: SERVICE_A, name: "DERIVED_SECRET" }],
    },
  ];
}

function unrelatedInventory(count: number): VariableFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `unrelated-${index}`,
    name: `UNRELATED_${index}`,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_B,
    isSealed: false,
    references: [],
  }));
}

function metadataPageSource(
  edgeCursors: readonly string[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      environment: {
        id: ENVIRONMENT_ID,
        variables: {
          edges: edgeCursors.map((cursor, index) => ({
            cursor,
            node: {
              id: `metadata-variable-${index}`,
              name: `UNRELATED_${index}`,
              environmentId: ENVIRONMENT_ID,
              serviceId: SERVICE_B,
              isSealed: false,
              references: [],
            },
          })),
          pageInfo,
        },
      },
    },
  });
}

async function runWithInventory(inventory: VariableFixture[]) {
  const output: string[] = [];
  const edgeCursors = inventory.map((_variable, index) => `cursor-${index + 1}`);
  const code = await runRailwaySealedVariableReadiness({
    argv: ["--policy", "fixture-policy.json"],
    readPolicy: () => JSON.stringify(policyFixture()),
    queryMetadataPage: async () => ({
      environmentId: ENVIRONMENT_ID,
      variables: inventory,
      edgeCursors,
      hasNextPage: false,
      endCursor: edgeCursors.at(-1) ?? null,
      requestedAfter: null,
    }),
    writeOutput: (line) => output.push(line),
  });
  expect(output).toHaveLength(1);
  expect(output[0]!.endsWith("\n")).toBe(true);
  return {
    code,
    output: output[0]!,
    receipt: JSON.parse(output[0]!) as {
      schemaVersion: string;
      policy: string;
      mode: string;
      outcome: string;
      checks: Record<string, boolean>;
    },
  };
}

describe("Railway sealed-variable readiness", () => {
  it("paginates a complete inventory beyond 100 rows and emits one canonical passing receipt", async () => {
    const inventory = [...unrelatedInventory(101), ...governedInventory()];
    const calls: Array<{ projectId: string; environmentId: string; after: string | null }> = [];
    const output: string[] = [];
    const code = await runRailwaySealedVariableReadiness({
      argv: ["--policy", "fixture-policy.json"],
      readPolicy: () => JSON.stringify(policyFixture()),
      queryMetadataPage: async (variables) => {
        calls.push(variables);
        const firstPage = variables.after === null;
        const pageVariables = firstPage
          ? inventory.slice(0, 100)
          : inventory.slice(100);
        const cursorOffset = firstPage ? 0 : 100;
        const edgeCursors = pageVariables.map(
          (_variable, index) => `cursor-${cursorOffset + index + 1}`,
        );
        return {
          environmentId: ENVIRONMENT_ID,
          variables: pageVariables,
          edgeCursors,
          hasNextPage: firstPage,
          endCursor: edgeCursors.at(-1) ?? null,
          requestedAfter: variables.after,
        };
      },
      writeOutput: (line) => output.push(line),
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID, after: null },
      {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        after: "cursor-100",
      },
    ]);
    expect(output).toHaveLength(1);
    expect(output[0]).toBe(
      `${JSON.stringify({
        schemaVersion: RAILWAY_SEALED_VARIABLE_RECEIPT_SCHEMA,
        policy: "permanent-staging-post-rotation",
        mode: "post-seal",
        outcome: "passed",
        checks: {
          policyValid: true,
          metadataQuerySafe: true,
          completeInventory: true,
          environmentExact: true,
          uniqueRows: true,
          exactScope: true,
          allSealed: true,
          exactReferences: true,
          noSharedShadows: true,
          forbiddenVariablesAbsent: true,
          forbiddenServicesAbsent: true,
        },
      })}\n`,
    );
  });

  it("accepts an empty final page only when it is bound to the full page cursor", async () => {
    const inventory = [...unrelatedInventory(97), ...governedInventory()];
    const edgeCursors = inventory.map((_variable, index) => `cursor-${index + 1}`);
    const calls: Array<string | null> = [];
    const output: string[] = [];
    const code = await runRailwaySealedVariableReadiness({
      argv: ["--policy", "fixture-policy.json"],
      readPolicy: () => JSON.stringify(policyFixture()),
      queryMetadataPage: async (variables) => {
        calls.push(variables.after);
        if (variables.after === null) {
          return {
            environmentId: ENVIRONMENT_ID,
            variables: inventory,
            edgeCursors,
            hasNextPage: true,
            endCursor: "cursor-100",
            requestedAfter: null,
          };
        }
        return {
          environmentId: ENVIRONMENT_ID,
          variables: [],
          edgeCursors: [],
          hasNextPage: false,
          endCursor: null,
          requestedAfter: variables.after,
        };
      },
      writeOutput: (line) => output.push(line),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([null, "cursor-100"]);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: "passed" });
  });

  it.each([
    [
      "a missing governed row",
      () => governedInventory().slice(1),
      "exactScope",
    ],
    [
      "an extra service shadow",
      () => [
        ...governedInventory(),
        { ...governedInventory()[0]!, id: "shadow", serviceId: SERVICE_B },
      ],
      "exactScope",
    ],
    [
      "a shared shadow",
      () => [
        ...governedInventory(),
        { ...governedInventory()[0]!, id: "shared", serviceId: null },
      ],
      "noSharedShadows",
    ],
    [
      "an unsealed governed row",
      () => [
        { ...governedInventory()[0]!, isSealed: false },
        ...governedInventory().slice(1),
      ],
      "allSealed",
    ],
    [
      "reference drift",
      () => [
        governedInventory()[0]!,
        { ...governedInventory()[1]!, references: [] },
        governedInventory()[2]!,
      ],
      "exactReferences",
    ],
    [
      "duplicate variable ids",
      () => [
        governedInventory()[0]!,
        { ...governedInventory()[1]!, id: governedInventory()[0]!.id },
        governedInventory()[2]!,
      ],
      "uniqueRows",
    ],
    [
      "a distinct-id duplicate tuple hiding a missing governed row",
      () => [
        governedInventory()[0]!,
        { ...governedInventory()[0]!, id: "duplicate-tuple" },
        governedInventory()[2]!,
      ],
      "exactScope",
    ],
    [
      "a forbidden variable name",
      () => [
        ...governedInventory(),
        {
          ...unrelatedInventory(1)[0]!,
          id: "forbidden-variable-row",
          name: "FORBIDDEN_SECRET",
        },
      ],
      "forbiddenVariablesAbsent",
    ],
    [
      "a forbidden retired service",
      () => [
        ...governedInventory(),
        {
          ...unrelatedInventory(1)[0]!,
          id: "forbidden-row",
          serviceId: FORBIDDEN_SERVICE,
        },
      ],
      "forbiddenServicesAbsent",
    ],
    [
      "a row from another environment",
      () => [
        {
          ...governedInventory()[0]!,
          environmentId: "66666666-6666-4666-8666-666666666666",
        },
        ...governedInventory().slice(1),
      ],
      "environmentExact",
    ],
  ])("fails closed on %s", async (_label, mutate, failedCheck) => {
    const result = await runWithInventory(mutate());
    expect(result.code).toBe(1);
    expect(result.receipt.outcome).toBe("failed");
    expect(result.receipt.checks[failedCheck]).toBe(false);
  });

  it("requires unique provider ids and unique service/name tuples", async () => {
    const source = governedInventory()[0]!;
    const result = await runWithInventory([
      source,
      { ...source, id: "distinct-id-same-tuple" },
      governedInventory()[2]!,
    ]);

    expect(result.receipt.checks).toMatchObject({
      uniqueRows: false,
      exactScope: false,
    });
  });

  it("normalizes only confirmed bare and service-qualified reference strings", () => {
    const source = JSON.stringify({
      data: {
        environment: {
          id: ENVIRONMENT_ID,
          variables: {
            edges: [
              {
                cursor: "cursor-1",
                node: {
                  id: "variable-1",
                  name: "DERIVED_SECRET",
                  environmentId: ENVIRONMENT_ID,
                  serviceId: SERVICE_A,
                  isSealed: true,
                  references: [
                    "SOURCE_SECRET",
                    `${SERVICE_B}.CONSUMER_SECRET`,
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: "cursor-1" },
          },
        },
      },
    });
    expect(
      railwaySealedVariableReadinessInternals.parseMetadataPage(source),
    ).toMatchObject({
      variables: [
        {
          references: [
            { serviceId: SERVICE_A, name: "SOURCE_SECRET" },
            { serviceId: SERVICE_B, name: "CONSUMER_SECRET" },
          ],
        },
      ],
    });

    for (const invalid of [
      "service-name.SOURCE_SECRET",
      `${SERVICE_A}.SOURCE_SECRET.extra`,
      "${{Postgres.SOURCE_SECRET}}",
      "lowercase",
    ]) {
      const malformed = source.replace(
        `\"${SERVICE_B}.CONSUMER_SECRET\"`,
        JSON.stringify(invalid),
      );
      expect(
        railwaySealedVariableReadinessInternals.parseMetadataPage(malformed),
      ).toBeNull();
    }
  });

  it("binds every metadata page to a bounded unique edge-cursor sequence", () => {
    expect(
      railwaySealedVariableReadinessInternals.parseMetadataPage(
        metadataPageSource(
          ["cursor-1", "cursor-2"],
          { hasNextPage: true, endCursor: "cursor-2" },
        ),
        "prior-page-cursor",
      ),
    ).toMatchObject({
      edgeCursors: ["cursor-1", "cursor-2"],
      hasNextPage: true,
      endCursor: "cursor-2",
      requestedAfter: "prior-page-cursor",
    });

    for (const malformed of [
      metadataPageSource(
        ["cursor-1"],
        { hasNextPage: true, endCursor: "different-cursor" },
      ),
      metadataPageSource(
        ["duplicate", "duplicate"],
        { hasNextPage: true, endCursor: "duplicate" },
      ),
      metadataPageSource(
        [],
        { hasNextPage: true, endCursor: "empty-page-cursor" },
      ),
      metadataPageSource(
        ["cursor-1"],
        { hasNextPage: false, endCursor: null },
      ),
      metadataPageSource(
        Array.from({ length: 101 }, (_value, index) => `cursor-${index}`),
        { hasNextPage: false, endCursor: "cursor-100" },
      ),
    ]) {
      expect(
        railwaySealedVariableReadinessInternals.parseMetadataPage(malformed),
      ).toBeNull();
    }
  });

  it("fails with a fixed receipt on malformed pages, cursor loops, and raw errors", async () => {
    const sensitive = "postgresql://secret@private.internal/pintpath";
    const cases = [
      vi.fn(async () => {
        throw new Error(sensitive);
      }),
      vi.fn(async (variables: { after: string | null }) => ({
        environmentId: ENVIRONMENT_ID,
        variables: unrelatedInventory(1),
        edgeCursors: ["same-cursor"],
        hasNextPage: true,
        endCursor: "same-cursor",
        requestedAfter: variables.after,
      })),
    ];

    for (const queryMetadataPage of cases) {
      const output: string[] = [];
      const code = await runRailwaySealedVariableReadiness({
        argv: ["--policy", "fixture-policy.json"],
        readPolicy: () => JSON.stringify(policyFixture()),
        queryMetadataPage,
        writeOutput: (line) => output.push(line),
      });
      expect(code).toBe(1);
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain(sensitive);
      expect(JSON.parse(output[0]!)).toMatchObject({
        policy: "permanent-staging-post-rotation",
        mode: "post-seal",
        outcome: "failed",
        checks: { completeInventory: false },
      });
    }
  });

  it("fails closed when a page is not bound to the requested after cursor", async () => {
    const output: string[] = [];
    const code = await runRailwaySealedVariableReadiness({
      argv: ["--policy", "fixture-policy.json"],
      readPolicy: () => JSON.stringify(policyFixture()),
      queryMetadataPage: async () => ({
        environmentId: ENVIRONMENT_ID,
        variables: governedInventory(),
        edgeCursors: ["cursor-1", "cursor-2", "cursor-3"],
        hasNextPage: false,
        endCursor: "cursor-3",
        requestedAfter: "not-the-requested-cursor",
      }),
      writeOutput: (line) => output.push(line),
    });
    expect(code).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed",
      checks: { completeInventory: false },
    });
  });

  it("contains every fulfilled runtime-malformed dependency page", async () => {
    const sensitive = "sensitive-environmentId";
    const basePage = {
      environmentId: ENVIRONMENT_ID,
      variables: governedInventory(),
      edgeCursors: ["cursor-1", "cursor-2", "cursor-3"],
      hasNextPage: false,
      endCursor: "cursor-3",
      requestedAfter: null,
    };
    const malformed: unknown[] = [
      null,
      undefined,
      {
        ...basePage,
        variables: [null],
        edgeCursors: ["cursor-1"],
        endCursor: "cursor-1",
      },
      {
        ...basePage,
        variables: [{ ...governedInventory()[0]!, references: null }],
        edgeCursors: ["cursor-1"],
        endCursor: "cursor-1",
      },
      new Proxy(basePage, {
        get(target, property, receiver) {
          if (property === "environmentId") throw new Error(sensitive);
          return Reflect.get(target, property, receiver);
        },
      }),
    ];
    for (const candidate of malformed) {
      const output: string[] = [];
      await expect(runRailwaySealedVariableReadiness({
        argv: ["--policy", "fixture-policy.json"],
        readPolicy: () => JSON.stringify(policyFixture()),
        queryMetadataPage: async () => candidate as never,
        writeOutput: (line) => output.push(line),
      })).resolves.toBe(1);
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain(sensitive);
      expect(JSON.parse(output[0]!)).toMatchObject({
        outcome: "failed",
        checks: { completeInventory: false },
      });
    }
  });

  it("rejects noncanonical policy input before querying metadata", async () => {
    const queryMetadataPage = vi.fn();
    const output: string[] = [];
    const malformed = { ...policyFixture(), unexpected: "do-not-forward" };
    const code = await runRailwaySealedVariableReadiness({
      argv: ["--policy", "fixture-policy.json"],
      readPolicy: () => JSON.stringify(malformed),
      queryMetadataPage,
      writeOutput: (line) => output.push(line),
    });
    expect(code).toBe(1);
    expect(queryMetadataPage).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({
      policy: "invalid",
      mode: "invalid",
      outcome: "failed",
    });
    expect(output[0]).not.toContain("do-not-forward");
  });

  it("uses only paginated non-value metadata and a project-scoped API token", async () => {
    expect(RAILWAY_VARIABLE_METADATA_QUERY).toContain("first: 100");
    expect(RAILWAY_VARIABLE_METADATA_QUERY).toContain("after: $after");
    expect(RAILWAY_VARIABLE_METADATA_QUERY).toContain("isSealed");
    expect(RAILWAY_VARIABLE_METADATA_QUERY).toContain("references");
    expect(RAILWAY_VARIABLE_METADATA_QUERY).not.toMatch(/\bvalue\b/);
    expect(RAILWAY_VARIABLE_METADATA_QUERY).not.toContain("decryptVariables");
    expect(
      railwaySealedVariableReadinessInternals.queryIsMetadataOnly(
        RAILWAY_VARIABLE_METADATA_QUERY,
      ),
    ).toBe(true);
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "Content-Type": "application/json",
        "Project-Access-Token": "synthetic-project-token",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        operationName: "PintPathRailwayVariableMetadata",
        query: RAILWAY_VARIABLE_METADATA_QUERY,
        variables: {
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          after: null,
        },
      });
      return new Response(
        JSON.stringify({
          data: {
            environment: {
              id: ENVIRONMENT_ID,
              variables: {
                edges: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    await expect(
      railwaySealedVariableReadinessInternals.defaultQueryMetadataPage(
        {
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          after: null,
        },
        {
          PINTPATH_RAILWAY_METADATA_TOKEN: "synthetic-project-token",
          DATABASE_URL: "must-not-reach-request",
          SUPABASE_SERVICE_ROLE_KEY: "must-not-reach-request",
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ environmentId: ENVIRONMENT_ID, variables: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://backboard.railway.com/graphql/v2",
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });

  it("bounds a chunked decoded body before parsing and cancels on overflow", async () => {
    const maximumBytes = 1024 * 1024;
    const chunkBytes = 64 * 1024;
    let bytesProduced = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bytesProduced += chunkBytes;
          controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
        },
        cancel() {
          cancellations += 1;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      railwaySealedVariableReadinessInternals.defaultQueryMetadataPage(
        {
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          after: null,
        },
        { PINTPATH_RAILWAY_METADATA_TOKEN: "synthetic-project-token" },
        fetchImpl,
      ),
    ).rejects.toThrow("metadata_query_failed");
    await vi.waitFor(() => expect(cancellations).toBe(1));
    expect(bytesProduced).toBeGreaterThan(maximumBytes);
    expect(bytesProduced).toBeLessThanOrEqual(maximumBytes + chunkBytes);
  });

  it("uses fatal UTF-8 decoding and cancels without waiting for stream completion", async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0xff]));
      },
      cancel() {
        cancellations += 1;
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      railwaySealedVariableReadinessInternals.defaultQueryMetadataPage(
        {
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          after: null,
        },
        { PINTPATH_RAILWAY_METADATA_TOKEN: "synthetic-project-token" },
        fetchImpl,
      ),
    ).rejects.toThrow("metadata_query_failed");
    await vi.waitFor(() => expect(cancellations).toBe(1));
  });

  it.each([
    ["a non-OK response", { status: 503 }],
    [
      "an oversized declared response",
      { status: 200, headers: { "Content-Length": "1048577" } },
    ],
  ])("cancels %s with one fixed failure", async (_label, responseInit) => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0x7b]));
      },
      cancel() {
        cancellations += 1;
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(body, responseInit),
    ) as unknown as typeof fetch;
    await expect(
      railwaySealedVariableReadinessInternals.defaultQueryMetadataPage(
        {
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          after: null,
        },
        { PINTPATH_RAILWAY_METADATA_TOKEN: "synthetic-project-token" },
        fetchImpl,
      ),
    ).rejects.toThrow("metadata_query_failed");
    await vi.waitFor(() => expect(cancellations).toBe(1));
  });

  it.each(["fetch", "body"])(
    "enforces one abort deadline across a stalled %s",
    async (stall) => {
      vi.useFakeTimers();
      try {
        let capturedSignal: AbortSignal | null = null;
        let cancellations = 0;
        const fetchImpl = vi.fn(
          async (_input: string | URL | Request, init?: RequestInit) => {
            capturedSignal = init?.signal as AbortSignal;
            if (stall === "fetch") {
              return await new Promise<Response>(() => undefined);
            }
            return new Response(new ReadableStream<Uint8Array>({
              cancel() {
                cancellations += 1;
              },
            }), { status: 200 });
          },
        ) as typeof fetch;
        const pending = railwaySealedVariableReadinessInternals
          .defaultQueryMetadataPage(
            {
              projectId: PROJECT_ID,
              environmentId: ENVIRONMENT_ID,
              after: null,
            },
            { PINTPATH_RAILWAY_METADATA_TOKEN: "synthetic-project-token" },
            fetchImpl,
          );
        const rejected = expect(pending).rejects.toThrow(
          "metadata_query_failed",
        );
        await vi.advanceTimersByTimeAsync(20_000);
        await rejected;
        expect(capturedSignal?.aborted).toBe(true);
        if (stall === "body") expect(cancellations).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps the query deadline referenced while fetch is pending", async () => {
    let releaseFetch: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        await new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        }),
    ) as typeof fetch;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const response = new Response(
      metadataPageSource([], { hasNextPage: false, endCursor: null }),
      { status: 200 },
    );
    const pending = railwaySealedVariableReadinessInternals
      .defaultQueryMetadataPage(
        {
          projectId: PROJECT_ID,
          environmentId: ENVIRONMENT_ID,
          after: null,
        },
        { PINTPATH_RAILWAY_METADATA_TOKEN: "synthetic-project-token" },
        fetchImpl,
      );
    try {
      const deadline = setTimeoutSpy.mock.results[0]?.value as
        ReturnType<typeof setTimeout> & { hasRef?: () => boolean };
      expect(deadline).toBeDefined();
      expect(deadline.hasRef?.()).toBe(true);
      releaseFetch?.(response);
      await expect(pending).resolves.toMatchObject({
        environmentId: ENVIRONMENT_ID,
        requestedAfter: null,
      });
    } finally {
      releaseFetch?.(response);
      setTimeoutSpy.mockRestore();
    }
  });

  it("accepts the checked-in nonsecret policy and covers the selected populated rows", () => {
    const policyPath = path.resolve(
      "ops/railway/permanent-staging-sealed-variable-policy.json",
    );
    const source = fs.readFileSync(policyPath, "utf8");
    expect(source).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(source).not.toMatch(/redis(?:s)?:\/\//i);
    expect(
      railwaySealedVariableReadinessInternals.parsePolicy(source),
    ).toMatchObject({
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
      variables: expect.arrayContaining([
        expect.objectContaining({
          serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
          name: "SUPABASE_SERVICE_ROLE_KEY",
        }),
        expect.objectContaining({
          serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
          name: "SOURCE_EVIDENCE_SIGNING_SECRET",
        }),
      ]),
      forbiddenVariableNames: [
        "OFFSITE_BACKUP_SUPABASE_URL",
        "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
        "OFFSITE_BACKUP_BUCKET",
      ],
    });
    const parsed = JSON.parse(source) as { variables: unknown[] };
    expect(parsed.variables).toHaveLength(13);
  });
});
