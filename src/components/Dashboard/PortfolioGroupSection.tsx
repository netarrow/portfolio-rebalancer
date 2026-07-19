import React, { useMemo, useState } from 'react';
import {
    calculateAssets,
    injectCashAssets,
    isCashTicker,
    isGroupKey,
} from '../../utils/portfolioCalculations';
import {
    resolveGroups,
    distributeGroupDelta,
    distributeBuyOnlyWithPac,
    pacPriorityFor,
    buyRecipientOf,
    memberInfoFromAssets,
    groupWeightConfig,
    isFullyFrozen,
    requiredLiquidityForFullBuyOnly,
    type BuyOnlyCandidate,
    type MemberAction,
    type ResolvedGroups,
} from '../../utils/allocationGroups';
import { calculateAssetAllocation } from '../../utils/assetAllocation';
import { computeGroupRebalance, type GroupRebalancePlan } from '../../utils/groupRebalance';
import { usePortfolio } from '../../context/PortfolioContext';
import { WithdrawalModal } from './WithdrawalModal';
import { PortfolioAllocationTable } from './AllocationOverview';
import type { Portfolio, Transaction, AssetDefinition, Broker, Asset } from '../../types';

interface Props {
    parent: Portfolio;
    children: Portfolio[];
    allTransactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    brokers: Broker[];
    onUpdatePortfolio: (portfolio: Portfolio) => void;
    onAddTransactions: (transactions: Transaction[]) => void;
}

interface PortfolioCalc {
    portfolio: Portfolio;
    assets: Asset[];
    summary: ReturnType<typeof calculateAssets>['summary'];
    totalValue: number;
    cashAssetsValue: number;
    transactions: Transaction[];
}

const PORTFOLIO_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4'];

function getColorForClass(assetClass: string): string {
    switch (assetClass) {
        case 'Stock': return '#3B82F6';
        case 'Bond': return '#10B981';
        case 'Commodity': return '#F59E0B';
        case 'Crypto': return '#8B5CF6';
        case 'Cash': return '#6B7280';
        case 'PensionFund': return '#EC4899';
        default: return '#9CA3AF';
    }
}

const fmt = (n: number) =>
    n.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

interface BuyOnlyPlan {
    /** unit key (standalone ticker or groupId) -> euro to deploy */
    byUnit: Record<string, number>;
    /** ticker (UPPERCASE) -> member buy action, for tickers bought through their group */
    memberBuy: Record<string, MemberAction>;
}

const EMPTY_BUY_ONLY: BuyOnlyPlan = { byUnit: {}, memberBuy: {} };

function computeBuyOnly(
    pc: PortfolioCalc,
    resolved: ResolvedGroups,
    marketData: Record<string, { price: number; lastUpdated: string }>,
): BuyOnlyPlan {
    const liq = pc.portfolio.liquidity || 0;
    if (liq <= 0) return EMPTY_BUY_ONLY;
    const allocations = pc.portfolio.allocations || {};
    const { tickerToGroupId, groupById } = resolved;
    // Buy-Only deploys portfolio.liquidity, so its target base is the
    // portfolio total plus that cash (the total itself excludes it).
    const targetBase = pc.totalValue + liq;

    const candidates: BuyOnlyCandidate[] = [];

    // Standalone tickers: group members compete through their group, not alone.
    const unitKeys = new Set<string>([
        ...pc.assets.map(a => a.ticker),
        ...Object.keys(allocations),
    ]);
    unitKeys.forEach(ticker => {
        if (isCashTicker(ticker) || isGroupKey(ticker) || tickerToGroupId[ticker.toUpperCase()]) return;
        const asset = pc.assets.find(a => a.ticker === ticker);
        const currentValue = asset?.currentValue || 0;
        const price = asset?.currentPrice || 0;
        const targetPerc = allocations[ticker] || 0;
        const gap = targetBase * (targetPerc / 100) - currentValue;
        candidates.push({ key: ticker, gap, price, pacPriority: pacPriorityFor(pc.portfolio.pacConfigs, ticker) });
    });

    // Groups — one candidate each, same pricing as the single-portfolio view:
    // priority groups at the buy-recipient member, weighted groups at the
    // cheapest buy-eligible active member (invalid weighted setups are skipped).
    Object.values(groupById).forEach(group => {
        const memberInfo = memberInfoFromAssets(group.members, pc.assets, marketData);
        const wcfg = groupWeightConfig(group.members, group.memberRules);
        let price: number | undefined;
        if (wcfg.weighted) {
            if (!wcfg.valid) return;
            group.members.forEach(m => {
                const rule = group.memberRules?.[m] ?? group.memberRules?.[m.toUpperCase()] ?? {};
                if (isFullyFrozen(rule) || rule.noBuy) return;
                const mi = memberInfo[m.toUpperCase()];
                if (mi && mi.price > 0 && (price === undefined || mi.price < price)) price = mi.price;
            });
        } else {
            price = buyRecipientOf(group, memberInfo)?.price;
        }
        if (price === undefined) return;
        const currentValue = Object.values(memberInfo).reduce((s, mi) => s + mi.currentValue, 0);
        const gap = targetBase * (((allocations[group.id] || 0)) / 100) - currentValue;
        candidates.push({ key: group.id, gap, price, pacPriority: pacPriorityFor(pc.portfolio.pacConfigs, group.id) });
    });

    const byUnit = distributeBuyOnlyWithPac(candidates, liq);

    // Route each group's assigned euro to its member buy action(s).
    const memberBuy: Record<string, MemberAction> = {};
    Object.values(groupById).forEach(group => {
        const euro = byUnit[group.id] || 0;
        if (euro <= 0) return;
        const memberInfo = memberInfoFromAssets(group.members, pc.assets, marketData);
        const dist = distributeGroupDelta({ deltaEur: euro, members: group.members, memberInfo, rules: group.memberRules });
        Object.values(dist.actions).forEach(a => { memberBuy[a.ticker.toUpperCase()] = a; });
    });

    return { byUnit, memberBuy };
}

