import type { Transaction, PriceHistoryMap, TickerPriceHistory } from '../types';
import { CASH_TICKER_PREFIX, isIncomeDirection } from '../types';
import { priceAt } from './priceHistory';

// Builds value-over-time series for assets, portfolios and net worth by
// combining the transaction log (holdings by date) with the local price
// history (close price by date, carry-forward).

export interface ValuePoint {
    date: string; // YYYY-MM-DD
    value: number;
}

type Timeline = Array<[string, number]>; // [date, cumulative quantity] ascending

/** Cumulative quantity per ticker over time (Buy/Sell only). */
export function buildHoldingsTimeline(
    transactions: Transaction[],
    portfolioId?: string
): Map<string, Timeline> {
    const grouped = new Map<string, Transaction[]>();
    for (const tx of transactions) {
        if (isIncomeDirection(tx.direction || 'Buy')) continue;
        if (portfolioId && tx.portfolioId !== portfolioId) continue;
        const key = tx.ticker.toUpperCase();
        const list = grouped.get(key);
        if (list) list.push(tx); else grouped.set(key, [tx]);
    }

    const result = new Map<string, Timeline>();
    for (const [ticker, txs] of grouped) {
        txs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        const timeline: Timeline = [];
        let qty = 0;
        for (const tx of txs) {
            const amount = Number(tx.amount) || 0;
            qty += (tx.direction || 'Buy') === 'Buy' ? amount : -amount;
            const date = (tx.date || '').slice(0, 10);
            if (timeline.length > 0 && timeline[timeline.length - 1][0] === date) {
                timeline[timeline.length - 1][1] = qty;
            } else {
                timeline.push([date, qty]);
            }
        }
        result.set(ticker, timeline);
    }
    return result;
}

function valueAtOrBefore(timeline: Timeline, date: string): number {
    let lo = 0, hi = timeline.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (timeline[mid][0] <= date) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans >= 0 ? timeline[ans][1] : 0;
}

export const qtyAt = valueAtOrBefore;

/** Last transaction price on or before `date` (fallback when no history exists). */
function buildTxPriceTimeline(transactions: Transaction[], ticker: string): Timeline {
    const timeline: Timeline = [];
    const txs = transactions
        .filter(t => t.ticker.toUpperCase() === ticker && !isIncomeDirection(t.direction || 'Buy'))
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    for (const tx of txs) {
        const date = (tx.date || '').slice(0, 10);
        const price = Number(tx.price) || 0;
        if (timeline.length > 0 && timeline[timeline.length - 1][0] === date) {
            timeline[timeline.length - 1][1] = price;
        } else {
            timeline.push([date, price]);
        }
    }
    return timeline;
}

/**
 * Portfolio (or whole-account when portfolioId is omitted) value over time:
 * for each axis date, Σ over tickers of qty(date) × price(date).
 * Price resolution per ticker: cash tickers are worth 1; otherwise the price
 * history with carry-forward; otherwise the last transaction price (assets
 * without any history yet, e.g. CPRAM before snapshots accumulate).
 */
export function getPortfolioValueSeries(
    transactions: Transaction[],
    priceHistory: PriceHistoryMap,
    opts: { portfolioId?: string; from?: string; to?: string } = {}
): ValuePoint[] {
    const holdings = buildHoldingsTimeline(transactions, opts.portfolioId);
    if (holdings.size === 0) return [];

    // Date axis: union of history dates and transaction dates of involved tickers
    const dates = new Set<string>();
    let firstTxDate: string | null = null;
    for (const [ticker, timeline] of holdings) {
        if (timeline.length > 0) {
            const first = timeline[0][0];
            if (firstTxDate === null || first < firstTxDate) firstTxDate = first;
            for (const [date] of timeline) dates.add(date);
        }
        const history = priceHistory[ticker];
        if (history) for (const [date] of history.points) dates.add(date);
    }
    if (firstTxDate === null) return [];

    const from = opts.from && opts.from > firstTxDate ? opts.from : firstTxDate;
    const to = opts.to ?? '9999-12-31';
    const axis = Array.from(dates).filter(d => d >= from && d <= to).sort();

    const txPriceCache = new Map<string, Timeline>();
    const series: ValuePoint[] = [];
    for (const date of axis) {
        let total = 0;
        for (const [ticker, timeline] of holdings) {
            const qty = valueAtOrBefore(timeline, date);
            if (qty <= 0) continue;
            let price: number | null;
            if (ticker.startsWith(CASH_TICKER_PREFIX)) {
                price = 1;
            } else {
                price = priceAt(priceHistory[ticker], date);
                if (price === null) {
                    let txPrices = txPriceCache.get(ticker);
                    if (!txPrices) {
                        txPrices = buildTxPriceTimeline(transactions, ticker);
                        txPriceCache.set(ticker, txPrices);
                    }
                    price = valueAtOrBefore(txPrices, date);
                }
            }
            total += qty * price;
        }
        series.push({ date, value: total });
    }
    return series;
}

