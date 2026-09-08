import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  COLD_PROVIDER_HISTORY_ANCHOR,
  COLD_PROVIDER_HISTORY_QUERY,
  COLD_PROVIDER_PATCHES_QUERY,
  COLD_PROVIDER_PATCH_QUERY,
  readPermanentStagingColdProviderNoWriteProof,
} from "../scripts/lib/permanent-staging-cold-provider-history.js";
import {
  COLD_RECOVERY_LOCK,
  type ColdRecoveryState,
} from "../scripts/lib/permanent-staging-cold-recovery.js";

type JsonRecord = Record<string, unknown>;

interface ProjectionFixture {
  readonly schemaVersion: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly secretMaterialIncluded: boolean;
  readonly secretDerivedCommitmentsIncluded: boolean;
  readonly history: {
    readonly count: number;
    readonly rowsSha256: string;
    readonly rows: readonly JsonRecord[];
  };
  readonly patches: {
    readonly count: number;
    readonly rowsSha256: string;
    readonly envelopeSha256: string;
    readonly rows: readonly JsonRecord[];
  };
}

const fixture = JSON.parse(fs.readFileSync(path.join(
  process.cwd(),
  "test/fixtures/cold-provider-history-prefix-20260908.json",
), "utf8")) as ProjectionFixture;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const record = value as JsonRecord;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [
    key,
    sortKeys(record[key]),
  ]));
}

