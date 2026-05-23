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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                <h2 style={{ margin: 0 }}>YNAB Goals</h2>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    {ynabConfig.goalsGroupName && <>Group: <strong>{ynabConfig.goalsGroupName}</strong></>}
                    {ynabConfig.lastGoalsSyncAt && (
                        <> · Last sync: {new Date(ynabConfig.lastGoalsSyncAt).toLocaleString('en-IE')}</>
                    )}
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 'var(--space-6)' }}>
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

                    return (
                        <div
                            key={g.id}
                            style={{
                                background: 'var(--bg-surface)',
                                borderRadius: 'var(--radius-lg)',
                                border: '1px solid var(--bg-card)',
                                padding: 'var(--space-5)',
                                opacity: g.archived ? 0.7 : 1,
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                                <div>
                                    <h3 style={{ margin: 0 }}>
                                        {g.name}
                                        <span className="badge badge-ynab">YNAB</span>
                                        {g.archived && <span className="badge badge-warn">archived</span>}
                                        {g.targetSource === 'manual-override' && <span className="badge badge-info">manual</span>}
                                    </h3>
                                    {g.goalType && g.goalType !== 'MF' && (
                                        <div style={{ fontSize: '0.8rem', color: '#b45309', marginTop: '0.25rem' }}>
                                            ⚠️ YNAB goal type is <code>{g.goalType}</code>. Switch to <code>MF</code> to avoid YNAB underfunded warnings.
                                        </div>
                                    )}
                                </div>
                                <button
                                    className="btn-icon delete"
                                    title="Delete YNAB goal from tool"
                                    onClick={() => handleDeleteGoal(g)}
                                    style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                                >🗑️</button>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.75rem', fontSize: '0.85rem' }}>
                                <div><span style={{ color: 'var(--text-muted)' }}>Target</span><br /><strong>{formatCurrency(g.targetAmount, currencyIso)}</strong></div>
                                <div><span style={{ color: 'var(--text-muted)' }}>Target date</span><br /><strong>{g.targetDate || '—'}</strong></div>
                                <div><span style={{ color: 'var(--text-muted)' }}>Cash (YNAB)</span><br /><strong>{formatCurrencyExact(g.cashCoverage, currencyIso)}</strong></div>
                                <div><span style={{ color: 'var(--text-muted)' }}>Investments</span><br /><strong>{formatCurrencyExact(investmentCoverage, currencyIso)}</strong></div>
                                <div><span style={{ color: 'var(--text-muted)' }}>Total</span><br /><strong>{formatCurrencyExact(totalCoverage, currencyIso)}</strong></div>
                                <div><span style={{ color: 'var(--text-muted)' }}>Gap</span><br /><strong>{formatCurrencyExact(gap, currencyIso)}</strong></div>
                            </div>

                            {target > 0 && (
                                <div style={{ marginTop: '0.75rem' }}>
                                    <div style={{ height: 12, borderRadius: 'var(--radius-full)', background: 'var(--bg-card)', overflow: 'hidden', display: 'flex' }}>
                                        <div style={{ width: `${cashSegment}%`, background: '#3b82f6', height: '100%' }} title={`Cash ${formatCurrencyExact(g.cashCoverage, currencyIso)}`} />
                                        <div style={{ width: `${investSegment}%`, background: '#10b981', height: '100%' }} title={`Investments ${formatCurrencyExact(investmentCoverage, currencyIso)}`} />
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                                        <span>{progressPct.toFixed(1)}%</span>
                                        {g.targetDate && <span>{monthsRemaining} months left</span>}
                                    </div>
                                </div>
                            )}

                            <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.75rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem' }}>
                                <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Monthly funding</div>
                                {requiredMonthly != null && (
                                    <div>
                                        Suggested: <strong>{formatCurrencyExact(requiredMonthly, currencyIso)}/mo</strong>
                                        <button
                                            type="button"
                                            className="link-btn"
                                            style={{ marginLeft: '0.5rem', background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: '0.8rem', textDecoration: 'underline' }}
                                            onClick={() => navigator.clipboard.writeText(requiredMonthly.toFixed(2))}
                                        >Copy</button>
                                    </div>
                                )}
                                {g.ynabMonthlyFunding != null && (
                                    <div>
                                        YNAB MF: <strong>{formatCurrencyExact(g.ynabMonthlyFunding, currencyIso)}/mo</strong>
                                        {g.ynabActivityThisMonth != null && (
                                            <> · this month: {formatCurrencyExact(Math.abs(g.ynabActivityThisMonth), currencyIso)} / {formatCurrencyExact(g.ynabMonthlyFunding, currencyIso)}</>
                                        )}
                                    </div>
                                )}
                                {mfMismatch && (
                                    <div style={{ marginTop: '0.35rem', color: '#b45309' }}>
                                        ⚠️ YNAB MF differs from suggestion by &gt;10%.
                                    </div>
                                )}
                            </div>

                            <div style={{ marginTop: '0.75rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                                    <strong style={{ fontSize: '0.9rem' }}>Allocations</strong>
                                    <button
                                        type="button"
                                        className="btn btn-secondary"
                                        style={{ padding: '0.3rem 0.7rem', fontSize: '0.8rem' }}
                                        onClick={() => setDialog({ ynabGoal: g, editing: null })}
                                        disabled={g.archived}
                                    >+ Add</button>
                                </div>
                                {allocations.length === 0 ? (
                                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>No allocations yet.</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                        {allocations.map(a => (
                                            <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem', padding: '0.35rem 0.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)' }}>
                                                <span>{portfolioName(a.portfolioId)}</span>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                    <span style={{ fontFamily: 'monospace' }}>{formatCurrencyExact(a.amount, currencyIso)}</span>
                                                    <button
                                                        type="button"
                                                        className="btn-icon"
                                                        title="Edit"
                                                        onClick={() => setDialog({ ynabGoal: g, editing: a })}
                                                        style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                                                    >✏️</button>
                                                    <button
                                                        type="button"
                                                        className="btn-icon delete"
                                                        title="Remove"
                                                        onClick={() => handleRemoveAllocation(a)}
                                                        style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                                                    >🗑️</button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
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
                .badge {
                    display: inline-block;
                    margin-left: 0.5rem;
                    padding: 0.1rem 0.5rem;
                    border-radius: var(--radius-full);
                    font-size: 0.7rem;
                    font-weight: 500;
                    vertical-align: middle;
                }
                .badge-ynab { background: rgba(59, 130, 246, 0.15); color: #2563eb; }
                .badge-warn { background: rgba(245, 158, 11, 0.18); color: #b45309; }
                .badge-info { background: rgba(99, 102, 241, 0.15); color: #4f46e5; }
            `}</style>
        </div>
    );
};

export default YnabGoalsView;
