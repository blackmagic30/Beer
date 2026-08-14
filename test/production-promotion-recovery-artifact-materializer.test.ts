import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runProductionPromotionRecoveryArtifactMaterializer } from "../scripts/materialize-production-promotion-recovery-artifact.mjs";

const CANDIDATE = "a".repeat(40);
const roots: string[] = [];

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type Stage =
  | "deploy"
  | "scale"
  | "close"
  | "close-terminal"
  | "activation"
  | "promotion-recovery";

const stageContracts: Record<
  Stage,
  {
    phase: "close" | "activation" | "promotion-recovery" | "open";
    chainStage:
      "deploy" | "scale" | "close" | "activation" | "promotion-recovery";
    prefix: string;
    producerCheck: string;
    receiptEntry: string;
  }
> = {
  deploy: {
    phase: "close",
    chainStage: "deploy",
    prefix: "pintpath-production-deployment-",
    producerCheck: "Deploy protected production",
    receiptEntry:
      "pintpath-production-deployment-evidence/deployment-receipt.json",
  },
  scale: {
    phase: "close",
    chainStage: "scale",
    prefix: "pintpath-production-scale-evidence-",
    producerCheck: "Converge exact production deployment to two replicas",
    receiptEntry: "converge-production-two-receipt.json",
  },
  close: {
    phase: "activation",
    chainStage: "close",
    prefix: "pintpath-production-route-close-",
    producerCheck: "Close exact production route",
    receiptEntry: "receipt.json",
  },
  "close-terminal": {
    phase: "promotion-recovery",
    chainStage: "close",
    prefix: "pintpath-production-route-close-",
    producerCheck: "Close exact production route",
    receiptEntry: "terminal.json",
  },
  activation: {
    phase: "promotion-recovery",
    chainStage: "activation",
    prefix: "pintpath-production-promotion-recovery-activation-",
    producerCheck: "Activate exact production promotion recovery",
    receiptEntry: "activation-receipt.json",
  },
  "promotion-recovery": {
    phase: "open",
    chainStage: "promotion-recovery",
    prefix: "pintpath-production-promotion-recovery-",
    producerCheck: "Attest protected production promotion and recovery",
    receiptEntry: "production-promotion-recovery-receipt.json",
  },
};

function fixture(
  options: { metadataDigestDrift?: boolean; stage?: Stage } = {},
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-promotion-artifact-")),
  );
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const archive = Buffer.from("synthetic-reviewed-artifact");
  const digest = `sha256:${crypto.createHash("sha256").update(archive).digest("hex")}`;
  const stage = options.stage ?? "promotion-recovery";
  const contract = stageContracts[stage];
  const artifact = {
    stage: contract.chainStage,
    artifactId: 123,
    name: `${contract.prefix}${CANDIDATE}`,
    digest,
    sizeBytes: archive.length,
    runId: 456,
    producerCheck: contract.producerCheck,
  };
  const authority = {
    schemaVersion: "pintpath-github-release-candidate-receipt/v3",
    repository: "blackmagic30/Beer",
    branch: "main",
    phase: contract.phase,
    candidateSha: CANDIDATE,
    policySha256:
      "b47f562d94b462ed7d2b1d9df317ac239a607d517bb487c109585e09213ba4fd",
    consumer: {},
    checks: [],
    artifacts: [],
    productionChain: [{ stage: contract.chainStage, artifact }],
    orderedProductionChainSha256: "2".repeat(64),
    requiredChecksExact: true,
    requiredArtifactsExact: true,
    chronologyExact: true,
    currentConsumerExact: true,
  };
  const authorityPath = path.join(root, "authority.json");
  fs.writeFileSync(authorityPath, canonical(authority), { mode: 0o600 });
  const receiptSource = canonical({ schemaVersion: "synthetic-receipt" });
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith("/actions/artifacts/123")) {
      return new Response(
        JSON.stringify({
          id: 123,
          name: artifact.name,
          digest: options.metadataDigestDrift
            ? `sha256:${"0".repeat(64)}`
            : digest,
          size_in_bytes: archive.length,
          expired: false,
          workflow_run: { id: 456, head_sha: CANDIDATE },
          archive_download_url:
            "https://api.github.com/repos/blackmagic30/Beer/actions/artifacts/123/zip",
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/actions/artifacts/123/zip")) {
      return new Response(archive, { status: 200 });
    }
    return new Response("", { status: 404 });
  });
  const output = path.join(root, `${stage}-receipt.json`);
  return {
    archive,
    authorityPath,
    fetchImpl,
    output,
    receiptEntry: contract.receiptEntry,
    receiptSource,
    root,
    stage,
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("production promotion-recovery artifact materializer", () => {
  it("re-queries exact artifact metadata and extracts each stage's one receipt", async () => {
    for (const stage of Object.keys(stageContracts) as Stage[]) {
      const value = fixture({ stage });
      const extractEntry = vi.fn(() => Buffer.from(value.receiptSource));
      const code = await runProductionPromotionRecoveryArtifactMaterializer(
        [
          "--authority",
          value.authorityPath,
          "--candidate-sha",
          CANDIDATE,
          "--stage",
          value.stage,
          "--output",
          value.output,
        ],
        {
          env: {
            GITHUB_ACTIONS: "true",
            GITHUB_REPOSITORY: "blackmagic30/Beer",
            GITHUB_SHA: CANDIDATE,
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_TOKEN: "g".repeat(32),
          },
          fetchImpl: value.fetchImpl,
          extractEntry,
          writeOutput: () => undefined,
        },
      );
      expect(code, stage).toBe(0);
      expect(value.fetchImpl).toHaveBeenCalledTimes(2);
      expect(extractEntry).toHaveBeenCalledWith(
        value.archive,
        value.root,
        value.receiptEntry,
      );
      expect(fs.readFileSync(value.output, "utf8")).toBe(value.receiptSource);
    }
  });

  it("fails closed before download when fresh metadata differs from authority", async () => {
    const value = fixture({ metadataDigestDrift: true });
    const code = await runProductionPromotionRecoveryArtifactMaterializer(
      [
        "--authority",
        value.authorityPath,
        "--candidate-sha",
        CANDIDATE,
        "--stage",
        "promotion-recovery",
        "--output",
        value.output,
      ],
      {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_SHA: CANDIDATE,
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: value.fetchImpl,
        extractEntry: vi.fn(),
        writeOutput: () => undefined,
      },
    );
    expect(code).toBe(1);
    expect(value.fetchImpl).toHaveBeenCalledOnce();
    expect(fs.existsSync(value.output)).toBe(false);
  });
});
