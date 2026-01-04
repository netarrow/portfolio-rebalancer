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
