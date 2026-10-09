import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import {
    buildTrackingPlan,
    TRACKING_PREFIX,
    type TrackingAccountRef,
    type TrackingDestination,
    type TrackingDestinationKind,
} from '../../utils/ynabTrackingPlan';

// The off-budget map: how the per-broker tracking accounts of the primary
// budget would be re-cut by purpose. Preview only — the page reads the account
// list from YNAB and never writes to it.

const KIND_TITLE: Record<TrackingDestinationKind, string> = {
    goal: 'Goals and categories covered by investments',
    portfolio: 'Portfolios (parent and children merged)',
    pension: 'Pension',
    'broker-cash': 'Broker cash kept off budget',
};

// YNAB's sidebar cuts long account names; past this the name is flagged.
const LONG_ACCOUNT_NAME = 24;

const stripPrefix = (name: string) =>
    name.replace(/^[\s\p{Extended_Pictographic}️‍]+/u, '').trim().toLowerCase();

interface AccountSelectProps {
    value?: string;
    accounts: TrackingAccountRef[];
    emptyLabel: string;
    onChange: (accountId: string | null) => void;
    format: (v: number) => string;
    ariaLabel: string;
}

const AccountSelect: React.FC<AccountSelectProps> = ({ value, accounts, emptyLabel, onChange, format, ariaLabel }) => (
    <select
        className="form-select ytv-select"
        value={value ?? ''}
        aria-label={ariaLabel}
        onChange={e => onChange(e.target.value || null)}
    >
        <option value="">{emptyLabel}</option>
        {value && !accounts.some(a => a.id === value) && <option value={value}>(account not found)</option>}
        {accounts.map(a => (
            <option key={a.id} value={a.id}>{a.name} · {format(a.balance)}</option>
        ))}
    </select>
);