function canonical(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function compareLiveRows(
  left: ColdRecoveryState["rows"][number],
  right: ColdRecoveryState["rows"][number],
): number {
  return `${left.serviceId ?? ""}:${left.name}:${left.id}`.localeCompare(
    `${right.serviceId ?? ""}:${right.name}:${right.id}`,
  );
}

function valueFromKeyShape(shape: unknown): unknown {
  if (shape === "null") return null;
  if (shape === "string") return "redacted";
  if (shape === "number") return 0;
  if (shape === "boolean") return false;
  if (typeof shape !== "object" || shape === null || Array.isArray(shape)) {
    throw new Error("fixture_shape_invalid");
  }
  const record = shape as JsonRecord;
  if (record.type === "array" && Array.isArray(record.items)) {
    return record.items.map(valueFromKeyShape);
  }
  if (record.type !== "object" || typeof record.children !== "object" ||
    record.children === null || Array.isArray(record.children)) {
    throw new Error("fixture_shape_invalid");
  }
  return Object.fromEntries(Object.entries(record.children as JsonRecord).map(
    ([key, value]) => [key, valueFromKeyShape(value)],
  ));
}

function rawHistoryRow(row: JsonRecord): JsonRecord {
  const payload = row.activityPayload as JsonRecord;
  return {
    id: row.id,
    createdAt: row.createdAt,
    object: row.object,
    action: row.action,
    outcome: row.outcome,
    operationKind: row.operationKind,
    severity: row.severity,
    source: row.source,
    workflowId: row.workflowId,
    activityPayload: {
      count: payload.count,
      names: payload.names,
      serviceId: payload.serviceId,
    },
  };
}

function rawPatchRow(row: JsonRecord): JsonRecord {
  return {
    id: row.id,
    environmentId: row.environmentId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    appliedAt: row.appliedAt,
    message: row.message,
    patch: valueFromKeyShape(row.patchKeyShape),
  };
}

const PREPARE_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const PREPARE_PATCH_ID = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT_PATCH_ID = "44444444-4444-4444-8444-444444444444";

function suffixHistory(
  id: string,
  createdAt: string,
  variableName: string,
): JsonRecord {
  return {
    id,
    createdAt,
    object: "Variable",
    action: "updated",
    outcome: "",
    operationKind: "",
    severity: "INFO",
    source: "event",
    workflowId: null,
    activityPayload: {
      count: 1,
      names: [variableName],
      serviceId: COLD_RECOVERY_LOCK.serviceId,
    },
  };
}

function suffixPatch(
  id: string,
  createdAt: string,
  appliedAt: string,
  variableName: string,
): JsonRecord {
  return {
    id,
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    status: "COMMITTED",
    createdAt,
    updatedAt: createdAt,
    appliedAt,
    message: "Setting 2 variables",
    patch: {
      services: {
        [COLD_RECOVERY_LOCK.serviceId]: {
          variables: { [variableName]: { value: "redacted" } },
        },
      },
    },
  };
}

function providerRows(): {
  history: JsonRecord[];
  patches: JsonRecord[];
} {
  return {
    history: [
      suffixHistory(
        PREPARE_EVENT_ID,
        "2026-09-08T12:26:00.000Z",
        "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
      ),
      suffixHistory(
        REPLACEMENT_EVENT_ID,
        "2026-09-08T12:21:00.000Z",
        "SUPABASE_SERVICE_ROLE_KEY",
      ),
      ...fixture.history.rows.map(rawHistoryRow),
    ],
    patches: [
      suffixPatch(
        PREPARE_PATCH_ID,
        "2026-09-08T12:26:00.002Z",
        "2026-09-08T12:26:00.000Z",
        "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
      ),
      suffixPatch(
        REPLACEMENT_PATCH_ID,
        "2026-09-08T12:21:00.002Z",
        "2026-09-08T12:21:00.000Z",
        "SUPABASE_SERVICE_ROLE_KEY",
      ),
      ...fixture.patches.rows.map(rawPatchRow),
    ],
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function providerFetch(rows: ReturnType<typeof providerRows>): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { after?: string | null; id?: string };
    };
    if (body.query === COLD_PROVIDER_HISTORY_QUERY) {
      const edges = rows.history.map((node, index) => ({
        cursor: `history-${index}-${String(node.id)}`,
        node,
      }));
      return response({ data: { environmentHistory: {
        edges,
        pageInfo: {
          hasNextPage: false,
          endCursor: edges.at(-1)!.cursor,
        },
      } } });
    }
    if (body.query === COLD_PROVIDER_PATCHES_QUERY) {
      const offset = body.variables.after === null ? 0 : 100;
      const selected = rows.patches.slice(offset, offset + 100);
      const edges = selected.map((node, index) => ({
        cursor: `patch-${offset + index}-${String(node.id)}`,
        node,
      }));
      return response({ data: { environmentPatches: {
        edges,
        pageInfo: {
          hasNextPage: offset === 0,
          endCursor: edges.at(-1)!.cursor,
        },
      } } });
    }
    if (body.query === COLD_PROVIDER_PATCH_QUERY) {
      return response({ data: { environmentPatch: rows.patches.find(
        (row) => row.id === body.variables.id,
      ) } });
    }
    return response({ errors: [{ message: "unexpected operation" }] });
  }) as typeof fetch;
}

