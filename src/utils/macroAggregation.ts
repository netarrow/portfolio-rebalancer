import type { Asset } from '../types';
import { getAssetGoal } from './goalCalculations';

/**
 * Aggregation behind the Macro Allocation readout: holdings rolled up to macro
 * asset class, to subclass, and to financial goal, with broker cash folded in.
 *
 * Extracted from MacroStats so the Fund Relocation what-if measures the "after"
 * state with the exact same conventions the Stats page uses for the "before" —
 * notably the two that are easy to get wrong:
 *  - a pension fund is not its own macro class: it is split 57% equity / 43% bond;
 *  - broker cash counts as Cash and, on the goal axis, as Protection.
 */

/** Equity/bond split applied to a pension fund's value on the macro axis. */
export const PENSION_FUND_EQUITY_SHARE = 0.57;
export const PENSION_FUND_BOND_SHARE = 0.43;

export interface MacroAggregation {
    /** Market value of the holdings, cash excluded. */
    totalInvested: number;
    /** Broker cash. */
    currentLiquidity: number;
    /** totalInvested + currentLiquidity — the net worth denominator. */
    totalValue: number;
    /** Macro class -> EUR (Stock, Bond, Commodity, Crypto, Cash). */
    macroValues: Record<string, number>;
    /** Financial goal -> EUR (Growth, Protection, Security). */
    goalValues: Record<string, number>;
    /** `Class` or `Class:SubClass` -> EUR, with PensionFund kept whole. */
    subclassValues: Record<string, number>;
}

export const aggregateMacroValues = (assets: Asset[], currentLiquidity: number): MacroAggregation => {
    const totalInvested = assets.reduce((sum, a) => sum + (a.currentValue || 0), 0);
    const totalValue = totalInvested + currentLiquidity;

    const subclassValues: Record<string, number> = {};
    const macroValues: Record<string, number> = { Stock: 0, Bond: 0, Commodity: 0, Crypto: 0, Cash: 0 };
    const goalValues: Record<string, number> = { Growth: 0, Protection: 0, Security: 0 };

    assets.forEach(asset => {
        if (!asset.currentValue) return;

        const cls = asset.assetClass;
        const sub = asset.assetSubClass || '';

        if (cls === 'PensionFund') {
            const key = 'PensionFund:Balanced';
            subclassValues[key] = (subclassValues[key] || 0) + asset.currentValue;
            macroValues['Stock'] += asset.currentValue * PENSION_FUND_EQUITY_SHARE;
            macroValues['Bond'] += asset.currentValue * PENSION_FUND_BOND_SHARE;
        } else if (cls === 'Crypto') {
            subclassValues['Crypto'] = (subclassValues['Crypto'] || 0) + asset.currentValue;
            macroValues['Crypto'] += asset.currentValue;
        } else if (cls === 'Cash') {
            subclassValues['Cash'] = (subclassValues['Cash'] || 0) + asset.currentValue;
            macroValues['Cash'] += asset.currentValue;
        } else if (macroValues[cls] !== undefined) {
            const key = sub ? `${cls}:${sub}` : cls;
            subclassValues[key] = (subclassValues[key] || 0) + asset.currentValue;
            macroValues[cls] += asset.currentValue;
        }

        const goal = getAssetGoal(cls, sub);
        if (goalValues[goal] !== undefined) goalValues[goal] += asset.currentValue;
    });

    subclassValues['Cash'] = (subclassValues['Cash'] || 0) + currentLiquidity;
    macroValues['Cash'] = (macroValues['Cash'] || 0) + currentLiquidity;
    goalValues['Protection'] += currentLiquidity;

    return { totalInvested, currentLiquidity, totalValue, macroValues, goalValues, subclassValues };
};
