# Pint Path full remediation audit

> Historical, non-executable snapshot. Its deploy and Railway configuration
> tasks are superseded by the current production launch and provider runbooks.
> Every Railway write now requires the tracked
> `readiness:railway:mutation-boundary` executor with an immediate preflight and
> unconditional postflight.

**Audit and remediation date:** 14 July 2026
**Repository:** `/Users/zac/Desktop/Beer`
**Scope:** public website, authenticated consumer accounts, contributor accounts, venue managers, counter staff, admins, API/backend, SQLite/Supabase storage, Stripe, backup/restore, iOS, Android, accessibility, performance, operations, and release evidence.

## Outcome

This was a fix pass, not a visual-only review. Every repository-side defect found during repeated browser, static, contract, security, privacy, data-integrity, concurrency, billing, native, backup, and adversarial reviews was patched and covered in proportion to its risk.

The remaining items at the end of this document are external evidence tasks. They require deployed providers, physical devices, legal/accounting owners, real venues, or store-signing accounts and cannot truthfully be completed by changing this checkout.

“No known repository-side defect remains” means the current tree passed the final gates listed below. It is not a claim that software can never contain an undiscovered defect or that unrun production evidence is complete.

## Review method

The final result came from several independent passes:

1. Cross-role browser review at desktop and 390 x 844 phone sizes.
2. Anonymous, consumer, venue-manager, counter-staff, and admin workflow review against isolated synthetic data.
3. API-to-UI contract reconciliation instead of relying on copy or route names.
4. Stripe event-order, replay, deletion-race, recovery, and duplicate-subscription review.
5. Privacy, erasure, retention, session, evidence, and storage-policy review.
6. SQLite migration, query-bound, index, pagination, and concurrency review.
7. Independent off-site backup, deletion-ledger, restore, and readiness review.
8. iOS and Android auth, persistence, pagination, upload, role, and lifecycle review.
9. Static HTML, local-reference, duplicate-ID, inline-script, form-label, and touch-target checks.
10. Repeated adversarial re-audits after fixes landed, including checks for newly introduced contract regressions.

## Complete remediation ledger

### Public and signed-out experience

1. Fixed the map’s blank/broken state when Google Maps is unavailable or no API key is configured; the venue list remains usable.
2. Fixed the map bootstrap promise rejection in list-only mode.
3. Corrected map/list legend language so it reflects the active rendering mode.
4. Changed missing optional map configuration from a false error state to clear informational copy.
5. Kept venue discovery available without leaking server/provider secrets into browser configuration.
6. Added bounded, paginated venue directory reads instead of whole-table remote reads.
7. Removed write-on-read venue location and alias population from public GET requests.
8. Replaced application-side venue-directory accumulation with one bounded SQL union/count page offline and one ranged Supabase request online.
9. Kept public venue merging pure and deterministic.
10. Fixed public price pagination so filtered, expired, duplicate, or ineligible rows cannot prematurely end a page while valid older rows remain.
11. Kept current-price selection at the correct venue/beer/serve grain.
12. Preserved exact tracked-beer separation, including alcoholic and zero-alcohol variants.
13. Preserved unknown-price exclusion from cheapest/price-threshold results.
14. Kept Best Match lower-price-aware, confidence/freshness-aware, and transparent about bounded promotion.
15. Removed mission-write side effects from public mission reads.
16. Fixed missing-location distance and selected-sort behavior in mission cards.
17. Kept map search language understandable on phone (`Area or venue`).
18. Ensured the no-data and no-map states contain a usable next action instead of a dead end.
19. Added explicit cache-control behavior for public APIs and static files.
20. Made unversioned `business.js` and `business.css` revalidate on every navigation so a deployment cannot pair new HTML with hour-stale code.
21. Added compression for large public static responses.
22. Pinned every jsDelivr executable to an exact version with integrity, CORS, and referrer controls.
23. Tightened the content-security policy to the exact pinned CDN paths.
24. Denied framing through CSP and `X-Frame-Options: DENY` after removing the last legitimate embedded-frame dependency.
25. Kept public support, trust, status, pricing, and feedback pages usable without horizontal overflow.
26. Added query-driven support-type selection so reward/billing links open the correct support category.
27. Preserved support receipt/reference copy after a successful message.

