import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import '../Transactions/Transactions.css'; // Reuse form styles

const TargetSettings: React.FC = () => {
    const { targets, updateTarget, assets } = usePortfolio();

    // Get unique tickers from assets (plus any already in targets even if 0 items)
    const assetTickers = assets.map(a => a.ticker);
    const targetTickers = targets.map(t => t.ticker);
    const allTickers = Array.from(new Set([...assetTickers, ...targetTickers])).sort();

    const getTarget = (ticker: string) => targets.find(t => t.ticker === ticker)?.targetPercentage || 0;

    const total = targets.reduce((sum, t) => sum + t.targetPercentage, 0);

    const handleUpdate = (ticker: string, value: string) => {
        updateTarget(ticker, Number(value));
    };

    return (
        <div className="transaction-form-card" style={{ maxWidth: '600px', margin: '0 auto' }}>
            <h2>Target Allocation</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
                Define target allocation for each asset. Total should be 100%.
            </p>

            {allTickers.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>No assets found. Add transactions first to see them here.</p>
            ) : (
                allTickers.map(ticker => (
                    <div className="form-group" key={ticker}>
                        <label>{ticker} (%)</label>
                        <input
                            type="number"
                            className="form-input"
                            value={getTarget(ticker)}
                            onChange={(e) => handleUpdate(ticker, e.target.value)}
                            min="0"
                            max="100"
                        />
                    </div>
                ))
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
