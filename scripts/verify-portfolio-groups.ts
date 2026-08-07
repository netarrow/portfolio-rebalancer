// Known-answer checks for parent/child portfolio groups: tree building (orphans,
// nesting), group aggregation (netted union holdings, merged per-broker cash,
// value-weighted targets) and target→asset-class resolution.
// Run with: npx esbuild scripts/verify-portfolio-groups.ts --bundle --format=esm | node --input-type=module
import type { AssetDefinition, Broker, Portfolio, Transaction } from '../src/types';
import { buildPortfolioTree, aggregateGroup, targetClassSlices } from '../src/utils/portfolioGroups';
import { getCashFlowsByDate, getPortfolioValueSeries } from '../src/utils/performanceCalculations';

const pf = (p: Partial<Portfolio> & { id: string }): Portfolio =>
    ({ name: p.id, order: 0, ...p });

const tx = (t: Partial<Transaction> & { ticker: string; amount: number; price: number }): Transaction =>
    ({ id: `${t.ticker}-${t.amount}-${t.price}-${t.date ?? ''}`, date: '2024-01-01', direction: 'Buy', ...t });

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};
const assertList = (label: string, actual: string[], expected: string[]) => {
    const got = actual.join(',');
    const want = expected.join(',');
    if (got !== want) throw new Error(`${label}: expected [${want}], got [${got}]`);
    console.log(`ok ${label} → [${got}]`);
};

// ── 1. Tree building ──
{
    const flat = [pf({ id: 'a', order: 1 }), pf({ id: 'b', order: 0 })];
    const t = buildPortfolioTree(flat);
    assertEq('flat list → no groups', t.groups.length, 0);
    assertList('flat list → standalones by order', t.standalones.map(p => p.id), ['b', 'a']);
}
{
    const t = buildPortfolioTree([
        pf({ id: 'parent', order: 0 }),
        pf({ id: 'c2', parentId: 'parent', order: 2 }),
        pf({ id: 'c1', parentId: 'parent', order: 1 }),
        pf({ id: 'solo', order: 3 }),
    ]);
    assertEq('one group', t.groups.length, 1);
    assertList('children sorted by order', t.groups[0].children.map(p => p.id), ['c1', 'c2']);
    assertList('members = parent first', t.groups[0].members.map(p => p.id), ['parent', 'c1', 'c2']);
    assertList('standalones', t.standalones.map(p => p.id), ['solo']);
}
{
    // deletePortfolio leaves children pointing at a missing parent
    const t = buildPortfolioTree([pf({ id: 'orphan', parentId: 'gone' })]);
    assertEq('orphan → no group', t.groups.length, 0);
    assertList('orphan → standalone', t.standalones.map(p => p.id), ['orphan']);
}
{
    // A <- B <- C: the grandchild is flattened into the root's group
    const t = buildPortfolioTree([
        pf({ id: 'A', order: 0 }),
        pf({ id: 'B', parentId: 'A', order: 1 }),
        pf({ id: 'C', parentId: 'B', order: 2 }),
    ]);
    assertEq('nested → one group', t.groups.length, 1);
    assertList('grandchild flattened into root', t.groups[0].members.map(p => p.id), ['A', 'B', 'C']);
    assertEq('nested → nothing standalone', t.standalones.length, 0);
}
{
    // corrupted data: a parentId cycle must not make portfolios disappear
    const t = buildPortfolioTree([pf({ id: 'X', parentId: 'Y' }), pf({ id: 'Y', parentId: 'X' })]);
    const seen = [...t.groups.flatMap(g => g.members.map(m => m.id)), ...t.standalones.map(p => p.id)].sort();
    assertList('cycle → nothing lost', seen, ['X', 'Y']);
}

// ── 2. Group aggregation ──
const settings: AssetDefinition[] = [
    { ticker: 'STK', assetClass: 'Stock' },
    { ticker: 'BND', assetClass: 'Bond' },
    { ticker: 'STK2', assetClass: 'Stock' },
];
const marketData = { STK: { price: 100, lastUpdated: '' }, BND: { price: 50, lastUpdated: '' }, STK2: { price: 10, lastUpdated: '' } };

{
    const group = buildPortfolioTree([
        pf({ id: 'p', order: 0, liquidity: 9999 }),
        pf({ id: 'c', parentId: 'p', order: 1 }),
    ]).groups[0];
    const transactions: Transaction[] = [
        tx({ ticker: 'STK', amount: 10, price: 90, portfolioId: 'p' }),
        tx({ ticker: 'STK', amount: 4, price: 95, portfolioId: 'c', direction: 'Sell', date: '2024-02-01' }),
        tx({ ticker: 'STK', amount: 5, price: 80, portfolioId: 'other' }),
    ];
    const brokers: Broker[] = [
        { id: 'b1', name: 'B1', liquidityAllocations: { p: 1000, c: 500 } },
        { id: 'b2', name: 'B2', liquidityAllocations: { other: 700 } },
    ];
    const agg = aggregateGroup(group, transactions, settings, marketData, brokers);

    const stk = agg.assets.filter(a => a.ticker === 'STK');
    assertEq('union holdings: one STK row', stk.length, 1);
    assertEq('union holdings: parent buy net of child sell', stk[0].quantity, 6);
    const cash = agg.assets.filter(a => a.ticker === '_CASH_b1');
    assertEq('shared broker cash merged into one row', cash.length, 1);
    assertEq('shared broker cash summed', cash[0].currentValue, 1500);
    assertEq('no cash from a broker outside the group', agg.assets.filter(a => a.ticker === '_CASH_b2').length, 0);
    // 6 × 100 invested + 1500 cash; portfolio.liquidity (9999) must not count
    assertEq('group total excludes portfolio.liquidity', agg.totalValue, 2100);
    assertEq('member weights sum to 1', agg.memberCalcs.reduce((s, m) => s + m.weight, 0), 1);
}

