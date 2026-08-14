import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "parse5";

import { createApp, shutdownAppServices } from "../src/app.js";

const VIEWER_ROOT = path.resolve(process.cwd(), "viewer");
const FALLBACK_ACTION = "/form-submission-unavailable";

type HtmlNode = {
  readonly tagName?: string;
  readonly attrs?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly childNodes?: ReadonlyArray<HtmlNode>;
  readonly content?: HtmlNode;
  readonly value?: string;
};

type StaticForm = {
  readonly key: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly hasSubmitControl: boolean;
  readonly insideDialog: boolean;
};

const EXPECTED_STATIC_FORMS = [
  "account.html#accountPreferencesForm",
  "account.html#canIDriveForm",
  "account.html#dataRequestForm",
  "account.html#displayNameForm",
  "account.html#loginForm",
  "account.html#privacySettingsForm",
  "account.html#pubGolfForm",
  "account.html#returningLegalAcceptanceForm",
  "account.html#signupForm",
  "admin.html#(missing-id)",
  "admin.html#adminAccountContainmentForm",
  "admin.html#adminCreateVenueForm",
  "admin.html#adminReportOpsForm",
  "admin.html#adminSourceQueueForm",
  "admin.html#leaderboardPrizeForm",
  "admin.html#managerAssignForm",
  "admin.html#outreachForm",
  "admin.html#securityAuditFilterForm",
  "auth/callback.html#callbackAcceptanceForm",
  "feedback.html#feedbackForm",
  "index.html#wrongPriceForm",
  "resend-confirmation.html#resendConfirmationForm",
  "reset-password.html#requestResetForm",
  "reset-password.html#updatePasswordForm",
  "submit.html#submissionForm",
  "venue-portal.html#beerForm",
  "venue-portal.html#counterStaffForm",
  "venue-portal.html#discountRedemptionForm",
  "venue-portal.html#freePintRewardForm",
  "venue-portal.html#happyHourForm",
  "venue-portal.html#memberPurchaseForm",
  "venue-portal.html#profileForm",
  "venue-portal.html#reportDeliveryForm",
  "venue-portal.html#specialForm",
  "venue-portal.html#venueClaimForm",
  "venue-portal.html#venueSupportForm",
  "venue-portal.html#voidPintPointForm",
] as const;

const DIALOG_FORMS = new Set<string>([
  "admin.html#(missing-id)",
  "index.html#wrongPriceForm",
  "venue-portal.html#voidPintPointForm",
]);

const SUPPORTED_POST_FORMS = new Map<string, string>([
  ["feedback.html#feedbackForm", "/api/business/feedback"],
]);

const SUBMIT_HANDLER_EVIDENCE: Readonly<Record<string, string>> = {
  "account.html#accountPreferencesForm": '$("accountPreferencesForm").addEventListener("submit"',
  "account.html#canIDriveForm": '$("canIDriveForm").addEventListener("submit"',
  "account.html#dataRequestForm": '$("dataRequestForm").addEventListener("submit"',
  "account.html#displayNameForm": '$("displayNameForm").addEventListener("submit"',
  "account.html#loginForm": '$("loginForm").addEventListener("submit"',
  "account.html#privacySettingsForm": '$("privacySettingsForm").addEventListener("submit"',
  "account.html#pubGolfForm": '$("pubGolfForm").addEventListener("submit"',
  "account.html#returningLegalAcceptanceForm": '$("returningLegalAcceptanceForm").addEventListener("submit"',
  "account.html#signupForm": '$("signupForm").addEventListener("submit"',
  "admin.html#adminAccountContainmentForm": 'document.getElementById("adminAccountContainmentForm")?.addEventListener("submit"',
  "admin.html#adminCreateVenueForm": 'adminCreateVenueForm.addEventListener("submit"',
  "admin.html#adminReportOpsForm": 'document.getElementById("adminReportOpsForm")?.addEventListener("submit"',
  "admin.html#adminSourceQueueForm": 'adminSourceQueueForm.addEventListener("submit"',
  "admin.html#leaderboardPrizeForm": 'leaderboardPrizeForm.addEventListener("submit"',
  "admin.html#managerAssignForm": 'managerAssignForm.addEventListener("submit"',
  "admin.html#outreachForm": 'outreachForm.addEventListener("submit"',
  "admin.html#securityAuditFilterForm": 'document.getElementById("securityAuditFilterForm")?.addEventListener("submit"',
  "auth/callback.html#callbackAcceptanceForm": 'acceptanceForm.addEventListener("submit"',
  "feedback.html#feedbackForm": '$("feedbackForm").addEventListener("submit"',
  "resend-confirmation.html#resendConfirmationForm": '$("resendConfirmationForm").addEventListener("submit"',
  "reset-password.html#requestResetForm": '$("requestResetForm").addEventListener("submit"',
  "reset-password.html#updatePasswordForm": '$("updatePasswordForm").addEventListener("submit"',
  "submit.html#submissionForm": 'submissionForm.addEventListener("submit"',
  "venue-portal.html#beerForm": 'beerForm.addEventListener("submit"',
  "venue-portal.html#counterStaffForm": 'counterStaffForm.addEventListener("submit"',
  "venue-portal.html#discountRedemptionForm": 'discountRedemptionFormElement.addEventListener("submit"',
  "venue-portal.html#freePintRewardForm": 'freePintRewardForm.addEventListener("submit"',
  "venue-portal.html#happyHourForm": 'happyHourForm.addEventListener("submit"',
  "venue-portal.html#memberPurchaseForm": 'memberPurchaseForm.addEventListener("submit"',
  "venue-portal.html#profileForm": 'profileForm.addEventListener("submit"',
  "venue-portal.html#reportDeliveryForm": 'reportDeliveryFormElement.addEventListener("submit"',
  "venue-portal.html#specialForm": 'specialForm.addEventListener("submit"',
  "venue-portal.html#venueClaimForm": 'venueClaimForm.addEventListener("submit", submitVenueClaim)',
  "venue-portal.html#venueSupportForm": 'venueSupportFormElement.addEventListener("submit"',
};

