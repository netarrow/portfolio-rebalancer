import type { AssetDefinition, Broker, Goal, Portfolio, Transaction } from '../types';
import { calculateAssets, injectCashAssets } from './portfolioCalculations';
import { buildPortfolioTree } from './portfolioGroups';
import { tintForInherited } from './colorTint';

/**
 * The "pyramid": wealth split across the ordered financial goals.
 *
 * Level 0 is always the cash NOT earmarked to any portfolio; above it sits one
 * level per goal, fed by the portfolios attached to it via `Portfolio.goalId`.
 * Cash earmarked to a portfolio (`Broker.liquidityAllocations`) is deliberately
 * NOT in level 0 — `injectCashAssets` folds it into that portfolio's holdings,
 * so it counts inside the portfolio's own goal level. The two conventions
 * together mean every euro of net worth lands in exactly one level.
 *
 * Parent/child groups are read as ONE portfolio here too, which is the only
 * reason a level can hold value whose goal is not its own: a member attached to
 * a different goal than its group's parent counts at the PARENT's level, and
 * says so (`inherited`). This is a re-bucketing, never a re-count — see
 * `nativeValue` below.
 */

const GOAL_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6', '#F97316'];
export const LIQUIDITY_COLOR = '#6B7280';

/** Id of the synthetic level holding cash not earmarked to any portfolio. */
export const UNASSIGNED_LIQUIDITY_ID = '__liquidity__';

/**
 * Value sitting at a level on loan from another goal, because the portfolio
 * holding it was merged into a group whose parent lives at this level.
 */
export interface InheritedSlice {
    fromGoalId: string;
    fromGoalTitle: string;
    value: number;
    /** Tint of the host level's colour — same hue, visibly not native. */
    color: string;
    /** Portfolios contributing it, for the tooltip. */
    portfolioNames: string[];
}

export interface GoalSegment {
    id: string;
    name: string;
    value: number;
    color: string;
    breakdown: { label: string; value: number }[];
    /**
     * Value belonging to portfolios whose OWN goal is this level.
     *
     * The invariant that keeps the merge honest:
     *     nativeValue + Σ inherited.value === value
     * Provenance partitions a level's value, it never adds to it, so merging
     * parent and child can move a euro between levels but can never mint one.
     */
    nativeValue: number;
    inherited: InheritedSlice[];
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

/**
 * Which goal level each portfolio's value is counted at, once parent/child
 * groups are read as one portfolio.
 *
 * Two rules keep the pyramid's total identical to the un-merged one:
 *
 *  - a portfolio with no goal of its own stays out of the pyramid, group member
 *    or not. Letting it in through its parent would add value the pyramid never
 *    counted before;
 *  - a member is only redirected onto a parent that HAS a goal. Redirecting
 *    onto a goal-less parent would drop value the pyramid did count.
 *
 * So every portfolio that counted before still counts, possibly at a different
 * level — which is exactly what `inherited` then reports.
 */
export const effectiveGoalIds = (portfolios: Portfolio[]): Map<string, string | undefined> => {
    const { groups } = buildPortfolioTree(portfolios);
    const parentGoalByMember = new Map<string, string>();
    groups.forEach(group => {
        const parentGoalId = group.parent.goalId;
        if (!parentGoalId) return;
        group.members.forEach(m => parentGoalByMember.set(m.id, parentGoalId));
    });

    return new Map(
        portfolios.map(p => [p.id, p.goalId ? (parentGoalByMember.get(p.id) ?? p.goalId) : undefined])
    );
};

export interface GoalDistributionInput {
    goals: Goal[];
    portfolios: Portfolio[];
    transactions: Transaction[];
    brokers: Broker[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    /**
     * Read parent/child groups as one portfolio (default true). Set false to
     * get the plain per-portfolio split — the two must always add up to the
     * same total, which is what `verify-merged-portfolio-view` asserts.
     */
    mergeGroups?: boolean;
}

/**
 * Builds the goal levels, largest goal id first in `goals` order, with the
 * unassigned-liquidity level prepended. Returns [] when there is nothing to
 * show at all, so callers can skip rendering.
 */
export const buildGoalDistribution = (input: GoalDistributionInput): GoalSegment[] => {
    const { goals, portfolios, transactions, brokers, assetSettings, marketData } = input;
    const mergeGroups = input.mergeGroups !== false;

    const assetsOf = (portfolioId: string) => {
        const { assets } = calculateAssets(
            transactions.filter(t => t.portfolioId === portfolioId),
            assetSettings,
            marketData
        );
        return injectCashAssets(assets, brokers, portfolioId);
    };

    const sortedGoals = [...goals].sort((a, b) => a.order - b.order);
    const goalTitleById = new Map(sortedGoals.map(g => [g.id, g.title]));

    const levelOf = mergeGroups
        ? effectiveGoalIds(portfolios)
        : new Map(portfolios.map(p => [p.id, p.goalId]));

    const goalSegments = sortedGoals.map((goal, idx) => {
        const linkedPortfolios = portfolios.filter(p => levelOf.get(p.id) === goal.id);
        const color = GOAL_COLORS[idx % GOAL_COLORS.length];

        const classBreakdown: Record<string, number> = {};
        let totalValue = 0;
        /** Foreign goal id -> what it lends this level, in first-seen order. */
        const borrowed = new Map<string, { value: number; portfolioNames: string[] }>();

        linkedPortfolios.forEach(p => {
            let portfolioValue = 0;
            assetsOf(p.id).forEach(asset => {
                if (asset.currentValue <= 0) return;
                const cls = asset.assetClass || 'Other';
                classBreakdown[cls] = (classBreakdown[cls] || 0) + asset.currentValue;
                portfolioValue += asset.currentValue;
            });
            totalValue += portfolioValue;

            // `levelOf` only ever redirects a portfolio that HAS a goal, so a
            // mismatch here always names a real foreign goal.
            if (p.goalId === goal.id) return;
            const fromGoalId = p.goalId as string;
            const entry = borrowed.get(fromGoalId);
            if (entry) {
                entry.value += portfolioValue;
                entry.portfolioNames.push(p.name);
            } else {
                borrowed.set(fromGoalId, { value: portfolioValue, portfolioNames: [p.name] });
            }
        });

        const inherited: InheritedSlice[] = Array.from(borrowed.entries())
            // A member merged in while holding nothing is not worth a shade.
            .filter(([, entry]) => entry.value > 0)
            .map(([fromGoalId, entry], i) => ({
                fromGoalId,
                fromGoalTitle: goalTitleById.get(fromGoalId) ?? 'Unknown goal',
                value: entry.value,
                color: tintForInherited(color, i),
                portfolioNames: entry.portfolioNames,
            }));

        return {
            id: goal.id,
            name: goal.title,
            value: totalValue,
            color,
            breakdown: Object.entries(classBreakdown)
                .map(([cls, val]) => ({ label: cls, value: val }))
                .sort((a, b) => b.value - a.value),
            // Whatever the filter above dropped stays counted as native, so the
            // nativeValue + Σ inherited === value invariant holds regardless.
            nativeValue: totalValue - inherited.reduce((s, h) => s + h.value, 0),
            inherited,
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
        nativeValue: unassignedLiquidity,
        inherited: [],
    };

    if (goalSegments.length === 0 && unassignedLiquidity <= 0) return [];
    return [liquiditySegment, ...goalSegments];
};

export const goalDistributionTotal = (segments: GoalSegment[]): number =>
    segments.reduce((sum, g) => sum + g.value, 0);
