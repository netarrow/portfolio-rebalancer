import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabGoal, YnabGoalAllocation } from '../../types';
import AllocationModal from './AllocationModal';
import Swal from 'sweetalert2';

const formatCurrency = (value: number | undefined | null, iso: string = 'EUR') =>
    value == null
        ? '—'
        : new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 0 }).format(value);

const formatCurrencyExact = (value: number | undefined | null, iso: string = 'EUR') =>
    value == null
        ? '—'
        : new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 2 }).format(value);

function monthsBetween(from: Date, to: Date): number {
    const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
    return Math.max(0, months);
}

interface AllocationDialogState {
    ynabGoal: YnabGoal;
    editing: YnabGoalAllocation | null;
}

const YnabGoalsView: React.FC<{ onNavigateToYnab?: () => void }> = ({ onNavigateToYnab }) => {
    const {
        ynabGoals,
        portfolios,
        ynabConfig,
        getYnabGoalAllocations,
        removeAllocation,
        deleteYnabGoal,
    } = usePortfolio();

    const [dialog, setDialog] = useState<AllocationDialogState | null>(null);
    const currencyIso = ynabConfig?.currencyIso || 'EUR';

    const sortedGoals = useMemo(() => {
        return [...ynabGoals].sort((a, b) => {
            if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
            return a.name.localeCompare(b.name);
        });
    }, [ynabGoals]);

    const portfolioName = (id: string) => portfolios.find(p => p.id === id)?.name || id;

    const handleRemoveAllocation = (alloc: YnabGoalAllocation) => {
        Swal.fire({
            title: 'Remove allocation?',
            text: `Remove ${formatCurrencyExact(alloc.amount, currencyIso)} from ${portfolioName(alloc.portfolioId)}?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Remove',
        }).then(r => {
            if (r.isConfirmed) removeAllocation(alloc.id);
        });
    };

    const handleDeleteGoal = (g: YnabGoal) => {
        Swal.fire({
            title: 'Delete YNAB goal?',
            text: `This removes "${g.name}" from the tool. Allocations must be empty.`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete',
        }).then(r => {
            if (!r.isConfirmed) return;
            const res = deleteYnabGoal(g.id);
            if (!res.ok) {
                Swal.fire({ title: 'Cannot delete', text: res.error, icon: 'error' });
            }
        });
    };

    if (!ynabConfig) {
        return (
            <div style={{ maxWidth: 720, margin: '2rem auto', padding: '2rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
                <h2 style={{ marginBottom: '1rem' }}>YNAB not configured</h2>
                <p style={{ color: 'var(--text-secondary)' }}>
                    Configure YNAB first to sync your investment goals.
                </p>
            </div>
        );
    }

    if (ynabGoals.length === 0) {
        return (
            <div style={{ maxWidth: 720, margin: '2rem auto', padding: '2rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
                <h2 style={{ marginBottom: '1rem' }}>No YNAB goals synced yet</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                    Go to the YNAB section, pick an "Investment Goals" category group and run a sync.
                </p>
                {onNavigateToYnab && (
                    <button className="btn btn-primary" onClick={onNavigateToYnab}>Go to YNAB</button>
                )}
            </div>
        );
    }

    return (
        <div className="ynab-goals-page">
            <header className="ynab-goals-header">
                <div>
                    <h2 className="ynab-goals-title">YNAB Goals</h2>
                    <div className="ynab-goals-subtitle">
                        {ynabConfig.goalsGroupName && <>Group <strong>{ynabConfig.goalsGroupName}</strong></>}
                        {ynabConfig.lastGoalsSyncAt && (
                            <> <span className="dot-sep">·</span> Last sync {new Date(ynabConfig.lastGoalsSyncAt).toLocaleString('en-IE')}</>
                        )}
                    </div>
                </div>
            </header>

            <div className="ynab-goals-grid">
                {sortedGoals.map(g => {
                    const allocations = getYnabGoalAllocations(g.id);
                    const investmentCoverage = allocations.reduce((s, a) => s + a.amount, 0);
                    const totalCoverage = (g.cashCoverage || 0) + investmentCoverage;
                    const target = g.targetAmount ?? 0;
                    const gap = target > 0 ? Math.max(0, target - totalCoverage) : 0;
                    const progressPct = target > 0 ? Math.min(100, (totalCoverage / target) * 100) : 0;

                    let monthsRemaining = 0;
                    if (g.targetDate) {
                        monthsRemaining = monthsBetween(new Date(), new Date(g.targetDate));
                    }
                    const requiredMonthly = g.targetDate && target > 0
                        ? gap / Math.max(monthsRemaining, 1)
                        : null;

                    const mfMismatch = g.ynabMonthlyFunding != null && requiredMonthly != null && requiredMonthly > 0
                        ? Math.abs(g.ynabMonthlyFunding - requiredMonthly) / requiredMonthly > 0.1
                        : false;

                    const cashSegment = target > 0 ? Math.min(100, ((g.cashCoverage || 0) / target) * 100) : 0;
                    const investSegment = target > 0 ? Math.min(100 - cashSegment, (investmentCoverage / target) * 100) : 0;
                    const targetDateLabel = g.targetDate
                        ? new Date(g.targetDate).toLocaleDateString('en-IE', { year: 'numeric', month: 'short', day: 'numeric' })
                        : '—';

                    return (
                        <article key={g.id} className={`goal-card${g.archived ? ' goal-card-archived' : ''}`}>
                            <div className="goal-card-head">
                                <div className="goal-card-titleblock">
                                    <h3 className="goal-card-name">{g.name}</h3>
                                    <div className="goal-card-badges">
                                        <span className="badge badge-ynab">YNAB</span>
                                        {g.archived && <span className="badge badge-warn">archived</span>}
                                        {g.targetSource === 'manual-override' && <span className="badge badge-info">manual</span>}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className="goal-card-delete"
                                    title="Delete YNAB goal from tool"
                                    onClick={() => handleDeleteGoal(g)}
                                    aria-label="Delete goal"
                                >🗑</button>
                            </div>

                            {g.goalType && g.goalType !== 'MF' && (
                                <div className="goal-card-alert">
                                    <span aria-hidden>⚠</span>
                                    <span>YNAB goal type is <code>{g.goalType}</code>. Switch to <code>MF</code> to avoid underfunded warnings.</span>
                                </div>
                            )}

                            {target > 0 && (
                                <div className="goal-progress">
                                    <div className="goal-progress-meta">
                                        <span className="goal-progress-pct">{progressPct.toFixed(1)}%</span>
                                        {g.targetDate && (
                                            <span className="goal-progress-eta">{monthsRemaining} months left</span>
                                        )}
                                    </div>
                                    <div className="goal-progress-bar">
                                        <div className="goal-progress-cash" style={{ width: `${cashSegment}%` }} title={`Cash ${formatCurrencyExact(g.cashCoverage, currencyIso)}`} />
                                        <div className="goal-progress-invest" style={{ width: `${investSegment}%` }} title={`Investments ${formatCurrencyExact(investmentCoverage, currencyIso)}`} />
                                    </div>
                                    <div className="goal-progress-legend">
                                        <span><i className="dot dot-cash" /> Cash</span>
                                        <span><i className="dot dot-invest" /> Investments</span>
                                    </div>
                                </div>
                            )}

                            <div className="goal-stats">
                                <div className="goal-stat">
                                    <span className="goal-stat-label">Target</span>
                                    <span className="goal-stat-value">{formatCurrency(g.targetAmount, currencyIso)}</span>
                                </div>
                                <div className="goal-stat">
                                    <span className="goal-stat-label">Target date</span>
                                    <span className="goal-stat-value">{targetDateLabel}</span>
                                </div>
                                <div className="goal-stat">
                                    <span className="goal-stat-label">Total covered</span>
                                    <span className="goal-stat-value">{formatCurrencyExact(totalCoverage, currencyIso)}</span>
                                </div>
                                <div className="goal-stat">
                                    <span className="goal-stat-label">Cash (YNAB)</span>
                                    <span className="goal-stat-value">{formatCurrencyExact(g.cashCoverage, currencyIso)}</span>
                                </div>
                                <div className="goal-stat">
                                    <span className="goal-stat-label">Investments</span>
                                    <span className="goal-stat-value">{formatCurrencyExact(investmentCoverage, currencyIso)}</span>
                                </div>
                                <div className="goal-stat">
                                    <span className="goal-stat-label">Gap</span>
                                    <span className={`goal-stat-value${gap > 0 ? ' goal-stat-gap' : ''}`}>{formatCurrencyExact(gap, currencyIso)}</span>
                                </div>
                            </div>

                            <div className="goal-funding">
                                <div className="goal-funding-head">Monthly funding</div>
                                {requiredMonthly != null && (
                                    <div className="goal-funding-row">
                                        <span className="goal-funding-label">Suggested</span>
                                        <span className="goal-funding-value">
                                            {formatCurrencyExact(requiredMonthly, currencyIso)}<small>/mo</small>
                                            <button
                                                type="button"
                                                className="goal-funding-copy"
                                                onClick={() => navigator.clipboard.writeText(requiredMonthly.toFixed(2))}
                                                title="Copy amount"
                                            >Copy</button>
                                        </span>
                                    </div>
                                )}
                                {g.ynabMonthlyFunding != null && (
                                    <div className="goal-funding-row">
                                        <span className="goal-funding-label">YNAB MF</span>
                                        <span className="goal-funding-value">
                                            {formatCurrencyExact(g.ynabMonthlyFunding, currencyIso)}<small>/mo</small>
                                        </span>
                                    </div>
                                )}
                                {g.ynabMonthlyFunding != null && g.ynabActivityThisMonth != null && (
                                    <div className="goal-funding-row">
                                        <span className="goal-funding-label">This month</span>
                                        <span className="goal-funding-value goal-funding-value-muted">
                                            {formatCurrencyExact(Math.abs(g.ynabActivityThisMonth), currencyIso)} / {formatCurrencyExact(g.ynabMonthlyFunding, currencyIso)}
                                        </span>
                                    </div>
                                )}
                                {mfMismatch && (
                                    <div className="goal-funding-warn">
                                        <span aria-hidden>⚠</span> YNAB MF differs from suggestion by more than 10%.
                                    </div>
                                )}
                            </div>

                            <div className="goal-allocations">
                                <div className="goal-allocations-head">
                                    <span className="goal-allocations-title">Allocations</span>
                                    <button
                                        type="button"
                                        className="goal-allocations-add"
                                        onClick={() => setDialog({ ynabGoal: g, editing: null })}
                                        disabled={g.archived}
                                    >+ Add</button>
                                </div>
                                {allocations.length === 0 ? (
                                    <div className="goal-allocations-empty">No allocations yet.</div>
                                ) : (
                                    <ul className="goal-allocations-list">
                                        {allocations.map(a => (
                                            <li key={a.id} className="goal-allocation-row">
                                                <span className="goal-allocation-portfolio">{portfolioName(a.portfolioId)}</span>
                                                <span className="goal-allocation-amount">{formatCurrencyExact(a.amount, currencyIso)}</span>
                                                <div className="goal-allocation-actions">
                                                    <button
                                                        type="button"
                                                        className="goal-allocation-btn"
                                                        title="Edit"
                                                        aria-label="Edit allocation"
                                                        onClick={() => setDialog({ ynabGoal: g, editing: a })}
                                                    >✏️</button>
                                                    <button
                                                        type="button"
                                                        className="goal-allocation-btn goal-allocation-btn-delete"
                                                        title="Remove"
                                                        aria-label="Remove allocation"
                                                        onClick={() => handleRemoveAllocation(a)}
                                                    >🗑</button>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </article>
                    );
                })}
            </div>

            {dialog && (
                <AllocationModal
                    ynabGoal={dialog.ynabGoal}
                    editing={dialog.editing}
                    onClose={() => setDialog(null)}
                />
            )}

            <style>{`
                .ynab-goals-page {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-8);
                }
                .ynab-goals-header {
                    display: flex;
                    align-items: flex-end;
                    justify-content: space-between;
                    gap: var(--space-4);
                    flex-wrap: wrap;
                }
                .ynab-goals-title {
                    margin: 0 0 var(--space-2);
                    font-size: 1.5rem;
                    letter-spacing: -0.01em;
                }
                .ynab-goals-subtitle {
                    font-size: 0.85rem;
                    color: var(--text-secondary);
                }
                .ynab-goals-subtitle strong { color: var(--text-primary); font-weight: 600; }
                .dot-sep { color: var(--text-muted); margin: 0 0.2rem; }

                .ynab-goals-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
                    gap: var(--space-6);
                }

                .goal-card {
                    background: var(--bg-card);
                    border-radius: var(--radius-xl);
                    padding: var(--space-6);
                    box-shadow: var(--shadow-md);
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-5);
                    transition: transform 0.15s ease, box-shadow 0.15s ease;
                }
                .goal-card:hover {
                    transform: translateY(-2px);
                    box-shadow: var(--shadow-lg);
                }
                .goal-card-archived { opacity: 0.6; }

                .goal-card-head {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: var(--space-3);
                }
                .goal-card-titleblock {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                    min-width: 0;
                }
                .goal-card-name {
                    margin: 0;
                    font-size: 1.15rem;
                    font-weight: 600;
                    letter-spacing: -0.01em;
                    word-break: break-word;
                }
                .goal-card-badges {
                    display: flex;
                    flex-wrap: wrap;
                    gap: var(--space-2);
                }
                .goal-card-delete {
                    background: transparent;
                    border: none;
                    color: var(--text-muted);
                    width: 2rem;
                    height: 2rem;
                    border-radius: var(--radius-md);
                    cursor: pointer;
                    font-size: 0.95rem;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    transition: background 0.15s ease, color 0.15s ease;
                }
                .goal-card-delete:hover {
                    background: rgba(239, 68, 68, 0.12);
                    color: var(--color-danger);
                }

                .goal-card-alert {
                    display: flex;
                    align-items: flex-start;
                    gap: var(--space-2);
                    padding: var(--space-3);
                    background: rgba(245, 158, 11, 0.1);
                    border: 1px solid rgba(245, 158, 11, 0.25);
                    border-radius: var(--radius-md);
                    color: var(--color-warning);
                    font-size: 0.8rem;
                    line-height: 1.4;
                }
                .goal-card-alert code {
                    background: rgba(245, 158, 11, 0.18);
                    padding: 0.05rem 0.35rem;
                    border-radius: var(--radius-sm);
                    font-size: 0.78rem;
                }

                .goal-progress { display: flex; flex-direction: column; gap: var(--space-2); }
                .goal-progress-meta {
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                }
                .goal-progress-pct {
                    font-size: 1.35rem;
                    font-weight: 700;
                    color: var(--text-primary);
                    letter-spacing: -0.02em;
                }
                .goal-progress-eta {
                    font-size: 0.8rem;
                    color: var(--text-muted);
                }
                .goal-progress-bar {
                    height: 10px;
                    background: var(--bg-surface);
                    border-radius: 999px;
                    overflow: hidden;
                    display: flex;
                }
                .goal-progress-cash { background: var(--color-etf); height: 100%; transition: width 0.3s ease; }
                .goal-progress-invest { background: var(--color-success); height: 100%; transition: width 0.3s ease; }
                .goal-progress-legend {
                    display: flex;
                    gap: var(--space-4);
                    font-size: 0.75rem;
                    color: var(--text-muted);
                }
                .goal-progress-legend .dot {
                    display: inline-block;
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    margin-right: 0.3rem;
                    vertical-align: middle;
                }
                .dot-cash { background: var(--color-etf); }
                .dot-invest { background: var(--color-success); }

                .goal-stats {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: var(--space-4) var(--space-3);
                }
                .goal-stat {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-1);
                    min-width: 0;
                }
                .goal-stat-label {
                    font-size: 0.68rem;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--text-muted);
                    font-weight: 500;
                }
                .goal-stat-value {
                    font-size: 0.95rem;
                    font-weight: 600;
                    color: var(--text-primary);
                    font-variant-numeric: tabular-nums;
                }
                .goal-stat-gap { color: var(--color-warning); }

                .goal-funding {
                    background: var(--bg-surface);
                    border-radius: var(--radius-md);
                    padding: var(--space-4);
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                }
                .goal-funding-head {
                    font-size: 0.68rem;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--text-muted);
                    font-weight: 600;
                    margin-bottom: var(--space-1);
                }
                .goal-funding-row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: var(--space-3);
                    font-size: 0.85rem;
                }
                .goal-funding-label { color: var(--text-secondary); }
                .goal-funding-value {
                    font-weight: 600;
                    color: var(--text-primary);
                    font-variant-numeric: tabular-nums;
                    display: inline-flex;
                    align-items: baseline;
                    gap: var(--space-2);
                }
                .goal-funding-value small {
                    font-size: 0.7rem;
                    font-weight: 500;
                    color: var(--text-muted);
                    margin-left: -0.15rem;
                }
                .goal-funding-value-muted { color: var(--text-secondary); font-weight: 500; }
                .goal-funding-copy {
                    background: transparent;
                    border: 1px solid var(--bg-card);
                    color: var(--color-primary);
                    border-radius: var(--radius-sm);
                    padding: 0.15rem 0.5rem;
                    font-size: 0.7rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: background 0.15s ease, border-color 0.15s ease;
                }
                .goal-funding-copy:hover {
                    background: rgba(99, 102, 241, 0.12);
                    border-color: var(--color-primary);
                }
                .goal-funding-warn {
                    margin-top: var(--space-1);
                    font-size: 0.78rem;
                    color: var(--color-warning);
                    display: flex;
                    align-items: center;
                    gap: 0.4rem;
                }

                .goal-allocations { display: flex; flex-direction: column; gap: var(--space-2); }
                .goal-allocations-head {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .goal-allocations-title {
                    font-size: 0.68rem;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--text-muted);
                    font-weight: 600;
                }
                .goal-allocations-add {
                    background: transparent;
                    border: 1px solid var(--color-primary);
                    color: var(--color-primary);
                    border-radius: var(--radius-md);
                    padding: 0.3rem 0.75rem;
                    font-size: 0.78rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: background 0.15s ease, color 0.15s ease;
                }
                .goal-allocations-add:hover:not(:disabled) {
                    background: var(--color-primary);
                    color: white;
                }
                .goal-allocations-add:disabled { opacity: 0.4; cursor: not-allowed; }
                .goal-allocations-empty {
                    font-size: 0.85rem;
                    color: var(--text-muted);
                    padding: var(--space-2) 0;
                }
                .goal-allocations-list {
                    list-style: none;
                    margin: 0;
                    padding: 0;
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-1);
                }
                .goal-allocation-row {
                    display: grid;
                    grid-template-columns: 1fr auto auto;
                    align-items: center;
                    gap: var(--space-3);
                    padding: var(--space-2) var(--space-3);
                    background: var(--bg-surface);
                    border-radius: var(--radius-sm);
                    font-size: 0.85rem;
                    transition: background 0.15s ease;
                }
                .goal-allocation-row:hover { background: rgba(30, 41, 59, 0.7); }
                .goal-allocation-portfolio {
                    color: var(--text-primary);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .goal-allocation-amount {
                    font-variant-numeric: tabular-nums;
                    font-weight: 600;
                    color: var(--text-primary);
                }
                .goal-allocation-actions { display: flex; gap: 0.15rem; }
                .goal-allocation-btn {
                    background: transparent;
                    border: none;
                    color: var(--text-muted);
                    width: 1.75rem;
                    height: 1.75rem;
                    border-radius: var(--radius-sm);
                    cursor: pointer;
                    font-size: 0.85rem;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.15s ease, color 0.15s ease;
                }
                .goal-allocation-btn:hover { background: var(--bg-card); color: var(--text-primary); }
                .goal-allocation-btn-delete:hover { background: rgba(239, 68, 68, 0.12); color: var(--color-danger); }

                .badge {
                    display: inline-flex;
                    align-items: center;
                    padding: 0.15rem 0.55rem;
                    border-radius: 999px;
                    font-size: 0.68rem;
                    font-weight: 600;
                    letter-spacing: 0.02em;
                    text-transform: uppercase;
                }
                .badge-ynab { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
                .badge-warn { background: rgba(245, 158, 11, 0.18); color: #fbbf24; }
                .badge-info { background: rgba(99, 102, 241, 0.18); color: #a5b4fc; }

                @media (max-width: 600px) {
                    .ynab-goals-grid { grid-template-columns: 1fr; }
                    .goal-stats { grid-template-columns: repeat(2, 1fr); }
                    .goal-card { padding: var(--space-5); }
                }
            `}</style>
        </div>
    );
};

export default YnabGoalsView;
