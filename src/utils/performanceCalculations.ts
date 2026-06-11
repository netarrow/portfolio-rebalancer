import type { Transaction, PriceHistoryMap } from '../types';
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
