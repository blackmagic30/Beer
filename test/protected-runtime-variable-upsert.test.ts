import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PROTECTED_RUNTIME_VARIABLE_METADATA,
  protectedRuntimeVariableInternals,
  runProtectedRuntimeVariableUpsert,
} from "../scripts/execute-protected-runtime-variable-upsert.js";
import * as failedStartupRecovery from "../scripts/lib/bar-pilot-failed-startup-recovery.js";
import { BAR_PILOT_STOPPED_DEPLOYMENT_ID } from "../scripts/lib/bar-pilot-staging-contract.js";

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

function metadataRow(index: number, name = `EXISTING_VARIABLE_${index}`) {
  return {
    node: {
      id: `variable-${index}`,
      name,
      environmentId: ENVIRONMENT,
      serviceId: SERVICE,
      isSealed: true,
      references: [] as string[],
    },
  };
}

function metadataPage(
  edges: ReturnType<typeof metadataRow>[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      environment: {
        id: ENVIRONMENT,
        variables: { edges, pageInfo: { hasNextPage, endCursor } },
      },
      staged: { environmentId: ENVIRONMENT, patch: {} as Record<string, unknown> },
      targetServiceInstance: applicationServiceInstance(),
      applicationServiceInstance: applicationServiceInstance(),
    },
  };
}

