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

  it("verifies local secret files are untracked regular files with private permissions", () => {
    const source = securityScanSource();

    expect(source).toContain("LOCAL_SECRET_CONFIGS_TO_VERIFY");
    expect(source).toContain('[".env", ".env.local", ".npmrc"]');
    expect(source).toContain("stat.mode & 0o077");
    expect(source).toContain("Tracked local secret config");
  });

  it("keeps private server key assignments in the scan patterns", () => {
    const source = securityScanSource();

    [
      "SERVICE_ROLE_KEY",
      "OPENAI_API_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_MAINTENANCE_URL",
      "GITHUB_TOKEN",
      "RAILWAY_TOKEN",
      "RESEND_TRANSACTIONAL_API_KEY",
    ].forEach((secretName) => expect(source).toContain(secretName));
  });

  it("covers GitHub, AWS, Railway, Resend, and private-key token families", () => {
    const source = securityScanSource();

    [
      "GitHub access token",
      "AWS access key ID",
      "Railway API token",
      "Resend API key",
      "Private key material",
    ].forEach((patternName) => expect(source).toContain(patternName));
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

  it("continues past a placeholder to detect a later real secret on the same line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const placeholder = "your_placeholder_service_key";
    const secret = "real_service_key_material_123";
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(
        path.join(root, "fixture.js"),
        `SERVICE_ROLE_KEY=${placeholder}; SERVICE_ROLE_KEY=${secret};\n`, // security-scan allow: values are assembled synthetic fixtures
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture.js:1 Private config assignment: [REDACTED]");
      expect(result.stderr).not.toContain(placeholder);
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not exempt a private-key fallback merely because it mentions process.env", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = "real_service_key_material_123";
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(
        path.join(root, "fixture.js"),
        `SERVICE_ROLE_KEY=process.env.KEY||${secret};\n`, // security-scan allow: assembled scanner regression
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture.js:1 Private config assignment: [REDACTED]");
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a Supabase secret mis-slotted into an ignored public mobile config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", `xxx${"S".repeat(29)}`].join("_");
    try {
      fs.mkdirSync(path.join(root, "apps/ios"), { recursive: true });
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(
        path.join(root, ".gitignore"),
        "apps/ios/Config.xcconfig\n",
      );
      fs.writeFileSync(
        path.join(root, "apps/ios/Config.xcconfig"),
        `SUPABASE_ANON_KEY = ${secret}\n`,
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "apps/ios/Config.xcconfig:1 Supabase secret key: [REDACTED]",
      );
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects an embedded Supabase secret without echoing the value", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", "S".repeat(32)].join("_");
    const embedded = `provider-prefix${secret}`;
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(
        path.join(root, "fixture.js"),
        `const leakedProviderDiagnostic = "${embedded}";\n`,
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture.js:1 Supabase secret key: [REDACTED]");
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).not.toContain(embedded);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects an overlong Supabase-secret-shaped string", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", "M".repeat(221)].join("_");
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(path.join(root, "fixture.js"), `const leaked = "${secret}";\n`);
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture.js:1 Supabase secret key: [REDACTED]");
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a tracked symbolic link without printing its target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", "L".repeat(32)].join("_");
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.symlinkSync(secret, path.join(root, "linked-source.png"));
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
      expect(spawnSync("git", ["add", "linked-source.png"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("linked-source.png:1 Symbolic link: [REDACTED]");
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a credential-shaped path without printing the path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", "P".repeat(32)].join("_");
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(path.join(root, secret), "");
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
      expect(spawnSync("git", ["add", secret], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Path name (Supabase secret key): [REDACTED]");
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mistake source filenames beginning with dist for build directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", "D".repeat(32)].join("_");
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(
        path.join(root, "dist-secret.js"),
        `const leaked = "${secret}";\n`,
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "dist-secret.js:1 Supabase secret key: [REDACTED]",
      );
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans newline-bearing filenames without splitting or printing control characters", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", "N".repeat(32)].join("_");
    const oddFilename = "odd\nsource.js";
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(
        path.join(root, oddFilename),
        `const leaked = "${secret}";\n`,
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `- ${JSON.stringify(oddFilename)}:1 Supabase secret key: [REDACTED]`,
      );
      expect(result.stderr).not.toContain(oddFilename);
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when Git returns a non-UTF-8 path inventory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const binaryDirectory = path.join(root, "bin");
    const fakeGit = path.join(binaryDirectory, "git");
    try {
      fs.mkdirSync(binaryDirectory);
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(
        fakeGit,
        "#!/usr/bin/env node\nprocess.stdout.write(Buffer.from([0x62, 0x61, 0x64, 0xff, 0x00]));\n",
        { mode: 0o755 },
      );

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Security scan failed: Git path inventory is not valid UTF-8.",
      );
      expect(result.stderr).not.toContain("bad");
      expect(result.stderr).not.toContain("�");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans staged index bytes even when the working tree was overwritten safely", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", "I".repeat(32)].join("_");
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
      fs.writeFileSync(path.join(root, "fixture.js"), `const leaked = "${secret}";\n`);
      expect(spawnSync("git", ["add", "fixture.js"], { cwd: root }).status).toBe(0);
      fs.writeFileSync(
        path.join(root, "fixture.js"),
        "const key = process.env.SUPABASE_SERVICE_ROLE_KEY;\n",
      );

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture.js:1 Supabase secret key: [REDACTED]");
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans staged index bytes after the working-tree file is deleted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const secret = ["sb", "secret", "R".repeat(32)].join("_");
    try {
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
      fs.writeFileSync(path.join(root, "fixture.js"), `const leaked = "${secret}";\n`);
      expect(spawnSync("git", ["add", "fixture.js"], { cwd: root }).status).toBe(0);
      fs.unlinkSync(path.join(root, "fixture.js"));

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture.js:1 Supabase secret key: [REDACTED]");
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects an accepted non-eyJ legacy Supabase JWT in ignored browser config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-security-scan-"));
    const signature = `xxx${"A".repeat(40)}`;
    expect(Buffer.from(signature, "base64url")).toHaveLength(32);
    expect(Buffer.from(signature, "base64url").toString("base64url")).toBe(signature);
    const secret = [
      Buffer.from(`  ${JSON.stringify({ typ: "JWT", alg: "HS256" })}`).toString("base64url"),
      Buffer.from(`  ${JSON.stringify({ role: "service_role" })}`).toString("base64url"),
      signature,
    ].join(".");
    try {
      fs.mkdirSync(path.join(root, "viewer"), { recursive: true });
      fs.copyFileSync(
        path.resolve(process.cwd(), "scripts/security-scan.mjs"),
        path.join(root, "security-scan.mjs"),
      );
      fs.writeFileSync(path.join(root, ".gitignore"), "viewer/config.js\n");
      fs.writeFileSync(
        path.join(root, "viewer/config.js"),
        `window.CONFIG = { supabaseAnonKey: "${secret}" };\n`,
      );
      expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);

      const result = spawnSync(process.execPath, ["security-scan.mjs"], {
        cwd: root,
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "viewer/config.js:1 JWT-like token: [REDACTED]",
      );
      expect(result.stderr).not.toContain(secret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
