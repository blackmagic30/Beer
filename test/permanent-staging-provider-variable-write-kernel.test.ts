import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Receipt tests need the genuine local/process brand chain, while Linux CI
// deliberately has no reviewed macOS Railway binary. Replace only this
// isolated test graph's immutable CLI lock with a private, never-run fixture.
const KERNEL_RAILWAY_CLI_FIXTURE = vi.hoisted(() => {
  const fsExact = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  const osExact = process.getBuiltinModule("node:os") as typeof import("node:os");
  const pathExact = process.getBuiltinModule("node:path") as typeof import("node:path");
  const cryptoExact = process.getBuiltinModule("node:crypto") as typeof import("node:crypto");
  const root = fsExact.realpathSync(fsExact.mkdtempSync(
    pathExact.join(osExact.tmpdir(), "pintpath-kernel-reviewed-cli."),
  ));
  fsExact.chmodSync(root, 0o700);
  const absolutePath = pathExact.join(root, "railway-fixture-never-executed");
  const bytes = Buffer.from("#!/bin/sh\nexit 0\n", "utf8");
  fsExact.writeFileSync(absolutePath, bytes, {
    flag: "wx",
    mode: 0o555,
  });
  fsExact.chmodSync(absolutePath, 0o555);
  return Object.freeze({
    absolutePath,
    root,
    sha256: cryptoExact.createHash("sha256").update(bytes).digest("hex"),
  });
});

vi.mock(
  "../scripts/lib/permanent-staging-provider-variable-write-executor.js",
  async (importOriginal) => {
    const actual = await importOriginal<typeof import(
      "../scripts/lib/permanent-staging-provider-variable-write-executor.js"
    )>();
    const railwayCli = Object.freeze({
      ...actual.PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli,
      absolutePath: KERNEL_RAILWAY_CLI_FIXTURE.absolutePath,
      sha256: KERNEL_RAILWAY_CLI_FIXTURE.sha256,
    });
    const lock = Object.freeze({
      ...actual.PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK,
      railwayCli,
    });
    const canonicalPolicySource = `${JSON.stringify({
      schemaVersion:
        actual.PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_POLICY_SCHEMA,
      policyId: actual.PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATION,
      activationState:
        actual.PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE,
      projectId: lock.projectId,
      productionEnvironmentId: lock.productionEnvironmentId,
      stagingEnvironmentId: lock.stagingEnvironmentId,
      serviceId: lock.serviceId,
      operations: actual.PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS,
      railwayCli,
      writeContract: lock.writeContract,
    }, null, 2)}\n`;
    return {
      ...actual,
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE:
        canonicalPolicySource,
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK: lock,
    };
  },
);

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS,
} from "../scripts/lib/permanent-staging-provider-variable-write-executor.js";
import {
  openPermanentStagingProviderVariableWriteProcessAdapter,
  type PermanentStagingProviderVariableWriteProcessAdapterHandle,
} from "../scripts/lib/permanent-staging-provider-variable-write-process-adapter.js";
import {
  createPermanentStagingProviderVariableWriteLocalAttemptAuthority,
  openPermanentStagingProviderVariableWriteLocalAuthority,
  type PermanentStagingProviderVariableWriteLocalAttemptAuthority,
  type PermanentStagingProviderVariableWriteLocalAuthorityHandle,
  type PermanentStagingProviderVariableWriteLocalReceipt,
} from "../scripts/lib/permanent-staging-provider-variable-write-local-authority.js";
import {
  readPermanentStagingProviderVariableWriteInput,
} from "../scripts/lib/permanent-staging-provider-variable-write-input.js";
import {
  buildPermanentStagingProviderVariableTargetPostflight,
  buildPermanentStagingProviderVariableTargetPreflight,
} from "../scripts/lib/permanent-staging-provider-variable-write-authority.js";
import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_TERMINAL_SCHEMA,
  permanentStagingProviderVariableWriteKernelInternals,
  type PermanentStagingProviderVariableBoundaryAuthority,
  type PermanentStagingProviderVariableCleanupAuthority,
  type PermanentStagingProviderVariableDurableArtifactEvidence,
  type PermanentStagingProviderVariableExistingIntent,
  type PermanentStagingProviderVariableExistingTerminalEvidence,
  type PermanentStagingProviderVariableInputAuthority,
  type PermanentStagingProviderVariableLocalAuthority,
  type PermanentStagingProviderVariableTargetPostflight,
  type PermanentStagingProviderVariableTargetPreflight,
  type PermanentStagingProviderVariableTargetPreflightObservation,
  type PermanentStagingProviderVariableWriteAcknowledgement,
  type PermanentStagingProviderVariableWriteIntent,
  type PermanentStagingProviderVariableWriteKernelDependencies,
} from "../scripts/lib/permanent-staging-provider-variable-write-kernel.js";
import {
  evaluatePermanentStagingProviderVariableCreatePreflight,
  foldPermanentStagingProviderDeploymentInventoryPages,
  foldPermanentStagingProviderVariableInventoryPages,
  parsePermanentStagingProviderDeploymentInventoryPage,
  parsePermanentStagingProviderVariableInventoryPage,
} from "../scripts/lib/permanent-staging-provider-variable-write-railway-contract.js";

