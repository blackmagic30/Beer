import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function securityScanSource() {
  return fs.readFileSync(path.resolve(process.cwd(), "scripts/security-scan.mjs"), "utf8");
}

describe("security scan guardrails", () => {
  it("checks ignored local browser and mobile config files when present", () => {
    const source = securityScanSource();

    expect(source).toContain("IGNORED_LOCAL_CONFIGS_TO_SCAN");
    [
      '"viewer/config.js"',
      '"apps/android/local.properties"',
      '"apps/ios/Config.xcconfig"',
    ].forEach((configPath) => expect(source).toContain(configPath));
  });

  it("keeps private server key assignments in the scan patterns", () => {
    const source = securityScanSource();

    [
      "SERVICE_ROLE_KEY",
      "OPENAI_API_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ].forEach((secretName) => expect(source).toContain(secretName));
  });

  it("detects a provider key beside process.env without echoing the secret", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = `AIza${"A".repeat(35)}`;
    try {
      fs.copyFileSync(path.resolve(process.cwd(), "scripts/security-scan.mjs"), path.join(root, "security-scan.mjs"));
      fs.writeFileSync(
        path.join(root, "fixture.js"),
        `const key = process.env.GOOGLE_API_KEY || "${secret}"; // example of a forbidden fallback\n`,
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture.js:1 Google API key: [REDACTED]");
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain("process.env.GOOGLE_API_KEY");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
