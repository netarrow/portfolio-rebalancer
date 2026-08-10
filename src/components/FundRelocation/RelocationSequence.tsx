import React, { useState } from 'react';
import type { Broker, Portfolio } from '../../types';
import type {
    RelocationEndpoint,
    RelocationSequenceTotals,
    RelocationStep,
} from '../../utils/fundRelocation';
import RelocationActions from './RelocationActions';

/**
 * The queued moves, in the order they would be executed.
 *
 * A sequence is not a list of independent what-ifs: step #2 is priced on the
 * state step #1 leaves behind, so the numbers here are what the moves cost
 * TOGETHER — including the commission paid twice on a euro that passes through
 * three buckets, and the tax on a gain measured from the average cost the
 * previous step created.
 */

const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;

/** "Growth" / "Growth · VWCE" / "Cash" / "Cash · Directa" */
const endpointLabel = (
    endpoint: RelocationEndpoint,
    portfolios: Portfolio[],
    brokers: Broker[]
): string => {
    if (endpoint.kind === 'cash') {
        const broker = brokers.find(b => b.id === endpoint.brokerId);
        return broker ? `Cash · ${broker.name}` : 'Cash';
    }
    const name = portfolios.find(p => p.id === endpoint.portfolioId)?.name ?? 'Portfolio';
    return endpoint.ticker ? `${name} · ${endpoint.ticker}` : name;
};

interface StepRowProps {
    step: RelocationStep;
    index: number;
    portfolios: Portfolio[];
    brokers: Broker[];
    isFirst: boolean;
    isLast: boolean;
    onRemove: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
}

const CRITICAL_KINDS = ['source-shortfall', 'cash-overdraft', 'no-price', 'no-target'];

const StepRow: React.FC<StepRowProps> = ({
    step, index, portfolios, brokers, isFirst, isLast, onRemove, onMoveUp, onMoveDown,
}) => {
    const [open, setOpen] = useState(false);
    const { plan, request } = step;
    const critical = plan.warnings.some(w => CRITICAL_KINDS.includes(w.kind));

    const legs = [
        plan.sells.length > 0 ? `${plan.sells.length} sell${plan.sells.length > 1 ? 's' : ''}` : null,
        plan.buys.length > 0 ? `${plan.buys.length} buy${plan.buys.length > 1 ? 's' : ''}` : null,
    ].filter(Boolean).join(' · ');

    return (
        <div className={`reloc-step${open ? ' is-open' : ''}`}>
            <div className="reloc-step-row">
                <button
                    type="button"
                    className="reloc-step-head"
                    onClick={() => setOpen(v => !v)}
                    aria-expanded={open}
                >
                    <span className="reloc-step-index">{index + 1}</span>
                    <span className="reloc-step-main">
                        <span className="reloc-step-route">
                            {endpointLabel(request.from, portfolios, brokers)}
                            <span className="reloc-step-arrow" aria-hidden="true">→</span>
                            {endpointLabel(request.to, portfolios, brokers)}
                        </span>
                        <span className="reloc-step-sub">
                            {eur0(request.netAmount)} requested
                            {legs && ` · ${legs}`}
                            {plan.warnings.length > 0 && (
                                <span className={`reloc-step-flag${critical ? ' critical' : ''}`}>
                                    {critical ? '⛔' : '⚠️'} {plan.warnings.length}
                                </span>
                            )}
                        </span>
                    </span>
                    <span className="reloc-step-side">
                        <span className="reloc-step-cost">
                            {plan.friction > 0 ? `−${eur0(plan.friction)}` : eur0(0)}
                        </span>
                        <span className="reloc-step-sub">friction</span>
                    </span>
                    <span className="reloc-step-chevron" aria-hidden="true">▶</span>
                </button>

                <div className="reloc-step-tools">
                    <button
                        type="button"
                        className="reloc-icon-btn"
                        onClick={onMoveUp}
                        disabled={isFirst}
                        aria-label={`Move step ${index + 1} earlier`}
                        title="Execute earlier"
                    >
                        ↑
                    </button>
                    <button
                        type="button"
                        className="reloc-icon-btn"
                        onClick={onMoveDown}
                        disabled={isLast}
                        aria-label={`Move step ${index + 1} later`}
                        title="Execute later"
                    >
                        ↓
                    </button>
                    <button
                        type="button"
                        className="reloc-icon-btn danger"
                        onClick={onRemove}
                        aria-label={`Remove step ${index + 1}`}
                        title="Remove"
                    >
                        ✕
                    </button>
                </div>
            </div>

            {open && (
                <div className="reloc-step-body">
                    <RelocationActions plan={plan} compact />
                </div>
            )}
        </div>
    );
};

