/**
 * Sinking funds: planned capex that come back every N years.
 *
 * Setting money aside month by month is the depreciation of the thing, paid
 * in advance. So the same operation reads two ways, and each view takes one:
 *  - cash and net worth: setting aside is not spending (cash goes from free to
 *    set aside), and the purchase takes the whole amount out at its date;
 *  - cost of living (FI, withdrawal rate): the yearly quota — target ÷ years —
 *    is the cost, and the purchase is the use of the fund, not a cost on top.
 * Never both in the same view. There is no depreciation ledger after the
 * purchase: the thing bought is not in the wealth the tool counts.
 */
import type { SinkingCycle, YnabGoal } from '../types';

const round = (x: number) => Math.round(x * 100) / 100;

/** `iso` moved by `years` (may be negative, may be fractional: whole months). */
export const addYears = (iso: string, years: number): string => {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + Math.round(years * 12));
    // 31 Jan + 1 month stays in February.
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.toISOString().slice(0, 10);
};

const validCycle = (cycle?: SinkingCycle): cycle is SinkingCycle => !!cycle && cycle.years > 0;

/** The yearly cost of a cyclical capex: its target over the years it lasts. 0 when not cyclical. */
export const annualQuota = (goal: Pick<YnabGoal, 'targetAmount' | 'cycle' | 'archived'>): number =>
    !goal.archived && validCycle(goal.cycle) && (goal.targetAmount ?? 0) > 0 ? round(goal.targetAmount! / goal.cycle.years) : 0;

/** When the current cycle started setting aside. */
export const cycleStart = (goal: Pick<YnabGoal, 'targetDate' | 'cycle'>): string | undefined => {
    if (!validCycle(goal.cycle)) return undefined;
    if (goal.cycle.startDate) return goal.cycle.startDate.slice(0, 10);
    return goal.targetDate ? addYears(goal.targetDate, -goal.cycle.years) : undefined;
};

export interface SinkingFundStatus {
    goalId: string;
    name: string;
    target: number;
    covered: number;
    years: number;
    quota: number;
    /** What a straight line from the cycle's start to its date asks for today; null without a date. */
    expected: number | null;
    /** expected − covered when positive. */
    behind: number;
    /** The date has passed: spent, or still to spend — time to start the next cycle. */
    ended: boolean;
}

const dayOf = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

export const sinkingFundStatus = (goal: YnabGoal, covered: number, today: string): SinkingFundStatus | null => {
    if (goal.archived || !validCycle(goal.cycle) || !((goal.targetAmount ?? 0) > 0)) return null;
    const target = goal.targetAmount!;
    const start = cycleStart(goal);
    let expected: number | null = null;
    let ended = false;
    if (goal.targetDate && start) {
        const span = dayOf(goal.targetDate) - dayOf(start);
        const share = span > 0 ? Math.min(1, Math.max(0, (dayOf(today) - dayOf(start)) / span)) : 1;
        expected = round(target * share);
        ended = dayOf(today) >= dayOf(goal.targetDate);
    }
    return {
        goalId: goal.id, name: goal.name, target, covered: round(covered), years: goal.cycle.years, quota: annualQuota(goal),
        expected, behind: expected === null ? 0 : round(Math.max(0, expected - covered)), ended,
    };
};

/**
 * The fund after its purchase: the next date, the price it will have by then,
 * and a cycle that starts where the last one ended. Null without a date.
 */
export const nextCycle = (goal: Pick<YnabGoal, 'targetAmount' | 'targetDate' | 'cycle'>): { targetAmount?: number; targetDate: string; cycle: SinkingCycle } | null => {
    if (!validCycle(goal.cycle) || !goal.targetDate) return null;
    const { years, inflationPercent } = goal.cycle;
    const growth = Math.pow(1 + (inflationPercent ?? 0) / 100, years);
    return {
        targetAmount: goal.targetAmount ? Math.round(goal.targetAmount * growth) : undefined,
        targetDate: addYears(goal.targetDate, years),
        cycle: { ...goal.cycle, startDate: goal.targetDate.slice(0, 10) },
    };
};

/**
 * The purchases after the first one, up to the end of `lastYear`: what a
 * long projection has to count so the car is not bought once in thirty years.
 */
export const laterPurchases = (first: { amount: number; targetDate: string }, cycle: SinkingCycle | undefined, lastYear: number): { amount: number; targetDate: string }[] => {
    if (!validCycle(cycle)) return [];
    const out: { amount: number; targetDate: string }[] = [];
    for (let k = 1; k < 200; k++) {
        const targetDate = addYears(first.targetDate, cycle.years * k);
        if (Number(targetDate.slice(0, 4)) > lastYear) break;
        out.push({ targetDate, amount: Math.round(first.amount * Math.pow(1 + (cycle.inflationPercent ?? 0) / 100, cycle.years * k)) });
    }
    return out;
};

export interface SinkingSummary {
    funds: SinkingFundStatus[];
    /** Σ of the yearly quotas: the cost of living the cyclical capex add. */
    annualQuota: number;
    /** Σ of what the cyclical funds lack against their straight line. */
    behind: number;
    /**
     * Money already put toward every active planned capex, cyclical or not
     * (cash + investments, up to its target): yours, but committed.
     */
    setAside: number;
}

export const buildSinkingSummary = (goals: YnabGoal[], coveredOf: (goal: YnabGoal) => number, today: string): SinkingSummary => {
    const active = goals.filter(g => !g.archived);
    const funds = active.map(g => sinkingFundStatus(g, coveredOf(g), today)).filter((f): f is SinkingFundStatus => !!f);
    return {
        funds,
        annualQuota: round(funds.reduce((s, f) => s + f.quota, 0)),
        behind: round(funds.reduce((s, f) => s + f.behind, 0)),
        setAside: round(active.reduce((s, g) => {
            const covered = Math.max(0, coveredOf(g));
            return s + ((g.targetAmount ?? 0) > 0 ? Math.min(covered, g.targetAmount!) : covered);
        }, 0)),
    };
};
