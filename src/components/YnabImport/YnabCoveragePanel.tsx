import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import type { GoalCoverage, GoalStatus } from '../../utils/ynabCoverage';
import { useYnabCoverage } from './useYnabCoverage';
import CategoryDetailModal from './CategoryDetailModal';

/**
 * Liquidity & coverage: the checks that follow from where the categories'
 * money sits (the "Location & nature" view above).
 *
 *  - Accounts: is each account's liquidity enough for the Available of the
 *    categories living on it, how much to deposit if not, and the minimum it
 *    should keep for day-to-day spending and goals due soon.
 *  - Emergency fund: N months of fixed spending against the categories marked
 *    as fund.
 *  - Goals: how far each dated target is, counting cash and investments.
 */

const eur = (value: number) =>
    value.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

const shortDate = (iso: string) =>
    new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IE', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const STATUS_LABEL: Record<GoalStatus, string> = {
    done: 'Covered',
    'on-track': 'In progress',
    'due-soon': 'Due soon',
    overdue: 'Overdue',
    'no-target': 'No target',
};

const monthsText = (g: GoalCoverage) => {
    if (g.monthsLeft === null) return null;
    if (g.monthsLeft < 0) return `${-g.monthsLeft} mo late`;
    if (g.monthsLeft === 0) return 'this month';
    return `${g.monthsLeft} mo left`;
};

