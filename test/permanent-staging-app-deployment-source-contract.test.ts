import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_LOCK as LOCK,
  PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_STATE,
  PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA,
  PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS,
  PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM,
  evaluatePermanentStagingAppDeploymentSourceFixture,
  isPermanentStagingAppDeploymentSourceCandidate,
  parsePermanentStagingAppDeploymentSourceFixture,
  type PermanentStagingAppDeploymentSourceManifestEntry,
} from "../scripts/lib/permanent-staging-app-deployment-source-contract.js";
import { PERMANENT_STAGING_APP_DEPLOYMENT_LOCK } from
  "../scripts/lib/permanent-staging-app-deployment-executor.js";

const HEAD_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const APP_SHA256 = "c".repeat(64);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function exactEntries(): PermanentStagingAppDeploymentSourceManifestEntry[] {
  return [
    ["package-lock.json", "f", 384, 123, LOCK.packageLockSha256],
    ["railway.toml", "f", 384, 456, LOCK.railwayConfigSha256],
    ["src", "d", 448, 0, null],
    ["src/index.ts", "f", 384, 12, APP_SHA256],
  ];
}

function exactEntriesWithAdditionalLeaf(
  leafPath: string,
): PermanentStagingAppDeploymentSourceManifestEntry[] {
  const separator = leafPath.lastIndexOf("/");
  if (separator < 0) {
    return [
      [leafPath, "f", 384, 1, APP_SHA256],
      ...exactEntries(),
    ];
  }
  const parent = leafPath.slice(0, separator);
  return [
    [parent, "d", 448, 0, null],
    [leafPath, "f", 384, 1, APP_SHA256],
    ...exactEntries(),
  ];
}

function fixtureObject(
  entries: readonly PermanentStagingAppDeploymentSourceManifestEntry[] = exactEntries(),
): Record<string, unknown> {
  const directoryCount = entries.filter((entry) => entry[1] === "d").length;
  const files = entries.filter((entry) => entry[1] === "f");
  return {
    schemaVersion: PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA,
    activationAuthorized: false,
    providerCandidateBindingAvailable: false,
    candidateSha: HEAD_SHA,
    treeSha: TREE_SHA,
    git: {
      objectFormat: "sha1",
      headBefore: HEAD_SHA,
      treeBefore: TREE_SHA,
      porcelainV2: "",
      materializedCommitSha: HEAD_SHA,
      materializedTreeSha: TREE_SHA,
      headAfter: HEAD_SHA,
      treeAfter: TREE_SHA,
      committedObjectEnumerationComplete: true,
      blobObjectIdsVerified: true,
      treeObjectIdVerified: true,
      committedEntryModesExact: true,
      symlinkEntryCount: 0,
      gitlinkEntryCount: 0,
      worktreeAttributesUsed: false,
    },
    upload: {
      futureMode: "explicit-snapshot-path",
      explicitSnapshotPathRequired: true,
      pathAsRootFlag: "--path-as-root",
      noGitignoreFlag: "--no-gitignore",
      pathAsRootRequired: true,
      noGitignoreRequired: true,
      railwayIgnoreAbsent: true,
      gitAttributesAbsent: true,
      gitmodulesAbsent: true,
      dotIgnoreAbsent: true,
      nodeModulesAbsent: true,
      uploaderEntrySetBindingAvailable: false,
      ancestorIgnoreIndependentUploadAvailable: false,
      allIgnoreAndParentFiltersDisabled: false,
      reviewedUploaderEntrySetSha256: null,
    },
    snapshot: {
      absoluteCanonicalPath: true,
      directChildOfPrivateTmp: true,
      exclusiveCreation: true,
      atomicPublication: true,
      rootCurrentUid: true,
      rootMode0700: true,
      rootNonSymlink: true,
      rootSameDeviceAsPrivateTmp: true,
      privateTmpRootOwnedSticky01777: true,
      privateAncestorsRootOwnedNonWritable: true,
      identityHeld: true,
      identityReasserted: true,
      allDirectoriesCurrentUidMode0700: true,
      allFilesCurrentUidMode0600Or0700: true,
      allFilesNlinkOne: true,
      specialFilesAbsent: true,
      aclAuthorityInspected: true,
      aclEntriesAbsent: true,
    },
    manifest: {
      algorithm: PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM,
      complete: true,
      entries,
      sha256: sha256(JSON.stringify(entries)),
      entryCount: entries.length,
      directoryCount,
      fileCount: files.length,
      fileBytes: files.reduce((total, entry) => total + entry[3], 0),
    },
  };
}

