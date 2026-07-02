/**
 * Known-answer checks for performance metrics (TWR, return stats, volatility,
 * uninvested-proceeds overlay). Synthetic data only. Run with:
 *   npx tsx scripts/verify_performance_metrics.ts
 */
import {
    computeTWR,
    computeReturnStats,
    computeRealizedVolatility,
    getUninvestedProceedsTimeline,
    getNetWorthSeries,
    getCashFlowsByDate,
    getAssetDistributionFlows,
    type ValuePoint,
} from '../src/utils/performanceCalculations';
import type { Transaction, PriceHistoryMap } from '../src/types';

let failures = 0;
function check(name: string, actual: number | null, expected: number, tol = 1e-9) {
    const ok = actual !== null && Math.abs(actual - expected) <= tol;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: actual=${actual} expected=${expected}`);
}

// --- computeTWR -------------------------------------------------------------
check('TWR pure growth 100→110 = +10%',
    computeTWR([{ date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 110 }], new Map()),
    10);
check('TWR deposit stripped: 100→155 with +50 flow = +5%',
    computeTWR([{ date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 155 }], new Map([['2026-01-02', 50]])),
    5);
check('TWR withdrawal stripped: 100→55 with -50 flow = +5%',
    computeTWR([{ date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 55 }], new Map([['2026-01-02', -50]])),
    5);

// --- computeReturnStats -----------------------------------------------------
// One year, +21% in two legs (×1.10 × ×1.10), no flows.
{
    const series: ValuePoint[] = [
        { date: '2025-01-01', value: 100 },
        { date: '2025-07-02', value: 110 },
        { date: '2026-01-01', value: 121 },
    ];
    const stats = computeReturnStats(series, new Map());
    check('Stats TWR = +21%', stats!.twrPct, 21, 1e-6);
    check('Stats annualized ≈ +21% over ~1y', stats!.annualizedReturnPct, 21, 0.15);
    check('Stats maxDD = 0 (monotonic)', stats!.maxDrawdownPct, 0);
}

// A withdrawal must NOT count as a drawdown: 100 → sell 50 → 50 → 55.
{
    const series: ValuePoint[] = [
        { date: '2026-01-01', value: 100 },
        { date: '2026-01-02', value: 50 },
        { date: '2026-01-03', value: 55 },
    ];
    const stats = computeReturnStats(series, new Map([['2026-01-02', -50]]));
    check('Withdrawal is not a drawdown', stats!.maxDrawdownPct, 0);
    check('TWR with withdrawal = +10%', stats!.twrPct, 10, 1e-6);
}

// A real loss is a drawdown: 100 → 80 → 90 ⇒ maxDD -20%.
{
    const series: ValuePoint[] = [
        { date: '2026-01-01', value: 100 },
        { date: '2026-01-02', value: 80 },
        { date: '2026-01-03', value: 90 },
    ];
    const stats = computeReturnStats(series, new Map());
    check('Real loss maxDD = -20%', stats!.maxDrawdownPct, -20, 1e-9);
}

// Sharpe: constant returns ⇒ zero volatility ⇒ Sharpe null; noisy ⇒ finite.
{
    const flat: ValuePoint[] = [];
    for (let i = 0; i < 20; i++) flat.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, value: 100 * Math.pow(1.001, i) });
    const s1 = computeReturnStats(flat, new Map());
    check('Constant growth ⇒ volatility 0', s1!.annualizedVolatilityPct, 0, 1e-9);
    if (s1!.sharpe !== null) { failures++; console.log('FAIL  Sharpe should be null with zero volatility'); }
    else console.log('PASS  Sharpe null with zero volatility');

    const noisy: ValuePoint[] = [];
    let v = 100;
    for (let i = 0; i < 20; i++) { noisy.push({ date: `2026-02-${String(i + 1).padStart(2, '0')}`, value: v }); v *= i % 2 === 0 ? 1.02 : 0.99; }
    const s2 = computeReturnStats(noisy, new Map());
    if (s2!.sharpe === null || !isFinite(s2!.sharpe)) { failures++; console.log('FAIL  Sharpe finite on noisy series'); }
    else console.log(`PASS  Sharpe finite on noisy series (${s2!.sharpe.toFixed(2)})`);
}

// --- computeRealizedVolatility ----------------------------------------------
{
    const points: Array<[string, number]> = [];
    let p = 100;
    for (let i = 0; i < 40; i++) {
        points.push([new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), p]);
        p *= i % 2 === 0 ? 1.01 : 0.99;
    }
    const r1 = Math.log(1.01), r2 = Math.log(0.99);
    const rets: number[] = [];
    for (let i = 0; i < 39; i++) rets.push(i % 2 === 0 ? r1 : r2);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
    const expected = Math.sqrt(variance) * Math.sqrt(252) * 100;
    check('Realized volatility alternating ±1%', computeRealizedVolatility({ points, granularity: 'D' }), expected, 1e-6);
}

// --- Uninvested proceeds overlay ---------------------------------------------
// Buy 10×100 on day1, sell all on day3 @100, re-buy 10×100 on day5:
// the net-worth chart with liquidity anchored at 0 must NOT dip on day3/4.
{
    const txs: Transaction[] = [
        { id: '1', date: '2026-01-01', ticker: 'AAA', amount: 10, price: 100, direction: 'Buy' } as Transaction,
        { id: '2', date: '2026-01-03', ticker: 'AAA', amount: 10, price: 100, direction: 'Sell' } as Transaction,
        { id: '3', date: '2026-01-05', ticker: 'BBB', amount: 10, price: 100, direction: 'Buy' } as Transaction,
    ];
    const history: PriceHistoryMap = {
        AAA: { points: [['2026-01-01', 100], ['2026-01-02', 100], ['2026-01-03', 100], ['2026-01-04', 100], ['2026-01-05', 100]], granularity: 'D' },
        BBB: { points: [['2026-01-01', 100], ['2026-01-02', 100], ['2026-01-03', 100], ['2026-01-04', 100], ['2026-01-05', 100]], granularity: 'D' },
    };
    const proceeds = getUninvestedProceedsTimeline(txs);
    check('Bucket after sell = 1000', proceeds.find(([d]) => d === '2026-01-03')![1], 1000);
    check('Bucket after re-buy = 0', proceeds[proceeds.length - 1][1], 0);

    // liquidity today = 0 → overlay(t) = bucket(t) − bucketEnd anchored, floored
    const nw = getNetWorthSeries(txs, history, { liquidity: 0 });
    // liquidity 0 keeps legacy behaviour (no overlay): dip still visible
    check('liquidity=0 keeps raw series (dip on day 4)', nw.find(p => p.date === '2026-01-04')!.value, 0);

    const nw2 = getNetWorthSeries(txs, history, { liquidity: 50 });
    for (const p of nw2) {
        if (Math.abs(p.value - 1050) > 1e-9) {
            failures++;
            console.log(`FAIL  overlay keeps series flat, got ${p.value} on ${p.date}`);
        }
    }
    console.log('PASS  sell→re-buy no longer dips with liquidity overlay (flat 1050)');

    // And TWR on the raw series must still be 0% (no market move).
    const raw = getNetWorthSeries(txs, history, {});
    check('TWR flat market = 0%', computeTWR(raw, getCashFlowsByDate(txs)), 0, 1e-9);
}

// --- Distributions counted as return -----------------------------------------
// Flat clean price 100, coupon of 5 on an axis date: TWR must be +5%, not 0%.
{
    const txs: Transaction[] = [
        { id: '1', date: '2026-01-01', ticker: 'BOND', amount: 1, price: 100, direction: 'Buy' } as Transaction,
        { id: '2', date: '2026-01-03', ticker: 'BOND', amount: 5, price: 1, direction: 'Coupon' } as Transaction,
    ];
    const series: ValuePoint[] = [
        { date: '2026-01-01', value: 100 },
        { date: '2026-01-03', value: 100 },
        { date: '2026-01-05', value: 100 },
    ];
    check('Coupon on axis date counts as +5% TWR', computeTWR(series, getCashFlowsByDate(txs)), 5, 1e-9);
    const stats = computeReturnStats(series, getCashFlowsByDate(txs));
    check('Coupon in stats TWR too', stats!.twrPct, 5, 1e-9);
    check('Coupon is not a drawdown', stats!.maxDrawdownPct, 0);
}

// Coupon paid on a date BETWEEN two axis points (e.g. Saturday, no price
// point): the window aggregation must still credit it.
{
    const txs: Transaction[] = [
        { id: '1', date: '2026-01-01', ticker: 'BOND', amount: 1, price: 100, direction: 'Buy' } as Transaction,
        { id: '2', date: '2026-01-04', ticker: 'BOND', amount: 5, price: 1, direction: 'Coupon' } as Transaction, // between axis pts
    ];
    const series: ValuePoint[] = [
        { date: '2026-01-01', value: 100 },
        { date: '2026-01-03', value: 100 },
        { date: '2026-01-05', value: 100 },
    ];
    check('Weekend coupon still counted (+5% TWR)', computeTWR(series, getCashFlowsByDate(txs)), 5, 1e-9);
}

// Sell + coupon combined: growth 100→110 with a 10 withdrawal and a 5 coupon
// on the same day ⇒ factor (110 + 10 + 5)/100... value already net of the
// sell: V2 = 110-10 = 100; flows = -10 (sell) -5 (coupon) ⇒ (100+15)/100 = +15%.
{
    const txs: Transaction[] = [
        { id: '1', date: '2026-01-01', ticker: 'BOND', amount: 1, price: 100, direction: 'Buy' } as Transaction,
        { id: '2', date: '2026-01-02', ticker: 'BOND', amount: 0.0909, price: 110, direction: 'Sell' } as Transaction,
        { id: '3', date: '2026-01-02', ticker: 'BOND', amount: 5, price: 1, direction: 'Coupon' } as Transaction,
    ];
    const sellProceeds = 0.0909 * 110;
    const series: ValuePoint[] = [
        { date: '2026-01-01', value: 100 },
        { date: '2026-01-02', value: 110 - sellProceeds },
    ];
    check('Sell + coupon same day: TWR = +15%', computeTWR(series, getCashFlowsByDate(txs)), 15, 1e-6);
}

// Asset-scope per-unit distributions: 10 units held, coupon 20€ total ⇒ 2€/unit
// on a flat price of 100 ⇒ +2%.
{
    const txs: Transaction[] = [
        { id: '1', date: '2026-01-01', ticker: 'BOND', amount: 10, price: 100, direction: 'Buy' } as Transaction,
        { id: '2', date: '2026-01-03', ticker: 'BOND', amount: 20, price: 1, direction: 'Coupon' } as Transaction,
    ];
    const flows = getAssetDistributionFlows(txs, 'BOND');
    check('Per-unit distribution flow = -2', flows.get('2026-01-03') ?? 0, -2, 1e-9);
    const priceSeries: ValuePoint[] = [
        { date: '2026-01-01', value: 100 },
        { date: '2026-01-03', value: 100 },
    ];
    check('Asset-scope TWR with coupon = +2%', computeTWR(priceSeries, flows), 2, 1e-9);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures > 0 ? 1 : 0);
