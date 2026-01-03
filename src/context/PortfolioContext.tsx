import React, { createContext, useContext, useMemo, useEffect } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { Transaction, Asset, Target, AssetClass, PortfolioSummary, AssetSubClass } from '../types';

interface PortfolioContextType {
    transactions: Transaction[];
    targets: Target[];
    assets: Asset[];
    summary: PortfolioSummary;
    addTransaction: (transaction: Transaction) => void;
    updateTransaction: (transaction: Transaction) => void;
    deleteTransaction: (id: string) => void;
    updateTarget: (ticker: string, percentage: number, source?: 'ETF' | 'MOT', label?: string, assetClass?: AssetClass, assetSubClass?: AssetSubClass) => void;
    updateTransactionsBulk: (ids: string[], updates: Partial<Transaction>) => void;
    refreshPrices: () => Promise<void>;
    resetPortfolio: () => void;
    loadMockData: () => void;
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
    const [marketData, setMarketData] = useLocalStorage<Record<string, { price: number, lastUpdated: string }>>('portfolio_market_data', {});

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
        const assetMap = new Map<string, Asset>();

        // Process transactions to build assets
        transactions.forEach(tx => {
            // normalize ticker
            const ticker = tx.ticker.toUpperCase();
            const existing = assetMap.get(ticker);

            // Default to Buy if undefined (migration safety)
            const direction = tx.direction || 'Buy';

            if (existing) {
                let newQuantity = existing.quantity;
                let newAveragePrice = existing.averagePrice;

                if (direction === 'Buy') {
                    const totalQuantity = existing.quantity + tx.amount;
                    // Weighted Average Price
                    if (totalQuantity !== 0) {
                        newAveragePrice = ((existing.quantity * existing.averagePrice) + (tx.amount * tx.price)) / totalQuantity;
                    } else {
                        newAveragePrice = 0;
                    }
                    newQuantity = totalQuantity;
                } else {
                    // Sell
                    newQuantity = existing.quantity - tx.amount;
                    // Average Price doesn't change on Sell
                }

                assetMap.set(ticker, {
                    ...existing,
                    quantity: newQuantity,
                    averagePrice: newAveragePrice,
                    // Temporary currentValue, updated below
                    currentValue: newQuantity * existing.averagePrice,
                    currentPrice: tx.price
                });
            } else {
                // New asset
                const quantity = direction === 'Buy' ? tx.amount : -tx.amount;
                // Fetch class from target logic will be done in the next step (assetsList mapping)
                // But we need a placeholder here for the map.
                assetMap.set(ticker, {
                    ticker: ticker,
                    label: undefined, // Will be filled below if target exists
                    assetClass: 'Stock', // Default, superseded by target below
                    assetSubClass: 'International', // Default
                    quantity: quantity,
                    averagePrice: tx.price,
                    currentValue: quantity * tx.price,
                    currentPrice: tx.price
                });
            }
        });

        // Calculate final stats using Market Data if available
        const assetsList = Array.from(assetMap.values()).map(asset => {
            // Prefer market data if available
            const marketInfo = marketData[asset.ticker];
            const effectivePrice = marketInfo ? marketInfo.price : (asset.currentPrice || asset.averagePrice);
            const lastUpdated = marketInfo ? marketInfo.lastUpdated : undefined;

            // Inject data from target
            const target = targets.find(t => t.ticker === asset.ticker);
            const label = target?.label;
            const assetClass = target?.assetClass || 'Stock';
            const assetSubClass = target?.assetSubClass || 'International';

            const currentValue = asset.quantity * effectivePrice;
            const totalCost = asset.quantity * asset.averagePrice;
            const gain = currentValue - totalCost;
            const gainPercentage = totalCost !== 0 ? (gain / totalCost) * 100 : 0;

            return {
                ...asset,
                label,
                assetClass,
                assetSubClass,
                currentPrice: effectivePrice,
                currentValue: currentValue,
                lastUpdated,
                gain,
                gainPercentage
            };
        });

        // Calculate totals
        const totalValue = assetsList.reduce((sum, asset) => sum + (asset.currentValue || 0), 0);
        const totalCost = assetsList.reduce((sum, asset) => sum + (asset.quantity * asset.averagePrice || 0), 0);
        const totalGain = totalValue - totalCost;
        const totalGainPercentage = totalCost !== 0 ? (totalGain / totalCost) * 100 : 0;

        // Calculate allocation
        const allocation: { [key in AssetClass]?: number } = {
            'Stock': 0,
            'Bond': 0,
            'Commodity': 0,
            'Crypto': 0
        };

        assetsList.forEach(asset => {
            if (allocation[asset.assetClass] !== undefined) {
                allocation[asset.assetClass]! += asset.currentValue;
            }
        });

        // Convert to percentage
        if (totalValue > 0) {
            (Object.keys(allocation) as AssetClass[]).forEach(key => {
                allocation[key] = (allocation[key]! / totalValue) * 100;
            });
        }

        const summaryData: PortfolioSummary = {
            totalValue,
            totalCost,
            allocation,
            totalGain,
            totalGainPercentage
        };

        return { assets: assetsList, summary: summaryData };
    }, [transactions, marketData]);

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
        loadMockData
    };

    return (
        <PortfolioContext.Provider value={value}>
            {children}
        </PortfolioContext.Provider>
    );
};