function liveState(): ColdRecoveryState {
  const applicationRows = [
    {
      name: "DATABASE_URL",
      references: [
        "c454955f-263b-4599-aee0-dc447a4d3d15.PINTPATH_RUNTIME_DATABASE_URL",
      ],
    },
    {
      name: "REDIS_URL",
      references: ["d6351cec-fe04-4a6f-8e05-1cc164ea1e73.REDIS_URL"],
    },
    ...[
      "ALCOHOL_GAMIFICATION_ENABLED",
      "CONSUMER_PAID_ENROLLMENT_ENABLED",
      "GOOGLE_MAPS_API_KEY",
      "GOOGLE_MAPS_MAP_ID",
      "GOOGLE_PLACES_API_KEY",
      "OPENAI_API_KEY",
      "PINT_POINTS_REWARDS_ENABLED",
      "PUBLIC_BASE_URL",
      "REPORT_DELIVERY_SCHEDULE_ENABLED",
      "SUPABASE_ANON_KEY",
      "SUPABASE_RESULTS_TABLE",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_URL",
      "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
      ...Array.from({ length: 60 }, (_, index) =>
        `TEST_BEER_VARIABLE_${String(index).padStart(2, "0")}`),
    ].map((name) => ({ name, references: [] as string[] })),
  ].map(({ name, references }, index) => ({
    id: `beer-row-${String(index).padStart(2, "0")}`,
    name,
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    isSealed: name === "SUPABASE_SERVICE_ROLE_KEY",
    references,
  }));
  const siblingRows = [
    ...Array.from({ length: 14 }, (_, index) => ({
      id: `postgres-row-${String(index).padStart(2, "0")}`,
      name: index === 0 ? "DATABASE_URL" :
        `TEST_POSTGRES_VARIABLE_${String(index).padStart(2, "0")}`,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: "c454955f-263b-4599-aee0-dc447a4d3d15",
      isSealed: false,
      references: [],
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `redis-row-${String(index).padStart(2, "0")}`,
      name: index === 0 ? "REDIS_URL" :
        `TEST_REDIS_VARIABLE_${String(index).padStart(2, "0")}`,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: "d6351cec-fe04-4a6f-8e05-1cc164ea1e73",
      isSealed: false,
      references: [],
    })),
  ];
  const rows = [...applicationRows, ...siblingRows].sort(compareLiveRows);
  return {
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceInstanceId: COLD_RECOVERY_LOCK.serviceInstanceId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    numReplicas: null,
    configuredReplicas: 1,
    configuredRegions: [{
      region: COLD_RECOVERY_LOCK.configuredRegionBefore,
      numReplicas: 1,
    }],
    deploymentRegions: [{ region: COLD_RECOVERY_LOCK.region, numReplicas: 1 }],
    source: { repo: null, image: null },
    latestDeployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      status: "FAILED",
      deploymentStopped: true,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
    },
    activeDeployments: [],
    domains: [{
      kind: "service",
      id: COLD_RECOVERY_LOCK.domainId,
      domain: COLD_RECOVERY_LOCK.domain,
      targetPort: COLD_RECOVERY_LOCK.targetPort,
    }],
    deployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
      commitHash: COLD_RECOVERY_LOCK.sourceSha,
      imageDigest: null,
      patchId: null,
    },
    rows,
  };
}

const proofInput = {
  replacement: {
    runId: "500",
    startedAt: "2026-09-08T12:20:00.000Z",
    completedAt: "2026-09-08T12:22:00.000Z",
  },
  prepare: {
    runId: "1000",
    startedAt: "2026-09-08T12:25:00.000Z",
    completedAt: "2026-09-08T12:27:00.000Z",
  },
  observedAt: "2026-09-08T12:28:00.000Z",
  liveState: liveState(),
} as const;

