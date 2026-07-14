import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  adminPaginationSchema,
  beerCatalogAdminQuerySchema,
  missionsQuerySchema,
  priceRecordsQuerySchema,
  submissionsQuerySchema,
  venueReconciliationQuerySchema,
  venuesQuerySchema,
} from "../src/modules/business/business.schemas.js";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.resolve(root, file), "utf8");
const sourceSection = (source: string, start: string, end: string) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Could not find source section: ${start} -> ${end}`);
  return source.slice(startIndex, endIndex);
};

describe("native mobile remediation guardrails", () => {
  const iosAPI = read("apps/ios/BeerMap/Services/BeerMapAPI.swift");
  const iosAuth = read("apps/ios/BeerMap/Features/AuthView.swift");
  const iosAccount = read("apps/ios/BeerMap/Features/AccountView.swift");
  const iosDiscover = read("apps/ios/BeerMap/Features/DiscoverView.swift");
  const iosModels = read("apps/ios/BeerMap/Models/BeerMapModels.swift");
  const iosApp = read("apps/ios/BeerMap/App/BeerMapApp.swift");
  const iosRoot = read("apps/ios/BeerMap/Features/RootView.swift");
  const iosKeychain = read("apps/ios/BeerMap/Services/KeychainSessionStore.swift");
  const androidAPI = read("apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt");
  const androidModels = read("apps/android/app/src/main/java/au/pintpath/beermap/data/Models.kt");
  const androidApp = read("apps/android/app/src/main/java/au/pintpath/beermap/ui/features/BeerMapApp.kt");
  const androidSessions = read("apps/android/app/src/main/java/au/pintpath/beermap/data/SessionStore.kt");
  const androidComponents = read("apps/android/app/src/main/java/au/pintpath/beermap/ui/components/Components.kt");
  const androidBuild = read("apps/android/app/build.gradle.kts");

  it("ships the Pint Path display brand on both platforms", () => {
    const info = read("apps/ios/BeerMap/Info.plist");
    const strings = read("apps/android/app/src/main/res/values/strings.xml");

    expect(info).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Pint Path<\/string>/);
    expect(strings).toContain('<string name="app_name">Pint Path</string>');
  });

  it("uses Supabase Auth plus a scoped app-session exchange in production", () => {
    for (const client of [iosAPI, androidAPI]) {
      expect(client).toContain("/auth/v1/token?grant_type=password");
      expect(client).toContain("/auth/v1/token?grant_type=refresh_token");
      expect(client).toContain("/api/business/auth/supabase-session");
      expect(client).not.toContain("/api/business/auth/signup");
      expect(client).toContain("hasSupabaseConfiguration");
      expect(client).toContain("/api/business/auth/login");
    }
    expect(iosAPI).toMatch(/if !hasSupabaseConfiguration\(config\)[\s\S]*\/api\/business\/auth\/login/);
    expect(androidAPI).toMatch(/if \(!hasSupabaseConfiguration\(config\)\)[\s\S]*\/api\/business\/auth\/login/);
    expect(iosAPI).toContain('consentSource: hasCompleteConsent ? "ios" : nil');
    expect(androidAPI).toContain('put("consentSource", "android")');
    expect(iosModels).not.toContain("stripePublishableKey");
    expect(androidModels).not.toContain("stripePublishableKey");
  });

  it("reuses the logical Pint Path session only when refreshing Supabase credentials", () => {
    const iosSync = sourceSection(iosAPI, "func syncSupabase(", "func requestPasswordReset(");
    const iosRefresh = sourceSection(iosAPI, "func refreshSupabaseSession(", "func exchangeSupabasePKCE(");
    const iosLogin = sourceSection(iosAPI, "func login(", "func billingRecoveryPortal(");
    const iosSignup = sourceSection(iosAPI, "func signup(", "func syncSupabase(");
    const iosOAuth = sourceSection(iosApp, "func completeOAuthSignIn(", "func openBillingRecovery(");
    expect(iosSync).toContain("existingAppToken: String? = nil");
    expect(iosSync).toContain("token: existingAppToken");
    expect(iosRefresh).toContain("existingAppToken: String");
    expect(iosRefresh).toContain("existingAppToken: existingAppToken");
    expect(iosApp).toMatch(/refreshSupabaseSession\([\s\S]*existingAppToken: currentToken/);
    expect(iosLogin).not.toContain("existingAppToken:");
    expect(iosSignup).not.toContain("existingAppToken:");
    expect(iosOAuth).not.toContain("existingAppToken:");

    const androidRefresh = sourceSection(androidAPI, "suspend fun refreshSupabaseSession(", "suspend fun completeOAuthSession(");
    const androidSync = sourceSection(androidAPI, "private suspend fun syncSupabase(", "suspend fun logout(");
    const androidLogin = sourceSection(androidAPI, "suspend fun login(", "suspend fun billingRecoveryPortal(");
    const androidSignup = sourceSection(androidAPI, "suspend fun signup(", "suspend fun refreshSupabaseSession(");
    const androidOAuth = sourceSection(androidAPI, "suspend fun completeOAuthSession(", "suspend fun exchangeSupabasePKCE(");
    expect(androidSync).toContain("existingAppToken: String? = null");
    expect(androidSync).toContain("token = existingAppToken");
    expect(androidRefresh).toContain("existingAppToken: String");
    expect(androidRefresh).toContain("syncSupabase(accessToken, config, null, null, null, existingAppToken)");
    expect(androidApp).toContain("api.refreshSupabaseSession(refreshToken, config, currentAppToken)");
    expect(androidLogin).not.toContain("existingAppToken");
    expect(androidSignup).not.toContain("existingAppToken");
    expect(androidOAuth).not.toContain("existingAppToken");
  });

  it("describes free price access as a fixed preview without a fictional daily counter", () => {
    expect(iosDiscover).toContain('title: "Free price access"');
    expect(iosDiscover).toContain('value: "Fixed preview"');
    expect(iosDiscover).not.toMatch(/free reveals\/day|reveals per day/i);
    expect(iosModels).not.toContain("freePriceRevealsPerDay");
    expect(iosModels).not.toContain("freePriceRevealsRemaining");
    expect(iosModels).toContain("let priceAccessModel: String?");
    expect(iosModels).toContain("let freePreviewScope: String?");
    expect(androidModels).toContain("val priceAccessModel: String?");
    expect(androidModels).toContain("val freePreviewScope: String?");
    const iosPriceResult = sourceSection(iosModels, "struct PriceRecordsResponse", "struct PriceRecord");
    const androidPriceResult = sourceSection(androidModels, "data class PriceRecordsResult", "data class PriceAccessState");
    const iosPriceRequest = sourceSection(iosAPI, "func priceRecords(", "private func priceRecordIdentityKey");
    const androidPriceRequest = sourceSection(androidAPI, "suspend fun priceRecords(", "private fun priceRecordIdentityKey");
    expect(iosPriceResult).toContain("let preview: PricePreview?");
    expect(androidPriceResult).toContain("val preview: PricePreview?");
    for (const source of [iosPriceResult, androidPriceResult, iosPriceRequest, androidPriceRequest]) {
      expect(source).not.toMatch(/\b(revealed|blocked|canRevealPrice)\b/);
    }
    expect(iosDiscover).toContain("response.preview?.lockedCount");
    expect(androidApp).toContain("selectedPriceResult?.preview?.lockedCount");
    expect(iosModels).toContain("let canViewAllPrices: Bool?");
    expect(androidModels).toContain("val canViewAllPrices: Boolean");
    expect(iosModels).toContain("let pricePreviewViews: Int?");
    expect(androidModels).toContain("val pricePreviewViews: Int");
    expect(iosModels).not.toContain("priceReveals");
    expect(androidModels).not.toContain("priceReveals");
    for (const client of [iosAPI, androidAPI]) {
      expect(client).not.toContain('name: "reveal"');
      expect(client).not.toContain("&reveal=true");
      expect(client).not.toMatch(/freePriceReveals(PerDay|Remaining)/);
    }
  });

  it("requires legal consent at signup or after a verified policy-version 403, never on routine login", () => {
    const iosLogin = sourceSection(iosAPI, "func login(", "func billingRecoveryPortal(");
    const iosOAuth = sourceSection(iosApp, "func completeOAuthSignIn(", "func acceptCurrentPolicies(");
    const androidLogin = sourceSection(androidAPI, "suspend fun login(", "suspend fun billingRecoveryPortal(");
    const androidOAuth = sourceSection(androidAPI, "suspend fun completeOAuthSession(", "suspend fun acceptCurrentPolicies(");

    expect(iosLogin).not.toMatch(/ageConfirmed: Bool|termsAccepted: Bool|privacyAccepted: Bool/);
    expect(iosLogin).toContain("ageConfirmed: nil");
    expect(iosOAuth).toContain("ageConfirmed: nil");
    expect(androidLogin).not.toMatch(/ageConfirmed: Boolean|termsAccepted: Boolean|privacyAccepted: Boolean/);
    expect(androidLogin).toContain("syncSupabase(accessToken, config, null, null, null)");
    expect(androidOAuth).toContain("syncSupabase(accessToken, config, null, null, null)");

    for (const source of [iosAPI, androidAPI]) {
      expect(source).toContain("legalAcceptanceRequired");
      expect(source).toContain('contains("accept the current terms")');
      expect(source).toContain('contains("privacy policy")');
    }
    for (const source of [iosApp, androidApp]) {
      expect(source).toContain("pendingLegalAcceptance");
      expect(source).toContain("legalAcceptanceVersion");
      expect(source).toContain("acceptCurrentPolicies");
    }
    expect(iosAuth).toContain("held only in memory until you decide");
    expect(androidApp).toContain("held only in memory until you decide");
    expect(androidSessions).toMatch(/data class PendingOAuthState\(\s*val codeVerifier: String\s*\)/);
    expect(androidSessions).not.toContain("val ageConfirmed: Boolean");
    expect(androidSessions).not.toContain("val termsAccepted: Boolean");
    expect(androidSessions).not.toContain("val privacyAccepted: Boolean");
  });

  it("validates signup password confirmation and clears submitted secrets", () => {
    for (const source of [iosAuth, androidApp]) {
      expect(source).toContain("Confirm password");
      expect(source).toContain("do not match");
      expect(source).toMatch(/password = ""/);
      expect(source).toMatch(/confirmPassword = ""/);
    }
    expect(iosAuth).toContain("submittedPassword == submittedConfirmation");
    expect(androidApp).toContain("submittedPassword != submittedConfirmation");
  });

  it("keeps Android discovery list-first, searchable from IME, and accessibility-clean", () => {
    expect(androidApp).toContain('FeatureCard("Venue list"');
    expect(androidApp).toContain('MetricCard("Listed venues"');
    expect(androidApp).toContain("open directions in your maps app");
    expect(androidApp).toContain('SecondaryAction("Open in Maps"');
    expect(androidApp).not.toContain("without leaving the app");
    expect(androidApp).not.toContain('MetricCard("Mapped venues"');
    expect(androidApp).toContain("imeAction = ImeAction.Search");
    expect(androidApp).toContain("KeyboardActions(onSearch = { submitSearch() })");
    expect(androidApp).toMatch(/NavigationBarItem\([\s\S]*?Icon\(Icons\.Filled\.Search, contentDescription = null\)/);
    expect(androidApp).not.toMatch(/NavigationBarItem\([\s\S]*?contentDescription = AppTab\./);
    expect(androidComponents).toContain('Text("View prices")');
  });

  it("uses purpose-specific native keyboards and disables learning for secrets", () => {
    for (const keyboardType of ["Email", "Password", "Phone", "Uri", "Decimal"]) {
      expect(androidApp).toContain(`KeyboardType.${keyboardType}`);
    }
    expect(androidApp).toContain("autoCorrectEnabled = false");
    expect(iosAuth).toContain(".keyboardType(.emailAddress)");
    expect(iosAuth).toContain(".keyboardType(.asciiCapable)");
    expect(iosAuth).toContain(".autocorrectionDisabled()");
    expect(read("apps/ios/BeerMap/Features/VenuePortalView.swift")).toContain(".keyboardType(.phonePad)");
    expect(read("apps/ios/BeerMap/Features/VenuePortalView.swift")).toContain(".keyboardType(.URL)");
    expect(read("apps/ios/BeerMap/Features/ContributeView.swift")).toContain(".keyboardType(.decimalPad)");
  });

  it("prevents duplicate Android mutations and disables shared action controls while work is active", () => {
    expect(androidApp).toContain("var mutationInFlight by mutableStateOf(false)");
    expect(androidApp).toMatch(/private suspend fun mutate[\s\S]*if \(mutationInFlight\) return false[\s\S]*mutationInFlight = false/);
    expect(androidApp).toContain("CompositionLocalProvider(LocalActionsEnabled provides !state.loading)");
    expect(androidComponents).toContain("enabled = enabled && actionsEnabled");
    expect(androidComponents).toContain("enabled = actionsEnabled");
    expect(androidApp).not.toContain('mutableStateOf(setOf("fri"))');
  });

  it("revokes all provider-linked sessions with the current Supabase access token", () => {
    for (const client of [iosAPI, androidAPI]) {
      expect(client).toContain("/api/business/auth/logout-all");
      expect(client).toContain("accessToken");
    }
    expect(iosApp).toContain("KeychainSessionStore.loadSupabaseAccessToken()");
    expect(androidApp).toContain("api.logoutAll(currentReauthenticationToken(), current)");
    expect(read("apps/ios/BeerMap/Features/AccountView.swift")).toContain("Sign out all devices");
    expect(androidApp).toContain("Sign out all devices");
  });

  it("sends the current provider token only on recent-auth account operations", () => {
    for (const client of [iosAPI, androidAPI]) {
      expect(client).toContain("X-Pint-Path-Reauth-Token");
      expect(client).not.toContain("X-Pint-Path-Current-Password");
      expect(client).not.toMatch(/current.password/i);
      for (const route of [
        "/api/business/account/sessions",
        "/api/business/account/export",
        "/api/business/account/delete-request",
        "/api/business/auth/logout-all",
      ]) {
        expect(client).toContain(route);
      }
    }
    expect(iosAPI).toMatch(/func account\(token: String\)[\s\S]*?get\("\/api\/business\/account", token: token\)/);
    expect(androidAPI).toContain('request("/api/business/account", token = token).toAccountDashboard()');
    expect(iosAPI).toMatch(/func logoutAll[\s\S]*LogoutAllRequest\(accessToken: accessToken\)[\s\S]*reauthenticationToken: accessToken/);
    expect(androidAPI).toMatch(/suspend fun logoutAll[\s\S]*put\("accessToken", accessToken\)[\s\S]*reauthenticationToken = accessToken/);
    expect(iosApp).toContain("Nothing was completed; retry after signing in.");
    expect(androidApp).toContain("Nothing was completed; retry after signing in.");
    expect(iosAccount).toContain("Sign out and sign in again");
    expect(androidApp).toContain("Sign out and sign in again");
    expect(iosApp).toContain("Pint Path has not run it automatically");
    expect(androidApp).toContain("Pint Path has not run it automatically");
  });

  it("loads recent-auth-protected session lists only after an explicit security action", () => {
    const iosAccountRefresh = sourceSection(iosApp, "func refreshAccount() async", "func loadAccountSessions() async");
    const iosCredentialRefresh = sourceSection(iosApp, "private func refreshExpiredSession()", "private func clearLocalSession()");
    const androidAccountRefresh = sourceSection(androidApp, "suspend fun refreshAccount()", "suspend fun loadAccountSessions()");
    expect(iosAccountRefresh).not.toContain("accountSessions");
    expect(iosCredentialRefresh).not.toContain("api.accountSessions");
    expect(androidAccountRefresh).not.toContain("accountSessions");

    expect(iosApp).toMatch(/func loadAccountSessions\(\) async[\s\S]*api\.accountSessions/);
    expect(androidApp).toMatch(/suspend fun loadAccountSessions\(\)[\s\S]*api\.accountSessions/);
    expect(iosApp).toContain("accountSessionsLoaded = true");
    expect(androidApp).toContain("accountSessionsLoaded = true");
    expect(iosAccount).toContain("Review signed-in sessions");
    expect(androidApp).toContain("Review signed-in sessions");
  });

  it("offers billing-only recovery for a production-shaped suspended login without granting an app session", () => {
    const productionError = {
      ok: false,
      error: {
        message: "Account access is suspended. Billing management remains available through secure billing recovery.",
        code: "ACCOUNT_SUSPENDED_BILLING_RECOVERY",
        recovery: {
          eligible: true,
          endpoint: "/api/business/billing/recovery-portal",
          consumer: true,
          venues: [],
        },
      },
    };
    expect(productionError.error.recovery.eligible).toBe(true);
    expect(productionError.error).not.toHaveProperty("details");
    const unavailableRecovery = {
      ...productionError.error,
      recovery: { ...productionError.error.recovery, eligible: false },
    };
    expect(
      unavailableRecovery.code === "ACCOUNT_SUSPENDED_BILLING_RECOVERY"
      && unavailableRecovery.recovery.eligible,
    ).toBe(false);
    const suspendedWithoutBilling = {
      message: productionError.error.message,
      code: "ACCOUNT_SUSPENDED",
    };
    expect(suspendedWithoutBilling.code === "ACCOUNT_SUSPENDED_BILLING_RECOVERY").toBe(false);
    for (const client of [iosAPI, androidAPI]) {
      expect(client).toContain("ACCOUNT_SUSPENDED_BILLING_RECOVERY");
      expect(client).toContain("/api/business/billing/recovery-portal");
      expect(client).toContain("billingRecoveryEligible");
      expect(client).toContain("billing management remains available");
    }
    expect(iosModels).toMatch(/struct APIErrorPayload[\s\S]*let code: String\?[\s\S]*let recovery: APIErrorRecovery\?/);
    expect(iosAPI).toContain("recoveryHasTarget");
    expect(androidAPI).toContain("recoveryHasTarget");
    expect(iosAPI).toContain("legacyBillingRecovery = recoveryCode == nil");
    expect(androidAPI).toContain("legacyBillingRecovery = recoveryCode == null");
    expect(iosAPI).toMatch(/BillingRecoveryProviderRequest\(accessToken: accessToken, venueId: venueId\)/);
    expect(iosAPI).toMatch(/BillingRecoveryPasswordRequest\(email: email, password: password, venueId: venueId\)/);
    expect(androidAPI).toMatch(/billingRecoveryPortal\(accessToken: String, venueId: String\?\)[\s\S]*JSONObject\(\)\.put\("accessToken", accessToken\)/);
    expect(androidAPI).toMatch(/billingRecoveryPortal\(email: String, password: String, venueId: String\?\)[\s\S]*\.put\("email", email\)[\s\S]*\.put\("password", password\)/);
    expect(iosApp).toMatch(/presentBillingRecovery[\s\S]*clearLocalSession\(\)[\s\S]*billingRecoveryAccessToken/);
    expect(androidApp).toMatch(/presentBillingRecovery[\s\S]*clearLocalSession\(\)[\s\S]*billingRecoveryAccessToken/);
    for (const ui of [iosAuth, androidApp]) {
      expect(ui).toContain("Manage billing only");
      expect(ui).toContain("will not create an app session or restore suspended access");
    }
    for (const source of [iosAPI, androidAPI]) {
      expect(source).toContain("BILLING_RECOVERY_VENUE_SELECTION_REQUIRED");
    }
    expect(iosModels).toContain("let venues: [BillingRecoveryVenue]?");
    expect(androidAPI).toContain("billingRecoveryVenues");
    expect(iosAuth).toContain("Choose a managed venue");
    expect(iosAuth).toContain("Personal subscription");
    expect(androidApp).toContain("Personal subscription");
    expect(androidApp).toContain("billingRecoveryVenueId");
  });

  it("keeps optional analytics consent scoped to a confirmed signed-in account", () => {
    expect(iosApp).toContain("guard optionalAnalyticsEnabled, let token = sessionToken else { return }");
    expect(iosApp).toContain('UserDefaults.standard.removeObject(forKey: "au.pintpath.beermap.optionalAnalytics")');
    expect(iosApp).toMatch(/private func clearLocalSession\(\)[\s\S]*resetOptionalAnalytics\(\)/);

    expect(androidApp).toContain("if (optionalAnalytics && current != null)");
    expect(androidApp).toMatch(/private fun clearLocalSession\(\)[\s\S]*optionalAnalytics = false/);
    expect(androidApp).toMatch(/private fun storeSession[\s\S]*if \(resetAuthority\)[\s\S]*optionalAnalytics = false/);
  });

  it("refreshes and retries authenticated actions without discarding venue context", () => {
    expect(iosApp).toContain("withAuthenticatedSession");
    expect(iosApp).toContain("storeSession(result.authResult, resetAuthority: false)");
    expect(iosApp).toMatch(/func saveProfile[\s\S]*withAuthenticatedSession/);
    expect(iosApp).toMatch(/func submitSourcePhotoUpdate[\s\S]*withAuthenticatedSession/);

    expect(androidApp).toContain("resetAuthority = false");
    expect(androidApp).toMatch(/private suspend fun busy[\s\S]*refreshSession\(\)[\s\S]*block\(\)/);
    expect(androidApp).toMatch(/private fun storeSession[\s\S]*if \(resetAuthority\)/);
    expect(androidAPI).toContain("runCatching { JSONObject(text) }.getOrNull()");
  });

  it("prepares bounded source photos away from the UI thread with cancellation", () => {
    const iosContribute = read("apps/ios/BeerMap/Features/ContributeView.swift");
    expect(iosContribute).toContain("import ImageIO");
    expect(iosContribute).toContain("Task.detached(priority: .userInitiated)");
    expect(iosContribute).toContain("CGImageSourceCreateThumbnailAtIndex");
    expect(iosContribute).toContain("sourcePhotoPreparationTask?.cancel()");
    expect(iosContribute).toMatch(/private func prepareSourcePhoto[\s\S]*base64EncodedString\(\)/);
    expect(iosContribute).not.toContain("sourcePhotoData.base64EncodedString()");

    expect(androidApp).toContain("withContext(Dispatchers.IO)");
    expect(androidApp).toContain("File.createTempFile");
    expect(androidApp).toContain("currentCoroutineContext().ensureActive()");
    expect(androidApp).toContain("sourcePhotoPreparationJob?.cancel()");
    expect(androidApp).not.toContain("BitmapFactory.decodeByteArray(originalBytes");
    expect(androidBuild).toContain('androidx.exifinterface:exifinterface:1.4.2');
    expect(androidApp).toContain("ImageDecoder.decodeBitmap");
    expect(androidApp).toContain("ExifInterface.TAG_ORIENTATION");
    expect(androidApp).toContain("ExifInterface.ORIENTATION_ROTATE_90");
    expect(androidApp).toContain("Bitmap.createBitmap");

    const jpeg = Buffer.from(read("test/fixtures/android-exif-orientation-6.jpg.base64").trim(), "base64");
    const exifOffset = jpeg.indexOf(Buffer.from("Exif\0\0", "binary"));
    expect(exifOffset).toBeGreaterThan(0);
    const tiffOffset = exifOffset + 6;
    const littleEndian = jpeg.toString("ascii", tiffOffset, tiffOffset + 2) === "II";
    const readUInt16 = (offset: number) => littleEndian
      ? jpeg.readUInt16LE(offset)
      : jpeg.readUInt16BE(offset);
    const readUInt32 = (offset: number) => littleEndian
      ? jpeg.readUInt32LE(offset)
      : jpeg.readUInt32BE(offset);
    const firstIfd = tiffOffset + readUInt32(tiffOffset + 4);
    const entryCount = readUInt16(firstIfd);
    let orientation: number | undefined;
    for (let index = 0; index < entryCount; index += 1) {
      const entry = firstIfd + 2 + (index * 12);
      if (readUInt16(entry) === 0x0112) orientation = readUInt16(entry + 8);
    }
    expect(orientation).toBe(6);
  });

  it("keeps compiler-sensitive native concurrency and imports valid", () => {
    const iosContribute = read("apps/ios/BeerMap/Features/ContributeView.swift");
    expect(androidAPI).toMatch(/^import java\.util\.Locale$/m);
    expect(androidAPI).toMatch(/^import kotlinx\.coroutines\.withContext$/m);
    expect(androidAPI).not.toContain("throw@withContext");
    expect(iosContribute).toMatch(
      /@MainActor\s+private final class OneTimeLocationProof:[^{\n]*@preconcurrency\s+CLLocationManagerDelegate/,
    );
  });

  it("binds native provider login with PKCE instead of a caller-controlled OAuth state", () => {
    for (const source of [iosAuth, androidApp]) {
      expect(source).toContain("code_challenge");
      expect(source).toContain("code_challenge_method");
      expect(source).not.toContain('URLQueryItem(name: "state"');
      expect(source).not.toContain('.appendQueryParameter("state"');
    }
    expect(iosAPI).toContain("/auth/v1/token?grant_type=pkce");
    expect(androidAPI).toContain("/auth/v1/token?grant_type=pkce");
    expect(iosAuth).toContain('callbackURL.scheme == "pintpath"');
    expect(androidApp).toContain('uri.scheme == "pintpath" && uri.host == "auth-callback"');
  });

  it("protects session material and handles uninstall/reinstall safely", () => {
    expect(iosKeychain).toContain("kSecAttrAccessibleWhenUnlockedThisDeviceOnly");
    expect(iosKeychain).not.toContain("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly");
    expect(iosApp).toContain("installMarker");
    expect(iosApp).toContain("hasLegacyAppContainer");
    expect(iosApp).toContain("KeychainSessionStore.deleteToken()");

    expect(androidSessions).toContain("AndroidKeyStore");
    expect(androidSessions).toContain("AES/GCM/NoPadding");
    expect(androidSessions).toContain("supabase_refresh_token");
    expect(androidSessions).toContain("supabase_access_token");
    expect(androidSessions).toContain('saveEncrypted("pending_oauth_code_verifier"');
    expect(read("apps/android/app/src/main/res/xml/backup_rules.xml")).toContain('path="beermap_session.xml"');
    expect(read("apps/android/app/src/main/res/xml/data_extraction_rules.xml")).toContain('path="beermap_session.xml"');
  });

  it("matches current account, deletion, invitation, and privacy response envelopes", () => {
    for (const client of [iosAPI, androidAPI]) {
      expect(client).toContain("/api/business/account/privacy-settings");
      expect(client).toContain("/api/business/account/delete-request");
      expect(client).toContain("/counter-staff-invitations/");
    }
    expect(iosModels).toContain("struct PrivacySettingsSaveResult");
    expect(iosModels).toContain("struct AccountDeletionStatusResponse");
    expect(androidModels).toContain("data class AccountDeletionStatus");
    expect(androidModels).toContain("counterStaffInvitations");
  });

  it("includes required location timestamps and mission lifecycle routes", () => {
    expect(iosModels).toMatch(/struct UploadLocationRequest[\s\S]*let capturedAt: String/);
    expect(androidModels).toMatch(/data class UploadLocation[\s\S]*val capturedAt: String/);
    expect(androidModels).toContain('.put("capturedAt", capturedAt)');
    for (const client of [iosAPI, androidAPI]) {
      expect(client).toContain("/accept");
      expect(client).toContain("/release");
    }
  });

  it("makes every paged native collection reachable with progress guards", () => {
    for (const client of [iosAPI, androidAPI]) {
      expect(client).toContain("offset");
      expect(client).toContain("hasMore");
      expect(client).toContain("nextCursor");
      expect(client).toMatch(/pagination (stopped making progress|returned an invalid next page)/);
      expect(client).toContain("repeated cursor");
      expect(client).not.toContain("venues?limit=80");
      expect(client).not.toContain("missions?limit=50");
      expect(client).not.toContain("limit=120");
      expect(client).not.toContain("100_000");
    }
    expect(iosModels).toContain("struct OffsetPagination");
    expect(iosModels).toMatch(/struct PriceRecordsResponse[\s\S]*let access: AccessState\?[\s\S]*let nextCursor: String\?/);
    expect(androidModels).toMatch(/data class PriceRecordsResult[\s\S]*val access: PriceAccessState\?[\s\S]*val nextCursor: String\?/);
    expect(iosApp).toContain("selectedVenuePrices = [:]");
    expect(androidApp).toContain("selectedPriceResult = null");

    expect(iosAPI).not.toContain("guard !response.records.isEmpty, nextCursor != cursor");
    expect(androidAPI).not.toContain("if (page.isEmpty() || nextCursor == cursor");
    for (const client of [iosAPI, androidAPI]) {
      expect(client).toContain("Price pagination exceeded its safety limit");
      expect(client).toContain("priceRecordIdentityKey");
      expect(client).toContain("normalizedBeerId");
    }

    const schemas = read("src/modules/business/business.schemas.ts");
    const service = read("src/modules/business/business.service.ts");
    expect(schemas).toMatch(/venuesQuerySchema[\s\S]*offset:/);
    expect(schemas).toMatch(/missionsQuerySchema[\s\S]*offset:/);
    expect(schemas).toMatch(/priceRecordsQuerySchema[\s\S]*cursor:/);
    expect(service).toContain("nextCursor");
    expect(service).toContain("pagination: {");
  });

  it("keeps native page sizes and cursors inside the live backend contracts", () => {
    expect(venuesQuerySchema.parse({ limit: "500", offset: "500" })).toMatchObject({ limit: 500, offset: 500 });
    expect(missionsQuerySchema.parse({ limit: "200", offset: "200" })).toMatchObject({ limit: 200, offset: 200 });
    expect(adminPaginationSchema.parse({ limit: "100", offset: "100" })).toMatchObject({ limit: 100, offset: 100 });
    expect(priceRecordsQuerySchema.parse({ limit: "500", cursor: "opaque-page-token" })).toMatchObject({
      limit: 500,
      cursor: "opaque-page-token",
    });
    const deepOffset = 250_001;
    expect(venuesQuerySchema.parse({ offset: String(deepOffset) }).offset).toBe(deepOffset);
    expect(missionsQuerySchema.parse({ offset: String(deepOffset) }).offset).toBe(deepOffset);
    expect(submissionsQuerySchema.parse({ offset: String(deepOffset) }).offset).toBe(deepOffset);
    expect(adminPaginationSchema.parse({ offset: String(deepOffset) }).offset).toBe(deepOffset);
    expect(venueReconciliationQuerySchema.parse({ offset: String(deepOffset) }).offset).toBe(deepOffset);
    expect(beerCatalogAdminQuerySchema.parse({
      pendingOffset: String(deepOffset),
      activeOffset: String(deepOffset + 1),
    })).toMatchObject({ pendingOffset: deepOffset, activeOffset: deepOffset + 1 });
    expect(() => venuesQuerySchema.parse({ offset: String(Number.MAX_SAFE_INTEGER + 1) })).toThrow();
  });

  it("preserves hidden venue fields and uses optimistic timestamps", () => {
    expect(iosModels).toContain("var expectedUpdatedAt: String? = nil");
    expect(androidModels).toContain('.put("openingHours", openingHours)');
    expect(androidModels).toContain('.put("venueTags", JSONArray(venueTags))');
    expect(androidModels).toContain('.putNullable("expectedUpdatedAt", updatedAt)');
    expect(androidModels).toContain('abv = doubleOrNull("abv")');
  });

  it("gates native venue navigation with current server authority, not persisted roles", () => {
    const hasVenueAccess = (authority: {
      persistedRole: string;
      persistedSubscription: string;
      serverIsAdmin: boolean;
      portalIsAdmin: boolean;
      assignmentCount: number;
      accessState: string;
    }) => authority.accessState !== "claim_required" && (
      (authority.serverIsAdmin && authority.portalIsAdmin)
      || (!authority.portalIsAdmin && authority.assignmentCount > 0)
    );

    expect(hasVenueAccess({
      persistedRole: "admin",
      persistedSubscription: "admin",
      serverIsAdmin: false,
      portalIsAdmin: true,
      assignmentCount: 20,
      accessState: "admin",
    })).toBe(false);
    expect(hasVenueAccess({
      persistedRole: "user",
      persistedSubscription: "free",
      serverIsAdmin: false,
      portalIsAdmin: false,
      assignmentCount: 1,
      accessState: "manager",
    })).toBe(true);
    expect(hasVenueAccess({
      persistedRole: "user",
      persistedSubscription: "free",
      serverIsAdmin: false,
      portalIsAdmin: false,
      assignmentCount: 1,
      accessState: "claim_required",
    })).toBe(false);

    expect(iosModels).toMatch(/struct AccessState[\s\S]*let accountRole: String\?[\s\S]*let isAdmin: Bool\?/);
    expect(iosApp).toContain("accountDashboard?.access?.isAdmin == true");
    expect(iosApp).toContain("venuePortal.isAdmin != true && venuePortal.assignments?.isEmpty == false");
    expect(iosApp).toMatch(/private func storeSession[\s\S]*venuePortal = nil[\s\S]*accountDashboard = AccountDashboard/);
    expect(iosApp).not.toContain('account?.role == "admin"');
    expect(iosRoot).toContain("model.hasVenueAccess");

    expect(androidModels).toContain("data class AccountAccess");
    expect(androidModels).toContain('access = optJSONObject("access")');
    expect(androidModels).toContain('isAdmin = optBoolean("isAdmin", false)');
    expect(androidApp).toContain("accountDashboard?.access?.isAdmin == true");
    expect(androidApp).toContain("!currentPortal.isAdmin && currentPortal.assignments.isNotEmpty()");
    expect(androidApp).toMatch(/private fun storeSession[\s\S]*accountDashboard = null[\s\S]*portal = null/);
    expect(androidApp).toContain("if (!state.hasVenueAccess && tab == AppTab.Bars) tab = AppTab.Account");
    expect(androidApp).not.toContain('account.role == "admin"');
    expect(androidApp).not.toContain('account.subscriptionStatus == "admin"');

    const service = read("src/modules/business/business.service.ts");
    expect(service).toContain("access: this.getAccessState(account, null)");
    expect(service).toContain("isAdmin: currentAdmin");
  });

  it("renders the authoritative upload total when recent history is capped at 12", () => {
    const fixture = JSON.parse(read("test/fixtures/native-account-dashboard-over-12.json")) as {
      dashboardStats: { totalUploads: number };
      submissions: Array<{ id: string }>;
    };
    const displayedUploads = fixture.dashboardStats.totalUploads ?? fixture.submissions.length;

    expect(fixture.submissions).toHaveLength(12);
    expect(displayedUploads).toBe(37);
    expect(displayedUploads).toBeGreaterThan(fixture.submissions.length);
    expect(androidApp).toContain("dashboard.stats?.totalSubmissions ?: dashboard.submissionCount");
  });

  it("keeps mobile documentation aligned with the implemented feature set", () => {
    const docs = [
      "apps/ios/README.md",
      "apps/android/README.md",
      "MOBILE_APP_README.md",
      "MOBILE_STATUS_REPORT.md",
      "MOBILE_APP_STORE_CHECKLIST.md",
      "MOBILE_APP_RELEASE_NOTES_DRAFT.md",
    ].map(read).join("\n");

    expect(docs).not.toMatch(/native (google|apple) oauth is not wired/i);
    expect(docs).not.toMatch(/photo evidence upload is not wired/i);
    expect(docs).not.toMatch(/upload-location proof is not wired/i);
    expect(docs).toContain("Pint Path");
    expect(docs).toContain("PKCE");
  });
});
