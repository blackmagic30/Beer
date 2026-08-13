#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const trackedIndexBuffer = execFileSync("git", ["ls-files", "-s", "-z"]);
const untrackedFilesBuffer = execFileSync(
  "git",
  ["ls-files", "-z", "--others", "--exclude-standard"],
);
let trackedIndexOutput;
let untrackedFilesOutput;
try {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  trackedIndexOutput = decoder.decode(trackedIndexBuffer);
  untrackedFilesOutput = decoder.decode(untrackedFilesBuffer);
} catch {
  console.error("Security scan failed: Git path inventory is not valid UTF-8.");
  process.exit(1);
}

const trackedEntries = trackedIndexOutput.split("\0").filter(Boolean).map((record) => {
  const separator = record.indexOf("\t");
  const header = separator < 0 ? [] : record.slice(0, separator).split(" ");
  const file = separator < 0 ? "" : record.slice(separator + 1);
  if (
    header.length !== 3
    || !/^\d{6}$/.test(header[0])
    || !/^[a-f0-9]{40,64}$/.test(header[1])
    || !/^[0-3]$/.test(header[2])
    || !file
  ) {
    console.error("Security scan failed: Git index inventory is malformed.");
    process.exit(1);
  }
  return { mode: header[0], objectId: header[1], file };
});
const untrackedFiles = untrackedFilesOutput.split("\0").filter(Boolean);
const files = Array.from(new Set([
  ...trackedEntries.map((entry) => entry.file),
  ...untrackedFiles,
]));

const IGNORED_LOCAL_CONFIGS_TO_SCAN = [
  "viewer/config.js",
  "apps/android/local.properties",
  "apps/ios/Config.xcconfig",
];

const LOCAL_SECRET_CONFIGS_TO_VERIFY = [".env", ".env.local", ".npmrc"];

for (const ignoredLocalConfig of IGNORED_LOCAL_CONFIGS_TO_SCAN) {
  if (!files.includes(ignoredLocalConfig)) {
    files.push(ignoredLocalConfig);
  }
}

const SKIP_FILE = /(?:^|\/)(?:(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|(?:dist|coverage|node_modules)(?:\/|$))/;
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|heic|heif|ico|pdf|woff2?|ttf|eot|zip|gz|sqlite3?|db)$/i;
const PLACEHOLDER = /(?:your_|example|placeholder|replace|dummy|fake|fixture|[_-]test[_-]|forbidden|unrelated|inherited|dedicated[_-]?sending|xxx|xxxx|optional_|changeme|not[_-]?set|price_|pk_test_xxx|sk_test_xxx|whsec_xxx|ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX)/i;
const SAFE_PRIVATE_ASSIGNMENT_REFERENCE = /^(?:AWS_SECRET_ACCESS_KEY|DATABASE_MAINTENANCE_URL|GITHUB_TOKEN|RAILWAY_TOKEN|RESEND_API_KEY|RESEND_TRANSACTIONAL_API_KEY|SERVICE_ROLE_KEY|OPENAI_API_KEY|PRIVATE_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)\s*:\s*(?:(?:optionalStringFromEnv|requiredStringFromEnv|booleanFromEnv|numberFromEnv|z\.object)|(?:(?:production|staging)(?:Maintenance)?DatabaseUrl))[,;]?$/;

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
    name: "Supabase secret key",
    regex: /sb_secret_[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: "OpenAI style API key",
    regex: /\b(?:sk|rk|sess)_[A-Za-z0-9_-]{32,}\b|\bsk-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    name: "GitHub access token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{50,255}\b/g,
  },
  {
    name: "AWS access key ID",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    name: "Resend API key",
    regex: /\bre_[A-Za-z0-9]{32,}\b/g,
  },
  {
    name: "Railway API token",
    regex: /\brw_[A-Za-z0-9_-]{48,}\b/g,
  },
  {
    name: "Private key material",
    regex: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/g,
  },
  {
    name: "JWT-like token",
    regex: /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{43,}/g,
  },
  {
    name: "Private config assignment",
    regex: /\b(?:AWS_SECRET_ACCESS_KEY|DATABASE_MAINTENANCE_URL|GITHUB_TOKEN|RAILWAY_TOKEN|RESEND_API_KEY|RESEND_TRANSACTIONAL_API_KEY|SERVICE_ROLE_KEY|OPENAI_API_KEY|PRIVATE_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)\s*[:=]\s*['"]?[^'"\s#]{12,}/g,
  },
];

