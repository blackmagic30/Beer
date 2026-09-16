import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const html = fs.readFileSync("viewer/venue-portal.html", "utf8");
const section = (start: string, end: string) => {
  const index = html.indexOf(start);
  return html.slice(index, html.indexOf(end, index));
};

function counterHarness() {
  class Element {
    value = "";
    disabled = false;
    hidden = false;
    innerHTML = "";
    textContent = "";
    parentFieldset?: Element;
    focus = vi.fn();
    listeners = new Map<string, (event: { currentTarget: Element }) => void>();
    addEventListener(name: string, listener: (event: { currentTarget: Element }) => void) { this.listeners.set(name, listener); }
    get unavailable() { return this.disabled || Boolean(this.parentFieldset?.disabled); }
    type(value: string) {
      if (this.unavailable) return false;
      this.value = value;
      this.listeners.get("input")?.({ currentTarget: this });
      return true;
    }
  }
  class Form extends Element {}
  class Fieldset extends Element {}
  class Button extends Element {}
  const form = new Form();
  const fields = new Fieldset();
  fields.disabled = true;
  const button = new Button();
  const inputs = { code: new Element(), transactionReference: new Element(), itemName: new Element() };
  inputs.code.value = "ABC123";
  // Derive disabled-fieldset inheritance from the real form markup, not from
  // the proposed fix: the original nesting reproduces the first-keystroke lock.
  const purchaseMarkup = section('<form id="memberPurchaseForm"', "</form>");
  const fieldsetStart = purchaseMarkup.indexOf('<fieldset id="memberPurchaseFields"');
  const fieldsetEnd = purchaseMarkup.indexOf("</fieldset>", fieldsetStart);
  for (const [name, input] of Object.entries(inputs)) {
    const index = purchaseMarkup.indexOf(`name="${name}"`);
    if (index > fieldsetStart && index < fieldsetEnd) input.parentFieldset = fields;
  }
  const status = new Element();
  const nodes = { memberPurchaseForm: form, memberPurchaseFields: fields, checkMemberButton: button,
    memberPurchaseStatus: status, memberPreviewStatus: new Element() };
  const preview = (token = "verified-checkout") => ({ accountId: "PP-CUSTOMER", checkoutToken: token,
    authorizationExpiresAt: new Date(Date.now() + 60000).toISOString(), wallet: { available: 49, threshold: 50 } });
  const api = vi.fn(async (_path: string, _options: { body: string }) => preview());
  const context = vm.createContext({
    HTMLFormElement: Form, HTMLFieldSetElement: Fieldset, HTMLButtonElement: Button,
    document: { getElementById: (id: keyof typeof nodes) => nodes[id] },
    field: (_form: Form, name: keyof typeof inputs) => inputs[name],
    selectedVenueId: () => "assigned-venue", generateCounterReference: () => "counter-generated-reference",
    memberPurchaseForm: form, currentPortal: { profile: { name: "Demo venue" } },
    COMMERCIAL_LAUNCH_ENABLED: false, formatCount: String, escapeHtml: String,
    clearStatus: (element: Element) => { element.hidden = true; element.textContent = ""; },
    MelbBeerBusiness: { apiFetch: api, formatDate: String,
      setStatus: (element: Element, message: string) => { element.hidden = false; element.textContent = message; } },
  });
  vm.runInContext(section("    let activeMemberPreviewCode", "    let pendingVoidRecordId"), context);
  vm.runInContext(section("    function normalizeMemberCode(", "    function generateCounterReference("), context);
  vm.runInContext(section("    async function checkMemberCode(", "    function stopMemberQrScanner("), context);
  vm.runInContext(section('        field(memberPurchaseForm, "transactionReference").addEventListener', '        document.getElementById("checkMemberButton")'), context);
  return { inputs, fields, status, api, preview,
    check: () => vm.runInContext("checkMemberCode()", context) as Promise<unknown>,
    token: () => vm.runInContext("activeMemberCheckoutToken", context) as string,
    reference: () => vm.runInContext("activeMemberPreviewReference", context) as string,
  };
}

describe("staff receipt reference editing", () => {
  it("allows completing an edit while immediately invalidating purchase, then binds a fresh check", async () => {
    const ui = counterHarness();
    await ui.check();
    expect(ui.fields.disabled).toBe(false);
    expect(ui.inputs.transactionReference.type("p")).toBe(true);
    expect(ui.token()).toBe("");
    expect(ui.fields.disabled).toBe(true);
    expect(ui.inputs.transactionReference.type("purchase-123")).toBe(true);
    expect(ui.fields.disabled).toBe(true);
    await ui.check();
    expect(JSON.parse(ui.api.mock.calls.at(-1)![1].body)).toEqual({ code: "ABC123", transactionReference: "purchase-123" });
    expect(ui.reference()).toBe("purchase-123");
    expect(ui.token()).toBe("verified-checkout");
    expect(ui.fields.disabled).toBe(false);
  });

  it("explains a short reference locally and allows clearing it for an automatic reference", async () => {
    const ui = counterHarness();
    expect(ui.inputs.transactionReference.type("p")).toBe(true);
    await ui.check();
    expect(ui.api).not.toHaveBeenCalled();
    expect(ui.status.textContent).toContain("at least 4 characters");
    expect(ui.fields.disabled).toBe(true);
    expect(ui.inputs.transactionReference.type("")).toBe(true);
    await ui.check();
    expect(ui.reference()).toBe("counter-generated-reference");
    expect(ui.fields.disabled).toBe(false);
  });

  it.each(["replacement-123", ""])("does not unlock purchase after an in-flight reference edit to %j", async (reference) => {
    const ui = counterHarness();
    let resolve!: (value: ReturnType<typeof ui.preview>) => void;
    ui.api.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const checking = ui.check();
    expect(ui.inputs.transactionReference.type(reference)).toBe(true);
    resolve(ui.preview("obsolete-checkout"));
    await checking;
    expect(ui.token()).toBe("");
    expect(ui.fields.disabled).toBe(true);
    await ui.check();
    expect(ui.reference()).toBe(reference || "counter-generated-reference");
    expect(ui.token()).toBe("verified-checkout");
    expect(ui.fields.disabled).toBe(false);
  });

  it("keeps purchase locked and the reference editable when a recheck fails", async () => {
    const ui = counterHarness();
    await ui.check();
    expect(ui.inputs.transactionReference.type("new-reference")).toBe(true);
    ui.api.mockRejectedValueOnce(new Error("That member code has expired."));
    await ui.check();
    expect(ui.token()).toBe("");
    expect(ui.fields.disabled).toBe(true);
    expect(ui.inputs.transactionReference.type("corrected-reference")).toBe(true);
  });
});
