import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PROTECTED_SUPABASE_CUTOVER_SCHEMA,
  runProtectedPermanentStagingSupabaseCutover,
} from "../scripts/execute-protected-permanent-staging-supabase-cutover.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const candidateSha = "a".repeat(40);
const readToken = "supabase-secrets-read-token";
const writeToken = "supabase-secrets-write-token";
const publishableKey = `sb_publishable_${"p".repeat(32)}`;
const secretKey = `sb_secret_${"s".repeat(32)}`;

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

function argv(): string[] {
  return [
    "--candidate-sha", candidateSha,
    "--management-read-token-file", filenames.read,
    "--management-write-token-file", filenames.write,
    "--new-publishable-key-file", filenames.publishable,
    "--new-secret-key-file", filenames.secret,
    "--old-anon-key-file", filenames.anon,
    "--old-service-role-key-file", filenames.serviceRole,
    "--evidence-dir", filenames.evidence,
  ];
}

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: candidateSha,
    GITHUB_RUN_ATTEMPT: "1",
    PINTPATH_SUPABASE_CUTOVER_CONFIRMATION:
      "DISABLE_PERMANENT_STAGING_SUPABASE_LEGACY_KEYS",
    ...overrides,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function provider(options: { ambiguousWrite?: boolean } = {}): {
  fetchImpl: typeof fetch;
  putCount: () => number;
} {
  let enabled = true;
  let puts = 0;
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
      return json({ enabled });
    }
    const apiKey = headers?.apikey;
    if (!enabled && (apiKey === oldAnon || apiKey === oldServiceRole)) {
      return json({ message: "Invalid API key" }, 401);
    }
    if (url.endsWith("/auth/v1/settings")) {
      expect(apiKey).toBe(publishableKey);
      return json({ disable_signup: false, external: { google: true } });
    }
    if (url.includes("/auth/v1/admin/users")) {
      expect(apiKey).toBe(secretKey);
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
  return { fetchImpl, putCount: () => puts };
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
    expect(output).toHaveLength(1);
    const receipt = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(receipt.schemaVersion).toBe(PROTECTED_SUPABASE_CUTOVER_SCHEMA);
    expect(receipt.outcome).toBe("disabled");
    expect(receipt.attempts).toBe(1);
    expect(receipt.retryAllowed).toBe(false);
    expect(receipt.checks).toEqual(expect.objectContaining({
      canaryBBeforeExact: true,
      legacyPreflightEnabledExact: true,
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
    const allDurable = `${output.join("")}\n${[...evidence.values()].join("\n")}`;
    for (const secret of [readToken, writeToken, publishableKey, secretKey,
      oldAnon, oldServiceRole]) expect(allDurable).not.toContain(secret);
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

  it("keeps the workflow manual, protected, one-shot, and secret-file based", () => {
    const workflow = fs.readFileSync(path.join(projectRoot,
      ".github/workflows/permanent-staging-supabase-legacy-cutover.yml"), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: permanent-staging-supabase-legacy-disable");
    expect(workflow).toContain("test \"$RUN_ATTEMPT\" = 1");
    expect(workflow).toContain("--management-write-token-file");
    expect(workflow).toContain("if: always()\n        shell: bash\n        run: |");
    expect(workflow).toContain("shred -u");
    expect(workflow).not.toContain("npm install --global");
    expect(workflow).not.toMatch(/continue-on-error|retry/i);
  });
});
