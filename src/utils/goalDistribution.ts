import type { AssetDefinition, Broker, Goal, Portfolio, Transaction } from '../types';
import { calculateAssets, injectCashAssets } from './portfolioCalculations';

/**
 * The "pyramid": wealth split across the ordered financial goals.
 *
 * Level 0 is always the cash NOT earmarked to any portfolio; above it sits one
 * level per goal, fed by the portfolios attached to it via `Portfolio.goalId`.
 * Cash earmarked to a portfolio (`Broker.liquidityAllocations`) is deliberately
 * NOT in level 0 — `injectCashAssets` folds it into that portfolio's holdings,
 * so it counts inside the portfolio's own goal level. The two conventions
 * together mean every euro of net worth lands in exactly one level.
 */

const GOAL_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6', '#F97316'];
export const LIQUIDITY_COLOR = '#6B7280';

/** Id of the synthetic level holding cash not earmarked to any portfolio. */
export const UNASSIGNED_LIQUIDITY_ID = '__liquidity__';

export interface GoalSegment {
    id: string;
    name: string;
    value: number;
    color: string;
    breakdown: { label: string; value: number }[];
}

/** Broker cash left over once every `liquidityAllocations` earmark is honoured. */
export const unassignedLiquidityOf = (brokers: Broker[]): number => {
    const total = brokers.reduce((s, b) => s + (b.currentLiquidity || 0), 0);
    const assigned = brokers.reduce(
        (s, b) => s + Object.values(b.liquidityAllocations || {}).reduce((a, v) => a + v, 0),
        0
    );
    return Math.max(0, total - assigned);
};

export interface GoalDistributionInput {
    goals: Goal[];
    portfolios: Portfolio[];
    transactions: Transaction[];
    brokers: Broker[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
}

/**
 * Builds the goal levels, largest goal id first in `goals` order, with the
 * unassigned-liquidity level prepended. Returns [] when there is nothing to
 * show at all, so callers can skip rendering.
 */
export const buildGoalDistribution = (input: GoalDistributionInput): GoalSegment[] => {
    const { goals, portfolios, transactions, brokers, assetSettings, marketData } = input;

    const assetsOf = (portfolioId: string) => {
        const { assets } = calculateAssets(
            transactions.filter(t => t.portfolioId === portfolioId),
            assetSettings,
            marketData
        );
        return injectCashAssets(assets, brokers, portfolioId);
    };

    const sortedGoals = [...goals].sort((a, b) => a.order - b.order);

    const goalSegments = sortedGoals.map((goal, idx) => {
        const linkedPortfolios = portfolios.filter(p => p.goalId === goal.id);

        const classBreakdown: Record<string, number> = {};
        let totalValue = 0;

        linkedPortfolios.forEach(p => {
            assetsOf(p.id).forEach(asset => {
                if (asset.currentValue <= 0) return;
                const cls = asset.assetClass || 'Other';
                classBreakdown[cls] = (classBreakdown[cls] || 0) + asset.currentValue;
                totalValue += asset.currentValue;
            });
        });

        return {
            id: goal.id,
            name: goal.title,
            value: totalValue,
            color: GOAL_COLORS[idx % GOAL_COLORS.length],
            breakdown: Object.entries(classBreakdown)
                .map(([cls, val]) => ({ label: cls, value: val }))
                .sort((a, b) => b.value - a.value),
        };
    });

    const unassignedLiquidity = unassignedLiquidityOf(brokers);

    const liquiditySegment: GoalSegment = {
        id: UNASSIGNED_LIQUIDITY_ID,
        name: 'Liquidity',
        value: unassignedLiquidity,
        color: LIQUIDITY_COLOR,
        breakdown: unassignedLiquidity > 0
            ? [{ label: 'Not assigned to any portfolio', value: unassignedLiquidity }]
            : [],
    };

    if (goalSegments.length === 0 && unassignedLiquidity <= 0) return [];
    return [liquiditySegment, ...goalSegments];
};

export const goalDistributionTotal = (segments: GoalSegment[]): number =>
    segments.reduce((sum, g) => sum + g.value, 0);