/**
 * Net external cash flow per date (Buy cost minus Sell proceeds, scoped by
 * portfolioId). A Buy injects external cash into the scope's value (the
 * money used to pay for it isn't part of the value series), a Sell removes
 * it (proceeds leave the scope). Used to strip cash-flow effects from TWR.
 */
export function getCashFlowsByDate(
    transactions: Transaction[],
    portfolioId?: string
): Map<string, number> {
    const flows = new Map<string, number>();
    for (const tx of transactions) {
        if (isIncomeDirection(tx.direction || 'Buy')) continue;
        if (portfolioId && tx.portfolioId !== portfolioId) continue;
        const date = (tx.date || '').slice(0, 10);
        const cost = (Number(tx.amount) || 0) * (Number(tx.price) || 0);
        const sign = (tx.direction || 'Buy') === 'Buy' ? 1 : -1;
        flows.set(date, (flows.get(date) || 0) + sign * cost);
    }
    return flows;
}

/**
 * Time-Weighted Return (%) over a value series, given external cash flows by
 * date. Links daily returns with same-day flows removed from the numerator,
 * so contributions/withdrawals don't distort the result (unlike a simple
 * first-vs-last % change, which is money-weighted).
 */
export function computeTWR(series: ValuePoint[], cashFlows: Map<string, number>): number {
    if (series.length < 2) return 0;
    let factor = 1;
    for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1].value;
        if (prev <= 0) continue;
        const cf = cashFlows.get(series[i].date) || 0;
        factor *= (series[i].value - cf) / prev;
    }
    return (factor - 1) * 100;
}

export interface RiskMetrics {
    volatility: number;      // annualized standard deviation of returns, in %
    sharpe: number;          // annualized Sharpe ratio (excess return / volatility)
    maxDrawdown: number;     // worst peak-to-trough decline, magnitude in % (>= 0)
    samples: number;         // number of period returns the metrics are based on
    periodsPerYear: number;  // annualization factor derived from the actual date span
}

/**
 * Risk metrics (annualized volatility, Sharpe ratio, max drawdown) for a value
 * series. Returns are computed per step with same-day external cash flows removed
 * from the numerator (same convention as computeTWR), so deposits/withdrawals
 * don't distort them. Max drawdown is measured on the compounded return index
 * (not raw value), so contributions can't masquerade as recoveries.
 *
 * The annualization factor is derived from the actual span of the series
 * (returns per year), which handles both daily and monthly axes as well as the
 * irregular date axis of portfolio value series. Returns null when there aren't
 * enough points. `riskFreeRate` is annual and expressed as a decimal (0.02 = 2%).
 */
