// The invariants that make "read a parent/child group as one portfolio" safe:
// merging must RE-BUCKET value, never re-count it. Every check below compares a
// reading taken on the real portfolio list against the same reading taken on
// the merged view, on a fixture built to be the worst case for double counting:
// a group whose members share a broker AND hold the same ticker, plus a child
// attached to a different goal than its parent.
// Run with: npx esbuild scripts/verify-merged-portfolio-view.ts --bundle --format=esm | node --input-type=module
import type { AssetDefinition, Broker, Goal, Portfolio, Transaction } from '../src/types';
import { buildMergedPortfolioView, splitGroupAmount } from '../src/utils/mergedPortfolioView';
import { buildGoalDistribution, goalDistributionTotal, unassignedLiquidityOf } from '../src/utils/goalDistribution';
import { calculateAssets, injectCashAssets } from '../src/utils/portfolioCalculations';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};
const assertStr = (label: string, actual: string, expected: string) => {
    if (actual !== expected) throw new Error(`${label}: expected "${expected}", got "${actual}"`);
    console.log(`ok ${label} = ${actual}`);
};

// ── Fixture ──────────────────────────────────────────────────────────
// Core (parent, goal Growth) + Satellite (child, goal Growth) + Buffer (child,
// goal PROTECTION — the divergent one) + Standalone. Core and Satellite both
// hold VWCE and are both funded from the same broker: the two overlaps that
// would show up first if the merge counted anything twice.

const goals: Goal[] = [
    { id: 'growth', title: 'Growth', order: 0 },
    { id: 'protection', title: 'Protection', order: 1 },
];

const portfolios: Portfolio[] = [
    { id: 'core', name: 'Core', goalId: 'growth', order: 0, groupSharePercent: 60 },
    { id: 'sat', name: 'Satellite', goalId: 'growth', parentId: 'core', order: 1, groupSharePercent: 25 },
    { id: 'buf', name: 'Buffer', goalId: 'protection', parentId: 'core', order: 2, groupSharePercent: 15 },
    { id: 'solo', name: 'Standalone', goalId: 'protection', order: 3 },
];

const transactions: Transaction[] = [
    { id: 't1', ticker: 'VWCE', amount: 60, price: 100, date: '2024-01-01', direction: 'Buy', portfolioId: 'core', brokerId: 'b1' },
    { id: 't2', ticker: 'VWCE', amount: 20, price: 100, date: '2024-02-01', direction: 'Buy', portfolioId: 'sat', brokerId: 'b1' },
    { id: 't3', ticker: 'BTP', amount: 10, price: 100, date: '2024-03-01', direction: 'Buy', portfolioId: 'buf', brokerId: 'b1' },
    { id: 't4', ticker: 'XMAU', amount: 30, price: 100, date: '2024-04-01', direction: 'Buy', portfolioId: 'solo', brokerId: 'b2' },
    // A sale in the child of something the parent bought: the case that only
    // nets out correctly if the merge recomputes from the combined stream.
    { id: 't5', ticker: 'VWCE', amount: 5, price: 120, date: '2024-05-01', direction: 'Sell', portfolioId: 'sat', brokerId: 'b1' },
];

const brokers: Broker[] = [
    { id: 'b1', name: 'Directa', currentLiquidity: 5000, liquidityAllocations: { core: 800, sat: 400, buf: 200, solo: 100 } },
    { id: 'b2', name: 'Fineco', currentLiquidity: 2000, liquidityAllocations: { solo: 300 } },
];

const assetSettings: AssetDefinition[] = [
    { ticker: 'VWCE', assetClass: 'Stock' },
    { ticker: 'BTP', assetClass: 'Bond' },
    { ticker: 'XMAU', assetClass: 'Commodity' },
];

const marketData = {
    VWCE: { price: 110, lastUpdated: '2024-06-01' },
    BTP: { price: 105, lastUpdated: '2024-06-01' },
    XMAU: { price: 130, lastUpdated: '2024-06-01' },
};

const view = buildMergedPortfolioView({ portfolios, transactions, brokers, assetSettings, marketData });

