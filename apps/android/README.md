# Pint Path Android

Native Kotlin/Jetpack Compose app for Pint Path. The package and source types retain the internal `BeerMap` name; the installed app is displayed as **Pint Path**. Continue this project in place.

## Run

1. Install Android Studio, JDK 17, and the Android SDK.
2. Open `apps/android`.
3. Copy `local.properties.example` to the ignored `local.properties` only for local overrides.
4. Sync Gradle and run on a phone or emulator.

```properties
PINT_PATH_API_BASE_URL=http://10.0.2.2:3000
```

`10.0.2.2` routes the Android emulator to the host machine.

## Current integration

- Email/password signup, login, refresh, password recovery, and logout use Supabase Auth REST endpoints. Recovery emails return through the verified HTTPS `/auth/callback` flow before the browser opens password-update mode.
- Google and Apple provider-login code uses authorization-code PKCE and the `pintpath://auth-callback` deep link. Android is outside the current launch; launch OAuth is Google-only and Apple must remain disabled until authorization-token revocation is implemented and tested.
- Supabase access tokens are exchanged at `POST /api/business/auth/supabase-session` for a scoped Pint Path app session.
- Sensitive session/export/deletion actions require a fresh provider sign-in token; a rejected action is never reported as complete.
- A suspended paid account receives billing-only recovery without an app session, including personal-versus-managed-venue selection when needed.
- App, Supabase refresh, and Supabase access tokens are AES-GCM encrypted with an Android Keystore key. Session preferences are excluded from cloud backup and device transfer.
- No service-role key is bundled, and the app never reads private Supabase tables directly.

Any future Android provider release requires the callback URI in Supabase's redirect allow list and completed Google provider-console configuration. Apple provider configuration remains deferred until authorization-token revocation is implemented and tested.

## Native coverage

- Venue search/list, fixed free price preview or entitled full prices, wrong-price reporting, venue saving, and external map directions.
- Reviewed price, photo, and happy-hour submissions with optional one-time location proof.
- Missing venue/beer requests and mission reserve/release.
- Account dashboard, privacy controls, sessions, JSON export, deletion request/status/cancel, rewards, and counter-staff invitations.
- Venue profile, beer/stock, happy hours, eligible specials, counter/POS tools, analytics, planner, and monthly report export for assigned roles.
- A server-authority-gated Admin tab that hands verified admins to the secure web workspace.
- Claim-required accounts are handed to the secure web claim workflow.

## Deliberate remaining boundaries

Android currently uses a venue list plus an external Maps handoff rather than bundling a map SDK/API key. Menu evidence supports either a direct camera capture or one existing image. Multiple images, PDF evidence, offline queues, general plan/checkout changes, and admin moderation remain outside this release. The narrow suspended-account billing-recovery portal is implemented. Real-device/provider testing, screenshots, reviewer accounts, and Play listing/data-safety declarations require release-owner credentials.

## Signed release bundle

Keep the Play upload keystore outside the repository and secret manager values out of shell history, Gradle properties, build logs, and screenshots. The repository ignores in-tree `.jks` and `.keystore` files as a last line of defence, but an absolute path outside the checkout is required. Use the following zsh subshell in a private terminal; no value literal appears in a command, both passwords use non-echoing prompts, and all four values are cleared on success, failure, or interruption:

```zsh
cd apps/android
unset PINT_PATH_ANDROID_KEYSTORE_PATH PINT_PATH_ANDROID_KEYSTORE_PASSWORD \
  PINT_PATH_ANDROID_KEY_ALIAS PINT_PATH_ANDROID_KEY_PASSWORD
(
  set -euo pipefail
  cleanup_android_signing() {
    unset PINT_PATH_ANDROID_KEYSTORE_PATH PINT_PATH_ANDROID_KEYSTORE_PASSWORD \
      PINT_PATH_ANDROID_KEY_ALIAS PINT_PATH_ANDROID_KEY_PASSWORD
  }
  trap cleanup_android_signing EXIT INT TERM
  read -r "PINT_PATH_ANDROID_KEYSTORE_PATH?Absolute upload-keystore path: "
  export PINT_PATH_ANDROID_KEYSTORE_PATH
  read -rs "PINT_PATH_ANDROID_KEYSTORE_PASSWORD?Keystore password: "
  export PINT_PATH_ANDROID_KEYSTORE_PASSWORD
  printf '\n'
  read -r "PINT_PATH_ANDROID_KEY_ALIAS?Upload key alias: "
  export PINT_PATH_ANDROID_KEY_ALIAS
  read -rs "PINT_PATH_ANDROID_KEY_PASSWORD?Upload key password: "
  export PINT_PATH_ANDROID_KEY_PASSWORD
  printf '\n'
  ./gradlew --no-daemon clean bundleRelease
)
```

The signed bundle is written to `app/build/outputs/bundle/release/app-release.aab`. Verify its certificate locally before uploading it to the Play Console:

```bash
(
  set -euo pipefail
  umask 077
  SIGNATURE_LOG="$(mktemp)"
  trap 'rm -f "$SIGNATURE_LOG"' EXIT INT TERM
  jarsigner -verify -verbose -certs app/build/outputs/bundle/release/app-release.aab \
    2>&1 | tee "$SIGNATURE_LOG"
  grep -F 'jar verified.' "$SIGNATURE_LOG"
  keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab
  shasum -a 256 app/build/outputs/bundle/release/app-release.aab
)
```

The interactive commands themselves may remain in shell history, but none contains a secret. Require `jar verified.`, inspect every warning, and confirm the signer certificate is within its validity period and uses approved algorithms. Do not use `jarsigner -strict` as a blind pass/fail gate: the intentionally self-signed Android upload certificate can produce a nonzero strict exit even when archive integrity is valid. Match the SHA-256 certificate fingerprint printed by `keytool` to the Play Console upload certificate and record the AAB SHA-256 beside the source commit. `bundleRelease` refuses before task execution when signing is absent, so it cannot create an unsigned final AAB. Supplying only some signing variables also fails with the missing variable names. The CI validation command below intentionally keeps `assembleRelease` usable without release secrets; its APK is an unsigned build artifact and must never be submitted to Play.

## Validation

```bash
cd apps/android
./gradlew --no-daemon lintDebug lintRelease testDebugUnitTest assembleDebug assembleRelease
```

CI runs this gate with JDK 17 and an Android SDK.
