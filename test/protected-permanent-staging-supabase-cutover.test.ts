import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PROTECTED_SUPABASE_CUTOVER_SCHEMA,
  protectedPermanentStagingSupabaseCutoverInternals,
  runProtectedPermanentStagingSupabaseCutover,
} from "../scripts/execute-protected-permanent-staging-supabase-cutover.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const candidateSha = "a".repeat(40);
const readToken = "supabase-secrets-read-token";
const writeToken = "supabase-secrets-write-token";
const publishableKey = `sb_publishable_${"p".repeat(32)}`;
const secretKey = `sb_secret_${"s".repeat(32)}`;
const disableOperation = "disable-enabled-legacy-keys";
const reconcileOperation = "reconcile-already-disabled-legacy-keys";

function legacyJwt(role: "anon" | "service_role"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "supabase", role, iat: 1 })).toString("base64url");
  return `${header}.${payload}.${"x".repeat(43)}`;
}

const oldAnon = legacyJwt("anon");
const oldServiceRole = legacyJwt("service_role");
const filenames = {
  read: "/private/read-token",
  write: "/private/write-token",
  publishable: "/private/new-publishable",
  secret: "/private/new-secret",
  anon: "/private/old-anon",
  serviceRole: "/private/old-service-role",
  evidence: "/private/evidence",
};

function argv(operation = disableOperation): string[] {
  const values = [
    "--candidate-sha", candidateSha,
    "--operation", operation,
    "--management-read-token-file", filenames.read,
    "--new-publishable-key-file", filenames.publishable,
    "--new-secret-key-file", filenames.secret,
    "--old-anon-key-file", filenames.anon,
    "--old-service-role-key-file", filenames.serviceRole,
    "--evidence-dir", filenames.evidence,
  ];
  if (operation === disableOperation) {
    values.push("--management-write-token-file", filenames.write);
  }
  return values;
}

