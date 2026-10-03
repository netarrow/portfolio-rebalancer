import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabGoalAllocation } from '../../types';
import { isVirtualBondTicker, getVirtualBondId } from '../../types';
import { pinnedAllocationCoverage } from '../../utils/goalAllocationCoverage';
import GoalSetupModal from './GoalSetupModal';
import { buildGoalRow, formatCurrency, formatCurrencyExact } from './goalRows';

// Investments shown inline in a row of the list; the rest are summed into "+N".
const MAX_WHERE_CHIPS = 2;

const formatShortDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-IE', { year: 'numeric', month: 'short' });

const YnabGoalsView: React.FC<{ onNavigateToYnab?: () => void }> = ({ onNavigateToYnab }) => {
    const {
        ynabGoals,
        portfolios,
        ynabConfig,
        getYnabGoalAllocations,
        ynabGoalAllocations,
        transactions,
        effectiveAssetSettings,
        marketData,
        virtualBonds,
    } = usePortfolio();

    // An allocation pinned to an asset of a goal-matching portfolio is a
    // target, not money set aside: what it actually covers is its share of
    // what the asset holds today (the asset's goals are funded pro rata).
    const pinnedCoverage = useMemo(() => pinnedAllocationCoverage({
        portfolios,
        transactions,
        assetSettings: effectiveAssetSettings,
        marketData,
        allocations: ynabGoalAllocations,
        goals: ynabGoals,
        virtualBonds,
    }), [portfolios, transactions, effectiveAssetSettings, marketData, ynabGoalAllocations, ynabGoals, virtualBonds]);

    const coveredBy = (a: YnabGoalAllocation) => pinnedCoverage.get(a.id) ?? a.amount;
    const isPinned = (a: YnabGoalAllocation) => pinnedCoverage.has(a.id);

    const allocationLabel = (a: YnabGoalAllocation) => {
        const portfolio = portfolios.find(p => p.id === a.portfolioId);
        let row: string | null = null;
        if (a.ticker) {
            const group = portfolio?.allocationGroups?.find(g => g.id === a.ticker);
            row = group ? group.label
                : isVirtualBondTicker(a.ticker) ? (virtualBonds.find(b => b.id === getVirtualBondId(a.ticker!))?.label || 'Virtual bond')
                : (effectiveAssetSettings.find(s => s.ticker.toUpperCase() === a.ticker!.toUpperCase())?.label || a.ticker);
        }
        return { portfolio: portfolio?.name || a.portfolioId, row };
    };

    const [setupGoalId, setSetupGoalId] = useState<string | null>(null);
    const currencyIso = ynabConfig?.currencyIso || 'EUR';

    const rows = useMemo(() => {
        return [...ynabGoals]
            .sort((a, b) => {
                if (!!a.archived !== !!b.archived) return a.archived ? 1 : -1;
                return a.name.localeCompare(b.name);
            })
            .map(g => buildGoalRow(g, getYnabGoalAllocations(g.id), coveredBy));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ynabGoals, ynabGoalAllocations, pinnedCoverage]);

    const totals = useMemo(() => {
        const active = rows.filter(r => !r.goal.archived);
        const target = active.reduce((s, r) => s + r.target, 0);
        const cash = active.reduce((s, r) => s + r.cash, 0);
        const invested = active.reduce((s, r) => s + r.invested, 0);
        // Coverage counts each goal up to its own target, so a goal ahead of
        // plan does not hide another one behind it.
        const coveredOfTargets = active.reduce((s, r) => s + (r.target > 0 ? Math.min(r.covered, r.target) : 0), 0);
        return { count: active.length, target, cash, invested, pct: target > 0 ? (coveredOfTargets / target) * 100 : 0 };
    }, [rows]);

    const setupRow = setupGoalId ? rows.find(r => r.goal.id === setupGoalId) ?? null : null;

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

            <div className="ygl-totals">
                <div className="ygl-total">
                    <span className="ygl-total-label">Goals</span>
                    <span className="ygl-total-value">{totals.count}</span>
                </div>
                <div className="ygl-total">
                    <span className="ygl-total-label">Targets</span>
                    <span className="ygl-total-value">{formatCurrency(totals.target, currencyIso)}</span>
                </div>
                <div className="ygl-total">
                    <span className="ygl-total-label"><i className="goal-dot goal-dot-cash" /> Cash (YNAB)</span>
                    <span className="ygl-total-value">{formatCurrency(totals.cash, currencyIso)}</span>
                </div>
                <div className="ygl-total">
                    <span className="ygl-total-label"><i className="goal-dot goal-dot-invest" /> Invested</span>
                    <span className="ygl-total-value">{formatCurrency(totals.invested, currencyIso)}</span>
                </div>
                <div className="ygl-total">
                    <span className="ygl-total-label">Covered</span>
                    <span className="ygl-total-value">{totals.pct.toFixed(0)}%</span>
                </div>
            </div>

            <div className="ygl-list" role="list">
                <div className="ygl-head" aria-hidden>
                    <span>Goal</span>
                    <span className="ygl-num">Cash (YNAB)</span>
                    <span className="ygl-num">Invested</span>
                    <span>Where</span>
                    <span>Progress</span>
                    <span />
                </div>

                {rows.map(r => {
                    const g = r.goal;
                    const chips = r.allocations.slice(0, MAX_WHERE_CHIPS);
                    const hidden = r.allocations.slice(MAX_WHERE_CHIPS);
                    const openSetup = () => setSetupGoalId(g.id);
                    return (
                        <div
                            key={g.id}
                            role="listitem"
                            className={`ygl-row${g.archived ? ' ygl-row-archived' : ''}`}
                            onClick={openSetup}
                        >
                            <div className="ygl-cell ygl-name">
                                <span className="ygl-name-text" title={g.name}>{g.name}</span>
                                <span className="ygl-name-sub">
                                    {g.targetAmount != null && <>{formatCurrency(g.targetAmount, currencyIso)}</>}
                                    {g.targetAmount != null && g.targetDate && <span className="dot-sep">·</span>}
                                    {g.targetDate && <>{formatShortDate(g.targetDate)}{r.monthsRemaining != null && ` (${r.monthsRemaining}m)`}</>}
                                    {g.archived && <span className="badge badge-warn">archived</span>}
                                    {g.goalType && g.goalType !== 'MF' && (
                                        <span className="ygl-flag" title={`YNAB goal type is ${g.goalType}: switch to MF to avoid underfunded warnings`}>⚠</span>
                                    )}
                                </span>
                            </div>

                            <div className="ygl-cell ygl-num ygl-cash">
                                <span className="ygl-mlabel"><i className="goal-dot goal-dot-cash" /> Cash</span>
                                {formatCurrencyExact(r.cash, currencyIso)}
                            </div>

                            <div className="ygl-cell ygl-num ygl-invested">
                                <span className="ygl-mlabel"><i className="goal-dot goal-dot-invest" /> Invested</span>
                                {r.invested > 0 ? formatCurrencyExact(r.invested, currencyIso) : <span className="ygl-muted">—</span>}
                            </div>

                            <div className="ygl-cell ygl-where">
                                {r.allocations.length === 0 ? (
                                    <span className="ygl-muted">Not invested</span>
                                ) : (
                                    <>
                                        {chips.map(a => {
                                            const label = allocationLabel(a);
                                            const text = label.row ? `${label.portfolio} › ${label.row}` : label.portfolio;
                                            return (
                                                <span key={a.id} className="ygl-chip" title={`${text}: ${formatCurrencyExact(coveredBy(a), currencyIso)}`}>
                                                    {text}
                                                </span>
                                            );
                                        })}
                                        {hidden.length > 0 && (
                                            <span
                                                className="ygl-chip ygl-chip-more"
                                                title={hidden.map(a => {
                                                    const label = allocationLabel(a);
                                                    return `${label.row ? `${label.portfolio} › ${label.row}` : label.portfolio}: ${formatCurrencyExact(coveredBy(a), currencyIso)}`;
                                                }).join('\n')}
                                            >+{hidden.length}</span>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="ygl-cell ygl-progress">
                                {r.target > 0 ? (
                                    <>
                                        <div className="ygl-progress-top">
                                            <span className="ygl-pct">{r.progressPct.toFixed(0)}%</span>
                                            <span className={r.gap > 0 ? 'ygl-gap' : 'ygl-done'}>
                                                {r.gap > 0 ? `${formatCurrency(r.gap, currencyIso)} to go` : 'reached'}
                                            </span>
                                        </div>
                                        <div className="goal-bar" title={`Cash ${formatCurrencyExact(r.cash, currencyIso)} · Invested ${formatCurrencyExact(r.invested, currencyIso)}`}>
                                            <div className="goal-bar-cash" style={{ width: `${r.cashSegment}%` }} />
                                            <div className="goal-bar-invest" style={{ width: `${r.investSegment}%` }} />
                                        </div>
                                    </>
                                ) : (
                                    <span className="ygl-muted">No target</span>
                                )}
                            </div>

                            <div className="ygl-cell ygl-action">
                                <button
                                    type="button"
                                    className="ygl-setup"
                                    onClick={e => { e.stopPropagation(); openSetup(); }}
                                    aria-label={`Open setup of ${g.name}`}
                                    title="Goal setup"
                                >
                                    <span aria-hidden>⚙</span><span className="ygl-setup-text">Setup</span>
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {setupRow && (
                <GoalSetupModal
                    row={setupRow}
                    currencyIso={currencyIso}
                    coveredBy={coveredBy}
                    isPinned={isPinned}
                    allocationLabel={allocationLabel}
                    onClose={() => setSetupGoalId(null)}
                />
            )}

            <style>{`
                .ynab-goals-page {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-6);
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
                .dot-sep { color: var(--text-muted); margin: 0 0.3rem; }

                /* ── Totals strip ── */
                .ygl-totals {
                    display: grid;
                    grid-template-columns: repeat(5, minmax(0, 1fr));
                    gap: var(--space-3);
                }
                .ygl-total {
                    background: var(--bg-card);
                    border-radius: var(--radius-lg);
                    padding: var(--space-3) var(--space-4);
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-1);
                    min-width: 0;
                }
                .ygl-total-label {
                    font-size: 0.68rem;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--text-muted);
                    font-weight: 500;
                    white-space: nowrap;
                }
                .ygl-total-value {
                    font-size: 1.1rem;
                    font-weight: 700;
                    font-variant-numeric: tabular-nums;
                }

                /* ── List: a table on desktop, stacked rows on a phone ── */
                .ygl-list {
                    background: var(--bg-card);
                    border-radius: var(--radius-lg);
                    overflow: hidden;
                }
                .ygl-head, .ygl-row {
                    display: grid;
                    grid-template-columns:
                        minmax(180px, 2.2fr) minmax(100px, 1fr) minmax(100px, 1fr)
                        minmax(160px, 2fr) minmax(150px, 1.6fr) 6rem;
                    align-items: center;
                    gap: var(--space-4);
                    padding: var(--space-3) var(--space-4);
                }
                .ygl-head {
                    font-size: 0.68rem;
                    text-transform: uppercase;
                    letter-spacing: 0.06em;
                    color: var(--text-muted);
                    font-weight: 600;
                    border-bottom: 1px solid var(--bg-surface);
                }
                .ygl-row {
                    border-bottom: 1px solid var(--bg-surface);
                    cursor: pointer;
                    transition: background 0.12s ease;
                }
                .ygl-row:last-child { border-bottom: none; }
                .ygl-row:hover { background: rgba(148, 163, 184, 0.06); }
                .ygl-row-archived { opacity: 0.55; }

                .ygl-cell { min-width: 0; font-size: 0.88rem; }
                .ygl-num { text-align: right; font-variant-numeric: tabular-nums; }
                .ygl-cash, .ygl-invested { font-weight: 600; }
                .ygl-muted { color: var(--text-muted); font-weight: 400; }
                .ygl-mlabel { display: none; }

                .ygl-name { display: flex; flex-direction: column; gap: 0.15rem; }
                .ygl-name-text {
                    font-weight: 600;
                    color: var(--text-primary);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .ygl-name-sub {
                    font-size: 0.75rem;
                    color: var(--text-muted);
                    display: flex;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 0.2rem;
                    font-variant-numeric: tabular-nums;
                }
                .ygl-name-sub .badge { margin-left: 0.3rem; }
                .ygl-flag { color: var(--color-warning); margin-left: 0.3rem; }

                .ygl-where { display: flex; flex-wrap: wrap; gap: 0.3rem; padding-left: var(--space-3); }
                .ygl-head > span:nth-child(4) { padding-left: var(--space-3); }
                .ygl-action { display: flex; justify-content: flex-end; }
                .ygl-chip {
                    font-size: 0.74rem;
                    background: var(--bg-surface);
                    color: var(--text-secondary);
                    padding: 0.15rem 0.5rem;
                    border-radius: 999px;
                    max-width: 100%;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .ygl-chip-more { color: var(--text-muted); }

                .ygl-progress { display: flex; flex-direction: column; gap: 0.3rem; }
                .ygl-progress-top {
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: var(--space-2);
                    font-variant-numeric: tabular-nums;
                }
                .ygl-pct { font-weight: 700; }
                .ygl-gap { font-size: 0.75rem; color: var(--color-warning); white-space: nowrap; }
                .ygl-done { font-size: 0.75rem; color: var(--color-success); }

                .goal-bar {
                    height: 6px;
                    background: var(--bg-surface);
                    border-radius: 999px;
                    overflow: hidden;
                    display: flex;
                }
                .goal-bar-lg { height: 10px; }
                .goal-bar-cash { background: var(--color-etf); height: 100%; }
                .goal-bar-invest { background: var(--color-success); height: 100%; }
                .goal-dot {
                    display: inline-block;
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    margin-right: 0.3rem;
                    vertical-align: middle;
                }
                .goal-dot-cash { background: var(--color-etf); }
                .goal-dot-invest { background: var(--color-success); }

                .ygl-setup {
                    background: var(--bg-surface);
                    border: 1px solid rgba(148, 163, 184, 0.2);
                    color: var(--text-primary);
                    border-radius: var(--radius-md);
                    padding: 0.35rem 0.7rem;
                    font-size: 0.8rem;
                    font-weight: 600;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 0.35rem;
                    white-space: nowrap;
                }
                .ygl-setup:hover { border-color: var(--color-primary); }

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

                /* Mid widths: "Where" moves under the name instead of
                   squeezing every column. */
                @media (max-width: 1100px) and (min-width: 721px) {
                    .ygl-head, .ygl-row {
                        grid-template-columns: minmax(180px, 2fr) minmax(95px, 1fr) minmax(95px, 1fr) minmax(140px, 1.5fr) 6rem;
                    }
                    .ygl-head > span:nth-child(4) { display: none; }
                    .ygl-where { grid-column: 1 / 2; grid-row: 2; padding-left: 0; }
                }

                /* Phone: every goal is a compact block — name and setup on
                   top, the bar, then cash / invested side by side and where
                   the money sits. The whole block opens the setup. */
                @media (max-width: 720px) {
                    .ygl-totals { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
                    .ygl-total:first-child { display: none; }
                    .ygl-total { padding: var(--space-2) var(--space-3); }
                    .ygl-total-value { font-size: 1rem; }

                    .ygl-head { display: none; }
                    .ygl-row {
                        grid-template-columns: 1fr 1fr auto;
                        grid-template-areas:
                            "name name action"
                            "progress progress progress"
                            "cash invested invested"
                            "where where where";
                        gap: var(--space-2) var(--space-3);
                        padding: var(--space-3);
                    }
                    .ygl-name { grid-area: name; }
                    .ygl-action { grid-area: action; align-self: start; }
                    .ygl-progress { grid-area: progress; }
                    .ygl-cash { grid-area: cash; }
                    .ygl-invested { grid-area: invested; }
                    .ygl-where { grid-area: where; padding-left: 0; }
                    .ygl-name-text { white-space: normal; overflow-wrap: anywhere; }
                    .ygl-num { text-align: left; }
                    .ygl-cash, .ygl-invested { display: flex; flex-direction: column; gap: 0.1rem; }
                    .ygl-mlabel {
                        display: block;
                        font-size: 0.66rem;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                        color: var(--text-muted);
                        font-weight: 500;
                    }
                    .ygl-setup { min-width: 44px; min-height: 44px; justify-content: center; padding: 0.35rem; }
                    .ygl-setup-text { display: none; }
                    .ygl-setup span[aria-hidden] { font-size: 1.1rem; }
                }
            `}</style>
        </div>
    );
};

export default YnabGoalsView;
