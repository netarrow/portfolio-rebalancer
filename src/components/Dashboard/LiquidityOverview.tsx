import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { usePortfolio } from '../../context/PortfolioContext';
import './Dashboard.css';

import { calculateAssets } from '../../utils/portfolioCalculations';
// ...
const LiquidityOverview: React.FC = () => {
    const { brokers, summary, transactions, assetSettings, marketData } = usePortfolio();

    const liquidityData = useMemo(() => {
        // ... (same as before)
        const totalLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
        const totalInvested = summary.totalValue;
        const totalCapital = totalLiquidity + totalInvested;

        return {
            totalLiquidity,
            totalInvested,
            totalCapital,
            chartData: [
                { name: 'Invested', value: totalInvested },
                { name: 'Liquidity', value: totalLiquidity }
            ].filter(d => d.value > 0)
        };
    }, [brokers, summary]);

    const brokerLiquidityData = useMemo(() => {
        return brokers
            .map(b => {
                // 1. Calculate Invested Value for this Broker
                // Filter transactions by brokerId 
                const brokerTxs = transactions.filter(t => t.brokerId === b.id);

                const { summary: brokerSummary } = calculateAssets(brokerTxs, assetSettings, marketData);
                const invested = brokerSummary.totalValue;
                const liquidity = b.currentLiquidity || 0;
                const totalBrokerCapital = invested + liquidity;

                const brokerLiquidityPercent = totalBrokerCapital > 0 ? (liquidity / totalBrokerCapital) * 100 : 0;

                return {
                    ...b,
                    value: liquidity,
                    invested,
                    totalBrokerCapital,
                    brokerLiquidityPercent,
                    percentOfTotalLiquidity: liquidityData.totalLiquidity > 0 ? liquidity / liquidityData.totalLiquidity : 0
                };
            })
            // Filter to show only brokers that have EITHER liquidity OR invested capital? 
            // Or just current list? User probably wants to see all checks.
            // Let's hide if BOTH are 0.
            .filter(b => b.totalBrokerCapital > 0)
            .sort((a, b) => b.value - a.value);
    }, [brokers, transactions, assetSettings, marketData, liquidityData.totalLiquidity]);

    // const COLORS = ['#3B82F6', '#10B981']; // Unused, colors are inline

    if (liquidityData.totalCapital === 0) return null;

    return (
        <div className="liquidity-section" style={{ marginTop: '3rem' }}>
            <h2 className="section-title" style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>Liquidity Overview</h2>

            <div className="charts-grid">
                {/* Capital Allocation Chart */}
                <div className="chart-card">
                    <h4>Capital Allocation</h4>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={liquidityData.chartData}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={60}
                                    outerRadius={80}
                                    paddingAngle={5}
                                    dataKey="value"
                                >
                                    {liquidityData.chartData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.name === 'Invested' ? '#3B82F6' : '#10B981'} />
                                    ))}
                                </Pie>
                                <Tooltip formatter={(value: number | undefined) => `€${(value || 0).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
                                <Legend verticalAlign="bottom" height={36} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* KPI Cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>

                    <div className="summary-card" style={{ borderLeft: '4px solid #3B82F6' }}>
                        <span className="card-label">Total Invested</span>
                        <span className="card-value">€{liquidityData.totalInvested.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        <span className="card-trend">{(liquidityData.totalInvested / liquidityData.totalCapital * 100).toFixed(1)}%</span>
                    </div>

                    <div className="summary-card" style={{ borderLeft: '4px solid #10B981' }}>
                        <span className="card-label">Total Liquidity</span>
                        <span className="card-value">€{liquidityData.totalLiquidity.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        <span className="card-trend">{(liquidityData.totalLiquidity / liquidityData.totalCapital * 100).toFixed(1)}%</span>
                    </div>

                    <div className="summary-card" >
                        <span className="card-label">Total Capital</span>
                        <span className="card-value">€{liquidityData.totalCapital.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>

                </div>

                {/* Broker Breakdown */}
                <div className="chart-card" style={{ overflow: 'auto' }}>
                    <h4>Liquidity by Broker</h4>
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                <th style={{ textAlign: 'left', padding: '0.5rem' }}>Broker</th>
                                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Liq. Amount</th>
                                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Current %</th>
                                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Target %</th>
                                <th style={{ textAlign: 'center', padding: '0.5rem' }}>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {brokerLiquidityData.map(b => {
                                const target = b.minLiquidityPercentage || 0;
                                let statusColor = 'var(--text-secondary)';
                                let statusText = '-';

                                if (target > 0) {
                                    if (b.brokerLiquidityPercent >= target) {
                                        statusColor = 'var(--color-success)';
                                        statusText = 'OK';
                                    } else {
                                        statusColor = 'var(--color-danger)';
                                        statusText = 'Low';
                                    }
                                }

                                return (
                                    <tr key={b.name} style={{ borderBottom: '1px solid var(--bg-app)' }}>
                                        <td style={{ padding: '0.5rem' }}>{b.name}</td>
                                        <td style={{ textAlign: 'right', padding: '0.5rem' }}>€{b.value.toLocaleString('en-IE', { minimumFractionDigits: 0 })}</td>
                                        <td style={{ textAlign: 'right', padding: '0.5rem' }}>{(b.brokerLiquidityPercent).toFixed(1)}%</td>
                                        <td style={{ textAlign: 'right', padding: '0.5rem' }}>{target > 0 ? `${target.toFixed(1)}%` : '-'}</td>
                                        <td style={{ textAlign: 'center', padding: '0.5rem' }}>
                                            <span style={{
                                                color: statusColor,
                                                fontWeight: 600,
                                                padding: '2px 8px',
                                                borderRadius: '12px',
                                                backgroundColor: statusText === 'OK' ? 'rgba(16, 185, 129, 0.1)' : statusText === 'Low' ? 'rgba(239, 68, 68, 0.1)' : 'transparent'
                                            }}>
                                                {statusText}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                            {brokerLiquidityData.length === 0 && (
                                <tr>
                                    <td colSpan={5} style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                                        No liquidity configured.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default LiquidityOverview;