### Authentication, consumer, contributor, and account settings

28. Implemented Supabase email, Google, and Apple auth handling with PKCE-safe callback behavior; live provider-console verification remains an external gate.
29. Bound signup age/Terms/Privacy acceptance to the verified auth flow rather than editable provider metadata.
30. Kept confirmation, resend, callback, and cross-device acceptance paths consistent.
31. Hydrated role authority before rendering role-sensitive navigation.
32. Removed stale raw-role authority from clients; current server access is authoritative.
33. Added provider-global session revocation after password reset.
34. Added provider-global revocation for “sign out all devices.”
35. Kept current-device logout and all-device logout behavior distinct and accurately described.
36. Added recent-authentication checks to session listing/revocation, export, deletion request/cancel, and logout-all.
37. Added Supabase token step-up through a dedicated reauthentication header.
38. Added local-password step-up without persisting the password.
39. Replaced the inaccessible native browser password prompt with a labelled, cancellable, ephemeral dialog.
40. Avoided automatically triggering a sensitive-session prompt just because the account page loaded.
41. Added clear re-sign-in/MFA guidance when recent authentication is stale.
42. Added production-safe structured error codes for suspended-account billing recovery instead of relying on development-only error details.
43. Added a billing-only recovery panel for suspended subscribers without restoring application access.
44. Supported provider-token and explicit local email/password recovery modes.
45. Supported personal and named managed-venue billing profile selection, including multiple venues.
46. Prevented counter-staff assignments from being treated as venue billing authority.
47. Added a direct billing-support fallback from recovery.
48. Kept non-billable suspended users from seeing a dead billing action.
49. Corrected account totals so all submissions are counted rather than only the first page.
50. Added complete submission and session pagination.
51. Kept account aggregates and partner totals exact under dense fixtures.
52. Corrected paid/free/contributor dashboard state and paid-through copy.
53. Added working billing management for normal paid accounts, including failed/cancelled recovery paths.
54. Made account export copy accurately disclose retained exact upload coordinates while evidence files are listed rather than embedded.
55. Added an export-size safety limit and low-cost rate limit.
56. Added deletion request status, cancel, safety-window, and receipt behavior.
57. Preserved policy-required moderation/security/billing records while removing user-identifying content according to the retention policy.
58. Made privacy consent version server-owned while accepting older clients for compatibility.
59. Immediately purged optional analytics/venue-insight scopes when consent is withdrawn.
60. Preserved support-message content where policy requires follow-up while removing deleted-account identity.
61. Added a safe leaderboard display-name policy, uniqueness, impersonation, URL, and abuse controls.
62. Made leaderboard month assignment use authoritative server time and the configured Melbourne reporting timezone rather than unbounded client `observedAt`.
63. Aligned approved-submission tie-breaking to the same authoritative campaign boundary.
64. Revalidated prize eligibility at finalization and transactionally reranked the first three eligible contributors.
65. Excluded admins, venue staff, suspended/deleted accounts, and otherwise ineligible rows from prizes.
66. Added 90-day reward voucher expiry.
67. Added user-visible voucher amount, title, status, claim reference, instructions, expiry, selectable/copyable reference, and support path.
68. Removed misleading generic partner-redemption copy from manually fulfilled leaderboard vouchers.
69. Added accurate fulfilled, expired, and void voucher states.
70. Kept the responsible-drinking route planner explicit that it is not a drinking requirement.
71. Kept the standard-drink log from claiming to estimate BAC, sobriety, or driving clearance.

### Venue manager and counter-staff experience

