import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

interface BrowserApi {
  apiFetch(path: string, options?: RequestInit & { timeoutMs?: number }): Promise<unknown>;
}

function loadBrowserApi(fetchImpl: typeof fetch, token: string | null = null): {
  api: BrowserApi;
  storage: Map<string, string>;
} {
  const source = fs.readFileSync(path.resolve(process.cwd(), "viewer/business.js"), "utf8");
  const storage = new Map<string, string>();
  if (token) storage.set("melbBeerBusinessAuthToken", token);
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
  };
  const windowObject: Record<string, unknown> = {
    MELB_BEER_BOT_VIEWER_CONFIG: {},
    localStorage,
    sessionStorage: localStorage,
    location: {
      origin: "https://pintpath.au",
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
    fetch: fetchImpl,
    AbortController,
    DOMException,
    Response,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    crypto: globalThis.crypto,
  }, { filename: "viewer/business.js" });

  return {
    api: windowObject.MelbBeerBusiness as BrowserApi,
    storage,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("shared browser API deadlines", () => {
  it("aborts a stalled API response with a friendly retryable timeout", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const { api } = loadBrowserApi(fetchMock as typeof fetch);

    await expect(api.apiFetch("/api/business/account", { timeoutMs: 5 })).rejects.toMatchObject({
      name: "PintPathRequestTimeoutError",
      message: "This request took too long. Check your connection and try again.",
      status: 408,
      retryable: true,
      code: "REQUEST_TIMEOUT",
      recovery: "Check your connection, then retry the request.",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("timeoutMs");
  });

  it("bounds legacy-cookie migration before continuing the requested API call", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/api/business/auth/session-cookie") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { loaded: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    const { api, storage } = loadBrowserApi(fetchMock as typeof fetch, "legacy-token");

    const request = api.apiFetch("/api/business/account");
    await vi.advanceTimersByTimeAsync(7_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toEqual({ loaded: true });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/business/auth/session-cookie",
      "/api/business/account",
    ]);
    expect(storage.get("melbBeerBusinessAuthToken")).toBe("legacy-token");
  });
});
