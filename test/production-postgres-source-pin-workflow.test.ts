import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(
  root,
  ".github/workflows/pin-production-postgres-source-image.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function jobSource(name: string): string {
  const marker = new RegExp(`^  ${escapeRegExp(name)}:\\s*$`, "m");
  const match = marker.exec(workflow);
  expect(match, `job ${name}`).not.toBeNull();
  const start = match!.index;
  const remainder = workflow.slice(start + match![0].length);
  const next = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(remainder);
  return workflow.slice(
    start,
    next ? start + match![0].length + next.index : workflow.length,
  );
}

function stepContaining(source: string, needle: string): string {
  const position = source.indexOf(needle);
  expect(position, needle).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf("\n      - name:", position);
  const end = source.indexOf("\n      - name:", position + needle.length);
  expect(start, needle).toBeGreaterThanOrEqual(0);
  return source.slice(start, end < 0 ? source.length : end);
}

function stepId(source: string): string {
  const value = /^\s{8}id:\s*([a-zA-Z0-9_-]+)\s*$/m.exec(source)?.[1];
  expect(value, "step id").toBeDefined();
  return value!;
}

function jobOutput(source: string, name: string): string {
  const value = new RegExp(
    `^\\s{6}${escapeRegExp(name)}:\\s*(.+?)\\s*$`,
    "m",
  ).exec(source)?.[1];
  expect(value, `job output ${name}`).toBeDefined();
  return value!;
}