function environment(
  overrides: Record<string, string> = {},
  operation = disableOperation,
): Record<string, string> {
  return {
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: candidateSha,
    GITHUB_RUN_ATTEMPT: "1",
    PINTPATH_SUPABASE_CUTOVER_OPERATION: operation,
    PINTPATH_SUPABASE_CUTOVER_CONFIRMATION:
      operation === reconcileOperation
        ? "RECONCILE_PERMANENT_STAGING_SUPABASE_LEGACY_KEYS"
        : "DISABLE_PERMANENT_STAGING_SUPABASE_LEGACY_KEYS",
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type LegacyKeyFamily = "anon" | "service_role";

interface ProviderOptions {
  ambiguousWrite?: boolean;
  initiallyDisabled?: boolean;
  reEnableOnSecondManagementRead?: boolean;
  alreadyRejected?: LegacyKeyFamily;
  invalidPostDisableRejection?: {
    family: LegacyKeyFamily;
    status: number;
    value: unknown;
  };
}

function provider(options: ProviderOptions = {}): {
  fetchImpl: typeof fetch;
  putCount: () => number;
  oldProbeCount: (family: LegacyKeyFamily) => number;
} {
  let enabled = options.initiallyDisabled !== true;
  let puts = 0;
  let managementReads = 0;
  const oldProbes: Record<LegacyKeyFamily, number> = { anon: 0, service_role: 0 };
  const rejection = (family: LegacyKeyFamily): Response => {
    const invalid = options.invalidPostDisableRejection;
    return invalid?.family === family
      ? json(invalid.value, invalid.status)
      : json({ message: "Invalid API key" }, 401);
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    if (url.startsWith("https://api.supabase.com/")) {
      if (init?.method === "PUT") {
        puts += 1;
        expect(headers?.authorization).toBe(`Bearer ${writeToken}`);
        enabled = false;
        if (options.ambiguousWrite) throw new Error("transport lost after apply");
        return json({ enabled: false });
      }
      expect(headers?.authorization).toBe(`Bearer ${readToken}`);
      managementReads += 1;
      if (options.reEnableOnSecondManagementRead && managementReads === 2) {
        enabled = true;
      }
      return json({ enabled });
    }
    const apiKey = headers?.apikey;
    if (url.endsWith("/auth/v1/settings")) {
      if (apiKey === oldAnon) {
        oldProbes.anon += 1;
        expect(headers).toEqual({ apikey: oldAnon });
        if (!enabled || options.alreadyRejected === "anon") return rejection("anon");
        return json({ disable_signup: false, external: { google: true } });
      }
      expect(apiKey).toBe(publishableKey);
      expect(headers).toEqual({ apikey: publishableKey });
      return json({ disable_signup: false, external: { google: true } });
    }
    if (url.includes("/auth/v1/admin/users")) {
      if (apiKey === oldServiceRole) {
        oldProbes.service_role += 1;
        expect(headers).toEqual({
          apikey: oldServiceRole,
          authorization: `Bearer ${oldServiceRole}`,
        });
        if (!enabled || options.alreadyRejected === "service_role") {
          return rejection("service_role");
        }
        return json({ users: [] });
      }
      expect(apiKey).toBe(secretKey);
      expect(headers).toEqual({ apikey: secretKey });
      return json({ users: [] });
    }
    if (url.includes("/storage/v1/bucket/")) {
      expect(apiKey).toBe(secretKey);
      return json({
        id: "beermap-source-evidence",
        name: "beermap-source-evidence",
        public: false,
        allowed_mime_types: ["image/jpeg", "image/png", "image/webp",
          "image/heic", "image/heif", "application/pdf"],
      });
    }
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;
  return {
    fetchImpl,
    putCount: () => puts,
    oldProbeCount: (family) => oldProbes[family],
  };
}

function readSecret(filename: string): Buffer {
  const values = new Map([
    [filenames.read, readToken],
    [filenames.write, writeToken],
    [filenames.publishable, publishableKey],
    [filenames.secret, secretKey],
    [filenames.anon, oldAnon],
    [filenames.serviceRole, oldServiceRole],
  ]);
  const value = values.get(filename);
  if (!value) throw new Error("unknown test input");
  return Buffer.from(value);
}

function durable(evidence: Map<string, string>) {
  return (_directory: string, leaf: string, source: string): string => {
    expect(evidence.has(leaf)).toBe(false);
    evidence.set(leaf, source);
    return crypto.createHash("sha256").update(source).digest("hex");
  };
}

describe("protected permanent-staging Supabase cutover", () => {
  it("canaries replacement keys, writes once, reconciles disabled state, and proves both old keys denied", async () => {
    const output: string[] = [];
    const evidence = new Map<string, string>();
    const live = provider();
    const exitCode = await runProtectedPermanentStagingSupabaseCutover({
      argv: argv(), env: environment(), cwd: projectRoot, fetchImpl: live.fetchImpl,
      readSecret, writeDurable: durable(evidence), writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(live.putCount()).toBe(1);
    expect(live.oldProbeCount("anon")).toBe(2);
    expect(live.oldProbeCount("service_role")).toBe(2);
    expect(output).toHaveLength(1);
    const receipt = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(receipt.schemaVersion).toBe(PROTECTED_SUPABASE_CUTOVER_SCHEMA);
    expect(receipt.outcome).toBe("disabled");
    expect(receipt.attempts).toBe(1);
    expect(receipt.retryAllowed).toBe(false);
    expect(receipt.checks).toEqual(expect.objectContaining({
      operationExact: true,
      managementWriteCredentialAbsentExact: false,
      managementWriteCredentialSeparateExact: true,
      canaryBBeforeExact: true,
      legacyPreflightEnabledExact: true,
      oldAnonAcceptedBeforeExact: true,
      oldServiceRoleAcceptedBeforeExact: true,
      managementWriteSkippedExact: false,
      disableAcknowledgementExact: true,
      postflightAttempted: true,
      legacyPostflightDisabledExact: true,
      canaryBAfterExact: true,
      oldAnonDeniedExact: true,
      oldServiceRoleDeniedExact: true,
      inputZeroized: true,
      terminalEvidenceExact: true,
    }));
    expect([...evidence.keys()]).toEqual(["intent.json", "terminal.json"]);
    expect(JSON.parse(evidence.get("intent.json")!)).toEqual(expect.objectContaining({
      oldAnonAcceptedBeforeDisable: true,
      oldServiceRoleAcceptedBeforeDisable: true,
    }));
    const allDurable = `${output.join("")}\n${[...evidence.values()].join("\n")}`;
    for (const secret of [readToken, writeToken, publishableKey, secretKey,
      oldAnon, oldServiceRole]) expect(allDurable).not.toContain(secret);
  });

  it("reconciles an already-disabled project without a management write", async () => {
    const output: string[] = [];
    const evidence = new Map<string, string>();
    const live = provider({ initiallyDisabled: true });
    const read = vi.fn(readSecret);
    const exitCode = await runProtectedPermanentStagingSupabaseCutover({
      argv: argv(reconcileOperation), env: environment({}, reconcileOperation),
      cwd: projectRoot, fetchImpl: live.fetchImpl, readSecret: read,
      writeDurable: durable(evidence), writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(0);
    expect(live.putCount()).toBe(0);
    expect(read).not.toHaveBeenCalledWith(filenames.write);
    expect(live.oldProbeCount("anon")).toBe(2);
    expect(live.oldProbeCount("service_role")).toBe(2);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      schemaVersion: PROTECTED_SUPABASE_CUTOVER_SCHEMA,
      outcome: "already_disabled",
      attempts: 0,
      retryAllowed: false,
      checks: {
        canaryBBeforeExact: true,
        legacyPreflightEnabledExact: false,
        legacyPreflightDisabledExact: true,
        oldAnonAcceptedBeforeExact: false,
        oldServiceRoleAcceptedBeforeExact: false,
        oldAnonDeniedBeforeExact: true,
        oldServiceRoleDeniedBeforeExact: true,
        managementWriteCredentialAbsentExact: true,
        managementWriteCredentialSeparateExact: false,
        managementWriteSkippedExact: true,
        disableAcknowledgementExact: false,
        postflightAttempted: true,
        legacyPostflightDisabledExact: true,
        canaryBAfterExact: true,
        oldAnonDeniedExact: true,
        oldServiceRoleDeniedExact: true,
        terminalEvidenceExact: true,
      },
    });
    expect([...evidence.keys()]).toEqual(["intent.json", "terminal.json"]);
    expect(JSON.parse(evidence.get("intent.json")!)).toMatchObject({
      schemaVersion: "pintpath-protected-permanent-staging-supabase-cutover-intent/v2",
      requestedOperation: reconcileOperation,
      operation: "reconcile-already-disabled-legacy-jwt-api-keys",
      maximumAttempts: 0,
      legacyPreflightEnabled: false,
      legacyPreflightDisabled: true,
      oldAnonDeniedBeforeReconciliation: true,
      oldServiceRoleDeniedBeforeReconciliation: true,
    });
    const allDurable = `${output.join("")}\n${[...evidence.values()].join("\n")}`;
    for (const secret of [readToken, writeToken, publishableKey, secretKey,
      oldAnon, oldServiceRole]) expect(allDurable).not.toContain(secret);
  });

  it("fails closed without a write when the already-disabled state changes during reconciliation", async () => {
    const output: string[] = [];
    const live = provider({
      initiallyDisabled: true,
      reEnableOnSecondManagementRead: true,
    });
    const exitCode = await runProtectedPermanentStagingSupabaseCutover({
      argv: argv(reconcileOperation), env: environment({}, reconcileOperation),
      cwd: projectRoot, fetchImpl: live.fetchImpl,
      readSecret, writeDurable: durable(new Map()), writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(live.putCount()).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      checks: {
        legacyPreflightDisabledExact: true,
        managementWriteSkippedExact: true,
        postflightAttempted: true,
        legacyPostflightDisabledExact: false,
      },
    });
  });

  it("rejects explicit operation and provider-state mismatches before intent or write", async () => {
    for (const fixture of [
      {
        operation: disableOperation,
        live: provider({ initiallyDisabled: true }),
      },
      {
        operation: reconcileOperation,
        live: provider(),
      },
    ]) {
      const output: string[] = [];
      const evidence = new Map<string, string>();
      const read = vi.fn(readSecret);
      const exitCode = await runProtectedPermanentStagingSupabaseCutover({
        argv: argv(fixture.operation),
        env: environment({}, fixture.operation),
        cwd: projectRoot,
        fetchImpl: fixture.live.fetchImpl,
        readSecret: read,
        writeDurable: durable(evidence),
        writeOutput: (value) => output.push(value),
      });

      expect(exitCode).toBe(1);
      expect(fixture.live.putCount()).toBe(0);
      expect(evidence.size).toBe(0);
      expect(JSON.parse(output[0]!)).toMatchObject({
        outcome: "failed_before_attempt",
        attempts: 0,
        intentSha256: null,
      });
      if (fixture.operation === reconcileOperation) {
        expect(read).not.toHaveBeenCalledWith(filenames.write);
      }
    }
  });

  it("requires operation-specific write-token argument custody", () => {
    const { parseArguments } = protectedPermanentStagingSupabaseCutoverInternals;
    expect(parseArguments(argv(disableOperation))).not.toBeNull();
    expect(parseArguments(argv(reconcileOperation))).not.toBeNull();

    const disableWithoutWrite = argv(disableOperation);
    const writeIndex = disableWithoutWrite.indexOf("--management-write-token-file");
    disableWithoutWrite.splice(writeIndex, 2);
    expect(parseArguments(disableWithoutWrite)).toBeNull();
    expect(parseArguments([
      ...argv(reconcileOperation),
      "--management-write-token-file",
      filenames.write,
    ])).toBeNull();
  });

  it("does not retry an applied write whose acknowledgement is lost", async () => {
    const output: string[] = [];
    const live = provider({ ambiguousWrite: true });
    const exitCode = await runProtectedPermanentStagingSupabaseCutover({
      argv: argv(), env: environment(), cwd: projectRoot, fetchImpl: live.fetchImpl,
      readSecret, writeDurable: durable(new Map()), writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(1);
    expect(live.putCount()).toBe(1);
    const receipt = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks).toEqual(expect.objectContaining({
      disableAcknowledgementExact: false,
      legacyPostflightDisabledExact: true,
      oldAnonDeniedExact: true,
      oldServiceRoleDeniedExact: true,
    }));
  });

  it.each(["anon", "service_role"] as const)(
    "rejects an already-rejected %s input while management still reports enabled",
    async (family) => {
      const output: string[] = [];
      const evidence = new Map<string, string>();
      const live = provider({ alreadyRejected: family });
      const exitCode = await runProtectedPermanentStagingSupabaseCutover({
        argv: argv(), env: environment(), cwd: projectRoot, fetchImpl: live.fetchImpl,
        readSecret, writeDurable: durable(evidence), writeOutput: (value) => output.push(value),
      });

      expect(exitCode).toBe(1);
      expect(live.putCount()).toBe(0);
      expect(evidence.size).toBe(0);
      const receipt = JSON.parse(output[0]!) as {
        outcome: string;
        attempts: number;
        intentSha256: string | null;
        checks: Record<string, boolean>;
      };
      expect(receipt).toMatchObject({
        outcome: "failed_before_attempt",
        attempts: 0,
        intentSha256: null,
      });
      expect(receipt.checks.oldAnonAcceptedBeforeExact).toBe(family !== "anon");
      expect(receipt.checks.oldServiceRoleAcceptedBeforeExact)
        .toBe(family !== "service_role");
    },
  );

  it("treats a non-exact post-disable 401 body as mutation-uncertain", async () => {
    const output: string[] = [];
    const live = provider({
      invalidPostDisableRejection: {
        family: "service_role",
        status: 401,
        value: { message: "Invalid API key", code: 401 },
      },
    });
    const exitCode = await runProtectedPermanentStagingSupabaseCutover({
      argv: argv(), env: environment(), cwd: projectRoot, fetchImpl: live.fetchImpl,
      readSecret, writeDurable: durable(new Map()), writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(live.putCount()).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      checks: {
        oldAnonDeniedExact: true,
        oldServiceRoleDeniedExact: false,
      },
    });
  });

  it("accepts only the exact legacy-key gateway rejection shape", () => {
    const { rejectionExact } = protectedPermanentStagingSupabaseCutoverInternals;
    expect(rejectionExact({
      status: 401,
      value: { message: "Invalid API key" },
    })).toBe(true);
    expect(rejectionExact({
      status: 401,
      value: { message: "Invalid API key", code: 401 },
    })).toBe(false);
    expect(rejectionExact({
      status: 401,
      value: { error: "Invalid API key" },
    })).toBe(false);
    expect(rejectionExact({
      status: 403,
      value: { message: "Invalid API key" },
    })).toBe(false);
  });

  it("blocks reruns before secret custody or provider access", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const read = vi.fn() as unknown as typeof readSecret;
    const output: string[] = [];
    const exitCode = await runProtectedPermanentStagingSupabaseCutover({
      argv: argv(), env: environment({ GITHUB_RUN_ATTEMPT: "2" }), cwd: projectRoot,
      fetchImpl, readSecret: read, writeDurable: durable(new Map()),
      writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).attempts).toBe(0);
  });

  it("keeps the workflow manual, protected, explicit-mode, one-shot, and secret-file based", () => {
    const workflow = fs.readFileSync(path.join(projectRoot,
      ".github/workflows/permanent-staging-supabase-legacy-cutover.yml"), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: permanent-staging-supabase-legacy-disable");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("replacement_run_id:");
    expect(workflow).toContain("fenced_deployment_run_id:");
    expect(workflow).toContain("deployment_run_id:");
    expect(workflow).toContain("operation:");
    expect(workflow).toContain(
      "run-name: Permanent staging Supabase legacy cutover | ${{ inputs.operation }} | ${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain("- reconcile-already-disabled-legacy-keys");
    expect(workflow).toContain("- disable-enabled-legacy-keys");
    expect(workflow).toContain(
      "RECONCILE_PERMANENT_STAGING_SUPABASE_LEGACY_KEYS",
    );
    expect(workflow).toContain("test \"$RUN_ATTEMPT\" = 1");
    expect(workflow).toContain(
      "scripts/verify-github-permanent-staging-deployment.mjs",
    );
    expect(workflow).toContain("--replacement-run-id \"$REPLACEMENT_RUN_ID\"");
    expect(workflow).toContain(
      "--fenced-deployment-run-id \"$FENCED_DEPLOYMENT_RUN_ID\"",
    );
    expect(workflow).toContain("--deployment-run-id \"$DEPLOYMENT_RUN_ID\"");
    expect(workflow).toContain("--fenced-deployment-receipt");
    expect(workflow).toContain("--deployment-receipt");
    expect(workflow).toContain(
      "pintpath-permanent-staging-fenced-deployment-${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain(
      "pintpath-permanent-staging-deployment-${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain(
      'schemaVersion:"pintpath-protected-supabase-cutover-dispatch/v3"',
    );
    expect(workflow).toContain("--cutover-mode \"$OPERATION\"");
    expect(workflow).toContain("--operation \"$OPERATION\"");
    expect(workflow).toContain("--management-write-token-file");
    expect(workflow).toContain(
      "if: inputs.operation == 'disable-enabled-legacy-keys'",
    );
    expect(workflow).toContain(
      "test ! -e \"$RUNNER_TEMP/pintpath-supabase-cutover-input/management-write-token\"",
    );
    expect(workflow).toContain("if: always()\n        shell: bash\n        run: |");
    expect(workflow).toContain("shred -u");
    expect(workflow).not.toContain("npm install --global");
    expect(workflow).not.toMatch(/continue-on-error|retry/i);

    const authorityIndex = workflow.indexOf(
      "scripts/verify-github-permanent-staging-deployment.mjs",
    );
    const secretCustodyIndex = workflow.indexOf(
      "PINTPATH_SUPABASE_STAGING_SECRETS_READ_TOKEN",
    );
    const writeCustodyIndex = workflow.indexOf(
      "Add separate write-token custody only for enabled-state disablement",
    );
    const writeSecretIndex = workflow.indexOf(
      "PINTPATH_SUPABASE_STAGING_SECRETS_WRITE_TOKEN",
    );
    expect(authorityIndex).toBeGreaterThan(0);
    expect(secretCustodyIndex).toBeGreaterThan(authorityIndex);
    expect(writeCustodyIndex).toBeGreaterThan(secretCustodyIndex);
    expect(writeSecretIndex).toBeGreaterThan(writeCustodyIndex);
    expect(workflow.slice(secretCustodyIndex, writeCustodyIndex)).not.toContain(
      "PINTPATH_SUPABASE_STAGING_SECRETS_WRITE_TOKEN",
    );
  });
});
