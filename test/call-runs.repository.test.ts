import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CallRunsRepository } from "../src/db/call-runs.repository";

function createRepository() {
  const database = new BetterSqlite3(":memory:");
  const schemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
  database.exec(fs.readFileSync(schemaPath, "utf8"));

  return {
    database,
    repository: new CallRunsRepository(database),
  };
}

describe("CallRunsRepository", () => {
  it("updates call status without requiring optional SQL parameters", () => {
    const { repository } = createRepository();

    repository.create({
      id: "run-1",
      venueId: "venue-1",
      venueName: "Test Venue",
      phoneNumber: "+61400000000",
      suburb: "Melbourne",
      startedAt: "2026-04-14T10:00:00.000Z",
      callStatus: "queued",
      parseStatus: "pending",
      isTest: true,
      createdAt: "2026-04-14T10:00:00.000Z",
      updatedAt: "2026-04-14T10:00:00.000Z",
    });

    repository.updateDialSuccess(
      "run-1",
      "CA-test-1",
      "in-progress",
      "2026-04-14T10:00:05.000Z",
    );

    expect(() =>
      repository.updateStatusByCallSid("CA-test-1", {
        callStatus: "completed",
        durationSeconds: 16,
        updatedAt: "2026-04-14T10:00:16.000Z",
      }),
    ).not.toThrow();

    expect(() =>
      repository.updateStatusById("run-1", {
        callStatus: "completed",
        endedAt: "2026-04-14T10:00:16.000Z",
        updatedAt: "2026-04-14T10:00:16.000Z",
      }),
    ).not.toThrow();

    expect(() =>
      repository.saveTranscriptParseById("run-1", {
        rawTranscript: "USER: Carlton Draft is 12 dollars",
        parseConfidence: 0.78,
        parseStatus: "parsed",
        updatedAt: "2026-04-14T10:00:20.000Z",
      }),
    ).not.toThrow();

    const row = repository.getById("run-1");

    expect(row?.callStatus).toBe("completed");
    expect(row?.durationSeconds).toBe(16);
    expect(row?.rawTranscript).toContain("Carlton Draft");
    expect(row?.parseStatus).toBe("parsed");
    expect(row?.errorMessage).toBeNull();
  });
});
