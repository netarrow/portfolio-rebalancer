import React, { createContext, useContext, useMemo, useEffect, useState, useRef } from 'react';
import { calculateAssets } from '../utils/portfolioCalculations';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { Transaction, Asset, AssetClass, PortfolioSummary, AssetSubClass, Portfolio, AssetDefinition, Broker, MacroAllocation, GoalAllocation, AssetAllocationSettings, PortfolioTargetConfig, LiquidityTargetConfig, RatioGroupConfig, Goal } from '../types';
import io, { Socket } from 'socket.io-client';
import PriceUpdateModal, { type PriceUpdateItem } from '../components/modals/PriceUpdateModal';
import { normalizeAssetAllocationSettings } from '../utils/assetAllocation';
import Swal from 'sweetalert2';
import { encrypt, decrypt, uploadToAzure, downloadFromAzure } from '../services/azureSync';
import type { AzureConfig, SyncPayload } from '../services/azureSync';

// Legacy Type for Migration
type Target = AssetDefinition & { targetPercentage?: number };

interface PortfolioContextType {
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    assets: Asset[];
    portfolios: Portfolio[];
    brokers: Broker[];
    goals: Goal[];
    assetAllocationSettings: AssetAllocationSettings;
    summary: PortfolioSummary;
    macroAllocations: MacroAllocation;
    goalAllocations: GoalAllocation;
    addTransaction: (transaction: Transaction) => void;
    updateTransaction: (transaction: Transaction) => void;
    deleteTransaction: (id: string) => void;
    updateAssetSettings: (ticker: string, source?: 'ETF' | 'MOT' | 'CPRAM' | 'COMETA', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => void;
    updatePortfolioAllocation: (portfolioId: string, ticker: string, percentage: number) => void;
    updateMacroAllocation: (allocations: MacroAllocation) => void;
    updateGoalAllocation: (allocations: GoalAllocation) => void;
    updateTransactionsBulk: (ids: string[], updates: Partial<Transaction>) => void;
    refreshPrices: () => Promise<void>;
    resetPortfolio: () => void;
    loadMockData: () => void;
    marketData: Record<string, { price: number, lastUpdated: string }>;
    addPortfolio: (portfolio: Portfolio) => void;
    updatePortfolio: (portfolio: Portfolio) => void;
    deletePortfolio: (id: string) => void;
    addBroker: (broker: Broker) => void;
    updateBroker: (broker: Broker) => void;
    deleteBroker: (id: string) => void;
    addGoal: (goal: Goal) => void;
    updateGoal: (goal: Goal) => void;
    deleteGoal: (id: string) => void;
    updatePortfolioTarget: (portfolioId: string, target: PortfolioTargetConfig | null) => void;
    updateLiquidityTarget: (target: LiquidityTargetConfig | undefined) => void;
    upsertRatioGroup: (group: RatioGroupConfig) => void;
    deleteRatioGroup: (id: string) => void;
    resetAssetAllocationSettings: () => void;
    // Deprecated accessors for compatibility during transition
    targets: AssetDefinition[];
    importData: (data: any) => Promise<boolean>;
    updateMarketData: (ticker: string, price: number, lastUpdated: string) => void;
    addTransactionsBulk: (newTransactions: Transaction[]) => void;
    // Azure sync
    azureConfig: AzureConfig;
    setAzureConfig: (config: AzureConfig | ((prev: AzureConfig) => AzureConfig)) => void;
    syncToAzure: () => Promise<{ ok: boolean; error?: string }>;
    restoreFromAzure: () => Promise<{ ok: boolean; error?: string }>;
    azureSyncing: boolean;
}

const PortfolioContext = createContext<PortfolioContextType | undefined>(undefined);

export const usePortfolio = () => {
    const context = useContext(PortfolioContext);
    if (!context) {
        throw new Error('usePortfolio must be used within a PortfolioProvider');
    }
    return context;
};

// Default targets


export const PortfolioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [transactions, setTransactions] = useLocalStorage<Transaction[]>('portfolio_transactions', []);
    const [assetSettings, setAssetSettings] = useLocalStorage<AssetDefinition[]>('portfolio_assets_v1', []);
    // Legacy state for migration only
    const [oldTargets, setOldTargets] = useLocalStorage<Target[]>('portfolio_targets_v2', []);
    const [portfolios, setPortfolios] = useLocalStorage<Portfolio[]>('portfolio_list', []);
    const [brokers, setBrokers] = useLocalStorage<Broker[]>('portfolio_brokers', []);
    const [goals, setGoals] = useLocalStorage<Goal[]>('portfolio_goals', []);
    const [marketData, setMarketData] = useLocalStorage<Record<string, { price: number, lastUpdated: string }>>('portfolio_market_data', {});
    const [storedAssetAllocationSettings, setStoredAssetAllocationSettings] = useLocalStorage<AssetAllocationSettings>(
        'portfolio_asset_allocation_v1',
        { portfolioTargets: {}, ratioGroups: [] }
    );

    // New State for Macro/Goal Targets
    const [macroAllocations, setMacroAllocations] = useLocalStorage<MacroAllocation>('portfolio_macro_targets', {});
    const [goalAllocations, setGoalAllocations] = useLocalStorage<GoalAllocation>('portfolio_goal_targets', {});

