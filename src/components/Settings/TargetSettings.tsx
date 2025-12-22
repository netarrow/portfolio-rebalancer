import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import '../Transactions/Transactions.css'; // Reuse form styles

const TargetSettings: React.FC = () => {
    const { targets, updateTarget, assets } = usePortfolio();

    // Get unique tickers from assets (plus any already in targets even if 0 items)
    const assetTickers = assets.map(a => a.ticker);
    const targetTickers = targets.map(t => t.ticker);
    const allTickers = Array.from(new Set([...assetTickers, ...targetTickers])).sort();

    const getTarget = (ticker: string) => targets.find(t => t.ticker === ticker) || { ticker, targetPercentage: 0, source: 'ETF' };

    const total = targets.reduce((sum, t) => sum + t.targetPercentage, 0);

    const handleUpdate = (ticker: string, field: 'percentage' | 'source' | 'label', value: string) => {
        const current = getTarget(ticker);
        const newPerc = field === 'percentage' ? Number(value) : current.targetPercentage;
        const newSource = field === 'source' ? value as 'ETF' | 'MOT' : (current.source || 'ETF');
        const newLabel = field === 'label' ? value : current.label;
        updateTarget(ticker, newPerc, newSource, newLabel);
    };

    return (
        <div className="transaction-form-card" style={{ maxWidth: '700px', margin: '0 auto' }}>
            <h2>Target Allocation & Source</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
                Define target allocation and price source (ETF/MOT) for each asset.
            </p>

            {allTickers.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>No assets found. Add transactions first to see them here.</p>
            ) : (
                allTickers.map(ticker => {
                    const target = getTarget(ticker);
                    return (
                        <div className="form-group" key={ticker} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 100px', gap: 'var(--space-4)', alignItems: 'center' }}>
                            <label style={{ margin: 0 }}>{ticker}</label>

                            <div>
                                <label style={{ fontSize: '0.7rem' }}>Label Name</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="Optional Display Name"
                                    value={target.label || ''}
                                    onChange={(e) => handleUpdate(ticker, 'label', e.target.value)}
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: '0.7rem' }}>Target %</label>
                                <input
                                    type="number"
                                    className="form-input"
                                    value={target.targetPercentage}
                                    onChange={(e) => handleUpdate(ticker, 'percentage', e.target.value)}
                                    min="0"
                                    max="100"
                                />
                            </div>

                            <div>
                                <label style={{ fontSize: '0.7rem' }}>Source</label>
                                <select
                                    className="form-select"
                                    value={target.source || 'ETF'}
                                    onChange={(e) => handleUpdate(ticker, 'source', e.target.value)}
                                >
                                    <option value="ETF">ETF</option>
                                    <option value="MOT">MOT</option>
                                </select>
                            </div>
                        </div>
                    );
                })
            )}

            <div style={{
                marginTop: 'var(--space-4)',
                padding: 'var(--space-3)',
                backgroundColor: 'var(--bg-app)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'center',
                color: Math.abs(total - 100) < 0.1 ? 'var(--color-success)' : 'var(--color-warning)', // Float tolerance
                fontWeight: 600
            }}>
                Total: {total.toFixed(1)}%
            </div>
        </div>
    );
};

export default TargetSettings;
