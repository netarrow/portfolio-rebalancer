import React, { useEffect, useMemo } from 'react';
import type { AssetDefinition, Broker, Goal, Portfolio, Transaction } from '../../types';
import { buildGoalFlowPlan, DEFAULT_MIN_MOVE, type GoalFlowMove } from '../../utils/goalFlows';
import type { RelocationRequest } from '../../utils/fundRelocation';
import GoalAllocationBar, { type GoalBarItem } from './GoalAllocationBar';

/**
 * Goal Flows — the editable pyramid, answered in portfolios.
 *
 * Dragging the target bar states where the wealth should sit across the goals.
 * Because a goal is only ever fed by the portfolios attached to it, the answer
 * is a list of whole-portfolio moves: € out of the portfolios of the goals that
 * are over target, into the portfolios of the goals that are under it. What
 * gets sold and bought inside those portfolios is decided one step later, by
 * the relocation planner, which is also the only thing that can price the
 * round trip — so the moves are handed to the queue rather than executed here.
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

const toRequest = (move: GoalFlowMove): RelocationRequest => ({
    from: { kind: 'portfolio', portfolioId: move.fromPortfolioId },
    to: { kind: 'portfolio', portfolioId: move.toPortfolioId },
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

    // Targets are persisted (and synced), but a new or deleted goal leaves them
    // incomplete: fall back to an even split rather than to a bar that does not
    // add up to the wealth it is splitting.
    useEffect(() => {
        if (plan.goals.length === 0) return;
        const complete = plan.goals.every(g => g.id in targets);
        const sum = plan.goals.reduce((s, g) => s + (targets[g.id] ?? 0), 0);
        if (complete && Math.abs(sum - 100) < 0.5 && Object.keys(targets).length === plan.goals.length) return;
        const equal = parseFloat((100 / plan.goals.length).toFixed(2));
        const next: Record<string, number> = {};
        plan.goals.forEach((g, i) => {
            next[g.id] = i < plan.goals.length - 1 ? equal : 100 - equal * (plan.goals.length - 1);
        });
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
        () => plan.goals.map(g => ({ id: g.id, title: g.title, color: g.color, currentValue: g.currentValue })),
        [plan.goals]
    );

    const movedTotal = plan.moves.reduce((s, m) => s + m.amount, 0);

    if (plan.goals.length === 0) {
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
                Drag the target bar to say where your wealth should sit across the goals. Because each
                portfolio is attached to a goal, closing a gap means <strong>moving money between whole
                portfolios</strong> — never picking assets inside them. Queue the moves below and the page
                prices what the round trip actually costs.
            </p>

            <GoalAllocationBar
                goals={barGoals}
                targetAllocs={targets}
                onTargetChange={onTargetsChange}
                total={plan.total}
            />

            <div className="reloc-flow-head">
                <h4 className="reloc-flow-title">
                    Moves between portfolios
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
                    Nothing to move: every goal is within {eur0(DEFAULT_MIN_MOVE)} of its target.
                </p>
            ) : (
                <div className="reloc-flow-list">
                    {plan.moves.map((move, i) => (
                        <div className="reloc-flow" key={`${move.fromPortfolioId}-${move.toPortfolioId}-${i}`}>
                            <div className="reloc-flow-main">
                                <div className="reloc-flow-route">
                                    <span className="reloc-flow-endpoint">
                                        <span className="reloc-flow-dot" style={{ background: goalColorById[move.fromGoalId] }} />
                                        {move.fromPortfolioName}
                                    </span>
                                    <span className="reloc-flow-arrow" aria-hidden="true">→</span>
                                    <span className="reloc-flow-endpoint">
                                        <span className="reloc-flow-dot" style={{ background: goalColorById[move.toGoalId] }} />
                                        {move.toPortfolioName}
                                    </span>
                                </div>
                                <div className="reloc-flow-sub">
                                    {goalTitleById[move.fromGoalId]} → {goalTitleById[move.toGoalId]}
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
                        {issue.kind === 'not-enough-to-drain' && (
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
                The percentages apply to the {eur0(plan.total)} held inside the goals. Cash that is not earmarked
                to a portfolio sits below every goal in the pyramid: deploy it with a Cash → Portfolio move in the form below.
            </p>
        </div>
    );
};

export default GoalFlowPlanner;
