import React, { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import '../Transactions/Transactions.css'; // Reuse form styles

interface PortfolioAllocationsProps {
    portfolioId: string;
    onClose: () => void;
}

const PortfolioAllocations: React.FC<PortfolioAllocationsProps> = ({ portfolioId, onClose }) => {
    const { portfolios, assetSettings, updatePortfolioAllocation } = usePortfolio();

    const portfolio = portfolios.find(p => p.id === portfolioId);

    // Get all assets defined in settings
    const tickers = useMemo(() => assetSettings.map(s => s.ticker).sort(), [assetSettings]);

    if (!portfolio) return null;

    const allocations = portfolio.allocations || {};
    const total = Object.values(allocations).reduce((sum, val) => sum + val, 0);

    const handleUpdate = (ticker: string, value: string) => {
        const num = parseFloat(value);
        updatePortfolioAllocation(portfolioId, ticker, isNaN(num) ? 0 : num);
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content" style={{ maxWidth: '800px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
                    <h3>Allocations: {portfolio.name}</h3>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
                </div>

                <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
                    Set target percentages for this portfolio. Total should be 100%.
                </p>

                <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 'var(--space-2)' }}>
                    {tickers.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)' }}>No assets defined. Go to Settings to add assets (or add transactions).</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                            <div className="allocation-header" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 100px', gap: 'var(--space-4)', paddingBottom: 'var(--space-2)', borderBottom: '1px solid var(--border-color)', fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                <div>Ticker</div>
                                <div>Asset</div>
                                <div>Class</div>
                                <div>Target %</div>
                            </div>

                            {tickers.map(ticker => {
                                const setting = assetSettings.find(s => s.ticker === ticker);
                                const currentPerc = allocations[ticker] || 0;

                                return (
                                    <div key={ticker} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 100px', gap: 'var(--space-4)', alignItems: 'center' }}>
                                        <div style={{ fontWeight: 500 }}>{ticker}</div>
                                        <div>
                                            {setting?.label || '-'}
                                        </div>
                                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                            {setting?.assetClass}
                                            {setting?.assetSubClass && <span style={{ opacity: 0.7 }}> • {setting.assetSubClass}</span>}
                                        </div>
                                        <div>
                                            <input
                                                type="number"
                                                className="form-input"
                                                value={currentPerc}
                                                onChange={(e) => handleUpdate(ticker, e.target.value)}
                                                min="0"
                                                max="100"
                                                step="0.1"
                                                style={{ textAlign: 'right' }}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div style={{
                    marginTop: 'var(--space-4)',
                    padding: 'var(--space-3)',
                    backgroundColor: 'var(--bg-app)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontWeight: 600
                }}>
                    <span>Total Allocation</span>
                    <span style={{
                        color: Math.abs(total - 100) < 0.1 ? 'var(--color-success)' : 'var(--color-warning)',
                        fontSize: '1.1rem'
                    }}>
                        {total.toFixed(1)}%
                    </span>
                </div>

                <div className="form-actions" style={{ marginTop: 'var(--space-6)' }}>
                    <button onClick={onClose} className="btn btn-primary">
                        Done
                    </button>
                </div>
            </div>

            <style>{`
                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                }

                .modal-content {
                    background-color: var(--bg-surface);
                    padding: var(--space-6);
                    border-radius: var(--radius-lg);
                    width: 100%;
                    border: 1px solid var(--bg-card);
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                }

                .btn {
                    padding: var(--space-2) var(--space-4);
                    border-radius: var(--radius-md);
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    font-size: 0.9rem;
                }

                .btn-primary {
                    background-color: var(--color-primary);
                    color: white;
                }

                .btn-primary:hover {
                    opacity: 0.9;
                }
            `}</style>
        </div>
    );
};

export default PortfolioAllocations;
