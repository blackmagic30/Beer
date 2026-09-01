import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runProductionPromotionRecoveryArtifactMaterializer } from "../scripts/materialize-production-promotion-recovery-artifact.mjs";

const CANDIDATE = "a".repeat(40);
const TRUSTED_ARCHIVE = Buffer.from(
  "UEsDBAoAAAAAANpuFV2YyDAuKwAAACsAAAAqAAAAcHJvZHVjdGlvbi1wcm9tb3Rpb24tcmVjb3ZlcnktcmVjZWlwdC5qc29uewogICJzY2hlbWFWZXJzaW9uIjogInN5bnRoZXRpYy1yZWNlaXB0Igp9ClBLAQIeAwoAAAAAANpuFV2YyDAuKwAAACsAAAAqAAAAAAAAAAEAAACkgQAAAABwcm9kdWN0aW9uLXByb21vdGlvbi1yZWNvdmVyeS1yZWNlaXB0Lmpzb25QSwUGAAAAAAEAAQBYAAAAcwAAAAAA",
  "base64",
);
const FORGED_LIST_ARCHIVE = Buffer.from(
  "UEsDBAoAAAAAAOBuFV3JwF5fEAAAABAAAAALAAAAZm9yZ2VkLmpzb257ImZvcmdlZCI6dHJ1ZX0KUEsBAh4DCgAAAAAA4G4VXcnAXl8QAAAAEAAAAAsAAAAAAAAAAQAAAKSBAAAAAGZvcmdlZC5qc29uUEsFBgAAAAABAAEAOQAAADkAAAAAAA==",
  "base64",
);
const FORGED_EXTRACT_ARCHIVE = Buffer.from(
  "UEsDBAoAAAAAAORuFV3JwF5fEAAAABAAAAAqAAAAcHJvZHVjdGlvbi1wcm9tb3Rpb24tcmVjb3ZlcnktcmVjZWlwdC5qc29ueyJmb3JnZWQiOnRydWV9ClBLAQIeAwoAAAAAAORuFV3JwF5fEAAAABAAAAAqAAAAAAAAAAEAAACkgQAAAABwcm9kdWN0aW9uLXByb21vdGlvbi1yZWNvdmVyeS1yZWNlaXB0Lmpzb25QSwUGAAAAAAEAAQBYAAAAWAAAAAAA",
  "base64",
);
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
  options: {
    archive?: Buffer;
    metadataDigestDrift?: boolean;
    stage?: Stage;
  } = {},
) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-promotion-artifact-")),
  );
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const archive = options.archive ?? Buffer.from("synthetic-reviewed-artifact");
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
    schemaVersion: "pintpath-github-release-candidate-receipt/v5",
    repository: "blackmagic30/Beer",
    branch: "main",
    phase: contract.phase,
    candidateSha: CANDIDATE,
    reviewedPullRequest: {
      number: 24,
      reviewedPrHeadSha: "e".repeat(40),
      mergeCommitSha: CANDIDATE,
      treeSha: "f".repeat(40),
      mergedAt: "1970-01-01T00:00:00.000Z",
      authorId: 1,
      mergedById: 2,
      githubMergeExact: true,
      reviewedTreeExact: true,
      pullRequestApprovalRequirement: "not_required",
      pullRequestApprovalRequirementExact: true,
      linearHistoryExact: true,
    },
    policySha256:
      "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90",
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

function validEnvironment(): Record<string, string> {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: "g".repeat(32),
  };
}

