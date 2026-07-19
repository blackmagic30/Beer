import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertOperatorMutationAllowed,
  isRestoreRehearsalEnvironment,
} from "../scripts/lib/operator-mutation-guard.js";

class BrowserStorage {
  constructor(readonly values = new Map<string, string>()) {}

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

interface RestoreBrowserApi {
  isRestoreRehearsalMode(): boolean;
  prepareRestoreIsolation(): Promise<{ enabled: boolean; indexedDbCleared: boolean }>;
  getAuthToken(): string | null;
  getAccountContext(): unknown;
  hasAuthenticatedSessionHint(): boolean;
  getSupabaseConfig(): { url: string | null; anonKey: string | null };
  getSupabaseOauthProviders(): string[];
  getSupabaseClient(): unknown;
  getAccountScopedStorageKey(baseKey: string, accountId?: string): string | null;
  syncSupabaseSession(): Promise<Record<string, unknown>>;
}

function loadRestoreBrowserApi() {
  const source = fs.readFileSync(path.resolve(process.cwd(), "viewer/business.js"), "utf8");
  const localStorage = new BrowserStorage(new Map([
    ["melbBeerBusinessAuthToken", "restored-token"],
    ["pintPathAccountContext", JSON.stringify({ id: "restored-account" })],
    ["melbBeerAnonSessionId", "restored-anonymous-session"],
    ["pintPathAuthReturnTo", "/account.html"],
    ["pintPathLegalAcceptance", "restored-legal-acceptance"],
    ["pintPathUploadLocationProof", "restored-location-proof"],
    ["pintPathSubmitDraft", "restored-submission-draft"],
    ["pintPathQueuedSubmissions", "restored-submission-queue"],
    ["pintPathLocationPreference", "enabled"],
    ["pintPathCanIDriveProfile", "restored-drive-profile"],
    ["pintPathSupportReceipts", "restored-support-receipt"],
    ["pintPathSubmitDraft:account:restored-account", "restored-account-draft"],
    ["sb-restore-project-auth-token", "restored-supabase-session"],
    ["pintPathCookieConsent", "accepted"],
    ["pintPathOptionalAnalyticsEnabled", "accepted"],
    ["melbBeerMapOverlayState", "collapsed"],
    ["customUiDensity", "compact"],
  ]));
  const sessionStorage = new BrowserStorage(new Map([
    ["pintPathSensitiveAuthReturnTo", "/venue-portal.html"],
    ["pintPathPendingPortalRedemption", "restored-redemption"],
    ["pintPathPasswordRecovery", "restored-recovery"],
    ["pintPathBillingRecoveryOptions", "restored-billing-state"],
    ["sb-restore-project-auth-token-code-verifier", "restored-code-verifier"],
    ["harmlessExpandedPanel", "map-filters"],
  ]));
  const deletedDatabases: string[] = [];
  const indexedDB = {
    deleteDatabase(name: string) {
      deletedDatabases.push(name);
      const request: {
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
      } = {};
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  const windowObject: Record<string, unknown> = {
    MELB_BEER_BOT_VIEWER_CONFIG: {
      supabaseUrl: "https://production.supabase.co",
      supabaseAnonKey: "production-browser-key",
      business: {
        restoreRehearsalMode: true,
        supabaseUrl: "https://restore.supabase.co",
        supabaseAnonKey: "restore-browser-key",
        supabaseOauthProviders: ["google", "apple"],
      },
    },
    localStorage,
    sessionStorage,
    indexedDB,
    location: {
      origin: "https://restore-staging.example",
      pathname: "/account.html",
      search: "",
      hash: "",
    },
    addEventListener: vi.fn(),
  };

  vm.runInNewContext(source, {
    window: windowObject,
    document: {},
    navigator: {},
    fetch: vi.fn(),
    AbortController,
    DOMException,
    Response,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    crypto: globalThis.crypto,
  }, { filename: "viewer/business.js" });

  return {
    api: windowObject.MelbBeerBusiness as RestoreBrowserApi,
    localStorage,
    sessionStorage,
    deletedDatabases,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restore rehearsal operator mutation guard", () => {
  it("recognizes explicit values and fails closed for invalid non-empty configuration", () => {
    expect(isRestoreRehearsalEnvironment(undefined)).toBe(false);
    expect(isRestoreRehearsalEnvironment("false")).toBe(false);
    expect(isRestoreRehearsalEnvironment("OFF")).toBe(false);
    expect(isRestoreRehearsalEnvironment("true")).toBe(true);
    expect(isRestoreRehearsalEnvironment(" yes ")).toBe(true);
    expect(isRestoreRehearsalEnvironment("typo-that-must-not-disable-containment")).toBe(true);
  });

  it("does not let an explicit false flag bypass immutable staging or restore markers", () => {
    expect(isRestoreRehearsalEnvironment("false", {
      RAILWAY_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    })).toBe(true);
    expect(isRestoreRehearsalEnvironment("off", {
      RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    })).toBe(true);
    expect(isRestoreRehearsalEnvironment("0", {
      DATABASE_PATH: "/app/data/restore-pint-path-example/pint-path.sqlite",
    })).toBe(true);
    expect(isRestoreRehearsalEnvironment(undefined, {
      REDIS_KEY_NAMESPACE: "pint-path:restore:environment:backup",
    })).toBe(true);
  });

  it("rejects operator writes before a mutator can run", () => {
    vi.stubEnv("RESTORE_REHEARSAL_MODE", "true");
    expect(() => assertOperatorMutationAllowed("Fixture mutation")).toThrow(
      "Fixture mutation is disabled while RESTORE_REHEARSAL_MODE is enabled.",
    );
  });

  it("keeps every direct operator mutator behind the shared guard", () => {
    const source = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

    expect(source("scripts/import-melbourne-venues.ts")).toMatch(
      /if \(!dryRun\) \{\s*assertOperatorMutationAllowed\("Venue directory import"\)/,
    );
    expect(source("scripts/cleanup-duplicate-venues.ts")).toMatch(
      /if \(apply\) \{\s*assertOperatorMutationAllowed\("Duplicate venue cleanup --apply"\)/,
    );
    expect(source("scripts/publish-source-ingestion-map-base.ts")).toMatch(
      /if \(!options\.dryRun\) \{\s*assertOperatorMutationAllowed\("Menu review publication"\)/,
    );
    expect(source("scripts/queue-menu-crawler-results.ts")).toContain(
      'assertOperatorMutationAllowed("Menu crawler review queue import")',
    );
    expect(source("scripts/seed-pintpath-fake-data.ts")).toContain(
      'assertOperatorMutationAllowed("Synthetic Pint Path data seed")',
    );
    expect(source("scripts/reset-pintpath-test-data.ts")).toContain(
      'assertOperatorMutationAllowed("Synthetic Pint Path data reset")',
    );
    expect(source("scripts/discover-menu-sources.ts")).toContain(
      'assertOperatorMutationAllowed("Menu source discovery and OCR")',
    );
    expect(source("scripts/benchmark-menu-ocr.ts")).toContain(
      'assertOperatorMutationAllowed("Live or persistent menu OCR benchmark")',
    );
    expect(source("scripts/provider-readiness-check.ts")).toContain(
      'assertOperatorMutationAllowed("Provider readiness storage write probe")',
    );
    expect(source("scripts/backup-data-offsite.ts")).toContain(
      'assertOperatorMutationAllowed("Off-site backup upload and retention")',
    );
    expect(source("scripts/production-smoke-check.mjs")).toContain(
      "Production smoke authentication is disabled while RESTORE_REHEARSAL_MODE is enabled.",
    );
  });
});

describe("restore rehearsal browser isolation", () => {
  it("purges and ignores restored identity, recovery, location, and submission state", async () => {
    const { api, localStorage, sessionStorage, deletedDatabases } = loadRestoreBrowserApi();

    await expect(api.prepareRestoreIsolation()).resolves.toEqual({
      enabled: true,
      indexedDbCleared: true,
    });
    expect(api.isRestoreRehearsalMode()).toBe(true);
    expect(deletedDatabases).toEqual(["pintPathSubmissionQueue"]);

    for (const key of [
      "melbBeerBusinessAuthToken",
      "pintPathAccountContext",
      "melbBeerAnonSessionId",
      "pintPathAuthReturnTo",
      "pintPathLegalAcceptance",
      "pintPathUploadLocationProof",
      "pintPathSubmitDraft",
      "pintPathQueuedSubmissions",
      "pintPathLocationPreference",
      "pintPathCanIDriveProfile",
      "pintPathSupportReceipts",
      "pintPathSubmitDraft:account:restored-account",
      "sb-restore-project-auth-token",
    ]) {
      expect(localStorage.getItem(key), key).toBeNull();
    }
    for (const key of [
      "pintPathSensitiveAuthReturnTo",
      "pintPathPendingPortalRedemption",
      "pintPathPasswordRecovery",
      "pintPathBillingRecoveryOptions",
      "sb-restore-project-auth-token-code-verifier",
    ]) {
      expect(sessionStorage.getItem(key), key).toBeNull();
    }

    expect(localStorage.getItem("pintPathCookieConsent")).toBe("accepted");
    expect(localStorage.getItem("pintPathOptionalAnalyticsEnabled")).toBe("accepted");
    expect(localStorage.getItem("melbBeerMapOverlayState")).toBe("collapsed");
    expect(localStorage.getItem("customUiDensity")).toBe("compact");
    expect(sessionStorage.getItem("harmlessExpandedPanel")).toBe("map-filters");

    localStorage.setItem("melbBeerBusinessAuthToken", "reintroduced-token");
    localStorage.setItem("pintPathAccountContext", "reintroduced-account");
    expect(api.getAuthToken()).toBeNull();
    expect(api.getAccountContext()).toBeNull();
    expect(api.hasAuthenticatedSessionHint()).toBe(false);
    expect(api.getSupabaseConfig()).toEqual({ url: null, anonKey: null });
    expect(api.getSupabaseOauthProviders()).toEqual([]);
    expect(api.getSupabaseClient()).toBeNull();
    expect(api.getAccountScopedStorageKey("pintPathSubmitDraft", "restored-account")).toBeNull();
    await expect(api.syncSupabaseSession()).resolves.toEqual({
      configured: false,
      synced: false,
      restoreRehearsal: true,
    });
  });

  it("gates submission rendering and ignores persisted location preference", () => {
    const submit = fs.readFileSync(path.resolve(process.cwd(), "viewer/submit.html"), "utf8");
    const viewer = fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");

    expect(submit).toMatch(
      /await MelbBeerBusiness\.prepareRestoreIsolation\(\);[\s\S]*if \(MelbBeerBusiness\.isRestoreRehearsalMode\(\)\)[\s\S]*Submissions are disabled during the isolated restore rehearsal\.[\s\S]*return;[\s\S]*await purgeExpiredSubmissionDataBeforeAuth\(\)/,
    );
    expect(viewer).toContain("const RESTORE_REHEARSAL_MODE = BUSINESS_CONFIG.restoreRehearsalMode === true;");
    expect(viewer).toMatch(
      /function hasSavedLocationPreference\(\) \{[\s\S]*if \(RESTORE_REHEARSAL_MODE\) \{[\s\S]*removeItem\(LOCATION_PREFERENCE_STORAGE_KEY\);[\s\S]*return false;/,
    );
    expect(viewer).toMatch(
      /function setSavedLocationPreference\(enabled\) \{[\s\S]*if \(RESTORE_REHEARSAL_MODE\) \{[\s\S]*removeItem\(LOCATION_PREFERENCE_STORAGE_KEY\);[\s\S]*return;/,
    );
  });
});
