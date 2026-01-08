import type { AssetClass, AssetSubClass } from '../types';

export type FinancialGoal = 'Growth' | 'Protection' | 'Emergency Fund' | 'Speculative';

export const getAssetGoal = (assetClass: AssetClass, assetSubClass?: AssetSubClass): FinancialGoal => {
    if (assetClass === 'Stock') {
        return 'Growth';
    }

    if (assetClass === 'Bond') {
        if (assetSubClass === 'Short') {
            return 'Emergency Fund';
        }
        return 'Protection'; // Medium or Long
    }

    if (assetClass === 'Commodity' || assetClass === 'Crypto') {
        return 'Speculative';
    }

    // Default fallback (should ideally not happen given the types, but good for safety)
    return 'Growth';
};
