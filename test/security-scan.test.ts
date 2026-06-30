import fs from "node:fs";
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
});
