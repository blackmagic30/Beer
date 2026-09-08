import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  derivePostQDeploymentStopV2Deadline,
  postQDeploymentStopV2ConfirmationExact,
  postQDeploymentStopV2DeadlineExact,
} from "../scripts/lib/permanent-staging-post-q-deployment-stop-authority-v2.js";
import {
  authorizationSourceExact,
  historicalWorkflowBlobExact,
  successorPolicyExact,
} from "../scripts/verify-permanent-staging-post-q-authority-v2.mjs";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const hash = (source: string) =>
  crypto.createHash("sha256").update(source).digest("hex");
const candidateSha = "a".repeat(40);

describe("post-deadline post-Q staging containment v2", () => {
  it("binds the exact 267-byte reviewed provenance serialization", () => {
    const source = read(
      "ops/railway/permanent-staging-post-q-deployment-stop-authorization-v2.json",
    );
    expect(Buffer.byteLength(source)).toBe(267);
    expect(hash(source)).toBe(
      "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
    );
    const value = JSON.parse(source);
    expect(source).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(value).toEqual({
      schemaVersion: "pintpath-reviewed-user-authorization-provenance/v1",
      threadId: "01a02140-8628-7d30-9374-8d29d4a9f3a3",
      messages: [
        "you are always authorised until we are prod ready",
        "perfect so can we continue with pint path readyness?",
      ],
    });
    expect(authorizationSourceExact(source)).toBe(true);
    expect(authorizationSourceExact(`${source}\n`)).toBe(false);
    expect(authorizationSourceExact(source.replace("always", "sometimes")))
      .toBe(false);
  });

  it("preserves the archived v1 policy and verifier byte-for-byte", () => {
    expect(hash(read(
      "ops/railway/permanent-staging-post-q-deployment-stop-policy.json",
    ))).toBe("e8bb67ef71e49f3179f1fe0cb8a6eeceb09f7cae05376b2e74b8b1eae0f7b2e1");
    expect(hash(read(
      "scripts/verify-permanent-staging-post-q-authority.mjs",
    ))).toBe("f5a12c286573226a86445d1bd8960f96be92a75aedc10f705e20ee9e95f8c6a3");
  });

  it("pins the canonical workflow ledger, old no-write run, and historical blob", () => {
    const policy = JSON.parse(read(
      "ops/railway/permanent-staging-post-q-deployment-stop-policy-v2.json",
    ));
    const policySource = read(
      "ops/railway/permanent-staging-post-q-deployment-stop-policy-v2.json",
    );
    expect(successorPolicyExact(policySource)).toBe(true);
    expect(successorPolicyExact(policySource.replace(
      '"requiredRunNumber": 2',
      '"requiredRunNumber": 3',
    ))).toBe(false);
    expect(policy).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-post-q-deployment-stop-policy/v2",
      workflow: {
        path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        workflowId: 353312302,
        requiredRunNumber: 2,
        requiredTotalHistoryRows: 2,
        historyQueryEventFilterAllowed: false,
      },
      archivedV1: {
        authorityDeadline: "2026-09-08T18:57:20.000Z",
        expired: true,
        reused: false,
      },
      expiredRun: {
        runId: 34255228036,
        artifactCount: 0,
        writerNeverExistedOrStarted: true,
        historicalWorkflow: {
          blobOid: "0d5efadc53101ae6631e25bbff7c804a30faa672",
          sizeBytes: 28866,
          byteSha256:
            "6a452880ccbe3d80d9d771b4aae7bd3be2bcf26beac7dee1af91d0c705e7a9a8",
        },
      },
      candidateLineage: {
        directParentSha: "d27275f4c101b764c6016e8b378969c14719258e",
        directParentTreeSha: "53808bdd995a6ff1d2204e01f7639b103dbd5a76",
        directParentSoleParentSha:
          "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7",
        recoveryTreeSha: "9978dca9491f7bf7bee77ce39debe1f713e89c53",
        recoverySoleParentSha:
          "606d33facb515dd10bc94c360e43c20beb999cc1",
      },
    });
    expect(historicalWorkflowBlobExact({
      type: "file",
      name: "stop-permanent-staging-post-q-deployment.yml",
      path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
      sha: "1".repeat(40),
      size: 28_866,
      encoding: "base64",
      content: "",
    })).toBe(false);
  });

  it("uses the canonical workflow with only v2 authority/runtime and compatible intent name", () => {
    const workflow = read(
      ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    );
    expect(workflow).toContain("authorization_id:");
    expect(workflow).toContain("authorization_source_sha256:");
    expect(workflow.match(
      /scripts\/verify-permanent-staging-post-q-authority-v2\.mjs/gu,
    )).toHaveLength(3);
    expect(workflow.match(
      /scripts\/execute-protected-permanent-staging-post-q-deployment-stop-v2\.ts/gu,
    )).toHaveLength(3);
    expect(workflow).not.toMatch(
      /scripts\/verify-permanent-staging-post-q-authority\.mjs/gu,
    );
    expect(workflow).toContain(
      "pintpath-permanent-staging-post-q-deployment-stop-intent-${{ inputs.candidate_sha }}-${{ github.run_id }}",
    );
    expect(workflow).not.toContain("post-deadline.yml");
    expect(workflow).not.toContain("PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN");
  });

  it("queries unfiltered history by numeric workflow id", () => {
    const verifier = read(
      "scripts/verify-permanent-staging-post-q-authority-v2.mjs",
    );
    expect(verifier).toContain(
      "`/repos/${REPOSITORY}/actions/workflows/${CONTAINMENT_WORKFLOW_ID}/runs`",
    );
    expect(verifier).toContain("`?per_page=100&page=${page}`");
    expect(verifier).not.toContain("?event=workflow_dispatch&per_page");
    expect(verifier).toContain("EXPIRED_WORKFLOW_BLOB_OID");
    expect(verifier).toContain("historicalWorkflowBlobExact");
  });

  it("derives the earliest independent deadline and rejects invalid chronology", () => {
    expect(derivePostQDeploymentStopV2Deadline(
      "2026-09-09T05:30:00Z",
      "2026-09-09T06:00:00Z",
    )).toBe("2026-09-09T07:30:00.000Z");
    expect(derivePostQDeploymentStopV2Deadline(
      "2026-09-09T03:00:00Z",
      "2026-09-09T06:00:00Z",
    )).toBe("2026-09-09T07:00:00.000Z");
    expect(derivePostQDeploymentStopV2Deadline(
      "2026-09-09T06:30:00Z",
      "2026-09-09T07:00:00Z",
    )).toBe("2026-09-09T08:00:00.000Z");
    expect(derivePostQDeploymentStopV2Deadline(
      "2026-09-09T07:00:01Z",
      "2026-09-09T07:00:00Z",
    )).toBeNull();
    expect(derivePostQDeploymentStopV2Deadline(
      "2026-09-09T07:00:00Z",
      "2026-09-09T08:00:00Z",
    )).toBeNull();
  });

  it("rederives the persisted deadline immediately before allowing a write", () => {
    const authority = {
      sha256: "b".repeat(64),
      candidateSha,
      reviewedPrHeadSha: "c".repeat(40),
      reviewedPullRequestNumber: 101,
      reviewedPullRequestMergedAt: "2026-09-09T05:30:00Z",
      authorizationDeadline: "2026-09-09T07:30:00.000Z",
      workflowRunStartedAt: "2026-09-09T06:00:00Z",
      workflowRunId: "34300000000",
      workflowRunAttempt: 1 as const,
      reviewedAuthorityExact: true as const,
      freshDispatchWriteGuardExact: true as const,
    };
    expect(postQDeploymentStopV2DeadlineExact(
      authority,
      Date.parse("2026-09-09T07:29:59.999Z"),
    )).toBe(true);
    expect(postQDeploymentStopV2DeadlineExact(
      authority,
      Date.parse("2026-09-09T07:30:00.000Z"),
    )).toBe(false);
    expect(postQDeploymentStopV2DeadlineExact({
      ...authority,
      authorizationDeadline: "2026-09-09T08:00:00.000Z",
    }, Date.parse("2026-09-09T07:00:00.000Z"))).toBe(false);

    const executor = read(
      "scripts/execute-protected-permanent-staging-post-q-deployment-stop.ts",
    );
    const requestStart = executor.indexOf("const requestStartedMs = dependencies.now()");
    const deadlineRecheck = executor.indexOf(
      "dependencies.authorizationDeadlineExact(\n      reviewedAuthority,\n      requestStartedMs",
      requestStart,
    );
    const writer = executor.indexOf("dependencies.stopDeployment(writeToken)");
    const reconciliation = executor.indexOf("dependencies.reconcile({", writer);
    expect(requestStart).toBeGreaterThan(0);
    expect(deadlineRecheck).toBeGreaterThan(requestStart);
    expect(writer).toBeGreaterThan(deadlineRecheck);
    expect(reconciliation).toBeGreaterThan(writer);
    expect(executor.slice(writer, reconciliation)).not.toContain(
      "authorizationDeadlineExact",
    );
    expect(executor).toContain("args.phase === \"finalize\" ||");
  });

  it("requires the action-specific confirmation and fresh v2 identifiers", () => {
    const env = {
      PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
        "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_ID:
        "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v2",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_SOURCE_SHA256:
        "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_CONFIRMATION:
        `REAUTHORIZE_ONE_STAGING_DEPLOYMENT_STOP_6300A324_9407_4B1C_B651_749C47E9537F_FOR_${candidateSha}_UNDER_V2_FROM_01A02140_8628_7D30_9374_8D29D4A9F3A3`,
    };
    expect(postQDeploymentStopV2ConfirmationExact(candidateSha, env)).toBe(true);
    expect(postQDeploymentStopV2ConfirmationExact(candidateSha, {
      ...env,
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_ID:
        "pintpath-permanent-staging-post-q-deployment-stop-containment",
    })).toBe(false);
  });
});
