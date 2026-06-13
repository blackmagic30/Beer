import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function accountHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/account.html"), "utf8");
}

function mapHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");
}

function businessJs() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.js"), "utf8");
}

function businessCss() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.css"), "utf8");
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

describe("account page shell", () => {
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
    expect(html).toContain("New venue pending admin approval");
    expect(html).toContain("submissionPendingNotice");
    expect(html).toContain('id="authStatus" class="notice" role="status" hidden></div>');
    expect(html).toContain('id="dashboardStatus" class="notice" role="status" hidden></div>');
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

  it("keeps feedback on a dedicated page instead of clustering the account dashboard", () => {
    const html = accountHtml();
    const feedback = feedbackHtml();
    const script = businessJs();

    expect(html).not.toContain('id="feedbackForm"');
    expect(html).toContain('href="/feedback.html"');
    expect(feedback).toContain('id="feedbackForm"');
    expect(feedback).toContain("Tell us what felt confusing, useful, or broken.");
    expect(feedback).toContain('MelbBeerBusiness.renderNav("feedback")');
    expect(feedback).toContain('MelbBeerBusiness.apiFetch("/api/business/feedback"');
    expect(feedback.indexOf("Privacy note")).toBeLessThan(feedback.indexOf('id="feedbackForm"'));
    expect(script).toContain('{ key: "feedback", href: "/feedback.html", label: "Feedback" }');
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
    expect(html).toContain('href="/submit.html">Open Submit');
    expect(html).toContain('data-settings-target="submissions"');
    expect(html).toContain('data-settings-target="stats"');
    expect(html.indexOf('data-settings-target="stats"')).toBeLessThan(html.indexOf('data-settings-target="submissions"'));
    expect(html).not.toContain('data-settings-target="preferences"');
    expect(html).not.toContain('data-settings-target="watchlist"');
    expect(html).toContain('data-settings-target="privacy"');
    expect(html).toContain('data-settings-target="support"');
    expect(html).toContain('data-settings-target="security"');
    expect(html).not.toContain("Suggested missions");
    expect(html).not.toContain('id="suggestedMissions"');
    expect(html).not.toContain("function missionSubmitHref");
    expect(html).not.toContain('id="quickVenueSelect"');
    expect(html).not.toContain("function clearQuickVenue");
    expect(html).not.toContain("submitQuickUpload");
  });

  it("keeps Account focused on savings and specials while moving detailed stats to My Stats", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain('class="accountHighlightsGrid"');
    expect(html).not.toContain('id="accountIdMetric"');
    expect(html).toContain('id="savingsMetric"');
    expect(html).toContain('id="refreshDiscountPassButton"');
    expect(html).toContain("Pint Path special");
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
    expect(html.indexOf('class="accountHighlightsGrid"')).toBeLessThan(html.indexOf('id="settingsStatsPanel"'));
    expect(html).toContain("accountHeroMetric--savings");
    expect(html).toContain("accountHeroMetric--special");
    expect(html.indexOf('label: "Total saved"')).toBeLessThan(html.indexOf('label: "Total uploads"'));
    expect(html.indexOf('label: "Verified"')).toBeLessThan(html.indexOf('label: "Pending review"'));
    expect(css).toContain(".accountHighlightsGrid");
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
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.accountHighlightsGrid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountStatsGrid \.metricCard\s*\{[\s\S]*min-height:\s*104px;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountDiscountFeature \.sectionHeader p,[\s\S]*\.accountDiscountFeature > \.helperCopy\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountDashboardIntro \.button\s*\{[\s\S]*display:\s*none;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountIdentityCard--compact strong\s*\{[\s\S]*-webkit-line-clamp:\s*2;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountAccessBadgeRow\s*\{[\s\S]*flex-wrap:\s*nowrap;[\s\S]*overflow-x:\s*auto;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountAccessBadge\s*\{[\s\S]*font-size:\s*0\.56rem;/);
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*\.accountAccessBadgeRow \.accountAccessBadge:not\(:first-child\)\s*\{[\s\S]*display:\s*none;/);
    expect(css).toContain(".accountDiscountFeature");
  });

  it("opens account settings sections on demand instead of rendering every panel open", () => {
    const html = accountHtml();
    const css = businessCss();

    expect(html).toContain('id="settingsEmptyPanel"');
    expect(html).toContain('data-settings-target="submissions" aria-controls="settingsSubmissionsPanel"');
    expect(html).toContain('data-settings-target="stats" aria-controls="settingsStatsPanel"');
    expect(html).not.toContain('href="#recentSubmissionsSection"');
    expect(html).not.toContain('href="/stats.html"');
    expect(html).toContain('data-settings-panel="submissions" role="tabpanel" hidden');
    expect(html).toContain('data-settings-panel="stats" role="tabpanel" hidden');
    expect(html).not.toContain('data-settings-panel="preferences" role="tabpanel" hidden');
    expect(html).not.toContain('data-settings-panel="watchlist" role="tabpanel" hidden');
    expect(html).toContain('data-settings-panel="privacy" role="tabpanel" hidden');
    expect(html).toContain('data-settings-panel="support" role="tabpanel" hidden');
    expect(html).toContain('data-settings-panel="security" role="tabpanel" hidden');
    expect(html).toContain("function showAccountSettingsPanel");
    expect(html).toContain('document.querySelectorAll("[data-settings-target]")');
    expect(html).toContain("showAccountSettingsPanel(button.dataset.settingsTarget)");
    expect(html).toContain("function requestedSettingsPanel");
    expect(html).toContain("showAccountSettingsPanel(requestedSettingsPanel())");
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
    expect(script).toContain('const venueManagerNav = active === "venue-portal" || isVenueManagerContext()');
    expect(script).toContain('const adminNav = active === "admin" || isAdminContext()');
    expect(script).toContain('{ key: "map", href: "/", label: "Map" }');
    expect(script).toContain('{ key: "submit", href: "/submit.html", label: "Submit" }');
    expect(script).toContain('{ key: "missions", href: "/missions.html", label: "Missions" }');
    expect(script.indexOf('{ key: "submit", href: "/submit.html", label: "Submit" }')).toBeLessThan(
      script.indexOf('{ key: "missions", href: "/missions.html", label: "Missions" }'),
    );
    expect(script).toContain('{ key: "admin", href: "/admin.html", label: "Admin" }');
    expect(script).toContain('{ key: "pricing", href: "/pricing.html", label: "Pricing" }');
    expect(script).toContain('{ key: "faq", href: "/trust.html", label: "FAQ" }');
    expect(script).toContain('{ key: "venue-portal", href: "/venue-portal.html", label: "Dashboard" }');
    expect(script).not.toContain("const authenticatedLinks");
    expect(html).toContain('id="venueDashboardLink" href="/venue-portal.html" hidden>Dashboard');
    expect(html).toContain('href="/submit.html">Submit');
    expect(html).toContain('href="/missions.html">Missions');
    expect(html.indexOf('href="/submit.html">Submit')).toBeLessThan(html.indexOf('href="/missions.html">Missions'));
    expect(html).toContain('href="/trust.html">FAQ');
    expect(html).not.toContain('href="/missions.html" data-auth-required');
    expect(html).not.toContain('href="/submit.html" data-auth-required');
    expect(html).not.toContain('href="/submit.html" class="primary" data-auth-required');
    expect(html).toContain("function syncAuthenticatedNavLinks");
    expect(html).toContain("window.MelbBeerBusiness?.isVenueManagerContext?.()");
    expect(html).toContain('document.querySelectorAll("[data-auth-required]")');
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
    expect(privacy).toContain("Privacy Policy");
    expect(privacy).toContain("Venue reports are aggregate-only");
    expect(privacy).toContain("We do not store raw ID documents");
    expect(privacy).toContain("one-time upload-location proof");
  });

  it("adds a FAQ with trust, community, security, privacy, and support paths", () => {
    const trust = trustHtml();
    const community = communityHtml();
    const security = securityHtml();
    const status = statusHtml();
    const feedback = feedbackHtml();
    const nav = businessJs();
    const css = businessCss();

    expect(nav).toContain('{ key: "faq", href: "/trust.html", label: "FAQ" }');
    expect(trust).toContain("FAQ | Pint Path");
    expect(trust).not.toContain("Where did the Trust Centre go?");
    expect(trust).not.toContain("Tap a question when you need detail.");
    expect(trust).toContain("What if a price is wrong?");
    expect(trust).toContain("How does premium access work?");
    expect(trust).toContain("Can bars edit the map directly?");
    expect(trust).toContain("How do I report a security or privacy concern?");
    expect(trust).toContain("How do I add a missing venue?");
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
    expect(trust).toContain("/status.html");
    expect(security).toContain("/status.html");
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
    expect(html).not.toContain('id="requestForm"');
    expect(html).toContain('class="panel supportSubmitCard"');
    expect(html).toContain('href="/submit.html">Open Submit');
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
    expect(script).toContain("Essential only");
    expect(script).toContain("Allow optional analytics");
    expect(script).toContain("Manage in Account");
    expect(script).toContain("function hasAnalyticsConsent");
    expect(script).toContain("if (!hasAnalyticsConsent())");
    expect(script).toContain('aria-label="Primary"');
    expect(script).toContain("function installAccessibilityChrome");
    expect(script).toContain('main.id = "mainContent"');
    expect(script).not.toContain("Skip to main content");
    expect(css).toContain(".cookieConsent");
    expect(css).not.toContain(".skipLink");
    expect(css).toContain(":focus-visible");
  });
});
