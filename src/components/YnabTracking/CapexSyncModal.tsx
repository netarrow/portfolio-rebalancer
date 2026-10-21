import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildReassignmentPreview, suggestReassignments, type ReassignmentPreview, type ReassignmentSuggestion } from '../../utils/ynabWriteBack';
import type { TrackingPlan } from '../../utils/ynabTrackingPlan';
import type { TrackingAccount } from './useTrackingPlan';

interface Props {
    plan: TrackingPlan;
    accounts: TrackingAccount[] | null;
    /** Re-reads the YNAB accounts: each move is previewed on fresh balances. */
    loadAccounts: () => Promise<TrackingAccount[] | null>;
    format: (v: number) => string;
    /** The capex whose remapping opened it: its moves are marked. */
    focusGoalId?: string;
    onClose: (changed: boolean) => void;
}

const todayLocal = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time
const pairKey = (s: Pick<ReassignmentSuggestion, 'fromKey' | 'toKey'>) => `${s.fromKey}>${s.toKey}`;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

type StepResult = { key: string; ok: boolean; message: string };

/**
 * Brings the YNAB accounts by purpose back to what the capex allocations ask
 * after a remapping: every move suggested by the allocations, the capex
 * accounts to create included, previewed together and written after ONE
 * confirmation. Each move is still its own write (its own log entry, its own
 * rollback) and is previewed again, on fresh balances, right before it is
 * sent: an earlier move changes what the next one finds.
 */