/** invested + earmarked broker cash, summed over a portfolio list. */
const totalOver = (ps: Portfolio[], txs: Transaction[], bs: Broker[]): number =>
    ps.reduce((sum, p) => {
        const { assets } = calculateAssets(txs.filter(t => t.portfolioId === p.id), assetSettings, marketData);
        return sum + injectCashAssets(assets, bs, p.id).reduce((s, a) => s + a.currentValue, 0);
    }, 0);

// ── 0. The view is a partition, not an addition ──────────────────────
{
    assertEq('i0 one row per group + standalones', view.portfolios.length, 2);
    assertEq('i0 one group found', view.groups.length, 1);
    assertStr('i0 group members', view.groups[0].memberIds.join(','), 'core,sat,buf');
    assertTrue('i0 no member survives as its own row',
        !view.portfolios.some(p => ['core', 'sat', 'buf'].includes(p.id)));
    assertTrue('i0 standalone untouched', view.portfolios.some(p => p.id === 'solo'));
}

// ── 1. Same total value ──────────────────────────────────────────────
{
    const real = totalOver(portfolios, transactions, brokers);
    const merged = totalOver(view.portfolios, view.transactions, view.brokers);
    assertTrue('i1 fixture is not trivially empty', real > 0);
    assertEq('i1 merged total == real total', merged, real);
}

// ── 2. Same unassigned liquidity (the pyramid's level 0) ─────────────
{
    assertEq('i2 unassigned liquidity unchanged',
        unassignedLiquidityOf(view.brokers), unassignedLiquidityOf(brokers));
    // Re-keyed, not duplicated: the group holds what its members held.
    const b1 = view.brokers.find(b => b.id === 'b1')!;
    const allocs = b1.liquidityAllocations || {};
    assertEq('i2 members no longer earmarked',
        ['core', 'sat', 'buf'].reduce((s, id) => s + (allocs[id] ?? 0), 0), 0);
    assertEq('i2 group carries their sum', allocs[view.groups[0].id], 1400);
    assertEq('i2 broker cash itself untouched', b1.currentLiquidity!, 5000);
}

// ── 3. Same transactions, only re-tagged ─────────────────────────────
{
    assertEq('i3 transaction count unchanged', view.transactions.length, transactions.length);
    const qtyByTicker = (txs: Transaction[]) => {
        const out: Record<string, number> = {};
        txs.forEach(t => {
            const sign = t.direction === 'Sell' ? -1 : 1;
            out[t.ticker] = (out[t.ticker] ?? 0) + sign * t.amount;
        });
        return out;
    };
    const before = qtyByTicker(transactions);
    const after = qtyByTicker(view.transactions);
    Object.keys(before).forEach(ticker => {
        assertEq(`i3 ${ticker} quantity unchanged`, after[ticker], before[ticker]);
    });
    assertTrue('i3 no transaction left on a member',
        !view.transactions.some(t => ['core', 'sat', 'buf'].includes(t.portfolioId ?? '')));
    assertTrue('i3 ids are unique (re-tagged, not copied)',
        new Set(view.transactions.map(t => t.id)).size === view.transactions.length);
}

// ── 4. Same goal-pyramid total, whether merged or not ────────────────
{
    const input = { goals, portfolios, transactions, brokers, assetSettings, marketData };
    const plain = buildGoalDistribution({ ...input, mergeGroups: false });
    const merged = buildGoalDistribution(input);
    assertEq('i4 pyramid total unchanged',
        goalDistributionTotal(merged), goalDistributionTotal(plain));

    // ...but the SPLIT moves, which is the whole point: Buffer is attached to
    // Protection and counts under Growth because its group's parent lives there.
    const growth = merged.find(g => g.id === 'growth')!;
    const protection = merged.find(g => g.id === 'protection')!;
    const plainGrowth = plain.find(g => g.id === 'growth')!;
    const bufferValue = totalOver([portfolios[2]], transactions, brokers);
    assertEq('i4 buffer moved up into Growth', growth.value - plainGrowth.value, bufferValue);
    assertEq('i4 Growth reports it as borrowed', growth.inherited.length, 1);
    assertStr('i4 borrowed from', growth.inherited[0].fromGoalTitle, 'Protection');
    assertEq('i4 borrowed amount', growth.inherited[0].value, bufferValue);
    assertTrue('i4 borrowed slice is a tint, not the level colour',
        growth.inherited[0].color !== growth.color);
    assertTrue('i4 Protection keeps only the standalone', protection.inherited.length === 0);
}

