import React, { createContext, useContext, useMemo, useEffect } from 'react';
import { calculateAssets } from '../utils/portfolioCalculations';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { Transaction, Asset, Target, AssetClass, PortfolioSummary, AssetSubClass, Portfolio, AssetDefinition } from '../types';

interface PortfolioContextType {
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    assets: Asset[];
    portfolios: Portfolio[];
    summary: PortfolioSummary;
    addTransaction: (transaction: Transaction) => void;
    updateTransaction: (transaction: Transaction) => void;
    deleteTransaction: (id: string) => void;
    updateAssetSettings: (ticker: string, source?: 'ETF' | 'MOT', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => void;
    updatePortfolioAllocation: (portfolioId: string, ticker: string, percentage: number) => void;
    updateTransactionsBulk: (ids: string[], updates: Partial<Transaction>) => void;
    refreshPrices: () => Promise<void>;
    resetPortfolio: () => void;
    loadMockData: () => void;
    marketData: Record<string, { price: number, lastUpdated: string }>;
    addPortfolio: (portfolio: Portfolio) => void;
    updatePortfolio: (portfolio: Portfolio) => void;
    deletePortfolio: (id: string) => void;
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
    const [marketData, setMarketData] = useLocalStorage<Record<string, { price: number, lastUpdated: string }>>('portfolio_market_data', {});

    // Migration Effect 3: Migrate free-text portfolios to Portfolio entities
    useEffect(() => {
        let portfoliosChanged = false;
        let transactionsChanged = false;
        const newPortfolios = [...portfolios];
        const newTransactions = [...transactions];

        const uniquePortfolioNames = Array.from(new Set(transactions.map(t => t.portfolio).filter(Boolean))) as string[];

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
            if (t.portfolio && !t.portfolioId) {
                const portfolio = newPortfolios.find(p => p.name === t.portfolio);
                if (portfolio) {
                    newTransactions[index] = {
                        ...t,
                        portfolioId: portfolio.id
                        // We keep t.portfolio for now or could clear it. 
                        // Keeping it for safety but portfolioId is the new source of truth for the relationship.
                    };
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
            const lastTx = [...transactions].reverse().find(t => t.ticker === ticker && (t.assetClass as any));

            if (lastTx && (lastTx.assetClass as any)) {
                if (settingIndex === -1) {
                    newSettings.push({
                        ticker,
                        source: 'ETF',
                        assetClass: lastTx.assetClass as AssetClass,
                        assetSubClass: lastTx.assetSubClass as AssetSubClass
                    });
                    settingsChanged = true;
                } else {
                    if (!newSettings[settingIndex].assetClass) {
                        newSettings[settingIndex] = {
                            ...newSettings[settingIndex],
                            assetClass: lastTx.assetClass as AssetClass,
                            assetSubClass: lastTx.assetSubClass as AssetSubClass
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
        setPortfolios(prev => prev.filter(p => p.id !== id));
        // Optional: Remove portfolioId from transactions? Or keep as orphan? 
        // For strict integrity, we should probably unset it.
        setTransactions(prev => prev.map(t => t.portfolioId === id ? { ...t, portfolioId: undefined } : t));
    };

    const addTransaction = (transaction: Transaction) => {
        setTransactions((prev) => [...prev, transaction]);
    };

    const deleteTransaction = (id: string) => {
        setTransactions((prev) => prev.filter((t) => t.id !== id));
    };

    const updateAssetSettings = (ticker: string, source?: 'ETF' | 'MOT', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => {
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
        setPortfolios([]);
        setMarketData({});
        setOldTargets([]);
    };

    const refreshPrices = async () => {
        // Dynamic import to avoid circular dependency if any, though likely safe.
        // Also cleaner separation.
        const { fetchAssetPrice } = await import('../services/marketData');

        // Get unique tickers
        const uniqueTickers = Array.from(new Set(transactions.map(t => t.ticker)));

        await Promise.all(uniqueTickers.map(async (ticker) => {
            // Find asset setting source if available
            const setting = assetSettings.find(t => t.ticker === ticker);
            const source = setting?.source || 'ETF';

            const data = await fetchAssetPrice(ticker, source);
            if (data) {
                updateMarketData(ticker, data.currentPrice, data.lastUpdated);
            }
        }));
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
        const mockIsins = [
            { ticker: 'IE00B4L5Y983', name: 'iShares Core MSCI World', class: 'Stock', subClass: 'International', type: 'ETF' },
            { ticker: 'IE00BKM4GZ66', name: 'iShares Core MSCI EM IMI', class: 'Stock', subClass: 'International', type: 'ETF' },
            { ticker: 'IE00BDBRDM35', name: 'iShares Glb Agg Bond EUR-H', class: 'Bond', subClass: 'International', type: 'ETF' }
        ];

        // Mock Transactions
        const initialTransactions: Transaction[] = [
            { id: String(Date.now() + 1), ticker: mockIsins[0].ticker, date: '2023-01-15', amount: 50, price: 78.50, direction: 'Buy' },
            { id: String(Date.now() + 2), ticker: mockIsins[1].ticker, date: '2023-02-20', amount: 100, price: 28.30, direction: 'Buy' },
            { id: String(Date.now() + 3), ticker: mockIsins[2].ticker, date: '2023-03-10', amount: 200, price: 4.88, direction: 'Buy' },
            { id: String(Date.now() + 4), ticker: mockIsins[0].ticker, date: '2023-06-15', amount: 20, price: 82.10, direction: 'Buy' },
        ];

        // Mock Asset Settings
        const initialSettings: AssetDefinition[] = [
            { ticker: mockIsins[0].ticker, source: 'ETF', label: mockIsins[0].name, assetClass: 'Stock', assetSubClass: 'International' },
            { ticker: mockIsins[1].ticker, source: 'ETF', label: mockIsins[1].name, assetClass: 'Stock', assetSubClass: 'International' },
            { ticker: mockIsins[2].ticker, source: 'ETF', label: mockIsins[2].name, assetClass: 'Bond', assetSubClass: 'International' },
        ];

        // Mock Allocations (Apply to a default portfolio or create one)
        const mockAllocations = {
            [mockIsins[0].ticker]: 60,
            [mockIsins[1].ticker]: 10,
            [mockIsins[2].ticker]: 30
        };

        setTransactions(initialTransactions);
        setAssetSettings(initialSettings);

        // Ensure at least one portfolio exists with these allocations
        if (portfolios.length === 0) {
            setPortfolios([{
                id: 'mock-p1',
                name: 'Growth Portfolio',
                description: 'Mock Data Portfolio',
                allocations: mockAllocations
            }]);
        } else {
            // Update first portfolio
            const p = portfolios[0];
            updatePortfolio({ ...p, allocations: mockAllocations });
        }

        // Soft mock prices so dashboard looks good immediately
        const mockPrices = {
            [mockIsins[0].ticker]: { price: 85.20, lastUpdated: timestamp },
            [mockIsins[1].ticker]: { price: 29.50, lastUpdated: timestamp },
            [mockIsins[2].ticker]: { price: 4.95, lastUpdated: timestamp }
        };
        setMarketData(mockPrices);
    };

    const value = {
        transactions,
        targets: assetSettings, // Expose as targets for compatibility
        assetSettings,
        assets,
        summary,
        addTransaction,
        updateTransaction,
        updateTransactionsBulk,
        deleteTransaction,
        updateTarget,
        updateAssetSettings,
        updatePortfolioAllocation,
        refreshPrices,
        resetPortfolio,
        loadMockData,
        marketData,
        portfolios,
        addPortfolio,
        updatePortfolio,
        deletePortfolio
    };

    return (
        <PortfolioContext.Provider value={value}>
            {children}
        </PortfolioContext.Provider>
    );
};
