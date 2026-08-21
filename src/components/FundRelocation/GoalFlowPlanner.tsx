import React, { useEffect, useMemo } from 'react';
import type { AssetDefinition, Broker, Goal, Portfolio, Transaction } from '../../types';
import {
    buildGoalFlowPlan,
    DEFAULT_MIN_MOVE,
    LIQUIDITY_LEVEL_ID,
    type GoalFlowEndpoint,
    type GoalFlowMove,
} from '../../utils/goalFlows';
import type { RelocationRequest } from '../../utils/fundRelocation';
import GoalAllocationBar, { type GoalBarItem } from './GoalAllocationBar';

/**
 * Goal Flows — the editable pyramid, answered in portfolios.
 *
 * Dragging the target bar states where the wealth should sit across the levels.
 * Because a goal is only ever fed by the portfolios attached to it, the answer
 * is a list of whole-portfolio moves: € out of the portfolios of the levels that
 * are over target, into the portfolios of the levels that are under it. What
 * gets sold and bought inside those portfolios is decided one step later, by
 * the relocation planner, which is also the only thing that can price the
 * round trip — so the moves are handed to the queue rather than executed here.
 *
 * Level 0 — cash not earmarked to any portfolio — is one of those levels: drag
 * it down and the moves deploy the cash, drag it up and they raise it by
 * selling. It is the only level whose target may go to zero, since an empty
 * cash pot is a legitimate destination for the plan.
 */

const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;

