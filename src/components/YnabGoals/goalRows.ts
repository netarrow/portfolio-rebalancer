import type { YnabGoal, YnabGoalAllocation } from '../../types';

export const formatCurrency = (value: number | undefined | null, iso: string = 'EUR') =>
    value == null
        ? '—'
        : new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 0 }).format(value);

export const formatCurrencyExact = (value: number | undefined | null, iso: string = 'EUR') =>
    value == null
        ? '—'
        : new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 2 }).format(value);

export const formatTargetDate = (iso: string | undefined) =>
    iso ? new Date(iso).toLocaleDateString('en-IE', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

function monthsBetween(from: Date, to: Date): number {
    const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
    return Math.max(0, months);
}

// Everything the goals list and the goal setup show about one goal, worked out
// once: what YNAB holds in cash, what the investments cover, and how far the
// target still is.
export interface GoalRow {
    goal: YnabGoal;
    allocations: YnabGoalAllocation[];
    cash: number;
    invested: number;
    covered: number;
    target: number;            // 0 = no target set
    gap: number;
    progressPct: number;       // 0-100, of the target
    cashSegment: number;       // share of the progress bar, 0-100
    investSegment: number;
    monthsRemaining: number | null;
    requiredMonthly: number | null;
    // YNAB's monthly funding is more than 10% away from what the gap needs.
    mfMismatch: boolean;
}

export function buildGoalRow(
    goal: YnabGoal,
    allocations: YnabGoalAllocation[],
    coveredBy: (a: YnabGoalAllocation) => number,
    now: Date = new Date(),
): GoalRow {
    const cash = goal.cashCoverage || 0;
    const invested = allocations.reduce((s, a) => s + coveredBy(a), 0);
    const covered = cash + invested;
    const target = goal.targetAmount ?? 0;
    const gap = target > 0 ? Math.max(0, target - covered) : 0;
    const progressPct = target > 0 ? Math.min(100, (covered / target) * 100) : 0;
    const cashSegment = target > 0 ? Math.min(100, (cash / target) * 100) : 0;
    const investSegment = target > 0 ? Math.min(100 - cashSegment, (invested / target) * 100) : 0;

    const monthsRemaining = goal.targetDate ? monthsBetween(now, new Date(goal.targetDate)) : null;
    const requiredMonthly = goal.targetDate && target > 0
        ? gap / Math.max(monthsRemaining ?? 0, 1)
        : null;
    const mfMismatch = goal.ynabMonthlyFunding != null && requiredMonthly != null && requiredMonthly > 0
        ? Math.abs(goal.ynabMonthlyFunding - requiredMonthly) / requiredMonthly > 0.1
        : false;

    return {
        goal, allocations, cash, invested, covered, target, gap, progressPct,
        cashSegment, investSegment, monthsRemaining, requiredMonthly, mfMismatch,
    };
}
