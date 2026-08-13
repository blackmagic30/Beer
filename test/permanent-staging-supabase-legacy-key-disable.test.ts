import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY,
  PERMANENT_STAGING_SUPABASE_LEGACY_KEY_RESPONSE_SCHEMA,
  PERMANENT_STAGING_SUPABASE_LEGACY_KEY_STATE_SCHEMA,
  evaluatePermanentStagingSupabaseLegacyKeyDisable,
  parsePermanentStagingSupabaseLegacyKeyDisablePolicy,
  parsePermanentStagingSupabaseLegacyKeyDisableResponses,
  parsePermanentStagingSupabaseLegacyKeyStateSnapshot,
} from "../scripts/lib/permanent-staging-supabase-legacy-key-disable.js";

function state(phase: "before" | "after", enabled: boolean): string {
  return JSON.stringify({
    schemaVersion: PERMANENT_STAGING_SUPABASE_LEGACY_KEY_STATE_SCHEMA,
    source: "fixture-only",
    phase,
    projects: PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY.projects.map(
      (project) => ({
        role: project.role,
        projectRef: project.projectRef,
        enabled,
      }),
    ),
  });
}

function responses(
  mutate: (value: { responses: Array<{
    projectRef: string;
    response: Record<string, unknown>;
  }> }) => void = () => undefined,
): string {
  const value = {
    schemaVersion: PERMANENT_STAGING_SUPABASE_LEGACY_KEY_RESPONSE_SCHEMA,
    source: "fixture-only",
    responses: PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY.projects.map(
      (project) => ({
        projectRef: project.projectRef,
        response: { enabled: false } as Record<string, unknown>,
      }),
    ),
  };
  mutate(value);
  return JSON.stringify(value);
}

