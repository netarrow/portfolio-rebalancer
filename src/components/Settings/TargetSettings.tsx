import React, { useEffect, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import '../Transactions/Transactions.css'; // Reuse form styles
import type { AssetClass, AssetSubClass, PriceSource, YnabBudgetRef } from '../../types';
import Swal from 'sweetalert2';
import { testAzureConnection } from '../../services/azureSync';
import { milliunitsToEur } from '../../services/ynabApi';
import type { YnabBudgetSummary, YnabAccountSummary } from '../../services/ynabApi';
import EncryptionSettingsCard from '../Security/EncryptionSettingsCard';
import PremiumPriceCard from './PremiumPriceCard';
import FreeCommissionCard from './FreeCommissionCard';
import PeopleCard from './PeopleCard';
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
        assetAllocationSettings,
        macroAllocations,
        goalAllocations,
        goals,
        freeCommissionPeriods,
        plannedForecastExpenses,
        people,
        pacPlans,
        pacExecutions,
        importData,
        // Price history (separate backup JSON, local-only)
        priceHistory,
        refreshHistory,
        importPriceHistory,
        // Azure sync
        azureConfig,
        setAzureConfig,
        syncToAzure,
        restoreFromAzure,
        azureSyncing,
        // YNAB
        ynabConfig,
        setYnabConfig,
        ynabListBudgets,
        disconnectYnab,
        ynabSyncing,
        ynabAccountMappings,
        setYnabAccountMapping,
        refreshYnabBudgets,
        listYnabAccounts,
    } = usePortfolio();

    // ... (existing state)
    const [showConfirmReset, setShowConfirmReset] = useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const historyFileInputRef = React.useRef<HTMLInputElement>(null);

    // Azure sync form state (local, not persisted until saved)
    const [localSasUrl, setLocalSasUrl] = useState(azureConfig.sasUrl);
    const [localPassphrase, setLocalPassphrase] = useState(azureConfig.passphrase);
    const [showSasUrl, setShowSasUrl] = useState(false);
    const [showPassphrase, setShowPassphrase] = useState(false);
    const [connectionStatus, setConnectionStatus] = useState<'idle' | 'ok' | 'error'>('idle');

    // YNAB local form state
    const [ynabApiKeyInput, setYnabApiKeyInput] = useState(ynabConfig?.apiKey ?? '');
    const [showYnabKey, setShowYnabKey] = useState(false);
    const [ynabBudgets, setYnabBudgets] = useState<YnabBudgetSummary[] | null>(null);
    const [ynabVerifying, setYnabVerifying] = useState(false);
    const [ynabSelectedBudgetId, setYnabSelectedBudgetId] = useState(ynabConfig?.budgetId ?? '');

    // Broker ↔ YNAB account mapping: brokers can be mapped to accounts of any
    // budget the token reaches, so accounts are cached per budget and fetched
    // lazily — the primary budget plus every budget already mapped, then any
    // budget the user picks from a broker's Budget select.
    const [accountsByBudget, setAccountsByBudget] = useState<Record<string, YnabAccountSummary[]>>({});
    const [loadingBudgetIds, setLoadingBudgetIds] = useState<string[]>([]);
    const [ynabAccountsError, setYnabAccountsError] = useState<string | null>(null);

    // Budgets offered by the per-broker Budget select: the cached list, the
    // primary budget, and any budget an existing mapping points at. That last
    // one matters — a budget missing from the list would otherwise make the
    // select display (and, on the next pick, silently apply) the wrong budget.
    const ynabBudgetRefs: YnabBudgetRef[] = (() => {
        if (!ynabConfig) return [];
        const byId = new Map<string, YnabBudgetRef>();
        byId.set(ynabConfig.budgetId, {
            id: ynabConfig.budgetId,
            name: ynabConfig.budgetName || ynabConfig.budgetId,
            currencyIso: ynabConfig.currencyIso || 'EUR',
        });
        for (const b of ynabConfig.budgets ?? []) byId.set(b.id, b);
        for (const m of Object.values(ynabAccountMappings)) {
            if (!byId.has(m.budgetId)) {
                byId.set(m.budgetId, { id: m.budgetId, name: `${m.budgetId} (unknown budget)`, currencyIso: 'EUR' });
            }
        }
        return [...byId.values()];
    })();

    // Keep the mapping cache addressed by a stable key so the fetch effect
    // doesn't re-run on every render of the mappings object.
    const mappedBudgetIdsKey = Array.from(
        new Set(Object.values(ynabAccountMappings).map(m => m.budgetId))
    ).sort().join(',');

    const loadAccountsForBudget = React.useCallback(async (budgetId: string) => {
        if (!budgetId) return;
        setLoadingBudgetIds(prev => (prev.includes(budgetId) ? prev : [...prev, budgetId]));
        const res = await listYnabAccounts(budgetId);
        setLoadingBudgetIds(prev => prev.filter(id => id !== budgetId));
        if (res.ok && res.accounts) {
            setAccountsByBudget(prev => ({ ...prev, [budgetId]: res.accounts! }));
        } else {
            setYnabAccountsError(res.error || 'Unable to load YNAB accounts.');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ynabConfig?.apiKey]);

    useEffect(() => {
        if (!ynabConfig?.apiKey || !ynabConfig?.budgetId) {
            setAccountsByBudget({});
            return;
        }
        setYnabAccountsError(null);
        const wanted = new Set<string>([ynabConfig.budgetId]);
        for (const id of mappedBudgetIdsKey.split(',')) if (id) wanted.add(id);
        for (const id of wanted) {
            if (!(id in accountsByBudget)) void loadAccountsForBudget(id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ynabConfig?.apiKey, ynabConfig?.budgetId, mappedBudgetIdsKey]);

    // A stored config from before multi-budget support has no cached budget
    // list; fetch it so the Budget select has something to offer.
    useEffect(() => {
        if (!ynabConfig?.apiKey || ynabConfig.budgets) return;
        void refreshYnabBudgets();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ynabConfig?.apiKey, ynabConfig?.budgets]);

    // brokerId currently holding each account, to flag reassignments in the UI.
    // Keyed by budget too: the same account id in another budget is free.
    const brokerIdByAccountKey = new Map(
        Object.entries(ynabAccountMappings).map(([brokerId, m]) => [`${m.budgetId}:${m.accountId}`, brokerId])
    );

    // Budget picked for a broker before an account was chosen: the mapping alone
    // can't remember it, since it only exists once an account is selected.
    const [pendingBudgetByBroker, setPendingBudgetByBroker] = useState<Record<string, string>>({});

    const budgetIdForBroker = (brokerId: string): string =>
        pendingBudgetByBroker[brokerId]
        || ynabAccountMappings[brokerId]?.budgetId
        || ynabConfig?.budgetId
        || '';

    // Changing the budget drops the account: account ids don't carry over.
    const handleBrokerBudgetChange = (brokerId: string, budgetId: string) => {
        setPendingBudgetByBroker(prev => ({ ...prev, [brokerId]: budgetId }));
        if (ynabAccountMappings[brokerId]) setYnabAccountMapping(brokerId, null);
        if (budgetId && !(budgetId in accountsByBudget)) void loadAccountsForBudget(budgetId);
    };

    // ... (existing helpers)
    const assetTickers = assets.map(a => a.ticker);
    const settingTickers = assetSettings.map(t => t.ticker);
    const allTickers = Array.from(new Set([...assetTickers, ...settingTickers])).sort();

    const getSetting = (ticker: string) => assetSettings.find(t => t.ticker === ticker) || { ticker, source: 'ETF', assetClass: 'Stock', assetSubClass: 'International' };

    const handleUpdate = (ticker: string, field: 'source' | 'label' | 'assetClass' | 'assetSubClass', value: string) => {
        // ... (existing implementation)
        const current = getSetting(ticker);
        const newSource = field === 'source' ? value as PriceSource : (current.source || 'ETF');
        const newLabel = field === 'label' ? value : current.label;
        const newClass = field === 'assetClass' ? value as AssetClass : (current.assetClass || 'Stock');

        let newSubClass = field === 'assetSubClass' ? value as AssetSubClass : (current.assetSubClass || 'International');

        // Reset subclass if class changes to something incompatible (basic logic)
        if (field === 'assetClass') {
            if (value === 'Bond') newSubClass = 'Medium';
            else if (value === 'Commodity') newSubClass = 'Gold';
            else if (value === 'Crypto') newSubClass = '';
            else if (value === 'PensionFund') newSubClass = 'Balanced';
            else newSubClass = 'International';
        }

        updateAssetSettings(ticker, newSource, newLabel, newClass, newSubClass);
    };

    const handleBackup = () => {
        const backupData = {
            // v6 makes broker↔YNAB account mappings budget-qualified (v5 stored a
            // bare account id); older backups restore fine, since missing fields
            // default and v5 mappings are attached to the configured budget.
            version: 6,
            timestamp: new Date().toISOString(),
            transactions,
            assetSettings,
            portfolios,
            brokers,
            marketData,
            assetAllocationSettings,
            macroAllocations,
            goalAllocations,
            goals,
            freeCommissionPeriods,
            plannedForecastExpenses,
            people,
            ynabAccountMappings,
            pacPlans,
            pacExecutions
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


    const handleHistoryBackup = () => {
        const backupData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            history: priceHistory,
        };

        const blob = new Blob([JSON.stringify(backupData)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `portfolio-price-history-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleHistoryRestore = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            const resetInput = () => { if (historyFileInputRef.current) historyFileInputRef.current.value = ''; };
            try {
                const content = e.target?.result as string;
                const data = JSON.parse(content);
                if (data?.version !== 1 || !data?.history || typeof data.history !== 'object') {
                    throw new Error('Invalid price history file');
                }

                const result = await Swal.fire({
                    title: 'Import price history?',
                    html: `<p style="text-align:left;font-size:0.9rem"><b>Merge</b> unions the imported daily points with the existing ones (recommended).</p>
                           <p style="text-align:left;font-size:0.9rem"><b>Replace</b> discards the current history entirely.</p>`,
                    icon: 'question',
                    showCancelButton: true,
                    showDenyButton: true,
                    confirmButtonText: 'Merge',
                    denyButtonText: 'Replace',
                    cancelButtonText: 'Cancel',
                });

                if (result.isConfirmed || result.isDenied) {
                    const success = importPriceHistory(data.history, result.isConfirmed ? 'merge' : 'replace');
                    if (success) {
                        Swal.fire('Imported!', 'Price history has been imported.', 'success');
                    } else {
                        Swal.fire('Error!', 'Failed to import price history.', 'error');
                    }
                }
                resetInput();
            } catch (err) {
                console.error('Price history parse error', err);
                Swal.fire('Error!', 'Invalid price history file format.', 'error');
                resetInput();
            }
        };
        reader.readAsText(file);
    };

    const handleSaveAzureConfig = () => {
        const trimmed = localSasUrl.trim();
        if (trimmed) {
            let parsed: URL;
            try {
                parsed = new URL(trimmed);
            } catch {
                Swal.fire({ title: 'Invalid SAS URL', text: 'The SAS URL is not a valid URL.', icon: 'error' });
                return;
            }
            if (parsed.protocol !== 'https:') {
                Swal.fire({ title: 'Invalid SAS URL', text: 'The SAS URL must use HTTPS.', icon: 'error' });
                return;
            }
            if (!parsed.hostname.endsWith('.blob.core.windows.net')) {
                Swal.fire({ title: 'Invalid SAS URL', text: 'The SAS URL must point to an Azure Blob Storage endpoint (*.blob.core.windows.net).', icon: 'error' });
                return;
            }
        }
        setAzureConfig(prev => ({ ...prev, sasUrl: trimmed, passphrase: localPassphrase }));
        setConnectionStatus('idle');
        Swal.fire({ title: 'Settings saved', icon: 'success', timer: 1500, showConfirmButton: false });
    };

    const handleTestConnection = async () => {
        const result = await testAzureConnection(localSasUrl);
        setConnectionStatus(result.ok ? 'ok' : 'error');
        if (!result.ok) {
            Swal.fire({ title: 'Connection failed', text: result.error, icon: 'error' });
        } else if (!result.blobExists) {
            Swal.fire({ title: 'Connection OK', text: 'No backup found on Azure — it will be initialized automatically on first sync.', icon: 'info', timer: 3000, showConfirmButton: false });
        }
    };

    const handleSyncNow = async () => {
        const result = await syncToAzure();
        if (result.ok) {
            Swal.fire({ title: 'Synced!', icon: 'success', timer: 1500, showConfirmButton: false });
        } else {
            Swal.fire({ title: 'Sync error', text: result.error, icon: 'error' });
        }
    };

    const handleRestoreFromAzure = async () => {
        const confirm = await Swal.fire({
            title: 'Restore from Azure?',
            text: 'Local data will be overwritten with the data from Azure. This operation cannot be undone.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#3085d6',
            cancelButtonColor: '#d33',
            confirmButtonText: 'Restore',
            cancelButtonText: 'Cancel',
        });
        if (!confirm.isConfirmed) return;
        const result = await restoreFromAzure();
        if (result.ok) {
            Swal.fire({ title: 'Restored!', text: 'Data has been restored from Azure.', icon: 'success' });
        } else {
            Swal.fire({ title: 'Error', text: result.error, icon: 'error' });
        }
    };

    const handleYnabVerify = async () => {
        if (!ynabApiKeyInput.trim()) {
            Swal.fire({ title: 'Enter the API key', icon: 'warning' });
            return;
        }
        setYnabVerifying(true);
        const result = await ynabListBudgets(ynabApiKeyInput.trim());
        setYnabVerifying(false);
        if (!result.ok || !result.budgets) {
            setYnabBudgets(null);
            Swal.fire({ title: 'Verification failed', text: result.error, icon: 'error' });
            return;
        }
        setYnabBudgets(result.budgets);
        if (result.budgets.length === 0) {
            Swal.fire({ title: 'No budgets found', icon: 'info' });
            return;
        }
        // Auto-select the first budget if none chosen yet
        if (!ynabSelectedBudgetId) {
            setYnabSelectedBudgetId(result.budgets[0].id);
        }
        Swal.fire({ title: 'YNAB connection OK', icon: 'success', timer: 1500, showConfirmButton: false });
    };

    const handleYnabSaveBudget = () => {
        if (!ynabApiKeyInput.trim() || !ynabSelectedBudgetId || !ynabBudgets) return;
        const selected = ynabBudgets.find(b => b.id === ynabSelectedBudgetId);
        if (!selected) return;
        setYnabConfig({
            ...ynabConfig,
            apiKey: ynabApiKeyInput.trim(),
            budgetId: selected.id,
            budgetName: selected.name,
            currencyIso: selected.currencyIso,
            // Cache every budget of the token: broker mappings can target any of
            // them, not just the primary one saved here.
            budgets: ynabBudgets.map(b => ({ id: b.id, name: b.name, currencyIso: b.currencyIso })),
            lastSyncAt: ynabConfig?.lastSyncAt,
        });
        Swal.fire({ title: 'YNAB configured', icon: 'success', timer: 1500, showConfirmButton: false });
    };

    const handleYnabDisconnect = async () => {
        const confirm = await Swal.fire({
            title: 'Disconnect YNAB?',
            text: 'API key, imported categories, and mappings will be removed. This action cannot be undone.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Disconnect',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#d33',
        });
        if (!confirm.isConfirmed) return;
        disconnectYnab();
        setYnabApiKeyInput('');
        setYnabBudgets(null);
        setYnabSelectedBudgetId('');
    };

    const renderAssetRow = (ticker: string) => {
        // ... (existing implementation)
        const setting = getSetting(ticker);
        return (
            <div className="form-group asset-registry-row" key={ticker} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 100px 100px 100px', gap: 'var(--space-4)', alignItems: 'center' }}>
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
                        <option value="PensionFund">Pension</option>
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
                            {setting.assetClass === 'PensionFund' && <option value="Balanced">Balanced</option>}
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
                        <option value="COMETA">COMETA</option>
                        <option value="FT">FT Markets</option>
                    </select>
                </div>
            </div>
        );
    };

    const activeTickers = allTickers; // Show all

    return (
        <div className="transaction-form-card" style={{ maxWidth: '800px', margin: '0 auto' }}>
            <PremiumPriceCard />

            <EncryptionSettingsCard />

            <FreeCommissionCard />

            <PeopleCard />

            {/* Data Management Section */}
            <div>
                <h2 className="section-title">Data Management</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                    Backup your entire portfolio data to a JSON file or restore from a previous backup.
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
                    Backup files are exported as plaintext JSON. For an encrypted off-device copy use the Azure backup below.
                </p>
                <div className="data-management-buttons" style={{ display: 'flex', gap: '1rem', marginBottom: '3rem' }}>
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

                {/* Price History (separate backup) */}
                <h3 style={{ color: 'var(--text-primary)', marginBottom: '0.5rem' }}>Price History</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                    Day-by-day price history powers the Performance charts. It is kept separate from the
                    main backup above and from Azure sync: export/import it with its own JSON file.
                </p>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '1rem' }}>
                    "Update History" backfills each asset from its first purchase date. Notes: MOT bonds are
                    stored as clean price (corso secco, no accrued interest), COMETA has monthly NAV points,
                    CPRAM has no historical source and only accumulates from regular price updates.
                    FT Markets serves daily closes/NAVs for instruments the other sources don't list, such as
                    Luxembourg-domiciled funds; it publishes no bid/ask or volatility, so trade-cost estimates
                    fall back to the broker commission alone.
                </p>
                <div className="data-management-buttons" style={{ display: 'flex', gap: '1rem', marginBottom: '3rem', flexWrap: 'wrap' }}>
                    <button
                        onClick={() => refreshHistory()}
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
                        <span style={{ fontSize: '1.2rem' }}>⟳</span> Update History
                    </button>

                    <button
                        onClick={handleHistoryBackup}
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
                        <span style={{ fontSize: '1.2rem' }}>↓</span> Export History
                    </button>

                    <button
                        onClick={() => historyFileInputRef.current?.click()}
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
                        <span style={{ fontSize: '1.2rem' }}>↑</span> Import History
                    </button>
                    <input
                        type="file"
                        ref={historyFileInputRef}
                        style={{ display: 'none' }}
                        accept=".json"
                        onChange={handleHistoryRestore}
                    />
                </div>
            </div>

            <div style={{ margin: '3rem 0', borderTop: '1px solid var(--border-color)' }}></div>

            {/* Azure Cloud Sync Section */}
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                    <h2 className="section-title" style={{ margin: 0 }}>Cloud Sync (Azure)</h2>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontWeight: 500 }}>
                        <input
                            type="checkbox"
                            checked={azureConfig.enabled}
                            onChange={e => setAzureConfig(prev => ({ ...prev, enabled: e.target.checked }))}
                        />
                        Enabled
                    </label>
                    {azureSyncing && <span style={{ color: 'var(--color-primary)', fontSize: '0.85rem' }}>Syncing...</span>}
                </div>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
                    Data is encrypted with AES-256-GCM in the browser before being uploaded to Azure.
                    Azure stores only an opaque blob: without the passphrase, the data is unreadable.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '560px' }}>
                    {/* SAS URL */}
                    <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Azure blob SAS URL</label>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input
                                type={showSasUrl ? 'text' : 'password'}
                                value={localSasUrl}
                                onChange={e => { setLocalSasUrl(e.target.value); setConnectionStatus('idle'); }}
                                placeholder="https://<account>.blob.core.windows.net/<container>/<blob>?sv=..."
                                style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}
                            />
                            <button
                                onClick={() => setShowSasUrl(v => !v)}
                                style={{ padding: '0.4rem 0.7rem', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
                                title={showSasUrl ? 'Hide' : 'Show'}
                            >
                                {showSasUrl ? '🙈' : '👁'}
                            </button>
                        </div>
                        <small style={{ color: 'var(--text-muted)' }}>
                            Azure Portal → Storage Account → Container → blob → Generate SAS (Read + Write permissions)
                        </small>
                    </div>

                    {/* Passphrase */}
                    <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Encryption passphrase</label>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input
                                type={showPassphrase ? 'text' : 'password'}
                                value={localPassphrase}
                                onChange={e => setLocalPassphrase(e.target.value)}
                                placeholder="Secret passphrase (not saved to Azure)"
                                style={{ flex: 1 }}
                            />
                            <button
                                onClick={() => setShowPassphrase(v => !v)}
                                style={{ padding: '0.4rem 0.7rem', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
                                title={showPassphrase ? 'Hide' : 'Show'}
                            >
                                {showPassphrase ? '🙈' : '👁'}
                            </button>
                        </div>
                        <small style={{ color: 'var(--text-muted)' }}>
                            Stored in the browser only. Required to decrypt data on every device.
                        </small>
                    </div>

                    {/* Save + Test */}
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button
                            onClick={handleSaveAzureConfig}
                            style={{ padding: '0.6rem 1.2rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                        >
                            Save settings
                        </button>
                        <button
                            onClick={handleTestConnection}
                            disabled={!localSasUrl}
                            style={{ padding: '0.6rem 1.2rem', backgroundColor: 'var(--bg-card)', border: `1px solid ${connectionStatus === 'ok' ? 'var(--color-success)' : connectionStatus === 'error' ? 'var(--color-danger)' : 'var(--border-color)'}`, color: connectionStatus === 'ok' ? 'var(--color-success)' : connectionStatus === 'error' ? 'var(--color-danger)' : 'var(--text-primary)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                        >
                            {connectionStatus === 'ok' ? 'Connection OK' : connectionStatus === 'error' ? 'Connection failed' : 'Test connection'}
                        </button>
                    </div>

                    {/* Sync + Restore */}
                    {azureConfig.enabled && azureConfig.sasUrl && (
                        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', paddingTop: '0.5rem', borderTop: '1px solid var(--border-color)' }}>
                            {azureConfig.lastSync === null ? (
                                <button
                                    onClick={handleSyncNow}
                                    disabled={azureSyncing}
                                    style={{ padding: '0.6rem 1.2rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                                >
                                    Initialize on Azure
                                </button>
                            ) : (
                                <>
                                    <button
                                        onClick={handleSyncNow}
                                        disabled={azureSyncing}
                                        style={{ padding: '0.6rem 1.2rem', backgroundColor: 'var(--bg-card)', border: '1px solid var(--color-primary)', color: 'var(--color-primary)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                                    >
                                        Sync now
                                    </button>
                                    <button
                                        onClick={handleRestoreFromAzure}
                                        disabled={azureSyncing}
                                        style={{ padding: '0.6rem 1.2rem', backgroundColor: 'var(--bg-card)', border: '1px solid var(--text-secondary)', color: 'var(--text-primary)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                                    >
                                        Restore from Azure
                                    </button>
                                </>
                            )}
                            <span style={{ alignSelf: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                                {azureConfig.lastSync
                                    ? `Last sync: ${new Date(azureConfig.lastSync).toLocaleString('en-GB')}`
                                    : 'Never synced'}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            <div style={{ margin: '3rem 0', borderTop: '1px solid var(--border-color)' }}></div>

            {/* YNAB Integration Section */}
            <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
                    <h2 className="section-title" style={{ margin: 0 }}>YNAB (You Need A Budget)</h2>
                    {ynabSyncing && <span style={{ color: 'var(--color-primary)', fontSize: '0.85rem' }}>Syncing...</span>}
                </div>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                    Import your YNAB budget category balances and map each category to an investment asset or to broker cash.
                </p>
                <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem', fontSize: '0.85rem' }}>
                    YNAB credentials are stored only on this device and are never synced to Azure. Category → asset mappings are.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '560px' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                        <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Personal Access Token</label>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input
                                type={showYnabKey ? 'text' : 'password'}
                                value={ynabApiKeyInput}
                                onChange={e => { setYnabApiKeyInput(e.target.value); setYnabBudgets(null); }}
                                placeholder="YNAB token (Account Settings → Developer Settings)"
                                style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}
                            />
                            <button
                                onClick={() => setShowYnabKey(v => !v)}
                                style={{ padding: '0.4rem 0.7rem', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
                                title={showYnabKey ? 'Hide' : 'Show'}
                            >
                                {showYnabKey ? '🙈' : '👁'}
                            </button>
                        </div>
                        <small style={{ color: 'var(--text-muted)' }}>
                            Generate the token at app.ynab.com → Account Settings → Developer Settings → New Token.
                        </small>
                    </div>

                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button
                            onClick={handleYnabVerify}
                            disabled={!ynabApiKeyInput.trim() || ynabVerifying}
                            style={{ padding: '0.6rem 1.2rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                        >
                            {ynabVerifying ? 'Verifying…' : 'Verify and load budget'}
                        </button>
                        {ynabConfig && (
                            <button
                                onClick={handleYnabDisconnect}
                                style={{ padding: '0.6rem 1.2rem', backgroundColor: 'transparent', color: 'var(--color-danger)', border: '1px solid var(--color-danger)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                            >
                                Disconnect YNAB
                            </button>
                        )}
                    </div>

                    {ynabBudgets && ynabBudgets.length > 0 && (
                        <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Budget</label>
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                <select
                                    className="form-select"
                                    value={ynabSelectedBudgetId}
                                    onChange={e => setYnabSelectedBudgetId(e.target.value)}
                                    style={{ flex: 1, minWidth: '200px' }}
                                >
                                    {ynabBudgets.map(b => (
                                        <option key={b.id} value={b.id}>
                                            {b.name} ({b.currencyIso})
                                        </option>
                                    ))}
                                </select>
                                <button
                                    onClick={handleYnabSaveBudget}
                                    disabled={!ynabSelectedBudgetId}
                                    style={{ padding: '0.6rem 1.2rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                                >
                                    Save budget
                                </button>
                            </div>
                            {ynabSelectedBudgetId && (() => {
                                const selected = ynabBudgets.find(b => b.id === ynabSelectedBudgetId);
                                if (selected && selected.currencyIso !== 'EUR') {
                                    return (
                                        <small style={{ color: 'var(--color-warning, orange)' }}>
                                            ⚠ The budget currency is {selected.currencyIso}, not EUR. Values will be shown in the native currency.
                                        </small>
                                    );
                                }
                                return null;
                            })()}
                        </div>
                    )}

                    {ynabConfig && (
                        <div style={{ paddingTop: '0.5rem', borderTop: '1px solid var(--border-color)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <div>Active budget: <strong>{ynabConfig.budgetName || ynabConfig.budgetId}</strong> ({ynabConfig.currencyIso || '—'})</div>
                            <div>
                                Last sync: {ynabConfig.lastSyncAt
                                    ? new Date(ynabConfig.lastSyncAt).toLocaleString('en-IE')
                                    : 'never'}
                            </div>
                            <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <label htmlFor="ynab-avg-window">Budget average window:</label>
                                <input
                                    id="ynab-avg-window"
                                    type="number"
                                    min={1}
                                    max={24}
                                    step={1}
                                    value={ynabConfig.avgMonthsWindow ?? 6}
                                    onChange={e => {
                                        const raw = parseInt(e.target.value, 10);
                                        if (Number.isNaN(raw)) return;
                                        const clamped = Math.max(1, Math.min(24, raw));
                                        setYnabConfig({ ...ynabConfig, avgMonthsWindow: clamped });
                                    }}
                                    className="form-input"
                                    style={{ width: '80px' }}
                                />
                                <span>months (excludes the current month, 1–24)</span>
                            </div>
                        </div>
                    )}

                    {ynabConfig && (
                        <div style={{ paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)' }}>
                            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>Broker ↔ YNAB accounts</label>
                            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0.25rem 0 0.75rem 0' }}>
                                Link each broker to the YNAB account that holds its cash, picking the budget that account
                                lives in — brokers can be spread over different budgets of the same token. From the Brokers
                                page you can then update every mapped broker's liquidity with the account's working balance.
                                One account can back a single broker, within its own budget.
                                {ynabConfig.lastAccountsSyncAt && (
                                    <> Last liquidity update: {new Date(ynabConfig.lastAccountsSyncAt).toLocaleString('en-IE')}.</>
                                )}
                            </p>

                            {ynabAccountsError && (
                                <div style={{ color: 'var(--color-danger)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                                    {ynabAccountsError}
                                </div>
                            )}

                            {brokers.length === 0 ? (
                                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No brokers yet.</p>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    {brokers.map(broker => {
                                        const budgetId = budgetIdForBroker(broker.id);
                                        const accounts = accountsByBudget[budgetId] ?? [];
                                        const accountsLoading = loadingBudgetIds.includes(budgetId);
                                        const mapping = ynabAccountMappings[broker.id];
                                        return (
                                            <div key={broker.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                                                <span style={{ flex: 1, minWidth: '140px', fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                                                    {broker.name}
                                                </span>
                                                {/* Budget + account stay together when the row wraps, so a
                                                    narrow column never detaches the account from its broker. */}
                                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', flex: 2, minWidth: '240px' }}>
                                                <select
                                                    className="form-select"
                                                    aria-label={`YNAB budget for ${broker.name}`}
                                                    value={budgetId}
                                                    onChange={e => handleBrokerBudgetChange(broker.id, e.target.value)}
                                                    disabled={ynabBudgetRefs.length === 0}
                                                    style={{ flex: 1, minWidth: '160px' }}
                                                >
                                                    {ynabBudgetRefs.map(b => (
                                                        <option key={b.id} value={b.id}>{b.name}</option>
                                                    ))}
                                                </select>
                                                <select
                                                    className="form-select"
                                                    aria-label={`YNAB account for ${broker.name}`}
                                                    value={mapping?.budgetId === budgetId ? mapping.accountId : ''}
                                                    onChange={e => setYnabAccountMapping(
                                                        broker.id,
                                                        e.target.value ? { budgetId, accountId: e.target.value } : null,
                                                    )}
                                                    disabled={accountsLoading || accounts.length === 0}
                                                    style={{ flex: 2, minWidth: '240px' }}
                                                >
                                                    <option value="">
                                                        {accountsLoading
                                                            ? 'Loading accounts…'
                                                            : accounts.length === 0 ? 'No accounts available' : '— No account —'}
                                                    </option>
                                                    {accounts.map(account => {
                                                        const heldBy = brokerIdByAccountKey.get(`${budgetId}:${account.id}`);
                                                        const otherBroker = heldBy && heldBy !== broker.id
                                                            ? brokers.find(b => b.id === heldBy)
                                                            : undefined;
                                                        return (
                                                            <option key={account.id} value={account.id}>
                                                                {account.name} — €{milliunitsToEur(account.balanceMilliunits).toLocaleString('en-IE', { minimumFractionDigits: 2 })}
                                                                {otherBroker ? ` (on ${otherBroker.name})` : ''}
                                                            </option>
                                                        );
                                                    })}
                                                </select>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    )}
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
                    Load Mock Data (full feature coverage)
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
                    <div className="danger-zone-confirm" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)' }}>
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
