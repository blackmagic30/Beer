import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

function accountHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/account.html"), "utf8");
}

function mapHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");
}

function adminHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/admin.html"), "utf8");
}

function businessJs() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.js"), "utf8");
}

function loadBusinessHelpers() {
  const localStorage = new Map<string, string>();
  const context = {
    URL,
    URLSearchParams,
    crypto: { randomUUID: () => "test-uuid" },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    window: {
      MELB_BEER_BOT_VIEWER_CONFIG: { business: { fieldTestMode: true } },
      location: { origin: "https://pintpath.au", search: "" },
      localStorage: {
        getItem: (key: string) => localStorage.get(key) || null,
        setItem: (key: string, value: string) => localStorage.set(key, String(value)),
        removeItem: (key: string) => localStorage.delete(key),
        key: (index: number) => Array.from(localStorage.keys())[index] || null,
        get length() {
          return localStorage.size;
        },
      },
      addEventListener: () => undefined,
    },
  };
  vm.createContext(context);
  vm.runInContext(businessJs(), context);
  return (context.window as {
    MelbBeerBusiness: {
      renderNav: (active?: string) => string;
      setAccountContext: (account: Record<string, unknown> | null) => void;
    };
  }).MelbBeerBusiness;
}

function navLinkLabels(markup: string) {
  return Array.from(markup.matchAll(/href="[^"]+">([^<]+)<\/a>/g), (match) => match[1]);
}

function htmlBetween(html: string, start: string, end: string) {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex + start.length);
  expect(startIndex, start).toBeGreaterThanOrEqual(0);
  expect(endIndex, end).toBeGreaterThan(startIndex);
  return html.slice(startIndex, endIndex);
}

function businessCss() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.css"), "utf8");
}

function businessServiceTs() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/modules/business/business.service.ts"), "utf8");
}

function callbackHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/auth/callback.html"), "utf8");
}

function resetPasswordHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/reset-password.html"), "utf8");
}

function resendConfirmationHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/resend-confirmation.html"), "utf8");
}

function feedbackHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/feedback.html"), "utf8");
}

function termsHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/terms.html"), "utf8");
}

function privacyHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/privacy.html"), "utf8");
}

function trustHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/trust.html"), "utf8");
}

function communityHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/community.html"), "utf8");
}

function securityHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/security.html"), "utf8");
}

function statusHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/status.html"), "utf8");
}

function viewerHtmlFiles(directory = path.resolve(process.cwd(), "viewer")): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return viewerHtmlFiles(filePath);
    }
    return entry.isFile() && entry.name.endsWith(".html") ? [filePath] : [];
  });
}

