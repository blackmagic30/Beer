import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

type StatusElement = {
  classList: { add: ReturnType<typeof vi.fn> };
  textContent: string;
};

function statusPageScript(): string {
  const html = fs.readFileSync(path.resolve(process.cwd(), "viewer/status.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const source = scripts.at(-1)?.[1];
  if (!source) throw new Error("Status page script was not found.");
  return source;
}

function statusElement(): StatusElement {
  return {
    classList: { add: vi.fn() },
    textContent: "",
  };
}

function runStatusCheck(fetchImpl: typeof fetch, abortSignal: typeof AbortSignal) {
  const elements = new Map<string, StatusElement>([
    ["serviceStatusTitle", statusElement()],
    ["serviceStatusCopy", statusElement()],
    ["serviceStatusBadge", statusElement()],
  ]);
  let onDomContentLoaded: (() => Promise<void>) | undefined;

  vm.runInNewContext(statusPageScript(), {
    AbortController,
    AbortSignal: abortSignal,
    Date,
    MelbBeerBusiness: { renderNav: () => "navigation" },
    clearTimeout,
    document: {
      getElementById: (id: string) => elements.get(id),
    },
    fetch: fetchImpl,
    nav: { innerHTML: "" },
    setTimeout,
    window: {
      addEventListener: (event: string, listener: () => Promise<void>) => {
        if (event === "DOMContentLoaded") onDomContentLoaded = listener;
      },
    },
  }, { filename: "viewer/status.html" });

  if (!onDomContentLoaded) throw new Error("Status page did not register its load handler.");
  return {
    elements,
    pending: onDomContentLoaded(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("public service status check", () => {
  it("allows a healthy readiness response beyond the previous ten-second deadline", async () => {
    vi.useFakeTimers();
    class LegacyAbortSignal {
      static timeout(timeoutMs: number): AbortSignal {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), timeoutMs);
        return controller.signal;
      }
    }
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/health") return Promise.resolve({ ok: true } as Response);
      return new Promise<Response>((resolve, reject) => {
        const responseTimer = setTimeout(() => resolve({ ok: true } as Response), 10_500);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(responseTimer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    });

    const check = runStatusCheck(fetchMock as typeof fetch, LegacyAbortSignal as typeof AbortSignal);
    await vi.advanceTimersByTimeAsync(10_500);
    await check.pending;

    expect(check.elements.get("serviceStatusTitle")?.textContent).toBe("Pint Path is operational");
    expect(check.elements.get("serviceStatusBadge")?.textContent).toBe("Operational");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not depend on the newer AbortSignal.timeout browser API", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    const check = runStatusCheck(fetchMock as typeof fetch, class UnsupportedAbortSignal {} as typeof AbortSignal);

    await check.pending;

    expect(check.elements.get("serviceStatusTitle")?.textContent).toBe("Pint Path is operational");
    expect(check.elements.get("serviceStatusCopy")?.textContent).toContain("full backend initialization passed");
  });
});
