import React, { useRef, useCallback, useEffect, useMemo } from 'react';

export interface GoalItem {
    id: string;
    title: string;
    color: string;
}

export interface GoalRebalanceWidgetProps {
    goals: GoalItem[];                              // sorted by order already
    targetAllocs: Record<string, number>;           // goalId → %
    onTargetChange: (allocs: Record<string, number>) => void;
    currentGoalValues: Record<string, number>;      // goalId → €
    totalCurrentValue: number;
}

const MIN_PCT = 5;
const fmt = (v: number) => `€${Math.round(Math.abs(v)).toLocaleString('it-IT')}`;

const GoalRebalanceWidget: React.FC<GoalRebalanceWidgetProps> = ({
    goals, targetAllocs, onTargetChange, currentGoalValues, totalCurrentValue,
}) => {
    const barRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{
        handleIdx: number;
        startX: number;
        startAllocs: number[];  // parallel to goals array
    } | null>(null);

    const onMouseMove = useCallback((e: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag || !barRef.current) return;
        const W = barRef.current.getBoundingClientRect().width;
        if (W === 0) return;

        const delta = ((e.clientX - drag.startX) / W) * 100;
        const idx = drag.handleIdx;
        const next = [...drag.startAllocs];

        // Moving handle[idx] shifts boundary between goals[idx] and goals[idx+1] only
        const newLeft = Math.max(MIN_PCT, drag.startAllocs[idx] + delta);
        const newRight = Math.max(MIN_PCT, drag.startAllocs[idx + 1] - delta);
        if (newLeft < MIN_PCT || newRight < MIN_PCT) return;

        next[idx] = newLeft;
        next[idx + 1] = newRight;
        // Re-enforce total = 100 by adjusting last segment
        const sumExceptLast = next.reduce((s, v, i) => (i !== goals.length - 1 ? s + v : s), 0);
        next[goals.length - 1] = 100 - sumExceptLast;
        if (next[goals.length - 1] < MIN_PCT) return;

        const result: Record<string, number> = {};
        goals.forEach((g, i) => { result[g.id] = next[i]; });
        onTargetChange(result);
    }, [goals, onTargetChange]);

    const onMouseUp = useCallback(() => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
    }, [onMouseMove]);

    const onHandleMouseDown = useCallback((handleIdx: number, e: React.MouseEvent) => {
        e.preventDefault();
        dragRef.current = {
            handleIdx,
            startX: e.clientX,
            startAllocs: goals.map(g => targetAllocs[g.id] ?? 0),
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }, [goals, targetAllocs, onMouseMove, onMouseUp]);

    useEffect(() => () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
    }, [onMouseMove, onMouseUp]);

    const currentPercs = useMemo<Record<string, number>>(() => {
        if (totalCurrentValue <= 0) {
            const r: Record<string, number> = {};
            goals.forEach(g => { r[g.id] = 0; });
            return r;
        }
        const r: Record<string, number> = {};
        goals.forEach(g => {
            r[g.id] = ((currentGoalValues[g.id] ?? 0) / totalCurrentValue) * 100;
        });
        return r;
    }, [goals, currentGoalValues, totalCurrentValue]);

    const suggestedInvestment = useMemo(() => {
        return goals.reduce((sum, g) => {
            const targetEur = ((targetAllocs[g.id] ?? 0) / 100) * totalCurrentValue;
            return sum + Math.max(0, targetEur - (currentGoalValues[g.id] ?? 0));
        }, 0);
    }, [goals, targetAllocs, currentGoalValues, totalCurrentValue]);

    const renderStaticBar = () => (
        <div style={{ display: 'flex', height: 32, borderRadius: 6, overflow: 'hidden', width: '100%' }}>
            {goals.map(g => {
                const pct = totalCurrentValue > 0
                    ? ((currentGoalValues[g.id] ?? 0) / totalCurrentValue) * 100
                    : 0;
                return (
                    <div
                        key={g.id}
                        style={{
                            width: `${pct}%`,
                            background: g.color,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            overflow: 'hidden',
                        }}
                    >
                        {pct > 8 && (
                            <span style={{ color: '#fff', fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                {pct.toFixed(0)}%
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );

    return (
        <div className="allocation-card" style={{ border: '1px solid var(--border-color)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <h3 className="section-title" style={{ margin: 0 }}>Goal Allocation</h3>
                <div style={{ display: 'flex', gap: '1.25rem' }}>
                    {goals.map(g => (
                        <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem' }}>
                            <span style={{ width: 9, height: 9, borderRadius: '50%', background: g.color, display: 'inline-block', flexShrink: 0 }} />
                            <span style={{ color: 'var(--text-secondary)' }}>{g.title}</span>
                        </div>
                    ))}
                </div>
            </div>

            {/* Current bar */}
            <div style={{ marginBottom: 'var(--space-3)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                    Current
                </div>
                {renderStaticBar()}
            </div>

            {/* Target bar (draggable) */}
            <div style={{ marginBottom: 'var(--space-5)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                    Target{' '}
                    <span style={{ fontStyle: 'italic', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
                        — drag to adjust
                    </span>
                </div>
                <div
                    ref={barRef}
                    style={{ display: 'flex', height: 36, borderRadius: 6, overflow: 'hidden', width: '100%', userSelect: 'none' }}
                >
                    {goals.map((g, i) => {
                        const pct = targetAllocs[g.id] ?? 0;
                        const isLast = i === goals.length - 1;
                        return (
                            <React.Fragment key={g.id}>
                                <div
                                    style={{
                                        width: `${pct}%`,
                                        background: g.color,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        overflow: 'hidden',
                                        flexShrink: 0,
                                        minWidth: 0,
                                    }}
                                >
                                    {pct > 8 && (
                                        <span style={{ color: '#fff', fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
                                            {pct.toFixed(0)}%
                                        </span>
                                    )}
                                </div>
                                {!isLast && (
                                    <div
                                        onMouseDown={(e) => onHandleMouseDown(i, e)}
                                        style={{
                                            width: 8,
                                            background: 'var(--bg-surface)',
                                            cursor: 'col-resize',
                                            flexShrink: 0,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                        }}
                                    >
                                        <div style={{ width: 2, height: 16, background: 'var(--border-color)', borderRadius: 1 }} />
                                    </div>
                                )}
                            </React.Fragment>
                        );
                    })}
                </div>
            </div>

            {/* Gap cards */}
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${goals.length}, 1fr)`, gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
                {goals.map(g => {
                    const targetEur = ((targetAllocs[g.id] ?? 0) / 100) * totalCurrentValue;
                    const gapEur = targetEur - (currentGoalValues[g.id] ?? 0);
                    const gapPct = (targetAllocs[g.id] ?? 0) - (currentPercs[g.id] ?? 0);
                    return (
                        <div
                            key={g.id}
                            style={{
                                padding: 'var(--space-3)',
                                background: 'var(--bg-card)',
                                borderRadius: 'var(--radius-sm)',
                                border: '1px solid var(--border-color)',
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem' }}>
                                <span style={{ width: 8, height: 8, borderRadius: '50%', background: g.color, display: 'inline-block', flexShrink: 0 }} />
                                <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{g.title}</span>
                            </div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.8 }}>
                                <div>Current: {fmt(currentGoalValues[g.id] ?? 0)} ({(currentPercs[g.id] ?? 0).toFixed(1)}%)</div>
                                <div>Target: {(targetAllocs[g.id] ?? 0).toFixed(0)}%</div>
                                <div style={{ fontWeight: 600, color: gapEur > 50 ? 'var(--color-success)' : gapEur < -50 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                    Gap: {gapEur >= 0 ? '+' : '−'}{fmt(gapEur)}{' '}
                                    <span style={{ fontWeight: 400 }}>({gapPct >= 0 ? '+' : ''}{gapPct.toFixed(1)}%)</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Suggestion */}
            {suggestedInvestment > 50 && (
                <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.3rem 0.75rem',
                    borderRadius: 999,
                    background: 'rgba(59,130,246,0.08)',
                    border: '1px solid rgba(59,130,246,0.25)',
                    fontSize: '0.82rem',
                    color: '#3B82F6',
                }}>
                    <span>💡</span>
                    <span>Suggested investment to close gaps: <strong>{fmt(suggestedInvestment)}</strong></span>
                </div>
            )}
        </div>
    );
};

export default GoalRebalanceWidget;
