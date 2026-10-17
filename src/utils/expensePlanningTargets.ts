import type { YnabGoal, YnabGoalAllocation } from '../types';
import type { EmergencyCoverage } from './ynabCoverage';

/**
 * Portfolio € targets derived from Expense Planning, for the Asset Allocation
 * mode "From Expense Planning":
 *  - fund: the whole emergency fund the opex call for (months × fixed
 *    spending), shared equally over the fund portfolios — what they should
 *    hold, never what they hold today;
 *  - capex: what each planned capex still needs beyond its cash, shared over
 *    the portfolios its allocations point at, by allocated amount.
 * A portfolio can be both: the two parts add up.
 */
export interface ExpensePlanningTarget {
    fund: number;
    capex: number;
    total: number;
    capexItems: { goalId: string; name: string; amount: number }[];
}

export interface ExpensePlanningTargetsInput {
    emergency: EmergencyCoverage | null;
    emergencyPortfolioIds: string[];
    goals: YnabGoal[];
    allocations: YnabGoalAllocation[];
}

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

    // Capex: only the part not covered by cash.
    input.goals.forEach(goal => {
        if (goal.archived || !goal.targetAmount) return;
        const need = Math.max(0, goal.targetAmount - (goal.cashCoverage || 0));
        if (need <= 0) return;
        const rows = input.allocations
            .filter(a => a.ynabGoalId === goal.id && a.portfolioId)
            .map(a => ({ id: a.portfolioId, weight: a.amount }));
        share(need, rows).forEach((v, id) => {
            const t = entry(id);
            t.capex += v;
            t.capexItems.push({ goalId: goal.id, name: goal.name, amount: round(v) });
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
