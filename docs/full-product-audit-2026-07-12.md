# Pint Path Full Product, Data, Workflow, and UI Audit

**Original audit date:** 12 July 2026  
**Remediation reassessment:** 13 July 2026  
**Production originally reviewed:** `https://pintpath.au`  
**Original repository snapshot:** `/Users/zac/Desktop/Beer` at `d52d26b`  
**Original overall score:** **6.4/10**  
**Current code-backed implementation score:** **9.2/10**  
**Current local desktop and phone UI score:** **9.1/10**  
**Current production launch-proof score:** **8.6/10**  
**Recommendation:** The application is now a strong deploy candidate. Complete the external proof checklist below after deployment before describing every production workflow as proven.

## Remediation Reassessment

The original P0 and P1 code findings have been addressed. The current implementation passes the TypeScript build, all 342 automated tests, and the repository security scan. A fresh browser pass at 1440 x 1000 and 390 x 844 found no horizontal page overflow, no Pint Path-owned phone action below 44 pixels, uniform navigation labels, a working mobile menu, action-first contact layout, and correctly rendered mission cards. Browser testing also found and fixed a stale `rememberMissionOrder` call that had prevented mission cards from rendering after the earlier sort cleanup.

### Venue counter reassessment - 13 July 2026

The venue redemption area now starts with a staff counter workflow: scan or type a rotating member code, validate it without exposing name/email/internal user ID, choose the purchased item and category, add quantity and an optional receipt/order reference, and record the purchase. The backend returns a safe public member ID, points result, and reward progress. A receipt retry is idempotent and a conflicting reuse returns a clear error. Recent activity is visible to the assigned venue using public member IDs only.

An isolated browser verification used a temporary assigned venue manager and temporary premium member at desktop and 390 x 844 phone widths. The code validated, one Guinness purchase created exactly one drink record, one Pint Point, one security audit event, and one recent-activity row. Repeating the same receipt returned the original result and did not add another record or point. The test data and temporary server were removed afterward.

### Current scorecard

| Area | Current score | Evidence after remediation |
|---|---:|---|
| Core build and automated validation | 9.4 | Build, 342 tests, and security scan pass |
| Authentication and role security | 9.1 | Supabase auth, scoped venue assignments, admin MFA, origin/CSRF controls, safe login returns |
| OCR and submission safety | 9.2 | Multi-image and PDF evidence, two-pass OCR, strict beer filtering, catalogue quarantine, private previews |
| Venue beer and happy-hour management | 9.3 | Direct scoped edits, structured beer-linked happy hours, deletion safeguard, current-price refresh, action-first staff counter |
| Public map discovery | 9.1 | Canonical aliases, current-grain cursor delivery, transparent Best Match, accurate marker tiers |
| Sorting and identity logic | 9.2 | Lower-price relevance, canonical venue aliases, preserved mission sort, scope-specific freshness |
| Missions and contribution lifecycle | 9.1 | Accepted/submitted/completed state, structured mission IDs, recurring cycles, history, cached refresh |
| Account experience | 9.0 | Correct paid/free states, billing management, mission history, privacy/security controls |
| QR, codes, Pint Points, and rewards | 9.4 | In-page QR/manual entry, privacy-safe member preview, accurate quantity cap, idempotent receipts, scoped activity reconciliation |
| Admin operations | 9.2 | Actionable queues, assignment, notes, resolve/reject/reopen, evidence review, linked health panels |
| Billing workflow and product truth | 9.0 | Stripe portal, period display, renewal/cancel/refund copy, failed-payment logic, invoices guidance |
| FAQ, support, and product truth | 9.3 | Implemented rules documented for OCR, missions, QR, billing, venue edits, review, deletion, and ranking |
| Data durability and privacy | 9.3 | Private evidence, retention, durable job state, safe venue member projections, off-site backup verification, restore rehearsal |
| Visual design and brand consistency | 9.1 | Compact operational heroes, flatter hierarchy, consistent 8px cards, clearer action placement |
| Mobile usability and structural accessibility | 9.1 | Uniform 44px controls, no overflow, visible menu, readable tabs, stacked counter actions, focus/labels |
| Performance and scale in code | 9.0 | Public venue cache, cache headers, cursor price loading, current-price SQL grain, cached mission refresh |

### Major remediations completed

- Added Stripe billing portals for consumer and venue subscriptions, current paid-through display, safe checkout reconciliation, and accurate failed-payment handling.
- Replaced accidental higher-price ranking with a transparent Best Match score using availability, price, confidence, freshness, distance, and a bounded disclosed Pro boost.
- Added venue identity aliases and canonicalized price, inventory, detail, and mission reads without overwriting approved local venue data.
- Replaced the global 500-record map ceiling with current-grain SQL selection and cursor pagination.
- Added persisted mission progress, structured submission links, approval completion, recurring verification cycles, account history, missing happy-hour work, and a 30-minute refresh cache.
- Fixed a subtle mission reward defect where unrelated fresh beer data could reduce a missing happy-hour mission from 5 points to 0.1.
- Added actionable feedback, wrong-price, and venue-request queues with assignment, notes, status transitions, timestamps, links, and audit history.
- Added multi-image/PDF source upload, visual thumbnails/PDF tiles, decoded-byte limits, private signed previews, improved OCR prompts, RTD handling, and mandatory catalogue approval for unknown names.
- Corrected admin-published confidence to `admin_verified` while preserving the original OCR/source provenance separately.
- Added QR/login return preservation, external-camera wording, quantity alignment, explicit savings capture, and no misleading fallback metrics.
- Made navigation labels uniform across roles, kept Dashboard available from the venue context, put the contact form before supporting guidance, and removed stale/unfinished product promises.
- Added durable status for backup, restore rehearsal, evidence retention, OCR, Stripe webhook, and mission refresh; the public status page now runs live liveness/readiness checks.
- Added a restore-rehearsal command that restores a verified backup into a clean target and rechecks SQLite integrity, foreign keys, database checksum, and private evidence files.

