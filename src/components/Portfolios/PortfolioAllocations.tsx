import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import '../Transactions/Transactions.css'; // Reuse form styles
import type { AssetClass, AssetSubClass } from '../../types';

interface PortfolioAllocationsProps {
    portfolioId: string;
    onClose: () => void;
}

const PortfolioAllocations: React.FC<PortfolioAllocationsProps> = ({ portfolioId, onClose }) => {
    const { portfolios, assetSettings, updatePortfolioAllocation, updateAssetSettings } = usePortfolio();

    // UI State for "Add Asset" mode
    const [isAddingAsset, setIsAddingAsset] = useState(false);
    const [newAssetTicker, setNewAssetTicker] = useState('');
    const [newAssetLabel, setNewAssetLabel] = useState('');
    const [newAssetClass, setNewAssetClass] = useState<AssetClass>('Stock');
    const [newAssetSubClass, setNewAssetSubClass] = useState<AssetSubClass>('International');

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

    const handleAddAsset = () => {
        if (!newAssetTicker) return;

        // Add to settings (Registry)
        // updateAssetSettings(ticker, source, label, assetClass, assetSubClass)
        updateAssetSettings(
            newAssetTicker.toUpperCase(),
            'ETF',
            newAssetLabel || newAssetTicker.toUpperCase(),
            newAssetClass,
            newAssetSubClass
        );

        // Reset form
        setNewAssetTicker('');
        setNewAssetLabel('');
        setIsAddingAsset(false);
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

                <div style={{ maxHeight: '50vh', overflowY: 'auto', paddingRight: 'var(--space-2)' }}>
                    {tickers.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)' }}>No assets defined. Add an asset below to start.</p>
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

                {/* Add New Asset Section */}
                <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border-color)' }}>
                    {!isAddingAsset ? (
                        <button
                            className="btn"
                            style={{
                                width: '100%',
                                border: '1px dashed var(--border-color)',
                                color: 'var(--text-secondary)',
                                backgroundColor: 'transparent'
                            }}
                            onClick={() => setIsAddingAsset(true)}
                        >
                            + Add New Asset to Allocation
                        </button>
                    ) : (
                        <div style={{
                            padding: 'var(--space-4)',
                            backgroundColor: 'var(--bg-app)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--color-primary)'
                        }}>
                            <h4 style={{ marginTop: 0, marginBottom: 'var(--space-3)' }}>Define New Asset</h4>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Ticker (ISIN)</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="IE00..."
                                        value={newAssetTicker}
                                        onChange={e => setNewAssetTicker(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Label (Name)</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="iShares World..."
                                        value={newAssetLabel}
                                        onChange={e => setNewAssetLabel(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Class</label>
                                    <select
                                        className="form-input"
                                        value={newAssetClass}
                                        onChange={e => setNewAssetClass(e.target.value as AssetClass)}
                                    >
                                        <option value="Stock">Stock</option>
                                        <option value="Bond">Bond</option>
                                        <option value="Commodity">Commodity</option>
                                        <option value="Crypto">Crypto</option>
                                        <option value="Cash">Cash</option>
                                    </select>
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Sub-Class</label>
                                    <select
                                        className="form-input"
                                        value={newAssetSubClass}
                                        onChange={e => setNewAssetSubClass(e.target.value as AssetSubClass)}
                                    >
                                        <option value="International">International</option>
                                        <option value="Local">Local</option>
                                        <option value="Short">Bond: Short Term</option>
                                        <option value="Medium">Bond: Medium Term</option>
                                        <option value="Long">Bond: Long Term</option>
                                        <option value="Gold">Commodity: Gold</option>
                                        <option value="">None/Other</option>
                                    </select>
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                                <button className="btn" onClick={() => setIsAddingAsset(false)}>Cancel</button>
                                <button className="btn btn-primary" onClick={handleAddAsset} disabled={!newAssetTicker}>Add Asset</button>
                            </div>
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
                
                .btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
            `}</style>
        </div>
    );
};

export default PortfolioAllocations;
