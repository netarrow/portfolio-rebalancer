import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { createPortal } from 'react-dom';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets, calculateRequiredLiquidityForOnlyBuy, injectCashAssets, isCashTicker, calculateRealizedGains, calculateCommission, calculateCashFlows } from '../../utils/portfolioCalculations';
import { calculateAssetAllocation } from '../../utils/assetAllocation';
import { WithdrawalModal } from './WithdrawalModal';
import { RealizedGainsModal } from './RealizedGainsModal';
import { CashFlowModal } from './CashFlowModal';
import PortfolioGroupSection from './PortfolioGroupSection';
import GoalRebalanceWidget from './GoalRebalanceWidget';
import type { GoalItem } from './GoalRebalanceWidget';
import './Dashboard.css';

// Palette used to assign colors to user-defined goals by order
const GOAL_COLOR_PALETTE = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#6366F1'];


const AllocationOverview: React.FC = () => {
    const { portfolios, brokers, transactions, assetSettings, marketData, updatePortfolio, addTransactionsBulk, goals: rawGoals, goalModeTargets: storedGoalModeTargets, setGoalModeTargets } = usePortfolio();

    // Goals sorted by order, with assigned colors
    const goalItems = useMemo<GoalItem[]>(() => {
        return [...rawGoals]
            .sort((a, b) => a.order - b.order)
            .map((g, i) => ({ id: g.id, title: g.title, color: GOAL_COLOR_PALETTE[i % GOAL_COLOR_PALETTE.length] }));
    }, [rawGoals]);

    /**
     * Current goal values — portfolio-based, fully consistent with aggregateTotalValue.
     * Each portfolio contributes: invested assets + broker cash allocations (liquidityAllocations)
     * + portfolio-level liquidity. This matches exactly what the Aggregate table counts,
     * so goal gaps are accurate and broker cash shows as a real sell action.
     */
    const currentGoalValues = useMemo<Record<string, number>>(() => {
        const vals: Record<string, number> = {};
        rawGoals.forEach(g => { vals[g.id] = 0; });

        portfolios.forEach(p => {
            if (!p.goalId) return;
            const pTxs = transactions.filter(t => t.portfolioId === p.id);
            const { assets: pRawAssets, summary } = calculateAssets(pTxs, assetSettings, marketData);
            const pCash = injectCashAssets(pRawAssets, brokers, p.id)
                .filter(a => isCashTicker(a.ticker))
                .reduce((s, a) => s + a.currentValue, 0);
            vals[p.goalId] = (vals[p.goalId] ?? 0) + summary.totalValue + pCash + (p.liquidity || 0);
        });

        return vals;
    }, [portfolios, transactions, assetSettings, marketData, rawGoals, brokers]);

    const goalsTotalValue = useMemo(
        () => Object.values(currentGoalValues).reduce((s, v) => s + v, 0),
        [currentGoalValues]
    );

    // Target allocations: persisted via context (localStorage + Azure sync).
    // If goals change and stored targets are missing/incomplete, reinitialise to equal split.
    useEffect(() => {
        const hasAll = goalItems.length > 0 && goalItems.every(g => g.id in storedGoalModeTargets);
        if (hasAll) return;
        if (goalItems.length === 0) return;
        const equalPct = parseFloat((100 / goalItems.length).toFixed(2));
        const allocs: Record<string, number> = {};
        goalItems.forEach((g, i) => {
            allocs[g.id] = i < goalItems.length - 1 ? equalPct : 100 - equalPct * (goalItems.length - 1);
        });
        setGoalModeTargets(allocs);
    }, [goalItems, storedGoalModeTargets, setGoalModeTargets]);

    const targetGoalAllocs = storedGoalModeTargets;

    // Split portfolios into groups (parent + children) and standalones
    const { groups, standalones } = useMemo(() => {
        const parentPortfolios = portfolios.filter(
            p => !p.parentId && portfolios.some(c => c.parentId === p.id)
        ).sort((a, b) => a.order - b.order);
        // Children whose parent exists
        const validChildren = portfolios.filter(
            p => p.parentId && portfolios.some(par => par.id === p.parentId)
        );
        // Orphan children (parentId set but parent doesn't exist) → render standalone
        const orphans = portfolios.filter(
            p => p.parentId && !portfolios.some(par => par.id === p.parentId)
        );
        // Portfolios with no parent and no children
        const trueStandalones = portfolios.filter(
            p => !p.parentId && !portfolios.some(c => c.parentId === p.id)
        );

        const groups = parentPortfolios.map(parent => ({
            parent,
            children: validChildren.filter(c => c.parentId === parent.id).sort((a, b) => a.order - b.order),
        }));

        return { groups, standalones: [...trueStandalones, ...orphans].sort((a, b) => a.order - b.order) };
    }, [portfolios]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {portfolios.length === 0 ? (
                <div className="allocation-card">
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>
                        No portfolios configured. Create a portfolio to see allocation analysis.
                    </p>
                </div>
            ) : (
                <>
                    {groups.map(({ parent, children }) => (
                        <PortfolioGroupSection
                            key={parent.id}
                            parent={parent}
                            children={children}
                            allTransactions={transactions}
                            assetSettings={assetSettings}
                            marketData={marketData}
                            brokers={brokers}
                            onUpdatePortfolio={updatePortfolio}
                            onAddTransactions={addTransactionsBulk}
                        />
                    ))}
                    {standalones.map(portfolio => (
                        <PortfolioAllocationTable
                            key={portfolio.id}
                            portfolio={portfolio}
                            allTransactions={transactions}
                            assetSettings={assetSettings}
                            marketData={marketData}
                            brokers={brokers}
                            onUpdatePortfolio={updatePortfolio}
                            onAddTransactions={addTransactionsBulk}
                        />
                    ))}
                    {goalItems.length > 0 && (
                        <GoalRebalanceWidget
                            goals={goalItems}
                            targetAllocs={targetGoalAllocs}
                            onTargetChange={setGoalModeTargets}
                            currentGoalValues={currentGoalValues}
                            totalCurrentValue={goalsTotalValue}
                        />
                    )}
                    <AggregateAllocationSection
                        goalModeTargets={targetGoalAllocs}
                    />
                </>
            )}
        </div>
    );
};

interface AggregateAllocationSectionProps {
    goalModeTargets: Record<string, number>;  // goalId → target %
}

