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
 * it (proceeds leave the scope). Coupons/dividends count as negative flows
 * too: cash generated by the scope that leaves it — so TWR-style returns
 * credit distributions as performance instead of ignoring them (a bond's
 * clean-price series alone would understate its total return and Sharpe).
 */
export function getCashFlowsByDate(
    transactions: Transaction[],
    portfolioId?: string,
    opts: { includeDistributions?: boolean } = {}
): Map<string, number> {
    const includeDistributions = opts.includeDistributions ?? true;
    const flows = new Map<string, number>();
    for (const tx of transactions) {
        if (portfolioId && tx.portfolioId !== portfolioId) continue;
        if (!includeDistributions && isIncomeDirection(tx.direction || 'Buy')) continue;
        const date = (tx.date || '').slice(0, 10);
        const cost = (Number(tx.amount) || 0) * (Number(tx.price) || 0);
        const sign = (tx.direction || 'Buy') === 'Buy' ? 1 : -1;
        flows.set(date, (flows.get(date) || 0) + sign * cost);
    }
    return flows;
}

/**
 * Per-unit distribution flows for a single asset: each coupon/dividend of
 * `ticker` divided by the units held on that date, as a negative flow (cash
 * leaving the scope). Combined with the close-price series this makes
 * asset-scope returns total-return instead of price-only.
 */
export function getAssetDistributionFlows(
    transactions: Transaction[],
    ticker: string
): Map<string, number> {
    const key = ticker.toUpperCase();
    const holdings = buildHoldingsTimeline(transactions).get(key);
    const flows = new Map<string, number>();
    if (!holdings) return flows;
    for (const tx of transactions) {
        if (!isIncomeDirection(tx.direction || 'Buy')) continue;
        if (tx.ticker.toUpperCase() !== key) continue;
        const date = (tx.date || '').slice(0, 10);
        const amount = (Number(tx.amount) || 0) * (Number(tx.price) || 0);
        const qty = qtyAt(holdings, date);
        if (amount <= 0 || qty <= 0) continue;
        flows.set(date, (flows.get(date) || 0) - amount / qty);
    }
    return flows;
}

/**
 * Windowed flow lookup: net flow in the (fromExclusive, toInclusive] date
 * window. Exact-date lookups would silently drop flows dated between two axis
 * points (e.g. a coupon paid on a Saturday, when the price history has no
 * point), so returns are always computed against the aggregated window.
 */
function buildFlowWindow(cashFlows: Map<string, number>): (fromExclusive: string, toInclusive: string) => number {
    const dates = Array.from(cashFlows.keys()).sort();
    const prefix: number[] = [];
    let run = 0;
    for (const d of dates) { run += cashFlows.get(d)!; prefix.push(run); }
    const cumAt = (date: string): number => {
        let lo = 0, hi = dates.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (dates[mid] <= date) { ans = mid; lo = mid + 1; }
            else hi = mid - 1;
        }
        return ans >= 0 ? prefix[ans] : 0;
    };
    return (fromExclusive, toInclusive) => cumAt(toInclusive) - cumAt(fromExclusive);
}

/**
 * Time-Weighted Return (%) over a value series, given external cash flows by
 * date. Links daily returns with the window's flows removed from the
 * numerator, so contributions/withdrawals don't distort the result (unlike a
 * simple first-vs-last % change, which is money-weighted). Distributions,
 * being negative flows, are credited as return on their pay date.
 */
export function computeTWR(series: ValuePoint[], cashFlows: Map<string, number>): number {
    if (series.length < 2) return 0;
    const flowIn = buildFlowWindow(cashFlows);
    let factor = 1;
    for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1].value;
        if (prev <= 0) continue;
        const cf = flowIn(series[i - 1].date, series[i].date);
        factor *= (series[i].value - cf) / prev;
    }
    return (factor - 1) * 100;
}

export interface ReturnStats {
    twrPct: number;
    annualizedReturnPct: number;
    annualizedVolatilityPct: number | null; // null with too few points
    sharpe: number | null;                  // null when volatility is 0/unknown
    maxDrawdownPct: number;                 // ≤ 0
    maxDrawdownDate: string | null;
    years: number;
}

/**
 * Return/risk metrics on the flow-adjusted return stream (same daily factors
 * TWR links, so deposits/withdrawals don't show up as gains or losses):
 * annualized return and volatility, Sharpe (vs `riskFreePct`, default 0) and
 * max drawdown measured on the TWR index — NOT on the raw value series, where
 * a withdrawal would read as a crash.
 */
