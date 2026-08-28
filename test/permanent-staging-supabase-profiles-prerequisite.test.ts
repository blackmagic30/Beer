import { describe, expect, it, vi } from "vitest";

import {
  canaryPermanentStagingSupabaseKeyPair,
  parsePermanentStagingSupabaseProfilesPrerequisite,
  runPermanentStagingSupabaseProfilesPrerequisite,
  STAGING_SUPABASE_PROFILES_LOCK,
} from "../scripts/verify-permanent-staging-supabase-profiles-prerequisite.js";

const CANDIDATE = "a".repeat(40);
const OUTPUT = "/private/evidence/supabase-profiles-prerequisite.json";

function environment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    PINTPATH_PROTECTED_ENVIRONMENT: "permanent-staging-provider-mutation",
    PINTPATH_COLD_RECOVERY_CONFIRMATION:
      `PREPARE_PERMANENT_STAGING_COLD_RECOVERY_FOR_${CANDIDATE}_FROM_12c0d24f6619a0286e16b8daf56fc27aaa1e3aba`,
    PINTPATH_SUPABASE_STAGING_READINESS_SERVICE_KEY:
      `sb_secret_${"x".repeat(30)}`,
  };
}

describe("permanent-staging Supabase profiles prerequisite", () => {
  it("canaries one exact publishable/secret pair without retaining key-derived evidence", async () => {
    const publishable = `sb_publishable_${"p".repeat(30)}`;
    const secret = `sb_secret_${"s".repeat(30)}`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        disable_signup: false,
        external: { email: true },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const evidence = await canaryPermanentStagingSupabaseKeyPair({
      fetchImpl,
      publishableKey: publishable,
      secretKey: secret,
    });
    expect(evidence).toMatchObject({
      publishableHttpStatus: 200,
      secretHttpStatus: 200,
      checks: {
        replacementKeyShapesExact: true,
        replacementKeysDistinct: true,
        publishableAuthSettingsExact: true,
        secretProfilesRelationExact: true,
        exactInputPairUsed: true,
      },
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    expect(JSON.stringify(evidence)).not.toContain(publishable);
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it("proves the exact profiles Data API shape without emitting key material", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: "11111111-1111-4111-8111-111111111111",
    }]), { status: 200, headers: { "content-type": "application/json" } }));
    let receipt = "";
    const output: string[] = [];
    const code = await runPermanentStagingSupabaseProfilesPrerequisite({
      argv: ["--candidate-sha", CANDIDATE, "--output", OUTPUT],
      env: environment(),
      fetchImpl,
      writeEvidence: (_filename, source) => { receipt = source; },
      writeOutput: (source) => output.push(source),
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${STAGING_SUPABASE_PROFILES_LOCK.origin}${STAGING_SUPABASE_PROFILES_LOCK.endpoint}`,
      expect.objectContaining({
        method: "GET",
        headers: {
          accept: "application/json",
          apikey: `sb_secret_${"x".repeat(30)}`,
        },
      }),
    );
    expect(receipt).not.toContain(`sb_secret_${"x".repeat(30)}`);
    expect(parsePermanentStagingSupabaseProfilesPrerequisite(
      receipt,
      CANDIDATE,
    )).toEqual({ resultCount: 1 });
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      ok: true,
      productionContactAttempted: false,
      secretMaterialIncluded: false,
    });
  });

  it("fails closed on the live http_404 shape that blocked readiness", async () => {
    const writeEvidence = vi.fn();
    const code = await runPermanentStagingSupabaseProfilesPrerequisite({
      argv: ["--candidate-sha", CANDIDATE, "--output", OUTPUT],
      env: environment(),
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        code: "42P01",
      }), { status: 404, headers: { "content-type": "application/json" } })),
      writeEvidence,
      writeOutput: vi.fn(),
    });
    expect(code).toBe(1);
    expect(writeEvidence).not.toHaveBeenCalled();
  });
});
