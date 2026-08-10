// Known-answer checks for the Dashboard's Merged parent/child view: the
// parent/child shares, the blended target vector and its two identities (the
// per-member ratio and the members' internal proportions), the synthetic
// portfolio / transactions / brokers, and the order routing.
// Run with: npx esbuild scripts/verify-merged-group.ts --bundle --format=esm | node --input-type=module
import type { Broker, Portfolio, Transaction } from '../src/types';
import { computeGroupRebalance } from '../src/utils/groupRebalance';
import {
    mergedRatio,
    buildMergedGroup,
    routeOrder,
    isMergedPortfolioId,
    MERGED_PORTFOLIO_PREFIX,
    type MemberValue,
} from '../src/utils/mergedGroup';

const pf = (p: Partial<Portfolio> & { id: string }): Portfolio =>
    ({ name: p.id, order: 0, ...p });

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

/** A member with the given value, target vector and holdings. */
const member = (
    portfolio: Portfolio,
    totalValue: number,
    holdings: Record<string, { qty: number; value: number }>,
): MemberValue => ({
    portfolio,
    totalValue,
    valueByTicker: Object.fromEntries(Object.entries(holdings).map(([t, h]) => [t, h.value])),
    quantityByTicker: Object.fromEntries(Object.entries(holdings).map(([t, h]) => [t, h.qty])),
});

// Core 80 / Bond Buffer 20, disjoint assets. Core is overweight as a whole.
const core = pf({ id: 'core', name: 'Core', allocations: { VWCE: 70, XMAU: 30 } });
const buffer = pf({ id: 'buf', name: 'Bond Buffer', allocations: { BTP: 100 } });
const coreValue = member(core, 8400, { VWCE: { qty: 84, value: 6000 }, XMAU: { qty: 24, value: 2400 } });
const bufValue = member(buffer, 1600, { BTP: { qty: 16, value: 1600 } });
const members = [coreValue, bufValue];

const plan = computeGroupRebalance([
    { portfolioId: 'core', name: 'Core', currentValue: 8400, targetBasis: 8000 },
    { portfolioId: 'buf', name: 'Bond Buffer', currentValue: 1600, targetBasis: 2000 },
])!;

// ── 1. Shares from the configured global ratio ──
{
    const { members: ratio, ratioSource } = mergedRatio(members, plan);
    assertStr('r1 ratio source', ratioSource, 'global');
    assertEq('r1 core share', ratio[0].share, 0.8);
    assertEq('r1 buffer share', ratio[1].share, 0.2);
    assertEq('r1 shares sum to 1', ratio.reduce((s, r) => s + r.share, 0), 1);
}

// ── 2. Blended targets + the two identities ──
{
    const { members: ratio, ratioSource } = mergedRatio(members, plan);
    const merged = buildMergedGroup({
        members, ratio, ratioSource,
        transactions: [], brokers: [], existingPortfolioIds: ['core', 'buf'],
    });
    const alloc = merged.portfolio.allocations || {};

    // Core's 70/30 scaled by 0.8; the Buffer's 100 scaled by 0.2.
    assertEq('t2 VWCE merged target', alloc.VWCE, 56);
    assertEq('t2 XMAU merged target', alloc.XMAU, 24);
    assertEq('t2 BTP merged target', alloc.BTP, 20);
    assertEq('t2 merged targets sum to 100', Object.values(alloc).reduce((s, v) => s + v, 0), 100);

    // IDENTITY A (ratio): a member's merged targets sum to share × 100, so its
    // value at target is groupTotal × share — exactly the ⚖ panel's target.
    assertEq('t2 core block = share × 100', alloc.VWCE + alloc.XMAU, 80);
    assertEq('t2 buffer block = share × 100', alloc.BTP, 20);
    const groupTotal = 10000;
    assertEq('t2 core target value == plan target value',
        groupTotal * ((alloc.VWCE + alloc.XMAU) / 100),
        plan.members.find(m => m.portfolioId === 'core')!.targetValue);
    assertEq('t2 buffer target value == plan target value',
        groupTotal * (alloc.BTP / 100),
        plan.members.find(m => m.portfolioId === 'buf')!.targetValue);

    // IDENTITY B (internal): proportions inside a member are untouched.
    assertEq('t2 core internal ratio preserved', alloc.VWCE / alloc.XMAU, 70 / 30);
}

