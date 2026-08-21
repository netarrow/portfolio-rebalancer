import type { AssetDefinition, Broker, Goal, Portfolio, Transaction } from '../types';
import { calculateAssets, injectCashAssets } from './portfolioCalculations';

/**
 * Goal-level flows: what has to move BETWEEN WHOLE PORTFOLIOS for the wealth
 * split across goals to hit its targets.
 *
 * This is deliberately not an asset-level rebalance. Portfolios are attached to
 * a goal (`Portfolio.goalId`), so a goal only grows if a portfolio attached to
 * it grows — and the money has to come out of a portfolio attached to a goal
 * that is over target. What each move then sells and buys inside those two
 * portfolios is the relocation planner's job, not this one's: here the unit is
 * the portfolio, and the answer is "move € from portfolio A to portfolio B".
 *
 * The base the targets apply to is the sum of the goal levels only. Cash not
 * earmarked to any portfolio is level 0 of the pyramid, outside every goal, so
 * counting it would produce gaps that no portfolio-to-portfolio move can close.
 * Deploying that cash is a Cash → Portfolio move in the form above.
 */

export const GOAL_FLOW_COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#6366F1', '#14B8A6', '#F97316'];

/** Moves smaller than this are noise once tax and commissions are priced in. */
export const DEFAULT_MIN_MOVE = 100;

export interface GoalFlowPortfolio {
    id: string;
    name: string;
    value: number;
}

export interface GoalFlowGoal {
    id: string;
    title: string;
    color: string;
    currentValue: number;
    currentPercent: number;
    targetPercent: number;
    targetValue: number;
    /** target − current: positive = must grow, negative = must shrink. */
    gap: number;
    portfolios: GoalFlowPortfolio[];
}

export interface GoalFlowMove {
    fromPortfolioId: string;
    fromPortfolioName: string;
    fromGoalId: string;
    toPortfolioId: string;
    toPortfolioName: string;
    toGoalId: string;
    amount: number;
}

export type GoalFlowIssueKind =
    /** A goal must grow but has no portfolio attached to receive the money. */
    | 'no-destination'
    /** A goal must shrink but its portfolios hold less than the gap asks for. */
    | 'not-enough-to-drain'
    /** Moves dropped for being too small to be worth their friction. */
    | 'below-minimum';

export interface GoalFlowIssue {
    kind: GoalFlowIssueKind;
    goalId?: string;
    goalTitle?: string;
    amount: number;
}

export interface GoalFlowPlan {
    goals: GoalFlowGoal[];
    /** Sum of the goal levels — the base the target percentages apply to. */
    total: number;
    moves: GoalFlowMove[];
    /** Portfolios not attached to any goal: outside the split entirely. */
    orphanPortfolios: GoalFlowPortfolio[];
    /** Cash not earmarked to a portfolio is outside the goals — shown, not moved. */
    issues: GoalFlowIssue[];
}

