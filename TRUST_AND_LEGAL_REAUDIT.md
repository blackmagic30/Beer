# Trust, Privacy, and Support Re-Audit

Date: 30 June 2026

Scope: final review of the trust/legal/support website changes only, plus a sanity check against surrounding launch-readiness concerns. Mobile app folders were not touched.

## Verdict

Keep the changes, with cleanup.

The trust pass made the website better overall because it closes real launch-readiness gaps: clearer privacy handling, account deletion/export instructions, support categories, security reporting, pricing caveats, and app-store/legal follow-up documentation.

One part made the public product feel worse: raw bracket placeholders such as `[legal entity name]` and `[support email]` on public pages. Those were removed/reworded from the visible website and kept in the readiness report where they belong.

## Rating

No prior numeric rating was stored in the existing audit reports, so this uses the pre-trust-pass state described by `MAIN_WEBSITE_AUDIT.md` and `SECURITY_PRIVACY_AUDIT.md` as the baseline.

- Baseline after prior website passes: **8.0 / 10**
- Immediate trust pass before cleanup: **8.1 / 10**
  - Better coverage, but public placeholder text felt unfinished.
- Final after this re-audit cleanup: **8.2 / 10**
  - Slightly higher than baseline because trust, privacy, support, and legal-readiness surfaces are clearer without adding public clunk.

## Keep / Remove Decisions

Kept:

- Privacy plain-English summary.
- Service provider and integration explanation.
- Account deletion and export instructions.
- Feedback/support trust cards.
- Security-report guidance.
- Signed-in account helper text explaining deletion review and export limits.
- Pricing caveat that displayed tiers are beta until final checkout/refund/cancellation/tax/venue terms are published.
- Regression tests for the new trust/support/pricing copy.
- `TRUST_AND_LEGAL_READINESS_REPORT.md` as the owner/legal checklist.

Removed or reworked:

- Raw public bracket placeholders on Privacy, Terms, Feedback, and Pricing surfaces.
- Public Terms paragraph that said `Placeholder:` before billing/refund details.
- Public Privacy article about Apple/Google app-store questionnaire mechanics. The app-store relevance remains in the report instead.
- Internal-sounding pricing/legal wording was rewritten into user-facing beta wording.

## Aspect-by-Aspect Audit

### Trust and Confidence

Improved. Users now get a clearer explanation of what data is public, what stays private, how source evidence is handled, how venue analytics are aggregated, and how to report sensitive issues.

Risk reduced by the cleanup: public pages no longer show raw placeholders that would make the product feel unfinished.

### Privacy Readiness

Improved. The Privacy page now explains account data, submissions, location proof, source evidence, analytics, venue reports, providers, deletion, and export paths.

Remaining task: final provider names, regions, subprocessors, retention periods, owner identity, and privacy contact still need owner/legal review.

### Support Surface

Improved. Contact/support now explains privacy/deletion, security reporting, venue support, and what information helps support respond.

Remaining task: publish final support email/privacy contact/response window before public launch.

### Account Deletion and Export

Improved. The signed-in Account page, public Privacy page, Feedback page, and Security page now consistently describe deletion as a review request and clarify what the quick JSON export excludes.

Remaining task: document and operate the real deletion SLA/process.

### Terms and Pricing

Improved. Terms and Pricing now avoid pretending billing/refund/cancellation/GST terms are final. The pricing disclaimer is now less clunky and more user-facing.

Remaining task: final payment terms need owner/legal review before production payments.

### App Store / Play Store Readiness

Improved in documentation. The public privacy page can serve as the policy URL once owner/legal details are finalized, and the report now tracks Apple App Privacy and Google Play Data safety/deletion relevance.

Remaining task: complete the Apple/Google forms from actual production behavior, not this report alone.

### SEO and Metadata

No regression. Privacy, Terms, Security, Feedback, and Pricing retain metadata/canonical/social tags from previous passes.

### Performance

Neutral. The changes are text-only/static markup. No meaningful bundle or route performance impact was introduced.

### Accessibility

Slightly improved or neutral. Account support messages remain text-based and visible, and status/test coverage from the prior accessibility pass is intact.

Remaining pre-existing polish: shared mobile nav/footer touch targets still sit under ideal 44px in places.

### Security / Supabase

No backend/security regression. No database schema, Supabase policy, auth/session, service-role, or storage behavior changed. The website copy now better matches existing behavior around Supabase Auth/login support, server-side sessions, privacy controls, aggregate venue insights, and deletion/export request flows.

Remaining task: live Supabase Advisor/RLS/storage verification is still required before production launch.

### Mobile Responsiveness

No regression from this pass. Browser audit at `390x844` found no body-level horizontal overflow on the changed pages. The account settings nav has a pre-existing horizontally scrollable/tab behavior, and shared nav/footer touch targets remain a general polish item.

### Clunkiness Check

The first version was slightly clunky because raw placeholders appeared in user-facing copy. The cleanup fixed that. The final copy reads more like a beta product being honest about limits instead of an unfinished legal draft.

## Verification

- Live route checks:
  - `/health` - 200
  - `/privacy.html` - 200
  - `/terms.html` - 200
  - `/feedback.html` - 200
  - `/security.html` - 200
  - `/pricing.html` - 200
  - `/account.html` - 200
- Browser audit:
  - Desktop `1440x900` and mobile `390x844`.
  - No console errors on changed pages.
  - No body-level horizontal overflow on changed pages.
  - No raw public placeholder nodes after cleanup.
- `npx vitest run test/account-page.test.ts test/pricing-entitlements.test.ts` - passed, 2 files / 30 tests.
- `npm run build` - passed.
- `npm test` - passed, 27 files / 266 tests.
- `npm run security:scan` - passed, 262 tracked/untracked files checked.
- `npm run security:audit` - passed, 0 high-severity vulnerabilities.
- `npm run readiness:providers` - passed in development with 13 warnings and 0 failures.
- `npm run test:release:pintpath` - passed, including build, release-readiness tests, provider readiness, security scan, and npm audit.

## Remaining Launch Concerns

- Production provider warnings remain: Google Maps Map ID, Redis rate limiter, source evidence signing secret, Stripe keys/prices/webhook, POS webhook secret, admin allowlist, report timezone, and report email mode.
- Live Supabase RLS/storage/advisor verification still needs to happen against the hosted project.
- Final legal identity, support/privacy contact, response window, billing/refund/cancellation/GST, venue Pro subscription terms, provider list, subprocessors, and retention wording still need owner/legal approval.
- Shared mobile nav/footer touch targets could still be improved.

## Mobile Folder Confirmation

No mobile app folders were touched in this re-audit. The worktree already had unrelated dirty mobile files before this pass; those remain untouched.
