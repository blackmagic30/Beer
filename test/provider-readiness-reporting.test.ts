import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("provider readiness report delivery checks", () => {
  it("reports deferred production Resend credentials as launch-blocking warnings", () => {
    const result = spawnSync(
      path.resolve("node_modules/.bin/tsx"),
      ["scripts/provider-readiness-check.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          LAUNCH_READINESS_STRICT: "true",
          REPORT_EMAIL_MODE: "disabled",
          REPORT_DELIVERY_SCHEDULE_ENABLED: "false",
          RESEND_API_KEY: "",
          REPORT_EMAIL_FROM: "",
          SUPABASE_URL: "",
          SUPABASE_SERVICE_ROLE_KEY: "",
          OFFSITE_BACKUP_SUPABASE_URL: "",
          OFFSITE_BACKUP_SERVICE_ROLE_KEY: "",
        },
      },
    );

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; status: string }>;
      summary: { blockingWarnings: number };
    };
    expect(payload.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "RESEND_API_KEY", status: "warn" }),
      expect.objectContaining({ id: "REPORT_EMAIL_FROM", status: "warn" }),
    ]));
    expect(payload.summary.blockingWarnings).toBeGreaterThanOrEqual(4);
  });
});
