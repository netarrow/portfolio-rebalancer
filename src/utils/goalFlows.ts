import type { AssetDefinition, Broker, Goal, GoalFlowPortfolioState, Portfolio, Transaction } from '../types';
import { effectiveGoalIds, LIQUIDITY_COLOR, UNASSIGNED_LIQUIDITY_ID, unassignedLiquidityOf } from './goalDistribution';
import { calculateAssets, injectCashAssets } from './portfolioCalculations';
import { buildPortfolioTree } from './portfolioGroups';
import { configuredShares, mergedRatio } from './mergedGroup';
import { splitGroupAmount } from './mergedPortfolioView';

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
 * A parent/child group is one unit for the split and several for the moves: the
 * level hands it its money as one pot, and the pot is then shared across its
 * members by the configured parent/child ratio — from whoever is heaviest
 * against it, to whoever is lightest. So closing a goal gap also closes the
 * group's ratio, exactly as picking the group as an endpoint on the relocation
 * form does, instead of handing a group its money in the proportion it is
 * already wrong in.
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

/** A parent/child group counts as ONE unit at a level; a standalone is its own. */
interface LevelBlock {
    /** The group's parent id, or the standalone's own id. */
    id: string;
    /** The block's movable members, in the order they were given. */
    members: GoalFlowPortfolio[];
    value: number;
}

/** Resolution a level split needs: real portfolios, and who belongs to which group. */
interface LevelSplitContext {
    portfolioById: Map<string, Portfolio>;
    /** portfolioId -> the id of the block it belongs to (its group's parent, or itself). */
    blockIdOf: Map<string, string>;
}

/**
 * Split an amount over the movable portfolios of one level. `amount` is
 * positive for money arriving and negative for money leaving; the result is the
 * positive magnitude each portfolio takes on, whichever way it flows.
 *
 * The level is split over BLOCKS first — a parent/child group being one block,
 * the same unit the pyramid already counts it as — in proportion to what each
 * one holds, so the mix between a level's independent pots survives the move.
 * What lands on a group block is then split across its members by the
 * configured parent/child ratio: taken from whoever is heaviest against it,
 * given to whoever is lightest.
 *
 * That second stage is what makes this planner agree with a group endpoint on
 * the relocation form. Weighting the members by what they hold instead — which
 * is what this did before groups had a configured ratio — hands a group its
 * money in exactly the proportion it is already wrong in, so the ratio survives
 * the move untouched and the same page proposes two different answers.
 */
const splitOverLevel = (
    free: GoalFlowPortfolio[],
    amount: number,
    ctx: LevelSplitContext,
): Record<string, number> => {
    const magnitude = Math.abs(amount);
    if (free.length === 0 || magnitude <= 0) return {};
    const outflow = amount < 0;

    const byBlock = new Map<string, GoalFlowPortfolio[]>();
    free.forEach(p => {
        const key = ctx.blockIdOf.get(p.id) ?? p.id;
        const members = byBlock.get(key);
        if (members) members.push(p); else byBlock.set(key, [p]);
    });
    const blocks: LevelBlock[] = Array.from(byBlock, ([id, members]) => ({
        id,
        members,
        value: members.reduce((s, m) => s + m.value, 0),
    }));

    // A level whose blocks are all worth nothing has no proportions to go by,
    // so the amount is spread evenly instead — the same fallback the
    // per-portfolio split used.
    const anyValue = blocks.some(b => b.value > 0);
    const perBlock = spread(magnitude, blocks.map(b => ({
        id: b.id,
        weight: anyValue ? b.value : 1,
        // Only money leaving is capped: nothing limits what a block can receive.
        max: outflow ? b.value : undefined,
    })));

    const out: Record<string, number> = {};
    const add = (portfolioId: string, value: number) => {
        if (!(value > 0)) return;
        out[portfolioId] = (out[portfolioId] ?? 0) + value;
    };

    blocks.forEach(block => {
        const share = perBlock[block.id] ?? 0;
        if (!(share > 0)) return;
        if (block.members.length === 1) { add(block.members[0].id, share); return; }

        // Shares are resolved over the MOVABLE members only, so a frozen member
        // neither receives nor is planned down: the ratio is closed among the
        // portfolios this planner is actually allowed to touch.
        const memberValues = block.members.flatMap(m => {
            const portfolio = ctx.portfolioById.get(m.id);
            // `mergedRatio` reads the portfolio and its value only, so the
            // per-ticker maps it also takes are left empty here.
            return portfolio
                ? [{ portfolio, totalValue: m.value, valueByTicker: {}, quantityByTicker: {} }]
                : [];
        });
        const { members: ratio } = mergedRatio(
            memberValues,
            configuredShares(memberValues.map(m => m.portfolio)),
        );

        const legs = splitGroupAmount(
            {
                memberIds: block.members.map(m => m.id),
                members: ratio,
                valueByMember: Object.fromEntries(block.members.map(m => [m.id, m.value])),
            },
            outflow ? -share : share,
        );

        // A block that cannot be split by ratio at all (every member worth
        // nothing on the way out, say) still has to place its money, or the
        // level would silently move less than its gap asks for.
        if (legs.length === 0) {
            const fallback = spread(share, block.members.map(m => ({
                id: m.id,
                weight: anyValue ? m.value : 1,
                max: outflow ? m.value : undefined,
            })));
            Object.entries(fallback).forEach(([id, value]) => add(id, value));
            return;
        }
        legs.forEach(leg => add(leg.portfolioId, Math.abs(leg.amount)));
    });

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

    // ...but a group IS one unit when the level's gap is shared out: the block
    // gets its money as one pot and then splits it across its members by the
    // configured parent/child ratio, so the goal planner and a group endpoint on
    // the relocation form propose the same thing.
    const blockIdOf = new Map<string, string>();
    buildPortfolioTree(portfolios).groups.forEach(group => {
        group.members.forEach(m => blockIdOf.set(m.id, group.parent.id));
    });
    const splitCtx: LevelSplitContext = {
        portfolioById: new Map(portfolios.map(p => [p.id, p])),
        blockIdOf,
    };

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
    // of its BLOCKS holds, so the mix inside the goal survives the move, and a
    // group block then gives from whichever member is heaviest against the
    // parent/child ratio; the cash level is one pot and simply gives.
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
            const per = splitOverLevel(free, -Math.min(need, capacity), splitCtx);
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
            const per = splitOverLevel(free, g.gap, splitCtx);
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
