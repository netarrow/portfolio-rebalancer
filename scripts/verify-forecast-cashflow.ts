/**
 * Known-answer checks for the Forecast cash-flow table: that every row
 * reconciles (opening + income − planned expenses + market P/L = closing),
 * that the money lands in the period it is due, and that a Monte Carlo run
 * replayed on its own is the very run the ensemble scored.
 * Run with: npx tsx scripts/verify-forecast-cashflow.ts
 */
import type { Broker } from '../src/types';
import {
    calculateForecastWithState,
    runMonteCarloForecast,
    runMonteCarloScenario,
    type ForecastPortfolioInput,
} from '../src/utils/forecastCalculations';
import { buildCashflowTable } from '../src/utils/forecastCashflow';

let failures = 0;
const check = (label: string, actual: number, expected: number, tol = 1e-6) => {
    const ok = Math.abs(actual - expected) <= tol;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: actual=${actual} expected=${expected}`);
};
const checkTrue = (label: string, ok: boolean) => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const portfolios: ForecastPortfolioInput[] = [
    { id: 'p1', name: 'Growth', goalId: 'g1', currentValue: 100000 } as ForecastPortfolioInput,
];
const brokers: Broker[] = [{ id: 'b1', name: 'Broker', currentLiquidity: 20000 }];
const start = { totalValue: 120000, liquidityValue: 20000 };

// --- Deterministic path -----------------------------------------------------
// 12%/yr, +1000/month of net income, a 30k expense in year 2 that may erode
// liquidity. Nothing else moves money.
{
    const results = calculateForecastWithState(
        portfolios, brokers, 1500, 500, 3, { p1: 12 },
        [{ year: 2, amount: 30000, erosionAllowed: true }]
    );
    const table = buildCashflowTable(results, start, 'year');

    checkTrue('one row per year', table.rows.length === 3);
    check('income flow per year = 12 × (1500 − 500)', table.rows[0].income, 12000);
    check('planned expense booked in year 2', table.rows[1].plannedExpenses, 30000);
    check('no planned expense in year 1', table.rows[0].plannedExpenses, 0);
    // 12% on the 100k already invested, plus the compounding of each of the
    // twelve 1000€ contributions over the months left in the year.
    const r = Math.pow(1.12, 1 / 12) - 1;
    const contributionGain = 1000 * (((1 + r) * (Math.pow(1 + r, 12) - 1)) / r - 12);
    check('year-1 market P/L = 12% of the invested 100k plus growth on the new money',
        table.rows[0].marketPnl, 12000 + contributionGain, 1);

    // The reconciliation the table promises, row by row and in total.
    table.rows.forEach((r, i) => {
        const closes = r.openingValue + r.income - r.plannedExpenses + r.marketPnl;
        check(`row ${i + 1} reconciles`, closes, r.closingValue, 1e-6);
    });
    check('first row opens at today\'s net worth', table.rows[0].openingValue, 120000);
    check('rows chain: year 2 opens where year 1 closed',
        table.rows[1].openingValue, table.rows[0].closingValue);
    check('totals reconcile',
        table.totals.openingValue + table.totals.income - table.totals.plannedExpenses + table.totals.marketPnl,
        table.totals.closingValue, 1e-6);

    // Erosion: the 30k comes out of liquidity first, so liquidity drops.
    checkTrue('planned expense erodes liquidity in its year', table.rows[1].liquidityDelta < 0);

    // Monthly granularity: same money, finer rows.
    const monthly = buildCashflowTable(results, start, 'month');
    checkTrue('monthly granularity yields 36 rows', monthly.rows.length === 36);
    check('monthly totals match yearly totals', monthly.totals.marketPnl, table.totals.marketPnl, 1e-6);
    check('the expense sits in the first month of year 2', monthly.rows[12].plannedExpenses, 30000);
    check('a plain month carries no planned expense', monthly.rows[13].plannedExpenses, 0);

    // A rising deterministic path never dips: the 30k expense is a cash flow,
    // not a market loss, so it must not show up as a drawdown.
    checkTrue('spending 30k is not a drawdown', table.worstDrawdownPct === 0);
    checkTrue('the expense still lands in its row', table.rows[1].plannedExpenses === 30000);
}

// --- Monte Carlo scenarios --------------------------------------------------
{
    const vols = { p1: 18 };
    const summary = runMonteCarloForecast(
        portfolios, brokers, 1500, 500, 5, { p1: 7 }, vols,
        [{ year: 3, amount: 25000, erosionAllowed: true }],
        200, 4242
    );

    const replay = (run: number) => runMonteCarloScenario(
        portfolios, brokers, 1500, 500, 5, { p1: 7 }, vols,
        [{ year: 3, amount: 25000, erosionAllowed: true }], 4242, {}, {}, run
    );

    checkTrue('scenario run indexes are within the ensemble',
        [summary.scenarioRuns.p10, summary.scenarioRuns.p50, summary.scenarioRuns.p90]
            .every(i => i >= 0 && i < summary.simulations));

    const finals = (['p10', 'p50', 'p90'] as const).map(k => {
        const path = replay(summary.scenarioRuns[k]);
        return path[path.length - 1].totalValue;
    });
    checkTrue('pessimistic ≤ median ≤ optimistic', finals[0] <= finals[1] && finals[1] <= finals[2]);

    // The replayed run must BE the run the ensemble scored, not a lookalike.
    check('median run ends within 1% of the ensemble median', finals[1], summary.finalP50, summary.finalP50 * 0.01);

    const a = replay(summary.scenarioRuns.p50);
    const b = replay(summary.scenarioRuns.p50);
    checkTrue('replaying the same run twice is identical',
        a.every((r, i) => r.totalValue === b[i].totalValue));

    const table = buildCashflowTable(a, start, 'year');
    table.rows.forEach((r, i) => {
        const closes = r.openingValue + r.income - r.plannedExpenses + r.marketPnl;
        check(`MC row ${i + 1} reconciles`, closes, r.closingValue, 1e-6);
    });
    checkTrue('MC rows carry the random ups and downs',
        table.rows.some(r => r.marketPnl < 0) || table.worstDrawdownPct < 0);
    checkTrue('dips are never positive', table.rows.every(r => r.drawdownPct <= 0));
    check('the worst dip is the deepest of the rows',
        table.worstDrawdownPct, Math.min(0, ...table.rows.map(r => r.drawdownPct)), 1e-9);

    // A pessimistic path must dip at some point — that is what it is for.
    const pess = buildCashflowTable(replay(summary.scenarioRuns.p10), start, 'month');
    checkTrue('the pessimistic path goes under water', pess.worstDrawdownPct < 0);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures > 0 ? 1 : 0);