const PortfolioGroupSection: React.FC<Props> = ({
    parent,
    children,
    allTransactions,
    assetSettings,
    marketData,
    brokers,
    onUpdatePortfolio,
    onAddTransactions,
}) => {
    const [viewMode, setViewMode] = useState<'grouped' | 'individual'>('individual');
    const allPortfolios = useMemo(() => [parent, ...children], [parent, children]);
    // Global Rebalancing settings + full portfolio list, needed to resolve the
    // group members' configured proportions (e.g. Core 80% / Bond Buffer 20%).
    const { portfolios: storedPortfolios, assetAllocationSettings } = usePortfolio();

    const portfolioCalcs = useMemo((): PortfolioCalc[] => {
        return allPortfolios.map(portfolio => {
            const transactions = allTransactions.filter(t => t.portfolioId === portfolio.id);
            const { assets: rawAssets, summary } = calculateAssets(transactions, assetSettings, marketData);
            const assets = injectCashAssets(rawAssets, brokers, portfolio.id);
            const cashAssetsValue = assets
                .filter(a => isCashTicker(a.ticker))
                .reduce((s, a) => s + a.currentValue, 0);
            // Portfolio total = invested assets + broker cash allocated to this
            // portfolio. Per-portfolio liquidity (portfolio.liquidity) is shown as
            // an info row and is only deployed by the Buy-Only what-if, so it is
            // deliberately NOT summed into the total here.
            const totalValue = summary.totalValue + cashAssetsValue;
            return { portfolio, assets, summary, totalValue, cashAssetsValue, transactions };
        });
    }, [allPortfolios, allTransactions, assetSettings, marketData, brokers]);

    const totalGroupValue = portfolioCalcs.reduce((s, pc) => s + pc.totalValue, 0);

    // Per-portfolio allocation-group lookups. Groups are defined per portfolio,
    // so a ticker can be a group member in one member portfolio and standalone
    // in another — every check below must use the right portfolio's map.
    const resolvedByPortfolio = useMemo(() => {
        const map: Record<string, ResolvedGroups> = {};
        allPortfolios.forEach(p => { map[p.id] = resolveGroups(p); });
        return map;
    }, [allPortfolios]);

    /**
     * Inter-portfolio rebalance plan from the Global Rebalancing targets.
     *
     * Runs the same asset-allocation engine as the Global Rebalancing view over
     * ALL portfolios (percent/ratio targets need the full eligible total), then
     * normalizes the group members' target values within the group: the plan
     * only moves value between parent and children — asset-level rebalancing
     * inside each portfolio stays exactly as it is.
     *
     * Members without an active target (locked/excluded/unconfigured) are left
     * out of the plan and listed in `uncovered`; the panel needs at least two
     * covered members to be meaningful.
     */
    const groupRebalance = useMemo((): (GroupRebalancePlan & { uncovered: string[] }) | null => {
        const targets = assetAllocationSettings?.portfolioTargets ?? {};
        const isActive = (pid: string) => {
            const mode = targets[pid]?.mode;
            return mode === 'percent' || mode === 'ratio' || mode === 'fixed';
        };
        const activeMembers = portfolioCalcs.filter(pc => isActive(pc.portfolio.id));
        if (activeMembers.length < 2) return null;

        // Engine input over all portfolios, dashboard convention: invested assets
        // + broker cash allocated to the portfolio (same as AllocationOverview).
        const memberById = new Map(portfolioCalcs.map(pc => [pc.portfolio.id, pc]));
        const inputs = storedPortfolios.map(p => {
            const member = memberById.get(p.id);
            let investedValue: number;
            let totalValue: number;
            if (member) {
                investedValue = member.summary.totalValue;
                totalValue = member.totalValue;
            } else {
                const txs = allTransactions.filter(t => t.portfolioId === p.id);
                const { assets: rawAssets, summary } = calculateAssets(txs, assetSettings, marketData);
                const cash = injectCashAssets(rawAssets, brokers, p.id)
                    .filter(a => isCashTicker(a.ticker))
                    .reduce((s, a) => s + a.currentValue, 0);
                investedValue = summary.totalValue;
                totalValue = summary.totalValue + cash;
            }
            return {
                portfolioId: p.id,
                name: p.name,
                currentInvestedValue: investedValue,
                currentPortfolioLiquidity: p.liquidity || 0,
                currentTotalValue: totalValue,
            };
        });
        const brokerLiquidity = brokers.reduce((s, b) => {
            const alloc = b.liquidityAllocations || {};
            return s + Object.values(alloc).reduce((a, v) => a + (v || 0), 0);
        }, 0);
        const result = calculateAssetAllocation({
            portfolios: inputs,
            brokerLiquidity,
            settings: assetAllocationSettings,
        });
        const targetValueById = new Map(result.portfolios.map(r => [r.portfolioId, r.targetValue]));

        const plan = computeGroupRebalance(activeMembers.map(pc => ({
            portfolioId: pc.portfolio.id,
            name: pc.portfolio.name,
            currentValue: pc.totalValue,
            targetBasis: targetValueById.get(pc.portfolio.id) ?? 0,
        })));
        if (!plan) return null;

        const uncovered = portfolioCalcs
            .filter(pc => !isActive(pc.portfolio.id))
            .map(pc => pc.portfolio.name);
        return { ...plan, uncovered };
    }, [portfolioCalcs, storedPortfolios, allTransactions, assetSettings, marketData, brokers, assetAllocationSettings]);

    const groupAssets = useMemo((): Asset[] => {
        const groupTxs = allTransactions.filter(t =>
            allPortfolios.some(p => p.id === t.portfolioId)
        );
        const { assets: rawGroupAssets } = calculateAssets(groupTxs, assetSettings, marketData);

        const cashMap = new Map<string, Asset>();
        portfolioCalcs.forEach(pc => {
            pc.assets.filter(a => isCashTicker(a.ticker)).forEach(cashAsset => {
                if (cashMap.has(cashAsset.ticker)) {
                    const existing = cashMap.get(cashAsset.ticker)!;
                    const newValue = existing.currentValue + cashAsset.currentValue;
                    cashMap.set(cashAsset.ticker, {
                        ...existing,
                        currentValue: newValue,
                        averagePrice: newValue,
                        currentPrice: newValue,
                    });
                } else {
                    cashMap.set(cashAsset.ticker, { ...cashAsset });
                }
            });
        });

        return [...rawGroupAssets, ...Array.from(cashMap.values())];
    }, [allTransactions, allPortfolios, assetSettings, marketData, portfolioCalcs]);

    // Row keys for the comparison table: standalone tickers + allocation-group
    // ids. A ticker that belongs to a group is represented by that group's row
    // in the portfolios where it's grouped — adding it again as its own row
    // would count it twice (once aggregated in the group, once standalone).
    const allTickers = useMemo(() => {
        const set = new Set<string>();
        portfolioCalcs.forEach(pc => {
            const { tickerToGroupId, groupById } = resolvedByPortfolio[pc.portfolio.id];
            pc.assets.forEach(a => {
                if ((a.quantity > 0 || a.currentValue > 0) && !tickerToGroupId[a.ticker.toUpperCase()]) {
                    set.add(a.ticker);
                }
            });
            Object.entries(pc.portfolio.allocations || {}).forEach(([t, pct]) => {
                if (pct > 0 && !isGroupKey(t) && !tickerToGroupId[t.toUpperCase()]) set.add(t);
            });
            Object.values(groupById).forEach(g => {
                const hasTarget = ((pc.portfolio.allocations || {})[g.id] || 0) > 0;
                const hasValue = g.members.some(m => {
                    const a = pc.assets.find(x => x.ticker.toUpperCase() === m.toUpperCase());
                    return (a?.currentValue || 0) > 0;
                });
                if (hasTarget || hasValue) set.add(g.id);
            });
        });
        return Array.from(set).sort();
    }, [portfolioCalcs, resolvedByPortfolio]);

    // Allocation-group metadata (label + members) resolved across all portfolios
    // in this group. A group's target lives in allocations[groupId], so its id
    // shows up as a row in the comparison table; we resolve it to a readable
    // label and aggregate its members' value for the actual/deviation columns.
    const groupMeta = useMemo(() => {
        const map: Record<string, { label: string; members: string[] }> = {};
        allPortfolios.forEach(p => {
            (p.allocationGroups || []).forEach(g => {
                map[g.id] = { label: g.label, members: g.members };
            });
        });
        return map;
    }, [allPortfolios]);

    // Current value of an allocation group within a single portfolio = sum of
    // its members' current values. Resolved per portfolio: a portfolio that
    // doesn't define the group contributes nothing (its identically-named
    // tickers stay standalone there).
    const groupValueInPortfolio = (pc: PortfolioCalc, groupId: string): number => {
        const members = resolvedByPortfolio[pc.portfolio.id]?.groupById[groupId]?.members || [];
        return members.reduce((s, m) => {
            const a = pc.assets.find(x => x.ticker.toUpperCase() === m.toUpperCase());
            return s + (a?.currentValue || 0);
        }, 0);
    };

    // Pre-compute buy-only allocations for every portfolio (used in table + action bars)
    const portfolioBuyOnlyMap = useMemo(() => {
        const map: Record<string, BuyOnlyPlan> = {};
        portfolioCalcs.forEach(pc => {
            map[pc.portfolio.id] = computeBuyOnly(pc, resolvedByPortfolio[pc.portfolio.id], marketData);
        });
        return map;
    }, [portfolioCalcs, resolvedByPortfolio, marketData]);

    // Per-cell math shared by the desktop matrix and the mobile rows so the two
    // renderings can never drift apart.
    const computeCell = (pc: PortfolioCalc, ticker: string, isGroup: boolean, isCash: boolean): ComparisonCellData => {
        const resolved = resolvedByPortfolio[pc.portfolio.id];
        const asset = pc.assets.find(a => a.ticker === ticker);

        // A ticker that is grouped in THIS portfolio lives in its group's row
        // here: report the membership instead of a value, so nothing is
        // counted both in the group row and standalone.
        const memberGroupId = !isGroup && !isCash ? resolved.tickerToGroupId[ticker.toUpperCase()] : undefined;
        if (memberGroupId) {
            const held = (asset?.quantity || 0) > 0 || (asset?.currentValue || 0) > 0;
            return {
                currentValue: 0, actual: 0, target: 0, diff: 0,
                hasPosition: false, hasTarget: false,
                rebalShares: 0, rebalAmount: 0, buyOnlyShares: 0, buyOnlyAmount: 0,
                inGroupLabel: held ? (resolved.groupById[memberGroupId]?.label || memberGroupId) : undefined,
            };
        }

        const group = isGroup ? resolved.groupById[ticker] : undefined;
        const currentValue = isGroup
            ? groupValueInPortfolio(pc, ticker)
            : (asset?.currentValue || 0);
        const price = asset?.currentPrice || 0;
        const actual = pc.totalValue > 0 ? (currentValue / pc.totalValue) * 100 : 0;
        const target = (pc.portfolio.allocations || {})[ticker] || 0;
        const diff = actual - target;
        const hasPosition = isGroup
            ? currentValue > 0
            : ((asset?.quantity || 0) > 0 || currentValue > 0);
        const hasTarget = target > 0;

        // Rebalance action
        let rebalShares = 0;
        let rebalAmount = 0;
        if (!isCash && hasTarget) {
            const targetValue = pc.totalValue * (target / 100);
            const idealDiff = targetValue - currentValue;
            if (isGroup && group) {
                // Group rows act through their members: aggregate the euro the
                // member rules would actually trade (shares aren't meaningful
                // at group level).
                const memberInfo = memberInfoFromAssets(group.members, pc.assets, marketData);
                const dist = distributeGroupDelta({ deltaEur: idealDiff, members: group.members, memberInfo, rules: group.memberRules });
                rebalAmount = Object.values(dist.actions).reduce((s, a) => s + a.eur, 0);
            } else if (!isGroup && price > 0) {
                rebalShares = Math.round(idealDiff / price);
                rebalAmount = rebalShares * price;
            }
        }

        // Buy-only action (group rows are keyed by group id in byUnit)
        const buyOnlyAmount = !isCash ? (portfolioBuyOnlyMap[pc.portfolio.id]?.byUnit[ticker] || 0) : 0;
        const buyOnlyShares = !isGroup && buyOnlyAmount > 0 && price > 0 ? Math.round(buyOnlyAmount / price) : 0;

        return { currentValue, actual, target, diff, hasPosition, hasTarget, rebalShares, rebalAmount, buyOnlyShares, buyOnlyAmount };
    };

    // Per-ticker row metadata shared by the desktop matrix and the mobile rows.
    const deriveTickerRow = (ticker: string) => {
        const isGroup = isGroupKey(ticker);
        const groupAsset = groupAssets.find(a => a.ticker === ticker);
        const isCashRow = isCashTicker(ticker);
        // Aggregate column: for a standalone-ticker row, portfolios where that
        // ticker is grouped contribute to the group's row instead — skipping
        // them here keeps each euro counted exactly once.
        const groupValue = portfolioCalcs.reduce((s, pc) => {
            if (isGroup) return s + groupValueInPortfolio(pc, ticker);
            if (!isCashRow && resolvedByPortfolio[pc.portfolio.id].tickerToGroupId[ticker.toUpperCase()]) return s;
            const a = pc.assets.find(x => x.ticker === ticker);
            return s + (a?.currentValue || 0);
        }, 0);
        const groupActual = totalGroupValue > 0 ? (groupValue / totalGroupValue) * 100 : 0;

        const groupWeightedTarget = portfolioCalcs.reduce((sum, pc) => {
            const weight = totalGroupValue > 0 ? pc.totalValue / totalGroupValue : 0;
            const target = (pc.portfolio.allocations || {})[ticker] || 0;
            return sum + weight * target;
        }, 0);

        const isCash = isCashRow;
        const setting = assetSettings.find(s => s.ticker === ticker);
        const assetClass = isCash
            ? 'Cash'
            : (setting?.assetClass || groupAsset?.assetClass || 'Stock');
        const label = isGroup
            ? (groupMeta[ticker]?.label || ticker)
            : isCash
                ? (groupAsset?.label || ticker)
                : (setting?.label || groupAsset?.label || ticker);

        return { isGroup, groupValue, groupActual, groupWeightedTarget, isCash, assetClass, label };
    };

    return (
        <div className="group-section allocation-card">
            {/* Group header */}
            <div className="group-header">
                <div className="group-title-row">
                    <span className="group-icon">⬡</span>
                    <span className="group-title">{parent.name}</span>
                    <span className="group-children-tags">
                        {children.map(c => (
                            <span key={c.id} className="group-child-tag">{c.name}</span>
                        ))}
                    </span>
                    <span className="group-total-value">{fmt(totalGroupValue)}</span>
                    <div className="group-view-toggle">
                        <button
                            className={viewMode === 'individual' ? 'group-toggle-active' : 'group-toggle-btn'}
                            onClick={() => setViewMode('individual')}
                            title="Single portfolio view"
                        >☰ Single</button>
                        <button
                            className={viewMode === 'grouped' ? 'group-toggle-active' : 'group-toggle-btn'}
                            onClick={() => setViewMode('grouped')}
                            title="Group comparative view"
                        >⬡ Group</button>
                    </div>
                </div>

                <div className="group-composition-bar">
                    {portfolioCalcs.map((pc, i) => {
                        const weight = totalGroupValue > 0 ? (pc.totalValue / totalGroupValue) * 100 : 0;
                        return (
                            <div
                                key={pc.portfolio.id}
                                className="group-bar-segment"
                                style={{
                                    width: `${weight}%`,
                                    backgroundColor: PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length],
                                    minWidth: weight > 0 ? '4px' : '0',
                                }}
                                title={`${pc.portfolio.name}: ${fmt(pc.totalValue)} (${weight.toFixed(1)}%)`}
                            />
                        );
                    })}
                </div>

                <div className="group-legend">
                    {portfolioCalcs.map((pc, i) => {
                        const weight = totalGroupValue > 0 ? (pc.totalValue / totalGroupValue) * 100 : 0;
                        const isParent = pc.portfolio.id === parent.id;
                        return (
                            <span key={pc.portfolio.id} className="group-legend-item">
                                <span
                                    className="group-legend-dot"
                                    style={{ backgroundColor: PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length] }}
                                />
                                {isParent ? <strong>{pc.portfolio.name}</strong> : pc.portfolio.name}
                                {' '}
                                <span className="group-legend-pct">{weight.toFixed(1)}%</span>
                            </span>
                        );
                    })}
                </div>
            </div>

            {/* Inter-portfolio rebalance (Global Rebalancing proportions).
                Portfolio-level only: the asset tables below keep handling the
                rebalance inside each portfolio. */}
            {groupRebalance && (
                <div className="group-rebal-panel">
                    <div className="group-rebal-header">
                        <span className="group-rebal-title">⚖ Portfolio rebalance</span>
                        <span className="group-rebal-targets">
                            global targets: {groupRebalance.members.map(m => `${m.name} ${m.targetShare.toFixed(1).replace(/\.0$/, '')}%`).join(' / ')}
                        </span>
                        {groupRebalance.balanced && (
                            <span className="group-rebal-ok">✓ balanced</span>
                        )}
                    </div>
                    <div className="group-rebal-members">
                        {groupRebalance.members.map(m => {
                            const idx = portfolioCalcs.findIndex(pc => pc.portfolio.id === m.portfolioId);
                            const color = PORTFOLIO_COLORS[(idx >= 0 ? idx : 0) % PORTFOLIO_COLORS.length];
                            const off = Math.abs(m.delta) > groupRebalance.tolerance;
                            return (
                                <span key={m.portfolioId} className="group-rebal-member">
                                    <span className="group-legend-dot" style={{ backgroundColor: color }} />
                                    <span className="group-rebal-member-name">
                                        {m.portfolioId === parent.id ? <strong>{m.name}</strong> : m.name}
                                    </span>
                                    <span className="group-rebal-member-shares">
                                        {m.currentShare.toFixed(1)}% → {m.targetShare.toFixed(1)}%
                                    </span>
                                    <span className={`group-rebal-delta ${!off ? 'group-rebal-delta-ok' : m.delta > 0 ? 'group-rebal-delta-buy' : 'group-rebal-delta-sell'}`}>
                                        {!off ? '✓' : <>{m.delta > 0 ? '▲' : '▼'} {fmt(Math.abs(m.delta))}</>}
                                    </span>
                                </span>
                            );
                        })}
                    </div>
                    {!groupRebalance.balanced && (
                        <div className="group-rebal-actions">
                            <div className="group-rebal-action">
                                <span className="group-rebal-mode group-rebal-mode-sellbuy">Sell + Buy</span>
                                {groupRebalance.transfers.length > 0 ? (
                                    groupRebalance.transfers.map((t, i) => (
                                        <span key={i} className="group-rebal-transfer">
                                            {t.fromName} <span className="group-rebal-arrow">▶</span> {t.toName} · <strong>{fmt(t.amount)}</strong>
                                        </span>
                                    ))
                                ) : (
                                    <span className="group-rebal-muted">—</span>
                                )}
                            </div>
                            <div className="group-rebal-action">
                                <span className="group-rebal-mode group-rebal-mode-buyonly">Buy Only</span>
                                {groupRebalance.buyOnlyRequired > 0 ? (
                                    <>
                                        <span>add <strong>{fmt(groupRebalance.buyOnlyRequired)}</strong> fresh liquidity:</span>
                                        {groupRebalance.members
                                            .filter(m => m.buyOnlyAmount >= 1)
                                            .map(m => (
                                                <span key={m.portfolioId} className="group-rebal-transfer">
                                                    ▲ {m.name} · <strong>{fmt(m.buyOnlyAmount)}</strong>
                                                </span>
                                            ))}
                                    </>
                                ) : (
                                    <span className="group-rebal-muted">—</span>
                                )}
                                {groupRebalance.buyOnlyUnreachable && (
                                    <span className="group-rebal-muted">
                                        (a 0%-target portfolio holds value — not fully reachable without selling)
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                    {groupRebalance.uncovered.length > 0 && (
                        <div className="group-rebal-muted">
                            No global target (excluded from this plan): {groupRebalance.uncovered.join(', ')}
                        </div>
                    )}
                </div>
            )}

            {/* Individual view */}
            {viewMode === 'individual' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                    {portfolioCalcs.map((pc, i) => {
                        const isParent = pc.portfolio.id === parent.id;
                        const color = PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length];
                        return (
                            <div key={pc.portfolio.id}>
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                                    marginBottom: '0.5rem', padding: '0.35rem 0.75rem',
                                    background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
                                    border: `1px solid ${color}33`,
                                    borderLeft: `3px solid ${color}`,
                                }}>
                                    <span style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color }}>
                                        {isParent ? '⬡ Parent' : '↳ Child'}
                                    </span>
                                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {isParent
                                            ? `Group with: ${children.map(c => c.name).join(', ')}`
                                            : `Part of: ${parent.name}`}
                                    </span>
                                </div>
                                <PortfolioAllocationTable
                                    portfolio={pc.portfolio}
                                    allTransactions={allTransactions}
                                    assetSettings={assetSettings}
                                    marketData={marketData}
                                    brokers={brokers}
                                    onUpdatePortfolio={onUpdatePortfolio}
                                    onAddTransactions={onAddTransactions}
                                />
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Comparison table + action bars */}
            {viewMode === 'grouped' && (<>
            <div className="ct-scroll-wrapper desktop-only">
                <div
                    className="ct-table"
                    style={{ minWidth: `${220 + 130 + portfolioCalcs.length * 190}px` }}
                >
                    {/* Header row */}
                    <div className="ct-row ct-header-row">
                        <div className="ct-col ct-col-asset ct-header-cell">Asset</div>
                        <div className="ct-col ct-col-group ct-header-cell">
                            <div>Group</div>
                            <div className="ct-subheader">{fmt(totalGroupValue)}</div>
                        </div>
                        {portfolioCalcs.map((pc, i) => (
                            <div
                                key={pc.portfolio.id}
                                className="ct-col ct-col-portfolio ct-header-cell"
                                style={{ borderTop: `3px solid ${PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length]}` }}
                            >
                                <div className="ct-portfolio-name">
                                    {pc.portfolio.id === parent.id ? <strong>{pc.portfolio.name}</strong> : pc.portfolio.name}
                                </div>
                                <div className="ct-subheader">{fmt(pc.totalValue)}</div>
                                {(pc.portfolio.liquidity || 0) > 0 && (
                                    <div className="ct-subheader" style={{ color: '#3B82F6' }}>
                                        Liq: {fmt(pc.portfolio.liquidity || 0)}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {/* Data rows */}
                    {allTickers.length === 0 ? (
                        <div className="ct-empty">No assets or targets configured.</div>
                    ) : (
                        allTickers.map(ticker => {
                            const { isGroup, groupValue, groupActual, groupWeightedTarget, isCash, assetClass, label } = deriveTickerRow(ticker);

                            return (
                                <div key={ticker} className="ct-row ct-data-row">
                                    <div className="ct-col ct-col-asset">
                                        <span
                                            className="ct-dot"
                                            style={{ backgroundColor: getColorForClass(assetClass) }}
                                        />
                                        <span className="ct-label">{label}</span>
                                    </div>

                                    <div className="ct-col ct-col-group">
                                        <div className="ct-group-value">{fmt(groupValue)}</div>
                                        <div className="ct-group-actual">{groupActual.toFixed(1)}%</div>
                                        {groupWeightedTarget > 0.05 && (
                                            <div className="ct-group-target">
                                                T: {groupWeightedTarget.toFixed(1)}%
                                            </div>
                                        )}
                                    </div>

                                    {portfolioCalcs.map(pc => {
                                        const { actual, target, diff, hasPosition, hasTarget, rebalShares, rebalAmount, buyOnlyShares, buyOnlyAmount, inGroupLabel } = computeCell(pc, ticker, isGroup, isCash);

                                        if (inGroupLabel) {
                                            return (
                                                <div key={pc.portfolio.id} className="ct-col ct-col-portfolio ct-cell-empty">
                                                    <span title={`Counted in the "${inGroupLabel}" group row`}>↳ {inGroupLabel}</span>
                                                </div>
                                            );
                                        }

                                        if (!hasPosition && !hasTarget) {
                                            return (
                                                <div key={pc.portfolio.id} className="ct-col ct-col-portfolio ct-cell-empty">
                                                    <span>—</span>
                                                </div>
                                            );
                                        }

                                        const groupRebalOk = Math.abs(rebalAmount) < 1;
                                        return (
                                            <div key={pc.portfolio.id} className="ct-col ct-col-portfolio">
                                                {hasTarget && (
                                                    <div className="ct-cell-target">T: {target}%</div>
                                                )}
                                                <div className="ct-cell-actual">{actual.toFixed(1)}%</div>
                                                {hasTarget && (
                                                    <div className={`ct-cell-diff ${diff > 0.5 ? 'ct-diff-over' : diff < -0.5 ? 'ct-diff-under' : 'ct-diff-ok'}`}>
                                                        {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                                                    </div>
                                                )}
                                                {!isCash && !isGroup && hasTarget && (
                                                    <div className={`ct-cell-action ${rebalShares > 0 ? 'ct-action-buy' : rebalShares < 0 ? 'ct-action-sell' : 'ct-action-ok'}`}>
                                                        {rebalShares === 0
                                                            ? <span className="ct-ok-badge">✓</span>
                                                            : <>{rebalShares > 0 ? '▲' : '▼'} {Math.abs(rebalShares)} · {fmt(Math.abs(rebalAmount))}</>
                                                        }
                                                    </div>
                                                )}
                                                {isGroup && hasTarget && (
                                                    <div className={`ct-cell-action ${groupRebalOk ? 'ct-action-ok' : rebalAmount > 0 ? 'ct-action-buy' : 'ct-action-sell'}`}>
                                                        {groupRebalOk
                                                            ? <span className="ct-ok-badge">✓</span>
                                                            : <>{rebalAmount > 0 ? '▲' : '▼'} {fmt(Math.abs(rebalAmount))}</>
                                                        }
                                                    </div>
                                                )}
                                                {!isCash && !isGroup && buyOnlyShares > 0 && (
                                                    <div className="ct-cell-buyonly">
                                                        <span className="ct-buyonly-label">buy only</span>
                                                        ▲ {buyOnlyShares} · {fmt(buyOnlyAmount)}
                                                    </div>
                                                )}
                                                {isGroup && buyOnlyAmount >= 1 && (
                                                    <div className="ct-cell-buyonly">
                                                        <span className="ct-buyonly-label">buy only</span>
                                                        ▲ {fmt(buyOnlyAmount)}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Mobile comparison: per-portfolio totals strip (the info that lives in
                the matrix header cells on desktop) + dense expandable asset rows. */}
            <div className="mobile-only">
                <div className="ct-mobile-totals">
                    {portfolioCalcs.map((pc, i) => (
                        <span key={pc.portfolio.id} className="ct-mobile-total-chip">
                            <span
                                className="group-legend-dot"
                                style={{ backgroundColor: PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length] }}
                            />
                            {pc.portfolio.id === parent.id ? <strong>{pc.portfolio.name}</strong> : pc.portfolio.name}
                            <span className="ct-mobile-total-value">{fmt(pc.totalValue)}</span>
                            {(pc.portfolio.liquidity || 0) > 0 && (
                                <span style={{ color: '#3B82F6' }}>Liq {fmt(pc.portfolio.liquidity || 0)}</span>
                            )}
                        </span>
                    ))}
                </div>
                {allTickers.length === 0 ? (
                    <div className="ct-empty">No assets or targets configured.</div>
                ) : (
                    <div className="mrow-list">
                        {allTickers.map(ticker => {
                            const row = deriveTickerRow(ticker);
                            return (
                                <ComparisonMobileRow
                                    key={ticker}
                                    label={row.label}
                                    assetClass={row.assetClass}
                                    isCash={row.isCash}
                                    isGroup={row.isGroup}
                                    groupValue={row.groupValue}
                                    groupActual={row.groupActual}
                                    groupWeightedTarget={row.groupWeightedTarget}
                                    cells={portfolioCalcs.map((pc, i) => ({
                                        id: pc.portfolio.id,
                                        name: pc.portfolio.name,
                                        isParent: pc.portfolio.id === parent.id,
                                        color: PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length],
                                        cell: computeCell(pc, ticker, row.isGroup, row.isCash),
                                    }))}
                                />
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Per-portfolio action bars */}
            <div className="group-action-bars">
                {portfolioCalcs.map((pc, i) => (
                    <PortfolioActionBar
                        key={pc.portfolio.id}
                        portfolioCalc={pc}
                        color={PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length]}
                        resolved={resolvedByPortfolio[pc.portfolio.id]}
                        marketData={marketData}
                        buyOnly={portfolioBuyOnlyMap[pc.portfolio.id] || EMPTY_BUY_ONLY}
                        allTransactions={allTransactions}
                        brokers={brokers}
                        onUpdatePortfolio={onUpdatePortfolio}
                        onAddTransactions={onAddTransactions}
                    />
                ))}
            </div>
            </>)}

            <style>{`
                .group-section {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-4);
                }

                /* ── Header ── */
                .group-header {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                }

                .group-title-row {
                    display: flex;
                    align-items: center;
                    gap: var(--space-2);
                    flex-wrap: wrap;
                }

                .group-icon { font-size: 1rem; color: var(--text-muted); }
                .group-title { font-size: 1.1rem; font-weight: 700; color: var(--text-primary); }

                .group-children-tags { display: flex; gap: var(--space-1); flex-wrap: wrap; }

                .group-view-toggle {
                    display: flex;
                    gap: 2px;
                    margin-left: var(--space-2);
                    background: var(--bg-surface);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    padding: 2px;
                    flex-shrink: 0;
                }
                .group-toggle-btn, .group-toggle-active {
                    font-size: 0.78rem;
                    font-weight: 500;
                    padding: 3px 10px;
                    border-radius: calc(var(--radius-md) - 2px);
                    border: none;
                    cursor: pointer;
                    transition: all 0.15s;
                    white-space: nowrap;
                }
                .group-toggle-btn {
                    background: transparent;
                    color: var(--text-muted);
                }
                .group-toggle-btn:hover { color: var(--text-secondary); background: var(--bg-card); }
                .group-toggle-active {
                    background: var(--color-primary);
                    color: #fff;
                    font-weight: 600;
                }

                .group-child-tag {
                    font-size: 0.78rem;
                    background: var(--bg-surface);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-full);
                    padding: 2px 8px;
                    color: var(--text-secondary);
                }

                .group-total-value {
                    margin-left: auto;
                    font-size: 1rem;
                    font-weight: 600;
                    color: var(--text-primary);
                }

                .group-composition-bar {
                    display: flex;
                    height: 8px;
                    border-radius: var(--radius-full);
                    overflow: hidden;
                    gap: 2px;
                    background: var(--bg-surface);
                }

                .group-bar-segment { height: 100%; border-radius: 2px; transition: width 0.3s ease; }

                .group-legend { display: flex; gap: var(--space-4); flex-wrap: wrap; }

                .group-legend-item {
                    display: flex;
                    align-items: center;
                    gap: var(--space-1);
                    font-size: 0.85rem;
                    color: var(--text-secondary);
                }

                .group-legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
                .group-legend-pct { color: var(--text-muted); font-size: 0.78rem; }

                /* ── Inter-portfolio rebalance panel ── */
                .group-rebal-panel {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                    padding: var(--space-3);
                    background: var(--bg-surface);
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                }
                .group-rebal-header {
                    display: flex;
                    align-items: baseline;
                    gap: var(--space-2);
                    flex-wrap: wrap;
                }
                .group-rebal-title {
                    font-size: 0.8rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--text-secondary);
                }
                .group-rebal-targets { font-size: 0.78rem; color: var(--text-muted); }
                .group-rebal-ok {
                    font-size: 0.75rem;
                    font-weight: 600;
                    color: var(--color-success);
                    margin-left: auto;
                    white-space: nowrap;
                }
                .group-rebal-members {
                    display: flex;
                    gap: var(--space-2) var(--space-4);
                    flex-wrap: wrap;
                }
                .group-rebal-member {
                    display: flex;
                    align-items: center;
                    gap: var(--space-1);
                    font-size: 0.85rem;
                    color: var(--text-secondary);
                    flex-wrap: wrap;
                }
                .group-rebal-member-name { color: var(--text-primary); }
                .group-rebal-member-shares { color: var(--text-muted); font-size: 0.78rem; }
                .group-rebal-delta {
                    font-size: 0.78rem;
                    font-weight: 600;
                    padding: 1px 5px;
                    border-radius: 3px;
                }
                .group-rebal-delta-buy  { color: var(--color-success); background: rgba(16,185,129,0.08); }
                .group-rebal-delta-sell { color: var(--color-danger);  background: rgba(239,68,68,0.08); }
                .group-rebal-delta-ok   { color: var(--text-muted); }
                .group-rebal-actions {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-1);
                }
                .group-rebal-action {
                    display: flex;
                    align-items: center;
                    gap: var(--space-2);
                    flex-wrap: wrap;
                    font-size: 0.82rem;
                    color: var(--text-secondary);
                }
                .group-rebal-mode {
                    font-size: 0.65rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    padding: 1px 6px;
                    border-radius: 3px;
                    white-space: nowrap;
                }
                .group-rebal-mode-sellbuy { color: var(--color-warning, #F59E0B); background: rgba(245,158,11,0.12); }
                .group-rebal-mode-buyonly { color: #3B82F6; background: rgba(59,130,246,0.10); }
                .group-rebal-transfer { min-width: 0; }
                .group-rebal-arrow { color: var(--text-muted); font-size: 0.7rem; }
                .group-rebal-muted { font-size: 0.75rem; color: var(--text-muted); }

                /* ── Comparison Table ── */
                .ct-scroll-wrapper {
                    overflow-x: auto;
                    -webkit-overflow-scrolling: touch;
                    border-radius: var(--radius-md);
                    border: 1px solid var(--border-color);
                }

                .ct-table { display: flex; flex-direction: column; }

                .ct-row {
                    display: flex;
                    border-bottom: 1px solid var(--border-color);
                }
                .ct-row:last-child { border-bottom: none; }

                .ct-header-row {
                    background: var(--bg-surface);
                    position: sticky;
                    top: 0;
                    z-index: 2;
                }

                .ct-data-row:hover { background: var(--bg-surface); }

                .ct-col {
                    padding: var(--space-2) var(--space-3);
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    gap: 2px;
                    flex-shrink: 0;
                }

                .ct-col-asset {
                    width: 180px;
                    flex-direction: row;
                    align-items: center;
                    gap: var(--space-2);
                    position: sticky;
                    left: 0;
                    background: var(--bg-card);
                    z-index: 1;
                    border-right: 1px solid var(--border-color);
                }

                .ct-header-row .ct-col-asset { background: var(--bg-surface); }

                .ct-col-group {
                    width: 120px;
                    text-align: center;
                    align-items: center;
                    border-right: 1px solid var(--border-color);
                }

                .ct-col-portfolio {
                    width: 175px;
                    text-align: center;
                    align-items: center;
                    border-right: 1px solid var(--border-color);
                }
                .ct-col-portfolio:last-child { border-right: none; }

                .ct-header-cell { font-weight: 600; font-size: 0.85rem; color: var(--text-secondary); }
                .ct-subheader { font-size: 0.75rem; color: var(--text-muted); font-weight: normal; }

                .ct-portfolio-name {
                    font-size: 0.85rem;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 165px;
                }

                .ct-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

                .ct-label {
                    font-size: 0.9rem;
                    font-weight: 500;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .ct-group-value { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
                .ct-group-actual { font-size: 0.85rem; color: var(--text-secondary); }
                .ct-group-target { font-size: 0.72rem; color: var(--text-muted); }

                .ct-cell-target { font-size: 0.72rem; color: var(--text-muted); }
                .ct-cell-actual { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }

                .ct-cell-diff { font-size: 0.75rem; font-weight: 500; }
                .ct-diff-over  { color: var(--color-success); }
                .ct-diff-under { color: var(--color-danger); }
                .ct-diff-ok    { color: var(--text-muted); }

                /* Rebalance action row */
                .ct-cell-action {
                    font-size: 0.75rem;
                    font-weight: 600;
                    margin-top: 2px;
                    padding: 1px 4px;
                    border-radius: 3px;
                    line-height: 1.3;
                }
                .ct-action-buy  { color: var(--color-success); background: rgba(16,185,129,0.08); }
                .ct-action-sell { color: var(--color-danger);  background: rgba(239,68,68,0.08); }
                .ct-action-ok   { color: var(--text-muted); }
                .ct-ok-badge    { font-size: 0.8rem; }

                /* Buy-only row */
                .ct-cell-buyonly {
                    font-size: 0.75rem;
                    color: #3B82F6;
                    font-weight: 600;
                    margin-top: 2px;
                    padding: 1px 4px;
                    border-radius: 3px;
                    background: rgba(59,130,246,0.10);
                    line-height: 1.3;
                    display: flex;
                    align-items: center;
                    gap: 3px;
                }
                .ct-buyonly-label {
                    font-size: 0.65rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    opacity: 0.7;
                }

                .ct-cell-empty { color: var(--text-muted); font-size: 0.85rem; }
                .ct-empty { padding: var(--space-4); color: var(--text-muted); font-size: 0.9rem; }

                /* ── Action bars ── */
                .group-action-bars { display: flex; flex-direction: column; gap: var(--space-2); }

                .group-action-bar {
                    display: flex;
                    align-items: center;
                    gap: var(--space-3);
                    padding: var(--space-3) var(--space-4);
                    border-radius: var(--radius-md);
                    background: var(--bg-surface);
                    border: 1px solid var(--border-color);
                    flex-wrap: wrap;
                }

                .group-action-bar-name { font-weight: 600; font-size: 0.9rem; color: var(--text-primary); min-width: 100px; }

                .group-action-bar-controls {
                    display: flex;
                    align-items: center;
                    gap: var(--space-2);
                    flex-wrap: wrap;
                }

                .group-action-bar-controls label { font-size: 0.85rem; color: var(--text-muted); white-space: nowrap; }

                .group-liquidity-hint { font-size: 0.78rem; color: var(--text-muted); cursor: pointer; white-space: nowrap; }
                .group-liquidity-hint:hover { color: var(--text-secondary); text-decoration: underline; }

                .group-action-bar-buttons { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-left: auto; }

                /* ── Mobile ──
                   The desktop matrix hides at 768px (.desktop-only) and the
                   mrow-based mobile list takes over (styles/mobile-list.css). */
                .ct-mobile-totals {
                    display: flex;
                    flex-wrap: wrap;
                    gap: var(--space-2) var(--space-3);
                    padding: var(--space-2) 0;
                    margin-bottom: var(--space-2);
                    border-bottom: 1px solid var(--border-color);
                }
                .ct-mobile-total-chip {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                    font-size: 0.75rem;
                    color: var(--text-secondary);
                    white-space: nowrap;
                }
                .ct-mobile-total-value { font-weight: 600; color: var(--text-primary); }
                .ct-mobile-cell-values {
                    display: flex;
                    align-items: baseline;
                    gap: var(--space-2);
                    flex-wrap: wrap;
                }

                @media (max-width: 768px) {
                    .group-action-bar { flex-direction: column; align-items: flex-start; }
                    .group-action-bar-buttons { margin-left: 0; width: 100%; }
                    .group-action-bar-buttons button { flex: 1; }
                }
            `}</style>
        </div>
    );
};

/* ─── Mobile comparison row ─── */

interface ComparisonCellData {
    currentValue: number;
    actual: number;
    target: number;
    diff: number;
    hasPosition: boolean;
    hasTarget: boolean;
    rebalShares: number;
    rebalAmount: number;
    buyOnlyShares: number;
    buyOnlyAmount: number;
    /** Set when the ticker is held here but grouped: its value lives in this group's row. */
    inGroupLabel?: string;
}

interface ComparisonMobileRowProps {
    label: string;
    assetClass: string;
    isCash: boolean;
    isGroup: boolean;
    groupValue: number;
    groupActual: number;
    groupWeightedTarget: number;
    cells: Array<{ id: string; name: string; isParent: boolean; color: string; cell: ComparisonCellData }>;
}

/**
 * Dense expandable mobile row for the comparison matrix (mrow pattern,
 * styles/mobile-list.css). Collapsed: asset + group aggregate; expanded: the
 * full per-portfolio breakdown (target/actual/diff/rebalance/buy-only) that
 * the desktop matrix shows as columns.
 */
const ComparisonMobileRow: React.FC<ComparisonMobileRowProps> = ({
    label, assetClass, isCash, isGroup, groupValue, groupActual, groupWeightedTarget, cells,
}) => {
    const [expanded, setExpanded] = useState(false);
    const showActions = !isCash;
    const actionsCount = showActions
        ? cells.filter(c =>
            (c.cell.hasTarget && (isGroup ? Math.abs(c.cell.rebalAmount) >= 1 : c.cell.rebalShares !== 0))
            || (isGroup ? c.cell.buyOnlyAmount >= 1 : c.cell.buyOnlyShares > 0)
        ).length
        : 0;

    return (
        <div className={`mrow ${expanded ? 'is-open' : ''}`}>
            <div className="mrow-head" onClick={() => setExpanded(v => !v)}>
                <span className="mrow-chevron">▶</span>
                <div className="mrow-main">
                    <div className="mrow-line1">
                        <span className="ct-dot" style={{ backgroundColor: getColorForClass(assetClass), flex: '0 0 auto' }} />
                        <span className="mrow-title">{label}</span>
                    </div>
                    <div className="mrow-line2">
                        <span>Group {groupActual.toFixed(1)}%{groupWeightedTarget > 0.05 && ` / T ${groupWeightedTarget.toFixed(1)}%`}</span>
                        {actionsCount > 0 && (
                            <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                                {actionsCount} action{actionsCount !== 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                </div>
                <div className="mrow-side">
                    <div className="mrow-side-primary">{fmt(groupValue)}</div>
                    {groupWeightedTarget > 0.05 && (
                        <div className={`mrow-side-secondary ${groupActual - groupWeightedTarget > 0.5 ? 'ct-diff-over' : groupActual - groupWeightedTarget < -0.5 ? 'ct-diff-under' : 'ct-diff-ok'}`}>
                            {groupActual - groupWeightedTarget > 0 ? '+' : ''}{(groupActual - groupWeightedTarget).toFixed(1)}%
                        </div>
                    )}
                </div>
            </div>
            {expanded && (
                <div className="mrow-details">
                    {cells.map(({ id, name, isParent, color, cell }) => (
                        <div key={id} className="mrow-detail mrow-detail--wide">
                            <span className="mrow-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span className="group-legend-dot" style={{ backgroundColor: color }} />
                                {isParent ? <strong>{name}</strong> : name}
                            </span>
                            {cell.inGroupLabel ? (
                                <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>↳ {cell.inGroupLabel}</span>
                            ) : !cell.hasPosition && !cell.hasTarget ? (
                                <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>—</span>
                            ) : (
                                <span className="mrow-value ct-mobile-cell-values">
                                    {cell.hasTarget && <span className="ct-cell-target">T: {cell.target}%</span>}
                                    <span className="ct-cell-actual">{cell.actual.toFixed(1)}%</span>
                                    {cell.hasTarget && (
                                        <span className={`ct-cell-diff ${cell.diff > 0.5 ? 'ct-diff-over' : cell.diff < -0.5 ? 'ct-diff-under' : 'ct-diff-ok'}`}>
                                            {cell.diff > 0 ? '+' : ''}{cell.diff.toFixed(1)}%
                                        </span>
                                    )}
                                    {showActions && !isGroup && cell.hasTarget && (
                                        <span className={`ct-cell-action ${cell.rebalShares > 0 ? 'ct-action-buy' : cell.rebalShares < 0 ? 'ct-action-sell' : 'ct-action-ok'}`}>
                                            {cell.rebalShares === 0
                                                ? <span className="ct-ok-badge">✓</span>
                                                : <>{cell.rebalShares > 0 ? '▲' : '▼'} {Math.abs(cell.rebalShares)} · {fmt(Math.abs(cell.rebalAmount))}</>
                                            }
                                        </span>
                                    )}
                                    {showActions && isGroup && cell.hasTarget && (
                                        <span className={`ct-cell-action ${Math.abs(cell.rebalAmount) < 1 ? 'ct-action-ok' : cell.rebalAmount > 0 ? 'ct-action-buy' : 'ct-action-sell'}`}>
                                            {Math.abs(cell.rebalAmount) < 1
                                                ? <span className="ct-ok-badge">✓</span>
                                                : <>{cell.rebalAmount > 0 ? '▲' : '▼'} {fmt(Math.abs(cell.rebalAmount))}</>
                                            }
                                        </span>
                                    )}
                                    {showActions && !isGroup && cell.buyOnlyShares > 0 && (
                                        <span className="ct-cell-buyonly">
                                            <span className="ct-buyonly-label">buy only</span>
                                            ▲ {cell.buyOnlyShares} · {fmt(cell.buyOnlyAmount)}
                                        </span>
                                    )}
                                    {showActions && isGroup && cell.buyOnlyAmount >= 1 && (
                                        <span className="ct-cell-buyonly">
                                            <span className="ct-buyonly-label">buy only</span>
                                            ▲ {fmt(cell.buyOnlyAmount)}
                                        </span>
                                    )}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

/* ─── Per-portfolio action bar ─── */
interface ActionBarProps {
    portfolioCalc: PortfolioCalc;
    color: string;
    resolved: ResolvedGroups;
    marketData: Record<string, { price: number; lastUpdated: string }>;
    buyOnly: BuyOnlyPlan;
    allTransactions: Transaction[];
    brokers: Broker[];
    onUpdatePortfolio: (portfolio: Portfolio) => void;
    onAddTransactions: (transactions: Transaction[]) => void;
}

const PortfolioActionBar: React.FC<ActionBarProps> = ({
    portfolioCalc,
    color,
    resolved,
    marketData,
    buyOnly,
    allTransactions,
    brokers,
    onUpdatePortfolio,
    onAddTransactions,
}) => {
    const { portfolio, assets, totalValue, transactions } = portfolioCalc;
    const [isWithdrawalOpen, setIsWithdrawalOpen] = React.useState(false);
    const allocations = portfolio.allocations || {};

    // Group-aware: each allocation group counts as one unit (its target lives
    // on the group id, not on the member tickers).
    const requiredLiquidity = useMemo(() => {
        const { tickerToGroupId, groupById } = resolved;
        const units: { currentValue: number; targetPerc: number }[] = [];
        assets.forEach(a => {
            if (isCashTicker(a.ticker) || tickerToGroupId[a.ticker.toUpperCase()]) return;
            units.push({ currentValue: a.currentValue, targetPerc: allocations[a.ticker] || 0 });
        });
        Object.values(groupById).forEach(group => {
            const memberInfo = memberInfoFromAssets(group.members, assets, marketData);
            units.push({
                currentValue: Object.values(memberInfo).reduce((s, mi) => s + mi.currentValue, 0),
                targetPerc: allocations[group.id] || 0,
            });
        });
        return requiredLiquidityForFullBuyOnly(units);
    }, [assets, allocations, resolved, marketData]);

    const handleExecuteRebalance = async (mode: 'Full' | 'BuyOnly') => {
        const Swal = (await import('sweetalert2')).default;
        const toCreate: Transaction[] = [];
        const { tickerToGroupId, groupById } = resolved;

        const pushTx = (ticker: string, shares: number, price: number) => {
            if (shares === 0 || price <= 0) return;
            const lastTx = allTransactions
                .filter(t => t.ticker === ticker && t.portfolioId === portfolio.id)
                .pop();
            toCreate.push({
                id: `auto-rebal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                portfolioId: portfolio.id,
                ticker,
                date: new Date().toISOString().split('T')[0],
                amount: Math.abs(shares),
                price,
                direction: shares > 0 ? 'Buy' : 'Sell',
                brokerId: lastTx?.brokerId,
            });
        };

        // Standalone tickers. Group members are traded through their group
        // below — treating them as standalone (target 0) would sell them off.
        const unitKeys = new Set<string>([
            ...assets.map(a => a.ticker),
            ...Object.keys(allocations),
        ]);
        unitKeys.forEach(ticker => {
            if (isCashTicker(ticker) || isGroupKey(ticker) || tickerToGroupId[ticker.toUpperCase()]) return;
            const asset = assets.find(a => a.ticker === ticker);
            const price = asset?.currentPrice || 0;
            const targetPerc = allocations[ticker] || 0;
            const quantity = asset?.quantity || 0;
            if (quantity <= 0 && targetPerc <= 0) return;

            let shares = 0;
            if (mode === 'Full') {
                const diff = totalValue * (targetPerc / 100) - (asset?.currentValue || 0);
                if (price > 0) shares = Math.round(diff / price);
            } else {
                const buyAmt = buyOnly.byUnit[ticker] || 0;
                if (price > 0) shares = Math.round(buyAmt / price);
            }
            pushTx(ticker, shares, price);
        });

        // Allocation groups: Full distributes the group delta by member rules;
        // Buy Only uses the member buys already routed by the buy-only plan.
        Object.values(groupById).forEach(group => {
            const memberInfo = memberInfoFromAssets(group.members, assets, marketData);
            let actions: MemberAction[];
            if (mode === 'Full') {
                const currentValue = Object.values(memberInfo).reduce((s, mi) => s + mi.currentValue, 0);
                const delta = totalValue * ((allocations[group.id] || 0) / 100) - currentValue;
                actions = Object.values(distributeGroupDelta({
                    deltaEur: delta,
                    members: group.members,
                    memberInfo,
                    rules: group.memberRules,
                }).actions);
            } else {
                actions = group.members
                    .map(m => buyOnly.memberBuy[m.toUpperCase()])
                    .filter((a): a is MemberAction => !!a);
            }
            actions.forEach(a => pushTx(a.ticker, a.shares, memberInfo[a.ticker.toUpperCase()]?.price || 0));
        });

        if (toCreate.length === 0) {
            Swal.fire({ title: 'No Actions', text: 'No actions needed for this mode.', icon: 'info', confirmButtonColor: '#3B82F6' });
            return;
        }

        const label = mode === 'Full' ? 'Full Rebalance' : 'Buy Only';
        const result = await Swal.fire({
            title: `Execute ${label}?`,
            html: `This will create <b>${toCreate.length}</b> transactions for <b>${portfolio.name}</b>.`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, Create Transactions',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#10B981',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
        });

        if (result.isConfirmed) {
            onAddTransactions(toCreate);
            Swal.fire({
                title: 'Success',
                text: `${toCreate.length} transactions created!`,
                icon: 'success',
                timer: 2000,
                showConfirmButton: false,
                background: 'var(--bg-card)',
                color: 'var(--text-primary)',
            });
        }
    };

    return (
        <div className="group-action-bar" style={{ borderLeft: `3px solid ${color}` }}>
            <div className="group-action-bar-name">{portfolio.name}</div>
            <div className="group-action-bar-controls">
                <label>Liquidity:</label>
                <input
                    type="number"
                    placeholder="0.00"
                    value={portfolio.liquidity !== undefined ? portfolio.liquidity : ''}
                    onChange={e => {
                        const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                        onUpdatePortfolio({ ...portfolio, liquidity: val });
                    }}
                    style={{
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-color)',
                        width: '100px',
                        textAlign: 'right',
                        padding: '2px 6px',
                        background: 'var(--bg-background)',
                        color: 'var(--text-primary)',
                        fontSize: '0.85rem',
                    }}
                />
                <span
                    className="group-liquidity-hint"
                    title="Click to set this value"
                    onClick={() => onUpdatePortfolio({ ...portfolio, liquidity: parseFloat(requiredLiquidity.toFixed(2)) })}
                >
                    (Req: <span style={{ textDecoration: 'underline' }}>€{requiredLiquidity.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</span>)
                </span>
            </div>
            <div className="group-action-bar-buttons">
                <button
                    className="btn-secondary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => setIsWithdrawalOpen(true)}
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

            <WithdrawalModal
                isOpen={isWithdrawalOpen}
                onClose={() => setIsWithdrawalOpen(false)}
                assets={assets}
                portfolio={portfolio}
                brokers={brokers}
                transactions={transactions}
            />
        </div>
    );
};

export default PortfolioGroupSection;
