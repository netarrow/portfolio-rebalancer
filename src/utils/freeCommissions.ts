import type { FreeCommissionPeriod } from '../types';

/** 'YYYY-MM' key of an ISO date string ('YYYY-MM-DD...'). */
export const monthKeyOfDate = (isoDate: string): string => (isoDate || '').slice(0, 7);

/** 'YYYY-MM' key of today, in local time (avoids UTC rollover at month boundaries). */
export const currentMonthKey = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Human label for a 'YYYY-MM' key, e.g. 'July 2026'. */
export const formatMonthKey = (monthKey: string): string => {
    const [y, m] = monthKey.split('-').map(Number);
    if (!y || !m) return monthKey;
    return new Date(y, m - 1, 1).toLocaleDateString('en-IE', { month: 'long', year: 'numeric' });
};

/**
 * Extracts ISIN-looking tokens from free text (2 country letters + 9
 * alphanumerics + check digit), deduplicated and uppercased. Tolerates any
 * surrounding prose, separators or list formatting.
 */
export const parseIsinList = (text: string): string[] => {
    const matches = text.toUpperCase().match(/\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/g) ?? [];
    return Array.from(new Set(matches));
};

/**
 * True when `ticker` buys are commission-free in the month identified by
 * `monthKey` at the given broker. Promos are broker-specific: an entry only
 * matches its own brokerId (legacy entries without brokerId match any broker).
 */
export const isFreeBuyIsin = (
    periods: FreeCommissionPeriod[],
    ticker: string | undefined,
    monthKey: string,
    brokerId?: string
): boolean => {
    if (!ticker) return false;
    const upper = ticker.toUpperCase();
    return periods.some(p =>
        p.monthKey === monthKey
        && (!p.brokerId || p.brokerId === brokerId)
        && p.isins.includes(upper)
    );
};

/**
 * A Buy transaction that falls in a free-commission month for its ISIN at its
 * broker but is not flagged freeCommission probably needs correcting.
 */
export const looksLikeMissedFreeBuy = (
    periods: FreeCommissionPeriod[],
    tx: { ticker: string; date: string; direction: string; brokerId?: string; freeCommission?: boolean }
): boolean =>
    tx.direction === 'Buy' && !tx.freeCommission && isFreeBuyIsin(periods, tx.ticker, monthKeyOfDate(tx.date), tx.brokerId);

/** Upserts the ISIN list for a month/broker pair (union with any existing entry), sorted by month desc. */
export const upsertFreeCommissionPeriod = (
    periods: FreeCommissionPeriod[],
    monthKey: string,
    brokerId: string,
    isins: string[]
): FreeCommissionPeriod[] => {
    const matches = (p: FreeCommissionPeriod) => p.monthKey === monthKey && p.brokerId === brokerId;
    const existing = periods.find(matches);
    const merged = Array.from(new Set([...(existing?.isins ?? []), ...isins])).sort();
    return [
        ...periods.filter(p => !matches(p)),
        { monthKey, brokerId, isins: merged },
    ].sort((a, b) => b.monthKey.localeCompare(a.monthKey) || (a.brokerId ?? '').localeCompare(b.brokerId ?? ''));
};