export interface GoalFlowInput {
    goals: Goal[];
    portfolios: Portfolio[];
    transactions: Transaction[];
    brokers: Broker[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    /** goalId → target %, summing to 100. */
    targets: Record<string, number>;
    minMove?: number;
}

/**
 * A portfolio's value the way every goal readout counts it: invested assets
 * plus the broker cash earmarked to that portfolio. Per-portfolio `liquidity`
 * is rebalancing-only and deliberately stays out.
 */
const portfolioValue = (
    portfolio: Portfolio,
    input: Pick<GoalFlowInput, 'transactions' | 'brokers' | 'assetSettings' | 'marketData'>
): number => {
    const txs = input.transactions.filter(t => t.portfolioId === portfolio.id);
    const { assets } = calculateAssets(txs, input.assetSettings, input.marketData);
    return injectCashAssets(assets, input.brokers, portfolio.id)
        .reduce((sum, a) => sum + Math.max(0, a.currentValue), 0);
};

/** Splits `amount` over `items` proportionally to weight, capped by `max`. */
const spread = (
    amount: number,
    items: { id: string; weight: number; max?: number }[]
): Record<string, number> => {
    const out: Record<string, number> = {};
    if (items.length === 0 || amount <= 0) return out;

    let remaining = amount;
    let pool = items.map(i => ({ ...i, weight: Math.max(0, i.weight) }));

    // Capped items are settled first and their overflow re-spread over the rest,
    // so a goal whose biggest portfolio cannot cover its share still drains the
    // full gap from the others instead of silently coming up short.
    for (let pass = 0; pass < 4 && remaining > 0.5 && pool.length > 0; pass++) {
        const totalWeight = pool.reduce((s, i) => s + i.weight, 0);
        const share = (i: { weight: number }) =>
            totalWeight > 0 ? remaining * (i.weight / totalWeight) : remaining / pool.length;

        const next: typeof pool = [];
        let placed = 0;
        pool.forEach(i => {
            const want = share(i);
            const room = i.max !== undefined ? Math.max(0, i.max - (out[i.id] ?? 0)) : Infinity;
            const give = Math.min(want, room);
            if (give > 0) { out[i.id] = (out[i.id] ?? 0) + give; placed += give; }
            if (room > give + 0.5) next.push(i);
        });
        remaining -= placed;
        if (placed <= 0.5) break;
        pool = next;
    }
    return out;
};

/**
 * Builds the goal split and the portfolio-to-portfolio moves that would close
 * it. Donors and receivers are matched largest-first, which keeps the number of
 * moves at donors + receivers − 1 at worst: every extra move is another sell →
 * buy round trip, and each one leaks tax and two commissions.
 */
export const buildGoalFlowPlan = (input: GoalFlowInput): GoalFlowPlan => {
    const { goals, portfolios, targets } = input;
    const minMove = input.minMove ?? DEFAULT_MIN_MOVE;

    const valueById: Record<string, number> = {};
    portfolios.forEach(p => { valueById[p.id] = portfolioValue(p, input); });

    const sortedGoals = [...goals].sort((a, b) => a.order - b.order);

    const goalPortfolios = (goalId: string): GoalFlowPortfolio[] =>
        portfolios
            .filter(p => p.goalId === goalId)
            .map(p => ({ id: p.id, name: p.name, value: valueById[p.id] ?? 0 }))
            .sort((a, b) => b.value - a.value);

    const base = sortedGoals.map((goal, idx) => {
        const linked = goalPortfolios(goal.id);
        return {
            goal,
            linked,
            currentValue: linked.reduce((s, p) => s + p.value, 0),
            color: GOAL_FLOW_COLORS[idx % GOAL_FLOW_COLORS.length],
        };
    });

    const total = base.reduce((s, g) => s + g.currentValue, 0);

    const flowGoals: GoalFlowGoal[] = base.map(({ goal, linked, currentValue, color }) => {
        const targetPercent = targets[goal.id] ?? 0;
        const targetValue = (targetPercent / 100) * total;
        return {
            id: goal.id,
            title: goal.title,
            color,
            currentValue,
            currentPercent: total > 0 ? (currentValue / total) * 100 : 0,
            targetPercent,
            targetValue,
            gap: targetValue - currentValue,
            portfolios: linked,
        };
    });

    const issues: GoalFlowIssue[] = [];

    // Donors: goals over target, drained proportionally to what each of their
    // portfolios holds, so the mix inside the goal survives the move.
    const donors: { portfolioId: string; name: string; goalId: string; amount: number }[] = [];
    const receivers: { portfolioId: string; name: string; goalId: string; amount: number }[] = [];

    flowGoals.forEach(g => {
        if (g.gap < -0.5) {
            const need = -g.gap;
            const capacity = g.portfolios.reduce((s, p) => s + p.value, 0);
            if (capacity + 0.5 < need) {
                issues.push({ kind: 'not-enough-to-drain', goalId: g.id, goalTitle: g.title, amount: need - capacity });
            }
            const per = spread(Math.min(need, capacity), g.portfolios.map(p => ({ id: p.id, weight: p.value, max: p.value })));
            g.portfolios.forEach(p => {
                const amount = per[p.id] ?? 0;
                if (amount > 0.5) donors.push({ portfolioId: p.id, name: p.name, goalId: g.id, amount });
            });
        } else if (g.gap > 0.5) {
            if (g.portfolios.length === 0) {
                issues.push({ kind: 'no-destination', goalId: g.id, goalTitle: g.title, amount: g.gap });
                return;
            }
            // A goal held entirely in cash-less brand new portfolios has no
            // weights to go by, so the gap is split evenly instead.
            const anyValue = g.portfolios.some(p => p.value > 0);
            const per = spread(g.gap, g.portfolios.map(p => ({ id: p.id, weight: anyValue ? p.value : 1 })));
            g.portfolios.forEach(p => {
                const amount = per[p.id] ?? 0;
                if (amount > 0.5) receivers.push({ portfolioId: p.id, name: p.name, goalId: g.id, amount });
            });
        }
    });

    donors.sort((a, b) => b.amount - a.amount);
    receivers.sort((a, b) => b.amount - a.amount);

    const moves: GoalFlowMove[] = [];
    let di = 0;
    let ri = 0;
    let dropped = 0;
    while (di < donors.length && ri < receivers.length) {
        const donor = donors[di];
        const receiver = receivers[ri];
        const amount = Math.round(Math.min(donor.amount, receiver.amount));
        if (amount >= minMove) {
            moves.push({
                fromPortfolioId: donor.portfolioId,
                fromPortfolioName: donor.name,
                fromGoalId: donor.goalId,
                toPortfolioId: receiver.portfolioId,
                toPortfolioName: receiver.name,
                toGoalId: receiver.goalId,
                amount,
            });
        } else if (amount > 0) {
            dropped += amount;
        }
        const used = Math.min(donor.amount, receiver.amount);
        donor.amount -= used;
        receiver.amount -= used;
        if (donor.amount <= 0.5) di++;
        if (receiver.amount <= 0.5) ri++;
    }

    if (dropped >= 1) issues.push({ kind: 'below-minimum', amount: dropped });

    const orphanPortfolios = portfolios
        .filter(p => !p.goalId || !goals.some(g => g.id === p.goalId))
        .map(p => ({ id: p.id, name: p.name, value: valueById[p.id] ?? 0 }))
        .filter(p => p.value > 0)
        .sort((a, b) => b.value - a.value);

    return { goals: flowGoals, total, moves, orphanPortfolios, issues };
};
