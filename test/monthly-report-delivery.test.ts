import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ReportEmailDeliveryError,
  createResendReportEmailProvider,
  isMonthlyReportDeliveryDue,
  runMonthlyReportDelivery,
  scheduleMonthlyReportDelivery,
  type ReportDeliveryRepository,
  type ReportEmailMessage,
  type ReportEmailProvider,
} from "../src/lib/monthly-report-delivery.js";

const baseMessage: ReportEmailMessage = {
  from: "Pint Path <reports@pintpath.au>",
  to: "owner@example.com",
  subject: "Monthly report",
  html: "<p>Ready</p>",
  text: "Ready",
  idempotencyKey: "pintpath-monthly/2026-06/venue-1/recipient-1",
  attachments: [{
    filename: "report.json",
    contentBase64: Buffer.from("{}", "utf8").toString("base64"),
    contentType: "application/json",
  }],
};

function createRepository(): ReportDeliveryRepository & {
  states: Map<string, Record<string, unknown>>;
  accounts: Map<string, { id: string; email: string; emailVerifiedAt: string | null; ageConfirmedAt: string | null; role: string; status: string }>;
  assignments: Array<{ userId: string; venueId: string; accessLevel: "manager" | "counter_staff"; status: string }>;
} {
  const states = new Map<string, Record<string, unknown>>();
  const stateUpdatedAt = new Map<string, string>();
  const accounts = new Map<string, { id: string; email: string; emailVerifiedAt: string | null; ageConfirmedAt: string | null; role: string; status: string }>([
    ["manager-1", { id: "manager-1", email: "owner@example.com", emailVerifiedAt: "2026-01-01T00:00:00.000Z", ageConfirmedAt: "2026-01-01T00:00:00.000Z", role: "venue_manager", status: "active" }],
    ["counter-1", { id: "counter-1", email: "counter@example.com", emailVerifiedAt: "2026-01-01T00:00:00.000Z", ageConfirmedAt: "2026-01-01T00:00:00.000Z", role: "venue_manager", status: "active" }],
    ["unverified-1", { id: "unverified-1", email: "unverified@example.com", emailVerifiedAt: null, ageConfirmedAt: "2026-01-01T00:00:00.000Z", role: "venue_manager", status: "active" }],
  ]);
  const assignments: Array<{ userId: string; venueId: string; accessLevel: "manager" | "counter_staff"; status: string }> = [
    { userId: "manager-1", venueId: "venue-1", accessLevel: "manager", status: "active" },
    { userId: "counter-1", venueId: "venue-1", accessLevel: "counter_staff", status: "active" },
    { userId: "unverified-1", venueId: "venue-1", accessLevel: "manager", status: "active" },
  ];

  return {
    states,
    accounts,
    assignments,
    listVenueManagerAssignments: (input) => assignments.filter((assignment) => !input.venueId || assignment.venueId === input.venueId),
    getAccountById: (id) => accounts.get(id) ?? null,
    getSystemState<T extends Record<string, unknown>>(key: string) {
      const value = states.get(key);
      return value ? { value: value as T, updatedAt: stateUpdatedAt.get(key) ?? "2026-07-02T00:00:00.000Z" } : null;
    },
    setSystemState(key, value, now) {
      states.set(key, structuredClone(value));
      stateUpdatedAt.set(key, now);
    },
    compareAndSetSystemState(key, expectedUpdatedAt, value, now) {
      const currentUpdatedAt = states.has(key)
        ? stateUpdatedAt.get(key) ?? "2026-07-02T00:00:00.000Z"
        : null;
      if (currentUpdatedAt !== expectedUpdatedAt) return false;
      states.set(key, structuredClone(value));
      stateUpdatedAt.set(key, now);
      return true;
    },
  };
}

