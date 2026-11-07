// Known-answer checks for the parent/child ratio drift shown on the Home:
// buy-only cash per member and full-rebalance moves. Invented data only.
// Run with: npx esbuild scripts/verify-group-ratio-drift.ts --bundle --format=esm | node --input-type=module
import type { MergedGroupInfo } from '../src/utils/mergedPortfolioView';
import { groupRatioDrifts } from '../src/utils/groupRatioDrift';

const assertEq = (label: string, actual: number, expected: number, tol = 0.01) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};

const group = (shares: Record<string, number>, values: Record<string, number>, ratioSource: 'config' | 'value' = 'config'): MergedGroupInfo => ({
    id: '_MERGED_core', parentId: 'core', memberIds: Object.keys(values),
    members: Object.entries(shares).map(([portfolioId, share]) => ({ portfolioId, name: portfolioId, share })),
    ratioSource, ownerByUnit: {}, quantityByMember: {}, valueByMember: values,
});

// Target 75/20/5, held 8500/1200/300 (85/12/3) of 10,000.
const [d] = groupRatioDrifts([group({ core: 0.75, sat: 0.2, alt: 0.05 }, { core: 8500, sat: 1200, alt: 300 })], id => id);
assertEq('drift points', d.driftPoints, 10);
// Buy only: core 8500 / 0.75 → the group grows to 11,333.33.
assertEq('buy only: core buys nothing', d.members.find(m => m.portfolioId === 'core')!.buy, 0);
assertEq('buy only: sat', d.members.find(m => m.portfolioId === 'sat')!.buy, 1066.67);
assertEq('buy only: alt', d.members.find(m => m.portfolioId === 'alt')!.buy, 266.67);
assertEq('buy only: total cash', d.buyOnlyCash, 1333.33);
// Full: core gives 1000, 800 to sat and 200 to alt.
assertEq('full: two moves', d.moves.length, 2);
assertTrue('full: core → sat 800', d.moves.some(m => m.fromId === 'core' && m.toId === 'sat' && Math.abs(m.amount - 800) < 0.01));
assertTrue('full: core → alt 200', d.moves.some(m => m.fromId === 'core' && m.toId === 'alt' && Math.abs(m.amount - 200) < 0.01));
assertEq('full: total moved', d.moveTotal, 1000);

// A member at 0% that still holds money: buy only cannot fix it.
const [z] = groupRatioDrifts([group({ core: 1, old: 0 }, { core: 900, old: 100 })], id => id);
assertTrue('zero share: buy only is partial', z.buyOnlyPartial);
assertEq('zero share: full moves 100', z.moveTotal, 100);

// A group split by value has no target: left out.
assertEq('value-split groups ignored', groupRatioDrifts([group({ a: 0.5, b: 0.5 }, { a: 1, b: 3 }, 'value')], id => id).length, 0);
console.log('all group ratio drift checks passed');
