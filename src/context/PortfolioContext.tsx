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
            if (exists) {
                return prev.map(t => t.ticker === ticker ? { ...t, targetPercentage: percentage } : t);
            }
            return [...prev, { ticker, targetPercentage: percentage }];
        });
    };

    const resetPortfolio = () => {
        setTransactions([]);
        setTargets(DEFAULT_TARGETS);
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
                    currentValue: newQuantity * (existing.currentPrice || newAveragePrice), // Use last known price or new Avg? Ideally we should have a separate "Current Price" user input. For now assume Current Price = Last Buy Price or Avg Price is flawed. 
                    // Let's assume for MVP: Value = Quantity * Last Known Price. 
                    // Check if this tx has a price. If it's a Buy/Sell at market, maybe that's the new "Current Price"?
                    currentPrice: tx.price // Update current market price to latest transaction price
                });
            } else {
                // New asset
                // If first tx is Sell, we have negative quantity. Allowed.
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

        // Update current values based on final quantity * last seen price
        // Note: The loop above updates currentValue incrementally, but we should probably recalc at the end if we want "Latest Price" to apply to ALL quantity.
        // Let's do a second pass or just ensure the stored Asset has the "Latest Price" from the sort order?
        // Transactions are usually appended. So last one is latest.

        // Better approach: Calculate stats after processing all txs
        const assetsList = Array.from(assetMap.values()).map(asset => ({
            ...asset,
            currentValue: asset.quantity * (asset.currentPrice || asset.averagePrice)
        }));

        // Calculate totals
        const totalValue = assetsList.reduce((sum, asset) => sum + asset.currentValue, 0);
        const totalCost = assetsList.reduce((sum, asset) => sum + (asset.quantity * asset.averagePrice), 0);

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
            }
        };

        return { assets: assetsList, summary: summaryData };
    }, [transactions]);

    const value = {
        transactions,
        targets,
        assets,
        summary,
        addTransaction,
        deleteTransaction,
        updateTarget,
        resetPortfolio
    };

    return (
        <PortfolioContext.Provider value={value}>
            {children}
        </PortfolioContext.Provider>
    );
};
