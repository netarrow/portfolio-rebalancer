import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildExpensePlanningTargets, type ExpensePlanningTarget } from '../../utils/expensePlanningTargets';
import { useYnabCoverage } from './useYnabCoverage';

export interface ExpensePlanningTargets {
    /** € per portfolio: emergency fund from the opex + capex not covered by cash. */
    portfolios: Map<string, ExpensePlanningTarget>;
    /** Operating cash to keep on the accounts, null without YNAB. */
    operatingCash: number | null;
    /** Of which, per account. */
    operatingCashByAccount: { brokerName: string; amount: number }[];
}

/** The targets Asset Allocation can take from Expense Planning. */
export const useExpensePlanningTargets = (): ExpensePlanningTargets => {
    const { ynabConfig, ynabGoals, ynabGoalAllocations } = usePortfolio();
    const { report, settings } = useYnabCoverage();
    const fundKey = (settings.emergencyPortfolioIds ?? []).join(',');
    const budgetId = ynabConfig?.budgetId;

    return useMemo(() => {
        if (!budgetId) return { portfolios: new Map<string, ExpensePlanningTarget>(), operatingCash: null, operatingCashByAccount: [] };
        const byAccount = report.accounts
            .filter(a => a.operatingCash > 0)
            .map(a => ({ brokerName: a.brokerName, amount: a.operatingCash }));
        return {
            portfolios: buildExpensePlanningTargets({
                emergency: report.emergency,
                emergencyPortfolioIds: fundKey.split(',').filter(Boolean),
                goals: ynabGoals.filter(g => g.ynabBudgetId === budgetId),
                allocations: ynabGoalAllocations,
            }),
            operatingCash: Math.round(byAccount.reduce((s, a) => s + a.amount, 0) * 100) / 100,
            operatingCashByAccount: byAccount,
        };
    }, [budgetId, report.emergency, report.accounts, fundKey, ynabGoals, ynabGoalAllocations]);
};
