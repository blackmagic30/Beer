import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_OBSERVATION_SCHEMA,
  PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY,
  evaluatePermanentStagingSupabaseKeyCanaryB,
  parsePermanentStagingSupabaseKeyCanaryBObservation,
  parsePermanentStagingSupabaseKeyCanaryBPolicy,
} from "../scripts/lib/permanent-staging-supabase-key-canary-b.js";

function observationObject() {
  const policy = PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY;
  return {
    schemaVersion: PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_OBSERVATION_SCHEMA,
    projectId: policy.railwayTarget.projectId,
    environmentId: policy.railwayTarget.environmentId,
    serviceId: policy.railwayTarget.canaryServiceId,
    railwayConfigPath: policy.railwayTarget.railwayConfigPath,
    deploymentId: "235d6994-7bd4-4a13-b1dc-f255775d5dc0",
    lifecycle: {
      startCommand: policy.lifecycle.startCommand,
      restartPolicyType: policy.lifecycle.restartPolicyType,
    },
    network: {
      publicDomains: [] as string[],
      tcpProxyPorts: [] as number[],
    },
    source: {
      entrypointPath: policy.sourceReview.entrypointPath,
      gitCommitSha: "a".repeat(40),
      entrypointSha256: "b".repeat(64),
      railwayConfigSha256: "c".repeat(64),
      imageDigest: `sha256:${"d".repeat(64)}`,
    },
    references: policy.requiredReferences.map((reference) => ({ ...reference })),
    checks: {
      stagingAuthSettings: true,
      stagingAuthAdminListLimitOne: true,
      stagingPrivateStorageBucket: true,
      offsitePrivateStorageBucket: true,
    },
  };
}

function observation(
  mutate: (value: ReturnType<typeof observationObject>) => void = () => undefined,
): string {
  const value = observationObject();
  mutate(value);
  return JSON.stringify(value);
}