const AggregateAllocationSection: React.FC<AggregateAllocationSectionProps> = ({ goalModeTargets }) => {
    const { portfolios, brokers, transactions, assetSettings, marketData, assetAllocationSettings, aggregateExcludedTickers: excludedTickers, setAggregateExcludedTickers: setExcludedTickers } = usePortfolio();
    const [isEditing, setIsEditing] = useState(false);
    const [additionalLiquidity, setAdditionalLiquidity] = useState<number | undefined>(undefined);

    const { assets: rawAggregateAssets, summary } = useMemo(
        () => calculateAssets(transactions, assetSettings, marketData),
        [transactions, assetSettings, marketData]
    );

    // Per-portfolio total values (needed for aggregated cash and as input to asset allocation engine)
    const portfolioCalcs = useMemo(() => {
        return portfolios.map(portfolio => {
            const pTxs = transactions.filter(t => t.portfolioId === portfolio.id);
            const { assets: pRawAssets, summary: pSummary } = calculateAssets(pTxs, assetSettings, marketData);
            const pAssets = injectCashAssets(pRawAssets, brokers, portfolio.id);
            const cashAssetsValue = pAssets
                .filter(a => isCashTicker(a.ticker))
                .reduce((s, a) => s + a.currentValue, 0);
            const totalValue = pSummary.totalValue + (portfolio.liquidity || 0) + cashAssetsValue;
            return { portfolio, assets: pAssets, totalValue, investedValue: pSummary.totalValue, portfolioLiquidity: portfolio.liquidity || 0 };
        });
    }, [portfolios, transactions, assetSettings, marketData, brokers]);

    // Run the Asset Allocation engine to get configured target weights per portfolio
    const allocationResult = useMemo(() => {
        const brokerLiquidity = brokers.reduce((s, b) => {
            const alloc = b.liquidityAllocations || {};
            return s + Object.values(alloc).reduce((a, v) => a + (v || 0), 0);
        }, 0);
        return calculateAssetAllocation({
            portfolios: portfolioCalcs.map(pc => ({
                portfolioId: pc.portfolio.id,
                name: pc.portfolio.name,
                currentInvestedValue: pc.investedValue,
                currentPortfolioLiquidity: pc.portfolioLiquidity,
                currentTotalValue: pc.totalValue,
            })),
            brokerLiquidity,
            settings: assetAllocationSettings,
        });
    }, [portfolioCalcs, brokers, assetAllocationSettings]);

    // Map portfolioId → configured target weight (%)
    const portfolioTargetWeightById = useMemo(() => {
        const map: Record<string, number> = {};
        allocationResult.portfolios.forEach(r => { map[r.portfolioId] = r.targetWeight; });
        return map;
    }, [allocationResult]);

    // Aggregate cash assets across portfolios
    const aggregateCashAssets = useMemo<import('../../types').Asset[]>(() => {
        const cashMap = new Map<string, import('../../types').Asset>();
        portfolioCalcs.forEach(pc => {
            pc.assets.filter(a => isCashTicker(a.ticker)).forEach(cashAsset => {
                const existing = cashMap.get(cashAsset.ticker);
                if (existing) {
                    const newValue = existing.currentValue + cashAsset.currentValue;
                    cashMap.set(cashAsset.ticker, { ...existing, currentValue: newValue, averagePrice: newValue, currentPrice: newValue });
                } else {
                    cashMap.set(cashAsset.ticker, { ...cashAsset });
                }
            });
        });
        return Array.from(cashMap.values());
    }, [portfolioCalcs]);

    // All assets (quantity > 0) — used to render rows (including excluded in edit mode)
    const allVisibleAssets = useMemo(() => {
        const real = rawAggregateAssets.filter(a => a.quantity > 0 && !isCashTicker(a.ticker));
        return [...real, ...aggregateCashAssets].sort((a, b) => a.ticker.localeCompare(b.ticker));
    }, [rawAggregateAssets, aggregateCashAssets]);

    // Only included assets — used for totals and rebalance calculations
    const includedAssets = useMemo(
        () => allVisibleAssets.filter(a => !excludedTickers.includes(a.ticker)),
        [allVisibleAssets, excludedTickers]
    );

    const totalLiquidity = useMemo(
        () => portfolios.reduce((s, p) => s + (p.liquidity || 0), 0),
        [portfolios]
    );

    // Aggregate total value counts only included assets
    const aggregateTotalValue = useMemo(
        () => includedAssets.reduce((s, a) => s + a.currentValue, 0) + totalLiquidity,
        [includedAssets, totalLiquidity]
    );

    // Total value including the additional liquidity input
    const liq = additionalLiquidity ?? 0;
    const calcTotalValue = aggregateTotalValue + liq;

    // Realized + distributions
    const { totalRealized, details: realizedDetails, totalCommissions: realizedCommissions, totalTax: realizedTax } = useMemo(
        () => calculateRealizedGains(transactions, brokers, assetSettings),
        [transactions, brokers, assetSettings]
    );
    const [showRealizedModal, setShowRealizedModal] = React.useState(false);

    const { totalIncome, totalDividends, totalCoupons, byTicker: cashFlowDetails } = useMemo(
        () => calculateCashFlows(transactions),
        [transactions]
    );
    const [showCashFlowModal, setShowCashFlowModal] = React.useState(false);

    const includedGain = includedAssets.reduce((s, a) => s + (a.gain || 0), 0);
    const includedCost = includedAssets.reduce((s, a) => s + a.quantity * a.averagePrice, 0);
    const aggregateTotalReturn = includedGain + totalRealized + totalIncome;
    const aggregateTotalReturnPerc = includedCost > 0 ? (aggregateTotalReturn / includedCost) * 100 : 0;

    const getLabel = (ticker: string) => assetSettings.find(s => s.ticker === ticker)?.label || ticker;

    const toggleExcluded = (ticker: string) => {
        setExcludedTickers(prev =>
            prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker]
        );
    };

    // Weighted target % per ticker (memoised map)
    const totalConfiguredWeight = useMemo(() => {
        return portfolioCalcs.reduce((sum, pc) => sum + (portfolioTargetWeightById[pc.portfolio.id] ?? 0), 0);
    }, [portfolioCalcs, portfolioTargetWeightById]);

    const weightedTargets = useMemo(() => {
        const normFactor = totalConfiguredWeight > 0 ? 100 / totalConfiguredWeight : 0;
        const result: Record<string, number> = {};
        allVisibleAssets.forEach(a => {
            if (isCashTicker(a.ticker)) return;
            result[a.ticker] = portfolioCalcs.reduce((sum, pc) => {
                const tw = portfolioTargetWeightById[pc.portfolio.id] ?? 0;
                const w = (tw * normFactor) / 100;
                const tgt = (pc.portfolio.allocations || {})[a.ticker] || 0;
                return sum + w * tgt;
            }, 0);
        });
        return result;
    }, [allVisibleAssets, portfolioCalcs, portfolioTargetWeightById, totalConfiguredWeight]);

    // Buy-only allocations (largest remainder method on included non-cash assets)
    const aggregateBuyOnlyAllocations = useMemo(() => {
        if (liq <= 0) return {} as Record<string, number>;

        const candidates = includedAssets
            .filter(a => !isCashTicker(a.ticker))
            .map(a => {
                const tgt = weightedTargets[a.ticker] || 0;
                const targetValue = calcTotalValue * (tgt / 100);
                const gap = targetValue - a.currentValue;
                const price = a.currentPrice || 0;
                return { ticker: a.ticker, gap, price };
            })
            .filter(c => c.gap > 0 && c.price > 0);

        const totalGap = candidates.reduce((s, c) => s + c.gap, 0);
        if (totalGap <= 0) return {} as Record<string, number>;

        const distribution = candidates.map(c => {
            const rawAlloc = (c.gap / totalGap) * liq;
            const idealShares = rawAlloc / c.price;
            const flooredShares = Math.floor(idealShares);
            return { ...c, shares: flooredShares, fraction: idealShares - flooredShares, cost: flooredShares * c.price };
        });

        let remaining = liq - distribution.reduce((s, d) => s + d.cost, 0);
        const sortedIdx = distribution.map((_, i) => i).sort((a, b) => distribution[b].fraction - distribution[a].fraction);
        for (const idx of sortedIdx) {
            if (remaining >= distribution[idx].price) {
                distribution[idx].shares += 1;
                distribution[idx].cost += distribution[idx].price;
                remaining -= distribution[idx].price;
            }
        }

        const result: Record<string, number> = {};
        distribution.forEach(d => { if (d.shares > 0) result[d.ticker] = d.shares * d.price; });
        return result;
    }, [includedAssets, liq, calcTotalValue, weightedTargets]);

    const excludedCount = excludedTickers.filter(t => allVisibleAssets.some(a => a.ticker === t)).length;

    // Current goal values for goal-rebalance calculation — portfolio-based (robust against any goal title)
    const currentGoalValuesInAggregate = useMemo<Record<string, number>>(() => {
        const vals: Record<string, number> = {};
        // Use totalValue (invested + broker cash allocations + portfolio liquidity)
        // so that sum(vals) ≈ aggregateTotalValue and gaps are accurate.
        portfolioCalcs.forEach(pc => {
            const gid = pc.portfolio.goalId;
            if (!gid) return;
            vals[gid] = (vals[gid] ?? 0) + pc.totalValue;
        });
        return vals;
    }, [portfolioCalcs]);

    /**
     * ticker → goalId via portfolio membership (robust against any goal title).
     * If a ticker appears in portfolios with different goals, use the goal of the
     * portfolio where it has the highest current value.
     */
    const tickerToGoalId = useMemo<Record<string, string>>(() => {
        const map: Record<string, { goalId: string; value: number }> = {};
        portfolioCalcs.forEach(pc => {
            const gid = pc.portfolio.goalId;
            if (!gid) return;
            pc.assets.filter(a => !isCashTicker(a.ticker) && a.quantity > 0).forEach(a => {
                const existing = map[a.ticker];
                if (!existing || a.currentValue > existing.value) {
                    map[a.ticker] = { goalId: gid, value: a.currentValue };
                }
            });
        });
        const result: Record<string, string> = {};
        Object.entries(map).forEach(([ticker, { goalId }]) => { result[ticker] = goalId; });
        return result;
    }, [portfolioCalcs]);

    /**
     * Portfolio ids configured as 'locked' or 'excluded' in Asset Allocation settings.
     * These portfolios are off-limits for both buy and sell suggestions.
     */
    const lockedPortfolioIds = useMemo<Set<string>>(() => {
        const ids = new Set<string>();
        Object.entries(assetAllocationSettings?.portfolioTargets ?? {}).forEach(([pid, t]) => {
            if (t.mode === 'locked' || t.mode === 'excluded') ids.add(pid);
        });
        return ids;
    }, [assetAllocationSettings]);

    /**
     * Tickers frozen by Asset Allocation constraints: assets belonging exclusively
     * to locked/excluded portfolios. Off-limits for BOTH buy and sell suggestions.
     */
    const frozenTickers = useMemo<Set<string>>(() => {
        if (lockedPortfolioIds.size === 0) return new Set();
        const tickers = new Set<string>();
        portfolioCalcs.forEach(pc => {
            if (!lockedPortfolioIds.has(pc.portfolio.id)) return;
            pc.assets.filter(a => !isCashTicker(a.ticker) && a.quantity > 0).forEach(a => {
                const appearsElsewhere = portfolioCalcs.some(
                    other => !lockedPortfolioIds.has(other.portfolio.id) &&
                             other.assets.some(oa => oa.ticker === a.ticker && oa.quantity > 0)
                );
                if (!appearsElsewhere) tickers.add(a.ticker);
            });
        });
        return tickers;
    }, [portfolioCalcs, lockedPortfolioIds]);

    /**
     * Cash assets grouped by goalId, excluding cash held in locked/excluded
     * portfolios and excluding tickers the user has manually excluded from the
     * aggregate. Used to drain own-goal cash first when a goal must shrink.
     */
    const cashByGoal = useMemo<Record<string, { ticker: string; value: number }[]>>(() => {
        const map: Record<string, Record<string, number>> = {};
        portfolioCalcs.forEach(pc => {
            if (lockedPortfolioIds.has(pc.portfolio.id)) return;
            const gid = pc.portfolio.goalId;
            if (!gid) return;
            pc.assets
                .filter(a => isCashTicker(a.ticker) && a.currentValue > 0 && !excludedTickers.includes(a.ticker))
                .forEach(a => {
                    if (!map[gid]) map[gid] = {};
                    map[gid][a.ticker] = (map[gid][a.ticker] ?? 0) + a.currentValue;
                });
        });
        const result: Record<string, { ticker: string; value: number }[]> = {};
        Object.entries(map).forEach(([gid, byTicker]) => {
            result[gid] = Object.entries(byTicker).map(([ticker, value]) => ({ ticker, value }));
        });
        return result;
    }, [portfolioCalcs, lockedPortfolioIds, excludedTickers]);

    /**
     * Non-cash value actually held within each goal (per-portfolio aware).
     * goalId → ticker → € summed across non-locked portfolios that belong to
     * the goal. A ticker can appear under multiple goals when it's held in
     * portfolios with different goalIds — each goal only sees its own slice.
     * Frozen and user-excluded tickers are filtered out.
     */
    const nonCashValueByGoal = useMemo<Record<string, Record<string, number>>>(() => {
        const map: Record<string, Record<string, number>> = {};
        portfolioCalcs.forEach(pc => {
            if (lockedPortfolioIds.has(pc.portfolio.id)) return;
            const gid = pc.portfolio.goalId;
            if (!gid) return;
            pc.assets
                .filter(a => !isCashTicker(a.ticker) && a.quantity > 0
                    && !excludedTickers.includes(a.ticker)
                    && !frozenTickers.has(a.ticker))
                .forEach(a => {
                    if (!map[gid]) map[gid] = {};
                    map[gid][a.ticker] = (map[gid][a.ticker] ?? 0) + a.currentValue;
                });
        });
        return map;
    }, [portfolioCalcs, lockedPortfolioIds, excludedTickers, frozenTickers]);

    /**
     * Goal-Rebalance allocations.
     *
     * postTotal = aggregateTotalValue + liq
     * gap_per_goal = target€ − current€  →  Σ gaps = liq
     *
     * For each goal with gap < 0 (must shrink): drain own-goal cash FIRST, then
     * (only if needed) sell own-goal non-cash proportional to currentValue.
     * For each goal with gap > 0 (must grow): buy non-frozen assets of that goal
     * proportional to weightedTargets.
     *
     * Frozen tickers (assets exclusively in locked/excluded portfolios) and cash
     * sitting in locked portfolios are completely off-limits.
     *
     * Returns: ticker → € signed (positive = buy, negative = sell).
     */
    const goalRebalanceAllocations = useMemo<Record<string, number>>(() => {
        const goalIds = Object.keys(goalModeTargets);
        if (goalIds.length === 0) return {};

        const postTotal = aggregateTotalValue + liq;

        const goalGaps: Record<string, number> = {};
        goalIds.forEach(gid => {
            const targetEur = ((goalModeTargets[gid] ?? 0) / 100) * postTotal;
            const currentEur = currentGoalValuesInAggregate[gid] ?? 0;
            goalGaps[gid] = targetEur - currentEur;
        });

        const result: Record<string, number> = {};
        const addToResult = (ticker: string, eur: number) => {
            if (!Number.isFinite(eur) || eur === 0) return;
            result[ticker] = (result[ticker] ?? 0) + eur;
        };

        // Largest-remainder distribution: split |target| € across items in integer
        // shares, then redistribute leftover € to the items with the highest
        // fractional residue. Guarantees Σ shares*price ≈ |target| (loss ≤ price).
        type LRMItem = { ticker: string; weight: number; price: number };
        const distributeLRM = (signedTarget: number, items: LRMItem[]) => {
            const filtered = items.filter(i => i.price > 0);
            if (filtered.length === 0 || Math.abs(signedTarget) < 0.5) return;
            const sign = signedTarget > 0 ? 1 : -1;
            const absTarget = Math.abs(signedTarget);
            const totalWeight = filtered.reduce((s, i) => s + i.weight, 0);
            const useEqual = totalWeight <= 0;

            const dist = filtered.map(i => {
                const ideal = useEqual ? absTarget / filtered.length : absTarget * (i.weight / totalWeight);
                const idealShares = ideal / i.price;
                const flooredShares = Math.floor(idealShares);
                return { ticker: i.ticker, price: i.price, shares: flooredShares, fraction: idealShares - flooredShares };
            });

            let remaining = absTarget - dist.reduce((s, d) => s + d.shares * d.price, 0);
            const sortedIdx = dist.map((_, i) => i).sort((a, b) => dist[b].fraction - dist[a].fraction);
            for (const idx of sortedIdx) {
                if (remaining >= dist[idx].price) {
                    dist[idx].shares += 1;
                    remaining -= dist[idx].price;
                }
            }
            dist.forEach(d => {
                if (d.shares > 0) addToResult(d.ticker, sign * d.shares * d.price);
            });
        };

        goalIds.forEach(gid => {
            const gap = goalGaps[gid] ?? 0;
            if (Math.abs(gap) < 1) return;

            // Per-goal non-cash slice: each ticker appears with the € value held
            // by this goal's portfolios only (non-locked, non-frozen).
            const goalNonCash = nonCashValueByGoal[gid] ?? {};
            const assets = Object.entries(goalNonCash).map(([ticker, valueInGoal]) => {
                const a = includedAssets.find(x => x.ticker === ticker);
                return { ticker, valueInGoal, price: a?.currentPrice || 0 };
            }).filter(a => a.price > 0);

            if (gap > 0) {
                // Buy: LRM proportional to current value held in the goal.
                // Asset Allocation target % is intentionally NOT used here — the
                // goal % targets take priority; only lock/excluded constraints
                // (already filtered into `assets`) are respected.
                distributeLRM(gap, assets.map(a => ({
                    ticker: a.ticker, weight: a.valueInGoal, price: a.price,
                })));
            } else {
                // Sell: drain own-goal cash first (cash is fungible, exact €)
                let remaining = -gap;
                const cashAssets = cashByGoal[gid] ?? [];
                const totalCashInGoal = cashAssets.reduce((s, c) => s + c.value, 0);
                if (totalCashInGoal > 0) {
                    const cashSell = Math.min(remaining, totalCashInGoal);
                    cashAssets.forEach(c => {
                        const amt = cashSell * (c.value / totalCashInGoal);
                        addToResult(c.ticker, -Math.round(amt));
                    });
                    remaining -= cashSell;
                }
                // Residual: sell own-goal non-cash via LRM proportional to value-in-goal
                if (remaining > 0.5) {
                    distributeLRM(-remaining, assets.map(a => ({
                        ticker: a.ticker, weight: a.valueInGoal, price: a.price,
                    })));
                }
            }
        });

        // Drop sub-€ noise
        const cleaned: Record<string, number> = {};
        Object.entries(result).forEach(([ticker, eur]) => {
            if (Math.abs(eur) >= 1) cleaned[ticker] = eur;
        });
        return cleaned;
    }, [goalModeTargets, aggregateTotalValue, liq, currentGoalValuesInAggregate,
        includedAssets, cashByGoal, nonCashValueByGoal]);

    return (
        <div className="allocation-card" style={{ border: '1.5px dashed rgba(148,163,184,0.45)', background: 'var(--bg-surface)' }}>
            <div className="allocation-header-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <h3 className="section-title" style={{ margin: 0 }}>
                    <span style={{ fontSize: '0.8em', fontWeight: 500, color: 'var(--text-muted)', marginRight: 'var(--space-2)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>∑</span>Aggregate <span style={{ fontSize: '0.9em', fontWeight: 'normal', color: 'var(--text-secondary)' }}>
                        ({aggregateTotalValue.toLocaleString('en-IE', { style: 'currency', currency: 'EUR' })})
                    </span>
                    {realizedDetails.length > 0 && (
                        <span
                            style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: totalRealized >= 0 ? 'var(--color-success)' : 'var(--color-danger)', borderBottom: '1px dashed currentColor', cursor: 'pointer' }}
                            onClick={e => { e.stopPropagation(); setShowRealizedModal(true); }}
                        >
                            Realized: {totalRealized >= 0 ? '+' : ''}€{totalRealized.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {cashFlowDetails.length > 0 && (
                        <span
                            style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: '#3B82F6', borderBottom: '1px dashed currentColor', cursor: 'pointer' }}
                            onClick={e => { e.stopPropagation(); setShowCashFlowModal(true); }}
                        >
                            Distributions: +€{totalIncome.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {(includedGain !== 0 || totalRealized !== 0 || totalIncome !== 0) && (
                        <span style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: aggregateTotalReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            Total Return: {aggregateTotalReturn >= 0 ? '+' : ''}€{aggregateTotalReturn.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({aggregateTotalReturnPerc.toFixed(1)}%)
                        </span>
                    )}
                    <RealizedGainsModal isOpen={showRealizedModal} onClose={() => setShowRealizedModal(false)} title="Realized — Aggregate" details={realizedDetails} totalRealized={totalRealized} totalCommissions={realizedCommissions} totalTax={realizedTax} getLabel={getLabel} />
                    <CashFlowModal isOpen={showCashFlowModal} onClose={() => setShowCashFlowModal(false)} details={cashFlowDetails} totalDividends={totalDividends} totalCoupons={totalCoupons} totalIncome={totalIncome} getLabel={getLabel} />
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    <div className="allocation-liquidity-controls" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Liquidity:</label>
                        <input
                            type="number"
                            placeholder="0.00"
                            value={additionalLiquidity !== undefined ? additionalLiquidity : ''}
                            onChange={e => setAdditionalLiquidity(e.target.value === '' ? undefined : parseFloat(e.target.value))}
                            style={{ borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', width: '100px', textAlign: 'right' }}
                        />
                    </div>
                    <button
                        onClick={() => setIsEditing(e => !e)}
                        style={{
                            fontSize: '0.78rem', padding: '3px 10px', borderRadius: 'var(--radius-sm)',
                            border: isEditing ? '1px solid rgba(148,163,184,0.5)' : '1px solid var(--border-color)',
                            background: isEditing ? 'rgba(148,163,184,0.12)' : 'transparent',
                            color: isEditing ? 'var(--text-primary)' : 'var(--text-muted)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0,
                        }}
                        title="Includi/escludi asset dal conteggio"
                    >
                        {isEditing ? '✓ Fine' : `⚙ Filtra${excludedCount > 0 ? ` (${excludedCount} esclusi)` : ''}`}
                    </button>
                </div>
            </div>

            <div className="allocation-details" style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                <div className="allocation-row desktop-only" style={{ fontWeight: 600, color: 'var(--text-muted)', border: 'none' }}>
                    {isEditing && <div style={{ width: '36px' }} />}
                    <div style={{ flex: 1 }}>Asset</div>
                    <div style={{ width: '100px', textAlign: 'center' }}>Qty</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Pmc</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Mkt Price</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Value</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Gain</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Target (w)</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Actual</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Action</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Post Act %</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Buy Only</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Post Buy %</div>
                    <div style={{ width: '130px', textAlign: 'center', color: '#8B5CF6' }}>Goal Rebalance</div>
                    <div style={{ width: '80px', textAlign: 'center', color: '#8B5CF6' }}>Post Goal %</div>
                </div>

                {allVisibleAssets.length === 0 ? (
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>No assets currently held.</p>
                ) : (
                    allVisibleAssets.map(asset => {
                        const isExcluded = excludedTickers.includes(asset.ticker);
                        const isCash = isCashTicker(asset.ticker);
                        const setting = assetSettings.find(s => s.ticker === asset.ticker);
                        const assetClass = isCash ? 'Cash' : (setting?.assetClass || asset.assetClass || 'Stock');
                        const label = isCash ? (asset.label || asset.ticker) : (setting?.label || asset.label || asset.ticker);

                        // Use calcTotalValue (includes additional liquidity) for % calcs
                        const currentPerc = calcTotalValue > 0 ? (asset.currentValue / calcTotalValue) * 100 : 0;
                        const targetPerc = isCash ? 0 : (weightedTargets[asset.ticker] ?? 0);

                        // Rebalance (full) — only for included, non-cash assets
                        let rebalanceShares = 0;
                        let rebalanceAmount = 0;
                        let postRebalancePerc = currentPerc;

                        if (!isCash && !isExcluded && calcTotalValue > 0) {
                            const targetValue = calcTotalValue * (targetPerc / 100);
                            const idealDiff = targetValue - asset.currentValue;
                            const price = asset.currentPrice || 0;
                            if (price > 0) {
                                rebalanceShares = Math.round(idealDiff / price);
                                rebalanceAmount = rebalanceShares * price;
                            }
                            const postValue = asset.currentValue + rebalanceAmount;
                            postRebalancePerc = calcTotalValue > 0 ? (postValue / calcTotalValue) * 100 : 0;
                        }

                        // Buy-only — only for included, non-cash assets
                        const buyOnlyAmountRaw = (!isCash && !isExcluded) ? (aggregateBuyOnlyAllocations[asset.ticker] || 0) : 0;
                        let buyOnlyShares = 0;
                        let buyOnlyAmount = 0;
                        let projectedPerc = currentPerc;

                        if (buyOnlyAmountRaw > 0) {
                            const price = asset.currentPrice || 0;
                            if (price > 0) {
                                buyOnlyShares = Math.round(buyOnlyAmountRaw / price);
                                buyOnlyAmount = buyOnlyAmountRaw;
                            }
                            const postBuyValue = asset.currentValue + buyOnlyAmount;
                            projectedPerc = calcTotalValue > 0 ? (postBuyValue / calcTotalValue) * 100 : 0;
                        }

                        // Goal rebalance — only for included, non-cash assets (buy or sell, no new money)
                        const goalRebalanceRaw = (!isCash && !isExcluded) ? (goalRebalanceAllocations[asset.ticker] ?? 0) : 0;
                        let goalModeShares = 0;
                        let goalModeEur = 0;
                        let postGoalPerc = currentPerc;

                        if (goalRebalanceRaw !== 0) {
                            const price = asset.currentPrice || 0;
                            if (price > 0) {
                                // shares already integer from goalRebalanceAllocations
                                goalModeEur = goalRebalanceRaw;
                                goalModeShares = Math.round(goalRebalanceRaw / price);
                            }
                            // Post-rebalance total = aggregateTotalValue + liq (liquidity deployed)
                            const postGoalValue = asset.currentValue + goalModeEur;
                            const postTotal = aggregateTotalValue + liq;
                            postGoalPerc = postTotal > 0 ? (postGoalValue / postTotal) * 100 : 0;
                        }

                        return (
                            <AggregateRow
                                key={asset.ticker}
                                ticker={asset.ticker}
                                label={label}
                                assetClass={assetClass}
                                isCash={isCash}
                                quantity={asset.quantity}
                                averagePrice={asset.averagePrice}
                                currentPrice={asset.currentPrice || 0}
                                currentValue={asset.currentValue}
                                gain={asset.gain || 0}
                                gainPerc={asset.gainPercentage || 0}
                                currentPerc={currentPerc}
                                targetPerc={targetPerc}
                                rebalanceAmount={rebalanceAmount}
                                rebalanceShares={rebalanceShares}
                                buyOnlyAmount={buyOnlyAmount}
                                buyOnlyShares={buyOnlyShares}
                                postRebalancePerc={postRebalancePerc}
                                projectedPerc={projectedPerc}
                                goalModeEur={goalModeEur}
                                goalModeShares={goalModeShares}
                                postGoalPerc={postGoalPerc}
                                isEditing={isEditing}
                                isExcluded={isExcluded}
                                onToggleExclude={() => toggleExcluded(asset.ticker)}
                            />
                        );
                    })
                )}
            </div>
        </div>
    );
};

interface AggregateRowProps {
    ticker: string;
    label: string;
    assetClass: string;
    isCash: boolean;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    currentValue: number;
    gain: number;
    gainPerc: number;
    currentPerc: number;
    targetPerc: number;
    rebalanceAmount: number;
    rebalanceShares: number;
    buyOnlyAmount: number;
    buyOnlyShares: number;
    postRebalancePerc: number;
    projectedPerc: number;
    goalModeEur: number;
    goalModeShares: number;
    postGoalPerc: number;
    isEditing: boolean;
    isExcluded: boolean;
    onToggleExclude: () => void;
}

const AggregateRow: React.FC<AggregateRowProps> = ({
    ticker, label, assetClass, isCash, quantity, averagePrice, currentPrice, currentValue,
    gain, gainPerc, currentPerc, targetPerc,
    rebalanceAmount, rebalanceShares, buyOnlyAmount, buyOnlyShares, postRebalancePerc, projectedPerc,
    goalModeEur, goalModeShares, postGoalPerc,
    isEditing, isExcluded, onToggleExclude,
}) => {
    const diff = currentPerc - targetPerc;
    const colorMap: Record<string, string> = {
        'Stock': 'dot-etf',
        'Bond': 'dot-bond',
        'Commodity': 'dot-commodity',
        'Crypto': 'dot-crypto'
    };
    const colorClass = colorMap[assetClass] || 'dot-neutral';
    const rowOpacity = isExcluded ? 0.35 : 1;

    return (
        <>
            {/* Desktop */}
            <div className="allocation-row desktop-only" style={{ padding: 'var(--space-3) 0', opacity: rowOpacity, transition: 'opacity 0.15s' }}>
                {isEditing && (
                    <button
                        onClick={onToggleExclude}
                        title={isExcluded ? 'Includi nel conteggio' : 'Escludi dal conteggio'}
                        style={{
                            width: '24px', height: '24px', borderRadius: '50%', border: '1.5px solid',
                            borderColor: isExcluded ? 'var(--text-muted)' : 'var(--color-success)',
                            background: isExcluded ? 'transparent' : 'rgba(16,185,129,0.12)',
                            color: isExcluded ? 'var(--text-muted)' : 'var(--color-success)',
                            cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center',
                            justifyContent: 'center', flexShrink: 0, marginRight: '8px',
                        }}
                    >{isExcluded ? '✕' : '✓'}</button>
                )}
                <div className="allocation-type" style={{ flex: 1 }}>
                    <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                    <div><strong>{label || ticker}</strong></div>
                </div>
                <div style={{ width: '100px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : parseFloat(quantity.toFixed(4))}
                </div>
                <div style={{ width: '110px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : `€${averagePrice.toFixed(2)}`}
                </div>
                <div style={{ width: '110px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : `€${currentPrice.toFixed(2)}`}
                </div>
                <div style={{ width: '110px', textAlign: 'center' }}>
                    €{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{ width: '110px', textAlign: 'center', fontSize: '0.9rem' }}>
                    {isCash ? (
                        <div style={{ color: 'var(--text-muted)' }}>-</div>
                    ) : (
                        <>
                            <div style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: gainPerc >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gainPerc.toFixed(1)}%
                            </div>
                        </>
                    )}
                </div>
                <div style={{ width: '80px', textAlign: 'center' }}>
                    {isCash ? <span style={{ color: 'var(--text-muted)' }}>-</span> : `${targetPerc.toFixed(1)}%`}
                </div>
                <div style={{ width: '80px', textAlign: 'center' }}>
                    <div className="allocation-perc">{currentPerc.toFixed(1)}%</div>
                    {!isCash && targetPerc > 0 && (
                        <div className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ fontSize: '0.75rem' }}>
                            {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                        </div>
                    )}
                </div>
                {/* Action (full rebalance) */}
                <div style={{ width: '130px', textAlign: 'center' }}>
                    {(isCash || isExcluded) ? (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                    ) : (
                        <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {rebalanceShares === 0 ? (
                                <span className="trend-neutral">OK</span>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                    <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div style={{ width: '80px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {(isCash || isExcluded) ? '-' : `${postRebalancePerc.toFixed(1)}%`}
                </div>
                {/* Buy Only */}
                <div style={{ width: '130px', textAlign: 'center' }}>
                    {(isCash || isExcluded) ? (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                    ) : (
                        <div style={{ fontWeight: 600, color: buyOnlyAmount > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                            {buyOnlyShares === 0 ? (
                                <span className="trend-neutral">-</span>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                    <span>Buy {Math.abs(buyOnlyShares)}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div style={{ width: '80px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {(isCash || isExcluded) ? '-' : `${projectedPerc.toFixed(1)}%`}
                </div>
                {/* Goal Rebalance */}
                <div style={{ width: '130px', textAlign: 'center' }}>
                    {(isCash || isExcluded) ? (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                    ) : (
                        <div style={{ fontWeight: 600, color: goalModeEur > 0 ? '#8B5CF6' : goalModeEur < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {goalModeShares === 0 ? (
                                <span className="trend-neutral">-</span>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                    <span>{goalModeShares > 0 ? 'Buy' : 'Sell'} {Math.abs(goalModeShares)}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        €{Math.abs(goalModeEur).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div style={{ width: '80px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {(isCash || isExcluded) ? '-' : goalModeShares !== 0 ? `${postGoalPerc.toFixed(1)}%` : '-'}
                </div>
            </div>

            {/* Mobile */}
            <div className="allocation-mobile-card mobile-only" style={{ opacity: rowOpacity, transition: 'opacity 0.15s' }}>
                <div className="mobile-card-header">
                    <div className="mobile-card-title" style={{ gap: 'var(--space-2)' }}>
                        {isEditing && (
                            <button
                                onClick={onToggleExclude}
                                title={isExcluded ? 'Includi' : 'Escludi'}
                                style={{
                                    width: '22px', height: '22px', borderRadius: '50%', border: '1.5px solid',
                                    borderColor: isExcluded ? 'var(--text-muted)' : 'var(--color-success)',
                                    background: isExcluded ? 'transparent' : 'rgba(16,185,129,0.12)',
                                    color: isExcluded ? 'var(--text-muted)' : 'var(--color-success)',
                                    cursor: 'pointer', fontSize: '0.7rem', display: 'flex', alignItems: 'center',
                                    justifyContent: 'center', flexShrink: 0,
                                }}
                            >{isExcluded ? '✕' : '✓'}</button>
                        )}
                        <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                        <strong>{label || ticker}</strong>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 600 }}>€{currentValue.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</div>
                        {!isCash && (
                            <div style={{ fontSize: '0.8rem', color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)} ({gainPerc.toFixed(1)}%)
                            </div>
                        )}
                    </div>
                </div>
                <div className="mobile-card-grid">
                    {!isCash && (
                        <>
                            <div className="mobile-detail-group">
                                <span className="mobile-label">Price</span>
                                <span className="mobile-value">€{currentPrice.toFixed(2)}</span>
                            </div>
                            <div className="mobile-detail-group">
                                <span className="mobile-label">Qty</span>
                                <span className="mobile-value">{parseFloat(quantity.toFixed(4))}</span>
                            </div>
                        </>
                    )}
                    <div className="mobile-detail-group">
                        <span className="mobile-label">Target (w)</span>
                        <span className="mobile-value">{isCash ? '-' : `${targetPerc.toFixed(1)}%`}</span>
                    </div>
                    <div className="mobile-detail-group">
                        <span className="mobile-label">Actual</span>
                        <span className="mobile-value">
                            {currentPerc.toFixed(1)}%
                            {!isCash && targetPerc > 0 && (
                                <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px', fontSize: '0.75rem' }}>
                                    ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                                </span>
                            )}
                        </span>
                    </div>
                </div>
                {!isCash && !isExcluded && (rebalanceShares !== 0 || buyOnlyShares !== 0 || goalModeShares !== 0) && (
                    <div className="mobile-actions">
                        {rebalanceShares !== 0 && (
                            <div className="mobile-action-box">
                                <div className="mobile-action-title">Rebalance</div>
                                <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        )}
                        {buyOnlyShares !== 0 && (
                            <div className="mobile-action-box">
                                <div className="mobile-action-title">Buy Only</div>
                                <div style={{ fontWeight: 600, color: 'var(--color-success)' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span>Buy {Math.abs(buyOnlyShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        )}
                        {goalModeShares !== 0 && (
                            <div className="mobile-action-box">
                                <div className="mobile-action-title" style={{ color: goalModeEur > 0 ? '#8B5CF6' : 'var(--color-danger)' }}>Goal Rebalance</div>
                                <div style={{ fontWeight: 600, color: goalModeEur > 0 ? '#8B5CF6' : 'var(--color-danger)' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span>{goalModeShares > 0 ? 'Buy' : 'Sell'} {Math.abs(goalModeShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(goalModeEur).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    );
};

interface AllocationTableProps {
    portfolio: import('../../types').Portfolio;
    allTransactions: import('../../types').Transaction[];
    assetSettings: import('../../types').AssetDefinition[];
    marketData: Record<string, { price: number, lastUpdated: string }>;
    brokers: import('../../types').Broker[];
    onUpdatePortfolio: (portfolio: import('../../types').Portfolio) => void;
    onAddTransactions: (transactions: import('../../types').Transaction[]) => void;
}

export const PortfolioAllocationTable: React.FC<AllocationTableProps> = ({ portfolio, allTransactions, assetSettings, marketData, brokers, onUpdatePortfolio, onAddTransactions }) => {
    const [isWithdrawalModalOpen, setIsWithdrawalModalOpen] = React.useState(false);

    // Filter Txs for this portfolio
    const portfolioTxs = useMemo(() => {
        return allTransactions.filter(t => t.portfolioId === portfolio.id);
    }, [allTransactions, portfolio.id]);

    // Realized gains for this portfolio
    const { totalRealized, details: realizedDetails, totalCommissions: realizedCommissions, totalTax: realizedTax } = useMemo(
        () => calculateRealizedGains(portfolioTxs, brokers, assetSettings),
        [portfolioTxs, brokers, assetSettings]
    );
    const [showRealizedModal, setShowRealizedModal] = React.useState(false);

    // Cash flows (distributions) for this portfolio
    const { totalIncome: portfolioIncome, totalDividends: portfolioDividends, totalCoupons: portfolioCoupons, byTicker: portfolioCashFlowDetails } = useMemo(
        () => calculateCashFlows(portfolioTxs),
        [portfolioTxs]
    );
    const [showCashFlowModal, setShowCashFlowModal] = React.useState(false);
    const getCashFlowLabel = (ticker: string) => assetSettings.find(s => s.ticker === ticker)?.label || ticker;

    const fmtNum = (n: number) => n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const getRealizedLabel = (ticker: string) => assetSettings.find(s => s.ticker === ticker)?.label || ticker;

    // Calculate Assets for this portfolio, then inject virtual Cash assets from broker allocations
    const { assets, summary } = useMemo(() => {
        const result = calculateAssets(portfolioTxs, assetSettings, marketData);
        return {
            assets: injectCashAssets(result.assets, brokers, portfolio.id),
            summary: result.summary
        };
    }, [portfolioTxs, assetSettings, marketData, brokers, portfolio.id]);

    const portfolioTotalReturn = summary.totalGain + totalRealized + portfolioIncome;
    const portfolioTotalReturnPerc = summary.totalCost > 0 ? (portfolioTotalReturn / summary.totalCost) * 100 : 0;

    const allocations = portfolio.allocations || {};
    const liquidity = portfolio.liquidity || 0;

    // Total value of injected cash assets (broker liquidity allocated to this portfolio)
    const cashAssetsValue = useMemo(() => {
        return assets.filter(a => isCashTicker(a.ticker)).reduce((sum, a) => sum + a.currentValue, 0);
    }, [assets]);

    const assetTickers = assets.map(a => a.ticker);
    const targetTickers = Object.keys(allocations);
    const allTickers = Array.from(new Set([...assetTickers, ...targetTickers])).sort();

    const totalPortfolioValue = summary.totalValue + liquidity + cashAssetsValue;

    // Helper to calculate Buy Only amounts with integer share optimization
    // Strategy: Proportional Gap Filling + Largest Remainder Method
    const buyOnlyAllocations = useMemo(() => {
        const liq = portfolio.liquidity || 0;
        if (liq <= 0) return {};

        const totalVal = summary.totalValue + liq + cashAssetsValue;

        // 1. Calculate weighted gaps (Ideal Allocation - Current Value)
        // We only care about positive gaps (Underweight assets)
        // Skip cash tickers - they are not tradeable
        const candidates = allTickers.filter(t => !isCashTicker(t)).map(ticker => {
            const asset = assets.find(a => a.ticker === ticker);
            const currentValue = asset ? asset.currentValue : 0;
            const price = asset?.currentPrice || 0;
            const targetPerc = allocations[ticker] || 0;
            const targetValue = totalVal * (targetPerc / 100);
            const gap = targetValue - currentValue;

            return { ticker, gap, price };
        }).filter(c => c.gap > 0 && c.price > 0);

        const totalPositiveGap = candidates.reduce((sum, c) => sum + c.gap, 0);

        if (totalPositiveGap <= 0) return {};

        // 2. Initial Flow: Distribute Liquidity Proportional to Gap
        // This gives us the "Ideal Cash" for each asset.
        // Then convert to "Ideal Shares".
        let distribution = candidates.map(c => {
            const rawAlloc = (c.gap / totalPositiveGap) * liq;
            const idealShares = rawAlloc / c.price;
            const flooredShares = Math.floor(idealShares);
            const fraction = idealShares - flooredShares;

            return {
                ...c,
                shares: flooredShares,
                fraction: fraction,
                cost: flooredShares * c.price
            };
        });

        // 3. Optimization: Spend Remaining Liquidity
        // Sort by fractional part descending (Largest Remainder Methodish)
        // Only consider buying if we have enough cash for the share price
        let spent = distribution.reduce((sum, d) => sum + d.cost, 0);
        let remaining = liq - spent;

        // Sort candidates by potential benefit (fraction high = close to next share)
        const sortedIndices = distribution.map((_, i) => i).sort((a, b) => {
            return distribution[b].fraction - distribution[a].fraction;
        });

        // Greedy pass to buy extra shares
        // We iterate sorted candidates. If we can afford one share, we buy it.
        // We might need multiple passes or just one. Usually one pass through prioritized list is good.
        // But price constraint matters. High fraction but Price > Remaining -> Skip.
        for (const idx of sortedIndices) {
            const candidate = distribution[idx];

            if (remaining >= candidate.price) {
                distribution[idx].shares += 1;
                distribution[idx].cost += candidate.price;
                remaining -= candidate.price;
                // Update spent not strictly needed if we track remaining
            }
        }

        // 4. Build Result Map
        const finalMap: Record<string, number> = {};
        distribution.forEach(d => {
            if (d.shares > 0) {
                finalMap[d.ticker] = d.shares * d.price;
            }
        });

        return finalMap;
    }, [allTickers, allocations, assets, portfolio.liquidity, summary.totalValue]);

    // --- Execution Handlers ---
    const handleExecuteRebalance = async (mode: 'Full' | 'BuyOnly') => {
        const Swal = (await import('sweetalert2')).default;

        const transactionsToCreate: import('../../types').Transaction[] = [];

        // Wait, for Full Rebalance we iterate allTickers and calc difference to Target.
        // For Buy Only, we iterate allTickers and use buyOnlyAllocations.

        allTickers.forEach(ticker => {
            // Skip cash tickers - they are not tradeable
            if (isCashTicker(ticker)) return;

            const asset = assets.find(a => a.ticker === ticker);
            const currentPrice = asset?.currentPrice || 0;
            const targetPerc = allocations[ticker] || 0;
            const quantity = asset?.quantity || 0;

            if (quantity <= 0 && targetPerc <= 0) return;

            let shares = 0;


            if (mode === 'Full') {
                // Rebalance Calc
                const targetValue = totalPortfolioValue * (targetPerc / 100);
                const idealDiff = targetValue - (asset ? asset.currentValue : 0);
                if (currentPrice > 0) {
                    shares = Math.round(idealDiff / currentPrice);
                }
            } else {
                // Buy Only Calc
                const buyOnlyAmountIdeal = buyOnlyAllocations[ticker] || 0;
                if (currentPrice > 0) {
                    shares = Math.round(buyOnlyAmountIdeal / currentPrice);
                }
            }

            if (shares !== 0 && currentPrice > 0) {
                // Try to resolve broker. 
                const lastTx = allTransactions.filter(t => t.ticker === ticker && t.portfolioId === portfolio.id).pop();
                const brokerId = lastTx?.brokerId;

                transactionsToCreate.push({
                    id: `auto-rebal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    portfolioId: portfolio.id,
                    ticker: ticker,
                    date: new Date().toISOString().split('T')[0],
                    amount: Math.abs(shares),
                    price: currentPrice,
                    direction: shares > 0 ? 'Buy' : 'Sell',
                    brokerId: brokerId
                });
            }
        });

        if (transactionsToCreate.length === 0) {
            Swal.fire({
                title: 'No Actions',
                text: 'There are no actions to execute for this mode.',
                icon: 'info',
                confirmButtonColor: '#3B82F6'
            });
            return;
        }

        const modeLabel = mode === 'Full' ? 'Full Rebalance' : 'Buy Only Rebalance';

        const result = await Swal.fire({
            title: `Execute ${modeLabel}?`,
            html: `This will create <b>${transactionsToCreate.length}</b> transactions based on current market prices.<br/><br/>` +
                `<small style="color:var(--text-muted)">Ensure prices are displayed correctly! Transactions will be created at the current dashboard price.</small>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, Create Transactions',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#10B981',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)'
        });

        if (result.isConfirmed) {
            onAddTransactions(transactionsToCreate);
            Swal.fire({
                title: 'Success',
                text: `${transactionsToCreate.length} transactions created!`,
                icon: 'success',
                timer: 2000,
                showConfirmButton: false,
                background: 'var(--bg-card)',
                color: 'var(--text-primary)'
            });
        }
    };

    return (
        <div className="allocation-card">
            <div className="allocation-header-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
                <h3 className="section-title" style={{ margin: 0 }}>
                    Rebalancing: {portfolio.name} <span style={{ fontSize: '0.9em', fontWeight: 'normal', color: 'var(--text-secondary)' }}>
                        ({totalPortfolioValue.toLocaleString('en-IE', { style: 'currency', currency: 'EUR' })})
                    </span>
                    {(() => {
                        const totalTargetPerc = Object.values(allocations).reduce((sum, v) => sum + v, 0);
                        const isComplete = Math.abs(totalTargetPerc - 100) < 0.01;
                        return (
                            <span style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: isComplete ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                Target: {totalTargetPerc.toFixed(1)}%
                            </span>
                        );
                    })()}
                    {realizedDetails.length > 0 && (
                        <span
                            style={{
                                fontSize: '0.75em',
                                fontWeight: 'normal',
                                marginLeft: 'var(--space-3)',
                                color: totalRealized >= 0 ? 'var(--color-success)' : 'var(--color-danger)',
                                borderBottom: '1px dashed currentColor',
                                cursor: 'pointer',
                            }}
                            onClick={e => { e.stopPropagation(); setShowRealizedModal(true); }}
                        >
                            Realized: {totalRealized >= 0 ? '+' : ''}€{totalRealized.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {portfolioCashFlowDetails.length > 0 && (
                        <span
                            style={{
                                fontSize: '0.75em',
                                fontWeight: 'normal',
                                marginLeft: 'var(--space-3)',
                                color: '#3B82F6',
                                borderBottom: '1px dashed currentColor',
                                cursor: 'pointer',
                            }}
                            onClick={e => { e.stopPropagation(); setShowCashFlowModal(true); }}
                        >
                            Distributions: +€{portfolioIncome.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {(summary.totalGain !== 0 || totalRealized !== 0 || portfolioIncome !== 0) && (
                        <span
                            style={{
                                fontSize: '0.75em',
                                fontWeight: 'normal',
                                marginLeft: 'var(--space-3)',
                                color: portfolioTotalReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)',
                            }}
                        >
                            Total Return: {portfolioTotalReturn >= 0 ? '+' : ''}€{portfolioTotalReturn.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({portfolioTotalReturnPerc.toFixed(1)}%)
                        </span>
                    )}
                    <RealizedGainsModal
                        isOpen={showRealizedModal}
                        onClose={() => setShowRealizedModal(false)}
                        title={`Realized — ${portfolio.name}`}
                        details={realizedDetails}
                        totalRealized={totalRealized}
                        totalCommissions={realizedCommissions}
                        totalTax={realizedTax}
                        getLabel={getRealizedLabel}
                    />
                    <CashFlowModal
                        isOpen={showCashFlowModal}
                        onClose={() => setShowCashFlowModal(false)}
                        details={portfolioCashFlowDetails}
                        totalDividends={portfolioDividends}
                        totalCoupons={portfolioCoupons}
                        totalIncome={portfolioIncome}
                        getLabel={getCashFlowLabel}
                    />
                </h3>
                <div className="allocation-liquidity-controls" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Liquidity:</label>
                    <input
                        type="number"
                        placeholder="0.00"
                        value={portfolio.liquidity !== undefined ? portfolio.liquidity : ''}
                        onChange={(e) => {
                            const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                            onUpdatePortfolio({ ...portfolio, liquidity: val });
                        }}
                        style={{
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-color)',
                            width: '100px',
                            textAlign: 'right'
                        }}
                    />
                    {(() => {
                        const requiredTotalLiq = calculateRequiredLiquidityForOnlyBuy(assets, allocations);
                        // existing liquidity is portfolio.liquidity. We need to add the difference?
                        // "Liquidity to Invest" usually means "Cash Available to Buy".
                        // The user asked: "indicare la quantità di liquidità da investire per poter portare le % ... correttamente con solo azioni Only Buy"
                        // If I have 0 cash, I need X cash.
                        // If I have 100 cash, and need 100 total, I need 0 more.
                        // But usually the user wants to know the Total Amount of Cash required to make the "Only Buy" rebalance work.
                        // Let's show "Req for Only Buy: €X".

                        // Wait, if I already HAVE liquidity in the input, does the user want to know how much MORE?
                        // "indicare la quantità di liquidità da investire" -> "Amount of liquidity to invest".
                        // Use case: User asks "How much money do I need to deposit to balance this?"
                        // So it means "Total Required Liquidity" (assuming current cash is 0 or part of it).
                        // If I have 500 cash in input, and I need 1000 total. Do I interpret "Liquidity to invest" as 1000? Or 500 more?
                        // Let's display "Min Liq: €X" where X is the TOTAL liquidity needed.
                        // The user can then type that into the input. 

                        return (
                            <div
                                className="allocation-liquidity-hint"
                                style={{ fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'var(--space-2)' }}
                                title="Click to set Liquidity to this value"
                                onClick={() => onUpdatePortfolio({ ...portfolio, liquidity: parseFloat(requiredTotalLiq.toFixed(2)) })}
                            >
                                (Rebalancing Buy Only Liquidity: <span style={{ textDecoration: 'underline' }}>€{requiredTotalLiq.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</span>)
                            </div>
                        );
                    })()}
                </div>
            </div>


            {/* Rebalancing Actions Toolbar */}
            <div className="rebalancing-toolbar" style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                    className="btn-secondary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => setIsWithdrawalModalOpen(true)}
                >
                    Simulate Withdrawal
                </button>
                <button
                    className="btn-secondary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => handleExecuteRebalance('BuyOnly')}
                >
                    Exec Buy Only
                </button>
                <button
                    className="btn-primary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => handleExecuteRebalance('Full')}
                >
                    Exec Full Rebalance
                </button>
            </div>

            <div className="allocation-details" style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                <div className="allocation-row desktop-only" style={{ fontWeight: 600, color: 'var(--text-muted)', border: 'none' }}>
                    <div style={{ flex: 1 }}>Asset</div>
                    <div style={{ width: '100px', textAlign: 'center' }}>Qty</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Pmc</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Mkt Price</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Value</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Gain</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Target</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Actual</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Action</div>
                    <div style={{ width: '90px', textAlign: 'center' }}>Post Act %</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Buy Only</div>
                    <div style={{ width: '90px', textAlign: 'center' }}>Post Buy %</div>
                </div>

                {allTickers.length === 0 ? (
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>No activity or targets.</p>
                ) : (
                    allTickers.map(ticker => {
                        const asset = assets.find(a => a.ticker === ticker);
                        const currentValue = asset ? asset.currentValue : 0;
                        const currentPrice = asset?.currentPrice || 0;

                        // Actual % should be based on TOTAL (Invested + Liquidity) or just Invested?
                        // Usually Rebalancing compares Target % vs (Asset / TotalCapital).
                        // If I add liquidity, the TotalCapital increases.
                        // So correct math: currentPerc = (currentValue / totalPortfolioValue) * 100
                        const currentPerc = totalPortfolioValue > 0 ? (currentValue / totalPortfolioValue) * 100 : 0;

                        const targetPerc = allocations[ticker] || 0;
                        const quantity = asset?.quantity || 0;

                        // Filter: Hide if we don't hold it AND don't target it
                        if (quantity <= 0 && targetPerc <= 0) return null;

                        // Rebalance Calc
                        // 1. Ideal Monetary Diff
                        const targetValue = totalPortfolioValue * (targetPerc / 100);
                        const idealDiff = targetValue - currentValue;

                        // 2. Integer Share Optimization (Executability)
                        let rebalanceShares = 0;
                        let rebalanceAmount = idealDiff; // Default to ideal if no price (shouldn't happen for active assets)

                        if (currentPrice > 0) {
                            // Round to nearest share
                            rebalanceShares = Math.round(idealDiff / currentPrice);
                            rebalanceAmount = rebalanceShares * currentPrice;
                        }

                        const buyOnlyAmountIdeal = buyOnlyAllocations[ticker] || 0;
                        let buyOnlyShares = 0;
                        let buyOnlyAmount = buyOnlyAmountIdeal;

                        if (currentPrice > 0) {
                            // Buy Only is already conceptually "shares" in previous logic, but stored as amount.
                            // Let's recover shares:
                            buyOnlyShares = Math.round(buyOnlyAmountIdeal / currentPrice);
                            buyOnlyAmount = buyOnlyAmountIdeal; // It is already integer-aligned from computation
                        }


                        // Projected % after Buy Only
                        // Assumption: Buy Only action consumes existing Liquidity, so TotalPortfolioValue (Equity + Cash) is constant.
                        // projectedPerc = (NewEquity / TotalPortfolioValue) * 100
                        const projectedPerc = totalPortfolioValue > 0
                            ? ((currentValue + buyOnlyAmount) / totalPortfolioValue) * 100
                            : 0;

                        // Projected % after Rebalancing (Buy/Sell)
                        // This assumes full rebalancing: NewValue = CurrentValue + RebalanceAmount (Buy is +, Sell is -)
                        // And usually Standard Rebalancing tends to keep Total Portfolio Value same (Sell X to Buy Y), 
                        // UNLESS we are adding liquidity? 
                        // Standard rebalance in this tool seems to be "Ideal Diff" based on CURRENT Total Value (Assets + Liq).
                        // So if we execute it, the Asset Value becomes TargetValue.
                        // So PostRebalance % should be virtually equal to Target %, unless integer share rounding makes it slightly different.
                        // Let's calculate exactly based on integer shares:
                        const postRebalanceValue = currentValue + rebalanceAmount;
                        const postRebalancePerc = totalPortfolioValue > 0
                            ? (postRebalanceValue / totalPortfolioValue) * 100
                            : 0;

                        const isCash = isCashTicker(ticker);
                        const setting = assetSettings.find(s => s.ticker === ticker);
                        const assetClass = isCash ? 'Cash' : (setting?.assetClass || asset?.assetClass || 'Stock');

                        const label = isCash ? asset?.label : (setting?.label || asset?.label);

                        const tickerTxs = portfolioTxs.filter(t => t.ticker === ticker);
                        const totalFees = tickerTxs.reduce((sum, t) => {
                            if (t.freeCommission) return sum;
                            const broker = brokers.find(b => b.id === t.brokerId);
                            return sum + (calculateCommission(t, broker) || 0);
                        }, 0);

                        const assetCashFlow = portfolioCashFlowDetails.find(d => d.ticker === ticker.toUpperCase());
                        const assetDistributions = assetCashFlow?.totalIncome ?? 0;
                        const assetDistributionEvents = assetCashFlow?.events.length ?? 0;

                        return (
                            <AllocationRow
                                key={ticker}
                                ticker={ticker}
                                label={label}
                                assetClass={assetClass}
                                isCash={isCash}
                                currentPerc={currentPerc}
                                targetPerc={targetPerc}
                                rebalanceAmount={rebalanceAmount}
                                rebalanceShares={rebalanceShares}
                                buyOnlyAmount={buyOnlyAmount}
                                buyOnlyShares={buyOnlyShares}
                                currentValue={asset?.currentValue || 0}
                                quantity={asset?.quantity || 0}
                                averagePrice={asset?.averagePrice || 0}
                                currentPrice={asset?.currentPrice || 0}
                                gain={asset?.gain || 0}
                                gainPerc={asset?.gainPercentage || 0}
                                postRebalancePerc={postRebalancePerc}
                                projectedPerc={projectedPerc}
                                totalFees={totalFees}
                                assetDistributions={assetDistributions}
                                assetDistributionEvents={assetDistributionEvents}
                            />
                        );
                    })
                )}
            </div>

            <WithdrawalModal
                isOpen={isWithdrawalModalOpen}
                onClose={() => setIsWithdrawalModalOpen(false)}
                assets={assets}
                portfolio={portfolio}
                brokers={brokers}
                transactions={portfolioTxs}
            />
        </div >
    );
};

interface RowProps {
    ticker: string;
    label?: string;
    assetClass: string;
    isCash?: boolean;

    currentPerc: number;
    targetPerc: number;
    rebalanceAmount: number;
    rebalanceShares: number;
    buyOnlyAmount: number;
    buyOnlyShares: number;
    currentValue: number;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    gain: number;
    gainPerc: number;
    postRebalancePerc: number;
    projectedPerc: number;
    totalFees: number;
    assetDistributions: number;
    assetDistributionEvents: number;
}

const AllocationRow: React.FC<RowProps> = ({ ticker, label, assetClass, isCash, currentPerc, targetPerc, rebalanceAmount, rebalanceShares, buyOnlyAmount, buyOnlyShares, currentValue, quantity, averagePrice, currentPrice, gain, gainPerc, postRebalancePerc, projectedPerc, totalFees, assetDistributions, assetDistributionEvents }) => {
    const [isModalOpen, setIsModalOpen] = React.useState(false);
    const diff = currentPerc - targetPerc;

    const taxRate = assetClass === 'Bond' ? 0.125 : 0.26;
    const estimatedTax = gain > 0 ? gain * taxRate : 0;
    const netGain = gain - totalFees - estimatedTax;

    const totalReturnWithDistributions = gain + assetDistributions;
    const totalReturnPerc = (averagePrice > 0 && quantity > 0)
        ? (totalReturnWithDistributions / (averagePrice * quantity)) * 100
        : 0;

    const colorMap: Record<string, string> = {
        'Stock': 'dot-etf',
        'Bond': 'dot-bond',
        'Commodity': 'dot-commodity',
        'Crypto': 'dot-crypto'
    };

    const colorClass = colorMap[assetClass] || 'dot-neutral';

    return (
        <React.Fragment>
            {/* Desktop Table Row */}
            <div className="allocation-row desktop-only" style={{ padding: 'var(--space-3) 0' }}>
                <div className="allocation-type" style={{ flex: 1 }}>
                    <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                    <div>
                        <strong>{label || ticker}</strong>
                    </div>
                </div>

                <div style={{ width: '100px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : parseFloat(quantity.toFixed(4))}
                </div>

                <div style={{ width: '110px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : `€${averagePrice.toFixed(2)}`}
                </div>

                <div style={{ width: '110px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : `€${currentPrice.toFixed(2)}`}
                </div>

                <div style={{ width: '110px', textAlign: 'center' }}>
                    €{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>

                <div style={{ width: '110px', textAlign: 'center', fontSize: '0.9rem' }}>
                    {isCash ? (
                        <div style={{ color: 'var(--text-muted)' }}>-</div>
                    ) : (
                        <div
                            style={{ display: 'inline-block', cursor: 'pointer' }}
                            onClick={() => setIsModalOpen(true)}
                            title="Click for P/L breakdown"
                        >
                            <div style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)', borderBottom: '1px dashed currentColor' }}>
                                {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: gainPerc >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gainPerc.toFixed(1)}%
                            </div>
                        </div>
                    )}
                </div>

                {isModalOpen && createPortal(
                    <div className="realized-modal-overlay" onClick={() => setIsModalOpen(false)}>
                        <div className="realized-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
                            <div className="realized-modal-header">
                                <span className="realized-modal-title">P/L Breakdown — {label || ticker}</span>
                                <button className="realized-modal-close" onClick={() => setIsModalOpen(false)} aria-label="Close">✕</button>
                            </div>
                            <div className="realized-modal-body">
                                <div className="realized-tooltip-section-label" style={{ color: 'var(--text-muted)' }}>Position</div>
                                <div className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">Avg buy price</span>
                                    <span className="realized-tooltip-amount">€{averagePrice.toFixed(2)}</span>
                                </div>
                                <div className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">Current price</span>
                                    <span className="realized-tooltip-amount">€{currentPrice.toFixed(2)}</span>
                                </div>
                                <div className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">Quantity</span>
                                    <span className="realized-tooltip-amount">{parseFloat(quantity.toFixed(4))}</span>
                                </div>

                                <hr className="realized-tooltip-divider" />

                                <div className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">Gross P/L</span>
                                    <span className="realized-tooltip-amount" style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                        {gain >= 0 ? '+' : ''}€{gain.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        <span style={{ fontWeight: 'normal', marginLeft: 4, fontSize: '0.78rem' }}>({gainPerc.toFixed(1)}%)</span>
                                    </span>
                                </div>

                                {totalFees > 0 && (
                                    <div className="realized-tooltip-row">
                                        <span className="realized-tooltip-label">Commissions paid</span>
                                        <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                            -€{totalFees.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </span>
                                    </div>
                                )}

                                {estimatedTax > 0 && (
                                    <div className="realized-tooltip-row">
                                        <span className="realized-tooltip-label">Tax est. ({(taxRate * 100).toFixed(1)}%)</span>
                                        <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                            -€{estimatedTax.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </span>
                                    </div>
                                )}

                                <hr className="realized-tooltip-divider" />
                                <div className="realized-tooltip-total">
                                    <span>Net P/L {(totalFees > 0 || estimatedTax > 0) ? '(est.)' : ''}</span>
                                    <span style={{ color: netGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                        {netGain >= 0 ? '+' : ''}€{netGain.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </span>
                                </div>
                                {estimatedTax > 0 && (
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 'var(--space-2)', textAlign: 'center' }}>
                                        Tax is estimated on unrealized gain if sold today
                                    </div>
                                )}

                                {assetDistributions > 0 && (
                                    <>
                                        <hr className="realized-tooltip-divider" />
                                        <div className="realized-tooltip-section-label" style={{ color: '#8B5CF6' }}>Distributions received</div>
                                        <div className="realized-tooltip-row">
                                            <span className="realized-tooltip-label">
                                                Income
                                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: 4 }}>
                                                    ({assetDistributionEvents} payment{assetDistributionEvents !== 1 ? 's' : ''}, net at source)
                                                </span>
                                            </span>
                                            <span className="realized-tooltip-amount" style={{ color: '#8B5CF6' }}>
                                                +€{assetDistributions.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                            </span>
                                        </div>
                                        <hr className="realized-tooltip-divider" />
                                        <div className="realized-tooltip-total">
                                            <span>Total Return</span>
                                            <span style={{ color: totalReturnWithDistributions >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                                {totalReturnWithDistributions >= 0 ? '+' : ''}€{totalReturnWithDistributions.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                <span style={{ fontWeight: 'normal', marginLeft: 4, fontSize: '0.78rem' }}>({totalReturnPerc.toFixed(1)}%)</span>
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>,
                    document.body
                )}

                <div style={{ width: '80px', textAlign: 'center' }}>
                    {targetPerc}%
                </div>

                <div style={{ width: '80px', textAlign: 'center' }}>
                    <div className="allocation-perc">{currentPerc.toFixed(1)}%</div>
                    <div className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ fontSize: '0.75rem' }}>
                        {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                    </div>
                </div>

                <div style={{ width: '130px', textAlign: 'center' }}>
                    {isCash ? (
                        <div style={{ color: 'var(--text-muted)' }}>-</div>
                    ) : (
                        <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {rebalanceShares === 0 ? (
                                <span className="trend-neutral">OK</span>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                    <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div style={{ width: '90px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text-muted)' }}>{isCash ? '-' : `${postRebalancePerc.toFixed(1)}%`}</div>
                </div>

                <div style={{ width: '130px', textAlign: 'center' }}>
                    {isCash ? (
                        <div style={{ color: 'var(--text-muted)' }}>-</div>
                    ) : (
                        <div style={{ fontWeight: 600, color: buyOnlyAmount > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                            {buyOnlyShares === 0 ? (
                                <span className="trend-neutral">-</span>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                    <span>Buy {Math.abs(buyOnlyShares)}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div style={{ width: '90px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text-muted)' }}>{isCash ? '-' : `${projectedPerc.toFixed(1)}%`}</div>
                </div>
            </div>

            {/* Mobile Card Layout */}
            <div className="allocation-mobile-card mobile-only">
                <div className="mobile-card-header">
                    <div className="mobile-card-title">
                        <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                        <strong>{label || ticker}</strong>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 600 }}>€{currentValue.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</div>
                        {!isCash && (
                            <div
                                style={{ display: 'inline-block', cursor: 'pointer' }}
                                onClick={() => setIsModalOpen(true)}
                            >
                                <div style={{ fontSize: '0.8rem', color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)', borderBottom: '1px dashed currentColor' }}>
                                    {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)} ({gainPerc.toFixed(1)}%)
                                </div>
                                <div style={{ fontSize: '0.72rem', color: netGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                    Net: {netGain >= 0 ? '+' : ''}€{netGain.toFixed(0)}
                                </div>
                                {assetDistributions > 0 && (
                                    <div style={{ fontSize: '0.7rem', color: '#8B5CF6' }}>
                                        +€{assetDistributions.toFixed(0)} dist.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                <div className="mobile-card-grid">
                    {!isCash && (
                        <>
                            <div className="mobile-detail-group">
                                <span className="mobile-label">Price</span>
                                <span className="mobile-value">€{currentPrice.toFixed(2)}</span>
                            </div>
                            <div className="mobile-detail-group">
                                <span className="mobile-label">Qty</span>
                                <span className="mobile-value">{parseFloat(quantity.toFixed(4))}</span>
                            </div>
                        </>
                    )}
                    <div className="mobile-detail-group">
                        <span className="mobile-label">Target</span>
                        <span className="mobile-value">{targetPerc}%</span>
                    </div>
                    <div className="mobile-detail-group">
                        <span className="mobile-label">Actual</span>
                        <span className="mobile-value">
                            {currentPerc.toFixed(1)}%
                            <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px', fontSize: '0.75rem' }}>
                                ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                            </span>
                        </span>
                    </div>
                </div>

                {!isCash && (
                    <div className="mobile-actions">
                        <div className="mobile-action-box">
                            <div className="mobile-action-title">Standard Rebal</div>
                            <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                {rebalanceShares === 0 ? (
                                    <span>OK</span>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="mobile-action-box">
                            <div className="mobile-action-title">Buy Only</div>
                            <div style={{ fontWeight: 600, color: buyOnlyAmount > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                                {buyOnlyShares === 0 ? (
                                    <span>-</span>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                        <span>Buy {Math.abs(buyOnlyShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </React.Fragment>
    );
}

// Inline helper for colors until CSS is fully updated (though existing classes work too)
function getColorForClass(assetClass: string): string {
    switch (assetClass) {
        case 'Stock': return '#3B82F6';
        case 'Bond': return '#10B981';
        case 'Commodity': return '#F59E0B';
        case 'Crypto': return '#8B5CF6';
        case 'Cash': return '#6B7280';
        default: return '#9CA3AF';
    }
}

export default AllocationOverview;