### External proof still required

These items cannot be truthfully completed by changing repository code alone, so they are not hidden inside the 9.1 implementation score:

- Deploy the final build and complete one controlled production happy hour, special, OCR/PDF submission, Pint Point, Free Pint Reward, support case, subscription, cancellation, and venue-manager edit.
- Run `npm run data:backup:rehearse -- --backup=/path/to/latest/downloaded-backup` against a recent production backup and confirm `job:restore_rehearsal` is healthy in Admin.
- Configure external uptime/readiness alerts with a named owner and escalation destination.
- Move or verify Railway deployment near Australian users, then measure Melbourne P75 map and API startup latency.
- Have the published owner/contact identity, terms, privacy, refund wording, and tax treatment reviewed by the responsible Australian legal/accounting owner. No entity details were invented in code.
- Complete a manual VoiceOver/TalkBack pass and formal accessibility-engine scan on the deployed build.

### What separates the current product from 10/10

- Prove the counter flow in at least three real bars during busy service, targeting a median under 15 seconds per member purchase and less than 1% staff correction/error rate.
- Test camera QR scanning on the venue devices that matter in practice, including current iPhone Safari and Android Chrome, with denied-camera and poor-light fallbacks.
- Add limited counter-staff accounts so casual staff can validate codes and record/void purchases without receiving profile, billing, stock, or analytics permissions.
- Add an audited void/correction workflow that reverses incorrectly awarded points without deleting history.
- Complete native POS integrations for the launch POS systems rather than relying only on manual entry and the generic signed webhook.
- Add controlled offline/poor-network handling so a bar can safely retry a queued receipt without guessing whether the first request succeeded.
- Run a benchmark set for OCR/menu capture, publishing measured beer-name, ABV, availability, and pint-price precision/recall by source type.
- Complete the production workflow, monitoring, Australian latency, backup restore, legal/accounting, and assistive-technology proof listed above.

## Original Baseline Report

The sections below preserve the 12 July findings as the historical baseline. Their scores describe the pre-remediation build and are superseded by the reassessment above.

## Original Brief Summary

Pint Path has a strong technical and visual base. Authentication, role scoping, private evidence storage, OCR review gates, venue beer editing, happy-hour beer selection, admin source review, responsive navigation, Stripe checkout wiring, MFA, backups, and security controls are substantially implemented. The full build, all 341 tests, and the security scan pass.

The main remaining risk is not basic code stability. It is product truth and operational completeness. Several screens promise behaviour that the code does not provide, live venue identities are duplicated, the default map sort promotes higher prices, mission sorting and distance labels are wrong, mission generation rewrites hundreds of database rows on every read, and important paid/support workflows are unfinished. Production also has no live happy hours, specials, code redemptions, Pint Point drink records, or Pro venues, so those workflows are code-tested rather than proven with real use.

The visual system is coherent and professional, especially on desktop. It becomes too card-heavy and verbose on operational pages. Large heroes, repeated summaries, and small horizontal mobile tabs delay the primary action. Venue beer and happy-hour forms are the clearest and most usable surfaces. Missions, admin trust work, contact, and billing management need the most attention.

## Audit Method

This was a code-backed and live-behaviour audit, not a visual-only review.

- Inspected every public HTML surface, shared navigation, API route, business service, repository, schema, crawler/OCR path, and relevant test.
- Exercised production pages at desktop and phone widths, including the public map, mobile menu, account, pricing, FAQ, missions, contact, and unauthenticated redirects.
- Exercised authenticated free/paid user, venue manager, Pro venue, and admin surfaces against an isolated synthetic database.
- Queried the live Railway SQLite database for integrity, counts, duplication, freshness, metadata completeness, queue state, account roles, mission state, and evidence links.
- Measured production API response time and payload size from Melbourne.
- Ran `npm run check`: build passed, 30 test files passed, 341 tests passed, and the security scan passed.
- Verified production readiness endpoints and storage usage.

The isolated authenticated review used synthetic data only. No production user, venue, billing, submission, or redemption record was changed.

## Overall Scorecard

| Area | Score | Status | Main reason |
|---|---:|---|---|
| Core build and automated validation | 9.0 | Strong | Build, 341 tests, and security scan pass |
| Authentication and role security | 8.4 | Strong | Supabase auth, scoped venue access, admin MFA, CSRF/origin checks |
| OCR and submission safety | 7.7 | Good | Two-pass image OCR, deterministic filtering, private evidence, admin catalogue gate |
| Venue beer and happy-hour management | 7.8 | Good | Direct scoped edits, catalogue matching, linked happy-hour beers, deletion threshold |
| Visual design and brand consistency | 7.5 | Good | Coherent type, colour, states, and responsive structure |
| Accessibility foundation | 7.4 | Good with gaps | Labels, landmarks, focus handling, reduced motion; some small mobile targets |
| Data durability and privacy | 7.4 | Good with monitoring gap | SQLite integrity, private evidence, retention, off-site backup implementation |
| Public map discovery | 6.2 | Needs correctness work | Duplicate venues, reversed default price weighting, global 500-record cap |
| Account experience | 6.6 | Needs simplification | Good settings structure; paid/freemium messaging and mobile tabs are confusing |
| QR and redemption workflow | 6.2 | Partly ready | Secure validation and idempotency; first-use scan flow and savings data are weak |
| Admin operations | 6.1 | Partly ready | Strong ingestion review; trust/contact queues cannot be resolved |
| Mobile usability | 6.3 | Needs compression | Responsive with no horizontal page overflow, but oversized and action-light first screens |
| Performance and scale | 5.7 | Needs work | Melbourne traffic is served from LAX; large payloads and write-heavy mission reads |
| Sorting and identity logic | 4.8 | High risk | Default map and mission sorting defects plus duplicate venue IDs |
| Missions and contribution lifecycle | 4.5 | High risk | No completion state, UI sort ignored, false 0 m distance, write churn |
| FAQ, support, and product truth | 4.4 | High risk | Multiple stale promises and no support resolution workflow |
| Billing and legal launch completeness | 3.4 | Blocker | No customer portal/cancel path and pages explicitly say final terms are missing |