// ── 3. Value-weighted targets ──
{
    const group = buildPortfolioTree([
        pf({ id: 'p', order: 0, allocations: { STK: 100 } }),
        pf({ id: 'c', parentId: 'p', order: 1, allocations: { BND: 100 } }),
    ]).groups[0];
    // parent 300×100 = 30 000, child 200×50 = 10 000 → 75 / 25
    const transactions: Transaction[] = [
        tx({ ticker: 'STK', amount: 300, price: 100, portfolioId: 'p' }),
        tx({ ticker: 'BND', amount: 200, price: 50, portfolioId: 'c' }),
    ];
    const agg = aggregateGroup(group, transactions, settings, marketData, []);
    assertEq('weighted target STK', agg.weightedTargets.STK, 75);
    assertEq('weighted target BND', agg.weightedTargets.BND, 25);
    assertEq('no equal-weight fallback when invested', agg.equalWeightFallback ? 1 : 0, 0);

    const empty = aggregateGroup(group, [], settings, marketData, []);
    assertEq('zero-value group falls back to equal weights (STK)', empty.weightedTargets.STK, 50);
    assertEq('zero-value group falls back to equal weights (BND)', empty.weightedTargets.BND, 50);
    assertEq('equal-weight fallback flagged', empty.equalWeightFallback ? 1 : 0, 1);
}

// ── 4. Target → asset class ──
{
    const src = pf({
        id: 'p',
        allocationGroups: [
            { id: '_GRP_same', label: 'World', members: ['STK', 'STK2'] },
            { id: '_GRP_mixed', label: 'Mixed', members: ['STK', 'BND'] },
        ],
    });

    const same = targetClassSlices({ _GRP_same: 100 }, settings, { groupSources: [src] });
    assertList('group of same-class members collapses', same.map(s => s.name), ['Stock']);
    assertEq('…at the full percentage', same[0].value, 100);

    const mixed = targetClassSlices({ _GRP_mixed: 60, _VBOND_2030: 30, _CASH_b1: 10 }, settings, {
        groupSources: [src],
        valueByTicker: { STK: 3000, BND: 1000 },
    });
    const byName = Object.fromEntries(mixed.map(s => [s.name, s.value]));
    assertEq('mixed group split by value (Stock)', byName.Stock, 45);
    assertEq('virtual bond + mixed group (Bond)', byName.Bond, 15 + 30);
    assertEq('cash ticker → Cash', byName.Cash, 10);
    assertEq('slices sum to 100', mixed.reduce((s, x) => s + x.value, 0), 100);

    const unknown = targetClassSlices({ NOPE: 100 }, settings, { groupSources: [src] });
    assertList('unknown ticker → Other', unknown.map(s => s.name), ['Other']);

    const dangling = targetClassSlices({ _GRP_gone: 100 }, settings, { groupSources: [src] });
    assertList('unresolvable group id → Other', dangling.map(s => s.name), ['Other']);
}

// ── 5. Multi-portfolio scope in the performance helpers ──
{
    const transactions: Transaction[] = [
        tx({ ticker: 'STK', amount: 10, price: 100, portfolioId: 'p1' }),
        tx({ ticker: 'BND', amount: 20, price: 50, portfolioId: 'p2', date: '2024-01-02' }),
        tx({ ticker: 'STK2', amount: 5, price: 10, portfolioId: 'p3', date: '2024-01-03' }),
        tx({ ticker: 'STK', amount: 1, price: 100 }), // no portfolio: never in a scoped result
    ];
    const history = {};
    const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);

    const one = sum(getCashFlowsByDate(transactions, 'p1'));
    const two = sum(getCashFlowsByDate(transactions, 'p2'));
    assertEq('array scope == sum of single scopes', sum(getCashFlowsByDate(transactions, ['p1', 'p2'])), one + two);
    assertEq('empty scope → no flows', sum(getCashFlowsByDate(transactions, [])), 0);
    assertEq('undefined scope → every flow', sum(getCashFlowsByDate(transactions)), 1000 + 1000 + 50 + 100);

    const single = getPortfolioValueSeries(transactions, history, { portfolioId: 'p1' });
    const asArray = getPortfolioValueSeries(transactions, history, { portfolioId: ['p1'] });
    assertList(
        'single-element array == plain string scope',
        asArray.map(v => `${v.date}:${v.value}`),
        single.map(v => `${v.date}:${v.value}`),
    );
    assertEq('empty scope → empty series', getPortfolioValueSeries(transactions, history, { portfolioId: [] }).length, 0);
    // p1 holds 10 STK @100 (tx fallback price), p2 holds 20 BND @50 → group = 2000
    const group = getPortfolioValueSeries(transactions, history, { portfolioId: ['p1', 'p2'] });
    assertEq('group series sums both members', group[group.length - 1].value, 2000);
}

console.log('\nAll portfolio-group checks passed.');
