import React, { useCallback, useEffect, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabBudgetRef } from '../../types';
import type { YnabAccountSummary } from '../../services/ynabApi';
import { milliunitsToEur } from '../../services/ynabApi';

// The write guard: ONE budget, and the off-budget accounts of it, that the
// off-budget map may link and any write-back may ever touch. Everything else
// stays read-only for the tool. On-budget accounts are never offered.
const YnabWriteGuardCard: React.FC<{ budgets: YnabBudgetRef[] }> = ({ budgets }) => {
    const { ynabConfig, listYnabAccounts, ynabTrackingConfig, setYnabWriteGuardBudget, setYnabWriteGuardAccounts } = usePortfolio();
    const guardBudgetId = ynabTrackingConfig.guardBudgetId ?? '';
    const allowed = ynabTrackingConfig.guardAccountIds ?? [];

    const [accounts, setAccounts] = useState<YnabAccountSummary[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (budgetId: string) => {
        setAccounts(null);
        setError(null);
        if (!budgetId) return;
        setLoading(true);
        const res = await listYnabAccounts(budgetId);
        setLoading(false);
        if (res.ok && res.accounts) setAccounts(res.accounts);
        else setError(res.error || 'Unable to load YNAB accounts.');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ynabConfig?.apiKey]);

    useEffect(() => { void load(guardBudgetId); }, [guardBudgetId, load]);

    const offBudget = (accounts ?? []).filter(a => !a.onBudget).sort((a, b) => a.name.localeCompare(b.name));
    const missing = accounts ? allowed.filter(id => !offBudget.some(a => a.id === id)) : [];
    const formatBalance = (milliunits: number) => new Intl.NumberFormat('en-IE', {
        style: 'currency', currency: ynabConfig?.currencyIso || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(milliunitsToEur(milliunits));
    const budgetName = (id: string) => budgets.find(b => b.id === id)?.name ?? id;
    const toggle = (id: string, on: boolean) =>
        setYnabWriteGuardAccounts(on ? [...allowed, id] : allowed.filter(x => x !== id));

    return (
        <div className="ywg" style={{ paddingTop: '0.75rem', borderTop: '1px solid var(--border-color)' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 600 }}>🛡 YNAB write guard</label>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0.25rem 0 0.75rem 0' }}>
                The only budget, and the only off-budget (tracking) accounts of it, that the YNAB Off-budget page may link
                and that any write-back may ever touch. Every other budget and account — on-budget accounts, a house, a car,
                a loan — stays read-only for the tool. Nothing chosen means nothing is allowed.
            </p>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                    className="form-select"
                    aria-label="Budget allowed for write-back"
                    value={guardBudgetId}
                    onChange={e => setYnabWriteGuardBudget(e.target.value || null)}
                    style={{ flex: 1, minWidth: '220px', maxWidth: '420px' }}
                >
                    <option value="">— No budget allowed —</option>
                    {budgets.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    {guardBudgetId && !budgets.some(b => b.id === guardBudgetId) && (
                        <option value={guardBudgetId}>{guardBudgetId} (unknown budget)</option>
                    )}
                </select>
                {guardBudgetId && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{allowed.length} account{allowed.length === 1 ? '' : 's'} allowed</span>}
            </div>

            {guardBudgetId && ynabConfig && guardBudgetId !== ynabConfig.budgetId && (
                <div className="ywg-warn">
                    ⚠ This is not the active budget ({budgetName(ynabConfig.budgetId)}). The off-budget map works on the active
                    budget, so it stays locked until the two match.
                </div>
            )}

            {guardBudgetId && (
                <div style={{ marginTop: '0.75rem' }}>
                    {loading && <div className="ywg-muted">Loading accounts…</div>}
                    {error && <div style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{error}</div>}
                    {accounts && offBudget.length === 0 && <div className="ywg-muted">This budget has no open off-budget accounts.</div>}
                    {offBudget.length > 0 && (
                        <>
                            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.5rem', fontSize: '0.8rem' }}>
                                <button type="button" className="ywg-link" onClick={() => setYnabWriteGuardAccounts(offBudget.map(a => a.id))}>Allow all</button>
                                <button type="button" className="ywg-link" onClick={() => setYnabWriteGuardAccounts([])}>Allow none</button>
                            </div>
                            <div className="ywg-list">
                                {offBudget.map(a => {
                                    const on = allowed.includes(a.id);
                                    return (
                                        <label key={a.id} className={`ywg-item${on ? ' ywg-item-on' : ''}`}>
                                            <input type="checkbox" checked={on} onChange={e => toggle(a.id, e.target.checked)} />
                                            <span className="ywg-name">{a.name}</span>
                                            <span className="ywg-bal">{formatBalance(a.balanceMilliunits)}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </>
                    )}
                    {missing.length > 0 && (
                        <div className="ywg-warn">
                            {missing.length} allowed account{missing.length === 1 ? ' is' : 's are'} no longer open in this budget.{' '}
                            <button type="button" className="ywg-link" onClick={() => setYnabWriteGuardAccounts(allowed.filter(id => !missing.includes(id)))}>Remove</button>
                        </div>
                    )}
                </div>
            )}

            <style>{`
                .ywg-muted { color: var(--text-muted); font-size: 0.8rem; }
                .ywg-warn {
                    margin-top: 0.5rem; font-size: 0.8rem; color: var(--color-warning);
                    background: rgba(245, 158, 11, 0.1); border-radius: var(--radius-sm); padding: 0.45rem 0.6rem;
                }
                .ywg-link { background: none; border: none; padding: 0; color: var(--color-primary); cursor: pointer; font-size: inherit; text-decoration: underline; }
                .ywg-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 0.4rem; }
                .ywg-item {
                    display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.65rem;
                    background: var(--bg-surface); border: 1px solid transparent; border-radius: var(--radius-md);
                    cursor: pointer; font-size: 0.85rem; min-height: 44px;
                }
                .ywg-item-on { border-color: rgba(16, 185, 129, 0.45); }
                .ywg-item input { width: 18px; height: 18px; flex-shrink: 0; }
                .ywg-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
                .ywg-bal { color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 0.8rem; }
            `}</style>
        </div>
    );
};

export default YnabWriteGuardCard;