// ── 3. Member targets that don't sum to 100 are normalized ──
{
    const sloppy = pf({ id: 'core', name: 'Core', allocations: { VWCE: 35, XMAU: 15 } }); // sums to 50
    const sloppyValue = { ...coreValue, portfolio: sloppy };
    const ms = [sloppyValue, bufValue];
    const { members: ratio, ratioSource } = mergedRatio(ms, plan);
    const merged = buildMergedGroup({
        members: ms, ratio, ratioSource,
        transactions: [], brokers: [], existingPortfolioIds: ['core', 'buf'],
    });
    const alloc = merged.portfolio.allocations || {};
    // Without normalization Core would be planned at 40% and the ratio would never close.
    assertEq('t3 core block still = share × 100', alloc.VWCE + alloc.XMAU, 80);
    assertEq('t3 core internal ratio preserved', alloc.VWCE / alloc.XMAU, 35 / 15);
    assertEq('t3 total still 100', Object.values(alloc).reduce((s, v) => s + v, 0), 100);
}

// ── 4. A member with no targets falls back to its current mix ──
{
    const untargeted = pf({ id: 'buf', name: 'Bond Buffer' });
    const ms = [coreValue, { ...bufValue, portfolio: untargeted }];
    const { members: ratio } = mergedRatio(ms, plan);
    const merged = buildMergedGroup({
        members: ms, ratio, ratioSource: 'global',
        transactions: [], brokers: [], existingPortfolioIds: ['core', 'buf'],
    });
    const alloc = merged.portfolio.allocations || {};
    assertEq('t4 buffer keeps its 20% block', alloc.BTP, 20);
    assertEq('t4 total still 100', Object.values(alloc).reduce((s, v) => s + v, 0), 100);
}

// ── 5. A member with no ACTIVE global target keeps its current share ──
{
    // Only two members are covered by a plan; here the Buffer is left out.
    const soloPlan = computeGroupRebalance([
        { portfolioId: 'core', name: 'Core', currentValue: 6000, targetBasis: 6000 },
        { portfolioId: 'sat', name: 'Satellite', currentValue: 2400, targetBasis: 1200 },
    ])!;
    const satellite = member(pf({ id: 'sat', name: 'Satellite', allocations: { NDX: 100 } }), 2400, {
        NDX: { qty: 12, value: 2400 },
    });
    const ms = [member(core, 6000, { VWCE: { qty: 60, value: 4200 }, XMAU: { qty: 18, value: 1800 } }), satellite, bufValue];
    const { members: ratio } = mergedRatio(ms, soloPlan);
    // Covered block = (6000+2400)/10000 = 0.84, split 66.67/33.33 by the plan.
    assertEq('t5 core share', ratio[0].share, 0.84 * (soloPlan.members[0].targetShare / 100));
    assertEq('t5 satellite share', ratio[1].share, 0.84 * (soloPlan.members[1].targetShare / 100));
    assertEq('t5 uncovered buffer keeps its value share', ratio[2].share, 0.16);
    assertEq('t5 shares sum to 1', ratio.reduce((s, r) => s + r.share, 0), 1);
}

