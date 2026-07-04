import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function submitHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/submit.html"), "utf8");
}

function businessCss() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/business.css"), "utf8");
}

function faqHtml() {
  return fs.readFileSync(path.resolve(process.cwd(), "viewer/trust.html"), "utf8");
}

describe("submit page auth gate", () => {
  it("requires login before showing the submission form", () => {
    const html = submitHtml();

    expect(html).toContain('id="loginRequiredPanel"');
    expect(html).toContain('id="submissionPanel" class="panel submitPanel is-hidden"');
    expect(html).toContain("Sign in before submitting data");
    expect(html).toContain("uploads accountable");
    expect(html).toContain('<div id="status" class="notice submitReviewNotice" hidden></div>');
    expect(html).not.toContain("Ready to submit.");
    expect(html).not.toContain("Reviewed before publication");
    expect(html).not.toContain("Offline uploads save locally");
    expect(html).toContain("const accountResult = await MelbBeerBusiness.apiFetch(\"/api/business/account\")");
    expect(html).toContain("Venue accounts use the venue dashboard instead of reward submissions.");
    expect(html).toContain('window.location.assign("/venue-portal.html")');
    expect(html).toContain("window.location.assign(loginUrl)");
  });

  it("does not expose the submission form to anonymous users by default", () => {
    const html = submitHtml();

    expect(html).toContain("loginRequiredPanel.classList.remove(\"is-hidden\")");
    expect(html).toContain("submissionPanel.classList.add(\"is-hidden\")");
    expect(html).toContain("Log in before submitting venue data.");
  });

  it("uses search-driven venue selection with a read-only chosen venue field", () => {
    const html = submitHtml();

    expect(html).toContain("Chosen venue");
    expect(html).toContain("Choose venue");
    expect(html).toContain('class="submitStep" aria-labelledby="submitVenueStepTitle"');
    expect(html).toContain('id="venueSelect" class="readonlySelect" required disabled');
    expect(html).toContain('id="venueSuggestionList" class="venueSuggestionList" role="listbox"');
    expect(html).toContain("Type 2 or more characters, then tap a venue.");
    expect(html).toContain("Search above and tap the matching venue.");
    expect(html).toContain("function clearSelectedVenue");
    expect(html).toContain("VENUE_SEARCH_DEBOUNCE_MS");
    expect(html).toContain("venueSearchCache");
    expect(html).toContain("venueSearchRequestId");
    expect(html).toContain('venueSuggestionList.addEventListener("click"');
    expect(html).toContain("Search and choose a venue first, or tick that the venue is not on Pint Path yet.");
    expect(html).not.toContain("Recent venues");
    expect(html).not.toContain("recentVenuePanel");
    expect(html).not.toContain("recentVenueButton");
    expect(html).not.toContain("readRecentVenues");
    expect(html).not.toContain("renderRecentVenues");
    expect(html).not.toContain("rememberRecentVenue");
    expect(html).not.toContain('venueSelect.addEventListener("change"');
    expect(html).not.toContain('list="venueSuggestions"');
  });

  it("keeps beer suggestions separate from browser form history", () => {
    const html = submitHtml();

    expect(html).toContain('<input data-field="beerName" list="trackedBeerSuggestions" placeholder="Start typing Guinness, Carlton Draught..." autocomplete="off" autocapitalize="words" spellcheck="false" />');
  });

  it("lets contributors request a missing venue with beer data from a Google-verified venue", () => {
    const html = submitHtml();

    expect(html).toContain('id="newVenueToggle"');
    expect(html).toContain("This venue is not on Pint Path yet");
    expect(html).toContain('id="newVenuePanel"');
    expect(html).toContain('id="newVenueGoogleSearch"');
    expect(html).toContain('id="newVenueGoogleButton"');
    expect(html).toContain('id="newVenueGoogleResults" class="adminGoogleVenueResults" aria-live="polite" hidden');
    expect(html).toContain('id="newVenueManualDetails"');
    expect(html).toContain("<summary>Review selected details</summary>");
    expect(html).toContain("Search Google Maps and choose the matching bar, pub, restaurant, or nightlife venue.");
    expect(html).toContain('id="newVenueName" type="text" maxlength="180" placeholder="Example: Moonlit Taproom" readonly');
    expect(html).toContain('id="newVenueAddress" type="text" placeholder="Street address from Google Maps" readonly');
    expect(html).toContain('id="newVenueSuburb" type="hidden"');
    expect(html).toContain('id="newVenuePhone" type="hidden"');
    expect(html).toContain('id="newVenueWebsite" type="hidden"');
    expect(html).toContain('id="newVenueLatitude" type="hidden"');
    expect(html).toContain('id="newVenueLongitude" type="hidden"');
    expect(html).toContain('id="newVenueSubmitShortcut"');
    expect(html).toContain("function collectNewVenue()");
    expect(html).toContain("function createPendingVenueId()");
    expect(html).toContain("function searchNewVenueGooglePlaces()");
    expect(html).toContain("function loadNewVenueGoogleDetails");
    expect(html).toContain("newVenueGoogleResults.hidden = true;");
    expect(html).toContain("newVenueGoogleResults.hidden = false;");
    expect(html).toContain('submissionTypeSelect.value = "single_beer_price";');
    expect(html).toContain("/api/business/venue-places/search");
    expect(html).toContain("/api/business/venue-places/");
    expect(html).toContain("googlePlaceId: selectedNewVenueGooglePlace?.googlePlaceId || null");
    expect(html).toContain("Choose the new venue from Google Maps before submitting");
    expect(html).toContain("newVenue,");
    expect(html).not.toContain("Review/edit selected details");
    expect(html).not.toContain('id="newVenueSuburb" type="text"');
    expect(html).not.toContain('id="newVenuePhone" type="tel"');
    expect(html).not.toContain('id="newVenueLatitude" type="number"');
    expect(html).not.toContain("Use saved location as venue coordinates");
    expect(html).not.toContain("Find coordinates from address");
    expect(html).not.toContain("Use manual fallback for now");
    expect(html).toContain("Request it once, then add the beer data you saw.");
  });

  it("keeps submit-time, notes, and evidence fields constrained by submission type", () => {
    const html = submitHtml();

    expect(html).not.toContain("Observed date/time");
    expect(html).not.toContain('name="observedAt"');
    expect(html).not.toContain('name="notes" placeholder="Optional notes, conditions, or source details"');
    expect(html).toContain('id="sourcePhotoField" class="field is-hidden"');
    expect(html).toContain('id="sourcePhoto" type="file" accept="image/*" multiple disabled');
    expect(html).toContain('id="sourcePhotoList" class="sourcePhotoList" aria-live="polite" hidden');
    expect(html).toContain("let selectedSourcePhotoFiles = [];");
    expect(html).toContain("sourcePhotoField.classList.toggle(\"is-hidden\", !isPhotoOnly)");
    expect(html).toContain("sourcePhoto.disabled = !isPhotoOnly");
    expect(html).toContain("sourcePhoto.required = isPhotoOnly && selectedSourcePhotoFiles.length === 0");
    expect(html).toContain("const observedAt = new Date().toISOString();");
    expect(html).toContain('submissionTypeSelect.value === "photo_upload"');
    expect(html).toContain("const notes = missionNote || null;");
    expect(html).toContain("A multiple beer submission needs at least 3 beer rows.");
    expect(html).not.toContain("A full venue update needs either a source photo");
    expect(html).not.toContain("Happy-hour updates need a source photo");
  });

  it("keeps happy-hour day controls inside a responsive grid", () => {
    const css = businessCss();

    expect(css).toContain(".dayChecklist");
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(106px, 1fr))");
    expect(css).toContain("min-height: 42px");
    expect(css).toContain(".dayChip");
    expect(css).toContain(".readonlySelect:disabled");
  });

  it("carries accepted mission context into submission payloads", () => {
    const html = submitHtml();
    const css = businessCss();

    expect(html).toContain('id="missionContext"');
    expect(html).toContain("const missionId = params.get(\"missionId\") || \"\"");
    expect(html).toContain("const missionReason = params.get(\"missionReason\") || \"\"");
    expect(html).toContain("const initialSubmissionType = params.get(\"type\")");
    expect(html).toContain("submissionTypeSelect.value = initialSubmissionType");
    expect(html).toContain("Mission accepted");
    expect(html).toContain("Your upload should match this mission");
    expect(html).toContain("Mission ${missionId}: ${missionReason || \"Pint Path mission\"}");
    expect(html).toContain("missionId: missionId || null");
    expect(css).toContain(".missionContext");
  });

  it("allows field-test submissions without private upload-location proof", () => {
    const html = submitHtml();

    expect(html).not.toContain("Points need location proof");
    expect(html).not.toContain("Use my location for points");
    expect(html).not.toContain('id="captureLocationButton"');
    expect(html).toContain("function captureUploadLocation()");
    expect(html).toContain("async function ensureUploadLocationForSubmit()");
    expect(html).toContain("await ensureUploadLocationForSubmit()");
    expect(html).toContain("Location proof is optional for now");
    expect(html).toContain("Submitting without location proof is allowed for field testing");
    expect(html).toContain("uploadLocation,");
    expect(html).toContain("getCurrentPosition");
    expect(html).toContain("UPLOAD_LOCATION_STORAGE_KEY");
    expect(html).toContain("restoreUploadLocation()");
    expect(html).toContain("localStorage.setItem");
    expect(html).toContain("localStorage.removeItem");
    expect(html).not.toContain("window.addEventListener(\"DOMContentLoaded\", captureUploadLocation");
  });

  it("keeps silent draft autosave and offline queued submissions without visible field-test status", () => {
    const html = submitHtml();
    const css = businessCss();

    expect(html).not.toContain('class="fieldTestConsole"');
    expect(html).not.toContain('id="networkStatusPill"');
    expect(html).not.toContain('id="locationStatusPill"');
    expect(html).toContain('const networkStatusPill = document.getElementById("networkStatusPill")');
    expect(html).toContain('const locationStatusPill = document.getElementById("locationStatusPill")');
    expect(html).toContain("if (!element) {");
    expect(html).toContain('id="submissionQueuePanel"');
    expect(html).toContain('id="submissionQueueList"');
    expect(html).toContain('id="retryQueuedSubmissionsButton"');
    expect(html).toContain('id="clearQueuedSubmissionsButton"');
    expect(html).not.toContain('id="draftStatusPill"');
    expect(html).not.toContain('id="saveDraftButton"');
    expect(html).not.toContain('id="restoreDraftButton"');
    expect(html).not.toContain('id="clearDraftButton"');
    expect(html).toContain("FIELD_DRAFT_STORAGE_KEY");
    expect(html).toContain("function collectFieldDraft()");
    expect(html).toContain("localStorage.setItem(FIELD_DRAFT_STORAGE_KEY");
    expect(html).toContain('submissionForm.addEventListener("input", scheduleDraftAutosave)');
    expect(html).toContain('window.addEventListener("online", () => {');
    expect(html).toContain('window.addEventListener("offline", updateNetworkStatus)');
    expect(html).toContain("SUBMISSION_QUEUE_STORAGE_KEY");
    expect(html).toContain("SUBMISSION_QUEUE_DB_NAME");
    expect(html).toContain("SUBMISSION_QUEUE_STORE_NAME");
    expect(html).toContain("indexedDB.open(SUBMISSION_QUEUE_DB_NAME");
    expect(html).toContain("async function migrateLegacySubmissionQueueToDb");
    expect(html).toContain("async function queueSubmissionPayload");
    expect(html).toContain("payload.clientSubmissionId = clientSubmissionId");
    expect(html).toContain("await queueSubmissionPayload(submissionPayload)");
    expect(html).toContain("function renderSubmissionQueue");
    expect(html).toContain("async function removeQueuedSubmission");
    expect(html).toContain("async function clearSubmissionQueue");
    expect(html).toContain("async function requestPersistentSubmissionStorage");
    expect(html).toContain("navigator.storage?.persist");
    expect(html).toContain('window.addEventListener("beforeunload"');
    expect(html).toContain("async function flushQueuedSubmissions");
    expect(html).toContain("Sending queued submission ${sent + 1} of ${sent + queue.length}");
    expect(html).toContain("No reception. Submission saved locally and will send when this device is online.");
    expect(html).not.toContain("QUICK_BEERS");
    expect(html).not.toContain('id="quickBeerButtons"');
    expect(html).not.toContain("function fillQuickBeer");
    expect(html).toContain("labels.add(beer.name)");
    expect(html).not.toContain("(beer.aliases || []).forEach((alias) => labels.add(alias))");
    expect(html).toContain('const statusEl = document.getElementById("status")');
    expect(html).toContain("MelbBeerBusiness.setStatus(statusEl");
    expect(html).toContain("attached. Pint Path compresses");
    expect(html).toContain('sourcePhoto.addEventListener("change"');
    expect(html).toContain('sourcePhotoList.addEventListener("click"');
    expect(html).toContain("data-remove-source-photo-index");
    expect(css).not.toContain(".fieldTestConsole");
    expect(css).not.toContain(".recentVenuePanel");
    expect(css).not.toContain(".recentVenueButton");
    expect(css).toContain(".queuedSubmissionsPanel");
    expect(css).toContain(".queuedSubmissionItem.is-sending");
    expect(css).toContain(".submitStep");
    expect(css).toContain(".submitActionDock");
    expect(css).toContain(".sourcePhotoList");
    expect(css).toContain(".sourcePhotoRemove");
    expect(css).not.toContain(".quickBeerChip");
  });

  it("compresses source photos through canvas so queued uploads do not preserve EXIF metadata", () => {
    const html = submitHtml();

    expect(html).toContain("SOURCE_PHOTO_MAX_EDGE");
    expect(html).toContain("SOURCE_PHOTO_MAX_FILES");
    expect(html).toContain("SOURCE_PHOTO_COMPOSITE_MAX_WIDTH");
    expect(html).toContain("SOURCE_PHOTO_OUTPUT_TYPE");
    expect(html).toContain("SOURCE_PHOTO_OUTPUT_QUALITY");
    expect(html).toContain("function loadImageFromFile");
    expect(html).toContain("function loadImageFromDataUrl");
    expect(html).toContain("function canvasToBlob");
    expect(html).toContain("function blobToDataUrl");
    expect(html).toContain("async function readPhotoDataUrl");
    expect(html).toContain("async function combinePhotoDataUrls");
    expect(html).toContain("async function readSourcePhotoSelectionDataUrl");
    expect(html).toContain('document.createElement("canvas")');
    expect(html).toContain("context.drawImage(image, 0, 0, width, height)");
    expect(html).toContain("context.drawImage(item.image, offsetX, offsetY, item.width, item.height)");
    expect(html).toContain("canvasToBlob(canvas, SOURCE_PHOTO_OUTPUT_TYPE, SOURCE_PHOTO_OUTPUT_QUALITY)");
    expect(html).toContain("await readPhotoDataUrl(file)");
    expect(html).toContain("await readSourcePhotoSelectionDataUrl(selectedSourcePhotoFiles)");
    expect(html).toContain("Attach a real photo or screenshot image");
    expect(html).toContain("clientSubmissionId: createQueuedSubmissionId()");
  });

  it("lets contributors attach and remove multiple OCR/source images before submitting", () => {
    const html = submitHtml();
    const css = businessCss();

    expect(html).toContain("function addSelectedSourcePhotos");
    expect(html).toContain("function clearSelectedSourcePhotos");
    expect(html).toContain("function renderSourcePhotoList");
    expect(html).toContain("selectedSourcePhotoFiles.splice(index, 1)");
    expect(html).toContain('aria-label="Remove ${escapeHtml(file.name || `source image ${index + 1}`)}"');
    expect(html).toContain("Remove one before adding another.");
    expect(html).toContain("selectedSourcePhotoFiles.length === 1 ? \"Preparing photo for review...\"");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) 34px");
    expect(css).toContain("border-radius: 50%");
  });

  it("keeps the submission type selector compact and ordered for field entry", () => {
    const html = submitHtml();

    expect(html).toContain('<option value="single_beer_price">Single beer price</option>');
    expect(html).toContain('<option value="happy_hour_update">Happy-hour</option>');
    expect(html).toContain('<option value="full_venue_update">Multiple beer submission</option>');
    expect(html).toContain('<option value="photo_upload">Photo/upload source</option>');
    expect(html.indexOf('value="single_beer_price"')).toBeLessThan(html.indexOf('value="happy_hour_update"'));
    expect(html.indexOf('value="happy_hour_update"')).toBeLessThan(html.indexOf('value="full_venue_update"'));
    expect(html.indexOf('value="full_venue_update"')).toBeLessThan(html.indexOf('value="photo_upload"'));
    expect(html).not.toContain('id="typeGuidance"');
  });

  it("keeps beer row entry linear without the duplicate happy-hour price toggle", () => {
    const html = submitHtml();
    const css = businessCss();

    expect(html).toContain('class="grid grid--two submitBeerRowGrid"');
    expect(html).toContain('<input data-field="isHappyHourPrice" type="checkbox" hidden />');
    expect(html).toContain('<input data-field="happyHourDetails" type="hidden" value="" />');
    expect(html).toContain('set("isHappyHourPrice", false);');
    expect(html).toContain('set("happyHourDetails", "");');
    expect(html).not.toContain("Happy-hour price</label>");
    expect(html).not.toContain('data-role="happyHourDetailsField"');
    expect(css).toContain(".submitBeerRowGrid");
    expect(css).toContain("row-gap: 16px");
    expect(css).toContain(".submitOptionGrid");
    expect(css).toContain("margin-top: 14px");
    expect(css).toContain(".submitOptionGrid + [data-remove]");
    expect(css).toContain(".adminGoogleVenueResults[hidden]");
    expect(css).toContain(".newVenueLockedField input[readonly]");
    expect(css).toContain(".submitNewVenueShortcut");
  });

  it("gives contributors beer-name match, typo, and new-catalogue feedback", () => {
    const html = submitHtml();
    const css = businessCss();

    expect(html).toContain("function findClosestTrackedBeer");
    expect(html).toContain("function updateBeerRowCatalogueUx");
    expect(html).toContain("Matched to ${escapeHtml(trackedBeer.name)}");
    expect(html).toContain("New beer will be saved for admin review and reused next time.");
    expect(html).toContain("Did you mean <button class=\"inlineSuggestionButton\"");
    expect(html).toContain("data-use-beer-suggestion");
    expect(html).toContain("Did you mean ${closestBeer.name}? Choose it or tick Add new beer.");
    expect(css).toContain(".inlineSuggestionButton");
  });

  it("explains submission location proof and offline queueing in the FAQ", () => {
    const html = faqHtml();

    expect(html).toContain("How do submits work?");
    expect(html).toContain("Google-selected new venues can appear on the map quickly");
    expect(html).toContain("beer prices stay pending until admin review or matching community confirmations");
    expect(html).toContain("saves the upload locally in your browser and retries when you are back online");
    expect(html).toContain("Why does Submit ask for location services?");
    expect(html).toContain("Location proof helps reviewers confirm that data was uploaded from the venue area.");
    expect(html).toContain("It is optional during field testing");
    expect(html).toContain("What happens if I lose reception while submitting?");
    expect(html).toContain("saves the finished submission in your browser’s local database and retries when the browser comes back online");
  });
});
