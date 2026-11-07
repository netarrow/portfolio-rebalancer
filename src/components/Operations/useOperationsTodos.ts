import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { isVirtualBondTicker } from '../../types';
import { calculateAssets, isCashTicker, isGroupKey } from '../../utils/portfolioCalculations';
import {
    detectBondMaturities, detectBrokerCash, detectCapex, detectCapexMatching, detectCapexSelling, detectFreeBrokerCash, detectFreeBuyPromos,
    detectGoalFlows, detectLiquidity, detectPac, detectPriceHistory, detectPrices, detectRebalance, detectRelocationQueue, detectSyncs,
    detectVirtualBonds, visibleTodos, type OperationTodo,
} from '../../utils/operationsQueue';
import { pinnedAllocationCoverage } from '../../utils/goalAllocationCoverage';
import { wantsInvestedTag } from '../../utils/ynabCapexNotes';
import { buildRevaluationPreview, suggestReassignments } from '../../utils/ynabWriteBack';
import { checkYnabGuardBudget } from '../../utils/ynabWriteGuard';
import { buildGoalRow, formatCurrencyExact } from '../YnabGoals/goalRows';
import { useTrackingPlan } from '../YnabTracking/useTrackingPlan';
import { useMaturityLadder } from '../YnabGoals/useMaturityLadder';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { RESERVE_ALLOCATED_CASH_KEY } from '../../utils/brokerLiquidity';

export const OPERATION_ICON: Record<OperationTodo['kind'], string> = {
    prices: '💱', liquidity: '🏦', 'broker-cash': '💶', pac: '📊', rebalance: '⚖️', 'capex-notes': '🧾', 'capex-bond': '🔎',
    'virtual-bond': '🧩', 'ynab-writeback': '🔁', 'ynab-revalue': '📈', 'capex-sync': '↻', backup: '☁️',
    'goal-flows': '🔀', 'relocation-queue': '📦', 'capex-match': '🎯', 'price-history': '📉', 'bond-maturity': '📅',
    'free-buy': '🎁', 'capex-sell': '💸',
};

/**
 * Everything still to be done, detected from the data: the one list both
 * Execute → Operations and the Home read, so they can never disagree. The
 * YNAB Writeback items only appear once its accounts have been read
 * (`tracking.loadAccounts`), which Operations does on demand.
 */
