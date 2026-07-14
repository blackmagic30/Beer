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

- Email/password signup, login, refresh, password recovery, and logout use Supabase Auth REST endpoints.
- Google and Apple provider login use authorization-code PKCE and the `pintpath://auth-callback` deep link.
- Supabase access tokens are exchanged at `POST /api/business/auth/supabase-session` for a scoped Pint Path app session.
- Sensitive session/export/deletion actions require a fresh provider sign-in token; a rejected action is never reported as complete.
- A suspended paid account receives billing-only recovery without an app session, including personal-versus-managed-venue selection when needed.
- App, Supabase refresh, and Supabase access tokens are AES-GCM encrypted with an Android Keystore key. Session preferences are excluded from cloud backup and device transfer.
- No service-role key is bundled, and the app never reads private Supabase tables directly.

Provider login requires the callback URI in Supabase's redirect allow list and completed Google/Apple provider-console configuration.

## Native coverage

- Venue search/list, fixed free price preview or entitled full prices, wrong-price reporting, venue saving, and external map directions.
- Reviewed price, photo, and happy-hour submissions with optional one-time location proof.
- Missing venue/beer requests and mission reserve/release.
- Account dashboard, privacy controls, sessions, JSON export, deletion request/status/cancel, rewards, and counter-staff invitations.
- Venue profile, beer/stock, happy hours, eligible specials, counter/POS tools, analytics, planner, and monthly report export for assigned roles.
- Claim-required accounts are handed to the secure web claim workflow.

## Deliberate remaining boundaries

Android currently uses a venue list plus an external Maps handoff rather than bundling a map SDK/API key. The photo picker supports one image. Direct camera capture, multiple images, PDF evidence, offline queues, general plan/checkout changes, and admin moderation remain outside this release. The narrow suspended-account billing-recovery portal is implemented. Signing, real-device/provider testing, screenshots, reviewer accounts, and Play listing/data-safety declarations require release-owner credentials.

## Validation

```bash
cd apps/android
./gradlew --no-daemon lintDebug lintRelease testDebugUnitTest assembleDebug assembleRelease
```

CI runs this gate with JDK 17 and an Android SDK.
