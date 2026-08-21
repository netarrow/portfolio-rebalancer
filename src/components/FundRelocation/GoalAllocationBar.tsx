import React, { useRef, useCallback, useEffect, useMemo } from 'react';

/**
 * The goal pyramid as one editable bar: today's split on top, the target split
 * underneath with draggable boundaries.
 *
 * It only edits percentages. What it takes to GET to those percentages is the
 * planner's answer (moves between whole portfolios), which is why this
 * component knows nothing about assets, orders or friction.
 */

export interface GoalBarItem {
    id: string;
    title: string;
    color: string;
    currentValue: number;
    /** Floor this segment cannot be dragged below. Defaults to MIN_PCT. */
    minPercent?: number;
}

export interface GoalAllocationBarProps {
    /** In goal order — the pyramid's own order. */
    goals: GoalBarItem[];
    /** goalId → target %. */
    targetAllocs: Record<string, number>;
    onTargetChange: (allocs: Record<string, number>) => void;
    total: number;
}

// A goal is a bucket you keep something in; cash is one you are allowed to
// empty, so the floor is per-segment rather than global.
const MIN_PCT = 5;
// en-IE, like every other euro figure on this page: the it-IT dot separator
// reads as a decimal point next to them and turns €46.093 into forty-six euros.
const fmt = (v: number) => `€${Math.round(Math.abs(v)).toLocaleString('en-IE')}`;

const GoalAllocationBar: React.FC<GoalAllocationBarProps> = ({ goals, targetAllocs, onTargetChange, total }) => {
    const barRef = useRef<HTMLDivElement>(null);
    /** Where the drag started, so every move is measured from the same origin. */
    const dragRef = useRef<{ startX: number; startAllocs: number[] } | null>(null);
    /** Tears the live drag down — held in a ref so unmounting mid-drag can call it. */
    const endDragRef = useRef<(() => void) | null>(null);

    // Pointer events rather than mouse ones: the same handler then drives the
    // drag with a finger, and this bar is the whole point of the card on a phone.
    // The listeners go on synchronously here rather than from an effect keyed on
    // a "dragging" state, so a fast flick cannot lose the moves that arrive
    // before React has committed the first render of the drag.
    const onHandlePointerDown = useCallback((handleIdx: number, e: React.PointerEvent) => {
        e.preventDefault();
        endDragRef.current?.();
        dragRef.current = { startX: e.clientX, startAllocs: goals.map(g => targetAllocs[g.id] ?? 0) };
        const floor = (i: number) => goals[i].minPercent ?? MIN_PCT;
        // The floor stops a segment being shrunk past it — it must never freeze
        // one that is ALREADY below it (targets seeded from today's split can
        // start under 5%), or the whole bar becomes undraggable: the last
        // segment is re-derived on every drag, so its check fires even when the
        // drag never touched it.
        const blocked = (i: number, next: number, start: number) =>
            next < floor(i) && next < start - 0.001;

        const onMove = (ev: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag || !barRef.current) return;
            const W = barRef.current.getBoundingClientRect().width;
            if (W === 0) return;

            const delta = ((ev.clientX - drag.startX) / W) * 100;

            // The handle shifts the boundary between goals[idx] and goals[idx+1]
            // only: every other goal keeps the share the user already chose.
            const newLeft = drag.startAllocs[handleIdx] + delta;
            const newRight = drag.startAllocs[handleIdx + 1] - delta;
            if (blocked(handleIdx, newLeft, drag.startAllocs[handleIdx])) return;
            if (blocked(handleIdx + 1, newRight, drag.startAllocs[handleIdx + 1])) return;

            const next = [...drag.startAllocs];
            next[handleIdx] = newLeft;
            next[handleIdx + 1] = newRight;
            // Re-enforce total = 100 by adjusting last segment
            const sumExceptLast = next.reduce((s, v, i) => (i !== goals.length - 1 ? s + v : s), 0);
            next[goals.length - 1] = 100 - sumExceptLast;
            const last = goals.length - 1;
            if (blocked(last, next[last], drag.startAllocs[last])) return;

            const result: Record<string, number> = {};
            goals.forEach((g, i) => { result[g.id] = next[i]; });
            onTargetChange(result);
        };
        const onUp = () => endDragRef.current?.();

        endDragRef.current = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            endDragRef.current = null;
            dragRef.current = null;
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }, [goals, targetAllocs, onTargetChange]);

    useEffect(() => () => endDragRef.current?.(), []);

    const currentPercs = useMemo<Record<string, number>>(() => {
        const r: Record<string, number> = {};
        goals.forEach(g => {
            r[g.id] = total > 0 ? (g.currentValue / total) * 100 : 0;
        });
        return r;
    }, [goals, total]);

    const renderStaticBar = () => (
        <div style={{ display: 'flex', height: 32, borderRadius: 6, overflow: 'hidden', width: '100%' }}>
            {goals.map(g => {
                const pct = currentPercs[g.id] ?? 0;
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
        <div>
            {/* Legend */}
            <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
                {goals.map(g => (
                    <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem' }}>
                        <span style={{ width: 9, height: 9, borderRadius: '50%', background: g.color, display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ color: 'var(--text-secondary)' }}>{g.title}</span>
                    </div>
                ))}
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
                    style={{ display: 'flex', height: 36, borderRadius: 6, overflow: 'hidden', width: '100%', userSelect: 'none', touchAction: 'none' }}
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
                                        onPointerDown={(e) => onHandlePointerDown(i, e)}
                                        style={{
                                            width: 8,
                                            background: 'var(--bg-surface)',
                                            cursor: 'col-resize',
                                            flexShrink: 0,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            touchAction: 'none',
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

            {/* Gap cards. The class is the hook mobile.css uses to drop them to
                two per row — four columns of euro figures do not fit a phone. */}
            <div className="goal-gap-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--space-3)' }}>
                {goals.map(g => {
                    const targetEur = ((targetAllocs[g.id] ?? 0) / 100) * total;
                    const gapEur = targetEur - g.currentValue;
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
                                <div>Current: {fmt(g.currentValue)} ({(currentPercs[g.id] ?? 0).toFixed(1)}%)</div>
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
        </div>
    );
};

export default GoalAllocationBar;