function shellRunBodies(source: string): readonly string[] {
  const lines = source.split("\n");
  const bodies: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*(.*?)\s*$/.exec(lines[index] ?? "");
    if (!match) continue;
    const indentation = match[1]!.length;
    const scalar = match[2]!;
    if (!/^[|>][-+0-9]*$/.test(scalar)) {
      bodies.push(scalar);
      continue;
    }
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const contentIndentation = /^\s*/.exec(line)?.[0].length ?? 0;
      if (line.trim().length > 0 && contentIndentation <= indentation) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

describe("protected production Postgres source-pin workflow", () => {
  it("keeps all five source-pin entry points exact and executable", () => {
    expect(packageJson.scripts).toMatchObject({
      "github:production-postgres-source-pin-authority:verify":
        "node --frozen-intrinsics --disable-proto=throw scripts/verify-github-reviewed-candidate-authority.mjs --operation production-postgres-source-pin",
      "github:production-postgres-source-pin-recovery:materialize":
        "node --frozen-intrinsics --disable-proto=throw --import tsx scripts/materialize-production-postgres-source-pin-recovery-authority.mjs",
      "production:postgres-source-pin:compatibility:verify":
        "node --frozen-intrinsics --disable-proto=throw --import tsx scripts/verify-production-postgres-source-pin-compatibility.ts",
      "production:postgres-source-pin:contract:check":
        "vitest run test/github-reviewed-candidate-authority.test.ts test/postgres-logical-source-identity.test.ts test/production-postgres-source-pin-recovery-authority.test.ts test/protected-production-postgres-source-pin.test.ts test/production-postgres-source-pin-workflow.test.ts --maxWorkers=1",
      "railway:production:postgres-source-pin:protected":
        "node --frozen-intrinsics --disable-proto=throw --import tsx scripts/execute-protected-production-postgres-source-pin.ts",
    });
    for (const filename of [
      "scripts/verify-github-reviewed-candidate-authority.mjs",
      "scripts/materialize-production-postgres-source-pin-recovery-authority.mjs",
      "scripts/verify-production-postgres-source-pin-compatibility.ts",
      "scripts/execute-protected-production-postgres-source-pin.ts",
      "test/github-reviewed-candidate-authority.test.ts",
      "test/postgres-logical-source-identity.test.ts",
      "test/production-postgres-source-pin-recovery-authority.test.ts",
      "test/protected-production-postgres-source-pin.test.ts",
      "test/production-postgres-source-pin-workflow.test.ts",
    ]) expect(fs.existsSync(path.join(root, filename)), filename).toBe(true);
  });

  it("keeps preparation secret-free and mutation on the protected private runner", () => {
    const prepare = jobSource("prepare");
    const pin = jobSource("pin");
    const pinHeader = pin.slice(0, pin.indexOf("    steps:"));

    expect(prepare).not.toMatch(/^\s{4}environment:/m);
    expect(prepare).not.toMatch(/\$\{\{\s*secrets(?:\.|\[)/);
    expect(pinHeader).toContain("environment: production-postgres-source-pin");
    for (const label of [
      "self-hosted",
      "linux",
      "x64",
      "pintpath-production-backup",
    ]) expect(pinHeader, label).toContain(label);
    expect(pinHeader).not.toMatch(/ubuntu-(?:latest|[0-9.]+)/);
  });

  it("treats dispatch inputs as untrusted data and reasserts live main before secrets", () => {
    const pin = jobSource("pin");
    const reassert = stepContaining(
      pin,
      "Reassert live current main before protected credentials",
    );
    expect(reassert).toContain(
      "github:production-postgres-source-pin-authority:verify",
    );
    expect(reassert).toContain("$CANDIDATE_SHA");

    const reassertPosition = pin.indexOf(
      "Reassert live current main before protected credentials",
    );
    const firstSecretPosition = pin.search(/\$\{\{\s*secrets(?:\.|\[)/);
    expect(firstSecretPosition).toBeGreaterThan(reassertPosition);
    expect(pin.slice(0, reassertPosition)).not.toMatch(
      /\$\{\{\s*secrets(?:\.|\[)/,
    );

    for (const [index, body] of shellRunBodies(workflow).entries()) {
      expect(body, `run body ${index}`).not.toMatch(
        /\$\{\{\s*inputs(?:\.|\[)/,
      );
    }

    const backupRunBindings = workflow.split("\n").filter((line) =>
      line.includes("${{ inputs.backup_run_id }}")
    );
    expect(backupRunBindings.length).toBeGreaterThan(0);
    for (const line of backupRunBindings) {
      expect(line).toMatch(
        /^\s+BACKUP_RUN_ID:\s*\$\{\{\s*inputs\.backup_run_id\s*\}\}\s*$/,
      );
    }
    expect(shellRunBodies(workflow).some((body) =>
      body.includes('[[ "$BACKUP_RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]]')
    )).toBe(true);
    expect(workflow).toContain('--backup-run-id "$BACKUP_RUN_ID"');
  });

  it("hard-stops on compatibility and performs exactly one source mutation", () => {
    const prepare = jobSource("prepare");
    const compatibility = stepContaining(
      prepare,
      "production:postgres-source-pin:compatibility:verify",
    );
    expect(compatibility).not.toContain("continue-on-error: true");
    expect(compatibility).not.toContain("set +e");
    expect(compatibility).not.toMatch(/\|\|\s*true/);
    expect(prepare.indexOf("production:postgres-source-pin:compatibility:verify"))
      .toBeLessThan(prepare.indexOf("actions/upload-artifact@"));

    expect(occurrences(
      workflow,
      "name: Commit exact immutable production Postgres source once",
    )).toBe(1);
    expect(occurrences(
      workflow,
      "railway:production:postgres-source-pin:protected",
    )).toBe(1);
    expect(occurrences(
      workflow,
      "secrets.PINTPATH_RAILWAY_PRODUCTION_POSTGRES_SOURCE_MUTATION_TOKEN",
    )).toBe(1);
  });

  it("uses volatile recovery custody for the database probe and dominant cleanup", () => {
    const pin = jobSource("pin");
    const prepareRoot = stepContaining(
      pin,
      "verify-production-backup-volatile-work-root.mjs prepare",
    );
    const cleanupRoot = stepContaining(
      pin,
      "verify-production-backup-volatile-work-root.mjs cleanup",
    );
    const mutation = stepContaining(
      pin,
      "railway:production:postgres-source-pin:protected",
    );
    const secrets = stepContaining(
      pin,
      "secrets.PINTPATH_PRODUCTION_BACKUP_DATABASE_URL",
    );

    expect(prepareRoot).toMatch(/--operation(?:=|\s+)recovery/);
    expect(prepareRoot).toContain("$GITHUB_ENV");
    expect(cleanupRoot).toMatch(
      /if:\s*(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?/,
    );
    expect(cleanupRoot).toMatch(/--operation(?:=|\s+)recovery/);
    expect(cleanupRoot).not.toContain("continue-on-error: true");
    expect(secrets).toContain(
      "secrets.PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_PEM",
    );
    expect(secrets).toContain("$PINTPATH_RECOVERY_WORK_ROOT/");
    expect(secrets).not.toContain("$RUNNER_TEMP/");
    expect(mutation).toMatch(
      /--database-url-file(?:=|\s+)"?\$PINTPATH_RECOVERY_WORK_ROOT\//,
    );
    expect(mutation).toMatch(
      /--root-ca-file(?:=|\s+)"?\$PINTPATH_RECOVERY_WORK_ROOT\//,
    );
  });

  it("binds the materializer output hash and exact uploaded artifact into execution", () => {
    const prepare = jobSource("prepare");
    const pin = jobSource("pin");
    const prepareHeader = prepare.slice(0, prepare.indexOf("    steps:"));
    const recovery = stepContaining(prepare, "id: recovery");
    const upload = stepContaining(prepare, "actions/upload-artifact@");
    const download = stepContaining(pin, "actions/download-artifact@");
    const mutation = stepContaining(
      pin,
      "railway:production:postgres-source-pin:protected",
    );
    const recoveryId = stepId(recovery);
    const uploadId = stepId(upload);

    expect(recovery).toContain("outputSha256");
    expect(recovery).toContain("$GITHUB_OUTPUT");
    expect(jobOutput(prepareHeader, "recovery_authority_file_sha256")).toContain(
      `steps.${recoveryId}.outputs.`,
    );
    expect(jobOutput(prepareHeader, "prepared_artifact_id")).toContain(
      `steps.${uploadId}.outputs.artifact-id`,
    );
    expect(jobOutput(prepareHeader, "prepared_artifact_digest")).toContain(
      `steps.${uploadId}.outputs.artifact-digest`,
    );
    expect(download).toContain(
      "artifact-ids: ${{ needs.prepare.outputs.prepared_artifact_id }}",
    );
    expect(download).toContain("merge-multiple: true");

    for (const [output, environmentName, argument] of [
      [
        "recovery_authority_file_sha256",
        "EXPECTED_RECOVERY_AUTHORITY_FILE_SHA256",
        "--expected-recovery-authority-file-sha256",
      ],
      [
        "prepared_artifact_id",
        "EXPECTED_PREPARED_ARTIFACT_ID",
        "--expected-prepared-artifact-id",
      ],
      [
        "prepared_artifact_digest",
        "EXPECTED_PREPARED_ARTIFACT_DIGEST",
        "--expected-prepared-artifact-digest",
      ],
    ] as const) {
      expect(mutation).toContain(
        `${environmentName}: \${{ needs.prepare.outputs.${output} }}`,
      );
      expect(mutation).toMatch(
        new RegExp(`${escapeRegExp(argument)}(?:=|\\s+)"?\\$${environmentName}`),
      );
    }
    expect(mutation).toMatch(
      /--recovery-authority(?:=|\s+)"?\$PINTPATH_RECOVERY_WORK_ROOT\//,
    );
  });
});