describe("permanent-staging cold provider history proof", () => {
  it("locks the complete secret-free live prefix fixture", () => {
    expect(fixture).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-provider-history-projection-fixture/v1",
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
      history: {
        count: COLD_PROVIDER_HISTORY_ANCHOR.historyPrefixCount,
        rowsSha256: COLD_PROVIDER_HISTORY_ANCHOR.historyPrefixRowsSha256,
      },
      patches: {
        count: COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixCount,
        rowsSha256: COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixRowsSha256,
        envelopeSha256: COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixEnvelopeSha256,
      },
    });
    expect(sha256(canonical(fixture.history.rows))).toBe(
      COLD_PROVIDER_HISTORY_ANCHOR.historyPrefixRowsSha256,
    );
    expect(sha256(canonical(fixture.patches.rows))).toBe(
      COLD_PROVIDER_HISTORY_ANCHOR.patchPrefixRowsSha256,
    );
  });

  it("accepts only the pinned prefix plus the two authorized variable-only writes", async () => {
    const rows = providerRows();
    const live = liveState();
    expect(live.rows).toHaveLength(97);
    expect(live.rows.filter((row) =>
      row.serviceId === COLD_RECOVERY_LOCK.serviceId)).toHaveLength(76);
    expect(live.rows.filter((row) =>
      row.serviceId === "c454955f-263b-4599-aee0-dc447a4d3d15")).toHaveLength(14);
    expect(live.rows.filter((row) =>
      row.serviceId === "d6351cec-fe04-4a6f-8e05-1cc164ea1e73")).toHaveLength(7);
    const fetchImpl = providerFetch(rows);
    await expect(readPermanentStagingColdProviderNoWriteProof(
      fetchImpl,
      "metadata-token-long-enough",
      { ...proofInput, liveState: live },
    )).resolves.toMatchObject({
      history: {
        count: 10,
        prefixCount: 8,
        suffixEventIds: [PREPARE_EVENT_ID, REPLACEMENT_EVENT_ID],
      },
      patches: {
        count: 126,
        prefixCount: 124,
        suffixPatchIds: [PREPARE_PATCH_ID, REPLACEMENT_PATCH_ID],
      },
      checks: {
        historicalPrefixesExact: true,
        historicalScalePositiveControlExact: true,
        legacyUnauthorizedRunNoWriteExact: true,
        priorUnauthorizedRunNoWriteExact: true,
        failedPrewriteUnauthorizedRunNoWriteExact: true,
        authorizedSuffixExact: true,
        targetDeployAbsentFromSuffixExact: true,
        crossFetchedPatchesExact: true,
        ledgerRecheckExact: true,
        liveTopologyContinuityExact: true,
      },
    });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it.each([
    ["an invalid sibling service id", (state: ColdRecoveryState) => {
      const sibling = state.rows.find((row) =>
        row.serviceId === "c454955f-263b-4599-aee0-dc447a4d3d15");
      if (sibling) (sibling as { serviceId: string }).serviceId = "not-a-uuid";
    }],
    ["a duplicate sibling identity", (state: ColdRecoveryState) => {
      const sibling = state.rows.find((row) =>
        row.serviceId === "d6351cec-fe04-4a6f-8e05-1cc164ea1e73");
      if (sibling) {
        (state.rows as ColdRecoveryState["rows"] &
          { push: (row: typeof sibling) => void }).push(structuredClone(sibling));
      }
    }],
    ["a shared target-variable shadow", (state: ColdRecoveryState) => {
      const sibling = state.rows.find((row) =>
        row.serviceId === "c454955f-263b-4599-aee0-dc447a4d3d15");
      if (sibling) {
        (sibling as { serviceId: null; name: string }).serviceId = null;
        (sibling as { name: string }).name = "DATABASE_URL";
      }
    }],
  ])("rejects %s before reading provider history", async (_label, mutate) => {
    const state = structuredClone(liveState());
    mutate(state);
    const sortedState = {
      ...state,
      rows: [...state.rows].sort(compareLiveRows),
    } satisfies ColdRecoveryState;
    const fetchImpl = providerFetch(providerRows());
    await expect(readPermanentStagingColdProviderNoWriteProof(
      fetchImpl,
      "metadata-token-long-enough",
      { ...proofInput, liveState: sortedState },
    )).rejects.toThrow("cold_provider_history_input_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts an authorized suffix applied 6.419s after creation", async () => {
    const rows = providerRows();
    rows.patches[0]!.appliedAt = "2026-09-08T12:26:06.421Z";
    rows.patches[0]!.updatedAt = "2026-09-08T12:26:06.422Z";
    rows.patches[1]!.appliedAt = "2026-09-08T12:21:06.421Z";
    rows.patches[1]!.updatedAt = "2026-09-08T12:21:06.422Z";
    await expect(readPermanentStagingColdProviderNoWriteProof(
      providerFetch(rows),
      "metadata-token-long-enough",
      proofInput,
    )).resolves.toMatchObject({
      checks: {
        authorizedSuffixExact: true,
        crossFetchedPatchesExact: true,
      },
    });
  });

  it.each([
    ["prefix drift", (rows: ReturnType<typeof providerRows>) => {
      rows.patches[2]!.message = "drift";
    }],
    ["an impossible generic-row timestamp", (rows: ReturnType<typeof providerRows>) => {
      rows.patches[2]!.updatedAt = "2026-09-08T04:19:56.525Z";
    }],
    ["a suffix deploy key", (rows: ReturnType<typeof providerRows>) => {
      (rows.patches[0]!.patch as JsonRecord).services = {
        [COLD_RECOVERY_LOCK.serviceId]: {
          deploy: null,
          variables: {
            PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: {
              value: "redacted",
            },
          },
        },
      };
    }],
    ["a third suffix patch", (rows: ReturnType<typeof providerRows>) => {
      rows.patches.unshift(structuredClone(rows.patches[0]!));
      rows.patches[0]!.id = "55555555-5555-4555-8555-555555555555";
      rows.patches[0]!.createdAt = "2026-09-08T12:26:30.000Z";
      rows.patches[0]!.updatedAt = "2026-09-08T12:26:30.000Z";
      rows.patches[0]!.appliedAt = "2026-09-08T12:26:29.998Z";
    }],
    ["an uncommitted suffix", (rows: ReturnType<typeof providerRows>) => {
      rows.patches[0]!.status = "PENDING";
    }],
    ["a misleading suffix message", (rows: ReturnType<typeof providerRows>) => {
      rows.patches[0]!.message = "Setting variables";
    }],
    ["a suffix applied after its update", (rows: ReturnType<typeof providerRows>) => {
      rows.patches[0]!.appliedAt = "2026-09-08T12:26:00.004Z";
      rows.patches[0]!.updatedAt = "2026-09-08T12:26:00.003Z";
    }],
    ["an out-of-window applied timestamp", (rows: ReturnType<typeof providerRows>) => {
      rows.patches[0]!.appliedAt = "2026-09-08T12:27:00.001Z";
      rows.patches[0]!.updatedAt = "2026-09-08T12:27:00.001Z";
    }],
    ["an incident-window event", (rows: ReturnType<typeof providerRows>) => {
      rows.history[1]!.createdAt = "2026-09-08T04:31:00.000Z";
    }],
    ["non-monotone history", (rows: ReturnType<typeof providerRows>) => {
      rows.history[3]!.createdAt = "2026-09-08T12:22:30.000Z";
    }],
  ])("rejects %s", async (_label, mutate) => {
    const rows = providerRows();
    mutate(rows);
    await expect(readPermanentStagingColdProviderNoWriteProof(
      providerFetch(rows),
      "metadata-token-long-enough",
      proofInput,
    )).rejects.toThrow(/cold_provider_history_/);
  });

  it("rejects GraphQL errors instead of accepting a partial ledger", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response({
      data: { environmentHistory: null },
      errors: [{ message: "denied" }],
    })) as typeof fetch;
    await expect(readPermanentStagingColdProviderNoWriteProof(
      fetchImpl,
      "metadata-token-long-enough",
      proofInput,
    )).rejects.toThrow();
  });

  it("rejects a provider ledger that changes during proof construction", async () => {
    const rows = providerRows();
    const stableFetch = providerFetch(rows);
    let historyReads = 0;
    const changingFetch = vi.fn(async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query === COLD_PROVIDER_HISTORY_QUERY) {
        historyReads += 1;
        if (historyReads === 2) {
          rows.history.unshift(suffixHistory(
            "55555555-5555-4555-8555-555555555555",
            "2026-09-08T12:27:30.000Z",
            "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
          ));
        }
      }
      return await stableFetch(request, init);
    }) as typeof fetch;
    await expect(readPermanentStagingColdProviderNoWriteProof(
      changingFetch,
      "metadata-token-long-enough",
      proofInput,
    )).rejects.toThrow("cold_provider_history_ledger_changed_during_proof");
  });
});