interface RelocationSequenceProps {
    steps: RelocationStep[];
    totals: RelocationSequenceTotals;
    portfolios: Portfolio[];
    brokers: Broker[];
    /** Friction of the move being edited, already included in the preview. */
    draftFriction: number;
    onRemove: (index: number) => void;
    onReorder: (from: number, to: number) => void;
    onClear: () => void;
}

const RelocationSequenceView: React.FC<RelocationSequenceProps> = ({
    steps, totals, portfolios, brokers, draftFriction, onRemove, onReorder, onClear,
}) => {
    if (steps.length === 0) return null;

    const totalFriction = totals.friction + draftFriction;

    return (
        <div className="reloc-card">
            <div className="reloc-sequence-header">
                <h3 className="reloc-section-title reloc-section-title--flush">
                    Planned sequence
                    <span className="reloc-count-badge">{steps.length}</span>
                </h3>
                <button type="button" className="reloc-btn ghost" onClick={onClear}>
                    Clear all
                </button>
            </div>

            <div className="reloc-step-list">
                {steps.map((step, i) => (
                    <StepRow
                        key={i}
                        step={step}
                        index={i}
                        portfolios={portfolios}
                        brokers={brokers}
                        isFirst={i === 0}
                        isLast={i === steps.length - 1}
                        onRemove={() => onRemove(i)}
                        onMoveUp={() => onReorder(i, i - 1)}
                        onMoveDown={() => onReorder(i, i + 1)}
                    />
                ))}
            </div>

            <div className="reloc-friction-grid reloc-sequence-totals">
                <div className="reloc-stat">
                    <div className="reloc-stat-label">Total tax</div>
                    <div className="reloc-stat-value negative">{totals.tax > 0 ? `−${eur0(totals.tax)}` : eur0(0)}</div>
                </div>
                <div className="reloc-stat">
                    <div className="reloc-stat-label">Total commissions</div>
                    <div className="reloc-stat-value negative">
                        {totals.sellCommission + totals.buyCommission > 0
                            ? `−${eur0(totals.sellCommission + totals.buyCommission)}`
                            : eur0(0)}
                    </div>
                </div>
                <div className="reloc-stat">
                    <div className="reloc-stat-label">Friction, queued moves</div>
                    <div className="reloc-stat-value negative">{totals.friction > 0 ? `−${eur0(totals.friction)}` : eur0(0)}</div>
                    <div className="reloc-stat-sub">{totals.frictionPercent.toFixed(2)}% of what was requested</div>
                </div>
                {draftFriction > 0 && (
                    <div className="reloc-stat">
                        <div className="reloc-stat-label">Including the draft</div>
                        <div className="reloc-stat-value negative">−{eur0(totalFriction)}</div>
                        <div className="reloc-stat-sub">the move being edited counts too</div>
                    </div>
                )}
            </div>

            <p className="reloc-hint">
                Each move is priced on the state the previous ones leave behind — so selling in step 3
                what step 1 bought pays the commission twice and is taxed on the average cost step 1
                created. Reorder the steps and the whole chain is re-priced.
            </p>
        </div>
    );
};

export default RelocationSequenceView;