72. Preserved strict assigned-venue scoping for every venue read and write.
73. Added a real counter-staff role rather than giving casual staff manager access.
74. Restricted counter staff to code validation, purchase recording, reward handling, and permitted correction tasks.
75. Removed reconciliation, profile, billing, stock, analytics, and admin data from the counter-staff UI and server response.
76. Prevented the counter client from requesting manager-only reconciliation data.
77. Added privacy-safe member previews using public account IDs only.
78. Added idempotent transaction/receipt references so safe retry cannot double-award points.
79. Added bounded offline/poor-network receipt retry with explicit conflict and manual-reconciliation states.
80. Kept pending receipts in session storage rather than long-lived local storage.
81. Added queue capacity, duplicate payload, and conflicting reference protection.
82. Added dedicated counter/POS rate limits rather than sharing a broad write bucket.
83. Added audited void/correction behavior for Pint Point drink records without deleting history.
84. Prevented discount redemption from separately duplicating Pint Points.
85. Added reward-code expiry, quantity limits, RSA-safe copy, and idempotency.
86. Added manager invite, acceptance, expiry, revoke, and counter-only capability checks.
87. Added explicit “Sign out all devices” to native and web account security.
88. Fixed the venue mobile logout touch target.
89. Changed venue phone, website, and Instagram inputs to appropriate semantic types/autocomplete modes.
90. Added optimistic concurrency to venue profile updates.
91. Added optimistic concurrency to beer updates and deletion.
92. Added optimistic concurrency to happy-hour updates and deletion.
93. Added optimistic concurrency to special updates and deletion.
94. Made missing version tokens fail closed for existing records.
95. Made repository compare-and-update/delete atomic so check/use races cannot silently overwrite a teammate.
96. Preserved unsaved form content and showed specific 409 guidance after a concurrent edit.
97. Preserved unknown venue tags and legacy opening-hours data during round trips.
98. Kept tier, activation, and code-acceptance fields admin-authoritative.
99. Preserved the protected fourth beer deletion/admin-review safeguard across multiple managers.
100. Kept profile, beer, and happy-hour ordinary edits direct for assigned managers while restricted changes remain reviewed.
101. Corrected report recipient behavior so revoked managers/custom recipients cannot keep receiving future private reports without current authority.
102. Added report recipient validation, deduplication, and privacy-safe defaults.
103. Added POS token one-time display, rotation, grace window, hashing, and dedicated idempotency/rate controls.
104. Kept native venue portal retry behavior consistent with web while preserving the selected portal after token refresh.

### Admin and operational workflows

105. Kept the static admin surface at `/admin.html` and exercised every tab.
106. Preserved admin allowlisting and production MFA requirements.
107. Added current-role checks so stale provider/user metadata cannot grant admin rights.
108. Prevented an admin from deleting themselves or the last effective admin.
109. Added session containment, account status, audit, deletion, mission, source, venue, partner, prize, and report operations to the usable UI.
110. Escaped previously unsafe suburb and cohort labels in generated admin HTML.
111. Replaced the broken PDF iframe preview with a secure open/download evidence card.
112. Served PDF evidence as an attachment with `nosniff` and no-store headers.
113. Kept images behind signed, short-lived, private evidence URLs.
114. Added bounded lazy evidence hydration rather than loading every private preview at once.
115. Added complete ingestion queue pagination and source review states.
116. Preserved beer-catalogue approve, merge, reject, and bulk-junk workflows.
117. Added actionable trust/support queue assignment, status, notes, and audit history.
118. Added admin reward-voucher claim details, copy action, expiry/status, fulfil, and void controls.
119. Required an audited reason for reward fulfil/void transitions.
120. Made reward transitions idempotent and conflict-aware.
121. Fixed admin report-operation copy to use `generatedCount`, `deliveredCount`, `mockedCount`, `rejectedCount`, `uncertainCount`, `inProgressCount`, and skipped counts from the real backend contract.
122. Made partial report failures and uncertain/in-progress sends visibly non-successful.
123. Added report-delivery compare-and-set leases so concurrent workers cannot duplicate sends.
124. Added durable job states for report delivery, backups, restore rehearsal, evidence retention, OCR, Stripe webhook handling, and mission refresh.
125. Added operational readiness checks for live dependencies rather than configuration presence alone.
126. Added cached/in-flight readiness probes to avoid readiness storms.
127. Added graceful server shutdown and service cleanup.
128. Added production health workflow coverage and deployment metadata.

### Stripe, subscription, and deletion integrity

