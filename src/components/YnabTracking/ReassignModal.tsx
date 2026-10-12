import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { TrackingAccountRef, TrackingPlan } from '../../utils/ynabTrackingPlan';
import { buildReassignmentPreview, suggestReassignments, type ReassignmentPreview } from '../../utils/ynabWriteBack';

interface Props {
    plan: TrackingPlan;
    accounts: (TrackingAccountRef & { transferPayeeId?: string })[] | null;
    format: (v: number) => string;
    /** Prefill, e.g. from the row whose allocations changed. */
    initial?: { fromKey?: string; toKey?: string; amount?: number };
    onClose: (changed: boolean) => void;
}

const todayLocal = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time
const SHARE_KINDS = new Set(['goal', 'portfolio', 'pension']);

// Moves goal shares between accounts by purpose: goal → goal, portfolio →
// goal, goal → its own portfolio. One transfer, previewed exactly, written
// only after the confirmation.
const ReassignModal: React.FC<Props> = ({ plan, accounts, format, initial, onClose }) => {
    const { ynabConfig, ynabTrackingConfig, ynabWriteLog, executeYnabReassignment, ynabWriting } = usePortfolio();
    const [entryId, setEntryId] = useState(() => crypto.randomUUID());
    const [date] = useState(todayLocal);
    const budgetId = ynabConfig?.budgetId ?? '';

    const migrated = useMemo(() => new Set(plan.brokers.filter(b => b.migrated).map(b => b.brokerId)), [plan.brokers]);
    const movable = (key: string) => plan.destinations.find(d => d.key === key)?.pieces
        .filter(p => migrated.has(p.brokerId)).reduce((s, p) => s + p.value, 0) ?? 0;
    const sources = plan.destinations.filter(d => SHARE_KINDS.has(d.kind) && movable(d.key) >= 0.01);
    const targets = plan.destinations.filter(d => SHARE_KINDS.has(d.kind));

    const build = (fromKey: string, toKey: string, amount: number, newAccountName?: string) => buildReassignmentPreview({
        plan, fromKey, toKey, amount, accounts, config: ynabTrackingConfig, budgetId, entryId, date, newAccountName, log: ynabWriteLog,
    });
    // A suggestion stays listed when only a revaluation stands in its way.
    const suggestions = useMemo(
        () => suggestReassignments(plan, s => {
            const p = build(s.fromKey, s.toKey, s.amount);
            return p.blockers.every(b => p.unaligned.includes(b));
        }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [plan, accounts, ynabTrackingConfig, budgetId, ynabWriteLog],
    );

    // Opening from a row: the suggestion that involves that row, if any.
    const first = suggestions.find(x =>
        (!initial?.fromKey || x.fromKey === initial.fromKey) && (!initial?.toKey || x.toKey === initial.toKey));
    const [fromKey, setFromKey] = useState(first?.fromKey ?? initial?.fromKey ?? sources[0]?.key ?? '');
    const [toKey, setToKey] = useState(first?.toKey ?? initial?.toKey ?? '');
    const [amountText, setAmountText] = useState(String(first?.amount ?? initial?.amount ?? ''));
    const [newName, setNewName] = useState<string | undefined>(undefined);
    const [confirmed, setConfirmed] = useState(false);
    const [sent, setSent] = useState<ReassignmentPreview | null>(null);
    const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

    const amount = Number(amountText.replace(',', '.'));
    const live = useMemo(
        () => build(fromKey, toKey, Number.isFinite(amount) ? amount : 0, newName),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [plan, accounts, ynabTrackingConfig, budgetId, entryId, date, fromKey, toKey, amount, newName, ynabWriteLog],
    );
    const preview = sent ?? live;
    const signed = (v: number) => `${v > 0 ? '+' : ''}${format(v)}`;
    const nameOf = (key: string) => plan.destinations.find(d => d.key === key)?.accountName ?? key;
    const pick = (s: { fromKey: string; toKey: string; amount: number }) => {
        setFromKey(s.fromKey); setToKey(s.toKey); setAmountText(String(s.amount)); setNewName(undefined); setConfirmed(false);
    };

    const apply = async () => {
        setSent(live);
        const res = await executeYnabReassignment(live);
        setResult(res.ok
            ? { ok: true, message: `Done: ${format(live.amount)} moved from ${live.from.accountName} to ${live.to.accountName}.` }
            : { ok: false, message: `${res.error ?? 'The reassignment failed.'} Whatever was written is in the write-back log, where it can be rolled back.` });
    };
    const another = () => { setSent(null); setResult(null); setConfirmed(false); setEntryId(crypto.randomUUID()); };

    const locked = ynabWriting || !!result;
    const ready = preview.blockers.length === 0 && preview.amount > 0;

    return (
        <div className="modal-overlay" onClick={() => !ynabWriting && onClose(!!result)}>
            <div className="modal-content rsm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Reassign shares">
                <div className="rsm-head">
                    <h3>Reassign shares</h3>
                    <span className="rsm-writes">Writes to YNAB</span>
                </div>
                <p className="rsm-hint">
                    Moves holdings, in units with their cost basis, from one account by purpose to another — goal → goal, portfolio → goal,
                    or goal → its own portfolio. Only shares at migrated brokers move this way. One tracking-to-tracking transfer, dated {date}.
                </p>

                {!result && suggestions.length > 0 && (
                    <section className="rsm-sec">
                        <h4>Suggested by the goal allocations</h4>
                        <div className="rsm-sugs">
                            {suggestions.map(s => (
                                <button
                                    key={`${s.fromKey}>${s.toKey}`}
                                    type="button"
                                    className={`rsm-sug${s.fromKey === fromKey && s.toKey === toKey ? ' rsm-sug-on' : ''}`}
                                    onClick={() => pick(s)}
                                >
                                    {nameOf(s.fromKey)} → {nameOf(s.toKey)} · <strong>{format(s.amount)}</strong>
                                </button>
                            ))}
                        </div>
                    </section>
                )}

                <section className="rsm-sec rsm-form">
                    <label>
                        <span>From</span>
                        <select className="form-select" value={fromKey} disabled={locked} onChange={e => { setFromKey(e.target.value); setConfirmed(false); }}>
                            {!sources.some(d => d.key === fromKey) && <option value={fromKey}>{fromKey ? nameOf(fromKey) : '—'}</option>}
                            {sources.map(d => <option key={d.key} value={d.key}>{d.accountName} · {format(movable(d.key))} movable</option>)}
                        </select>
                    </label>
                    <label>
                        <span>To</span>
                        <select className="form-select" value={toKey} disabled={locked} onChange={e => { setToKey(e.target.value); setNewName(undefined); setConfirmed(false); }}>
                            <option value="">— choose —</option>
                            {targets.filter(d => d.key !== fromKey).map(d => <option key={d.key} value={d.key}>{d.accountName}</option>)}
                        </select>
                    </label>
                    <label>
                        <span>Amount</span>
                        <div className="rsm-amount">
                            <input className="form-input" inputMode="decimal" value={amountText} disabled={locked} onChange={e => { setAmountText(e.target.value); setConfirmed(false); }} />
                            <button type="button" className="btn" disabled={locked || !fromKey} onClick={() => setAmountText(String(Math.floor(movable(fromKey) * 100) / 100))}>Max</button>
                        </div>
                    </label>
                    {preview.createAccounts.length > 0 && (
                        <label>
                            <span>New account</span>
                            <input className="form-input" value={newName ?? preview.to.accountName} disabled={locked} onChange={e => setNewName(e.target.value)} />
                        </label>
                    )}
                </section>

                {!result && preview.blockers.length > 0 && toKey && (
                    <div className="rsm-block">
                        <strong>Cannot run yet</strong>
                        <ul>{preview.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                    </div>
                )}

                {preview.pieces.length > 0 && toKey && (
                    <section className="rsm-sec">
                        <h4>Transfer at cost basis (PMC)</h4>
                        <div className="rsm-transfer">
                            <div className="rsm-line">
                                <span>{preview.from.accountName} → {preview.to.accountName}{preview.createAccounts.length > 0 && <span className="rsm-small"> (new)</span>}</span>
                                <span className="rsm-strong">{format(preview.cost)}</span>
                            </div>
                            <div className="rsm-small">value today {format(preview.amount)} · P/L {signed(preview.amount - preview.cost)}</div>
                            <div className="rsm-small">{preview.memo}</div>
                        </div>
                        <ul className="rsm-pieces">
                            {preview.pieces.map(p => (
                                <li key={p.holdingKey}>
                                    <span>{p.label}</span>
                                    <span>{p.quantity.toLocaleString('en-IE', { maximumFractionDigits: 4 })} units · {format(p.value)}</span>
                                </li>
                            ))}
                        </ul>
                        {preview.lines.length > 0 && (
                            <>
                                <h4>P/L and latent-tax lines, updated in place</h4>
                                {preview.lines.map(l => (
                                    <div key={l.importId} className="rsm-line rsm-small">
                                        <span>{l.accountName} · {l.role === 'pl' ? 'P/L' : 'latent tax'}</span>
                                        <span>{format(l.previous)} → {format(l.amount)}</span>
                                    </div>
                                ))}
                            </>
                        )}
                    </section>
                )}

                {result ? (
                    <div className={result.ok ? 'rsm-ok' : 'rsm-block'}>{result.message}</div>
                ) : (
                    <label className="rsm-confirm">
                        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={!ready || ynabWriting} />
                        <span>I have checked this transfer: write it to YNAB.</span>
                    </label>
                )}

                <div className="rsm-actions">
                    {result?.ok && <button type="button" className="btn" onClick={another}>Reassign more</button>}
                    <button type="button" className="btn" onClick={() => onClose(!!result)} disabled={ynabWriting}>{result ? 'Close' : 'Cancel'}</button>
                    {!result && (
                        <button type="button" className="btn btn-primary" onClick={apply} disabled={!ready || !confirmed || ynabWriting}>
                            {ynabWriting ? 'Writing…' : 'Write to YNAB'}
                        </button>
                    )}
                </div>

                <style>{`
                    .rsm { max-width: 600px; width: 95vw; display: flex; flex-direction: column; gap: var(--space-4); }
                    .rsm-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
                    .rsm-head h3 { margin: 0; }
                    .rsm-writes { font-size: 0.72rem; font-weight: 700; color: var(--color-warning); background: rgba(245, 158, 11, 0.14); border-radius: 999px; padding: 0.15rem 0.6rem; white-space: nowrap; }
                    .rsm-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .rsm-sec { display: flex; flex-direction: column; gap: var(--space-2); }
                    .rsm-sec h4 { margin: 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
                    .rsm-sugs { display: flex; flex-wrap: wrap; gap: 0.4rem; }
                    .rsm-sug { background: var(--bg-card); border: 1px dashed rgba(148, 163, 184, 0.35); color: var(--text-secondary); border-radius: var(--radius-md); padding: 0.4rem 0.6rem; font-size: 0.8rem; cursor: pointer; text-align: left; }
                    .rsm-sug-on, .rsm-sug:hover { border-style: solid; border-color: var(--color-primary); color: var(--text-primary); }
                    .rsm-form { display: grid; grid-template-columns: 1fr; gap: var(--space-3); }
                    .rsm-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; color: var(--text-muted); min-width: 0; }
                    .rsm-form .form-select, .rsm-form .form-input { width: 100%; min-width: 0; }
                    .rsm-amount { display: flex; gap: 0.4rem; }
                    .rsm-block { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-md); padding: var(--space-3); font-size: 0.85rem; }
                    .rsm-block ul { margin: 0.35rem 0 0; padding-left: 1.2rem; }
                    .rsm-ok { background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: var(--radius-md); padding: var(--space-3); font-size: 0.85rem; }
                    .rsm-transfer { background: var(--bg-card); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); display: flex; flex-direction: column; gap: 0.2rem; }
                    .rsm-line { display: flex; justify-content: space-between; gap: var(--space-3); font-size: 0.88rem; }
                    .rsm-line > span:first-child { min-width: 0; overflow-wrap: anywhere; }
                    .rsm-strong { font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
                    .rsm-small { font-size: 0.74rem; color: var(--text-muted); overflow-wrap: anywhere; }
                    .rsm-pieces { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; }
                    .rsm-pieces li { display: flex; justify-content: space-between; gap: var(--space-3); padding: 0.25rem 0.5rem; background: var(--bg-card); border-radius: var(--radius-sm); font-variant-numeric: tabular-nums; }
                    .rsm-confirm { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.88rem; cursor: pointer; }
                    .rsm-confirm input { width: 18px; height: 18px; margin-top: 0.1rem; flex-shrink: 0; }
                    .rsm-actions { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
                    @media (max-width: 480px) {
                        .rsm-actions .btn { flex: 1; min-height: 44px; }
                    }
                `}</style>
            </div>
        </div>
    );
};

export default ReassignModal;
