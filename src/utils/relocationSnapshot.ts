import type { AssetDefinition, Broker, Goal, GoalAllocation, MacroAllocation, Portfolio, Transaction } from '../types';
import { calculateAssets, calculateRealizedGains, injectCashAssets } from './portfolioCalculations';
import { aggregateMacroValues, type MacroAggregation } from './macroAggregation';
import { buildGoalDistribution, goalDistributionTotal, type GoalSegment } from './goalDistribution';

/**
 * One complete reading of the portfolio, taken with the production calculators.
 *
 * The Fund Relocation what-if builds this twice — once on the real data, once on
 * the state the plan would produce — and diffs them. Because both readings run
 * through `calculateAssets` / `aggregateMacroValues` / `buildGoalDistribution`,
 * the "before" column is the same arithmetic the Stats page shows, and any
 * future change to those calculators moves both columns together.
 */

export interface MacroLine {
    name: string;
    value: number;
    percent: number;
    targetPercent: number;
}

export interface PortfolioLine {
    id: string;
    name: string;
    value: number;
}

export interface PortfolioSnapshot {
    /** Market value of all holdings, cash excluded. */
    invested: number;
    /** Broker cash. */
    liquidity: number;
    /** invested + liquidity. */
    netWorth: number;
    /** Book value of the open positions. */
    cost: number;
    /** Unrealized P&L on the open positions. */
    unrealizedGain: number;
    /** Gains already locked in by past sales. */
    realizedGain: number;
    macro: MacroLine[];
    goalPyramid: GoalSegment[];
    goalPyramidTotal: number;
    byPortfolio: PortfolioLine[];
    aggregation: MacroAggregation;
}

export interface SnapshotInput {
    transactions: Transaction[];
    brokers: Broker[];
    portfolios: Portfolio[];
    goals: Goal[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    macroAllocations: MacroAllocation;
    goalAllocations: GoalAllocation;
}

const MACRO_ORDER = ['Stock', 'Bond', 'Commodity', 'Crypto', 'Cash'];

export const buildSnapshot = (input: SnapshotInput): PortfolioSnapshot => {
    const { transactions, brokers, portfolios, goals, assetSettings, marketData, macroAllocations } = input;

    const { assets, summary } = calculateAssets(transactions, assetSettings, marketData);
    const liquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
    const aggregation = aggregateMacroValues(assets, liquidity);

    const macro: MacroLine[] = MACRO_ORDER.map(name => {
        const value = aggregation.macroValues[name] || 0;
        return {
            name,
            value,
            percent: aggregation.totalValue > 0 ? (value / aggregation.totalValue) * 100 : 0,
            targetPercent: (macroAllocations as Record<string, number | undefined>)[name] || 0,
        };
    });

    const goalPyramid = buildGoalDistribution({ goals, portfolios, transactions, brokers, assetSettings, marketData });

    const byPortfolio: PortfolioLine[] = portfolios
        .map(p => {
            const { assets: pAssets } = calculateAssets(
                transactions.filter(t => t.portfolioId === p.id),
                assetSettings,
                marketData
            );
            const withCash = injectCashAssets(pAssets, brokers, p.id);
            return { id: p.id, name: p.name, value: withCash.reduce((s, a) => s + a.currentValue, 0) };
        })
        .sort((a, b) => b.value - a.value);

    const { totalRealized } = calculateRealizedGains(transactions, brokers, assetSettings);

    return {
        invested: aggregation.totalInvested,
        liquidity,
        netWorth: aggregation.totalValue,
        cost: summary.totalCost,
        unrealizedGain: summary.totalGain,
        realizedGain: totalRealized,
        macro,
        goalPyramid,
        goalPyramidTotal: goalDistributionTotal(goalPyramid),
        byPortfolio,
        aggregation,
    };
};
