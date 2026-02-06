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
    grossSellAmount: number; // Positive
    estimatedTax: number;
    netProceeds: number;
    postSellQuantity: number;
    postSellValue: number;
    gainPortion: number;
}

/**
 * Calculates a withdrawal strategy to meet `neededNet` amount.
 * It tries to sell assets such that the REMAINING portfolio is as close to Target Allocation as possible.
 * It accounts for Capital Gains Tax on the sold portion.
 */
export const calculateWithdrawalProjection = (
    assets: Asset[],
    allocations: Record<string, number>, // Target % per ticker
    neededNet: number
): WithdrawalProjection => {
    // 1. Current State
    const currentTotalValue = assets.reduce((sum, a) => sum + a.currentValue, 0);

    // If needed > total, cap it (or handle error, but let's just return full liquidation equivalent)
    if (neededNet >= currentTotalValue) {
        // Full liquidation scenario (simplification)
        return calculateFullLiquidation(assets);
    }

    // 2. Iterative Solver
    // We need to find `GrossSell` such that `Net(GrossSell) ≈ neededNet`.
    // Since Tax depends on WHICH assets we sell, and "Which assets" depends on "Gross Amount" (because we rebalance),
    // this is circular.
    // However, Tax is monotonic with Gross Sell.
    // We can use Binary Search or simple Iteration. 
    // Given the scale, a simple fixed-point iteration is fast enough.

    // Initial Guess: Gross ≈ Net (assume 0 tax)
    let grossTarget = neededNet;
    let projection: WithdrawalProjection = { grossTotal: 0, netTotal: 0, taxTotal: 0, breakdown: [] };

    for (let i = 0; i < 10; i++) {
        projection = simulateSellEvent(assets, allocations, grossTarget);

        const diff = neededNet - projection.netTotal;
        if (Math.abs(diff) < 1) {
            break; // Converged within €1
        }

        // Adjust Gross Target
        // If Net is too low, we need to sell more.
        // We add the difference roughly. 
        // Better: GrossNew = GrossOld + (Diff / (1 - AvgTax))? 
        // Let's just add Diff for stability, maybe slightly boosted.
        grossTarget += diff;
    }

    return projection;
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
            estimatedTax: result.tax,
            netProceeds: result.net,
            postSellQuantity: 0,
            postSellValue: 0,
            gainPortion: result.gain
        });
    });

    return { grossTotal: gross, netTotal: net, taxTotal: tax, breakdown };
};

