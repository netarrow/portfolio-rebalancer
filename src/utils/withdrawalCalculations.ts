import type { Asset, AssetClass, Broker } from '../types';
import { calculateCommission } from './portfolioCalculations';

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
    commissionTotal: number;
    breakdown: WithdrawalAction[];
}

export interface WithdrawalAction {
    ticker: string;
    grossSellAmount: number;
    sharesToSell: number; // Integer
    estimatedTax: number;
    commission: number;
    netProceeds: number;
    postSellQuantity: number;
    postSellValue: number;
    postRebalancePerc: number; // New column
    gainPortion: number;
}

/**
 * Calculates a withdrawal strategy to meet `neededNet` amount.
 * Enforces INTEGER share constraints.
 * Optionally accounts for broker sell commissions via `brokerByTicker`.
 */
export const calculateWithdrawalProjection = (
    assets: Asset[],
    allocations: Record<string, number>,
    neededNet: number,
    brokerByTicker?: Record<string, Broker | undefined>
): WithdrawalProjection => {
    // 1. Sanity Check
    const currentTotalValue = assets.reduce((sum, a) => sum + a.currentValue, 0);
    if (neededNet >= currentTotalValue * 0.99) { // Safety margin
        return calculateFullLiquidation(assets, brokerByTicker);
    }

    // 2. Integer Share Solver
    // Start with 0 shares sold for everyone.
    // Loop: find asset most overweight relative to target, sell 1 share, repeat until net >= needed.

    const workingState = assets.map(a => ({
        ...a,
        sharesSold: 0,
        remainingQty: a.quantity,
        remainingValue: a.currentValue,
        price: a.currentPrice || 0,
        targetWeight: allocations[a.ticker] || 0,
        broker: brokerByTicker?.[a.ticker.toUpperCase()]
    }));

    let currentNet = 0;

    // Safety break
    let limit = 0;
    const maxShares = workingState.reduce((sum, a) => sum + a.quantity, 0);

    while (currentNet < neededNet && limit < maxShares + 1000) {
        limit++;

        let bestCandidateIdx = -1;
        let maxScore = -1;

        workingState.forEach((asset, idx) => {
            if (asset.remainingQty < 1) return;
            if (asset.price <= 0) return;

            const score = asset.targetWeight === 0
                ? Number.MAX_VALUE
                : asset.remainingValue / asset.targetWeight;

            if (score > maxScore) {
                maxScore = score;
                bestCandidateIdx = idx;
            }
        });

        if (bestCandidateIdx === -1) break;

        const candidate = workingState[bestCandidateIdx];
        candidate.sharesSold += 1;
        candidate.remainingQty -= 1;
        candidate.remainingValue -= candidate.price;

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
            const res = calculateAssetCosts(asset, gross, asset.broker);
            totalNet += res.net;
        }
    });
    return totalNet;
};

const buildProjection = (state: any[], netTotal: number): WithdrawalProjection => {
    let grossTotal = 0;
    let taxTotal = 0;
    let commissionTotal = 0;
    const breakdown: WithdrawalAction[] = [];

    const finalTotalValue = state.reduce((sum, a) => sum + a.remainingValue, 0);

    state.forEach(asset => {
        const gross = asset.sharesSold * asset.price;
        grossTotal += gross;

        const txRes = calculateAssetCosts(asset, gross, asset.broker);
        taxTotal += txRes.tax;
        commissionTotal += txRes.commission;

        const postRebalancePerc = finalTotalValue > 0
            ? (asset.remainingValue / finalTotalValue) * 100
            : 0;

        if (asset.sharesSold > 0) {
            breakdown.push({
                ticker: asset.ticker,
                sharesToSell: asset.sharesSold,
                grossSellAmount: gross,
                estimatedTax: txRes.tax,
                commission: txRes.commission,
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
        commissionTotal,
        breakdown
    };
};


const calculateFullLiquidation = (assets: Asset[], brokerByTicker?: Record<string, Broker | undefined>): WithdrawalProjection => {
    let gross = 0;
    let net = 0;
    let tax = 0;
    let commissionTotal = 0;
    const breakdown: WithdrawalAction[] = [];

    assets.forEach(asset => {
        const broker = brokerByTicker?.[asset.ticker.toUpperCase()];
        const result = calculateAssetCosts(asset, asset.currentValue, broker);
        gross += asset.currentValue;
        net += result.net;
        tax += result.tax;
        commissionTotal += result.commission;

        breakdown.push({
            ticker: asset.ticker,
            grossSellAmount: asset.currentValue,
            sharesToSell: asset.quantity,
            estimatedTax: result.tax,
            commission: result.commission,
            netProceeds: result.net,
            postSellQuantity: 0,
            postSellValue: 0,
            postRebalancePerc: 0,
            gainPortion: result.gain
        });
    });

    return { grossTotal: gross, netTotal: net, taxTotal: tax, commissionTotal, breakdown };
};

const calculateAssetCosts = (asset: Asset, sellAmount: number, broker?: Broker): { tax: number, commission: number, net: number, gain: number } => {
    // Tax
    let tax = 0;
    let gain = 0;
    if (asset.currentPrice && asset.currentPrice > 0) {
        const sellQty = sellAmount / asset.currentPrice;
        const costBasis = sellQty * asset.averagePrice;
        gain = sellAmount - costBasis;
        if (gain < 0) gain = 0;
        const rate = TAX_RATES[asset.assetClass] || 0.26;
        tax = gain * rate;
    }

    // Commission (sell only)
    let commission = 0;
    if (broker) {
        const sellQty = asset.currentPrice && asset.currentPrice > 0
            ? sellAmount / asset.currentPrice
            : 0;
        const fakeTx = {
            amount: sellQty,
            price: asset.currentPrice || 0,
        } as any;
        commission = calculateCommission(fakeTx, broker) || 0;
    }

    return { tax, commission, net: sellAmount - tax - commission, gain };
};