export function computeReturnStats(
    series: ValuePoint[],
    cashFlows: Map<string, number>,
    opts: { riskFreePct?: number; minReturns?: number } = {}
): ReturnStats | null {
    if (series.length < 2) return null;
    const flowIn = buildFlowWindow(cashFlows);
    const factors: number[] = [];
    const dates: string[] = [];
    for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1].value;
        if (prev <= 0) continue;
        const cf = flowIn(series[i - 1].date, series[i].date);
        factors.push((series[i].value - cf) / prev);
        dates.push(series[i].date);
    }
    if (factors.length === 0) return null;

    const msPerYear = 365.25 * 86400000;
    const years = Math.max(
        (Date.parse(series[series.length - 1].date) - Date.parse(series[0].date)) / msPerYear,
        1 / 365.25
    );

    let index = 1, peak = 1, maxDD = 0;
    let maxDDDate: string | null = null;
    for (let i = 0; i < factors.length; i++) {
        index *= factors[i];
        if (index > peak) peak = index;
        const dd = index / peak - 1;
        if (dd < maxDD) { maxDD = dd; maxDDDate = dates[i]; }
    }

    const totalFactor = factors.reduce((a, b) => a * b, 1);
    const twrPct = (totalFactor - 1) * 100;
    const annualizedReturnPct = totalFactor > 0
        ? (Math.pow(totalFactor, 1 / years) - 1) * 100
        : -100;

    // Annualized volatility from log-returns; the axis is irregular (business
    // days, monthly NAVs, gaps), so periods-per-year is estimated from the
    // actual observation density instead of assuming 252.
    const minReturns = opts.minReturns ?? 5;
    const logrets = factors.filter(f => f > 0).map(f => Math.log(f));
    let annualizedVolatilityPct: number | null = null;
    if (logrets.length >= minReturns) {
        const mean = logrets.reduce((a, b) => a + b, 0) / logrets.length;
        const variance = logrets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (logrets.length - 1);
        const periodsPerYear = logrets.length / years;
        annualizedVolatilityPct = Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100;
    }

    const riskFree = opts.riskFreePct ?? 0;
    // 1e-6 %: below floating-point noise a Sharpe ratio is meaningless
    const sharpe = annualizedVolatilityPct !== null && annualizedVolatilityPct > 1e-6
        ? (annualizedReturnPct - riskFree) / annualizedVolatilityPct
        : null;

    return {
        twrPct,
        annualizedReturnPct,
        annualizedVolatilityPct,
        sharpe,
        maxDrawdownPct: maxDD * 100,
        maxDrawdownDate: maxDDDate,
        years,
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
 * Uninvested-proceeds timeline: cash received from sells/coupons that has not
 * yet been consumed by later buys, per date (floored at 0 — buys beyond the
 * bucket are funded by external deposits, which are not tracked). Used to make
 * the liquidity overlay time-varying, so a sell followed by a re-buy days
 * later doesn't paint a fake crash in the value chart.
 */
export function getUninvestedProceedsTimeline(
    transactions: Transaction[],
    portfolioId?: string
): Timeline {
    const byDate = new Map<string, number>(); // +proceeds/income, -buy cost
    for (const tx of transactions) {
        if (portfolioId && tx.portfolioId !== portfolioId) continue;
        const date = (tx.date || '').slice(0, 10);
        const cost = (Number(tx.amount) || 0) * (Number(tx.price) || 0);
        const sign = (tx.direction || 'Buy') === 'Buy' ? -1 : 1; // Sell/Dividend/Coupon add cash
        byDate.set(date, (byDate.get(date) || 0) + sign * cost);
    }
    const timeline: Timeline = [];
    let bucket = 0;
    for (const [date, delta] of Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        bucket = Math.max(0, bucket + delta);
        timeline.push([date, bucket]);
    }
    return timeline;
}

/**
 * Net worth = all portfolios/transactions combined, plus an optional liquidity
 * overlay. Liquidity has no history of its own, so it is anchored to today's
 * broker cash and varied backwards using the uninvested-proceeds timeline:
 * right after a sell the proceeds stay in the series as cash instead of
 * vanishing until the next buy.
 */
export function getNetWorthSeries(
    transactions: Transaction[],
    priceHistory: PriceHistoryMap,
    opts: { from?: string; to?: string; liquidity?: number } = {}
): ValuePoint[] {
    const base = getPortfolioValueSeries(transactions, priceHistory, { from: opts.from, to: opts.to });
    const liquidity = opts.liquidity ?? 0;
    if (liquidity === 0) return base;
    const proceeds = getUninvestedProceedsTimeline(transactions);
    const bucketEnd = proceeds.length > 0 ? proceeds[proceeds.length - 1][1] : 0;
    return base.map(p => {
        const bucketAt = valueAtOrBefore(proceeds, p.date);
        // Today's liquidity already contains today's uninvested proceeds:
        // shift the anchor so the overlay ends exactly at `liquidity`.
        const overlay = Math.max(0, liquidity - bucketEnd + bucketAt);
        return { date: p.date, value: p.value + overlay };
    });
}
