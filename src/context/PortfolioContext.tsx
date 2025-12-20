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
    updateTarget: (type: TransactionType, percentage: number) => void;
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
const DEFAULT_TARGETS: Target[] = [
    { type: 'ETF', targetPercentage: 60 },
    { type: 'Bond', targetPercentage: 40 },
];

export const PortfolioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [transactions, setTransactions] = useLocalStorage<Transaction[]>('portfolio_transactions', []);
    const [targets, setTargets] = useLocalStorage<Target[]>('portfolio_targets', DEFAULT_TARGETS);

    const addTransaction = (transaction: Transaction) => {
        setTransactions((prev) => [...prev, transaction]);
    };

    const deleteTransaction = (id: string) => {
        setTransactions((prev) => prev.filter((t) => t.id !== id));
    };

    const updateTarget = (type: TransactionType, percentage: number) => {
        setTargets((prev) => {
            // Ensure specific type is updated, or add if missing
            const exists = prev.find(t => t.type === type);
            if (exists) {
                return prev.map(t => t.type === type ? { ...t, targetPercentage: percentage } : t);
            }
            return [...prev, { type, targetPercentage: percentage }];
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
            const existing = assetMap.get(tx.ticker);
            if (existing) {
                // Update existing asset
                const totalQuantity = existing.quantity + tx.amount;
                // Average price calculation (simplified: weighted average)
                // formula: (oldQty * oldAvg + newQty * newPrice) / totalQty
                const newAveragePrice = ((existing.quantity * existing.averagePrice) + (tx.amount * tx.price)) / totalQuantity;

                assetMap.set(tx.ticker, {
                    ...existing,
                    quantity: totalQuantity,
                    averagePrice: newAveragePrice,
                    currentValue: totalQuantity * (existing.currentPrice || newAveragePrice), // Using last known price or avg
                });
            } else {
                // New asset
                assetMap.set(tx.ticker, {
                    ticker: tx.ticker,
                    type: tx.type,
                    quantity: tx.amount,
                    averagePrice: tx.price,
                    currentValue: tx.amount * tx.price,
                    currentPrice: tx.price
                });
            }
        });

        const assetsList = Array.from(assetMap.values());

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