129. Bound checkout sessions to the authenticated account/venue and persisted the intended paid target.
130. Reused Stripe customers and blocked repeated checkout creation for an already paid/active target.
131. Added checkout idempotency to prevent rapid duplicate clicks creating orphan subscriptions.
132. Reconciled checkout against the current Stripe subscription rather than trusting session metadata alone.
133. Required a present, known, grant-eligible subscription authority status; missing/unknown 2xx responses fail closed.
134. Handled delayed/async payment success and failure states accurately.
135. Handled paused, incomplete, unpaid, past-due, cancelled, and unknown subscription states without granting access.
136. Accepted multiple valid `v1` webhook signatures while preserving timing-safe verification.
137. Made webhook event ordering monotonic.
138. Resolved same-second cancellation/checkout ordering without allowing a checkout replay to overwrite cancellation.
139. Prevented old completed/paid checkout replay from regranting a later-cancelled subscription.
140. Applied the same authority rules to consumer and venue subscriptions.
141. Preserved billing portal access for downgraded/past-due accounts with linked customers.
142. Added billing-only recovery for suspended consumers and venue managers without reopening app access.
143. Blocked every billing mutation once destructive account deletion is active.
144. Added deletion locks and Stripe tombstones so delayed webhooks/checkouts cannot resurrect deleted accounts.
145. Cancelled/downgraded external billing through a retryable deletion saga before anonymisation.
146. Persisted side-effect markers so failed external cancellation can resume safely.
147. Redacted Stripe payloads before clearing customer identifiers so deletion cannot strand identifying payload rows.
148. Scrubbed deleted account IDs from cross-actor audit/event JSON metadata, not only actor/target columns.
149. Prevented the deletion-completed audit row from writing the raw deleted account ID back after cleanup.
150. Added reconciliation for delayed deletion/billing races.

### Security, privacy, request containment, and storage

151. Added a pre-parser 16 MiB upload envelope limit.
152. Rejected malformed/oversized unauthenticated upload requests before service initialization and JSON parsing.
153. Added route-specific/IP-specific limits for auth, writes, exports, evidence, OCR, counters, POS, and billing.
154. Replaced non-atomic distributed rate-limit sequences with one Redis Lua operation.
155. Kept rate-limit identity privacy-safe and resistant to attacker-controlled path/header identity expansion.
156. Added CORS allowance only for the dedicated recent-auth headers.
157. Preserved trusted-origin/CSRF enforcement on mutating browser requests.
158. Kept session cookies HttpOnly, Secure in production, SameSite, revocable, and server-authoritative.
159. Added provider-session blocklists and issued-at invalidation after security resets.
160. Added full-account suspension containment across sessions, passes, rewards, and protected access.
161. Closed mapped/private IPv4 and IPv6 SSRF forms, redirects, DNS rebinding, and unsafe image sources.
162. Added bounded fetch timeouts and pinned-address validation for remote evidence.
163. Kept source-evidence bucket service-only/private with explicit MIME and size policy.
164. Added PDF support while preventing active PDF content from being embedded in the application origin.
165. Added evidence-retention backlog draining with a hard per-run bound and recurring lease.
166. Added visibility for overdue evidence-retention work.
167. Added exact upload-location retention/purge behavior and export disclosure, plus a 24-hour device-local offline-evidence limit, automatic expiry purge, and deletion-request cleanup.
168. Added an account-data retention policy covering each retained class and deletion exception.
169. Removed identifying data from reports, system-state payloads, recipients, events, and audit metadata during erasure.
170. Kept logs and error envelopes redacted and prevented production stack/detail disclosure.
171. Added allowlisted production-safe recovery metadata rather than exposing arbitrary internal error details.
172. Ran the committed-secret/dependency scans with ignored browser config included in the audit scope.

### Database, query performance, migrations, backup, and restore

