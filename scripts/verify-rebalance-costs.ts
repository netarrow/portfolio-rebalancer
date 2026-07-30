// Known-answer checks for the sell-side friction of a full rebalance: tax on the
// sold portion only, per-class rates, broker sell commissions, and the resulting
// buy-budget scale (buys must never cost more than the sells actually settle for).
// Run with: npx esbuild scripts/verify-rebalance-costs.ts --bundle --format=esm | node --input-type=module
import { computeSellFriction, buyBudgetScale, scaledBuyShares, capitalGainsRate } from '../src/utils/rebalanceCosts';
import type { Broker } from '../src/types';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};

const fixedBroker = (fee: number): Broker => ({
    id: 'b1', name: 'Fixed', commissionType: 'fixed', commissionFixed: fee,
} as Broker);
const percentBroker = (perc: number, min?: number, max?: number): Broker => ({
    id: 'b2', name: 'Percent', commissionType: 'percent', commissionPercent: perc,
    commissionMin: min, commissionMax: max,
} as Broker);

// ── 1. Rates per asset class ──
{
    assertEq('r1 stock', capitalGainsRate('Stock'), 0.26);
    assertEq('r1 crypto', capitalGainsRate('Crypto'), 0.26);
    assertEq('r1 gold', capitalGainsRate('Commodity'), 0.26);
    assertEq('r1 bond', capitalGainsRate('Bond'), 0.125);
    assertEq('r1 cash/monetary', capitalGainsRate('Cash'), 0.125);
    assertEq('r1 pension fund', capitalGainsRate('PensionFund'), 0.20);
    assertEq('r1 unknown falls back to 26%', capitalGainsRate('Whatever'), 0.26);
    assertEq('r1 undefined falls back to 26%', capitalGainsRate(undefined), 0.26);
}

// ── 2. Tax hits the sold portion only, not the whole unrealized gain ──
{
    // Position: 100 shares @ PMC 100 now worth 130 (unrealized gain €3,000).
    // Selling 10 shares realizes only 10 × 30 = €300 → tax 26% = €78.
    const f = computeSellFriction([
        { ticker: 'ETF', shares: 10, price: 130, averagePrice: 100, assetClass: 'Stock' },
    ]);
    assertEq('p2 gross', f.gross, 1300);
    assertEq('p2 taxable gain (sold portion only)', f.legs[0].gain, 300);
    assertEq('p2 tax', f.tax, 78);
    assertEq('p2 no broker ⇒ no commission', f.commission, 0);
    assertEq('p2 net proceeds', f.net, 1222);
    assertEq('p2 friction', f.total, 78);
}

// ── 3. Bonds taxed at 12.5%, plus a fixed sell commission ──
{
    const f = computeSellFriction([
        { ticker: 'BTP', shares: 20, price: 110, averagePrice: 100, assetClass: 'Bond', broker: fixedBroker(5) },
    ]);
    assertEq('p3 gross', f.gross, 2200);
    assertEq('p3 gain', f.legs[0].gain, 200);
    assertEq('p3 tax @12.5%', f.tax, 25);
    assertEq('p3 commission', f.commission, 5);
    assertEq('p3 net', f.net, 2170);
}

// ── 4. A sale at a loss is taxed 0 and does NOT offset the other legs' gains ──
{
    const f = computeSellFriction([
        { ticker: 'WIN', shares: 10, price: 130, averagePrice: 100, assetClass: 'Stock' },
        { ticker: 'LOSS', shares: 10, price: 70, averagePrice: 100, assetClass: 'Stock' },
    ]);
    assertEq('p4 losing leg taxable gain', f.legs[1].gain, 0);
    assertEq('p4 losing leg tax', f.legs[1].tax, 0);
    // Conservative: €300 gain is taxed in full, the €300 loss is ignored.
    assertEq('p4 total tax (no offsetting)', f.tax, 78);
    assertEq('p4 gross', f.gross, 2000);
    assertEq('p4 net', f.net, 1922);
}

