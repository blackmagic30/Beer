#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const gitFilesOutput = [
  execFileSync("git", ["ls-files"], { encoding: "utf8" }),
  execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }),
].join("\n");

const files = Array.from(new Set(gitFilesOutput
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean)));

const SKIP_FILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|dist|coverage|node_modules)\b/;
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|heic|heif|ico|pdf|woff2?|ttf|eot|zip|gz|sqlite3?|db)$/i;
const PLACEHOLDER = /(?:your_|example|placeholder|dummy|fake|test[_-]?fixture|xxx|xxxx|optional_|changeme|not[_-]?set|price_|pk_test_xxx|sk_test_xxx|whsec_xxx|ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)/i;
const SAFE_CONFIG_REFERENCE = /\b(?:optionalStringFromEnv|requiredStringFromEnv|booleanFromEnv|numberFromEnv|z\.object|process\.env)\b/;

const patterns = [
  {
    name: "Stripe secret key",
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: "Stripe webhook secret",
    regex: /\bwhsec_[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: "Google API key",
    regex: /\bAIza[0-9A-Za-z_-]{32,}\b/g,
  },
  {
    name: "OpenAI style API key",
    regex: /\b(?:sk|rk|sess)_[A-Za-z0-9_-]{32,}\b|\bsk-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    name: "JWT-like token",
    regex: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: "Twilio auth token assignment",
    regex: /\bTWILIO_AUTH_TOKEN\s*=\s*['"]?[A-Za-z0-9_-]{24,}['"]?/g,
  },
  {
    name: "Private config assignment",
    regex: /\b(?:SERVICE_ROLE_KEY|OPENAI_API_KEY|ELEVENLABS_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)\s*[:=]\s*['"]?[^'"\s#]{12,}/g,
  },
];

const findings = [];

for (const file of files) {
  if (SKIP_FILE.test(file) || BINARY_FILE.test(file) || !fs.existsSync(file)) {
    continue;
  }

  const content = fs.readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (PLACEHOLDER.test(line) || SAFE_CONFIG_REFERENCE.test(line) || line.includes("security-scan allow")) {
      return;
    }

    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(line)) {
        findings.push({
          file,
          line: index + 1,
          type: pattern.name,
          sample: line.trim().slice(0, 160),
        });
      }
    }
  });
}

if (findings.length > 0) {
  console.error("Potential committed secrets found:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} ${finding.type}: ${finding.sample}`);
  }
  console.error("Replace real values with env placeholders, or mark obvious test fixtures with 'security-scan allow'.");
  process.exit(1);
}

console.log(`Security scan passed (${files.length} tracked/untracked files checked).`);