173. Made schema upgrades versioned and transactional.
174. Added pre-migration backups, rollback behavior, duplicate quarantine, and stale-backup cleanup.
175. Added migration tests for upgrade, rollback, malformed duplicates, and current schema idempotency.
176. Added missing foreign-key indexes on high-use relationship columns.
177. Replaced public price materialization/N+1 behavior with bounded keyset/SQL reads.
178. Added refill behavior so post-filter pages remain complete.
179. Added dense-fixture tests beyond the original small sample size.
180. Kept public venue, mission, leaderboard, account, admin, and catalogue queries bounded/paginated.
181. Removed GET-time mission regeneration/write churn.
182. Added leased background mission refresh with durable status.
183. Added independent source and destination Supabase clients for off-site backup.
184. Refused an off-site target that is the same project or a public bucket.
185. Added a versioned manifest with database/evidence checksums, byte counts, MIME types, and orphan reconciliation.
186. Enumerated and downloaded private Supabase evidence instead of backing up SQLite alone.
187. Added filesystem evidence stability and checksum checks.
188. Added immutable append-only account-deletion tombstones and a current deletion ledger, with canonical path/body verification and checkpoint reconciliation against stale aggregate, tampering, and rollback.
189. Wired the deletion path to append and durably verify the off-site tombstone at deletion time rather than waiting for the next backup; completion fails closed if verification does not succeed.
190. Required restore to reconcile an independently supplied trusted deletion ledger, genesis hash, and checkpoint hash; hashes copied from `latest.json` remain observations rather than restore authority.
191. Added authenticated zero-deletion genesis/checkpoint support so a fresh install can restore safely.
192. Added stale, tampered, missing, unauthenticated-empty, and rollback ledger negative tests.
193. Removed the legacy 100 MiB backup-destination bucket/object cap and switched restore to streamed/file-backed verification.
194. Added private PDF evidence to backup/restore validation.
195. Added destination migration/readiness probes and last-success freshness checks.
196. Made production readiness fail when the independent backup destination is missing, public, inaccessible, or stale.
197. Added production backup/restore runbook and evidence hooks without pretending a local rehearsal is a live provider drill.

### iOS and Android

198. Preserved the existing native apps and extended them instead of creating duplicates.
199. Added Supabase email/OAuth PKCE auth flows matching the server contract.
200. Added secure token persistence (Keychain/encrypted Android storage) and removed plain preference token storage.
201. Added first-install Keychain cleanup to avoid inheriting a deleted app’s old session.
202. Added Android backup/data-extraction exclusions for auth and sensitive local state.
203. Cleared analytics consent/account-scoped caches on logout and account change.
204. Made server role/access authority override stale local role data.
205. Added automatic 401 refresh/retry without losing the current portal/task.
206. Preserved non-JSON HTTP status, especially 401, so refresh logic can run.
207. Added all-page pagination for venues, prices, missions, submissions, sessions, and account totals; native price traversal accepts empty advancing pages, rejects repeated cursors, caps traversal at 1,000 pages, and deduplicates semantic rows across pages.
208. Corrected Android’s total-submission count.
209. Added bounded, cancellable, off-main-thread photo processing.
210. Enforced per-file and aggregate upload limits before transmission.
211. Added sensitive-action recent-auth headers to native sessions, export, deletion, and logout-all; native clients send a provider step-up token only, never a password header, and do not show false success after reauthentication failure.
212. Added production-safe reauthentication guidance.
213. Added suspended personal/venue billing recovery and multi-venue selection without minting an app session; non-billable/`eligible:false` responses suppress dead actions and the recovery provider token stays memory-only.
214. Added explicit all-device signout.
215. Added current role, error-envelope, upload, recovery, pagination, and no-session-grant regression coverage.
216. Added iOS privacy declarations and project wiring.
217. Added Android manifest/network/security and backup policy hardening.

### UI, design, accessibility, and user friendliness

218. Exercised public, account, manager, counter, and admin surfaces at desktop and phone widths.
219. Removed horizontal overflow found in the reviewed surfaces.
220. Raised Pint Path-owned phone controls to at least 44 px.
221. Corrected compact account settings navigation and mobile scroll behavior.
222. Kept operational primary actions ahead of secondary explanation where practical.
223. Reduced false warning/error states and replaced them with actionable status copy.
224. Added labels, semantic input modes, autocomplete, dialog titles/descriptions, live regions, and focus handling where missing.
225. Preserved keyboard tab semantics for account/admin section navigation.
226. Added Escape/cancel/focus-return behavior to modal workflows.
227. Removed native browser prompt/alert workflows from Pint Path pages.
228. Kept destructive actions explicitly confirmed and audited.
229. Added empty, loading, success, warning, error, conflict, and retry states to high-risk workflows.
230. Added copy/select affordances for identifiers users/admins actually need.
231. Checked all 20 HTML pages for duplicate static IDs, broken local references, missing image alt text, and untyped buttons.
232. Parsed every inline script and the shared business script after remediation.
233. Kept color-backed states paired with written labels.
234. Preserved reduced-motion and visible-focus support.
235. Kept the product’s alcohol/RSA language from implying safety, sobriety, or required consumption.

### Final adversarial closure pass