// ── 6. Synthetic portfolio, transactions and brokers ──
{
    const { members: ratio, ratioSource } = mergedRatio(members, plan);
    const txs: Transaction[] = [
        { id: 'a', ticker: 'VWCE', amount: 100, price: 100, date: '2024-01-01', direction: 'Buy', portfolioId: 'core' },
        { id: 'b', ticker: 'VWCE', amount: 16, price: 110, date: '2024-06-01', direction: 'Sell', portfolioId: 'buf' },
        { id: 'c', ticker: 'ZZZ', amount: 5, price: 10, date: '2024-01-01', direction: 'Buy', portfolioId: 'other' },
    ];
    const brokers: Broker[] = [{
        id: 'b1', name: 'Directa', currentLiquidity: 9000,
        liquidityAllocations: { core: 500, buf: 300, other: 700 },
    }];
    const merged = buildMergedGroup({
        members, ratio, ratioSource,
        transactions: txs, brokers, existingPortfolioIds: ['core', 'buf', 'other'],
    });

    assertTrue('t6 synthetic id is flagged', isMergedPortfolioId(merged.portfolio.id));
    assertStr('t6 synthetic id', merged.portfolio.id, `${MERGED_PORTFOLIO_PREFIX}core`);
    assertEq('t6 only member txs, re-tagged', merged.transactions.length, 2);
    assertTrue('t6 every tx on the synthetic id',
        merged.transactions.every(t => t.portfolioId === merged.portfolio.id));
    // 100 bought in the parent, 16 sold in the child → the union nets to 84.
    const netVwce = merged.transactions.reduce(
        (s, t) => s + (t.direction === 'Sell' ? -t.amount : t.amount), 0);
    assertEq('t6 union nets across members', netVwce, 84);

    const allocs = merged.brokers[0].liquidityAllocations!;
    assertEq('t6 member cash merged onto one id', allocs[merged.portfolio.id], 800);
    assertTrue('t6 member ids removed', !('core' in allocs) && !('buf' in allocs));
    assertEq('t6 foreign earmark untouched', allocs.other, 700);

    // Pooled Buy-Only budget.
    const withLiq = buildMergedGroup({
        members: [
            { ...coreValue, portfolio: { ...core, liquidity: 1200 } },
            { ...bufValue, portfolio: { ...buffer, liquidity: 300 } },
        ],
        ratio, ratioSource, transactions: [], brokers: [], existingPortfolioIds: [],
    });
    assertEq('t6 pooled liquidity', withLiq.portfolio.liquidity!, 1500);
}

// ── 7. Id collision with an imported portfolio ──
{
    const { members: ratio, ratioSource } = mergedRatio(members, plan);
    const merged = buildMergedGroup({
        members, ratio, ratioSource, transactions: [], brokers: [],
        existingPortfolioIds: ['core', 'buf', `${MERGED_PORTFOLIO_PREFIX}core`],
    });
    assertStr('t7 collision suffixed', merged.portfolio.id, `${MERGED_PORTFOLIO_PREFIX}core_2`);
}

// ── 8. Order routing ──
{
    const ownerByUnit = { VWCE: 'core', XMAU: 'core', BTP: 'buf' };

    // Disjoint assets: a single leg on the owner.
    const buy = routeOrder({
        unitKey: 'BTP', ticker: 'BTP', shares: 4, ownerByUnit,
        holdingsByMember: { buf: 16 }, fallbackPortfolioId: 'core',
    });
    assertEq('t8 buy one leg', buy.length, 1);
    assertStr('t8 buy on the owner', buy[0].portfolioId, 'buf');
    assertEq('t8 buy shares', buy[0].shares, 4);

    const sell = routeOrder({
        unitKey: 'VWCE', ticker: 'VWCE', shares: -10, ownerByUnit,
        holdingsByMember: { core: 84 }, fallbackPortfolioId: 'core',
    });
    assertEq('t8 sell one leg', sell.length, 1);
    assertStr('t8 sell on the holder', sell[0].portfolioId, 'core');
    assertEq('t8 sell shares', sell[0].shares, -10);

    // A ticker nobody holds or owns is bought in the parent.
    const fresh = routeOrder({
        unitKey: 'NEW', ticker: 'NEW', shares: 7, ownerByUnit,
        holdingsByMember: {}, fallbackPortfolioId: 'core',
    });
    assertEq('t8 fresh buy one leg', fresh.length, 1);
    assertStr('t8 fresh buy goes to the parent', fresh[0].portfolioId, 'core');
    assertEq('t8 fresh buy shares', fresh[0].shares, 7);

    // Degenerate data (shared asset): pro-rata, legs summing exactly.
    const shared = routeOrder({
        unitKey: 'VWCE', ticker: 'VWCE', shares: 10, ownerByUnit,
        holdingsByMember: { core: 30, buf: 10 }, fallbackPortfolioId: 'core',
    });
    assertEq('t8 shared buy sums exactly', shared.reduce((s, l) => s + l.shares, 0), 10);
    assertEq('t8 shared buy legs', shared.length, 2);

    // A sell is never routed past what a member actually holds.
    const cappedSell = routeOrder({
        unitKey: 'VWCE', ticker: 'VWCE', shares: -35, ownerByUnit,
        holdingsByMember: { core: 30, buf: 10 }, fallbackPortfolioId: 'core',
    });
    assertEq('t8 capped sell sums exactly', cappedSell.reduce((s, l) => s + l.shares, 0), -35);
    const coreLeg = cappedSell.find(l => l.portfolioId === 'core')!;
    const bufLeg = cappedSell.find(l => l.portfolioId === 'buf')!;
    assertTrue('t8 core sell within holdings', -coreLeg.shares <= 30);
    assertTrue('t8 buffer sell within holdings', -bufLeg.shares <= 10);

    assertEq('t8 zero order → no legs', routeOrder({
        unitKey: 'VWCE', ticker: 'VWCE', shares: 0, ownerByUnit,
        holdingsByMember: { core: 30 }, fallbackPortfolioId: 'core',
    }).length, 0);
}