const simulateSellEvent = (
    assets: Asset[],
    allocations: Record<string, number>,
    totalGrossToSell: number
): WithdrawalProjection => {
    const currentTotalValue = assets.reduce((sum, a) => sum + a.currentValue, 0);
    const targetPostValue = currentTotalValue - totalGrossToSell;

    if (targetPostValue <= 0) return calculateFullLiquidation(assets);

    // 1. Calculate Ideal Post-Withdrawal Values per Asset
    // We want the Remaining Portfolio to match Allocations.
    // IdealRemValue(A) = TargetPostValue * Target%(A)

    // However, we have a constraint: We cannot buy (Sell Only).
    // So PostValue(A) <= CurrentValue(A).
    // And sum(PostValue) must equal TargetPostValue.

    // This is "Rebalance with Sell Only constraint".
    // We calculate "Gap to Cut" for each asset.

    // Let's compute Ideal Target Values
    // (Loop removed as it was unused)

    // 2. Resolve Constraints
    // If Ideal > Current (we are underweight), we can't Add. So we stay at Current.
    // This leaves "extra money" that we didn't sell? No.
    // If we can't reduce an asset to its ideal because it's ALREADY below ideal? 
    // Wait. If we are reducing the Total Pie, all ideal values shrink.
    // If an asset is currently 100 (10%), and we shrink Pie by 50%. New Ideal is 50.
    // It's likely we need to sell everything.

    // Exception: If an asset is heavily Overweight, and another is Underweight.
    // Existing: A=100 (Target 50%), B=0 (Target 50%). Total 100.
    // Withdraw 10. TargetPost=90.
    // Ideal: A=45, B=45.
    // We can reduce A to 45 (Sell 55). 
    // B stays at 0.
    // Total Remaining: 45. We sold 55. But we only wanted to sell 10.
    // This logic removes TOO MUCH.

    // CORRECT LOGIC for Sell Only to Target:
    // We want to sell `totalGrossToSell`.
    // We should sell from the assets that are MOST Overweight relative to the New Target Pie?
    // Or simpler: Minimize relative deviation?

    // Let's use the "Liquidity For Sell" approach.
    // We identify "Surplus" relative to the Target Allocation of the REMAINING amount.
    // But we don't know the remaining distribution perfectly yet.

    // Alternative Algorithm:
    // 1. Calculate Current "Score" = Value / Target.
    // 2. "Trim the tops". Iteratively remove $1 from the asset with the highest Score (most overweight),
    // until we removed `totalGrossToSell`.

    // Optimization for speed:
    // Sort assets by Score (Value / TargetWeight).
    // Reduce highest asset until its score matches the second highest.
    // ...

    // Implementation of "Trim the Tops"
    let remainingToSell = totalGrossToSell;

    // Working mutable state
    const workingAssets = assets.map(a => ({
        ...a,
        workingValue: a.currentValue,
        targetWeight: allocations[a.ticker] || 0
    }));

    // Filter out 0 holdings
    const activeAssets = workingAssets.filter(a => a.workingValue > 0);

    // Check if any asset has 0 target but positive value - these should be sold FIRST?
    // Yes, Score = Value / 0 = Infinity.

    // Loop until sold enough
    // Use a small step or analytical step? 
    // Analytical is better but complex with many assets. 
    // Let's use proportional reduction of the "Overweight Set".

    // Iterate 20 times to approximate
    for (let iter = 0; iter < 50 && remainingToSell > 0.1; iter++) {
        // Compute Scores
        activeAssets.forEach(a => {
            // Avoid div by zero. If weight is 0, score is effectively infinite (or Max Safe Integer)
            // But we scale it.
            // Score = Current % / Target %.
            // or Value / (TotalCurrent * Target%)?
            // Simple: Value / Weight. 
            // If weight 0, High Number.
            (a as any).score = a.targetWeight > 0
                ? a.workingValue / a.targetWeight
                : Number.MAX_VALUE;
        });

        // Find max Score (the most overweight asset relative to its target)
        // We select ALL assets that are within a small epsilon of the Max Score to reduce them together.
        const maxScore = Math.max(...activeAssets.map(a => (a as any).score));

        // Limit to assets with value > 0
        const candidates = activeAssets.filter(a => Math.abs((a as any).score - maxScore) < maxScore * 0.0001 && a.workingValue > 0);

        if (candidates.length === 0) break; // Should not happen

        // Find Next Highest Score to determin Step Size
        const nonCandidates = activeAssets.filter(a => (a as any).score < maxScore * 0.9999);
        const secondScore = nonCandidates.length > 0
            ? Math.max(...nonCandidates.map(a => (a as any).score))
            : 0;

        // We want to reduce Candidates so their score drops to SecondScore.
        // DeltaScore = MaxScore - SecondScore.
        // For a candidate: NewValue / Weight = SecondScore => NewValue = SecondScore * Weight.
        // Reduction = WorkingValue - (SecondScore * Weight).
        // If SecondScore is 0 (all others are done), we reduce to 0.

        let totalReductionPossible = 0;
        candidates.forEach(c => {
            const targetVal = secondScore * c.targetWeight;
            // Cap targetVal at 0.
            // reduction for this asset
            // If c.targetWeight is 0 (Score=Max), we can reduce it fully or step by step.
            // If weight is 0, let's just use a small step or reduce fully if it's the only logic.
            // Handled below.

            let reduction = 0;
            if (c.targetWeight === 0) {
                reduction = c.workingValue; // Sell all junk first
            } else {
                reduction = c.workingValue - targetVal;
            }
            (c as any).proposedReduction = reduction;
            totalReductionPossible += reduction;
        });

        // Determine how much we actually sell in this step
        // We need `remainingToSell`.
        // We can sell up to `totalReductionPossible`.

        const amountToSellNow = Math.min(remainingToSell, totalReductionPossible);

        // Distribute `amountToSellNow` among candidates proportional to their weight (to keep scores equal) 
        // OR proportional to their proposed reduction?
        // Proportional to proposed reduction ensures they hit the next level together.

        if (totalReductionPossible > 0.000001) {
            candidates.forEach(c => {
                const share = (c as any).proposedReduction / totalReductionPossible;
                const sellAmt = share * amountToSellNow;
                c.workingValue -= sellAmt;
            });
            remainingToSell -= amountToSellNow;
        } else {
            // Deadlock or finished?
            // If we can't reduce further but need to sell?
            // Maybe all assets are equal score?
            // Then reduce all proportionally.
            // Score = Val/Wt. Equal Score means Alloc = Target.
            // Just reduce all by ratio.
            const ratio = remainingToSell / activeAssets.reduce((sum, a) => sum + a.workingValue, 0);
            activeAssets.forEach(a => {
                a.workingValue -= a.workingValue * ratio;
            });
            remainingToSell = 0;
        }
    }

    // 3. Build Result
    let taxTotal = 0;
    let netTotal = 0;
    const breakdown: WithdrawalAction[] = [];

    assets.forEach((asset, idx) => {
        const finalVal = workingAssets[idx].workingValue;
        const grossSell = asset.currentValue - finalVal;

        if (grossSell > 0.001) {
            const txRes = calculateAssetTax(asset, grossSell);
            taxTotal += txRes.tax;
            netTotal += txRes.net;

            breakdown.push({
                ticker: asset.ticker,
                grossSellAmount: grossSell,
                estimatedTax: txRes.tax,
                netProceeds: txRes.net,
                postSellQuantity: asset.quantity - (grossSell / asset.currentPrice!), // Approx
                postSellValue: finalVal,
                gainPortion: txRes.gain
            });
        }
    });

    return {
        grossTotal: totalGrossToSell,
        netTotal: netTotal,
        taxTotal: taxTotal,
        breakdown
    };
};

const calculateAssetTax = (asset: Asset, sellAmount: number): { tax: number, net: number, gain: number } => {
    // 1. Determine Cost Basis for the sold portion
    // Average Cost method.
    // Cost of sold chunk = (SellAmount / CurrentValue) * TotalCost
    // But better: SellQty * AvgPrice.
    // SellQty = SellAmount / CurrentPrice.

    // Safety
    if (!asset.currentPrice || asset.currentPrice === 0) return { tax: 0, net: sellAmount, gain: 0 };

    const sellQty = sellAmount / asset.currentPrice;
    const costBasis = sellQty * asset.averagePrice;

    const proceeds = sellAmount;
    let gain = proceeds - costBasis;

    // No tax on loss
    if (gain < 0) gain = 0; // Simplified as per request (compensate minusvalenze ignored)

    const rate = TAX_RATES[asset.assetClass] || 0.26;
    const tax = gain * rate;

    return {
        tax,
        net: proceeds - tax,
        gain
    };
};
