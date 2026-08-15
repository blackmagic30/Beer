import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import express from "express";
import { describe, expect, it } from "vitest";

import { createPublicVenuePageHandler } from "../src/app.js";
import { errorHandler } from "../src/middleware/error-handler.js";

async function withHttpServer(
  app: ReturnType<typeof express>,
  callback: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(app);
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

describe("public HTML error recovery", () => {
  it("returns the branded recovery page for a deleted venue share link", async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.locals.cspNonce = "public-html-error-test";
      next();
    });
    app.get(
      "/venues/:venueId",
      createPublicVenuePageHandler(async () => ({
        getPublicVenueById: async () => null,
      })),
    );
    app.use(errorHandler);

    const originalCwd = process.cwd();
    const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-public-html-404-"));
    try {
      process.chdir(isolatedCwd);
      await withHttpServer(app, async (baseUrl) => {
        const jsonResponse = await fetch(`${baseUrl}/venues/deleted-venue`, {
          headers: { accept: "application/json" },
        });
        expect(jsonResponse.status).toBe(404);
        expect(jsonResponse.headers.get("content-type")).toContain("application/json");
        expect(jsonResponse.headers.get("cache-control")).toBe("no-store");
        expect(jsonResponse.headers.get("vary")).toContain("Accept");
        await expect(jsonResponse.json()).resolves.toEqual(expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ message: "Venue not found." }),
        }));

        const response = await fetch(`${baseUrl}/venues/deleted-venue`, {
          headers: { accept: "text/html" },
        });
        const body = await response.text();

        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("vary")).toContain("Accept");
        expect(body).toContain("This Pint Path page is not here.");
        expect(body).toContain("Open the beer map");
        expect(body).toContain("Contact support");
        expect(body).not.toContain('"ok":false');

        const headResponse = await fetch(`${baseUrl}/venues/deleted-venue`, {
          method: "HEAD",
          headers: { accept: "text/html" },
        });
        expect(headResponse.status).toBe(404);
        expect(headResponse.headers.get("content-type")).toContain("text/html");
        expect(headResponse.headers.get("cache-control")).toBe("no-store");
        expect(headResponse.headers.get("vary")).toContain("Accept");
        expect(await headResponse.text()).toBe("");
      });
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });
});
