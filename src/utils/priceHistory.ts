import type { PricePoint, PriceHistoryMap, TickerPriceHistory } from '../types';

// Pure helpers for the per-ticker price history kept in localStorage
// (portfolio_price_history). All functions return new objects/arrays so they
// compose with React state updates.

/** Union of two point lists by date; incoming wins on conflicts; sorted ascending. */
export function mergePoints(existing: PricePoint[], incoming: PricePoint[]): PricePoint[] {
    const byDate = new Map<string, number>();
    for (const [date, price] of existing) byDate.set(date, price);
    for (const [date, price] of incoming) byDate.set(date, price);
    return Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

/** Drop points older than maxYears from the most recent point. */
export function trimHistory(points: PricePoint[], maxYears = 10): PricePoint[] {
    if (points.length === 0) return points;
    const lastDate = points[points.length - 1][0];
    const cutoff = new Date(lastDate);
    cutoff.setFullYear(cutoff.getFullYear() - maxYears);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    return points.filter(([date]) => date >= cutoffISO);
}

export interface HistoryMeta {
    granularity: 'D' | 'M';
    priceBasis?: 'clean' | 'dirty';
    lastHistoryFetch?: string;
}

/** Merge a batch of fetched points (backfill) into the map for one ticker. */
export function upsertTickerHistory(
    map: PriceHistoryMap,
    ticker: string,
    points: PricePoint[],
    meta: HistoryMeta
): PriceHistoryMap {
    const key = ticker.toUpperCase();
    const existing = map[key];
    return {
        ...map,
        [key]: {
            points: trimHistory(mergePoints(existing?.points ?? [], points)),
            granularity: meta.granularity,
            priceBasis: meta.priceBasis ?? existing?.priceBasis,
            lastHistoryFetch: meta.lastHistoryFetch ?? new Date().toISOString(),
        },
    };
}

/**
 * Upsert today's point from a regular price update. Skipped for series marked
 * 'clean' (MOT bonds): the live price is tel quel and would corrupt the
 * corso-secco series with a jump on the last point.
 */
export function appendDailySnapshot(
    map: PriceHistoryMap,
    ticker: string,
    price: number,
    dateISO: string
): PriceHistoryMap {
    const key = ticker.toUpperCase();
    const existing = map[key];
    if (existing?.priceBasis === 'clean') return map;
    const history: TickerPriceHistory = existing ?? { points: [], granularity: 'D' };
    return {
        ...map,
        [key]: { ...history, points: mergePoints(history.points, [[dateISO, price]]) },
    };
}

/** Price at a given date with carry-forward (last point on or before `date`). */
export function priceAt(history: TickerPriceHistory | undefined, date: string): number | null {
    if (!history || history.points.length === 0) return null;
    const points = history.points;
    if (date < points[0][0]) return null;
    // Binary search for the last point with point.date <= date
    let lo = 0, hi = points.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid][0] <= date) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans >= 0 ? points[ans][1] : null;
}

export type MarketDataMap = Record<string, { price: number; lastUpdated: string; spreadPercent?: number | null; volatility?: number | null; indexationCoefficient?: number | null }>;

/**
 * Market data enriched with the freshest local-history close: tickers whose
 * history has a point newer than (or missing from) the last price update are
 * valued at that close — the same price the Performance view uses — so the
 * Dashboard and the Performance net worth agree. Clean-basis series (MOT
 * bonds, corso secco) are skipped: their closes are not comparable with the
 * tel-quel live price.
 */
export function mergeLatestCloses(marketData: MarketDataMap, history: PriceHistoryMap): MarketDataMap {
    let out = marketData;
    for (const [ticker, h] of Object.entries(history)) {
        if (!h || h.priceBasis === 'clean' || h.points.length === 0) continue;
        const [date, price] = h.points[h.points.length - 1];
        const existing = marketData[ticker];
        if (existing && existing.lastUpdated.slice(0, 10) >= date) continue;
        if (out === marketData) out = { ...marketData };
        out[ticker] = { price, lastUpdated: date };
    }
    return out;
}

/** Merge or replace an imported history map (separate backup JSON). */
export function mergeHistoryMaps(
    current: PriceHistoryMap,
    imported: PriceHistoryMap,
    mode: 'merge' | 'replace'
): PriceHistoryMap {
    if (mode === 'replace') return imported;
    const out: PriceHistoryMap = { ...current };
    for (const [ticker, incoming] of Object.entries(imported)) {
        const key = ticker.toUpperCase();
        const existing = out[key];
        out[key] = existing
            ? {
                points: trimHistory(mergePoints(existing.points, incoming.points)),
                granularity: incoming.granularity ?? existing.granularity,
                priceBasis: incoming.priceBasis ?? existing.priceBasis,
                lastHistoryFetch: incoming.lastHistoryFetch ?? existing.lastHistoryFetch,
            }
            : incoming;
    }
    return out;
}
