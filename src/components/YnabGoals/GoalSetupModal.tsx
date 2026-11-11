import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabGoalAllocation } from '../../types';
import AllocationModal from './AllocationModal';
import { formatCurrency, formatCurrencyExact, formatTargetDate, type GoalRow } from './goalRows';
import { parsePrbLine } from '../../utils/ynabGoalParser';
import { nextCycle, sinkingFundStatus } from '../../utils/sinkingFunds';

interface Props {
    row: GoalRow;
    currencyIso: string;
    coveredBy: (a: YnabGoalAllocation) => number;
    // Pinned to a row of an amount-mode portfolio: covers a share of what the
    // row holds, which may differ from the amount it was given.
    isPinned: (a: YnabGoalAllocation) => boolean;
    allocationLabel: (a: YnabGoalAllocation) => { portfolio: string; row: string | null };
    onClose: () => void;
}

// Setup of one YNAB goal: its figures, its monthly funding and the
// investments covering it — everything the goals list leaves out.
const GoalSetupModal: React.FC<Props> = ({ row, currencyIso, coveredBy, isPinned, allocationLabel, onClose }) => {
    const { removeAllocation, deleteYnabGoal, setCategoryGoalTarget, setYnabGoalCycle, renewYnabGoalCycle } = usePortfolio();
    const [editing, setEditing] = useState<{ allocation: YnabGoalAllocation | null } | null>(null);
    const g = row.goal;
    // The target is set here; the YNAB Writeback copies it into the note.
    const [draft, setDraft] = useState<{ amount: string; date: string } | null>(null);
    const prb = parsePrbLine(g.ynabNote);
    const noteInLine = !!prb && (prb.amount ?? null) === (g.targetAmount ?? null)
        && (prb.date ?? null) === (g.targetDate?.slice(0, 10) ?? null);
    const saveDraft = () => {
        if (!draft) return;
        const amount = Number(draft.amount.replace(',', '.'));
        setCategoryGoalTarget(g.id, {
            amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null,
            date: draft.date || null,
        });
        setDraft(null);
    };

    // Cyclical capex: the fund against its straight line, and its renewal.
    const fund = sinkingFundStatus(g, row.covered, new Date().toLocaleDateString('sv-SE'));
    const setCycle = (patch: { years?: string; inflation?: string }) => {
        const years = patch.years !== undefined ? Number(patch.years.replace(',', '.')) : g.cycle?.years ?? 0;
        const inflation = patch.inflation !== undefined ? Number(patch.inflation.replace(',', '.')) : g.cycle?.inflationPercent ?? 0;
        if (!(years > 0)) { setYnabGoalCycle(g.id, null); return; }
        setYnabGoalCycle(g.id, {
            ...g.cycle, years: Math.min(100, years),
            ...(inflation > 0 ? { inflationPercent: Math.min(50, inflation) } : { inflationPercent: undefined }),
        });
    };
    const handleRenew = () => {
        const next = nextCycle(g);
        if (!next) return;
        Swal.fire({
            title: 'Start the next cycle?',
            html: `Once “${g.name}” has been paid, the fund starts again:<br/><b>${formatCurrency(next.targetAmount, currencyIso)}</b> by <b>${formatTargetDate(next.targetDate)}</b>.<br/><span style="font-size:0.85rem">The target and the date change here; what is still in the fund is kept and counts toward the next one.</span>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Start next cycle',
        }).then(r => { if (r.isConfirmed) renewYnabGoalCycle(g.id); });
    };

    const handleRemoveAllocation = (alloc: YnabGoalAllocation) => {
        Swal.fire({
            title: 'Remove allocation?',
            text: `Remove ${formatCurrencyExact(alloc.amount, currencyIso)} from ${allocationLabel(alloc).portfolio}?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Remove',
        }).then(r => {
            if (r.isConfirmed) removeAllocation(alloc.id);
        });
    };

    const handleDeleteGoal = () => {
        Swal.fire({
            title: 'Delete planned capex?',
            text: `This removes "${g.name}" from the tool. Allocations must be empty.`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete',
        }).then(r => {
            if (!r.isConfirmed) return;
            const res = deleteYnabGoal(g.id);
            if (!res.ok) {
                Swal.fire({ title: 'Cannot delete', text: res.error, icon: 'error' });
                return;
            }
            onClose();
        });
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="modal-content gsm-modal"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={`Setup of ${g.name}`}
            >
                <div className="gsm-head">
                    <div className="gsm-titleblock">
                        <h3 className="gsm-title">{g.name}</h3>
                        <div className="gsm-badges">
                            <span className="badge badge-ynab">YNAB</span>
                            {g.archived && <span className="badge badge-warn">archived</span>}
                            {g.targetSource === 'manual-override' && <span className="badge badge-info">manual</span>}
                            {g.targetSource === 'ynab-goal' && (
                                <span className="badge badge-info" title="Target read from YNAB's own goal fields">ynab target</span>
                            )}
                        </div>
                    </div>
                    <button type="button" className="gsm-close" onClick={onClose} aria-label="Close">✕</button>
                </div>

                {g.goalType && g.goalType !== 'MF' && (
                    <div className="gsm-alert">
                        <span aria-hidden>⚠</span>
                        <span>YNAB goal type is <code>{g.goalType}</code>. Switch to <code>MF</code> to avoid underfunded warnings.</span>
                    </div>
                )}

                {row.target > 0 && (
                    <div className="gsm-progress">
                        <div className="gsm-progress-meta">
                            <span className="gsm-progress-pct">{row.progressPct.toFixed(1)}%</span>
                            {row.monthsRemaining != null && (
                                <span className="gsm-progress-eta">{row.monthsRemaining} months left</span>
                            )}
                        </div>
                        <div className="goal-bar goal-bar-lg">
                            <div className="goal-bar-cash" style={{ width: `${row.cashSegment}%` }} />
                            <div className="goal-bar-invest" style={{ width: `${row.investSegment}%` }} />
                        </div>
                        <div className="gsm-legend">
                            <span><i className="goal-dot goal-dot-cash" /> Cash</span>
                            <span><i className="goal-dot goal-dot-invest" /> Investments</span>
                        </div>
                    </div>
                )}

                <div className="gsm-target">
                    {draft ? (
                        <>
                            <label className="gsm-target-field">
                                <span className="gsm-stat-label">Target (€)</span>
                                <input
                                    type="number" min="0" step="any" inputMode="decimal" autoFocus
                                    value={draft.amount}
                                    onChange={e => setDraft({ ...draft, amount: e.target.value })}
                                    onKeyDown={e => { if (e.key === 'Enter') saveDraft(); if (e.key === 'Escape') setDraft(null); }}
                                />
                            </label>
                            <label className="gsm-target-field">
                                <span className="gsm-stat-label">Due date</span>
                                <input type="date" value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} />
                            </label>
                            <div className="gsm-target-actions">
                                <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>Cancel</button>
                                <button type="button" className="btn btn-sm btn-primary" onClick={saveDraft}>Save</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="gsm-stat">
                                <span className="gsm-stat-label">Target</span>
                                <span className="gsm-stat-value">{formatCurrency(g.targetAmount, currencyIso)}</span>
                            </div>
                            <div className="gsm-stat">
                                <span className="gsm-stat-label">Target date</span>
                                <span className="gsm-stat-value">{formatTargetDate(g.targetDate)}</span>
                            </div>
                            <div className="gsm-target-actions">
                                <button
                                    type="button"
                                    className="btn btn-sm"
                                    onClick={() => setDraft({ amount: g.targetAmount ? String(g.targetAmount) : '', date: g.targetDate?.slice(0, 10) ?? '' })}
                                >Edit</button>
                            </div>
                        </>
                    )}
                </div>
                {!g.archived && g.origin !== 'category' && !noteInLine && (g.targetAmount != null || g.targetDate) && (
                    <p className="gsm-note-hint">
                        {prb ? 'The [PRB] line in the YNAB note is out of date.' : 'The YNAB note has no [PRB] line yet.'}{' '}
                        Write it from “YNAB capex categories out of date” in the Capex list: if the line is edited in YNAB, YNAB wins at the next sync.
                    </p>
                )}

                <div className="gsm-stats">
                    <div className="gsm-stat">
                        <span className="gsm-stat-label">Total covered</span>
                        <span className="gsm-stat-value">{formatCurrencyExact(row.covered, currencyIso)}</span>
                    </div>
                    <div className="gsm-stat">
                        <span className="gsm-stat-label">Cash (YNAB)</span>
                        <span className="gsm-stat-value">{formatCurrencyExact(row.cash, currencyIso)}</span>
                    </div>
                    <div className="gsm-stat">
                        <span className="gsm-stat-label">Investments</span>
                        <span className="gsm-stat-value">{formatCurrencyExact(row.invested, currencyIso)}</span>
                    </div>
                    <div className="gsm-stat">
                        <span className="gsm-stat-label">Gap</span>
                        <span className={`gsm-stat-value${row.gap > 0 ? ' gsm-stat-gap' : ''}`}>{formatCurrencyExact(row.gap, currencyIso)}</span>
                    </div>
                </div>

                <section className="gsm-section">
                    <h4 className="gsm-section-title">Cycle</h4>
                    <div className="gsm-cycle">
                        <label title="How often this expense comes back. Empty = a one-off expense.">
                            Comes back every
                            <input type="number" min="0" max="100" step="any" inputMode="decimal" placeholder="—"
                                value={g.cycle?.years ?? ''} onChange={e => setCycle({ years: e.target.value })} />
                            years
                        </label>
                        {g.cycle && (
                            <label title="Yearly growth of its price: sizes the target of the next cycle and its later purchases in the Forecast">
                                price
                                <input type="number" min="0" max="50" step="any" inputMode="decimal" placeholder="0"
                                    value={g.cycle.inflationPercent ?? ''} onChange={e => setCycle({ inflation: e.target.value })} />
                                % a year
                            </label>
                        )}
                    </div>
                    {!g.cycle && <p className="gsm-muted">A one-off expense. Give it a cycle if it comes back (a car, a boiler, a laptop): its yearly quota then counts as cost of living, and the Forecast buys it again.</p>}
                    {fund && (
                        <>
                            <div className="gsm-funding-line" title="Target ÷ years: what this costs a year. Setting it aside is its depreciation, paid in advance: the purchase itself is not a cost on top.">
                                <span className="gsm-funding-label">Yearly quota</span>
                                <span className="gsm-funding-value">{formatCurrencyExact(fund.quota, currencyIso)}<small>/y</small> · {formatCurrencyExact(fund.quota / 12, currencyIso)}<small>/mo</small></span>
                            </div>
                            {fund.expected !== null && (
                                <div className="gsm-funding-line" title="A straight line from the start of the cycle to its date">
                                    <span className="gsm-funding-label">Should hold today</span>
                                    <span className="gsm-funding-value">
                                        {formatCurrencyExact(fund.expected, currencyIso)}
                                        {fund.behind > 0.5
                                            ? <small className="gsm-stat-gap"> · {formatCurrencyExact(fund.behind, currencyIso)} behind</small>
                                            : <small> · in line</small>}
                                    </span>
                                </div>
                            )}
                            {g.targetDate
                                ? <button type="button" className="btn btn-sm gsm-renew" onClick={handleRenew} title="After the purchase: next date, the price by then, a new cycle">{fund.ended ? 'Cycle ended — start the next one…' : 'Purchased — start the next cycle…'}</button>
                                : <p className="gsm-muted">Set a due date to follow the fund against its line.</p>}
                        </>
                    )}
                </section>

                <section className="gsm-section">
                    <h4 className="gsm-section-title">Monthly funding</h4>
                    {row.requiredMonthly != null && (
                        <div className="gsm-funding-line">
                            <span className="gsm-funding-label">Suggested</span>
                            <span className="gsm-funding-value">
                                {formatCurrencyExact(row.requiredMonthly, currencyIso)}<small>/mo</small>
                                <button
                                    type="button"
                                    className="gsm-copy"
                                    onClick={() => navigator.clipboard.writeText(row.requiredMonthly!.toFixed(2))}
                                    title="Copy amount"
                                    aria-label="Copy suggested amount"
                                >📋</button>
                            </span>
                        </div>
                    )}
                    {g.ynabMonthlyFunding != null && (
                        <div className="gsm-funding-line">
                            <span className="gsm-funding-label">YNAB MF</span>
                            <span className="gsm-funding-value">
                                {formatCurrencyExact(g.ynabMonthlyFunding, currencyIso)}<small>/mo</small>
                            </span>
                        </div>
                    )}
                    {g.ynabMonthlyFunding != null && g.ynabActivityThisMonth != null && (
                        <div className="gsm-funding-line">
                            <span className="gsm-funding-label">This month</span>
                            <span className="gsm-funding-value gsm-muted">
                                {formatCurrencyExact(Math.abs(g.ynabActivityThisMonth), currencyIso)} / {formatCurrencyExact(g.ynabMonthlyFunding, currencyIso)}
                            </span>
                        </div>
                    )}
                    {row.requiredMonthly == null && g.ynabMonthlyFunding == null && (
                        <div className="gsm-empty">Set a target and a date to get a suggestion.</div>
                    )}
                    {row.mfMismatch && (
                        <div className="gsm-warn"><span aria-hidden>⚠</span> YNAB MF differs from suggestion by more than 10%.</div>
                    )}
                </section>

                <section className="gsm-section">
                    <div className="gsm-section-head">
                        <h4 className="gsm-section-title">Invested in</h4>
                        <button
                            type="button"
                            className="btn btn-primary gsm-add"
                            onClick={() => setEditing({ allocation: null })}
                            disabled={g.archived}
                        >+ Add</button>
                    </div>
                    {row.allocations.length === 0 ? (
                        <div className="gsm-empty">No allocations yet.</div>
                    ) : (
                        <ul className="gsm-allocs">
                            {row.allocations.map(a => {
                                const label = allocationLabel(a);
                                const covered = coveredBy(a);
                                return (
                                    <li key={a.id} className="gsm-alloc">
                                        <span className="gsm-alloc-name">
                                            {label.portfolio}
                                            {label.row && <span className="gsm-muted"> › {label.row}</span>}
                                        </span>
                                        <span className="gsm-alloc-amount">
                                            {isPinned(a) && Math.abs(covered - a.amount) > 0.5
                                                ? <>{formatCurrencyExact(covered, currencyIso)} <small className="gsm-muted">of {formatCurrencyExact(a.amount, currencyIso)}</small></>
                                                : formatCurrencyExact(a.amount, currencyIso)}
                                        </span>
                                        <span className="gsm-alloc-actions">
                                            <button
                                                type="button"
                                                className="gsm-icon-btn"
                                                title="Edit"
                                                aria-label="Edit allocation"
                                                onClick={() => setEditing({ allocation: a })}
                                            >✏️</button>
                                            <button
                                                type="button"
                                                className="gsm-icon-btn gsm-icon-btn-danger"
                                                title="Remove"
                                                aria-label="Remove allocation"
                                                onClick={() => handleRemoveAllocation(a)}
                                            >🗑</button>
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>

                <div className="gsm-footer">
                    <button type="button" className="btn gsm-delete" onClick={handleDeleteGoal}>Delete capex</button>
                    <button type="button" className="btn" onClick={onClose}>Close</button>
                </div>
            </div>

            {editing && (
                <div onClick={e => e.stopPropagation()}>
                    <AllocationModal
                        ynabGoal={g}
                        editing={editing.allocation}
                        onClose={() => setEditing(null)}
                    />
                </div>
            )}

            <style>{`
                .gsm-modal {
                    max-width: 620px;
                    width: 95vw;
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-5);
                }
                .gsm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
                .gsm-titleblock { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
                .gsm-title { margin: 0; font-size: 1.15rem; word-break: break-word; }
                .gsm-badges { display: flex; flex-wrap: wrap; gap: var(--space-2); }
                .gsm-close {
                    background: transparent; border: none; color: var(--text-muted);
                    width: 2.25rem; height: 2.25rem; border-radius: var(--radius-md);
                    cursor: pointer; font-size: 1rem; flex-shrink: 0;
                }
                .gsm-close:hover { background: var(--bg-card); color: var(--text-primary); }

                .gsm-alert {
                    display: flex; align-items: flex-start; gap: var(--space-2);
                    padding: var(--space-3);
                    background: rgba(245, 158, 11, 0.1);
                    border: 1px solid rgba(245, 158, 11, 0.25);
                    border-radius: var(--radius-md);
                    color: var(--color-warning);
                    font-size: 0.8rem; line-height: 1.4;
                }
                .gsm-alert code { background: rgba(245, 158, 11, 0.18); padding: 0.05rem 0.35rem; border-radius: var(--radius-sm); }

                .gsm-progress { display: flex; flex-direction: column; gap: var(--space-2); }
                .gsm-progress-meta { display: flex; align-items: baseline; justify-content: space-between; }
                .gsm-progress-pct { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.02em; }
                .gsm-progress-eta { font-size: 0.8rem; color: var(--text-muted); }
                .gsm-legend { display: flex; gap: var(--space-4); font-size: 0.75rem; color: var(--text-muted); }

                .gsm-target { display: flex; align-items: flex-end; gap: var(--space-4); flex-wrap: wrap; }
                .gsm-target > .gsm-stat { flex: 1; min-width: 120px; }
                .gsm-target-field { display: flex; flex-direction: column; gap: var(--space-1); flex: 1; min-width: 140px; }
                .gsm-target-field input { padding: 0.35rem 0.5rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); }
                .gsm-target-actions { display: flex; gap: 0.4rem; margin-left: auto; }
                .gsm-note-hint { margin: 0; font-size: 0.78rem; color: var(--color-warning); line-height: 1.4; }
                .gsm-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4); }
                .gsm-stat { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
                .gsm-stat-label {
                    font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
                    color: var(--text-muted); font-weight: 500;
                }
                .gsm-stat-value { font-size: 0.95rem; font-weight: 600; font-variant-numeric: tabular-nums; }
                .gsm-stat-gap { color: var(--color-warning); }

                .gsm-section {
                    display: flex; flex-direction: column; gap: var(--space-2);
                    padding-top: var(--space-4);
                    border-top: 1px solid var(--bg-card);
                }
                .gsm-section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
                .gsm-section-title {
                    margin: 0; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
                    color: var(--text-muted); font-weight: 600;
                }
                .gsm-add { padding: 0.35rem 0.85rem; font-size: 0.8rem; }

                .gsm-cycle { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); font-size: 0.88rem; color: var(--text-secondary); }
                .gsm-cycle label { display: flex; align-items: center; gap: var(--space-2); }
                .gsm-cycle input { width: 4.5rem; padding: 0.3rem 0.45rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); }
                .gsm-renew { align-self: flex-start; }
                .gsm-funding-line { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); font-size: 0.88rem; }
                .gsm-funding-label { color: var(--text-secondary); }
                .gsm-funding-value {
                    font-weight: 600; font-variant-numeric: tabular-nums;
                    display: inline-flex; align-items: center; gap: 0.2rem;
                }
                .gsm-funding-value small { font-size: 0.7rem; color: var(--text-muted); font-weight: 500; }
                .gsm-copy {
                    background: transparent; border: none; cursor: pointer;
                    font-size: 0.85rem; padding: 0.2rem 0.35rem; border-radius: var(--radius-sm);
                }
                .gsm-copy:hover { background: var(--bg-card); }
                .gsm-warn {
                    font-size: 0.78rem; color: var(--color-warning);
                    background: rgba(245, 158, 11, 0.1);
                    border-radius: var(--radius-sm); padding: 0.4rem 0.6rem;
                }
                .gsm-muted { color: var(--text-muted); font-weight: 400; }
                .gsm-empty { font-size: 0.85rem; color: var(--text-muted); }

                .gsm-allocs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
                .gsm-alloc {
                    display: grid; grid-template-columns: 1fr auto auto;
                    align-items: center; gap: var(--space-3);
                    padding: var(--space-2) var(--space-3);
                    background: var(--bg-card);
                    border-radius: var(--radius-md);
                    font-size: 0.85rem;
                }
                .gsm-alloc-name { min-width: 0; overflow-wrap: anywhere; }
                .gsm-alloc-amount { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
                .gsm-alloc-actions { display: flex; gap: 0.15rem; }
                .gsm-icon-btn {
                    background: transparent; border: none; cursor: pointer;
                    width: 2rem; height: 2rem; border-radius: var(--radius-sm); font-size: 0.85rem;
                }
                .gsm-icon-btn:hover { background: var(--bg-surface); }
                .gsm-icon-btn-danger:hover { background: rgba(239, 68, 68, 0.12); }

                .gsm-footer {
                    display: flex; justify-content: space-between; gap: var(--space-3);
                    padding-top: var(--space-4); border-top: 1px solid var(--bg-card);
                }
                .gsm-delete { color: var(--color-danger); }

                @media (max-width: 480px) {
                    .gsm-stats { grid-template-columns: repeat(2, 1fr); gap: var(--space-3); }
                    .gsm-alloc { gap: var(--space-2); padding: var(--space-2); }
                    .gsm-icon-btn { width: 2.5rem; height: 2.5rem; }
                    .gsm-footer .btn { min-height: 44px; flex: 1; }
                }
            `}</style>
        </div>
    );
};

export default GoalSetupModal;
