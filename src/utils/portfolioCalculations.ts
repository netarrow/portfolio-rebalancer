import type { Transaction, Asset, PortfolioSummary, AssetClass, AssetDefinition } from '../types';

export const calculateAssets = (
    transactions: Transaction[],
    targets: AssetDefinition[],
    marketData: Record<string, { price: number; lastUpdated: string }>
): { assets: Asset[], summary: PortfolioSummary } => {
    const assetMap = new Map<string, Asset>();

    // Process transactions to build assets
    transactions.forEach(tx => {
        // normalize ticker
        const ticker = tx.ticker.toUpperCase();
        const existing = assetMap.get(ticker);

        // Default to Buy if undefined (migration safety)
        const direction = tx.direction || 'Buy';

        // Ensure numbers
        const amount = Number(tx.amount);
        const price = Number(tx.price);

        if (existing) {
            let newQuantity = existing.quantity;
            let newAveragePrice = existing.averagePrice;

            if (direction === 'Buy') {
                const totalQuantity = existing.quantity + amount;
                // Weighted Average Price
                if (totalQuantity !== 0) {
                    newAveragePrice = ((existing.quantity * existing.averagePrice) + (amount * price)) / totalQuantity;
                } else {
                    newAveragePrice = 0;
                }
                newQuantity = totalQuantity;
            } else {
                // Sell
                newQuantity = existing.quantity - amount;
                // Average Price doesn't change on Sell
            }

            assetMap.set(ticker, {
                ...existing,
                quantity: newQuantity,
                averagePrice: newAveragePrice,
                // Temporary currentValue, updated below
                currentValue: newQuantity * existing.averagePrice,
                currentPrice: price
            });
        } else {
            // New asset
            const quantity = direction === 'Buy' ? amount : -amount;
            // Fetch class from target logic will be done in the next step (assetsList mapping)
            // But we need a placeholder here for the map.
            assetMap.set(ticker, {
                ticker: ticker,
                label: undefined, // Will be filled below if target exists
                assetClass: 'Stock', // Default, superseded by target below
                assetSubClass: 'International', // Default
                quantity: quantity,
                averagePrice: price,
                currentValue: quantity * price,
                currentPrice: price
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
            currentValue,
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
};

export const calculatePortfolioPerformance = (
    transactions: Transaction[],
    marketData: Record<string, { price: number; lastUpdated: string }>
): {
    totalValue: number;
    totalCost: number;
    totalGain: number;
    totalGainPercentage: number;
    cagr: number;
    yearsElapsed: number;
} => {
    if (transactions.length === 0) {
        return { totalValue: 0, totalCost: 0, totalGain: 0, totalGainPercentage: 0, cagr: 0, yearsElapsed: 0 };
    }

    // 1. Calculate Value and Cost
    // We can reuse calculateAssets but we need to pass temporary targets (empty or minimal)
    // because we just need sums, we don't need classification.
    const { summary } = calculateAssets(transactions, [], marketData);

    // 2. Find duration
    const dates = transactions.map(t => new Date(t.date).getTime());
    const minDate = Math.min(...dates);
    const now = Date.now();

    // Avoid division by zero or negative time
    const diffMs = now - minDate;
    // Floor at 1 day to prevent infinity
    const daysElapsed = Math.max(1, diffMs / (1000 * 60 * 60 * 24));
    const yearsElapsed = daysElapsed / 365.25;

    // 3. Calculate CAGR
    // Formula: (End/Start)^(1/n) - 1
    // But we have DCA (multiple inflows). 
    // True CAGR/XIRR is complex. 
    // Approx: Total Gain % / Years? No.
    // Approx for DCA: (CurrentValue / TotalInvested)^(1/Years) - 1? 
    // This assumes all money was there at start (underestimates return if invested recently).
    // Let's stick to a simple Annualized Return = TotalReturn% / Years. 
    // It's not mathematically perfect compounding (Simple Annual Interest), but easier to explain.
    // Wait, simple interest is (Gain/Cost) / Years.
    // Compound: (1 + Gain/Cost) ^ (1/Years) - 1.

    let cagr = 0;
    if (summary.totalCost > 0) {
        const absoluteReturn = summary.totalGain / summary.totalCost; // e.g. 0.10 for 10%

        if (yearsElapsed < 1) {
            // If less than a year, don't annualize (too volatile). Return absolute.
            cagr = absoluteReturn;
        } else {
            // Annualize
            cagr = Math.pow(1 + absoluteReturn, 1 / yearsElapsed) - 1;
        }
    }

    // Sanity caps? -90% to +500%?
    // Let's leave it raw for now.

    return {
        totalValue: summary.totalValue,
        totalCost: summary.totalCost,
        totalGain: summary.totalGain,
        totalGainPercentage: summary.totalGainPercentage,
        cagr: cagr * 100, // Return as percentage (5.0 instead of 0.05)
        yearsElapsed
    };
};
