// Known-answer checks for the Asset Allocation modes "From Expense Planning"
// (fund portfolios get the whole emergency fund target; each portfolio gets
// the capex not due that are invested there, allocations plus their cash;
// capex due soon go to liquidity with their investments to sell) and
// "Take the rest".
// Run with: npx esbuild scripts/verify-expense-planning-targets.ts --bundle --format=esm | node --input-type=module
import { buildExpensePlanningTargets, capexRouting, targetsByRow } from '../src/utils/expensePlanningTargets';
import { buildMaturityLadder } from '../src/utils/maturityLadder';
import { calculateAssetAllocation, withExpenseTargets, normalizeAssetAllocationSettings } from '../src/utils/assetAllocation';
import type { EmergencyCoverage } from '../src/utils/ynabCoverage';
import type { YnabGoal, YnabGoalAllocation } from '../src/types';

const assertEq = (label: string, actual: number, expected: number, tol = 0.01) => {
    if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};

// Fund: €12,000 target. The cash and investments already in the fund do not
// lower what the fund portfolios should hold.
const emergency = {
    target: 12000, cash: 3000, invested: 500,
    toMove: [{ categoryId: 'buffer', portfolioId: 'money', amount: 1000 }],
} as unknown as EmergencyCoverage;

const goal = (id: string, target: number, cash: number, extra: Partial<YnabGoal> = {}): YnabGoal => ({
    id, ynabBudgetId: 'b', name: id, targetAmount: target, cashCoverage: cash,
    targetSource: 'parsed-name', lastSyncedAt: '', ...extra,
});
const alloc = (goalId: string, portfolioId: string, amount: number): YnabGoalAllocation => ({
    id: `${goalId}-${portfolioId}`, ynabGoalId: goalId, portfolioId, amount, createdAt: '', updatedAt: '',
});

const t = buildExpensePlanningTargets({
    emergency,
    emergencyPortfolioIds: ['money', 'money2'],
    goals: [
        goal('car', 25000, 9000),                       // 3,000 + 1,000 allocated
        goal('house', 60000, 60000),                    // all cash, nothing allocated
        goal('old', 5000, 0, { archived: true }),       // archived: nothing
    ],
    allocations: [alloc('car', 'bonds', 3000), alloc('car', 'money', 1000), alloc('old', 'bonds', 500)],
    horizonMonths: 3,
    today: '2026-10-17',
});

// The whole 12,000 target, in equal parts over the two fund portfolios.
assertEq('fund on money = 12,000 / 2', t.get('money')!.fund, 6000);
assertEq('fund on money2 = 12,000 / 2', t.get('money2')!.fund, 6000);
assertEq('car on bonds = 3,000 + 9,000 cash × 3/4', t.get('bonds')!.capex, 9750);
assertEq('car on money = 1,000 + 9,000 cash × 1/4', t.get('money')!.capex, 3250);
assertEq('money adds fund and capex', t.get('money')!.total, 9250);
assertEq('a capex covered by cash adds nothing', [...t.values()].reduce((s, x) => s + x.capexItems.filter(c => c.goalId === 'house').length, 0), 0);

// A group row adds up its members.
const rows = targetsByRow(t, id => (id === 'money' || id === 'money2' ? 'grp' : undefined));
assertEq('group row = both fund portfolios', rows.get('grp')!.total, 9250 + 6000);

// The engine sizes an expense row like a fixed one, with the value filled in.
const stored = normalizeAssetAllocationSettings({ portfolioTargets: { bonds: { mode: 'expense', value: 1 }, rest: { mode: 'percent', value: 50 } } });
assertEq('the mode survives normalization', stored.portfolioTargets.bonds.mode === 'expense' ? 1 : 0, 1);
const settings = withExpenseTargets(stored, id => t.get(id)?.total);
const r = calculateAssetAllocation({
    portfolios: [
        { portfolioId: 'bonds', name: 'bonds', currentInvestedValue: 10000, currentPortfolioLiquidity: 0, currentTotalValue: 10000 },
        { portfolioId: 'rest', name: 'rest', currentInvestedValue: 30000, currentPortfolioLiquidity: 0, currentTotalValue: 30000 },
    ],
    brokerLiquidity: 0,
    settings,
});
assertEq('expense row target = 9,750', r.portfolios.find(p => p.portfolioId === 'bonds')!.targetValue, 9750);
assertEq('no Expense Planning value: 0', withExpenseTargets(stored, () => undefined).portfolioTargets.bonds.value, 0);