describe("account page shell", () => {
  it("installs Pint Path logo assets and favicon metadata across every viewer page", () => {
    const script = businessJs();
    const css = businessCss();
    const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "viewer/site.webmanifest"), "utf8")) as {
      icons: Array<{ src: string; sizes: string; type: string }>;
    };
    const requiredAssets = [
      "viewer/favicon.ico",
      "viewer/favicon.png",
      "viewer/assets/pint-path-logo.png",
      "viewer/assets/pint-path-icon-192.png",
      "viewer/assets/pint-path-icon-512.png",
      "viewer/assets/pint-path-apple-touch-icon.png",
    ];

    requiredAssets.forEach((assetPath) => {
      expect(fs.existsSync(path.resolve(process.cwd(), assetPath))).toBe(true);
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/assets/pint-path-icon-192.png", sizes: "192x192", type: "image/png" }),
        expect.objectContaining({ src: "/assets/pint-path-icon-512.png", sizes: "512x512", type: "image/png" }),
      ]),
    );
    expect(script).toContain('class="brandLogo" src="/assets/pint-path-icon-192.png"');
    expect(mapHtml()).toContain('class="mapBrandLogo" src="/assets/pint-path-icon-192.png"');
    expect(css).toContain(".brandLogo");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.brandText\s*\{[\s\S]*display:\s*none;/);

    viewerHtmlFiles().forEach((filePath) => {
      const html = fs.readFileSync(filePath, "utf8");
      expect(html, filePath).toContain('href="/favicon.ico"');
      expect(html, filePath).toContain('href="/favicon.png"');
      expect(html, filePath).toContain('href="/assets/pint-path-icon-192.png"');
      expect(html, filePath).toContain('rel="apple-touch-icon"');
      expect(html, filePath).toContain('href="/site.webmanifest"');
      expect(html, filePath).toContain('property="og:image" content="https://pintpath.au/assets/pint-path-logo.png"');
    });
  });

  it("renders separate logged-out auth and logged-in dashboard states", () => {
    const html = accountHtml();

    expect(html).toContain('id="loggedOutView"');
    expect(html).toContain('id="accountDashboard"');
    expect(html).toContain("Pint Path Contributor Account");
    expect(html).not.toContain("Contributor dashboard");
    expect(html).not.toContain("Quick beer price upload");
    expect(html).toContain("Manage your Pint Path account");
    expect(html).toContain('id="accountSettingsHub"');
    expect(html).not.toContain("Account active. Uploads and verification actions are tracked against your signed-in user.");
    expect(html).not.toContain('id="premiumMemberHub"');
    expect(html).not.toContain("renderPremiumMemberHub");
    expect(html).toContain("Recent submissions");
    expect(html).toContain('id="displayNameForm"');
    expect(html).toContain('id="settingsBetaTestingPanel"');
    expect(html).toContain('id="betaTestingNavButton"');
    expect(html).toContain("Click here to show other beta testing features.");
    expect(html).toContain('id="leaderboardPodium"');
    expect(html.indexOf('id="settingsStatsPanel"')).toBeLessThan(html.indexOf('id="betaFeatureLeaderboard"'));
    expect(html.indexOf('id="displayNameForm"')).toBeGreaterThan(html.indexOf('id="betaFeatureLeaderboard"'));
    expect(html.indexOf('id="displayNameForm"')).toBeLessThan(html.indexOf('id="leaderboardPodium"'));
    expect(html).toContain('id="rewardVoucherList"');
    expect(html).toContain('id="pubGolfForm"');
    expect(html).toContain('data-beta-feature-target="can-i-drive"');
    expect(html).toContain('id="canIDriveForm"');
    expect(html).toContain("Ranks 4-50");
    expect(html).toContain("betaLeaderboardRow--me");
    expect(html).toContain("betaLeaderboardRow--outside");
    expect(html).toContain("Venue added to the public map");
    expect(html).toContain("submissionPendingNotice");
    expect(html).toContain('id="authStatus" class="notice" role="status" aria-live="polite" aria-atomic="true" hidden></div>');
    expect(html).toContain('id="dashboardStatus" class="notice" role="status" aria-live="polite" aria-atomic="true" hidden></div>');
    expect(html).toContain("function hideAccountStatus");
    expect(html).toContain("quietAuthMessages");
    expect(html).toContain('hideAccountStatus($("dashboardStatus"))');
    expect(html).not.toContain("How verification works");
    expect(html).toContain("Pint Path special");
    expect(html).not.toContain("Pint Path discount pass");
    expect(html).not.toContain('href="/stats.html"');
    expect(html).toContain('data-settings-target="stats"');
    expect(html).not.toContain("Current status");
  });

  it("hides the auth shell after a successful account fetch", () => {
    const html = accountHtml();

    expect(html).toContain('$("loggedOutView").hidden = true');
    expect(html).toContain('$("accountDashboard").hidden = false');
    expect(html).toContain('$("accountDashboard").classList.remove("is-hidden")');
    expect(html).toContain('$("loggedOutView").hidden = false');
    expect(html).toContain('$("accountDashboard").hidden = true');
    expect(html).toContain('$("accountDashboard").classList.add("is-hidden")');
  });

  it("keeps hidden account states visually hidden even when display utility classes are present", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain('id="accountDashboard" class="dashboardMain accountDashboard is-hidden" hidden');
    expect(html).toContain('id="accountEmail">Not signed in</strong>');
    expect(html).toContain('id="accountEmailHelper" class="accountEmailHelper" hidden');
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
  });

  it("labels Apple Hide My Email relay addresses clearly", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain("function isApplePrivateRelayEmail");
    expect(html).toContain("@privaterelay\\.appleid\\.com");
    expect(html).toContain("Apple private email");
    expect(html).toContain("Apple is forwarding Pint Path emails through Hide My Email.");
    expect(html).toContain("renderAccountEmail(account)");
    expect(css).toContain(".accountEmailHelper");
  });

  it("does not show logged-out confirmation when no session existed", () => {
    const html = accountHtml();

    expect(html).toContain("const hadApiToken = Boolean(MelbBeerBusiness.getAuthToken())");
    expect(html).toContain("hadApiToken || hadSupabaseSession ? \"You have been logged out.\" : \"Enter your details to continue.\"");
  });

  it("can resume premium checkout after account session refresh", () => {
    const html = accountHtml();

    expect(html).toContain("function pendingCheckoutPlan");
    expect(html).toContain("function pendingStripeCheckoutSessionId");
    expect(html).toContain('plan === "monthly" || plan === "yearly"');
    expect(html).toContain("checkoutResumeStarted");
    expect(html).toContain("checkoutReconcileStarted");
    expect(html).toContain("async function resumeCheckoutIfRequested");
    expect(html).toContain("async function reconcileCheckoutReturnIfNeeded");
    expect(html).toContain('MelbBeerBusiness.apiFetch("/api/business/billing/checkout"');
    expect(html).toContain('MelbBeerBusiness.apiFetch("/api/business/billing/checkout/reconcile"');
    expect(html).toContain("Confirm you are 18+ on this account before starting checkout.");
    expect(html).toContain("Opening ${plan} checkout");
    expect(html).toContain("Confirming your Stripe checkout");
    expect(html).toContain("session_id");
    expect(html).toContain("await resumeCheckoutIfRequested(result)");
    expect(html).toContain("await reconcileCheckoutReturnIfNeeded()");
  });

  it("keeps contributor evidence copy private and reviewer-focused", () => {
    const html = accountHtml();
    const trust = trustHtml();

    expect(html).toContain("Private evidence");
    expect(html).toContain("Submitted data stays pending until verified or approved.");
    expect(trust).toContain("Source photos, receipts, upload-location proof, OCR evidence, and reviewer notes are private review material.");
  });

  it("keeps contact on a dedicated page instead of clustering the account dashboard", () => {
    const html = accountHtml();
    const feedback = feedbackHtml();
    const script = businessJs();
    const css = businessCss();

    expect(html).not.toContain('id="feedbackForm"');
    expect(html).toContain('href="/feedback.html"');
    expect(feedback).toContain('id="feedbackForm"');
    expect(feedback).toContain("Tell us what you need, or ask about joining as a venue.");
    expect(feedback).toContain("venue_partner_interest");
    expect(feedback).toContain("Account deletion starts as a review request.");
    expect(feedback).toContain("Use this form until launch contacts are final.");
    expect(feedback).toContain("Do not include passwords, card numbers, private keys, or ID documents");
    expect(feedback).toContain('MelbBeerBusiness.renderNav(isVenueSupport ? "venue-support" : "feedback")');
    expect(feedback).toContain("Ask Pint Path about your venue account.");
    expect(feedback).toContain("Venue support messages are saved into the Pint Path admin support inbox.");
    expect(feedback).toContain('MelbBeerBusiness.apiFetch("/api/business/feedback"');
    expect(feedback.indexOf("Privacy note")).toBeLessThan(feedback.indexOf('id="feedbackForm"'));
    expect(css).toContain("margin-top: clamp(14px, 2.2vw, 24px);");
    expect(script).toContain('{ key: "feedback", href: venueManagerNav ? "/feedback.html?audience=bars" : "/feedback.html", label: venueManagerNav ? "Support" : "Contact us" }');
    expect(script).not.toContain('href="/account.html#feedbackForm"');
    expect(script).not.toContain("fieldTestFeedbackButton");
    expect(script).not.toContain("floatingFeedback");
  });

  it("moves account actions into submit flows and a settings hub", () => {
    const html = accountHtml();

    expect(html).not.toContain('class="accountActionsGrid"');
    expect(html).not.toContain('href="/submit.html?type=photo_upload"');
    expect(html).not.toContain('href="#recentSubmissionsSection"');
    expect(html).not.toContain('href="/stats.html"');
    expect(html).not.toContain('href="/submit.html">Open Submit');
    expect(html).toContain('data-settings-target="submissions"');
    expect(html).toContain('data-settings-target="stats"');
    expect(html.indexOf('data-settings-target="stats"')).toBeLessThan(html.indexOf('data-settings-target="submissions"'));
    expect(html).not.toContain('data-settings-target="preferences"');
    expect(html).not.toContain('data-settings-target="watchlist"');
    expect(html).toContain('data-settings-target="privacy"');
    expect(html).toContain('data-settings-target="support"');
    expect(html).toContain('data-settings-target="security"');
    expect(html).toContain('class="panel form accountSupportPanel"');
    expect(html).toContain('class="accountSupportIntro"');
    expect(html).toContain('class="accountSupportFields"');
    expect(html).not.toContain("Suggested missions");
    expect(html).not.toContain('id="suggestedMissions"');
    expect(html).not.toContain("function missionSubmitHref");
    expect(html).not.toContain('id="quickVenueSelect"');
    expect(html).not.toContain("function clearQuickVenue");
    expect(html).not.toContain("submitQuickUpload");
  });

  it("keeps account hero cards only inside My Stats", () => {
    const html = accountHtml();
    const css = businessCss();
    const submissionsPanel = htmlBetween(html, 'id="settingsSubmissionsPanel"', 'id="settingsStatsPanel"');
    const statsPanel = htmlBetween(html, 'id="settingsStatsPanel"', 'id="settingsBetaTestingPanel"');
    const betaTestingPanel = htmlBetween(html, 'id="settingsBetaTestingPanel"', 'id="settingsPrivacyPanel"');
    const privacyPanel = htmlBetween(html, 'id="settingsPrivacyPanel"', 'id="settingsSupportPanel"');
    const supportPanel = htmlBetween(html, 'id="settingsSupportPanel"', 'id="settingsSecurityPanel"');
    const securityPanel = html.slice(html.indexOf('id="settingsSecurityPanel"'), html.indexOf("</section>", html.indexOf('id="settingsSecurityPanel"')));

    expect(html).toContain('class="accountHighlightsGrid"');
    expect(html).not.toContain("Start here");
    expect(html).not.toContain("accountQuickStart");
    expect(css).not.toContain("accountQuickStart");
    expect(html).not.toContain('id="accountIdMetric"');
    expect(html).toContain('id="savingsMetric"');
    expect(html).toContain('id="refreshDiscountPassButton"');
    expect(html).toContain('id="discountPassModal"');
    expect(html).toContain('data-close-discount-pass-modal');
    expect(html).toContain("Pint Path special");
    expect(html).toContain("openDiscountPassModal()");
    expect(html).toContain("closeDiscountPassModal({ quiet: true })");
    expect(html).not.toContain('id="totalUploadsMetric"');
    expect(html).not.toContain('id="pendingMetric"');
    expect(html).not.toContain('id="leaderboardMetric"');
    expect(html).toContain('id="settingsStatsPanel"');
    expect(html).toContain('id="accountStatsGrid"');
    expect(html).toContain("function renderAccountStatsPanel");
    expect(html).toContain("renderAccountStatsPanel(result)");
    expect(html).toContain("accountStatsProgressCard");
    expect(html).toContain("same premium map access as a paid user");
    expect(html).toContain("Account ID");
    expect(html).toContain("accountStatCard--");
    expect(html).toContain('class="accountDashboardIntro sectionHeader"');
    expect(html.indexOf('id="accountDashboardTitle"')).toBeLessThan(html.indexOf('id="accountSettingsHub"'));
    expect(html.indexOf('class="settingsNav"')).toBeLessThan(html.indexOf('class="accountHighlightsGrid"'));
    expect(statsPanel).toContain('class="accountHighlightsGrid"');
    [submissionsPanel, betaTestingPanel, privacyPanel, supportPanel, securityPanel].forEach((panel) => {
      expect(panel).not.toContain('class="accountHighlightsGrid"');
      expect(panel).not.toContain("accountHeroMetric--savings");
      expect(panel).not.toContain("accountHeroMetric--special");
    });
    expect(html).toContain("accountHeroMetric--savings");
    expect(html).toContain("accountHeroMetric--special");
    expect(html.indexOf('label: "Total saved"')).toBeLessThan(html.indexOf('label: "Total uploads"'));
    expect(html.indexOf('label: "Total uploads"')).toBeLessThan(html.indexOf('label: "Verified"'));
    expect(html.indexOf('label: "Verified"')).toBeLessThan(html.indexOf('label: "Pending review"'));
    expect(html.indexOf('label: "Rejected"')).toBeLessThan(html.indexOf('label: "Trust score"'));
    expect(css).toContain(".accountHighlightsGrid");
    expect(css).toContain("margin: clamp(14px, 1.8vw, 20px) 0;");
    expect(css).toContain(".accountDashboardIntro");
    expect(css).toContain(".accountHeroMetric--savings");
    expect(css).toContain(".accountHeroMetric--special");
    expect(css).toContain(".accountAccessBadge--monthly");
    expect(css).toContain(".accountAccessBadge--yearly");
    expect(css).toContain(".accountAccessBadge--freemium");
    expect(css).toContain(".accountStatsGrid");
    expect(css).toContain("display: grid;");
    expect(css).toContain(".accountStatsProgressCard");
    expect(css).toContain(".accountStatCard .helperCopy");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.accountStatsGrid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.accountStatCard \.helperCopy\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.settingsNav\s*\{[\s\S]*overflow-x:\s*auto;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.accountHighlightsGrid\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountStatsGrid \.metricCard\s*\{[\s\S]*min-height:\s*104px;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountDiscountFeature \.sectionHeader p,[\s\S]*\.accountDiscountFeature > \.helperCopy\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountDashboardIntro \.button\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountIdentityCard--compact strong\s*\{[\s\S]*white-space:\s*nowrap;[\s\S]*text-overflow:\s*ellipsis;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountAccessBadgeRow\s*\{[\s\S]*flex-wrap:\s*nowrap;[\s\S]*overflow-x:\s*auto;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountAccessBadge\s*\{[\s\S]*font-size:\s*0\.56rem;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountAccessBadgeRow \.accountAccessBadge:not\(:first-child\)\s*\{[\s\S]*display:\s*none;/);
    expect(css).toContain(".accountDiscountFeature");
    expect(css).toContain(".discountPassModal");
    expect(css).toContain(".discountPassModalClose");
    expect(css).toContain(".nameRuleHint");
    expect(css).toContain(".betaFeatureHint");
    expect(css).toContain(".betaTestingPanel");
    expect(css).toContain(".leaderboardPodium");
    expect(css).toContain(".podiumCard--rank3");
    expect(css).toContain(".betaLeaderboardRow--me");
    expect(css).toContain(".accountSupportPanel");
    expect(css).toContain(".accountSupportFields");
    expect(css).toContain(".rewardVoucherCard");
    expect(css).toContain(".pubGolfDrinkGrid");
    expect(css).toContain(".canIDrivePanel");
  });

  it("adds a guarded Can I Drive beta calculator without giving driving clearance", () => {
    const html = accountHtml();
    const css = businessCss();
    const service = businessServiceTs();

    expect(html).toContain('id="betaFeatureCanIDrive"');
    expect(html).toContain('data-beta-feature-panel="can-i-drive"');
    expect(html).toContain("Can I Drive?");
    expect(html).toContain("No calculator can tell you that.");
    expect(html).toContain("This is not legal advice, medical advice, or a real breath test.");
    expect(html).toContain("Pint Path does not approve drinking and driving.");
    expect(html).toContain("Pint Path is not responsible for decisions made from this fun calculator.");
    expect(html).toContain("Do not drive after drinking.");
    expect(html).toContain('name="heightCm"');
    expect(html).toContain('name="weightKg"');
    expect(html).toContain('name="extraStandardDrinks"');
    expect(html).toContain("CAN_I_DRIVE_PROFILE_KEY");
    expect(html).toContain("AU_STANDARD_DRINK_GRAMS");
    expect(html).toContain("BAC_ELIMINATION_PER_HOUR");
    expect(html).toContain("function estimateStandardDrinksForRecord");
    expect(html).toContain("function calculateEstimatedBac");
    expect(html).toContain("function calculateCanIDriveEstimate");
    expect(html).toContain("renderCanIDrivePanel(result)");
    expect(html).toContain("renderCanIDriveEstimate(estimate)");
    expect(html).toContain("No calculator can say yes.");
    expect(html).not.toContain("Safe to drive");

    expect(css).toContain(".canIDriveWarningStack");
    expect(css).toContain(".canIDriveMetricGrid");
    expect(css).toContain(".canIDriveDrinkRow");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.canIDriveMetricGrid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.canIDriveMetricGrid\s*\{[\s\S]*grid-template-columns:\s*1fr;/);
    expect(service).toContain("listPintPointDrinkRecordsForUser(account.id, 25)");
    expect(service).toContain("canIDrive");
    expect(service).toContain("This never provides a driving clearance.");
  });

  it("opens account settings sections on demand instead of rendering every panel open", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain('id="settingsEmptyPanel"');
    expect(html).toContain('data-settings-target="submissions" aria-controls="settingsSubmissionsPanel"');
    expect(html).toContain('data-settings-target="stats" aria-controls="settingsStatsPanel"');
    expect(html).not.toContain('href="#recentSubmissionsSection"');
    expect(html).not.toContain('href="/stats.html"');
    expect(html).toContain('data-settings-panel="submissions" role="tabpanel" aria-labelledby="settingsSubmissionsTab" hidden');
    expect(html).toContain('data-settings-panel="stats" role="tabpanel" aria-labelledby="settingsStatsTab" hidden');
    expect(html).not.toContain('data-settings-panel="preferences" role="tabpanel" hidden');
    expect(html).not.toContain('data-settings-panel="watchlist" role="tabpanel" hidden');
    expect(html).toContain('data-settings-panel="privacy" role="tabpanel" aria-labelledby="settingsPrivacyTab" hidden');
    expect(html).toContain('data-settings-panel="support" role="tabpanel" aria-labelledby="settingsSupportTab" hidden');
    expect(html).toContain('data-settings-panel="security" role="tabpanel" aria-labelledby="settingsSecurityTab" hidden');
    expect(html).toContain('id="betaTestingNavButton"');
    expect(html).toContain('data-settings-target="beta-testing"');
    expect(html).toContain('aria-controls="settingsBetaTestingPanel"');
    expect(html).toContain('data-settings-panel="beta-testing" role="tabpanel" aria-labelledby="betaTestingNavButton" hidden');
    expect(html).toContain("function showAccountSettingsPanel");
    expect(html).toContain('document.querySelectorAll("[data-settings-target]")');
    expect(html).toContain("showAccountSettingsPanel(button.dataset.settingsTarget)");
    expect(html).toContain("function requestedSettingsPanel");
    expect(html).toContain("showAccountSettingsPanel(requestedSettingsPanel())");
    expect(html).toContain("renderBetaTestingPanel(result)");
    expect(html).toContain('MelbBeerBusiness.apiFetch("/api/business/beta/pub-golf/plan"');
    expect(html).not.toContain('id="privacyControlsSection"');
    expect(css).toContain(".settingsNavButton");
    expect(css).toContain(".settingsPanel");
    expect(css).toContain(".settingsEmptyPanel");
    expect(css).not.toContain(".accountDashboard #premiumMemberHub");
    expect(css).not.toContain(".premiumMemberHub");
    expect(css).toContain(".accountDashboard #accountSettingsHub");
    expect(css).toMatch(/\.accountDashboard \.accountDashboardIntro\s*\{[^}]*order:\s*1;/s);
    expect(css).toMatch(/\.accountDashboard #accountSettingsHub\s*\{[^}]*order:\s*3;/s);
    expect(css).not.toContain(".accountDashboard .accountHighlightsGrid");
    expect(css).not.toContain(".accountDashboard .accountPrimaryGrid");
  });

  it("uses Supabase OAuth and email auth before falling back to local demo auth", () => {
    const html = accountHtml();
    const script = businessJs();

    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Apple");
    expect(html).not.toContain("Continue with Facebook");
    expect(html.indexOf("Welcome back")).toBeLessThan(html.indexOf("Continue with Google"));
    expect(html.indexOf("Reset password")).toBeLessThan(html.indexOf("Continue with Google"));
    expect(html).toContain("MelbBeerBusiness.signUpWithEmail");
    expect(html).toContain("MelbBeerBusiness.signInWithEmail");
    expect(html).toContain('class="authUtilityGrid" aria-label="Account recovery links"');
    expect(html).toContain('id="passwordResetLink" class="authUtilityCard" href="/reset-password.html"');
    expect(html).toContain('id="resendConfirmationLink" class="authUtilityCard" href="/resend-confirmation.html"');
    expect(html).toContain('authUtilityLink("/reset-password.html")');
    expect(html).toContain('authUtilityLink("/resend-confirmation.html")');
    expect(html).toContain('authUtilityLink("/resend-confirmation.html", body.email)');
    expect(html).toContain("If no link arrives within a minute, use Resend confirmation.");
    expect(html).toContain("No Supabase confirmation email was sent.");
    expect(html).not.toContain('id="oauthTermsAccepted"');
    expect(html).not.toContain('id="oauthPrivacyAccepted"');
    expect(html).not.toContain("before using social login");
    expect(html).toContain("Google and Apple sign-in appears");
    expect(script).toContain("signInWithOAuth({");
    expect(script).toContain('provider,');
    expect(script).toContain("signInWithPassword");
    expect(script).toContain("signUp({");
    expect(script).toContain("resendSignupConfirmation");
    expect(script).toContain("auth.resend({");
    expect(script).toContain('type: "signup"');
    expect(script).toContain("/auth/callback");
    expect(script).toContain('/reset-password.html?mode=update');
    expect(script).toContain("updateUser({ password })");
    expect(script).toContain("terms_accepted");
    expect(script).toContain("privacy_accepted");
    expect(script).toContain("applyPendingLegalAcceptance");
  });

  it("provides dedicated confirmation resend and password reset pages", () => {
    const reset = resetPasswordHtml();
    const resend = resendConfirmationHtml();

    expect(resend).toContain("Resend your confirmation email");
    expect(resend).toContain('id="resendConfirmationForm"');
    expect(resend).toContain('id="confirmationEmail"');
    expect(resend).toContain("MelbBeerBusiness.resendSignupConfirmation");
    expect(resend).toContain("If a Supabase signup exists for that email, a confirmation email has been sent.");
    expect(reset).toContain("Reset your Pint Path password");
    expect(reset).toContain('id="requestResetForm"');
    expect(reset).toContain('id="updatePasswordForm"');
    expect(reset).toContain("MelbBeerBusiness.requestPasswordReset");
    expect(reset).toContain("MelbBeerBusiness.updatePassword");
    expect(reset).toContain('params.get("mode") === "update"');
    expect(reset).toContain("Password updated. You can continue to your Pint Path account.");
  });

  it("keeps the primary nav consistent and gives privileged accounts dashboard/admin links", () => {
    const html = mapHtml();
    const script = businessJs();

    expect(script).toContain("function hasAuthenticatedSessionHint");
    expect(script).toContain("function hasCachedSupabaseSession");
    expect(script).toContain("function isVenueManagerContext");
    expect(script).toContain("function isAdminContext");
    expect(script).toContain("subscriptionStatus: account.subscriptionStatus || null");
    expect(script).not.toContain("email: account.email || null");
    expect(script).not.toContain("email: session?.user?.email");
    const helpers = loadBusinessHelpers();
    const publicNavLabels = ["Map", "Submit", "Missions", "Pricing", "FAQ", "Account", "Contact us"];

    ["", "account", "bar-faq", "faq", "feedback", "missions", "pricing", "submit", "trust", "venue-portal", "venue-support"].forEach((active) => {
      expect(navLinkLabels(helpers.renderNav(active))).toEqual(publicNavLabels);
    });
    expect(script).toContain('const venueManagerNav = isVenueManagerContext()');
    expect(script).toContain('const adminNav = active === "admin" || isAdminContext()');
    expect(script).toContain('{ key: "map", href: "/", label: "Map" }');
    expect(script).toContain('{ key: "submit", href: "/submit.html", label: "Submit" }');
    expect(script).toContain('{ key: "missions", href: "/missions.html", label: "Missions" }');
    expect(script.indexOf('{ key: "submit", href: "/submit.html", label: "Submit" }')).toBeLessThan(
      script.indexOf('{ key: "missions", href: "/missions.html", label: "Missions" }'),
    );
    expect(script).toContain('{ key: "admin", href: "/admin.html", label: "Admin" }');
    expect(script).toContain('{ key: "pricing", href: "/pricing.html", label: "Pricing" }');
    expect(script).toContain('{ key: "venue-portal", href: "/venue-portal.html", label: "Dashboard" }');
    expect(script).toContain('{ key: "faq", href: venueManagerNav ? "/trust.html?audience=bars" : "/trust.html", label: venueManagerNav ? "Bar FAQ" : "FAQ" }');
    expect(script).toContain('{ key: "feedback", href: venueManagerNav ? "/feedback.html?audience=bars" : "/feedback.html", label: venueManagerNav ? "Support" : "Contact us" }');
    expect(script).not.toContain("const authenticatedLinks");
    expect(html).toContain('id="venueDashboardLink" href="/venue-portal.html" hidden>Dashboard');
    expect(html).toContain('href="/submit.html">Submit');
    expect(html).toContain('href="/missions.html">Missions');
    expect(html.indexOf('href="/submit.html">Submit')).toBeLessThan(
      html.indexOf('href="/missions.html">Missions'),
    );
    expect(html).toContain('href="/trust.html" id="venueFaqLink">FAQ');
    expect(html).toContain('href="/feedback.html" id="topbarFeedbackLink">Contact us');
    expect(html).not.toContain("data-venue-hidden");
    expect(html).not.toContain('href="/missions.html" data-auth-required');
    expect(html).not.toContain('href="/submit.html" data-auth-required');
    expect(html).not.toContain('href="/submit.html" class="primary" data-auth-required');
    expect(html).toContain("function syncAuthenticatedNavLinks");
    expect(html).toContain("window.MelbBeerBusiness?.isVenueManagerContext?.()");
    expect(html).toContain('document.querySelectorAll("[data-auth-required]")');
  });

  it("keeps venue-manager navigation in the same order with venue links added", () => {
    const helpers = loadBusinessHelpers();
    helpers.setAccountContext({
      id: "venue-user-1",
      role: "venue_manager",
      status: "active",
      email: "venue@example.com",
    });
    const nav = helpers.renderNav("account");

    expect(navLinkLabels(nav)).toEqual(["Map", "Dashboard", "Submit", "Missions", "Pricing", "Bar FAQ", "Account", "Support"]);
    expect(navLinkLabels(helpers.renderNav("venue-portal"))).toEqual(navLinkLabels(nav));
    expect(navLinkLabels(helpers.renderNav("venue-support"))).toEqual(navLinkLabels(nav));
    expect(nav).toContain('class="pill" aria-current="page" href="/account.html">Account</a>');
  });

  it("keeps the admin page in the same nav with Admin highlighted", () => {
    const helpers = loadBusinessHelpers();
    const nav = helpers.renderNav("admin");

    expect(navLinkLabels(nav)).toEqual(["Map", "Submit", "Missions", "Admin", "Pricing", "FAQ", "Account", "Contact us"]);
    expect(nav).toContain('class="pill" aria-current="page" href="/admin.html">Admin</a>');
  });

  it("keeps potential partner leads compact on the admin page", () => {
    const html = adminHtml();
    const css = businessCss();

    expect(html).toContain('id="partnerLeads" class="list partnerLeadList"');
    expect(html).toContain('class="listItem partnerLeadList__item"');
    expect(css).toContain("max-height: calc((var(--partner-lead-row-height) * 5) + (12px * 4));");
    expect(css).toContain("overflow-y: auto;");
    expect(css).toContain("overscroll-behavior: contain;");
  });

  it("labels mixed package availability as cans or bottles in admin review", () => {
    const html = adminHtml();

    expect(html).toContain('<option value="cans_or_bottles">Cans or bottles</option>');
    expect(html).toContain('unavailableReason: "cans_or_bottles"');
  });

  it("groups the admin page into clear workflow sections without removing tools", () => {
    const html = adminHtml();
    const css = businessCss();
    const sectionOrder = [
      'id="adminReview"',
      'id="adminCapture"',
      'id="adminPartners"',
      'id="adminLeaderboard"',
      'id="adminAnalytics"',
    ];
    const requiredAdminControls = [
      'id="adminTodayQueue"',
      'id="adminActiveSectionLabel"',
      'id="adminLoadSummary"',
      'id="refreshAdminPageButton"',
      'id="adminFocusRail"',
      'id="adminHealthPanel"',
      'id="pendingSubmissions"',
      'id="pendingBarChanges"',
      'id="reviewQueues"',
      'id="adminCaptureMetrics"',
      'id="adminVenueSearch"',
      'id="adminCreateVenueForm"',
      'id="adminSourceQueueForm"',
      'id="adminIngestionQueue"',
      'id="adminIngestionPager"',
      'id="adminIngestionPrevPage"',
      'id="adminIngestionPageStatus"',
      'id="adminIngestionNextPage"',
      'id="venueInterestRequests"',
      'id="venueManagerAssignments"',
      'id="managerAssignForm"',
      'id="outreachForm"',
      'id="pitchReadinessPanel"',
      'id="pitchReadinessList"',
      'id="outreachPipelineSummary"',
      'id="outreachPipelineBoard"',
      'id="venueOutreachList"',
      'id="leaderboardPrizeForm"',
      'id="adminLeaderboardPodium"',
      'id="adminLeaderboardEntries"',
      'id="adminLeaderboardAwards"',
      'id="headlineMetrics"',
      'id="retentionCohorts"',
      'id="coverageDashboard"',
      'id="demandSignals"',
      'id="partnerLeads"',
      'id="reviewDecisionDialog"',
    ];

    expect(html).toContain('class="adminJumpNav" role="tablist" aria-label="Admin workflow sections"');
    expect(html).toContain('data-admin-tab-target="review" aria-controls="adminReview" aria-selected="false"');
    expect(html).toContain('data-admin-tab-target="capture" aria-controls="adminCapture" aria-selected="false"');
    expect(html).toContain('data-admin-tab-target="partners" aria-controls="adminPartners" aria-selected="false"');
    expect(html).toContain('data-admin-tab-target="leaderboard" aria-controls="adminLeaderboard" aria-selected="false"');
    expect(html).toContain('data-admin-tab-target="analytics" aria-controls="adminAnalytics" aria-selected="false"');
    expect(html).toContain('data-admin-tab-panel="review" role="tabpanel" hidden');
    expect(html).toContain('data-admin-tab-panel="capture" role="tabpanel" hidden');
    expect(html).toContain('data-admin-tab-panel="partners" role="tabpanel" hidden');
    expect(html).toContain('data-admin-tab-panel="leaderboard" role="tabpanel" hidden');
    expect(html).toContain('data-admin-tab-panel="analytics" role="tabpanel" hidden');
    expect(html).toContain("function showAdminTab");
    expect(html).toContain("function renderAdminFocusRail");
    expect(html).toContain("function adminJumpAttributes");
    expect(html).toContain("function refreshAdminPage");
    expect(html).toContain("function openReviewDecision");
    expect(html).toContain("function promptSubmissionReview");
    expect(html).toContain("function isPhotoEvidenceOnlySubmission");
    expect(html).toContain("Approve evidence only");
    expect(html).toContain("will not publish live beer prices");
    expect(html).toContain("Evidence-only upload approved; no live beer rows were published.");
    expect(html).toContain("function promptQueuedIngestionReview");
    expect(html).toContain("function renderCrawlerDetails");
    expect(html).toContain("function crawlerFeedbackPill");
    expect(html).toContain("function copyTextToClipboard");
    expect(html).toContain('data-source-url-value');
    expect(html).toContain('data-copy-source-url');
    expect(html).toContain("ADMIN_INGESTION_PAGE_SIZE = 12");
    expect(html).toContain("offset: String(adminIngestionOffset)");
    expect(html).toContain("showing ${pageStart}-${pageEnd} of ${adminIngestionTotal}");
    expect(html).toContain("function moveAdminIngestionPage");
    expect(html).toContain('<option value="pending_review">Pending</option>');
    expect(html).toContain('params.set("status", adminIngestionStatus.value);');
    expect(html).toContain("Source ingestion published. ${mapRows} live map row");
    expect(html).toContain('adminIngestionStatus.value = "pending_review";');
    expect(html).toContain("await loadAdminIngestionQueue({ resetPage: true });");
    expect(html).toContain("Load next 12");
    expect(html).toContain("function prefillOutreachFromLead");
    expect(html).toContain("function renderOutreachPipeline");
    expect(html).toContain("function updateOutreachStage");
    expect(html).toContain("function renderPitchReadiness");
    expect(html).toContain("function renderAdminLeaderboardPrizes");
    expect(html).toContain("function handleLeaderboardPrizeFinalize");
    expect(html).toContain("function openLeadCapture");
    expect(html).toContain('class="adminSourceReviewLayout"');
    expect(html).toContain('class="adminCrawlerRewardHint"');
    expect(html).toContain('data-prefill-lead');
    expect(html).toContain('data-prep-pitch');
    expect(html).toContain('data-capture-lead');
    expect(html).toContain('name="tierFit"');
    expect(html).toContain('name="nextAction"');
    expect(html).toContain('name="lastContactedAt"');
    expect(html).toContain('document.querySelectorAll("[data-admin-tab-target]")');
    expect(html).toContain('metricCard${options.target ? " metricCard--button" : ""}');
    expect(html).toContain('renderMetric("Pending approvals", metrics.totalPendingSubmissions, { target: "review", selector: "#pendingSubmissions"');
    expect(html).toContain('renderMetric("Submissions today", metrics.totalSubmissionCompletions || 0, { target: "review", selector: "#pendingSubmissions"');
    expect(html).toContain('label: "Source queue",');
    expect(html).toContain('selector: "#adminIngestionQueue"');
    expect(html).toContain('wireAdminJumpActions(panel);');
    sectionOrder.forEach((section, index) => {
      expect(html).toContain(section);
      if (index > 0) {
        expect(html.indexOf(sectionOrder[index - 1])).toBeLessThan(html.indexOf(section));
      }
    });
    requiredAdminControls.forEach((control) => expect(html).toContain(control));
    expect(css).toContain(".adminWorkbench");
    expect(css).toContain(".adminUtilityBar");
    expect(css).toContain(".adminFocusRail");
    expect(css).toContain(".adminSection");
    expect(css).toContain(".adminJumpNav");
    expect(css).toContain(".adminTabButton");
    expect(css).toContain(".adminGrid--two");
    expect(css).toContain(".adminCommandCard");
    expect(css).toContain(".metricCard--button");
    expect(css).toContain(".adminReviewActionBar");
    expect(css).toContain(".adminCrawlerDetails");
    expect(css).toContain(".adminCrawlerRewardHint");
    expect(css).toContain(".adminSourceReviewLayout");
    expect(css).toContain(".adminSourceEvidence__urlField");
    expect(css).toContain(".adminSourceEvidence__urlInput");
    expect(css).toContain(".adminSourceEvidence__actions");
    expect(css).toContain(".adminQueueBeerRows .adminBeerRow");
    expect(css).toContain(".adminIngestionPager");
    expect(css).toContain(".pitchReadinessGrid");
    expect(css).toContain(".pitchReadinessChecklist");
    expect(css).toContain(".outreachPipelineBoard");
    expect(css).toContain(".outreachPipelineLane");
    expect(css).toContain(".outreachPipelineCard");
    expect(css).toContain(".reviewDecisionDialog");
  });

  it("requires confirm password and keeps signup consent text readable", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain("Confirm password");
    expect(html).toContain('name="confirmPassword"');
    expect(html).toContain('name="termsAccepted"');
    expect(html).toContain('name="privacyAccepted"');
    expect(html).toContain("Terms and Conditions");
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Passwords do not match.");
    expect(html).toContain("Confirm you are 18+ and accept the Terms and Privacy Policy to create an account.");
    expect(html).toContain("Unique public name.");
    expect(html).toContain("No disrespectful, racist, hateful, rude");
    expect(html).toContain("validateDisplayNameClient(body.displayName)");
    expect(html).toContain('id="signupPanel" class="authPanelStack"');
    expect(html).toContain('class="authFields"');
    expect(html).toContain('class="field consentField" role="group" aria-label="Account consent"');
    expect(html).toContain('<label class="consentLine"><input name="ageConfirmed"');
    expect(html).toContain('<label class="consentLine"><input name="termsAccepted"');
    expect(html).toContain('<label class="consentLine"><input name="privacyAccepted"');
    expect(html).toContain('authParams.get("supabaseAuth") !== "1"');
    expect(css).toContain('.field input[type="checkbox"]');
    expect(css).toContain(".authPanelStack");
    expect(css).toContain(".authFields");
    expect(css).toContain(".authActions");
    expect(css).toContain("padding-right: 86px");
    expect(css).toContain("position: absolute");
    expect(css).toContain("grid-template-columns: 18px minmax(0, 1fr)");
    expect(css).toContain("font-size: clamp(42px, 5vw, 64px)");
  });

  it("keeps signup telemetry and post-signup sync failures from trapping users on Load failed", () => {
    const html = accountHtml();
    const script = businessJs();

    expect(html).toContain('trackEvent("signup_started", { source: "account_page" }).catch(() => null)');
    expect(html).toContain("We could not finish account creation.");
    expect(html).toContain("result.message ||");
    expect(script).toContain("Account created and confirmation requested.");
    expect(script).toContain("}).catch(() => null)");
  });

  it("resets OAuth loading buttons when a provider flow is cancelled", () => {
    const html = accountHtml();

    expect(html).toContain("oauthLoginOpening: false");
    expect(html).toContain("function setOauthButtonsLoading");
    expect(html).toContain("function resetCancelledOauth");
    expect(html).toContain("Secure login was cancelled. Choose Google, Apple, or email to continue.");
    expect(html).toContain('window.addEventListener("pageshow", () => resetCancelledOauth())');
    expect(html).toContain('window.addEventListener("focus", () => resetCancelledOauth())');
  });

  it("has a dedicated Supabase auth callback that exchanges the session and redirects safely", () => {
    const html = callbackHtml();

    expect(html).toContain("Finishing your Pint Path login");
    expect(html).toContain("exchangeCodeForSession");
    expect(html).toContain("MelbBeerBusiness.syncSupabaseSession");
    expect(html).toContain("MelbBeerBusiness.applyPendingLegalAcceptance");
    expect(html).toContain("MelbBeerBusiness.getSafeReturnPath");
    expect(html).toContain('returnPath.startsWith("/reset-password.html")');
    expect(html).toContain('result.account?.role === "venue_manager" ? "/venue-portal.html" : returnPath');
    expect(html).not.toContain("If this takes more than a moment");
    expect(html).not.toContain("service_role");
  });

  it("publishes stronger beta Terms and Privacy pages for account consent", () => {
    const terms = termsHtml();
    const privacy = privacyHtml();

    expect(terms).toContain("Terms and Conditions");
    expect(terms).toContain("warn, restrict, suspend, or permanently ban accounts");
    expect(terms).toContain("exploit the points system");
    expect(terms).toContain("scrape protected data");
    expect(terms).toContain("Display names/usernames must be unique");
    expect(terms).toContain("We do not tolerate rude or discriminatory names");
    expect(terms).toContain("Final owner contact, billing, refund, cancellation, and jurisdiction details");
    expect(terms).toContain("Beta legal-review notice");
    expect(terms).toContain("publish final cancellation, refund, Stripe customer portal");
    expect(privacy).toContain("Privacy Policy");
    expect(privacy).toContain("Plain-English beta summary");
    expect(privacy).toContain("Service providers and integrations");
    expect(privacy).toContain("Venue reports are aggregate-only");
    expect(privacy).toContain("We do not store raw ID documents");
    expect(privacy).toContain("one-time upload-location proof");
    expect(privacy).toContain("Account deletion and export");
    expect(privacy).toContain("Final owner contact details should be published here");
    expect(privacy).not.toContain("[legal entity name]");
  });

  it("adds a FAQ with trust, community, security, privacy, and support paths", () => {
    const trust = trustHtml();
    const community = communityHtml();
    const security = securityHtml();
    const status = statusHtml();
    const feedback = feedbackHtml();
    const nav = businessJs();
    const css = businessCss();

    expect(nav).toContain('key: "faq", href: venueManagerNav ? "/trust.html?audience=bars" : "/trust.html"');
    expect(trust).toContain("FAQ | Pint Path");
    expect(trust).not.toContain("Where did the Trust Centre go?");
    expect(trust).not.toContain("Tap a question when you need detail.");
    expect(trust).toContain("What if a price is wrong?");
    expect(trust).toContain("How does premium access work?");
    expect(trust).toContain("Can bars edit the map directly?");
    expect(trust).toContain("How do I report a security or privacy concern?");
    expect(trust).toContain("How do I add a missing venue?");
    expect(trust).toContain('params.get("audience") === "bars"');
    expect(trust).toContain("Answers for venues using Pint Path.");
    expect(trust).toContain("What can my bar account manage?");
    expect(trust).toContain("What do venue reports show?");
    expect(trust).toContain("faqList");
    expect(trust).not.toContain("faqActionPanel");
    expect(trust).not.toContain("Need something else?");
    expect(css).toContain(".faqItem summary");
    expect(css).toContain(".faqItem[open]");
    expect(css).toContain(".faqItem summary::after");
    expect(css).not.toContain(".faqActionPanel");
    expect(trust).toContain("/security.html");
    expect(community).toContain("Submit what you actually saw at the venue.");
    expect(community).toContain("Spoofing location");
    expect(security).toContain("Security & privacy");
    expect(security).toContain("Log out all sessions");
    expect(security).toContain("Security report");
    expect(security).toContain("If you cannot sign in, use Contact us and include the account email");
    expect(trust).not.toContain('<a href="/status.html"');
    expect(security).not.toContain('<a href="/status.html"');
    expect(status).toContain("Pint Path status and incident reporting.");
    expect(status).toContain("Provider checks still need human verification");
    expect(status).toContain("Railway");
    expect(status).toContain("Supabase");
    expect(status).toContain("Resend");
    expect(feedback).toContain("privacy_request");
    expect(feedback).toContain("data_export_request");
    expect(feedback).toContain("account_deletion_request");
    expect(feedback).toContain("moderation_appeal");
    expect(feedback).toContain("security_report");
    expect(feedback).toContain("abuse_report");
    expect(feedback).toContain("billing_support");
    expect(feedback).toContain("venue_partner_interest");
  });

  it("exposes signed-in privacy controls without clustering feedback back into account", () => {
    const html = accountHtml();
    const css = businessCss();
    const script = businessJs();

    expect(html).toContain('id="privacySettingsForm"');
    expect(html).toContain("Allow optional product analytics");
    expect(html).toContain("Include my aggregate activity in venue insights");
    expect(html).toContain('id="dataRequestForm"');
    expect(html).toContain('id="downloadAccountDataButton"');
    expect(html).toContain('id="requestAccountDeletionButton"');
    expect(html).toContain("Deletion is a review request, not an instant switch.");
    expect(html).toContain("The quick account export is JSON");
    expect(html).not.toContain('id="requestForm"');
    expect(html).not.toContain('class="panel supportSubmitCard"');
    expect(html).not.toContain("Add venue data");
    expect(html).not.toContain("Open Trust Centre");
    expect(html).toContain("/api/business/account/export");
    expect(html).toContain("/api/business/account/delete-request");
    expect(html).toContain("downloadJson");
    expect(html).toContain('id="logoutAllButton"');
    expect(html).toContain('class="securityActionGrid"');
    expect(html).toContain('class="button button--danger securityLogoutAll"');
    expect(html).toContain("/api/business/account/privacy-settings");
    expect(html).toContain("/api/business/auth/logout-all");
    expect(html).toContain("/community.html");
    expect(css).toContain(".accountSecurityPanel");
    expect(css).toContain(".securityActionGrid");
    expect(css).toContain(".securityLogoutAll");
    expect(css).toContain(".quickPrivacyActions");
    expect(css).toContain(".toggleLine");
    expect(script).toContain("setPrivacyPreferenceCache");
    expect(script).toContain("pintPathOptionalAnalyticsEnabled");
    expect(script).toContain("pintPathVenueReportsEnabled");
  });

  it("adds cookie consent and accessibility chrome around optional analytics", () => {
    const css = businessCss();
    const script = businessJs();

    expect(script).toContain("pintPathCookieConsent");
    expect(script).toContain("function installCookieConsent");
    expect(script).toContain("Essentials only");
    expect(script).toContain("Accept all");
    expect(script).toContain("Manage in account");
    expect(script).toContain("function hasAnalyticsConsent");
    expect(script).toContain("if (!hasAnalyticsConsent())");
    expect(script).toContain('aria-label="Primary"');
    expect(script).toContain("function installAccessibilityChrome");
    expect(script).toContain('main.id = "mainContent"');
    expect(script).toContain("Skip to main content");
    expect(css).toContain(".cookieConsent");
    expect(css).toContain(".skipLink");
    expect(css).toContain(":focus-visible");
  });
});
