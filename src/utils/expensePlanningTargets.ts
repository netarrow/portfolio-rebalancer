import type { YnabGoal, YnabGoalAllocation } from '../types';
import { monthsUntil, type EmergencyCoverage } from './ynabCoverage';

/**
 * Portfolio € targets derived from Expense Planning, for the Asset Allocation
 * mode "From Expense Planning":
 *  - fund: the whole emergency fund the opex call for (months × fixed
 *    spending), shared equally over the fund portfolios — what they should
 *    hold, never what they hold today;
 *  - capex not due within the horizon: their allocations (Setup) on the
 *    portfolio holding each asset, plus their cash, which will end up there;
 *    capex due soon count on the liquidity target instead, investments
 *    included, so the sale back to cash is planned (see `capexRouting`).
 * A portfolio can be both: the two parts add up.
 */
export interface ExpensePlanningTarget {
    fund: number;
    capex: number;
    total: number;
    /** Per capex: allocated here, and of its cash, what will move here. */
    capexItems: { goalId: string; name: string; amount: number; allocated: number; cash: number }[];
}

export interface ExpensePlanningTargetsInput {
    emergency: EmergencyCoverage | null;
    emergencyPortfolioIds: string[];
    goals: YnabGoal[];
    allocations: YnabGoalAllocation[];
    /** Capex due within this many months are held as cash. */
    horizonMonths: number;
    /** 'YYYY-MM-DD'; defaults to today. */
    today?: string;
}

export type CapexLiquidityReason = 'due-soon' | 'not-invested';

export interface CapexLiquidityItem {
    goalId: string;
    name: string;
    /** cash + divest. */
    amount: number;
    cash: number;
    /** Invested € to sell back to cash (due-soon capex only). */
    divest: number;
    reason: CapexLiquidityReason;
}

/** Allocated € of each capex, by portfolio, positive amounts only. */
const allocatedByGoal = (allocations: YnabGoalAllocation[]): Map<string, Map<string, number>> => {
    const out = new Map<string, Map<string, number>>();
    allocations.forEach(a => {
        if (!a.portfolioId || !(a.amount > 0)) return;
        const m = out.get(a.ynabGoalId) ?? new Map<string, number>();
        m.set(a.portfolioId, (m.get(a.portfolioId) ?? 0) + a.amount);
        out.set(a.ynabGoalId, m);
    });
    return out;
};

/**
 * Where each active planned capex counts (its real YNAB cash, never the target):
 *  - due within the horizon (or overdue): on the liquidity target, its cash
 *    and its investments — those are to be sold back to cash before paying;
 *  - not due, invested: on the portfolios holding its assets — allocations
 *    plus its cash, shared by allocated amount, since the cash will go there;
 *  - not due, nothing invested: its cash on the liquidity target.
 */
export const capexRouting = (input: Pick<ExpensePlanningTargetsInput, 'goals' | 'allocations' | 'horizonMonths' | 'today'>) => {
    const today = input.today ?? new Date().toISOString().slice(0, 10);
    const allocated = allocatedByGoal(input.allocations);
    const liquidity: CapexLiquidityItem[] = [];
    const invested: { goal: YnabGoal; byPortfolio: Map<string, { allocated: number; cash: number }> }[] = [];
    input.goals.forEach(goal => {
        if (goal.archived) return;
        const dueSoon = !!goal.targetDate && monthsUntil(today, goal.targetDate) <= input.horizonMonths;
        const byPortfolio = allocated.get(goal.id);
        const allocatedTotal = byPortfolio ? [...byPortfolio.values()].reduce((s, v) => s + v, 0) : 0;
        const cash = Math.max(0, goal.cashCoverage || 0);
        if (dueSoon || allocatedTotal <= 0) {
            const divest = dueSoon ? allocatedTotal : 0;
            if (cash + divest > 0) {
                liquidity.push({
                    goalId: goal.id, name: goal.name,
                    amount: round(cash + divest), cash: round(cash), divest: round(divest),
                    reason: dueSoon ? 'due-soon' : 'not-invested',
                });
            }
            return;
        }
        const out = new Map<string, { allocated: number; cash: number }>();
        byPortfolio!.forEach((amount, id) => out.set(id, { allocated: amount, cash: (amount / allocatedTotal) * cash }));
        invested.push({ goal, byPortfolio: out });
    });
    return { liquidity, liquidityTotal: round(liquidity.reduce((s, i) => s + i.amount, 0)), invested };
};

const round = (x: number) => Math.round(x * 100) / 100;

/** Share `amount` over `rows` by weight; equal shares when every weight is 0. */
const share = (amount: number, rows: { id: string; weight: number }[]): Map<string, number> => {
    const out = new Map<string, number>();
    if (rows.length === 0 || amount <= 0) return out;
    const total = rows.reduce((s, r) => s + Math.max(0, r.weight), 0);
    rows.forEach(r => {
        const part = total > 0 ? (Math.max(0, r.weight) / total) * amount : amount / rows.length;
        out.set(r.id, (out.get(r.id) ?? 0) + part);
    });
    return out;
};

export const buildExpensePlanningTargets = (input: ExpensePlanningTargetsInput): Map<string, ExpensePlanningTarget> => {
    const out = new Map<string, ExpensePlanningTarget>();
    const entry = (id: string) => {
        let e = out.get(id);
        if (!e) { e = { fund: 0, capex: 0, total: 0, capexItems: [] }; out.set(id, e); }
        return e;
    };

    // Fund: the target Expense Planning computes, in full.
    const fundIds = [...new Set(input.emergencyPortfolioIds)];
    if (input.emergency && fundIds.length > 0) {
        share(Math.max(0, input.emergency.target), fundIds.map(id => ({ id, weight: 0 })))
            .forEach((v, id) => { entry(id).fund += v; });
    }

    // Capex not due: allocations and the cash bound for them, on the portfolio.
    capexRouting(input).invested.forEach(({ goal, byPortfolio }) => {
        byPortfolio.forEach(({ allocated, cash }, id) => {
            const t = entry(id);
            t.capex += allocated + cash;
            t.capexItems.push({ goalId: goal.id, name: goal.name, amount: round(allocated + cash), allocated: round(allocated), cash: round(cash) });
        });
    });

    out.forEach(t => {
        t.fund = round(t.fund);
        t.capex = round(t.capex);
        t.total = round(t.fund + t.capex);
    });
    return out;
};

/**
 * The same targets keyed by Asset Allocation row: a parent/child group is one
 * row, so its members' targets add up on the group.
 */
export const targetsByRow = (
    targets: Map<string, ExpensePlanningTarget>,
    groupOf: (portfolioId: string) => string | undefined,
): Map<string, ExpensePlanningTarget> => {
    const out = new Map<string, ExpensePlanningTarget>();
    targets.forEach((t, id) => {
        const row = groupOf(id) ?? id;
        const e = out.get(row) ?? { fund: 0, capex: 0, total: 0, capexItems: [] };
        out.set(row, {
            fund: round(e.fund + t.fund),
            capex: round(e.capex + t.capex),
            total: round(e.total + t.total),
            capexItems: [...e.capexItems, ...t.capexItems],
        });
    });
    return out;
};
