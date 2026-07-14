import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp, getStaticAssetCacheControl, LARGE_JSON_BODY_LIMIT_BYTES } from "../src/app.js";

async function withHttpServer(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function postHeadersOnly(url: string, contentLength: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(contentLength),
        connection: "close",
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("large JSON upload pre-parser containment", () => {
  it("rejects oversized anonymous upload envelopes before parsing or service initialization", async () => {
    const initializeSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const paths = [
      "/api/business/submissions",
      "/api/admin/captures/menu-photo-ocr",
      "/api/admin/ingestions/queue",
    ];

    await withHttpServer(async (baseUrl) => {
      for (const pathname of paths) {
        const response = await postHeadersOnly(`${baseUrl}${pathname}`, LARGE_JSON_BODY_LIMIT_BYTES + 1);
        expect(response.status).toBe(413);
        expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ message: "Request body is too large." }),
        }));
      }
    });

    expect(initializeSpy).not.toHaveBeenCalledWith("Initializing backend services...");
  });

  it("rejects malformed unauthenticated upload JSON before the JSON parser", async () => {
    const initializeSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/business/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: "Authentication required." }),
      }));
    });

    expect(initializeSpy).not.toHaveBeenCalledWith("Initializing backend services...");
  });
});

describe("static response compression", () => {
  it("compresses large public pages without applying compression to API responses", async () => {
    await withHttpServer(async (baseUrl) => {
      const page = await new Promise<{ encoding: string | undefined; body: Buffer }>((resolve, reject) => {
        http.get(`${baseUrl}/`, { headers: { "accept-encoding": "gzip" } }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({
            encoding: response.headers["content-encoding"],
            body: Buffer.concat(chunks),
          }));
        }).on("error", reject);
      });
      expect(page.encoding).toBe("gzip");
      expect(gunzipSync(page.body).toString("utf8")).toContain("Pint Path");

      const health = await fetch(`${baseUrl}/health`, { headers: { "accept-encoding": "gzip" } });
      expect(health.headers.get("content-encoding")).toBeNull();
    });
  });

  it("forces unversioned JavaScript and CSS to revalidate after every deploy", () => {
    expect(getStaticAssetCacheControl("/app/viewer/business.js", "production"))
      .toBe("public, max-age=0, must-revalidate");
    expect(getStaticAssetCacheControl("/app/viewer/business.css", "production"))
      .toBe("public, max-age=0, must-revalidate");
    expect(getStaticAssetCacheControl("/app/viewer/account.html", "production")).toBe("no-store");
    expect(getStaticAssetCacheControl("/app/viewer/assets/logo.png", "production"))
      .toContain("max-age=86400");
  });

  it("prevents every Pint Path page from being embedded in another frame", async () => {
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    });
  });
});
