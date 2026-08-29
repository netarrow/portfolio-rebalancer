import type { AssetDefinition, Broker, Goal, GoalFlowPortfolioState, Portfolio, Transaction } from '../types';
import { effectiveGoalIds, LIQUIDITY_COLOR, UNASSIGNED_LIQUIDITY_ID, unassignedLiquidityOf } from './goalDistribution';
import { calculateAssets, injectCashAssets } from './portfolioCalculations';

/**
 * Goal-level flows: what has to move for the wealth split across the pyramid to
 * hit its targets.
 *
 * This is deliberately not an asset-level rebalance. Portfolios are attached to
 * a goal (`Portfolio.goalId`), so a goal only grows if a portfolio attached to
 * it grows — and the money has to come out of a portfolio attached to a goal
 * that is over target. What each move then sells and buys inside those two
 * portfolios is the relocation planner's job, not this one's: here the unit is
 * the portfolio, and the answer is "move € from portfolio A to portfolio B".
 *
 * Each portfolio can be taken out of the planner's hands without leaving the
 * pyramid: 'frozen' keeps it in its goal's value but bars every move from
 * touching it (a pension fund, a PAC you will not interrupt), 'excluded' drops
 * it from the base entirely (money you would rather not think about here). The
 * flag is Fund Relocation's alone — every other readout keeps counting the lot.
 *
 * The one level that is not a goal is level 0: the cash NOT earmarked to any
 * portfolio, which sits below every goal in the pyramid exactly as it does on
 * the Stats page. It is a full participant here — draining it is a cash →
 * portfolio move (an investment, no sale, no tax) and feeding it a portfolio →
 * cash one (a divestment) — which is why the targets apply to the whole net
 * worth rather than to the goals alone. Cash earmarked to a portfolio is folded
 * into that portfolio by `injectCashAssets`, so it counts inside its own goal
 * and never twice.
 */

export const GOAL_FLOW_COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#6366F1', '#14B8A6', '#F97316'];

/** Moves smaller than this are noise once tax and commissions are priced in. */
export const DEFAULT_MIN_MOVE = 100;

/** The cash level's id and label — the same ones the Stats pyramid uses. */
export const LIQUIDITY_LEVEL_ID = UNASSIGNED_LIQUIDITY_ID;
export const LIQUIDITY_LEVEL_TITLE = 'Liquidity';

export interface GoalFlowPortfolio {
    id: string;
    name: string;
    value: number;
    state: GoalFlowPortfolioState;
}

export interface GoalFlowGoal {
    id: string;
    title: string;
    color: string;
    /** 'cash' marks level 0 — the pot, not a goal: it has no portfolios. */
    kind: 'goal' | 'cash';
    currentValue: number;
    currentPercent: number;
    targetPercent: number;
    targetValue: number;
    /** target − current: positive = must grow, negative = must shrink. */
    gap: number;
    /** Every portfolio attached to the level, whatever its state — the UI
     *  needs the excluded ones too, to offer them back. `currentValue` counts
     *  the active and frozen ones only. */
    portfolios: GoalFlowPortfolio[];
}

/** One end of a move: a portfolio, or the unearmarked cash pot. */
export interface GoalFlowEndpoint {
    kind: 'portfolio' | 'cash';
    /** Empty string on the cash pot, which is not a portfolio. */
    portfolioId: string;
    name: string;
    /** The pyramid level this end belongs to (a goal id, or the cash level). */
    goalId: string;
}

export interface GoalFlowMove {
    from: GoalFlowEndpoint;
    to: GoalFlowEndpoint;
    amount: number;
}

export type GoalFlowIssueKind =
    /** A goal must grow but has no portfolio free to receive the money. */
    | 'no-destination'
    /** A level must shrink but holds less than the gap asks for. */
    | 'not-enough-to-drain'
    /** Moves dropped for being too small to be worth their friction. */
    | 'below-minimum';

export interface GoalFlowIssue {
    kind: GoalFlowIssueKind;
    goalId?: string;
    goalTitle?: string;
    amount: number;
    /** 'no-destination' only: nothing is attached, or nothing is left active. */
    reason?: 'unattached' | 'none-active';
}