const OPERATION = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS[0];
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
let VALUE_BYTE_LENGTH = 17;
let VALUE_COMMITMENT = "a".repeat(64);
const BOUNDARY_SHA = "b".repeat(64);
const CURRENT_METADATA_SHA = "d".repeat(64);
const VARIABLE_INVENTORY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/variable-inventory/v1\0";
const DEPLOYMENT_INVENTORY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/deployment-inventory/v1\0";
const VARIABLE_PAGE_SOURCE = JSON.stringify({
  data: {
    environment: {
      id: ENVIRONMENT_ID,
      variables: {
        edges: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  },
});
const DEPLOYMENT_PAGE_SOURCE = JSON.stringify({
  data: {
    deployments: {
      edges: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
});

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function domainSha256(domain: string, value: unknown): string {
  return crypto.createHash("sha256")
    .update(domain, "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function brandedPreflight() {
  const variablePage = parsePermanentStagingProviderVariableInventoryPage(
    VARIABLE_PAGE_SOURCE,
    null,
  );
  const deploymentPage = parsePermanentStagingProviderDeploymentInventoryPage(
    DEPLOYMENT_PAGE_SOURCE,
    null,
  );
  if (variablePage === null || deploymentPage === null) {
    throw new Error("fixture page invalid");
  }
  const variableInventory = foldPermanentStagingProviderVariableInventoryPages([
    variablePage,
  ]);
  const deploymentInventory =
    foldPermanentStagingProviderDeploymentInventoryPages([deploymentPage]);
  if (variableInventory === null || deploymentInventory === null) {
    throw new Error("fixture inventory invalid");
  }
  const preflight = evaluatePermanentStagingProviderVariableCreatePreflight({
    variableName: OPERATION.variableName,
    variableInventory,
    deploymentInventory,
  });
  if (preflight === null) throw new Error("fixture preflight invalid");
  return { preflight, variableInventory, deploymentInventory };
}

function brandedPostflightInventories() {
  const variableSource = JSON.stringify({
    data: {
      environment: {
        id: ENVIRONMENT_ID,
        variables: {
          edges: [{
            cursor: "created-target",
            node: {
              id: "created-target-id",
              name: OPERATION.variableName,
              environmentId: ENVIRONMENT_ID,
              serviceId: SERVICE_ID,
              isSealed: false,
              references: [],
            },
          }],
          pageInfo: { hasNextPage: false, endCursor: "created-target" },
        },
      },
    },
  });
  const variablePage = parsePermanentStagingProviderVariableInventoryPage(
    variableSource,
    null,
  );
  const deploymentPage = parsePermanentStagingProviderDeploymentInventoryPage(
    DEPLOYMENT_PAGE_SOURCE,
    null,
  );
  if (variablePage === null || deploymentPage === null) {
    throw new Error("fixture postflight page invalid");
  }
  const variableInventory = foldPermanentStagingProviderVariableInventoryPages([
    variablePage,
  ]);
  const deploymentInventory =
    foldPermanentStagingProviderDeploymentInventoryPages([deploymentPage]);
  if (variableInventory === null || deploymentInventory === null) {
    throw new Error("fixture postflight inventory invalid");
  }
  return { variableInventory, deploymentInventory };
}

const INITIAL_PREFLIGHT = brandedPreflight();
const METADATA_SHA = domainSha256(
  VARIABLE_INVENTORY_HASH_DOMAIN,
  INITIAL_PREFLIGHT.variableInventory,
);
const DEPLOYMENT_SHA = domainSha256(
  DEPLOYMENT_INVENTORY_HASH_DOMAIN,
  INITIAL_PREFLIGHT.deploymentInventory,
);

function input(): PermanentStagingProviderVariableInputAuthority {
  return {
    schemaVersion:
      "pintpath-permanent-staging-provider-variable-write-input/v2",
    variableName: OPERATION.variableName,
    byteLength: VALUE_BYTE_LENGTH,
    commitmentDomain:
      "pintpath/permanent-staging/provider-variable-write/input-commitment/v1",
    commitmentSha256: VALUE_COMMITMENT,
    callbackIngressOnly: true,
    stdinSourceAuthorityAvailable: false,
    validUtf8: true,
    controlCharactersAbsent: true,
  };
}

let LOCAL_AUTHORITY_FIXTURE: PermanentStagingProviderVariableLocalAuthority = {
    schemaVersion:
      "pintpath-permanent-staging-provider-variable-write-local-authority/v2",
    railwayCliVersion: "5.32.0",
    railwayCliAbsolutePath: "/opt/homebrew/Cellar/railway/5.32.0/bin/railway",
    railwayCliSha256:
      "26e3e0fd2b59fd9f7b1e891cbc8f3ca9b0266556545f00ba4db3ce754fbc10d1",
    railwayCliBytes: 16_696_704,
    railwayCliIdentitySha256: "9".repeat(64),
    absoluteCanonicalNonSymlinkPath: true,
    regularFile: true,
    currentUid: true,
    mode0555: true,
    nlinkOne: true,
    descriptorHeld: true,
    pathAndDescriptorIdentityExact: true,
    bytesHashedFromHeldDescriptor: true,
    privateExecutableCopyAbsolutePath:
      "/private/pintpath/railway-26e3e0fd2b59",
    privateExecutableCopySha256:
      "26e3e0fd2b59fd9f7b1e891cbc8f3ca9b0266556545f00ba4db3ce754fbc10d1",
    privateExecutableCopyBytes: 16_696_704,
    privateExecutableCopyIdentitySha256: "1".repeat(64),
    privateExecutableCopyAuthoritySha256: "2".repeat(64),
    environmentAuthoritySha256: "3".repeat(64),
    stdinAuthoritySha256: "4".repeat(64),
    processGroupAuthoritySha256: "5".repeat(64),
    processAdapterAuthoritySha256: "6".repeat(64),
    privateExecutableCopyDescriptorHeld: true,
    privateExecutableCopyParentMode0700: true,
    processAdapterInjectedSpawnOnly: true,
    providerInvokedDuringInspection: false,
};

function local(): PermanentStagingProviderVariableLocalAuthority {
  return { ...LOCAL_AUTHORITY_FIXTURE };
}

function localAuthoritySha256(): string {
  return domainSha256(
    "pintpath/permanent-staging/provider-variable-write/local-authority/v2\0",
    local(),
  );
}

function commandSha256(): string {
  const authority = local();
  return domainSha256(
    "pintpath/permanent-staging/provider-variable-write/command/v2\0",
    {
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-write-command/v2",
      executable: authority.privateExecutableCopyAbsolutePath,
      executableAuthority: {
        privateExecutableCopySha256: authority.privateExecutableCopySha256,
        privateExecutableCopyIdentitySha256:
          authority.privateExecutableCopyIdentitySha256,
        privateExecutableCopyAuthoritySha256:
          authority.privateExecutableCopyAuthoritySha256,
        descriptorHeld: true,
      },
      argv: [
        "variable",
        "set",
        OPERATION.variableName,
        "--stdin",
        "--skip-deploys",
        "--project",
        PROJECT_ID,
        "--environment",
        ENVIRONMENT_ID,
        "--service",
        SERVICE_ID,
      ],
      environment: {
        inherit: false,
        prototype: "null",
        ownEnumerableDataPropertiesOnly: true,
        exactNames: ["RAILWAY_TOKEN"],
        valuesHandledByThisModule: false,
      },
      shell: false,
      stdin: "pipe",
      stdinWrites: 1,
      stdinEndCalls: 1,
      stdout: "ignore",
      stderr: "ignore",
      maximumCapturedStdoutBytes: 0,
      maximumCapturedStderrBytes: 0,
      detached: true,
      abortSignalSequence: ["SIGTERM", "SIGKILL"],
      processGroupEmptyBeforeSettlement: true,
    },
  );
}

function boundary(): PermanentStagingProviderVariableBoundaryAuthority {
  return {
    schemaVersion:
      "pintpath-permanent-staging-provider-variable-boundary-authority/v1",
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    productionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    productionTokenExact: true,
    stagingTokenExact: true,
    productionPatchEmpty: true,
    stagingPatchEmpty: true,
    productionBaselineExact: true,
    stagingScopeExact: true,
    mutationPolicyExact: true,
    snapshotSha256: BOUNDARY_SHA,
  };
}

function targetPreflight(): PermanentStagingProviderVariableTargetPreflight {
  const current = brandedPreflight();
  const authority = buildPermanentStagingProviderVariableTargetPreflight({
    variableName: OPERATION.variableName,
    variableInventory: current.variableInventory,
    deploymentInventory: current.deploymentInventory,
  });
  if (authority === null) throw new Error("fixture authority invalid");
  return authority;
}

function targetPreflightObservation():
PermanentStagingProviderVariableTargetPreflightObservation {
  return {
    authority: targetPreflight(),
    recoveryLineage: {
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-preflight-lineage/v1",
      variablePages: [{ requestedAfter: null, source: VARIABLE_PAGE_SOURCE }],
      deploymentPages: [{ requestedAfter: null, source: DEPLOYMENT_PAGE_SOURCE }],
    },
  };
}

function targetPostflight(): PermanentStagingProviderVariableTargetPostflight {
  return {
    schemaVersion:
      "pintpath-permanent-staging-provider-variable-target-postflight/v1",
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    variableName: OPERATION.variableName,
    inventoryComplete: true,
    targetPresent: true,
    sharedShadowAbsent: true,
    expectedMetadataExact: true,
    metadataDeltaExact: true,
    beforeMetadataInventorySha256: METADATA_SHA,
    currentMetadataInventorySha256: CURRENT_METADATA_SHA,
    beforeDeploymentInventorySha256: DEPLOYMENT_SHA,
    currentDeploymentInventorySha256: DEPLOYMENT_SHA,
    deploymentInventoryComplete: true,
    deploymentUnchanged: true,
  };
}

let RECEIPT_FIXTURE_ROOT = "";
let RECEIPT_FIXTURE_PRIVATE_COPY_PATH = "";
let RECEIPT_FIXTURE_ADAPTER:
  PermanentStagingProviderVariableWriteProcessAdapterHandle | undefined;
let RECEIPT_FIXTURE_LOCAL:
  PermanentStagingProviderVariableWriteLocalAuthorityHandle | undefined;
let PREMINTED_ACKNOWLEDGEMENT:
  PermanentStagingProviderVariableWriteLocalReceipt | undefined;
let RECEIPT_FIXTURE_PID = 40_000;

function acknowledgement(): PermanentStagingProviderVariableWriteAcknowledgement {
  const receipt = PREMINTED_ACKNOWLEDGEMENT;
  if (receipt === undefined) {
    throw new Error("genuine local receipt fixture unavailable");
  }
  return receipt;
}

async function mintAcknowledgement(
  attemptAuthority: PermanentStagingProviderVariableWriteLocalAttemptAuthority,
  intentSha256: string,
): Promise<PermanentStagingProviderVariableWriteLocalReceipt> {
  let groupEmpty = false;
  const emitter = new EventEmitter();
  const stdinEmitter = new EventEmitter();
  const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
    privateExecutableCopyPath: RECEIPT_FIXTURE_PRIVATE_COPY_PATH,
    expectedSourceSha256:
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli.sha256,
    spawn: () => ({
      pid: RECEIPT_FIXTURE_PID++,
      stdin: {
        write(_value: Buffer, callback: (error?: unknown) => void) {
          callback();
          return true;
        },
        end(callback: (error?: unknown) => void) {
          callback();
          setImmediate(() => {
            groupEmpty = true;
            emitter.emit("close", 0, null);
          });
        },
        once: stdinEmitter.once.bind(stdinEmitter),
        removeListener: stdinEmitter.removeListener.bind(stdinEmitter),
      },
      once: emitter.once.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
    }),
    killProcessGroup: () => {
      groupEmpty = true;
    },
    probeProcessGroupEmpty: () => groupEmpty,
  });
  let localAuthority:
    PermanentStagingProviderVariableWriteLocalAuthorityHandle | undefined;
  try {
    const binding = await adapter.inspectLocalAuthorityBinding(
      new AbortController().signal,
    );
    localAuthority =
      await openPermanentStagingProviderVariableWriteLocalAuthority(binding);
    await localAuthority.inspect(new AbortController().signal);
    const inputHandle = await readPermanentStagingProviderVariableWriteInput(
      OPERATION.variableName,
      {
        readExactlyOnce(consumeChunk, settle) {
          consumeChunk(Buffer.from("offline-value-001", "utf8"));
          settle();
        },
      },
      new AbortController().signal,
    );
    return await localAuthority.writeExactlyOnceWithInjectedChild(
      OPERATION.variableName,
      inputHandle,
      intentSha256,
      attemptAuthority,
      adapter.createLauncher("offline-kernel-token-never-sent"),
      new AbortController().signal,
    );
  } finally {
    await localAuthority?.close();
    await adapter.close();
  }
}

function cleanup(): PermanentStagingProviderVariableCleanupAuthority {
  return {
    schemaVersion:
      "pintpath-permanent-staging-provider-variable-cleanup-authority/v1",
    inputZeroized: true,
    inputClosed: true,
    localAuthorityClosed: true,
    childReaped: true,
    temporaryArtifactsRemoved: true,
  };
}

function evidence(
  canonical: string,
  publication: "created-durable" | "existing-exact" = "created-durable",
): PermanentStagingProviderVariableDurableArtifactEvidence {
  return {
    publication,
    sha256: sha256(canonical),
    canonicalPathExact: true,
    parentMode0700: true,
    fileMode0600: true,
    currentUid: true,
    regularFile: true,
    nonSymlink: true,
    nlinkOne: true,
    exclusiveCreate: publication === "created-durable",
    fileFsync: true,
    parentFsync: true,
    identityHeld: true,
    readbackExact: true,
  };
}

function canonicalIntent(): string {
  const value: PermanentStagingProviderVariableWriteIntent = {
    schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA,
    policySha256: sha256(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
    ),
    operationId: OPERATION.operationId,
    variableName: OPERATION.variableName,
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    valueByteLength: VALUE_BYTE_LENGTH,
    valueCommitmentSha256: VALUE_COMMITMENT,
    localAuthoritySha256: localAuthoritySha256(),
    commandSha256: commandSha256(),
    processAdapterAuthoritySha256: local().processAdapterAuthoritySha256,
    privateExecutableCopyAuthoritySha256:
      local().privateExecutableCopyAuthoritySha256,
    environmentAuthoritySha256: local().environmentAuthoritySha256,
    stdinAuthoritySha256: local().stdinAuthoritySha256,
    processGroupAuthoritySha256: local().processGroupAuthoritySha256,
    boundarySnapshotSha256: BOUNDARY_SHA,
    metadataInventorySha256: METADATA_SHA,
    deploymentInventorySha256: DEPLOYMENT_SHA,
    preflightLineage: targetPreflightObservation().recoveryLineage,
    expectedBefore: "absent",
    sequentialNotAtomic: true,
    externalMutationFreezeRequired: true,
  };
  return JSON.stringify(value);
}

interface DependencyFixture {
  readonly dependencies: PermanentStagingProviderVariableWriteKernelDependencies;
  readonly calls: string[];
  readonly intentCandidates: string[];
  readonly terminalCandidates: string[];
  setExisting(value: PermanentStagingProviderVariableExistingIntent | null): void;
  setExistingTerminal(
    value: PermanentStagingProviderVariableExistingTerminalEvidence | null,
  ): void;
  setBoundary(value: PermanentStagingProviderVariableBoundaryAuthority): void;
  setPreflight(value: PermanentStagingProviderVariableTargetPreflightObservation): void;
  setPostflight(value: PermanentStagingProviderVariableTargetPostflight): void;
  setAcknowledgement(value: PermanentStagingProviderVariableWriteAcknowledgement): void;
  getLastAcknowledgement():
    PermanentStagingProviderVariableWriteAcknowledgement | null;
  setCleanup(value: PermanentStagingProviderVariableCleanupAuthority): void;
  setFinalize(value: boolean): void;
}

function fixture(): DependencyFixture {
  const calls: string[] = [];
  const intentCandidates: string[] = [];
  const terminalCandidates: string[] = [];
  let existing: PermanentStagingProviderVariableExistingIntent | null = null;
  let existingTerminal:
    PermanentStagingProviderVariableExistingTerminalEvidence | null = null;
  let boundaryValue = boundary();
  let preflightValue = targetPreflightObservation();
  let postflightValue = targetPostflight();
  let acknowledgementValue:
    PermanentStagingProviderVariableWriteAcknowledgement | null = null;
  let lastAcknowledgement:
    PermanentStagingProviderVariableWriteAcknowledgement | null = null;
  let cleanupValue = cleanup();
  let finalizeValue = true;
  const dependencies: PermanentStagingProviderVariableWriteKernelDependencies = {
    inspectTerminalEvidence: async () => {
      calls.push("terminal-inspect");
      return existingTerminal;
    },
    inspectInput: async () => {
      calls.push("input");
      return input();
    },
    inspectLocalAuthority: async () => {
      calls.push("local");
      return local();
    },
    inspectBoundary: async () => {
      calls.push("boundary");
      return boundaryValue;
    },
    inspectTargetPreflight: async () => {
      calls.push("target-preflight");
      return preflightValue;
    },
    inspectIntent: async () => {
      calls.push("intent-inspect");
      return existing;
    },
    persistIntent: async (_operation, canonical) => {
      calls.push("intent-persist");
      intentCandidates.push(canonical);
      return evidence(canonical);
    },
    writeExactlyOnce: async (_operation, intentSha256, attemptAuthority) => {
      calls.push("write");
      const observed = acknowledgementValue ?? await mintAcknowledgement(
        attemptAuthority,
        intentSha256,
      );
      lastAcknowledgement = observed;
      return observed;
    },
    inspectTargetPostflight: async () => {
      calls.push("target-postflight");
      return postflightValue;
    },
    cleanup: async () => {
      calls.push("cleanup");
      return cleanupValue;
    },
    persistTerminalEvidence: async (_operation, canonical) => {
      calls.push("terminal-persist");
      terminalCandidates.push(canonical);
      return evidence(canonical);
    },
    finalize: async () => {
      calls.push("finalize");
      return finalizeValue;
    },
  };
  return {
    dependencies,
    calls,
    intentCandidates,
    terminalCandidates,
    setExisting: (value) => {
      existing = value;
    },
    setExistingTerminal: (value) => {
      existingTerminal = value;
    },
    setBoundary: (value) => {
      boundaryValue = value;
    },
    setPreflight: (value) => {
      preflightValue = value;
    },
    setPostflight: (value) => {
      postflightValue = value;
    },
    setAcknowledgement: (value) => {
      acknowledgementValue = value;
    },
    getLastAcknowledgement: () => lastAcknowledgement,
    setCleanup: (value) => {
      cleanupValue = value;
    },
    setFinalize: (value) => {
      finalizeValue = value;
    },
  };
}

const execute = permanentStagingProviderVariableWriteKernelInternals.executeEnabled;

beforeAll(async () => {
  if (
    PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli.absolutePath
      !== KERNEL_RAILWAY_CLI_FIXTURE.absolutePath
    || PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli.sha256
      !== KERNEL_RAILWAY_CLI_FIXTURE.sha256
  ) {
    throw new Error("kernel Railway CLI fixture lock was not installed");
  }
  RECEIPT_FIXTURE_ROOT = await fs.promises.realpath(await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pintpath-kernel-local-receipt."),
  ));
  RECEIPT_FIXTURE_PRIVATE_COPY_PATH = path.join(
    RECEIPT_FIXTURE_ROOT,
    "railway-private-copy-never-executed",
  );
  await fs.promises.copyFile(
    PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli.absolutePath,
    RECEIPT_FIXTURE_PRIVATE_COPY_PATH,
    fs.constants.COPYFILE_EXCL,
  );
  await fs.promises.chmod(RECEIPT_FIXTURE_PRIVATE_COPY_PATH, 0o500);
  RECEIPT_FIXTURE_ADAPTER = await openPermanentStagingProviderVariableWriteProcessAdapter({
    privateExecutableCopyPath: RECEIPT_FIXTURE_PRIVATE_COPY_PATH,
    expectedSourceSha256:
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli.sha256,
    spawn: () => {
      throw new Error("kernel fixture never creates a process");
    },
    killProcessGroup: () => undefined,
    probeProcessGroupEmpty: () => true,
  });
  const binding = await RECEIPT_FIXTURE_ADAPTER.inspectLocalAuthorityBinding(
    new AbortController().signal,
  );
  const openInput = async () => readPermanentStagingProviderVariableWriteInput(
    OPERATION.variableName,
    {
      readExactlyOnce(consumeChunk, settle) {
        consumeChunk(Buffer.from("offline-value-001", "utf8"));
        settle();
      },
    },
    new AbortController().signal,
  );
  RECEIPT_FIXTURE_LOCAL =
    await openPermanentStagingProviderVariableWriteLocalAuthority(binding);
  LOCAL_AUTHORITY_FIXTURE = await RECEIPT_FIXTURE_LOCAL.inspect(
    new AbortController().signal,
  );
  const heldInput = await openInput();
  const inputInspection = heldInput.inspect();
  VALUE_BYTE_LENGTH = inputInspection.byteLength;
  VALUE_COMMITMENT = inputInspection.commitmentSha256;
  heldInput.close();
  const expectedIntentSha256 = sha256(canonicalIntent());
  await RECEIPT_FIXTURE_LOCAL.close();
  RECEIPT_FIXTURE_LOCAL = undefined;
  await RECEIPT_FIXTURE_ADAPTER.close();
  RECEIPT_FIXTURE_ADAPTER = undefined;
  const premintAttempt =
    createPermanentStagingProviderVariableWriteLocalAttemptAuthority({
      operationId: OPERATION.operationId,
      variableName: OPERATION.variableName,
      inputCommitmentSha256: VALUE_COMMITMENT,
      inputByteLength: VALUE_BYTE_LENGTH,
      intentSha256: expectedIntentSha256,
      localAuthoritySha256: localAuthoritySha256(),
      commandSha256: commandSha256(),
      processAdapterAuthoritySha256:
        LOCAL_AUTHORITY_FIXTURE.processAdapterAuthoritySha256,
      privateExecutableCopyAuthoritySha256:
        LOCAL_AUTHORITY_FIXTURE.privateExecutableCopyAuthoritySha256,
      environmentAuthoritySha256:
        LOCAL_AUTHORITY_FIXTURE.environmentAuthoritySha256,
      stdinAuthoritySha256: LOCAL_AUTHORITY_FIXTURE.stdinAuthoritySha256,
      processGroupAuthoritySha256:
        LOCAL_AUTHORITY_FIXTURE.processGroupAuthoritySha256,
    });
  PREMINTED_ACKNOWLEDGEMENT = await mintAcknowledgement(
    premintAttempt,
    expectedIntentSha256,
  );
});

afterAll(async () => {
  await RECEIPT_FIXTURE_LOCAL?.close();
  await RECEIPT_FIXTURE_ADAPTER?.close();
  if (RECEIPT_FIXTURE_ROOT.length > 0) {
    await fs.promises.rm(RECEIPT_FIXTURE_ROOT, {
      recursive: true,
      force: false,
    });
  }
  await fs.promises.rm(KERNEL_RAILWAY_CLI_FIXTURE.root, {
    recursive: true,
    force: true,
  });
});

describe("permanent staging provider-variable write kernel", () => {
  it("snapshots exact dependency functions and preserves their receiver before the first await", async () => {
    const state = fixture();
    const receiver = state.dependencies as unknown as object;
    const originalDescriptors = Object.getOwnPropertyDescriptors(receiver);
    const dependencyNames = Reflect.ownKeys(originalDescriptors);
    const poison = vi.fn(async () => {
      throw new Error("mutated dependency must not be invoked");
    });
    let receiverExact = false;
    Object.defineProperty(receiver, "inspectTerminalEvidence", {
      ...originalDescriptors.inspectTerminalEvidence,
      value: async function (this: unknown) {
        receiverExact = this === receiver;
        state.calls.push("terminal-inspect");
        await Promise.resolve();
        for (let index = 0; index < dependencyNames.length; index += 1) {
          Object.defineProperty(receiver, dependencyNames[index]!, {
            ...originalDescriptors[dependencyNames[index]!],
            value: poison,
          });
        }
        return null;
      },
    });
    let receipt: Awaited<ReturnType<typeof execute>> | undefined;
    try {
      receipt = await execute(OPERATION.operationId, state.dependencies);
    } finally {
      for (let index = 0; index < dependencyNames.length; index += 1) {
        Object.defineProperty(
          receiver,
          dependencyNames[index]!,
          originalDescriptors[dependencyNames[index]!]!,
        );
      }
    }
    expect(receiverExact).toBe(true);
    expect(poison).not.toHaveBeenCalled();
    expect(receipt?.outcome).toBe("acknowledged_pending_runtime_proof");
    expect(receipt?.checks).toMatchObject({
      acknowledgementExact: true,
      cleanupExact: true,
      terminalEvidenceExact: true,
      finalizationExact: true,
    });
  });

  it("executes one create in the exact review-only sequence", async () => {
    const state = fixture();
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt).toMatchObject({
      executorState: "HARD_DISABLED_REVIEW_REQUIRED",
      mode: "internal-review-only-create",
      outcome: "acknowledged_pending_runtime_proof",
      operationId: OPERATION.operationId,
      variableName: OPERATION.variableName,
      recoveryOnly: false,
      runtimeValueProof: false,
      activationAuthorized: false,
      checks: {
        frameworkEnabled: true,
        policyExact: true,
        inputHeldAndBound: true,
        localAuthorityExact: true,
        boundaryPreflightExact: true,
        targetPreflightExact: true,
        durableIntentExact: true,
        inputReasserted: true,
        localAuthorityReasserted: true,
        boundaryReasserted: true,
        targetReasserted: true,
        writeAttempted: true,
        acknowledgementExact: true,
        postflightAttempted: true,
        boundaryPostflightExact: true,
        targetPostflightExact: true,
        deploymentUnchanged: true,
        localPostflightExact: true,
        inputCleanupExact: true,
        cleanupExact: true,
        terminalEvidenceExact: true,
        finalizationExact: true,
      },
    });
    expect(state.calls).toEqual([
      "terminal-inspect",
      "input",
      "local",
      "boundary",
      "intent-inspect",
      "target-preflight",
      "intent-persist",
      "input",
      "local",
      "boundary",
      "target-preflight",
      "write",
      "boundary",
      "target-postflight",
      "local",
      "cleanup",
      "terminal-persist",
      "finalize",
    ]);
  });

  it("publishes an immutable null-prototype receipt without inherited then assimilation", async () => {
    const state = fixture();
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, "then");
    let traps = 0;
    state.dependencies.finalize = async () => {
      state.calls.push("finalize");
      Object.defineProperty(Object.prototype, "then", {
        configurable: true,
        get() {
          traps += 1;
          const candidate = this as { outcome?: string };
          candidate.outcome = "acknowledged_pending_runtime_proof";
          return undefined;
        },
      });
      return false;
    };
    let receipt!: Awaited<ReturnType<typeof execute>>;
    try {
      receipt = await execute(OPERATION.operationId, state.dependencies);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(Object.prototype, "then");
      else Object.defineProperty(Object.prototype, "then", descriptor);
    }
    expect(traps).toBe(0);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.finalizationExact).toBe(false);
    expect(Object.getPrototypeOf(receipt)).toBeNull();
    expect(Object.getPrototypeOf(receipt.checks)).toBeNull();
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.checks)).toBe(true);
  });

  it("persists an explicit pre-finalization receipt binding", async () => {
    const state = fixture();
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(state.intentCandidates).toHaveLength(1);
    expect(Buffer.byteLength(state.intentCandidates[0]!, "utf8"))
      .toBeLessThanOrEqual(64 * 1_024);
    const persistedIntent = JSON.parse(state.intentCandidates[0]!) as
      Record<string, unknown>;
    expect(persistedIntent.preflightLineage).toEqual(
      targetPreflightObservation().recoveryLineage,
    );
    expect(persistedIntent).toMatchObject({
      localAuthoritySha256: localAuthoritySha256(),
      commandSha256: commandSha256(),
      processAdapterAuthoritySha256: local().processAdapterAuthoritySha256,
      privateExecutableCopyAuthoritySha256:
        local().privateExecutableCopyAuthoritySha256,
      environmentAuthoritySha256: local().environmentAuthoritySha256,
      stdinAuthoritySha256: local().stdinAuthoritySha256,
      processGroupAuthoritySha256: local().processGroupAuthoritySha256,
    });

    expect(state.terminalCandidates).toHaveLength(1);
    const terminal = JSON.parse(state.terminalCandidates[0]!) as
      Record<string, unknown>;
    expect(Object.keys(terminal)).toEqual([
      "schemaVersion",
      "binding",
      "operationId",
      "variableName",
      "intentLeaf",
      "terminalEvidenceLeaf",
      "intentSha256",
      "preFinalizationReceipt",
      "preFinalizationReceiptSha256",
      "runtimeValueProof",
      "activationAuthorized",
    ]);
    expect(terminal).toMatchObject({
      binding: "pre-finalization-receipt",
      intentLeaf: OPERATION.intentLeaf,
      terminalEvidenceLeaf: OPERATION.terminalEvidenceLeaf,
      intentSha256: sha256(state.intentCandidates[0]!),
      runtimeValueProof: false,
      activationAuthorized: false,
    });
    const preFinalizationReceipt = terminal.preFinalizationReceipt as
      Record<string, unknown>;
    expect(terminal.preFinalizationReceiptSha256).toBe(
      sha256(JSON.stringify(preFinalizationReceipt)),
    );
    expect(preFinalizationReceipt).toMatchObject({
      outcome: "acknowledged_pending_runtime_proof",
      terminalEvidenceSha256: null,
      writeAcknowledgementSha256: domainSha256(
        "pintpath/permanent-staging/provider-variable-write/write-acknowledgement/v2\0",
        acknowledgement(),
      ),
      runtimeValueProof: false,
      activationAuthorized: false,
      checks: {
        terminalEvidenceExact: false,
        finalizationExact: false,
      },
    });
    expect(terminal).not.toHaveProperty("finalReceipt");
    expect(terminal).not.toHaveProperty("candidateReceiptSha256");
    expect(receipt.checks.terminalEvidenceExact).toBe(true);
    expect(receipt.checks.finalizationExact).toBe(true);
    expect(receipt.writeAcknowledgementSha256).toBe(
      preFinalizationReceipt.writeAcknowledgementSha256,
    );
  });

  it("ignores an inherited toJSON hook and persists exact current evidence", async () => {
    const state = fixture();
    const previousToJSON = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    let receipt: Awaited<ReturnType<typeof execute>> | null = null;
    state.dependencies.inspectTargetPreflight = async () => {
      state.calls.push("target-preflight");
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        enumerable: false,
        writable: true,
        value(this: unknown) {
          if (typeof this === "object" && this !== null) {
            const schemaVersion = (this as Record<string, unknown>).schemaVersion;
            if (
              schemaVersion === PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA
              || schemaVersion
                === PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_TERMINAL_SCHEMA
            ) return {};
          }
          return this;
        },
      });
      return targetPreflightObservation();
    };
    try {
      receipt = await execute(OPERATION.operationId, state.dependencies);
    } finally {
      if (previousToJSON === undefined) {
        delete (Object.prototype as { toJSON?: unknown }).toJSON;
      } else {
        Object.defineProperty(Object.prototype, "toJSON", previousToJSON);
      }
    }

    expect(receipt?.outcome).toBe("acknowledged_pending_runtime_proof");
    expect(state.intentCandidates).toHaveLength(1);
    expect(state.intentCandidates[0]).not.toBe("{}");
    expect(JSON.parse(state.intentCandidates[0]!)).toMatchObject({
      schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA,
      operationId: OPERATION.operationId,
      variableName: OPERATION.variableName,
      expectedBefore: "absent",
      sequentialNotAtomic: true,
      externalMutationFreezeRequired: true,
    });
    expect(state.terminalCandidates).toHaveLength(1);
    expect(state.terminalCandidates[0]).not.toBe("{}");
    expect(JSON.parse(state.terminalCandidates[0]!)).toMatchObject({
      schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_TERMINAL_SCHEMA,
      binding: "pre-finalization-receipt",
      operationId: OPERATION.operationId,
      variableName: OPERATION.variableName,
      runtimeValueProof: false,
      activationAuthorized: false,
    });
  });

  it("does not let live Array serialization hooks rewrite a valid intent", async () => {
    const state = fixture();
    const stablePreflight = targetPreflightObservation();
    const replacementVariableName =
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS[1]!.variableName;
    const previousPush = Object.getOwnPropertyDescriptor(Array.prototype, "push");
    const previousJoin = Object.getOwnPropertyDescriptor(Array.prototype, "join");
    const previousString = Object.getOwnPropertyDescriptor(globalThis, "String");
    const pushExact = Array.prototype.push;
    const joinExact = Array.prototype.join;
    let arrayMethodsPoisoned = false;
    const liveString = vi.fn(() => {
      throw new Error("live String constructor must not run");
    });
    const rewriteVariableName = (value: string): string => value.replace(
      `"variableName":"${OPERATION.variableName}"`,
      `"variableName":"${replacementVariableName}"`,
    );
    const restoreArrayMethods = () => {
      if (!arrayMethodsPoisoned) return;
      arrayMethodsPoisoned = false;
      if (previousPush !== undefined) {
        Object.defineProperty(Array.prototype, "push", previousPush);
      }
      if (previousJoin !== undefined) {
        Object.defineProperty(Array.prototype, "join", previousJoin);
      }
      if (previousString === undefined) {
        Reflect.deleteProperty(globalThis, "String");
      } else {
        Object.defineProperty(globalThis, "String", previousString);
      }
    };
    let preflightReads = 0;
    state.dependencies.inspectTargetPreflight = async () => {
      state.calls.push("target-preflight");
      preflightReads += 1;
      if (preflightReads === 1) {
        Object.defineProperty(Array.prototype, "push", {
          configurable: true,
          enumerable: false,
          writable: true,
          value(this: unknown[], ...items: unknown[]) {
            for (let index = 0; index < items.length; index += 1) {
              if (
                items[index]
                  === `"variableName":"${OPERATION.variableName}"`
              ) {
                items[index] =
                  `"variableName":"${replacementVariableName}"`;
              }
            }
            return Reflect.apply(pushExact, this, items);
          },
        });
        Object.defineProperty(Array.prototype, "join", {
          configurable: true,
          enumerable: false,
          writable: true,
          value(this: unknown[], separator?: string) {
            const joined = Reflect.apply(joinExact, this, [separator]) as string;
            return rewriteVariableName(joined);
          },
        });
        Object.defineProperty(globalThis, "String", {
          configurable: true,
          value: liveString,
          writable: true,
        });
        arrayMethodsPoisoned = true;
      }
      return stablePreflight;
    };
    state.dependencies.persistIntent = async (_operation, canonical) => {
      state.calls.push("intent-persist");
      state.intentCandidates.push(canonical);
      restoreArrayMethods();
      return evidence(canonical);
    };

    let receipt: Awaited<ReturnType<typeof execute>> | null = null;
    try {
      receipt = await execute(OPERATION.operationId, state.dependencies);
    } finally {
      restoreArrayMethods();
    }
    expect(receipt?.outcome).toBe("acknowledged_pending_runtime_proof");
    expect(state.intentCandidates).toHaveLength(1);
    expect(JSON.parse(state.intentCandidates[0]!)).toMatchObject({
      operationId: OPERATION.operationId,
      variableName: OPERATION.variableName,
    });
    expect(state.intentCandidates[0]).not.toContain(replacementVariableName);
    expect(state.calls.filter((call) => call === "write")).toHaveLength(1);
    expect(liveString).not.toHaveBeenCalled();
  });

  it("uses pinned regexp, hash, and digest conversion intrinsics", async () => {
    const state = fixture();
    const applyExact = Reflect.apply;
    const createHashExact = crypto.createHash;
    const hashProbe = createHashExact("sha256");
    const hashPrototype = Object.getPrototypeOf(hashProbe) as object;
    const hashUpdateExact = hashProbe.update;
    const hashDigestExact = hashProbe.digest;
    const exactSha256 = (value: string): string => {
      const hash = applyExact(
        createHashExact,
        crypto,
        ["sha256"],
      ) as ReturnType<typeof crypto.createHash>;
      applyExact(hashUpdateExact, hash, [value, "utf8"]);
      const digest = applyExact(hashDigestExact, hash, []) as Buffer;
      const alphabet = "0123456789abcdef";
      let output = "";
      for (let index = 0; index < 32; index += 1) {
        const byte = digest[index]!;
        output += alphabet[byte >>> 4];
        output += alphabet[byte & 0x0f];
      }
      return output;
    };
    const durableTemplate = evidence("intrinsic-poison-template");
    const descriptors = {
      regexpTest: Object.getOwnPropertyDescriptor(RegExp.prototype, "test")!,
      regexpExec: Object.getOwnPropertyDescriptor(RegExp.prototype, "exec")!,
      createHash: Object.getOwnPropertyDescriptor(crypto, "createHash")!,
      hashUpdate: Object.getOwnPropertyDescriptor(hashPrototype, "update")!,
      hashDigest: Object.getOwnPropertyDescriptor(hashPrototype, "digest")!,
      bufferToString: Object.getOwnPropertyDescriptor(
        Buffer.prototype,
        "toString",
      )!,
      bufferHexSlice: Object.getOwnPropertyDescriptor(
        Buffer.prototype,
        "hexSlice",
      )!,
    };
    const poisonCalls = {
      regexpTest: 0,
      regexpExec: 0,
      createHash: 0,
      hashUpdate: 0,
      hashDigest: 0,
      bufferToString: 0,
      bufferHexSlice: 0,
    };
    let poisoned = false;
    const installPoison = () => {
      if (poisoned) return;
      poisoned = true;
      Object.defineProperty(RegExp.prototype, "test", {
        ...descriptors.regexpTest,
        value() {
          poisonCalls.regexpTest += 1;
          return true;
        },
      });
      Object.defineProperty(RegExp.prototype, "exec", {
        ...descriptors.regexpExec,
        value() {
          poisonCalls.regexpExec += 1;
          return ["poisoned-match"];
        },
      });
      Object.defineProperty(crypto, "createHash", {
        ...descriptors.createHash,
        value(...args: unknown[]) {
          poisonCalls.createHash += 1;
          return applyExact(createHashExact, crypto, args);
        },
      });
      Object.defineProperty(hashPrototype, "update", {
        ...descriptors.hashUpdate,
        value(this: unknown) {
          poisonCalls.hashUpdate += 1;
          return this;
        },
      });
      Object.defineProperty(hashPrototype, "digest", {
        ...descriptors.hashDigest,
        value(encoding?: unknown) {
          poisonCalls.hashDigest += 1;
          return typeof encoding === "string"
            ? "f".repeat(64)
            : Buffer.alloc(32, 0xff);
        },
      });
      Object.defineProperty(Buffer.prototype, "toString", {
        ...descriptors.bufferToString,
        value() {
          poisonCalls.bufferToString += 1;
          return "e".repeat(64);
        },
      });
      Object.defineProperty(Buffer.prototype, "hexSlice", {
        ...descriptors.bufferHexSlice,
        value() {
          poisonCalls.bufferHexSlice += 1;
          return "d".repeat(64);
        },
      });
    };
    const restoreIntrinsics = () => {
      if (!poisoned) return;
      poisoned = false;
      Object.defineProperty(RegExp.prototype, "test", descriptors.regexpTest);
      Object.defineProperty(RegExp.prototype, "exec", descriptors.regexpExec);
      Object.defineProperty(crypto, "createHash", descriptors.createHash);
      Object.defineProperty(hashPrototype, "update", descriptors.hashUpdate);
      Object.defineProperty(hashPrototype, "digest", descriptors.hashDigest);
      Object.defineProperty(
        Buffer.prototype,
        "toString",
        descriptors.bufferToString,
      );
      Object.defineProperty(
        Buffer.prototype,
        "hexSlice",
        descriptors.bufferHexSlice,
      );
    };
    state.dependencies.inspectInput = async () => {
      state.calls.push("input");
      installPoison();
      return input();
    };
    state.dependencies.persistIntent = async (_operation, canonical) => {
      state.calls.push("intent-persist");
      state.intentCandidates.push(canonical);
      return { ...durableTemplate, sha256: exactSha256(canonical) };
    };
    state.dependencies.persistTerminalEvidence = async (_operation, canonical) => {
      state.calls.push("terminal-persist");
      state.terminalCandidates.push(canonical);
      return { ...durableTemplate, sha256: exactSha256(canonical) };
    };

    let receipt: Awaited<ReturnType<typeof execute>> | null = null;
    try {
      receipt = await execute(OPERATION.operationId, state.dependencies);
    } finally {
      restoreIntrinsics();
    }
    expect(receipt?.outcome).toBe("acknowledged_pending_runtime_proof");
    expect(receipt?.checks).toMatchObject({
      durableIntentExact: true,
      writeAttempted: true,
      acknowledgementExact: true,
      terminalEvidenceExact: true,
      finalizationExact: true,
    });
    expect(poisonCalls).toEqual({
      regexpTest: 0,
      regexpExec: 0,
      createHash: 0,
      hashUpdate: 0,
      hashDigest: 0,
      bufferToString: 0,
      bufferHexSlice: 0,
    });
    expect(state.calls.filter((call) => call === "write")).toHaveLength(1);
  });

  it("never serializes a raw value into receipt or terminal evidence", async () => {
    const state = fixture();
    const secret = "should-never-appear-anywhere";
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(state.terminalCandidates).toHaveLength(1);
    expect(state.terminalCandidates[0]).not.toContain(secret);
    expect(state.terminalCandidates[0]).not.toContain("RAILWAY_TOKEN");
  });

  it("treats an existing exact intent as recovery-only and never retries", async () => {
    const state = fixture();
    const canonical = canonicalIntent();
    state.setExisting({
      leaf: OPERATION.intentLeaf,
      canonical,
      evidence: evidence(canonical, "existing-exact"),
    });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.recoveryOnly).toBe(true);
    expect(receipt.checks.durableIntentExact).toBe(true);
    expect(state.calls).not.toContain("write");
    expect(state.calls).not.toContain("intent-persist");
    expect(state.calls).not.toContain("target-preflight");
    expect(state.calls).toContain("target-postflight");
  });

  it("rebuilds branded preflight authority from durable raw transcripts", async () => {
    const state = fixture();
    const canonical = canonicalIntent();
    state.setExisting({
      leaf: OPERATION.intentLeaf,
      canonical,
      evidence: evidence(canonical, "existing-exact"),
    });
    let canonicalBridgeAccepted = false;
    state.dependencies.inspectTargetPostflight = async (
      _operation,
      _intent,
      preflight,
    ) => {
      state.calls.push("target-postflight");
      const current = brandedPostflightInventories();
      const authority = buildPermanentStagingProviderVariableTargetPostflight({
        preflight,
        variableInventory: current.variableInventory,
        deploymentInventory: current.deploymentInventory,
      });
      if (authority === null) throw new Error("canonical bridge rejected lineage");
      canonicalBridgeAccepted = true;
      return authority;
    };
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(canonicalBridgeAccepted).toBe(true);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.recoveryOnly).toBe(true);
    expect(receipt.checks.targetPostflightExact).toBe(true);
    expect(receipt.checks.deploymentUnchanged).toBe(true);
    expect(state.calls).not.toContain("write");
  });

  it("turns an intent publication race into recovery-only", async () => {
    const state = fixture();
    state.dependencies.persistIntent = async (_operation, canonical) => {
      state.calls.push("intent-persist");
      return evidence(canonical, "existing-exact");
    };
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.recoveryOnly).toBe(true);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(state.calls).not.toContain("write");
  });

  it("rejects mismatched existing evidence without a write", async () => {
    const state = fixture();
    const parsed = JSON.parse(canonicalIntent()) as Record<string, unknown>;
    parsed.valueCommitmentSha256 = "f".repeat(64);
    const canonical = JSON.stringify(parsed);
    state.setExisting({
      leaf: OPERATION.intentLeaf,
      canonical,
      evidence: evidence(canonical, "existing-exact"),
    });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.durableIntentExact).toBe(false);
    expect(state.calls).not.toContain("write");
  });

  it.each([
    ["production token", { productionTokenExact: false }],
    ["staging token", { stagingTokenExact: false }],
    ["production patch", { productionPatchEmpty: false }],
    ["staging patch", { stagingPatchEmpty: false }],
    ["production baseline", { productionBaselineExact: false }],
    ["mutation policy", { mutationPolicyExact: false }],
  ])("fails before intent/write when %s authority is false", async (_label, delta) => {
    const state = fixture();
    state.setBoundary({ ...boundary(), ...delta });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("failed");
    expect(state.calls).not.toContain("intent-persist");
    expect(state.calls).not.toContain("write");
    expect(state.calls.at(-1)).toBe("finalize");
  });

  it.each([
    ["incomplete inventory", { inventoryComplete: false }],
    ["existing target", { targetAbsent: false }],
    ["shared shadow", { sharedShadowAbsent: false }],
    ["incomplete deployment inventory", { deploymentInventoryComplete: false }],
  ])("rejects %s before durable intent", async (_label, delta) => {
    const state = fixture();
    state.setPreflight({
      ...targetPreflightObservation(),
      authority: { ...targetPreflight(), ...delta },
    });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("failed");
    expect(state.calls).not.toContain("intent-persist");
    expect(state.calls).not.toContain("write");
  });

  it("rejects noncanonical or non-exact raw preflight transcripts", async () => {
    const noncanonical = fixture();
    const observation = targetPreflightObservation();
    noncanonical.setPreflight({
      ...observation,
      recoveryLineage: {
        ...observation.recoveryLineage,
        variablePages: [{
          requestedAfter: null,
          source: `${VARIABLE_PAGE_SOURCE}\n`,
        }],
      },
    });
    const noncanonicalReceipt = await execute(
      OPERATION.operationId,
      noncanonical.dependencies,
    );
    expect(noncanonicalReceipt.outcome).toBe("failed");
    expect(noncanonical.calls).not.toContain("intent-persist");
    expect(noncanonical.calls).not.toContain("write");

    const extraField = fixture();
    const extraObservation = targetPreflightObservation();
    extraField.setPreflight({
      ...extraObservation,
      recoveryLineage: {
        ...extraObservation.recoveryLineage,
        variablePages: [{
          requestedAfter: null,
          source: VARIABLE_PAGE_SOURCE,
          extra: true,
        } as unknown as {
          readonly requestedAfter: null;
          readonly source: string;
        }],
      },
    });
    const extraReceipt = await execute(
      OPERATION.operationId,
      extraField.dependencies,
    );
    expect(extraReceipt.outcome).toBe("failed");
    expect(extraField.calls).not.toContain("intent-persist");
    expect(extraField.calls).not.toContain("write");
  });

  it("never writes after input reassertion drift", async () => {
    const state = fixture();
    let reads = 0;
    state.dependencies.inspectInput = async () => {
      state.calls.push("input");
      reads += 1;
      return reads === 1 ? input() : { ...input(), byteLength: 18 };
    };
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.inputReasserted).toBe(false);
    expect(state.calls).not.toContain("write");
  });

  it("never writes after target reassertion drift", async () => {
    const state = fixture();
    let reads = 0;
    state.dependencies.inspectTargetPreflight = async () => {
      state.calls.push("target-preflight");
      reads += 1;
      return reads === 1
        ? targetPreflightObservation()
        : {
          ...targetPreflightObservation(),
          authority: {
            ...targetPreflight(),
            metadataInventorySha256: "f".repeat(64),
          },
        };
    };
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.targetReasserted).toBe(false);
    expect(state.calls).not.toContain("write");
  });

  it("reconciles after a write throw and never retries", async () => {
    const state = fixture();
    state.dependencies.writeExactlyOnce = async () => {
      state.calls.push("write");
      throw new Error("raw-child-output-secret");
    };
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.writeAttempted).toBe(true);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(state.calls.filter((call) => call === "write")).toHaveLength(1);
    expect(state.calls).toContain("target-postflight");
    expect(JSON.stringify(receipt)).not.toContain("raw-child-output-secret");
  });

  it("invokes the writer once when an earlier dependency poisons Promise.resolve", async () => {
    const state = fixture();
    const previousResolve = Object.getOwnPropertyDescriptor(Promise, "resolve");
    let resolvePoisoned = false;
    const restoreResolve = () => {
      if (!resolvePoisoned) return;
      resolvePoisoned = false;
      if (previousResolve === undefined) {
        delete (Promise as { resolve?: unknown }).resolve;
      } else {
        Object.defineProperty(Promise, "resolve", previousResolve);
      }
    };
    const poisonedResolve = (() => ({
      then(onFulfilled: () => unknown) {
        onFulfilled();
        return onFulfilled();
      },
    })) as unknown as typeof Promise.resolve;
    state.dependencies.inspectTargetPreflight = async () => {
      state.calls.push("target-preflight");
      Object.defineProperty(Promise, "resolve", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: poisonedResolve,
      });
      resolvePoisoned = true;
      return targetPreflightObservation();
    };
    const originalWriteExactlyOnce = state.dependencies.writeExactlyOnce;
    state.dependencies.writeExactlyOnce = async (
      operation,
      intentSha256,
      attemptAuthority,
      signal,
    ) => {
      state.calls.push("write");
      restoreResolve();
      const callIndex = state.calls.lastIndexOf("write");
      state.calls.splice(callIndex, 1);
      return originalWriteExactlyOnce(
        operation,
        intentSha256,
        attemptAuthority,
        signal,
      );
    };

    let receipt: Awaited<ReturnType<typeof execute>> | null = null;
    try {
      receipt = await execute(OPERATION.operationId, state.dependencies);
    } finally {
      restoreResolve();
    }
    expect(receipt?.outcome).toBe("acknowledged_pending_runtime_proof");
    expect(state.calls.filter((call) => call === "write")).toHaveLength(1);
    expect(state.intentCandidates).toHaveLength(1);
    expect(state.terminalCandidates).toHaveLength(1);
  });

  it("does not accept a truthy or structurally malformed acknowledgement", async () => {
    const state = fixture();
    state.setAcknowledgement({
      ...acknowledgement(),
      childAttempts: 2,
    });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.acknowledgementExact).toBe(false);
  });

  it("rejects an otherwise exact unbranded local receipt after the sole write attempt", async () => {
    const state = fixture();
    state.setAcknowledgement({ ...acknowledgement() });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.writeAttempted).toBe(true);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(receipt.writeAcknowledgementSha256).toBeNull();
    expect(state.calls.filter((call) => call === "write")).toHaveLength(1);
  });

  it("rejects a genuine same-intent receipt minted before durable persistence", async () => {
    const preminted = acknowledgement();
    const state = fixture();
    state.setAcknowledgement(preminted);
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.intentSha256).toBe(preminted.intentSha256);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.durableIntentExact).toBe(true);
    expect(receipt.checks.writeAttempted).toBe(true);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(receipt.writeAcknowledgementSha256).toBeNull();
  });

  it("rejects a genuine receipt replayed against a different durable intent", async () => {
    const replayed = acknowledgement();
    const state = fixture();
    state.setBoundary({ ...boundary(), snapshotSha256: "e".repeat(64) });
    state.setAcknowledgement(replayed);
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.intentSha256).not.toBe(replayed.intentSha256);
    expect(receipt.checks.writeAttempted).toBe(true);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(receipt.writeAcknowledgementSha256).toBeNull();
  });

  it("consumes each genuine local receipt authority at most once", async () => {
    const first = fixture();
    const accepted = await execute(OPERATION.operationId, first.dependencies);
    expect(accepted.outcome).toBe("acknowledged_pending_runtime_proof");
    expect(accepted.checks.acknowledgementExact).toBe(true);
    const oneShot = first.getLastAcknowledgement();
    if (oneShot === null) throw new Error("missing in-call acknowledgement");

    const second = fixture();
    second.setAcknowledgement(oneShot);
    const replayed = await execute(OPERATION.operationId, second.dependencies);
    expect(replayed.outcome).toBe("mutation_uncertain");
    expect(replayed.checks.writeAttempted).toBe(true);
    expect(replayed.checks.acknowledgementExact).toBe(false);
    expect(replayed.writeAcknowledgementSha256).toBeNull();
  });

  it("rejects valid-looking acknowledgement hashes not bound to durable intent", async () => {
    const state = fixture();
    state.setAcknowledgement({
      ...acknowledgement(),
      localAuthoritySha256: "7".repeat(64),
      commandSha256: "8".repeat(64),
    });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.writeAttempted).toBe(true);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(receipt.writeAcknowledgementSha256).toBeNull();
    const terminal = JSON.parse(state.terminalCandidates[0]!) as {
      readonly preFinalizationReceipt: {
        readonly writeAcknowledgementSha256: string | null;
      };
    };
    expect(terminal.preFinalizationReceipt.writeAcknowledgementSha256)
      .toBeNull();
  });

  it.each([
    ["metadata delta", { metadataDeltaExact: false }],
    ["target metadata", { expectedMetadataExact: false }],
    ["deployment drift", {
      deploymentUnchanged: false,
      currentDeploymentInventorySha256: "f".repeat(64),
    }],
    ["shared shadow", { sharedShadowAbsent: false }],
  ])("keeps %s postflight non-green", async (_label, delta) => {
    const state = fixture();
    state.setPostflight({ ...targetPostflight(), ...delta });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.targetPostflightExact).toBe(false);
  });

  it("preserves mutation uncertainty when cleanup fails after a write attempt", async () => {
    const state = fixture();
    state.setCleanup({ ...cleanup(), inputZeroized: false });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.inputCleanupExact).toBe(false);
    expect(receipt.checks.cleanupExact).toBe(false);
    expect(state.calls).toContain("terminal-persist");
    expect(state.calls.at(-1)).toBe("finalize");
  });

  it("preserves mutation uncertainty when terminal evidence fails", async () => {
    const state = fixture();
    state.dependencies.persistTerminalEvidence = async (_operation, canonical) => {
      state.calls.push("terminal-persist");
      return { ...evidence(canonical), readbackExact: false };
    };
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.terminalEvidenceExact).toBe(false);
    expect(receipt.checks.finalizationExact).toBe(true);
  });

  it("preserves mutation uncertainty when finalization fails after durable intent", async () => {
    const state = fixture();
    state.setFinalize(false);
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.finalizationExact).toBe(false);
  });

  it("fences an exact terminal replay before input, provider, or write", async () => {
    const first = fixture();
    await execute(OPERATION.operationId, first.dependencies);
    const canonical = first.intentCandidates[0]!;
    const terminalCanonical = first.terminalCandidates[0]!;

    const replay = fixture();
    replay.setExisting({
      leaf: OPERATION.intentLeaf,
      canonical,
      evidence: evidence(canonical, "existing-exact"),
    });
    replay.setExistingTerminal({
      leaf: OPERATION.terminalEvidenceLeaf,
      canonical: terminalCanonical,
      evidence: evidence(terminalCanonical, "existing-exact"),
    });
    const receipt = await execute(OPERATION.operationId, replay.dependencies);
    expect(receipt).toMatchObject({
      outcome: "mutation_uncertain",
      recoveryOnly: true,
      intentSha256: sha256(canonical),
      terminalEvidenceSha256: sha256(terminalCanonical),
      runtimeValueProof: false,
      activationAuthorized: false,
      checks: {
        durableIntentExact: true,
        writeAttempted: false,
        postflightAttempted: false,
        terminalEvidenceExact: true,
        finalizationExact: true,
      },
    });
    expect(replay.calls).toEqual([
      "terminal-inspect",
      "intent-inspect",
      "cleanup",
      "finalize",
    ]);
    expect(replay.terminalCandidates).toEqual([]);
  });

  it("replays terminal success after finalization failure without new bytes", async () => {
    const first = fixture();
    first.setFinalize(false);
    const failed = await execute(OPERATION.operationId, first.dependencies);
    expect(failed.outcome).toBe("mutation_uncertain");
    expect(failed.checks.terminalEvidenceExact).toBe(true);
    expect(failed.checks.finalizationExact).toBe(false);
    const canonical = first.intentCandidates[0]!;
    const terminalCanonical = first.terminalCandidates[0]!;

    const replay = fixture();
    replay.setExisting({
      leaf: OPERATION.intentLeaf,
      canonical,
      evidence: evidence(canonical, "existing-exact"),
    });
    replay.setExistingTerminal({
      leaf: OPERATION.terminalEvidenceLeaf,
      canonical: terminalCanonical,
      evidence: evidence(terminalCanonical, "existing-exact"),
    });
    const recovered = await execute(OPERATION.operationId, replay.dependencies);
    expect(recovered.outcome).toBe("mutation_uncertain");
    expect(recovered.recoveryOnly).toBe(true);
    expect(recovered.checks.finalizationExact).toBe(true);
    expect(replay.calls).toEqual([
      "terminal-inspect",
      "intent-inspect",
      "cleanup",
      "finalize",
    ]);
    expect(replay.terminalCandidates).toEqual([]);
  });

  it("fails closed on malformed fixed-leaf terminal evidence", async () => {
    const state = fixture();
    const malformed = "{}";
    state.setExistingTerminal({
      leaf: OPERATION.terminalEvidenceLeaf,
      canonical: malformed,
      evidence: evidence(malformed, "existing-exact"),
    });
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt).toMatchObject({
      outcome: "mutation_uncertain",
      recoveryOnly: true,
      intentSha256: null,
      terminalEvidenceSha256: null,
      runtimeValueProof: false,
      activationAuthorized: false,
      checks: {
        durableIntentExact: false,
        writeAttempted: false,
        terminalEvidenceExact: false,
      },
    });
    expect(state.calls).toEqual([
      "terminal-inspect",
      "cleanup",
      "finalize",
    ]);
  });

  it("rejects exact terminal bytes presented under any other leaf", async () => {
    const first = fixture();
    await execute(OPERATION.operationId, first.dependencies);
    const terminalCanonical = first.terminalCandidates[0]!;
    const replay = fixture();
    replay.setExistingTerminal({
      leaf: OPERATION.intentLeaf,
      canonical: terminalCanonical,
      evidence: evidence(terminalCanonical, "existing-exact"),
    });
    const receipt = await execute(OPERATION.operationId, replay.dependencies);
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.recoveryOnly).toBe(true);
    expect(receipt.checks.terminalEvidenceExact).toBe(false);
    expect(replay.calls).toEqual([
      "terminal-inspect",
      "cleanup",
      "finalize",
    ]);
    expect(replay.calls).not.toContain("input");
    expect(replay.calls).not.toContain("write");
  });

  it("publishes dependency array snapshots as own data despite inherited setters", () => {
    const source = Object.freeze([
      Object.freeze({ marker: "source-own-data" }),
    ]);
    const priorIndex = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let setterCalls = 0;
    Object.defineProperty(Array.prototype, "0", {
      configurable: true,
      set() {
        setterCalls += 1;
        Object.defineProperty(this, "0", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: Object.freeze({ marker: "forged-by-prototype" }),
        });
      },
    });
    let snapshot: typeof source | undefined;
    try {
      snapshot = permanentStagingProviderVariableWriteKernelInternals
        .snapshotDependencyResult(source);
    } finally {
      if (priorIndex === undefined) {
        delete (Array.prototype as unknown as Record<string, unknown>)["0"];
      } else {
        Object.defineProperty(Array.prototype, "0", priorIndex);
      }
    }
    expect(setterCalls).toBe(0);
    expect(Object.hasOwn(snapshot!, "0")).toBe(true);
    expect(snapshot![0]).toEqual({ marker: "source-own-data" });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("awaits a timed-out operation before returning", async () => {
    let settle!: (value: string) => void;
    let signal!: AbortSignal;
    const deferred = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const result = permanentStagingProviderVariableWriteKernelInternals
      .withDeadline(1, async (operationSignal) => {
        signal = operationSignal;
        return deferred;
      });
    let returned = false;
    void result.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      },
    );
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(returned).toBe(false);
    settle("late-success");
    await expect(result).rejects.toThrow("operation_timeout");
  });

  it("does not trust poisoned live timers or AbortController methods", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const setTimeoutPoison = vi.spyOn(globalThis, "setTimeout")
      .mockImplementation(() => 12345 as unknown as NodeJS.Timeout);
    const clearTimeoutPoison = vi.spyOn(globalThis, "clearTimeout")
      .mockImplementation(() => {
        throw new Error("poisoned live clearTimeout");
      });
    const abortPoison = vi.spyOn(AbortController.prototype, "abort")
      .mockImplementation(() => undefined);
    const unrelatedSignal = new AbortController().signal;
    const signalPoison = vi.spyOn(AbortController.prototype, "signal", "get")
      .mockImplementation(() => unrelatedSignal);
    let caught: unknown;
    try {
      await permanentStagingProviderVariableWriteKernelInternals.withDeadline(
        1,
        async () => await new Promise<string>((resolve) => {
          Reflect.apply(realSetTimeout, globalThis, [
            () => resolve("late-success"),
            25,
          ]);
        }),
      );
    } catch (error) {
      caught = error;
    } finally {
      signalPoison.mockRestore();
      abortPoison.mockRestore();
      clearTimeoutPoison.mockRestore();
      setTimeoutPoison.mockRestore();
    }
    expect(caught).toMatchObject({ message: "operation_timeout" });
    expect(setTimeoutPoison).not.toHaveBeenCalled();
    expect(clearTimeoutPoison).not.toHaveBeenCalled();
    expect(abortPoison).not.toHaveBeenCalled();
    expect(signalPoison).not.toHaveBeenCalled();
  });

  it("rejects an unknown operation before touching dependencies", async () => {
    const state = fixture();
    await expect(execute("unknown", state.dependencies)).rejects.toThrow(
      "operation_invalid",
    );
    expect(state.calls).toEqual([]);
  });

  it("contains Proxy/accessor failures and never emits their messages", async () => {
    const state = fixture();
    const poison = new Proxy({}, {
      ownKeys: () => {
        throw new Error("secret-from-proxy-trap");
      },
    });
    state.dependencies.inspectBoundary = async () =>
      poison as PermanentStagingProviderVariableBoundaryAuthority;
    const receipt = await execute(OPERATION.operationId, state.dependencies);
    expect(receipt.outcome).toBe("failed");
    expect(JSON.stringify(receipt)).not.toContain("secret-from-proxy-trap");
    expect(state.calls).not.toContain("write");
    expect(state.calls.at(-1)).toBe("finalize");
  });

  it("pins four distinct create-only evidence identities", () => {
    expect(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS).toHaveLength(4);
    expect(new Set(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS.map(
        (operation) => operation.operationId,
      ),
    ).size).toBe(4);
    expect(new Set(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS.map(
        (operation) => operation.intentLeaf,
      ),
    ).size).toBe(4);
    expect(new Set(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS.map(
        (operation) => operation.terminalEvidenceLeaf,
      ),
    ).size).toBe(4);
  });
});