236. Replaced the abandoned daily-reveal concept with one consistent fixed-preview contract across public configuration, price responses, telemetry, reports, web copy, and native clients.
237. Removed active `reveal`, `revealed`, `blocked`, and `canRevealPrice` request/response behavior; the historical `price_view_revealed` event remains aggregation-only compatibility for old records.
238. Renamed current venue analytics and monthly-report presentation to `pricePreviewViews` and “Free-preview views,” including privacy-suppression keys.
239. Loaded venue and price bootstrap data concurrently and bounded remote venue pagination without repeatedly fetching an ever-growing prefix.
240. Corrected overnight opening-hours evaluation so after-midnight periods are attributed to the prior trading day where appropriate.
241. Kept every public map filter’s `aria-pressed` state synchronized at first render and after interaction.
242. Added public venue descriptions, validated phone/site/Instagram links, opening-hours details, and current open/closed status to map and list views.
243. Serialized account night-plan synchronization so an older response cannot overwrite a newer local plan and local-only fallback is stated truthfully.
244. Added request generations and query/account/offset checks to public search, venue claim, submission history, sessions, geocoding, admin search/detail, deletion, security, missions, catalogue, partner, leaderboard, venue, status, and data-tool loaders.
245. Ensured only the newest admin panel generation may clear busy state or replace content after navigation.
246. Added self-service MFA replacement and removal with fresh verification, lost-authenticator recovery copy, safe cancellation, and preservation of the old factor until its replacement verifies.
247. Preserved validated manager deep links through password, policy, and OAuth completion while keeping short-lived redemption codes in session storage rather than URLs.
248. Scrubbed auth/redemption codes from destination URLs and cleared sensitive return state when a user cancels.
249. Closed the cookie-preference navigation loop by saving an essential-only provisional choice before opening account controls.
250. Removed HEIC/HEIF from browser upload promises because the browser canvas pipeline cannot reliably decode them, while retaining supported native handling and explicit JPEG-conversion guidance.
251. Enforced aggregate post-compression image, evidence, and encoded-request limits on the client before the server’s 16 MiB envelope.
252. Sent venue-support contact email as a structured field rather than duplicating it into free text, and made support/local notices live-region aware.
253. Added authoritative active counter-staff assignments to account, login, and session-refresh responses, sanitized them for local context, and exposed only scoped counter-dashboard links/capabilities.
254. Added structured Google Place IDs to missing-venue requests, idempotent duplicate responses, and automatic request resolution when a matching venue is submitted.
255. Added a privacy-safe, paginated contributor verification queue with confirm, dispute, and needs-more-evidence actions; negative checks require a useful note.
256. Excluded self-owned and already-verified candidates plus contributor identity, email, notes, coordinates, evidence URLs/bytes, pending-venue details, and reviewer fields from that queue.
257. Enforced current legal acceptance, verified email, active account status, and 18+ confirmation before community verification writes.
258. Added optimistic concurrency tokens and admin-assignee validation to trust/support updates so stale tabs cannot silently overwrite newer work.
259. Added atomic ingestion claims, bulk rejection, stale-lease recovery, hard page/work bounds, and full-row replacement so review workers cannot double-process or leave stale child rows.
260. Projected only evidence metadata in ingestion lists and hydrated private evidence lazily through signed, bounded endpoints.
261. Made manual capture persist the authoritative submission before its post-commit snapshot and kept client submission IDs idempotent across retries.
262. Added filesystem-evidence and submission-evidence saga compensation so failed database writes do not orphan private bytes and failed storage writes do not create broken records.
263. Made mission creation from user requests atomic and idempotent, including request completion only after the mission is durable.
264. Required fresh, sufficiently accurate contributor geolocation where a location-backed contribution claims eligibility.
265. Added optional-column/table guards so partially upgraded databases fail predictably instead of crashing on optional feature reads.
266. Moved independent-backup-project Supabase DDL out of the production migration chain and left the old tracked migration as an intentional no-op tombstone.
267. Added a regression that forbids the independent `pintpath-backups` bucket from appearing in primary production migrations.
268. Removed dead daily-reveal environment/configuration fields and rewrote the related deployment, readiness, and field-test documentation around fixed preview.
269. Reused validated Supabase provider sessions instead of creating redundant app sessions during account synchronization.
270. Made privacy-report scopes server-owned and enforced a minimum distinct-actor floor resistant to one actor creating many anonymous sessions.
271. Calculated monthly boundaries in the product’s Melbourne timezone rather than UTC.
272. Standardized uncertain moderation outcomes as neutral `needs_more_evidence` and kept fraud classification canonical rather than presentation-dependent.
273. Scrubbed deleted-user identifiers from both JSON keys and values in retained audit/event metadata.
274. Reduced the mission feed to two bounded queries and removed query-per-row behavior.
275. Converted provider readiness from environment-presence checks to cached live probes with production fail-closed outcomes.
276. Corrected the privacy page to disclose that self-service account exports include the exact location fields stored with a user’s uploads.
277. Made returning native email/OAuth users accept updated, versioned policies only after provider identity verification; signup consent remains explicit and signup-only.
278. Added native confirm-password validation and sensitive-field clearing after auth completion/failure.
279. Made Android Discover list-first and truthful when a native map is unavailable, with a real Open in Maps fallback and IME/search affordances.
280. Corrected native keyboard types, autocorrect behavior for sensitive fields, and duplicate TalkBack/VoiceOver navigation announcements.
281. Disabled native mutation controls while requests are in flight and removed duplicate write paths, including duplicate happy-day submissions.
282. Added Android EXIF-orientation-aware image decoding with a real orientation-6 fixture and bounded off-main-thread processing.
283. Added exact native `priceAccessModel`/`freePreviewScope` decoding and removed active legacy reveal consumers.
284. Updated the backup, restore, provider-readiness, release, field-test, mobile, role, performance, and production runbooks to match the implemented contracts rather than old TODOs.
285. Converted the 404 page to an external CSP-compatible script and removed stale consent, logout, and pending-receipt presentation paths uncovered in the final page sweep.
286. Removed the unused browser-facing Stripe publishable-key contract from environment examples, readiness checks, workflows, tests, and release documentation so operators are not asked to expose a key the application never consumes.
287. Added a single account UI identity epoch that invalidates all account-bound requests, clears sensitive session/MFA/reward/pass/deletion state, and prevents an older user response from rendering after logout or an account switch on a shared device.
288. Bound email auth, returning-policy acceptance, suspended-account billing recovery, and post-recovery redirects to the current auth/account epoch so stale completion paths cannot reopen or mutate a newer identity state.
289. Reset Pub Golf, Can I Drive, preferences, support, and action-loading transients on identity change, and added a Pub Golf render epoch so delayed geocoding, routing, and map callbacks cannot leak an earlier account's plan.
290. Applied the bounded lookup limiter to the privacy-safe community verification feed in addition to the existing authenticated write controls.
291. Reconciled production deployment, provider, auth, billing, native-map, QA, field-test, follow-up, readiness, and security documentation with the final code: mandatory providers are explicit, normal production cannot silently disable billing, and already-shipped capabilities are no longer listed as missing.
292. Completed a focused post-patch adversarial review of account declaration order, billing recovery, sessions, MFA, sensitive responses, private transient forms, async map callbacks, accessibility, and public hardening with no remaining actionable source defect found.
293. Replaced the last secret-like deployment example with an unmistakable placeholder so the repository security scan cannot normalize a credential-shaped documentation value.
294. Added a strict UUID boundary before local venue IDs enter Supabase UUID filters; text-keyed local venues no longer cause public directory, search, pagination-boundary, or merge requests to fail with a provider 502.
295. Kept text-keyed local venue detail pages local and made malformed/nonexistent text IDs return 404 instead of sending invalid UUID equality queries to Supabase.
296. Prevented account Security from starting a password-gated session inventory on render, made Refresh the explicit step-up action, and replaced raw hosted-auth session errors with provider-aware password/sign-in guidance.
297. Moved the single current-device Log out control and signed-in identity summary outside individual settings panels so logout remains immediately reachable from Stats, Submissions, Saved, Preferences, Privacy, Support, Security, and Beta tools on desktop and phone.
298. Re-swept public, authenticated, invalid-input, protected, evidence, local/remote venue, pagination-boundary, HTML, alias, and local-asset routes against a disposable database; every response matched its intended 2xx/3xx/4xx class and no unexpected 5xx remained.
299. Closed the compiler gaps exposed by the authoritative native CI runner: the main-actor Core Location helper uses a Swift 6-compatible pre-concurrency delegate conformance, authenticated operation results are Sendable, OAuth continuation types and Supabase returns are explicit, pagination fallback precedence is unambiguous, the shared trimmed-string helper is module-visible, Android imports `Locale`, invalid labelled Kotlin throws were removed, and static guardrails cover each boundary.
300. Migrated every pinned GitHub JavaScript action from Node 20 to an immutable Node 24 release, disabled persisted checkout credentials, added weekly action-update tracking and pin regression coverage, expanded the 12 external sign-offs into an executable evidence checklist, hardened evidence validation against schema/gate/timestamp drift, and added a verified isolated-Supabase evidence restore helper for real backup rehearsals.

