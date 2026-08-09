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

async function runWithInventory(inventory: VariableFixture[]) {
  const output: string[] = [];
  const code = await runRailwaySealedVariableReadiness({
    argv: ["--policy", "fixture-policy.json"],
    readPolicy: () => JSON.stringify(policyFixture()),
    queryMetadataPage: async () => ({
      environmentId: ENVIRONMENT_ID,
      variables: inventory,
      hasNextPage: false,
      endCursor: null,
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
        return {
          environmentId: ENVIRONMENT_ID,
          variables: firstPage ? inventory.slice(0, 100) : inventory.slice(100),
          hasNextPage: firstPage,
          endCursor: firstPage ? "cursor-100" : null,
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
          forbiddenServicesAbsent: true,
        },
      })}\n`,
    );
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
            pageInfo: { hasNextPage: false, endCursor: null },
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

  it("fails with a fixed receipt on malformed pages, cursor loops, and raw errors", async () => {
    const sensitive = "postgresql://secret@private.internal/pintpath";
    const cases = [
      vi.fn(async () => {
        throw new Error(sensitive);
      }),
      vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        variables: [],
        hasNextPage: true,
        endCursor: "same-cursor",
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
          name: "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
        }),
        expect.objectContaining({
          serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
          name: "SOURCE_EVIDENCE_SIGNING_SECRET",
        }),
      ]),
    });
    const parsed = JSON.parse(source) as { variables: unknown[] };
    expect(parsed.variables).toHaveLength(14);
  });
});
