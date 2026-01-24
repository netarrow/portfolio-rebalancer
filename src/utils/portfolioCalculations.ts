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

    // 2. Add "Ghost Assets" from targets that haven't been touched by transactions yet
    targets.forEach(target => {
        const ticker = target.ticker.toUpperCase();
        if (!assetMap.has(ticker)) {
            // Found a defined asset with no transactions
            assetMap.set(ticker, {
                ticker: ticker,
                label: target.label,
                assetClass: target.assetClass || 'Stock',
                assetSubClass: target.assetSubClass || 'International',
                quantity: 0,
                averagePrice: 0,
                currentValue: 0,
                currentPrice: 0
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

export const calculateRequiredLiquidityForOnlyBuy = (
    assets: Asset[],
    allocations: Record<string, number>
): number => {
    // 1. Identify constraint
    // We need to find the "Implied Total Value" for each asset if it were to match its target perfect.
    // ImpliedTotal = AssetValue / (Target% / 100)
    // The Max(ImpliedTotal) is the Minimum Portfolio Size required to satisfy ALL asset targets by only adding value.

    let maxImpliedTotal = 0;
    let currentTotalAssetsValue = 0;

    assets.forEach(asset => {
        const targetPerc = allocations[asset.ticker] || 0;
        const currentValue = asset.currentValue;
        currentTotalAssetsValue += currentValue;

        if (targetPerc > 0) {
            const impliedTotal = currentValue / (targetPerc / 100);
            if (impliedTotal > maxImpliedTotal) {
                maxImpliedTotal = impliedTotal;
            }
        }
        // If targetPerc is 0 and currentValue > 0, we can't solve this with "Only Buy" 
        // because we can never reduce the weight to 0 without selling.
        // We will ignore this constraint for the "Buy Only" calculation on OTHER assets,
        // effectively accepting that this 0% target asset will drift down but never reach 0%.
    });

    // If no assets have targets, or all targets are 0 with no value, 0 needed.
    if (maxImpliedTotal === 0) return 0;

    // However, the MaxImpliedTotal might be LESS than current total value if we have assets with 0% target but High Value?
    // specific edge case:
    // A: Val 100, Target 50% -> Implied 200
    // B: Val 100, Target 50% -> Implied 200
    // MaxImplied = 200. CurrentTotal = 200. ReqLiquidity = 0. Correct.

    // A: Val 150, Target 50% -> Implied 300
    // B: Val 50,  Target 50% -> Implied 100
    // MaxImplied = 300. CurrentTotal = 200. ReqLiquidity = 100.
    // Result: A->150 (50% of 300), B needs to be 150 (Buy 100). Total 300. Correct.

    // Constraint: MaxImpliedTotal must be at least CurrentTotal (plus existing liquidity? No, the function signature doesn't know existing liquidity yet. 
    // It usually works on Assets Value. 
    // Wait, the User wants to know "Liquidity to Invest".
    // If we have existing liquidity, say 50. And we need 100 MORE.
    // Actually this function should return the "Additional Cash Needed on top of Current Asset Value".
    // So if function returns 100, and we have 50 cash, we need to deposit 50 more.
    // The caller can subtract existing liquidity.

    // Safety check: maxImpliedTotal should be >= currentTotalAssetsValue (mathematically it should be if sum(targets)=100%)
    // But if sum(targets) < 100%? e.g. Target A 40%, Target B 40% (Total 80%).
    // A: 100 -> Implied 250.
    // B: 100 -> Implied 250.
    // MaxImplied 250.
    // New allocations: A (100 is 40% of 250), B (100 is 40% of 250). Total used 200. Unallocated 50.
    // So logic holds.

    const requiredLiquidity = maxImpliedTotal - currentTotalAssetsValue;
    return Math.max(0, requiredLiquidity);
};