// ── 5. Provenance partitions a level, never adds to it ───────────────
{
    const merged = buildGoalDistribution({ goals, portfolios, transactions, brokers, assetSettings, marketData });
    merged.forEach(level => {
        assertEq(`i5 ${level.name}: native + inherited == value`,
            level.nativeValue + level.inherited.reduce((s, h) => s + h.value, 0),
            level.value);
    });
}

// ── 6. A goal-less member is not smuggled into the pyramid ───────────
{
    // Adding a child with no goal must not change the pyramid's total: a
    // portfolio with no goal has always been outside it, group or not.
    const withGoalless: Portfolio[] = [
        ...portfolios,
        { id: 'nog', name: 'No Goal', parentId: 'core', order: 4 },
    ];
    const extraTx: Transaction[] = [
        ...transactions,
        { id: 't6', ticker: 'XMAU', amount: 7, price: 100, date: '2024-05-02', direction: 'Buy', portfolioId: 'nog', brokerId: 'b2' },
    ];
    const base = buildGoalDistribution({ goals, portfolios: withGoalless, transactions: extraTx, brokers, assetSettings, marketData, mergeGroups: false });
    const merged = buildGoalDistribution({ goals, portfolios: withGoalless, transactions: extraTx, brokers, assetSettings, marketData });
    assertEq('i6 goal-less member changes no total',
        goalDistributionTotal(merged), goalDistributionTotal(base));
}

// ── 7. splitGroupAmount closes the ratio and never overdraws ─────────
{
    const group = view.groups[0];
    const memberTotal = group.memberIds.reduce((s, id) => s + group.valueByMember[id], 0);

    const inLegs = splitGroupAmount(group, 1000);
    assertEq('i7 incoming legs sum to the request',
        inLegs.reduce((s, l) => s + l.amount, 0), 1000);
    assertTrue('i7 incoming legs all positive', inLegs.every(l => l.amount > 0));

    const outLegs = splitGroupAmount(group, -1000);
    assertEq('i7 outgoing legs sum to the request',
        outLegs.reduce((s, l) => s + l.amount, 0), -1000);
    assertTrue('i7 outgoing legs all negative', outLegs.every(l => l.amount < 0));
    assertTrue('i7 no member is overdrawn',
        outLegs.every(l => -l.amount <= group.valueByMember[l.portfolioId] + 1e-6));

    // Taking out more than the group holds can only yield what it holds.
    const drained = splitGroupAmount(group, -(memberTotal * 2));
    assertTrue('i7 draining is capped at what the group holds',
        -drained.reduce((s, l) => s + l.amount, 0) <= memberTotal + 1e-6);
    assertTrue('i7 still nobody overdrawn',
        drained.every(l => -l.amount <= group.valueByMember[l.portfolioId] + 1e-6));

    assertEq('i7 zero moves nothing', splitGroupAmount(group, 0).length, 0);

    // Money arriving goes to whoever is furthest BELOW its configured share.
    const shareOf = (id: string) => group.members.find(m => m.portfolioId === id)!.share;
    const gapOf = (id: string) => (memberTotal + 1000) * shareOf(id) - group.valueByMember[id];
    const neediest = group.memberIds.reduce((a, b) => (gapOf(b) > gapOf(a) ? b : a));
    const biggestLeg = inLegs.reduce((a, b) => (b.amount > a.amount ? b : a));
    assertStr('i7 the neediest member gets the most', biggestLeg.portfolioId, neediest);
}

// ── 8. Ratio source reflects the configuration ───────────────────────
{
    assertStr('i8 configured ratio is used', view.groups[0].ratioSource, 'config');
    const noRatio = portfolios.map(p => ({ ...p, groupSharePercent: undefined }));
    const fallback = buildMergedPortfolioView({ portfolios: noRatio, transactions, brokers, assetSettings, marketData });
    assertStr('i8 without a ratio it falls back to value', fallback.groups[0].ratioSource, 'value');
    assertEq('i8 fallback still totals the same',
        totalOver(fallback.portfolios, fallback.transactions, fallback.brokers),
        totalOver(portfolios, transactions, brokers));
}

console.log('\nAll merged-portfolio-view invariants hold.');