// ── 5. Percent commission honours min/max ──
{
    const f = computeSellFriction([
        // 0.19% of €1,000 = €1.90 → lifted to the €2.95 minimum.
        { ticker: 'A', shares: 10, price: 100, averagePrice: 100, broker: percentBroker(0.19, 2.95, 19) },
        // 0.19% of €50,000 = €95 → capped at €19.
        { ticker: 'B', shares: 500, price: 100, averagePrice: 100, broker: percentBroker(0.19, 2.95, 19) },
    ]);
    assertEq('p5 min applied', f.legs[0].commission, 2.95);
    assertEq('p5 max applied', f.legs[1].commission, 19);
    assertEq('p5 no gains ⇒ no tax', f.tax, 0);
}

// ── 6. Buy budget scale ──
{
    // Sell €10,000 with €600 tax + €10 fees, buy €10,000 gross.
    assertEq('p6 scale', buyBudgetScale(10000, 610), 0.939);
    // Nothing sold (or nothing owed) ⇒ untouched sizing, so the correction is a
    // strict no-op on a buy-only rebalance.
    assertEq('p6 no friction ⇒ 1', buyBudgetScale(10000, 0), 1);
    assertEq('p6 nothing to buy ⇒ 1', buyBudgetScale(0, 500), 1);
    // Friction bigger than the whole buy leg ⇒ clamped, never negative.
    assertEq('p6 clamped at 0', buyBudgetScale(100, 500), 0);
}

// ── 7. Scaled buys round DOWN, never up ──
{
    assertEq('p7 floors', scaledBuyShares(10, 0.939), 9);
    assertEq('p7 exact stays', scaledBuyShares(10, 1), 10);
    assertEq('p7 scale 1 is identity for sells too', scaledBuyShares(-4, 1), -4);
    assertEq('p7 sub-share buy disappears', scaledBuyShares(1, 0.5), 0);
}

// ── 8. End-to-end: the buys can never cost more than the sells credit ──
{
    // Sell 100 shares of a stock @ €130 bought at €100 → €13,000 gross,
    // €3,000 gain, €780 tax, €5 commission → €12,215 actually settles.
    const price = 130;
    const f = computeSellFriction([
        { ticker: 'SELLME', shares: 100, price, averagePrice: 100, assetClass: 'Stock', broker: fixedBroker(5) },
    ]);
    assertEq('p8 net settled', f.net, 12215);

    // Gross plan wanted to buy 130 shares @ €100 = €13,000 with that money.
    const buyPrice = 100;
    const grossBuyShares = 130;
    const grossBuyTotal = grossBuyShares * buyPrice;
    const scale = buyBudgetScale(grossBuyTotal, f.total);
    const netBuyShares = scaledBuyShares(grossBuyShares, scale);
    const netBuyCost = netBuyShares * buyPrice;

    assertEq('p8 gross buy overdraws by the friction', grossBuyTotal - f.net, f.total);
    assertEq('p8 netted buy shares', netBuyShares, 122);
    assertEq('p8 netted buy cost', netBuyCost, 12200);
    assertTrue('p8 buys fit inside the settled cash', netBuyCost <= f.net);
    assertTrue('p8 leftover under one share', f.net - netBuyCost < buyPrice);
}

// ── 9. Degenerate inputs ──
{
    assertEq('p9 no legs', computeSellFriction([]).total, 0);
    assertEq('p9 zero shares ignored', computeSellFriction([
        { ticker: 'X', shares: 0, price: 100, averagePrice: 50 },
    ]).legs.length, 0);
    assertEq('p9 priceless leg ignored', computeSellFriction([
        { ticker: 'X', shares: 10, price: 0, averagePrice: 50 },
    ]).legs.length, 0);
}

console.log('\nAll rebalance-cost checks passed.');
