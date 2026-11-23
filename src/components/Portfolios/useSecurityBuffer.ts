import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets } from '../../utils/portfolioCalculations';
import { pinnedAllocationCoverage } from '../../utils/goalAllocationCoverage';
import { buildSecurityBufferReport, type SecurityBufferReport } from '../../utils/securityBuffer';
import { useYnabCoverage } from '../YnabImport/useYnabCoverage';

/**
 * The Security Buffer report from the app's data:
 *  - portfolio values are the market value of their holdings in the current
 *    counting scope (family / illiquid / persons), broker cash excluded —
 *    operating liquidity is never L1, nor part of L3;
 *  - L1_target is the emergency fund target of Expense Planning;
 *  - a goal's funded money is what its allocations cover today (as on the
 *    YNAB Goals page) plus the cash YNAB holds for it.
 */
export const useSecurityBuffer = (): { report: SecurityBufferReport; emergencyMonths: number; fixedMonthly: number } => {
    const {
        portfolios, scopedTransactions, effectiveAssetSettings, marketData, ynabGoals, ynabGoalAllocations,
        virtualBonds, securityBufferSettings,
    } = usePortfolio();
    const { report: coverage } = useYnabCoverage();

    const values = useMemo(() => {
        const out: Record<string, number> = {};
        portfolios.forEach(p => {
            const { summary } = calculateAssets(scopedTransactions.filter(t => t.portfolioId === p.id), effectiveAssetSettings, marketData);
            out[p.id] = summary.totalValue;
        });
        return out;
    }, [portfolios, scopedTransactions, effectiveAssetSettings, marketData]);

    const pinned = useMemo(() => pinnedAllocationCoverage({
        portfolios, transactions: scopedTransactions, assetSettings: effectiveAssetSettings, marketData,
        allocations: ynabGoalAllocations, goals: ynabGoals, virtualBonds,
    }), [portfolios, scopedTransactions, effectiveAssetSettings, marketData, ynabGoalAllocations, ynabGoals, virtualBonds]);

    const l1Target = coverage.emergency.target;
    const emergencyKey = coverage.emergency.categoryIds.join(',');

    const report = useMemo(() => buildSecurityBufferReport({
        portfolios,
        settings: securityBufferSettings,
        valueOf: id => values[id] ?? 0,
        goals: ynabGoals,
        allocations: ynabGoalAllocations,
        coveredOf: a => pinned.get(a.id) ?? a.amount,
        l1Target,
        emergencyGoalIds: emergencyKey ? emergencyKey.split(',') : [],
        now: new Date(),
    }), [portfolios, securityBufferSettings, values, ynabGoals, ynabGoalAllocations, pinned, l1Target, emergencyKey]);

    return { report, emergencyMonths: coverage.emergency.months, fixedMonthly: coverage.emergency.fixedMonthly };
};
