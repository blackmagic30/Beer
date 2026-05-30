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
    expect(html).toContain("Contributor dashboard");
    expect(html).not.toContain("Quick beer price upload");
    expect(html).toContain("Manage your Pint Path account");
    expect(html).toContain('id="accountSettingsHub"');
    expect(html).toContain("Recent submissions");
    expect(html).toContain("How verification works");
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
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
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

    expect(html).toContain("Private evidence");
    expect(html).toContain("Raw photos, receipts, OCR evidence, and reviewer notes are not public map data");
    expect(html).toContain("Submitted data stays pending until verified or approved.");
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
    expect(script).toContain('href="/feedback.html"');
    expect(script).not.toContain('href="/account.html#feedbackForm"');
  });

  it("moves account actions into submit flows and a settings hub", () => {
    const html = accountHtml();

    expect(html).toContain('href="/submit.html"');
    expect(html).toContain('href="/submit.html?type=photo_upload"');
    expect(html).toContain('href="#accountSettingsHub"');
    expect(html).toContain('href="#privacySettingsForm"');
    expect(html).toContain('href="#dataRequestForm"');
    expect(html).toContain('href="#securitySettingsCard"');
    expect(html).toContain("function missionSubmitHref");
    expect(html).toContain("missionId: String(mission.id)");
    expect(html).toContain("missionReason: String(mission.reason || \"Pint Path mission\")");
    expect(html).not.toContain('id="quickVenueSelect"');
    expect(html).not.toContain("function clearQuickVenue");
    expect(html).not.toContain("submitQuickUpload");
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
    expect(html).toContain('id="passwordResetButton"');
    expect(html).toContain("Reset password");
    expect(html).toContain("Sending reset link...");
    expect(html).toContain("If an account exists for that email, a secure reset link has been sent.");
    expect(html).not.toContain('id="oauthTermsAccepted"');
    expect(html).not.toContain('id="oauthPrivacyAccepted"');
    expect(html).not.toContain("before using social login");
    expect(html).toContain("Google and Apple sign-in appears");
    expect(script).toContain("signInWithOAuth({");
    expect(script).toContain('provider,');
    expect(script).toContain("signInWithPassword");
    expect(script).toContain("signUp({");
    expect(script).toContain("/auth/callback");
    expect(script).toContain("terms_accepted");
    expect(script).toContain("privacy_accepted");
    expect(script).toContain("applyPendingLegalAcceptance");
  });

  it("keeps Missions and Submit data navigation behind authenticated session hints", () => {
    const html = mapHtml();
    const script = businessJs();

    expect(script).toContain("function hasAuthenticatedSessionHint");
    expect(script).toContain("function hasCachedSupabaseSession");
    expect(script).toContain("const authenticatedLinks = hasAuthenticatedSessionHint()");
    expect(script).toContain('href="/missions.html">Missions');
    expect(script).toContain('href="/submit.html">Submit data');
    expect(html).toContain('href="/missions.html" data-auth-required');
    expect(html).toContain('href="/submit.html" class="primary" data-auth-required');
    expect(html).toContain("function syncAuthenticatedNavLinks");
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
    expect(html).toContain('class="consentLine"');
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
    expect(script).toContain("Account created. Check your email to confirm your Pint Path login");
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

  it("adds a trust centre with community, security, privacy, and support paths", () => {
    const trust = trustHtml();
    const community = communityHtml();
    const security = securityHtml();
    const status = statusHtml();
    const feedback = feedbackHtml();
    const nav = businessJs();

    expect(nav).toContain('href="/trust.html"');
    expect(trust).toContain("Trust Centre");
    expect(trust).toContain("Raw photos, reviewer notes, account details, and individual analytics stay private.");
    expect(trust).toContain("Read Community Standards");
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
    expect(html).toContain("/api/business/account/export");
    expect(html).toContain("/api/business/account/delete-request");
    expect(html).toContain("downloadJson");
    expect(html).toContain('id="logoutAllButton"');
    expect(html).toContain("/api/business/account/privacy-settings");
    expect(html).toContain("/api/business/auth/logout-all");
    expect(html).toContain("/community.html");
    expect(css).toContain(".accountSecurityPanel");
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
