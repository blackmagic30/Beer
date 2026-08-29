import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  protectedRuntimeVariableInternals,
  runProtectedRuntimeVariableUpsert,
} from "../scripts/execute-protected-runtime-variable-upsert.js";

const PROJECT = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const POSTGRES_SERVICE = "c454955f-263b-4599-aee0-dc447a4d3d15";
const CANDIDATE = "a".repeat(40);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function scope(): Response {
  return json({
    data: { projectToken: { projectId: PROJECT, environmentId: ENVIRONMENT } },
  });
}

function applicationServiceInstance(
  deploymentId = "deployment",
  status = "SUCCESS",
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    serviceId: SERVICE,
    environmentId: ENVIRONMENT,
    latestDeployment: { id: deploymentId, status },
    activeDeployments: [{ id: deploymentId, status }],
  };
}

function postgresServiceInstance() {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    serviceId: POSTGRES_SERVICE,
    environmentId: ENVIRONMENT,
    latestDeployment: { id: "postgres-deployment", status: "SUCCESS" },
    activeDeployments: [{ id: "postgres-deployment", status: "SUCCESS" }],
  };
}

function metadata(hasVariable: boolean): Response {
  const edges = hasVariable
    ? [
        {
          node: {
            id: "runtime-variable-row",
            name: "DATABASE_MAINTENANCE_URL",
            environmentId: ENVIRONMENT,
            serviceId: SERVICE,
            isSealed: true,
            references: [],
          },
        },
      ]
    : [];
  return json({
    data: {
      environment: {
        id: ENVIRONMENT,
        variables: { edges, pageInfo: { hasNextPage: false, endCursor: null } },
      },
      staged: { environmentId: ENVIRONMENT, patch: {} },
      targetServiceInstance: applicationServiceInstance(),
      applicationServiceInstance: applicationServiceInstance(),
    },
  });
}