const findings = [];
const findingKeys = new Set();

function addFinding(finding) {
  const key = [
    finding.pathName ? "path" : "content",
    finding.file ?? "",
    finding.line ?? "",
    finding.type,
  ].join("\0");
  if (findingKeys.has(key)) return;
  findingKeys.add(key);
  findings.push(finding);
}

for (const file of LOCAL_SECRET_CONFIGS_TO_VERIFY) {
  if (!fs.existsSync(file)) continue;
  const indexEntry = trackedEntries.find((entry) => entry.file === file);
  if (indexEntry) {
    addFinding({ file, line: 1, type: "Tracked local secret config" });
    continue;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    addFinding({ file, line: 1, type: "Unsafe local secret config" });
    continue;
  }
  if ((stat.mode & 0o077) !== 0) {
    addFinding({ file, line: 1, type: "Over-permissive local secret config" });
  }
}

function isReportableMatch(pattern, match) {
  if (
    pattern.name === "Private config assignment"
    && SAFE_PRIVATE_ASSIGNMENT_REFERENCE.test(match[0])
  ) {
    return false;
  }
  return pattern.name !== "Private config assignment" || !PLACEHOLDER.test(match[0]);
}

function pathFindingType(file) {
  let pathFindingType = null;
  for (const pattern of patterns) {
    for (const match of file.matchAll(pattern.regex)) {
      if (isReportableMatch(pattern, match)) {
        pathFindingType = pattern.name;
        break;
      }
    }
    if (pathFindingType) break;
  }
  return pathFindingType;
}

function scanContent(file, content) {
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes("security-scan allow")) return;
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern.regex)) {
        if (isReportableMatch(pattern, match)) {
          addFinding({ file, line: index + 1, type: pattern.name });
          break;
        }
      }
    }
  });
}

const secretPathFiles = new Set();
for (const file of files) {
  const type = pathFindingType(file);
  if (!type) continue;
  secretPathFiles.add(file);
  addFinding({ file, line: null, type, pathName: true });
}

for (const entry of trackedEntries) {
  const { file } = entry;
  if (secretPathFiles.has(file) || SKIP_FILE.test(file)) continue;
  if (entry.mode === "120000") {
    addFinding({ file, line: 1, type: "Symbolic link" });
    continue;
  }
  if (entry.mode === "160000") {
    addFinding({ file, line: 1, type: "Gitlink" });
    continue;
  }
  if (BINARY_FILE.test(file)) continue;
  const content = execFileSync(
    "git",
    ["cat-file", "blob", entry.objectId],
    { maxBuffer: 64 * 1024 * 1024 },
  ).toString("utf8");
  scanContent(file, content);
}

if (typeof fs.constants.O_NOFOLLOW !== "number") {
  throw new Error("Security scan requires O_NOFOLLOW support.");
}

for (const file of files) {
  if (secretPathFiles.has(file)) continue;
  if (SKIP_FILE.test(file)) {
    continue;
  }

  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      continue;
    }
    if (error && typeof error === "object" && error.code === "ELOOP") {
      addFinding({ file, line: 1, type: "Symbolic link" });
      continue;
    }
    throw error;
  }

  if (BINARY_FILE.test(file)) {
    fs.closeSync(descriptor);
    continue;
  }

  let content;
  try {
    content = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  scanContent(file, content);
}

if (findings.length > 0) {
  console.error("Potential committed secrets found:");
  for (const finding of findings) {
    if (finding.pathName) {
      console.error(`- Path name (${finding.type}): [REDACTED]`);
      continue;
    }
    const safeFile = [...finding.file].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
      ? JSON.stringify(finding.file)
      : finding.file;
    console.error(`- ${safeFile}:${finding.line} ${finding.type}: [REDACTED]`);
  }
  console.error("Replace real values with env placeholders, or mark obvious test fixtures with 'security-scan allow'.");
  process.exit(1);
}

console.log(`Security scan passed (${files.length} tracked/untracked files checked).`);