export interface GoalFlowPlan {
    goals: GoalFlowGoal[];
    /** Net worth inside the pyramid — the base the target percentages apply to. */
    total: number;
    moves: GoalFlowMove[];
    /** Portfolios not attached to any goal: outside the split entirely. */
    orphanPortfolios: GoalFlowPortfolio[];
    /** Portfolios the user took out of the split, with the goal they belong to. */
    excludedPortfolios: (GoalFlowPortfolio & { goalId: string; goalTitle: string })[];
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
    /** portfolioId → state; absent = 'active'. */
    portfolioStates?: Record<string, GoalFlowPortfolioState>;
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

/** The cash pot as an endpoint: one pot, no broker picked — the planner chooses. */
const cashEndpoint = (): GoalFlowEndpoint => ({
    kind: 'cash',
    portfolioId: '',
    name: LIQUIDITY_LEVEL_TITLE,
    goalId: LIQUIDITY_LEVEL_ID,
});

/**
 * Builds the pyramid split and the moves that would close it. Donors and
 * receivers are matched largest-first, which keeps the number of moves at
 * donors + receivers − 1 at worst: every extra move is another sell → buy round
 * trip, and each one leaks tax and two commissions.
 */
export const buildGoalFlowPlan = (input: GoalFlowInput): GoalFlowPlan => {
    const { goals, portfolios, brokers, targets } = input;
    const minMove = input.minMove ?? DEFAULT_MIN_MOVE;

    const valueById: Record<string, number> = {};
    portfolios.forEach(p => { valueById[p.id] = portfolioValue(p, input); });

    const stateOf = (id: string): GoalFlowPortfolioState => input.portfolioStates?.[id] ?? 'active';
    /** Counted in its goal: everything the user has not taken out of the split. */
    const counts = (p: GoalFlowPortfolio) => p.state !== 'excluded';
    /** Free to be sold from or bought into. */
    const movable = (p: GoalFlowPortfolio) => p.state === 'active';

    const sortedGoals = [...goals].sort((a, b) => a.order - b.order);

    // Which LEVEL each portfolio counts at, with parent/child groups read as one
    // portfolio — the same rule the Stats pyramid uses, so the two never
    // disagree about where a group's money sits.
    //
    // Only the level is merged, not the portfolios: the moves this planner
    // proposes, and the per-portfolio Move/Freeze/Skip switches beside them,
    // stay on real portfolios. A group is where the money IS; which member to
    // sell from is still a decision worth keeping.
    const levelOf = effectiveGoalIds(portfolios);

    const goalPortfolios = (goalId: string): GoalFlowPortfolio[] =>
        portfolios
            .filter(p => levelOf.get(p.id) === goalId)
            .map(p => ({ id: p.id, name: p.name, value: valueById[p.id] ?? 0, state: stateOf(p.id) }))
            .sort((a, b) => b.value - a.value);

    // Level 0 first, then the goals in their own order — the pyramid from the
    // ground up, so cash always sits before the first goal.
    const base: { id: string; title: string; kind: 'goal' | 'cash'; linked: GoalFlowPortfolio[]; currentValue: number; color: string }[] = [
        {
            id: LIQUIDITY_LEVEL_ID,
            title: LIQUIDITY_LEVEL_TITLE,
            kind: 'cash',
            linked: [],
            currentValue: unassignedLiquidityOf(brokers),
            color: LIQUIDITY_COLOR,
        },
        ...sortedGoals.map((goal, idx) => {
            const linked = goalPortfolios(goal.id);
            return {
                id: goal.id,
                title: goal.title,
                kind: 'goal' as const,
                linked,
                currentValue: linked.filter(counts).reduce((s, p) => s + p.value, 0),
                color: GOAL_FLOW_COLORS[idx % GOAL_FLOW_COLORS.length],
            };
        }),
    ];

    const total = base.reduce((s, g) => s + g.currentValue, 0);

    const flowGoals: GoalFlowGoal[] = base.map(({ id, title, kind, linked, currentValue, color }) => {
        const targetPercent = targets[id] ?? 0;
        const targetValue = (targetPercent / 100) * total;
        return {
            id,
            title,
            color,
            kind,
            currentValue,
            currentPercent: total > 0 ? (currentValue / total) * 100 : 0,
            targetPercent,
            targetValue,
            gap: targetValue - currentValue,
            portfolios: linked,
        };
    });

    const issues: GoalFlowIssue[] = [];

    // Donors: levels over target. A goal is drained proportionally to what each
    // of its portfolios holds, so the mix inside the goal survives the move;
    // the cash level is one pot and simply gives.
    const donors: { endpoint: GoalFlowEndpoint; amount: number }[] = [];
    const receivers: { endpoint: GoalFlowEndpoint; amount: number }[] = [];

    flowGoals.forEach(g => {
        if (g.gap < -0.5) {
            const need = -g.gap;
            if (g.kind === 'cash') {
                // Never promise more cash than is actually unearmarked: the rest
                // of the gap has to be closed by lowering the target.
                if (g.currentValue + 0.5 < need) {
                    issues.push({ kind: 'not-enough-to-drain', goalId: g.id, goalTitle: g.title, amount: need - g.currentValue });
                }
                const give = Math.min(need, g.currentValue);
                if (give > 0.5) donors.push({ endpoint: cashEndpoint(), amount: give });
                return;
            }
            // Frozen and excluded portfolios cannot give: the shortfall they
            // leave is reported rather than silently taken from elsewhere.
            const free = g.portfolios.filter(movable);
            const capacity = free.reduce((s, p) => s + p.value, 0);
            if (capacity + 0.5 < need) {
                issues.push({ kind: 'not-enough-to-drain', goalId: g.id, goalTitle: g.title, amount: need - capacity });
            }
            const per = spread(Math.min(need, capacity), free.map(p => ({ id: p.id, weight: p.value, max: p.value })));
            free.forEach(p => {
                const amount = per[p.id] ?? 0;
                if (amount > 0.5) {
                    donors.push({ endpoint: { kind: 'portfolio', portfolioId: p.id, name: p.name, goalId: g.id }, amount });
                }
            });
        } else if (g.gap > 0.5) {
            if (g.kind === 'cash') {
                // Cash can always receive: raising it is selling into the pot.
                receivers.push({ endpoint: cashEndpoint(), amount: g.gap });
                return;
            }
            const free = g.portfolios.filter(movable);
            if (free.length === 0) {
                issues.push({
                    kind: 'no-destination', goalId: g.id, goalTitle: g.title, amount: g.gap,
                    reason: g.portfolios.length === 0 ? 'unattached' : 'none-active',
                });
                return;
            }
            // A goal held entirely in cash-less brand new portfolios has no
            // weights to go by, so the gap is split evenly instead.
            const anyValue = free.some(p => p.value > 0);
            const per = spread(g.gap, free.map(p => ({ id: p.id, weight: anyValue ? p.value : 1 })));
            free.forEach(p => {
                const amount = per[p.id] ?? 0;
                if (amount > 0.5) {
                    receivers.push({ endpoint: { kind: 'portfolio', portfolioId: p.id, name: p.name, goalId: g.id }, amount });
                }
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
            moves.push({ from: donor.endpoint, to: receiver.endpoint, amount });
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

    // Orphaned by its EFFECTIVE level, not its own goal: a member merged onto a
    // parent that has a goal is inside the split, and listing it here as well
    // would show the same money twice.
    const orphanPortfolios = portfolios
        .filter(p => {
            const level = levelOf.get(p.id);
            return !level || !goals.some(g => g.id === level);
        })
        .map(p => ({ id: p.id, name: p.name, value: valueById[p.id] ?? 0, state: stateOf(p.id) }))
        .filter(p => p.value > 0)
        .sort((a, b) => b.value - a.value);

    const excludedPortfolios = flowGoals
        .flatMap(g => g.portfolios
            .filter(p => p.state === 'excluded')
            .map(p => ({ ...p, goalId: g.id, goalTitle: g.title })))
        .sort((a, b) => b.value - a.value);

    return { goals: flowGoals, total, moves, orphanPortfolios, excludedPortfolios, issues };
};
