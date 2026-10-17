import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { useYnabCoverage } from './useYnabCoverage';

/**
 * Liquidity & coverage, as three plain answers for the primary budget:
 *
 *  - Operating cash: the day-to-day money that circulates on the accounts
 *    (average month in / out, worst month) and how much cash to keep for it;
 *  - Emergency fund: the target, what is in it, and whether it sits apart from
 *    the operating cash;
 *  - Coming up: the planned capex due within the look-ahead, each one either
 *    already covered by cash, needing investments sold, or not covered at all.
 */

const eur = (value: number) =>
    value.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

const shortDate = (iso: string) =>
    new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IE', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const whenText = (monthsLeft: number) =>
    monthsLeft < 0 ? `${-monthsLeft} mo late` : monthsLeft === 0 ? 'this month' : `in ${monthsLeft} mo`;

interface Props {
    /** Kept for the callers; capex now show only as spending coming up. */
    hideCapex?: boolean;
}

const YnabCoveragePanel: React.FC<Props> = () => {
    const { brokers, ynabCategories, setYnabFundingSettings, setYnabMappingEmergency, portfolios, effectiveAssetSettings } = usePortfolio();
    const { report, settings } = useYnabCoverage();
    const [editFund, setEditFund] = useState(false);
    const [openAside, setOpenAside] = useState<Record<string, boolean>>({});

    if (ynabCategories.length === 0) return null;

    const { accounts, emergency, upcoming } = report;
    const nameOf = (categoryId: string) => report.positions.find(p => p.categoryId === categoryId)?.name ?? categoryId;
    const brokerName = (id?: string) => brokers.find(b => b.id === id)?.name ?? 'no account';
    const allocationLabel = (a: { portfolioId: string; ticker?: string }) => {
        const portfolio = portfolios.find(p => p.id === a.portfolioId)?.name ?? a.portfolioId;
        if (!a.ticker) return portfolio;
        const asset = effectiveAssetSettings.find(x => x.ticker.toUpperCase() === a.ticker!.toUpperCase())?.label || a.ticker;
        return `${portfolio} › ${asset}`;
    };

    const setSetting = (key: 'emergencyMonths' | 'workingCapitalMonths' | 'goalHorizonMonths', raw: string) => {
        const value = Math.max(0, Math.min(60, Math.round(Number(raw) || 0)));
        setYnabFundingSettings(prev => ({ ...prev, [key]: value }));
    };

    // ── Operating cash, all accounts together ─────────────────────────
    const sum = (f: (a: typeof accounts[number]) => number) => accounts.reduce((s, a) => s + f(a), 0);
    const operating = {
        avgIn: sum(a => a.avgIn),
        avgOut: sum(a => a.avgOut),
        worst: sum(a => a.peakOut),
        keep: sum(a => a.operatingCash),
        months: Math.max(0, ...accounts.map(a => a.flowMonths)),
    };
    const keepOn = accounts.filter(a => a.operatingCash > 0);

    // ── Set aside: cash on the accounts already destined elsewhere ─────
    const positionById = new Map(report.positions.map(p => [p.categoryId, p]));
    const asideKind = (id: string) => {
        const p = positionById.get(id);
        if (!p) return '';
        if (p.nature === 'sinking') return 'Sinking fund';
        if (p.nature === 'investments') return 'To invest';
        return p.nature ? '' : 'Not mapped';
    };
    const asideAccounts = accounts.filter(a => a.earmarked > 0 || a.emergencyHere > 0);
    const asideTotal = asideAccounts.reduce((s, a) => s + a.earmarked, 0);

    // ── Emergency fund ────────────────────────────────────────────────
    const emergencyProgress = emergency.target > 0 ? Math.min(1, emergency.current / emergency.target) : 0;
    const mixedFund = accounts.filter(a => a.emergencyHere > 0 && a.operatingCash > 0);
    const fundCandidates = report.positions.filter(p => !p.emergencyFund).sort((a, b) => a.name.localeCompare(b.name));
    const allGroups = [...new Map(report.positions.map(p => [p.groupId, p.groupName])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1]));
    const groupName = (id: string) => allGroups.find(([gid]) => gid === id)?.[1] ?? id;
    const portfolioName = (id: string) => portfolios.find(p => p.id === id)?.name ?? id;
    const setFundList = (key: 'emergencyGroupIds' | 'emergencyPortfolioIds', ids: string[]) =>
        setYnabFundingSettings(prev => ({ ...prev, [key]: ids }));
    const sourceCount = emergency.groupIds.length + emergency.flaggedCategoryIds.length + emergency.portfolios.length;

    // ── Coming up ─────────────────────────────────────────────────────
    const toSell = upcoming.reduce((s, u) => s + u.toRecover, 0);
    const missing = upcoming.reduce((s, u) => s + u.stillMissing, 0);
    const coveredCount = upcoming.filter(u => u.toRecover === 0 && u.stillMissing === 0).length;
    const afterPayments = accounts.filter(a => a.afterCapex);
    const totalTopUp = afterPayments.reduce((s, a) => s + (a.afterCapex?.topUp ?? 0), 0);

    return (
        <div className="ynab-cov-card">
            <div className="cov-head">
                <div>
                    <h3 style={{ margin: 0 }}>Liquidity &amp; coverage</h3>
                    <div className="cov-sub">How much cash to keep for day-to-day, the emergency fund, and the spending coming up.</div>
                </div>
                <div className="cov-settings">
                    <label title="Months of average day-to-day spending to keep as operating cash">
                        <span>Operating cash</span>
                        <input type="number" className="form-input" min={0} max={60} value={settings.workingCapitalMonths}
                            onChange={e => setSetting('workingCapitalMonths', e.target.value)} />
                        <small>months</small>
                    </label>
                    <label title="Months of fixed (structural) spending the emergency fund should cover">
                        <span>Emergency fund</span>
                        <input type="number" className="form-input" min={0} max={60} value={settings.emergencyMonths}
                            onChange={e => setSetting('emergencyMonths', e.target.value)} />
                        <small>months</small>
                    </label>
                    <label title="How far ahead to look for planned capex">
                        <span>Look ahead</span>
                        <input type="number" className="form-input" min={0} max={60} value={settings.goalHorizonMonths}
                            onChange={e => setSetting('goalHorizonMonths', e.target.value)} />
                        <small>months</small>
                    </label>
                </div>
            </div>

            <div className="cov-blocks">
                {/* ── 1 · Operating cash ─────────────────────────── */}
                <section className="cov-block">
                    <h4>Operating cash</h4>
                    <div className="cov-big">{eur(operating.keep)}</div>
                    <div className="cov-caption">to keep as cash for day-to-day spending</div>
                    <dl className="cov-list">
                        <div><dt>Average month in / out</dt><dd>{eur(operating.avgIn)} / {eur(operating.avgOut)}</dd></div>
                        <div><dt>Worst month out</dt><dd>{eur(operating.worst)}</dd></div>
                        <div><dt>Rule</dt><dd>{settings.workingCapitalMonths} × average + the worst-month swing</dd></div>
                    </dl>
                    {keepOn.length > 1 && (
                        <div className="cov-caption">{keepOn.map(a => `${eur(a.operatingCash)} on ${a.brokerName}`).join(' · ')}</div>
                    )}
                    {operating.months === 0 && <div className="cov-caption">From the 12-month averages: sync the spending history for the real month-by-month flow.</div>}
                </section>

                {/* ── Set aside ──────────────────────────────────── */}
                <section className="cov-block">
                    <h4>Set aside</h4>
                    <div className="cov-big">{eur(asideTotal)}</div>
                    <div className="cov-caption">cash on the accounts already destined elsewhere (dated expenses, money to invest). The emergency fund is counted on its own.</div>
                    {asideAccounts.length === 0 && <div className="cov-caption">Nothing set aside on the accounts.</div>}
                    {asideAccounts.map(a => {
                        const open = !!openAside[a.brokerId];
                        const ids = open ? a.earmarkedCategoryIds : a.earmarkedCategoryIds.slice(0, 4);
                        const hidden = a.earmarkedCategoryIds.length - ids.length;
                        return (
                            <div key={a.brokerId} className="cov-aside">
                                <div className="cov-aside-head">
                                    <strong>{a.brokerName}</strong>
                                    <span>{eur(a.earmarked)}</span>
                                </div>
                                <ul className="cov-aside-list">
                                    {ids.map(id => (
                                        <li key={id}>
                                            <span>{nameOf(id)}{asideKind(id) && <small> · {asideKind(id)}</small>}</span>
                                            <span>{eur(positionById.get(id)?.available ?? 0)}</span>
                                        </li>
                                    ))}
                                </ul>
                                {(hidden > 0 || open) && (
                                    <button type="button" className="cov-link" onClick={() => setOpenAside(prev => ({ ...prev, [a.brokerId]: !open }))}>
                                        {open ? 'Show less' : `Show all (+${hidden})`}
                                    </button>
                                )}
                                {a.emergencyHere > 0 && (
                                    <div className="cov-aside-head cov-aside-fund">
                                        <span>+ Emergency fund held here</span>
                                        <span>{eur(a.emergencyHere)}</span>
                                    </div>
                                )}
                                <div className="cov-aside-check" title="Liquidity on the account against operating cash + emergency fund held here + set aside">
                                    {eur(a.liquidity)} on the account vs {eur(a.operatingCash + a.emergencyHere + a.earmarked)} to hold
                                    {' '}(operating {eur(a.operatingCash)}{a.emergencyHere > 0 && <> + fund {eur(a.emergencyHere)}</>} + set aside {eur(a.earmarked)}) ·{' '}
                                    {a.free >= 0
                                        ? <span className="pill pill-ok">in line +{eur(a.free)}</span>
                                        : <span className="pill pill-bad">already short {eur(-a.free)}</span>}
                                </div>
                            </div>
                        );
                    })}
                </section>

                {/* ── 2 · Emergency fund ─────────────────────────── */}
                <section className="cov-block">
                    <h4>Emergency fund</h4>
                    <div className={`cov-big ${emergency.gap > 0 ? 'bad' : 'ok'}`}>
                        {emergency.gap > 0 ? `${eur(emergency.gap)} missing` : `${emergency.monthsCovered} months`}
                    </div>
                    <div className="cov-caption">{emergency.gap > 0 ? 'to reach the target' : 'of fixed spending covered'}</div>
                    {emergency.target > 0 && (
                        <div className="cov-bar" aria-label={`${Math.round(emergencyProgress * 100)}% of target`}>
                            <div style={{ width: `${emergencyProgress * 100}%` }} />
                        </div>
                    )}
                    <dl className="cov-list">
                        <div><dt>Target · {emergency.months} months of fixed spending</dt><dd>{eur(emergency.target)}</dd></div>
                        <div><dt>In the fund</dt><dd>{eur(emergency.current)}</dd></div>
                        {(emergency.invested > 0 || emergency.fromPortfolios > 0) && (
                            <div><dt>of which</dt><dd><small>
                                {[`${eur(emergency.cash)} cash`,
                                    emergency.invested > 0 ? `${eur(emergency.invested)} invested` : null,
                                    ...emergency.portfolios.map(x => `${eur(x.value)} in ${portfolioName(x.portfolioId)}`)]
                                    .filter(Boolean).join(' + ')}
                            </small></dd></div>
                        )}
                    </dl>
                    {mixedFund.length > 0 && (
                        <div className="cov-alert">
                            Keep it apart from operating cash: {mixedFund.map(a => `${eur(a.emergencyHere)} sits on ${a.brokerName}`).join(', ')},
                            the account that also pays day-to-day spending.
                        </div>
                    )}
                    {emergency.fixedMonthly === 0 && <div className="cov-caption">No fixed spending found: classify categories as Structural.</div>}
                    <button type="button" className="cov-link" onClick={() => setEditFund(v => !v)}>
                        {editFund ? 'Done' : `Fund sources (${sourceCount})`}
                    </button>
                    {editFund && (
                        <div className="cov-sources">
                            <div className="cov-chips">
                                {emergency.groupIds.map(id => (
                                    <span key={`g-${id}`} className="cov-chip" title="Every category of this YNAB group">
                                        📁 {groupName(id)}
                                        <button type="button" aria-label={`Remove the ${groupName(id)} group from the emergency fund`}
                                            onClick={() => setFundList('emergencyGroupIds', emergency.groupIds.filter(x => x !== id))}>×</button>
                                    </span>
                                ))}
                                {emergency.flaggedCategoryIds.map(id => (
                                    <span key={`c-${id}`} className="cov-chip">
                                        {nameOf(id)}
                                        <button type="button" aria-label={`Remove ${nameOf(id)} from the emergency fund`}
                                            onClick={() => setYnabMappingEmergency(id, false)}>×</button>
                                    </span>
                                ))}
                                {emergency.portfolios.map(x => (
                                    <span key={`p-${x.portfolioId}`} className="cov-chip" title="The whole value of this portfolio">
                                        📊 {portfolioName(x.portfolioId)}
                                        <button type="button" aria-label={`Remove ${portfolioName(x.portfolioId)} from the emergency fund`}
                                            onClick={() => setFundList('emergencyPortfolioIds', emergency.portfolios.map(p => p.portfolioId).filter(p => p !== x.portfolioId))}>×</button>
                                    </span>
                                ))}
                            </div>
                            <div className="cov-chips">
                                <select className="form-select cov-add" value=""
                                    onChange={e => { if (e.target.value) setFundList('emergencyGroupIds', [...emergency.groupIds, e.target.value]); }}>
                                    <option value="">+ YNAB group…</option>
                                    {allGroups.filter(([id]) => !emergency.groupIds.includes(id)).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                                </select>
                                <select className="form-select cov-add" value=""
                                    onChange={e => { if (e.target.value) setYnabMappingEmergency(e.target.value, true); }}>
                                    <option value="">+ Category…</option>
                                    {fundCandidates.map(p => <option key={p.categoryId} value={p.categoryId}>{p.name}</option>)}
                                </select>
                                <select className="form-select cov-add" value=""
                                    onChange={e => { if (e.target.value) setFundList('emergencyPortfolioIds', [...emergency.portfolios.map(p => p.portfolioId), e.target.value]); }}>
                                    <option value="">+ Portfolio…</option>
                                    {portfolios.filter(p => !emergency.portfolios.some(x => x.portfolioId === p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                </select>
                            </div>
                        </div>
                    )}
                </section>

                {/* ── 3 · Coming up ──────────────────────────────── */}
                <section className="cov-block cov-block-wide">
                    <h4>Coming up in the next {settings.goalHorizonMonths} months</h4>
                    {upcoming.length === 0 ? (
                        <div className="cov-caption">No planned capex due in the next {settings.goalHorizonMonths} months.</div>
                    ) : (
                        <>
                            <div className="cov-summary">
                                {toSell > 0 && <span className="pill pill-warn">Sell {eur(toSell)}</span>}
                                {missing > 0 && <span className="pill pill-bad">Not covered {eur(missing)}</span>}
                                {coveredCount > 0 && <span className="pill pill-ok">{coveredCount} already in cash</span>}
                                {afterPayments.length > 0 && (totalTopUp > 0
                                    ? <span className="pill pill-bad">Top up {eur(totalTopUp)} after paying</span>
                                    : <span className="pill pill-ok">Accounts in line after paying</span>)}
                            </div>
                            <ul className="cov-upcoming">
                                {upcoming.map(u => {
                                    const covered = u.toRecover === 0 && u.stillMissing === 0;
                                    return (
                                        <li key={u.categoryId}>
                                            <div className="cov-up-head">
                                                <strong>{u.name}</strong>
                                                <span className="cov-caption">{eur(u.target)} · {shortDate(u.date)} · {whenText(u.monthsLeft)}</span>
                                            </div>
                                            {covered ? (
                                                <span className="pill pill-ok">Covered by cash</span>
                                            ) : (
                                                <div className="cov-up-actions">
                                                    {u.toRecover > 0 && (
                                                        <span>
                                                            <span className="pill pill-warn">Sell {eur(u.toRecover)}</span>
                                                            {' '}from {u.allocations.map(a => allocationLabel(a)).join(', ') || 'its investments'} → {brokerName(u.brokerId)}
                                                        </span>
                                                    )}
                                                    {u.stillMissing > 0 && <span className="pill pill-bad">Not covered {eur(u.stillMissing)}</span>}
                                                    {u.cash > 0 && <span className="cov-caption">{eur(u.cash)} already in cash</span>}
                                                </div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                            {afterPayments.length > 0 && (
                                <div className="cov-after">
                                    <div className="cov-after-title">After these payments</div>
                                    {afterPayments.map(a => {
                                        const x = a.afterCapex!;
                                        return (
                                            <div key={a.brokerId} className="cov-after-row">
                                                <div>
                                                    <strong>{a.brokerName}</strong>
                                                    <div className="cov-caption">
                                                        {eur(a.liquidity)}{x.recover > 0 && <> + {eur(x.recover)} sold</>} − {eur(x.pay)} paid = <strong>{eur(x.liquidityAfter)}</strong>
                                                        {' '}· must hold {eur(x.needAfter)} (operating {eur(a.operatingCash)}
                                                        {a.emergencyHere > 0 && <> + fund {eur(a.emergencyHere)}</>}
                                                        {x.needAfter - a.operatingCash - a.emergencyHere > 0.5 && <> + set aside {eur(x.needAfter - a.operatingCash - a.emergencyHere)}</>})
                                                        {a.free < 0 && <> · already short {eur(-a.free)} before paying</>}
                                                    </div>
                                                </div>
                                                {x.topUp > 0
                                                    ? <span className="pill pill-bad">Top up {eur(x.topUp)}</span>
                                                    : <span className="pill pill-ok">In line · {eur(x.spare)} spare</span>}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </>
                    )}
                </section>
            </div>

            <style>{`
                .ynab-cov-card { background: var(--bg-card); border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.5rem; }
                .cov-head { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; }
                .cov-sub { font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.25rem; }
                .cov-settings { display: flex; gap: 0.75rem; flex-wrap: wrap; }
                .cov-settings label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.72rem; color: var(--text-muted); }
                .cov-settings input { width: 90px; padding: 0.3rem 0.45rem; }
                .cov-settings small { font-size: 0.68rem; }
                .cov-blocks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
                @media (max-width: 1000px) { .cov-blocks { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
                @media (max-width: 700px) { .cov-blocks { grid-template-columns: 1fr; } }
                .cov-block { background: var(--bg-app); border-radius: var(--radius-md); padding: 1rem; display: flex; flex-direction: column; gap: 0.4rem; }
                .cov-block-wide { grid-column: 1 / -1; }
                .cov-block h4 { margin: 0; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }
                .cov-big { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
                .cov-big.bad { color: var(--color-danger); }
                .cov-big.ok { color: var(--color-success, #10b981); }
                .cov-caption { font-size: 0.8rem; color: var(--text-muted); }
                .cov-list { margin: 0.4rem 0 0; display: flex; flex-direction: column; gap: 0.25rem; }
                .cov-list div { display: flex; justify-content: space-between; gap: 1rem; font-size: 0.85rem; }
                .cov-list dt { color: var(--text-secondary); }
                .cov-list dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
                .cov-list small { color: var(--text-muted); }
                .cov-bar { height: 8px; background: var(--bg-surface); border-radius: 999px; overflow: hidden; display: flex; margin-top: 0.3rem; }
                .cov-bar > div { height: 100%; background: var(--color-primary); }
                .cov-alert { font-size: 0.82rem; color: var(--color-warning, #f59e0b); }
                .cov-link { align-self: flex-start; background: none; border: none; color: var(--color-primary); cursor: pointer; font-size: 0.8rem; padding: 0; margin-top: 0.2rem; }
                .cov-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
                .cov-chip { display: inline-flex; align-items: center; gap: 0.3rem; background: var(--bg-card); border-radius: 999px; padding: 0.2rem 0.3rem 0.2rem 0.65rem; font-size: 0.82rem; }
                .cov-chip button { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 0.2rem; }
                .cov-add { width: auto; min-width: 150px; padding: 0.25rem 0.4rem; font-size: 0.82rem; }
                .cov-sources { display: flex; flex-direction: column; gap: 0.5rem; }
                .cov-aside { border-top: 1px solid var(--border-color); padding-top: 0.5rem; margin-top: 0.3rem; display: flex; flex-direction: column; gap: 0.3rem; }
                .cov-aside-head { display: flex; justify-content: space-between; font-size: 0.88rem; }
                .cov-aside-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; }
                .cov-aside-list li { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.82rem; color: var(--text-secondary); }
                .cov-aside-list small { color: var(--text-muted); }
                .cov-aside-check { font-size: 0.78rem; color: var(--text-muted); }
                .cov-aside-fund { font-size: 0.82rem; color: var(--text-secondary); }
                .cov-summary { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.2rem 0 0.4rem; }
                .cov-upcoming { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
                .cov-upcoming li { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap;
                    padding: 0.55rem 0; border-top: 1px solid var(--border-color); font-size: 0.88rem; }
                .cov-up-head { display: flex; flex-direction: column; gap: 0.1rem; }
                .cov-up-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem; text-align: right; }
                .cov-after { margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px dashed var(--border-color); display: flex; flex-direction: column; gap: 0.5rem; }
                .cov-after-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }
                .cov-after-row { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; font-size: 0.88rem; }
                .pill { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 0.15rem 0.55rem; border-radius: 999px; white-space: nowrap; }
                .pill-ok { background: color-mix(in srgb, var(--color-success, #10b981) 18%, transparent); color: var(--color-success, #10b981); }
                .pill-bad { background: color-mix(in srgb, var(--color-danger) 18%, transparent); color: var(--color-danger); }
                .pill-warn { background: color-mix(in srgb, var(--color-warning, #f59e0b) 20%, transparent); color: var(--color-warning, #f59e0b); }
            `}</style>
        </div>
    );
};

export default YnabCoveragePanel;
