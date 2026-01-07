import React, { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets } from '../../utils/portfolioCalculations';
import './Dashboard.css';

const BrokerPerformance: React.FC = () => {
    const { transactions, assetSettings, marketData, brokers: brokerList } = usePortfolio();

    const brokerStats = useMemo(() => {
        // 1. Identify all unique brokers keys (ID) from transactions AND broker list
        // We want to show brokers even if they only have liquidity and no transactions? 
        // Or just ones with performance? The user said "merge into Broker Performance cards".
        // Usually Performance implies invested capital. 
        // But if I have a broker with JUST cash, I might want to see it.
        // Let's stick to the existing logic which derives keys from transactions, 
        // BUT also include brokers that are in the brokerList but might have no transactions (just liquidity).

        const txBrokerIds = new Set(transactions.map(t => t.brokerId || 'Unassigned'));
        const allBrokerIds = new Set([...txBrokerIds, ...brokerList.map(b => b.id)]);

        // 2. Calculate summary for each broker key
        const stats = Array.from(allBrokerIds).map(key => {
            // Find broker entity
            const brokerEntity = brokerList.find(b => b.id === key);
            let displayName = brokerEntity ? brokerEntity.name : (key === 'Unassigned' ? 'Unassigned' : key);

            // Filter transactions for this broker key
            const brokerTxs = transactions.filter(t => {
                const tKey = t.brokerId || 'Unassigned';
                return tKey === key;
            });

            const { summary } = calculateAssets(brokerTxs, assetSettings, marketData);

            // Liquidity Calculations
            const liquidity = brokerEntity?.currentLiquidity || 0;
            const invested = summary.totalValue; // "Value" of assets

            // "Calcola la parcentuale della liquidità sul value"
            const liquidityPercentOnValue = invested > 0 ? (liquidity / invested) * 100 : 0;

            let targetValue = 0;
            let targetLabel = '';

            // Determine Target based on Type
            const liquidityType = brokerEntity?.minLiquidityType || 'percent'; // default to percent

            if (liquidityType === 'fixed') {
                targetValue = brokerEntity?.minLiquidityAmount || 0;
                targetLabel = `€${targetValue.toLocaleString('en-IE', { minimumFractionDigits: 0 })}`;
            } else {
                const targetPercent = brokerEntity?.minLiquidityPercentage || 0;
                targetValue = invested * (targetPercent / 100);
                targetLabel = `${targetPercent}%`;
            }

            const deviation = liquidity - targetValue;

            return {
                broker: displayName,
                brokerId: key,
                ...summary,
                liquidity,
                targetValue,
                targetLabel,
                liquidityPercentOnValue,
                deviation,
                hasTarget: targetValue > 0
            };
        }).filter(s => s !== null && (s.totalValue > 0 || s.liquidity > 0));

        // Sort by Total Value desc
        return stats.sort((a, b) => (b.totalValue + b.liquidity) - (a.totalValue + a.liquidity));

    }, [transactions, assetSettings, marketData, brokerList]);

    if (brokerStats.length === 0) return null;

    return (
        <div className="broker-performance-section" style={{ marginTop: '3rem' }}>
            <h2 className="section-title" style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>Broker Performance & Liquidity</h2>

            <div className="summary-grid">
                {brokerStats.map(stat => {
                    const isPositive = stat.totalGain >= 0;

                    // Liquidity Status
                    let liqStatusText = '-';
                    let liqStatusColor = 'var(--text-secondary)';
                    let liqStatusBg = 'transparent';

                    if (stat.hasTarget) {
                        if (stat.deviation > 0) {
                            liqStatusText = 'High';
                            liqStatusColor = '#D97706'; // amber
                            liqStatusBg = 'rgba(245, 158, 11, 0.1)';
                        } else if (stat.deviation < 0) {
                            liqStatusText = 'Low';
                            liqStatusColor = 'var(--color-danger)';
                            liqStatusBg = 'rgba(239, 68, 68, 0.1)';
                        } else {
                            liqStatusText = 'OK';
                            liqStatusColor = 'var(--color-success)';
                            liqStatusBg = 'rgba(16, 185, 129, 0.1)';
                        }
                    }

                    return (
                        <div key={stat.broker} className="summary-card" style={{ borderTop: '4px solid var(--color-primary)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                <span className="card-label" style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                    {stat.broker}
                                </span>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {/* Performance Section */}
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Value</span>
                                    <span style={{ fontWeight: 600 }}>€{stat.totalValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Cost</span>
                                    <span>€{stat.totalCost.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Return</span>
                                    <div style={{ textAlign: 'right' }}>
                                        <div className={`card-value ${isPositive ? 'trend-up' : 'trend-down'}`} style={{ fontSize: '1rem' }}>
                                            {isPositive ? '+' : ''}€{Math.abs(stat.totalGain).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </div>
                                        <div className={`card-trend ${isPositive ? 'trend-up' : 'trend-down'}`} style={{ fontSize: '0.8rem' }}>
                                            {isPositive ? '▲' : '▼'} {Math.abs(stat.totalGainPercentage).toFixed(2)}%
                                        </div>
                                    </div>
                                </div>

                                {/* Liquidity Section Divider */}
                                <div style={{ borderTop: '1px dashed var(--border-color)', margin: '0.5rem 0' }}></div>
                                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.2rem' }}>Liquidity</div>

                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Cash</span>
                                    <div style={{ textAlign: 'right' }}>
                                        <span style={{ fontWeight: 600 }}>€{stat.liquidity.toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
                                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginLeft: '0.3rem' }}>
                                            ({stat.liquidityPercentOnValue.toFixed(1)}%)
                                        </span>
                                    </div>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Target ({stat.targetLabel})</span>
                                    <span>€{stat.targetValue.toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
                                </div>

                                {stat.hasTarget && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.2rem', alignItems: 'center' }}>
                                        <span style={{ color: 'var(--text-secondary)' }}>Status</span>
                                        <span style={{
                                            color: liqStatusColor,
                                            fontWeight: 600,
                                            padding: '1px 8px',
                                            borderRadius: '10px',
                                            backgroundColor: liqStatusBg,
                                            fontSize: '0.85rem'
                                        }}>
                                            {liqStatusText}
                                        </span>
                                    </div>
                                )}

                                {stat.hasTarget && Math.abs(stat.deviation) >= 100 && (
                                    <div style={{
                                        marginTop: '0.5rem',
                                        padding: '0.5rem',
                                        backgroundColor: stat.deviation > 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                        borderRadius: 'var(--radius-md)',
                                        textAlign: 'center',
                                        fontSize: '0.9rem',
                                        color: stat.deviation > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                                        fontWeight: 600
                                    }}>
                                        {stat.deviation > 0
                                            ? `You can invest €${Math.abs(stat.deviation).toLocaleString('en-IE', { maximumFractionDigits: 0 })}`
                                            : `You need to save €${Math.abs(stat.deviation).toLocaleString('en-IE', { maximumFractionDigits: 0 })}`
                                        }
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default BrokerPerformance;
