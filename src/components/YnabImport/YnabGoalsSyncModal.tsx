import React, { useState } from 'react';
import type { YnabGoalSyncCandidate } from '../../types';

interface Props {
    candidates: YnabGoalSyncCandidate[];
    currencyIso: string;
    onConfirm: (candidates: YnabGoalSyncCandidate[]) => void;
    onCancel: () => void;
}

const formatCurrency = (value: number | null, iso: string) =>
    value == null
        ? '—'
        : new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 2 }).format(value);

const YnabGoalsSyncModal: React.FC<Props> = ({ candidates, currencyIso, onConfirm, onCancel }) => {
    const [rows, setRows] = useState<YnabGoalSyncCandidate[]>(candidates);
    const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());

    const updateRow = (idx: number, patch: Partial<YnabGoalSyncCandidate>) => {
        setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
    };

    const toggleNote = (id: string) => {
        setExpandedNotes(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleConfirm = () => {
        onConfirm(rows);
    };

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal-content goal-sync-modal" onClick={e => e.stopPropagation()}>
                <h3 style={{ marginTop: 0 }}>Sync YNAB Investment Goals</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: 0 }}>
                    Edit the parsed values before confirming. Recognized syntax in the category name or note:
                    <code style={{ marginLeft: 4 }}>7000€ by 2028-06</code>,
                    <code style={{ marginLeft: 4 }}>[target:7000][date:2028-06]</code>,
                    <code style={{ marginLeft: 4 }}>7k entro 2028-06</code>.
                </p>

                <div className="goal-sync-table-wrap">
                    <table className="goal-sync-table">
                        <thead>
                            <tr>
                                <th>Category</th>
                                <th>Target €</th>
                                <th>Target date</th>
                                <th>Confidence</th>
                                <th>Cash balance</th>
                                <th>Goal type</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, idx) => {
                                const noteOpen = expandedNotes.has(row.ynabCategoryId);
                                const conflict = row.existingTargetSource === 'manual-override'
                                    && ((row.existingTargetAmount ?? null) !== row.parsedAmount
                                        || (row.existingTargetDate ?? null) !== row.parsedDate);
                                return (
                                    <React.Fragment key={row.ynabCategoryId}>
                                        <tr className={`row-${row.confidence}`}>
                                            <td>
                                                <div style={{ fontWeight: 600 }}>{row.ynabCategoryName}</div>
                                                {row.rawNote && (
                                                    <button
                                                        type="button"
                                                        className="link-btn"
                                                        onClick={() => toggleNote(row.ynabCategoryId)}
                                                    >
                                                        {noteOpen ? 'Hide note' : 'Show note'}
                                                    </button>
                                                )}
                                                {row.matchedYnabGoalId && (
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                        Existing → {row.existingTargetSource}
                                                    </div>
                                                )}
                                            </td>
                                            <td>
                                                <input
                                                    type="number"
                                                    className="form-input"
                                                    value={row.parsedAmount ?? ''}
                                                    onChange={e => updateRow(idx, { parsedAmount: e.target.value === '' ? null : parseFloat(e.target.value) })}
                                                    style={{ width: 110 }}
                                                />
                                            </td>
                                            <td>
                                                <input
                                                    type="date"
                                                    className="form-input"
                                                    value={row.parsedDate ?? ''}
                                                    onChange={e => updateRow(idx, { parsedDate: e.target.value || null })}
                                                    style={{ width: 150 }}
                                                />
                                            </td>
                                            <td>
                                                <span className={`pill pill-${row.confidence}`}>{row.confidence}</span>
                                            </td>
                                            <td style={{ fontFamily: 'monospace' }}>{formatCurrency(row.cashCoverage, currencyIso)}</td>
                                            <td>
                                                {row.goalType === 'MF'
                                                    ? <span className="pill pill-ok">MF</span>
                                                    : row.goalType
                                                        ? <span className="pill pill-warn" title="Use Monthly Funding (MF) to avoid YNAB underfunded warnings when moving cash to investments.">{row.goalType}</span>
                                                        : <span className="pill pill-muted">none</span>}
                                            </td>
                                            <td>
                                                <select
                                                    className="form-select"
                                                    value={row.action}
                                                    onChange={e => updateRow(idx, { action: e.target.value as 'create' | 'update' | 'skip' })}
                                                >
                                                    {row.matchedYnabGoalId
                                                        ? <option value="update">update</option>
                                                        : <option value="create">create</option>}
                                                    <option value="skip">skip</option>
                                                </select>
                                            </td>
                                        </tr>
                                        {conflict && (
                                            <tr>
                                                <td colSpan={7} style={{ background: 'rgba(245, 158, 11, 0.08)', fontSize: '0.85rem', padding: '0.5rem 0.75rem' }}>
                                                    ⚠️ Conflict with manual override: existing target = {formatCurrency(row.existingTargetAmount, currencyIso)} / {row.existingTargetDate || '—'}. Applying will overwrite your override.
                                                </td>
                                            </tr>
                                        )}
                                        {noteOpen && row.rawNote && (
                                            <tr>
                                                <td colSpan={7} style={{ background: 'var(--bg-surface)', whiteSpace: 'pre-wrap', fontSize: '0.85rem', padding: '0.5rem 0.75rem' }}>
                                                    {row.rawNote}
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                            {rows.length === 0 && (
                                <tr>
                                    <td colSpan={7} style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)' }}>
                                        No categories found in the selected group.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                    <button type="button" className="btn" onClick={onCancel}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={handleConfirm}>Confirm sync</button>
                </div>

                <style>{`
                    .goal-sync-modal {
                        max-width: 1100px;
                        width: 95vw;
                    }
                    .goal-sync-table-wrap {
                        overflow-x: auto;
                        margin-top: 1rem;
                        border: 1px solid var(--border-color);
                        border-radius: var(--radius-md);
                    }
                    .goal-sync-table {
                        width: 100%;
                        border-collapse: collapse;
                        font-size: 0.9rem;
                    }
                    .goal-sync-table th,
                    .goal-sync-table td {
                        padding: 0.5rem 0.75rem;
                        text-align: left;
                        border-bottom: 1px solid var(--border-color);
                        vertical-align: middle;
                    }
                    .goal-sync-table thead th {
                        background: var(--bg-surface);
                        font-size: 0.75rem;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                        color: var(--text-muted);
                    }
                    .row-low { background: rgba(245, 158, 11, 0.08); }
                    .pill {
                        display: inline-block;
                        padding: 0.15rem 0.5rem;
                        border-radius: var(--radius-full);
                        font-size: 0.75rem;
                        font-weight: 500;
                    }
                    .pill-high { background: rgba(16, 185, 129, 0.15); color: #059669; }
                    .pill-medium { background: rgba(59, 130, 246, 0.15); color: #2563eb; }
                    .pill-low { background: rgba(245, 158, 11, 0.18); color: #b45309; }
                    .pill-ok { background: rgba(16, 185, 129, 0.15); color: #059669; }
                    .pill-warn { background: rgba(245, 158, 11, 0.18); color: #b45309; cursor: help; }
                    .pill-muted { background: var(--bg-card); color: var(--text-muted); }
                    .link-btn {
                        background: none;
                        border: none;
                        color: var(--color-primary);
                        cursor: pointer;
                        padding: 0;
                        font-size: 0.8rem;
                        text-decoration: underline;
                    }
                `}</style>
            </div>
        </div>
    );
};

export default YnabGoalsSyncModal;
