// Known-answer checks for the Asset Allocation modes "From Expense Planning"
// (fund portfolios get the whole emergency fund target; capex portfolios get
// what each capex still needs beyond cash) and "Take the rest".
// Run with: npx esbuild scripts/verify-expense-planning-targets.ts --bundle --format=esm | node --input-type=module
import { buildExpensePlanningTargets, targetsByRow } from '../src/utils/expensePlanningTargets';
import { calculateAssetAllocation, withExpenseTargets, normalizeAssetAllocationSettings } from '../src/utils/assetAllocation';
import type { EmergencyCoverage } from '../src/utils/ynabCoverage';
import type { YnabGoal, YnabGoalAllocation } from '../src/types';

const assertEq = (label: string, actual: number, expected: number, tol = 0.01) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
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
        goal('car', 25000, 9000),                       // 16,000 to invest
        goal('house', 60000, 60000),                    // covered by cash: nothing
        goal('old', 5000, 0, { archived: true }),       // archived: nothing
    ],
    allocations: [alloc('car', 'bonds', 3000), alloc('car', 'money', 1000)],
});

// The whole 12,000 target, in equal parts over the two fund portfolios.
assertEq('fund on money = 12,000 / 2', t.get('money')!.fund, 6000);
assertEq('fund on money2 = 12,000 / 2', t.get('money2')!.fund, 6000);
assertEq('car need on bonds = 16,000 × 3/4', t.get('bonds')!.capex, 12000);
assertEq('car need on money = 16,000 × 1/4', t.get('money')!.capex, 4000);
assertEq('money adds fund and capex', t.get('money')!.total, 10000);
assertEq('a capex covered by cash adds nothing', [...t.values()].reduce((s, x) => s + x.capexItems.filter(c => c.goalId === 'house').length, 0), 0);

// A group row adds up its members.
const rows = targetsByRow(t, id => (id === 'money' || id === 'money2' ? 'grp' : undefined));
assertEq('group row = both fund portfolios', rows.get('grp')!.total, 10000 + 6000);

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
assertEq('expense row target = 12,000', r.portfolios.find(p => p.portfolioId === 'bonds')!.targetValue, 12000);
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

console.log('verify-expense-planning-targets: all checks passed');
