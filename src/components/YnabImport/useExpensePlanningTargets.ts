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
    /**
     * Set aside on the accounts (Expense Planning's "Set aside": dated expenses,
     * money to invest), without the emergency fund categories, the capex due
     * soon (counted below) and the capex whose cash goes to their portfolio.
     */
    setAside: number;
    setAsideByAccount: { brokerName: string; amount: number }[];
    /** Capex held as cash: due soon (cash + investments to sell), or not invested and not already set aside. */
    capexCash: number;
    capexCashItems: CapexLiquidityItem[];
    /** The liquidity target: operating cash + set aside + capex cash; null without YNAB. */
    liquidity: number | null;
    /**
     * Cash of the categories mapped to the emergency fund (one by one, by group,
     * or destined to a fund portfolio), still on the accounts: it belongs in the
     * fund portfolios, not in the liquidity.
     */
    fundCashByAccount: { brokerId: string; brokerName: string; amount: number }[];
    fundPortfolioIds: string[];
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
            return {
                portfolios: new Map<string, ExpensePlanningTarget>(), operatingCash: null, operatingCashByAccount: [],
                setAside: 0, setAsideByAccount: [], capexCash: 0, capexCashItems: [], liquidity: null,
                fundCashByAccount: [], fundPortfolioIds: [],
            };
        }
        const goals = ynabGoals.filter(g => g.ynabBudgetId === budgetId);
        const routing = { goals, allocations: ynabGoalAllocations, horizonMonths };
        const cash = capexRouting(routing);
        const byAccount = report.accounts
            .filter(a => a.operatingCash > 0)
            .map(a => ({ brokerName: a.brokerName, amount: a.operatingCash }));
        const round = (x: number) => Math.round(x * 100) / 100;
        const operatingCash = round(byAccount.reduce((s, a) => s + a.amount, 0));
        const fundPortfolioIds = fundKey.split(',').filter(Boolean);

        // Set aside, less the capex whose cash is bound for their portfolio.
        const toPortfolio = new Set(cash.invested.map(x => x.goal.id));
        const available = new Map(report.positions.map(p => [p.categoryId, Math.max(0, p.available)]));
        const earmarkedIds = new Set<string>();
        const setAsideByAccount = report.accounts
            .map(a => {
                a.earmarkedCategoryIds.forEach(id => earmarkedIds.add(id));
                const amount = a.earmarkedCategoryIds
                    .filter(id => !toPortfolio.has(id))
                    .reduce((s, id) => s + (available.get(id) ?? 0), 0);
                return { brokerName: a.brokerName, amount: round(amount) };
            })
            .filter(a => a.amount > 0);
        const setAside = round(setAsideByAccount.reduce((s, a) => s + a.amount, 0));
        // A capex with nothing invested whose cash is already set aside is not added twice.
        const capexItems = cash.liquidity.filter(i => !(i.reason === 'not-invested' && earmarkedIds.has(i.goalId)));
        const capexCash = round(capexItems.reduce((s, i) => s + i.amount, 0));
        return {
            portfolios: buildExpensePlanningTargets({
                emergency: report.emergency,
                emergencyPortfolioIds: fundPortfolioIds,
                ...routing,
            }),
            operatingCash,
            operatingCashByAccount: byAccount,
            setAside,
            setAsideByAccount,
            capexCash,
            capexCashItems: capexItems,
            liquidity: round(operatingCash + setAside + capexCash),
            fundCashByAccount: report.accounts
                .filter(a => a.emergencyHere > 0)
                .map(a => ({ brokerId: a.brokerId, brokerName: a.brokerName, amount: a.emergencyHere })),
            fundPortfolioIds,
        };
    }, [budgetId, report.emergency, report.accounts, report.positions, fundKey, ynabGoals, ynabGoalAllocations, horizonMonths]);
};
