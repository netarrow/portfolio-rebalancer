// Known-answer checks for the "By Broker" rebalancing mode: per-broker
// positions/Pmc, current-weight buy plan, and dominant-portfolio assignment.
// Run with: npx esbuild scripts/verify-broker-rebalance.ts --bundle --format=esm | node --input-type=module
import type { Transaction } from '../src/types';
import { calculateAssets } from '../src/utils/portfolioCalculations';
import { buildBrokerBuyPlan, groupTransactionsByBroker, assignPortfolioForBuy } from '../src/utils/brokerRebalancing';

const tx = (t: Partial<Transaction>): Transaction => ({
    id: Math.random().toString(36).slice(2),
    ticker: 'AAA', amount: 0, price: 0, date: '2024-01-02', direction: 'Buy', portfolioId: 'p1', brokerId: 'b1',
    ...t,
});

const transactions: Transaction[] = [
    // Broker b1 — AAA held by both p1 and p2 (p2 dominant), BBB by p1 only
    tx({ ticker: 'AAA', amount: 10, price: 100, date: '2024-01-02', portfolioId: 'p1' }),
    tx({ ticker: 'AAA', amount: 30, price: 105, date: '2024-02-01', portfolioId: 'p2' }),
    tx({ ticker: 'AAA', amount: 5, price: 110, date: '2024-03-01', portfolioId: 'p1', direction: 'Sell' }),
    tx({ ticker: 'BBB', amount: 100, price: 50, date: '2024-02-15', portfolioId: 'p1' }),
    // Broker b2
    tx({ ticker: 'CCC', amount: 20, price: 200, date: '2024-04-01', brokerId: 'b2' }),
    // Legacy: no broker
    tx({ ticker: 'DDD', amount: 1, price: 10, date: '2024-05-01', brokerId: undefined }),
];

const marketData = {
    AAA: { price: 120, lastUpdated: '2026-07-01T10:00:00Z' },
    BBB: { price: 60, lastUpdated: '2026-07-01T10:00:00Z' },
    CCC: { price: 210, lastUpdated: '2026-07-01T10:00:00Z' },
};

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`ok ${label} = ${actual}`);
};

// ── 1. Per-broker grouping + positions/Pmc ──
const byBroker = groupTransactionsByBroker(transactions);
if ((byBroker.get('b1') ?? []).length !== 4) throw new Error('b1 should have 4 transactions');
if ((byBroker.get('b2') ?? []).length !== 1) throw new Error('b2 should have 1 transaction');
if ((byBroker.get('') ?? []).length !== 1) throw new Error('legacy bucket should have 1 transaction');

const { assets: b1Assets } = calculateAssets(byBroker.get('b1')!, [], marketData);
const aaa = b1Assets.find(a => a.ticker === 'AAA')!;
// 10@100 + 30@105 = 40 shares, Pmc 103.75; sell 5 leaves 35 @ Pmc unchanged
assertEq('b1 AAA qty', aaa.quantity, 35);
assertEq('b1 AAA Pmc', aaa.averagePrice, 103.75);
const bbb = b1Assets.find(a => a.ticker === 'BBB')!;
assertEq('b1 BBB qty', bbb.quantity, 100);
assertEq('b1 BBB Pmc', bbb.averagePrice, 50);

// ── 2. Buy plan follows current weights ──
// Values: AAA 35×120 = 4200, BBB 100×60 = 6000 → weights 41.18% / 58.82%
const liquidity = 10_000;
const plan = buildBrokerBuyPlan(b1Assets, liquidity);
assertEq('plan conservation (spent + leftover)', plan.totalSpent + plan.leftover, liquidity);
if (plan.totalSpent > liquidity) throw new Error('plan overspends liquidity');
for (const line of plan.lines) {
    if (!Number.isInteger(line.shares)) throw new Error(`${line.ticker}: shares not integer (${line.shares})`);
    const price = line.ticker === 'AAA' ? 120 : 60;
    assertEq(`${line.ticker} eur = shares × price`, line.eur, line.shares * price);
    // Proportionality: assigned eur within one share price of liquidity × weight
    const ideal = liquidity * (line.currentWeight / 100);
    if (Math.abs(line.eur - ideal) > price) {
        throw new Error(`${line.ticker}: eur ${line.eur} deviates from ideal ${ideal} by more than one share`);
    }
}
const planAAA = plan.lines.find(l => l.ticker === 'AAA')!;
const planBBB = plan.lines.find(l => l.ticker === 'BBB')!;
assertEq('AAA current weight', planAAA.currentWeight, (4200 / 10200) * 100);
assertEq('BBB current weight', planBBB.currentWeight, (6000 / 10200) * 100);
// Projected weights stay close to current weights (composition preserved)
if (Math.abs(planAAA.projectedWeight - planAAA.currentWeight) > 1) throw new Error('AAA projected weight drifts > 1%');
if (Math.abs(planBBB.projectedWeight - planBBB.currentWeight) > 1) throw new Error('BBB projected weight drifts > 1%');

// ── 3. Edge cases ──
const empty = buildBrokerBuyPlan(b1Assets, 0);
if (empty.lines.length !== 0 || empty.totalSpent !== 0) throw new Error('zero liquidity must produce empty plan');
console.log('ok zero liquidity → empty plan');

const { assets: b2Assets } = calculateAssets(byBroker.get('b2')!, [], marketData);
const single = buildBrokerBuyPlan(b2Assets, 1000);
// CCC @210: 1000 → 4 shares = 840, leftover 160
assertEq('single asset spent', single.totalSpent, 840);
assertEq('single asset leftover', single.leftover, 160);

const tiny = buildBrokerBuyPlan(b2Assets, 100); // below one share price
assertEq('liquidity below cheapest share → spent', tiny.totalSpent, 0);
assertEq('liquidity below cheapest share → leftover', tiny.leftover, 100);

const withCash = buildBrokerBuyPlan(
    [...b2Assets, { ticker: '_CASH_b2', assetClass: 'Cash', assetSubClass: '', quantity: 1, averagePrice: 500, currentPrice: 500, currentValue: 500 }],
    1000
);
assertEq('_CASH_ assets ignored', withCash.totalSpent, single.totalSpent);
if (withCash.lines.some(l => l.ticker.startsWith('_CASH_'))) throw new Error('_CASH_ asset leaked into plan lines');

// ── 4. Dominant-portfolio assignment ──
// AAA at b1: p1 holds 10−5 = 5, p2 holds 30 → p2 dominant
if (assignPortfolioForBuy('AAA', byBroker.get('b1')!) !== 'p2') throw new Error('AAA should be assigned to p2');
if (assignPortfolioForBuy('BBB', byBroker.get('b1')!) !== 'p1') throw new Error('BBB should be assigned to p1');
console.log('ok dominant portfolio assignment');

// Tie-break by recency: equal quantities, later purchase wins
const tieTxs: Transaction[] = [
    tx({ ticker: 'EEE', amount: 10, price: 10, date: '2024-01-01', portfolioId: 'pOld' }),
    tx({ ticker: 'EEE', amount: 10, price: 10, date: '2024-06-01', portfolioId: 'pNew' }),
];
if (assignPortfolioForBuy('EEE', tieTxs) !== 'pNew') throw new Error('tie should break by most recent transaction');
console.log('ok tie-break by recency');

console.log('\nAll broker-rebalance checks passed ✓');
