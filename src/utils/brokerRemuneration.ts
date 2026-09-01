// Pure logic for broker cash remuneration: which slice of the liquidity earns
// the rate, when the interest is credited, and how much has accrued since the
// last credited period. No React, no context — see
// scripts/verify-broker-remuneration.ts.
import type { Broker, BrokerAccrual, BrokerRemuneration, RemunerationFrequency } from '../types';

const roundCents = (value: number): number => Math.round(value * 1e2) / 1e2;

// ACT/365: the day-count deposit accounts quote their gross rate on.
const DAYS_PER_YEAR = 365;

// Safety valve: a plan started decades ago (or hand-edited) must not spin.
const MAX_CREDITS = 4000;

const MONTHS_PER_PERIOD: Record<RemunerationFrequency, number> = {
    daily: 0,
    monthly: 1,
    quarterly: 3,
    semiannual: 6,
    annual: 12,
};

export const FREQUENCY_LABELS: Record<RemunerationFrequency, string> = {
    daily: 'Daily',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    semiannual: 'Every 6 months',
    annual: 'Yearly',
};

const pad = (n: number) => String(n).padStart(2, '0');

export const toIsoDate = (date: Date): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const todayIso = (): string => toIsoDate(new Date());

const fromIsoDate = (iso: string): Date => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return new Date(y, (m ?? 1) - 1, d ?? 1);
};

const addDays = (iso: string, n: number): string => {
    const date = fromIsoDate(iso);
    date.setDate(date.getDate() + n);
    return toIsoDate(date);
};

// Whole days between two ISO dates. Rounded because a DST boundary makes the
// span 23 or 25 hours.
const daysBetween = (fromIso: string, toIso: string): number =>
    Math.round((fromIsoDate(toIso).getTime() - fromIsoDate(fromIso).getTime()) / 86_400_000);

// The credit day clamped to the length of the month, so "the 31st" still lands
// on the last day of February.
const dayInMonth = (year: number, monthIndex: number, day: number): string => {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    return `${year}-${pad(monthIndex + 1)}-${pad(Math.min(Math.max(1, day), lastDay))}`;
};

/** True when the plan is complete enough to pay anything. */
export const isRemunerationActive = (rem?: BrokerRemuneration): rem is BrokerRemuneration =>
    !!rem && !!rem.startDate && Number(rem.annualRatePercent) > 0;

/** Share of the interest kept after tax, e.g. 0.74 at the Italian 26%. */
const netFactor = (rem: BrokerRemuneration): number =>
    1 - Math.min(100, Math.max(0, rem.withholdingPercent ?? 0)) / 100;

/** The slice of `liquidity` that earns the rate. */
export const remuneratedBase = (rem: BrokerRemuneration, liquidity: number): number => {
    const positive = Math.max(0, liquidity || 0);
    switch (rem.baseType) {
        case 'capped':
            return Math.min(positive, Math.max(0, rem.baseCap ?? 0));
        case 'percent':
            return positive * Math.min(100, Math.max(0, rem.basePercent ?? 0)) / 100;
        default:
            return positive;
    }
};

/**
 * Credit dates strictly after `afterIso` and up to `untilIso` (inclusive).
 * Daily plans pay every day; the others pay on `creditDay` of the month, on a
 * schedule anchored to the month the plan started in (so a quarterly plan
 * started in February pays in February, May, August and November).
 */
export const creditDatesBetween = (rem: BrokerRemuneration, afterIso: string, untilIso: string): string[] => {
    const dates: string[] = [];
    if (!untilIso || untilIso <= afterIso) return dates;

    if (rem.frequency === 'daily') {
        let current = addDays(afterIso, 1);
        while (current <= untilIso && dates.length < MAX_CREDITS) {
            dates.push(current);
            current = addDays(current, 1);
        }
        return dates;
    }

    const step = MONTHS_PER_PERIOD[rem.frequency] || 1;
    const anchor = fromIsoDate(rem.startDate);
    const day = rem.creditDay && rem.creditDay > 0 ? rem.creditDay : anchor.getDate();
    let year = anchor.getFullYear();
    let month = anchor.getMonth();
    // The anchor month's credit day can predate the start date; the window
    // filter below drops it, so start walking from the anchor month either way.
    for (let i = 0; i < MAX_CREDITS * 2 && dates.length < MAX_CREDITS; i++) {
        const iso = dayInMonth(year, month, day);
        if (iso > untilIso) break;
        if (iso > afterIso) dates.push(iso);
        month += step;
        year += Math.floor(month / 12);
        month %= 12;
    }
    return dates;
};