async function runPagedUpsert(fetchImpl: ReturnType<typeof vi.fn>, pilotEnv: Record<string, string> = {}) {
  const output: string[] = [];
  const evidence: string[] = [];
  const held = Buffer.from("postgresql://test-only-private-value");
  const readValue = vi.fn(() => held);
  const result = await runProtectedRuntimeVariableUpsert({
    argv: ["--target", "permanent-staging", "--variable", "DATABASE_MAINTENANCE_URL",
      "--value-file", "/private/value", "--evidence-dir", "/private/evidence", "--candidate-sha", CANDIDATE],
    env: {
      GITHUB_REF: "refs/heads/main", GITHUB_SHA: CANDIDATE, GITHUB_RUN_ATTEMPT: "1",
      PINTPATH_RUNTIME_VARIABLE_CONFIRMATION: "UPSERT_DATABASE_MAINTENANCE_URL_IN_PERMANENT_STAGING",
      PINTPATH_RAILWAY_TARGET_METADATA_TOKEN: "runtime-metadata-token-long-enough",
      PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN: "runtime-write-token-long-enough",
      ...pilotEnv,
    },
    cwd: process.cwd(), fetchImpl, boundaryCheck: vi.fn().mockResolvedValue(0), readValue,
    writeDurable: (_directory, _leaf, source) => { evidence.push(source); return sha256(source); },
    writeOutput: (source) => output.push(source),
  });
  const requests = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
  return {
    result, held, readValue, evidence, receipt: JSON.parse(output[0]!),
    mutations: requests.filter((request) => request.query.includes("variableCollectionUpsert")),
    metadataRequests: requests.filter((request) => request.query === PROTECTED_RUNTIME_VARIABLE_METADATA),
  };
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
  it.each(["approved", "missing proof", "snapshot drift", "active predecessor"])(
    "checks the exact failed predecessor and correction proof before pilot configuration: %s", async (condition) => {
      const lock = failedStartupRecovery.BAR_PILOT_FAILED_STARTUP_RECOVERY;
      const before = metadataPage([]);
      const after = metadataPage([metadataRow(0, "DATABASE_MAINTENANCE_URL")]);
      for (const page of [before, after]) {
        for (const row of [page.data.targetServiceInstance, page.data.applicationServiceInstance]) {
          Object.assign(row.latestDeployment, { id: lock.deploymentId, snapshotId: lock.snapshotId,
            status: "FAILED", deploymentStopped: true });
          Object.assign(row.activeDeployments[0]!, { id: BAR_PILOT_STOPPED_DEPLOYMENT_ID,
            status: "SUCCESS", deploymentStopped: condition !== "active predecessor" });
        }
      }
      if (condition === "snapshot drift") Object.assign(before.data.targetServiceInstance.latestDeployment,
        { snapshotId: "33333333-3333-4333-8333-333333333333" });
      const proof = vi.spyOn(failedStartupRecovery, "readBarPilotFailedStartupCorrectionProof")
        .mockImplementation(() => {
          if (condition === "missing proof") throw new Error("failed_startup_recovery_invalid");
          return "a".repeat(64);
        });
      try {
        const fetchImpl = vi.fn().mockResolvedValueOnce(scope()).mockResolvedValueOnce(scope())
          .mockResolvedValueOnce(json(before))
          .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
          .mockResolvedValueOnce(json(after));
        const run = await runPagedUpsert(fetchImpl, {
          PINTPATH_BAR_PILOT_STAGING_CONFIGURATION: "true",
          PINTPATH_BAR_PILOT_RECOVER_FAILED_STARTUP: "true",
        });
        expect(run.result).toBe(condition === "approved" ? 0 : 1);
        expect(run.mutations).toHaveLength(condition === "approved" ? 1 : 0);
        if (condition === "approved") {
          expect(run.mutations[0].variables.skipDeploys).toBe(true);
          expect(run.receipt.checks.deploymentUnchanged).toBe(true);
        }
      } finally { proof.mockRestore(); }
    },
  );
  it.each([100, 101])("reads all metadata before and after one upsert with %i existing environment variables", async (count) => {
    const rows = Array.from({ length: count }, (_, index) => metadataRow(index));
    const added = metadataRow(count, "DATABASE_MAINTENANCE_URL");
    const fetchImpl = vi.fn().mockResolvedValueOnce(scope()).mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(json(metadataPage(rows.slice(0, 100), count > 100, count > 100 ? "before-100" : null)));
    if (count > 100) fetchImpl.mockResolvedValueOnce(json(metadataPage(rows.slice(100))));
    fetchImpl.mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(json(metadataPage(rows.slice(0, 100), true, "after-100")))
      .mockResolvedValueOnce(json(metadataPage([...rows.slice(100), added])));
    const run = await runPagedUpsert(fetchImpl);
    expect(run.result).toBe(0);
    expect(run.mutations).toHaveLength(1);
    expect(run.mutations[0].variables.skipDeploys).toBe(true);
    expect(run.metadataRequests.map((request) => request.variables.variablesAfter)).toEqual(
      count === 100 ? [null, null, "after-100"] : [null, "before-100", null, "after-100"],
    );
    expect(run.receipt).toMatchObject({
      outcome: "updated", attempts: 1,
      checks: { targetPreflightExact: true, targetPostflightExact: true, deploymentUnchanged: true },
    });
    expect(run.held.every((byte) => byte === 0)).toBe(true);
    expect(run.evidence.join("\n")).not.toContain("postgresql://test-only-private-value");
    expect(PROTECTED_RUNTIME_VARIABLE_METADATA).toContain("variables(first:100,after:$variablesAfter)");
    expect(PROTECTED_RUNTIME_VARIABLE_METADATA).not.toMatch(/\bvalue\b/);
    expect(PROTECTED_RUNTIME_VARIABLE_METADATA).toContain("decryptVariables:false");
  });

  it.each([
    "wrong environment", "wrong staged environment", "staged patch", "changed target deployment",
    "changed application deployment", "duplicate id", "duplicate scoped name", "repeated cursor",
    "repeated terminal cursor", "empty continuation", "missing continuation", "malformed page",
  ])("does not write when metadata continuation has %s", async (failure) => {
    const first = metadataPage(Array.from({ length: 100 }, (_, index) => metadataRow(index)), true, "page-100");
    const next = metadataPage([metadataRow(100)]);
    if (failure === "wrong environment") next.data.environment.id = "other-environment";
    if (failure === "wrong staged environment") next.data.staged.environmentId = "other-environment";
    if (failure === "staged patch") next.data.staged.patch.changed = true;
    if (failure === "changed target deployment") next.data.targetServiceInstance.latestDeployment.id = "new-deployment";
    if (failure === "changed application deployment") next.data.applicationServiceInstance.activeDeployments = [];
    if (failure === "duplicate id") next.data.environment.variables.edges[0]!.node.id = "variable-0";
    if (failure === "duplicate scoped name") next.data.environment.variables.edges[0]!.node.name = "EXISTING_VARIABLE_0";
    if (failure === "repeated cursor" || failure === "repeated terminal cursor") {
      next.data.environment.variables.pageInfo = { hasNextPage: failure === "repeated cursor", endCursor: "page-100" };
    }
    if (failure === "empty continuation") next.data.environment.variables.edges = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(scope()).mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(json(first));
    if (failure === "missing continuation") fetchImpl.mockRejectedValueOnce(new Error("provider-unavailable"));
    else fetchImpl.mockResolvedValueOnce(json(failure === "malformed page" ? { data: {} } : next));
    const run = await runPagedUpsert(fetchImpl);
    expect(run.result).toBe(1);
    expect(run.mutations).toHaveLength(0);
    expect(run.readValue).not.toHaveBeenCalled();
    expect(run.receipt).toMatchObject({ outcome: "failed_before_attempt", attempts: 0 });
  });

  it.each(["missing cursor", "oversized page", "page limit"])("bounds metadata pagination and rejects %s", async (failure) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(scope()).mockResolvedValueOnce(scope());
    const pages = failure === "page limit" ? 20 : 1;
    for (let page = 0; page < pages; page += 1) {
      fetchImpl.mockResolvedValueOnce(json(metadataPage(
        Array.from({ length: failure === "oversized page" ? 101 : 100 }, (_, index) => metadataRow(page * 100 + index)),
        true, failure === "missing cursor" ? null : `page-${page + 1}`,
      )));
    }
    const run = await runPagedUpsert(fetchImpl);
    expect(run.result).toBe(1);
    expect(run.metadataRequests).toHaveLength(pages);
    expect(run.mutations).toHaveLength(0);
    expect(run.readValue).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "inconsistent deployment", "duplicate metadata"])("records uncertain postflight without retrying the write when continuation is %s", async (failure) => {
    const rows = Array.from({ length: 100 }, (_, index) => metadataRow(index));
    const next = metadataPage([metadataRow(100, "DATABASE_MAINTENANCE_URL")]);
    if (failure === "inconsistent deployment") next.data.targetServiceInstance.latestDeployment.id = "changed-deployment";
    if (failure === "duplicate metadata") next.data.environment.variables.edges[0]!.node.id = "variable-0";
    const fetchImpl = vi.fn().mockResolvedValueOnce(scope()).mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(json(metadataPage(rows)))
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(json(metadataPage(rows, true, "after-100")));
    if (failure === "unavailable") fetchImpl.mockRejectedValueOnce(new Error("provider-unavailable"));
    else fetchImpl.mockResolvedValueOnce(json(next));
    const run = await runPagedUpsert(fetchImpl);
    expect(run.result).toBe(1);
    expect(run.mutations).toHaveLength(1);
    expect(run.receipt).toMatchObject({
      outcome: "mutation_uncertain", attempts: 1,
      checks: { acknowledgementExact: true, postflightAttempted: true, targetPostflightExact: false },
    });
    expect(run.held.every((byte) => byte === 0)).toBe(true);
  });

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

