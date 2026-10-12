import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { TrackingAccountRef, TrackingPlan } from '../../utils/ynabTrackingPlan';
import { buildRevaluationPreview, type RevaluationPreview } from '../../utils/ynabWriteBack';

interface Props {
    plan: TrackingPlan;
    accounts: (TrackingAccountRef & { transferPayeeId?: string })[] | null;
    format: (v: number) => string;
    onClose: (changed: boolean) => void;
}

const todayLocal = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time

// Brings each account by purpose to the value of what it holds: the P/L as a
// cleared line, the latent tax as the account's single uncleared line.
const RevalueModal: React.FC<Props> = ({ plan, accounts, format, onClose }) => {
    const { ynabConfig, ynabTrackingConfig, ynabWriteLog, executeYnabRevaluation, ynabWriting } = usePortfolio();
    const [entryId] = useState(() => crypto.randomUUID());
    const [date] = useState(todayLocal);
    const [sent, setSent] = useState<{ preview: RevaluationPreview; selected: Set<string> } | null>(null);
    const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
    const [confirmed, setConfirmed] = useState(false);

    const live = useMemo(() => buildRevaluationPreview({
        plan, accounts, config: ynabTrackingConfig, budgetId: ynabConfig?.budgetId ?? '', entryId, date, log: ynabWriteLog,
    }), [plan, accounts, ynabTrackingConfig, ynabConfig?.budgetId, entryId, date, ynabWriteLog]);
    // Suspicious or blocked accounts start unticked.
    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(live.accounts.filter(a => !a.suspicious && !a.blocked).map(a => a.destinationKey)),
    );
    const preview = sent?.preview ?? live;
    const chosen = sent?.selected ?? selected;
    const picked = preview.accounts.filter(a => chosen.has(a.destinationKey) && !a.blocked);
    const totalDelta = picked.reduce((s, a) => s + a.delta, 0);
    const totalTax = picked.reduce((s, a) => s + (a.taxTarget - a.taxSeen), 0);
    const signed = (v: number) => `${v > 0 ? '+' : ''}${format(v)}`;
    const ready = preview.blockers.length === 0 && picked.length > 0;

    const toggle = (key: string, on: boolean) => {
        setConfirmed(false);
        setSelected(prev => { const next = new Set(prev); if (on) next.add(key); else next.delete(key); return next; });
    };

    const apply = async () => {
        setSent({ preview: live, selected });
        const res = await executeYnabRevaluation(live, selected);
        setResult(res.ok
            ? { ok: true, message: `Done: ${picked.length} account${picked.length === 1 ? '' : 's'} revalued.` }
            : { ok: false, message: `${res.error ?? 'The revaluation failed.'} Whatever was written is in the write-back log, where it can be rolled back.` });
    };

    return (
        <div className="modal-overlay" onClick={() => !ynabWriting && onClose(!!result)}>
            <div className="modal-content rvm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Revalue accounts">
                <div className="rvm-head">
                    <h3>Revalue accounts</h3>
                    <span className="rvm-writes">Writes to YNAB</span>
                </div>
                <p className="rvm-hint">
                    Each account goes to the value of what it holds at migrated brokers, dated {date}. Its two lines are updated in place:
                    <strong> P/L</strong> (value − PMC, cleared) and <strong>latent tax</strong> (uncleared). The PMC is touched only when a
                    purchase, sale or transfer moved it. Cleared balance = gross, working balance = net.
                </p>

                {preview.blockers.length > 0 && (
                    <div className="rvm-block">
                        <ul>{preview.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                    </div>
                )}

                {preview.accounts.length > 0 && (
                    <div className="rvm-list">
                        {preview.accounts.map(a => (
                            <label key={a.destinationKey} className={`rvm-row${a.blocked ? ' rvm-row-off' : ''}`}>
                                <input
                                    type="checkbox"
                                    checked={chosen.has(a.destinationKey) && !a.blocked}
                                    disabled={!!a.blocked || ynabWriting || !!result}
                                    onChange={e => toggle(a.destinationKey, e.target.checked)}
                                />
                                <div className="rvm-main">
                                    <div className="rvm-line">
                                        <span className="rvm-name">{a.accountName}</span>
                                        <span className={a.delta >= 0 ? 'rvm-up' : 'rvm-down'}>{signed(a.delta)}</span>
                                    </div>
                                    <div className="rvm-line rvm-small">
                                        <span>PMC {Math.abs(a.costAdjust) >= 0.01 ? `${format(a.costSeen)} → ` : ''}{format(a.cost)}</span>
                                        <span>P/L {format(a.plSeen)} → {format(a.plTarget)}</span>
                                        <span>tax {format(a.taxSeen)} → {format(a.taxTarget)}</span>
                                    </div>
                                    {a.conversion && <div className="rvm-info">ℹ First P/L line: the gain moves out of the PMC (one-time reclassification of an account migrated before P/L lines existed).</div>}
                                    {a.suspicious && <div className="rvm-warn">⚠ The PMC moved by {signed(a.costAdjust)}: a transfer may be missing in YNAB, or a purchase or sale not registered in the tool. Check before ticking it.</div>}
                                    {a.blocked && <div className="rvm-warn">⛔ {a.blocked}</div>}
                                </div>
                            </label>
                        ))}
                    </div>
                )}

                {picked.length > 0 && (
                    <div className="rvm-summary">
                        <span>{picked.length} account{picked.length === 1 ? '' : 's'} · P/L <strong>{signed(totalDelta)}</strong></span>
                        <span>latent tax {signed(totalTax)}</span>
                    </div>
                )}

                {result ? (
                    <div className={result.ok ? 'rvm-ok' : 'rvm-block'}>{result.message}</div>
                ) : (
                    <label className="rvm-confirm">
                        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={!ready || ynabWriting} />
                        <span>I have checked these values: write them to YNAB.</span>
                    </label>
                )}

                <div className="rvm-actions">
                    <button type="button" className="btn" onClick={() => onClose(!!result)} disabled={ynabWriting}>{result ? 'Close' : 'Cancel'}</button>
                    {!result && (
                        <button type="button" className="btn btn-primary" onClick={apply} disabled={!ready || !confirmed || ynabWriting}>
                            {ynabWriting ? 'Writing…' : 'Write to YNAB'}
                        </button>
                    )}
                </div>

                <style>{`
                    .rvm { max-width: 620px; width: 95vw; display: flex; flex-direction: column; gap: var(--space-4); }
                    .rvm-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
                    .rvm-head h3 { margin: 0; }
                    .rvm-writes { font-size: 0.72rem; font-weight: 700; color: var(--color-warning); background: rgba(245, 158, 11, 0.14); border-radius: 999px; padding: 0.15rem 0.6rem; white-space: nowrap; }
                    .rvm-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .rvm-block { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-md); padding: var(--space-3); font-size: 0.85rem; }
                    .rvm-block ul { margin: 0; padding-left: 1.2rem; }
                    .rvm-ok { background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: var(--radius-md); padding: var(--space-3); font-size: 0.85rem; }
                    .rvm-list { display: flex; flex-direction: column; gap: var(--space-2); }
                    .rvm-row { display: flex; gap: var(--space-3); align-items: flex-start; background: var(--bg-card); border-radius: var(--radius-md); padding: var(--space-3); cursor: pointer; }
                    .rvm-row input { width: 18px; height: 18px; margin-top: 0.15rem; flex-shrink: 0; }
                    .rvm-row-off { opacity: 0.6; cursor: default; }
                    .rvm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
                    .rvm-line { display: flex; justify-content: space-between; gap: var(--space-3); font-variant-numeric: tabular-nums; font-size: 0.88rem; flex-wrap: wrap; }
                    .rvm-name { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
                    .rvm-small { font-size: 0.76rem; color: var(--text-muted); }
                    .rvm-up { color: var(--color-success); font-weight: 600; white-space: nowrap; }
                    .rvm-down { color: var(--color-warning); font-weight: 600; white-space: nowrap; }
                    .rvm-warn { font-size: 0.76rem; color: var(--color-warning); }
                    .rvm-info { font-size: 0.76rem; color: var(--text-secondary); }
                    .rvm-summary { display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); font-size: 0.85rem; padding-top: var(--space-3); border-top: 1px solid var(--bg-card); }
                    .rvm-confirm { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.88rem; cursor: pointer; }
                    .rvm-confirm input { width: 18px; height: 18px; margin-top: 0.1rem; flex-shrink: 0; }
                    .rvm-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
                    @media (max-width: 480px) { .rvm-actions .btn { flex: 1; min-height: 44px; } }
                `}</style>
            </div>
        </div>
    );
};

export default RevalueModal;