function postgresRuntimeMetadata(
  applicationInstance = applicationServiceInstance(),
): Response {
  return json({
    data: {
      environment: {
        id: ENVIRONMENT,
        variables: {
          edges: [{
            node: {
              id: "postgres-runtime-url-row",
              name: "PINTPATH_RUNTIME_DATABASE_URL",
              environmentId: ENVIRONMENT,
              serviceId: POSTGRES_SERVICE,
              isSealed: false,
              references: [
                "PGPORT",
                "PINTPATH_RUNTIME_PASSWORD",
                "RAILWAY_PRIVATE_DOMAIN",
              ],
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      staged: { environmentId: ENVIRONMENT, patch: {} },
      targetServiceInstance: postgresServiceInstance(),
      applicationServiceInstance: applicationInstance,
    },
  });
}

describe("protected runtime-variable upsert", () => {
  it("allows the fixed source URL only on the permanent-staging PostgreSQL service", () => {
    expect(
      protectedRuntimeVariableInternals.targetVariableExact(
        "permanent-staging-postgres",
        "PINTPATH_RUNTIME_DATABASE_URL",
      ),
    ).toBe(true);
    expect(
      protectedRuntimeVariableInternals.targetVariableExact(
        "production",
        "PINTPATH_RUNTIME_DATABASE_URL",
      ),
    ).toBe(false);
    expect(
      protectedRuntimeVariableInternals.targetVariableExact(
        "permanent-staging-postgres",
        "DATABASE_URL",
      ),
    ).toBe(false);
  });

  it("scopes target uniqueness to the application and shared rows", () => {
    const application = {
      id: "application-database-url",
      name: "DATABASE_URL",
      environmentId: ENVIRONMENT,
      serviceId: SERVICE,
      isSealed: true,
      references: [],
    };
    const databaseService = {
      ...application,
      id: "database-service-database-url",
      serviceId: "c454955f-263b-4599-aee0-dc447a4d3d15",
    };
    const before = {
      environmentId: ENVIRONMENT,
      rows: [application, databaseService],
      patchEmpty: true as const,
      deploymentCanonical: "deployment",
    };
    expect(
      protectedRuntimeVariableInternals.targetBeforeExact(before, "DATABASE_URL"),
    ).toBe(true);
    expect(
      protectedRuntimeVariableInternals.targetAfterExact(
        before,
        structuredClone(before),
        "DATABASE_URL",
      ),
    ).toBe(true);
    expect(
      protectedRuntimeVariableInternals.targetBeforeExact(
        {
          ...before,
          rows: [
            ...before.rows,
            { ...application, id: "shared-shadow", serviceId: null },
          ],
        },
        "DATABASE_URL",
      ),
    ).toBe(false);
  });

  it("fails policy validation under any byte-level policy drift", () => {
    expect(protectedRuntimeVariableInternals.policyExact(process.cwd())).toBe(
      true,
    );
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-runtime-policy-"),
    );
    fs.mkdirSync(path.join(temporary, "ops", "railway"), { recursive: true });
    const policy = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "ops/railway/protected-runtime-variable-policy.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    policy.extra = true;
    fs.writeFileSync(
      path.join(
        temporary,
        "ops/railway/protected-runtime-variable-policy.json",
      ),
      JSON.stringify(policy, null, 2),
    );
    expect(protectedRuntimeVariableInternals.policyExact(temporary)).toBe(
      false,
    );
    fs.rmSync(temporary, { recursive: true });
  });

  it("accepts only a complete single-certificate PEM for the protected multiline CA variable", async () => {
    const result = await runProtectedRuntimeVariableUpsert({
      argv: [
        "--target", "permanent-staging",
        "--variable", "PINTPATH_POSTGRES_ROOT_CA_PEM",
        "--value-file", "/private/value",
        "--evidence-dir", "/private/evidence",
        "--candidate-sha", CANDIDATE,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_RUNTIME_VARIABLE_CONFIRMATION:
          "UPSERT_PINTPATH_POSTGRES_ROOT_CA_PEM_IN_PERMANENT_STAGING",
        PINTPATH_RAILWAY_TARGET_METADATA_TOKEN:
          "runtime-metadata-token-long-enough",
        PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN:
          "runtime-write-token-long-enough",
      },
      cwd: process.cwd(),
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(scope())
        .mockResolvedValueOnce(metadata(false)),
      boundaryCheck: vi.fn().mockResolvedValue(0),
      readValue: () => Buffer.from(
        "-----BEGIN CERTIFICATE-----\ninvalid body with spaces\n-----END CERTIFICATE-----",
      ),
      writeDurable: () => "a".repeat(64),
      writeOutput: vi.fn(),
    });
    expect(result).toBe(1);
  });

  it("writes one value and uses a non-self-referential terminal envelope", async () => {
    const held = Buffer.from("postgresql://maintenance-private-value");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(metadata(false))
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(metadata(true));
    const writes: { leaf: string; source: string }[] = [];
    const output: string[] = [];
    const result = await runProtectedRuntimeVariableUpsert({
      argv: [
        "--target",
        "permanent-staging",
        "--variable",
        "DATABASE_MAINTENANCE_URL",
        "--value-file",
        "/private/value",
        "--evidence-dir",
        "/private/evidence",
        "--candidate-sha",
        CANDIDATE,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_RUNTIME_VARIABLE_CONFIRMATION:
          "UPSERT_DATABASE_MAINTENANCE_URL_IN_PERMANENT_STAGING",
        PINTPATH_RAILWAY_TARGET_METADATA_TOKEN:
          "runtime-metadata-token-long-enough",
        PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN:
          "runtime-write-token-long-enough",
      },
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      readValue: () => held,
      writeDurable: (_directory, leaf, source) => {
        writes.push({ leaf, source });
        return sha256(source);
      },
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(0);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        String((call[1] as RequestInit).body).includes(
          "variableCollectionUpsert",
        ),
      ),
    ).toHaveLength(1);
    for (const [, init] of fetchImpl.mock.calls) {
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get("Project-Access-Token")).toMatch(
        /^runtime-(?:metadata|write)-token-long-enough$/,
      );
      expect(headers.has("Authorization")).toBe(false);
    }
    expect([...held]).toEqual(new Array(held.length).fill(0));
    expect(writes.map(({ leaf }) => leaf).sort()).toEqual([
      "intent.json",
      "terminal.json",
    ]);
    const terminal = JSON.parse(
      writes.find(({ leaf }) => leaf === "terminal.json")!.source,
    ) as {
      receipt: {
        terminalEvidenceSha256: null;
        checks: { terminalEvidenceExact: false };
      };
    };
    expect(terminal.receipt.terminalEvidenceSha256).toBeNull();
    expect(terminal.receipt.checks.terminalEvidenceExact).toBe(false);
    const finalReceipt = JSON.parse(output[0]!) as {
      terminalEvidenceSha256: string;
      checks: { terminalEvidenceExact: boolean };
    };
    expect(finalReceipt.terminalEvidenceSha256).toBe(
      sha256(writes.find(({ leaf }) => leaf === "terminal.json")!.source),
    );
    expect(finalReceipt.checks.terminalEvidenceExact).toBe(true);
    expect(writes.map(({ source }) => source).join("\n")).not.toContain(
      "postgresql://maintenance-private-value",
    );
  });

  it("repairs the staging PostgreSQL source URL from a compile-time constant without reading arbitrary input", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(postgresRuntimeMetadata())
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(postgresRuntimeMetadata());
    const readValue = vi.fn(() => {
      throw new Error("must_not_read");
    });
    const writes: string[] = [];
    const result = await runProtectedRuntimeVariableUpsert({
      argv: [
        "--target",
        "permanent-staging-postgres",
        "--variable",
        "PINTPATH_RUNTIME_DATABASE_URL",
        "--value-file",
        "/fixed/reviewed/value",
        "--evidence-dir",
        "/private/evidence",
        "--candidate-sha",
        CANDIDATE,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_RUNTIME_VARIABLE_CONFIRMATION:
          "UPSERT_PINTPATH_RUNTIME_DATABASE_URL_IN_PERMANENT_STAGING_POSTGRES",
        PINTPATH_RAILWAY_TARGET_METADATA_TOKEN:
          "runtime-metadata-token-long-enough",
        PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN:
          "runtime-write-token-long-enough",
      },
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      readValue,
      writeDurable: (_directory, _leaf, source) => {
        writes.push(source);
        return sha256(source);
      },
      writeOutput: vi.fn(),
    });
    expect(result).toBe(0);
    expect(readValue).not.toHaveBeenCalled();
    const mutationCall = fetchImpl.mock.calls.find((call) =>
      String((call[1] as RequestInit).body).includes(
        "variableCollectionUpsert",
      )
    );
    const body = JSON.parse(String((mutationCall?.[1] as RequestInit).body)) as {
      variables: { serviceId: string; variables: Record<string, string> };
    };
    expect(body.variables.serviceId).toBe(POSTGRES_SERVICE);
    expect(body.variables.variables).toEqual({
      PINTPATH_RUNTIME_DATABASE_URL:
        protectedRuntimeVariableInternals.stagingPostgresRuntimeUrl,
    });
    expect(body.variables.variables.PINTPATH_RUNTIME_DATABASE_URL).toMatch(
      /pintpath_staging_runtime_login:.*pintpath_staging\?sslmode=verify-full$/,
    );
    expect(body.variables.variables.PINTPATH_RUNTIME_DATABASE_URL).not.toMatch(
      /uselibpqcompat|sslmode=require/,
    );
    expect(writes.join("\n")).not.toContain(
      protectedRuntimeVariableInternals.stagingPostgresRuntimeUrl,
    );
  });

  it("fails closed when the dependent Beer service changes during the PostgreSQL repair", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(postgresRuntimeMetadata())
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(postgresRuntimeMetadata(
        applicationServiceInstance("queued-beer-deployment", "QUEUED"),
      ));
    const output: string[] = [];
    const result = await runProtectedRuntimeVariableUpsert({
      argv: [
        "--target",
        "permanent-staging-postgres",
        "--variable",
        "PINTPATH_RUNTIME_DATABASE_URL",
        "--value-file",
        "/fixed/reviewed/value",
        "--evidence-dir",
        "/private/evidence",
        "--candidate-sha",
        CANDIDATE,
      ],
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_RUNTIME_VARIABLE_CONFIRMATION:
          "UPSERT_PINTPATH_RUNTIME_DATABASE_URL_IN_PERMANENT_STAGING_POSTGRES",
        PINTPATH_RAILWAY_TARGET_METADATA_TOKEN:
          "runtime-metadata-token-long-enough",
        PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN:
          "runtime-write-token-long-enough",
      },
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: vi.fn().mockResolvedValue(0),
      readValue: vi.fn(() => {
        throw new Error("must_not_read");
      }),
      writeDurable: (_directory, _leaf, source) => sha256(source),
      writeOutput: (source) => output.push(source),
    });
    expect(result).toBe(1);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        String((call[1] as RequestInit).body).includes(
          "variableCollectionUpsert",
        )
      ),
    ).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      retryAllowed: false,
      checks: {
        acknowledgementExact: true,
        targetPostflightExact: true,
        deploymentUnchanged: false,
      },
    });
  });
});
