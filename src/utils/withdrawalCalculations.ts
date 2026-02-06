import type { Asset, AssetClass } from '../types';

// Tax Rates
// 26% for Stocks, Crypto, Gold (Commodity)
// 12.5% for Bond to assume "White List" generally, and Cash
export const TAX_RATES: Record<AssetClass, number> = {
    'Stock': 0.26,
    'Crypto': 0.26,
    'Commodity': 0.26, // Gold 
    'Bond': 0.125,     // State Bonds (approx)
    'Cash': 0.125      // Monetari (approx)
};

export interface WithdrawalProjection {
    grossTotal: number;
    netTotal: number;
    taxTotal: number;
    breakdown: WithdrawalAction[];
}

export interface WithdrawalAction {
    ticker: string;
    grossSellAmount: number;
    sharesToSell: number; // Integer
    estimatedTax: number;
    netProceeds: number;
    postSellQuantity: number;
    postSellValue: number;
    postRebalancePerc: number; // New column
    gainPortion: number;
}

/**
 * Calculates a withdrawal strategy to meet `neededNet` amount.
 * Enforces INTEGER share constraints.
 */
export const calculateWithdrawalProjection = (
    assets: Asset[],
    allocations: Record<string, number>,
    neededNet: number
): WithdrawalProjection => {
    // 1. Sanity Check
    const currentTotalValue = assets.reduce((sum, a) => sum + a.currentValue, 0);
    if (neededNet >= currentTotalValue * 0.99) { // Safety margin
        return calculateFullLiquidation(assets);
    } // TODO: Handle logic if needed > total (full liquidation)

    // 2. Initial Floating Point Solver 
    // We reuse the previous "Trim the Tops" logic (conceptually) or just run the iterative finder 
    // to get a "Target Gross" that we can try to discretize.

    // Let's use a simpler approach for Integer Solver:
    // Start with 0 shares sold for everyone.
    // Loop:
    //   Calculate current Net Proceeds.
    //   If Net >= Needed, Done.
    //   Else, Find the BEST asset to sell 1 share of.
    //   "Best" = The asset that is most Overweight relative to the target allocation of the REMAINING portfolio.
    //   Wait, "Remaining Portfolio" changes as we sell.
    //   Metric: Maximize (CurrentWeight - TargetWeight).
    //   Or better: Minimize the "Distance" to target.
    //   Let's use the Score: Value / TargetWeight. 
    //   The asset with the Highest Score is the most overweight. Sell 1 share of that.

    // Setup Mutable State
    const workingState = assets.map(a => ({
        ...a,
        sharesSold: 0,
        remainingQty: a.quantity,
        remainingValue: a.currentValue,
        price: a.currentPrice || 0,
        targetWeight: allocations[a.ticker] || 0
    }));

    let currentNet = 0;

    // Safety break
    let limit = 0;
    const maxShares = workingState.reduce((sum, a) => sum + a.quantity, 0);

    while (currentNet < neededNet && limit < maxShares + 1000) {
        limit++;

        // Calculate Scores for remaining assets
        // Score = RemainingValue / TargetWeight
        // We want to reduce the one with Highest Score.
        let bestCandidateIdx = -1;
        let maxScore = -1;

        workingState.forEach((asset, idx) => {
            if (asset.remainingQty < 1) return; // Cannot sell what we don't have
            if (asset.price <= 0) return;

            // Score calculation
            // If target is 0, score is infinite (sell it first)
            const score = asset.targetWeight === 0
                ? Number.MAX_VALUE
                : asset.remainingValue / asset.targetWeight;

            if (score > maxScore) {
                maxScore = score;
                bestCandidateIdx = idx;
            }
        });

        if (bestCandidateIdx === -1) break; // No assets left to sell

        // Sell 1 share of best candidate
        const candidate = workingState[bestCandidateIdx];
        candidate.sharesSold += 1;
        candidate.remainingQty -= 1;
        candidate.remainingValue -= candidate.price;

        // Update Net (incremental update is faster, but full recalc is safer)
        currentNet = calculateTotalNet(workingState);
    }

    // 3. Finalize
    return buildProjection(workingState, currentNet);
};

const calculateTotalNet = (state: any[]): number => {
    let totalNet = 0;
    state.forEach(asset => {
        if (asset.sharesSold > 0) {
            const gross = asset.sharesSold * asset.price;
            const res = calculateAssetTax(asset, gross);
            totalNet += res.net;
        }
    });
    return totalNet;
};

const buildProjection = (state: any[], netTotal: number): WithdrawalProjection => {
    let grossTotal = 0;
    let taxTotal = 0;
    const breakdown: WithdrawalAction[] = [];

    // Calculate Final Total Remaining Value to compute percentages
    const finalTotalValue = state.reduce((sum, a) => sum + a.remainingValue, 0);

    state.forEach(asset => {
        const gross = asset.sharesSold * asset.price;
        grossTotal += gross;

        const txRes = calculateAssetTax(asset, gross);
        taxTotal += txRes.tax;

        // Post Alloc %
        // If totalAllocWeight is ~100, we just do (Val / Total) * 100.
        const postRebalancePerc = finalTotalValue > 0
            ? (asset.remainingValue / finalTotalValue) * 100
            : 0;

        if (asset.sharesSold > 0) {
            breakdown.push({
                ticker: asset.ticker,
                sharesToSell: asset.sharesSold,
                grossSellAmount: gross,
                estimatedTax: txRes.tax,
                netProceeds: txRes.net,
                postSellQuantity: asset.remainingQty,
                postSellValue: asset.remainingValue,
                postRebalancePerc,
                gainPortion: txRes.gain
            });
        }
    });

    return {
        grossTotal,
        netTotal,
        taxTotal,
        breakdown
    };
};


const calculateFullLiquidation = (assets: Asset[]): WithdrawalProjection => {
    let gross = 0;
    let net = 0;
    let tax = 0;
    const breakdown: WithdrawalAction[] = [];

    assets.forEach(asset => {
        const result = calculateAssetTax(asset, asset.currentValue);
        gross += asset.currentValue;
        net += result.net;
        tax += result.tax;

        breakdown.push({
            ticker: asset.ticker,
            grossSellAmount: asset.currentValue,
            sharesToSell: asset.quantity, // Assuming integer quantity, or close enough
            estimatedTax: result.tax,
            netProceeds: result.net,
            postSellQuantity: 0,
            postSellValue: 0,
            postRebalancePerc: 0,
            gainPortion: result.gain
        });
    });

    return { grossTotal: gross, netTotal: net, taxTotal: tax, breakdown };
};

const calculateAssetTax = (asset: Asset, sellAmount: number): { tax: number, net: number, gain: number } => {
    if (!asset.currentPrice || asset.currentPrice === 0) return { tax: 0, net: sellAmount, gain: 0 };

    // Recalculate based on exact shares if possible, but sellAmount is derived from shares * price, so consistent.
    const sellQty = sellAmount / asset.currentPrice;
    const costBasis = sellQty * asset.averagePrice;

    let gain = sellAmount - costBasis;
    if (gain < 0) gain = 0;

    const rate = TAX_RATES[asset.assetClass] || 0.26;
    const tax = gain * rate;

    return { tax, net: sellAmount - tax, gain };
};
