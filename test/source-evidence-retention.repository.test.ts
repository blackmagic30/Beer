import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  SourceEvidenceRetentionRepository,
  SourceEvidenceRetentionRepositoryError,
  type SourceEvidenceRetentionCandidate,
} from "../src/db/source-evidence-retention.repository.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const BASE_TIME = "2026-08-08T00:00:00.000Z";
const NOW = atMinute(100);
const HARD_CUTOFF = atMinute(20);

function atMinute(minute: number): string {
  return new Date(Date.parse(BASE_TIME) + minute * 60_000).toISOString();
}

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: SourceEvidenceRetentionRepository;
}

interface EvidenceInput {
  id: string;
  ownerUserId?: string | null;
  storageProvider?: string;
  objectPath?: string;
  mimeType?: string | null;
  byteSize?: number | null;
  dataBase64?: string | null;
  externalUrl?: string | null;
  retentionExpiresAt?: string | null;
  deletedAt?: string | null;
  createdAt?: string;
}

function insertAccount(raw: BetterSqlite3.Database, id: string): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, public_account_id, email, password_hash, auth_provider, role,
       subscription_status, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'hash', 'local', 'user', 'free', 'active', ?, ?)`,
  ).run(id, `public-${id}`, `${id}@example.test`, BASE_TIME, BASE_TIME);
}

function insertEvidence(raw: BetterSqlite3.Database, input: EvidenceInput): void {
  raw.prepare(
    `INSERT INTO source_evidence_objects (
       id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
       data_base64, external_url, retention_expires_at, deleted_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.ownerUserId === undefined ? "owner-a" : input.ownerUserId,
    input.storageProvider ?? "sqlite_private",
    input.objectPath ?? `private/${input.id}`,
    input.mimeType === undefined ? "image/jpeg" : input.mimeType,
    input.byteSize === undefined ? 128 : input.byteSize,
    input.dataBase64 === undefined ? "cHJpdmF0ZQ==" : input.dataBase64,
    input.externalUrl === undefined ? `https://private.example/${input.id}` : input.externalUrl,
    input.retentionExpiresAt === undefined ? atMinute(50) : input.retentionExpiresAt,
    input.deletedAt ?? null,
    input.createdAt ?? atMinute(10),
  );
}

function insertSubmission(raw: BetterSqlite3.Database, id: string, status: string): void {
  raw.prepare(
    `INSERT INTO submissions (
       id, user_id, venue_id, venue_name, status, submission_type, observed_at,
       created_at, updated_at
     ) VALUES (?, 'owner-a', 'venue-a', 'Venue A', ?, 'photo_upload', ?, ?, ?)`,
  ).run(id, status, atMinute(30), atMinute(30), atMinute(30));
}

