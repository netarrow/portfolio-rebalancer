import React, { createContext, useContext, useMemo } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import type { Transaction, Asset, Target, TransactionType, PortfolioSummary } from '../types';

interface PortfolioContextType {
    transactions: Transaction[];
    targets: Target[];
    assets: Asset[];
    summary: PortfolioSummary;
    addTransaction: (transaction: Transaction) => void;
    deleteTransaction: (id: string) => void;
    updateTarget: (ticker: string, percentage: number) => void;
    refreshPrices: () => Promise<void>;
    resetPortfolio: () => void;
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

    const updateTarget = (ticker: string, percentage: number) => {
        setTargets((prev) => {
            // Ensure specific ticker is updated, or add if missing
            const exists = prev.find(t => t.ticker === ticker);

            if (percentage === 0) {
                // Remove target if 0 (cleanup)
                return prev.filter(t => t.ticker !== ticker);
            }

            if (exists) {
                return prev.map(t => t.ticker === ticker ? { ...t, targetPercentage: percentage } : t);
            }
            return [...prev, { ticker, targetPercentage: percentage }];
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
            const data = await fetchAssetPrice(ticker);
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
                    newAveragePrice = ((existing.quantity * existing.averagePrice) + (tx.amount * tx.price)) / totalQuantity;
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
                assetMap.set(ticker, {
                    ticker: ticker,
                    type: tx.type,
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

            const currentValue = asset.quantity * effectivePrice;
            const totalCost = asset.quantity * asset.averagePrice;
            const gain = currentValue - totalCost;
            const gainPercentage = totalCost !== 0 ? (gain / totalCost) * 100 : 0;

            return {
                ...asset,
                currentPrice: effectivePrice,
                currentValue: currentValue,
                lastUpdated,
                gain,
                gainPercentage
            };
        });

        // Calculate totals
        const totalValue = assetsList.reduce((sum, asset) => sum + asset.currentValue, 0);
        const totalCost = assetsList.reduce((sum, asset) => sum + (asset.quantity * asset.averagePrice), 0);
        const totalGain = totalValue - totalCost;
        const totalGainPercentage = totalCost !== 0 ? (totalGain / totalCost) * 100 : 0;

        // Calculate allocation
        const allocationByType: { [key in TransactionType]: number } = {
            'ETF': 0,
            'Bond': 0
        };

        assetsList.forEach(asset => {
            allocationByType[asset.type] += asset.currentValue;
        });

        // Convert to percentage
        const etfPerc = totalValue > 0 ? (allocationByType['ETF'] / totalValue) * 100 : 0;
        const bondPerc = totalValue > 0 ? (allocationByType['Bond'] / totalValue) * 100 : 0;

        const summaryData: PortfolioSummary = {
            totalValue,
            totalCost,
            allocation: {
                'ETF': etfPerc,
                'Bond': bondPerc
            },
            totalGain,
            totalGainPercentage
        };

        return { assets: assetsList, summary: summaryData };
    }, [transactions, marketData]);

    const value = {
        transactions,
        targets,
        assets,
        summary,
        addTransaction,
        deleteTransaction,
        updateTarget,
        refreshPrices,
        resetPortfolio
    };

    return (
        <PortfolioContext.Provider value={value}>
            {children}
        </PortfolioContext.Provider>
    );
};
