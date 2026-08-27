// Known-answer checks for the per-expense liquidity-erosion switch: whether a
// planned expense drains broker liquidity before it touches the portfolios,
// and whether that choice survives a re-sync from the YNAB Goals section.
// Run with: npx esbuild scripts/verify-forecast-erosion.ts --bundle --format=esm | node --input-type=module
import type { Broker, Portfolio, PlannedForecastExpense, YnabGoal, YnabGoalAllocation } from '../src/types';
import { calculateForecastWithState, type ForecastPortfolioInput } from '../src/utils/forecastCalculations';
import { buildPlannedForecastExpenses } from '../src/utils/plannedForecastExpenses';

let failures = 0;

const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
    }
};

// A frozen world: no returns, no savings, no monthly expenses, so the only
// thing that moves money is the planned expense itself.
const portfolios: ForecastPortfolioInput[] = [
    { id: 'p1', name: 'Growth', goalId: 'g1', currentValue: 50000 } as ForecastPortfolioInput,
];
const brokers: Broker[] = [{ id: 'b1', name: 'Broker', currentLiquidity: 8000 }];

const runWith = (erosionAllowed: boolean) => {
    const months = calculateForecastWithState(
        portfolios, brokers, 0, 0, 2, { p1: 0 },
        [{ year: 1, amount: 5000, erosionAllowed }],
    );
    const end = months[months.length - 1];
    return { liquidity: Math.round(end.liquidityValue), invested: Math.round(end.investedValue) };
};

console.log('calculateForecastWithState — who pays the planned expense');
check('erosion on: liquidity pays first, portfolios untouched',
    runWith(true),
    { liquidity: 3000, invested: 50000 });
check('erosion off: liquidity is protected, the portfolio pays',
    runWith(false),
    { liquidity: 8000, invested: 45000 });

// Liquidity smaller than the expense: erosion drains it, the rest is sold.
const partial = calculateForecastWithState(
    portfolios, brokers, 0, 0, 2, { p1: 0 },
    [{ year: 1, amount: 12000, erosionAllowed: true }],
);
check('erosion on with too little liquidity: drained, remainder sold',
    { liquidity: Math.round(partial[partial.length - 1].liquidityValue), invested: Math.round(partial[partial.length - 1].investedValue) },
    { liquidity: 0, invested: 46000 });

console.log('buildPlannedForecastExpenses — the choice survives a re-sync');
const goals: YnabGoal[] = [
    { id: 'y1', ynabBudgetId: 'b', name: 'Computer', targetAmount: 2500, targetDate: '2030-12-31', cashCoverage: 0, targetSource: 'parsed-name', lastSyncedAt: '2026-08-27T00:00:00Z' },
    { id: 'y2', ynabBudgetId: 'b', name: 'Cambio Polo', targetAmount: 12000, targetDate: '2026-11-15', cashCoverage: 0, targetSource: 'parsed-name', lastSyncedAt: '2026-08-27T00:00:00Z' },
];
const allocations: YnabGoalAllocation[] = [];
const portfoliosForBuild: Portfolio[] = [{ id: 'p1', name: 'Growth', goalId: 'g1' } as Portfolio];

const first = buildPlannedForecastExpenses(goals, allocations, portfoliosForBuild);
check('a freshly imported expense protects liquidity by default',
    first.map(e => [e.description, e.erosionAllowed]),
    [['Cambio Polo', false], ['Computer', false]]);

const edited: PlannedForecastExpense[] = first.map(e =>
    e.id === 'y2' ? { ...e, erosionAllowed: true } : e);
const resynced = buildPlannedForecastExpenses(goals, allocations, portfoliosForBuild, edited);
check('a re-sync keeps the per-expense erosion flag',
    resynced.map(e => [e.description, e.erosionAllowed]),
    [['Cambio Polo', true], ['Computer', false]]);

const withNewGoal = buildPlannedForecastExpenses(
    [...goals, { id: 'y3', ynabBudgetId: 'b', name: 'Tenda', targetAmount: 3000, targetDate: '2028-06-30', cashCoverage: 0, targetSource: 'parsed-name', lastSyncedAt: '2026-08-27T00:00:00Z' }],
    allocations, portfoliosForBuild, edited);
check('a goal that was not in the plan before starts protected',
    withNewGoal.map(e => [e.description, e.erosionAllowed]),
    [['Cambio Polo', true], ['Tenda', false], ['Computer', false]]);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
if (failures > 0) process.exit(1);
