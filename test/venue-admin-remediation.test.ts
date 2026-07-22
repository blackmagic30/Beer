import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const portal = fs.readFileSync(path.resolve(process.cwd(), "viewer/venue-portal.html"), "utf8");
const admin = fs.readFileSync(path.resolve(process.cwd(), "viewer/admin.html"), "utf8");
const css = fs.readFileSync(path.resolve(process.cwd(), "viewer/business.css"), "utf8");

function sourceBetween(source: string, start: string, end: string) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
}

describe("venue and admin remediation", () => {
  it("round-trips legacy opening hours and preserves unknown venue tags", () => {
    expect(portal).toContain('const legacyOpenTime = typeof day.open === "string" ? day.open : null;');
    expect(portal).toContain('const legacyCloseTime = typeof day.close === "string" ? day.close : null;');
    expect(portal).toContain("loadedOpeningHours = structuredClone(source)");
    expect(portal).toContain("...existing,");
    expect(portal).toContain("const preservedUnknownTags = loadedVenueTags.filter((tag) => !tagOptions.includes(tag));");
    expect(portal).toContain("venueTags: [...new Set([...preservedUnknownTags, ...checkedValues(venueTags)])]");
    expect(portal).toContain('id="publicProfilePreview"');
    expect(portal).toContain("Canonical venue:");
  });

  it("uses structured schedules, dedicated price verification, and evidence-backed analytics", () => {
    expect(portal).toContain('name="recurrence"');
    expect(portal).toContain("daysOfWeek: specialDaysOfWeek");
    expect(portal).toContain("timezone: openingHoursTimezone");
    expect(portal).toContain("function priceVerificationAt");
    expect(portal).toContain("beer?.priceVerifiedAt || beer?.lastVerifiedAt || beer?.priceLastVerifiedAt");
    expect(portal).toContain('name="priceConfirmed"');
    expect(portal).toContain('name="stockConfirmed"');
    expect(portal).toContain("/beers/bulk");
    expect(portal).toContain("expectedUpdatedAt: beer.updatedAt || null");
    expect(portal).toContain("expectedUpdatedAt: currentPortal?.profile?.updatedAt || null");
    expect(portal).toContain("Your edits are still here; review the latest venue data before retrying.");
    expect(portal).toContain("currentPortal?.inventory?.happyHours?.find((item) => item.id === field(happyHourForm, \"id\").value)?.updatedAt || null");
    expect(portal).toContain("currentPortal?.inventory?.specials?.find((item) => item.id === field(specialForm, \"id\").value)?.updatedAt || null");
    expect(portal).toContain('route === "beers"');
    expect(portal).toContain("currentPortal?.inventory?.beers?.find((item) => item.id === id)");
    expect(portal).toContain("JSON.stringify({ expectedUpdatedAt: versionedItem.updatedAt })");
    expect(portal).toContain("Refresh the venue before deciding whether to remove the newer version.");
    expect(portal).not.toContain("const PREMIUM_VENUE_MOCK");
    expect(portal).toContain("function firstMetric");
    expect(portal).toContain('return value === undefined ? null : Number(value);');
    expect(portal).toContain('suppressedMetrics.has(key) || value === null || value === undefined');
  });

  it("logs venue managers out of the local provider session before redirecting", () => {
    expect(portal).toContain('getSupabaseClient()?.auth.signOut({ scope: "local" })');
    expect(portal.indexOf('getSupabaseClient()?.auth.signOut({ scope: "local" })'))
      .toBeLessThan(portal.indexOf('window.location.assign("/account.html")'));
  });

  it("retains pending receipt evidence for reconciliation but erases expired authorization", () => {
    expect(portal).toContain("const pendingCounterAuthorizations = new Map()");
    expect(portal).toContain("pendingCounterAuthorizations.delete(entry.id)");
    expect(portal).toContain("const { checkoutToken: _checkoutToken, ...nonSecretPayload } = entry.payload || {}");
    expect(portal).toContain("reconciliationOnly: true");
    expect(portal).toContain("Expired checkout authorization is erased automatically while the non-secret receipt details remain");
    expect(portal).toContain("Authorization is not held in memory; reconcile manually");
    expect(portal).not.toContain("COUNTER_RECEIPT_QUEUE_TTL_MS");
    expect(portal).not.toContain("COUNTER_RECEIPT_RECONCILIATION_GRACE_MS");
  });

  it("ignores stale venue switches and does not expose dead recommendation buttons", () => {
    expect(portal).toContain("let portalRequestSequence = 0");
    expect(portal).toContain("const requestSequence = ++portalRequestSequence");
    expect(portal).toContain("if (requestSequence !== portalRequestSequence)");
    expect(portal).not.toContain('<button class="premiumActionItem" type="button">');
    expect(portal).toContain('<div class="premiumActionItem"><span>${index + 1}</span>');
  });

  it("labels the manager venue selection for assistive technology", () => {
    expect(admin).toContain('<label class="field">Selected venue');
    expect(admin).toContain('<select id="managerVenueSelect" aria-describedby="managerAssignPreview"></select>');
  });

  it("removes revoked venue managers from the current assignment workflow", () => {
    expect(admin).toContain('["active", "pending"].includes(assignment.status)');
    expect(admin).toContain("Venue manager revoked and removed from current assignments.");
  });

  it("announces admin async notices and sends venue support replies to the requested email", () => {
    expect(admin).toContain('element.setAttribute("role", isWarning ? "alert" : "status")');
    expect(admin).toContain('element.setAttribute("aria-live", isWarning ? "assertive" : "polite")');
    expect(portal).toContain("contactEmail: body.contactEmail || null");
    expect(portal).not.toContain('body.contactEmail ? `Reply email: ${body.contactEmail}`');
  });

  it("guards claim and admin lookup results against stale responses", () => {
    expect(portal).toContain("let venueClaimSearchRequestId = 0");
    expect(portal).toContain("if (requestId !== venueClaimSearchRequestId) return;");
    expect(admin).toContain("let adminGoogleVenueSearchRequestId = 0");
    expect(admin).toContain("let managerUserSearchRequestId = 0");
    expect(admin).toContain("let adminLoadRequestId = 0");
  });

  it("commits only the latest admin loader page and query", () => {
    expect(admin).toContain("let accountDeletionRequestId = 0");
    expect(admin).toContain("let securityAuditRequestId = 0");
    expect(admin).toContain("let adminMissionRequestId = 0");
    expect(admin).toContain("let adminBeerCatalogReviewRequestId = 0");
    expect(admin).toContain("let venuePartnerRequestId = 0");
    expect(admin).toContain("let adminStatusRequestId = 0");
    expect(admin).toContain("let adminVenuesRequestId = 0");
    expect(admin).toContain("let adminDataToolsRequestId = 0");
    expect(admin).toContain("requestedOffset !== accountDeletionOffset");
    expect(admin).toContain("requestedOffset !== securityAuditOffset");
    expect(admin).toContain("requestedQuery !== securityAuditRequestParams(requestedOffset).toString()");
    expect(admin).toContain("requestedOffset !== adminMissionOffset");
    expect(admin).toContain("requestedOffset !== adminBeerCatalogOffset");
    expect(admin).toContain("function hasActiveBeerCatalogMergeDraft()");
    expect(admin).toContain("beerCatalogPanelRequestId !== null");
    expect(admin).toContain("requestedOffset !== venuePartnerOffset");
    expect(admin).toContain("requestId !== adminStatusRequestId");
    expect(admin).toContain("requestId !== adminVenuesRequestId");
    expect(admin).toContain("requestId !== adminDataToolsRequestId");
    expect(admin).toContain("requestId === adminDataToolsRequestId && refreshButton instanceof HTMLButtonElement");
    expect(admin).toContain("if (requestId === adminRefreshRequestId && button)");
    expect(admin).toContain("if (requestId === adminBeerCatalogRefreshRequestId) refreshBeerCatalogButton.disabled = false;");

    const deletionLoader = sourceBetween(admin, "async function loadAccountDeletionRequests", "function securityAuditRequestParams");
    expect(deletionLoader.indexOf("requestId !== accountDeletionRequestId")).toBeLessThan(deletionLoader.indexOf("renderAccountDeletionRequests(data)"));
    const securityLoader = sourceBetween(admin, "async function loadSecurityAudit", "async function loadAdminAccountSessions");
    expect(securityLoader.indexOf("requestedQuery !== securityAuditRequestParams")).toBeLessThan(securityLoader.indexOf("list.innerHTML = logs.length"));
    const missionLoader = sourceBetween(admin, "async function loadAdminMissions", "async function updateAdminMissionLifecycle");
    expect(missionLoader.indexOf("requestId !== adminMissionRequestId")).toBeLessThan(missionLoader.indexOf("adminMissions = missions"));
    const partnerLoader = sourceBetween(admin, "async function loadVenuePartnerPage", "function moveVenuePartnerPage");
    expect(partnerLoader.indexOf("requestId !== venuePartnerRequestId")).toBeLessThan(partnerLoader.indexOf("renderVenuePartners(data)"));
  });

  it("reports monthly generation and delivery using the backend response contract", () => {
    expect(admin).toContain("result.generatedCount ?? result.reports?.length ?? 0");
    expect(admin).toContain("result.deliveredCount || 0");
    expect(admin).toContain("result.mockedCount || 0");
    expect(admin).toContain("result.rejectedCount || 0");
    expect(admin).toContain("result.uncertainCount || 0");
    expect(admin).toContain("result.inProgressCount || 0");
    expect(admin).toContain("result.skippedPreviouslyProcessedCount || 0");
    expect(admin).toContain("hasDeliveryIssue");
    expect(admin).not.toContain("result.generated ?? result.delivered");
  });

  it("guards navigation and counter workflows against destructive or duplicate actions", () => {
    expect(portal).toContain("const PORTAL_TAB_NAMES = new Set");
    expect(portal).toContain("function handlePortalTabKeydown");
    expect(portal).toContain("confirmDiscardPortalChanges");
    expect(portal).toContain('window.addEventListener("beforeunload"');
    expect(portal).toContain("function duplicateBeerDraft");
    expect(portal).toContain("function duplicateHappyHourDraft");
    expect(portal).toContain('window.sessionStorage.setItem(COUNTER_RECEIPT_QUEUE_KEY');
    expect(portal).not.toContain('window.localStorage.setItem(COUNTER_RECEIPT_QUEUE_KEY');
    expect(portal).toContain("const existing = entries.find((entry) => entry.id === id);");
    expect(portal).toContain("JSON.stringify(existing.payload) === JSON.stringify(nonSecretPayload)");
    expect(portal).toContain("? { id, saved: true, idempotent: true }");
    expect(portal).toContain(": { id, saved: false, conflict: true }");
    expect(portal).toContain("if (queuedReceipt.conflict)");
    expect(portal).toContain("The original receipt is still saved; reconcile it or use a new reference");
    expect(portal).toContain("error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500");
    expect(portal).toContain("Discount redemption does not separately award Pint Points.");
    expect(portal).toContain("Add a rejection reason of at least 4 characters.");
    expect(portal).toContain("/reconciliation?limit=50&offset=");
    expect(portal).toContain('data-reconciliation-offset=');
    expect(portal).toContain('id="reconciliationPanel" class="panel" data-manager-only');
    expect(portal).toContain('name="phone" type="tel" autocomplete="tel" inputmode="tel"');
    expect(portal).toContain('name="website" type="url" autocomplete="url" inputmode="url"');
    expect(portal).toContain('name="instagram" type="url" autocomplete="url" inputmode="url"');
    const counterRenderBranch = portal.match(/if \(data\.accessLevel === "counter_staff"\) \{[\s\S]*?\n\s+return;\n\s+\}/)?.[0] || "";
    expect(counterRenderBranch).not.toContain("loadVenueReconciliation(0)");
    expect(portal).toContain("10-minute handover window");
    expect(portal).not.toContain("target.dataset.copyPosToken");
    expect(portal).toContain("function scrubRedemptionCodesFromUrl");
    expect(portal).toContain('url.searchParams.delete("discountCode")');
    expect(portal).toContain('url.searchParams.delete("freePintCode")');
    expect(portal.indexOf("await loadPortal(urlParams.get(\"venueId\"));")).toBeLessThan(portal.indexOf("scrubRedemptionCodesFromUrl();"));
    expect(portal.indexOf("scrubRedemptionCodesFromUrl();")).toBeLessThan(portal.indexOf("if (discountCodeFromQr) await checkMemberCode();"));
  });

  it("hydrates role navigation from HttpOnly-cookie account responses", () => {
    expect(portal).toContain("if (data?.account)");
    expect(portal).toContain("MelbBeerBusiness.setAccountContext(data.account, { isAdmin: data.isAdmin });");
    expect(portal).toContain('nav.innerHTML = MelbBeerBusiness.renderNav("venue-portal");');
    expect(admin).toContain('accountResult = await MelbBeerBusiness.apiFetch("/api/business/account")');
    expect(admin).toContain("MelbBeerBusiness.setAccountContext(accountResult.account, accountResult.access);");
    expect(admin).toContain('nav.innerHTML = MelbBeerBusiness.renderNav("admin");');
    expect(admin).toContain("accountResult?.access?.isAdminAccount !== true");
    expect(admin).toContain("accountResult.access.isAdmin !== true");
    expect(admin).toContain('href: "/account.html?next=%2Fadmin.html"');
  });

  it("shows venue billing availability and portal errors beside the action", () => {
    expect(portal).toContain("data.billing?.managementAvailable === true");
    expect(portal).toContain("no paid Stripe billing profile is linked");
    expect(portal).toContain("data-venue-billing-status");
    expect(portal).toContain("Stripe did not return a billing portal address");
    expect(portal).toContain('portalUrl.hostname === "billing.stripe.com"');
    expect(portal).toContain("billingStatus?.scrollIntoView");
  });

  it("paginates every admin trust queue instead of hiding rows after the first response page", () => {
    expect(admin).toContain('id="adminReviewQueuePager"');
    expect(admin).toContain("const ADMIN_REVIEW_QUEUE_PAGE_SIZE = 25");
    expect(admin).toContain("/api/business/admin/queues?limit=${ADMIN_REVIEW_QUEUE_PAGE_SIZE}&offset=${adminReviewQueueOffset}");
    expect(admin).toContain("pagination.hasMore || {}");
    expect(admin).toContain("adminReviewQueueOffset += ADMIN_REVIEW_QUEUE_PAGE_SIZE");
  });

  it("does not expose dead private-evidence links while authenticated previews load or fail", () => {
    expect(admin).not.toContain('href="${item.hasImageData ? "#"');
    expect(admin).toContain('aria-disabled="true">Loading evidence...</span>');
    expect(admin).toContain('data-ingestion-evidence-image-link class="adminSourceEvidence__imageLink"');
    expect(admin).toContain('link.append(image)');
    expect(admin).toContain('imageLink.replaceWith(link)');
    expect(admin).toContain('openPlaceholder.replaceWith(link)');
    expect(admin).toContain('imageLink.replaceWith(errorMessage)');
    expect(admin).toContain('openPlaceholder.textContent = "Evidence unavailable"');
  });

  it("keeps every pending submission reachable and reports the server total", () => {
    expect(admin).toContain('id="pendingSubmissionsPager"');
    expect(admin).toContain("const ADMIN_SUBMISSION_PAGE_SIZE = 50");
    expect(admin).toContain("status=pending&limit=${ADMIN_SUBMISSION_PAGE_SIZE}&offset=${adminSubmissionOffset}&includeReviewData=true");
    expect(admin).toContain("adminSubmissionTotal = Number(submissions.pagination?.total");
    expect(admin).toContain("adminSubmissionOffset += ADMIN_SUBMISSION_PAGE_SIZE");
    expect(admin).toContain("submissionTotal: adminSubmissionTotal");
    expect(admin).toContain("pendingSubmissionTotal = Number(submissionTotal");
  });

  it("keeps every pending beer catalogue item reachable", () => {
    expect(admin).toContain('id="pendingBeerCatalogPager"');
    expect(admin).toContain("const ADMIN_BEER_CATALOG_PAGE_SIZE = 50");
    expect(admin).toContain("pendingLimit=${ADMIN_BEER_CATALOG_PAGE_SIZE}&pendingOffset=${requestedOffset}&activeLimit=100&activeOffset=0");
    expect(admin).toContain("adminBeerCatalogTotal = Number(data?.totals?.pending");
    expect(admin).toContain("adminBeerCatalogOffset += ADMIN_BEER_CATALOG_PAGE_SIZE");
    expect(admin).toContain("async function loadActiveBeerCatalogTargets");
    expect(admin).toContain("const requestedQuery = String(query || \"\").trim();");
    expect(admin).toContain("activeQ: requestedQuery");
    expect(admin).toContain("findAdminCatalogTarget(targetInput.value, searchedTargets)");
  });

  it("loads every venue for admin capture and assignment selectors", () => {
    expect(admin).toContain("async function loadAdminVenues()");
    expect(admin).toContain("/api/business/venues?limit=${pageSize}&offset=${offset}");
    expect(admin).toContain("if (!result.pagination?.hasMore) break;");
    expect(admin).toContain("Venue lookup pagination stopped before every venue loaded.");
  });

  it("rejects unsupported or oversized admin images before FileReader allocation", () => {
    const acceptedImages = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";
    expect(admin).toContain(`id="adminMenuPhoto" type="file" accept="${acceptedImages}"`);
    expect(admin).toContain(`id="adminSourceImage" type="file" accept="${acceptedImages}"`);
    expect(admin).toContain("const ADMIN_IMAGE_MAX_RAW_BYTES = 25 * 1024 * 1024");
    expect(admin).toContain("if (!isSupportedAdminImage(file))");
    expect(admin).toContain("if (Number(file.size || 0) > ADMIN_IMAGE_MAX_RAW_BYTES)");
    expect(admin.indexOf("if (!isSupportedAdminImage(file))")).toBeLessThan(admin.indexOf("const rawDataUrl = await readFileAsDataUrl(file)"));
    expect(admin).toContain("Source images must be 25MB or smaller before OCR or queueing.");
  });

  it("keeps admin panels usable independently and lazy-loads protected evidence", () => {
    expect(admin).toContain("escapeHtml(row.suburb)");
    expect(admin).toContain("escapeHtml(cohort.cohort)");
    expect(admin).toContain('id="adminPanelErrors"');
    expect(admin).toContain("const settledPanels = await Promise.allSettled");
    expect(admin).toContain("Working panels remain available.");
    expect(admin).toContain("async function hydrateSubmissionEvidencePreview");
    expect(admin).toContain('new IntersectionObserver((entries) =>');
    expect(admin).toContain("previews.slice(index, index + 4)");
    expect(admin).toContain("function handleAdminTabKeydown");
    expect(admin).toContain("updateAdminTabUrl");
  });

  it("pages all venue partner queues and keeps review controls reachable", () => {
    expect(admin).toContain('id="venuePartnerPager"');
    expect(admin).toContain('id="venuePartnerReviewPager"');
    expect(admin).toContain("payload.venuePartners?.totals?.pendingChanges ?? pendingChanges.length");
    expect(admin).toContain("data.venuePartners?.totals?.openOutreach ?? pageOpenOutreach");
    expect(admin).toContain("data.totals?.openOutreach ?? openItems.length");
    expect(admin).toContain('label: "Open overall"');
    expect(admin).toContain("function partnerLeadRelationshipMaps(partnerData = {})");
    expect(admin).toContain("context.outreachByVenueId");
    expect(admin).toContain("context.assignedVenueIds");
    expect(admin).toContain("const VENUE_PARTNER_PAGE_SIZE = 50");
    expect(admin).toContain("/api/business/admin/venue-partners?limit=${VENUE_PARTNER_PAGE_SIZE}&offset=${requestedOffset}");
    expect(admin).toContain("Object.values(data?.pagination?.hasMore || {}).some(Boolean)");
    expect(admin).toContain("moveVenuePartnerPage(1)");
  });

  it("exposes audited account containment, mission lifecycle, report operations and job freshness", () => {
    expect(admin).toContain('id="securityAuditList"');
    expect(admin).toContain("/api/business/admin/security-audit");
    expect(admin).toContain('id="adminAccountSessions"');
    expect(admin).toContain("/sessions/${encodeURIComponent(button.dataset.revokeAccountSession)}");
    expect(admin).toContain('id="adminAccountSessionPager"');
    expect(admin).toContain("/sessions?limit=${ADMIN_ACCOUNT_SESSION_PAGE_SIZE}&offset=${requestedOffset}");
    expect(admin).toContain("adminAccountSessionOffset += ADMIN_ACCOUNT_SESSION_PAGE_SIZE");
    expect(admin).toContain('id="adminMissionList"');
    expect(admin).toContain("/api/business/admin/missions?limit=${ADMIN_MISSION_PAGE_SIZE}&offset=${requestedOffset}");
    expect(admin).toContain('id="adminMissionPager"');
    expect(admin).toContain("adminMissionOffset += ADMIN_MISSION_PAGE_SIZE");
    expect(admin).toContain("/api/business/admin/account-deletions?limit=${ACCOUNT_DELETION_PAGE_SIZE}&offset=${requestedOffset}");
    expect(admin).toContain('id="accountDeletionAuditReason"');
    expect(admin).toContain("body: JSON.stringify({ reason })");
    expect(admin).toContain('id="accountDeletionPager"');
    expect(admin).toContain('["pending_review", "approved", "failed", "processing"].includes(request.status)');
    expect(admin).toContain('request.status === "failed"');
    expect(admin).toContain('? "Retry deletion"');
    expect(admin).toContain('? "Retry if stalled"');
    expect(admin).toContain('id="adminReportOpsForm"');
    expect(admin).toContain("/api/business/admin/reports/monthly/deliver");
    expect(admin).toContain('return { label: "Stale"');
    expect(portal).toContain('id="reportDeliveryForm"');
    expect(portal).toContain("/report-delivery");
    expect(css).toContain(".venuePortalHasUnsavedChanges");
    expect(css).toContain("#securityAuditList pre");
  });
});