export const useOperationsTodos = (now: Date) => {
    const {
        portfolios, scopedTransactions, scopedBrokers, transactions, brokers, assetSettings, effectiveAssetSettings, marketData,
        pacPlans, pacExecutions, ynabGoals, ynabGoalAllocations, virtualBonds, ynabConfig,
        ynabAccountMappings, azureConfig, operations,
        ynabMigratedBrokerIds, ynabTrackingConfig, ynabWriteLog,
        goals, goalModeTargets, goalFlowPortfolioStates, relocationQueue,
        priceHistory, freeCommissionPeriods,
    } = usePortfolio();
    const { ladder } = useMaturityLadder();
    const currencyIso = ynabConfig?.currencyIso || 'EUR';
    const fmt = (v: number) => formatCurrencyExact(v, currencyIso);
    // The Dashboard's "Reserve cash allocated to portfolios" setting, read as is.
    const [reserveAllocatedCash] = useLocalStorage<boolean>(RESERVE_ALLOCATED_CASH_KEY, true);

    // ── Inputs the detectors need ──
    const priceTickers = useMemo(() => {
        const { assets } = calculateAssets(transactions, effectiveAssetSettings, marketData);
        const out = new Set(assets.filter(a => a.quantity > 0 && !isCashTicker(a.ticker) && !isVirtualBondTicker(a.ticker)).map(a => a.ticker));
        portfolios.forEach(p => {
            const groups = Object.fromEntries((p.allocationGroups || []).map(g => [g.id, g]));
            Object.entries(p.allocations || {}).forEach(([k, perc]) => {
                if ((perc || 0) < 1) return;
                const tickers = isGroupKey(k) ? groups[k]?.members ?? [] : [k];
                tickers.forEach(t => { if (!isCashTicker(t) && !isVirtualBondTicker(t) && !isGroupKey(t)) out.add(t); });
            });
        });
        return [...out];
    }, [transactions, effectiveAssetSettings, marketData, portfolios]);

    // History is fetched for what is held (Update History backfills from the first Buy).
    const heldTickers = useMemo(() => calculateAssets(transactions, effectiveAssetSettings, marketData).assets
        .filter(a => a.quantity > 0 && !isCashTicker(a.ticker) && !isVirtualBondTicker(a.ticker)).map(a => a.ticker),
    [transactions, effectiveAssetSettings, marketData]);

    const pinnedCoverage = useMemo(() => pinnedAllocationCoverage({
        portfolios, transactions, assetSettings: effectiveAssetSettings, marketData,
        allocations: ynabGoalAllocations, goals: ynabGoals, virtualBonds,
    }), [portfolios, transactions, effectiveAssetSettings, marketData, ynabGoalAllocations, ynabGoals, virtualBonds]);
    const tagOf = useMemo(() => {
        const wants = new Map(ynabGoals.map(g => [g.id, wantsInvestedTag(buildGoalRow(
            g, ynabGoalAllocations.filter(a => a.ynabGoalId === g.id), a => pinnedCoverage.get(a.id) ?? a.amount,
        ))]));
        return (id: string) => wants.get(id) ?? false;
    }, [ynabGoals, ynabGoalAllocations, pinnedCoverage]);

    // YNAB Writeback: accounts are read on demand, only when the Writeback is in use.
    const writebackInUse = ynabMigratedBrokerIds.length > 0;
    const tracking = useTrackingPlan(false);
    const guard = checkYnabGuardBudget(ynabTrackingConfig, ynabConfig?.budgetId);

    const detected = useMemo((): OperationTodo[] => {
        const list: OperationTodo[] = [
            ...detectPac({
                plans: pacPlans, executions: pacExecutions, now,
                portfolios, transactions, assetSettings: effectiveAssetSettings, marketData, brokers,
            }),
            ...detectPrices({ tickers: priceTickers, marketData, now }),
            ...detectLiquidity({ brokers, ynabBrokerIds: new Set(Object.keys(ynabAccountMappings)), records: operations, now }),
            // The Dashboard's Broker Performance cards read the stored asset settings.
            ...detectBrokerCash({ brokers: scopedBrokers, transactions: scopedTransactions, assetSettings, marketData, reserveAllocatedCash }),
            ...detectFreeBrokerCash({ brokers: scopedBrokers, reserveAllocatedCash }),
            ...detectRebalance({ portfolios, transactions: scopedTransactions, assetSettings: effectiveAssetSettings, marketData, brokers: scopedBrokers }),
            ...detectCapexMatching({
                portfolios, transactions: scopedTransactions, assetSettings: effectiveAssetSettings, marketData, brokers: scopedBrokers,
                goals: ynabGoals, allocations: ynabGoalAllocations, virtualBonds, now,
            }),
            // Capital Allocation counts what the Stats page counts: scoped data.
            ...detectGoalFlows({
                goals, portfolios, transactions: scopedTransactions, brokers: scopedBrokers, assetSettings: effectiveAssetSettings, marketData,
                targets: goalModeTargets, portfolioStates: goalFlowPortfolioStates, queued: relocationQueue,
            }),
            ...detectRelocationQueue({ queue: relocationQueue, portfolios }),
            ...detectBondMaturities({ portfolios, transactions, assetSettings: effectiveAssetSettings, marketData, now }),
            ...detectCapexSelling({ ladder, now }),
            ...detectPriceHistory({ tickers: heldTickers, history: priceHistory, assetSettings: effectiveAssetSettings, now }),
            ...detectFreeBuyPromos({ periods: freeCommissionPeriods, brokers, now }),
            ...detectVirtualBonds({ virtualBonds, transactions }),
            ...detectCapex({
                goals: ynabGoals, allocations: ynabGoalAllocations, assetSettings: effectiveAssetSettings, virtualBonds,
                tagOf, goalsGroupSet: !!ynabConfig?.goalsGroupId, ladder, now,
            }),
            ...detectSyncs({
                goalsGroupSet: !!ynabConfig?.goalsGroupId, lastGoalsSyncAt: ynabConfig?.lastGoalsSyncAt,
                azureEnabled: !!azureConfig?.enabled, azureLastSync: azureConfig?.lastSync, now,
            }),
        ];
        if (tracking.accounts) {
            const moves = suggestReassignments(tracking.plan);
            if (moves.length > 0) list.push({
                key: 'ynab-writeback', kind: 'ynab-writeback', urgency: 'due', title: 'Update the YNAB Writeback accounts',
                detail: `${moves.length} move${moves.length === 1 ? '' : 's'} (${fmt(moves.reduce((s, m) => s + m.amount, 0))}) between the accounts by purpose`,
            });
            if (guard.ok && writebackInUse) {
                const p = buildRevaluationPreview({ plan: tracking.plan, accounts: tracking.accounts, config: ynabTrackingConfig, budgetId: ynabConfig?.budgetId ?? '', entryId: 'check', date: '2000-01-01', log: ynabWriteLog });
                const n = p.accounts.filter(a => !a.suspicious && !a.blocked && (Math.abs(a.delta) >= 1 || Math.abs(a.taxTarget - a.taxSeen) >= 1)).length;
                if (n > 0) list.push({
                    key: 'ynab-revalue', kind: 'ynab-revalue', urgency: 'info', title: 'Revalue the YNAB Writeback accounts',
                    detail: `${n} account${n === 1 ? '' : 's'} to bring to market value (P/L and latent tax)`,
                });
            }
        }
        return list;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pacPlans, pacExecutions, priceTickers, marketData, brokers, ynabAccountMappings, operations, portfolios, scopedTransactions,
        effectiveAssetSettings, scopedBrokers, virtualBonds, transactions, ynabGoals, ynabGoalAllocations, tagOf, ynabConfig,
        azureConfig, reserveAllocatedCash, assetSettings, goals, goalModeTargets, goalFlowPortfolioStates, relocationQueue, ladder,
        heldTickers, priceHistory, freeCommissionPeriods, tracking.accounts, tracking.plan, guard.ok, writebackInUse, ynabTrackingConfig, ynabWriteLog, now]);

    const todos = useMemo(() => visibleTodos(detected, operations, now), [detected, operations, now]);

    return { detected, todos, priceTickers, heldTickers, tagOf, tracking, ladder, writebackInUse, reserveAllocatedCash };
};