// ── 9. Degenerate inputs ──
{
    const { members: ratio, ratioSource } = mergedRatio(members, null);
    assertStr('t9 no plan → value source', ratioSource, 'value');
    assertEq('t9 core value share', ratio[0].share, 0.84);
    assertEq('t9 buffer value share', ratio[1].share, 0.16);

    const empty = [
        member(pf({ id: 'a' }), 0, {}),
        member(pf({ id: 'b' }), 0, {}),
    ];
    const zero = mergedRatio(empty, null);
    assertEq('t9 zero group → equal weights', zero.members[0].share, 0.5);
    assertEq('t9 zero group → shares sum to 1', zero.members.reduce((s, r) => s + r.share, 0), 1);

    assertEq('t9 no members → empty', mergedRatio([], null).members.length, 0);
}

// ── 10. A ticker grouped in one member and standalone in another ──
{
    const grouped = pf({
        id: 'core', name: 'Core',
        allocations: { _GRP_all: 100 },
        allocationGroups: [{ id: '_GRP_all', label: 'All World', members: ['VWCE', 'XMAU'] }],
    });
    const child = pf({ id: 'buf', name: 'Bond Buffer', allocations: { VWCE: 100 } });
    const ms = [
        member(grouped, 8000, { VWCE: { qty: 60, value: 5000 }, XMAU: { qty: 30, value: 3000 } }),
        member(child, 2000, { VWCE: { qty: 20, value: 2000 } }),
    ];
    const merged = buildMergedGroup({
        members: ms,
        ratio: [
            { portfolioId: 'core', name: 'Core', share: 0.8 },
            { portfolioId: 'buf', name: 'Bond Buffer', share: 0.2 },
        ],
        ratioSource: 'global', transactions: [], brokers: [], existingPortfolioIds: [],
    });
    const alloc = merged.portfolio.allocations || {};
    // The child's standalone VWCE target is folded into the group, which is the
    // only row that survives resolveGroups — otherwise those 20 points vanish.
    assertEq('t10 group absorbs the standalone target', alloc._GRP_all, 100);
    assertTrue('t10 no orphan standalone row', !('VWCE' in alloc));
    assertEq('t10 total preserved', Object.values(alloc).reduce((s, v) => s + v, 0), 100);
}

