import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildAccountCashPlans, type AccountCashPlan, type CashPlan } from '../../utils/cashPlan';
import { useYnabCoverage } from './useYnabCoverage';
import { useExpensePlanningTargets } from './useExpensePlanningTargets';

/**
 * The layers of each account (what to hold, what is in transit, what is
 * free), from the coverage report alone: what the broker minimums linked to
 * Expense Planning follow.
 */
export const useAccountCashPlans = (): AccountCashPlan[] => {
    const { ynabConfig, ynabGoals } = usePortfolio();
    const { report, settings } = useYnabCoverage();
    const budgetId = ynabConfig?.budgetId;
    const fundKey = (settings.emergencyPortfolioIds ?? []).join(',');
    return useMemo(() => buildAccountCashPlans({
        report,
        fundPortfolioIds: fundKey.split(',').filter(Boolean),
        activeGoalIds: new Set(ynabGoals.filter(g => !g.archived && g.ynabBudgetId === budgetId).map(g => g.id)),
    }), [report, fundKey, ynabGoals, budgetId]);
};

/** The whole cash plan — layers, liquidity target and moves; null without YNAB. */
export const useCashPlan = (): CashPlan | null => useExpensePlanningTargets().cashPlan;
