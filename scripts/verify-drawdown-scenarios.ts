// Known-answer checks for the Forecast's scripted drawdowns: that a scenario's
// severity follows the asset class and the portfolio's mix, that the classes do
// not all move together, that the path is a path (rallies inside the fall) and
// that the projection outside the crash window is untouched.
// Run with: npx esbuild scripts/verify-drawdown-scenarios.ts --bundle --format=esm | node --input-type=module
import type { Broker } from '../src/types';
import { calculateForecastWithState, type ForecastPortfolioInput } from '../src/utils/forecastCalculations';
import { buildCashflowTable } from '../src/utils/forecastCashflow';
import {
    DRAWDOWN_SCENARIOS,
    buildDrawdownSampler,
    classifyForShock,
    scenarioById,
    shockMixOf,
    summarizeDrawdown,
    type ShockMix,
} from '../src/utils/drawdownScenarios';

let failures = 0;
const check = (label: string, actual: number, expected: number, tol = 1e-9) => {
    const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: actual=${actual} expected=${expected}`);
};
const checkTrue = (label: string, ok: boolean) => {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

// A plan with one portfolio per class, so each class's shock is readable on its
// own, plus a mixed one to check the blending.
const mixes: Record<string, ShockMix> = {
    eq: { equity: 1 },
    bondL: { bondLong: 1 },
    bondS: { bondShort: 1 },
    cash: { cash: 1 },
    gold: { gold: 1 },
    btc: { crypto: 1 },
    mixed: { equity: 0.4, bondShort: 0.6 },
};
const returns: Record<string, number> = { eq: 7, bondL: 3, bondS: 1, cash: 2, gold: 4, btc: 20, mixed: 5 };
const values: Record<string, number> = { eq: 100000, bondL: 0, bondS: 0, cash: 0, gold: 0, btc: 0, mixed: 0 };

/** Compound a sampler over `months`, stripping the drift so only the shock is left. */
const shockPath = (
    sampler: (pid: string, m: number) => number,
    pid: string,
    months: number
): number[] => {
    const drift = Math.pow(1 + returns[pid] / 100, 1 / 12) - 1;
    const path = [1];
    for (let m = 1; m <= months; m++) {
        const total = 1 + sampler(pid, m);
        path.push(path[path.length - 1] * (total / (1 + drift)));
    }
    return path;
};

// ── 1. Classification ───────────────────────────────────────────────────────
{
    checkTrue('a stock is equity', classifyForShock('Stock', 'International') === 'equity');
    checkTrue('a long bond is long', classifyForShock('Bond', 'Long') === 'bondLong');
    checkTrue('a short bond is short', classifyForShock('Bond', 'Short') === 'bondShort');
    checkTrue('an unlabelled bond is medium duration', classifyForShock('Bond') === 'bondMedium');
    checkTrue('gold is gold', classifyForShock('Commodity', 'Gold') === 'gold');
    checkTrue('crypto is crypto', classifyForShock('Crypto') === 'crypto');
    checkTrue('cash is the money market', classifyForShock('Cash') === 'cash');

    const mix = shockMixOf([
        { assetClass: 'Stock', assetSubClass: 'International', currentValue: 75 },
        { assetClass: 'Bond', assetSubClass: 'Short', currentValue: 25 },
        { assetClass: 'Bond', assetSubClass: 'Long', currentValue: 0 },
    ]);
    check('the mix is by value', mix.equity ?? 0, 0.75, 1e-12);
    check('and it sums to one', (mix.equity ?? 0) + (mix.bondShort ?? 0), 1, 1e-12);
    checkTrue('a position worth nothing is not a class', !('bondLong' in mix));
    checkTrue('an empty portfolio has no mix', Object.keys(shockMixOf([])).length === 0);
}

// ── 2. The severity is the class's, and the trough is exact ─────────────────
{
    const scenario = scenarioById('systemic')!;
    const sampler = buildDrawdownSampler(mixes, returns, scenario, { startMonth: 13, seed: 7 });
    const window = scenario.crashMonths + scenario.recoveryMonths;
    const at = (pid: string, monthsIn: number) => shockPath(sampler, pid, 12 + window)[12 + monthsIn];

    check('equity halves at the trough', at('eq', scenario.crashMonths) - 1, -0.50, 1e-9);
    check('the long end sells off too, but 4%', at('bondL', scenario.crashMonths) - 1, -0.04, 1e-9);
    check('the money market moves by two tenths', at('cash', scenario.crashMonths) - 1, -0.002, 1e-9);
    check('gold is bid', at('gold', scenario.crashMonths) - 1, 0.12, 1e-9);
    check('crypto is devastated', at('btc', scenario.crashMonths) - 1, -0.75, 1e-9);
    // 40% equity + 60% short bonds cannot lose 50%: the mix decides.
    check('a mixed portfolio falls by its own mix',
        at('mixed', scenario.crashMonths) - 1, 0.4 * -0.50 + 0.6 * -0.005, 1e-9);
    checkTrue('and that is far shallower than pure equity',
        at('mixed', scenario.crashMonths) > at('eq', scenario.crashMonths) + 0.2);

    const impact = summarizeDrawdown(mixes, values, scenario);
    check('the readout agrees with the simulated trough', impact.byPortfolio.eq, -0.50, 1e-12);
    check('the blended figure follows the money', impact.blended, -0.50, 1e-12);
    checkTrue('the worst-hit portfolio is named first', impact.worst[0].portfolioId === 'btc');
}

// ── 3. Nothing moves in lockstep ────────────────────────────────────────────
{
    const scenario = scenarioById('bear')!;
    const sampler = buildDrawdownSampler(mixes, returns, scenario, { startMonth: 1, seed: 99 });
    const months = scenario.crashMonths + scenario.recoveryMonths;

    const monthly = (pid: string) => {
        const drift = Math.pow(1 + returns[pid] / 100, 1 / 12) - 1;
        return Array.from({ length: months }, (_, i) => (1 + sampler(pid, i + 1)) / (1 + drift) - 1);
    };
    const eq = monthly('eq');
    const gold = monthly('gold');
    const bondS = monthly('bondS');

    const corr = (a: number[], b: number[]) => {
        const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
        const ma = mean(a), mb = mean(b);
        const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
        const va = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0));
        const vb = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0));
        return va > 0 && vb > 0 ? cov / (va * vb) : 0;
    };

    checkTrue('equity and gold are not the same series', corr(eq, gold) < 0.9);
    checkTrue('equity and short bonds are not the same series', corr(eq, bondS) < 0.9);
    checkTrue('a month exists where equity falls and gold rises',
        eq.some((v, i) => v < 0 && gold[i] > 0));
    // A crash that only ever ticks down is a step function, not a market.
    checkTrue('there are bear-market rallies inside the fall',
        eq.slice(0, scenario.crashMonths).some(v => v > 0));
    checkTrue('and red months inside the recovery',
        eq.slice(scenario.crashMonths).some(v => v < 0));
    checkTrue('the money market never swings like equity',
        monthly('cash').every(v => Math.abs(v) < 0.01));
}

// ── 4. Rates: the damage lands on duration, not on stocks ───────────────────
{
    const scenario = scenarioById('rates')!;
    const sampler = buildDrawdownSampler(mixes, returns, scenario, { startMonth: 1, seed: 3 });
    const trough = (pid: string) => shockPath(sampler, pid, scenario.crashMonths)[scenario.crashMonths] - 1;

    check('the long end takes 30%', trough('bondL'), -0.30, 1e-9);
    checkTrue('more than equity does', trough('bondL') < trough('eq'));
    checkTrue('and far more than the short end', trough('bondL') < trough('bondS') - 0.2);
    // The other scenarios are the other direction: duration is a refuge.
    const bear = scenarioById('bear')!;
    checkTrue('a flight to quality lifts the long end instead', bear.classes.bondLong.trough > 0);
    checkTrue('while a rate shock sinks it', scenario.classes.bondLong.trough < 0);
}

// ── 5. The ladder the classes are read on ───────────────────────────────────
{
    const equityTroughs = DRAWDOWN_SCENARIOS.map(s => s.classes.equity.trough);
    checkTrue('every scenario is a fall for equity', equityTroughs.every(t => t < 0));
    checkTrue('the ladder spans a correction to a lost decade',
        Math.max(...equityTroughs.map(Math.abs)) >= 0.8 && Math.min(...equityTroughs.map(Math.abs)) <= 0.2);
    checkTrue('the money market is never hit for more than half a percent',
        DRAWDOWN_SCENARIOS.every(s => Math.abs(s.classes.cash.trough) <= 0.005));
    checkTrue('crypto always moves more than equity',
        DRAWDOWN_SCENARIOS.every(s => Math.abs(s.classes.crypto.trough) > Math.abs(s.classes.equity.trough)));
    checkTrue('short bonds always move less than long ones',
        DRAWDOWN_SCENARIOS.every(s => Math.abs(s.classes.bondShort.trough) < Math.abs(s.classes.bondLong.trough)));
}

// ── 6. Outside the window nothing changes ───────────────────────────────────
{
    const scenario = scenarioById('correction')!;
    const start = 25;
    const sampler = buildDrawdownSampler(mixes, returns, scenario, { startMonth: start, seed: 11 });
    const drift = Math.pow(1 + returns.eq / 100, 1 / 12) - 1;

    for (const m of [1, 12, 24]) check(`month ${m} is the plain drift`, sampler('eq', m), drift, 1e-12);
    checkTrue('the crash starts exactly on its month', sampler('eq', start) !== drift);
    const end = start + scenario.crashMonths + scenario.recoveryMonths;
    check('and the month after the window is drift again', sampler('eq', end), drift, 1e-12);

    // Same seed, same crash; another seed, another crash — same severity.
    const again = buildDrawdownSampler(mixes, returns, scenario, { startMonth: start, seed: 11 });
    const other = buildDrawdownSampler(mixes, returns, scenario, { startMonth: start, seed: 12 });
    checkTrue('a seed replays the same path',
        [0, 1, 2, 3].every(i => sampler('eq', start + i) === again('eq', start + i)));
    checkTrue('a re-roll gives a different path',
        [0, 1, 2, 3].some(i => sampler('eq', start + i) !== other('eq', start + i)));
    check('but the same trough',
        shockPath(other, 'eq', start + scenario.crashMonths - 1)[start + scenario.crashMonths - 1] - 1,
        -0.20, 1e-9);

    // A portfolio the scenario knows nothing about keeps its drift.
    check('an unknown portfolio is left alone', sampler('nope', start), 0, 1e-12);
}

// ── 7. In the projection: the market column finally goes red ────────────────
{
    const portfolios: ForecastPortfolioInput[] = [
        { id: 'eq', name: 'Equity', goalId: 'g1', currentValue: 200000 } as ForecastPortfolioInput,
        { id: 'bondS', name: 'Short bonds', goalId: 'g2', currentValue: 100000 } as ForecastPortfolioInput,
    ];
    const brokers: Broker[] = [{ id: 'b1', name: 'Broker', currentLiquidity: 20000 }];
    const start = { totalValue: 320000, liquidityValue: 20000 };
    const scenario = scenarioById('systemic')!;
    const planReturns = { eq: 7, bondS: 1 };
    const planMixes: Record<string, ShockMix> = { eq: { equity: 1 }, bondS: { bondShort: 1 } };

    const calm = calculateForecastWithState(portfolios, brokers, 1000, 0, 10, planReturns, []);
    const sampler = buildDrawdownSampler(planMixes, planReturns, scenario, { startMonth: 25, seed: 5 });
    const crashed = calculateForecastWithState(portfolios, brokers, 1000, 0, 10, planReturns, [], sampler);

    const calmTable = buildCashflowTable(calm, start, 'year');
    const crashTable = buildCashflowTable(crashed, start, 'year');

    checkTrue('the calm projection never loses money to the market',
        calmTable.rows.every(r => r.marketPnl >= 0));
    checkTrue('the crash does', crashTable.rows.some(r => r.marketPnl < 0));
    checkTrue('and the table reports the dip', crashTable.worstDrawdownPct < -5);
    checkTrue('the first two years are untouched',
        crashTable.rows.slice(0, 3).every((r, i) => Math.abs(r.closingValue - calmTable.rows[i].closingValue) < 1e-6));
    checkTrue('the crash costs net worth against the calm run',
        crashTable.rows[crashTable.rows.length - 1].closingValue < calmTable.rows[calmTable.rows.length - 1].closingValue);
    // Two thirds equity at −50%, one third short bonds at −0.5%: a third of the
    // invested capital, not a half — the plan's own mix, not the headline.
    const impact = summarizeDrawdown(planMixes, { eq: 200000, bondS: 100000 }, scenario);
    check('the blended severity is the plan\'s, not equity\'s',
        impact.blended, (200000 * -0.5 + 100000 * -0.005) / 300000, 1e-12);
    checkTrue('every row still reconciles',
        crashTable.rows.every(r => Math.abs(r.openingValue + r.income - r.plannedExpenses + r.marketPnl - r.closingValue) < 1e-6));
}

console.log(failures === 0 ? '\nAll drawdown checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures > 0 ? 1 : 0);
