// Known-answer checks for the Expense Analysis savings measures: investments
// are saved money, never subtracted; operating savings count operating
// expenses only; spending drawn from previous years' savings is kept apart.
// Run with: npx esbuild scripts/verify-savings-measures.ts --bundle --format=esm | node --input-type=module
import { analyzeSpending } from '../src/utils/spendingAnalysis';
import type { YnabMacroMappings, YnabMonthSnapshot } from '../src/types';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};

// One month: €3,000 income. Rent 1,000 + food 400 + dining 100 = 1,500 operating.
// A dated expense of 500 with only 200 assigned this month (300 from past savings).
// 800 invested, of which 300 beyond what was assigned (old savings invested now).
const history: YnabMonthSnapshot[] = [{
    month: '2026-01-01', incomeMilliunits: 3_000_000, budgetedMilliunits: 0, activityMilliunits: 0, syncedAt: '',
    categories: [
        ['rent', 'g-home', 1000, 1000], ['food', 'g-food', 400, 400], ['dining', 'g-out', 100, 100],
        ['holiday', 'g-sink', 500, 200], ['etf', 'g-inv', 800, 500],
    ].map(([id, group, spent, budgeted]) => ({
        categoryId: id as string, name: id as string, groupId: group as string, groupName: group as string,
        budgetedMilliunits: (budgeted as number) * 1000, activityMilliunits: -(spent as number) * 1000,
    })),
}];
const mappings: YnabMacroMappings = {
    groups: { 'g-home': 'structural', 'g-food': 'variable', 'g-out': 'compressible', 'g-sink': 'sinking', 'g-inv': 'investments' },
    categories: {},
};

const a = analyzeSpending(history, mappings);
assertEq('total outflow still counts everything', a.totalOutflow, 2800);
assertEq('investments are tracked apart', a.investmentsOutflow, 800);
assertEq('spending = outflow − investments', a.spendingOutflow, 2000);
assertEq('operating savings = income − operating expenses', a.operatingSavings, 1500);
assertEq('drawn from past savings excludes old savings invested now', a.pastSavingsOnSpending, 300);
assertEq('savings from income = income − spending paid by income', a.savingsFromIncome, 1300);
assertEq('net savings = income − spending (investments not subtracted)', a.netSavings, 1000);
assertEq('net savings = savings from income − drawn from past savings', a.netSavings, a.savingsFromIncome - a.pastSavingsOnSpending);
assertEq('savings rate on net savings', a.savingsRate!, 1000 / 3000);

console.log('verify-savings-measures: all checks passed');