    // Azure sync config — excluded from backup, restore and sync payload by design
    const [azureConfig, setAzureConfig] = useLocalStorage<AzureConfig>('portfolio_azure_config', {
        sasUrl: '', passphrase: '', enabled: false, lastSync: null
    });
    const [azureSyncing, setAzureSyncing] = useState(false);
    // Ref so sync effect can read latest config without adding azureConfig to deps (avoids loop on lastSync)
    const azureConfigRef = useRef(azureConfig);
    // Timestamp of last restore to suppress the debounced post-restore upload
    const lastRestoreRef = useRef<number>(0);
    const syncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const assetAllocationSettings = useMemo(
        () => normalizeAssetAllocationSettings(storedAssetAllocationSettings),
        [storedAssetAllocationSettings]
    );

    useEffect(() => { azureConfigRef.current = azureConfig; }, [azureConfig]);

    // One-shot cleanup of legacy Global Rebalancing storage key
    useEffect(() => {
        try {
            localStorage.removeItem('portfolio_global_rebalancing_v1');
        } catch {
            // ignore
        }
    }, []);

    // Migrate portfolios to add order field if missing
    useEffect(() => {
        if (portfolios.length > 0) {
            const needsMigration = portfolios.some(p => p.order === undefined);
            if (needsMigration) {
                const migratedPortfolios = portfolios.map((p, index) => ({
                    ...p,
                    order: p.order ?? index
                }));
                setPortfolios(migratedPortfolios);
            }
        }
    }, []);

    // Socket & Modal State
    const [socket, setSocket] = useState<Socket | null>(null);
    const [isPriceModalOpen, setIsPriceModalOpen] = useState(false);
    const [priceUpdateItems, setPriceUpdateItems] = useState<PriceUpdateItem[]>([]);
    const [isUpdateComplete, setIsUpdateComplete] = useState(false);

    // Initialize Socket
    useEffect(() => {
        const socketUrl = window.location.origin

        // Use the same host/port if served, or localhost:3001 for dev
        // Actually, if we are in dev (vite) we are on 5173 calling 3001. 
        // If prod, we are on 3001 calling 3001.

        const newSocket = io(socketUrl);
        setSocket(newSocket);

        return () => {
            newSocket.close();
        };
    }, []);

    // Socket Event Listeners
    useEffect(() => {
        if (!socket) return;

        socket.on('price_update_progress', ({ isin, status }) => {
            setPriceUpdateItems(prev => prev.map(item =>
                item.isin === isin ? { ...item, status } : item
            ));
        });

        socket.on('price_update_item', ({ isin, success, data, error }) => {
            setPriceUpdateItems(prev => prev.map(item => {
                if (item.isin === isin) {
                    return {
                        ...item,
                        status: success ? 'success' : 'error',
                        price: data?.currentPrice,
                        currency: data?.currency,
                        error: error
                    };
                }
                return item;
            }));

            if (success && data && data.currentPrice) {
                updateMarketData(isin, data.currentPrice, data.lastUpdated);
            }
        });

        socket.on('price_update_complete', () => {
            setIsUpdateComplete(true);
        });

        socket.on('price_update_error', ({ message }) => {
            console.error('Socket Global Error:', message);
            setPriceUpdateItems(prev => prev.map(item =>
                (item.status === 'pending' || item.status === 'processing')
                    ? { ...item, status: 'error', error: message }
                    : item
            ));
            setIsUpdateComplete(true);
        });

        // Handle Disconnection / Network Error
        const handleNetworkError = (reason: string) => {
            console.warn('Socket disconnected/error:', reason);
            setPriceUpdateItems(prev => prev.map(item =>
                (item.status === 'pending' || item.status === 'processing')
                    ? { ...item, status: 'error', error: `Network Error: ${reason}` }
                    : item
            ));
            setIsUpdateComplete(true);
        };

        socket.on('disconnect', (reason) => handleNetworkError(reason.toString()));
        socket.on('connect_error', (err) => handleNetworkError(err.message));

        return () => {
            socket.off('price_update_progress');
            socket.off('price_update_item');
            socket.off('price_update_complete');
            socket.off('price_update_error');
            socket.off('disconnect');
            socket.off('connect_error');
        };
    }, [socket]);

    // Migration Effect 3: Migrate free-text portfolios to Portfolio entities
    useEffect(() => {
        let portfoliosChanged = false;
        let transactionsChanged = false;
        const newPortfolios = [...portfolios];
        const newTransactions = [...transactions];

        const uniquePortfolioNames = Array.from(new Set(transactions.map(t => (t as any).portfolio).filter(Boolean))) as string[];

        uniquePortfolioNames.forEach(name => {
            // Check if portfolio already exists by name
            let portfolio = newPortfolios.find(p => p.name === name);

            if (!portfolio) {
                // Create new portfolio
                portfolio = {
                    id: String(Date.now() + Math.random()),
                    name: name,
                    description: 'Migrated from transaction',
                    order: newPortfolios.length
                };
                newPortfolios.push(portfolio);
                portfoliosChanged = true;
                console.log(`Created migrated portfolio: ${name}`);
            }
        });

        // Link transactions to portfolio IDs
        newTransactions.forEach((t, index) => {
            if ((t as any).portfolio && !t.portfolioId) {
                const portfolio = newPortfolios.find(p => p.name === (t as any).portfolio);
                if (portfolio) {
                    newTransactions[index] = {
                        ...t,
                        portfolioId: portfolio.id,
                        // Clear legacy field to prevent resurrection during migration checks
                        portfolio: undefined
                    } as any;
                    transactionsChanged = true;
                }
            }
        });

        if (portfoliosChanged) {
            setPortfolios(newPortfolios);
        }
        if (transactionsChanged) {
            setTransactions(newTransactions);
        }
    }, [transactions, portfolios, setPortfolios, setTransactions]);

