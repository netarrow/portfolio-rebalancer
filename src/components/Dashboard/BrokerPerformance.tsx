import React, { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets } from '../../utils/portfolioCalculations';
import './Dashboard.css';

const BrokerPerformance: React.FC = () => {
    const { transactions, assetSettings, marketData, brokers: brokerList } = usePortfolio();

    const brokerStats = useMemo(() => {
        // 1. Identify all unique brokers keys (ID or Name)
        // We prioritize brokerId, fallback to broker string, or 'Unassigned'
        const uniqueKeys = Array.from(new Set(transactions.map(t => t.brokerId || t.broker || 'Unassigned')));

        // 2. Calculate summary for each broker key
        const stats = uniqueKeys.map(key => {
            // Filter transactions for this broker key
            const brokerTxs = transactions.filter(t => {
                const tKey = t.brokerId || t.broker || 'Unassigned';
                return tKey === key;
            });

            if (brokerTxs.length === 0) return null;

            const { summary } = calculateAssets(brokerTxs, assetSettings, marketData);

            // Determine display name
            let displayName = 'Unassigned';
            const brokerEntity = brokerList.find(b => b.id === key);

            if (brokerEntity) {
                displayName = brokerEntity.name;
            } else {
                // Fallback: if key is not an ID, it might be the legacy name itself
                displayName = key === 'Unassigned' ? 'Unassigned' : key;
            }

            return {
                broker: displayName,
                ...summary
            };
        }).filter(s => s !== null && s.totalValue > 0);

        // Sort by Total Value desc
        return stats.sort((a, b) => (b?.totalValue || 0) - (a?.totalValue || 0));

    }, [transactions, assetSettings, marketData, brokerList]);

    if (brokerStats.length === 0) return null;

    return (
        <div className="broker-performance-section" style={{ marginTop: '3rem' }}>
            <h2 className="section-title" style={{ fontSize: '1.5rem', marginBottom: '1.5rem' }}>Broker Performance</h2>

            <div className="summary-grid">
                {/* Reuse summary-grid for layout, or create a new grid class if needed. 
                    Using 'summary-grid' gives us the 3-column layout from SummaryCards usually, 
                    but here we might have N brokers. We want a flex wrap or grid. 
                    Let's stick to a responsive grid. */}

                {brokerStats.map(stat => {
                    if (!stat) return null;
                    const isPositive = stat.totalGain >= 0;

                    return (
                        <div key={stat.broker} className="summary-card" style={{ borderTop: '4px solid var(--color-primary)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                <span className="card-label" style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                    {stat.broker}
                                </span>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Value</span>
                                    <span style={{ fontWeight: 600 }}>€{stat.totalValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Cost</span>
                                    <span>€{stat.totalCost.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                </div>
                                <div style={{ borderTop: '1px solid var(--border-color)', margin: '0.5rem 0' }}></div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Return</span>
                                    <div style={{ textAlign: 'right' }}>
                                        <div className={`card-value ${isPositive ? 'trend-up' : 'trend-down'}`} style={{ fontSize: '1.1rem' }}>
                                            {isPositive ? '+' : ''}€{Math.abs(stat.totalGain).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </div>
                                        <div className={`card-trend ${isPositive ? 'trend-up' : 'trend-down'}`} style={{ fontSize: '0.9rem' }}>
                                            {isPositive ? '▲' : '▼'} {Math.abs(stat.totalGainPercentage).toFixed(2)}%
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default BrokerPerformance;
