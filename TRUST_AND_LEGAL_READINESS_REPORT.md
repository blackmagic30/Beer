# Pint Path Trust and Legal Readiness Report

Date: 30 June 2026

Scope: main Pint Path / BeerMap website only. This pass did not touch mobile app folders, change backend/database behavior, or make database/schema changes.

Important note: this is product readiness work, not final legal advice. The placeholder legal sections below need owner and legal review before a broad public launch or production payment rollout.

## 1. Pages found

- `viewer/privacy.html` - existing Privacy Policy with account data, submissions, source evidence, location proof, analytics, venue reports, retention, and user choices.
- `viewer/terms.html` - existing Terms and Conditions covering responsible use, accounts, submissions, points, venue tools, billing, availability, and contact.
- `viewer/feedback.html` - existing Contact / Support page with support categories for privacy, export, deletion, moderation, security, abuse, billing, and venue partner interest.
- `viewer/security.html` - existing Security & Privacy page with account, evidence, analytics, request categories, and disclosure guidance.
- `viewer/account.html` - signed-in privacy settings, quick JSON data export, deletion review request, support request form, and logout-all-sessions control.
- `viewer/pricing.html` - consumer and venue pricing presentation with plan limits, venue verification notes, and footer links to Terms/Privacy.
- Footer/nav links already point users toward FAQ, support, privacy, terms, security, status, pricing, and venue support surfaces.

## 2. Pages added or improved

No new route was required because the website already had dedicated privacy, terms, support, account, and security pages.

Improved:

- `viewer/privacy.html`
  - Added public-safe owner/legal review copy without exposing raw bracket placeholders on the public page.
  - Added a plain-English beta summary.
  - Added service provider/integration context based on current app behavior: Supabase Auth/login support, server-side Pint Path sessions, Google Maps/Places, Stripe where enabled, and private server storage for source evidence.
  - Added explicit account deletion and data export instructions, including fallback support path when the user cannot sign in.
- `viewer/terms.html`
  - Added beta legal-review notice.
  - Added public-safe entity/contact/billing/legal review reminders without exposing raw bracket placeholders on the public page.
  - Tightened billing/refund/cancellation review wording without making final claims.
  - Added privacy, deletion, and app-store listing cross-reference.
- `viewer/feedback.html`
  - Added trust cards for privacy/deletion, support contact placeholders, and private security reporting.
  - Clarified that deletion starts as a review request and that users should not send passwords, card numbers, private keys, or ID documents.
- `viewer/security.html`
  - Clarified security report and logout-all-sessions copy.
  - Added fallback account/deletion request guidance for users who cannot sign in.
- `viewer/account.html`
  - Added signed-in helper text explaining deletion review and export limits.
- `viewer/pricing.html`
  - Added beta pricing note that warns users not to treat displayed tiers as final billing terms until checkout/refund/cancellation/tax/venue terms are published.
  - Clarified that Pro placement does not fake popularity or reviews.

Regression coverage:

- `test/account-page.test.ts` now checks the new trust/legal/privacy/support copy.
- `test/pricing-entitlements.test.ts` now checks the new pricing disclaimer and anti-fake-popularity language.

## 3. Placeholder sections needing owner/legal review

Keep these owner/legal details in the report checklist and replace/publish the appropriate final wording before launch:

- `[legal entity name]`
- `[trading name]`
- `[ABN/ACN if applicable]`
- `[support email]`
- `[privacy contact email]`
- `[service address or postal address if required]`
- `[expected response window]`
- `[refund/cancellation policy owner]`
- `[jurisdiction/dispute venue]`
- `[Stripe customer portal status]`
- `[consumer subscription refunds]`
- `[venue Pro subscription terms]`
- `[GST/tax invoice handling]`
- `[contact route for billing disputes]`
- Final provider names, provider regions, subprocessors, data retention settings, and deletion/anonymisation rules after deployment choices are locked.

Manual legal/product review should confirm:

- Australian privacy-law wording and contact requirements.
- Consumer subscription, cancellation, renewal, refund, and tax invoice wording.
- Venue partner subscription and Pro placement wording.
- Alcohol/responsible-service disclaimers.
- Whether app-specific policy wording is needed after native app release details are final.

## 4. App Store / Play Store relevance

Official references checked:

- Apple App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/
- Google Play Data safety form: https://support.google.com/googleplay/android-developer/answer/10787469
- Google Play account and data deletion policy: https://support.google.com/googleplay/android-developer/answer/13327111
- Supabase changelog/security-relevant platform changes: https://supabase.com/changelog

Readiness notes:

- `viewer/privacy.html` is now positioned as the public privacy-policy URL for website and app-store listings.
- `viewer/privacy.html`, `viewer/feedback.html`, `viewer/security.html`, and `viewer/account.html` now describe account export/deletion paths.
- Google Play generally expects account/data deletion information to be reachable from both in-app and web surfaces. The website now has web instructions, but the owner still needs to confirm the final app listing URL and any mobile in-app links.
- Apple App Privacy and Google Play Data safety answers must be completed from actual production behavior, including data categories, collection purpose, sharing, retention/deletion, tracking, and linked-to-user status. Do not infer final questionnaire answers from this report alone.

## 5. Remaining manual tasks

- Replace all owner/legal placeholders with final approved details.
- Decide final production support/privacy email addresses and expected response windows.
- Confirm final Stripe/checkout behavior before accepting real payments.
- Confirm final provider/subprocessor list and deployment regions.
- Confirm whether account deletion should become an automated self-service flow later; current behavior is a tracked admin review request.
- Review privacy retention wording against actual production retention and moderation/audit needs.
- Publish the final privacy URL and deletion-instructions URL in app store listings once mobile releases are ready.
- If launching paid venue tiers, have owner/legal review all Pro placement, billing, refund, cancellation, and tax wording.

## 6. Commands run

- `npx vitest run test/account-page.test.ts test/pricing-entitlements.test.ts` - passed, 2 test files / 30 tests.
- `npm run build` - passed.
- `npm test` - passed, 27 test files / 266 tests.
- `npm run security:scan` - passed, 261 tracked/untracked files checked.
- `npm run security:audit` - passed, 0 high-severity vulnerabilities reported.
- Official reference reachability checks returned HTTP 200 for Apple App Privacy Details, Google Play Data safety, and Google Play account/data deletion pages.

## 7. Mobile folder confirmation

No mobile app files were edited during this pass. The worktree already contained pre-existing mobile app changes under `apps/` and mobile release docs before this task; those were not touched or reverted.
