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
  const iosSettings = read("apps/ios/BeerMap/Features/SettingsView.swift");
  const iosKeychain = read("apps/ios/BeerMap/Services/KeychainSessionStore.swift");
  const androidAPI = read("apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt");
  const androidModels = read("apps/android/app/src/main/java/au/pintpath/beermap/data/Models.kt");
  const androidApp = read("apps/android/app/src/main/java/au/pintpath/beermap/ui/features/BeerMapApp.kt");
  const androidSessions = read("apps/android/app/src/main/java/au/pintpath/beermap/data/SessionStore.kt");
  const androidComponents = read("apps/android/app/src/main/java/au/pintpath/beermap/ui/components/Components.kt");
  const androidBuild = read("apps/android/app/build.gradle.kts");

  it("ships the Pint Path display brand on both platforms", () => {
    const info = read("apps/ios/BeerMap/Info.plist");
    const iosProject = read("apps/ios/BeerMap.xcodeproj/project.pbxproj");
    const iosConfig = read("apps/ios/Config.example.xcconfig");
    const strings = read("apps/android/app/src/main/res/values/strings.xml");

    expect(info).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Pint Path<\/string>/);
    expect(info).toContain("<string>au.pintpath.app.auth</string>");
    expect(iosProject).toContain("PRODUCT_BUNDLE_IDENTIFIER = au.pintpath.app;");
    expect(iosConfig).toContain("PRODUCT_BUNDLE_IDENTIFIER = au.pintpath.app");
    expect(iosKeychain).toContain('private static let service = "au.pintpath.app.session"');
    expect([info, iosProject, iosConfig, iosKeychain, iosApp].join("\n")).not.toContain(
      "au.pintpath.beermap",
    );
    expect(strings).toContain('<string name="app_name">Pint Path</string>');
  });

  it("uses Supabase Auth plus a scoped app-session exchange in production", () => {
    const supabaseConfig = read("supabase/config.toml");
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
    expect(supabaseConfig).toContain('"https://pintpath.au/auth/callback"');
    expect(supabaseConfig).toContain('"pintpath://auth-callback"');
    expect(iosAuth).toContain("SignInWithAppleButton");
    expect(iosAuth).toContain("nonce: nonce");
    expect(iosAuth).toContain("ASAuthorizationAppleIDCredential");
    expect(iosAuth).toContain("request.nonce = Self.sha256(nonce)");
    expect(iosAuth).toContain('provider: "google"');
    expect(iosAuth).toContain('provider: "apple"');
    expect(iosAuth).toContain("exchangeSupabaseIDToken");
    expect(iosAPI).toContain("/auth/v1/token?grant_type=id_token");
    expect(iosAuth).toContain("ASWebAuthenticationSession");
    expect(iosAuth).toContain('appendingPathComponent("auth/v1/authorize")');
    expect(iosAuth).toContain(
      'URLQueryItem(name: "redirect_to", value: "pintpath://auth-callback")',
    );
    expect(iosAuth).toContain("code_challenge");
    expect(iosAPI).toContain("exchangeSupabasePKCE");
    expect(androidApp).toContain(
      '.appendQueryParameter("redirect_to", "pintpath://auth-callback")',
    );
    expect(androidApp).toContain("code_challenge");
    expect(androidApp).toContain("code_challenge_method");
  });

  it("reports the effective native Supabase configuration in debug settings", () => {
    expect(iosSettings).toContain("model.config?.supabaseUrl");
    expect(iosSettings).toContain("model.config?.supabaseAnonKey");
    expect(iosSettings).not.toContain("AppConfig.supabaseURL == nil");
    expect(androidApp).toContain('state.config.stringOrNull("supabaseUrl")');
    expect(androidApp).toContain('state.config.stringOrNull("supabaseAnonKey")');
    expect(androidApp).toContain("hasServerSupabaseConfig || hasEmbeddedSupabaseConfig");
  });

  it("matches the production public-config and venue discovery response shapes", () => {
    const trackedBeer = sourceSection(iosModels, "struct TrackedBeer", "struct AuthResult");
    expect(trackedBeer).toContain("case key");
    expect(trackedBeer).toMatch(/decodeIfPresent\(String\.self, forKey: \.key\)/);
    expect(iosModels).toContain("let highlightedName: Bool?");
    expect(iosModels).not.toContain("let highlightedName: String?");

    expect(iosAPI).toContain("APIStatusEnvelope");
    expect(iosAPI).toContain("throw BeerMapAPIError.invalidResponse");
    expect(iosAPI).not.toContain("let envelope = try? decoder.decode(APIEnvelope<T>.self, from: data)");
  });

  it("clusters iOS venue annotations instead of rebuilding hundreds of SwiftUI pin views", () => {
    expect(iosDiscover).toContain("UIViewRepresentable");
    expect(iosDiscover).toContain("MKMarkerAnnotationView");
    expect(iosDiscover).toContain("clusteringIdentifier = Self.clusterIdentifier");
    expect(iosDiscover).toContain("incomingSnapshots != snapshotsByID");
    expect(iosDiscover).not.toContain("Map(position: $mapPosition)");
    expect(iosDiscover).not.toContain("ForEach(mappedVenues)");
    expect(iosDiscover).not.toContain(".background(.thinMaterial, in: Circle())");
  });

  it("reuses the logical Pint Path session only when refreshing Supabase credentials", () => {
    const iosSync = sourceSection(iosAPI, "func syncSupabase(", "func requestPasswordReset(");
    const iosRefresh = sourceSection(iosAPI, "func refreshSupabaseSession(", "func exchangeSupabaseIDToken(");
    const iosLogin = sourceSection(iosAPI, "func login(", "func billingRecoveryPortal(");
    const iosSignup = sourceSection(iosAPI, "func signup(", "func syncSupabase(");
    const iosOAuth = sourceSection(iosApp, "func completeOAuthSignIn(", "func openBillingRecovery(");
    expect(iosSync).toContain("existingAppToken: String? = nil");
    expect(iosSync).toContain("token: existingAppToken");
    expect(iosSync).toMatch(
      /catch let apiError as BeerMapAPIError[\s\S]*apiError\.isUnauthorized && existingAppToken != nil[\s\S]*return try await send\([\s\S]*body: body/,
    );
    expect(iosRefresh).toContain("existingAppToken: String");
    expect(iosRefresh).toContain("existingAppToken: existingAppToken");
    expect(iosApp).toContain("api.refreshSupabaseTokens(");
    expect(iosApp).toMatch(
      /saveSupabaseRefreshToken\(providerTokens\.refreshToken \?\? refreshToken\)[\s\S]*api\.syncSupabase\([\s\S]*existingAppToken: currentToken/,
    );
    expect(iosApp).toContain("sessionRefreshTask");
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

  it("preserves valid iOS sessions across transient refresh and provider-sync failures", () => {
    const refreshGate = sourceSection(
      iosApp,
      "private func refreshExpiredSession()",
      "private func performSessionRefresh(",
    );
    const refresh = sourceSection(
      iosApp,
      "private func performSessionRefresh(",
      "private func clearLocalSession()",
    );
    const providerEntry = sourceSection(
      iosApp,
      "func completeOAuthSignIn(",
      "private func completeOAuthSignIn(",
    );
    const providerFinish = sourceSection(
      iosApp,
      "private func completeOAuthSignIn(",
      "func retryPendingProviderSignIn()",
    );
    const providerRetry = sourceSection(
      iosApp,
      "func retryPendingProviderSignIn()",
      "func acceptCurrentPolicies(",
    );
    const authenticatedRetry = sourceSection(
      iosApp,
      "private func withAuthenticatedSession",
      "private func withOptionalAuthenticatedSession",
    );
    const optionalRetry = sourceSection(
      iosApp,
      "private func withOptionalAuthenticatedSession",
      "private func setLoading",
    );
    const clearSession = sourceSection(
      iosApp,
      "private func clearLocalSession()",
      "private func invalidateSessionRefresh()",
    );
    const invalidateRefresh = sourceSection(
      iosApp,
      "private func invalidateSessionRefresh()",
      "private func authenticationIsCurrent(",
    );

    expect(iosApp).toContain("private enum SessionRefreshOutcome: Sendable");
    expect(iosApp).toContain("private var authenticationGeneration: UInt64 = 0");
    expect(refreshGate).toMatch(
      /let refreshGeneration = authenticationGeneration[\s\S]*expectedGeneration: refreshGeneration[\s\S]*if authenticationGeneration == refreshGeneration/,
    );
    expect(refresh).toMatch(
      /saveSupabaseRefreshToken\(providerTokens\.refreshToken \?\? refreshToken\)[\s\S]*saveSupabaseAccessToken\(providerAccessToken\)[\s\S]*api\.syncSupabase\([\s\S]*existingAppToken: currentToken/,
    );
    expect(refresh.match(/authenticationIsCurrent\(/g)?.length).toBeGreaterThanOrEqual(7);
    expect(refresh).toMatch(
      /catch let apiError as BeerMapAPIError where apiError\.isConclusiveAuthenticationRejection \{[\s\S]*clearLocalSession\(\)[\s\S]*return \.invalidCredentials/,
    );
    expect(refresh).toMatch(/catch \{\s*return \.retryableFailure\s*\}/);
    expect(clearSession).toContain("invalidateSessionRefresh()");
    expect(invalidateRefresh).toContain("authenticationGeneration &+= 1");
    expect(invalidateRefresh).toContain("sessionRefreshTask?.cancel()");
    expect(invalidateRefresh).toContain("sessionRefreshTask = nil");
    for (const retry of [authenticatedRetry, optionalRetry]) {
      expect(retry).toContain("let operationGeneration = authenticationGeneration");
      expect(retry.match(/authenticationGeneration == operationGeneration/g)?.length).toBe(2);
      expect(retry).toContain("if sessionToken != currentToken, let newerToken = sessionToken");
      expect(retry).toContain("case .retryableFailure:");
      expect(retry).not.toMatch(/case \.retryableFailure:[\s\S]*clearLocalSession\(\)/);
    }

    expect(iosApp).toContain(
      "private static let providerSignInRetryWindow: TimeInterval = 10 * 60",
    );
    expect(providerEntry).toContain(
      "Date().addingTimeInterval(Self.providerSignInRetryWindow)",
    );
    expect(providerFinish).toMatch(
      /pendingProviderSignIn = PendingProviderSignIn[\s\S]*providerSignInRetryAvailable = true/,
    );
    expect(providerFinish).toMatch(
      /try storeAuthenticatedSession\([\s\S]*clearPendingProviderSignIn\(\)[\s\S]*finishSignIn/,
    );
    expect(providerFinish).toContain(
      "Your verified provider sign-in is still available; choose Retry finishing sign-in.",
    );
    expect(providerRetry).toContain("guard pendingProviderSignIn.expiresAt > Date()");
    expect(providerRetry).toContain("expiresAt: pendingProviderSignIn.expiresAt");
    expect(iosAuth).toContain("Retry finishing sign-in");
    expect(iosAccount).toContain("Session retained");
    expect(iosAccount).toContain("Log out or switch account");
  });

  it("keeps price-access contracts without obstructing Explore with account metrics", () => {
    expect(iosDiscover).not.toContain('title: "Free price access"');
    expect(iosDiscover).not.toContain('value: "Fixed preview"');
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

  it("keeps iOS exploration map-first with stable navigation and accessible filters", () => {
    expect(iosRoot).toContain('Label("Explore", systemImage: "map.fill")');
    expect(iosRoot).toContain('Label("Add Price", systemImage: "plus.circle.fill")');
    expect(iosRoot).toContain('Label("Account", systemImage: "person.crop.circle")');
    expect(iosRoot).toContain('Label("More", systemImage: "ellipsis.circle.fill")');
    expect(iosRoot).not.toContain('Label("Find"');
    expect(iosRoot).not.toContain('Label("Bars"');
    expect(iosDiscover).not.toContain('.navigationTitle("Find")');
    expect(iosDiscover).toContain('.searchable(');
    expect(iosDiscover).not.toContain("ExploreDisplayMode");
    expect(iosDiscover).not.toContain("venueList(");
    expect(iosDiscover).not.toContain("Show venue list");
    expect(iosDiscover).not.toContain("more in List");
    expect(iosDiscover).toContain("venueMap(filteredVenues: results.filtered, mappedVenues: results.mapped)");
    expect(iosDiscover).toContain('FilterChip(');
    expect(iosDiscover).toContain('ExploreFilterSheet(');
    expect(iosDiscover).toContain("private static let pageSize = 6");
    expect(iosDiscover).toContain('Label("Load more areas"');
    expect(iosDiscover).toContain('Label("Load more beers"');
    expect(iosDiscover).toContain("matchingSuburbs.prefix(visibleSuburbCount)");
    expect(iosDiscover).toContain("matchingBeers.prefix(visibleBeerCount)");
    expect(iosDiscover).toContain("visibleSuburbCount = Self.pageSize");
    expect(iosDiscover).toContain("visibleBeerCount = Self.pageSize");
    expect(iosDiscover).toContain('ExploreBeerOption(id: "guinness"');
    expect(iosDiscover).toContain('ExploreBeerOption(id: "carlton_draft"');
    expect(iosDiscover).toContain('ExploreBeerOption(id: "stone_and_wood_pacific_ale"');
    expect(iosDiscover).toContain("model.accountDashboard?.access?.hasFullAccess == true");
    expect(iosDiscover).toContain("venueBeerKeys: venue.beerKeys");
    expect(iosDiscover).toContain('Image(systemName: "lock.fill")');
    expect(iosDiscover).toContain('Text("Contributor or paid")');
    expect(iosDiscover).toContain("assetImage: BeerMapAsset.beerPint");
    expect(iosModels).toContain("let beerKeys: [String]?");
    expect(iosAPI).toMatch(/func listVenues\([\s\S]*token: String\? = nil/);
    expect(iosAPI).toMatch(/\/api\/business\/venues[\s\S]*token: token/);
    expect(iosApp).toMatch(/api\.listVenues\(query: search, token: token\)/);
    expect(iosDiscover).toContain('didFitInitialRegion');
    expect(iosDiscover).toContain('mapView.isRotateEnabled = false');
    expect(iosDiscover).toContain('manager.desiredAccuracy = kCLLocationAccuracyHundredMeters');
    expect(iosDiscover).toContain('manager.requestLocation()');
    expect(iosDiscover).not.toContain('manager.startUpdatingLocation()');
    expect(iosDiscover).toContain('model.startPriceContribution(for: venue)');
    expect(iosApp).toContain('pendingContributionVenueId = venue.id');
    expect(iosApp).toContain('selectedTab = .addPrice');
  });

  it("makes the iOS quick-price flow explicit, searchable, and evidence-aware", () => {
    const iosContribute = read("apps/ios/BeerMap/Features/ContributeView.swift");
    const iosReusable = read("apps/ios/BeerMap/Components/ReusableViews.swift");
    const iosVenuePortal = read("apps/ios/BeerMap/Features/VenuePortalView.swift");
    const servingAssets = {
      pint: read("apps/ios/BeerMap/Assets.xcassets/BeerPint.imageset/beer-pint.svg"),
      pot: read("apps/ios/BeerMap/Assets.xcassets/BeerPot.imageset/beer-pot.svg"),
      schooner: read(
        "apps/ios/BeerMap/Assets.xcassets/BeerSchooner.imageset/beer-schooner.svg",
      ),
      jug: read("apps/ios/BeerMap/Assets.xcassets/BeerJug.imageset/beer-jug.svg"),
    };
    const venuePicker = sourceSection(
      iosContribute,
      "private struct VenueSelectionSheet",
      "@MainActor\nprivate final class VenuePickerLocationProvider",
    );
    const info = read("apps/ios/BeerMap/Info.plist");
    expect(iosContribute).toContain('title: "Quick price"');
    expect(iosContribute).toContain('VenueSelectionSheet(');
    expect(iosContribute).toContain('.searchable(text: $searchText');
    expect(iosContribute).toContain('model.config?.trackedBeers');
    expect(iosContribute).toContain('sourcePhotoDataUrl: sourcePhotoDataURL');
    expect(iosContribute).toContain('Enter a price from $0.01 to $250');
    expect(iosContribute).not.toContain('selectedVenueId = model.venues.first');
    expect(iosContribute).toContain('kCGImageSourceThumbnailMaxPixelSize: 2_800');
    expect(iosContribute).toContain('applyPendingVenueSelection()');
    expect(iosContribute).toContain('takePendingContributionVenueId()');
    expect(iosContribute).toContain('CameraPhotoPicker { image in');
    expect(iosContribute).toContain('UIImagePickerController.isSourceTypeAvailable(.camera)');
    expect(iosContribute).toContain('confirmedCustomBeerName');
    expect(iosContribute).toContain('let recentVenue = recentVenue');
    expect(venuePicker).toContain("let venuePageSize = 10");
    expect(venuePicker).toContain("let allMatches = matchingVenues(excluding: recentVenue?.id)");
    expect(venuePicker).toContain("Array(allMatches.prefix(visibleVenueLimit))");
    expect(venuePicker).toContain('localizedStandardContains(query)');
    expect(venuePicker.indexOf("localizedStandardContains(query)")).toBeLessThan(
      venuePicker.indexOf("allMatches.prefix(visibleVenueLimit)"),
    );
    expect(venuePicker).toContain("visibleVenueLimit + venuePageSize");
    expect(venuePicker).toContain(".onChange(of: searchText)");
    expect(venuePicker).toContain("locationProvider.requestOnce()");
    expect(venuePicker).toContain("origin.distance(from: venueLocation)");
    expect(iosContribute).toContain("manager.requestLocation()");
    expect(iosContribute).not.toContain("manager.startUpdatingLocation()");
    expect(iosContribute).toMatch(/case "pint": return BeerMapAsset\.beerPint/);
    expect(iosContribute).toMatch(/case "pot": return BeerMapAsset\.beerPot/);
    expect(iosContribute).toMatch(/case "schooner": return BeerMapAsset\.beerSchooner/);
    expect(iosContribute).toMatch(/case "jug": return BeerMapAsset\.beerJug/);
    expect(iosContribute).not.toContain('["pint", "pot", "schooner", "jug"].contains(serving)');
    expect(new Set(Object.values(servingAssets)).size).toBe(4);
    for (const asset of Object.values(servingAssets)) {
      expect(asset).toContain('<svg width="24" height="24"');
    }
    expect([iosContribute, iosDiscover, iosReusable, iosVenuePortal].join("\n")).not.toContain('"mug.fill"');
    for (const assetName of ["beerPint", "beerPot", "beerSchooner", "beerJug"]) {
      expect([iosContribute, iosReusable].join("\n")).toContain(`BeerMapAsset.${assetName}`);
    }
    expect(info).toContain('<key>NSCameraUsageDescription</key>');
    expect(iosModels).toContain('let statusCopy: String?');
    expect(iosModels).toContain('let ocrStatus: String?');
  });

  it("makes Android menu capture durable enough for OCR and explicit about camera, venue, and result state", () => {
    const manifest = read("apps/android/app/src/main/AndroidManifest.xml");
    const filePaths = read("apps/android/app/src/main/res/xml/file_paths.xml");
    const photoApi = sourceSection(
      androidAPI,
      "suspend fun submitPhotoUpload(",
      "suspend fun submitHappyHourUpdate(",
    );
    const photoCard = sourceSection(
      androidApp,
      "private fun PhotoUploadCard(",
      "private fun LocationProofCard(",
    );
    const venueSearch = sourceSection(
      androidApp,
      "private fun SearchablePhotoVenueChoice(",
      "private fun VenueChoiceChips(",
    );

    expect(photoApi).toContain("readTimeoutMs = 300_000");
    expect(androidAPI).toMatch(
      /private suspend fun request\([\s\S]*readTimeoutMs: Int = 20_000[\s\S]*readTimeout = readTimeoutMs/,
    );
    expect(androidApp).toContain('result.stringOrNull("statusCopy")');
    expect(androidApp).not.toContain("selectedVenueId = state.venues.firstOrNull()?.id.orEmpty()");
    expect(androidApp).toContain("var contributionVenues by mutableStateOf<List<Venue>>(emptyList())");
    expect(androidApp).toContain("if (search.isNullOrBlank()) contributionVenues = loadedVenues");
    expect(androidApp).toContain("val venue = contributionVenues.firstOrNull { it.id == venueId }");
    expect(photoCard).toContain("state.contributionVenues");
    expect(photoCard).toContain("SearchablePhotoVenueChoice");
    expect(venueSearch).toContain("venues.asSequence()");
    expect(venueSearch).toContain("venue.suburb");
    expect(venueSearch).toContain("venue.address");
    expect(venueSearch.indexOf(".filter { venue ->")).toBeLessThan(venueSearch.indexOf(".take(12)"));
    expect(androidApp).toContain("ActivityResultContracts.TakePicture()");
    expect(androidApp).toContain("FileProvider.getUriForFile");
    expect(androidApp).toContain("pendingCameraPhotoPath by rememberSaveable");
    expect(photoCard).toContain('SecondaryAction("Take menu photo"');
    expect(androidApp).toContain("decodeSourcePhotoBitmap(cacheFile, sampleSize, 2_800)");
    expect(androidApp).toContain("decoder.setTargetSize(");
    expect(androidApp).toContain("OCR will read the beer rows and pint prices");
    expect(manifest).toContain('android:name="androidx.core.content.FileProvider"');
    expect(manifest).toContain('android:authorities="${applicationId}.fileprovider"');
    expect(manifest).not.toContain("android.permission.CAMERA");
    expect(filePaths).toContain('name="camera_source_images"');
    expect(filePaths).toContain('path="camera/"');
    expect(filePaths).not.toContain('path="."');
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

  it("fails closed on missing native policy configuration and derives displayed versions from public config", () => {
    const iosSignup = sourceSection(iosAPI, "func signup(", "func syncSupabase(");
    const iosSync = sourceSection(iosAPI, "func syncSupabase(", "func requestPasswordReset(");
    const iosGuard = sourceSection(iosAPI, "private func requiredLegalPolicyVersion(", "private func path(");
    expect(iosSignup).toContain("let policyVersion = try requiredLegalPolicyVersion(config)");
    expect(iosSync).toContain("policyVersion = try requiredLegalPolicyVersion(config)");
    expect(iosGuard).toContain("config.legalPolicyVersion?.trimmingCharacters");
    expect(iosGuard).toContain("throw BeerMapAPIError.configuration(");

    const androidSignup = sourceSection(androidAPI, "suspend fun signup(", "suspend fun refreshSupabaseSession(");
    const androidSync = sourceSection(androidAPI, "private suspend fun syncSupabase(", "suspend fun logout(");
    const androidGuard = sourceSection(
      androidAPI,
      "private fun requiredLegalPolicyVersion(",
      "private suspend fun supabaseRequest(",
    );
    expect(androidSignup).toContain("val policyVersion = requiredLegalPolicyVersion(config)");
    expect(androidSync).toContain("val policyVersion = requiredLegalPolicyVersion(config)");
    expect(androidGuard).toContain('config.stringOrNull("legalPolicyVersion")?.trim()?.takeIf { it.isNotEmpty() }');
    expect(androidGuard).toContain("?: throw IOException(");

    for (const guard of [iosGuard, androidGuard]) {
      expect(guard).toContain("The current Terms and Privacy Policy version is unavailable.");
    }
    for (const source of [iosAPI, androidAPI, iosApp, androidApp, iosSettings]) {
      expect(source).not.toMatch(/["']20\d{2}-\d{2}-\d{2}["']/);
    }

    expect(iosApp).toContain("legalAcceptanceVersion = config?.legalPolicyVersion");
    expect(androidApp).toContain('legalAcceptanceVersion = config.stringOrNull("legalPolicyVersion")');
    expect(iosSettings).toContain('model.config?.legalPolicyVersion ?? "unavailable"');
    expect(androidApp).toContain('state.config.stringOrNull("legalPolicyVersion") ?: "unavailable"');
  });

  it("shows complete operator and legal links in native settings while keeping diagnostics debug-only", () => {
    const androidSettings = sourceSection(androidApp, "private fun SettingsScreen(", "private fun showTimePicker(");
    const legalDetails = [
      "Isaac William De Worsop, sole trader",
      "ABN 80 319 578 329",
      "WOTSO, Level 3, 11–19 Bank Place, Melbourne VIC 3000, Australia",
      "admin@pintpath.au",
      "Terms and Conditions",
      "Privacy Policy",
      "Account export and deletion",
      "terms.html",
      "privacy.html",
      "account.html",
    ];
    for (const source of [iosSettings, androidSettings]) {
      for (const detail of legalDetails) expect(source).toContain(detail);
      expect(source).toContain("mailto:admin@pintpath.au");
    }

    const iosDebugStart = iosSettings.indexOf("#if DEBUG");
    const iosDebugEnd = iosSettings.indexOf("#endif", iosDebugStart);
    const iosDiagnostics = iosSettings.indexOf('title: "Backend connection"');
    expect(iosDebugStart).toBeGreaterThanOrEqual(0);
    expect(iosDiagnostics).toBeGreaterThan(iosDebugStart);
    expect(iosDiagnostics).toBeLessThan(iosDebugEnd);
    expect(iosSettings.match(/Backend connection/g)).toHaveLength(1);

    const androidDebugStart = androidSettings.indexOf("if (BuildConfig.DEBUG) {");
    const androidSupportStart = androidSettings.indexOf('SectionHeader("Support"', androidDebugStart);
    const androidDiagnostics = androidSettings.indexOf('SectionHeader("Configuration", "Backend connection"');
    expect(androidDebugStart).toBeGreaterThanOrEqual(0);
    expect(androidDiagnostics).toBeGreaterThan(androidDebugStart);
    expect(androidDiagnostics).toBeLessThan(androidSupportStart);
    expect(androidSettings.match(/Backend connection/g)).toHaveLength(1);
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
    expect(iosApp).toContain('UserDefaults.standard.removeObject(forKey: "au.pintpath.app.optionalAnalytics")');
    expect(iosApp).toMatch(/private func clearLocalSession\(\)[\s\S]*resetOptionalAnalytics\(\)/);

    expect(androidApp).toContain("if (optionalAnalytics && current != null)");
    expect(androidApp).toMatch(/private fun clearLocalSession\(\)[\s\S]*optionalAnalytics = false/);
    expect(androidApp).toMatch(/private fun storeSession[\s\S]*if \(resetAuthority\)[\s\S]*optionalAnalytics = false/);
  });

  it("refreshes and retries authenticated actions without discarding venue context", () => {
    expect(iosApp).toContain("withAuthenticatedSession");
    expect(iosApp).toContain("try storeSession(result, resetAuthority: false)");
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
    expect(iosContribute).toContain("withCompressionQuality: 0.84");
    expect(iosAPI).toContain("configuration.timeoutIntervalForResource = 330");
    expect(iosAPI).toContain('timeoutInterval: submission.submissionType == "photo_upload" ? 300 : nil');
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
    const iosSync = sourceSection(iosAPI, "func syncSupabase(", "func requestPasswordReset(");
    expect(androidAPI).toMatch(/^import java\.util\.Locale$/m);
    expect(androidAPI).toMatch(/^import kotlinx\.coroutines\.withContext$/m);
    expect(androidAPI).not.toContain("throw@withContext");
    expect(iosContribute).toMatch(
      /@MainActor\s+private final class OneTimeLocationProof:[^{\n]*@preconcurrency\s+CLLocationManagerDelegate/,
    );
    expect(iosApp).toMatch(/private func withAuthenticatedSession<T:\s*Sendable>/);
    expect(iosApp).toMatch(/private func withOptionalAuthenticatedSession<T:\s*Sendable>/);
    expect(iosAuth).toMatch(/^import AuthenticationServices$/m);
    expect(iosAuth).toMatch(/^import CryptoKit$/m);
    expect(iosAuth).not.toMatch(/^import GoogleSignIn$/m);
    expect(iosAuth).toMatch(/@MainActor\s+private final class NativeProviderSignInCoordinator/);
    expect(iosSync).toContain("return try await send(");
    expect(iosAPI).not.toMatch(/pagination\?\.hasMore\s*\?\?\s*response\.\w+\.count\s*==\s*pageSize/);
    expect(iosContribute).toMatch(/^extension String \{\s*var trimmed:/m);
    expect(iosContribute).not.toMatch(/^(?:private|fileprivate) extension String \{\s*var trimmed:/m);
  });

  it("binds native Apple and an app-returning verified Google flow", () => {
    const presentationProvider = sourceSection(
      iosAuth,
      "func presentationAnchor(",
      "private func signInWithSupabaseBrowser",
    );
    const browserFlow = sourceSection(
      iosAuth,
      "private func signInWithSupabaseBrowser",
      "private static func activePresentationAnchor",
    );
    const anchorFinder = sourceSection(
      iosAuth,
      "private static func activePresentationAnchor",
      "private static func canonicalSupabaseOrigin",
    );
    expect(iosAuth).toContain("SignInWithAppleButton");
    expect(iosAuth).toContain("exchangeSupabaseIDToken");
    expect(iosAPI).toContain("/auth/v1/token?grant_type=id_token");
    expect(iosModels).toContain("struct SupabaseIDTokenRequest");
    expect(iosModels).toContain('case idToken = "id_token"');
    expect(iosModels).toContain('case accessToken = "access_token"');
    expect(iosAuth).toContain('try await signInWithSupabaseBrowser(provider: "google"');
    expect(iosAuth).toContain('callbackURLScheme: "pintpath"');
    expect(iosAuth).toContain('callbackURL.scheme?.lowercased() == "pintpath"');
    expect(iosAuth).toContain('callbackURL.host?.lowercased() == "auth-callback"');
    expect(iosAuth).toContain("callbackURL.path.isEmpty");
    expect(iosAuth).toContain("callbackURL.user == nil");
    expect(iosAuth).toContain("BrowserSignInOperation");
    expect(iosAuth).toContain("withTaskCancellationHandler");
    expect(iosAuth).toContain("prefersEphemeralWebBrowserSession = true");
    expect(presentationProvider).toContain("browserPresentationAnchor!");
    expect(browserFlow).toContain(
      "guard let presentationAnchor = Self.activePresentationAnchor() else",
    );
    expect(browserFlow).toMatch(
      /browserPresentationAnchor = presentationAnchor[\s\S]*session\.presentationContextProvider = self/,
    );
    expect(browserFlow).toMatch(/defer \{[\s\S]*browserPresentationAnchor = nil/);
    expect(anchorFinder).toContain(".foregroundActive");
    expect(anchorFinder).toContain("first(where: \\.isKeyWindow)");
    expect(anchorFinder).toContain("!$0.isHidden");
    expect(anchorFinder).toContain("return nil");
    expect(iosAuth).not.toContain("ASPresentationAnchor()");
    expect(iosAuth).toContain("guard values[item.name] == nil");
    expect(iosAuth).toContain("sanitizedProviderError");
    expect(iosAuth).toContain("code_challenge");
    expect(iosAuth).not.toContain('URLQueryItem(name: "state"');
    expect(iosAPI).toContain("/auth/v1/token?grant_type=pkce");
    expect(iosModels).toContain("struct SupabasePKCERequest");
    expect(iosModels).toContain('case authCode = "auth_code"');
    expect(iosModels).toContain('case codeVerifier = "code_verifier"');
  });

  it("keeps Android provider login on PKCE without caller-controlled OAuth state", () => {
    expect(androidApp).toContain("code_challenge");
    expect(androidApp).toContain("code_challenge_method");
    expect(androidApp).not.toContain('.appendQueryParameter("state"');
    expect(androidAPI).toContain("/auth/v1/token?grant_type=pkce");
    expect(androidApp).toContain('uri.scheme == "pintpath" && uri.host == "auth-callback"');
  });

  it("ships Apple capability and one non-empty iOS provider callback", () => {
    const info = read("apps/ios/BeerMap/Info.plist");
    const iosProject = read("apps/ios/BeerMap.xcodeproj/project.pbxproj");
    const iosEntitlements = read("apps/ios/BeerMap/BeerMap.entitlements");

    expect(info).toContain("<string>pintpath</string>");
    expect(info).not.toContain("GOOGLE_IOS_REVERSED_CLIENT_ID");
    expect(info).not.toContain("<key>GIDClientID</key>");
    expect(iosProject).not.toContain("GoogleSignIn");
    expect(iosProject).toContain("CODE_SIGN_ENTITLEMENTS = BeerMap/BeerMap.entitlements;");
    expect(iosEntitlements).toContain("<key>com.apple.developer.applesignin</key>");
    expect(iosEntitlements).toContain("<string>Default</string>");
    expect(iosApp).not.toContain("GIDSignIn.sharedInstance.handle(url)");
  });

  it("requires HTTPS for provider authorization in Release builds", () => {
    const oauthOrigin = sourceSection(
      iosAuth,
      "private static func canonicalSupabaseOrigin",
      "private static func callbackValues",
    );
    expect(oauthOrigin).toContain("#if DEBUG");
    expect(oauthOrigin).toContain('guard components.scheme?.lowercased() == "https"');
  });

  it("protects session material and handles uninstall/reinstall safely", () => {
    const keychainSave = sourceSection(
      iosKeychain,
      "private static func save(",
      "static func deleteToken()",
    );
    const credentialSave = sourceSection(
      iosApp,
      "private func storeAuthenticatedSession(",
      "private func storeSession(",
    );
    const appSessionSave = sourceSection(
      iosApp,
      "private func storeSession(",
      "private func refreshExpiredSession()",
    );
    expect(iosKeychain).toContain("kSecAttrAccessibleWhenUnlockedThisDeviceOnly");
    expect(iosKeychain).not.toContain("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly");
    expect(iosKeychain).toContain("SecItemUpdate");
    expect(iosKeychain).toContain("errSecItemNotFound");
    expect(iosKeychain).toContain("errSecDuplicateItem");
    expect(keychainSave).not.toContain("delete(account: account)");
    expect(iosKeychain).toMatch(/static func saveToken\(_ token: String\) -> Bool/);
    expect(iosKeychain).toMatch(
      /static func saveSupabaseRefreshToken\(_ token: String\?\) -> Bool/,
    );
    expect(iosKeychain).toMatch(
      /static func saveSupabaseAccessToken\(_ token: String\?\) -> Bool/,
    );
    expect(keychainSave).toMatch(
      /SecItemUpdate[\s\S]*updateStatus == errSecSuccess[\s\S]*guard updateStatus == errSecItemNotFound[\s\S]*SecItemAdd/,
    );
    expect(keychainSave).toMatch(
      /addStatus == errSecDuplicateItem[\s\S]*SecItemUpdate/,
    );
    expect(credentialSave).toMatch(
      /invalidateSessionRefresh\(\)[\s\S]*saveSupabaseRefreshToken\(refreshToken\)[\s\S]*saveSupabaseAccessToken\(accessToken\)[\s\S]*else \{[\s\S]*clearLocalSession\(\)[\s\S]*throw/,
    );
    expect(appSessionSave).toContain(
      "guard KeychainSessionStore.saveToken(result.token) else",
    );
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

  it("requires complete environment-only signing for Android release bundles", () => {
    for (const variable of [
      "PINT_PATH_ANDROID_KEYSTORE_PATH",
      "PINT_PATH_ANDROID_KEYSTORE_PASSWORD",
      "PINT_PATH_ANDROID_KEY_ALIAS",
      "PINT_PATH_ANDROID_KEY_PASSWORD",
    ]) {
      expect(androidBuild).toContain(`"${variable}"`);
    }
    expect(androidBuild).toContain("configuredReleaseSigningVariables.isNotEmpty()");
    expect(androidBuild).toContain("configuredReleaseSigningVariables.size != releaseSigningVariableNames.size");
    expect(androidBuild).toContain("gradle.taskGraph.whenReady");
    expect(androidBuild).toContain('it.name == "bundleRelease"');
    expect(androidBuild).toContain("if (releaseBundleRequested && !releaseSigningConfigured)");
    expect(androidBuild).toContain("import java.io.File");
    expect(androidBuild).toContain("File(configuredStorePath)");
    expect(androidBuild).not.toContain("java.io.File(configuredStorePath)");
    expect(androidBuild).toContain("if (!unresolvedStoreFile.isAbsolute)");
    expect(androidBuild.indexOf("if (!unresolvedStoreFile.isAbsolute)")).toBeLessThan(
      androidBuild.indexOf("unresolvedStoreFile.canonicalFile"),
    );
    expect(androidBuild).toContain("configuredStoreFile.toPath().startsWith(repositoryRoot.toPath())");
    expect(androidBuild).toContain('getByName("release")');
    expect(androidBuild).toContain('signingConfig = signingConfigs.getByName("release")');
    expect(androidBuild).not.toMatch(/findProperty\("PINT_PATH_ANDROID_(?:KEYSTORE|KEY)/);
    expect(androidBuild).not.toMatch(/storePassword\s*=\s*"[^"$]+"/);
    expect(androidBuild).not.toMatch(/keyPassword\s*=\s*"[^"$]+"/);
    const signingGuard = sourceSection(androidBuild, "gradle.taskGraph.whenReady", "dependencies {");
    expect(signingGuard).not.toContain("assembleRelease");

    const androidReadme = read("apps/android/README.md");
    expect(androidReadme).toContain("./gradlew --no-daemon clean bundleRelease");
    expect(androidReadme).toContain("set -euo pipefail");
    expect(androidReadme).toContain("trap cleanup_android_signing EXIT INT TERM");
    expect(androidReadme).toContain('read -rs "PINT_PATH_ANDROID_KEYSTORE_PASSWORD?');
    expect(androidReadme).toContain('read -rs "PINT_PATH_ANDROID_KEY_PASSWORD?');
    expect(androidReadme).toContain("jarsigner -verify -verbose -certs");
    expect(androidReadme).toContain("grep -F 'jar verified.'");
    expect(androidReadme).not.toContain("jarsigner -verify -strict");
    expect(androidReadme).toContain("keytool -printcert -jarfile");
    expect(androidReadme).toContain("shasum -a 256");
    expect(androidReadme).toContain("unsigned build artifact and must never be submitted to Play");
  });

  it("keeps Android compilation free of resolved deprecation and nullability warnings", () => {
    const androidApp = read(
      "apps/android/app/src/main/java/au/pintpath/beermap/ui/features/BeerMapApp.kt",
    );
    expect(androidApp).toContain("import androidx.compose.material3.HorizontalDivider");
    expect(androidApp).not.toContain("import androidx.compose.material3.Divider");
    expect(androidApp).not.toMatch(/\bDivider\(/);
    expect(androidModels).toContain('else -> value?.toString() ?: "-"');
    expect(androidModels).not.toContain("else -> value.toString()");
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

  it("shows native Admin quick-bar access only with current server-verified admin authority", () => {
    const hasAdminAccess = (signedIn: boolean, serverIsAdmin: boolean) => signedIn && serverIsAdmin;

    expect(hasAdminAccess(true, true)).toBe(true);
    expect(hasAdminAccess(true, false)).toBe(false);
    expect(hasAdminAccess(false, true)).toBe(false);

    expect(iosApp).toContain("isSignedIn && accountDashboard?.access?.isAdmin == true");
    expect(iosRoot).toContain("if model.hasAdminAccess");
    expect(iosRoot).toContain('title: "Admin workspace"');
    expect(iosRoot).toContain('systemImage: "lock.shield.fill"');
    expect(iosRoot).toContain('URLQueryItem(name: "returnTo", value: "/admin.html")');
    expect(iosRoot).not.toContain('account?.role == "admin"');

    expect(androidApp).toContain("get() = signedIn && accountDashboard?.access?.isAdmin == true");
    expect(androidApp).toContain("if (state.hasAdminAccess)");
    expect(androidApp).toContain("if (!state.hasAdminAccess && tab == AppTab.Admin) tab = AppTab.Account");
    expect(androidApp).toContain('Admin("Admin")');
    expect(androidApp).toContain("/account.html?returnTo=%2Fadmin.html");
    expect(androidApp).not.toContain('account.role == "admin"');
    expect(androidApp).not.toContain('account.subscriptionStatus == "admin"');
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
    const iosReadme = read("apps/ios/README.md");
    const iosDocs = [
      "apps/ios/README.md",
      "MOBILE_APP_README.md",
      "MOBILE_STATUS_REPORT.md",
      "MOBILE_APP_STORE_CHECKLIST.md",
      "MOBILE_APP_RELEASE_NOTES_DRAFT.md",
    ].map(read).join("\n");
    const androidDocs = read("apps/android/README.md");

    expect(iosDocs).not.toMatch(/native (google|apple) oauth is not wired/i);
    expect(iosDocs).not.toMatch(/photo evidence upload is not wired/i);
    expect(iosDocs).not.toMatch(/upload-location proof is not wired/i);
    expect(iosDocs).toContain("Pint Path");
    expect(iosDocs).toMatch(/identity token|ID token/i);
    expect(iosReadme).toContain("PKCE");
    expect(androidDocs).toContain("PKCE");
  });
});
