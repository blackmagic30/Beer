import fs from "node:fs";
import path from "node:path";

interface EvidenceItem {
  id: string;
  label: string;
  required: boolean;
  status: "pending" | "pass" | "fail" | "not_applicable";
  evidence: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
}

interface EvidenceFile {
  version: number;
  items: EvidenceItem[];
}

const filename = path.resolve(process.env.RELEASE_EVIDENCE_PATH || "docs/release-evidence.json");
const strict = process.argv.includes("--strict");
const data = JSON.parse(fs.readFileSync(filename, "utf8")) as EvidenceFile;
const invalid = data.items.filter((item) =>
  !item.id || !item.label || !["pending", "pass", "fail", "not_applicable"].includes(item.status),
);
const incomplete = data.items.filter((item) => item.required && item.status !== "pass");
const unsupportedPasses = data.items.filter((item) => item.status === "pass" && (!item.evidence || !item.verifiedAt || !item.verifiedBy));
const valid = invalid.length === 0 && unsupportedPasses.length === 0;
const launchReady = valid && incomplete.length === 0;

console.log(JSON.stringify({
  ok: launchReady,
  valid,
  launchReady,
  strict,
  summary: {
    total: data.items.length,
    passed: data.items.filter((item) => item.status === "pass").length,
    pending: data.items.filter((item) => item.status === "pending").length,
    failed: data.items.filter((item) => item.status === "fail").length,
    requiredIncomplete: incomplete.length,
  },
  invalid: invalid.map((item) => item.id),
  unsupportedPasses: unsupportedPasses.map((item) => item.id),
  incomplete: incomplete.map((item) => ({ id: item.id, label: item.label, status: item.status })),
}, null, 2));

if (invalid.length || unsupportedPasses.length || (strict && incomplete.length)) process.exitCode = 1;
