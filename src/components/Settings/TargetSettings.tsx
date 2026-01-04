import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import '../Transactions/Transactions.css'; // Reuse form styles
import type { AssetClass, AssetSubClass } from '../../types';

const TargetSettings: React.FC = () => {
    const { assetSettings, updateAssetSettings, assets, resetPortfolio, loadMockData } = usePortfolio();
    const [showConfirmReset, setShowConfirmReset] = useState(false);

    // Get unique tickers from assets (plus any already in settings even if 0 items)
    const assetTickers = assets.map(a => a.ticker);
    const settingTickers = assetSettings.map(t => t.ticker);
    const allTickers = Array.from(new Set([...assetTickers, ...settingTickers])).sort();

    const getSetting = (ticker: string) => assetSettings.find(t => t.ticker === ticker) || { ticker, source: 'ETF', assetClass: 'Stock', assetSubClass: 'International' };


    const handleUpdate = (ticker: string, field: 'source' | 'label' | 'assetClass' | 'assetSubClass', value: string) => {
        const current = getSetting(ticker);
        const newSource = field === 'source' ? value as 'ETF' | 'MOT' : (current.source || 'ETF');
        const newLabel = field === 'label' ? value : current.label;
        const newClass = field === 'assetClass' ? value as AssetClass : (current.assetClass || 'Stock');

        let newSubClass = field === 'assetSubClass' ? value as AssetSubClass : (current.assetSubClass || 'International');

        // Reset subclass if class changes to something incompatible (basic logic)
        if (field === 'assetClass') {
            if (value === 'Bond') newSubClass = 'Medium';
            else if (value === 'Commodity') newSubClass = 'Gold';
            else if (value === 'Crypto') newSubClass = ''; // Just a placeholder or empty
            else newSubClass = 'International';
        }

        updateAssetSettings(ticker, newSource, newLabel, newClass, newSubClass);
    };

    const renderAssetRow = (ticker: string) => {
        const setting = getSetting(ticker);
        return (
            <div className="form-group" key={ticker} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 100px 100px 100px', gap: 'var(--space-4)', alignItems: 'center' }}>
                <label style={{ margin: 0 }}>{ticker}</label>

                <div>
                    <label style={{ fontSize: '0.7rem' }}>Label Name</label>
                    <input
                        type="text"
                        className="form-input"
                        placeholder="Optional Display Name"
                        value={setting.label || ''}
                        onChange={(e) => handleUpdate(ticker, 'label', e.target.value)}
                    />
                </div>


                <div>
                    <label style={{ fontSize: '0.7rem' }}>Asset Class</label>
                    <select
                        className="form-select"
                        value={setting.assetClass || 'Stock'}
                        onChange={(e) => handleUpdate(ticker, 'assetClass', e.target.value)}
                    >
                        <option value="Stock">Stock</option>
                        <option value="Bond">Bond</option>
                        <option value="Commodity">Cmdty</option>
                        <option value="Crypto">Crypto</option>
                    </select>
                </div>

                <div>
                    <label style={{ fontSize: '0.7rem' }}>Subclass</label>
                    {setting.assetClass !== 'Crypto' ? (
                        <select
                            className="form-select"
                            value={setting.assetSubClass || 'International'}
                            onChange={(e) => handleUpdate(ticker, 'assetSubClass', e.target.value)}
                        >
                            {setting.assetClass === 'Stock' && (
                                <>
                                    <option value="International">Intl</option>
                                    <option value="Local">Local</option>
                                </>
                            )}
                            {setting.assetClass === 'Bond' && (
                                <>
                                    <option value="Short">Short</option>
                                    <option value="Medium">Medium</option>
                                    <option value="Long">Long</option>
                                </>
                            )}
                            {setting.assetClass === 'Commodity' && <option value="Gold">Gold</option>}
                        </select>
                    ) : (
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>-</span>
                    )}
                </div>

                <div>
                    <label style={{ fontSize: '0.7rem' }}>Source</label>
                    <select
                        className="form-select"
                        value={setting.source || 'ETF'}
                        onChange={(e) => handleUpdate(ticker, 'source', e.target.value)}
                    >
                        <option value="ETF">ETF</option>
                        <option value="MOT">MOT</option>
                    </select>
                </div>
            </div>
        );
    };

    const activeTickers = allTickers; // Show all

    return (
        <div className="transaction-form-card" style={{ maxWidth: '800px', margin: '0 auto' }}>
            <h2>Asset Registry & Settings</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
                Configure asset labels, classes and price sources.
                <br /><small>Target allocations are now configured per-portfolio in the Portfolios tab.</small>
            </p>

            {allTickers.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>No assets found. Add transactions first to see them here.</p>
            ) : (
                <>
                    {activeTickers.map(renderAssetRow)}
                </>
            )}

            <div style={{ marginTop: 'var(--space-6)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border-color)' }}>
                <h3 style={{ color: 'var(--text-primary)', fontSize: '1rem', marginBottom: 'var(--space-2)' }}>Developer Tools</h3>
                <button
                    onClick={() => {
                        if (confirm('Replace current data with Mock Data? This overrides everything.')) {
                            loadMockData();
                        }
                    }}
                    style={{
                        backgroundColor: 'var(--bg-card)',
                        border: '1px solid var(--color-primary)',
                        color: 'var(--color-primary)',
                        padding: 'var(--space-2) var(--space-4)',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                        fontWeight: 600,
                        marginRight: 'var(--space-3)'
                    }}
                >
                    Load Mock Data (3 Test ISINs)
                </button>
            </div>

            <div style={{ marginTop: 'var(--space-6)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border-color)' }}>
                <h3 style={{ color: 'var(--color-danger)', fontSize: '1rem', marginBottom: 'var(--space-2)' }}>Danger Zone</h3>

                {!showConfirmReset ? (
                    <button
                        onClick={() => setShowConfirmReset(true)}
                        style={{
                            backgroundColor: 'transparent',
                            border: '1px solid var(--color-danger)',
                            color: 'var(--color-danger)',
                            padding: 'var(--space-2) var(--space-4)',
                            borderRadius: 'var(--radius-md)',
                            cursor: 'pointer',
                            fontWeight: 600
                        }}
                    >
                        Delete All Data
                    </button>
                ) : (
                    <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)' }}>
                        <span style={{ color: 'var(--color-danger)', fontWeight: 500 }}>Are you sure? This cannot be undone.</span>
                        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                            <button
                                onClick={() => {
                                    resetPortfolio();
                                    setShowConfirmReset(false);
                                }}
                                style={{
                                    backgroundColor: 'var(--color-danger)',
                                    color: 'white',
                                    border: 'none',
                                    padding: 'var(--space-1) var(--space-3)',
                                    borderRadius: 'var(--radius-sm)',
                                    cursor: 'pointer',
                                    fontWeight: 600
                                }}
                            >
                                Yes, Delete All
                            </button>
                            <button
                                onClick={() => setShowConfirmReset(false)}
                                style={{
                                    backgroundColor: 'var(--bg-card)',
                                    color: 'var(--text-primary)',
                                    border: '1px solid var(--border-color)',
                                    padding: 'var(--space-1) var(--space-3)',
                                    borderRadius: 'var(--radius-sm)',
                                    cursor: 'pointer'
                                }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TargetSettings;
