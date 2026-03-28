import React, { useMemo, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets, injectCashAssets, isCashTicker } from '../../utils/portfolioCalculations';
import { getAssetGoal } from '../../utils/goalCalculations';
import type { Asset } from '../../types';
import MacroStats from './MacroStats';
import './Dashboard.css';

const RADIAN = Math.PI / 180;
const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) => {
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return percent > 0.05 ? (
        <text x={x} y={y} fill="white" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={12} style={{ pointerEvents: 'none' }}>
            {`${(percent * 100).toFixed(0)}%`}
        </text>
    ) : null;
};

// Custom Tooltip
const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload;
        return (
            <div className="custom-chart-tooltip">
                <p className="label"><strong>{data.name}</strong></p>
                <p className="value">€{data.value.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                <p className="percent">{data.percent ? `${(data.percent * 100).toFixed(1)}%` : ''}</p>
            </div>
        );
    }
    return null;
};

// Sub-component for a single row of charts
interface DistributionRowProps {
    title: string;
    assets: Asset[];
    portfolio?: import('../../types').Portfolio;
    assetSettings?: import('../../types').AssetDefinition[];
}

const DistributionRow: React.FC<DistributionRowProps> = ({ title, assets, portfolio, assetSettings }) => {
    // Colors (consistent palette)
    const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6'];

    // Target Calculation (By Class)
    const targetClassData = useMemo(() => {
        if (!portfolio || !portfolio.allocations || !assetSettings) return null;

        const grouped: Record<string, number> = {};
        Object.entries(portfolio.allocations).forEach(([ticker, percent]) => {
            const cls = isCashTicker(ticker)
                ? 'Cash'
                : (assetSettings.find(s => s.ticker === ticker)?.assetClass || 'Other');
            grouped[cls] = (grouped[cls] || 0) + percent;
        });

        // Normalize or just show as is (should sum to 100)
        return Object.entries(grouped)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value);
    }, [portfolio, assetSettings]);

    // 1. Group by Asset Class
    const classData = useMemo(() => {
        const grouped: Record<string, number> = {};
        assets.filter(a => a.currentValue > 0).forEach(asset => {
            const cls = asset.assetClass || 'Other';
            grouped[cls] = (grouped[cls] || 0) + asset.currentValue;
        });

        return Object.entries(grouped)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value); // Descending
    }, [assets]);

    // 2. Group by Asset SubClass
    const subClassData = useMemo(() => {
        const grouped: Record<string, number> = {};
        assets.filter(a => a.currentValue > 0).forEach(asset => {
            const sub = asset.assetSubClass || 'Other';
            grouped[sub] = (grouped[sub] || 0) + asset.currentValue;
        });

        return Object.entries(grouped)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value);
    }, [assets]);

    // 3. Group by Asset Name
    const nameData = useMemo(() => {
        return assets
            .filter(a => a.currentValue > 0)
            .map(a => ({ name: a.label || a.ticker, value: a.currentValue }))
            .sort((a, b) => b.value - a.value);
    }, [assets]);

    if (assets.length === 0 || assets.every(a => a.currentValue === 0)) {
        return null;
    }

    return (
        <div style={{ marginBottom: '3rem' }}>
            <h3 className="section-title" style={{
                fontSize: '1.2rem',
                color: 'var(--color-primary)',
                borderBottom: '1px solid var(--border-color)',
                paddingBottom: '0.5rem',
                marginBottom: '1rem'
            }}>
                {title}
            </h3>
            <div className="charts-grid">
                {/* Target By Class (Only if portfolio exists) */}
                {targetClassData && targetClassData.length > 0 && (
                    <div className="chart-card">
                        <h4>Target (Class)</h4>
                        <div style={{ width: '100%', height: 250 }}>
                            <ResponsiveContainer>
                                <PieChart>
                                    <Pie
                                        data={targetClassData}
                                        cx="50%"
                                        cy="50%"
                                        labelLine={false}
                                        label={renderCustomizedLabel}
                                        outerRadius={80}
                                        fill="#8884d8"
                                        dataKey="value"
                                    >
                                        {targetClassData.map((_, index) => (
                                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                        ))}
                                    </Pie>
                                    <Tooltip content={<CustomTooltip />} />
                                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                )}

                {/* By Class */}
                <div className="chart-card">
                    <h4>By Class</h4>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={classData}
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    label={renderCustomizedLabel}
                                    outerRadius={80}
                                    fill="#8884d8"
                                    dataKey="value"
                                >
                                    {classData.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip />} />
                                <Legend wrapperStyle={{ fontSize: '12px' }} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* By Subclass */}
                <div className="chart-card">
                    <h4>By Subclass</h4>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={subClassData}
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    label={renderCustomizedLabel}
                                    outerRadius={80}
                                    fill="#8884d8"
                                    dataKey="value"
                                >
                                    {subClassData.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[(index + 2) % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip />} />
                                <Legend wrapperStyle={{ fontSize: '12px' }} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* By Name */}
                <div className="chart-card">
                    <h4>By Asset</h4>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={nameData}
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    label={renderCustomizedLabel}
                                    outerRadius={80}
                                    fill="#8884d8"
                                    dataKey="value"
                                >
                                    {nameData.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip />} />
                                <Legend wrapperStyle={{ fontSize: '12px' }} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>
        </div>
    );
};

