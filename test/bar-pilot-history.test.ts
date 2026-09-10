import fs from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

it("shows the original purchase operator and separate correction operator in manager history", () => {
  const html = fs.readFileSync("viewer/venue-portal.html", "utf8");
  const source = html.slice(html.indexOf("    function renderVenueReconciliation(data)"), html.indexOf("    async function loadVenueReconciliation"));
  const elements = new Map<string, { innerHTML: string; textContent: string; insertAdjacentHTML(position: string, value: string): void; querySelectorAll(): never[]; setAttribute(): void }>();
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", insertAdjacentHTML(_position, value) { this.innerHTML += value; }, querySelectorAll() { return []; }, setAttribute() {} });
    return elements.get(id)!;
  }
  const context = vm.createContext({
    document: { getElementById: element }, COMMERCIAL_LAUNCH_ENABLED: false,
    formatCount: String, formatCurrency: String,
    escapeHtml: (value: unknown) => String(value).replaceAll("<", "&lt;"),
    MelbBeerBusiness: { formatDate: String },
    data: { pintPointActivity: { total: 1, items: [{ id: "record", publicAccountId: "PP-CUSTOMER", itemName: "Guinness", status: "void", operatorPublicAccountId: "PP-STAFF", voidedByPublicAccountId: "PP-MANAGER", voidReason: "Wrong member", recordedAt: "2026-09-10", pointsAwarded: 1 }] } },
  });
  vm.runInContext(`${source}\nrenderVenueReconciliation(data);`, context);
  expect(element("reconciliationHistory").innerHTML).toContain("PP-STAFF");
  expect(element("reconciliationHistory").innerHTML).toContain("Reversed by PP-MANAGER · Wrong member");
  expect(element("reconciliationHistory").innerHTML).toContain("PP-CUSTOMER");
});
