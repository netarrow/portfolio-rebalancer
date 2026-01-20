import type { AssetClass, AssetSubClass } from '../types';

export type FinancialGoal = 'Growth' | 'Protection' | 'Security';

export const getAssetGoal = (assetClass: AssetClass, assetSubClass?: AssetSubClass): FinancialGoal => {
    if (assetClass === 'Stock') {
        return 'Growth';
    }

    if (assetClass === 'Bond') {
        if (assetSubClass === 'Short') {
            return 'Protection'; // Was Emergency Fund
        }
        return 'Security'; // Medium or Long, was Protection
    }

    if (assetClass === 'Commodity' || assetClass === 'Crypto') {
        return 'Growth'; // Was Speculative
    }

    if (assetClass === 'Cash') {
        return 'Protection';
    }

    // Default fallback
    return 'Growth';
};