export function computeRiskMetrics(
    series: ValuePoint[],
    cashFlows: Map<string, number>,
    opts: { riskFreeRate?: number } = {}
): RiskMetrics | null {
    if (series.length < 3) return null;
    const riskFreeRate = opts.riskFreeRate ?? 0;

    const returns: number[] = [];
    for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1].value;
        if (prev <= 0) continue;
        const cf = cashFlows.get(series[i].date) || 0;
        returns.push((series[i].value - cf) / prev - 1);
    }
    if (returns.length < 2) return null;

    // Annualization factor from the real time span (returns per year), robust to
    // the irregular / mixed-granularity date axes these series can have.
    const firstMs = new Date(series[0].date).getTime();
    const lastMs = new Date(series[series.length - 1].date).getTime();
    const years = Math.max((lastMs - firstMs) / (365.25 * 24 * 3600 * 1000), 1 / 365.25);
    const periodsPerYear = returns.length / years;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    const annualizedVol = stdDev * Math.sqrt(periodsPerYear);
    const annualizedReturn = mean * periodsPerYear;
    const sharpe = annualizedVol > 0 ? (annualizedReturn - riskFreeRate) / annualizedVol : 0;

    // Max drawdown on the compounded return index (starting at 1).
    let index = 1, peak = 1, maxDrawdown = 0;
    for (const r of returns) {
        index *= 1 + r;
        if (index > peak) peak = index;
        const drawdown = (index - peak) / peak;
        if (drawdown < maxDrawdown) maxDrawdown = drawdown;
    }

    return {
        volatility: annualizedVol * 100,
        sharpe,
        maxDrawdown: Math.abs(maxDrawdown) * 100,
        samples: returns.length,
        periodsPerYear,
    };
}

/** Close-price series for a single ticker within an optional range. */
export function getAssetPriceSeries(
    ticker: string,
    priceHistory: PriceHistoryMap,
    opts: { from?: string; to?: string } = {}
): ValuePoint[] {
    const history = priceHistory[ticker.toUpperCase()];
    if (!history) return [];
    const from = opts.from ?? '0000-01-01';
    const to = opts.to ?? '9999-12-31';
    return history.points
        .filter(([date]) => date >= from && date <= to)
        .map(([date, price]) => ({ date, value: price }));
}

/**
 * Annualized realized volatility (%) from a ticker's close-price history.
 * Std-dev of consecutive log-returns, annualized by granularity
 * (√252 for 'D', √12 for 'M'). Returns null when there aren't enough points
 * (no downloaded volatility and too little history → caller falls back to the
 * asset-class estimate).
 */
export function computeRealizedVolatility(
    history: TickerPriceHistory | undefined,
    opts: { minPoints?: number; lookbackYears?: number } = {}
): number | null {
    const minPoints = opts.minPoints ?? 8;
    const lookbackYears = opts.lookbackYears ?? 2;
    if (!history || !history.points || history.points.length < minPoints + 1) return null;

    // Keep only the recent window so the estimate reflects current volatility.
    let points = history.points;
    const lastDate = points[points.length - 1][0];
    const cutoff = new Date(lastDate);
    cutoff.setFullYear(cutoff.getFullYear() - lookbackYears);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    const windowed = points.filter(([date]) => date >= cutoffISO);
    // Use the window only if it still has enough data; otherwise fall back to all points.
    if (windowed.length >= minPoints + 1) points = windowed;

    // Consecutive log-returns over positive prices.
    const returns: number[] = [];
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1][1];
        const curr = points[i][1];
        if (prev > 0 && curr > 0) returns.push(Math.log(curr / prev));
    }
    if (returns.length < minPoints) return null;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    const periodsPerYear = history.granularity === 'M' ? 12 : 252;
    return stdDev * Math.sqrt(periodsPerYear) * 100;
}

/**
 * Net worth = all portfolios/transactions combined, plus an optional constant
 * liquidity overlay (broker + portfolio liquidity has no history, so it is
 * applied as today's value across the whole series).
 */
export function getNetWorthSeries(
    transactions: Transaction[],
    priceHistory: PriceHistoryMap,
    opts: { from?: string; to?: string; liquidity?: number } = {}
): ValuePoint[] {
    const base = getPortfolioValueSeries(transactions, priceHistory, { from: opts.from, to: opts.to });
    const liquidity = opts.liquidity ?? 0;
    if (liquidity === 0) return base;
    return base.map(p => ({ date: p.date, value: p.value + liquidity }));
}