describe("pilot configuration preserves the exact predecessor", () => {
  it.each([true, false])("requires the retained deployment to remain stopped: %s", async (stopped) => {
    const deploymentId = "6300a324-9407-4b1c-b651-749c47e9537f";
    const makeMetadata = async (hasVariable: boolean) => {
      const value = await metadata(hasVariable).json();
      for (const name of ["targetServiceInstance", "applicationServiceInstance"]) {
        value.data[name].latestDeployment = { id: deploymentId, status: "SUCCESS", deploymentStopped: stopped };
        value.data[name].activeDeployments = [{ id: deploymentId, status: "SUCCESS", deploymentStopped: stopped }];
      }
      return json(value);
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(scope()).mockResolvedValueOnce(scope())
      .mockResolvedValueOnce(await makeMetadata(false))
      .mockResolvedValueOnce(json({ data: { variableCollectionUpsert: true } }))
      .mockResolvedValueOnce(await makeMetadata(true));
    const result = await runProtectedRuntimeVariableUpsert({
      argv: ["--target", "permanent-staging", "--variable", "DATABASE_MAINTENANCE_URL",
        "--value-file", "/private/value", "--evidence-dir", "/private/evidence", "--candidate-sha", CANDIDATE],
      env: { GITHUB_REF: "refs/heads/main", GITHUB_SHA: CANDIDATE, GITHUB_RUN_ATTEMPT: "1",
        PINTPATH_BAR_PILOT_STAGING_CONFIGURATION: "true",
        PINTPATH_RUNTIME_VARIABLE_CONFIRMATION: "UPSERT_DATABASE_MAINTENANCE_URL_IN_PERMANENT_STAGING",
        PINTPATH_RAILWAY_TARGET_METADATA_TOKEN: "runtime-metadata-token-long-enough",
        PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN: "runtime-write-token-long-enough" },
      cwd: process.cwd(), fetchImpl, boundaryCheck: vi.fn().mockResolvedValue(0),
      readValue: () => Buffer.from("postgresql://private-maintenance"),
      writeDurable: (_dir, _leaf, source) => sha256(source), writeOutput: vi.fn(),
    });
    expect(result).toBe(stopped ? 0 : 1);
    const mutations = fetchImpl.mock.calls.filter(([, init]) => String(init.body).includes("variableCollectionUpsert"));
    expect(mutations).toHaveLength(stopped ? 1 : 0);
    if (stopped) expect(JSON.parse(mutations[0]![1].body).variables.skipDeploys).toBe(true);
  });
});


describe("production database transition through the existing one-variable executor", () => {
  const production = "13dab015-df74-45c6-b26f-69323daea99a";
  async function run(name: string, condition = "valid", suppliedValue = "postgresql://test-only-private-runtime") {
    let mutations = 0;
    let metadataReads = 0;
    const requests: Record<string, unknown>[] = [];
    const evidence: Record<string, unknown>[] = [];
    const reassert = vi.fn(async () => { if (condition === "changed-live-proof") throw new Error("not ready"); });
    const close = vi.fn(async () => undefined);
    const gate = vi.fn(async () => {
      if (condition === "bad-native-proof" || condition === "bad-live-proof") throw new Error("not ready");
      return { binding: { candidateSha: CANDIDATE, sourceSnapshotSha256: "a".repeat(64) }, reassert, close };
    });
    const readValue = vi.fn(() => Buffer.from(suppliedValue));
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("projectToken")) return json({data:{projectToken:{projectId:PROJECT,environmentId:production}}});
      if (body.query.includes("mutation ")) {
        mutations += 1; requests.push(body.variables);
        return json({data:{variableCollectionUpsert:true}});
      }
      metadataReads += 1;
      const page = metadataPage(name === "DATABASE_PATH" || mutations ? [metadataRow(0,name)] : []);
      const value = JSON.parse(JSON.stringify(page).replaceAll(ENVIRONMENT,production));
      for (const instance of [value.data.targetServiceInstance,value.data.applicationServiceInstance]) {
        instance.latestDeployment.deploymentStopped = condition !== "active-legacy-writer";
        instance.activeDeployments[0].deploymentStopped = condition !== "active-legacy-writer";
      }
      if (condition === "revived-legacy-writer" && metadataReads === 3) value.data.applicationServiceInstance.activeDeployments[0].deploymentStopped = false;
      if (condition === "changed-deployment" && metadataReads === 2) value.data.targetServiceInstance.latestDeployment.id = "different";
      return json(value);
    });
    let receipt = "";
    const result = await runProtectedRuntimeVariableUpsert({
      argv: ["--target","production","--variable",name,"--value-file","/private/value",
        "--evidence-dir","/private/evidence","--candidate-sha",CANDIDATE],
      env: { GITHUB_REF:"refs/heads/main",GITHUB_SHA:CANDIDATE,GITHUB_RUN_ATTEMPT:"1",
        PINTPATH_RUNTIME_VARIABLE_CONFIRMATION: name === "DATABASE_PATH" ? "CLEAR_DATABASE_PATH_IN_PRODUCTION" : `UPSERT_${name}_IN_PRODUCTION`,
        PINTPATH_RAILWAY_TARGET_METADATA_TOKEN:"read-token-long-enough",PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN:"write-token-long-enough" },
      cwd:process.cwd(),fetchImpl,boundaryCheck:async()=>0,readValue,
      loadProductionImportGate:gate as never,
      writeDurable:(_dir,_leaf,source)=>{evidence.push(JSON.parse(source));return sha256(source);},
      writeOutput:source=>{receipt=source;},
    });
    return {result,mutations,requests,evidence,receipt,gate,reassert,close,readValue};
  }
  it("performs one bounded non-deploying DATABASE_URL write after native and actual live proof reassertion", async () => {
    const result = await run("DATABASE_URL");
    expect(result.result).toBe(0); expect(result.mutations).toBe(1);
    expect(result.gate).toHaveBeenCalledOnce(); expect(result.reassert).toHaveBeenCalledOnce(); expect(result.close).toHaveBeenCalledOnce();
    expect(result.requests[0]).toMatchObject({environmentId:production,serviceId:SERVICE,skipDeploys:true});
    expect(result.evidence[0]).toHaveProperty("productionImport");
    expect(JSON.stringify(result.evidence)).not.toContain("postgresql://test-only-private-runtime");
  });
  it.each(["bad-native-proof","bad-live-proof","changed-live-proof","changed-deployment","active-legacy-writer","revived-legacy-writer"])(
    "writes nothing when a production connection prerequisite fails: %s", async condition => {
      const result = await run("DATABASE_URL",condition);
      expect(result.result).toBe(1); expect(result.mutations).toBe(0);
    });
  it("clears only DATABASE_PATH with a fixed empty upsert without reading an arbitrary value or deleting storage", async () => {
    const result = await run("DATABASE_PATH");
    expect(result.result).toBe(0);expect(result.mutations).toBe(1);
    expect(result.readValue).not.toHaveBeenCalled();expect(result.gate).not.toHaveBeenCalled();
    expect(result.requests).toEqual([{projectId:PROJECT,serviceId:SERVICE,environmentId:production,variables:{DATABASE_PATH:""},skipDeploys:true}]);
    expect(result.evidence[0]).toMatchObject({clearOperation:"CLEAR_DATABASE_PATH",valueSource:"REVIEWED_EMPTY_DATABASE_PATH",providerRowPreserved:true,dataFilesAndVolumesUnchanged:true});
  });
  it.each([
    ["BAR_PILOT_ENABLED","true",true], ["BAR_PILOT_ENABLED","false",true],
    ["BAR_PILOT_ENABLED","1",false], ["BAR_PILOT_VENUE_IDS","pilot-venue-one,pilot-venue-two",true],
    ["BAR_PILOT_VENUE_IDS","",false], ["BAR_PILOT_VENUE_IDS","one,one",false],
    ["BAR_PILOT_VENUE_IDS","one, two",false],
    ["ALCOHOL_PROMOTION_APPROVAL_REFERENCE","Owner review record: pilot approval 2026-09",true],
    ["ALCOHOL_PROMOTION_APPROVAL_REFERENCE","",false],
    ["ALCOHOL_PROMOTION_APPROVAL_REFERENCE"," ",false],
    ["ALCOHOL_PROMOTION_APPROVAL_REFERENCE","x".repeat(513),false],
  ])("allows only a bounded real-pilot value for %s", async (name,value,valid) => {
    const result = await run(String(name),"valid",String(value));
    expect(result.result).toBe(valid ? 0 : 1);
    expect(result.mutations).toBe(valid ? 1 : 0);
    if (valid) expect(result.requests[0]).toMatchObject({variables:{[String(name)]:value},skipDeploys:true});
  });
  it("preserves staging access while production allows only three real-pilot controls", () => {
    for (const name of ["BAR_PILOT_ENABLED","BAR_PILOT_VENUE_IDS","ALCOHOL_PROMOTION_APPROVAL_REFERENCE"]) {
      expect(protectedRuntimeVariableInternals.targetVariableExact("production",name)).toBe(true);
      expect(protectedRuntimeVariableInternals.targetVariableExact("permanent-staging-postgres",name)).toBe(false);
    }
    for (const name of ["BAR_PILOT_ENABLED","BAR_PILOT_VENUE_IDS"]) expect(protectedRuntimeVariableInternals.targetVariableExact("permanent-staging",name)).toBe(true);
    expect(protectedRuntimeVariableInternals.targetVariableExact("permanent-staging","ALCOHOL_PROMOTION_APPROVAL_REFERENCE")).toBe(false);
    for (const name of ["BAR_PILOT_DEMO_ENABLED","BAR_PILOT_DEMO_CUSTOMER_IDS","PINT_POINTS_REWARDS_ENABLED","ALCOHOL_GAMIFICATION_ENABLED","COMMERCIAL_LAUNCH_ENABLED","CONSUMER_PAID_ENROLLMENT_ENABLED"]) {
      expect(protectedRuntimeVariableInternals.targetVariableExact("production",name)).toBe(false);
    }
  });

  it("does not widen staging variables, permit arbitrary deletes, or turn off Redis enforcement", () => {
    const policy = JSON.parse(fs.readFileSync("ops/railway/protected-runtime-variable-policy.json","utf8"));
    for (const field of policy.productionOnlyVariables) {
      expect(protectedRuntimeVariableInternals.targetVariableExact("production",field)).toBe(true);
      expect(protectedRuntimeVariableInternals.targetVariableExact("permanent-staging",field)).toBe(false);
      expect(protectedRuntimeVariableInternals.targetVariableExact("permanent-staging-postgres",field)).toBe(false);
    }
    expect(protectedRuntimeVariableInternals.targetVariableExact("production","ARBITRARY_VARIABLE")).toBe(false);
    expect(protectedRuntimeVariableInternals.productionVariableValueExact("DATABASE_PATH","/data/database.sqlite")).toBe(false);
    expect(protectedRuntimeVariableInternals.productionVariableValueExact("REQUIRE_REDIS_RATE_LIMITING","false")).toBe(false);
    expect(protectedRuntimeVariableInternals.productionVariableValueExact("ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION","true")).toBe(false);
  });
});