    // Migration Effect 4: Migrate free-text brokers to Broker entities
    useEffect(() => {
        let brokersChanged = false;
        let transactionsChanged = false;
        const newBrokers = [...brokers];
        const newTransactions = [...transactions];

        // 1. Find all unique broker names from transactions that don't have brokerId yet
        const uniqueBrokerNames = Array.from(new Set(
            transactions
                .filter(t => (t as any).broker && !t.brokerId)
                .map(t => (t as any).broker)
        )) as string[];

        uniqueBrokerNames.forEach(name => {
            // Check if broker already exists by name
            let broker = newBrokers.find(b => b.name === name);

            if (!broker) {
                // Create new broker
                broker = {
                    id: String(Date.now() + Math.random()), // Simple ID generation
                    name: name,
                    description: 'Migrated from transaction',
                    currentLiquidity: undefined,
                    minLiquidityPercentage: undefined
                };
                newBrokers.push(broker);
                brokersChanged = true;
                console.log(`Created migrated broker: ${name}`);
            }
        });

        // 2. Link transactions to broker IDs
        newTransactions.forEach((t, index) => {
            if ((t as any).broker && !t.brokerId) {
                const broker = newBrokers.find(b => b.name === (t as any).broker);
                if (broker) {
                    newTransactions[index] = {
                        ...t,
                        brokerId: broker.id,
                        // Clear legacy field
                        broker: undefined
                    } as any;
                    transactionsChanged = true;
                }
            }
        });

        if (brokersChanged) {
            setBrokers(newBrokers);
        }
        if (transactionsChanged) {
            setTransactions(newTransactions);
        }
    }, [transactions, brokers, setBrokers, setTransactions]);

    // Migration Effect: Transform old Targets (global %) to AssetSettings + Portfolio Allocations
    useEffect(() => {
        if (oldTargets.length > 0 && assetSettings.length === 0) {
            console.log('Migrating Global Targets to AssetSettings and Portfolio Allocations...');

            // 1. Convert Targets to AssetSettings (strip %)
            const newSettings: AssetDefinition[] = oldTargets.map(t => ({
                ticker: t.ticker,
                label: t.label,
                assetClass: t.assetClass,
                assetSubClass: t.assetSubClass,
                source: t.source
            }));
            setAssetSettings(newSettings);

            // 2. Move % to Portfolios
            const newPortfolios = [...portfolios];
            let portfoliosChanged = false;

            // If no portfolios exist, create Main
            if (newPortfolios.length === 0) {
                newPortfolios.push({
                    id: 'main',
                    name: 'Main Portfolio',
                    description: 'Default portfolio',
                    allocations: {},
                    order: 0
                });
                portfoliosChanged = true;
            }

            // Apply global % to ALL portfolios (as a safe default start)
            newPortfolios.forEach((p, idx) => {
                const allocations = { ...p.allocations };
                let pChanged = false;
                oldTargets.forEach(t => {
                    if (t.targetPercentage !== undefined && t.targetPercentage > 0) {
                        if (allocations[t.ticker] === undefined) {
                            allocations[t.ticker] = t.targetPercentage;
                            pChanged = true;
                        }
                    }
                });

                if (pChanged || !p.allocations) {
                    newPortfolios[idx] = { ...p, allocations };
                    portfoliosChanged = true;
                }
            });

            if (portfoliosChanged) {
                setPortfolios(newPortfolios);
            }

            setOldTargets([]);
        }
    }, [oldTargets, assetSettings, portfolios, setAssetSettings, setPortfolios, setOldTargets]);

    // Migration Effect 2: Move assetClass/assetSubClass from Transactions to AssetSettings
    useEffect(() => {
        let settingsChanged = false;
        const newSettings = [...assetSettings];

        const uniqueTickers = Array.from(new Set(transactions.map(t => t.ticker)));

        uniqueTickers.forEach(ticker => {
            const settingIndex = newSettings.findIndex(t => t.ticker === ticker);
            // Look for existing class in transactions (take last one as source of truth)
            const lastTx = [...transactions].reverse().find(t => t.ticker === ticker && (t as any).assetClass);

            if (lastTx && (lastTx as any).assetClass) {
                if (settingIndex === -1) {
                    newSettings.push({
                        ticker,
                        source: 'ETF',
                        assetClass: (lastTx as any).assetClass as AssetClass,
                        assetSubClass: (lastTx as any).assetSubClass as AssetSubClass
                    });
                    settingsChanged = true;
                } else {
                    if (!newSettings[settingIndex].assetClass) {
                        newSettings[settingIndex] = {
                            ...newSettings[settingIndex],
                            assetClass: (lastTx as any).assetClass as AssetClass,
                            assetSubClass: (lastTx as any).assetSubClass as AssetSubClass
                        };
                        settingsChanged = true;
                    }
                }
            }
        });

        if (settingsChanged) {
            setAssetSettings(newSettings);
        }
    }, [transactions, assetSettings, setAssetSettings]);