describe("permanent-staging Supabase legacy-key disable policy", () => {
  it("pins only the staging project, exact disable endpoint vocabulary, and null review-required key IDs", () => {
    const checkedIn = fs.readFileSync(
      path.resolve(
        "ops/supabase/permanent-staging-supabase-legacy-key-disable-policy.json",
      ),
      "utf8",
    );
    expect(checkedIn).toBe(
      PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_CANONICAL_POLICY_SOURCE,
    );
    expect(parsePermanentStagingSupabaseLegacyKeyDisablePolicy(checkedIn)).toBe(
      PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY,
    );
    expect(PERMANENT_STAGING_SUPABASE_LEGACY_KEY_DISABLE_POLICY).toMatchObject({
      activationState: "HARD_DISABLED_REVIEW_REQUIRED",
      projects: [
        {
          role: "permanent-staging",
          projectRef: "bbfibbadwjxzrcdncavy",
          legacyKeyIds: { anon: null, serviceRole: null },
          reviewRequired: true,
        },
      ],
      disableRequest: {
        method: "PUT",
        pathTemplate: "/v1/projects/{projectRef}/api-keys/legacy?enabled=false",
        exactResponse: { enabled: false },
        maximumAttemptsPerProject: 1,
        retriesAllowed: false,
      },
    });
  });

  it("recognizes the exact enabled-before/disabled-response/disabled-after sequence but cannot activate", () => {
    const evaluation = evaluatePermanentStagingSupabaseLegacyKeyDisable(
      parsePermanentStagingSupabaseLegacyKeyStateSnapshot(state("before", true))!,
      parsePermanentStagingSupabaseLegacyKeyDisableResponses(responses())!,
      parsePermanentStagingSupabaseLegacyKeyStateSnapshot(state("after", false))!,
    );
    expect(evaluation).toMatchObject({
      outcome: "blocked-review-required",
      projectsExact: true,
      beforeEnabledExact: true,
      disableResponsesExact: true,
      afterDisabledExact: true,
      legacyKeyIdsReviewed: false,
      policyActivated: false,
    });
    expect(evaluation.requests).toEqual([
      {
        method: "PUT",
        path: "/v1/projects/bbfibbadwjxzrcdncavy/api-keys/legacy?enabled=false",
        maximumAttempts: 1,
        retryAllowed: false,
      },
    ]);
  });

  it("rejects anything except the exact {enabled:false} response", () => {
    expect(parsePermanentStagingSupabaseLegacyKeyDisableResponses(responses(
      (value) => { value.responses[0]!.response.enabled = true; },
    ))).toBeNull();
    expect(parsePermanentStagingSupabaseLegacyKeyDisableResponses(responses(
      (value) => { value.responses[0]!.response.status = "disabled"; },
    ))).toBeNull();
    expect(parsePermanentStagingSupabaseLegacyKeyDisableResponses(
      `${responses()}\n`,
    )).toBeNull();
  });

  it("fails exact state checks for already-disabled before, enabled after, or a wrong project target", () => {
    const exactResponses = parsePermanentStagingSupabaseLegacyKeyDisableResponses(
      responses(),
    )!;
    const exactBefore = parsePermanentStagingSupabaseLegacyKeyStateSnapshot(
      state("before", true),
    )!;
    const exactAfter = parsePermanentStagingSupabaseLegacyKeyStateSnapshot(
      state("after", false),
    )!;
    expect(evaluatePermanentStagingSupabaseLegacyKeyDisable(
      parsePermanentStagingSupabaseLegacyKeyStateSnapshot(state("before", false))!,
      exactResponses,
      exactAfter,
    ).beforeEnabledExact).toBe(false);
    expect(evaluatePermanentStagingSupabaseLegacyKeyDisable(
      exactBefore,
      exactResponses,
      parsePermanentStagingSupabaseLegacyKeyStateSnapshot(state("after", true))!,
    ).afterDisabledExact).toBe(false);

    const wrongTarget = JSON.parse(state("after", false)) as {
      projects: Array<{ projectRef: string }>;
    };
    wrongTarget.projects[0]!.projectRef = "hfbmhdxrwtihukmixxta";
    const parsedWrongTarget = parsePermanentStagingSupabaseLegacyKeyStateSnapshot(
      JSON.stringify(wrongTarget),
    )!;
    expect(evaluatePermanentStagingSupabaseLegacyKeyDisable(
      exactBefore,
      exactResponses,
      parsedWrongTarget,
    ).projectsExact).toBe(false);
  });

  it("contains no provider client or credential-bearing runtime", () => {
    const source = fs.readFileSync(
      path.resolve("scripts/lib/permanent-staging-supabase-legacy-key-disable.ts"),
      "utf8",
    );
    for (const forbidden of [
      "fetch(",
      "node:https",
      "node:http",
      "SUPABASE_ACCESS_TOKEN",
      "RAILWAY_TOKEN",
      "process.env",
      "process.stdin",
    ]) expect(source).not.toContain(forbidden);
  });

  it("uses captured Array/RegExp/Set/String intrinsics for exact disabled-state evaluation", () => {
    const beforeSource = state("before", true);
    const responseSource = responses();
    const afterSource = state("after", false);
    const originals = {
      every: Array.prototype.every,
      map: Array.prototype.map,
      regexpExec: RegExp.prototype.exec,
      regexpTest: RegExp.prototype.test,
      setAdd: Set.prototype.add,
      stringReplace: String.prototype.replace,
    };
    const poisons = Array.from({ length: 6 }, () => vi.fn(() => {
      throw new Error("poison intrinsic invoked");
    }));
    let evaluation: ReturnType<
      typeof evaluatePermanentStagingSupabaseLegacyKeyDisable
    > | undefined;
    try {
      Array.prototype.every = poisons[0] as typeof Array.prototype.every;
      Array.prototype.map = poisons[1] as typeof Array.prototype.map;
      RegExp.prototype.exec = poisons[2] as typeof RegExp.prototype.exec;
      RegExp.prototype.test = poisons[3] as typeof RegExp.prototype.test;
      Set.prototype.add = poisons[4] as typeof Set.prototype.add;
      String.prototype.replace = poisons[5] as typeof String.prototype.replace;
      const before = parsePermanentStagingSupabaseLegacyKeyStateSnapshot(
        beforeSource,
      );
      const exactResponses = parsePermanentStagingSupabaseLegacyKeyDisableResponses(
        responseSource,
      );
      const after = parsePermanentStagingSupabaseLegacyKeyStateSnapshot(
        afterSource,
      );
      if (before && exactResponses && after) {
        evaluation = evaluatePermanentStagingSupabaseLegacyKeyDisable(
          before,
          exactResponses,
          after,
        );
      }
    } finally {
      Array.prototype.every = originals.every;
      Array.prototype.map = originals.map;
      RegExp.prototype.exec = originals.regexpExec;
      RegExp.prototype.test = originals.regexpTest;
      Set.prototype.add = originals.setAdd;
      String.prototype.replace = originals.stringReplace;
    }
    expect(evaluation).toMatchObject({
      outcome: "blocked-review-required",
      projectsExact: true,
      beforeEnabledExact: true,
      disableResponsesExact: true,
      afterDisabledExact: true,
    });
    expect(evaluation?.requests).toHaveLength(1);
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
  });
});