/**
 * Interest earned by `broker` over the credit dates that have already passed,
 * or null when nothing is due yet (including when the accrual still rounds to
 * zero cents — the window then simply keeps growing until it is worth a cent).
 *
 * `amount` is what actually lands on the account: the gross interest less the
 * tax withheld at source. Past balances are not tracked, so today's liquidity
 * stands in for the whole window; the net interest credited inside the window
 * compounds onto it, since that is the only part that stays there.
 */
export const computeBrokerAccrual = (broker: Broker, asOfIso: string = todayIso()): BrokerAccrual | null => {
    const rem = broker.remuneration;
    if (!isRemunerationActive(rem)) return null;

    const start = rem.startDate.slice(0, 10);
    const last = rem.lastCreditDate?.slice(0, 10);
    const from = last && last > start ? last : start;
    const dates = creditDatesBetween(rem, from, asOfIso.slice(0, 10));
    if (dates.length === 0) return null;

    const net = netFactor(rem);
    let liquidity = broker.currentLiquidity || 0;
    const base = remuneratedBase(rem, liquidity);
    let gross = 0;
    let previous = from;
    for (const creditDate of dates) {
        const days = daysBetween(previous, creditDate);
        const interest = remuneratedBase(rem, liquidity) * (rem.annualRatePercent / 100) * days / DAYS_PER_YEAR;
        gross += interest;
        liquidity += interest * net;
        previous = creditDate;
    }

    const grossAmount = roundCents(gross);
    const amount = roundCents(gross * net);
    // Nothing worth a cent has landed yet: leave the watermark where it is so
    // the window keeps growing instead of silently swallowing the period.
    if (amount === 0) return null;
    return {
        fromDate: from,
        toDate: dates[dates.length - 1],
        amount,
        grossAmount,
        withheld: roundCents(grossAmount - amount),
        credits: dates.length,
        base: roundCents(base),
        annualRatePercent: rem.annualRatePercent,
        withholdingPercent: rem.withholdingPercent ?? 0,
    };
};

const formatEur = (value: number): string =>
    `€${value.toLocaleString('en-IE', { maximumFractionDigits: 2 })}`;

const ordinal = (day: number): string => {
    const suffix = day % 10 === 1 && day !== 11 ? 'st'
        : day % 10 === 2 && day !== 12 ? 'nd'
            : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
    return `${day}${suffix}`;
};

/** One-line description of a plan, for card badges and modal notes. */
export const describeRemuneration = (rem: BrokerRemuneration): string => {
    const parts = [`${rem.annualRatePercent}% per year`];
    if (rem.frequency === 'daily') {
        parts.push('credited daily');
    } else {
        const day = rem.creditDay && rem.creditDay > 0 ? rem.creditDay : fromIsoDate(rem.startDate).getDate();
        parts.push(`${FREQUENCY_LABELS[rem.frequency].toLowerCase()}, on the ${ordinal(day)}`);
    }
    if (rem.baseType === 'capped' && rem.baseCap) parts.push(`on the first ${formatEur(rem.baseCap)}`);
    else if (rem.baseType === 'percent' && rem.basePercent != null) parts.push(`on ${rem.basePercent}% of the liquidity`);
    else parts.push('on the whole liquidity');
    parts.push(rem.withholdingPercent ? `${rem.withholdingPercent}% tax withheld` : 'paid gross');
    return parts.join(' · ');
};