## Page Scores: Desktop and Phone

Scores include visual quality, information placement, control ergonomics, workflow correctness, and whether the page keeps its promises.

| Surface | Desktop | Phone | Notes |
|---|---:|---:|---|
| Public map | 7.0 | 6.8 | Strong map and filters; data identity and default sort reduce trust |
| Mobile/desktop navigation | 7.8 | 7.7 | Clear responsive menu; role links can disappear when account context cache is absent |
| Missions | 5.2 | 4.7 | Attractive cards, but sorting, distance, lifecycle, and hero placement are wrong |
| Submit: single/manual | 8.1 | 7.7 | Clear two-step flow and validation |
| Submit: image/OCR | 7.6 | 7.0 | Safe and simple; no PDF upload or visual thumbnail review before sending |
| Sign in/create account | 7.8 | 7.2 | Clear and accessible; hero delays the form on smaller screens |
| Free user account | 6.9 | 6.3 | Useful progress and privacy tools; premium/free reveal model is confusing |
| Freemium contributor account | 7.1 | 6.5 | Good unlock concept; mission completion and current-month feedback need work |
| Paid user account | 6.5 | 5.9 | Features unlock, but no billing management and contributor upsell remains prominent |
| Venue overview | 6.7 | 5.6 | Rich but repetitive; primary tasks start below the fold |
| Venue beers/stock | 8.3 | 7.7 | Best operational surface; clear edit/remove/refresh paths |
| Venue happy hours | 8.2 | 7.7 | Beer-level linking is well designed and supports combined filters |
| Venue redemption | 6.5 | 6.1 | Manual entry is clear; scan/login handoff and savings capture need work |
| Venue profile | 7.5 | 7.0 | Complete and understandable, though long on mobile |
| Venue Pro analytics | 6.4 | 5.6 | Considerable useful structure, but repeats KPIs and shows speculative actions |
| Admin dashboard | 7.4 | 6.5 | Strong visual command centre; too much context before the work |
| Admin source/submission review | 7.2 | 6.4 | Evidence previews and OCR rows are strong |
| Admin trust/contact review | 4.4 | 4.0 | Read-only summaries with no operational close/resolve action |
| Pricing | 5.9 | 5.6 | Plans are clear; cancellation and legal terms are incomplete |
| FAQ | 5.3 | 5.2 | Visually easy to scan; several answers are inaccurate or missing |
| Contact/support | 4.7 | 4.1 | Form works, but four long information blocks delay it and launch contacts are unfinished |
| Privacy/security/terms | 6.3 | 5.9 | Strong technical disclosure, but explicitly marked as unfinished beta legal copy |

## P0: Must Fix Before Broad Paid Launch

### P0.1 Finalise billing, cancellation, refund, and owner terms

**Score: 2.5/10**

The production pricing page says users can cancel through Stripe "once customer portal is enabled." There is no customer portal endpoint or account button for managing/cancelling a subscription. The Terms page says final cancellation, refund, Stripe portal, tax invoice, billing dispute, owner contact, and jurisdiction wording must be published before production payments. The Contact page says the dedicated support email, privacy contact, legal entity, service address, and response window still need to be finalised.

**Required outcome:**

- Add Stripe Billing Portal or an equally clear cancel/manage-subscription workflow.
- Show plan, renewal date, billing status, and manage/cancel action in Account.
- Publish owner/legal entity, support and privacy contacts, response expectations, refund/cancellation terms, GST/tax invoice handling, renewal wording, and jurisdiction.
- Remove every "before launch," "once enabled," and unfinished-beta disclaimer from customer-facing legal and payment pages only after the policy is actually approved.

### P0.2 Do not market paid operation as complete while those terms remain visible

The app can technically create Stripe checkouts, but the customer-facing contract says the commercial workflow is unfinished. Keep checkout private or clearly controlled until P0.1 is complete.

## P1: Correctness and Trust Findings

### P1.1 Canonicalise venue identity across Supabase and SQLite

**Score: 4.2/10**

Live price data contains duplicate logical venues under different IDs:

- Arbory Bar & Eatery
- Garden State Hotel
- Natural History Bar & Grill
- The Duke of Wellington

The public map visibly renders duplicate cards for Garden State Hotel and Arbory Bar & Eatery. The merge layer deduplicates by ID only, while price merging also uses name/suburb. This creates duplicate markers, duplicate missions, conflicting histories, and misleading counts.

**Required outcome:** establish one canonical venue ID, migrate all prices, inventory, submissions, missions, manager assignments, analytics, and aliases to it, then enforce a normalized name/suburb or Google Place identity rule at ingestion.

