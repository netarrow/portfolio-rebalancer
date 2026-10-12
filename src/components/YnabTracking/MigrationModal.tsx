import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { TrackingAccountRef, TrackingPlan } from '../../utils/ynabTrackingPlan';
import { buildMigrationPreview, PRB_PAYEE, type MigrationPreview } from '../../utils/ynabWriteBack';

interface Props {
    plan: TrackingPlan;
    brokerId: string;
    accounts: (TrackingAccountRef & { transferPayeeId?: string })[] | null;
    format: (v: number) => string;
    onClose: (changed: boolean) => void;
}

const todayLocal = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time

// Migration of ONE broker account: the exact operations, then an explicit
// confirmation before anything is sent to YNAB.
const MigrationModal: React.FC<Props> = ({ plan, brokerId, accounts, format, onClose }) => {
    const { ynabConfig, ynabTrackingConfig, ynabWriteLog, executeYnabMigration, ynabWriting } = usePortfolio();
    const [entryId] = useState(() => crypto.randomUUID());
    const [date] = useState(todayLocal);
    const [names, setNames] = useState<Record<string, string>>({});
    const [confirmed, setConfirmed] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

    // What was sent stays on screen after the write, even though the plan
    // then reports the broker as migrated.
    const [sent, setSent] = useState<MigrationPreview | null>(null);
    const live = useMemo(() => buildMigrationPreview({
        plan, brokerId, accounts, config: ynabTrackingConfig, budgetId: ynabConfig?.budgetId ?? '',
        entryId, date, nameOverrides: names, log: ynabWriteLog,
    }), [plan, brokerId, accounts, ynabTrackingConfig, ynabConfig?.budgetId, entryId, date, names, ynabWriteLog]);
    const preview = sent ?? live;

    const signed = (v: number) => `${v > 0 ? '+' : ''}${format(v)}`;
    const moved = preview.transfers.reduce((s, t) => s + t.amount, 0);
    const stays = preview.staysInPlace.reduce((s, t) => s + t.amount, 0);
    const ready = preview.blockers.length === 0;
    const sourceLines = (Math.abs(preview.realignment) >= 0.01 ? 1 : 0) + (Math.abs(preview.plMove) >= 0.01 ? 1 : 0);
    const writes = sourceLines + preview.transfers.length + preview.lines.length;
    const lineName = (l: MigrationPreview['lines'][number]) => l.accountId ? l.accountName : (names[l.destinationKey] ?? l.accountName);

    const apply = async () => {
        setSent(live);
        const res = await executeYnabMigration(live);
        if (res.ok) {
            setResult({
                ok: true,
                message: `Done: ${res.entry?.transactions.length ?? 0} transaction(s) written${res.entry?.createdAccounts.length ? `, ${res.entry.createdAccounts.length} account(s) created` : ''}.${res.entry?.error ? ` ${res.entry.error}` : ''}`,
            });
        } else {
            setResult({ ok: false, message: `${res.error ?? 'The migration failed.'} Whatever was written is in the write-back log, where it can be rolled back.` });
        }
    };

    return (
        <div className="modal-overlay" onClick={() => !ynabWriting && onClose(!!result)}>
            <div className="modal-content mgm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Migrate ${preview.brokerName}`}>
                <div className="mgm-head">
                    <h3>Migrate {preview.brokerName}</h3>
                    <span className="mgm-writes">Writes to YNAB</span>
                </div>
                <p className="mgm-hint">
                    From <strong>{preview.source?.name ?? 'an account not linked'}</strong>
                    {preview.source && <> (today {format(preview.source.balanceSeen)})</>}, dated {date}. Every transaction gets the
                    <code>[PRB]</code> memo and the purple flag. Nothing touches a category or Ready to Assign.
                </p>

                {!result && preview.blockers.length > 0 && (
                    <div className="mgm-block">
                        <strong>Cannot run yet</strong>
                        <ul>{preview.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                    </div>
                )}

                {sourceLines > 0 && (
                    <section className="mgm-sec">
                        <h4>1 · {preview.source?.name ?? 'Broker account'} · payee “{PRB_PAYEE}”</h4>
                        {Math.abs(preview.realignment) >= 0.01 && (
                            <div className="mgm-line">
                                <span>Realign to the tool's value</span>
                                <span className={preview.realignment > 0 ? 'mgm-up' : 'mgm-down'}>{signed(preview.realignment)}</span>
                            </div>
                        )}
                        {Math.abs(preview.plMove) >= 0.01 && (
                            <div className="mgm-line">
                                <span>Unrealised gains, moved to the P/L lines below</span>
                                <span className={preview.plMove > 0 ? 'mgm-up' : 'mgm-down'}>{signed(preview.plMove)}</span>
                            </div>
                        )}
                    </section>
                )}

                {preview.createAccounts.length > 0 && (
                    <section className="mgm-sec">
                        <h4>{sourceLines > 0 ? '2' : '1'} · Create tracking accounts (opened at 0)</h4>
                        {preview.createAccounts.map(c => (
                            <label key={c.destinationKey} className="mgm-name">
                                <input
                                    className="form-input"
                                    value={names[c.destinationKey] ?? c.name}
                                    onChange={e => setNames(prev => ({ ...prev, [c.destinationKey]: e.target.value }))}
                                    disabled={ynabWriting || !!result}
                                    aria-label={`Name of the new account for ${c.name}`}
                                />
                            </label>
                        ))}
                        <div className="mgm-small">They are added to the write guard and linked automatically.</div>
                    </section>
                )}

                <section className="mgm-sec">
                    <h4>Transfers out of {preview.source?.name ?? 'the broker account'}, at cost basis (PMC)</h4>
                    {preview.transfers.map(t => (
                        <div key={t.destinationKey} className="mgm-transfer">
                            <div className="mgm-line">
                                <span>→ {names[t.destinationKey] ?? t.accountName}{!t.accountId && <span className="mgm-small"> (new)</span>}</span>
                                <span className="mgm-amount">{format(t.amount)}</span>
                            </div>
                            {Math.abs(t.value - t.amount) >= 0.01 && <div className="mgm-small">value today {format(t.value)} · P/L {signed(t.value - t.amount)}</div>}
                            <div className="mgm-memo">{t.memo}</div>
                        </div>
                    ))}
                    {preview.staysInPlace.map(s => (
                        <div key={s.destinationKey} className="mgm-line mgm-muted">
                            <span>↺ stays in {s.accountName}</span>
                            <span>{format(s.amount)}</span>
                        </div>
                    ))}
                </section>

                {preview.lines.length > 0 && (
                    <section className="mgm-sec">
                        <h4>P/L and latent-tax lines (one each per account, updated in place later)</h4>
                        {preview.lines.map(l => (
                            <div key={l.importId} className="mgm-line">
                                <span>{lineName(l)} · {l.role === 'pl' ? 'P/L (cleared)' : 'latent tax (uncleared)'}</span>
                                <span className={l.amount >= 0 ? 'mgm-up' : 'mgm-down'}>
                                    {l.existingId ? `${format(l.previous)} → ` : ''}{signed(l.amount)}
                                </span>
                            </div>
                        ))}
                    </section>
                )}

                {preview.source && (
                    <div className="mgm-summary">
                        <span>{writes} transaction{writes === 1 ? '' : 's'} · {format(moved)} moved at PMC</span>
                        <span>{preview.source.name} after: <strong>{format(stays)}</strong></span>
                    </div>
                )}

                {result ? (
                    <div className={result.ok ? 'mgm-ok' : 'mgm-block'}>{result.message}</div>
                ) : (
                    <label className="mgm-confirm">
                        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={!ready || ynabWriting} />
                        <span>I have checked these operations: write them to YNAB.</span>
                    </label>
                )}

                <div className="mgm-actions">
                    <button type="button" className="btn" onClick={() => onClose(!!result)} disabled={ynabWriting}>{result ? 'Close' : 'Cancel'}</button>
                    {!result && (
                        <button type="button" className="btn btn-primary" onClick={apply} disabled={!ready || !confirmed || ynabWriting}>
                            {ynabWriting ? 'Writing…' : 'Write to YNAB'}
                        </button>
                    )}
                </div>

                <style>{`
                    .mgm { max-width: 640px; width: 95vw; display: flex; flex-direction: column; gap: var(--space-4); }
                    .mgm-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
                    .mgm-head h3 { margin: 0; }
                    .mgm-writes { font-size: 0.72rem; font-weight: 700; color: var(--color-warning); background: rgba(245, 158, 11, 0.14); border-radius: 999px; padding: 0.15rem 0.6rem; white-space: nowrap; }
                    .mgm-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .mgm-hint code { margin: 0 0.25rem; }
                    .mgm-block { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: var(--text-primary); border-radius: var(--radius-md); padding: var(--space-3); font-size: 0.85rem; }
                    .mgm-block ul { margin: 0.35rem 0 0; padding-left: 1.2rem; }
                    .mgm-ok { background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: var(--radius-md); padding: var(--space-3); font-size: 0.85rem; }
                    .mgm-sec { display: flex; flex-direction: column; gap: var(--space-2); }
                    .mgm-sec h4 { margin: 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
                    .mgm-line { display: flex; justify-content: space-between; gap: var(--space-3); font-size: 0.88rem; font-variant-numeric: tabular-nums; }
                    .mgm-line > span:first-child { min-width: 0; overflow-wrap: anywhere; }
                    .mgm-transfer { background: var(--bg-card); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); display: flex; flex-direction: column; gap: 0.2rem; }
                    .mgm-memo { font-size: 0.74rem; color: var(--text-muted); overflow-wrap: anywhere; }
                    .mgm-amount { font-weight: 600; white-space: nowrap; }
                    .mgm-muted { color: var(--text-muted); }
                    .mgm-small { font-size: 0.75rem; color: var(--text-muted); }
                    .mgm-up { color: var(--color-success); white-space: nowrap; }
                    .mgm-down { color: var(--color-warning); white-space: nowrap; }
                    .mgm-name .form-input { width: 100%; }
                    .mgm-summary { display: flex; justify-content: space-between; flex-wrap: wrap; gap: var(--space-2); font-size: 0.85rem; padding-top: var(--space-3); border-top: 1px solid var(--bg-card); }
                    .mgm-confirm { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.88rem; cursor: pointer; }
                    .mgm-confirm input { width: 18px; height: 18px; margin-top: 0.1rem; flex-shrink: 0; }
                    .mgm-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
                    @media (max-width: 480px) { .mgm-actions .btn { flex: 1; min-height: 44px; } }
                `}</style>
            </div>
        </div>
    );
};

export default MigrationModal;
