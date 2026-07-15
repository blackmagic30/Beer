import crypto from "node:crypto";

import { logger } from "./logger.js";
import { redactSecrets } from "./redact.js";
import { getPreviousZonedMonthKey } from "./time.js";

const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";
const DELIVERY_STATE_VERSION = 3;
const DELIVERY_SEND_LEASE_MS = 15 * 60 * 1000;

export type ReportEmailMode = "disabled" | "mock" | "resend";
export type ReportDeliveryItemStatus = "sending" | "delivered" | "mocked" | "rejected" | "uncertain";

export interface ReportEmailAttachment {
  filename: string;
  contentBase64: string;
  contentType: string;
}

export interface ReportEmailMessage {
  from: string;
  to: string;
  replyTo?: string | undefined;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  attachments: ReportEmailAttachment[];
}

export interface ReportEmailProvider {
  readonly mode: Exclude<ReportEmailMode, "disabled">;
  send(message: ReportEmailMessage): Promise<{ id: string }>;
}

export class ReportEmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "uncertain",
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = "ReportEmailDeliveryError";
  }
}

export interface ReportDeliveryRepository {
  getVenueReportDeliverySettings?(venueId: string): {
    enabled: boolean;
    recipients: string[];
    configured: boolean;
  };
  setVenueReportDeliverySettings?(input: {
    venueId: string;
    enabled: boolean;
    recipients: string[];
    updatedBy: string;
    now: string;
  }): void;
  listVenueManagerAssignments(input: {
    venueId?: string | undefined;
    activeOnly?: boolean | undefined;
    limit: number;
  }): Array<{
    userId: string;
    venueId: string;
    accessLevel: "manager" | "counter_staff";
    status: string;
  }>;
  getAccountById(id: string): {
    id: string;
    email: string;
    emailVerifiedAt: string | null;
    ageConfirmedAt: string | null;
    role: string;
    status: string;
  } | null;
  getSystemState<T extends Record<string, unknown>>(key: string): { value: T; updatedAt: string } | null;
  setSystemState(key: string, value: Record<string, unknown>, now: string): void;
  compareAndSetSystemState(
    key: string,
    expectedUpdatedAt: string | null,
    value: Record<string, unknown>,
    now: string,
  ): boolean;
}

export interface ScheduledReportGenerator {
  generateScheduledVenueMonthlyReports(input: {
    month: string;
    venueId: string | null;
    dryRun: boolean;
  }): unknown;
}

interface GeneratedMonthlyReport {
  barId: string;
  month: string;
  data: Record<string, unknown>;
}

interface ReportDeliveryStateItem extends Record<string, unknown> {
  venueId: string;
  recipientKey: string;
  status: ReportDeliveryItemStatus;
  startedAt: string;
  completedAt: string | null;
  providerMessageId: string | null;
  error: string | null;
}

interface ReportDeliveryState extends Record<string, unknown> {
  version: number;
  month: string;
  providerMode: ReportEmailMode | "dry-run";
  scope: string;
  generatedAt: string;
  updatedAt: string;
  completedAt: string | null;
  generatedCount: number;
  items: Record<string, ReportDeliveryStateItem>;
}

export interface MonthlyReportDeliveryResult {
  month: string;
  dryRun: boolean;
  generatedCount: number;
  eligibleRecipientCount: number;
  deliveredCount: number;
  mockedCount: number;
  rejectedCount: number;
  uncertainCount: number;
  inProgressCount: number;
  skippedPreviouslyProcessedCount: number;
  skippedNoEligibleRecipientCount: number;
  skippedCounterStaffCount: number;
  skippedUnverifiedAccountCount: number;
  alreadyCompleted: boolean;
  stateKey: string;
}

export interface RunMonthlyReportDeliveryInput {
  generator: ScheduledReportGenerator;
  repository: ReportDeliveryRepository;
  provider: ReportEmailProvider | null;
  publicBaseUrl: string;
  from: string;
  replyTo?: string | undefined;
  timezone: string;
  month?: string | undefined;
  venueId?: string | null | undefined;
  dryRun?: boolean | undefined;
  retryRejected?: boolean | undefined;
  now?: Date | undefined;
}