async function runFixture(
  value: ReturnType<typeof fixture>,
  options: {
    readonly spawnSyncImpl?: typeof spawnSync;
    readonly useDefaultExtractEntry?: boolean;
    readonly writeOutput?: (source: string) => void;
  } = {},
): Promise<number> {
  return runProductionPromotionRecoveryArtifactMaterializer(
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
      env: validEnvironment(),
      fetchImpl: value.fetchImpl,
      extractEntry: options.useDefaultExtractEntry
        ? undefined
        : () => Buffer.from(value.receiptSource),
      spawnSyncImpl: options.spawnSyncImpl,
      writeOutput: options.writeOutput ?? (() => undefined),
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("production promotion-recovery artifact materializer", () => {
  it("re-queries exact artifact metadata and extracts each stage's one receipt", async () => {
    for (const stage of Object.keys(stageContracts) as Stage[]) {
      const value = fixture({ stage });
      const extractEntry = vi.fn(() => Buffer.from(value.receiptSource));
      let summary = "";
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
          writeOutput: (source: string) => {
            summary += source;
          },
        },
      );
      expect(code, `${stage}:${summary}`).toBe(0);
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

  it("rejects a predecessor authority whose reviewed PR no longer binds the candidate", async () => {
    const value = fixture();
    const authority = JSON.parse(fs.readFileSync(value.authorityPath, "utf8"));
    authority.reviewedPullRequest.mergeCommitSha = "0".repeat(40);
    fs.writeFileSync(value.authorityPath, canonical(authority), { mode: 0o600 });

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
        extractEntry: vi.fn(),
        writeOutput: () => undefined,
      },
    );
    expect(code).toBe(1);
    expect(value.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects v4 and extra, omitted, or changed approval authority fields", async () => {
    type MutableAuthority = {
      schemaVersion: string;
      reviewedPullRequest: Record<string, unknown>;
    };
    const cases: ReadonlyArray<readonly [
      string,
      (authority: MutableAuthority) => void,
    ]> = [
      ["legacy schema", (authority) => {
        authority.schemaVersion = "pintpath-github-release-candidate-receipt/v4";
      }],
      ["extra legacy approval field", (authority) => {
        authority.reviewedPullRequest.approvingReviewIds = [3];
      }],
      ["omitted approval requirement", (authority) => {
        delete authority.reviewedPullRequest.pullRequestApprovalRequirement;
      }],
      ["changed approval requirement", (authority) => {
        authority.reviewedPullRequest.pullRequestApprovalRequirement = "required";
      }],
      ["inexact approval requirement", (authority) => {
        authority.reviewedPullRequest.pullRequestApprovalRequirementExact = false;
      }],
    ];

    for (const [label, mutate] of cases) {
      const value = fixture();
      const authority = JSON.parse(
        fs.readFileSync(value.authorityPath, "utf8"),
      ) as MutableAuthority;
      mutate(authority);
      fs.writeFileSync(value.authorityPath, canonical(authority), { mode: 0o600 });

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
          extractEntry: vi.fn(),
          writeOutput: () => undefined,
        },
      );
      expect(code, label).toBe(1);
      expect(value.fetchImpl, label).not.toHaveBeenCalled();
      expect(fs.existsSync(value.output), label).toBe(false);
    }
  });

  it("lists and extracts the downloaded ZIP only through an inherited held descriptor", async () => {
    const value = fixture({ archive: TRUSTED_ARCHIVE });
    const archivePath = path.join(
      value.root,
      ".production-rollout-artifact.zip",
    );

    const code = await runFixture(value, { useDefaultExtractEntry: true });

    expect(code).toBe(0);
    expect(fs.readFileSync(value.output, "utf8")).toBe(value.receiptSource);
    expect(fs.existsSync(archivePath)).toBe(false);
  });

  it("cannot list a forged ZIP swapped onto the temporary pathname", async () => {
    const value = fixture({ archive: TRUSTED_ARCHIVE });
    const archivePath = path.join(
      value.root,
      ".production-rollout-artifact.zip",
    );
    const displaced = path.join(value.root, "downloaded-held.zip");
    let childDescriptor: number | null = null;
    let listedSource = "";
    let spawnCalls = 0;
    const spawnImpl = ((...args: Parameters<typeof spawnSync>) => {
      spawnCalls += 1;
      if (spawnCalls === 1) {
        fs.renameSync(archivePath, displaced);
        fs.writeFileSync(archivePath, FORGED_LIST_ARCHIVE, { mode: 0o600 });
      }
      const options = args[2] as { stdio?: unknown[] };
      childDescriptor = options.stdio?.[3] as number;
      const result = Reflect.apply(spawnSync, null, args);
      if (spawnCalls === 1 && typeof result.stdout === "string") {
        listedSource = result.stdout;
      }
      return result;
    }) as typeof spawnSync;
    let summary = "";

    const code = await runFixture(value, {
      spawnSyncImpl: spawnImpl,
      useDefaultExtractEntry: true,
      writeOutput: (source) => {
        summary += source;
      },
    });

    expect(code).toBe(1);
    expect(spawnCalls).toBe(1);
    expect(listedSource.trim()).toBe(value.receiptEntry);
    expect(JSON.parse(summary)).toMatchObject({
      failureCode: "artifact_archive_invalid",
      ok: false,
    });
    expect(fs.existsSync(value.output)).toBe(false);
    expect(fs.readFileSync(archivePath).equals(FORGED_LIST_ARCHIVE)).toBe(true);
    expect(fs.readFileSync(displaced).equals(TRUSTED_ARCHIVE)).toBe(true);
    expect(childDescriptor).not.toBeNull();
    expect(() => fs.fstatSync(childDescriptor!)).toThrow();
  });

  it("cannot extract a forged ZIP swapped onto the temporary pathname", async () => {
    const value = fixture({ archive: TRUSTED_ARCHIVE });
    const archivePath = path.join(
      value.root,
      ".production-rollout-artifact.zip",
    );
    const displaced = path.join(value.root, "downloaded-held.zip");
    let extractedSource: Buffer | null = null;
    let spawnCalls = 0;
    const spawnImpl = ((...args: Parameters<typeof spawnSync>) => {
      spawnCalls += 1;
      if (spawnCalls === 2) {
        fs.renameSync(archivePath, displaced);
        fs.writeFileSync(archivePath, FORGED_EXTRACT_ARCHIVE, { mode: 0o600 });
      }
      const result = Reflect.apply(spawnSync, null, args);
      if (spawnCalls === 2 && Buffer.isBuffer(result.stdout)) {
        extractedSource = result.stdout;
      }
      return result;
    }) as typeof spawnSync;

    const code = await runFixture(value, {
      spawnSyncImpl: spawnImpl,
      useDefaultExtractEntry: true,
    });

    expect(code).toBe(1);
    expect(spawnCalls).toBe(2);
    expect(extractedSource?.toString("utf8")).toBe(value.receiptSource);
    expect(extractedSource?.toString("utf8")).not.toBe("{\"forged\":true}\n");
    expect(fs.existsSync(value.output)).toBe(false);
    expect(fs.readFileSync(archivePath).equals(FORGED_EXTRACT_ARCHIVE)).toBe(
      true,
    );
    expect(fs.readFileSync(displaced).equals(TRUSTED_ARCHIVE)).toBe(true);
  });

  it("writes zero archive bytes if the held output parent is swapped during reservation", async () => {
    const value = fixture({ archive: TRUSTED_ARCHIVE });
    const displaced = `${value.root}-held`;
    roots.push(displaced);
    const originalOpen = fs.openSync.bind(fs);
    let archiveCreateInjected = false;
    let spawnCalls = 0;
    vi.spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      const [target, flags] = args;
      if (
        !archiveCreateInjected &&
        typeof flags === "number" &&
        (flags & fs.constants.O_CREAT) !== 0 &&
        path.basename(String(target)) === ".production-rollout-artifact.zip"
      ) {
        archiveCreateInjected = true;
        fs.renameSync(value.root, displaced);
        fs.mkdirSync(value.root, { mode: 0o700 });
      }
      return Reflect.apply(originalOpen, fs, args);
    }) as typeof fs.openSync);
    const spawnImpl = ((...args: Parameters<typeof spawnSync>) => {
      spawnCalls += 1;
      return Reflect.apply(spawnSync, null, args);
    }) as typeof spawnSync;

    const code = await runFixture(value, {
      spawnSyncImpl: spawnImpl,
      useDefaultExtractEntry: true,
    });

    expect(code).toBe(1);
    expect(archiveCreateInjected).toBe(true);
    expect(spawnCalls).toBe(0);
    for (const parent of [value.root, displaced]) {
      const archivePath = path.join(
        parent,
        ".production-rollout-artifact.zip",
      );
      if (fs.existsSync(archivePath)) {
        expect(fs.statSync(archivePath).size).toBe(0);
      }
      expect(fs.existsSync(path.join(parent, path.basename(value.output))))
        .toBe(false);
    }
  });

  it("rejects noncanonical and symlinked output parents before archive reservation", async () => {
    for (const kind of ["noncanonical", "symlink"] as const) {
      const value = fixture({ archive: TRUSTED_ARCHIVE });
      if (kind === "noncanonical") {
        value.output = `${value.root}/missing/../receipt.json`;
      } else {
        const actual = path.join(value.root, "actual-parent");
        const linked = path.join(value.root, "linked-parent");
        fs.mkdirSync(actual, { mode: 0o700 });
        fs.symlinkSync(actual, linked);
        value.output = path.join(linked, "receipt.json");
      }
      const originalOpen = fs.openSync.bind(fs);
      let archiveCreates = 0;
      vi.spyOn(fs, "openSync").mockImplementation(((
        ...args: Parameters<typeof fs.openSync>
      ) => {
        const [target, flags] = args;
        if (
          typeof flags === "number" &&
          (flags & fs.constants.O_CREAT) !== 0 &&
          path.basename(String(target)) === ".production-rollout-artifact.zip"
        ) {
          archiveCreates += 1;
        }
        return Reflect.apply(originalOpen, fs, args);
      }) as typeof fs.openSync);

      const code = await runFixture(value, { useDefaultExtractEntry: true });

      expect(code, kind).toBe(1);
      expect(archiveCreates, kind).toBe(0);
      expect(fs.existsSync(path.join(
        value.root,
        ".production-rollout-artifact.zip",
      )), kind).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("rejects an authority pathname swap after identity inspection and closes its descriptor", async () => {
    const value = fixture();
    const displaced = path.join(value.root, "authority-held.json");
    const forged = JSON.parse(fs.readFileSync(value.authorityPath, "utf8"));
    forged.consumer = { forged: true };
    const originalOpen = fs.openSync.bind(fs);
    const originalLstat = fs.lstatSync.bind(fs);
    let authorityDescriptor: number | null = null;
    let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      const descriptor = Reflect.apply(originalOpen, fs, args);
      if (args[0] === value.authorityPath) authorityDescriptor = descriptor;
      return descriptor;
    }) as typeof fs.openSync);
    vi.spyOn(fs, "lstatSync").mockImplementation(((
      ...args: Parameters<typeof fs.lstatSync>
    ) => {
      const result = Reflect.apply(originalLstat, fs, args);
      if (!replaced && args[0] === value.authorityPath) {
        replaced = true;
        fs.renameSync(value.authorityPath, displaced);
        fs.writeFileSync(value.authorityPath, canonical(forged), {
          mode: 0o600,
        });
      }
      return result;
    }) as typeof fs.lstatSync);

    const code = await runFixture(value);

    expect(code).toBe(1);
    expect(replaced).toBe(true);
    expect(value.fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(value.output)).toBe(false);
    expect(authorityDescriptor).not.toBeNull();
    expect(() => fs.fstatSync(authorityDescriptor!)).toThrow();
  });

  it("rejects an authority pathname swap during descriptor-only reading", async () => {
    const value = fixture();
    const displaced = path.join(value.root, "authority-held.json");
    const forged = JSON.parse(fs.readFileSync(value.authorityPath, "utf8"));
    forged.consumer = { forged: true };
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readSync.bind(fs);
    let authorityDescriptor: number | null = null;
    let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      const descriptor = Reflect.apply(originalOpen, fs, args);
      if (args[0] === value.authorityPath) authorityDescriptor = descriptor;
      return descriptor;
    }) as typeof fs.openSync);
    vi.spyOn(fs, "readSync").mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      if (!replaced && args[0] === authorityDescriptor) {
        replaced = true;
        fs.renameSync(value.authorityPath, displaced);
        fs.writeFileSync(value.authorityPath, canonical(forged), {
          mode: 0o600,
        });
      }
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readSync);

    const code = await runFixture(value);

    expect(code).toBe(1);
    expect(replaced).toBe(true);
    expect(value.fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(value.output)).toBe(false);
    expect(authorityDescriptor).not.toBeNull();
    expect(() => fs.fstatSync(authorityDescriptor!)).toThrow();
  });

  it("rejects an output parent swap after its descriptor is held", async () => {
    const value = fixture();
    const displaced = `${value.root}-held`;
    roots.push(displaced);
    const originalOpen = fs.openSync.bind(fs);
    let parentDescriptor: number | null = null;
    let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      const descriptor = Reflect.apply(originalOpen, fs, args);
      const [target, flags] = args;
      if (
        !replaced &&
        target === value.root &&
        typeof flags === "number" &&
        (flags & fs.constants.O_DIRECTORY) !== 0
      ) {
        replaced = true;
        parentDescriptor = descriptor;
        fs.renameSync(value.root, displaced);
        fs.mkdirSync(value.root, { mode: 0o700 });
      }
      return descriptor;
    }) as typeof fs.openSync);
    let summary = "";

    const code = await runFixture(value, {
      writeOutput: (source) => {
        summary += source;
      },
    });

    expect(code).toBe(1);
    expect(replaced).toBe(true);
    expect(JSON.parse(summary)).toMatchObject({
      failureCode: "output_unsafe",
      ok: false,
    });
    expect(fs.existsSync(value.output)).toBe(false);
    expect(fs.existsSync(path.join(displaced, path.basename(value.output))))
      .toBe(false);
    expect(parentDescriptor).not.toBeNull();
    expect(() => fs.fstatSync(parentDescriptor!)).toThrow();
  });

  it("writes no forged bytes when the output parent is swapped during child creation", async () => {
    const value = fixture();
    const displaced = `${value.root}-held`;
    roots.push(displaced);
    const originalOpen = fs.openSync.bind(fs);
    let parentDescriptor: number | null = null;
    let outputDescriptor: number | null = null;
    let replaced = false;
    let creationTarget = "";
    vi.spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      const [target, flags] = args;
      if (
        !replaced &&
        typeof flags === "number" &&
        (flags & fs.constants.O_CREAT) !== 0 &&
        path.basename(String(target)) === path.basename(value.output)
      ) {
        replaced = true;
        creationTarget = String(target);
        fs.renameSync(value.root, displaced);
        fs.mkdirSync(value.root, { mode: 0o700 });
      }
      const descriptor = Reflect.apply(originalOpen, fs, args);
      if (
        target === value.root &&
        typeof flags === "number" &&
        (flags & fs.constants.O_DIRECTORY) !== 0
      ) {
        parentDescriptor = descriptor;
      }
      if (
        typeof flags === "number" &&
        (flags & fs.constants.O_CREAT) !== 0 &&
        path.basename(String(target)) === path.basename(value.output)
      ) {
        outputDescriptor = descriptor;
      }
      return descriptor;
    }) as typeof fs.openSync);
    let summary = "";

    const code = await runFixture(value, {
      writeOutput: (source) => {
        summary += source;
      },
    });

    expect(code).toBe(1);
    expect(replaced).toBe(true);
    if (process.platform === "linux") {
      expect(creationTarget).toMatch(
        /^\/proc\/self\/fd\/[1-9][0-9]*\/promotion-recovery-receipt\.json$/,
      );
    }
    expect(JSON.parse(summary)).toMatchObject({
      failureCode: "output_unsafe",
      ok: false,
    });
    for (const candidate of [
      value.output,
      path.join(displaced, path.basename(value.output)),
    ]) {
      if (fs.existsSync(candidate)) {
        expect(fs.readFileSync(candidate, "utf8")).not.toBe(
          value.receiptSource,
        );
        expect(fs.statSync(candidate).size).toBe(0);
      }
    }
    expect(parentDescriptor).not.toBeNull();
    expect(outputDescriptor).not.toBeNull();
    expect(() => fs.fstatSync(parentDescriptor!)).toThrow();
    expect(() => fs.fstatSync(outputDescriptor!)).toThrow();
  });

  it("does not follow or overwrite an existing output link", async () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const value = fixture();
      const victim = path.join(value.root, `${kind}-victim.json`);
      fs.writeFileSync(victim, "preserve-me\n", { mode: 0o600 });
      if (kind === "symlink") fs.symlinkSync(victim, value.output);
      else fs.linkSync(victim, value.output);

      const code = await runFixture(value);

      expect(code, kind).toBe(1);
      expect(fs.readFileSync(victim, "utf8"), kind).toBe("preserve-me\n");
      expect(fs.readFileSync(value.output, "utf8"), kind).toBe(
        "preserve-me\n",
      );
    }
  });
});