function attributes(node: HtmlNode): Readonly<Record<string, string>> {
  return Object.fromEntries((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
}

function staticFormsIn(file: string): ReadonlyArray<StaticForm> {
  const document = parse(readViewer(file)) as unknown as HtmlNode;
  const forms: StaticForm[] = [];

  function walk(node: HtmlNode, dialogDepth: number): void {
    const nodeAttributes = attributes(node);
    const childDialogDepth = dialogDepth + (node.tagName === "dialog" ? 1 : 0);

    if (node.tagName === "form") {
      let hasSubmitControl = false;
      function inspectFormContent(descendant: HtmlNode): void {
        const control = attributes(descendant);
        if (
          (descendant.tagName === "button" && (!control.type || control.type.toLowerCase() === "submit"))
          || (descendant.tagName === "input" && ["submit", "image"].includes((control.type || "").toLowerCase()))
        ) {
          hasSubmitControl = true;
        }
        for (const child of descendant.childNodes ?? []) inspectFormContent(child);
        if (descendant.content) inspectFormContent(descendant.content);
      }
      inspectFormContent(node);
      forms.push({
        key: `${file}#${nodeAttributes.id || "(missing-id)"}`,
        attributes: nodeAttributes,
        hasSubmitControl,
        insideDialog: childDialogDepth > 0,
      });
    }

    for (const child of node.childNodes ?? []) walk(child, childDialogDepth);
    if (node.content) walk(node.content, childDialogDepth);
  }

  walk(document, 0);
  return forms;
}

function readViewer(file: string): string {
  return fs.readFileSync(path.join(VIEWER_ROOT, file), "utf8");
}

function viewerFiles(extension: string): ReadonlyArray<string> {
  const files: string[] = [];
  function visit(directory: string, prefix: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), relativePath);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(relativePath);
      }
    }
  }
  visit(VIEWER_ROOT, "");
  return files.sort();
}

function inlineScriptFormMarkup(file: string): ReadonlyArray<string> {
  const document = parse(readViewer(file)) as unknown as HtmlNode;
  const matches: string[] = [];
  function walk(node: HtmlNode): void {
    if (node.tagName === "script") {
      const source = (node.childNodes ?? []).map((child) => child.value || "").join("");
      if (source.includes("<form")) matches.push(file);
    }
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  }
  walk(document);
  return matches;
}

async function withHttpServer(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownAppServices();
});

