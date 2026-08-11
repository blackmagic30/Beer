import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_SUPABASE_OLD_KEY_DENIAL_FIXTURE_SCHEMA,
  classifyPermanentStagingSupabaseOldKeyDenial,
  parsePermanentStagingSupabaseOldKeyDenialFixture,
} from "../scripts/lib/permanent-staging-supabase-old-key-denial.js";

function fixtureObject() {
  return {
    schemaVersion: PERMANENT_STAGING_SUPABASE_OLD_KEY_DENIAL_FIXTURE_SCHEMA,
    source: "fixture-only",
    projectRole: "permanent-staging",
    projectRef: "bbfibbadwjxzrcdncavy",
    keyFamily: "anon",
    legacyKeyId: null as string | null,
    request: {
      method: "GET",
      readOnly: true,
      canaryClass: "staging-auth-settings",
    },
    response: {
      transportCompleted: true,
      status: 401 as number | null,
      apiKeyDecision: "rejected",
    },
  };
}

function fixture(
  mutate: (value: ReturnType<typeof fixtureObject>) => void = () => undefined,
): string {
  const value = fixtureObject();
  mutate(value);
  return JSON.stringify(value);
}

describe("Supabase old-key denial fixture classifier", () => {
  it("classifies exact gateway rejection but withholds eligibility until the old key ID is reviewed", () => {
    const parsed = parsePermanentStagingSupabaseOldKeyDenialFixture(fixture())!;
    expect(classifyPermanentStagingSupabaseOldKeyDenial(parsed)).toEqual({
      classification: "denied",
      evidenceEligible: false,
      legacyKeyIdPolicyExact: false,
      ambiguousOutcomeAction: "STOP_NO_RETRY",
      keyMaterialIncluded: false,
      reason: "legacy-key-id-review-required",
    });
  });

  it("does not let an arbitrary UUID bypass the policy's null review gate", () => {
    const parsed = parsePermanentStagingSupabaseOldKeyDenialFixture(fixture(
      (value) => {
        value.legacyKeyId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";
      },
    ))!;
    expect(classifyPermanentStagingSupabaseOldKeyDenial(parsed)).toEqual({
      classification: "denied",
      evidenceEligible: false,
      legacyKeyIdPolicyExact: false,
      ambiguousOutcomeAction: "STOP_NO_RETRY",
      keyMaterialIncluded: false,
      reason: "legacy-key-id-review-required",
    });
  });

  it("classifies a 2xx accepted old key as not denied", () => {
    const parsed = parsePermanentStagingSupabaseOldKeyDenialFixture(fixture(
      (value) => {
        value.legacyKeyId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";
        value.response.status = 200;
        value.response.apiKeyDecision = "accepted";
      },
    ))!;
    expect(classifyPermanentStagingSupabaseOldKeyDenial(parsed)).toMatchObject({
      classification: "not-denied",
      evidenceEligible: false,
      reason: "gateway-accepted-old-key",
    });
  });

  it.each([
    ["403 rejection", (value: ReturnType<typeof fixtureObject>) => {
      value.response.status = 403;
    }],
    ["unknown 401", (value: ReturnType<typeof fixtureObject>) => {
      value.response.apiKeyDecision = "unknown";
    }],
    ["provider failure", (value: ReturnType<typeof fixtureObject>) => {
      value.response.status = 503;
      value.response.apiKeyDecision = "unknown";
    }],
    ["transport failure", (value: ReturnType<typeof fixtureObject>) => {
      value.response.transportCompleted = false;
      value.response.status = null;
      value.response.apiKeyDecision = "unknown";
    }],
    ["contradictory 2xx rejection", (value: ReturnType<typeof fixtureObject>) => {
      value.response.status = 200;
    }],
  ])("keeps %s ambiguous and mandates stop/no-retry", (_label, mutate) => {
    const parsed = parsePermanentStagingSupabaseOldKeyDenialFixture(fixture(
      (value) => {
        value.legacyKeyId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";
        mutate(value);
      },
    ))!;
    expect(classifyPermanentStagingSupabaseOldKeyDenial(parsed)).toMatchObject({
      classification: "ambiguous",
      evidenceEligible: false,
      ambiguousOutcomeAction: "STOP_NO_RETRY",
      reason: "ambiguous-provider-outcome",
    });
  });

  it("pins exact project/family/read-only canary combinations", () => {
    expect(parsePermanentStagingSupabaseOldKeyDenialFixture(fixture(
      (value) => { value.projectRef = "hfbmhdxrwtihukmixxta"; },
    ))).toBeNull();
    expect(parsePermanentStagingSupabaseOldKeyDenialFixture(fixture(
      (value) => { value.request.canaryClass = "staging-auth-admin-list-limit-one"; },
    ))).toBeNull();
    expect(parsePermanentStagingSupabaseOldKeyDenialFixture(fixture(
      (value) => { value.request.method = "POST"; },
    ))).toBeNull();

    const offsiteService = fixtureObject();
    offsiteService.projectRole = "operational-offsite-copy";
    offsiteService.projectRef = "hfbmhdxrwtihukmixxta";
    offsiteService.keyFamily = "serviceRole";
    offsiteService.request.canaryClass = "offsite-private-storage-bucket";
    expect(parsePermanentStagingSupabaseOldKeyDenialFixture(
      JSON.stringify(offsiteService),
    )).not.toBeNull();
  });

  it("rejects credential-bearing extras and noncanonical fixture serialization", () => {
    const extra = { ...fixtureObject(), oldKey: `eyJ${"x".repeat(40)}` };
    expect(parsePermanentStagingSupabaseOldKeyDenialFixture(
      JSON.stringify(extra),
    )).toBeNull();
    expect(parsePermanentStagingSupabaseOldKeyDenialFixture(`${fixture()}\n`))
      .toBeNull();
  });

  it("is a fixture-only pure classifier with no network or environment surface", () => {
    const source = fs.readFileSync(
      path.resolve("scripts/lib/permanent-staging-supabase-old-key-denial.ts"),
      "utf8",
    );
    for (const forbidden of [
      "fetch(",
      "node:https",
      "node:http",
      "process.env",
      "process.stdin",
      "SUPABASE_ACCESS_TOKEN",
    ]) expect(source).not.toContain(forbidden);
  });

  it("uses captured Array/RegExp/Object intrinsics for fixture parsing and policy binding", () => {
    const source = fixture((value) => {
      value.legacyKeyId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";
    });
    const originals = {
      find: Array.prototype.find,
      numberIsSafeInteger: Number.isSafeInteger,
      regexpExec: RegExp.prototype.exec,
      regexpTest: RegExp.prototype.test,
      objectFreeze: Object.freeze,
    };
    const poisons = Array.from({ length: 5 }, () => vi.fn(() => {
      throw new Error("poison intrinsic invoked");
    }));
    let result: ReturnType<
      typeof classifyPermanentStagingSupabaseOldKeyDenial
    > | undefined;
    try {
      Array.prototype.find = poisons[0] as typeof Array.prototype.find;
      Number.isSafeInteger = poisons[1] as typeof Number.isSafeInteger;
      RegExp.prototype.exec = poisons[2] as typeof RegExp.prototype.exec;
      RegExp.prototype.test = poisons[3] as typeof RegExp.prototype.test;
      Object.freeze = poisons[4] as typeof Object.freeze;
      const parsed = parsePermanentStagingSupabaseOldKeyDenialFixture(source);
      if (parsed) result = classifyPermanentStagingSupabaseOldKeyDenial(parsed);
    } finally {
      Array.prototype.find = originals.find;
      Number.isSafeInteger = originals.numberIsSafeInteger;
      RegExp.prototype.exec = originals.regexpExec;
      RegExp.prototype.test = originals.regexpTest;
      Object.freeze = originals.objectFreeze;
    }
    expect(result).toMatchObject({
      classification: "denied",
      evidenceEligible: false,
      legacyKeyIdPolicyExact: false,
      reason: "legacy-key-id-review-required",
    });
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
  });
});
