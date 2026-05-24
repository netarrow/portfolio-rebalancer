import React, { createContext, useContext, useMemo, useEffect, useState, useRef } from 'react';
import { calculateAssets } from '../utils/portfolioCalculations';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { Transaction, Asset, AssetClass, PortfolioSummary, AssetSubClass, Portfolio, AssetDefinition, Broker, MacroAllocation, GoalAllocation, AssetAllocationSettings, PortfolioTargetConfig, LiquidityTargetConfig, RatioGroupConfig, Goal, YnabConfig, YnabCategory, YnabCategoryMapping, YnabMappingTarget, YnabCategoryGroupSummary, YnabGoal, YnabGoalAllocation, YnabGoalSyncCandidate } from '../types';
import { listBudgets as ynabListBudgets, getCurrentMonthCategories as ynabGetCategories, getAverageBudgetedByCategory as ynabGetAverages, listCategoryGroups as ynabListGroups, getGoalCategories as ynabGetGoalCategories, milliunitsToEur } from '../services/ynabApi';
import type { YnabBudgetSummary } from '../services/ynabApi';
import { parseGoalDescriptor } from '../utils/ynabGoalParser';
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
    // Aggregate section UI preferences (synced)
    aggregateExcludedTickers: string[];
    setAggregateExcludedTickers: (tickers: string[] | ((prev: string[]) => string[])) => void;
    // Goal rebalance widget targets (persisted and synced with Azure)
    goalModeTargets: Record<string, number>;
    setGoalModeTargets: (targets: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>)) => void;
    // Azure sync
    azureConfig: AzureConfig;
    setAzureConfig: (config: AzureConfig | ((prev: AzureConfig) => AzureConfig)) => void;
    syncToAzure: () => Promise<{ ok: boolean; error?: string }>;
    restoreFromAzure: () => Promise<{ ok: boolean; error?: string }>;
    azureSyncing: boolean;
    // YNAB integration
    ynabConfig: YnabConfig | null;
    setYnabConfig: (config: YnabConfig | null) => void;
    ynabCategories: YnabCategory[];
    ynabMappings: YnabCategoryMapping[];
    ynabListBudgets: (apiKey: string) => Promise<{ ok: boolean; budgets?: YnabBudgetSummary[]; error?: string }>;
    syncYnabBudget: () => Promise<{ ok: boolean; error?: string }>;
    setYnabMapping: (categoryId: string, target: YnabMappingTarget) => void;
    disconnectYnab: () => void;
    ynabSyncing: boolean;
    // YNAB Goals (entità separata dai Goal manuali)
    ynabGoals: YnabGoal[];
    ynabGoalAllocations: YnabGoalAllocation[];
    listYnabCategoryGroups: () => Promise<{ ok: boolean; groups?: YnabCategoryGroupSummary[]; error?: string }>;
    setYnabGoalsGroup: (groupId: string, groupName: string) => void;
    prepareYnabGoalsSync: () => Promise<{ ok: boolean; candidates?: YnabGoalSyncCandidate[]; error?: string }>;
    applyYnabGoalsSync: (candidates: YnabGoalSyncCandidate[]) => { ok: boolean; report?: { created: number; updated: number; skipped: number; archived: number; deleted: number }; error?: string };
    deleteYnabGoal: (ynabGoalId: string) => { ok: boolean; error?: string };
    addAllocation: (input: { portfolioId: string; ynabGoalId: string; amount: number; allowOverallocation?: boolean }) => { ok: boolean; error?: string };
    updateAllocation: (allocationId: string, input: { amount: number; allowOverallocation?: boolean }) => { ok: boolean; error?: string };
    removeAllocation: (allocationId: string) => void;
    getPortfolioAllocationSummary: (portfolioId: string) => { allocated: number; available: number; drift: number; currentValue: number };
    getYnabGoalAllocations: (ynabGoalId: string) => YnabGoalAllocation[];
    ynabGoalsSyncing: boolean;
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

    // Aggregate section UI preferences (persisted and synced with Azure)
    const [aggregateExcludedTickers, setAggregateExcludedTickers] = useLocalStorage<string[]>('aggregate-excluded-tickers', []);
    const [goalModeTargets, setGoalModeTargets] = useLocalStorage<Record<string, number>>('goal_mode_targets', {});

    // Azure sync config — excluded from backup, restore and sync payload by design
    const [azureConfig, setAzureConfig] = useLocalStorage<AzureConfig>('portfolio_azure_config', {
        sasUrl: '', passphrase: '', enabled: false, lastSync: null
    });
    const [azureSyncing, setAzureSyncing] = useState(false);

    // YNAB integration — apiKey + snapshot categorie SOLO LOCALI (non sincronizzati su Azure).
    // I mapping sono invece inclusi nel SyncPayload per propagarsi fra device.
    const [ynabConfig, setYnabConfigState] = useLocalStorage<YnabConfig | null>('portfolio_ynab_config', null);
    const [ynabCategories, setYnabCategories] = useLocalStorage<YnabCategory[]>('portfolio_ynab_categories', []);
    const [ynabMappings, setYnabMappings] = useLocalStorage<YnabCategoryMapping[]>('portfolio_ynab_mappings', []);
    const [ynabSyncing, setYnabSyncing] = useState(false);
    const [ynabGoals, setYnabGoals] = useLocalStorage<YnabGoal[]>('portfolio_ynab_goals', []);
    const [ynabGoalAllocations, setYnabGoalAllocations] = useLocalStorage<YnabGoalAllocation[]>('portfolio_ynab_goal_allocations', []);
    const [ynabGoalsSyncing, setYnabGoalsSyncing] = useState(false);
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
                aggregateExcludedTickers, goalModeTargets,
                ynabMappings,
                ynabGoals,
                ynabGoalAllocations,
                ynabGoalsGroupId: ynabConfig?.goalsGroupId,
                ynabGoalsGroupName: ynabConfig?.goalsGroupName,
                ynabLastGoalsSyncAt: ynabConfig?.lastGoalsSyncAt,
            };
            try {
                setAzureSyncing(true);
                const encrypted = await encrypt(JSON.stringify(payload), config.passphrase);
                await uploadToAzure(config.sasUrl, encrypted);
                setAzureConfig(prev => ({ ...prev, lastSync: new Date().toISOString() }));
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                console.error(`[Azure Sync] Error at ${new Date().toISOString()}:`, {
                    message: error.message,
                    stack: error.stack,
                    payloadSize: JSON.stringify(payload).length,
                });
            } finally {
                setAzureSyncing(false);
            }
        }, 3000);

        return () => { if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current); };
    }, [transactions, assetSettings, portfolios, brokers, marketData,
        storedAssetAllocationSettings, macroAllocations, goalAllocations, goals, aggregateExcludedTickers, goalModeTargets, ynabMappings,
        ynabGoals, ynabGoalAllocations, ynabConfig?.goalsGroupId, ynabConfig?.goalsGroupName, ynabConfig?.lastGoalsSyncAt]);

    // On mount: check if Azure has newer data and offer restore
    useEffect(() => {
        const config = azureConfigRef.current;
        if (!config.enabled || !config.sasUrl || !config.passphrase) return;

        (async () => {
            try {
                const buffer = await downloadFromAzure(config.sasUrl);
                if (!buffer) {
                    // Primo avvio con Azure configurato: blob non esiste ancora, inizializza
                    const initPayload: SyncPayload = {
                        syncVersion: 1,
                        syncTimestamp: new Date().toISOString(),
                        transactions, assetSettings, portfolios, brokers, marketData,
                        assetAllocationSettings: storedAssetAllocationSettings,
                        macroAllocations, goalAllocations, goals,
                        aggregateExcludedTickers, goalModeTargets,
                        ynabMappings,
                        ynabGoals,
                        ynabGoalAllocations,
                        ynabGoalsGroupId: ynabConfig?.goalsGroupId,
                        ynabGoalsGroupName: ynabConfig?.goalsGroupName,
                        ynabLastGoalsSyncAt: ynabConfig?.lastGoalsSyncAt,
                    };
                    const encrypted = await encrypt(JSON.stringify(initPayload), config.passphrase);
                    await uploadToAzure(config.sasUrl, encrypted);
                    setAzureConfig(prev => ({ ...prev, lastSync: initPayload.syncTimestamp }));
                    return;
                }

                const decrypted = await decrypt(buffer, config.passphrase);
                const payload: SyncPayload = JSON.parse(decrypted);

                const remoteTime = new Date(payload.syncTimestamp).getTime();
                const localTime = config.lastSync ? new Date(config.lastSync).getTime() : 0;

                if (remoteTime > localTime) {
                    const result = await Swal.fire({
                        title: 'Remote data is more recent',
                        text: `Azure contains data updated at ${new Date(payload.syncTimestamp).toLocaleString('en-GB')}. Restore it?`,
                        icon: 'question',
                        showCancelButton: true,
                        confirmButtonText: 'Restore from Azure',
                        cancelButtonText: 'Keep local',
                    });
                    if (result.isConfirmed) {
                        lastRestoreRef.current = Date.now();
                        await importData(payload);
                        setAzureConfig(prev => ({ ...prev, lastSync: payload.syncTimestamp }));
                    }
                }
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                console.error(`[Azure Startup Sync] Error at ${new Date().toISOString()}:`, {
                    message: error.message,
                    stack: error.stack,
                });
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
        // Clean up YNAB goal allocations pointing at this portfolio
        setYnabGoalAllocations(prev => prev.filter(a => a.portfolioId !== id));
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
        const pIdMainTilt = 'mock-p-main-tilt';
        const pIdBonds = 'mock-p-bonds';
        const pIdSafe = 'mock-p-safe';

        // 1. Define Assets — ETFs and bond ETFs only (no crypto by design).
        const mockAssets = [
            // Growth (Stocks)
            { ticker: 'IE00B4L5Y983', name: 'iShares Core MSCI World', class: 'Stock', subClass: 'International', source: 'ETF', goal: 'Growth' }, // SWDA
            { ticker: 'IE00BKM4GZ66', name: 'iShares Core MSCI EM IMI', class: 'Stock', subClass: 'International', source: 'ETF', goal: 'Growth' }, // EMIM
            { ticker: 'IE00B3RBWM25', name: 'Vanguard FTSE All-World', class: 'Stock', subClass: 'International', source: 'ETF', goal: 'Growth' }, // VWRL

            // Security (Bonds, medium duration)
            { ticker: 'IE00BDBRDM35', name: 'iShares Glb Agg Bond EUR-H', class: 'Bond', subClass: 'Medium', source: 'ETF', goal: 'Security' }, // AGGH

            // Protection (Long-duration govt bonds + short-term EUR overnight)
            { ticker: 'IE00B1FZS798', name: 'iShares Euro Govt Bond 15-30yr', class: 'Bond', subClass: 'Long', source: 'ETF', goal: 'Protection' }, // IGLT (Proxy)
            { ticker: 'LU0290358497', name: 'Xtrackers II EUR Overnight Rate', class: 'Bond', subClass: 'Short', source: 'ETF', goal: 'Protection' }, // XEON
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

        // --- SCENARIO 1: Main Strategy (Growth parent — core ETF holdings) ---
        // SWDA: Regular Accumulation
        addTx(pIdMain, 'IE00B4L5Y983', 365, 300, 78.50, 'Buy', 'Degiro');
        addTx(pIdMain, 'IE00B4L5Y983', 180, 50, 84.20, 'Buy', 'Degiro');
        addTx(pIdMain, 'IE00B4L5Y983', 30, 20, 92.10, 'Buy', 'Degiro');

        // EMIM: Weighted Average Test (Buy -> Sell Half -> Buy)
        addTx(pIdMain, 'IE00BKM4GZ66', 200, 100, 25.00, 'Buy', 'Degiro');
        addTx(pIdMain, 'IE00BKM4GZ66', 100, 50, 28.00, 'Sell', 'Degiro');
        addTx(pIdMain, 'IE00BKM4GZ66', 10, 50, 30.00, 'Buy', 'Degiro');

        // --- SCENARIO 2: Main Strategy — Tactical Tilt (Growth child of pIdMain) ---
        // Child portfolio shares the Growth goal but tilts toward developed-world
        // dividend exposure via VWRL and emerging markets via EMIM.
        addTx(pIdMainTilt, 'IE00B3RBWM25', 120, 40, 105.00, 'Buy', 'Trade Republic');
        addTx(pIdMainTilt, 'IE00BKM4GZ66', 50, 30, 28.50, 'Buy', 'Degiro');

        // --- SCENARIO 3: Bond Allocation (Security — global aggregate bonds) ---
        addTx(pIdBonds, 'IE00BDBRDM35', 90, 500, 4.80, 'Buy', 'Trade Republic');

        // --- SCENARIO 4: Safety Net (Protection — long-duration & overnight) ---
        addTx(pIdSafe, 'LU0290358497', 60, 450, 139.50, 'Buy', 'Directa');
        addTx(pIdSafe, 'IE00B1FZS798', 120, 50, 180.00, 'Buy', 'Directa');

        // --- SCENARIO 5: Feature coverage transactions ---
        // Free-commission Buy (Trade Republic style)
        txs.push({
            id: `mock-tx-${idCounter++}`,
            portfolioId: pIdMain,
            ticker: 'IE00B4L5Y983',
            date: new Date(today - (15 * ONE_DAY)).toISOString().split('T')[0],
            amount: 10,
            price: 93.00,
            direction: 'Buy',
            brokerId: 'b3',
            freeCommission: true
        } as any);

        // Dividend on VWRL (exercises Dividend income path on the Tilt child)
        txs.push({
            id: `mock-tx-${idCounter++}`,
            portfolioId: pIdMainTilt,
            ticker: 'IE00B3RBWM25',
            date: new Date(today - (45 * ONE_DAY)).toISOString().split('T')[0],
            amount: 1,
            price: 42.75, // EUR total dividend
            direction: 'Dividend',
            brokerId: 'b1'
        } as any);

        // Coupon on AGGH (bond income)
        txs.push({
            id: `mock-tx-${idCounter++}`,
            portfolioId: pIdBonds,
            ticker: 'IE00BDBRDM35',
            date: new Date(today - (75 * ONE_DAY)).toISOString().split('T')[0],
            amount: 1,
            price: 28.50, // EUR total coupon
            direction: 'Coupon',
            brokerId: 'b3'
        } as any);

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
        // Parent-child pair (pIdMain → pIdMainTilt) both have populated allocations
        // and real transactions so nested rendering can be exercised end-to-end.
        const portfoliosList: Portfolio[] = [
            {
                id: pIdMain,
                name: 'Main Strategy',
                description: 'Core developed + emerging stocks (Growth parent)',
                goalId: 'goal-growth',
                order: 0,
                liquidity: 2000,
                allocations: {
                    'IE00B4L5Y983': 60, // SWDA
                    'IE00BKM4GZ66': 30, // EMIM
                    'IE00B3RBWM25': 10  // VWRL
                }
            },
            {
                id: pIdMainTilt,
                name: 'Main Strategy — Tactical Tilt',
                description: 'Nested Growth sub-portfolio tilting toward EM + dividend ETF',
                goalId: 'goal-growth',
                parentId: pIdMain,
                order: 1,
                allocations: {
                    'IE00B3RBWM25': 60, // VWRL
                    'IE00BKM4GZ66': 40  // EMIM
                }
            },
            {
                id: pIdBonds,
                name: 'Bond Allocation',
                description: 'Global aggregate bond exposure (Security goal)',
                goalId: 'goal-security',
                order: 2,
                allocations: {
                    'IE00BDBRDM35': 100 // AGGH
                }
            },
            {
                id: pIdSafe,
                name: 'Safety Net',
                description: 'Long-duration govt bonds + EUR overnight (Protection)',
                goalId: 'goal-protection',
                order: 3,
                allocations: {
                    'LU0290358497': 70, // XEON
                    'IE00B1FZS798': 30  // IGLT
                }
            }
        ];

        // 5. Market Data (Soft Mocks for immediate display)
        const mockPrices = {
            'IE00B4L5Y983': { price: 95.50, lastUpdated: timestamp }, // Profit
            'IE00BKM4GZ66': { price: 31.20, lastUpdated: timestamp }, // Profit
            'IE00B3RBWM25': { price: 115.00, lastUpdated: timestamp }, // Profit
            'IE00BDBRDM35': { price: 5.10, lastUpdated: timestamp },  // Profit
            'IE00B1FZS798': { price: 175.50, lastUpdated: timestamp }, // Loss
            'LU0290358497': { price: 142.10, lastUpdated: timestamp }  // Profit
        };

        // 6. Macro & Goal Allocations (Global Targets)
        // Goal split: 60% Growth, 20% Security, 20% Protection.
        // Reflected in macro classes: 60% Stock (Growth), 40% Bond (Security + Protection).
        const newMacros: MacroAllocation = {
            'Stock': 60,
            'Bond': 40,
            'Cash': 0,
            'Crypto': 0,
            'Commodity': 0
        };

        const newGoals: GoalAllocation = {
            'Growth': 60,
            'Security': 20,
            'Protection': 20,
            'Liquidity': 0
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
            liquidityTarget: { mode: 'fixed', value: 0 },
            portfolioTargets: {
                [pIdMain]: { mode: 'percent', value: 40 },
                [pIdMainTilt]: { mode: 'ratio', value: 100, ratioGroupId: 'rg-growth-remainder' },
                [pIdBonds]: { mode: 'percent', value: 20 },
                [pIdSafe]: { mode: 'fixed', value: 10000 }
            },
            ratioGroups: [
                { id: 'rg-growth-remainder', name: 'Growth Remainder', groupTargetMode: 'remainder', groupTargetValue: 0 }
            ]
        });
        setBrokers([
            {
                id: 'b1',
                name: 'Degiro',
                description: 'Main Broker',
                commissionType: 'fixed',
                commissionFixed: 2.5,
                currentLiquidity: 1500
            },
            {
                id: 'b2',
                name: 'Directa',
                description: 'Italian Broker',
                commissionType: 'percent',
                commissionPercent: 0.19,
                commissionMin: 2.95,
                commissionMax: 19,
                currentLiquidity: 8000,
                minLiquidityType: 'fixed',
                minLiquidityAmount: 5000,
                liquidityAllocations: { [pIdSafe]: 5000 }
            },
            {
                id: 'b3',
                name: 'Trade Republic',
                description: 'Savings Plans',
                commissionType: 'fixed',
                commissionFixed: 1,
                currentLiquidity: 500
            }
        ]);

        // 8. YNAB integration mock data
        setYnabConfig({
            apiKey: 'mock-ynab-key',
            budgetId: 'mock-budget-id',
            budgetName: 'Family Budget',
            currencyIso: 'EUR',
            avgMonthsWindow: 6,
            lastSyncAt: timestamp
        });
        setYnabCategories([
            // ── Investments ──────────────────────────────────────────────────
            { id: 'ynab-cat-1', groupId: 'ynab-grp-inv', groupName: 'Investments', name: 'ETF DCA (SWDA)', balanceMilliunits: 1200000, budgetedMilliunits: 500000, avgBudgetedMilliunits: 480000, avgMonthsCount: 6 },
            { id: 'ynab-cat-2', groupId: 'ynab-grp-inv', groupName: 'Investments', name: 'Bonds ETF (AGGH)', balanceMilliunits: 400000, budgetedMilliunits: 150000, avgBudgetedMilliunits: 160000, avgMonthsCount: 6 },
            { id: 'ynab-cat-3', groupId: 'ynab-grp-inv', groupName: 'Investments', name: 'Pension Fund (COMETA)', balanceMilliunits: 600000, budgetedMilliunits: 200000, avgBudgetedMilliunits: 195000, avgMonthsCount: 6 },
            { id: 'ynab-cat-4', groupId: 'ynab-grp-inv', groupName: 'Investments', name: 'Crypto (unmapped)', balanceMilliunits: 300000, budgetedMilliunits: 100000, avgBudgetedMilliunits: 120000, avgMonthsCount: 6 },
            // ── Savings ──────────────────────────────────────────────────────
            { id: 'ynab-cat-5', groupId: 'ynab-grp-sav', groupName: 'Savings', name: 'Emergency Fund', balanceMilliunits: 5000000, budgetedMilliunits: 200000, avgBudgetedMilliunits: 250000, avgMonthsCount: 6 },
            { id: 'ynab-cat-6', groupId: 'ynab-grp-sav', groupName: 'Savings', name: 'Travel Fund', balanceMilliunits: 800000, budgetedMilliunits: 150000, avgBudgetedMilliunits: 140000, avgMonthsCount: 6 },
            { id: 'ynab-cat-7', groupId: 'ynab-grp-sav', groupName: 'Savings', name: 'Home Renovations', balanceMilliunits: 1500000, budgetedMilliunits: 300000, avgBudgetedMilliunits: 280000, avgMonthsCount: 6 },
            // ── Monthly Expenses ──────────────────────────────────────────────
            { id: 'ynab-cat-8', groupId: 'ynab-grp-exp', groupName: 'Monthly Expenses', name: 'Groceries', balanceMilliunits: 350000, budgetedMilliunits: 400000, avgBudgetedMilliunits: 380000, avgMonthsCount: 6 },
            { id: 'ynab-cat-9', groupId: 'ynab-grp-exp', groupName: 'Monthly Expenses', name: 'Restaurants & Takeaway', balanceMilliunits: 120000, budgetedMilliunits: 200000, avgBudgetedMilliunits: 175000, avgMonthsCount: 6 },
            { id: 'ynab-cat-10', groupId: 'ynab-grp-exp', groupName: 'Monthly Expenses', name: 'Transport', balanceMilliunits: 80000, budgetedMilliunits: 120000, avgBudgetedMilliunits: 110000, avgMonthsCount: 6 },
            { id: 'ynab-cat-11', groupId: 'ynab-grp-exp', groupName: 'Monthly Expenses', name: 'Health & Pharmacy', balanceMilliunits: -50000, budgetedMilliunits: 100000, avgBudgetedMilliunits: 90000, avgMonthsCount: 6 },
            // ── Housing ──────────────────────────────────────────────────────
            { id: 'ynab-cat-12', groupId: 'ynab-grp-hous', groupName: 'Housing', name: 'Mortgage / Rent', balanceMilliunits: 0, budgetedMilliunits: 900000, avgBudgetedMilliunits: 900000, avgMonthsCount: 6 },
            { id: 'ynab-cat-13', groupId: 'ynab-grp-hous', groupName: 'Housing', name: 'Utilities (gas, electric, water)', balanceMilliunits: 60000, budgetedMilliunits: 150000, avgBudgetedMilliunits: 140000, avgMonthsCount: 6 },
            { id: 'ynab-cat-14', groupId: 'ynab-grp-hous', groupName: 'Housing', name: 'Internet & Phone', balanceMilliunits: 20000, budgetedMilliunits: 50000, avgBudgetedMilliunits: 50000, avgMonthsCount: 6 },
        ]);
        setYnabMappings([
            { categoryId: 'ynab-cat-1', target: { kind: 'asset', ticker: 'IE00B4L5Y983' } },
            { categoryId: 'ynab-cat-2', target: { kind: 'asset', ticker: 'IE00BDBRDM35' } },
            { categoryId: 'ynab-cat-3', target: { kind: 'asset', ticker: 'LU0290358497' } },
            { categoryId: 'ynab-cat-5', target: { kind: 'cash', brokerId: 'b1' } },
            { categoryId: 'ynab-cat-7', target: { kind: 'cash', brokerId: 'b2' } },
            // cat-4 (Crypto) and housing/expenses remain unmapped
        ]);

        // 9. Aggregate UI: exclude VWRL from the aggregate view
        setAggregateExcludedTickers(['IE00B3RBWM25']);

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
            const aggregateExcludedTickers = Array.isArray(data.aggregateExcludedTickers) ? data.aggregateExcludedTickers : [];
            const goalModeTargets = (data.goalModeTargets && typeof data.goalModeTargets === 'object') ? data.goalModeTargets : {};
            const importedYnabMappings: YnabCategoryMapping[] = Array.isArray(data.ynabMappings) ? data.ynabMappings : [];
            const importedYnabGoals: YnabGoal[] = Array.isArray(data.ynabGoals) ? data.ynabGoals : [];
            const importedYnabGoalAllocations: YnabGoalAllocation[] = Array.isArray(data.ynabGoalAllocations) ? data.ynabGoalAllocations : [];
            const importedYnabGoalsGroupId: string | undefined = typeof data.ynabGoalsGroupId === 'string' ? data.ynabGoalsGroupId : undefined;
            const importedYnabGoalsGroupName: string | undefined = typeof data.ynabGoalsGroupName === 'string' ? data.ynabGoalsGroupName : undefined;
            const importedYnabLastGoalsSyncAt: string | undefined = typeof data.ynabLastGoalsSyncAt === 'string' ? data.ynabLastGoalsSyncAt : undefined;

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
            localStorage.setItem('aggregate-excluded-tickers', JSON.stringify(aggregateExcludedTickers));
            localStorage.setItem('goal_mode_targets', JSON.stringify(goalModeTargets));
            localStorage.setItem('portfolio_ynab_mappings', JSON.stringify(importedYnabMappings));
            localStorage.setItem('portfolio_ynab_goals', JSON.stringify(importedYnabGoals));
            localStorage.setItem('portfolio_ynab_goal_allocations', JSON.stringify(importedYnabGoalAllocations));

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
            setAggregateExcludedTickers(aggregateExcludedTickers);
            setGoalModeTargets(goalModeTargets);
            setYnabMappings(importedYnabMappings);
            setYnabGoals(importedYnabGoals);
            setYnabGoalAllocations(importedYnabGoalAllocations);
            if (importedYnabGoalsGroupId !== undefined || importedYnabGoalsGroupName !== undefined || importedYnabLastGoalsSyncAt !== undefined) {
                setYnabConfigState(prev => prev ? {
                    ...prev,
                    goalsGroupId: importedYnabGoalsGroupId ?? prev.goalsGroupId,
                    goalsGroupName: importedYnabGoalsGroupName ?? prev.goalsGroupName,
                    lastGoalsSyncAt: importedYnabLastGoalsSyncAt ?? prev.lastGoalsSyncAt,
                } : prev);
            }

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
                aggregateExcludedTickers, goalModeTargets,
                ynabMappings,
                ynabGoals,
                ynabGoalAllocations,
                ynabGoalsGroupId: ynabConfig?.goalsGroupId,
                ynabGoalsGroupName: ynabConfig?.goalsGroupName,
                ynabLastGoalsSyncAt: ynabConfig?.lastGoalsSyncAt,
            };
            const payloadJson = JSON.stringify(payload);
            const encrypted = await encrypt(payloadJson, config.passphrase);
            await uploadToAzure(config.sasUrl, encrypted);
            setAzureConfig(prev => ({ ...prev, lastSync: new Date().toISOString() }));
            console.log(`[Azure Sync] Success: uploaded ${encrypted.byteLength} bytes at ${new Date().toISOString()}`);
            return { ok: true };
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            const errorLog = {
                timestamp: new Date().toISOString(),
                action: 'syncToAzure',
                message: error.message,
                stack: error.stack,
            };
            console.error('[Azure Sync] Failed:', errorLog);
            return { ok: false, error: String(e) };
        } finally {
            setAzureSyncing(false);
        }
    };

    const restoreFromAzure = async (): Promise<{ ok: boolean; error?: string }> => {
        const config = azureConfigRef.current;
        if (!config.sasUrl || !config.passphrase) return { ok: false, error: 'Azure not configured' };
        try {
            setAzureSyncing(true);
            const buffer = await downloadFromAzure(config.sasUrl);
            if (!buffer) return { ok: false, error: 'No data found on Azure' };
            const decrypted = await decrypt(buffer, config.passphrase);
            const payload: SyncPayload = JSON.parse(decrypted);
            lastRestoreRef.current = Date.now();
            await importData(payload);
            setAzureConfig(prev => ({ ...prev, lastSync: payload.syncTimestamp }));
            console.log(`[Azure Restore] Success: restored ${buffer.byteLength} bytes at ${new Date().toISOString()}`);
            return { ok: true };
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            const errorLog = {
                timestamp: new Date().toISOString(),
                action: 'restoreFromAzure',
                message: error.message,
                stack: error.stack,
            };
            console.error('[Azure Restore] Failed:', errorLog);
            return { ok: false, error: String(e) };
        } finally {
            setAzureSyncing(false);
        }
    };

    // YNAB methods
    const setYnabConfig = (config: YnabConfig | null) => {
        setYnabConfigState(config);
        if (config === null) {
            setYnabCategories([]);
        }
    };

    const handleYnabListBudgets = async (apiKey: string) => {
        const result = await ynabListBudgets(apiKey);
        if (result.success && result.data) return { ok: true, budgets: result.data };
        return { ok: false, error: result.error };
    };

    const syncYnabBudget = async (): Promise<{ ok: boolean; error?: string }> => {
        if (!ynabConfig?.apiKey || !ynabConfig?.budgetId) {
            return { ok: false, error: 'YNAB non configurato.' };
        }
        try {
            setYnabSyncing(true);
            const [result, avgResult] = await Promise.all([
                ynabGetCategories(ynabConfig.apiKey, ynabConfig.budgetId),
                ynabGetAverages(ynabConfig.apiKey, ynabConfig.budgetId, ynabConfig.avgMonthsWindow ?? 6),
            ]);
            if (!result.success || !result.data) {
                return { ok: false, error: result.error || 'Error during synchronization.' };
            }
            const averages = avgResult.success && avgResult.data ? avgResult.data : null;
            if (!avgResult.success) {
                console.warn('[YNAB] Failed to fetch historical averages:', avgResult.error);
            }
            const merged = result.data.map(c => {
                const avg = averages?.get(c.id);
                return avg
                    ? { ...c, avgBudgetedMilliunits: avg.avgBudgetedMilliunits, avgMonthsCount: avg.monthsCount }
                    : c;
            });
            setYnabCategories(merged);
            setYnabConfigState(prev => prev ? { ...prev, lastSyncAt: new Date().toISOString() } : prev);
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        } finally {
            setYnabSyncing(false);
        }
    };

    const setYnabMapping = (categoryId: string, target: YnabMappingTarget) => {
        setYnabMappings(prev => {
            const idx = prev.findIndex(m => m.categoryId === categoryId);
            if (target.kind === 'unmapped') {
                if (idx === -1) return prev;
                return prev.filter(m => m.categoryId !== categoryId);
            }
            const next = { categoryId, target };
            if (idx === -1) return [...prev, next];
            const copy = prev.slice();
            copy[idx] = next;
            return copy;
        });
    };

    const disconnectYnab = () => {
        setYnabConfigState(null);
        setYnabCategories([]);
        setYnabMappings([]);
        setYnabGoals([]);
        setYnabGoalAllocations([]);
    };

    // ── YNAB Goals (entità separata dai Goal manuali del tool) ──────────

    const listYnabCategoryGroups = async (): Promise<{ ok: boolean; groups?: YnabCategoryGroupSummary[]; error?: string }> => {
        if (!ynabConfig?.apiKey || !ynabConfig?.budgetId) {
            return { ok: false, error: 'YNAB not configured.' };
        }
        const result = await ynabListGroups(ynabConfig.apiKey, ynabConfig.budgetId);
        if (result.success && result.data) return { ok: true, groups: result.data };
        return { ok: false, error: result.error };
    };

    const setYnabGoalsGroup = (groupId: string, groupName: string) => {
        setYnabConfigState(prev => prev ? { ...prev, goalsGroupId: groupId, goalsGroupName: groupName } : prev);
    };

    const prepareYnabGoalsSync = async (): Promise<{ ok: boolean; candidates?: YnabGoalSyncCandidate[]; error?: string }> => {
        if (!ynabConfig?.apiKey || !ynabConfig?.budgetId) {
            return { ok: false, error: 'YNAB not configured.' };
        }
        if (!ynabConfig?.goalsGroupId) {
            return { ok: false, error: 'Select an Investment Goals category group first.' };
        }
        try {
            setYnabGoalsSyncing(true);
            const res = await ynabGetGoalCategories(ynabConfig.apiKey, ynabConfig.budgetId, ynabConfig.goalsGroupId);
            if (!res.success || !res.data) {
                return { ok: false, error: res.error || 'Failed to fetch goal categories.' };
            }
            const existingById = new Map<string, YnabGoal>();
            for (const g of ynabGoals) existingById.set(g.id, g);

            const candidates: YnabGoalSyncCandidate[] = res.data.map(cat => {
                const parsed = parseGoalDescriptor(cat.name, cat.note);
                const existing = existingById.get(cat.id) ?? null;
                return {
                    ynabCategoryId: cat.id,
                    ynabCategoryName: cat.name,
                    rawNote: cat.note ?? null,
                    parsedAmount: parsed.amount,
                    parsedDate: parsed.date,
                    confidence: parsed.confidence,
                    cashCoverage: milliunitsToEur(cat.balanceMilliunits),
                    ynabMonthlyFunding: cat.goalType === 'MF' && typeof cat.goalTargetMilliunits === 'number'
                        ? milliunitsToEur(cat.goalTargetMilliunits)
                        : null,
                    ynabActivityThisMonth: typeof cat.activityMilliunits === 'number'
                        ? milliunitsToEur(cat.activityMilliunits)
                        : null,
                    goalType: cat.goalType ?? null,
                    matchedYnabGoalId: existing?.id ?? null,
                    parsedSource: parsed.source,
                    existingTargetSource: existing?.targetSource ?? null,
                    existingTargetAmount: existing?.targetAmount ?? null,
                    existingTargetDate: existing?.targetDate ?? null,
                    action: existing ? 'update' : 'create',
                };
            });

            const order = { low: 0, medium: 1, high: 2 } as const;
            candidates.sort((a, b) => order[a.confidence] - order[b.confidence]);
            return { ok: true, candidates };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        } finally {
            setYnabGoalsSyncing(false);
        }
    };

    const applyYnabGoalsSync = (candidates: YnabGoalSyncCandidate[]) => {
        if (!ynabConfig?.budgetId) {
            return { ok: false as const, error: 'YNAB not configured.' };
        }
        const now = new Date().toISOString();
        const incomingIds = new Set(candidates.filter(c => c.action !== 'skip').map(c => c.ynabCategoryId));
        const allFetchedIds = new Set(candidates.map(c => c.ynabCategoryId));
        const report = { created: 0, updated: 0, skipped: 0, archived: 0, deleted: 0 };

        setYnabGoals(prev => {
            const byId = new Map<string, YnabGoal>();
            for (const g of prev) byId.set(g.id, g);

            for (const c of candidates) {
                if (c.action === 'skip') {
                    report.skipped += 1;
                    continue;
                }
                const existing = byId.get(c.ynabCategoryId) ?? null;

                let targetSource: YnabGoal['targetSource'];
                if (existing && existing.targetSource === 'manual-override') {
                    const sameAmount = (existing.targetAmount ?? null) === c.parsedAmount;
                    const sameDate = (existing.targetDate ?? null) === c.parsedDate;
                    if (sameAmount && sameDate) {
                        targetSource = c.parsedSource ?? 'manual-override';
                    } else {
                        targetSource = 'manual-override';
                    }
                } else {
                    targetSource = c.parsedSource ?? 'manual-override';
                }

                const next: YnabGoal = {
                    id: c.ynabCategoryId,
                    ynabBudgetId: ynabConfig.budgetId,
                    name: c.ynabCategoryName,
                    targetAmount: c.parsedAmount ?? undefined,
                    targetDate: c.parsedDate ?? undefined,
                    cashCoverage: c.cashCoverage,
                    ynabMonthlyFunding: c.ynabMonthlyFunding ?? undefined,
                    ynabActivityThisMonth: c.ynabActivityThisMonth ?? undefined,
                    goalType: c.goalType ?? undefined,
                    targetSource,
                    lastSyncedAt: now,
                    archived: false,
                };
                byId.set(c.ynabCategoryId, next);
                if (existing) report.updated += 1;
                else report.created += 1;
            }

            // Categorie scomparse dal gruppo YNAB: archive (se hanno allocations) o delete
            for (const g of prev) {
                if (allFetchedIds.has(g.id)) continue;
                if (!incomingIds.has(g.id)) {
                    const hasAllocs = ynabGoalAllocations.some(a => a.ynabGoalId === g.id);
                    if (hasAllocs) {
                        byId.set(g.id, { ...g, archived: true, lastSyncedAt: now });
                        report.archived += 1;
                    } else {
                        byId.delete(g.id);
                        report.deleted += 1;
                    }
                }
            }

            return Array.from(byId.values());
        });

        setYnabConfigState(prev => prev ? { ...prev, lastGoalsSyncAt: now } : prev);
        return { ok: true as const, report };
    };

    const deleteYnabGoal = (ynabGoalId: string) => {
        const hasAllocs = ynabGoalAllocations.some(a => a.ynabGoalId === ynabGoalId);
        if (hasAllocs) {
            return { ok: false as const, error: 'Remove allocations linked to this YNAB goal first.' };
        }
        setYnabGoals(prev => prev.filter(g => g.id !== ynabGoalId));
        return { ok: true as const };
    };

    // Portfolio current value (somma del valore corrente degli asset più la cash assegnata)
    const portfolioCurrentValue = useMemo(() => {
        const map = new Map<string, number>();
        for (const a of assets) {
            const txs = transactions.filter(t => t.ticker === a.ticker);
            const byPortfolio = new Map<string, number>();
            const totalQty = txs.reduce((s, t) => s + (t.direction === 'Buy' ? t.amount : t.direction === 'Sell' ? -t.amount : 0), 0);
            if (totalQty <= 0) continue;
            for (const t of txs) {
                if (!t.portfolioId) continue;
                const delta = t.direction === 'Buy' ? t.amount : t.direction === 'Sell' ? -t.amount : 0;
                byPortfolio.set(t.portfolioId, (byPortfolio.get(t.portfolioId) || 0) + delta);
            }
            for (const [pid, qty] of byPortfolio) {
                if (qty <= 0) continue;
                const share = qty / totalQty;
                const value = (a.currentValue || 0) * share;
                map.set(pid, (map.get(pid) || 0) + value);
            }
        }
        for (const b of brokers) {
            if (!b.liquidityAllocations) continue;
            for (const [pid, amt] of Object.entries(b.liquidityAllocations)) {
                if (!amt) continue;
                map.set(pid, (map.get(pid) || 0) + amt);
            }
        }
        for (const p of portfolios) {
            if (typeof p.liquidity === 'number' && p.liquidity > 0) {
                map.set(p.id, (map.get(p.id) || 0) + p.liquidity);
            }
        }
        return map;
    }, [assets, transactions, brokers, portfolios]);

    const getPortfolioAllocationSummary = (portfolioId: string) => {
        const currentValue = portfolioCurrentValue.get(portfolioId) || 0;
        const allocated = ynabGoalAllocations
            .filter(a => a.portfolioId === portfolioId)
            .reduce((s, a) => s + a.amount, 0);
        const available = Math.max(0, currentValue - allocated);
        const drift = allocated - currentValue;
        return { allocated, available, drift, currentValue };
    };

    const getYnabGoalAllocations = (ynabGoalId: string) => {
        return ynabGoalAllocations.filter(a => a.ynabGoalId === ynabGoalId);
    };

    const addAllocation = (input: { portfolioId: string; ynabGoalId: string; amount: number; allowOverallocation?: boolean }) => {
        const { portfolioId, ynabGoalId, amount, allowOverallocation } = input;
        if (!(amount > 0)) return { ok: false as const, error: 'Amount must be greater than zero.' };
        if (!portfolios.some(p => p.id === portfolioId)) return { ok: false as const, error: 'Portfolio not found.' };
        if (!ynabGoals.some(g => g.id === ynabGoalId)) return { ok: false as const, error: 'YNAB goal not found.' };
        const summary = getPortfolioAllocationSummary(portfolioId);
        if (amount > summary.available && !allowOverallocation) {
            return {
                ok: false as const,
                error: `Available: €${summary.available.toFixed(2)} of €${summary.currentValue.toFixed(2)} (already allocated €${summary.allocated.toFixed(2)} on other YNAB goals).`,
            };
        }
        const now = new Date().toISOString();
        const newAlloc: YnabGoalAllocation = {
            id: crypto.randomUUID(),
            portfolioId,
            ynabGoalId,
            amount,
            createdAt: now,
            updatedAt: now,
        };
        setYnabGoalAllocations(prev => [...prev, newAlloc]);
        return { ok: true as const };
    };

    const updateAllocation = (allocationId: string, input: { amount: number; allowOverallocation?: boolean }) => {
        const { amount, allowOverallocation } = input;
        if (!(amount > 0)) return { ok: false as const, error: 'Amount must be greater than zero.' };
        const existing = ynabGoalAllocations.find(a => a.id === allocationId);
        if (!existing) return { ok: false as const, error: 'Allocation not found.' };
        const summary = getPortfolioAllocationSummary(existing.portfolioId);
        const availableForUpdate = summary.available + existing.amount;
        if (amount > availableForUpdate && !allowOverallocation) {
            return {
                ok: false as const,
                error: `Available: €${availableForUpdate.toFixed(2)} of €${summary.currentValue.toFixed(2)}.`,
            };
        }
        const now = new Date().toISOString();
        setYnabGoalAllocations(prev => prev.map(a => a.id === allocationId ? { ...a, amount, updatedAt: now } : a));
        return { ok: true as const };
    };

    const removeAllocation = (allocationId: string) => {
        setYnabGoalAllocations(prev => prev.filter(a => a.id !== allocationId));
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
        aggregateExcludedTickers,
        setAggregateExcludedTickers,
        goalModeTargets,
        setGoalModeTargets,
        azureConfig,
        setAzureConfig,
        syncToAzure,
        restoreFromAzure,
        azureSyncing,
        ynabConfig,
        setYnabConfig,
        ynabCategories,
        ynabMappings,
        ynabListBudgets: handleYnabListBudgets,
        syncYnabBudget,
        setYnabMapping,
        disconnectYnab,
        ynabSyncing,
        ynabGoals,
        ynabGoalAllocations,
        listYnabCategoryGroups,
        setYnabGoalsGroup,
        prepareYnabGoalsSync,
        applyYnabGoalsSync,
        deleteYnabGoal,
        addAllocation,
        updateAllocation,
        removeAllocation,
        getPortfolioAllocationSummary,
        getYnabGoalAllocations,
        ynabGoalsSyncing,
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
