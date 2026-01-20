import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import '../Transactions/Transactions.css'; // Reuse form styles
import type { AssetClass, AssetSubClass } from '../../types';
import Swal from 'sweetalert2';
import MacroSettings from './MacroSettings';

const TargetSettings: React.FC = () => {

    // ... (existing imports)
    const {
        assetSettings,
        updateAssetSettings,
        assets,
        resetPortfolio,
        loadMockData,
        // Get all state for backup
        transactions,
        portfolios,
        brokers,
        marketData,
        macroAllocations,
        goalAllocations,
        importData
    } = usePortfolio();

    // ... (existing state)
    const [showConfirmReset, setShowConfirmReset] = useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    // ... (existing helpers)
    const assetTickers = assets.map(a => a.ticker);
    const settingTickers = assetSettings.map(t => t.ticker);
    const allTickers = Array.from(new Set([...assetTickers, ...settingTickers])).sort();

    const getSetting = (ticker: string) => assetSettings.find(t => t.ticker === ticker) || { ticker, source: 'ETF', assetClass: 'Stock', assetSubClass: 'International' };

    const handleUpdate = (ticker: string, field: 'source' | 'label' | 'assetClass' | 'assetSubClass', value: string) => {
        // ... (existing implementation)
        const current = getSetting(ticker);
        const newSource = field === 'source' ? value as 'ETF' | 'MOT' | 'CPRAM' : (current.source || 'ETF');
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

    const handleBackup = () => {
        const backupData = {
            version: 1,
            timestamp: new Date().toISOString(),
            transactions,
            assetSettings,
            portfolios,
            brokers,
            marketData,
            macroAllocations,
            goalAllocations
        };

        const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `portfolio-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleRestore = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const content = e.target?.result as string;
                const data = JSON.parse(content);

                Swal.fire({
                    title: 'Restore Backup?',
                    text: "This will overwrite ALL current data with the backup. This action cannot be undone!",
                    icon: 'warning',
                    showCancelButton: true,
                    confirmButtonColor: '#3085d6',
                    cancelButtonColor: '#d33',
                    confirmButtonText: 'Yes, restore it!'
                }).then(async (result) => {
                    if (result.isConfirmed) {
                        const success = await importData(data);
                        if (success) {
                            Swal.fire(
                                'Restored!',
                                'Your data has been restored successfully.',
                                'success'
                            );
                        } else {
                            Swal.fire(
                                'Error!',
                                'Failed to restore data. The file might be corrupted.',
                                'error'
                            );
                        }
                    }
                    // Reset input
                    if (fileInputRef.current) fileInputRef.current.value = '';
                });

            } catch (err) {
                console.error('Json parse error', err);
                Swal.fire(
                    'Error!',
                    'Invalid backup file format.',
                    'error'
                );
                if (fileInputRef.current) fileInputRef.current.value = '';
            }
        };
        reader.readAsText(file);
    };


    const renderAssetRow = (ticker: string) => {
        // ... (existing implementation)
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
                        <option value="CPRAM">CPRAM</option>
                    </select>
                </div>
            </div>
        );
    };

    const activeTickers = allTickers; // Show all

    return (
        <div className="transaction-form-card" style={{ maxWidth: '800px', margin: '0 auto' }}>
            <MacroSettings />

            <div style={{ margin: '3rem 0', borderTop: '1px solid var(--border-color)' }}></div>

            {/* Data Management Section */}
            <div>
                <h2 className="section-title">Data Management</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                    Backup your entire portfolio data to a JSON file or restore from a previous backup.
                </p>
                <div style={{ display: 'flex', gap: '1rem', marginBottom: '3rem' }}>
                    <button
                        onClick={handleBackup}
                        style={{
                            padding: '0.75rem 1.5rem',
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--color-primary)',
                            color: 'var(--color-primary)',
                            borderRadius: 'var(--radius-md)',
                            cursor: 'pointer',
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem'
                        }}
                    >
                        <span style={{ fontSize: '1.2rem' }}>↓</span> Run Backup
                    </button>

                    <button
                        onClick={() => fileInputRef.current?.click()}
                        style={{
                            padding: '0.75rem 1.5rem',
                            backgroundColor: 'var(--bg-card)',
                            border: '1px solid var(--text-secondary)',
                            color: 'var(--text-primary)',
                            borderRadius: 'var(--radius-md)',
                            cursor: 'pointer',
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem'
                        }}
                    >
                        <span style={{ fontSize: '1.2rem' }}>↑</span> Restore Data
                    </button>
                    <input
                        type="file"
                        ref={fileInputRef}
                        style={{ display: 'none' }}
                        accept=".json"
                        onChange={handleRestore}
                    />
                </div>
            </div>

            <div style={{ margin: '3rem 0', borderTop: '1px solid var(--border-color)' }}></div>


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
                        Swal.fire({
                            title: 'Load Mock Data?',
                            text: "This will replace all your current data with test data. This action cannot be undone!",
                            icon: 'warning',
                            showCancelButton: true,
                            confirmButtonColor: '#3085d6',
                            cancelButtonColor: '#d33',
                            confirmButtonText: 'Yes, overwrite everything!'
                        }).then((result) => {
                            if (result.isConfirmed) {
                                loadMockData();
                                Swal.fire(
                                    'Loaded!',
                                    'Mock data has been loaded.',
                                    'success'
                                );
                            }
                        });
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