// Take the rest: what the others leave, in equal parts; none on a shortfall.
const pf = (id: string, v: number) => ({ portfolioId: id, name: id, currentInvestedValue: v, currentPortfolioLiquidity: 0, currentTotalValue: v });
const rest = calculateAssetAllocation({
    portfolios: [pf('a', 20000), pf('b', 10000), pf('c', 10000)],
    brokerLiquidity: 0,
    settings: normalizeAssetAllocationSettings({ portfolioTargets: { a: { mode: 'fixed', value: 15000 }, b: { mode: 'rest' }, c: { mode: 'rest' } } }),
});
assertEq('rest b = (40,000 − 15,000) / 2', rest.portfolios.find(p => p.portfolioId === 'b')!.targetValue, 12500);
assertEq('rest c = (40,000 − 15,000) / 2', rest.portfolios.find(p => p.portfolioId === 'c')!.targetValue, 12500);
assertEq('nothing left unallocated', rest.unallocatedRemainder, 0);
const short = calculateAssetAllocation({
    portfolios: [pf('a', 10000), pf('b', 10000)],
    brokerLiquidity: 0,
    settings: normalizeAssetAllocationSettings({ portfolioTargets: { a: { mode: 'fixed', value: 25000 }, b: { mode: 'rest' } } }),
});
assertEq('shortfall: rest gets 0', short.portfolios.find(p => p.portfolioId === 'b')!.targetValue, 0);
assertEq('shortfall still reported', short.sustainability.shortfall, 5000);

// Liquidity from Expense Planning: the operating cash, sized like a fixed target.
const liq = normalizeAssetAllocationSettings({ liquidityTarget: { mode: 'expense', value: 99 }, portfolioTargets: { a: { mode: 'rest' } } });
assertEq('the liquidity mode survives normalization', liq.liquidityTarget?.mode === 'expense' ? 1 : 0, 1);
const liqR = calculateAssetAllocation({
    portfolios: [pf('a', 20000)],
    brokerLiquidity: 5000,
    settings: withExpenseTargets(liq, () => undefined, 1936),
});
assertEq('liquidity target = operating cash', liqR.liquidity.target, 1936);
assertEq('rest takes the remainder', liqR.portfolios[0].targetValue, 25000 - 1936);
assertEq('no operating cash: 0', withExpenseTargets(liq, () => undefined).liquidityTarget!.value, 0);

