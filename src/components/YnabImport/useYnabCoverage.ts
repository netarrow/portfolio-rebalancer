import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { DEFAULT_YNAB_FUNDING_SETTINGS } from '../../types';
import { averageSpentFromHistory, buildCoverageReport, type CoverageReport, type CoverageSettings } from '../../utils/ynabCoverage';
import { pinnedAllocationCoverage } from '../../utils/goalAllocationCoverage';

/**
 * The coverage report of the primary YNAB budget, shared by the category table
 * (invested money, nature) and the coverage panel (accounts, fund, goals).
 */
export const useYnabCoverage = (): { report: CoverageReport; settings: CoverageSettings } => {
    const {
        ynabConfig, ynabCategories, ynabMappings, ynabMacroMappings, brokers, ynabGoals, ynabGoalAllocations,
        ynabFundingSettings, ynabSpendingHistoryByBudget, portfolios, transactions, effectiveAssetSettings,
        marketData, virtualBonds,
    } = usePortfolio();

    const settings: CoverageSettings = {
        emergencyMonths: ynabFundingSettings.emergencyMonths ?? DEFAULT_YNAB_FUNDING_SETTINGS.emergencyMonths!,
        workingCapitalMonths: ynabFundingSettings.workingCapitalMonths ?? DEFAULT_YNAB_FUNDING_SETTINGS.workingCapitalMonths!,
        goalHorizonMonths: ynabFundingSettings.goalHorizonMonths ?? DEFAULT_YNAB_FUNDING_SETTINGS.goalHorizonMonths!,
    };
    const { emergencyMonths, workingCapitalMonths, goalHorizonMonths } = settings;

    // Allocations pinned to a goal-matching row cover their share of what the
    // row holds today, as on the YNAB Goals page.
    const pinned = useMemo(() => pinnedAllocationCoverage({
        portfolios, transactions, assetSettings: effectiveAssetSettings, marketData,
        allocations: ynabGoalAllocations, goals: ynabGoals, virtualBonds,
    }), [portfolios, transactions, effectiveAssetSettings, marketData, ynabGoalAllocations, ynabGoals, virtualBonds]);

    // Categories synced before they carried a 12-month average fall back to the
    // Summary's stored history of the same budget.
    const budgetId = ynabConfig?.budgetId;
    const spentFallback = useMemo(
        () => averageSpentFromHistory(budgetId ? ynabSpendingHistoryByBudget[budgetId] ?? [] : []),
        [budgetId, ynabSpendingHistoryByBudget],
    );

    const report = useMemo(() => buildCoverageReport({
        categories: ynabCategories,
        mappings: ynabMappings,
        macroMappings: ynabMacroMappings,
        brokers,
        goals: ynabGoals,
        allocations: ynabGoalAllocations,
        coveredOf: a => pinned.get(a.id) ?? a.amount,
        spentFallback,
        defaultSourceBrokerId: ynabFundingSettings.defaultSourceBrokerId,
        settings: { emergencyMonths, workingCapitalMonths, goalHorizonMonths },
    }), [ynabCategories, ynabMappings, ynabMacroMappings, brokers, ynabGoals, ynabGoalAllocations, pinned,
        spentFallback, ynabFundingSettings.defaultSourceBrokerId, emergencyMonths, workingCapitalMonths, goalHorizonMonths]);

    return { report, settings };
};
