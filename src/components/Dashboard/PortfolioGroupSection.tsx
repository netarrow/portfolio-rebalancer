import React, { useMemo } from 'react';
import {
    calculateAssets,
    calculateRequiredLiquidityForOnlyBuy,
    injectCashAssets,
    isCashTicker,
} from '../../utils/portfolioCalculations';
import { WithdrawalModal } from './WithdrawalModal';
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

function computeBuyOnly(
    pc: PortfolioCalc,
    allTickers: string[],
): Record<string, number> {
    const liq = pc.portfolio.liquidity || 0;
    if (liq <= 0) return {};
    const allocations = pc.portfolio.allocations || {};

    const candidates = allTickers
        .filter(t => !isCashTicker(t))
        .map(ticker => {
            const asset = pc.assets.find(a => a.ticker === ticker);
            const currentValue = asset?.currentValue || 0;
            const price = asset?.currentPrice || 0;
            const targetPerc = allocations[ticker] || 0;
            const gap = pc.totalValue * (targetPerc / 100) - currentValue;
            return { ticker, gap, price };
        })
        .filter(c => c.gap > 0 && c.price > 0);

    const totalGap = candidates.reduce((s, c) => s + c.gap, 0);
    if (totalGap <= 0) return {};

    let dist = candidates.map(c => {
        const rawAlloc = (c.gap / totalGap) * liq;
        const idealShares = rawAlloc / c.price;
        const floored = Math.floor(idealShares);
        return { ...c, shares: floored, fraction: idealShares - floored, cost: floored * c.price };
    });

    let remaining = liq - dist.reduce((s, d) => s + d.cost, 0);
    const sorted = dist.map((_, i) => i).sort((a, b) => dist[b].fraction - dist[a].fraction);
    for (const idx of sorted) {
        if (remaining >= dist[idx].price) {
            dist[idx].shares += 1;
            dist[idx].cost += dist[idx].price;
            remaining -= dist[idx].price;
        }
    }

    const result: Record<string, number> = {};
    dist.forEach(d => { if (d.shares > 0) result[d.ticker] = d.shares * d.price; });
    return result;
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
    const allPortfolios = useMemo(() => [parent, ...children], [parent, children]);

    const portfolioCalcs = useMemo((): PortfolioCalc[] => {
        return allPortfolios.map(portfolio => {
            const transactions = allTransactions.filter(t => t.portfolioId === portfolio.id);
            const { assets: rawAssets, summary } = calculateAssets(transactions, assetSettings, marketData);
            const assets = injectCashAssets(rawAssets, brokers, portfolio.id);
            const cashAssetsValue = assets
                .filter(a => isCashTicker(a.ticker))
                .reduce((s, a) => s + a.currentValue, 0);
            const totalValue = summary.totalValue + (portfolio.liquidity || 0) + cashAssetsValue;
            return { portfolio, assets, summary, totalValue, cashAssetsValue, transactions };
        });
    }, [allPortfolios, allTransactions, assetSettings, marketData, brokers]);

    const totalGroupValue = portfolioCalcs.reduce((s, pc) => s + pc.totalValue, 0);

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

    const allTickers = useMemo(() => {
        const set = new Set<string>();
        portfolioCalcs.forEach(pc => {
            pc.assets.forEach(a => { if (a.quantity > 0 || a.currentValue > 0) set.add(a.ticker); });
            Object.entries(pc.portfolio.allocations || {}).forEach(([t, pct]) => {
                if (pct > 0) set.add(t);
            });
        });
        return Array.from(set).sort();
    }, [portfolioCalcs]);

    // Pre-compute buy-only allocations for every portfolio (used in table + action bars)
    const portfolioBuyOnlyMap = useMemo(() => {
        const map: Record<string, Record<string, number>> = {};
        portfolioCalcs.forEach(pc => {
            map[pc.portfolio.id] = computeBuyOnly(pc, allTickers);
        });
        return map;
    }, [portfolioCalcs, allTickers]);

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

            {/* Comparison table */}
            <div className="ct-scroll-wrapper">
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
                            const groupAsset = groupAssets.find(a => a.ticker === ticker);
                            const groupValue = groupAsset?.currentValue || 0;
                            const groupActual = totalGroupValue > 0 ? (groupValue / totalGroupValue) * 100 : 0;

                            const groupWeightedTarget = portfolioCalcs.reduce((sum, pc) => {
                                const weight = totalGroupValue > 0 ? pc.totalValue / totalGroupValue : 0;
                                const target = (pc.portfolio.allocations || {})[ticker] || 0;
                                return sum + weight * target;
                            }, 0);

                            const isCash = isCashTicker(ticker);
                            const setting = assetSettings.find(s => s.ticker === ticker);
                            const assetClass = isCash
                                ? 'Cash'
                                : (setting?.assetClass || groupAsset?.assetClass || 'Stock');
                            const label = isCash
                                ? (groupAsset?.label || ticker)
                                : (setting?.label || groupAsset?.label || ticker);

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
                                        const asset = pc.assets.find(a => a.ticker === ticker);
                                        const currentValue = asset?.currentValue || 0;
                                        const price = asset?.currentPrice || 0;
                                        const actual = pc.totalValue > 0 ? (currentValue / pc.totalValue) * 100 : 0;
                                        const target = (pc.portfolio.allocations || {})[ticker] || 0;
                                        const diff = actual - target;
                                        const hasPosition = (asset?.quantity || 0) > 0 || currentValue > 0;
                                        const hasTarget = target > 0;

                                        if (!hasPosition && !hasTarget) {
                                            return (
                                                <div key={pc.portfolio.id} className="ct-col ct-col-portfolio ct-cell-empty">
                                                    <span>—</span>
                                                </div>
                                            );
                                        }

                                        // Rebalance action
                                        let rebalShares = 0;
                                        let rebalAmount = 0;
                                        if (!isCash && hasTarget && price > 0) {
                                            const targetValue = pc.totalValue * (target / 100);
                                            const idealDiff = targetValue - currentValue;
                                            rebalShares = Math.round(idealDiff / price);
                                            rebalAmount = rebalShares * price;
                                        }

                                        // Buy-only action
                                        const buyOnlyAmount = !isCash ? (portfolioBuyOnlyMap[pc.portfolio.id]?.[ticker] || 0) : 0;
                                        const buyOnlyShares = buyOnlyAmount > 0 && price > 0 ? Math.round(buyOnlyAmount / price) : 0;

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
                                                {!isCash && hasTarget && (
                                                    <div className={`ct-cell-action ${rebalShares > 0 ? 'ct-action-buy' : rebalShares < 0 ? 'ct-action-sell' : 'ct-action-ok'}`}>
                                                        {rebalShares === 0
                                                            ? <span className="ct-ok-badge">✓</span>
                                                            : <>{rebalShares > 0 ? '▲' : '▼'} {Math.abs(rebalShares)} · {fmt(Math.abs(rebalAmount))}</>
                                                        }
                                                    </div>
                                                )}
                                                {!isCash && buyOnlyShares > 0 && (
                                                    <div className="ct-cell-buyonly">
                                                        <span className="ct-buyonly-label">buy only</span>
                                                        ▲ {buyOnlyShares} · {fmt(buyOnlyAmount)}
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

            {/* Per-portfolio action bars */}
            <div className="group-action-bars">
                {portfolioCalcs.map((pc, i) => (
                    <PortfolioActionBar
                        key={pc.portfolio.id}
                        portfolioCalc={pc}
                        color={PORTFOLIO_COLORS[i % PORTFOLIO_COLORS.length]}
                        allTickers={allTickers}
                        buyOnlyAllocations={portfolioBuyOnlyMap[pc.portfolio.id] || {}}
                        allTransactions={allTransactions}
                        brokers={brokers}
                        onUpdatePortfolio={onUpdatePortfolio}
                        onAddTransactions={onAddTransactions}
                    />
                ))}
            </div>

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

                /* ── Mobile ── */
                @media (max-width: 640px) {
                    .ct-col-asset  { width: 120px; }
                    .ct-col-group  { width: 85px; }
                    .ct-col-portfolio { width: 140px; }
                    .ct-label { font-size: 0.78rem; }
                    .ct-cell-action { font-size: 0.7rem; }
                    .ct-cell-buyonly { font-size: 0.68rem; }

                    .group-action-bar { flex-direction: column; align-items: flex-start; }
                    .group-action-bar-buttons { margin-left: 0; width: 100%; }
                    .group-action-bar-buttons button { flex: 1; }
                }
            `}</style>
        </div>
    );
};

/* ─── Per-portfolio action bar ─── */
interface ActionBarProps {
    portfolioCalc: PortfolioCalc;
    color: string;
    allTickers: string[];
    buyOnlyAllocations: Record<string, number>;
    allTransactions: Transaction[];
    brokers: Broker[];
    onUpdatePortfolio: (portfolio: Portfolio) => void;
    onAddTransactions: (transactions: Transaction[]) => void;
}

const PortfolioActionBar: React.FC<ActionBarProps> = ({
    portfolioCalc,
    color,
    allTickers,
    buyOnlyAllocations,
    allTransactions,
    brokers,
    onUpdatePortfolio,
    onAddTransactions,
}) => {
    const { portfolio, assets, totalValue, transactions } = portfolioCalc;
    const [isWithdrawalOpen, setIsWithdrawalOpen] = React.useState(false);
    const allocations = portfolio.allocations || {};

    const requiredLiquidity = useMemo(() => {
        const nonCash = assets.filter(a => !isCashTicker(a.ticker));
        return calculateRequiredLiquidityForOnlyBuy(nonCash, allocations);
    }, [assets, allocations]);

    const handleExecuteRebalance = async (mode: 'Full' | 'BuyOnly') => {
        const Swal = (await import('sweetalert2')).default;
        const toCreate: Transaction[] = [];

        allTickers.forEach(ticker => {
            if (isCashTicker(ticker)) return;
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
                const buyAmt = buyOnlyAllocations[ticker] || 0;
                if (price > 0) shares = Math.round(buyAmt / price);
            }

            if (shares !== 0 && price > 0) {
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
            }
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