describe("monthly report email provider", () => {
  it("uses Resend's authenticated endpoint, attachment payload, and idempotency header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email-123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const provider = createResendReportEmailProvider({
      apiKey: "re_test_report_key",
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(provider.send(baseMessage)).resolves.toEqual({ id: "email-123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer re_test_report_key",
      "idempotency-key": baseMessage.idempotencyKey,
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: baseMessage.from,
      to: [baseMessage.to],
      attachments: [{
        filename: "report.json",
        content: baseMessage.attachments[0]!.contentBase64,
      }],
    });
  });

  it("treats network failures as uncertain and never silently retries", async () => {
    const provider = createResendReportEmailProvider({
      apiKey: "re_test_report_key",
      fetchImpl: vi.fn(async () => {
        throw new Error("socket closed");
      }) as typeof fetch,
    });

    await expect(provider.send(baseMessage)).rejects.toMatchObject<Partial<ReportEmailDeliveryError>>({
      outcome: "uncertain",
    });
  });

  it("keeps the timeout active while the response body is still being read", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("response body aborted")), { once: true });
        },
      }),
      { status: 200 },
    ));
    const provider = createResendReportEmailProvider({
      apiKey: "re_test_report_key",
      timeoutMs: 5,
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(provider.send(baseMessage)).rejects.toMatchObject<Partial<ReportEmailDeliveryError>>({
      outcome: "uncertain",
    });
  });
});