### P1.2 Fix the public map default "Best match" ordering

**Score: 4.0/10**

The default rail uses `-price` and then sorts ascending. That puts higher prices first. The live rail demonstrated A$19.30 before A$18, A$17, and A$16.50. "Cheapest first" works separately, but the default label "Best match" currently rewards expensive records and a small Pro boost without a balanced relevance model.

**Required outcome:** define and test a transparent relevance score using exact beer match, active availability, confidence, freshness, distance, and a bounded Pro boost. Price should be neutral or lower-is-better, never higher-is-better by accident.

### P1.3 Repair mission sorting, distance, completion, and write behaviour

**Score: 4.1/10**

Four separate defects exist:

1. `Number(null)` causes every mission to show `0 m away` when location is off.
2. The browser randomises missions whenever location is off, overriding the API's selected sort. "Highest points," "Stale data," "No data," and other sort choices therefore do not reliably control the visible list.
3. Accepting a mission only places its ID in submission notes. There is no accepted/completed mission record, so completed work is not explicitly closed or credited to that mission.
4. Every mission list or local area lookup regenerates the mission set, deactivates all auto missions, and upserts hundreds of rows in SQLite. Production currently has 792 active missions; as coverage increases this can grow into thousands of writes per public read.

**Required outcome:** persist mission acceptance/completion, pass `missionId` as structured submission data, mark completed missions, preserve server ordering, hide distance without a location, and refresh mission definitions on a schedule or stale cache rather than on every GET.

### P1.4 Replace the global 500-price-record ceiling

The public map requests a maximum of 500 price records across the whole system. Production has 354 now, so this is close to the ceiling. Once the system crosses 500 current records, older but valid venues will silently lose their prices from the initial map and may look empty.

**Required outcome:** return the latest record per canonical venue/beer/serve grain using pagination, cursoring, area bounds, or a materialized current-price table. Do not use one global recency limit as the map dataset.

### P1.5 Make FAQ and venue copy match actual write/review rules

**Score: 4.0/10**

Current false or stale promises include:

- FAQ says matching community confirmations can publish a price. The backend explicitly returns `autoApproved: false` and says community confirmations never auto-publish.
- There is no user-facing community verification screen.
- Consumer and bar FAQ say venue changes stay pending until admin review. Profile, beer, and happy-hour writes save directly. Only controlled subscription/promotion actions and the fourth deletion in an hour are queued.
- Pricing says Free venue beer and happy-hour changes require admin review, which is not the implemented rule.
- Admin says pending venue changes are manager edits waiting for approval, although normal edits are already live.

**Required outcome:** choose the intended rules, then update code, FAQ, pricing, admin, and venue copy together. Add contract tests for the published wording.

### P1.6 Add real trust and support queue operations

**Score: 4.0/10**

Wrong-price reports, venue/beer requests, and contact messages are displayed as truncated text summaries. There is no admin action to assign, respond, resolve, reject, or close them. Production currently has no open trust/contact items, but the workflow will fail as soon as volume arrives.

**Required outcome:** add item-level views, status filters, owner/assignee, notes, reply/contact action, resolve/reopen controls, timestamps, and an audit trail.

### P1.7 Finish the QR scan and first-use venue login handoff

**Score: 6.0/10**

The secure core is good: six-character codes are uppercase-normalised, hashed, time-limited, server validated, role scoped, idempotent, and points-capped. A QR opens the venue portal with the code prefilled.

The gaps are:

- There is no in-dashboard camera scanner. "Scan it here" means staff must use the phone's external camera app.
- An unauthenticated QR visitor gets a login error with no focused sign-in action; the claim panel is hidden in the error branch.
- The generic Account nav link does not preserve the QR URL/code as `next`, so first-time staff can lose the transaction.
- The UI allows quantity up to 20 while the API rejects anything above 4.
- Beer redemptions and fixed-price specials often record A$0 savings because savings are only inferred from text such as "$2 off". A "$9 pint" does not calculate its saving from the regular price.

**Required outcome:** add a camera scan button or change the copy to "scan with your phone camera"; preserve a safe return path through login; align quantity limits; and store explicit discount value or link the special to a regular beer price.

### P1.8 Prove new production workflows with controlled real records

Production has:

- 0 happy hours
- 0 venue specials
- 0 discount redemptions
- 0 Pint Point drink records
- 0 venues accepting Pint Path codes
- 0 Pro venue profiles
- 20 photo submissions, but every one has `ocr_status = not_requested`

The code and tests are meaningful, but these features are not proven in the live environment. Use one owned test venue and clearly labelled test accounts to complete one end-to-end record for each path, then remove or archive test data where appropriate.

### P1.9 Reduce Melbourne latency and map startup payload

Production responses were served through Railway LAX during this audit:

- `/ready`: about 0.84 s
- `/api/business/venues?limit=1000`: 2.6-4.0 s
- `/api/business/price-records?limit=500`: 1.4-1.5 s
- `/api/business/missions?limit=200`: about 1.15 s

The venue and price payloads total about 579 KB before compression, plus a 308 KB map HTML file and Google Maps assets. Railway gzip is active, but distance and upstream Supabase calls still dominate.

**Required outcome:** run the service close to Australian users, cache public venue metadata, request data by map bounds, avoid repeated Supabase full-list reads, and stop write-heavy mission refreshes on GET.

## Data, Storage, and Sorting Audit

### Production data snapshot

**Score: 6.0/10**