## Final verification

- TypeScript build: **passed**
- Full Vitest suite: **46 files, 575 tests passed**
- Security scan: **passed across 334 tracked/untracked files**
- Dependency audit: **0 known vulnerabilities**
- Diff whitespace check: **clean**
- Inline browser scripts: **all parsed**
- Final account/public/accessibility focused suite: **64/64 passed**
- Rendered browser smoke: **public desktop, public 390 x 844, signed-in Security, explicit reauthentication, persistent logout, and shared-device logout passed without horizontal overflow, stale private UI, or an unexpected 5xx**
- Local API route sweep: **all checked public/authenticated routes and all 20 HTML pages returned their expected status classes; 36 referenced local routes/assets resolved**
- Provider-readiness diagnostics in development: **18 passed, 14 external-configuration warnings, 0 blocking warnings, 0 failures**
- Release-evidence schema at this dated checkpoint: **valid; 0/12 then-defined external evidence gates complete; strict mode correctly exited non-zero**. The current schema-v4 register supersedes this historical count with 13 required gates, including `permanent_staging_cost`.
- Native static regression suite: **28/28 passed**
- Swift parser: **passed**
- iOS plist/privacy manifest lint: **passed**
- Android Gradle build: **debug/release lint, tests, and assembly passed in GitHub Native Apps; it remains unavailable on this host because no Java runtime is installed**