export interface MonthlyReportSchedulerConfig extends Omit<RunMonthlyReportDeliveryInput, "month" | "venueId" | "dryRun" | "retryRejected" | "now"> {
  scheduleDay: number;
  scheduleHour: number;
  checkIntervalMinutes: number;
  initialDelayMs?: number | undefined;
  now?: (() => Date) | undefined;
  onStatus?: ((status: Record<string, unknown>) => void | Promise<void>) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutEmails = message.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[redacted-email]",
  );
  return String(redactSecrets(withoutEmails)).slice(0, 300);
}

function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  return new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "venue";
}

function recipientKey(venueId: string, email: string): string {
  return crypto
    .createHash("sha256")
    .update(`${venueId}\n${email.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

function deliveryScope(venueId: string | null | undefined): string {
  if (!venueId) return "all";
  const venueHash = crypto.createHash("sha256").update(venueId).digest("hex").slice(0, 16);
  return `venue-${venueHash}`;
}

function deliveryStateKey(month: string, providerMode: ReportEmailMode | "dry-run", venueId?: string | null): string {
  return `delivery:venue-monthly-report:${providerMode}:${month}:${deliveryScope(venueId)}`;
}

function recipientDeliveryStateKey(
  month: string,
  providerMode: ReportEmailMode | "dry-run",
  itemKey: string,
): string {
  return `delivery:venue-monthly-report:recipient:${providerMode}:${month}:${itemKey}`;
}

function deliveryLedgerRevision(timestamp: string): string {
  return `${timestamp}#${crypto.randomUUID()}`;
}

function getRecipientDeliveryState(
  repository: ReportDeliveryRepository,
  month: string,
  providerMode: ReportEmailMode | "dry-run",
  itemKey: string,
): { item: ReportDeliveryStateItem; updatedAt: string } | null {
  const stored = repository.getSystemState<ReportDeliveryStateItem>(
    recipientDeliveryStateKey(month, providerMode, itemKey),
  );
  const value = stored?.value;
  if (!value || value.recipientKey !== itemKey || typeof value.status !== "string") return null;
  return { item: value, updatedAt: stored.updatedAt };
}

function normalizeGeneratedReports(value: unknown): { generatedCount: number; reports: GeneratedMonthlyReport[] } {
  if (!isRecord(value) || !Array.isArray(value.reports)) {
    throw new Error("Monthly report generator returned an invalid result.");
  }

  const reports = value.reports.map((report): GeneratedMonthlyReport => {
    if (!isRecord(report) || typeof report.barId !== "string" || typeof report.month !== "string" || !isRecord(report.data)) {
      throw new Error("Monthly report generator returned an invalid report entry.");
    }
    return { barId: report.barId, month: report.month, data: report.data };
  });

  return {
    generatedCount: typeof value.generatedCount === "number" ? value.generatedCount : reports.length,
    reports,
  };
}

function getOrCreateDeliveryState(
  repository: ReportDeliveryRepository,
  month: string,
  providerMode: ReportEmailMode | "dry-run",
  venueId: string | null | undefined,
  now: string,
): { key: string; state: ReportDeliveryState } {
  const scope = deliveryScope(venueId);
  const key = deliveryStateKey(month, providerMode, venueId);
  const stored = repository.getSystemState<ReportDeliveryState>(key)?.value;
  if (
    stored &&
    stored.version === DELIVERY_STATE_VERSION &&
    stored.month === month &&
    stored.providerMode === providerMode &&
    stored.scope === scope &&
    isRecord(stored.items)
  ) {
    return { key, state: stored };
  }

  return {
    key,
    state: {
      version: DELIVERY_STATE_VERSION,
      month,
      providerMode,
      scope,
      generatedAt: now,
      updatedAt: now,
      completedAt: null,
      generatedCount: 0,
      items: {},
    },
  };
}

function persistDeliveryState(repository: ReportDeliveryRepository, key: string, state: ReportDeliveryState, now: string): void {
  state.updatedAt = now;
  repository.setSystemState(key, state, now);
}

function buildPortalUrl(publicBaseUrl: string, report: GeneratedMonthlyReport): string {
  const url = new URL("/venue-portal", publicBaseUrl);
  url.searchParams.set("venueId", report.barId);
  url.searchParams.set("month", report.month);
  return url.toString();
}

function buildReportEmail(input: {
  report: GeneratedMonthlyReport;
  recipientEmail: string;
  recipientKey: string;
  publicBaseUrl: string;
  from: string;
  replyTo?: string | undefined;
}): ReportEmailMessage {
  const venue = isRecord(input.report.data.venue) ? input.report.data.venue : {};
  const venueName = typeof venue.name === "string" && venue.name.trim() ? venue.name.trim() : "your venue";
  const label = monthLabel(input.report.month);
  const portalUrl = buildPortalUrl(input.publicBaseUrl, input.report);
  const attachmentName = `pint-path-${safeFilenamePart(input.report.barId)}-${input.report.month}-monthly-report.json`;
  const attachmentJson = `${JSON.stringify({
    venueId: input.report.barId,
    month: input.report.month,
    data: input.report.data,
  }, null, 2)}\n`;

  return {
    from: input.from,
    to: input.recipientEmail,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: `Your ${label} Pint Path venue report`,
    text: [
      `Your ${label} Pint Path report for ${venueName} is ready.`,
      "",
      `View the report securely in the venue portal: ${portalUrl}`,
      "",
      "A privacy-safe JSON copy is attached for your records.",
    ].join("\n"),
    html: [
      `<p>Your <strong>${escapeHtml(label)}</strong> Pint Path report for <strong>${escapeHtml(venueName)}</strong> is ready.</p>`,
      `<p><a href="${escapeHtml(portalUrl)}">View the report securely in the venue portal</a>.</p>`,
      "<p>A privacy-safe JSON copy is attached for your records.</p>",
    ].join(""),
    idempotencyKey: `pintpath-monthly/${input.report.month}/${safeFilenamePart(input.report.barId)}/${input.recipientKey}`,
    attachments: [{
      filename: attachmentName,
      contentBase64: Buffer.from(attachmentJson, "utf8").toString("base64"),
      contentType: "application/json",
    }],
  };
}

export function createResendReportEmailProvider(input: {
  apiKey: string;
  timeoutMs?: number | undefined;
  minimumIntervalMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}): ReportEmailProvider {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required when REPORT_EMAIL_MODE=resend.");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const minimumIntervalMs = Math.max(0, input.minimumIntervalMs ?? 550);
  let lastRequestStartedAt = 0;
  let requestSlot = Promise.resolve();

  const waitForRequestSlot = async () => {
    const previousSlot = requestSlot;
    let releaseSlot!: () => void;
    requestSlot = new Promise<void>((resolve) => { releaseSlot = resolve; });
    await previousSlot;
    try {
      const waitMs = Math.max(0, lastRequestStartedAt + minimumIntervalMs - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      lastRequestStartedAt = Date.now();
    } finally {
      releaseSlot();
    }
  };

  return {
    mode: "resend",
    async send(message) {
      await waitForRequestSlot();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response!: Response;
      let responseText = "";
      try {
        response = await fetchImpl(RESEND_EMAIL_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "idempotency-key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from: message.from,
            to: [message.to],
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
            subject: message.subject,
            html: message.html,
            text: message.text,
            attachments: message.attachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.contentBase64,
            })),
            tags: [
              { name: "message_type", value: "venue_monthly_report" },
            ],
          }),
          signal: controller.signal,
        });
        responseText = await response.text();
      } catch (error) {
        throw new ReportEmailDeliveryError(
          `Resend request outcome is uncertain: ${safeErrorMessage(error)}`,
          "uncertain",
        );
      } finally {
        clearTimeout(timeout);
      }

      let responseBody: Record<string, unknown> = {};
      try {
        const parsed = responseText ? JSON.parse(responseText) : {};
        responseBody = isRecord(parsed) ? parsed : {};
      } catch {
        responseBody = {};
      }

      if (!response.ok) {
        const responseMessage = typeof responseBody.message === "string"
          ? responseBody.message
          : `HTTP ${response.status}`;
        const uncertain = response.status === 408 || response.status === 409 || response.status >= 500;
        throw new ReportEmailDeliveryError(
          `Resend rejected the report email: ${String(redactSecrets(responseMessage)).slice(0, 240)}`,
          uncertain ? "uncertain" : "rejected",
          response.status,
        );
      }

      if (typeof responseBody.id !== "string" || !responseBody.id.trim()) {
        throw new ReportEmailDeliveryError(
          "Resend returned success without a message ID; delivery outcome is uncertain.",
          "uncertain",
          response.status,
        );
      }

      return { id: responseBody.id };
    },
  };
}