| Dataset | Live count | Assessment |
|---|---:|---|
| Mapped venue locations | 630 | Good base footprint |
| Map venues still needing data | 592 | About 94% of footprint remains unpopulated |
| Venue price records | 354 | Below the 500-record client ceiling, but close enough to address now |
| Distinct priced venue IDs | 38 | Small populated share |
| Venue inventory rows | 335 | Useful, with metadata gaps |
| Venue profiles | 43 | All Basic; no live Pro venue |
| Happy hours | 0 | Combined happy-hour search cannot be proven live |
| Venue specials | 0 | Paid special flow not proven live |
| Beer catalogue items | 211 | 197 active, 14 pending review |
| User submissions | 25 | 24 approved, 1 rejected, none pending |
| Photo submissions | 20 | Legacy/current records have no OCR run status |
| Source ingestion queue | 266 | 28 published, 238 rejected, 0 pending |
| Active missions | 792 | 657 represent venues with no data |
| Accounts | 5 | 3 free, 1 paid monthly, 1 admin |
| Active venue manager assignments | 1 | Role scoping exists, but little live usage |

### What is strong

- SQLite integrity check passes and there are no foreign-key violations.
- The Railway volume uses about 28 MB of 434 MB, around 7%.
- Source ingestion is operationally clean with no stale pending queue.
- No invalid, zero, negative, or extreme live price was found.
- Normalized beer IDs and verification timestamps are complete on live price records.
- Only five price records are older than 30 days and none are older than 90 days.
- Private evidence records are linked and retention-aware.
- Off-site backup code snapshots, verifies checksums after upload, and prunes by retention.

### What needs work

- Venue identity is split across Supabase venues and local SQLite profiles/cache/prices and merged by ID only.
- Four duplicate logical venues are already visible.
- `venue_beers` has 142 rows without brewery, 143 without style, and 108 without ABV.
- The active catalogue still has 12 items without brewery, 12 without style, and 43 without ABV.
- All 354 live price records use the coarse `photo_verified` confidence label, including different source types. Confidence currently overstates uniformity.
- Venue profiles are sparse: 15 lack address, 19 lack website, and 42 lack description.
- The backup mechanism has no durable last-success record, admin indicator, or alert. A configured bucket is not proof that the latest backup succeeded.
- The current-price query fetches historical rows by recency, then deduplicates in application code. A dedicated current-price grain would be simpler and safer.

## Search and Filter Audit

**Score: 6.4/10**

### Strong

- Exact canonical beer matching keeps Guinness 0.0 separate from alcoholic Guinness.
- Unknown prices are excluded from cheapest and under-A$10 calculations.
- Happy-hour and beer double filtering supports structured linked beer rows.
- On-tap, verified-only, location radius, recent verification, saved areas, and price state have clear logic.
- Package-only and unavailable states do not masquerade as pint prices.

### Needs work

- Default Best Match ordering is reversed by price.
- Duplicate venue identities create duplicate filter results.
- No live happy-hour records exist, so the combined filter has no real production proof.
- The free-price-reveal counter is effectively dead. `price_view_revealed` is counted but not emitted by the active path, and non-preview prices remain redacted even on a reveal request. The product should either implement five daily reveals or remove that model and describe the fixed free preview honestly.
- Only 500 price records are loaded globally.
- A generic text fallback for old happy-hour descriptions is less reliable than structured beer links and should be treated as low confidence.

## Submission and OCR Audit

**Score: 7.7/10**

### Manual submissions

The manual flow is clear: choose/search venue, choose submission type, enter beer/serve/price/tap status, and submit for review. New venues require Google selection or reviewed location details. Offline submissions use browser storage and retry. Idempotency prevents duplicate sends.

### Image submissions

Users can attach up to six images and remove mistakes with an X. Images are compressed to JPEG at a maximum 2200-pixel edge, metadata is stripped by canvas re-encoding, unsafe formats are rejected, and total post-compression size is limited. Evidence is stored privately and shown to admins through short-lived signed links.

The OCR path is strong for this stage:

- Uses a structured JSON schema.
- Reads up to six images.
- Uses a high-capability primary model and fallback.
- Runs a stricter second review pass.
- Explicitly rejects food, spirits, wine, cocktails, headings, slogans, package size, ABV-as-price, and lower pour prices.
- Understands Australian pot/schooner/pint order, tins, cans, bottles, and tap section headings.
- Canonicalises close OCR matches only at a strict fuzzy threshold.
- Quarantines unknown OCR beer names as pending catalogue items.
- Blocks submission publication until every unknown OCR beer is approved, merged, or rejected.

### OCR and upload gaps

- User upload accepts images only, not PDF menus. The admin crawler handles PDFs/websites, but the user flow does not.
- The selected-image list shows file names and sizes, not thumbnails. Users cannot visually confirm crop/order before sending.
- A full dense menu compressed to 2200 pixels can still make small multi-column text difficult. The UI should encourage one close crop per section/page.
- HEIC browser canvas support varies even though the server accepts HEIC/HEIF.
- The deterministic beer-name filter allows beer/cider/RTD categories but rejects names containing gin, vodka, whisky, or bourbon. This can discard legitimate RTDs and contradicts the OCR category schema.
- Manual unknown beer names create pending catalogue entries but do not receive the same `requiresCatalogApproval` publication gate used for OCR items.
- No live production photo submission has exercised the current OCR path, so accuracy is test-backed rather than production-proven.

## Missions and Contribution Points Audit

**Score: 4.5/10**

### What works