describe("monthly report delivery job", () => {
  it("sends once per venue/month/verified manager and excludes counter staff", async () => {
    const repository = createRepository();
    repository.accounts.set("wrong-role", {
      id: "wrong-role",
      email: "wrong-role@example.com",
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
      ageConfirmedAt: "2026-01-01T00:00:00.000Z",
      role: "user",
      status: "active",
    });
    repository.accounts.set("no-age", {
      id: "no-age",
      email: "no-age@example.com",
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
      ageConfirmedAt: null,
      role: "venue_manager",
      status: "active",
    });
    repository.assignments.push(
      { userId: "wrong-role", venueId: "venue-1", accessLevel: "manager", status: "active" },
      { userId: "no-age", venueId: "venue-1", accessLevel: "manager", status: "active" },
    );
    const send = vi.fn(async () => ({ id: "email-123" }));
    const provider: ReportEmailProvider = { mode: "resend", send };
    const generator = {
      generateScheduledVenueMonthlyReports: vi.fn(() => ({
        generatedCount: 1,
        reports: [{
          barId: "venue-1",
          month: "2026-06",
          data: { venue: { id: "venue-1", name: "Report Hotel" }, summary: { directionsClicks: 12 } },
        }],
      })),
    };

    const first = await runMonthlyReportDelivery({
      generator,
      repository,
      provider,
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
      now: new Date("2026-07-02T00:00:00.000Z"),
    });
    const second = await runMonthlyReportDelivery({
      generator,
      repository,
      provider,
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
      now: new Date("2026-07-02T01:00:00.000Z"),
    });

    expect(first).toMatchObject({
      deliveredCount: 1,
      eligibleRecipientCount: 1,
      skippedCounterStaffCount: 1,
      skippedUnverifiedAccountCount: 3,
    });
    expect(second).toMatchObject({ deliveredCount: 0, skippedPreviouslyProcessedCount: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const sentMessage = send.mock.calls[0]![0];
    expect(sentMessage.idempotencyKey).toMatch(/^pintpath-monthly\/2026-06\/venue-1\/[a-f0-9]{32}$/);
    expect(sentMessage.to).toBe("owner@example.com");
    expect(sentMessage.html).toContain("https://pintpath.au/venue-portal?venueId=venue-1&amp;month=2026-06");
    expect(JSON.stringify([...repository.states.values()])).not.toContain("owner@example.com");
  });

  it("supports a no-send dry run while delivery remains disabled", async () => {
    const repository = createRepository();
    const result = await runMonthlyReportDelivery({
      generator: {
        generateScheduledVenueMonthlyReports: () => ({
          generatedCount: 1,
          reports: [{ barId: "venue-1", month: "2026-06", data: { venue: { name: "Report Hotel" } } }],
        }),
      },
      repository,
      provider: null,
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
      dryRun: true,
    });

    expect(result).toMatchObject({ dryRun: true, eligibleRecipientCount: 1, deliveredCount: 0 });
    expect(repository.states.size).toBe(0);
  });

  it("rejects invalid calendar months before generating a report", async () => {
    const repository = createRepository();
    const generator = { generateScheduledVenueMonthlyReports: vi.fn() };

    await expect(runMonthlyReportDelivery({
      generator,
      repository,
      provider: null,
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-13",
      dryRun: true,
    })).rejects.toThrow("YYYY-MM");
    await expect(runMonthlyReportDelivery({
      generator,
      repository,
      provider: null,
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "0000-01",
      dryRun: true,
    })).rejects.toThrow("YYYY-MM");
    expect(generator.generateScheduledVenueMonthlyReports).not.toHaveBeenCalled();
  });

  it("redacts recipient addresses from persisted provider errors", async () => {
    const repository = createRepository();
    repository.assignments.splice(1);
    const provider: ReportEmailProvider = {
      mode: "resend",
      send: vi.fn(async () => {
        throw new ReportEmailDeliveryError("Rejected recipient owner@example.com", "rejected", 422);
      }),
    };

    const result = await runMonthlyReportDelivery({
      generator: {
        generateScheduledVenueMonthlyReports: () => ({
          generatedCount: 1,
          reports: [{ barId: "venue-1", month: "2026-06", data: { venue: { name: "Report Hotel" } } }],
        }),
      },
      repository,
      provider,
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
    });

    expect(result.rejectedCount).toBe(1);
    const persisted = JSON.stringify([...repository.states.values()]);
    expect(persisted).toContain("[redacted-email]");
    expect(persisted).not.toContain("owner@example.com");
  });

  it("turns an interrupted sending state into an explicit uncertain outcome without resending", async () => {
    const repository = createRepository();
    repository.assignments.splice(1);
    const provider: ReportEmailProvider = { mode: "resend", send: vi.fn(async () => ({ id: "unexpected" })) };
    // Match the production recipient key for venue-1 and owner@example.com.
    const actualItemKey = crypto.createHash("sha256").update("venue-1\nowner@example.com").digest("hex").slice(0, 32);
    repository.states.set("delivery:venue-monthly-report:resend:2026-06:all", {
      version: 3,
      month: "2026-06",
      providerMode: "resend",
      scope: "all",
      generatedAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      completedAt: null,
      generatedCount: 1,
      items: {
        [actualItemKey]: {
          venueId: "venue-1",
          recipientKey: actualItemKey,
          status: "sending",
          startedAt: "2026-07-02T00:00:00.000Z",
          completedAt: null,
          providerMessageId: null,
          error: null,
        },
      },
    });

    const result = await runMonthlyReportDelivery({
      generator: {
        generateScheduledVenueMonthlyReports: () => ({
          generatedCount: 1,
          reports: [{ barId: "venue-1", month: "2026-06", data: { venue: { name: "Report Hotel" } } }],
        }),
      },
      repository,
      provider,
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
      now: new Date("2026-07-02T01:00:00.000Z"),
    });

    expect(result).toMatchObject({ uncertainCount: 1, skippedPreviouslyProcessedCount: 1 });
    expect(provider.send).not.toHaveBeenCalled();
    expect(JSON.stringify([...repository.states.values()])).toContain("reconcile it before retrying");
  });

  it("keeps the month incomplete until an assigned manager verifies their email", async () => {
    const repository = createRepository();
    repository.assignments.splice(2, 1);
    repository.accounts.get("manager-1")!.emailVerifiedAt = null;
    const generator = {
      generateScheduledVenueMonthlyReports: vi.fn(() => ({
        generatedCount: 1,
        reports: [{ barId: "venue-1", month: "2026-06", data: { venue: { name: "Report Hotel" } } }],
      })),
    };
    const send = vi.fn(async () => ({ id: "email-verified-later" }));
    const common = {
      generator,
      repository,
      provider: { mode: "resend" as const, send },
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
    };

    const beforeVerification = await runMonthlyReportDelivery(common);
    repository.accounts.get("manager-1")!.emailVerifiedAt = "2026-07-03T00:00:00.000Z";
    const afterVerification = await runMonthlyReportDelivery(common);

    expect(beforeVerification).toMatchObject({
      deliveredCount: 0,
      skippedNoEligibleRecipientCount: 1,
      skippedUnverifiedAccountCount: 1,
    });
    expect(afterVerification.deliveredCount).toBe(1);
    expect(generator.generateScheduledVenueMonthlyReports).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps targeted venue state separate from the full monthly batch", async () => {
    const repository = createRepository();
    repository.assignments.splice(1);
    repository.accounts.set("manager-2", {
      id: "manager-2",
      email: "second-owner@example.com",
      emailVerifiedAt: "2026-01-01T00:00:00.000Z",
      ageConfirmedAt: "2026-01-01T00:00:00.000Z",
      role: "venue_manager",
      status: "active",
    });
    repository.assignments.push({
      userId: "manager-2",
      venueId: "venue-2",
      accessLevel: "manager",
      status: "active",
    });
    const generator = {
      generateScheduledVenueMonthlyReports: vi.fn(({ venueId }: { venueId: string | null }) => ({
        generatedCount: venueId ? 1 : 2,
        reports: (venueId ? [venueId] : ["venue-1", "venue-2"]).map((barId) => ({
          barId,
          month: "2026-06",
          data: { venue: { name: barId } },
        })),
      })),
    };
    const send = vi.fn(async () => ({ id: "email-id" }));
    const common = {
      generator,
      repository,
      provider: { mode: "resend" as const, send },
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
    };

    const targeted = await runMonthlyReportDelivery({ ...common, venueId: "venue-1" });
    const global = await runMonthlyReportDelivery(common);

    expect(targeted).toMatchObject({ deliveredCount: 1, alreadyCompleted: false });
    expect(global).toMatchObject({ deliveredCount: 1, skippedPreviouslyProcessedCount: 1, alreadyCompleted: false });
    expect(targeted.stateKey).not.toBe(global.stateKey);
    expect(generator.generateScheduledVenueMonthlyReports).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("atomically claims a recipient so overlapping workers send only once", async () => {
    const repository = createRepository();
    repository.assignments.splice(1);
    let releaseSend!: (value: { id: string }) => void;
    const send = vi.fn(() => new Promise<{ id: string }>((resolve) => { releaseSend = resolve; }));
    const common = {
      generator: {
        generateScheduledVenueMonthlyReports: () => ({
          generatedCount: 1,
          reports: [{ barId: "venue-1", month: "2026-06", data: { venue: { name: "Report Hotel" } } }],
        }),
      },
      repository,
      provider: { mode: "resend" as const, send },
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
    };

    const firstWorker = runMonthlyReportDelivery(common);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const overlappingWorker = await runMonthlyReportDelivery(common);
    expect(overlappingWorker).toMatchObject({
      deliveredCount: 0,
      inProgressCount: 1,
      skippedPreviouslyProcessedCount: 1,
    });

    releaseSend({ id: "one-provider-message" });
    await expect(firstWorker).resolves.toMatchObject({ deliveredCount: 1, inProgressCount: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("removes superseded rejected recipients when a manager changes verified email", async () => {
    const repository = createRepository();
    repository.assignments.splice(1);
    const send = vi.fn(async (message: ReportEmailMessage) => {
      if (message.to === "owner@example.com") {
        throw new ReportEmailDeliveryError("old recipient rejected", "rejected", 422);
      }
      return { id: "new-address-delivered" };
    });
    const common = {
      generator: {
        generateScheduledVenueMonthlyReports: () => ({
          generatedCount: 1,
          reports: [{ barId: "venue-1", month: "2026-06", data: { venue: { name: "Report Hotel" } } }],
        }),
      },
      repository,
      provider: { mode: "resend" as const, send },
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
    };

    await expect(runMonthlyReportDelivery(common)).resolves.toMatchObject({ rejectedCount: 1, deliveredCount: 0 });
    repository.accounts.get("manager-1")!.email = "new-owner@example.com";
    await expect(runMonthlyReportDelivery(common)).resolves.toMatchObject({ rejectedCount: 0, deliveredCount: 1 });
    await expect(runMonthlyReportDelivery(common)).resolves.toMatchObject({ alreadyCompleted: true });

    const batchState = [...repository.states.entries()]
      .find(([key]) => key === "delivery:venue-monthly-report:resend:2026-06:all")?.[1];
    expect(Object.values((batchState?.items ?? {}) as Record<string, unknown>)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects generator output outside the requested month or venue before sending", async () => {
    const repository = createRepository();
    repository.assignments.splice(1);
    const send = vi.fn(async () => ({ id: "must-not-send" }));
    const common = {
      repository,
      provider: { mode: "resend" as const, send },
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      month: "2026-06",
      venueId: "venue-1",
    };

    await expect(runMonthlyReportDelivery({
      ...common,
      generator: {
        generateScheduledVenueMonthlyReports: () => ({
          generatedCount: 1,
          reports: [{ barId: "venue-1", month: "2026-05", data: {} }],
        }),
      },
    })).rejects.toThrow("wrong month");
    await expect(runMonthlyReportDelivery({
      ...common,
      generator: {
        generateScheduledVenueMonthlyReports: () => ({
          generatedCount: 1,
          reports: [{ barId: "venue-2", month: "2026-06", data: {} }],
        }),
      },
    })).rejects.toThrow("outside the requested venue scope");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("monthly report schedule", () => {
  it("becomes due at the configured Melbourne-local day and hour", () => {
    expect(isMonthlyReportDeliveryDue({
      now: new Date("2026-07-01T22:59:59.000Z"),
      timezone: "Australia/Melbourne",
      scheduleDay: 2,
      scheduleHour: 9,
    })).toBe(false);
    expect(isMonthlyReportDeliveryDue({
      now: new Date("2026-07-01T23:00:00.000Z"),
      timezone: "Australia/Melbourne",
      scheduleDay: 2,
      scheduleHour: 9,
    })).toBe(true);
    expect(isMonthlyReportDeliveryDue({
      now: new Date("2026-07-14T00:00:00.000Z"),
      timezone: "Australia/Melbourne",
      scheduleDay: 2,
      scheduleHour: 9,
    })).toBe(true);
  });

  it("generates the previous completed Melbourne month only once after it is due", async () => {
    const repository = createRepository();
    repository.assignments.splice(2, 1);
    const generator = {
      generateScheduledVenueMonthlyReports: vi.fn(({ month }: { month: string }) => ({
        generatedCount: 1,
        reports: [{ barId: "venue-1", month, data: { venue: { name: "Report Hotel" } } }],
      })),
    };
    const send = vi.fn(async () => ({ id: "email-123" }));
    const scheduler = scheduleMonthlyReportDelivery({
      generator,
      repository,
      provider: { mode: "resend", send },
      publicBaseUrl: "https://pintpath.au",
      from: "Pint Path <reports@pintpath.au>",
      timezone: "Australia/Melbourne",
      scheduleDay: 2,
      scheduleHour: 9,
      checkIntervalMinutes: 60,
      initialDelayMs: 60_000,
      now: () => new Date("2026-07-14T00:00:00.000Z"),
    });

    await scheduler.runNow();
    await scheduler.runNow();
    scheduler.stop();

    expect(generator.generateScheduledVenueMonthlyReports).toHaveBeenCalledTimes(1);
    expect(generator.generateScheduledVenueMonthlyReports).toHaveBeenCalledWith({
      month: "2026-06",
      venueId: null,
      dryRun: false,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
