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
      serviceInstance: {
        id: "11111111-1111-4111-8111-111111111111",
        serviceId: SERVICE,
        environmentId: ENVIRONMENT,
        latestDeployment: { id: "deployment", status: "SUCCESS" },
        activeDeployments: [{ id: "deployment", status: "SUCCESS" }],
      },
    },
  });
}

describe("protected runtime-variable upsert", () => {
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
});