- New/no-data work is worth 5 points and receives a 1.2x coverage bonus.
- Updates under 24 hours are worth 0.1, under seven days 0.5, and stale work 1.
- Adding a genuinely new drink receives at least the new-data reward.
- Points unlock only after admin review and location eligibility.
- A user cannot repeatedly earn unlimited venue points because the ledger has a user/venue/month uniqueness rule.

### What does not work smoothly

- Selected sort is overwritten by random client ordering when location is off.
- Missing distance becomes 0 metres.
- There is no accepted, in-progress, completed, expired, or completed-by-user mission lifecycle.
- `missionId` is embedded in notes rather than stored in a structured submission field.
- Old manually seeded demo venue IDs can disagree with the canonical live venue ID.
- Hundreds of missions are rewritten on every read.
- Recently completed work becomes a low-value active mission rather than a visibly completed mission.
- The account cannot clearly show "you completed this mission" or prevent a stale card lingering after approval.

## QR, Codes, Pint Points, and Rewards Audit

**Score: 6.2/10**

### Security and data logic

- Codes use an ambiguity-reduced alphabet, six characters, hashing, secure random generation, and expiry.
- Discount codes last 30 minutes; Free Pint Reward codes last 10 minutes.
- Venue redemptions require an assigned manager and an enabled venue.
- Redemption writes are transactional and idempotent.
- Points are capped at eight per 24 hours and quantities are capped server-side at four.
- A Free Pint Reward costs 50 points and does not itself earn another point.
- Venue analytics expose aggregate redemption data, not user email or exact location.

### Ease of use

Manual entry is straightforward and the code field is prominent. The user chooses a current special or beer and quantity, then receives immediate validation. However, the page spends a large block explaining the four-step process before the staff form. On a busy bar device, staff mode should open directly on the code field.

The QR is a link that pre-fills the code. It is not an embedded camera reader. That is acceptable if labelled accurately and if login return is fixed.

## Venue Account Audit

### Access and permissions

**Score: 8.5/10**

- Non-admin managers receive only active assignments for their own user ID.
- Every read/write checks the selected venue assignment.
- Cross-venue beer, happy-hour, special, and profile IDs are rejected.
- Normal beer/profile/happy-hour changes save directly.
- The fourth beer deletion in an hour is queued for admin review; the first three are audited and direct.
- Subscription tier and code-acceptance flags are admin-controlled.

### Venue UI

**Score: 7.0/10 overall**

The Beers/stock and Happy hours screens are the strongest parts of the product. Inputs are labelled, current stock is visible beside the form, edit/remove actions are obvious, catalogue matching is explained in context, and the price refresh tool supports bulk confirmation.

The overview is overloaded. It repeats today's tasks, KPI summaries, quick actions, a demand cockpit, a command centre, growth studio, listing readiness, and recent records. Some recommendations are generated from fallback/demo-like values and can contradict the visible counts. In the synthetic Pro review, the page showed 3 due beer rows but recommended refreshing 5, showed 0 pending changes but recommended reviewing 10, and repeated listing quality in multiple sections.

On mobile, the venue title, managed-venue selector, duplicate venue summary card, section selector, and logout button consume the first screen before any task. Remove the duplicate card and open the chosen task closer to the top.

### Venue tier truth

- Free venues can manage profile, beer, and happy-hour data.
- Pro adds specials, analytics, reports, premium map treatment, and POS integration capability.
- Production has no Pro venue and no live analytics/redemption volume, so Pro value claims remain largely unvalidated.

## Account Type Audit

### Signed-out visitor: 7.0/10

Can browse the map, see a limited beer preview, happy hours, mapped venues, FAQ, pricing, and account entry. The value proposition is understandable. Duplicate venues and opaque locked controls reduce trust.

### Free account: 6.7/10

Can submit, save data, build contribution progress, manage privacy/security, and see own history. The fixed free-preview model conflicts with the unused daily-reveal configuration.

### Freemium contributor: 6.9/10

The 15-point month unlock is understandable and gives a non-payment path. It needs mission completion history, clearer point event details, and reliable current-month attribution.

### Paid user: 6.2/10

Receives full filters, prices, toolkit, beta features, and discount pass. The account still prominently says "Earn premium access" and shows freemium progress even when the user is already Premium Yearly. There is no renewal date, payment method, invoice history, or manage/cancel button.

### Venue Free: 7.2/10

Core operational forms are useful. Pricing/FAQ copy incorrectly says all changes await review.

### Venue Pro: 6.6/10

Feature breadth is high, but the page is too dense and production has no live Pro evidence. Recommendations must be strictly derived from current data and suppress themselves when there is no signal.

### Admin: 6.3/10

MFA, source evidence, OCR review, beer catalogue approval/merge/reject, ingestion publish/reject, manager assignment, billing visibility, and data capture are strong. The actual queue starts too far below the hero/status/snapshot blocks, and trust/support work has no resolution actions.

## FAQ and Help Audit

**Score: 4.4/10 content, 7.4/10 presentation**

The accordion is accessible, readable, and touch-friendly. It covers price trust, submissions, missing venues, accounts, location, offline use, photo privacy, premium, bar editing, paid venue privacy, security, and responsible drinking.

Add or correct answers for:

- Missions, point calculation, approval timing, and monthly reset.
- What "completed" means for a mission.
- OCR output, private image review, and pending new beer names.
- QR/6-character code use, expiry, staff login, and failed redemption.
- Pint Points and Free Pint Reward rules.
- Exact venue manager changes that save immediately versus actions that require review.
- Subscription renewal, cancellation, refunds, invoices, and failed payment.
- Account deletion timing and MFA recovery.
- What users should do when no happy-hour data exists.
- Why a paid venue is visually promoted and how Best Match remains fair.