export interface GoalFlowPlannerProps {
    goals: Goal[];
    portfolios: Portfolio[];
    transactions: Transaction[];
    brokers: Broker[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    targets: Record<string, number>;
    onTargetsChange: (targets: Record<string, number>) => void;
    onQueueMoves: (requests: RelocationRequest[]) => void;
}

/** Cash keeps no broker: the relocation planner picks where it comes from. */
const toEndpoint = (e: GoalFlowEndpoint): RelocationRequest['from'] =>
    e.kind === 'cash' ? { kind: 'cash' } : { kind: 'portfolio', portfolioId: e.portfolioId };

const toRequest = (move: GoalFlowMove): RelocationRequest => ({
    from: toEndpoint(move.from),
    to: toEndpoint(move.to),
    netAmount: move.amount,
});

const GoalFlowPlanner: React.FC<GoalFlowPlannerProps> = ({
    goals, portfolios, transactions, brokers, assetSettings, marketData,
    targets, onTargetsChange, onQueueMoves,
}) => {
    const plan = useMemo(
        () => buildGoalFlowPlan({ goals, portfolios, transactions, brokers, assetSettings, marketData, targets }),
        [goals, portfolios, transactions, brokers, assetSettings, marketData, targets]
    );

    // Targets are persisted (and synced), but a new or deleted level leaves them
    // incomplete: reconcile rather than render a bar that does not add up to the
    // wealth it is splitting. A level with no target yet — the cash level, for
    // everyone who set their targets before it existed — starts at what it holds
    // today, so reconciling never invents a gap the user did not ask for; the
    // levels that DO have a target keep their proportions and are rescaled to
    // whatever is left.
    useEffect(() => {
        if (plan.goals.length === 0) return;
        const complete = plan.goals.every(g => g.id in targets);
        const sum = plan.goals.reduce((s, g) => s + (targets[g.id] ?? 0), 0);
        if (complete && Math.abs(sum - 100) < 0.5 && Object.keys(targets).length === plan.goals.length) return;

        const seeded = plan.goals.map(g => (g.id in targets ? targets[g.id] : g.currentPercent));
        const seededSum = seeded.reduce((s, v) => s + v, 0);
        const next: Record<string, number> = {};
        if (seededSum > 0.5) {
            let placed = 0;
            plan.goals.forEach((g, i) => {
                const v = i < plan.goals.length - 1
                    ? parseFloat(((seeded[i] / seededSum) * 100).toFixed(2))
                    : parseFloat((100 - placed).toFixed(2));
                placed += v;
                next[g.id] = v;
            });
        } else {
            const equal = parseFloat((100 / plan.goals.length).toFixed(2));
            plan.goals.forEach((g, i) => {
                next[g.id] = i < plan.goals.length - 1 ? equal : 100 - equal * (plan.goals.length - 1);
            });
        }
        onTargetsChange(next);
    }, [plan.goals, targets, onTargetsChange]);

    const goalTitleById = useMemo<Record<string, string>>(() => {
        const map: Record<string, string> = {};
        plan.goals.forEach(g => { map[g.id] = g.title; });
        return map;
    }, [plan.goals]);

    const goalColorById = useMemo<Record<string, string>>(() => {
        const map: Record<string, string> = {};
        plan.goals.forEach(g => { map[g.id] = g.color; });
        return map;
    }, [plan.goals]);

    const barGoals = useMemo<GoalBarItem[]>(
        // Cash is the one level that may be emptied: every goal keeps the 5% floor.
        () => plan.goals.map(g => ({
            id: g.id,
            title: g.title,
            color: g.color,
            currentValue: g.currentValue,
            minPercent: g.kind === 'cash' ? 0 : undefined,
        })),
        [plan.goals]
    );

    const movedTotal = plan.moves.reduce((s, m) => s + m.amount, 0);

    // The cash level exists even with no goals configured, and a bar with a
    // single segment at 100% is not a split: keep the empty state keyed on the
    // goals themselves.
    if (!plan.goals.some(g => g.kind === 'goal')) {
        return (
            <div className="reloc-card">
                <h3 className="reloc-section-title">Goal flows</h3>
                <p className="reloc-empty">
                    No goals defined yet. Create goals and attach portfolios to them (Planning → Goals)
                    to plan moves by goal instead of by portfolio.
                </p>
            </div>
        );
    }

    return (
        <div className="reloc-card">
            <h3 className="reloc-section-title">Goal flows</h3>
            <p className="reloc-intro" style={{ marginBottom: 'var(--space-5)' }}>
                Drag the target bar to say where your wealth should sit across the pyramid — the cash you
                have not earmarked to any portfolio included, on the far left, below every goal. Because each
                portfolio is attached to a goal, closing a gap means <strong>moving money between whole
                portfolios</strong> (or in and out of cash) — never picking assets inside them. Queue the
                moves below and the page prices what the round trip actually costs.
            </p>

            <GoalAllocationBar
                goals={barGoals}
                targetAllocs={targets}
                onTargetChange={onTargetsChange}
                total={plan.total}
            />

            <div className="reloc-flow-head">
                <h4 className="reloc-flow-title">
                    Moves
                    {plan.moves.length > 0 && <span className="reloc-count-badge">{plan.moves.length}</span>}
                </h4>
                {plan.moves.length > 0 && (
                    <button
                        type="button"
                        className="reloc-btn primary"
                        onClick={() => onQueueMoves(plan.moves.map(toRequest))}
                    >
                        Queue all {plan.moves.length} move{plan.moves.length > 1 ? 's' : ''} · {eur0(movedTotal)}
                    </button>
                )}
            </div>

            {plan.moves.length === 0 ? (
                <p className="reloc-empty">
                    Nothing to move: every level is within {eur0(DEFAULT_MIN_MOVE)} of its target.
                </p>
            ) : (
                <div className="reloc-flow-list">
                    {plan.moves.map((move, i) => (
                        <div className="reloc-flow" key={`${move.from.goalId}-${move.from.portfolioId}-${move.to.goalId}-${move.to.portfolioId}-${i}`}>
                            <div className="reloc-flow-main">
                                <div className="reloc-flow-route">
                                    <span className="reloc-flow-endpoint">
                                        <span className="reloc-flow-dot" style={{ background: goalColorById[move.from.goalId] }} />
                                        {move.from.name}
                                    </span>
                                    <span className="reloc-flow-arrow" aria-hidden="true">→</span>
                                    <span className="reloc-flow-endpoint">
                                        <span className="reloc-flow-dot" style={{ background: goalColorById[move.to.goalId] }} />
                                        {move.to.name}
                                    </span>
                                </div>
                                <div className="reloc-flow-sub">
                                    {goalTitleById[move.from.goalId]} → {goalTitleById[move.to.goalId]}
                                    {move.from.kind === 'cash' && ' · deploying cash, nothing is sold'}
                                    {move.to.kind === 'cash' && ' · raising cash, nothing is bought'}
                                </div>
                            </div>
                            <div className="reloc-flow-amount">{eur0(move.amount)}</div>
                            <button
                                type="button"
                                className="reloc-btn ghost"
                                onClick={() => onQueueMoves([toRequest(move)])}
                            >
                                Queue
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {plan.issues.map((issue, i) => (
                <div className="reloc-warning" key={`${issue.kind}-${i}`}>
                    <span aria-hidden="true">⚠️</span>
                    <span>
                        {issue.kind === 'no-destination' && (
                            <>“{issue.goalTitle}” needs {eur0(issue.amount)} but has no portfolio attached to receive it — attach one from the Portfolios page.</>
                        )}
                        {issue.kind === 'not-enough-to-drain' && issue.goalId === LIQUIDITY_LEVEL_ID && (
                            <>Cash is {eur0(issue.amount)} short of the drop you asked for: the rest of the liquidity is earmarked to portfolios, so it already counts inside their goals.</>
                        )}
                        {issue.kind === 'not-enough-to-drain' && issue.goalId !== LIQUIDITY_LEVEL_ID && (
                            <>“{issue.goalTitle}” is {eur0(issue.amount)} short of what its own portfolios can give up: the rest has to come from new money or from cash.</>
                        )}
                        {issue.kind === 'below-minimum' && (
                            <>{eur0(issue.amount)} was left unmoved: the remaining legs are under {eur0(DEFAULT_MIN_MOVE)} and would lose more to tax and commissions than the drift costs.</>
                        )}
                    </span>
                </div>
            ))}

            {plan.orphanPortfolios.length > 0 && (
                <p className="reloc-flow-note">
                    Outside the split: {plan.orphanPortfolios.map(p => `${p.name} (${eur0(p.value)})`).join(', ')} —
                    not attached to any goal, so they neither count toward the percentages nor take part in the moves.
                </p>
            )}

            <p className="reloc-flow-note">
                The percentages apply to the {eur0(plan.total)} held in the pyramid: the goals plus the cash level.
                Cash earmarked to a portfolio is not in that level — it already counts inside that portfolio's own goal.
            </p>
        </div>
    );
};

export default GoalFlowPlanner;
