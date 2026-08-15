import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { extractProductionAppSessionCookie } from "../scripts/extract-production-app-session-cookie.mjs";
import {
  extractExactAppSessionCookie,
  readSetCookieHeaders,
} from "../scripts/lib/app-session-cookie.mjs";

const genericToken = "g".repeat(43);
const genericCookie =
  `pint_path_session=${genericToken}; Path=/; Expires=Sat, 15 Aug 2026 06:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;

function privateTempDirectory(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe("operational app-session cookie extraction", () => {
  it("extracts one exact host-only generic cookie without exposing other response state", () => {
    expect(
      extractExactAppSessionCookie([genericCookie], "https://pintpath.au/api/business/auth/supabase-session"),
    ).toEqual({
      token: genericToken,
      cookieHeader: `pint_path_session=${genericToken}`,
    });
  });

  it("accepts an exact purpose credential only when the caller explicitly allows it", () => {
    const purposeToken = `credential-v1.account_export.1786759200.${"p".repeat(43)}`;
    const cookie = `pint_path_session=${purposeToken}; Path=/; HttpOnly; Secure; SameSite=Lax`;
    expect(() =>
      extractExactAppSessionCookie([cookie], "https://pintpath.au"),
    ).toThrow("one exact host-only app session cookie");
    expect(
      extractExactAppSessionCookie([cookie], "https://pintpath.au", {
        allowPurposeCredential: true,
      }).cookieHeader,
    ).toBe(`pint_path_session=${purposeToken}`);
  });

  it.each(["1", "99999999999"])(
    "accepts the server credential timestamp boundary %s",
    (timestamp) => {
      const token = `credential-v1.logout_all.${timestamp}.${"p".repeat(43)}`;
      expect(
        extractExactAppSessionCookie(
          [`pint_path_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`],
          "https://pintpath.au",
          { allowPurposeCredential: true },
        ).token,
      ).toBe(token);
    },
  );

  it.each(["0", "01", "100000000000"])(
    "rejects the malformed server credential timestamp %s",
    (timestamp) => {
      const token = `credential-v1.logout_all.${timestamp}.${"p".repeat(43)}`;
      expect(() =>
        extractExactAppSessionCookie(
          [`pint_path_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`],
          "https://pintpath.au",
          { allowPurposeCredential: true },
        ),
      ).toThrow("one exact host-only app session cookie");
    },
  );

  it.each([
    { headers: [] as string[] },
    { headers: [genericCookie, genericCookie] },
    { headers: [`pint_path_session=${genericToken}; Path=/; HttpOnly; SameSite=Lax`] },
    { headers: [`pint_path_session=${genericToken}; Domain=pintpath.au; Path=/; HttpOnly; Secure; SameSite=Lax`] },
    { headers: [`pint_path_session=${genericToken}; Path=/api; HttpOnly; Secure; SameSite=Lax`] },
    { headers: [`pint_path_session=${genericToken}; Path=/; HttpOnly; Secure; SameSite=None`] },
    { headers: [`pint_path_session=${genericToken}; Path=/; HttpOnly; HttpOnly; Secure; SameSite=Lax`] },
    { headers: [`pint_path_session=${"x".repeat(42)}; Path=/; HttpOnly; Secure; SameSite=Lax`] },
    { headers: [`pint_path_session=${genericToken}; Path=/; HttpOnly; Secure; SameSite=Lax, attacker=1`] },
    { headers: [`pint_path_session=${genericToken}; Path=/; HttpOnly; Secure=true; SameSite=Lax`] },
  ])("rejects malformed, duplicate, scoped, or insecure HTTPS cookies", ({ headers }) => {
    expect(() =>
      extractExactAppSessionCookie(headers, "https://pintpath.au/api/business/auth/supabase-session"),
    ).toThrow("one exact host-only app session cookie");
  });

  it("uses getSetCookie so Expires commas never split or merge cookie fields", () => {
    const getSetCookie = () => [genericCookie];
    expect(readSetCookieHeaders({ get: () => "folded", getSetCookie })).toEqual([
      genericCookie,
    ]);
  });

  it("writes one validated production cookie value to a new mode-private file", () => {
    const directory = privateTempDirectory("pintpath-cookie-extract-");
    const headers = path.join(directory, "response.headers");
    const output = path.join(directory, "app.cookie");
    try {
      fs.writeFileSync(headers, `HTTP/2 200\r\nSet-Cookie: ${genericCookie}\r\n\r\n`, {
        mode: 0o600,
      });
      const result = spawnSync(
        process.execPath,
        [path.resolve("scripts/extract-production-app-session-cookie.mjs"), headers, output],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(fs.readFileSync(output, "utf8")).toBe(`${genericToken}\n`);
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not create output for a domain-scoped production cookie", () => {
    const directory = privateTempDirectory("pintpath-cookie-reject-");
    const headers = path.join(directory, "response.headers");
    const output = path.join(directory, "app.cookie");
    try {
      fs.writeFileSync(
        headers,
        `Set-Cookie: pint_path_session=${genericToken}; Domain=pintpath.au; Path=/; HttpOnly; Secure; SameSite=Lax\r\n`,
        { mode: 0o600 },
      );
      const result = spawnSync(
        process.execPath,
        [path.resolve("scripts/extract-production-app-session-cookie.mjs"), headers, output],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Production app-session cookie extraction failed\n");
      expect(result.stderr).not.toContain(genericToken);
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an input symlink before reading any cookie credential", () => {
    const directory = privateTempDirectory("pintpath-cookie-symlink-");
    const target = path.join(directory, "target.headers");
    const headers = path.join(directory, "response.headers");
    const output = path.join(directory, "app.cookie");
    try {
      fs.writeFileSync(target, `Set-Cookie: ${genericCookie}\r\n`, { mode: 0o600 });
      fs.symlinkSync(target, headers);
      expect(() =>
        extractProductionAppSessionCookie([headers, output]),
      ).toThrow("Production app-session cookie extraction failed");
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a path replacement after open and closes the held input descriptor", () => {
    const directory = privateTempDirectory("pintpath-cookie-race-");
    const headers = path.join(directory, "response.headers");
    const displaced = path.join(directory, "held.headers");
    const output = path.join(directory, "app.cookie");
    fs.writeFileSync(headers, `Set-Cookie: ${genericCookie}\r\n`, { mode: 0o600 });
    const originalOpenSync = fs.openSync.bind(fs);
    const originalReadSync = fs.readSync.bind(fs);
    let heldDescriptor: number | null = null;
    let replaced = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filename, flags, mode) => {
      const descriptor = originalOpenSync(filename, flags, mode);
      if (filename === headers) heldDescriptor = descriptor;
      return descriptor;
    }) as typeof fs.openSync);
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (args[0] === heldDescriptor && !replaced) {
        replaced = true;
        fs.renameSync(headers, displaced);
        fs.writeFileSync(headers, `Set-Cookie: ${genericCookie}\r\n`, { mode: 0o600 });
      }
      return Reflect.apply(originalReadSync, fs, args);
    }) as typeof fs.readSync);
    try {
      expect(() =>
        extractProductionAppSessionCookie([headers, output]),
      ).toThrow("Production app-session cookie extraction failed");
      expect(fs.existsSync(output)).toBe(false);
      expect(heldDescriptor).not.toBeNull();
      expect(() => fs.fstatSync(heldDescriptor!)).toThrow();
    } finally {
      readSpy.mockRestore();
      openSpy.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens output exclusively without following an existing symlink", () => {
    const directory = privateTempDirectory("pintpath-cookie-output-");
    const headers = path.join(directory, "response.headers");
    const target = path.join(directory, "existing.secret");
    const output = path.join(directory, "app.cookie");
    try {
      fs.writeFileSync(headers, `Set-Cookie: ${genericCookie}\r\n`, { mode: 0o600 });
      fs.writeFileSync(target, "do-not-overwrite\n", { mode: 0o600 });
      fs.symlinkSync(target, output);
      expect(() =>
        extractProductionAppSessionCookie([headers, output]),
      ).toThrow("Production app-session cookie extraction failed");
      expect(fs.readFileSync(target, "utf8")).toBe("do-not-overwrite\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes both descriptor-bound files after successful extraction", () => {
    const directory = privateTempDirectory("pintpath-cookie-close-");
    const headers = path.join(directory, "response.headers");
    const output = path.join(directory, "app.cookie");
    fs.writeFileSync(headers, `Set-Cookie: ${genericCookie}\r\n`, { mode: 0o600 });
    const originalOpenSync = fs.openSync.bind(fs);
    const originalLstatSync = fs.lstatSync.bind(fs);
    const descriptors: number[] = [];
    const events: string[] = [];
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filename, flags, mode) => {
      events.push(`open:${String(filename)}`);
      const descriptor = originalOpenSync(filename, flags, mode);
      if (filename === headers || filename === output) descriptors.push(descriptor);
      return descriptor;
    }) as typeof fs.openSync);
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((filename, options) => {
      events.push(`lstat:${String(filename)}`);
      return originalLstatSync(filename, options as never);
    }) as typeof fs.lstatSync);
    const readFileSpy = vi.spyOn(fs, "readFileSync");
    try {
      extractProductionAppSessionCookie([headers, output]);
      expect(readFileSpy).not.toHaveBeenCalled();
      expect(descriptors).toHaveLength(2);
      expect(events.indexOf(`open:${headers}`)).toBeLessThan(
        events.indexOf(`lstat:${headers}`),
      );
      expect(events.indexOf(`open:${output}`)).toBeLessThan(
        events.indexOf(`lstat:${output}`),
      );
      for (const descriptor of descriptors) {
        expect(() => fs.fstatSync(descriptor)).toThrow();
      }
    } finally {
      readFileSpy.mockRestore();
      lstatSpy.mockRestore();
      openSpy.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