Remove all community-auto-publish claims unless that workflow is deliberately implemented.

## UI and Visual Design Audit

### Colour: 7.6/10

The dark navy base, white text, cyan/violet primary action, gold premium state, green success, and red danger state are coherent. The app is recognisable and status colours are generally paired with text.

The palette is dominated by dark blue/slate surfaces and repeated cyan/violet gradients. Operational pages would scan better with flatter neutral surfaces and fewer decorative background gradients. Premium gold should remain a semantic tier signal, not another general accent.

### Typography: 7.5/10

Fraunces gives Pint Path a clear personality and Avenir/SF/Segoe UI is readable for controls. Body copy is generally 15-16 px with good line height.

The 52 px desktop and 46 px phone heroes are too large on missions, admin, contact, pricing, and venue operational pages. Those are tools, not landing pages. Account mobile tabs use about 11.5 px text and 36 px height, below the preferred 44 px touch target.

### Spacing and placement: 6.3/10

Spacing tokens are consistent, forms have clear gaps, and dangerous actions are visually separated. The main issue is accumulated vertical space:

- Contact is about 3065 px tall on a phone and places four explanatory articles before the message form.
- Admin review puts the work below hero, tab rail, status, snapshot, and command-centre introduction.
- Venue overview repeats similar KPIs and actions across several large panels.
- Missions puts a large editorial hero before search and sort.
- Account login puts three feature cards before the sign-in form.

Move the action first and supporting explanation after it on operational pages.

### Cards and radii: 6.1/10

Cards are used for nearly every section, and cards often contain more cards. Large 18-30 px radii and repeated shadows soften hierarchy. Reserve cards for repeated records, tools, and modal focus. Use unframed bands or simple dividers for page sections and compact operations.

### Buttons: 7.1/10

Primary, neutral, premium, and danger actions are consistent. Venue edit/remove and admin approve/reject are especially clear. Most phone controls meet 44 px, but several submit/contact buttons are 42 px and account settings tabs are 36 px. Icon opportunities such as close/remove use text or `X` instead of a standard icon with tooltip.

### Responsive behaviour: 7.2/10

No horizontal page overflow was found at 1440, 390, or narrow phone widths. The mobile nav is a clear two-column menu with 44 px controls. Map controls stack well and the map stays visible in the first screen.

The account setting rail is horizontally clipped with no scroll cue, operational heroes consume too much phone height, and repeated cards make long pages tiring.

### Accessibility: 7.4/10

Strengths include skip links, landmarks, labelled controls, keyboard-accessible dialogs, FAQ summaries, map keyboard controls, focus restoration, screen-reader labels, non-colour state copy, and reduced-motion rules.

Remaining gaps:

- Increase all phone targets to at least 44 px.
- Increase account mobile tab text from 11.5 px.
- Replace hidden horizontal tab overflow with a select/menu or visible scroll affordance.
- Run an automated axe scan and manual VoiceOver/TalkBack pass; current tests are structural rather than a full accessibility engine.
- Recheck muted/disabled text contrast and focus order on long admin/venue pages.

## Navigation Audit

**Score: 7.4/10**

The public route set is consistent: Map, Dashboard when known, Submit, Missions, Admin when known, Pricing, FAQ, Account, and Contact/Support. Mobile collapse works and Escape/focus behaviour is implemented.

Role links rely on `pintPathAccountContext` in local storage. A valid cookie-authenticated manager opening the venue portal directly can receive a working dashboard while the top nav omits Dashboard because the cached context has not been populated. Bar accounts also rename FAQ to Bar FAQ and Contact us to Support, which means the visible options still vary by cached role.

**Required outcome:** hydrate account context before rendering role-sensitive navigation, or render the current role link from the authenticated page state. Treat the active venue portal itself as enough reason to include Dashboard.

## Button and Workflow Matrix

| Control group | Result | Score | Finding |
|---|---|---:|---|
| Desktop/mobile nav | Works | 7.4 | Role-cache inconsistency remains |
| Map marker/detail | Works | 7.0 | Good focus overlay; duplicate marker identities |
| Best Match | Incorrect | 3.5 | Higher prices rank first |
| Cheapest/nearest | Works with entitlements | 7.5 | Unknown prices correctly excluded |
| Beer exact filter | Works | 8.5 | Guinness 0.0 separation is tested |
| Happy-hour + beer | Code works | 7.5 | No live production data to prove it |
| Account Google/Apple/email login | Works | 8.5 | User-confirmed and code/test-backed |
| Account logout all sessions | Works | 8.5 | Also revokes discount passes |
| Account manage subscription | Missing | 1.0 | No Stripe portal/cancel action |
| Submit single/multiple | Works | 8.0 | Clear validation and idempotency |
| Submit photo remove X | Works | 8.0 | Add thumbnail preview |
| Submit PDF menu | Missing | 2.0 | Images only |
| Mission sort | Incorrect | 3.0 | Client randomisation overrides selected sort |
| Accept mission | Partial | 4.5 | Prefills submit but no lifecycle/completion |
| Venue beer save/edit/remove | Works | 8.5 | Fourth delete queues for review |
| Venue price bulk refresh | Works | 8.0 | Useful operational control |
| Venue happy-hour beer linking | Works | 8.5 | Best new workflow |
| QR open/prefill | Partial | 6.5 | External camera and login return gap |
| Six-character manual entry | Works | 8.0 | Align quantity max |
| Admin ingestion publish/reject | Works | 8.3 | Review-first and live-publish path is tested |
| Admin beer approve/merge/reject | Works | 8.3 | OCR publication gate is sound |
| Admin submission evidence preview | Works | 8.1 | Multi-image signed previews and OCR rows |
| Admin trust/contact resolve | Missing | 1.5 | Read-only summaries |
| Contact send | Works | 6.0 | No staff-side resolution workflow |