// ── 11. Groups that overlap across members are partitioned ──
// The shipped mock data does exactly this: the parent's "World Equity" group
// and the child's "EM + Dividend Tilt" group both list VWRL. Leaving VWRL in
// both member lists counts its value in both rows, so the actual percentages
// climb past 100 and the actions are computed off a phantom total.
{
    const parentPf = pf({
        id: 'core', name: 'Core',
        allocations: { _GRP_world: 70, EMIM: 30 },
        allocationGroups: [{
            id: '_GRP_world', label: 'World Equity', members: ['SWDA', 'VWRL'],
            memberRules: { VWRL: { noBuy: true } },
        }],
    });
    const childPf = pf({
        id: 'tilt', name: 'Tactical Tilt',
        allocations: { _GRP_tilt: 100 },
        allocationGroups: [{
            id: '_GRP_tilt', label: 'EM + Dividend Tilt', members: ['VWRL', 'EMIM'],
            memberRules: { VWRL: { weight: 60 }, EMIM: { weight: 40 } },
        }],
    });
    const ms = [
        member(parentPf, 8000, { SWDA: { qty: 40, value: 4000 }, VWRL: { qty: 20, value: 2000 }, EMIM: { qty: 20, value: 2000 } }),
        member(childPf, 2000, { VWRL: { qty: 10, value: 1000 }, EMIM: { qty: 10, value: 1000 } }),
    ];
    const merged = buildMergedGroup({
        members: ms,
        ratio: [
            { portfolioId: 'core', name: 'Core', share: 0.6 },
            { portfolioId: 'tilt', name: 'Tactical Tilt', share: 0.4 },
        ],
        ratioSource: 'global', transactions: [], brokers: [], existingPortfolioIds: [],
    });
    const groups = merged.portfolio.allocationGroups!;

    const world = groups.find(g => g.id === '_GRP_world')!;
    const tilt = groups.find(g => g.id === '_GRP_tilt')!;
    assertStr('t11 parent group keeps its members', world.members.join(','), 'SWDA,VWRL');
    assertStr('t11 child group drops the claimed ticker', tilt.members.join(','), 'EMIM');

    // No ticker may sit in two merged groups, or its value is double counted.
    const seen = new Set<string>();
    let duplicated = false;
    groups.forEach(g => g.members.forEach(t => {
        if (seen.has(t)) duplicated = true;
        seen.add(t);
    }));
    assertTrue('t11 no ticker in two groups', !duplicated);

    // A weighted group left with one member would fail groupWeightConfig's
    // "weights sum to 100" test and be skipped, so the survivor is rescaled.
    assertEq('t11 surviving weight rescaled to 100', tilt.memberRules!.EMIM.weight!, 100);
    assertTrue('t11 stale rule dropped', !('VWRL' in (tilt.memberRules || {})));

    // Targets still add up, and the standalone EMIM target folds into the group
    // that now owns EMIM.
    const alloc = merged.portfolio.allocations || {};
    assertEq('t11 total still 100', Object.values(alloc).reduce((s, v) => s + v, 0), 100);
    assertEq('t11 world = 0.6 × 70', alloc._GRP_world, 42);
    assertEq('t11 tilt = 0.4 × 100 + 0.6 × 30', alloc._GRP_tilt, 58);

    // Rows are addressed by the merged group ids, not the members' own.
    assertStr('t11 owner of the world group', merged.ownerByUnit._GRP_world, 'core');
    assertTrue('t11 no standalone EMIM unit', !('EMIM' in merged.ownerByUnit));
}

// ── 12. A group fully absorbed by an earlier one hands over its target ──
{
    const parentPf = pf({
        id: 'core', name: 'Core',
        allocations: { _GRP_a: 100 },
        allocationGroups: [{ id: '_GRP_a', label: 'A', members: ['SWDA', 'VWRL'] }],
    });
    const childPf = pf({
        id: 'kid', name: 'Kid',
        allocations: { _GRP_b: 100 },
        allocationGroups: [{ id: '_GRP_b', label: 'B', members: ['VWRL', 'SWDA'] }],
    });
    const ms = [
        member(parentPf, 5000, { SWDA: { qty: 30, value: 3000 }, VWRL: { qty: 20, value: 2000 } }),
        member(childPf, 5000, { VWRL: { qty: 50, value: 5000 } }),
    ];
    const merged = buildMergedGroup({
        members: ms,
        ratio: [
            { portfolioId: 'core', name: 'Core', share: 0.5 },
            { portfolioId: 'kid', name: 'Kid', share: 0.5 },
        ],
        ratioSource: 'global', transactions: [], brokers: [], existingPortfolioIds: [],
    });
    const alloc = merged.portfolio.allocations || {};
    assertEq('t12 one group survives', merged.portfolio.allocationGroups!.length, 1);
    assertTrue('t12 absorbed group has no target left', !('_GRP_b' in alloc));
    assertEq('t12 heir took the whole target', alloc._GRP_a, 100);
    assertEq('t12 total still 100', Object.values(alloc).reduce((s, v) => s + v, 0), 100);
}

console.log('\nAll merged-group checks passed.');
