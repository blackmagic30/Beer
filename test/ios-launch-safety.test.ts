import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function workspaceSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function iosSource(relativePath: string): string {
  return workspaceSource(path.join("apps/ios/BeerMap", relativePath));
}

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Could not find source section: ${start} -> ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

function privacyEntry(manifest: string, dataType: string): string {
  const dataTypeIndex = manifest.indexOf(`<string>${dataType}</string>`);
  if (dataTypeIndex < 0) throw new Error(`Missing privacy entry: ${dataType}`);
  const startIndex = manifest.lastIndexOf("<dict>", dataTypeIndex);
  const endIndex = manifest.indexOf("</dict>", dataTypeIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Malformed privacy entry: ${dataType}`);
  return manifest.slice(startIndex, endIndex + "</dict>".length);
}

describe("iOS launch safety", () => {
  it("does not compile alcohol-linked rewards or counter tooling", () => {
    const api = iosSource("Services/BeerMapAPI.swift");
    const models = iosSource("Models/BeerMapModels.swift");
    const account = iosSource("Features/AccountView.swift");
    const venuePortal = iosSource("Features/VenuePortalView.swift");
    const appModel = iosSource("App/BeerMapApp.swift");
    const nativeSource = [api, models, account, venuePortal, appModel].join("\n");

    expect(nativeSource).not.toContain("alcoholLinkedRewards");
    expect(nativeSource).not.toContain("pintPointsRewardsEnabled");
    expect(nativeSource).not.toContain("CounterToolsView");
    expect(nativeSource).not.toContain("CounterMemberPreview");
    expect(nativeSource).not.toContain("CounterPurchase");
    expect(nativeSource).not.toContain("CounterReward");
    expect(nativeSource).not.toContain("freePintReward");
    expect(nativeSource).not.toContain("discountPass");
    expect(nativeSource).not.toContain("checkoutToken");
    expect(nativeSource).not.toMatch(/Record purchase|Free Pint Reward|Pint Points/);
  });

  it("ignores web-paid consumer entitlements and paid venue placement", () => {
    const account = iosSource("Features/AccountView.swift");
    const discover = iosSource("Features/DiscoverView.swift");
    const models = iosSource("Models/BeerMapModels.swift");
    const appModel = iosSource("App/BeerMapApp.swift");
    const reusableViews = iosSource("Components/ReusableViews.swift");

    expect(appModel).toMatch(
      /var hasContributorAccess:[\s\S]*subscriptionStatus\?\.caseInsensitiveCompare\("contributor_unlocked"\) == \.orderedSame/,
    );
    expect(appModel).toMatch(/func loadHome[\s\S]*withContributorAuthenticatedSession[\s\S]*api\.listVenues/);
    expect(appModel).toMatch(/func loadPrices[\s\S]*withContributorAuthenticatedSession[\s\S]*api\.priceRecords/);
    const contributorSession = sourceSection(
      appModel,
      "private func withContributorAuthenticatedSession",
      "private func setLoading",
    );
    expect(contributorSession).toContain("guard hasContributorAccess");
    expect(contributorSession).toContain("operation(nil)");
    expect(discover).toContain("model.hasContributorAccess");
    expect(discover).not.toContain("accountDashboard?.access?.hasFullAccess");
    expect(discover).not.toContain("partnerOnly");
    expect(discover).not.toContain("membershipTier");
    expect(discover).not.toContain("isPro");
    expect(discover).not.toMatch(/\bPremium\b/);
    expect(discover).not.toMatch(/\bpaid\b/i);
    expect(discover).toContain('Text("Contributor unlock")');
    expect(reusableViews).not.toContain('venue.membershipTier == "pro"');
    expect(reusableViews).not.toContain('Text("Pro")');
    expect(models).toContain('return "Preview only"');
    expect(account).toContain('model.hasContributorAccess ? "Contributor access" : "Account"');
    expect(account).not.toContain("specialsCard");
    expect(account).not.toContain("subscriptionStatus ??");
  });

  it("does not compile venue Pro analytics, specials, reports, or trials", () => {
    const venuePortal = iosSource("Features/VenuePortalView.swift");
    const appModel = iosSource("App/BeerMapApp.swift");
    const api = iosSource("Services/BeerMapAPI.swift");
    const models = iosSource("Models/BeerMapModels.swift");
    const nativeSource = [venuePortal, appModel, api, models].join("\n");

    expect(nativeSource).not.toContain("nativeVenueProFeaturesEnabled");
    expect(nativeSource).not.toContain("BarSpecial");
    expect(nativeSource).not.toContain("VenueAnalytics");
    expect(nativeSource).not.toContain("DailySpecialsPlanner");
    expect(nativeSource).not.toContain("TierCapabilities");
    expect(nativeSource).not.toContain("saveSpecial");
    expect(nativeSource).not.toContain("exportVenueMonthlyReport");
    expect(nativeSource).not.toMatch(/\/specials|\/reports\//);
    expect(nativeSource).not.toMatch(/\bPro\b|\btrial\b/i);
    expect(venuePortal).toContain("Venue access requests are handled by Pint Path support outside this consumer iOS release.");
  });

  it("does not compile happy-hour discovery, submission, or management", () => {
    const api = iosSource("Services/BeerMapAPI.swift");
    const models = iosSource("Models/BeerMapModels.swift");
    const appModel = iosSource("App/BeerMapApp.swift");
    const contribute = iosSource("Features/ContributeView.swift");
    const venuePortal = iosSource("Features/VenuePortalView.swift");
    const discover = iosSource("Features/DiscoverView.swift");
    const root = iosSource("Features/RootView.swift");
    const nativeSource = [api, models, appModel, contribute, venuePortal, discover, root].join("\n");

    expect(nativeSource).not.toMatch(/happy.?hour/i);
    expect(nativeSource).not.toContain("BarHappyHour");
    expect(nativeSource).not.toContain("isHappyHourPrice");
    expect(nativeSource).not.toContain("submitHappyHourUpdate");
    expect(nativeSource).not.toContain("/happy-hours");
  });

  it("does not compile billing recovery or social auth and keeps commerce-capable web pages unreachable", () => {
    const api = iosSource("Services/BeerMapAPI.swift");
    const auth = iosSource("Features/AuthView.swift");
    const root = iosSource("Features/RootView.swift");
    const settings = iosSource("Features/SettingsView.swift");
    const venuePortal = iosSource("Features/VenuePortalView.swift");
    const appModel = iosSource("App/BeerMapApp.swift");
    const info = iosSource("Info.plist");
    const project = workspaceSource("apps/ios/BeerMap.xcodeproj/project.pbxproj");
    const business = workspaceSource("viewer/business.js");
    const terms = workspaceSource("viewer/terms.html");
    const privacy = workspaceSource("viewer/privacy.html");

    const nativeSource = [api, auth, root, settings, venuePortal, appModel, iosSource("Models/BeerMapModels.swift")].join("\n");
    expect(nativeSource).not.toMatch(/billing.?recovery/i);
    expect(nativeSource).not.toContain("completeOAuthSignIn");
    expect(nativeSource).not.toContain("exchangeSupabasePKCE");
    expect(nativeSource).not.toContain("SupabasePKCERequest");
    expect(nativeSource).not.toContain("supabaseOauthProviders");
    expect(root).toContain("model.hasVenueAccess && !model.hasAdminAccess");
    expect(root).not.toContain("Admin workspace");
    expect(root).not.toContain("admin.html");
    expect(root).not.toContain("account.html");
    expect(settings).toContain("AppConfig.termsURL");
    expect(settings).toContain("AppConfig.privacyURL");
    expect(settings).not.toContain("account.html");
    expect(venuePortal).not.toContain("venue-portal.html");
    expect(auth).not.toContain("ASWebAuthenticationSession");
    expect(auth).not.toContain("SignInWithAppleButton");
    expect(auth).not.toContain("GoogleOAuthCoordinator");
    expect(auth).not.toContain("supabaseOauthProviders");
    expect(project).not.toContain("com.apple.SignInWithApple");
    expect(project).not.toContain("CODE_SIGN_ENTITLEMENTS = BeerMap/BeerMap.entitlements;");
    expect(info).not.toContain("<key>CFBundleURLTypes</key>");
    expect(api).toContain('URLQueryItem(name: "source", value: "ios_app")');
    const safeLegalNav = sourceSection(
      business,
      "function renderIOSLegalNav",
      "function renderNav",
    );
    expect(safeLegalNav).toContain("mailto:admin@pintpath.au");
    expect(safeLegalNav).not.toContain("pricing");
    expect(safeLegalNav).not.toContain("account.html");
    expect(business).toContain("if (isIOSLegalSurface()) return null;");
    expect(business).toContain("if (!isIOSLegalSurface())");
    expect(terms).toContain("MelbBeerBusiness.renderIOSLegalNav()");
    expect(privacy).toContain("MelbBeerBusiness.renderIOSLegalNav()");
  });

  it("describes native account deletion as a scheduled self-service action", () => {
    const account = iosSource("Features/AccountView.swift");
    const appModel = iosSource("App/BeerMapApp.swift");

    expect(account).toContain("Schedule account deletion");
    expect(account).toContain("seven-day cancellation window");
    expect(account).not.toContain("Request account deletion review");
    expect(appModel).toContain("Self-service account deletion scheduled from the iOS app.");
  });

  it("declares native data categories and does not claim developer advertising", () => {
    const manifest = iosSource("PrivacyInfo.xcprivacy");

    for (const dataType of [
      "NSPrivacyCollectedDataTypeName",
      "NSPrivacyCollectedDataTypeEmailAddress",
      "NSPrivacyCollectedDataTypePhoneNumber",
      "NSPrivacyCollectedDataTypePhysicalAddress",
      "NSPrivacyCollectedDataTypeUserID",
      "NSPrivacyCollectedDataTypeDeviceID",
      "NSPrivacyCollectedDataTypePhotosorVideos",
      "NSPrivacyCollectedDataTypePreciseLocation",
      "NSPrivacyCollectedDataTypeCustomerSupport",
      "NSPrivacyCollectedDataTypeOtherUserContent",
      "NSPrivacyCollectedDataTypeOtherDataTypes",
      "NSPrivacyCollectedDataTypeSearchHistory",
      "NSPrivacyCollectedDataTypePurchaseHistory",
      "NSPrivacyCollectedDataTypeProductInteraction",
    ]) {
      expect(manifest).toContain(`<string>${dataType}</string>`);
    }
    const otherData = privacyEntry(manifest, "NSPrivacyCollectedDataTypeOtherDataTypes");
    expect(otherData).toMatch(/<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>/);
    expect(otherData).toMatch(/<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<false\/>/);
    expect(otherData).toContain("NSPrivacyCollectedDataTypePurposeAppFunctionality");
    const email = privacyEntry(manifest, "NSPrivacyCollectedDataTypeEmailAddress");
    expect(email).toContain("NSPrivacyCollectedDataTypePurposeAppFunctionality");
    expect(email).not.toContain("NSPrivacyCollectedDataTypePurposeDeveloperAdvertising");
    expect(manifest).not.toContain("NSPrivacyCollectedDataTypePurposeDeveloperAdvertising");
    expect(manifest).toContain("<key>NSPrivacyTracking</key>\n\t<false/>");
  });

  it("selects and asserts Xcode 26 and the iOS 26 SDK before CI builds", () => {
    const workflow = workspaceSource(".github/workflows/native-apps.yml");

    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("/Applications/Xcode_26*.app");
    expect(workflow).toContain('sudo xcode-select --switch "$xcode_app/Contents/Developer"');
    expect(workflow).toContain('xcode_version="$(xcodebuild -version');
    expect(workflow).toContain('sdk_version="$(xcrun --sdk iphoneos --show-sdk-version)"');
    expect(workflow).toContain("26.*) ;;");
  });
});
