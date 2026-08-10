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

/**
 * A single pie slice. Declared as a type alias rather than an interface on
 * purpose: Recharts' `data` prop requires an implicit index signature, which
 * TypeScript gives to object type aliases but not to interfaces.
 */
export type SliceLine = {
    name: string;
    value: number;
};

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
    /** Invested value per broker — the Stats "By Broker" pie, cash excluded. */
    byBroker: SliceLine[];
    /** The Stats "Invested vs Liquidity" pie. */
    investedVsLiquidity: SliceLine[];
    /** Macro classes with a non-zero value — the Stats asset-allocation pie. */
    assetClassSlices: SliceLine[];
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

    // Invested value per broker, cash excluded — matches the Stats "By Broker"
    // pie, which measures where the holdings sit rather than where cash sits.
    const byBroker: SliceLine[] = brokers
        .map(b => {
            const { assets: bAssets } = calculateAssets(
                transactions.filter(t => t.brokerId === b.id),
                assetSettings,
                marketData
            );
            return { name: b.name, value: bAssets.reduce((s, a) => s + a.currentValue, 0) };
        })
        .filter(d => d.value > 0)
        .sort((a, b) => b.value - a.value);

    const investedVsLiquidity: SliceLine[] = [
        { name: 'Invested', value: aggregation.totalInvested },
        { name: 'Liquidity', value: liquidity },
    ].filter(d => d.value > 0);

    const assetClassSlices: SliceLine[] = macro
        .filter(m => m.value > 0)
        .map(m => ({ name: m.name, value: m.value }));

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
        byBroker,
        investedVsLiquidity,
        assetClassSlices,
        aggregation,
    };
};
