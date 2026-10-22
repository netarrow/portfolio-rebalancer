import React, { useEffect, useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildCapexNoteRows, type FreshCapexCategory } from '../../utils/ynabCapexNotes';
import { checkYnabGuardBudget } from '../../utils/ynabWriteGuard';

interface Props {
    /** Whether a capex wants the "[Invested]" postfix on its name. */
    tagOf: (goalId: string) => boolean;
    onClose: () => void;
}

/**
 * Writes each capex target into its YNAB category note as a "[PRB] target: …
 * · due: …" line, the rest of the note kept, and keeps the "[Invested]"
 * postfix on the name while part of the capex is invested. Notes and names are
 * read again from YNAB when it opens: a line edited there since the last sync
 * is left alone, the sync takes it. YNAB's own goal fields are never written.
 */
const CapexNotesModal: React.FC<Props> = ({ tagOf, onClose }) => {
    const { ynabGoals, ynabConfig, ynabTrackingConfig, readCapexNotes, writeCapexNotes, ynabWriting } = usePortfolio();
    const [fresh, setFresh] = useState<Map<string, FreshCapexCategory> | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

    useEffect(() => {
        let alive = true;
        void readCapexNotes().then(res => {
            if (!alive) return;
            if (res.ok && res.notes) setFresh(res.notes);
            else setLoadError(res.error ?? 'Unable to read the capex notes.');
        });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Rows from the notes read on open: a written note is not proposed again.
    const [frozen] = useState({ goals: ynabGoals, tagOf });
    const rows = useMemo(() => fresh ? buildCapexNoteRows(frozen.goals, fresh, frozen.tagOf) : [], [fresh, frozen]);
    const toWrite = rows.filter(r => r.status === 'write');
    const guard = checkYnabGuardBudget(ynabTrackingConfig, ynabConfig?.budgetId);

    const apply = async () => {
        setRunning(true);
        const res = await writeCapexNotes(rows);
        setRunning(false);
        setResult(res.ok
            ? { ok: true, message: `${res.written} categor${res.written === 1 ? 'y' : 'ies'} updated. It can be rolled back from YNAB Writeback.` }
            : { ok: false, message: `${res.written > 0 ? `${res.written} written, then: ` : ''}${res.error ?? 'The write failed.'} What was written is in the log.` });
    };

    const busy = running || ynabWriting;
    const done = !!result;

    return (
        <div className="modal-overlay" onClick={() => !busy && onClose()}>
            <div className="modal-content cnm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Update capex categories in YNAB">
                <div className="cnm-head">
                    <h3>Update capex categories in YNAB</h3>
                    <span className="cnm-writes">Writes to YNAB</span>
                </div>
                <p className="cnm-hint">
                    Each capex target goes into its category note as one <code>[PRB]</code> line; the rest of the note stays as it is.
                    The name gets <code>[Invested]</code> while part of the capex is invested and its cash does not cover it, and loses it once it does.
                    YNAB's own goal is not touched. Edit the line in YNAB and the next sync takes it.
                </p>

                {!fresh && !loadError && <p className="cnm-hint">Reading the notes from YNAB…</p>}
                {loadError && <p className="cnm-err">{loadError}</p>}
                {fresh && rows.length === 0 && <p className="cnm-ok">Every capex category is already up to date in YNAB.</p>}
                {!guard.ok && fresh && toWrite.length > 0 && <p className="cnm-err">{guard.message}</p>}

                {rows.length > 0 && (
                    <ul className="cnm-list">
                        {rows.map(r => (
                            <li key={r.goalId} className={`cnm-row${r.status === 'write' ? '' : ' is-blocked'}`}>
                                <div className="cnm-name">{r.name}</div>
                                {r.nameAfter !== null && (
                                    <div className="cnm-diff">
                                        <pre className="cnm-before">{r.nameBefore}</pre>
                                        <span aria-hidden>→</span>
                                        <pre className="cnm-after">{r.nameAfter}</pre>
                                    </div>
                                )}
                                {r.after !== null && (
                                    <div className="cnm-diff">
                                        <pre className="cnm-before">{r.before || '(empty note)'}</pre>
                                        <span aria-hidden>→</span>
                                        <pre className="cnm-after">{r.after}</pre>
                                    </div>
                                )}
                                {r.noteEditedInYnab && (
                                    <div className="cnm-block">The [PRB] line was edited in YNAB: it is left as it is. Sync from YNAB to take it.</div>
                                )}
                                {r.status === 'missing' && (
                                    <div className="cnm-block">The category is no longer in the capex group in YNAB.</div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}

                {toWrite.length > 0 && guard.ok && !done && (
                    <label className="cnm-confirm">
                        <input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />
                        I have checked these changes: write them to YNAB.
                    </label>
                )}
                {result && <p className={result.ok ? 'cnm-ok' : 'cnm-err'}>{result.ok ? '✓ ' : '✗ '}{result.message}</p>}

                <div className="cnm-actions">
                    <button type="button" className="btn" onClick={onClose} disabled={busy}>{done ? 'Close' : 'Cancel'}</button>
                    {!done && (
                        <button type="button" className="btn btn-primary" onClick={apply} disabled={!confirmed || busy || toWrite.length === 0 || !guard.ok}>
                            {running ? 'Writing…' : `Update ${toWrite.length} in YNAB`}
                        </button>
                    )}
                </div>

                <style>{`
                    .cnm { max-width: 680px; width: 95vw; display: flex; flex-direction: column; gap: var(--space-4); max-height: 88vh; overflow-y: auto; }
                    .cnm-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
                    .cnm-head h3 { margin: 0; }
                    .cnm-writes { font-size: 0.72rem; font-weight: 700; color: var(--color-warning); background: rgba(245, 158, 11, 0.14); border-radius: 999px; padding: 0.15rem 0.6rem; white-space: nowrap; }
                    .cnm-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .cnm-ok { margin: 0; font-size: 0.85rem; color: var(--color-success); }
                    .cnm-err { margin: 0; font-size: 0.85rem; color: var(--color-danger); }
                    .cnm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
                    .cnm-row { border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.55rem 0.75rem; display: flex; flex-direction: column; gap: 0.35rem; }
                    .cnm-row.is-blocked { opacity: 0.8; }
                    .cnm-name { font-weight: 600; font-size: 0.88rem; }
                    .cnm-diff { display: grid; grid-template-columns: 1fr auto 1fr; gap: 0.5rem; align-items: start; }
                    .cnm-diff pre { margin: 0; font-size: 0.74rem; white-space: pre-wrap; word-break: break-word; padding: 0.35rem 0.5rem; border-radius: var(--radius-sm); background: var(--bg-secondary); }
                    .cnm-before { color: var(--text-secondary); }
                    .cnm-after { color: var(--text-primary); }
                    .cnm-block { font-size: 0.78rem; color: var(--color-warning); }
                    .cnm-confirm { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
                    .cnm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
                    @media (max-width: 560px) { .cnm-diff { grid-template-columns: 1fr; } .cnm-diff > span { display: none; } }
                `}</style>
            </div>
        </div>
    );
};

export default CapexNotesModal;