const YnabTrackingView: React.FC<{ onNavigateToYnab?: () => void }> = ({ onNavigateToYnab }) => {
    const {
        ynabConfig,
        listYnabAccounts,
        portfolios,
        transactions,
        brokers,
        effectiveAssetSettings,
        marketData,
        ynabGoals,
        ynabGoalAllocations,
        virtualBonds,
        ynabAccountMappings,
        ynabTrackingConfig,
        setYnabTrackingBrokerSource,
        setYnabTrackingDestinationAccount,
        setYnabTrackingBrokerInclusion,
        people,
    } = usePortfolio();

    const currencyIso = ynabConfig?.currencyIso || 'EUR';
    const eur = useCallback((v: number) => new Intl.NumberFormat('en-IE', {
        style: 'currency', currency: currencyIso, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(v), [currencyIso]);
    const signed = (v: number) => `${v > 0 ? '+' : ''}${eur(v)}`;

    const [accounts, setAccounts] = useState<TrackingAccountRef[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loadedAt, setLoadedAt] = useState<string | null>(null);

    const loadAccounts = useCallback(async () => {
        setLoading(true);
        setError(null);
        const res = await listYnabAccounts();
        setLoading(false);
        if (!res.ok || !res.accounts) {
            setError(res.error || 'Unable to load YNAB accounts.');
            return;
        }
        setAccounts(res.accounts.map(a => ({
            id: a.id,
            name: a.name,
            onBudget: a.onBudget,
            balance: a.balanceMilliunits / 1000,
            clearedBalance: a.clearedBalanceMilliunits / 1000,
        })));
        setLoadedAt(new Date().toISOString());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ynabConfig?.apiKey, ynabConfig?.budgetId]);

    useEffect(() => {
        if (ynabConfig?.apiKey && ynabConfig?.budgetId) loadAccounts();
    }, [ynabConfig?.apiKey, ynabConfig?.budgetId, loadAccounts]);

    // Only liquidity links of the primary budget make a broker "type A" here:
    // the split happens inside that budget.
    const liquidityMappings = useMemo(() => Object.fromEntries(
        Object.entries(ynabAccountMappings).filter(([, m]) => m.budgetId === ynabConfig?.budgetId),
    ), [ynabAccountMappings, ynabConfig?.budgetId]);

    const plan = useMemo(() => buildTrackingPlan({
        portfolios,
        transactions,
        brokers,
        assetSettings: effectiveAssetSettings,
        marketData,
        goals: ynabGoals,
        allocations: ynabGoalAllocations,
        virtualBonds,
        liquidityMappings,
        config: ynabTrackingConfig,
        accounts: accounts ?? undefined,
    }), [portfolios, transactions, brokers, effectiveAssetSettings, marketData, ynabGoals, ynabGoalAllocations,
        virtualBonds, liquidityMappings, ynabTrackingConfig, accounts]);

    const offBudget = useMemo(() => (accounts ?? []).filter(a => !a.onBudget)
        .sort((a, b) => a.name.localeCompare(b.name)), [accounts]);
    const accountName = (id?: string) => (id && accounts?.find(a => a.id === id)?.name) || null;
    const destinationByKey = useMemo(() => new Map(plan.destinations.map(d => [d.key, d])), [plan.destinations]);
    const brokerById = useMemo(() => new Map(plan.brokers.map(b => [b.brokerId, b])), [plan.brokers]);
    const personName = (id?: string) => (id && people.find(p => p.id === id)?.name) || null;

    // An existing account worth proposing for a destination: the broker's own
    // account for its cash or a pension fund, or one already named like it.
    const suggestionFor = (d: TrackingDestination): TrackingAccountRef | null => {
        if (d.accountId || offBudget.length === 0) return null;
        if (d.kind === 'broker-cash' && d.brokerId) {
            const src = ynabTrackingConfig.brokerSources[d.brokerId];
            return offBudget.find(a => a.id === src) ?? null;
        }
        if (d.kind === 'pension') {
            const brokerIds = [...new Set(d.pieces.map(p => p.brokerId))];
            const src = brokerIds.length === 1 ? ynabTrackingConfig.brokerSources[brokerIds[0]] : undefined;
            const own = offBudget.find(a => a.id === src);
            if (own) return own;
        }
        const target = d.baseName.trim().toLowerCase();
        return offBudget.find(a => stripPrefix(a.name) === target) ?? null;
    };

    const linkedCount = plan.destinations.filter(d => d.accountId).length;
    const toCreate = plan.destinations.length - linkedCount;

    if (!ynabConfig) {
        return (
            <div className="ytv-empty">
                <h2>YNAB not configured</h2>
                <p>Connect YNAB first: the off-budget map reads the accounts of your primary budget.</p>
                {onNavigateToYnab && <button className="btn btn-primary" onClick={onNavigateToYnab}>Go to YNAB</button>}
            </div>
        );
    }

    const groupedDestinations = (['goal', 'portfolio', 'pension', 'broker-cash'] as TrackingDestinationKind[])
        .map(kind => ({ kind, items: plan.destinations.filter(d => d.kind === kind) }))
        .filter(g => g.items.length > 0);

    return (
        <div className="ytv-page">
            <header className="ytv-header">
                <div>
                    <h2 className="ytv-title">YNAB Off-budget</h2>
                    <div className="ytv-subtitle">
                        From one tracking account per broker to one per purpose.
                        <span className="ytv-readonly">Preview only — nothing is written to YNAB</span>
                    </div>
                </div>
                <div className="ytv-load">
                    <button type="button" className="btn" onClick={loadAccounts} disabled={loading}>
                        {loading ? 'Loading…' : accounts ? 'Reload YNAB accounts' : 'Load YNAB accounts'}
                    </button>
                    {loadedAt && <span className="ytv-muted">{ynabConfig.budgetName || 'Primary budget'} · {new Date(loadedAt).toLocaleTimeString('en-IE')}</span>}
                </div>
            </header>

            {error && <div className="ytv-alert ytv-alert-error">{error}</div>}

            <div className="ytv-totals">
                <div className="ytv-total">
                    <span className="ytv-total-label">Invested</span>
                    <span className="ytv-total-value">{eur(plan.totals.securities)}</span>
                </div>
                <div className="ytv-total">
                    <span className="ytv-total-label">Broker cash off budget</span>
                    <span className="ytv-total-value">{eur(plan.totals.cash)}</span>
                </div>
                <div className="ytv-total">
                    <span className="ytv-total-label">Accounts by purpose</span>
                    <span className="ytv-total-value">{plan.destinations.length}<small> · {linkedCount} linked, {toCreate} to create</small></span>
                </div>
                <div className={`ytv-total ${plan.balanced ? 'ytv-ok' : 'ytv-bad'}`}>
                    <span className="ytv-total-label">Check</span>
                    <span className="ytv-total-value">{plan.balanced ? '✓ Balanced' : '✗ Not balanced'}</span>
                </div>
            </div>

            {plan.warnings.length > 0 && (
                <details className="ytv-warnings" open={plan.warnings.length <= 3}>
                    <summary>⚠ {plan.warnings.length} thing{plan.warnings.length === 1 ? '' : 's'} to check</summary>
                    <ul>{plan.warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
                </details>
            )}

            {/* ── 1. Brokers ─────────────────────────────────────── */}
            <section className="ytv-section">
                <h3 className="ytv-section-title">1 · Brokers and their account today</h3>
                <p className="ytv-hint">
                    <strong>A</strong>: its cash is an on-budget account (the one linked for the liquidity sync), so its off-budget account holds securities only.{' '}
                    <strong>B</strong>: no on-budget account — cash and securities sit together off budget; the cash stays there.
                </p>
                <div className="ytv-list">
                    <div className="ytv-row ytv-row-broker ytv-head" aria-hidden>
                        <span>Broker</span><span>Included</span><span className="ytv-num">Expected</span><span>YNAB account today</span><span className="ytv-num">To realign</span>
                    </div>
                    {plan.brokers.map(b => (
                        <div key={b.brokerId || 'none'} className={`ytv-row ytv-row-broker${b.included ? '' : ' ytv-row-off'}`}>
                            <div className="ytv-cell ytv-name">
                                <span className="ytv-name-text">{b.name}</span>
                                <span className="ytv-tags">
                                    <span className={`ytv-tag ytv-tag-${b.kind}`} title={b.kind === 'A' ? 'Cash on budget' : 'Cash off budget'}>{b.kind}</span>
                                    {b.illiquid && <span className="ytv-tag">illiquid</span>}
                                    {b.excludedBy === 'family' && <span className="ytv-tag">family</span>}
                                    {personName(b.ownerId) && <span className="ytv-tag">{personName(b.ownerId)}</span>}
                                </span>
                            </div>
                            <div className="ytv-cell">
                                <label className="ytv-check">
                                    <input
                                        type="checkbox"
                                        checked={b.included}
                                        disabled={!b.brokerId}
                                        onChange={e => setYnabTrackingBrokerInclusion(b.brokerId, e.target.checked)}
                                    />
                                    <span>{b.included ? 'In the split' : b.excludedBy === 'family' ? 'Out (family)' : 'Out'}</span>
                                </label>
                            </div>
                            <div className="ytv-cell ytv-num">
                                <span className="ytv-mlabel">Expected</span>
                                <span className="ytv-strong">{eur(b.expected)}</span>
                                {b.cash > 0 && <span className="ytv-muted ytv-small">{eur(b.securities)} securities + {eur(b.cash)} cash</span>}
                            </div>
                            <div className="ytv-cell">
                                <span className="ytv-mlabel">YNAB account today</span>
                                {b.brokerId ? (
                                    <AccountSelect
                                        value={b.sourceAccountId}
                                        accounts={offBudget}
                                        emptyLabel={accounts ? '— not in YNAB —' : '— load accounts —'}
                                        onChange={id => setYnabTrackingBrokerSource(b.brokerId, id)}
                                        format={eur}
                                        ariaLabel={`YNAB account of ${b.name}`}
                                    />
                                ) : <span className="ytv-muted">—</span>}
                            </div>
                            <div className="ytv-cell ytv-num">
                                <span className="ytv-mlabel">To realign</span>
                                {b.realignment === undefined
                                    ? <span className="ytv-muted">—</span>
                                    : Math.abs(b.realignment) < 0.01
                                        ? <span className="ytv-good">✓ aligned</span>
                                        : <span className={b.realignment > 0 ? 'ytv-up' : 'ytv-down'} title="Tool value minus the YNAB balance">{signed(b.realignment)}</span>}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── 2. Destinations ────────────────────────────────── */}
            <section className="ytv-section">
                <h3 className="ytv-section-title">2 · Accounts by purpose</h3>
                <p className="ytv-hint">
                    Expected balance of each account: a goal's share of the holdings, what is left of each portfolio, the pension fund and the cash that stays at a type-B broker.
                    Latent tax is the capital-gains tax on today's gain — it would be the uncleared part of the account.
                </p>
                {groupedDestinations.length === 0 && <div className="ytv-muted">No holdings to split yet.</div>}
                {groupedDestinations.map(group => (
                    <div key={group.kind} className="ytv-group">
                        <h4 className="ytv-group-title">{TRACKING_PREFIX[group.kind]} {KIND_TITLE[group.kind]}</h4>
                        <div className="ytv-list">
                            <div className="ytv-row ytv-row-dest ytv-head" aria-hidden>
                                <span>Account</span><span className="ytv-num">Expected</span><span className="ytv-num">Latent tax</span><span>YNAB account</span><span className="ytv-num">Difference</span>
                            </div>
                            {group.items.map(d => {
                                const suggestion = suggestionFor(d);
                                return (
                                    <div key={d.key} className="ytv-row ytv-row-dest">
                                        <div className="ytv-cell ytv-name">
                                            <span className="ytv-name-text" title={d.accountName}>{d.accountName}</span>
                                            <span className="ytv-muted ytv-small">
                                                {d.memberNames && d.memberNames.length > 1 && <>{d.memberNames.join(' + ')} · </>}
                                                {d.pieces.length > 0 && `${d.pieces.length} position${d.pieces.length === 1 ? '' : 's'}`}
                                                {[...d.accountName].length > LONG_ACCOUNT_NAME && <span className="ytv-warn-inline" title="YNAB may cut this name in the sidebar"> · long name</span>}
                                            </span>
                                        </div>
                                        <div className="ytv-cell ytv-num">
                                            <span className="ytv-mlabel">Expected</span>
                                            <span className="ytv-strong">{eur(d.value)}</span>
                                        </div>
                                        <div className="ytv-cell ytv-num">
                                            <span className="ytv-mlabel">Latent tax</span>
                                            {d.latentTax > 0
                                                ? <span title={`Net ${eur(d.net)}`}>−{eur(d.latentTax)}</span>
                                                : <span className="ytv-muted">—</span>}
                                        </div>
                                        <div className="ytv-cell">
                                            <span className="ytv-mlabel">YNAB account</span>
                                            <AccountSelect
                                                value={d.accountId}
                                                accounts={offBudget}
                                                emptyLabel={accounts ? '＋ to create' : '— load accounts —'}
                                                onChange={id => setYnabTrackingDestinationAccount(d.key, id)}
                                                format={eur}
                                                ariaLabel={`YNAB account for ${d.accountName}`}
                                            />
                                            {suggestion && (
                                                <button
                                                    type="button"
                                                    className="ytv-suggest"
                                                    onClick={() => setYnabTrackingDestinationAccount(d.key, suggestion.id)}
                                                >Use “{suggestion.name}”</button>
                                            )}
                                        </div>
                                        <div className="ytv-cell ytv-num">
                                            <span className="ytv-mlabel">Difference</span>
                                            {d.accountDifference === undefined
                                                ? <span className="ytv-muted">—</span>
                                                : Math.abs(d.accountDifference) < 0.01
                                                    ? <span className="ytv-good">✓</span>
                                                    : <span className={d.accountDifference > 0 ? 'ytv-up' : 'ytv-down'} title={d.sharesSourceAccount ? 'Expected minus the balance this account keeps once the securities have moved out' : 'Expected minus the YNAB balance'}>{signed(d.accountDifference)}</span>}
                                            {d.sharesSourceAccount && <span className="ytv-muted ytv-small">after the split</span>}
                                        </div>
                                        {d.pieces.length > 0 && (
                                            <details className="ytv-pieces">
                                                <summary>Positions</summary>
                                                <ul>
                                                    {d.pieces.map(p => (
                                                        <li key={p.holdingKey}>
                                                            <span>{p.label} <span className="ytv-muted">· {brokerById.get(p.brokerId)?.name ?? p.brokerId}</span></span>
                                                            <span className="ytv-num">{p.quantity.toLocaleString('en-IE', { maximumFractionDigits: 4 })} units · {eur(p.value)}</span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </details>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </section>

            {/* ── 3. Migration preview ───────────────────────────── */}
            <section className="ytv-section">
                <h3 className="ytv-section-title">3 · Migration preview</h3>
                <p className="ytv-hint">
                    The transfers that would empty each broker account into the accounts above. Tracking-to-tracking transfers: no category, no effect on Ready to Assign.
                    A difference with YNAB is realigned first, so the split starts from the right figures.
                </p>
                {plan.migrations.length === 0 && <div className="ytv-muted">Nothing to migrate.</div>}
                <div className="ytv-migrations">
                    {plan.migrations.map(m => {
                        const b = brokerById.get(m.brokerId);
                        const source = accountName(m.sourceAccountId);
                        return (
                            <div key={m.brokerId || 'none'} className="ytv-migration">
                                <div className="ytv-migration-head">
                                    <span className="ytv-strong">{b?.name}</span>
                                    <span className="ytv-muted">from {source ? `“${source}”` : 'an account not linked yet'}</span>
                                </div>
                                {b?.realignment !== undefined && Math.abs(b.realignment) >= 0.01 && (
                                    <div className="ytv-transfer ytv-transfer-realign">
                                        <span>Realign the balance first</span>
                                        <span className={b.realignment > 0 ? 'ytv-up' : 'ytv-down'}>{signed(b.realignment)}</span>
                                    </div>
                                )}
                                {m.transfers.map(t => {
                                    const d = destinationByKey.get(t.toKey);
                                    const linked = accountName(ynabTrackingConfig.destinationAccounts[t.toKey]);
                                    return (
                                        <div key={t.toKey} className={`ytv-transfer${t.staysInPlace ? ' ytv-transfer-stay' : ''}`}>
                                            <span>
                                                {t.staysInPlace ? '↺ stays in' : '→'} {d?.accountName ?? t.toKey}
                                                {!t.staysInPlace && !linked && <span className="ytv-muted ytv-small"> (to create)</span>}
                                            </span>
                                            <span className="ytv-num">{eur(t.amount)}</span>
                                        </div>
                                    );
                                })}
                                <div className="ytv-transfer ytv-transfer-total">
                                    <span>Total</span>
                                    <span className="ytv-num">{eur(m.total)}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>

            <style>{`
                .ytv-page { display: flex; flex-direction: column; gap: var(--space-6); }
                .ytv-empty { max-width: 720px; margin: 2rem auto; padding: 2rem; background: var(--bg-card); border-radius: var(--radius-lg); text-align: center; }
                .ytv-header { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
                .ytv-title { margin: 0 0 var(--space-2); font-size: 1.5rem; letter-spacing: -0.01em; }
                .ytv-subtitle { font-size: 0.85rem; color: var(--text-secondary); display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
                .ytv-readonly {
                    font-size: 0.72rem; font-weight: 600; color: var(--color-success);
                    background: rgba(16, 185, 129, 0.12); border-radius: 999px; padding: 0.15rem 0.6rem;
                }
                .ytv-load { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
                .ytv-muted { color: var(--text-muted); }
                .ytv-small { font-size: 0.75rem; }
                .ytv-strong { font-weight: 600; color: var(--text-primary); }
                .ytv-good { color: var(--color-success); }
                .ytv-up { color: var(--color-success); font-variant-numeric: tabular-nums; }
                .ytv-down { color: var(--color-warning); font-variant-numeric: tabular-nums; }
                .ytv-warn-inline { color: var(--color-warning); }
                .ytv-alert { padding: var(--space-3); border-radius: var(--radius-md); font-size: 0.85rem; }
                .ytv-alert-error { background: rgba(239, 68, 68, 0.12); color: var(--color-danger); }

                .ytv-totals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
                .ytv-total { background: var(--bg-card); border-radius: var(--radius-lg); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
                .ytv-total-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); font-weight: 500; }
                .ytv-total-value { font-size: 1.1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
                .ytv-total-value small { font-size: 0.75rem; font-weight: 500; color: var(--text-muted); }
                .ytv-ok .ytv-total-value { color: var(--color-success); }
                .ytv-bad .ytv-total-value { color: var(--color-danger); }

                .ytv-warnings { background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); font-size: 0.85rem; }
                .ytv-warnings summary { cursor: pointer; color: var(--color-warning); font-weight: 600; }
                .ytv-warnings ul { margin: var(--space-2) 0 0; padding-left: 1.2rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: var(--space-1); }

                .ytv-section { display: flex; flex-direction: column; gap: var(--space-3); }
                .ytv-section-title { margin: 0; font-size: 1.05rem; }
                .ytv-hint { margin: 0; font-size: 0.8rem; color: var(--text-muted); line-height: 1.45; max-width: 70rem; }
                .ytv-group { display: flex; flex-direction: column; gap: var(--space-2); }
                .ytv-group-title { margin: var(--space-2) 0 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }

                .ytv-list { background: var(--bg-card); border-radius: var(--radius-lg); overflow: hidden; }
                .ytv-row { display: grid; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--bg-surface); }
                .ytv-row:last-child { border-bottom: none; }
                .ytv-row-broker { grid-template-columns: minmax(160px, 1.6fr) minmax(120px, 1fr) minmax(130px, 1fr) minmax(200px, 1.6fr) minmax(110px, 0.9fr); }
                .ytv-row-dest { grid-template-columns: minmax(180px, 1.8fr) minmax(110px, 0.9fr) minmax(100px, 0.8fr) minmax(200px, 1.6fr) minmax(100px, 0.8fr); }
                .ytv-head { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); font-weight: 600; }
                .ytv-row-off { opacity: 0.55; }
                .ytv-cell { min-width: 0; font-size: 0.86rem; display: flex; flex-direction: column; gap: 0.2rem; }
                .ytv-num { text-align: right; font-variant-numeric: tabular-nums; }
                .ytv-cell.ytv-num { align-items: flex-end; }
                .ytv-mlabel { display: none; }
                .ytv-name-text { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .ytv-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
                .ytv-tag { font-size: 0.68rem; font-weight: 600; padding: 0.1rem 0.45rem; border-radius: 999px; background: var(--bg-surface); color: var(--text-secondary); }
                .ytv-tag-A { background: rgba(59, 130, 246, 0.18); color: #93c5fd; }
                .ytv-tag-B { background: rgba(168, 85, 247, 0.18); color: #d8b4fe; }
                .ytv-check { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; cursor: pointer; }
                .ytv-select { width: 100%; min-width: 0; font-size: 0.82rem; padding: 0.35rem 0.5rem; }
                .ytv-suggest {
                    align-self: flex-start; background: transparent; border: 1px dashed rgba(148, 163, 184, 0.4);
                    color: var(--text-secondary); border-radius: var(--radius-sm); padding: 0.2rem 0.5rem;
                    font-size: 0.74rem; cursor: pointer;
                }
                .ytv-suggest:hover { border-color: var(--color-primary); color: var(--text-primary); }

                .ytv-pieces { grid-column: 1 / -1; font-size: 0.8rem; }
                .ytv-pieces summary { cursor: pointer; color: var(--text-muted); }
                .ytv-pieces ul { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
                .ytv-pieces li { display: flex; justify-content: space-between; gap: var(--space-3); padding: 0.25rem 0.5rem; background: var(--bg-surface); border-radius: var(--radius-sm); }

                .ytv-migrations { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr)); gap: var(--space-3); }
                .ytv-migration { background: var(--bg-card); border-radius: var(--radius-lg); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2); }
                .ytv-migration-head { display: flex; flex-direction: column; gap: 0.15rem; margin-bottom: var(--space-1); font-size: 0.9rem; }
                .ytv-transfer { display: flex; justify-content: space-between; gap: var(--space-3); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
                .ytv-transfer > span:first-child { min-width: 0; overflow-wrap: anywhere; }
                .ytv-transfer-stay { color: var(--text-muted); }
                .ytv-transfer-realign { padding-bottom: var(--space-2); border-bottom: 1px dashed var(--bg-surface); }
                .ytv-transfer-total { padding-top: var(--space-2); border-top: 1px solid var(--bg-surface); font-weight: 600; }

                @media (max-width: 900px) {
                    .ytv-totals { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
                    .ytv-head { display: none; }
                    .ytv-row { gap: var(--space-2) var(--space-3); padding: var(--space-3); }
                    .ytv-row-broker {
                        grid-template-columns: 1fr 1fr;
                        grid-template-areas: "name inc" "exp real" "acc acc";
                    }
                    .ytv-row-broker > :nth-child(1) { grid-area: name; }
                    .ytv-row-broker > :nth-child(2) { grid-area: inc; align-items: flex-end; }
                    .ytv-row-broker > :nth-child(3) { grid-area: exp; }
                    .ytv-row-broker > :nth-child(4) { grid-area: acc; }
                    .ytv-row-broker > :nth-child(5) { grid-area: real; }
                    .ytv-row-dest {
                        grid-template-columns: 1fr 1fr 1fr;
                        grid-template-areas: "name name name" "exp tax diff" "acc acc acc" "pcs pcs pcs";
                    }
                    .ytv-row-dest > :nth-child(1) { grid-area: name; }
                    .ytv-row-dest > :nth-child(2) { grid-area: exp; }
                    .ytv-row-dest > :nth-child(3) { grid-area: tax; }
                    .ytv-row-dest > :nth-child(4) { grid-area: acc; }
                    .ytv-row-dest > :nth-child(5) { grid-area: diff; }
                    .ytv-row-dest > :nth-child(6) { grid-area: pcs; }
                    .ytv-cell.ytv-num { align-items: flex-start; text-align: left; }
                    .ytv-mlabel { display: block; font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
                    .ytv-name-text { white-space: normal; overflow-wrap: anywhere; }
                    .ytv-select { min-height: 44px; }
                    .ytv-check input { width: 20px; height: 20px; }
                }
            `}</style>
        </div>
    );
};

export default YnabTrackingView;
