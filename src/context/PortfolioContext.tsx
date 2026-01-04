import React, { createContext, useContext, useMemo, useEffect } from 'react';
import { calculateAssets } from '../utils/portfolioCalculations';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { Transaction, Asset, Target, AssetClass, PortfolioSummary, AssetSubClass, Portfolio } from '../types';

interface PortfolioContextType {
    transactions: Transaction[];
    targets: Target[];
    assets: Asset[];
    portfolios: Portfolio[];
    summary: PortfolioSummary;
    addTransaction: (transaction: Transaction) => void;
    updateTransaction: (transaction: Transaction) => void;
    deleteTransaction: (id: string) => void;
    updateTarget: (ticker: string, percentage: number, source?: 'ETF' | 'MOT', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => void;
    updateTransactionsBulk: (ids: string[], updates: Partial<Transaction>) => void;
    refreshPrices: () => Promise<void>;
    resetPortfolio: () => void;
    loadMockData: () => void;
    marketData: Record<string, { price: number, lastUpdated: string }>;
    addPortfolio: (portfolio: Portfolio) => void;
    updatePortfolio: (portfolio: Portfolio) => void;
    deletePortfolio: (id: string) => void;
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
const DEFAULT_TARGETS: Target[] = [];

export const PortfolioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [transactions, setTransactions] = useLocalStorage<Transaction[]>('portfolio_transactions', []);
    const [targets, setTargets] = useLocalStorage<Target[]>('portfolio_targets_v2', DEFAULT_TARGETS);
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

    // Migration Effect 2: Move assetClass/assetSubClass from Transactions to Targets
    useEffect(() => {
        let targetsChanged = false;
        const newTargets = [...targets];

        const uniqueTickers = Array.from(new Set(transactions.map(t => t.ticker)));

        uniqueTickers.forEach(ticker => {
            const targetIndex = newTargets.findIndex(t => t.ticker === ticker);
            // Look for existing class in transactions (take last one as source of truth)
            const lastTx = [...transactions].reverse().find(t => t.ticker === ticker && (t.assetClass as any));

            if (lastTx && (lastTx.assetClass as any)) {
                if (targetIndex === -1) {
                    // Create new target if missing, with migrated class
                    newTargets.push({
                        ticker,
                        targetPercentage: 0,
                        source: 'ETF',
                        assetClass: lastTx.assetClass as AssetClass,
                        assetSubClass: lastTx.assetSubClass as AssetSubClass
                    });
                    targetsChanged = true;
                    console.log(`Migrated class for ${ticker}: ${lastTx.assetClass}`);
                } else {
                    // Update existing target if missing class
                    if (!newTargets[targetIndex].assetClass) {
                        newTargets[targetIndex] = {
                            ...newTargets[targetIndex],
                            assetClass: lastTx.assetClass as AssetClass,
                            assetSubClass: lastTx.assetSubClass as AssetSubClass
                        };
                        targetsChanged = true;
                        console.log(`Updated class for ${ticker}: ${lastTx.assetClass}`);
                    }
                }
            }
        });

        if (targetsChanged) {
            setTargets(newTargets);
        }
    }, [transactions, targets, setTargets]);

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

    const updateTarget = (ticker: string, percentage: number, source?: 'ETF' | 'MOT', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => {
        setTargets((prev) => {
            // Ensure specific ticker is updated, or add if missing
            const exists = prev.find(t => t.ticker === ticker);

            if (percentage === 0 && (!source || source === 'ETF') && !label && !assetClass) {
                // Remove target only if 0, source is default, AND NO LABEL/CLASS (cleanup)
                return prev.filter(t => t.ticker !== ticker);
            }

            if (exists) {
                return prev.map(t => t.ticker === ticker ? {
                    ...t,
                    targetPercentage: percentage,
                    source: source || t.source,
                    label: label !== undefined ? label : t.label, // Update label if provided
                    assetClass: assetClass || t.assetClass,
                    assetSubClass: assetSubClass || t.assetSubClass
                } : t);
            }
            return [...prev, { ticker, targetPercentage: percentage, source: source || 'ETF', label, assetClass, assetSubClass }];
        });
    };

    const resetPortfolio = () => {
        setTransactions([]);
        setTargets(DEFAULT_TARGETS);
        setPortfolios([]);
        setMarketData({});
    };

    const refreshPrices = async () => {
        // Dynamic import to avoid circular dependency if any, though likely safe.
        // Also cleaner separation.
        const { fetchAssetPrice } = await import('../services/marketData');

        // Get unique tickers
        const uniqueTickers = Array.from(new Set(transactions.map(t => t.ticker)));

        await Promise.all(uniqueTickers.map(async (ticker) => {
            // Find target source if available
            const target = targets.find(t => t.ticker === ticker);
            const source = target?.source || 'ETF';

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
        return calculateAssets(transactions, targets, marketData);
    }, [transactions, targets, marketData]);

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

        // Mock Targets
        const initialTargets: Target[] = [
            { ticker: mockIsins[0].ticker, targetPercentage: 60, source: 'ETF', label: mockIsins[0].name, assetClass: 'Stock', assetSubClass: 'International' },
            { ticker: mockIsins[1].ticker, targetPercentage: 10, source: 'ETF', label: mockIsins[1].name, assetClass: 'Stock', assetSubClass: 'International' },
            { ticker: mockIsins[2].ticker, targetPercentage: 30, source: 'ETF', label: mockIsins[2].name, assetClass: 'Bond', assetSubClass: 'International' },
        ];

        setTransactions(initialTransactions);
        setTargets(initialTargets);

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
        targets,
        assets,
        summary,
        addTransaction,
        updateTransaction,
        updateTransactionsBulk,
        deleteTransaction,
        updateTarget,
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
