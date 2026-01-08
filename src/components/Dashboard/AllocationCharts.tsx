import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets } from '../../utils/portfolioCalculations';
import type { Asset } from '../../types';
import PortfolioPyramid from './PortfolioPyramid';
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
            const setting = assetSettings.find(s => s.ticker === ticker);
            const cls = setting?.assetClass || 'Other';
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

const AllocationCharts: React.FC = () => {
    const { transactions, assetSettings, marketData, portfolios, brokers } = usePortfolio();

    // 1. Total / All
    const totalAssets = useMemo(() => {
        return calculateAssets(transactions, assetSettings, marketData).assets;
    }, [transactions, assetSettings, marketData]);

    // 2. Portfolio Contribution
    const portfolioContributionData = useMemo(() => {
        return portfolios.map(p => {
            const pTxs = transactions.filter(t => t.portfolioId === p.id); // Filter by ID
            const { summary } = calculateAssets(pTxs, assetSettings, marketData);
            return { name: p.name, value: summary.totalValue };
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

    if (totalAssets.length === 0 || totalAssets.every(a => a.currentValue === 0)) {
        // Even if no assets, if we have liquidity we might want to show it?
        // But the checks below rely on portfolioContributionData etc.
        // Let's check if we have ANYTHING to show.
        if (investedVsLiquidityData.length === 0) return null;
    }

    // Helper to get assets for a portfolio
    const getPortfolioAssets = (pid: string) => {
        const filteredTxs = transactions.filter(t => t.portfolioId === pid);
        return calculateAssets(filteredTxs, assetSettings, marketData).assets;
    };

    return (
        <div className="charts-section">
            <h2 className="section-title" style={{ fontSize: '1.5rem', marginBottom: '2rem' }}>Portfolio Distribution</h2>

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

                        {/* Portfolio Pyramid */}
                        {portfolioContributionData.length > 0 && (
                            <div className="chart-card" style={{ gridColumn: '1 / -1' }}>
                                <h4>Total Wealth Distribution (Portfolios + Liquidity)</h4>
                                <PortfolioPyramid
                                    data={[
                                        ...portfolioContributionData.map((d, i) => ({
                                            ...d,
                                            color: ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6'][i % 7]
                                        })),
                                        // Append Liquidity if > 0
                                        ...(investedVsLiquidityData.find(d => d.name === 'Liquidity') ? [{
                                            name: 'Total Liquidity',
                                            value: investedVsLiquidityData.find(d => d.name === 'Liquidity')?.value || 0,
                                            color: '#64748B' // Slate-500 for distinct "Cash" look, or reused Green? Let's use Slate/Gray to differentiate from Invested.
                                        }] : [])
                                    ]}
                                />
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
