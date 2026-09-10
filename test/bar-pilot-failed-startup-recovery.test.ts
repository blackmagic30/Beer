import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BAR_PILOT_FAILED_STARTUP_RECOVERY,
  readBarPilotFailedStartupCorrectionProof,
} from "../scripts/lib/bar-pilot-failed-startup-recovery.js";

const roots: string[] = [];
const files = [
  "bar-pilot-startup-db-identity-correction.json",
  "bar-pilot-startup-db-source-terminal.json",
  "bar-pilot-startup-db-source-intent.json",
  "bar-pilot-startup-db-pins-intent.json",
];
const evidencePath = path.dirname(BAR_PILOT_FAILED_STARTUP_RECOVERY.proofPath);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function copyProof() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-correction-proof-")));
  roots.push(root);
  const directory = path.join(root, evidencePath);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(evidencePath, file), path.join(directory, file));
  return { root, directory };
}

describe("completed pilot database identity correction proof", () => {
  it("validates the actual successful receipt and every linked one-attempt source/pin record", () => {
    expect(readBarPilotFailedStartupCorrectionProof(process.cwd()))
      .toBe("30d0381312877e5378f4246b8352f5b271e2f74653beae93da78f05f4368f1d5");
    const terminal = JSON.parse(fs.readFileSync(BAR_PILOT_FAILED_STARTUP_RECOVERY.proofPath, "utf8"));
    expect(terminal).toMatchObject({ outcome: "updated", sourceWriteAttempts: 1,
      pinWriteAttempts: 1, writeAttempts: 2, databaseMutations: 0, productionMutations: 0 });
  });

  it.each(files)("rejects missing linked evidence %s", (file) => {
    const { root, directory } = copyProof();
    fs.unlinkSync(path.join(directory, file));
    expect(() => readBarPilotFailedStartupCorrectionProof(root)).toThrow("failed_startup_recovery_invalid");
  });

  it.each(files)("rejects even a byte-only change to %s", (file) => {
    const { root, directory } = copyProof();
    fs.appendFileSync(path.join(directory, file), "\n");
    expect(() => readBarPilotFailedStartupCorrectionProof(root)).toThrow("failed_startup_recovery_invalid");
  });

  it("does not accept the earlier incomplete receipt as completed correction authority", () => {
    const { root, directory } = copyProof();
    fs.copyFileSync(path.join(directory, "bar-pilot-startup-db-source-terminal.json"),
      path.join(directory, "bar-pilot-startup-db-identity-correction.json"));
    expect(() => readBarPilotFailedStartupCorrectionProof(root)).toThrow("failed_startup_recovery_invalid");
  });
});