export function createMockReportEmailProvider(): ReportEmailProvider {
  return {
    mode: "mock",
    async send(message) {
      return { id: `mock-${crypto.createHash("sha256").update(message.idempotencyKey).digest("hex").slice(0, 16)}` };
    },
  };
}

export async function runMonthlyReportDelivery(input: RunMonthlyReportDeliveryInput): Promise<MonthlyReportDeliveryResult> {
  const nowDate = input.now ?? new Date();
  const now = nowDate.toISOString();
  const month = input.month ?? getPreviousZonedMonthKey(nowDate, input.timezone);
  const dryRun = input.dryRun ?? false;
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5));
  if (!/^\d{4}-\d{2}$/.test(month) || year < 2020 || year > 2100 || monthNumber < 1 || monthNumber > 12) {
    throw new Error("Monthly report delivery month must use YYYY-MM format.");
  }
  if (!dryRun && !input.provider) {
    throw new Error("Report email delivery is disabled; configure a provider or run with --dry-run.");
  }

  const providerMode = input.provider?.mode ?? (dryRun ? "dry-run" : "disabled");
  const { key, state } = getOrCreateDeliveryState(input.repository, month, providerMode, input.venueId, now);
  const result: MonthlyReportDeliveryResult = {
    month,
    dryRun,
    generatedCount: state.generatedCount,
    eligibleRecipientCount: 0,
    deliveredCount: 0,
    mockedCount: 0,
    rejectedCount: 0,
    uncertainCount: 0,
    inProgressCount: 0,
    skippedPreviouslyProcessedCount: 0,
    skippedNoEligibleRecipientCount: 0,
    skippedCounterStaffCount: 0,
    skippedUnverifiedAccountCount: 0,
    alreadyCompleted: false,
    stateKey: key,
  };
  if (!dryRun && !input.venueId && !input.retryRejected && state.completedAt) {
    return {
      ...result,
      alreadyCompleted: true,
      skippedPreviouslyProcessedCount: Object.keys(state.items).length,
    };
  }

  const generated = normalizeGeneratedReports(input.generator.generateScheduledVenueMonthlyReports({
    month,
    venueId: input.venueId ?? null,
    dryRun,
  }));
  if (generated.reports.some((report) => report.month !== month)) {
    throw new Error("Monthly report generator returned a report for the wrong month.");
  }
  if (input.venueId && generated.reports.some((report) => report.barId !== input.venueId)) {
    throw new Error("Monthly report generator returned a report outside the requested venue scope.");
  }
  result.generatedCount = generated.generatedCount;

  const currentRecipientKeys = new Set<string>();
  for (const report of generated.reports) {
    const eligible = new Map<string, { email: string }>();
    const deliverySettings = input.repository.getVenueReportDeliverySettings?.(report.barId);
    const verifiedManagers = new Map<string, { email: string }>();
    const assignments = input.repository.listVenueManagerAssignments({
      venueId: report.barId,
      activeOnly: true,
      limit: -1,
    });
    for (const assignment of assignments) {
      if (assignment.accessLevel !== "manager") {
        result.skippedCounterStaffCount += 1;
        continue;
      }
      const account = input.repository.getAccountById(assignment.userId);
      if (!account || account.status !== "active") continue;
      if (
        account.role !== "venue_manager" ||
        !account.ageConfirmedAt ||
        !account.emailVerifiedAt ||
        !account.email.trim()
      ) {
        result.skippedUnverifiedAccountCount += 1;
        continue;
      }
      const normalizedEmail = account.email.trim().toLowerCase();
      verifiedManagers.set(normalizedEmail, { email: normalizedEmail });
    }

    if (deliverySettings?.enabled !== false && deliverySettings?.recipients.length) {
      for (const email of deliverySettings.recipients) {
        const normalizedEmail = email.trim().toLowerCase();
        const verified = verifiedManagers.get(normalizedEmail);
        if (verified) eligible.set(normalizedEmail, verified);
      }
      if (!dryRun && eligible.size !== deliverySettings.recipients.length) {
        if (input.repository.setVenueReportDeliverySettings) {
          input.repository.setVenueReportDeliverySettings({
            venueId: report.barId,
            enabled: eligible.size > 0,
            recipients: [...eligible.keys()],
            updatedBy: "system:recipient-validation",
            now,
          });
        } else {
          input.repository.setSystemState(`venue-report-delivery:${report.barId}`, {
            enabled: eligible.size > 0,
            recipients: [...eligible.keys()],
            updatedBy: "system:recipient-validation",
            scrubbedReason: "recipient_no_longer_active_verified_manager",
          }, now);
        }
      }
    } else if (deliverySettings?.enabled !== false) {
      for (const [email, recipient] of verifiedManagers) eligible.set(email, recipient);
    }

    if (eligible.size === 0) {
      result.skippedNoEligibleRecipientCount += 1;
      continue;
    }

    for (const recipient of eligible.values()) {
      result.eligibleRecipientCount += 1;
      const itemKey = recipientKey(report.barId, recipient.email);
      currentRecipientKeys.add(itemKey);
      let storedRecipient = getRecipientDeliveryState(input.repository, month, providerMode, itemKey);
      let existing = storedRecipient?.item ?? state.items[itemKey];
      if (existing) state.items[itemKey] = existing;
      if (existing?.status === "sending") {
        const startedAt = Date.parse(existing.startedAt);
        const leaseIsFresh = Number.isFinite(startedAt) && nowDate.getTime() - startedAt < DELIVERY_SEND_LEASE_MS;
        if (leaseIsFresh) {
          result.inProgressCount += 1;
          result.skippedPreviouslyProcessedCount += 1;
          continue;
        }
        const uncertainItem: ReportDeliveryStateItem = {
          ...existing,
          status: "uncertain",
          completedAt: now,
          error: "A previous send lease expired without a provider result; reconcile it before retrying.",
        };
        const uncertainRevision = deliveryLedgerRevision(now);
        const transitioned = input.repository.compareAndSetSystemState(
          recipientDeliveryStateKey(month, providerMode, itemKey),
          storedRecipient?.updatedAt ?? null,
          uncertainItem,
          uncertainRevision,
        );
        if (!transitioned) {
          storedRecipient = getRecipientDeliveryState(input.repository, month, providerMode, itemKey);
          existing = storedRecipient?.item ?? existing;
          state.items[itemKey] = existing;
          result.inProgressCount += existing.status === "sending" ? 1 : 0;
          result.uncertainCount += existing.status === "uncertain" ? 1 : 0;
          result.skippedPreviouslyProcessedCount += 1;
          continue;
        }
        existing = uncertainItem;
        storedRecipient = { item: uncertainItem, updatedAt: uncertainRevision };
        state.items[itemKey] = uncertainItem;
        persistDeliveryState(input.repository, key, state, now);
      }
      const canRetry = input.retryRejected && existing?.status === "rejected";
      if (existing && !canRetry) {
        result.skippedPreviouslyProcessedCount += 1;
        if (existing.status === "rejected") result.rejectedCount += 1;
        if (existing.status === "uncertain") result.uncertainCount += 1;
        continue;
      }
      if (dryRun) continue;

      const message = buildReportEmail({
        report,
        recipientEmail: recipient.email,
        recipientKey: itemKey,
        publicBaseUrl: input.publicBaseUrl,
        from: input.from,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });
      const startedAt = new Date().toISOString();
      const sendingItem: ReportDeliveryStateItem = {
        venueId: report.barId,
        recipientKey: itemKey,
        status: "sending",
        startedAt,
        completedAt: null,
        providerMessageId: null,
        error: null,
      };
      const claimRevision = deliveryLedgerRevision(startedAt);
      const claimed = input.repository.compareAndSetSystemState(
        recipientDeliveryStateKey(month, providerMode, itemKey),
        storedRecipient?.updatedAt ?? null,
        sendingItem,
        claimRevision,
      );
      if (!claimed) {
        const claimedByOther = getRecipientDeliveryState(input.repository, month, providerMode, itemKey)?.item;
        if (claimedByOther) state.items[itemKey] = claimedByOther;
        result.inProgressCount += claimedByOther?.status === "sending" ? 1 : 0;
        result.rejectedCount += claimedByOther?.status === "rejected" ? 1 : 0;
        result.uncertainCount += claimedByOther?.status === "uncertain" ? 1 : 0;
        result.skippedPreviouslyProcessedCount += 1;
        continue;
      }
      state.items[itemKey] = sendingItem;
      persistDeliveryState(input.repository, key, state, startedAt);

      try {
        const delivered = await input.provider!.send(message);
        const completedAt = new Date().toISOString();
        const status = input.provider!.mode === "mock" ? "mocked" : "delivered";
        state.items[itemKey] = {
          ...state.items[itemKey]!,
          status,
          completedAt,
          providerMessageId: delivered.id,
          error: null,
        };
        const recorded = input.repository.compareAndSetSystemState(
          recipientDeliveryStateKey(month, providerMode, itemKey),
          claimRevision,
          state.items[itemKey]!,
          deliveryLedgerRevision(completedAt),
        );
        if (!recorded) {
          state.items[itemKey] = getRecipientDeliveryState(input.repository, month, providerMode, itemKey)?.item ?? {
            ...state.items[itemKey]!,
            status: "uncertain",
            providerMessageId: null,
            error: "Provider responded, but the atomic delivery ledger could not record the result.",
          };
          result.uncertainCount += 1;
          persistDeliveryState(input.repository, key, state, completedAt);
          continue;
        }
        persistDeliveryState(input.repository, key, state, completedAt);
        if (status === "mocked") result.mockedCount += 1;
        else result.deliveredCount += 1;
      } catch (error) {
        const completedAt = new Date().toISOString();
        const status = error instanceof ReportEmailDeliveryError ? error.outcome : "uncertain";
        state.items[itemKey] = {
          ...state.items[itemKey]!,
          status,
          completedAt,
          providerMessageId: null,
          error: safeErrorMessage(error),
        };
        const recorded = input.repository.compareAndSetSystemState(
          recipientDeliveryStateKey(month, providerMode, itemKey),
          claimRevision,
          state.items[itemKey]!,
          deliveryLedgerRevision(completedAt),
        );
        if (!recorded) {
          state.items[itemKey] = getRecipientDeliveryState(input.repository, month, providerMode, itemKey)?.item ?? {
            ...state.items[itemKey]!,
            status: "uncertain",
            error: "The atomic delivery ledger changed before the provider failure could be recorded.",
          };
        }
        persistDeliveryState(input.repository, key, state, completedAt);
        if (state.items[itemKey]!.status === "rejected") result.rejectedCount += 1;
        else result.uncertainCount += 1;
      }
    }
  }

  for (const itemKey of Object.keys(state.items)) {
    if (!currentRecipientKeys.has(itemKey)) delete state.items[itemKey];
  }

  if (!dryRun) {
    state.generatedCount = generated.generatedCount;
    const hasUnresolvedItems = Object.values(state.items)
      .some((item) => ["sending", "rejected", "uncertain"].includes(item.status));
    const hasPendingEligibility = generated.generatedCount === 0 ||
      result.skippedNoEligibleRecipientCount > 0 ||
      result.skippedUnverifiedAccountCount > 0;
    const hasActiveSend = result.inProgressCount > 0;
    state.completedAt = hasUnresolvedItems || hasPendingEligibility || hasActiveSend ? null : new Date().toISOString();
    persistDeliveryState(input.repository, key, state, state.completedAt ?? new Date().toISOString());
  }

  return result;
}