describe("static form native fallback", () => {
  it("keeps an exact recursive inventory of every static viewer form", () => {
    const htmlFiles = viewerFiles(".html");
    const forms = htmlFiles.flatMap(staticFormsIn).sort((left, right) => left.key.localeCompare(right.key));

    expect(forms.map((form) => form.key)).toEqual([...EXPECTED_STATIC_FORMS].sort());
    expect(new Set(forms.map((form) => form.key)).size).toBe(EXPECTED_STATIC_FORMS.length);
    expect(htmlFiles.flatMap(inlineScriptFormMarkup)).toEqual([]);

    const scriptFormMarkup = viewerFiles(".js")
      .filter((file) => readViewer(file).includes("<form"));
    expect(scriptFormMarkup).toEqual(["business.js"]);
    expect(readViewer("business.js").match(/<form/g)).toHaveLength(1);
  });

  it("makes every non-dialog form an explicit POST and preserves enhanced submission", () => {
    const forms = viewerFiles(".html").flatMap(staticFormsIn);
    const byKey = new Map(forms.map((form) => [form.key, form]));
    const nonDialogKeys = EXPECTED_STATIC_FORMS.filter((key) => !DIALOG_FORMS.has(key));

    expect(Object.keys(SUBMIT_HANDLER_EVIDENCE).sort()).toEqual([...nonDialogKeys].sort());
    for (const key of EXPECTED_STATIC_FORMS) {
      const form = byKey.get(key);
      expect(form, key).toBeDefined();

      if (DIALOG_FORMS.has(key)) {
        expect(form?.insideDialog, `${key} must be inside a real dialog`).toBe(true);
        expect(form?.attributes.method, key).toBe("dialog");
        expect(form?.attributes.action, key).toBeUndefined();
        continue;
      }

      expect(form?.insideDialog, key).toBe(false);
      expect(form?.attributes.method, `${key} must not default to GET`).toBe("post");
      expect(form?.attributes["accept-charset"], key).toBe("UTF-8");
      expect(form?.attributes.action, key).not.toContain("?");
      expect(form?.hasSubmitControl, `${key} must retain keyboard form submission`).toBe(true);
      const separator = key.indexOf("#");
      expect(readViewer(key.slice(0, separator)), key).toContain(SUBMIT_HANDLER_EVIDENCE[key]);

      const supportedAction = SUPPORTED_POST_FORMS.get(key);
      if (supportedAction) {
        expect(form?.attributes.action, key).toBe(supportedAction);
        expect(form?.attributes["data-sensitive-native-fallback"], key).toBe("supported-post");
      } else {
        expect(form?.attributes.action, key).toBe(FALLBACK_ACTION);
        expect(form?.attributes["data-sensitive-native-fallback"], key).toBe("non-mutating");
      }
    }
  });

  it("keeps the dynamically-created current-password form local to its dialog", () => {
    const business = readViewer("business.js");

    expect(business).toContain('<form method="dialog" class="form">');
    expect(business).toContain('<input name="currentPassword" type="password"');
    expect(business).toContain('dialog.querySelector("form").addEventListener("submit", (event) => {');
    expect(business).toContain("event.preventDefault();");
  });

  it("rejects fallback submissions before parsing without redirecting, logging, or reflecting fields", async () => {
    const appSource = fs.readFileSync(path.resolve(process.cwd(), "src/app.ts"), "utf8");
    const routeIndex = appSource.indexOf(`"${FALLBACK_ACTION}",`);
    const jsonParserIndex = appSource.indexOf("const standardJsonParser = express.json");
    const urlEncodedParserIndex = appSource.indexOf("app.use(express.urlencoded");

    expect(routeIndex).toBeGreaterThan(-1);
    expect(routeIndex).toBeLessThan(jsonParserIndex);
    expect(routeIndex).toBeLessThan(urlEncodedParserIndex);

    const secretEmail = "private-person@example.test";
    const secretPassword = "do-not-reflect-this-password";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withHttpServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${FALLBACK_ACTION}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: secretEmail, password: secretPassword, message: "private message" }),
      });
      const body = await response.text();

      expect(response.status).toBe(409);
      expect(response.redirected).toBe(false);
      expect(new URL(response.url).search).toBe("");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(response.headers.get("ratelimit-limit")).toBe("30");
      expect(body).toContain('role="alert" aria-labelledby="formUnavailableTitle"');
      expect(body).toContain("Your information was not processed or saved.");
      expect(body).not.toContain(secretEmail);
      expect(body).not.toContain(secretPassword);
      expect(body).not.toContain("private message");

      const oversizedSecret = `must-not-reflect-${"x".repeat(70 * 1024)}`;
      const oversizedResponse = await fetch(`${baseUrl}${FALLBACK_ACTION}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ message: oversizedSecret }),
      });
      const oversizedBody = await oversizedResponse.text();
      expect(oversizedResponse.status).toBe(413);
      expect(oversizedResponse.headers.get("cache-control")).toContain("no-store");
      expect(oversizedBody).not.toContain(oversizedSecret);
    });
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