## Security, Privacy, and Reliability

**Score: 8.0/10 security, 7.0/10 operations**

### Strong

- Supabase-backed login with email verification and OAuth.
- Admin MFA step-up in production.
- Session cookies are HttpOnly, SameSite Lax, Secure in production, and server-side revocable.
- Non-GET requests enforce trusted Origin.
- Venue access is assignment scoped.
- Signed evidence URLs expire and source evidence is private.
- CSP, HSTS, frame protection, MIME protection, referrer policy, and permissions policy are present.
- Rate limiting supports Redis and production readiness checks require it.
- Passwords, tokens, precise coordinates, source images, and secrets are redacted from analytics/log metadata.
- Account deletion includes a seven-day safety window and deletes the Supabase auth user before local anonymisation.
- Stripe webhooks and redemption writes are idempotent.
- `/health` and `/ready` serve different liveness/readiness purposes.

### Needs work

- Publish a durable last-success/failure indicator for off-site backup, OCR, Redis, Stripe webhook, and evidence retention jobs.
- Add external uptime/ready monitoring and alert ownership; the public status page says monitoring is still being formalised.
- Treat QR codes in browser history as short-lived secrets and avoid copying them into support/log metadata.
- Run one periodic restore rehearsal, not only backup creation/checksum verification.
- Add item-level support queue permissions and audit actions before support volume grows.

## Performance and Maintainability

**Score: 5.7/10**

- `viewer/index.html` is about 308 KB.
- `viewer/business.css` is about 191 KB and 9731 lines.
- `viewer/admin.html` and `viewer/venue-portal.html` are about 198 KB and 193 KB.
- Railway gzip is active and static asset caching is sensible.
- The CSS has repeated mobile media blocks and a large global override surface.
- Public map boot fetches up to 1000 venues and 500 prices before area scoping.
- Venue listing hits Supabase and local merge logic, contributing to multi-second Melbourne response time.
- Mission reads cause bulk database writes.

Split business CSS by shared foundation plus page modules, move large inline scripts into tested modules, cache public venue metadata, and replace global payloads with bounds/cursor APIs.

## Recommended Fix Order

### Phase 0: Commercial and legal gate

1. Add Stripe customer portal/manage-cancel flow.
2. Finalise terms, privacy, refund/cancellation, tax, legal entity, support, and privacy contacts.
3. Remove unfinished customer-facing launch disclaimers only after approval.

### Phase 1: Public correctness

1. Canonicalise duplicate venue IDs and add prevention constraints.
2. Fix Best Match scoring and add an ordering regression test.
3. Replace the 500-record global price cap.
4. Correct FAQ/pricing/admin/venue workflow copy.

### Phase 2: Missions and contribution trust

1. Stop random client reordering.
2. Fix null distance display.
3. Add structured mission acceptance/completion state.
4. Refresh missions on schedule/cache rather than every read.
5. Reconcile demo/manual mission IDs to canonical venue IDs.

### Phase 3: Admin and support operations

1. Add resolve/reopen/assign/note actions for wrong-price, venue request, and contact queues.
2. Put actionable queues above descriptive admin content.
3. Add operational counts for oldest item and SLA age.

### Phase 4: Redemption and live proof

1. Fix QR login return and clarify camera scanning.
2. Align quantity limits and explicit savings data.
3. Enable one controlled test venue for codes.
4. Complete real happy-hour, special, discount, Pint Point, Pro, and OCR submissions end to end.

### Phase 5: UI compression and accessibility

1. Reduce operational hero sizes.
2. Put forms/tasks before explanatory content.
3. Remove nested/repeated cards and duplicate KPI panels.
4. Replace account mobile tab rail with an accessible select/menu or larger scrollable tabs.
5. Raise every phone target to 44 px and run axe plus VoiceOver/TalkBack checks.

### Phase 6: Scale and observability

1. Host close to Melbourne users and cache public venue data.
2. Add map-bounds data APIs.
3. Record and alert on backup/job/provider health.
4. Perform a restore rehearsal and load test map/missions/admin queues.

## Definition of Ready for Broad Launch

Pint Path should be considered ready for broad paid launch when all of the following are true:

- P0 billing/legal work is complete and customer-facing pages no longer describe unfinished terms.
- No logical venue appears twice on the map.
- Best Match and mission sort regression tests reflect the intended product order.
- Missions visibly complete and do not rewrite the mission table on each read.
- Public price delivery remains complete above 500 records.
- FAQ and pricing copy match implemented workflows.
- Admin can resolve every queue it displays.
- QR scanning survives first-time login and records correct savings.
- At least one controlled live record has passed through each happy-hour, special, OCR, discount, Pint Point, Free Pint, Pro venue, and support workflow.
- A recent off-site backup restore has been rehearsed.
- Melbourne P75 map startup and API targets are defined and met.
- Mobile account controls meet touch-size and accessibility requirements.

## Final Assessment

Pint Path is a credible, well-built beta with a better technical foundation than its current overall score might suggest. The score is being pulled down by a small number of high-impact truth, identity, mission, billing, and operational gaps. The venue data forms, OCR safety model, auth boundaries, evidence privacy, and ingestion review are strong foundations. Fixing the P0/P1 sequence above should move the product into the 8/10 range without needing a visual redesign or a new architecture.
