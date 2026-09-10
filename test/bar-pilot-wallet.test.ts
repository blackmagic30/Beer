import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function walletHarness() {
  const html = fs.readFileSync("viewer/account.html", "utf8");
  const source = html.slice(html.indexOf("    let activePilotReward = null;"), html.indexOf("    function renderDashboard(result)"));
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, textContent: "", innerHTML: "", disabled: false, classList: { add() {} }, removeAttribute(name: string) { delete this[name]; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    PINT_POINTS_REWARDS_ENABLED: true,
    $: element,
    Date,
    Number,
    Boolean,
    Math,
    escapeHtml: (value: unknown) => String(value).replaceAll("<", "&lt;"),
    MelbBeerBusiness: { formatDate: (value: unknown) => String(value), setStatus: (node: any, text: string) => { node.textContent = text; node.hidden = false; } },
  });
  vm.runInContext(source, context);
  return {
    element,
    render(wallet: unknown) { context.wallet = wallet; vm.runInContext("renderPintPointWallet(wallet)", context); },
    presentPass() { vm.runInContext("activePilotPassExpiresAt = new Date(Date.now() + 60000).toISOString()", context); },
    presentReward(id: string, lifetimeRedeemed = 0) { context.reward = { id, lifetimeRedeemed }; vm.runInContext("activePilotReward = reward", context); },
  };
}

const wallet = { balance: 49, available: 49, threshold: 50, rewardAvailable: false, activeCodes: [], recentLedger: [], rewardRedemptions: [], lifetimeRedeemed: 0 };

describe("bar pilot customer wallet", () => {
  it("keeps reward locked below fifty and makes availability explicit at fifty", () => {
    const ui = walletHarness();
    ui.render(wallet);
    expect(ui.element("pintPointBalanceHero").textContent).toBe("49 / 50");
    expect(ui.element("freePintRewardButton").disabled).toBe(true);
    expect(ui.element("pintPointProgressHero").textContent).toContain("1 Pint Point until");
    ui.render({ ...wallet, balance: 50, available: 50, rewardAvailable: true });
    expect(ui.element("freePintRewardButton").disabled).toBe(false);
    expect(ui.element("pintPointRewardBadge").textContent).toBe("Free pint available");
  });

  it("keeps the fifty-point balance visible while reserved and clears consumed QR on the next server response", () => {
    const ui = walletHarness();
    ui.presentReward("one-use-reward");
    ui.element("freePintRewardQr").src = "data:image/png;test";
    ui.element("freePintRewardCode").textContent = "ABC123";
    ui.render({ ...wallet, balance: 50, available: 0, activeCodes: [{ id: "one-use-reward", status: "active", expiresAt: new Date(Date.now() + 60000).toISOString() }] });
    expect(ui.element("pintPointBalanceHero").textContent).toBe("50 / 50");
    expect(ui.element("freePintRewardButton").disabled).toBe(true);
    expect(ui.element("freePintRewardCode").textContent).toBe("ABC123");
    ui.render({ ...wallet, balance: 0, available: 0, lifetimeRedeemed: 50 });
    expect(ui.element("pintPointBalanceHero").textContent).toBe("0 / 50");
    expect(ui.element("freePintRewardResult").hidden).toBe(true);
    expect(ui.element("freePintRewardCode").textContent).toBe("------");
    expect(ui.element("freePintRewardQr").src).toBeUndefined();
    expect(ui.element("pintPointWalletStatus").textContent).toContain("FREE PINT REDEEMED");
  });

  it("describes expiry without falsely reporting redemption and distinguishes test/reversal activity", () => {
    const ui = walletHarness();
    ui.presentReward("expired-reward");
    ui.render({ ...wallet, recentLedger: [
      { type: "admin_adjustment", pointsDelta: 49, description: "Approved demo fixture", createdAt: "2026-09-10" },
      { type: "drink_void", pointsDelta: -1, description: "Wrong member <script>", createdAt: "2026-09-10" },
    ] });
    expect(ui.element("pintPointWalletStatus").textContent).toContain("expired or was closed");
    expect(ui.element("pintPointWalletStatus").textContent).not.toContain("REDEEMED");
    expect(ui.element("pintPointActivity").innerHTML).toContain("Demo preparation");
    expect(ui.element("pintPointActivity").innerHTML).toContain("Purchase corrected");
    expect(ui.element("pintPointActivity").innerHTML).not.toContain("<script>");
  });

  it("retires the one-purchase identity code when a new recorded purchase reaches the wallet", () => {
    const ui = walletHarness();
    ui.render({ ...wallet, recentDrinkRecords: [] });
    ui.presentPass();
    ui.element("pintPointPassQr").src = "data:image/png;test";
    ui.element("pintPointPassCode").textContent = "ABC123";
    ui.render({ ...wallet, balance: 50, available: 50, recentDrinkRecords: [{ id: "new-purchase" }] });
    expect(ui.element("pintPointPassResult").hidden).toBe(true);
    expect(ui.element("pintPointPassCode").textContent).toBe("------");
    expect(ui.element("pintPointPassQr").src).toBeUndefined();
    expect(ui.element("pintPointWalletStatus").textContent).toContain("fresh customer code");
  });

  it("explains an active code from another page without creating an additional reward", () => {
    const ui = walletHarness();
    ui.render({ ...wallet, balance: 50, available: 0, activeCodes: [{ id: "existing", status: "active", expiresAt: new Date(Date.now() + 60000).toISOString() }] });
    expect(ui.element("freePintRewardButton").disabled).toBe(true);
    expect(ui.element("pintPointWalletStatus").textContent).toContain("screen that created it");
  });
});
