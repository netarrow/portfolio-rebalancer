import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildExpensePlanningTargets, capexRouting, type CapexLiquidityItem, type ExpensePlanningTarget } from '../../utils/expensePlanningTargets';
import { useYnabCoverage } from './useYnabCoverage';

export interface ExpensePlanningTargets {
    /** € per portfolio: emergency fund from the opex + capex not due, allocated there with their cash. */
    portfolios: Map<string, ExpensePlanningTarget>;
    /** Operating cash to keep on the accounts, null without YNAB. */
    operatingCash: number | null;
    /** Of which, per account. */
    operatingCashByAccount: { brokerName: string; amount: number }[];
    /** Capex held as cash: due soon (cash + investments to sell) or not invested (cash). */
    capexCash: number;
    capexCashItems: CapexLiquidityItem[];
    /** The liquidity target: operating cash + capex cash; null without YNAB. */
    liquidity: number | null;
}

/** The targets Asset Allocation can take from Expense Planning. */
export const useExpensePlanningTargets = (): ExpensePlanningTargets => {
    const { ynabConfig, ynabGoals, ynabGoalAllocations } = usePortfolio();
    const { report, settings } = useYnabCoverage();
    const fundKey = (settings.emergencyPortfolioIds ?? []).join(',');
    const budgetId = ynabConfig?.budgetId;
    const horizonMonths = settings.goalHorizonMonths;

    return useMemo(() => {
        if (!budgetId) {
            return { portfolios: new Map<string, ExpensePlanningTarget>(), operatingCash: null, operatingCashByAccount: [], capexCash: 0, capexCashItems: [], liquidity: null };
        }
        const goals = ynabGoals.filter(g => g.ynabBudgetId === budgetId);
        const routing = { goals, allocations: ynabGoalAllocations, horizonMonths };
        const cash = capexRouting(routing);
        const byAccount = report.accounts
            .filter(a => a.operatingCash > 0)
            .map(a => ({ brokerName: a.brokerName, amount: a.operatingCash }));
        const operatingCash = Math.round(byAccount.reduce((s, a) => s + a.amount, 0) * 100) / 100;
        return {
            portfolios: buildExpensePlanningTargets({
                emergency: report.emergency,
                emergencyPortfolioIds: fundKey.split(',').filter(Boolean),
                ...routing,
            }),
            operatingCash,
            operatingCashByAccount: byAccount,
            capexCash: cash.liquidityTotal,
            capexCashItems: cash.liquidity,
            liquidity: Math.round((operatingCash + cash.liquidityTotal) * 100) / 100,
        };
    }, [budgetId, report.emergency, report.accounts, fundKey, ynabGoals, ynabGoalAllocations, horizonMonths]);
};
