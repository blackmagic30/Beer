import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

  it("routes native password recovery through the verified web callback", () => {
    const api = iosSource("Services/BeerMapAPI.swift");
    const androidAPI = workspaceSource(
      "apps/android/app/src/main/java/au/pintpath/beermap/data/BeerMapApiClient.kt",
    );
    const auth = iosSource("Features/AuthView.swift");
    const recovery = sourceSection(
      api,
      "func requestPasswordReset(email: String, config: PublicConfig)",
      "func refreshSupabaseSession(",
    );
    const callback = workspaceSource("viewer/auth/callback.html");

    expect(recovery).toContain('baseURL.appending(path: "auth/callback")');
    expect(recovery).not.toContain('baseURL.appending(path: "reset-password.html")');
    expect(androidAPI).toContain('effectiveApiBaseUrl() + "/auth/callback"');
    expect(androidAPI).not.toContain('effectiveApiBaseUrl() + "/reset-password.html"');
    expect(callback).toContain('hash.get("type") === "recovery"');
    expect(callback).toContain('MelbBeerBusiness.markPasswordRecoverySession(result.account?.id)');
    expect(auth).toContain("Already use Google on the Pint Path website?");
    expect(auth).toContain("choose Forgot password");
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

  it("loads ignored iOS configuration and fails Release builds closed", () => {
    const api = iosSource("Services/BeerMapAPI.swift");
    const project = workspaceSource("apps/ios/BeerMap.xcodeproj/project.pbxproj");
    const defaults = workspaceSource("apps/ios/Config.defaults.xcconfig");
    const example = workspaceSource("apps/ios/Config.example.xcconfig");
    const validator = workspaceSource("apps/ios/Scripts/validate-release-configuration.sh");
    const gitignore = workspaceSource(".gitignore");

    expect(defaults).toContain('PINT_PATH_API_BASE_URL = https:/$()/pintpath.au');
    expect(defaults).toContain("SUPABASE_URL =\n");
    expect(defaults).toContain("SUPABASE_ANON_KEY =\n");
    expect(defaults).toContain('#include? "Config.xcconfig"');
    expect(project.match(/baseConfigurationReference = .*Config\.defaults\.xcconfig/g)).toHaveLength(2);
    expect(project).toContain("Validate Release Configuration");
    expect(project).toContain('showEnvVarsInLog = 0;');
    expect(project).not.toContain('SUPABASE_URL = "";');
    expect(project).not.toContain('SUPABASE_ANON_KEY = "";');
    expect(validator).toContain('if [[ "${CONFIGURATION:-}" != "Release" ]]');
    expect(validator).toContain('fail "${name} is missing."');
    expect(validator).toContain('approved_supabase_url="https://auth.pintpath.au"');
    expect(validator).toContain('[[ "$supabase_url" == "$approved_supabase_url" ]]');
    expect(validator).toContain("sb_secret_*");
    expect(validator).toContain('^sb_publishable_[A-Za-z0-9_-]{20,220}$');
    expect(validator.indexOf('^sb_publishable_[A-Za-z0-9_-]{20,220}$')).toBeLessThan(
      validator.indexOf('if [[ "${CONFIGURATION:-}" != "Release" ]]'),
    );
    expect(validator).not.toContain("validate_legacy_anon_jwt");
    expect(example).toContain("Release/archive builds fail closed");
    expect(example).toContain("https:/$()/auth.pintpath.au");
    expect(example).toContain("Legacy JWT and sb_secret_ keys are rejected");
    expect(api).toContain('static let approvedSupabaseOrigin = "https://auth.pintpath.au"');
    expect(api).toContain("let supabaseURL = AppConfig.supabaseURL");
    expect(api).toContain("let key = AppConfig.supabaseAnonKey");
    expect(api).toContain('^sb_publishable_[A-Za-z0-9_-]{20,220}$');
    expect(api).not.toContain('object["role"] as? String == "anon"');
    expect(api).toContain('request.setValue(key, forHTTPHeaderField: "apikey")');
    expect(api).toContain("if let accessToken, accessToken != key {");
    expect(api).toContain("RedirectRejectingURLSessionDelegate");
    expect(api).toContain("willPerformHTTPRedirection");
    expect(api).toContain("completionHandler(nil)");
    expect(api).toContain("delegate: RedirectRejectingURLSessionDelegate()");
    expect(api).not.toContain('request.setValue("Bearer \\(key)"');
    expect(api).not.toContain("/api/business/auth/login");
    expect(api).not.toContain("hasSupabaseConfiguration");
    expect(gitignore).toContain("apps/ios/Config.xcconfig");
  });

  it("accepts valid public Release inputs and rejects missing, placeholder, or private values", () => {
    const validatorPath = path.resolve(
      process.cwd(),
      "apps/ios/Scripts/validate-release-configuration.sh",
    );
    const validReleaseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CONFIGURATION: "Release",
      PINT_PATH_API_BASE_URL: "https://pintpath.au",
      SUPABASE_URL: "https://auth.pintpath.au",
      SUPABASE_ANON_KEY: `sb_publishable_${"0".repeat(32)}`,
    };
    const runValidator = (overrides: NodeJS.ProcessEnv) => spawnSync(
      "/bin/bash",
      [validatorPath],
      {
        env: { ...validReleaseEnv, ...overrides },
        encoding: "utf8",
      },
    );

    expect(runValidator({}).status).toBe(0);
    expect(runValidator({ SUPABASE_ANON_KEY: `sb_publishable_${"a".repeat(20)}` }).status)
      .toBe(0);
    expect(runValidator({ SUPABASE_ANON_KEY: `sb_publishable_${"a".repeat(220)}` }).status)
      .toBe(0);
    expect(runValidator({ SUPABASE_ANON_KEY: `sb_publishable_${"a".repeat(20)}__` }).status)
      .toBe(0);
    expect(runValidator({ CONFIGURATION: "Debug", SUPABASE_URL: "", SUPABASE_ANON_KEY: "" }).status)
      .toBe(0);
    expect(runValidator({
      CONFIGURATION: "Debug",
      PINT_PATH_API_BASE_URL: "",
      SUPABASE_URL: "",
      SUPABASE_ANON_KEY: `sb_publishable_${"d".repeat(20)}`,
    }).status).toBe(0);

    const missing = runValidator({ SUPABASE_URL: "" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("SUPABASE_URL is missing");

    const placeholder = runValidator({ SUPABASE_URL: "https://your-project.supabase.co" });
    expect(placeholder.status).not.toBe(0);
    expect(placeholder.stderr).toContain("SUPABASE_URL still contains a placeholder");

    const wrongProductionOrigin = runValidator({ SUPABASE_URL: "https://other-project.supabase.co" });
    expect(wrongProductionOrigin.status).not.toBe(0);
    expect(wrongProductionOrigin.stderr).toContain(
      "must exactly match the independently approved production origin",
    );

    const privateKey = runValidator({ SUPABASE_ANON_KEY: `sb_secret_${"0".repeat(32)}` });
    expect(privateKey.status).not.toBe(0);
    expect(privateKey.stderr).toContain("never a secret or legacy service-role key");

    const rejectedKeys = [
      "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature",
      `sb_publishable_${"a".repeat(19)}`,
      `sb_publishable_${"a".repeat(221)}`,
      `sb_publishable_${"a".repeat(20)}!`,
      ` ${validReleaseEnv.SUPABASE_ANON_KEY}`,
    ];
    for (const rejectedKey of rejectedKeys) {
      const rejected = runValidator({ SUPABASE_ANON_KEY: rejectedKey });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "must be an sb_publishable_ key with 20 to 220 URL-safe characters",
      );
      expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(rejectedKey);
    }

    for (const rejectedKey of [
      `sb_secret_${"s".repeat(32)}`,
      ...rejectedKeys,
    ]) {
      const rejected = runValidator({
        CONFIGURATION: "Debug",
        PINT_PATH_API_BASE_URL: "",
        SUPABASE_URL: "",
        SUPABASE_ANON_KEY: rejectedKey,
      });
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(rejectedKey);
    }
  });

  it("refuses to persist a non-publishable key in the ignored iOS build config", () => {
    const writerPath = path.resolve(
      process.cwd(),
      "apps/ios/Scripts/write-build-config.sh",
    );
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-ios-build-config-test-"),
    );
    const baseEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PINT_PATH_API_BASE_URL: "https://pintpath.au",
      SUPABASE_URL: "https://auth.pintpath.au",
    };
    const runWriter = (key: string, outputName: string) => spawnSync(
      "/bin/bash",
      [writerPath, path.join(temporaryDirectory, outputName)],
      {
        env: { ...baseEnvironment, SUPABASE_ANON_KEY: key },
        encoding: "utf8",
      },
    );

    try {
      const validKey = `sb_publishable_${"p".repeat(32)}`;
      const accepted = runWriter(validKey, "accepted.xcconfig");
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).not.toContain(validKey);
      expect(fs.readFileSync(
        path.join(temporaryDirectory, "accepted.xcconfig"),
        "utf8",
      )).toContain(`SUPABASE_ANON_KEY = ${validKey}`);

      for (const [index, rejectedKey] of [
        `sb_secret_${"s".repeat(32)}`,
        "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature",
        ` ${validKey}`,
        `sb_publishable_${"p".repeat(19)}`,
        `sb_publishable_${"p".repeat(221)}`,
      ].entries()) {
        const outputName = `rejected-${index}.xcconfig`;
        const rejected = runWriter(rejectedKey, outputName);
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain(
          "SUPABASE_ANON_KEY must be an exact sb_publishable_ key",
        );
        expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(rejectedKey);
        expect(fs.readdirSync(temporaryDirectory)).not.toContain(outputName);
      }
    } finally {
      fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("archives the pinned origin with synthetic keys on normal CI and protected keys in the manual job", () => {
    const workflow = workspaceSource(".github/workflows/native-apps.yml");
    const normalJob = workflow.slice(
      workflow.indexOf("  ios:"),
      workflow.indexOf("  ios-production-configuration:"),
    );
    const productionJob = workflow.slice(workflow.indexOf("  ios-production-configuration:"));

    expect(normalJob).toContain("Prepare synthetic public configuration for the unsigned iOS Release contract");
    expect(normalJob).toContain("SUPABASE_URL: https://auth.pintpath.au");
    expect(normalJob).toContain("inspect-release-archive.sh");
    expect(normalJob).not.toContain("secrets.SUPABASE_URL");
    expect(normalJob).not.toContain("secrets.SUPABASE_ANON_KEY");
    expect(productionJob).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(productionJob).toContain("environment: production");
    expect(productionJob).toContain("SUPABASE_URL: ${{ secrets.SUPABASE_URL }}");
    expect(productionJob).toContain("SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}");
    expect(productionJob).toContain("inspect-release-archive.sh");
    expect(productionJob).toContain("rm -f apps/ios/Config.xcconfig");
    expect(workspaceSource("apps/ios/Scripts/inspect-release-archive.sh"))
      .toContain('approved_supabase_url="https://auth.pintpath.au"');
  });
});