// Capex routing: not due and invested → portfolios (allocations + cash);
// due soon → liquidity, cash + investments to sell; not invested → its cash.
const routed = capexRouting({
    goals: [
        goal('car', 25000, 9000, { targetDate: '2027-12-01' }),   // invested, far: its cash
        goal('trip', 4000, 1000, { targetDate: '2026-12-15' }),   // invested, due in 2 months: whole
        goal('sofa', 2000, 500, { targetDate: '2028-01-01' }),    // nothing invested: whole
        goal('late', 3000, 0, { targetDate: '2026-05-01' }),      // overdue counts as due
        goal('old', 5000, 700, { archived: true }),
    ],
    allocations: [alloc('car', 'bonds', 6000), alloc('trip', 'bonds', 2000), alloc('late', 'bonds', 1000)],
    horizonMonths: 3,
    today: '2026-10-17',
});
const liqOf = (id: string) => routed.liquidity.find(i => i.goalId === id);
assertEq('car not due: not in liquidity', liqOf('car') ? 1 : 0, 0);
assertEq('car not due: allocation + cash on its portfolio', routed.invested[0].byPortfolio.get('bonds')!.allocated + routed.invested[0].byPortfolio.get('bonds')!.cash, 15000);
assertEq('trip due soon: cash 1,000 + 2,000 to sell', liqOf('trip')!.amount, 3000);
assertEq('trip divest', liqOf('trip')!.divest, 2000);
assertEq('sofa not invested: its cash, not the target', liqOf('sofa')!.amount, 500);
assertEq('late overdue: 1,000 to sell, no cash', liqOf('late')!.amount, 1000);
assertEq('archived left out', liqOf('old') ? 1 : 0, 0);
assertEq('liquidity total', routed.liquidityTotal, 4500);
assertEq('only car stays on a portfolio', routed.invested.length, 1);
const tr = buildExpensePlanningTargets({
    emergency: null, emergencyPortfolioIds: [],
    goals: [goal('trip', 4000, 1000, { targetDate: '2026-12-15' })],
    allocations: [alloc('trip', 'bonds', 2000)],
    horizonMonths: 3, today: '2026-10-17',
});
assertEq('a due capex leaves its portfolio (to be sold)', tr.get('bonds')?.total ?? 0, 0);

// With the maturity ladder: a capex further out whose portfolio holds the
// money in bonds maturing too late adds the bond to buy; a gap from holding
// too little is already in the allocations and is not added twice.
const ladderCase = (held: number) => {
    const goalsL = [goal('X', 5000, 0, { targetDate: '2029-12-01' }), goal('Y', 5000, 0, { targetDate: '2030-06-01' }), goal('Z', 5000, 0, { targetDate: '2027-04-30' })];
    const allocL = [alloc('X', 'sec', 5000), alloc('Y', 'sec', 5000), alloc('Z', 'sec', 5000)];
    const lad = buildMaturityLadder({ portfolios: [{ id: 'sec', name: 'Security', holdings: [{ key: 'BTP29', label: 'BTP29', value: held, kind: 'bond', maturityDate: '2029-06-01' }] }], goals: goalsL, allocations: allocL });
    return buildExpensePlanningTargets({
        emergency: null, emergencyPortfolioIds: [], goals: goalsL, allocations: allocL, horizonMonths: 3, today: '2026-10-17',
        ladder: lad.goals, heldByPortfolio: { sec: held },
    }).get('sec')!;
};
assertEq('10k held for 15k of capex: target 15k, nothing added', ladderCase(10000).capex, 15000);
assertEq('15k held, 5k of it unclaimed: Z is covered by selling it, nothing to buy', ladderCase(15000).capex, 15000);
assertEq('no bond to buy on Z', ladderCase(15000).capexItems.find(c => c.goalId === 'Z')!.toBuy, 0);

// Due soon with the ladder: only what is freed in time comes back, the rest is missing.
const dueGoals = [goal('S', 6000, 1000, { targetDate: '2026-12-01' })];
const dueAlloc = [alloc('S', 'p', 5000)];
const dueLad = buildMaturityLadder({ portfolios: [{ id: 'p', name: 'P', holdings: [{ key: 'B', label: 'B', value: 5000, kind: 'bond', maturityDate: '2028-01-01' }, { key: 'C', label: 'Cash', value: 2000, kind: 'cash' }] }], goals: dueGoals, allocations: dueAlloc });
const dueItem = capexRouting({ goals: dueGoals, allocations: dueAlloc, horizonMonths: 3, today: '2026-10-17', ladder: dueLad.goals }).liquidity[0];
assertEq('due soon: its cash', dueItem.cash, 1000);
assertEq('due soon: 2k cash + 3k by selling the unclaimed late bond come back', dueItem.divest, 5000);
assertEq('due soon: nothing missing', dueItem.missing ?? 0, 0);
assertEq('due soon: 6k on the accounts', dueItem.amount, 6000);

console.log('verify-expense-planning-targets: all checks passed');
