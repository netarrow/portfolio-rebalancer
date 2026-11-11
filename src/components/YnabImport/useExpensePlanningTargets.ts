import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildExpensePlanningTargets, capexRouting, type CapexLiquidityItem, type ExpensePlanningTarget } from '../../utils/expensePlanningTargets';
import { buildCashPlan, type CashPlan } from '../../utils/cashPlan';
import { useYnabCoverage } from './useYnabCoverage';
import { useMaturityLadder } from '../YnabGoals/useMaturityLadder';

export interface ExpensePlanningTargets {
    /** € per portfolio: emergency fund from the opex + capex not due, allocated there with their cash. */
    portfolios: Map<string, ExpensePlanningTarget>;
    /** Operating cash to keep on the accounts, null without YNAB. */
    operatingCash: number | null;
    /** Of which, per account. */
    operatingCashByAccount: { brokerName: string; amount: number }[];
    /**
     * Capex held as cash: due soon (cash + investments to sell), or with
     * nothing invested (their cash). Other money a category keeps on an account
     * is not held there by force: it is free for the portfolios.
     */
    capexCash: number;
    capexCashItems: CapexLiquidityItem[];
    /**
     * Cash set aside on the accounts that stays cash (sinking funds with no
     * planned capex behind them, unmapped money), and emergency-fund cash held
     * there because no fund portfolio is configured. The capex cash above is
     * not repeated here.
     */
    setAsideCash: number;
    fundCashHeld: number;
    /**
     * The liquidity target, null without YNAB: the cash every account has to
     * hold (the same figure the linked broker minimums follow) plus the cash
     * still to come in for the capex due soon. See `utils/cashPlan`.
     */
    liquidity: number | null;
    /** The cash plan the target is read from; null without YNAB. */
    cashPlan: CashPlan | null;
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
    const { ladder } = useMaturityLadder();
    const fundKey = (settings.emergencyPortfolioIds ?? []).join(',');
    const budgetId = ynabConfig?.budgetId;
    const horizonMonths = settings.goalHorizonMonths;

    return useMemo(() => {
        if (!budgetId) {
            return {
                portfolios: new Map<string, ExpensePlanningTarget>(), operatingCash: null, operatingCashByAccount: [],
                capexCash: 0, capexCashItems: [], setAsideCash: 0, fundCashHeld: 0, liquidity: null, cashPlan: null,
                fundCashByAccount: [], fundPortfolioIds: [],
            };
        }
        const goals = ynabGoals.filter(g => g.ynabBudgetId === budgetId);
        const heldByPortfolio = Object.fromEntries(ladder.portfolios.map(p => [p.portfolioId, p.held]));
        const routing = { goals, allocations: ynabGoalAllocations, horizonMonths, ladder: ladder.goals, heldByPortfolio };
        const cash = capexRouting(routing);
        const byAccount = report.accounts
            .filter(a => a.operatingCash > 0)
            .map(a => ({ brokerName: a.brokerName, amount: a.operatingCash }));
        const round = (x: number) => Math.round(x * 100) / 100;
        const operatingCash = round(byAccount.reduce((s, a) => s + a.amount, 0));
        const fundPortfolioIds = fundKey.split(',').filter(Boolean);
        const cashPlan = buildCashPlan({
            report,
            fundPortfolioIds,
            activeGoalIds: new Set(goals.filter(g => !g.archived).map(g => g.id)),
            capexLiquidity: cash.liquidity,
        });
        // Capex with nothing invested are in the capex cash already: what is
        // left of the set-aside layer is the other money that stays cash.
        const capexIds = new Set(cash.liquidity.map(c => c.goalId));
        const setAsideCash = round(cashPlan.accounts.reduce((s, a) => s + (a.layers.find(l => l.kind === 'set-aside')?.items ?? [])
            .filter(i => !capexIds.has(i.id)).reduce((x, i) => x + i.amount, 0), 0));

        return {
            portfolios: buildExpensePlanningTargets({
                emergency: report.emergency,
                emergencyPortfolioIds: fundPortfolioIds,
                ...routing,
            }),
            operatingCash,
            operatingCashByAccount: byAccount,
            capexCash: cash.liquidityTotal,
            capexCashItems: cash.liquidity,
            setAsideCash,
            fundCashHeld: cashPlan.totals.byLayer.emergency,
            liquidity: cashPlan.target,
            cashPlan,
            fundCashByAccount: report.accounts
                .filter(a => a.emergencyHere > 0)
                .map(a => ({ brokerId: a.brokerId, brokerName: a.brokerName, amount: a.emergencyHere })),
            fundPortfolioIds,
        };
    }, [budgetId, report, fundKey, ynabGoals, ynabGoalAllocations, horizonMonths, ladder]);
};
