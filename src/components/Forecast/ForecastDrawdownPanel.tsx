import React from 'react';
import {
    DRAWDOWN_SCENARIOS, SHOCK_CLASS_LABELS,
    type DrawdownScenario, type ShockClass,
} from '../../utils/drawdownScenarios';

/**
 * The crash picker.
 *
 * Its job is to make the scenario's assumptions readable BEFORE the chart moves:
 * which class loses what, which ones gain, and what that adds up to for this
 * particular mix. A stress test whose severity you cannot see is a number
 * generator — the row of classes is the point of the panel, not decoration.
 */

const pct = (v: number, digits = 0) =>
    `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(digits)}%`;

const eur0 = (v: number) => `€${Math.round(v).toLocaleString()}`;

const chip = (active: boolean): React.CSSProperties => ({
    padding: '0.3rem 0.7rem',
    background: active ? 'var(--color-primary)' : 'var(--bg-input)',
    color: active ? 'white' : 'var(--text-secondary)',
    border: `1px solid ${active ? 'var(--color-primary)' : 'var(--border-color)'}`,
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.75rem',
    whiteSpace: 'nowrap',
});

export interface DrawdownTrough {
    /** Deepest net worth inside the window. */
    value: number;
    /** Year the trough falls in. */
    year: number;
    /**
     * The same plan without the crash, at that same month. Both paths pay the
     * same planned expenses, so the gap between them is the crash alone — the
     * raw fall from the pre-crash figure would also be charging it for a house
     * deposit that was always due that year.
     */
    calmAtTrough: number;
    /** Net worth at the end of the horizon, against the same plan with no crash. */
    endValue: number;
    endValueCalm: number;
}

interface Props {
    scenario: DrawdownScenario | undefined;
    onPick: (id: string | null) => void;
    startYear: number;
    onStartYear: (year: number) => void;
    maxYears: number;
    onReroll: () => void;
    /** Classes this plan actually holds, in display order. */
    held: ShockClass[];
    /** Weighted trough of the whole invested capital, as a fraction. */
    blended: number;
    /** Per-portfolio trough, worst first, with names resolved. */
    worst: { name: string; shock: number }[];
    trough: DrawdownTrough | null;
    monteCarloOn: boolean;
}

const ForecastDrawdownPanel: React.FC<Props> = ({
    scenario, onPick, startYear, onStartYear, maxYears, onReroll,
    held, blended, worst, trough, monteCarloOn,
}) => (
    <div
        className="card"
        style={{
            padding: '1rem 1.2rem',
            background: 'var(--bg-card)',
            borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border-color)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.7rem',
        }}
    >
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginRight: '0.2rem' }}>Scenario</span>
            {DRAWDOWN_SCENARIOS.map(s => (
                <button
                    key={s.id}
                    onClick={() => onPick(scenario?.id === s.id ? null : s.id)}
                    style={chip(scenario?.id === s.id)}
                    title={s.story}
                >
                    {s.label}
                    <span style={{ opacity: 0.75, marginLeft: '0.35rem', fontWeight: 500 }}>
                        {pct(s.classes.equity.trough)} eq
                    </span>
                </button>
            ))}
            {scenario && (
                <button onClick={() => onPick(null)} style={{ ...chip(false), marginLeft: 'auto' }} title="Back to the undisturbed projection">
                    ✕ Clear
                </button>
            )}
        </div>

        {!scenario ? (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Pick a crash and it is dropped into the projection: each asset class falls (or rises) by
                what that scenario does to <em>it</em>, spread over months, and every portfolio takes the
                hit its own mix implies. The plan keeps running through it — contributions, planned
                expenses and all — so the question it answers is not “how bad is a crash” but
                <strong> “does this plan still stand up when one happens”</strong>.
            </div>
        ) : (
            <>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {scenario.story}
                </div>

                <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        Starts in year
                        <input
                            type="number"
                            min={1}
                            max={maxYears}
                            value={startYear}
                            onChange={e => onStartYear(Math.min(maxYears, Math.max(1, Number(e.target.value) || 1)))}
                            style={{
                                width: '3.5rem', padding: '0.25rem 0.4rem', borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--border-color)', background: 'var(--bg-input)',
                                color: 'var(--text-primary)', fontSize: '0.78rem',
                            }}
                        />
                    </label>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        {scenario.crashMonths} months down, {scenario.recoveryMonths} of recovery
                    </span>
                    <button
                        onClick={onReroll}
                        title="Same crash, same depth — a different path into it"
                        style={{
                            padding: '0.2rem 0.6rem', background: 'var(--bg-input)', color: 'var(--text-secondary)',
                            border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
                            cursor: 'pointer', fontSize: '0.75rem',
                        }}
                    >
                        ↻ Re-roll the path
                    </button>
                </div>

                {/* What each class the plan actually holds does. The ones that go
                    up are the reason a mixed portfolio is not a single number. */}
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {held.map(cls => {
                        const t = scenario.classes[cls].trough;
                        return (
                            <span
                                key={cls}
                                title={`${SHOCK_CLASS_LABELS[cls]} at the trough of this scenario`}
                                style={{
                                    fontSize: '0.72rem',
                                    padding: '0.2rem 0.5rem',
                                    borderRadius: 'var(--radius-md)',
                                    border: '1px solid var(--border-color)',
                                    background: 'var(--bg-input)',
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                {SHOCK_CLASS_LABELS[cls]}{' '}
                                <strong style={{ color: t < 0 ? 'var(--color-danger)' : t > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                                    {Math.abs(t) < 0.001 ? '≈0%' : pct(t, Math.abs(t) < 0.01 ? 1 : 0)}
                                </strong>
                            </span>
                        );
                    })}
                    {held.length === 0 && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            No valued holdings to shock — the crash has nothing to bite on.
                        </span>
                    )}
                </div>

                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                    Your invested capital at the trough:{' '}
                    <strong style={{ color: blended < 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>
                        {pct(blended, 1)}
                    </strong>
                    {worst.length > 1 && (
                        <span style={{ color: 'var(--text-muted)' }}>
                            {' '}· hardest hit {worst[0].name} ({pct(worst[0].shock, 1)}), least{' '}
                            {worst[worst.length - 1].name} ({pct(worst[worst.length - 1].shock, 1)})
                        </span>
                    )}
                    {trough && (
                        <>
                            <br />
                            Net worth bottoms at <strong>{eur0(trough.value)}</strong> in year {trough.year} —{' '}
                            <strong style={{ color: 'var(--color-danger)' }}>
                                {eur0(Math.max(0, trough.calmAtTrough - trough.value))} below
                            </strong>{' '}
                            where the same plan stands that month with no crash (same contributions, same
                            planned expenses — the gap is the crash alone).
                            <br />
                            By the end of the horizon it is back to <strong>{eur0(trough.endValue)}</strong>, against{' '}
                            {eur0(trough.endValueCalm)} undisturbed —{' '}
                            <strong style={{ color: 'var(--color-danger)' }}>
                                {eur0(Math.max(0, trough.endValueCalm - trough.endValue))} of compounding never made back
                            </strong>.
                        </>
                    )}
                </div>

                {monteCarloOn && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--color-warning, #F59E0B)' }}>
                        Monte Carlo is paused while a crash is scripted: one is a random ensemble, the other a
                        single written future, and averaging them would say nothing about either.
                    </div>
                )}
            </>
        )}
    </div>
);

export default ForecastDrawdownPanel;