function getZonedScheduleParts(date: Date, timezone: string): { day: number; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { day: Number(parts.day), hour: Number(parts.hour) };
}

export function isMonthlyReportDeliveryDue(input: {
  now: Date;
  timezone: string;
  scheduleDay: number;
  scheduleHour: number;
}): boolean {
  const local = getZonedScheduleParts(input.now, input.timezone);
  return local.day > input.scheduleDay || (local.day === input.scheduleDay && local.hour >= input.scheduleHour);
}

export function scheduleMonthlyReportDelivery(config: MonthlyReportSchedulerConfig): { stop: () => Promise<void>; runNow: () => Promise<void> } {
  let activeRun: Promise<void> | null = null;
  let stopped = false;
  const reportStatus = async (status: Record<string, unknown>): Promise<void> => {
    try {
      await config.onStatus?.(status);
    } catch (error) {
      logger.error("Could not persist monthly venue report delivery status", {
        state: status.state,
        error: safeErrorMessage(error),
      });
    }
  };
  const execute = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (activeRun) return activeRun;
    const pending = (async () => {
      const now = config.now?.() ?? new Date();
      if (!isMonthlyReportDeliveryDue({
        now,
        timezone: config.timezone,
        scheduleDay: config.scheduleDay,
        scheduleHour: config.scheduleHour,
      })) return;

      const startedAt = now.toISOString();
      await reportStatus({ state: "running", startedAt, completedAt: null });
      try {
        const result = await runMonthlyReportDelivery({
          generator: config.generator,
          repository: config.repository,
          provider: config.provider,
          publicBaseUrl: config.publicBaseUrl,
          from: config.from,
          ...(config.replyTo ? { replyTo: config.replyTo } : {}),
          timezone: config.timezone,
          now,
        });
        const failed = result.rejectedCount + result.uncertainCount > 0;
        const pendingRecipients = result.generatedCount === 0 ||
          result.skippedNoEligibleRecipientCount > 0 ||
          result.skippedUnverifiedAccountCount > 0 ||
          result.inProgressCount > 0;
        await reportStatus({
          state: failed ? "failed" : pendingRecipients ? "waiting_for_recipients" : "succeeded",
          startedAt,
          completedAt: new Date().toISOString(),
          ...result,
        });
        if (failed) {
          logger.error("Monthly venue report delivery completed with failures", { ...result });
        } else if (pendingRecipients) {
          logger.warn("Monthly venue report delivery is waiting for eligible recipients", { ...result });
        } else if (result.deliveredCount > 0 || result.mockedCount > 0) {
          logger.info("Monthly venue report delivery completed", { ...result });
        }
      } catch (error) {
        const failure = {
          state: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          error: safeErrorMessage(error),
        };
        await reportStatus(failure);
        logger.error("Monthly venue report delivery failed", failure);
      }
    })();
    activeRun = pending
      .catch((error) => {
        logger.error("Monthly venue report delivery scheduler failed unexpectedly", {
          error: safeErrorMessage(error),
        });
      })
      .finally(() => {
        activeRun = null;
      });
    return activeRun;
  };

  const initialTimer = setTimeout(() => void execute(), config.initialDelayMs ?? 15_000);
  initialTimer.unref();
  const interval = setInterval(() => void execute(), config.checkIntervalMinutes * 60 * 1000);
  interval.unref();

  return {
    async stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
      await activeRun;
    },
    runNow: execute,
  };
}