const CapexSyncModal: React.FC<Props> = ({ plan, accounts, loadAccounts, format, focusGoalId, onClose }) => {
    const { ynabConfig, ynabTrackingConfig, ynabWriteLog, executeYnabReassignment, ynabWriting } = usePortfolio();
    const budgetId = ynabConfig?.budgetId ?? '';
    const [date] = useState(todayLocal);
    const [confirmed, setConfirmed] = useState(false);
    const [running, setRunning] = useState(false);
    const [results, setResults] = useState<StepResult[]>([]);
    const [excluded, setExcluded] = useState<Set<string>>(new Set());

    // Fresh balances every time it opens: the preview checks them.
    const [fresh, setFresh] = useState(false);
    useEffect(() => {
        let alive = true;
        void loadAccounts().then(() => { if (alive) setFresh(true); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The latest plan and accounts, for the moves after the first.
    const latest = useRef({ plan, accounts, log: ynabWriteLog, config: ynabTrackingConfig });
    latest.current = { plan, accounts, log: ynabWriteLog, config: ynabTrackingConfig };

    const build = (s: ReassignmentSuggestion, ctx = latest.current): ReassignmentPreview => buildReassignmentPreview({
        plan: ctx.plan, fromKey: s.fromKey, toKey: s.toKey, amount: s.amount, accounts: ctx.accounts,
        config: ctx.config, budgetId, entryId: crypto.randomUUID(), date, log: ctx.log,
    });

    const rows = useMemo(() => suggestReassignments(plan).map(s => {
        const preview = build(s);
        return { s, preview, key: pairKey(s), ready: preview.blockers.length === 0 && preview.amount > 0 };
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, accounts, ynabTrackingConfig, ynabWriteLog, budgetId]);
    const nameOf = (key: string) => plan.destinations.find(d => d.key === key)?.accountName ?? key;
    const selected = rows.filter(r => r.ready && !excluded.has(r.key));
    const total = selected.reduce((s, r) => s + r.preview.amount, 0);
    const newAccounts = [...new Set(selected.flatMap(r => r.preview.createAccounts.map(c => c.name)))];
    const done = results.length > 0 && !running;

    const toggle = (key: string) => setExcluded(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });

    const applyAll = async () => {
        setRunning(true);
        setResults([]);
        const keys = selected.map(r => r.key);
        for (const key of keys) {
            // Fresh balances, then the move as the plan now sees it.
            const fresh = await loadAccounts();
            await wait(60);
            const ctx = { ...latest.current, accounts: fresh ?? latest.current.accounts };
            const s = suggestReassignments(ctx.plan).find(x => pairKey(x) === key);
            if (!s) { setResults(prev => [...prev, { key, ok: true, message: 'already in line' }]); continue; }
            const preview = build(s, ctx);
            if (preview.blockers.length > 0) {
                setResults(prev => [...prev, { key, ok: false, message: preview.blockers.join(' ') }]);
                break;
            }
            const res = await executeYnabReassignment(preview);
            setResults(prev => [...prev, res.ok
                ? { key, ok: true, message: `${format(preview.amount)} moved${preview.createAccounts.length ? ', account created' : ''}` }
                : { key, ok: false, message: res.error ?? 'The write failed: what was written is in the log, where it can be rolled back.' }]);
            if (!res.ok) break;
            await wait(60);
        }
        await loadAccounts();
        setRunning(false);
    };

    const resultOf = (key: string) => results.find(r => r.key === key);

    return (
        <div className="modal-overlay" onClick={() => !running && !ynabWriting && onClose(results.length > 0)}>
            <div className="modal-content csm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Update YNAB Writeback">
                <div className="csm-head">
                    <h3>Update YNAB Writeback</h3>
                    <span className="csm-writes">Writes to YNAB</span>
                </div>
                <p className="csm-hint">
                    The capex allocations changed: these moves bring the accounts by purpose back in line, in units with their cost basis,
                    and create the capex accounts that are missing. Each is written as its own entry, dated {date}, and can be rolled back from YNAB Writeback.
                </p>

                {!fresh && <p className="csm-hint">Loading the YNAB accounts…</p>}
                {fresh && rows.length === 0 && (
                    <p className="csm-ok">Nothing to update: every capex account already holds what its allocations ask.</p>
                )}

                {fresh && rows.length > 0 && (
                    <ul className="csm-list">
                        {rows.map(({ s, preview, key, ready }) => {
                            const r = resultOf(key);
                            const focus = !!focusGoalId && (s.fromKey === `goal:${focusGoalId}` || s.toKey === `goal:${focusGoalId}`);
                            return (
                                <li key={key} className={`csm-row${focus ? ' is-focus' : ''}${ready ? '' : ' is-blocked'}`}>
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={ready && !excluded.has(key)}
                                            disabled={!ready || running || done}
                                            onChange={() => toggle(key)}
                                        />
                                        <span className="csm-route">
                                            {nameOf(s.fromKey)} → {nameOf(s.toKey)}
                                            {preview.createAccounts.length > 0 && <span className="csm-new"> new account</span>}
                                        </span>
                                        <strong>{format(s.amount)}</strong>
                                    </label>
                                    {!ready && <div className="csm-block">{preview.blockers.join(' ') || 'Nothing to move.'}</div>}
                                    {r && <div className={r.ok ? 'csm-done' : 'csm-block'}>{r.ok ? '✓ ' : '✗ '}{r.message}</div>}
                                </li>
                            );
                        })}
                    </ul>
                )}

                {fresh && selected.length > 0 && !done && (
                    <>
                        <div className="csm-total">
                            {selected.length} move{selected.length === 1 ? '' : 's'} · {format(total)}
                            {newAccounts.length > 0 && <> · creates {newAccounts.join(', ')}</>}
                        </div>
                        <label className="csm-confirm">
                            <input type="checkbox" checked={confirmed} disabled={running} onChange={e => setConfirmed(e.target.checked)} />
                            I have checked these moves: write them to YNAB.
                        </label>
                    </>
                )}

                <div className="csm-actions">
                    <button type="button" className="btn" onClick={() => onClose(results.length > 0)} disabled={running || ynabWriting}>
                        {done ? 'Close' : 'Cancel'}
                    </button>
                    {!done && (
                        <button type="button" className="btn btn-primary" onClick={applyAll} disabled={!confirmed || running || selected.length === 0 || ynabWriting}>
                            {running ? 'Writing…' : `Write ${selected.length} to YNAB`}
                        </button>
                    )}
                </div>

                <style>{`
                    .csm { max-width: 640px; width: 95vw; display: flex; flex-direction: column; gap: var(--space-4); max-height: 88vh; overflow-y: auto; }
                    .csm-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
                    .csm-head h3 { margin: 0; }
                    .csm-writes { font-size: 0.72rem; font-weight: 700; color: var(--color-warning); background: rgba(245, 158, 11, 0.14); border-radius: 999px; padding: 0.15rem 0.6rem; white-space: nowrap; }
                    .csm-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .csm-ok { margin: 0; font-size: 0.85rem; color: var(--color-success); }
                    .csm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
                    .csm-row { border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.55rem 0.75rem; }
                    .csm-row.is-focus { border-color: var(--color-primary); }
                    .csm-row.is-blocked { opacity: 0.75; }
                    .csm-row label { display: flex; align-items: center; gap: 0.6rem; cursor: pointer; }
                    .csm-route { flex: 1; min-width: 0; font-size: 0.88rem; }
                    .csm-new { font-size: 0.72rem; color: var(--color-primary); font-weight: 600; }
                    .csm-block { margin-top: 0.3rem; font-size: 0.78rem; color: var(--color-danger); }
                    .csm-done { margin-top: 0.3rem; font-size: 0.78rem; color: var(--color-success); }
                    .csm-total { font-size: 0.88rem; font-weight: 600; }
                    .csm-confirm { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
                    .csm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
                `}</style>
            </div>
        </div>
    );
};

export default CapexSyncModal;
