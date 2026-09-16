import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function walletHarness() {
  const html = fs.readFileSync("viewer/account.html", "utf8");
  const source = html.slice(html.indexOf("    let activePilotReward = null;"), html.indexOf("    function renderDashboard(result)"));
  const statsSource = html.slice(html.indexOf("    function renderAccountStatsPanel(result)"), html.indexOf("    function renderDisplayNameForm(account)"));
  const contextSource = html.slice(html.indexOf("    function captureAccountUiContext()"), html.indexOf("    function invalidateAccountBoundUi()"));
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, textContent: "", innerHTML: "", disabled: false, classList: { add() {} }, removeAttribute(name: string) { delete this[name]; } });
    return elements.get(id);
  };
  const stats = new Map<string, { textContent: string }>();
  const statsGrid = element("accountStatsGrid");
  let statsMarkup = "";
  Object.defineProperty(statsGrid, "innerHTML", {
    get: () => statsMarkup,
    set(markup: string) {
      statsMarkup = markup;
      stats.clear();
      elements.delete("pintPointBalanceStat");
      for (const card of markup.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/g)) {
        const label = card[0].match(/<div class="metricLabel">([^<]+)<\/div>/)?.[1];
        const value = card[0].match(/<div([^>]*class="metricValue metricValue--small"[^>]*)>([^<]*)<\/div>/);
        if (!label || !value) continue;
        const node = { textContent: value[2] };
        stats.set(label, node);
        const id = value[1]?.match(/\bid="([^"]+)"/)?.[1];
        if (id) elements.set(id, node);
      }
    },
  });
  statsGrid.querySelector = () => null;
  const state = { accountUiEpoch: 1, accountData: { account: { id: "customer" }, pintPoints: {} as unknown } };
  const api = vi.fn<(_path: string) => Promise<{ pintPoints: unknown }>>();
  const context = vm.createContext({
    PINT_POINTS_REWARDS_ENABLED: true,
    COMMERCIAL_LAUNCH_ENABLED: false,
    $: (id: string) => id === "pintPointBalanceStat" ? elements.get(id) || null : element(id),
    state,
    document: { hidden: false },
    Date,
    Number,
    Boolean,
    Math,
    formatMoney: String,
    formatPoints: String,
    escapeHtml: (value: unknown) => String(value).replaceAll("<", "&lt;"),
    MelbBeerBusiness: { apiFetch: api, formatDate: (value: unknown) => String(value), setStatus: (node: any, text: string) => { node.textContent = text; node.hidden = false; } },
  });
  vm.runInContext(statsSource + contextSource, context);
  vm.runInContext(source, context);
  return {
    element,
    api,
    state,
    stats,
    load(wallet: unknown) {
      state.accountData.pintPoints = wallet;
      vm.runInContext("renderAccountStatsPanel(state.accountData); renderPintPointWallet(state.accountData.pintPoints)", context);
    },
    refresh(manual = false) { context.manual = manual; return vm.runInContext("refreshPintPointWallet(manual)", context) as Promise<void>; },
    render(wallet: unknown) { context.wallet = wallet; vm.runInContext("renderPintPointWallet(wallet)", context); },
    presentPass() { vm.runInContext("activePilotPassExpiresAt = new Date(Date.now() + 60000).toISOString()", context); },
    presentReward(id: string, lifetimeRedeemed = 0) { context.reward = { id, lifetimeRedeemed }; vm.runInContext("activePilotReward = reward", context); },
  };
}

const wallet = { balance: 49, available: 49, threshold: 50, rewardAvailable: false, activeCodes: [], recentLedger: [], rewardRedemptions: [], lifetimeRedeemed: 0 };

describe("bar pilot customer wallet", () => {
  it("keeps My stats and the wallet aligned through demo preparation, a purchase, reservation and redemption", async () => {
    const ui = walletHarness();
    ui.load({ ...wallet, balance: 1, available: 1 });
    expect(ui.stats.get("Pint Points")?.textContent).toBe("1/50");
    const contributionCard = ui.stats.get("Total uploads");
    for (const [balance, available, manual] of [[49, 49, true], [50, 50, false], [50, 0, false], [0, 0, false]] as const) {
      ui.api.mockResolvedValueOnce({ pintPoints: { ...wallet, balance, available } });
      await ui.refresh(manual);
      expect(ui.element("pintPointBalanceHero").textContent).toBe(`${balance} / 50`);
      expect(ui.stats.get("Pint Points")?.textContent).toBe(`${balance}/50`);
      expect(ui.stats.get("Total uploads")).toBe(contributionCard);
    }
    expect(ui.api.mock.calls).toEqual(Array.from({ length: 4 }, () => ["/api/business/account"]));
  });

  it("shows reserved points consistently on initial account load and direct reward rendering", () => {
    const ui = walletHarness();
    ui.load({ ...wallet, balance: 50, available: 0 });
    expect(ui.stats.get("Pint Points")?.textContent).toBe("50/50");
    expect(ui.element("pintPointBalanceHero").textContent).toBe("50 / 50");
    ui.render({ ...wallet, balance: 0, available: 0, lifetimeRedeemed: 50 });
    expect(ui.stats.get("Pint Points")?.textContent).toBe("0/50");
  });

  it("does not update either balance from a refresh belonging to a previous account context", async () => {
    const ui = walletHarness();
    ui.load({ ...wallet, balance: 1, available: 1 });
    let finish!: (value: { pintPoints: unknown }) => void;
    ui.api.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = ui.refresh();
    ui.state.accountUiEpoch += 1;
    finish({ pintPoints: { ...wallet, balance: 50, available: 50 } });
    await pending;
    expect(ui.element("pintPointBalanceHero").textContent).toBe("1 / 50");
    expect(ui.stats.get("Pint Points")?.textContent).toBe("1/50");
  });

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