## External evidence still required

These are not unresolved code defects. They are evidence gates that require authority or systems outside this checkout:

1. Deploy the final code and migrations to the intended staging/production environment.
2. Configure and live-probe Supabase Auth, RLS, database, private source-evidence storage, and the independent off-site backup project/bucket.
3. Verify Google and Apple OAuth provider consoles, callback URLs, email confirmation, and leaked-password protection.
4. Verify Google Maps key restrictions and a production vector Map ID.
5. Run Stripe test/live-mode webhook, checkout, cancellation, failed-payment, replay, portal, suspended recovery, and deletion-race smokes with real provider events.
6. Configure Resend sender/domain/reply-to and run one targeted manager-only delivery.
7. Configure production Redis and verify distributed limiting/fail-closed readiness.
8. Run and date a production off-site backup restore rehearsal with the independently supplied deletion ledger.
9. Complete three real venue-shift pilots with manager and counter-staff roles.
10. Verify the selected POS adapter or the documented manual fallback in a real venue.
11. Build an owner-labelled unseen OCR corpus and record measured accuracy by source type.
12. Complete manual keyboard, VoiceOver, TalkBack, large-text, iPhone Safari camera/permission, and Android Chrome camera/permission checks.
13. Obtain legal/accounting owner approval for entity/contact details, privacy, Terms, alcohol/RSA language, billing, GST/invoices, refunds, renewals, and cancellation.
14. Complete Apple signing, TestFlight, App Store privacy/screenshots, and device review.
15. Complete Android signing, Play internal test, Data Safety, screenshots, and device review.
16. Fill all 13 entries in the current `docs/release-evidence.json`; the strict release gate must remain blocked until every gate is bound to the frozen candidate and contains the private-manifest reference and SHA-256, named verifier/role, and current timestamp. The 12-item inventory recorded earlier in this dated remediation log is historical.

## Release position

The repository is a release-candidate implementation after the final automated gate. Broad production launch must still wait for the external evidence above. That boundary is deliberate: repository tests can prove code paths and invariants, but they cannot self-approve provider configuration, legal decisions, physical devices, or a real bar shift.
