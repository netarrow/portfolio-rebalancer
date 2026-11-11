import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { pinnedAllocationCoverage } from '../../utils/goalAllocationCoverage';
import { buildSinkingSummary, type SinkingSummary } from '../../utils/sinkingFunds';

/**
 * The planned capex of the primary budget as sinking funds: the yearly quota
 * of the cyclical ones, what they lack against their line, and the money
 * already put toward every capex (cash + what its investments cover today).
 */
export const useSinkingSummary = (): SinkingSummary => {
    const { ynabConfig, ynabGoals, ynabGoalAllocations, portfolios, transactions, effectiveAssetSettings, marketData, virtualBonds } = usePortfolio();
    const budgetId = ynabConfig?.budgetId;
    return useMemo(() => {
        const pinned = pinnedAllocationCoverage({
            portfolios, transactions, assetSettings: effectiveAssetSettings, marketData,
            allocations: ynabGoalAllocations, goals: ynabGoals, virtualBonds,
        });
        const invested = new Map<string, number>();
        ynabGoalAllocations.forEach(a => invested.set(a.ynabGoalId, (invested.get(a.ynabGoalId) ?? 0) + (pinned.get(a.id) ?? a.amount)));
        return buildSinkingSummary(
            ynabGoals.filter(g => !budgetId || g.ynabBudgetId === budgetId),
            g => Math.max(0, g.cashCoverage || 0) + (invested.get(g.id) ?? 0),
            new Date().toLocaleDateString('sv-SE'),
        );
    }, [budgetId, ynabGoals, ynabGoalAllocations, portfolios, transactions, effectiveAssetSettings, marketData, virtualBonds]);
};