interface GoalSegment {
    id: string;
    name: string;
    value: number;
    color: string;
    breakdown: { label: string; value: number }[];
}

const GoalDistributionChart: React.FC<{ data: GoalSegment[]; total: number }> = ({ data, total }) => {
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const hoveredGoal = data.find(g => g.id === hoveredId);
    const visible = data.filter(g => g.value > 0);

    return (
        <div style={{ marginBottom: '3rem' }}>
            <h3 className="section-title" style={{
                fontSize: '1.2rem',
                color: 'var(--color-primary)',
                borderBottom: '1px solid var(--border-color)',
                paddingBottom: '0.5rem',
                marginBottom: '1rem'
            }}>
                Goal Distribution
            </h3>
            <div className="chart-card" style={{ padding: '1.5rem' }}>
                {/* Bar */}
                <div style={{ display: 'flex', borderRadius: 'var(--radius-md)', overflow: 'hidden', height: 48, width: '100%', backgroundColor: 'var(--bg-card)' }}>
                    {visible.map((goal) => {
                        const pct = (goal.value / total) * 100;
                        return (
                            <div
                                key={goal.id}
                                onMouseEnter={() => setHoveredId(goal.id)}
                                onMouseLeave={() => setHoveredId(null)}
                                style={{
                                    width: `${pct}%`,
                                    backgroundColor: goal.color,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: '#fff',
                                    fontSize: pct >= 8 ? '0.85rem' : '0.7rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    filter: hoveredId === goal.id ? 'brightness(1.15)' : 'none',
                                    transition: 'filter 0.2s'
                                }}
                            >
                                {pct >= 8 ? `${goal.name} ${pct.toFixed(1)}%` : pct >= 4 ? `${pct.toFixed(0)}%` : ''}
                            </div>
                        );
                    })}
                </div>

                {/* Tooltip panel */}
                {hoveredGoal && (() => {
                    const pct = (hoveredGoal.value / total) * 100;
                    return (
                        <div style={{
                            marginTop: '0.75rem',
                            padding: '0.75rem 1rem',
                            backgroundColor: 'var(--bg-surface)',
                            border: `1px solid ${hoveredGoal.color}`,
                            borderRadius: 'var(--radius-md)',
                            fontSize: '0.85rem'
                        }}>
                            <div style={{ fontWeight: 700, marginBottom: '0.4rem', fontSize: '0.95rem', color: hoveredGoal.color }}>
                                {hoveredGoal.name} — {pct.toFixed(1)}%
                            </div>
                            <div style={{ fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text-primary)' }}>
                                Total: €{hoveredGoal.value.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                            </div>
                            {hoveredGoal.breakdown.map(b => (
                                <div key={b.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', color: 'var(--text-secondary)' }}>
                                    <span>{b.label}</span>
                                    <span>€{b.value.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</span>
                                </div>
                            ))}
                        </div>
                    );
                })()}

                {/* Legend */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginTop: '0.75rem' }}>
                    {visible.map(goal => (
                        <div key={goal.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.85rem' }}>
                            <span style={{ width: 12, height: 12, borderRadius: '50%', backgroundColor: goal.color, display: 'inline-block' }} />
                            <span style={{ color: 'var(--text-primary)' }}>{goal.name}</span>
                            <span style={{ color: 'var(--text-muted)' }}>€{goal.value.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

const AllocationCharts: React.FC = () => {
    const { transactions, assetSettings, marketData, portfolios, brokers, goals } = usePortfolio();

    // 1. Total / All (including virtual cash assets from all portfolios)
    const totalAssets = useMemo(() => {
        const baseAssets = calculateAssets(transactions, assetSettings, marketData).assets;
        // Collect cash assets from all portfolios, avoiding duplicates per broker
        const seenBrokerPortfolio = new Set<string>();
        const allCashAssets: Asset[] = [];
        portfolios.forEach(p => {
            const cashForPortfolio = injectCashAssets([], brokers, p.id);
            cashForPortfolio.forEach(ca => {
                const key = `${ca.ticker}_${p.id}`;
                if (!seenBrokerPortfolio.has(key)) {
                    seenBrokerPortfolio.add(key);
                    allCashAssets.push(ca);
                }
            });
        });
        return [...baseAssets, ...allCashAssets];
    }, [transactions, assetSettings, marketData, brokers, portfolios]);

    // 2. Portfolio Contribution
    const portfolioContributionData = useMemo(() => {
        return portfolios.map(p => {
            const pTxs = transactions.filter(t => t.portfolioId === p.id); // Filter by ID
            const { summary } = calculateAssets(pTxs, assetSettings, marketData);
            return { id: p.id, name: p.name, value: summary.totalValue };
        })
            .filter(d => d.value > 0)
            .sort((a, b) => b.value - a.value);
    }, [portfolios, transactions, assetSettings, marketData]);

    // 3. Broker Contribution
    const brokerContributionData = useMemo(() => {
        const brokerMap: Record<string, number> = {};

        // Algo: Tally up quantity per ticker PER BROKER.
        const items: Record<string, Record<string, number>> = {}; // brokerKey -> ticker -> qty

        transactions.forEach(tx => {
            // Priority: brokerId -> 'Unassigned'
            const key = tx.brokerId || 'Unassigned';
            const multiplier = tx.direction === 'Sell' ? -1 : 1;

            if (!items[key]) items[key] = {};
            items[key][tx.ticker] = (items[key][tx.ticker] || 0) + (tx.amount * multiplier);
        });

        // 2. Calculate value
        Object.entries(items).forEach(([key, tickers]) => {
            let brokerTotal = 0;

            // Resolve Display Name
            let displayName = 'Unassigned';
            const brokerEntity = brokers.find(b => b.id === key);
            if (brokerEntity) {
                displayName = brokerEntity.name;
            } else {
                displayName = key === 'Unassigned' ? 'Unassigned' : key;
            }

            Object.entries(tickers).forEach(([ticker, qty]) => {
                if (qty <= 0) return;

                const priceData = marketData[ticker];
                let price = priceData?.price || 0;

                if (!price) {
                    const asset = totalAssets.find(a => a.ticker === ticker);
                    price = asset?.currentPrice || 0;
                }

                brokerTotal += qty * price;
            });

            if (brokerTotal > 0) {
                // Aggregate by Display Name
                brokerMap[displayName] = (brokerMap[displayName] || 0) + brokerTotal;
            }
        });

        return Object.entries(brokerMap)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value);

    }, [transactions, marketData, totalAssets, brokers]);

    // 4. Invested vs Liquidity Data
    const investedVsLiquidityData = useMemo(() => {
        const investedAmount = totalAssets.reduce((sum, a) => sum + a.currentValue, 0);
        const liquidityAmount = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);

        return [
            { name: 'Invested', value: investedAmount },
            { name: 'Liquidity', value: liquidityAmount }
        ].filter(d => d.value > 0);
    }, [totalAssets, brokers]);

    // 5. Goal Distribution (New Logic)
    const goalDistributionData = useMemo(() => {
        const goalMap: Record<string, { value: number; breakdown: Record<string, number> }> = {
            'Growth': { value: 0, breakdown: {} },
            'Protection': { value: 0, breakdown: {} },
            'Security': { value: 0, breakdown: {} }
        };

        // 1. Assets
        totalAssets.forEach(asset => {
            if (asset.currentValue <= 0) return;
            const goal = getAssetGoal(asset.assetClass, asset.assetSubClass);
            goalMap[goal].value += asset.currentValue;

            // Breakdown Label: e.g. "Bond (Short)" or "Stock (International)"
            const label = `${asset.assetClass}${asset.assetSubClass ? ` (${asset.assetSubClass})` : ''}`;
            goalMap[goal].breakdown[label] = (goalMap[goal].breakdown[label] || 0) + asset.currentValue;
        });

        // 2. Liquidity -> Protection
        const totalLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
        if (totalLiquidity > 0) {
            goalMap['Protection'].value += totalLiquidity;
            goalMap['Protection'].breakdown['Liquidity'] = (goalMap['Protection'].breakdown['Liquidity'] || 0) + totalLiquidity;
        }

        // Colors for Goals
        const goalColors: Record<string, string> = {
            'Growth': '#3B82F6',      // Blue
            'Protection': '#10B981',  // Green
            'Security': '#8B5CF6'     // Purple
        };

        return Object.entries(goalMap)
            .filter(([_, data]) => data.value > 0)
            .map(([name, data]) => ({
                name,
                value: data.value,
                color: goalColors[name] || '#9CA3AF',
                breakdown: Object.entries(data.breakdown)
                    .map(([label, val]) => ({ label, value: val }))
                    .sort((a, b) => b.value - a.value)
            }))
            .sort((a, b) => b.value - a.value); // Standard largest at bottom behavior matches "Pyramid" usually.

    }, [totalAssets, brokers]);

    // 6. Portfolio Value Pyramid (simulation)
    const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6'];
    const LIQUIDITY_COLOR = '#6B7280';
    const [portfolioTransfers, setPortfolioTransfers] = useState<Record<string, { remove: number; add: number }>>({});
    const [liquidityPortfolioId, setLiquidityPortfolioId] = useState<string>('');
    const isSimulationActive = useMemo(
        () => Object.values(portfolioTransfers).some(({ remove, add }) => remove > 0 || add > 0),
        [portfolioTransfers]
    );

    const actualLiquidity = useMemo(() =>
        brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0),
        [brokers]
    );
    const roundedActualLiquidity = Math.trunc(actualLiquidity);

    const portfolioCurrentValues = useMemo(
        () => Object.fromEntries(
            portfolioContributionData.map(d => [d.id, Math.trunc(d.value)])
        ) as Record<string, number>,
        [portfolioContributionData]
    );

    const totalRemoved = useMemo(
        () => Object.values(portfolioTransfers).reduce((sum, { remove }) => sum + remove, 0),
        [portfolioTransfers]
    );

    const totalAdded = useMemo(
        () => Object.values(portfolioTransfers).reduce((sum, { add }) => sum + add, 0),
        [portfolioTransfers]
    );

    const simLiquidity = roundedActualLiquidity + totalRemoved - totalAdded;

    const simulatedPortfolioValues = useMemo(
        () => Object.fromEntries(
            portfolioContributionData.map(d => {
                const transfer = portfolioTransfers[d.id] ?? { remove: 0, add: 0 };
                return [d.id, portfolioCurrentValues[d.id] - transfer.remove + transfer.add];
            })
        ) as Record<string, number>,
        [portfolioContributionData, portfolioTransfers, portfolioCurrentValues]
    );

    const resolvedLiquidityPortfolioId = useMemo(() => {
        if (portfolioContributionData.length === 0) return '';
        const selectedExists = portfolioContributionData.some(d => d.id === liquidityPortfolioId);
        return selectedExists ? liquidityPortfolioId : portfolioContributionData[0].id;
    }, [portfolioContributionData, liquidityPortfolioId]);

    const liquidityPortfolioName = useMemo(
        () => portfolioContributionData.find(d => d.id === resolvedLiquidityPortfolioId)?.name ?? '',
        [portfolioContributionData, resolvedLiquidityPortfolioId]
    );

    const updatePortfolioTransfer = (portfolioId: string, field: 'remove' | 'add', rawValue: number) => {
        const sanitizedValue = Math.max(0, Math.trunc(Number.isFinite(rawValue) ? rawValue : 0));

        setPortfolioTransfers(prev => {
            const current = prev[portfolioId] ?? { remove: 0, add: 0 };
            const currentValue = portfolioCurrentValues[portfolioId] ?? 0;
            const prevTotalRemoved = Object.values(prev).reduce((sum, { remove }) => sum + remove, 0);
            const prevTotalAdded = Object.values(prev).reduce((sum, { add }) => sum + add, 0);

            let nextRemove = current.remove;
            let nextAdd = current.add;

            if (field === 'remove') {
                const otherRemoved = prevTotalRemoved - current.remove;
                const minimumRemoveNeeded = Math.max(0, prevTotalAdded - roundedActualLiquidity - otherRemoved);
                nextRemove = Math.max(minimumRemoveNeeded, Math.min(sanitizedValue, currentValue));
            } else {
                const availableForThisRow = Math.max(0, roundedActualLiquidity + prevTotalRemoved - (prevTotalAdded - current.add));
                nextAdd = Math.min(sanitizedValue, availableForThisRow);
            }

            const nextEntry = { remove: nextRemove, add: nextAdd };
            if (nextEntry.remove === 0 && nextEntry.add === 0) {
                const { [portfolioId]: _, ...rest } = prev;
                return rest;
            }

            return {
                ...prev,
                [portfolioId]: nextEntry
            };
        });
    };

    // Build pyramid data: portfolios + liquidity merged into the selected portfolio layer
    const { portfolioPyramidData, baseComposition } = useMemo(() => {
        const layers = portfolioContributionData.map((d, index) => ({
            id: d.id,
            name: d.name,
            value: simulatedPortfolioValues[d.id] ?? portfolioCurrentValues[d.id],
            color: COLORS[index % COLORS.length],
        })).filter(d => d.value > 0);

        if (layers.length === 0) return { portfolioPyramidData: [], baseComposition: undefined };

        const liqValue = simLiquidity;
        let composition: { label: string; value: number; color: string }[] | undefined;

        if (liqValue > 0) {
            let ownerIdx = layers.findIndex(layer => layer.id === resolvedLiquidityPortfolioId);

            if (ownerIdx === -1) {
                const ownerMeta = portfolioContributionData.find((portfolio, index) => {
                    if (portfolio.id !== resolvedLiquidityPortfolioId) return false;
                    layers.push({
                        id: portfolio.id,
                        name: portfolio.name,
                        value: 0,
                        color: COLORS[index % COLORS.length],
                    });
                    return true;
                });

                if (ownerMeta) {
                    ownerIdx = layers.findIndex(layer => layer.id === resolvedLiquidityPortfolioId);
                }
            }

            const ownerLayer = ownerIdx >= 0 ? layers[ownerIdx] : undefined;

            if (ownerLayer) {
                composition = [
                    { label: ownerLayer.name, value: ownerLayer.value, color: ownerLayer.color },
                    { label: 'Liquidity', value: liqValue, color: LIQUIDITY_COLOR }
                ];
                layers[ownerIdx] = {
                    ...ownerLayer,
                    name: `${ownerLayer.name} + Liquidity`,
                    value: ownerLayer.value + liqValue,
                };
            }
        }

        return {
            portfolioPyramidData: layers,
            baseComposition: composition
        };
    }, [portfolioContributionData, simulatedPortfolioValues, portfolioCurrentValues, simLiquidity, resolvedLiquidityPortfolioId]);

    const simulatedTotal = useMemo(() =>
        portfolioPyramidData.reduce((sum, d) => sum + d.value, 0),
        [portfolioPyramidData]
    );

    if (totalAssets.length === 0 || totalAssets.every(a => a.currentValue === 0)) {
        // Even if no assets, if we have liquidity we might want to show it?
        // But the checks below rely on portfolioContributionData etc.
        // Let's check if we have ANYTHING to show.
        if (investedVsLiquidityData.length === 0) return null;
    }

    // Helper to get assets for a portfolio (including virtual cash assets)
    const getPortfolioAssets = (pid: string) => {
        const filteredTxs = transactions.filter(t => t.portfolioId === pid);
        const result = calculateAssets(filteredTxs, assetSettings, marketData);
        return injectCashAssets(result.assets, brokers, pid);
    };

    // Goal aggregation chart data
    const GOAL_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6', '#F97316'];

    const goalChartData = useMemo(() => {
        if (goals.length === 0) return [];

        const sortedGoals = [...goals].sort((a, b) => a.order - b.order);

        return sortedGoals.map((goal, idx) => {
            const linkedPortfolios = portfolios.filter(p => p.goalId === goal.id);

            // Aggregate asset class breakdown across all linked portfolios
            const classBreakdown: Record<string, number> = {};
            let totalValue = 0;

            linkedPortfolios.forEach(p => {
                const pAssets = getPortfolioAssets(p.id);
                pAssets.forEach(asset => {
                    if (asset.currentValue <= 0) return;
                    const cls = asset.assetClass || 'Other';
                    classBreakdown[cls] = (classBreakdown[cls] || 0) + asset.currentValue;
                    totalValue += asset.currentValue;
                });
            });

            return {
                id: goal.id,
                name: goal.title,
                value: totalValue,
                color: GOAL_COLORS[idx % GOAL_COLORS.length],
                breakdown: Object.entries(classBreakdown)
                    .map(([cls, val]) => ({ label: cls, value: val }))
                    .sort((a, b) => b.value - a.value)
            };
        });
    }, [goals, portfolios, transactions, assetSettings, marketData, brokers]);

    const goalChartTotal = useMemo(() =>
        goalChartData.reduce((sum, g) => sum + g.value, 0),
        [goalChartData]
    );

    return (
        <div className="charts-section">
            <h2 className="section-title" style={{ fontSize: '1.5rem', marginBottom: '2rem' }}>Portfolio Distribution</h2>

            <MacroStats />
            <div style={{ margin: '3rem 0', borderTop: '1px solid var(--border-color)' }}></div>

            {/* Goal Distribution Chart */}
            {goalChartData.length > 0 && goalChartTotal > 0 && (
                <GoalDistributionChart data={goalChartData} total={goalChartTotal} />
            )}
            <div style={{ margin: '3rem 0', borderTop: '1px solid var(--border-color)' }}></div>

            {/* Portfolio Contribution Chart */}
            {(portfolioContributionData.length > 0 || brokerContributionData.length > 0) && (
                <div style={{ marginBottom: '3rem' }}>
                    <h3 className="section-title" style={{
                        fontSize: '1.2rem',
                        color: 'var(--color-primary)',
                        borderBottom: '1px solid var(--border-color)',
                        paddingBottom: '0.5rem',
                        marginBottom: '1rem'
                    }}>
                        Invested Capital Distribution
                    </h3>
                    <div className="charts-grid">
                        {/* Invested vs Liquidity */}
                        <div className="chart-card">
                            <h4>Invested vs Liquidity</h4>
                            <div style={{ width: '100%', height: 250 }}>
                                <ResponsiveContainer>
                                    <PieChart>
                                        <Pie
                                            data={investedVsLiquidityData}
                                            cx="50%"
                                            cy="50%"
                                            labelLine={false}
                                            label={renderCustomizedLabel}
                                            outerRadius={80}
                                            fill="#8884d8"
                                            dataKey="value"
                                        >
                                            {investedVsLiquidityData.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={entry.name === 'Invested' ? '#3B82F6' : '#10B981'} />
                                            ))}
                                        </Pie>
                                        <Tooltip content={<CustomTooltip />} />
                                        <Legend wrapperStyle={{ fontSize: '12px' }} />
                                    </PieChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        {/* By Portfolio */}
                        {portfolioContributionData.length > 0 && (
                            <div className="chart-card">
                                <h4>Value by Portfolio</h4>
                                <div style={{ width: '100%', height: 250 }}>
                                    <ResponsiveContainer>
                                        <PieChart>
                                            <Pie
                                                data={portfolioContributionData}
                                                cx="50%"
                                                cy="50%"
                                                labelLine={false}
                                                label={renderCustomizedLabel}
                                                outerRadius={80}
                                                fill="#8884d8"
                                                dataKey="value"
                                            >
                                                {portfolioContributionData.map((_, index) => (
                                                    <Cell key={`cell-${index}`} fill={['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6'][index % 7]} />
                                                ))}
                                            </Pie>
                                            <Tooltip content={<CustomTooltip />} />
                                            <Legend wrapperStyle={{ fontSize: '12px' }} />
                                        </PieChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}

                        {/* By Broker */}
                        {brokerContributionData.length > 0 && (
                            <div className="chart-card">
                                <h4>Value by Broker</h4>
                                <div style={{ width: '100%', height: 250 }}>
                                    <ResponsiveContainer>
                                        <PieChart>
                                            <Pie
                                                data={brokerContributionData}
                                                cx="50%"
                                                cy="50%"
                                                labelLine={false}
                                                label={renderCustomizedLabel}
                                                outerRadius={80}
                                                fill="#8884d8"
                                                dataKey="value"
                                            >
                                                {brokerContributionData.map((_, index) => (
                                                    <Cell key={`cell-${index}`} fill={['#EC4899', '#8B5CF6', '#F59E0B', '#10B981', '#3B82F6', '#6366F1', '#14B8A6'][(index + 3) % 7]} />
                                                ))}
                                            </Pie>
                                            <Tooltip content={<CustomTooltip />} />
                                            <Legend wrapperStyle={{ fontSize: '12px' }} />
                                        </PieChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>
                        )}


                    </div>
                </div>
            )}

            {/* Global View */}
            <DistributionRow
                title="Total / All Portfolios"
                assets={totalAssets}
            // No portfolio passed here, so no Target chart
            />

            {/* Individual Views */}
            {portfolios.map(p => {
                const pAssets = getPortfolioAssets(p.id);
                // Only show if there are assets OR allocations
                const hasAssets = pAssets.some(a => a.currentValue > 0);
                const hasAllocations = p.allocations && Object.keys(p.allocations).length > 0;

                if (!hasAssets && !hasAllocations) return null;

                return (
                    <DistributionRow
                        key={p.id}
                        title={`Portfolio: ${p.name}`}
                        assets={pAssets}
                        portfolio={p}
                        assetSettings={assetSettings}
                    />
                );
            })}
        </div>
    );
};

export default AllocationCharts;
