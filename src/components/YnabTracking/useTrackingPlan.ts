import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildTrackingPlan, type TrackingAccountRef, type TrackingPlan } from '../../utils/ynabTrackingPlan';
import { currentTaxLines } from '../../utils/ynabWriteBack';

export type TrackingAccount = TrackingAccountRef & { transferPayeeId?: string };

/**
 * The YNAB Writeback plan — accounts by purpose, what each should hold and
 * what it holds — as the Writeback page computes it, for any view that needs
 * it (the Capex section uses it to flag and fix what a remapping moved).
 * `autoLoad` reads the YNAB accounts on mount; otherwise `loadAccounts` does.
 */
export function useTrackingPlan(autoLoad = true) {
    const {
        ynabConfig, listYnabAccounts, portfolios, transactions, brokers, effectiveAssetSettings, marketData,
        ynabGoals, ynabGoalAllocations, virtualBonds, ynabAccountMappings, ynabTrackingConfig,
        ynabMigratedBrokerIds, ynabGoalQuotes, ynabWriteLog,
    } = usePortfolio();

    // The tool's latent-tax line in each account: balances are compared without it.
    const taxLineAmounts = useMemo(
        () => Object.fromEntries([...currentTaxLines(ynabWriteLog, ynabConfig?.budgetId)].map(([id, t]) => [id, t.amount])),
        [ynabWriteLog, ynabConfig?.budgetId],
    );

    const [accounts, setAccounts] = useState<TrackingAccount[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadedAt, setLoadedAt] = useState<string | null>(null);

    const loadAccounts = useCallback(async () => {
        setLoading(true);
        setError(null);
        const res = await listYnabAccounts();
        setLoading(false);
        if (!res.ok || !res.accounts) {
            setError(res.error || 'Unable to load YNAB accounts.');
            return null;
        }
        const list = res.accounts.map(a => ({
            id: a.id,
            name: a.name,
            onBudget: a.onBudget,
            balance: a.balanceMilliunits / 1000,
            clearedBalance: a.clearedBalanceMilliunits / 1000,
            transferPayeeId: a.transferPayeeId,
        }));
        setAccounts(list);
        setLoadedAt(new Date().toISOString());
        return list;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ynabConfig?.apiKey, ynabConfig?.budgetId]);

    useEffect(() => {
        if (autoLoad && ynabConfig?.apiKey && ynabConfig?.budgetId) void loadAccounts();
    }, [autoLoad, ynabConfig?.apiKey, ynabConfig?.budgetId, loadAccounts]);

    // Only liquidity links of the primary budget make a broker "type A" here:
    // the split happens inside that budget.
    const liquidityMappings = useMemo(() => Object.fromEntries(
        Object.entries(ynabAccountMappings).filter(([, m]) => m.budgetId === ynabConfig?.budgetId),
    ), [ynabAccountMappings, ynabConfig?.budgetId]);

    const plan: TrackingPlan = useMemo(() => buildTrackingPlan({
        portfolios,
        transactions,
        brokers,
        assetSettings: effectiveAssetSettings,
        marketData,
        goals: ynabGoals,
        allocations: ynabGoalAllocations,
        virtualBonds,
        liquidityMappings,
        config: ynabTrackingConfig,
        accounts: accounts ?? undefined,
        budgetId: ynabConfig?.budgetId,
        migratedBrokerIds: ynabMigratedBrokerIds,
        goalQuotes: ynabGoalQuotes,
        taxLineAmounts,
    }), [portfolios, transactions, brokers, effectiveAssetSettings, marketData, ynabGoals, ynabGoalAllocations,
        virtualBonds, liquidityMappings, ynabTrackingConfig, accounts, ynabConfig?.budgetId, ynabMigratedBrokerIds, ynabGoalQuotes, taxLineAmounts]);

    return { plan, accounts, loadAccounts, loading, error, loadedAt, liquidityMappings };
}