const YnabCoveragePanel: React.FC = () => {
    const { brokers, updateBroker, ynabCategories, setYnabFundingSettings, setYnabMappingEmergency } = usePortfolio();
    const { report, settings } = useYnabCoverage();
    const [detailId, setDetailId] = useState<string | null>(null);
    const detail = detailId ? report.positions.find(p => p.categoryId === detailId) : undefined;

    if (ynabCategories.length === 0) return null;

    const { accounts, unlocated, emergency, goals } = report;
    const nameOf = (categoryId: string) => report.positions.find(p => p.categoryId === categoryId)?.name ?? categoryId;

    const setSetting = (key: 'emergencyMonths' | 'workingCapitalMonths' | 'goalHorizonMonths', raw: string) => {
        const value = Math.max(0, Math.min(60, Math.round(Number(raw) || 0)));
        setYnabFundingSettings(prev => ({ ...prev, [key]: value }));
    };

    const applyMinimum = (brokerId: string, amount: number) => {
        const broker = brokers.find(b => b.id === brokerId);
        if (!broker) return;
        Swal.fire({
            title: `Set ${broker.name}'s minimum liquidity?`,
            text: `The rebalancing and funding plans will keep ${eur(amount)} untouched on this account.`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Set minimum',
        }).then(r => {
            if (r.isConfirmed) updateBroker({ ...broker, minLiquidityType: 'fixed', minLiquidityAmount: Math.round(amount) });
        });
    };

    const fundCandidates = report.positions
        .filter(p => !p.emergencyFund)
        .sort((a, b) => a.name.localeCompare(b.name));
    const emergencyProgress = emergency.target > 0 ? Math.min(1, emergency.current / emergency.target) : 0;

    return (
        <div className="ynab-cov-card">
            <div className="cov-head">
                <div>
                    <h3 style={{ margin: 0 }}>Liquidity &amp; coverage</h3>
                    <div className="cov-sub">
                        Read from where each category's money sits and what kind of spending it is (Location &amp; nature above).
                    </div>
                </div>
                <div className="cov-settings">
                    <label title="Months of fixed (structural) spending the emergency fund should cover">
                        <span>Emergency fund</span>
                        <input type="number" className="form-input" min={0} max={60} value={settings.emergencyMonths}
                            onChange={e => setSetting('emergencyMonths', e.target.value)} />
                        <small>months</small>
                    </label>
                    <label title="Months of day-to-day spending each account keeps liquid">
                        <span>Working capital</span>
                        <input type="number" className="form-input" min={0} max={60} value={settings.workingCapitalMonths}
                            onChange={e => setSetting('workingCapitalMonths', e.target.value)} />
                        <small>months</small>
                    </label>
                    <label title="A goal due within this horizon must already be cash">
                        <span>Goals due within</span>
                        <input type="number" className="form-input" min={0} max={60} value={settings.goalHorizonMonths}
                            onChange={e => setSetting('goalHorizonMonths', e.target.value)} />
                        <small>months</small>
                    </label>
                </div>
            </div>

            {/* ── Accounts ─────────────────────────────────────────── */}
            <h4 className="cov-title">Accounts</h4>
            {accounts.length === 0 ? (
                <p className="cov-empty">No category sits on an account yet: set <em>Cash at</em> in Location &amp; nature.</p>
            ) : (
                <div className="cov-table-wrap">
                    <table className="cov-table">
                        <thead>
                            <tr>
                                <th>Account</th>
                                <th className="num">Liquidity</th>
                                <th className="num" title="Σ Available of the categories on this account">Categories</th>
                                <th>Coverage</th>
                                <th className="num" title="Average monthly spending of its fixed, variable and compressible categories">Day-to-day / mo</th>
                                <th className="num" title="Cash still missing for goals due within the horizon">Goals due</th>
                                <th className="num">Suggested min</th>
                                <th className="num">Current min</th>
                            </tr>
                        </thead>
                        <tbody>
                            {accounts.map(a => {
                                const minDiffers = Math.abs(a.recommendedMin - a.configuredMin) >= 1;
                                return (
                                    <tr key={a.brokerId}>
                                        <td className="cov-name" title={a.categoryIds.map(nameOf).join(', ')}>
                                            {a.brokerName}
                                            <small>{a.categoryIds.length} categor{a.categoryIds.length === 1 ? 'y' : 'ies'}</small>
                                        </td>
                                        <td className="num" data-label="Liquidity">{eur(a.liquidity)}</td>
                                        <td className="num" data-label="Categories">{eur(a.required)}</td>
                                        <td data-label="Coverage">
                                            {a.shortfall > 0
                                                ? <span className="pill pill-bad">Deposit {eur(a.shortfall)}</span>
                                                : <span className="pill pill-ok">Covered · +{eur(a.surplus)}</span>}
                                        </td>
                                        <td className="num" data-label="Day-to-day / mo">{eur(a.monthlySpend)}</td>
                                        <td className="num" data-label="Goals due">{a.dueGoals > 0 ? eur(a.dueGoals) : '—'}</td>
                                        <td className="num" data-label="Suggested min"><strong>{eur(a.recommendedMin)}</strong></td>
                                        <td className="num" data-label="Current min">
                                            <span>
                                                {a.configuredMin > 0 ? eur(a.configuredMin) : '—'}
                                                {minDiffers && a.recommendedMin > 0 && (
                                                    <button type="button" className="cov-link" onClick={() => applyMinimum(a.brokerId, a.recommendedMin)}>
                                                        Set
                                                    </button>
                                                )}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {unlocated.amount > 0 && (
                <p className="cov-note">
                    {eur(unlocated.amount)} of Available sits on no account ({unlocated.categoryIds.map(nameOf).join(', ')}):
                    pick a <em>Cash at</em> account or a default <em>Wire from</em> account in the funding plan.
                </p>
            )}

            {/* ── Emergency fund ───────────────────────────────────── */}
            <h4 className="cov-title">Emergency fund</h4>
            <div className="cov-fund">
                <div className="cov-figures">
                    <div><span>Fixed spending</span><strong>{eur(emergency.fixedMonthly)}/mo</strong></div>
                    <div><span>Target · {emergency.months} months</span><strong>{eur(emergency.target)}</strong></div>
                    <div><span>In the fund</span><strong>{eur(emergency.current)}</strong>
                        {emergency.invested > 0 && <small>{eur(emergency.cash)} cash + {eur(emergency.invested)} invested</small>}
                    </div>
                    <div>
                        <span>{emergency.gap > 0 ? 'Still to set aside' : 'Months covered'}</span>
                        <strong className={emergency.gap > 0 ? 'bad' : 'ok'}>
                            {emergency.gap > 0 ? eur(emergency.gap) : `${emergency.monthsCovered} months`}
                        </strong>
                    </div>
                </div>
                {emergency.target > 0 && (
                    <div className="cov-bar" aria-label={`${Math.round(emergencyProgress * 100)}% of target`}>
                        <div style={{ width: `${emergencyProgress * 100}%` }} />
                    </div>
                )}
                {emergency.fixedMonthly === 0 && (
                    <p className="cov-note">No fixed spending found: classify categories as <em>Fixed (structural)</em> and sync the 12-month averages.</p>
                )}
                <div className="cov-chips">
                    {emergency.categoryIds.map(id => (
                        <span key={id} className="cov-chip">
                            {nameOf(id)}
                            <button type="button" aria-label={`Remove ${nameOf(id)} from the emergency fund`}
                                onClick={() => setYnabMappingEmergency(id, false)}>×</button>
                        </span>
                    ))}
                    <select className="form-select cov-add" value=""
                        onChange={e => { if (e.target.value) setYnabMappingEmergency(e.target.value, true); }}>
                        <option value="">+ Add category to the fund…</option>
                        {fundCandidates.map(p => <option key={p.categoryId} value={p.categoryId}>{p.name}</option>)}
                    </select>
                </div>
            </div>

            {/* ── Goals ────────────────────────────────────────────── */}
            <h4 className="cov-title">Goals</h4>
            {goals.length === 0 ? (
                <p className="cov-empty">No goal yet: classify a category as <em>Goal (dated expense)</em> or give it a target.</p>
            ) : (
                <ul className="cov-goals">
                    {goals.map(g => {
                        const cashShare = g.target ? Math.min(1, g.cash / g.target) : 0;
                        const investedShare = g.target ? Math.min(1 - cashShare, g.invested / g.target) : 0;
                        return (
                            <li key={g.categoryId}>
                                <div className="cov-goal-head">
                                    <button type="button" className="cov-goal-name" onClick={() => setDetailId(g.categoryId)}>{g.name}</button>
                                    <span className={`pill pill-${g.status}`}>{STATUS_LABEL[g.status]}</span>
                                </div>
                                <div className="cov-goal-meta">
                                    {g.target ? <>{eur(g.covered)} of {eur(g.target)}</> : <>{eur(g.covered)} set aside</>}
                                    {g.date && <> · by {shortDate(g.date)} ({monthsText(g)})</>}
                                    {g.gap > 0 && <> · missing {eur(g.gap)}</>}
                                    {g.requiredMonthly !== null && g.status !== 'overdue' && <> · <strong>{eur(g.requiredMonthly)}/mo</strong> to get there</>}
                                </div>
                                {g.target ? (
                                    <div className="cov-bar cov-bar-split">
                                        <div className="cash" style={{ width: `${cashShare * 100}%` }} title={`Cash ${eur(g.cash)}`} />
                                        <div className="invested" style={{ width: `${investedShare * 100}%` }} title={`Invested ${eur(g.invested)}`} />
                                    </div>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}

            {detail && <CategoryDetailModal key={detail.categoryId} position={detail} onClose={() => setDetailId(null)} />}

            <style>{`
                .ynab-cov-card {
                    background: var(--bg-card);
                    border-radius: var(--radius-lg);
                    padding: 1.25rem;
                    margin-bottom: 1.5rem;
                }
                .cov-head { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 0.75rem; }
                .cov-sub { font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem; }
                .cov-settings { display: flex; gap: 0.75rem; flex-wrap: wrap; }
                .cov-settings label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.72rem; color: var(--text-muted); }
                .cov-settings input { width: 90px; padding: 0.3rem 0.45rem; }
                .cov-settings small { font-size: 0.68rem; }
                .cov-title {
                    margin: 1.25rem 0 0.5rem;
                    font-size: 0.78rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--text-secondary);
                }
                .cov-empty, .cov-note { font-size: 0.85rem; color: var(--text-secondary); margin: 0.4rem 0 0; }
                .cov-table-wrap { overflow-x: auto; border: 1px solid var(--border-color); border-radius: var(--radius-md); }
                .cov-table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
                .cov-table th, .cov-table td {
                    padding: 0.45rem 0.7rem;
                    border-bottom: 1px solid var(--border-color);
                    text-align: left;
                    white-space: nowrap;
                }
                .cov-table th {
                    background: var(--bg-surface);
                    font-size: 0.7rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--text-muted);
                }
                .cov-table .num { text-align: right; font-variant-numeric: tabular-nums; }
                .cov-table .cov-name { font-weight: 600; }
                .cov-table .cov-name small { display: block; font-weight: 400; color: var(--text-muted); font-size: 0.72rem; }
                .cov-link { background: none; border: none; color: var(--color-primary); cursor: pointer; font-size: 0.78rem; margin-left: 0.4rem; padding: 0; }
                .pill {
                    display: inline-block;
                    font-size: 0.72rem;
                    font-weight: 600;
                    padding: 0.12rem 0.5rem;
                    border-radius: 999px;
                    white-space: nowrap;
                }
                .pill-ok, .pill-done { background: color-mix(in srgb, var(--color-success, #10b981) 18%, transparent); color: var(--color-success, #10b981); }
                .pill-bad, .pill-overdue { background: color-mix(in srgb, var(--color-danger) 18%, transparent); color: var(--color-danger); }
                .pill-due-soon { background: color-mix(in srgb, var(--color-warning, #f59e0b) 20%, transparent); color: var(--color-warning, #f59e0b); }
                .pill-on-track { background: color-mix(in srgb, var(--color-primary) 16%, transparent); color: var(--color-primary); }
                .pill-no-target { background: var(--bg-app); color: var(--text-muted); }
                .cov-fund { background: var(--bg-app); border-radius: var(--radius-md); padding: 0.85rem; }
                .cov-figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.6rem; }
                .cov-figures div { display: flex; flex-direction: column; gap: 0.1rem; }
                .cov-figures span { font-size: 0.72rem; color: var(--text-muted); }
                .cov-figures strong { font-size: 1.05rem; font-variant-numeric: tabular-nums; }
                .cov-figures small { font-size: 0.72rem; color: var(--text-muted); }
                .cov-figures .bad { color: var(--color-danger); }
                .cov-figures .ok { color: var(--color-success, #10b981); }
                .cov-bar { height: 8px; background: var(--bg-surface); border-radius: 999px; overflow: hidden; margin-top: 0.7rem; display: flex; }
                .cov-bar > div { height: 100%; background: var(--color-primary); }
                .cov-bar-split .cash { background: var(--color-primary); }
                .cov-bar-split .invested { background: var(--color-success, #10b981); }
                .cov-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.75rem; align-items: center; }
                .cov-chip {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.3rem;
                    background: var(--bg-card);
                    border-radius: 999px;
                    padding: 0.2rem 0.3rem 0.2rem 0.65rem;
                    font-size: 0.82rem;
                }
                .cov-chip button { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 0.2rem; }
                .cov-add { width: auto; min-width: 200px; padding: 0.25rem 0.4rem; font-size: 0.82rem; }
                .cov-goals { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
                .cov-goals li { background: var(--bg-app); border-radius: var(--radius-md); padding: 0.7rem 0.85rem; }
                .cov-goal-head { display: flex; justify-content: space-between; gap: 0.5rem; align-items: center; }
                .cov-goal-name { background: none; border: none; padding: 0; color: var(--text-primary); font-weight: 600; font-size: 0.92rem; cursor: pointer; text-align: left; }
                .cov-goal-meta { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.2rem; font-variant-numeric: tabular-nums; }
                @media (max-width: 768px) {
                    .cov-table-wrap { border: none; }
                    .cov-table, .cov-table tbody, .cov-table tr, .cov-table td { display: block; width: auto; }
                    .cov-table thead { display: none; }
                    .cov-table tr { padding: 0.6rem 0; border-bottom: 1px solid var(--border-color); }
                    .cov-table td { border: none; padding: 0.15rem 0; white-space: normal; }
                    .cov-table td[data-label] { display: flex; justify-content: space-between; gap: 0.75rem; }
                    .cov-table td[data-label]::before {
                        content: attr(data-label);
                        font-size: 0.7rem;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                        color: var(--text-muted);
                    }
                    .cov-settings { width: 100%; }
                    .cov-settings label { flex: 1 1 0; }
                    .cov-settings input { width: 100%; font-size: 16px; }
                    .cov-add { flex: 1 1 100%; font-size: 16px; }
                }
            `}</style>
        </div>
    );
};

export default YnabCoveragePanel;
