import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBoundedSupabaseFetch } from "../src/lib/supabase-client.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded Supabase fetch", () => {
  it("settles on its deadline even if the underlying fetch ignores abort signals", async () => {
    const underlyingFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const boundedFetch = createBoundedSupabaseFetch({
      timeoutMs: 10,
      fetchImplementation: underlyingFetch,
    });

    await expect(boundedFetch("https://project.supabase.co/storage/v1/bucket"))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(underlyingFetch).toHaveBeenCalledTimes(1);
    expect(underlyingFetch.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
  });

  it("preserves a caller abort reason while composing it with the deadline", async () => {
    let receivedSignal: AbortSignal | null = null;
    const underlyingFetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
      receivedSignal = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    });
    const boundedFetch = createBoundedSupabaseFetch({
      timeoutMs: 30_000,
      fetchImplementation: underlyingFetch,
    });
    const controller = new AbortController();
    const callerReason = new Error("caller cancelled request");
    const request = boundedFetch("https://project.supabase.co/rest/v1/venues", {
      signal: controller.signal,
    });
    const assertion = expect(request).rejects.toBe(callerReason);

    controller.abort(callerReason);

    await assertion;
    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal).toMatchObject({ aborted: true, reason: callerReason });
  });

  it("keeps every server-side Supabase client behind the bounded factory", () => {
    const collect = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const absolutePath = path.join(directory, entry.name);
        return entry.isDirectory() ? collect(absolutePath) : entry.name.endsWith(".ts") ? [absolutePath] : [];
      });
    const helperPath = path.resolve(process.cwd(), "src/lib/supabase-client.ts");
    const directClients = ["src", "scripts"]
      .flatMap((directory) => collect(path.resolve(process.cwd(), directory)))
      .filter((filename) => filename !== helperPath)
      .filter((filename) => /\bcreateClient\s*\(/.test(fs.readFileSync(filename, "utf8")))
      .map((filename) => path.relative(process.cwd(), filename));

    expect(directClients).toEqual([]);
  });
});