function fixtureSource(
  entries: readonly PermanentStagingAppDeploymentSourceManifestEntry[] = exactEntries(),
): string {
  return `${JSON.stringify(fixtureObject(entries))}\n`;
}

function mutate(
  update: (value: Record<string, any>) => void,
  entries: readonly PermanentStagingAppDeploymentSourceManifestEntry[] = exactEntries(),
): string {
  const value = fixtureObject(entries) as Record<string, any>;
  update(value);
  return `${JSON.stringify(value)}\n`;
}

describe("permanent staging app deployment source contract", () => {
  it("is a capability-pure legacy validator superseded by the protected executor", () => {
    const source = fs.readFileSync(path.resolve(
      "scripts/lib/permanent-staging-app-deployment-source-contract.ts",
    ), "utf8");
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_CONTRACT_STATE).toBe(
      "SUPERSEDED_BY_PROTECTED_EXECUTOR_OFFLINE_VALIDATOR_ONLY",
    );
    expect(LOCK).toEqual({
      railwayConfigPath: "railway.toml",
      railwayConfigSha256:
        "85dc659ebec2e0132092d917505d71678e92b8441b54bcefc80c6a082e3b967b",
      packageLockPath: "package-lock.json",
      packageLockSha256:
        "b5bfc2258853ab58dd5749b91ae55d9724620e102fe55e91de31a4599ab9f67b",
      futureUploadPathMode: "explicit-snapshot-path",
      futurePathAsRootFlag: "--path-as-root",
      futureNoGitignoreFlag: "--no-gitignore",
      futurePathAsRootRequired: true,
      futureNoGitignoreRequired: true,
      uploaderEntrySetBindingAvailable: false,
      ancestorIgnoreIndependentUploadAvailable: false,
      providerCandidateBindingAvailable: false,
      activationAuthorized: false,
    });
    expect(LOCK.railwayConfigSha256).toBe(
      PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.sourceContract.railwayConfigSha256,
    );
    expect(LOCK.packageLockSha256).toBe(
      PERMANENT_STAGING_APP_DEPLOYMENT_LOCK.sourceContract.packageLockSha256,
    );
    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("node:path");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("process.argv");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("railway up");
    expect(source).not.toContain("git archive");
  });

  it("parses and evaluates one exact canonical offline fixture", () => {
    const parsed = parsePermanentStagingAppDeploymentSourceFixture(fixtureSource());
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      authority: "offline-strict-json-fixture-candidate",
      activationAuthorized: false,
      providerCandidateBindingAvailable: false,
      candidateSha: HEAD_SHA,
      treeSha: TREE_SHA,
      git: {
        headBefore: HEAD_SHA,
        headAfter: HEAD_SHA,
        treeBefore: TREE_SHA,
        treeAfter: TREE_SHA,
        porcelainV2: "",
        symlinkEntryCount: 0,
        gitlinkEntryCount: 0,
      },
      upload: {
        futureMode: "explicit-snapshot-path",
        explicitSnapshotPathRequired: true,
        pathAsRootFlag: "--path-as-root",
        noGitignoreFlag: "--no-gitignore",
        pathAsRootRequired: true,
        noGitignoreRequired: true,
        railwayIgnoreAbsent: true,
        dotIgnoreAbsent: true,
        nodeModulesAbsent: true,
        uploaderEntrySetBindingAvailable: false,
        ancestorIgnoreIndependentUploadAvailable: false,
        allIgnoreAndParentFiltersDisabled: false,
        reviewedUploaderEntrySetSha256: null,
      },
      manifest: {
        entryCount: 4,
        directoryCount: 1,
        fileCount: 3,
        fileBytes: 591,
      },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed!.git)).toBe(true);
    expect(Object.isFrozen(parsed!.upload)).toBe(true);
    expect(Object.isFrozen(parsed!.snapshot)).toBe(true);
    expect(Object.isFrozen(parsed!.manifest)).toBe(true);
    expect(Object.isFrozen(parsed!.manifest.entries)).toBe(true);
    expect(parsed!.manifest.entries.every(Object.isFrozen)).toBe(true);

    const candidate = evaluatePermanentStagingAppDeploymentSourceFixture(parsed);
    expect(candidate).toEqual({
      schemaVersion: "pintpath-permanent-staging-app-source-snapshot-candidate/v1",
      authority: "offline-structural-source-candidate",
      contractState: "SUPERSEDED_BY_PROTECTED_EXECUTOR_OFFLINE_VALIDATOR_ONLY",
      activationAuthorized: false,
      providerCandidateBindingAvailable: false,
      candidateSha: HEAD_SHA,
      treeSha: TREE_SHA,
      porcelainV2Empty: true,
      committedObjectMaterializationFixtureExact: true,
      privateSnapshotFixtureExact: true,
      futureUploadPathMode: "explicit-snapshot-path",
      futurePathAsRootFlag: "--path-as-root",
      futureNoGitignoreFlag: "--no-gitignore",
      futurePathAsRootRequired: true,
      futureNoGitignoreRequired: true,
      exclusionControlFilesAbsent: true,
      uploaderEntrySetBindingAvailable: false,
      ancestorIgnoreIndependentUploadAvailable: false,
      allIgnoreAndParentFiltersDisabled: false,
      reviewedUploaderEntrySetSha256: null,
      sourceManifestBoundToUploaderEntrySet: false,
      sourceManifestAlgorithm:
        PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_MANIFEST_ALGORITHM,
      sourceManifestSha256: parsed!.manifest.sha256,
      sourceEntryCount: 4,
      sourceDirectoryCount: 1,
      sourceFileCount: 3,
      sourceFileBytes: 591,
      railwayConfigSha256: LOCK.railwayConfigSha256,
      packageLockSha256: LOCK.packageLockSha256,
    });
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(isPermanentStagingAppDeploymentSourceCandidate(candidate)).toBe(true);
  });

  it.each([
    ["missing final newline", () => fixtureSource().slice(0, -1)],
    ["extra final newline", () => `${fixtureSource()}\n`],
    ["pretty JSON", () => `${JSON.stringify(fixtureObject(), null, 2)}\n`],
    ["leading whitespace", () => ` ${fixtureSource()}`],
    ["malformed JSON", () => "{\n"],
    ["unknown top-level key", () => mutate((value) => { value.unknown = true; })],
    ["unknown nested key", () => mutate((value) => { value.git.unknown = true; })],
    ["reordered keys", () => {
      const value = fixtureObject();
      const reordered = { candidateSha: value.candidateSha, ...value };
      return `${JSON.stringify(reordered)}\n`;
    }],
    ["duplicate keys", () => fixtureSource().replace(
      `{"schemaVersion":"${PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA}",`,
      `{"schemaVersion":"${PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA}","schemaVersion":"${PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_FIXTURE_SCHEMA}",`,
    )],
  ])("rejects non-canonical fixture bytes: %s", (_label, source) => {
    expect(parsePermanentStagingAppDeploymentSourceFixture(source())).toBeNull();
  });

  it.each([
    ["activation", (value: any) => { value.activationAuthorized = true; }],
    ["provider candidate binding", (value: any) => {
      value.providerCandidateBindingAvailable = true;
    }],
    ["HEAD before", (value: any) => { value.git.headBefore = "d".repeat(40); }],
    ["HEAD after", (value: any) => { value.git.headAfter = "d".repeat(40); }],
    ["tree before", (value: any) => { value.git.treeBefore = "d".repeat(40); }],
    ["tree after", (value: any) => { value.git.treeAfter = "d".repeat(40); }],
    ["materialized commit", (value: any) => {
      value.git.materializedCommitSha = "d".repeat(40);
    }],
    ["materialized tree", (value: any) => {
      value.git.materializedTreeSha = "d".repeat(40);
    }],
    ["dirty porcelain", (value: any) => { value.git.porcelainV2 = "1 M. file"; }],
    ["incomplete enumeration", (value: any) => {
      value.git.committedObjectEnumerationComplete = false;
    }],
    ["unverified blob", (value: any) => { value.git.blobObjectIdsVerified = false; }],
    ["unverified tree", (value: any) => { value.git.treeObjectIdVerified = false; }],
    ["unverified Git entry modes", (value: any) => {
      value.git.committedEntryModesExact = false;
    }],
    ["symlink", (value: any) => { value.git.symlinkEntryCount = 1; }],
    ["gitlink", (value: any) => { value.git.gitlinkEntryCount = 1; }],
    ["worktree attributes", (value: any) => {
      value.git.worktreeAttributesUsed = true;
    }],
    ["missing path-as-root", (value: any) => {
      value.upload.pathAsRootRequired = false;
    }],
    ["missing explicit snapshot path", (value: any) => {
      value.upload.explicitSnapshotPathRequired = false;
    }],
    ["wrong path-as-root flag", (value: any) => {
      value.upload.pathAsRootFlag = "--wrong";
    }],
    ["missing no-gitignore", (value: any) => {
      value.upload.noGitignoreRequired = false;
    }],
    ["wrong no-gitignore flag", (value: any) => {
      value.upload.noGitignoreFlag = "--wrong";
    }],
    ["possible Railway ignore", (value: any) => {
      value.upload.railwayIgnoreAbsent = false;
    }],
    ["possible dot-ignore", (value: any) => {
      value.upload.dotIgnoreAbsent = false;
    }],
    ["possible node_modules", (value: any) => {
      value.upload.nodeModulesAbsent = false;
    }],
    ["forged uploader entry-set binding", (value: any) => {
      value.upload.uploaderEntrySetBindingAvailable = true;
    }],
    ["forged ancestor-ignore independence", (value: any) => {
      value.upload.ancestorIgnoreIndependentUploadAvailable = true;
    }],
    ["forged disabled-filter proof", (value: any) => {
      value.upload.allIgnoreAndParentFiltersDisabled = true;
    }],
    ["forged uploader entry-set digest", (value: any) => {
      value.upload.reviewedUploaderEntrySetSha256 = "d".repeat(64);
    }],
  ])("rejects unsafe Git/upload claim drift: %s", (_label, update) => {
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      mutate(update),
    )).toBeNull();
  });

  it("requires every private snapshot assertion to be exact", () => {
    const keys = Object.keys((fixtureObject() as any).snapshot);
    for (const key of keys) {
      const source = mutate((value) => { value.snapshot[key] = false; });
      expect(
        parsePermanentStagingAppDeploymentSourceFixture(source),
        key,
      ).toBeNull();
    }
  });

  it.each([
    [".ignore", ".safe-ignore"],
    [".railwayignore", ".safe-railwayignore"],
    [".gitattributes", ".safe-gitattributes"],
    [".gitmodules", ".safe-gitmodules"],
    ["nested/.railwayignore", "nested/.safe-railwayignore"],
    ["nested/.ignore", "nested/.safe-ignore"],
    ["nested/.GITATTRIBUTES", "nested/.SAFE-GITATTRIBUTES"],
    [".git/config", ".git-safe/config"],
  ])("rejects hidden source-control/exclusion path %s", (forbidden, safe) => {
    const safeEntries = exactEntriesWithAdditionalLeaf(safe);
    expect(
      parsePermanentStagingAppDeploymentSourceFixture(fixtureSource(safeEntries)),
      `safe control for ${forbidden}`,
    ).not.toBeNull();

    const entries = exactEntriesWithAdditionalLeaf(forbidden);
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(entries),
    )).toBeNull();
  });

  it("rejects a nested node_modules tree that the current uploader skips", () => {
    const entries: PermanentStagingAppDeploymentSourceManifestEntry[] = [
      ...exactEntries(),
      ["src/node_modules", "d", 448, 0, null],
      ["src/node_modules/package.json", "f", 384, 1, APP_SHA256],
    ];
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(entries),
    )).toBeNull();
  });

  it("retains unavailable uploader and ancestor-ignore proof after evaluation", () => {
    const parsed = parsePermanentStagingAppDeploymentSourceFixture(fixtureSource());
    const candidate = evaluatePermanentStagingAppDeploymentSourceFixture(parsed);
    expect(candidate).toMatchObject({
      activationAuthorized: false,
      providerCandidateBindingAvailable: false,
      uploaderEntrySetBindingAvailable: false,
      ancestorIgnoreIndependentUploadAvailable: false,
      allIgnoreAndParentFiltersDisabled: false,
      reviewedUploaderEntrySetSha256: null,
      sourceManifestBoundToUploaderEntrySet: false,
    });
  });

  it("allows a tracked .gitignore only under the fixed no-gitignore contract", () => {
    const entries: PermanentStagingAppDeploymentSourceManifestEntry[] = [
      [".gitignore", "f", 384, 1, APP_SHA256],
      ...exactEntries(),
    ];
    const parsed = parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(entries),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.upload.noGitignoreFlag).toBe("--no-gitignore");
    expect(parsed!.upload.noGitignoreRequired).toBe(true);
  });

  it.each([
    ["traversal", "../escape"],
    ["nested traversal", "src/../escape"],
    ["absolute", "/escape"],
    ["backslash", "src\\escape"],
    ["empty component", "src//escape"],
    ["trailing slash", "src/"],
    ["control", "src/escape\nvalue"],
    ["non-NFC", "src/e\u0301.ts"],
  ])("rejects invalid manifest path: %s", (_label, invalidPath) => {
    const entries = exactEntries();
    entries[3] = [invalidPath, "f", 384, 12, APP_SHA256];
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(entries),
    )).toBeNull();
  });

  it("rejects Unicode filesystem aliases outside the portable ASCII path set", () => {
    const entries = exactEntries();
    entries.push(["src/Σ.ts", "f", 384, 1, APP_SHA256]);
    entries.push(["src/σ.ts", "f", 384, 1, APP_SHA256]);
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(entries),
    )).toBeNull();
  });

  const manifestShapeCases: Array<[
    string,
    PermanentStagingAppDeploymentSourceManifestEntry[],
  ]> = [
    ["duplicate", [
      ...exactEntries(),
      ["src/index.ts", "f", 384, 12, APP_SHA256],
    ]],
    ["case collision", [
      ...exactEntries(),
      ["SRC", "d", 448, 0, null],
      ["SRC/other.ts", "f", 384, 1, APP_SHA256],
    ]],
    ["orphan child", [
      ...exactEntries().slice(0, 2),
      ["missing/index.ts", "f", 384, 1, APP_SHA256],
    ]],
    ["file as parent", [
      ...exactEntries().slice(0, 2),
      ["src", "f", 384, 1, APP_SHA256],
      ["src/index.ts", "f", 384, 1, APP_SHA256],
    ]],
    ["empty directory", [
      ...exactEntries(),
      ["unused", "d", 448, 0, null],
    ]],
  ];
  it.each(manifestShapeCases)("rejects manifest collision/shape: %s", (_label, entries) => {
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(entries),
    )).toBeNull();
  });

  it("requires exact depth-first bytewise sibling order", () => {
    const entries = exactEntries();
    [entries[0], entries[1]] = [entries[1]!, entries[0]!];
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(entries),
    )).toBeNull();
  });

  it("enforces fixture, entry, depth, component, and total-byte bounds", () => {
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      "x".repeat(PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumFixtureBytes + 1),
    )).toBeNull();

    const tooMany: PermanentStagingAppDeploymentSourceManifestEntry[] = [];
    for (
      let index = 0;
      index <= PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumEntries;
      index += 1
    ) {
      tooMany.push([
        `a${String(index).padStart(4, "0")}.txt`,
        "f",
        384,
        0,
        APP_SHA256,
      ]);
    }
    tooMany.push(...exactEntries());
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(tooMany),
    )).toBeNull();

    const tooDeep = exactEntries();
    const directoryPaths: string[] = [];
    let current = "a";
    for (
      let depth = 1;
      depth <= PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumDepth;
      depth += 1
    ) {
      directoryPaths.push(current);
      current += "/a";
    }
    const deepEntries: PermanentStagingAppDeploymentSourceManifestEntry[] = [
      ...directoryPaths.map((entryPath) => [entryPath, "d", 448, 0, null] as const),
      [current, "f", 384, 0, APP_SHA256],
      ...tooDeep,
    ];
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(deepEntries),
    )).toBeNull();

    const longComponent = exactEntries();
    longComponent.push([
      "z".repeat(
        PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumComponentBytes + 1,
      ),
      "f",
      384,
      0,
      APP_SHA256,
    ]);
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(longComponent),
    )).toBeNull();

    const maximumFileBytes =
      PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumFileBytes;
    const tooManyBytes: PermanentStagingAppDeploymentSourceManifestEntry[] = [
      ["a.bin", "f", 384, maximumFileBytes, APP_SHA256],
      ["b.bin", "f", 384, maximumFileBytes, APP_SHA256],
      ...exactEntries(),
    ];
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      fixtureSource(tooManyBytes),
    )).toBeNull();
  });

  it.each([
    ["directory mode", (entries: any[]) => { entries[2][2] = 493; }],
    ["directory size", (entries: any[]) => { entries[2][3] = 1; }],
    ["directory digest", (entries: any[]) => { entries[2][4] = APP_SHA256; }],
    ["file mode", (entries: any[]) => { entries[3][2] = 420; }],
    ["negative file size", (entries: any[]) => { entries[3][3] = -1; }],
    ["oversized file", (entries: any[]) => {
      entries[3][3] = PERMANENT_STAGING_APP_DEPLOYMENT_SOURCE_LIMITS.maximumFileBytes + 1;
    }],
    ["bad content hash", (entries: any[]) => { entries[3][4] = "A".repeat(64); }],
    ["symlink type", (entries: any[]) => { entries[3][1] = "l"; }],
    ["gitlink type", (entries: any[]) => { entries[3][1] = "g"; }],
  ])("rejects invalid manifest tuple: %s", (_label, update) => {
    const entries: any[] = JSON.parse(JSON.stringify(exactEntries()));
    update(entries);
    const value = fixtureObject(entries);
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      `${JSON.stringify(value)}\n`,
    )).toBeNull();
  });

  it.each([
    ["manifest algorithm", (value: any) => { value.manifest.algorithm = "sha256"; }],
    ["manifest completeness", (value: any) => { value.manifest.complete = false; }],
    ["manifest hash", (value: any) => { value.manifest.sha256 = "d".repeat(64); }],
    ["entry count", (value: any) => { value.manifest.entryCount += 1; }],
    ["directory count", (value: any) => { value.manifest.directoryCount += 1; }],
    ["file count", (value: any) => { value.manifest.fileCount += 1; }],
    ["file bytes", (value: any) => { value.manifest.fileBytes += 1; }],
    ["railway.toml hash", (value: any) => {
      value.manifest.entries[1][4] = "d".repeat(64);
      value.manifest.sha256 = sha256(JSON.stringify(value.manifest.entries));
    }],
    ["package-lock hash", (value: any) => {
      value.manifest.entries[0][4] = "d".repeat(64);
      value.manifest.sha256 = sha256(JSON.stringify(value.manifest.entries));
    }],
  ])("rejects manifest authority drift: %s", (_label, update) => {
    expect(parsePermanentStagingAppDeploymentSourceFixture(
      mutate(update),
    )).toBeNull();
  });

  it("rejects objects, accessors, and proxies without invoking them", () => {
    const accessor = vi.fn(() => {
      throw new Error("accessor invoked");
    });
    const object = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(object, "schemaVersion", {
      enumerable: true,
      get: accessor,
    });
    const proxyTrap = vi.fn(() => {
      throw new Error("proxy trap invoked");
    });
    const proxy = new Proxy({}, {
      get: proxyTrap,
      getPrototypeOf: proxyTrap,
      ownKeys: proxyTrap,
    });
    expect(parsePermanentStagingAppDeploymentSourceFixture(object)).toBeNull();
    expect(parsePermanentStagingAppDeploymentSourceFixture(proxy)).toBeNull();
    expect(evaluatePermanentStagingAppDeploymentSourceFixture(object)).toBeNull();
    expect(evaluatePermanentStagingAppDeploymentSourceFixture(proxy)).toBeNull();
    expect(isPermanentStagingAppDeploymentSourceCandidate(proxy)).toBe(false);
    expect(accessor).not.toHaveBeenCalled();
    expect(proxyTrap).not.toHaveBeenCalled();
  });

  it("rejects forged and JSON-cloned authorities", () => {
    const parsed = parsePermanentStagingAppDeploymentSourceFixture(fixtureSource())!;
    const clone = JSON.parse(JSON.stringify(parsed));
    expect(evaluatePermanentStagingAppDeploymentSourceFixture(clone)).toBeNull();
    expect(isPermanentStagingAppDeploymentSourceCandidate({
      ...evaluatePermanentStagingAppDeploymentSourceFixture(parsed),
    })).toBe(false);
  });

  it("uses captured intrinsics after hostile post-import mutation", () => {
    const source = fixtureSource();
    const defineProperty = Object.defineProperty;
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const targets: Array<[object, PropertyKey, unknown]> = [
      [JSON, "parse", JSON.parse],
      [JSON, "stringify", JSON.stringify],
      [Object, "freeze", Object.freeze],
      [Object, "defineProperty", Object.defineProperty],
      [Object, "getOwnPropertyDescriptor", Object.getOwnPropertyDescriptor],
      [Object, "getPrototypeOf", Object.getPrototypeOf],
      [Object, "hasOwn", Object.hasOwn],
      [Reflect, "apply", Reflect.apply],
      [Reflect, "ownKeys", Reflect.ownKeys],
      [Array, "isArray", Array.isArray],
      [Array.prototype, "push", Array.prototype.push],
      [Array.prototype, "sort", Array.prototype.sort],
      [Array.prototype, "join", Array.prototype.join],
      [Buffer, "byteLength", Buffer.byteLength],
      [Buffer, "from", Buffer.from],
      [Buffer, "compare", Buffer.compare],
      [RegExp.prototype, "exec", RegExp.prototype.exec],
      [String.prototype, "includes", String.prototype.includes],
      [String.prototype, "lastIndexOf", String.prototype.lastIndexOf],
      [String.prototype, "normalize", String.prototype.normalize],
      [String.prototype, "slice", String.prototype.slice],
      [String.prototype, "split", String.prototype.split],
      [String.prototype, "toLowerCase", String.prototype.toLowerCase],
      [Map.prototype, "get", Map.prototype.get],
      [Map.prototype, "set", Map.prototype.set],
      [Set.prototype, "add", Set.prototype.add],
      [Set.prototype, "has", Set.prototype.has],
      [WeakSet.prototype, "add", WeakSet.prototype.add],
      [WeakSet.prototype, "has", WeakSet.prototype.has],
      [crypto, "createHash", crypto.createHash],
    ];
    const descriptors = targets.map(([target, key]) =>
      getOwnPropertyDescriptor(target, key));
    const objectToJson = getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayToJson = getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const arrayZero = getOwnPropertyDescriptor(Array.prototype, "0");
    const arraySpecies = getOwnPropertyDescriptor(Array, Symbol.species);
    let parsed: ReturnType<
      typeof parsePermanentStagingAppDeploymentSourceFixture
    > = null;
    let candidate: ReturnType<
      typeof evaluatePermanentStagingAppDeploymentSourceFixture
    > = null;
    let caught: unknown;
    try {
      for (const [target, key] of targets) {
        defineProperty(target, key, {
          configurable: true,
          writable: true,
          value: () => { throw new Error("poisoned intrinsic"); },
        });
      }
      defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => ({ forged: true }),
      });
      defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => ["forged"],
      });
      defineProperty(Array.prototype, "0", {
        configurable: true,
        get: () => { throw new Error("inherited numeric getter"); },
        set: () => { throw new Error("inherited numeric setter"); },
      });
      defineProperty(Array, Symbol.species, {
        configurable: true,
        get: () => { throw new Error("array species getter"); },
      });
      parsed = parsePermanentStagingAppDeploymentSourceFixture(source);
      candidate = evaluatePermanentStagingAppDeploymentSourceFixture(parsed);
    } catch (error) {
      caught = error;
    } finally {
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const [target, key] = targets[index]!;
        const descriptor = descriptors[index];
        if (descriptor) defineProperty(target, key, descriptor);
      }
      if (objectToJson) {
        defineProperty(Object.prototype, "toJSON", objectToJson);
      } else {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      }
      if (arrayToJson) {
        defineProperty(Array.prototype, "toJSON", arrayToJson);
      } else {
        delete (Array.prototype as { toJSON?: unknown }).toJSON;
      }
      if (arrayZero) {
        defineProperty(Array.prototype, "0", arrayZero);
      } else {
        delete (Array.prototype as unknown as Record<string, unknown>)["0"];
      }
      if (arraySpecies) defineProperty(Array, Symbol.species, arraySpecies);
    }
    expect(caught).toBeUndefined();
    expect(parsed).not.toBeNull();
    expect(candidate).toMatchObject({
      activationAuthorized: false,
      providerCandidateBindingAvailable: false,
      candidateSha: HEAD_SHA,
      treeSha: TREE_SHA,
    });
  });
});