describe("permanent-staging Supabase key canary-B policy", () => {
  it("pins the existing no-restart canary service and stays blocked on unreviewed source locks", () => {
    const checkedIn = fs.readFileSync(
      path.resolve("ops/railway/permanent-staging-supabase-key-canary-b-policy.json"),
      "utf8",
    );
    expect(checkedIn).toBe(
      PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_CANONICAL_POLICY_SOURCE,
    );
    expect(parsePermanentStagingSupabaseKeyCanaryBPolicy(checkedIn)).toBe(
      PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY,
    );
    expect(PERMANENT_STAGING_SUPABASE_KEY_CANARY_B_POLICY).toMatchObject({
      activationState: "HARD_DISABLED_REVIEW_REQUIRED",
      railwayTarget: {
        canaryServiceId: "34a312cd-0920-4a7e-90db-8561c1e0746b",
        railwayConfigPath: "/railway.supabase-key-canary.toml",
      },
      lifecycle: {
        startCommand: "node dist/scripts/staging-supabase-key-canary.js",
        restartPolicyType: "NEVER",
        publicDomains: [],
        tcpProxyPorts: [],
      },
      sourceReview: { reviewRequired: true },
      reviewLocks: {
        deploymentId: null,
        gitCommitSha: null,
        entrypointSha256: null,
        railwayConfigSha256: null,
        imageDigest: null,
      },
    });
    expect(parsePermanentStagingSupabaseKeyCanaryBPolicy(`${checkedIn}\n`))
      .toBeNull();
  });

  it("evaluates an otherwise exact read-only no-ingress topology as review-blocked", () => {
    const parsed = parsePermanentStagingSupabaseKeyCanaryBObservation(
      observation(),
    )!;
    expect(evaluatePermanentStagingSupabaseKeyCanaryB(parsed)).toEqual({
      outcome: "blocked-review-required",
      targetExact: true,
      lifecycleExact: true,
      noIngress: true,
      sourceExact: false,
      referencesExact: true,
      readOnlyChecksPassed: true,
      policyActivated: false,
      reviewLocksComplete: false,
    });
  });

  it.each([
    ["public domain", (value: ReturnType<typeof observationObject>) => {
      value.network.publicDomains.push("canary.example.test");
    }, "noIngress"],
    ["TCP proxy", (value: ReturnType<typeof observationObject>) => {
      value.network.tcpProxyPorts.push(443);
    }, "noIngress"],
    ["wrong service", (value: ReturnType<typeof observationObject>) => {
      value.serviceId = "435d6994-7bd4-4a13-b1dc-f255775d5dc0";
    }, "targetExact"],
    ["wrong start command", (value: ReturnType<typeof observationObject>) => {
      value.lifecycle.startCommand = "node dist/src/server.js";
    }, "lifecycleExact"],
    ["wrong reference", (value: ReturnType<typeof observationObject>) => {
      value.references[0]!.sourceServiceId =
        "435d6994-7bd4-4a13-b1dc-f255775d5dc0";
    }, "referencesExact"],
    ["write-shaped failed check", (value: ReturnType<typeof observationObject>) => {
      value.checks.offsitePrivateStorageBucket = false;
    }, "readOnlyChecksPassed"],
  ])("fails the %s topology/source/reference check", (_label, mutate, check) => {
    const parsed = parsePermanentStagingSupabaseKeyCanaryBObservation(
      observation(mutate),
    )!;
    const evaluation = evaluatePermanentStagingSupabaseKeyCanaryB(parsed);
    expect(evaluation[check as keyof typeof evaluation]).toBe(false);
    expect(evaluation.outcome).not.toBe("passed");
  });

  it("rejects extra observation fields, malformed source pins, and noncanonical JSON", () => {
    const extra = { ...observationObject(), providerToken: "forbidden" };
    expect(parsePermanentStagingSupabaseKeyCanaryBObservation(
      JSON.stringify(extra),
    )).toBeNull();
    expect(parsePermanentStagingSupabaseKeyCanaryBObservation(observation(
      (value) => { value.source.imageDigest = "latest"; },
    ))).toBeNull();
    expect(parsePermanentStagingSupabaseKeyCanaryBObservation(
      `${observation()}\n`,
    )).toBeNull();
  });

  it("uses captured Array/Object/RegExp/Set/Number intrinsics for topology and review locks", () => {
    const source = observation();
    const originals = {
      every: Array.prototype.every,
      map: Array.prototype.map,
      values: Object.values,
      regexpExec: RegExp.prototype.exec,
      regexpTest: RegExp.prototype.test,
      setAdd: Set.prototype.add,
      isSafeInteger: Number.isSafeInteger,
    };
    const poisons = Array.from({ length: 7 }, () => vi.fn(() => {
      throw new Error("poison intrinsic invoked");
    }));
    let parsed: ReturnType<
      typeof parsePermanentStagingSupabaseKeyCanaryBObservation
    >;
    let evaluation: ReturnType<
      typeof evaluatePermanentStagingSupabaseKeyCanaryB
    > | undefined;
    try {
      Array.prototype.every = poisons[0] as typeof Array.prototype.every;
      Array.prototype.map = poisons[1] as typeof Array.prototype.map;
      Object.values = poisons[2] as typeof Object.values;
      RegExp.prototype.exec = poisons[3] as typeof RegExp.prototype.exec;
      RegExp.prototype.test = poisons[4] as typeof RegExp.prototype.test;
      Set.prototype.add = poisons[5] as typeof Set.prototype.add;
      Number.isSafeInteger = poisons[6] as typeof Number.isSafeInteger;
      parsed = parsePermanentStagingSupabaseKeyCanaryBObservation(source);
      if (parsed) evaluation = evaluatePermanentStagingSupabaseKeyCanaryB(parsed);
    } finally {
      Array.prototype.every = originals.every;
      Array.prototype.map = originals.map;
      Object.values = originals.values;
      RegExp.prototype.exec = originals.regexpExec;
      RegExp.prototype.test = originals.regexpTest;
      Set.prototype.add = originals.setAdd;
      Number.isSafeInteger = originals.isSafeInteger;
    }
    expect(parsed).not.toBeNull();
    expect(evaluation).toMatchObject({
      outcome: "blocked-review-required",
      noIngress: true,
      referencesExact: true,
      reviewLocksComplete: false,
    });
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
  });
});