    // Debounced Azure sync: fires 3s after any portfolio data change
    // azureConfig intentionally excluded from deps to avoid loop when lastSync updates
    useEffect(() => {
        const config = azureConfigRef.current;
        if (!config.enabled || !config.sasUrl || !config.passphrase) return;

        if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);

        syncDebounceRef.current = setTimeout(async () => {
            if (Date.now() - lastRestoreRef.current < 5000) return;

            const payload: SyncPayload = {
                syncVersion: 1,
                syncTimestamp: new Date().toISOString(),
                transactions, assetSettings, portfolios, brokers, marketData,
                assetAllocationSettings: storedAssetAllocationSettings,
                macroAllocations, goalAllocations, goals,
            };
            try {
                setAzureSyncing(true);
                const encrypted = await encrypt(JSON.stringify(payload), config.passphrase);
                await uploadToAzure(config.sasUrl, encrypted);
                setAzureConfig(prev => ({ ...prev, lastSync: new Date().toISOString() }));
            } catch (e) {
                console.error('Azure sync failed:', e);
            } finally {
                setAzureSyncing(false);
            }
        }, 3000);

        return () => { if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current); };
    }, [transactions, assetSettings, portfolios, brokers, marketData,
        storedAssetAllocationSettings, macroAllocations, goalAllocations, goals]);

    // On mount: check if Azure has newer data and offer restore
    useEffect(() => {
        const config = azureConfigRef.current;
        if (!config.enabled || !config.sasUrl || !config.passphrase) return;

        (async () => {
            try {
                const buffer = await downloadFromAzure(config.sasUrl);
                if (!buffer) return;

                const decrypted = await decrypt(buffer, config.passphrase);
                const payload: SyncPayload = JSON.parse(decrypted);

                const remoteTime = new Date(payload.syncTimestamp).getTime();
                const localTime = config.lastSync ? new Date(config.lastSync).getTime() : 0;

                if (remoteTime > localTime) {
                    const result = await Swal.fire({
                        title: 'Dati remoti più recenti',
                        text: `Azure contiene dati aggiornati al ${new Date(payload.syncTimestamp).toLocaleString('it-IT')}. Ripristinare?`,
                        icon: 'question',
                        showCancelButton: true,
                        confirmButtonText: 'Ripristina da Azure',
                        cancelButtonText: 'Mantieni locali',
                    });
                    if (result.isConfirmed) {
                        lastRestoreRef.current = Date.now();
                        await importData(payload);
                        setAzureConfig(prev => ({ ...prev, lastSync: payload.syncTimestamp }));
                    }
                }
            } catch (e) {
                console.error('Azure startup sync failed:', e);
            }
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const updateMarketData = (ticker: string, price: number, lastUpdated: string) => {
        setMarketData(prev => ({
            ...prev,
            [ticker.toUpperCase()]: { price, lastUpdated }
        }));
    };

    const addPortfolio = (portfolio: Portfolio) => {
        setPortfolios(prev => {
            const newPortfolio = {
                ...portfolio,
                order: portfolio.order !== undefined ? portfolio.order : prev.length
            };
            return [...prev, newPortfolio];
        });
    };

    const updatePortfolio = (portfolio: Portfolio) => {
        setPortfolios(prev => prev.map(p => p.id === portfolio.id ? portfolio : p));
    };

    const deletePortfolio = (id: string) => {
        const portfolioToDelete = portfolios.find(p => p.id === id);
        const nameToDelete = portfolioToDelete?.name;

        setPortfolios(prev => prev.filter(p => p.id !== id));
        setStoredAssetAllocationSettings(prev => {
            const normalized = normalizeAssetAllocationSettings(prev);
            const { [id]: _removed, ...rest } = normalized.portfolioTargets;
            return { ...normalized, portfolioTargets: rest };
        });
        // Also clear the legacy 'portfolio' field to prevent the migration effect from re-creating it
        setTransactions(prev => prev.map(t =>
            (t.portfolioId === id || (nameToDelete && (t as any).portfolio === nameToDelete))
                ? { ...t, portfolioId: undefined, portfolio: undefined } as any
                : t
        ));
        // Clean up liquidity allocations referencing this portfolio from all brokers
        setBrokers(prev => prev.map(b => {
            if (!b.liquidityAllocations || !b.liquidityAllocations[id]) return b;
            const { [id]: _, ...rest } = b.liquidityAllocations;
            return { ...b, liquidityAllocations: Object.keys(rest).length > 0 ? rest : undefined };
        }));
    };

    const addBroker = (broker: Broker) => {
        setBrokers(prev => [...prev, broker]);
    };

    const updateBroker = (broker: Broker) => {
        setBrokers(prev => prev.map(b => b.id === broker.id ? broker : b));
    };

    const deleteBroker = (id: string) => {
        setBrokers(prev => prev.filter(b => b.id !== id));
        // Clean up _CASH_ ticker entries from portfolio allocations referencing this broker
        const cashTicker = `_CASH_${id}`;
        setPortfolios(prev => prev.map(p => {
            if (!p.allocations || !(cashTicker in p.allocations)) return p;
            const { [cashTicker]: _, ...rest } = p.allocations;
            return { ...p, allocations: rest };
        }));
    };

    const addGoal = (goal: Goal) => {
        setGoals(prev => [...prev, goal]);
    };

    const updateGoal = (goal: Goal) => {
        setGoals(prev => prev.map(g => g.id === goal.id ? goal : g));
    };

    const deleteGoal = (id: string) => {
        setGoals(prev => prev.filter(g => g.id !== id));
        // Clear goalId from portfolios referencing this goal
        setPortfolios(prev => prev.map(p =>
            p.goalId === id ? { ...p, goalId: undefined } : p
        ));
    };

    const updatePortfolioTarget = (portfolioId: string, target: PortfolioTargetConfig | null) => {
        setStoredAssetAllocationSettings(prev => {
            const normalized = normalizeAssetAllocationSettings(prev);
            const nextTargets = { ...normalized.portfolioTargets };
            if (target === null) {
                delete nextTargets[portfolioId];
            } else {
                nextTargets[portfolioId] = target;
            }
            return { ...normalized, portfolioTargets: nextTargets };
        });
    };

    const updateLiquidityTarget = (target: LiquidityTargetConfig | undefined) => {
        setStoredAssetAllocationSettings(prev => {
            const normalized = normalizeAssetAllocationSettings(prev);
            if (!target) {
                const { liquidityTarget: _removed, ...rest } = normalized;
                return { ...rest };
            }
            return { ...normalized, liquidityTarget: target };
        });
    };

    const upsertRatioGroup = (group: RatioGroupConfig) => {
        setStoredAssetAllocationSettings(prev => {
            const normalized = normalizeAssetAllocationSettings(prev);
            let nextGroups = normalized.ratioGroups.slice();
            const idx = nextGroups.findIndex(g => g.id === group.id);

            // Enforce: only one remainder group allowed at a time
            let sanitizedGroup = group;
            if (group.groupTargetMode === 'remainder') {
                nextGroups = nextGroups.map(g =>
                    g.id !== group.id && g.groupTargetMode === 'remainder'
                        ? { ...g, groupTargetMode: 'percent' as const, groupTargetValue: 0 }
                        : g
                );
            }

            if (idx >= 0) {
                nextGroups[idx] = sanitizedGroup;
            } else {
                nextGroups.push(sanitizedGroup);
            }
            return { ...normalized, ratioGroups: nextGroups };
        });
    };

    const deleteRatioGroup = (id: string) => {
        setStoredAssetAllocationSettings(prev => {
            const normalized = normalizeAssetAllocationSettings(prev);
            const nextGroups = normalized.ratioGroups.filter(g => g.id !== id);
            // Reset portfolios that referenced this group to 'excluded'
            const nextTargets: Record<string, PortfolioTargetConfig> = {};
            for (const [pid, cfg] of Object.entries(normalized.portfolioTargets)) {
                if (cfg.mode === 'ratio' && cfg.ratioGroupId === id) {
                    nextTargets[pid] = { mode: 'excluded', value: 0 };
                } else {
                    nextTargets[pid] = cfg;
                }
            }
            return { ...normalized, ratioGroups: nextGroups, portfolioTargets: nextTargets };
        });
    };

    const resetAssetAllocationSettings = () => {
        setStoredAssetAllocationSettings({ portfolioTargets: {}, ratioGroups: [] });
    };

    const addTransaction = (transaction: Transaction) => {
        setTransactions((prev) => [...prev, transaction]);
    };

    const deleteTransaction = (id: string) => {
        setTransactions((prev) => prev.filter((t) => t.id !== id));
    };

    const addTransactionsBulk = (newTransactions: Transaction[]) => {
        setTransactions((prev) => [...prev, ...newTransactions]);
    };

    const updateAssetSettings = (ticker: string, source?: 'ETF' | 'MOT' | 'CPRAM' | 'COMETA', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => {
        setAssetSettings((prev) => {
            const exists = prev.find(t => t.ticker === ticker);

            if (exists) {
                return prev.map(t => t.ticker === ticker ? {
                    ...t,
                    source: source || t.source,
                    label: label !== undefined ? label : t.label,
                    assetClass: assetClass || t.assetClass,
                    assetSubClass: assetSubClass || t.assetSubClass
                } : t);
            }
            return [...prev, { ticker, source: source || 'ETF', label, assetClass, assetSubClass }];
        });
    };

    const updatePortfolioAllocation = (portfolioId: string, ticker: string, percentage: number) => {
        setPortfolios(prev => prev.map(p => {
            if (p.id === portfolioId) {
                const newAllocations = { ...(p.allocations || {}) };
                if (percentage > 0) {
                    newAllocations[ticker] = percentage;
                } else {
                    delete newAllocations[ticker];
                }
                return { ...p, allocations: newAllocations };
            }
            return p;
        }));
    };

    const updateMacroAllocation = (allocations: MacroAllocation) => {
        setMacroAllocations(allocations);
    };

    const updateGoalAllocation = (allocations: GoalAllocation) => {
        setGoalAllocations(allocations);
    };

    // Deprecated adapter
    const updateTarget = (ticker: string, percentage: number, source?: 'ETF' | 'MOT', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => {
        updateAssetSettings(ticker, source, label, assetClass, assetSubClass);
        if (percentage > 0) {
            console.warn('updateTarget called with percentage - ambiguous portfolio! Ignoring percentage.', percentage);
        }
    };

    const resetPortfolio = () => {
        setTransactions([]);
        setAssetSettings([]);
        setAssetSettings([]);
        setPortfolios([]);
        setBrokers([]);
        setMarketData({});
        setStoredAssetAllocationSettings({ portfolioTargets: {}, ratioGroups: [] });
        setOldTargets([]);
        setMacroAllocations({});
        setGoalAllocations({});
        setGoals([]);
    };

    const refreshPrices = async () => {
        // Calculate active assets dynamically to ensure we get current quantities
        const { assets } = calculateAssets(transactions, assetSettings, marketData);

        // Filter: Only include assets with quantity >= 1
        // User Requirement: "quantità residua di almeno 1 o superiore"
        const activeAssets = assets.filter(a => a.quantity > 0);

        if (activeAssets.length === 0) {
            // Optional: Notify user that no assets met criteria?
            // For now, just return to avoid socket error on empty list.
            console.log('No assets with quantity >= 1 found for update.');
            return;
        }

        // Prepare tokens from active assets
        const tokens = activeAssets.map(asset => {
            const setting = assetSettings.find(t => t.ticker === asset.ticker);
            return {
                isin: asset.ticker,
                source: setting?.source || 'ETF'
            };
        });

        // Initialize Modal State
        const initialItems: PriceUpdateItem[] = tokens.map(t => ({
            isin: t.isin,
            status: 'pending'
        }));

        setPriceUpdateItems(initialItems);
        setIsUpdateComplete(false);
        setIsPriceModalOpen(true);

        // Emit socket event
        if (socket) {
            socket.emit('request_price_update', tokens);
        } else {
            console.error('Socket not connected');
            setPriceUpdateItems(prev => prev.map(t => ({ ...t, status: 'error', error: 'Socket disconnected' })));
            setIsUpdateComplete(true);
        }
    };

    // Derive Assets and Summary
    const { assets, summary } = useMemo(() => {
        return calculateAssets(transactions, assetSettings, marketData);
    }, [transactions, assetSettings, marketData]);

    const updateTransaction = (updatedTransaction: Transaction) => {
        setTransactions((prev) => prev.map((t) => (t.id === updatedTransaction.id ? updatedTransaction : t)));
    };

    const updateTransactionsBulk = (ids: string[], updates: Partial<Transaction>) => {
        setTransactions((prev) => prev.map((t) => {
            if (ids.includes(t.id)) {
                return { ...t, ...updates };
            }
            return t;
        }));
    };

    const loadMockData = () => {
        const timestamp = new Date().toISOString();
        const pIdMain = 'mock-p-main';
        const pIdSafe = 'mock-p-safe';
        const pIdSpec = 'mock-p-spec';

        // 1. Define Assets with their "canonical" settings
        // We use a mix of ETFs for Stocks/Bonds, and Crypto
        const mockAssets = [
            // Growth (Stocks)
            { ticker: 'IE00B4L5Y983', name: 'iShares Core MSCI World', class: 'Stock', subClass: 'International', source: 'ETF', goal: 'Growth' }, // SWDA
            { ticker: 'IE00BKM4GZ66', name: 'iShares Core MSCI EM IMI', class: 'Stock', subClass: 'International', source: 'ETF', goal: 'Growth' }, // EMIM
            { ticker: 'IE00B3RBWM25', name: 'Vanguard FTSE All-World', class: 'Stock', subClass: 'International', source: 'ETF', goal: 'Growth' }, // VWRL (Unmanaged)

            // Security (Bonds)
            { ticker: 'IE00BDBRDM35', name: 'iShares Glb Agg Bond EUR-H', class: 'Bond', subClass: 'Medium', source: 'ETF', goal: 'Security' }, // AGGH

            // Protection (Gov Bonds / Gold)
            { ticker: 'IE00B1FZS798', name: 'iShares Euro Govt Bond 15-30yr', class: 'Bond', subClass: 'Long', source: 'ETF', goal: 'Protection' }, // IGLT (Proxy)

            // Liquidity (Cash Equiv) -> Now Bond Short per user request
            { ticker: 'LU0290358497', name: 'Xtrackers II EUR Overnight Rate', class: 'Bond', subClass: 'Short', source: 'ETF', goal: 'Protection' }, // XEON

            // Speculative (Crypto)
            { ticker: 'BTC-USD', name: 'Bitcoin', class: 'Crypto', subClass: 'International', source: 'CPRAM', goal: 'Growth' }
        ];

        // 2. Generate Transactions (History)
        const ONE_DAY = 24 * 60 * 60 * 1000;
        const today = Date.now();
        const txs: any[] = [];
        let idCounter = 1;

        const addTx = (pid: string, ticker: string, dateOffsetDays: number, amount: number, price: number, direction: 'Buy' | 'Sell', broker: string) => {
            txs.push({
                id: `mock-tx-${idCounter++}`,
                portfolioId: pid,
                ticker,
                date: new Date(today - (dateOffsetDays * ONE_DAY)).toISOString().split('T')[0],
                amount,
                price,
                direction,
                broker
            });
        };

        // --- SCENARIO 1: Main Portfolio (Steady Growth) ---
        // SWDA: Regular Accumulation
        addTx(pIdMain, 'IE00B4L5Y983', 365, 300, 78.50, 'Buy', 'Degiro'); // Increased from 100
        addTx(pIdMain, 'IE00B4L5Y983', 180, 50, 84.20, 'Buy', 'Degiro');
        addTx(pIdMain, 'IE00B4L5Y983', 30, 20, 92.10, 'Buy', 'Degiro');

        // EMIM: Weighted Average Test (Buy -> Sell Half -> Buy)
        // Buy 100 @ 25
        addTx(pIdMain, 'IE00BKM4GZ66', 200, 100, 25.00, 'Buy', 'Degiro');
        // Sell 50 @ 28 (Profit)
        addTx(pIdMain, 'IE00BKM4GZ66', 100, 50, 28.00, 'Sell', 'Degiro');
        // Buy 50 @ 30
        // Result: Holdings = 100. Previous Avg Cost was 25. New Buy is 30.
        // Remaining 50 from first batch still has cost 25? Or average?
        // App Logic: Average Cost matches weighted average.
        addTx(pIdMain, 'IE00BKM4GZ66', 10, 50, 30.00, 'Buy', 'Degiro');

        // AGGH: Lump sum
        addTx(pIdMain, 'IE00BDBRDM35', 90, 500, 4.80, 'Buy', 'Trade Republic');

        // VWRL: NO TRANSACTIONS -> UNMANAGED ASSET

        // --- SCENARIO 2: Safety Net (Liquidity & Protection) ---
        // XEON: Big Parked Cash
        addTx(pIdSafe, 'LU0290358497', 60, 450, 139.50, 'Buy', 'Directa'); // Increased from 250 (~63k)

        // Govt Bond: Protection
        addTx(pIdSafe, 'IE00B1FZS798', 120, 50, 180.00, 'Buy', 'Directa');

        // --- SCENARIO 3: Speculative (Crypto - Cost Reset Test) ---
        // Bitcoin: Buy -> Sell All -> Buy lower/higher
        // Buy 1 @ 50k
        addTx(pIdSpec, 'BTC-USD', 500, 0.5, 50000, 'Buy', 'Binance');
        // Sell All @ 60k
        addTx(pIdSpec, 'BTC-USD', 400, 0.5, 60000, 'Sell', 'Binance');
        // Buy 0.2 @ 65k
        // Result: Cost Basis should be 65k, NOT averaged with the 50k because it was fully closed.
        addTx(pIdSpec, 'BTC-USD', 20, 0.2, 65000, 'Buy', 'Binance');


        // 3. Create Settings
        const newSettings: AssetDefinition[] = mockAssets.map(m => ({
            ticker: m.ticker,
            source: m.source as any,
            label: m.name,
            assetClass: m.class as AssetClass,
            assetSubClass: m.subClass as AssetSubClass
        }));

        // 4. Goals
        const mockGoals: Goal[] = [
            { id: 'goal-growth', title: 'Growth', description: 'Long-term capital appreciation', order: 1 },
            { id: 'goal-protection', title: 'Protection', description: 'Capital preservation and emergency fund', order: 2 },
            { id: 'goal-security', title: 'Security', description: 'Stable income and low volatility', order: 3 }
        ];

        // 5. Portfolios & Allocations
        const portfoliosList: Portfolio[] = [
            {
                id: pIdMain,
                name: 'Main Strategy',
                description: 'Core ETF Portfolio (World + EM + Agg)',
                goalId: 'goal-growth',
                order: 0,
                allocations: {
                    'IE00B4L5Y983': 50, // SWDA
                    'IE00BKM4GZ66': 15, // EMIM
                    'IE00BDBRDM35': 25, // AGGH
                    'IE00B3RBWM25': 10  // VWRL (Unmanaged)
                }
            },
            {
                id: pIdSafe,
                name: 'Safety Net',
                description: 'Emergency fund and hedging',
                goalId: 'goal-protection',
                order: 1,
                allocations: {
                    'LU0290358497': 70, // XEON
                    'IE00B1FZS798': 30  // Govt Bond
                }
            },
            {
                id: pIdSpec,
                name: 'Speculative',
                description: 'High risk bets',
                goalId: 'goal-security',
                order: 2,
                allocations: {
                    'BTC-USD': 100
                }
            }
        ];

        // 5. Market Data (Soft Mocks for immediate display)
        const mockPrices = {
            'IE00B4L5Y983': { price: 95.50, lastUpdated: timestamp }, // Profit
            'IE00BKM4GZ66': { price: 31.20, lastUpdated: timestamp }, // Profit
            'IE00B3RBWM25': { price: 115.00, lastUpdated: timestamp }, // No tx, just price
            'IE00BDBRDM35': { price: 5.10, lastUpdated: timestamp },  // Profit
            'IE00B1FZS798': { price: 175.50, lastUpdated: timestamp }, // Loss
            'LU0290358497': { price: 142.10, lastUpdated: timestamp }, // Profit
            'BTC-USD': { price: 68000, lastUpdated: timestamp }     // Profit
        };

        // 6. Macro & Goal Allocations (Global Targets)
        const newMacros: MacroAllocation = {
            'Stock': 40,
            'Bond': 53,
            'Cash': 2,
            'Crypto': 5,
            'Commodity': 0
        };

        const newGoals: GoalAllocation = {
            'Growth': 45,     // Stocks + Crypto
            'Security': 5,   // Agg Bonds
            'Protection': 48,  // Govt Bonds + XEON
            'Liquidity': 2   // Cash
        };

        // 7. Apply All
        setTransactions(txs);
        setAssetSettings(newSettings);
        setPortfolios(portfoliosList);
        setGoals(mockGoals);
        setMarketData(mockPrices);
        setMacroAllocations(newMacros);
        setGoalAllocations(newGoals);
        setStoredAssetAllocationSettings({
            liquidityTarget: { mode: 'fixed', value: 5000 },
            portfolioTargets: {
                [pIdMain]: { mode: 'percent', value: 60 },
                [pIdSafe]: { mode: 'fixed', value: 10000 },
                [pIdSpec]: { mode: 'ratio', value: 100, ratioGroupId: 'rg-remainder' }
            },
            ratioGroups: [
                { id: 'rg-remainder', name: 'Growth Remainder', groupTargetMode: 'remainder', groupTargetValue: 0 }
            ]
        });
        setBrokers([
            { id: 'b1', name: 'Degiro', description: 'Main Broker' },
            { id: 'b2', name: 'Directa', description: 'Italian Broker' },
            { id: 'b3', name: 'Trade Republic', description: 'Savings Plans' },
            { id: 'b4', name: 'Binance', description: 'Crypto Exchange' }
        ]);

        // Clear old legacy
        setOldTargets([]);
    };

    const importData = async (data: any): Promise<boolean> => {
        try {
            // Basic Validation
            if (!Array.isArray(data.transactions) || !Array.isArray(data.assetSettings)) {
                throw new Error('Invalid data format');
            }

            const transactions = data.transactions || [];
            const assetSettings = data.assetSettings || [];
            const portfolios = data.portfolios || [];
            const brokers = data.brokers || [];
            const marketData = data.marketData || {};
            const assetAllocationSettings = normalizeAssetAllocationSettings(data.assetAllocationSettings);
            const macroAllocations = data.macroAllocations || {};
            const goalAllocations = data.goalAllocations || {};
            const goals = data.goals || [];

            // Write directly to localStorage first to guarantee persistence
            // regardless of React effect scheduling or migration effects ordering
            localStorage.setItem('portfolio_transactions', JSON.stringify(transactions));
            localStorage.setItem('portfolio_assets_v1', JSON.stringify(assetSettings));
            localStorage.setItem('portfolio_list', JSON.stringify(portfolios));
            localStorage.setItem('portfolio_brokers', JSON.stringify(brokers));
            localStorage.setItem('portfolio_market_data', JSON.stringify(marketData));
            localStorage.setItem('portfolio_asset_allocation_v1', JSON.stringify(assetAllocationSettings));
            localStorage.removeItem('portfolio_global_rebalancing_v1');
            localStorage.setItem('portfolio_macro_targets', JSON.stringify(macroAllocations));
            localStorage.setItem('portfolio_goal_targets', JSON.stringify(goalAllocations));
            localStorage.setItem('portfolio_goals', JSON.stringify(goals));
            localStorage.setItem('portfolio_targets_v2', JSON.stringify([]));

            // Then update React state
            setTransactions(transactions);
            setAssetSettings(assetSettings);
            setPortfolios(portfolios);
            setBrokers(brokers);
            setMarketData(marketData);
            setStoredAssetAllocationSettings(assetAllocationSettings);
            setMacroAllocations(macroAllocations);
            setGoalAllocations(goalAllocations);
            setGoals(goals);
            setOldTargets([]);

            return true;
        } catch (e) {
            console.error('Failed to import data', e);
            return false;
        }
    };

    const syncToAzure = async (): Promise<{ ok: boolean; error?: string }> => {
        const config = azureConfigRef.current;
        if (!config.enabled || !config.sasUrl || !config.passphrase)
            return { ok: false, error: 'Azure non configurato o disabilitato' };
        try {
            setAzureSyncing(true);
            const payload: SyncPayload = {
                syncVersion: 1, syncTimestamp: new Date().toISOString(),
                transactions, assetSettings, portfolios, brokers, marketData,
                assetAllocationSettings: storedAssetAllocationSettings,
                macroAllocations, goalAllocations, goals,
            };
            const encrypted = await encrypt(JSON.stringify(payload), config.passphrase);
            await uploadToAzure(config.sasUrl, encrypted);
            setAzureConfig(prev => ({ ...prev, lastSync: new Date().toISOString() }));
            return { ok: true };
        } catch (e) {
            return { ok: false, error: String(e) };
        } finally {
            setAzureSyncing(false);
        }
    };

    const restoreFromAzure = async (): Promise<{ ok: boolean; error?: string }> => {
        const config = azureConfigRef.current;
        if (!config.sasUrl || !config.passphrase) return { ok: false, error: 'Azure non configurato' };
        try {
            setAzureSyncing(true);
            const buffer = await downloadFromAzure(config.sasUrl);
            if (!buffer) return { ok: false, error: 'Nessun dato trovato su Azure' };
            const decrypted = await decrypt(buffer, config.passphrase);
            const payload: SyncPayload = JSON.parse(decrypted);
            lastRestoreRef.current = Date.now();
            await importData(payload);
            setAzureConfig(prev => ({ ...prev, lastSync: payload.syncTimestamp }));
            return { ok: true };
        } catch (e) {
            return { ok: false, error: String(e) };
        } finally {
            setAzureSyncing(false);
        }
    };

    const value = {
        transactions,
        targets: assetSettings, // Expose as targets for compatibility
        assetSettings,
        assets,
        summary,
        macroAllocations,
        goalAllocations,
        addTransaction,
        updateTransaction,
        updateTransactionsBulk,
        deleteTransaction,
        updateTarget,
        updateAssetSettings,
        updatePortfolioAllocation,
        updateMacroAllocation,
        updateGoalAllocation,
        refreshPrices,
        resetPortfolio,
        loadMockData,
        marketData,
        portfolios,
        addPortfolio,
        updatePortfolio,
        deletePortfolio,
        assetAllocationSettings,
        brokers,
        addBroker,
        updateBroker,
        deleteBroker,
        goals,
        addGoal,
        updateGoal,
        deleteGoal,
        updatePortfolioTarget,
        updateLiquidityTarget,
        upsertRatioGroup,
        deleteRatioGroup,
        resetAssetAllocationSettings,
        importData,
        updateMarketData,
        addTransactionsBulk,
        azureConfig,
        setAzureConfig,
        syncToAzure,
        restoreFromAzure,
        azureSyncing,
    };

    return (
        <PortfolioContext.Provider value={value}>
            {children}
            <PriceUpdateModal
                isOpen={isPriceModalOpen}
                onClose={() => setIsPriceModalOpen(false)}
                items={priceUpdateItems}
                isComplete={isUpdateComplete}
            />
        </PortfolioContext.Provider>
    );
};
