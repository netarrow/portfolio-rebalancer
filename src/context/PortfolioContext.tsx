import React, { createContext, useContext, useMemo, useEffect } from 'react';
import { calculateAssets } from '../utils/portfolioCalculations';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { Transaction, Asset, AssetClass, PortfolioSummary, AssetSubClass, Portfolio, AssetDefinition, Broker, MacroAllocation, GoalAllocation } from '../types';

// Legacy Type for Migration
type Target = AssetDefinition & { targetPercentage?: number };

interface PortfolioContextType {
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    assets: Asset[];
    portfolios: Portfolio[];
    brokers: Broker[];
    summary: PortfolioSummary;
    macroAllocations: MacroAllocation;
    goalAllocations: GoalAllocation;
    addTransaction: (transaction: Transaction) => void;
    updateTransaction: (transaction: Transaction) => void;
    deleteTransaction: (id: string) => void;
    updateAssetSettings: (ticker: string, source?: 'ETF' | 'MOT' | 'CPRAM', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => void;
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
    // Deprecated accessors for compatibility during transition
    targets: AssetDefinition[];
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
    const [marketData, setMarketData] = useLocalStorage<Record<string, { price: number, lastUpdated: string }>>('portfolio_market_data', {});

    // New State for Macro/Goal Targets
    const [macroAllocations, setMacroAllocations] = useLocalStorage<MacroAllocation>('portfolio_macro_targets', {});
    const [goalAllocations, setGoalAllocations] = useLocalStorage<GoalAllocation>('portfolio_goal_targets', {});

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
                    description: 'Migrated from transaction'
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
                    allocations: {}
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

    const updateMarketData = (ticker: string, price: number, lastUpdated: string) => {
        setMarketData(prev => ({
            ...prev,
            [ticker.toUpperCase()]: { price, lastUpdated }
        }));
    };

    const addPortfolio = (portfolio: Portfolio) => {
        setPortfolios(prev => [...prev, portfolio]);
    };

    const updatePortfolio = (portfolio: Portfolio) => {
        setPortfolios(prev => prev.map(p => p.id === portfolio.id ? portfolio : p));
    };

    const deletePortfolio = (id: string) => {
        const portfolioToDelete = portfolios.find(p => p.id === id);
        const nameToDelete = portfolioToDelete?.name;

        setPortfolios(prev => prev.filter(p => p.id !== id));
        // Also clear the legacy 'portfolio' field to prevent the migration effect from re-creating it
        setTransactions(prev => prev.map(t =>
            (t.portfolioId === id || (nameToDelete && (t as any).portfolio === nameToDelete))
                ? { ...t, portfolioId: undefined, portfolio: undefined } as any
                : t
        ));
    };

    const addBroker = (broker: Broker) => {
        setBrokers(prev => [...prev, broker]);
    };

    const updateBroker = (broker: Broker) => {
        setBrokers(prev => prev.map(b => b.id === broker.id ? broker : b));
    };

    const deleteBroker = (id: string) => {
        setBrokers(prev => prev.filter(b => b.id !== id));
    };

    const addTransaction = (transaction: Transaction) => {
        setTransactions((prev) => [...prev, transaction]);
    };

    const deleteTransaction = (id: string) => {
        setTransactions((prev) => prev.filter((t) => t.id !== id));
    };

    const updateAssetSettings = (ticker: string, source?: 'ETF' | 'MOT' | 'CPRAM', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => {
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
        setOldTargets([]);
        setMacroAllocations({});
        setGoalAllocations({});
    };

    const refreshPrices = async () => {
        // Dynamic import to avoid circular dependency
        const { fetchAssetPrices } = await import('../services/marketData');

        // Get unique tickers from both transactions and assetSettings
        const uniqueTickers = Array.from(new Set([
            ...transactions.map(t => t.ticker),
            ...assetSettings.map(a => a.ticker)
        ]));

        if (uniqueTickers.length === 0) return;

        // Prepare tokens
        const tokens = uniqueTickers.map(ticker => {
            const setting = assetSettings.find(t => t.ticker === ticker);
            return {
                isin: ticker,
                source: setting?.source || 'ETF'
            };
        });

        try {
            const results = await fetchAssetPrices(tokens as any);
            const errors: string[] = [];

            results.forEach(res => {
                if (res.success && res.data) {
                    updateMarketData(res.isin, res.data.currentPrice, res.data.lastUpdated);
                } else {
                    errors.push(`${res.isin}: ${res.error || 'Unknown error'}`);
                }
            });

            if (errors.length > 0) {
                const Swal = (await import('sweetalert2')).default;
                Swal.fire({
                    icon: 'error',
                    title: 'Price Update Issues',
                    html: `Some assets failed to update:<br/><ul style="text-align:left; font-size:0.9em;">${errors.map(e => `<li>${e}</li>`).join('')}</ul>`,
                    confirmButtonColor: '#d33'
                });
            } else {
                const Swal = (await import('sweetalert2')).default;
                Swal.fire({
                    icon: 'success',
                    title: 'Prices Updated',
                    text: 'All asset prices have been successfully updated.',
                    timer: 2000,
                    showConfirmButton: false
                });
            }

        } catch (err: any) {
            console.error('Bulk update failed', err);
            const Swal = (await import('sweetalert2')).default;
            Swal.fire({
                icon: 'error',
                title: 'Update Failed',
                text: 'Could not fetch prices. Check server connection.',
                confirmButtonColor: '#d33'
            });
        }
    };

    // Derive Assets and Summary
    const { assets, summary } = useMemo(() => {
        // Dynamic import to avoid circular dependency if any, though likely safe.
        // Actually we can import it directly at top level if no circular dependency, 
        // but let's assume valid scope.
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
        const mockPortfolioId = 'mock-p1';
        const mockPortfolioId2 = 'mock-p2';

        const mockIsins = [
            // Growth Portfolio Assets
            { ticker: 'IE00B4L5Y983', name: 'iShares Core MSCI World', class: 'Stock', subClass: 'International', type: 'ETF' },
            { ticker: 'IE00BKM4GZ66', name: 'iShares Core MSCI EM IMI', class: 'Stock', subClass: 'International', type: 'ETF' },
            { ticker: 'IE00BDBRDM35', name: 'iShares Glb Agg Bond EUR-H', class: 'Bond', subClass: 'International', type: 'ETF' },
            // Emergency Fund Assets (Money Market)
            { ticker: 'LU0290358497', name: 'Xtrackers II EUR Overnight Rate Swap', class: 'Cash', subClass: 'Local', type: 'ETF' }, // XEON
            { ticker: 'LU1190417599', name: 'Lyxor Smart Overnight Return', class: 'Cash', subClass: 'Local', type: 'ETF' } // CSH2
        ];

        // Mock Transactions
        const initialTransactions: any[] = [
            // Growth Portfolio
            { id: String(Date.now() + 1), portfolioId: mockPortfolioId, ticker: mockIsins[0].ticker, date: '2024-01-15', amount: 50, price: 88.50, direction: 'Buy', broker: 'Degiro' },
            { id: String(Date.now() + 2), portfolioId: mockPortfolioId, ticker: mockIsins[1].ticker, date: '2024-02-20', amount: 100, price: 29.30, direction: 'Buy', broker: 'Degiro' },
            { id: String(Date.now() + 3), portfolioId: mockPortfolioId, ticker: mockIsins[2].ticker, date: '2024-03-10', amount: 200, price: 4.95, direction: 'Buy', broker: 'Trade Republic' },
            { id: String(Date.now() + 4), portfolioId: mockPortfolioId, ticker: mockIsins[0].ticker, date: '2024-06-15', amount: 20, price: 92.10, direction: 'Buy', broker: 'Degiro' },
            // Emergency Fund
            { id: String(Date.now() + 5), portfolioId: mockPortfolioId2, ticker: mockIsins[3].ticker, date: '2024-01-10', amount: 10, price: 140.20, direction: 'Buy', broker: 'Directa' },
            { id: String(Date.now() + 6), portfolioId: mockPortfolioId2, ticker: mockIsins[4].ticker, date: '2024-01-10', amount: 12, price: 119.50, direction: 'Buy', broker: 'Directa' },
        ];

        // Mock Asset Settings
        const initialSettings: AssetDefinition[] = mockIsins.map(m => ({
            ticker: m.ticker,
            source: 'ETF',
            label: m.name,
            assetClass: m.class as any,
            assetSubClass: m.subClass as any
        }));

        // Mock Allocations
        const growthAllocations = {
            [mockIsins[0].ticker]: 60,
            [mockIsins[1].ticker]: 10,
            [mockIsins[2].ticker]: 30
        };

        const emergencyAllocations = {
            [mockIsins[3].ticker]: 60,
            [mockIsins[4].ticker]: 40
        };

        setTransactions(initialTransactions);
        setAssetSettings(initialSettings);

        // Update or Create Portfolios
        const mockGrowthPortfolio: Portfolio = {
            id: mockPortfolioId,
            name: 'Growth Portfolio',
            description: 'Mock Data Portfolio',
            allocations: growthAllocations
        };

        const mockEmergencyPortfolio: Portfolio = {
            id: mockPortfolioId2,
            name: 'Emergency Fund',
            description: 'Low risk liquidity',
            allocations: emergencyAllocations
        };

        // Replace portfolios to match the new transactions
        setPortfolios([mockGrowthPortfolio, mockEmergencyPortfolio]);

        // Soft mock prices so dashboard looks good immediately
        const mockPrices = {
            [mockIsins[0].ticker]: { price: 96.20, lastUpdated: timestamp },
            [mockIsins[1].ticker]: { price: 31.50, lastUpdated: timestamp },
            [mockIsins[2].ticker]: { price: 5.05, lastUpdated: timestamp },
            [mockIsins[3].ticker]: { price: 142.50, lastUpdated: timestamp },
            [mockIsins[4].ticker]: { price: 121.10, lastUpdated: timestamp }
        };
        setMarketData(mockPrices);
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
        brokers,
        addBroker,
        updateBroker,
        deleteBroker
    };

    return (
        <PortfolioContext.Provider value={value}>
            {children}
        </PortfolioContext.Provider>
    );
};