function linkEvidence(
  raw: BetterSqlite3.Database,
  submissionId: string,
  evidenceId: string,
  sortOrder = 0,
): void {
  raw.prepare(
    `INSERT INTO submission_source_evidence (submission_id, evidence_id, sort_order, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(submissionId, evidenceId, sortOrder, atMinute(31));
}

function retentionCursor(candidate: SourceEvidenceRetentionCandidate) {
  return {
    retentionExpiresAt: candidate.retentionExpiresAt,
    createdAt: candidate.createdAt,
    id: candidate.id,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "SourceEvidenceRetentionRepositoryError",
    code,
  });
}

describe("SourceEvidenceRetentionRepository with AsyncSqliteDatabase", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async ({ database }) => {
      if (database.metrics().totalConnections > 0) await database.close();
    }));
  });

  function fixture(): Fixture {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    insertAccount(raw, "owner-a");
    insertAccount(raw, "owner-b");
    const database = new AsyncSqliteDatabase(raw);
    const created = {
      raw,
      database,
      repository: new SourceEvidenceRetentionRepository(database),
    };
    fixtures.push(created);
    return created;
  }

  it("preserves inclusive retention, open-review hold, and hard-cap boundaries", async () => {
    const { raw, repository } = fixture();
    insertSubmission(raw, "submission-pending", "pending");
    insertSubmission(raw, "submission-needs", "needs_more_evidence");
    insertSubmission(raw, "submission-approved", "approved");

    insertEvidence(raw, {
      id: "cutoff-inclusive",
      createdAt: atMinute(30),
      retentionExpiresAt: NOW,
    });
    insertEvidence(raw, {
      id: "cutoff-future",
      createdAt: atMinute(30),
      retentionExpiresAt: atMinute(101),
    });
    insertEvidence(raw, {
      id: "held-before-hard-cap",
      createdAt: atMinute(21),
      retentionExpiresAt: atMinute(90),
    });
    linkEvidence(raw, "submission-pending", "held-before-hard-cap");
    insertEvidence(raw, {
      id: "held-at-hard-cap",
      createdAt: HARD_CUTOFF,
      retentionExpiresAt: atMinute(80),
    });
    linkEvidence(raw, "submission-needs", "held-at-hard-cap");
    insertEvidence(raw, {
      id: "closed-review",
      createdAt: atMinute(30),
      retentionExpiresAt: atMinute(70),
    });
    linkEvidence(raw, "submission-approved", "closed-review");
    insertEvidence(raw, {
      id: "already-deleted",
      createdAt: atMinute(30),
      retentionExpiresAt: atMinute(60),
      deletedAt: atMinute(95),
    });
    insertEvidence(raw, {
      id: "no-retention",
      createdAt: atMinute(30),
      retentionExpiresAt: null,
    });

    const expired = await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      limit: 20,
    });
    expect(expired.map((candidate) => candidate.id)).toEqual([
      "closed-review",
      "held-at-hard-cap",
      "cutoff-inclusive",
    ]);
    expect(expired[0]).toMatchObject({ heldForOpenReview: false, reason: "retention_expired" });
    expect(expired[1]).toMatchObject({ heldForOpenReview: true, reason: "hard_cap" });
    expect(expired.every((candidate) => /^[a-f0-9]{64}$/.test(candidate.deletionToken))).toBe(true);
    expect(await repository.countExpiredSourceEvidence(NOW, HARD_CUTOFF)).toBe(3);
    expect(await repository.countOverdueHeldSourceEvidence(NOW, HARD_CUTOFF)).toEqual({
      heldForOpenReview: 2,
      pastHardCap: 1,
    });
  });

  it("keyset-paginates and drains deterministic batches while retaining object-path tombstones", async () => {
    const { raw, repository } = fixture();
    for (const id of ["evidence-a", "evidence-b", "evidence-c", "evidence-d", "evidence-e"]) {
      insertEvidence(raw, {
        id,
        createdAt: atMinute(5),
        retentionExpiresAt: atMinute(10),
      });
    }

    const first = await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: BASE_TIME,
      limit: 2,
    });
    const second = await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: BASE_TIME,
      limit: 2,
      cursor: retentionCursor(first.at(-1)!),
    });
    const third = await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: BASE_TIME,
      limit: 2,
      cursor: retentionCursor(second.at(-1)!),
    });
    const candidates = [...first, ...second, ...third];
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "evidence-a",
      "evidence-b",
      "evidence-c",
      "evidence-d",
      "evidence-e",
    ]);

    for (const candidate of candidates) {
      const tombstone = await repository.markSourceEvidenceDeleted({
        id: candidate.id,
        deletionToken: candidate.deletionToken,
        now: NOW,
        hardCutoff: BASE_TIME,
        deletedAt: atMinute(101),
      });
      expect(tombstone).toMatchObject({
        id: candidate.id,
        objectPath: `private/${candidate.id}`,
        externalUrl: null,
        byteSize: null,
        deletedAt: atMinute(101),
      });
    }
    expect(await repository.countExpiredSourceEvidence(NOW, BASE_TIME)).toBe(0);
    const persisted = raw.prepare(
      `SELECT object_path, mime_type, data_base64, external_url, byte_size, deleted_at
       FROM source_evidence_objects WHERE id = 'evidence-c'`,
    ).get() as Record<string, unknown>;
    expect(persisted).toEqual({
      object_path: "private/evidence-c",
      mime_type: "image/jpeg",
      data_base64: null,
      external_url: null,
      byte_size: null,
      deleted_at: atMinute(101),
    });
  });

  it("fences stale metadata, newly held evidence, and concurrent deletion acknowledgements", async () => {
    const { raw, repository } = fixture();
    insertEvidence(raw, { id: "stale", createdAt: atMinute(30), retentionExpiresAt: atMinute(50) });
    const stale = (await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      limit: 10,
    }))[0]!;
    raw.prepare("UPDATE source_evidence_objects SET external_url = ? WHERE id = ?")
      .run("https://private.example/replaced", stale.id);
    await expectCode(repository.markSourceEvidenceDeleted({
      id: stale.id,
      deletionToken: stale.deletionToken,
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      deletedAt: atMinute(101),
    }), "retention_candidate_conflict");
    expect(raw.prepare("SELECT deleted_at FROM source_evidence_objects WHERE id = ?").get(stale.id))
      .toEqual({ deleted_at: null });

    insertEvidence(raw, { id: "newly-held", createdAt: atMinute(30), retentionExpiresAt: atMinute(50) });
    const newlyHeld = (await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      limit: 10,
    })).find((candidate) => candidate.id === "newly-held")!;
    insertSubmission(raw, "submission-new-hold", "pending");
    linkEvidence(raw, "submission-new-hold", newlyHeld.id);
    await expectCode(repository.markSourceEvidenceDeleted({
      id: newlyHeld.id,
      deletionToken: newlyHeld.deletionToken,
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      deletedAt: atMinute(101),
    }), "retention_candidate_conflict");

    insertEvidence(raw, { id: "concurrent", createdAt: atMinute(30), retentionExpiresAt: atMinute(50) });
    const concurrent = (await repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      limit: 10,
    })).find((candidate) => candidate.id === "concurrent")!;
    const results = await Promise.allSettled([
      repository.markSourceEvidenceDeleted({
        id: concurrent.id,
        deletionToken: concurrent.deletionToken,
        now: NOW,
        hardCutoff: HARD_CUTOFF,
        deletedAt: atMinute(101),
      }),
      repository.markSourceEvidenceDeleted({
        id: concurrent.id,
        deletionToken: concurrent.deletionToken,
        now: NOW,
        hardCutoff: HARD_CUTOFF,
        deletedAt: atMinute(101),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "retention_candidate_conflict" },
    });
  });

  it("paginates owners without leaking another owner's or tombstoned evidence", async () => {
    const { repository, raw } = fixture();
    insertEvidence(raw, { id: "owner-a-1", createdAt: atMinute(1) });
    insertEvidence(raw, { id: "owner-a-2", createdAt: atMinute(2) });
    insertEvidence(raw, { id: "owner-a-3", createdAt: atMinute(3) });
    insertEvidence(raw, { id: "owner-b-1", ownerUserId: "owner-b", createdAt: atMinute(1) });
    insertEvidence(raw, { id: "owner-a-deleted", createdAt: atMinute(4), deletedAt: atMinute(5) });

    const first = await repository.listSourceEvidenceForOwner({ ownerUserId: "owner-a", limit: 2 });
    const second = await repository.listSourceEvidenceForOwner({
      ownerUserId: "owner-a",
      limit: 2,
      cursor: { createdAt: first.at(-1)!.createdAt, id: first.at(-1)!.id },
    });
    expect([...first, ...second].map((evidence) => evidence.id)).toEqual([
      "owner-a-1",
      "owner-a-2",
      "owner-a-3",
    ]);
    expect(first[0]).not.toHaveProperty("dataBase64");
    expect(first[0]).toMatchObject({ ownerUserId: "owner-a", externalUrl: "https://private.example/owner-a-1" });
  });

  it("lists submission links in sort order and isolates linked checks", async () => {
    const { repository, raw } = fixture();
    insertSubmission(raw, "submission-links", "approved");
    insertEvidence(raw, { id: "link-a" });
    insertEvidence(raw, { id: "link-b" });
    insertEvidence(raw, { id: "unlinked" });
    linkEvidence(raw, "submission-links", "link-b", 1);
    linkEvidence(raw, "submission-links", "link-a", 0);

    expect(await repository.listSubmissionSourceEvidenceIds({ submissionId: "submission-links", limit: 10 }))
      .toEqual(["link-a", "link-b"]);
    expect(await repository.listSubmissionSourceEvidenceIds({ submissionId: "submission-links", limit: 1 }))
      .toEqual(["link-a"]);
    expect(await repository.isSourceEvidenceLinked("link-a")).toBe(true);
    expect(await repository.isSourceEvidenceLinked("unlinked")).toBe(false);
  });

  it("fails closed on malformed native records and invalid bounds", async () => {
    const { repository, raw } = fixture();
    insertEvidence(raw, { id: "malformed-provider", storageProvider: "public_bucket" });
    await expectCode(repository.listSourceEvidenceForOwner({ ownerUserId: "owner-a", limit: 10 }), "malformed_record");
    await expectCode(repository.listExpiredSourceEvidence({
      now: "2026-02-30T00:00:00.000Z",
      hardCutoff: HARD_CUTOFF,
      limit: 10,
    }), "invalid_input");
    await expectCode(repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: atMinute(101),
      limit: 10,
    }), "invalid_input");
    await expectCode(repository.listExpiredSourceEvidence({
      now: NOW,
      hardCutoff: HARD_CUTOFF,
      limit: 501,
    }), "invalid_input");
    await expectCode(repository.listSubmissionSourceEvidenceIds({
      submissionId: "submission-links",
      limit: 1_001,
    }), "invalid_input");
    expect(new SourceEvidenceRetentionRepositoryError("retention_candidate_conflict").message)
      .toBe("The source-evidence retention candidate is stale or no longer eligible.");
  });
});
