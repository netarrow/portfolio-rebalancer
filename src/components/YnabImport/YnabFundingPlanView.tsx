import React, { useMemo, useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildYnabFundingPlan, isRegisterableOrder } from '../../utils/ynabFundingPlan';
import type { FundingOrderWarning } from '../../utils/ynabFundingPlan';
import { formatMonthKey } from '../../utils/freeCommissions';

/**
 * The two answers the mapped categories are for: **how much to wire to each
 * broker** and **which orders to place** once the money is there — commissions
 * included, free-buy months and commission-free plans priced as free.
 */

const eur = (value: number, digits = 2) =>
    value.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits });

const units = (value: number) =>
    value.toLocaleString('en-IE', { maximumFractionDigits: 6 });

const WARNING_LABELS: Record<FundingOrderWarning, string> = {
    'no-price': 'No known price — run Update Price, or the order cannot be sized.',
    'no-broker': 'No broker: pick one on the mapping, or the commission is unknown.',
    'no-portfolio': 'No portfolio: pick one on the mapping to be able to register the buy.',
    'budget-too-small': 'Not enough money for one unit (or one bond lot) yet.',
    'high-fee': 'The commission is a large slice of the trade — consider letting it grow.',
    'no-commission-plan': 'This broker has no commission plan configured, so it is priced as free.',
    'already-registered': 'This exact order was already registered today — register it again only if you really bought twice.',
};

const WARNING_SHORT: Record<FundingOrderWarning, string> = {
    'no-price': 'no price',
    'no-broker': 'no broker',
    'no-portfolio': 'no portfolio',
    'budget-too-small': 'too small',
    'high-fee': 'costly fee',
    'no-commission-plan': 'no fee plan',
    'already-registered': 'done today',
};

const ROUNDING_STEPS = [0, 1, 10, 50, 100];

const YnabFundingPlanView: React.FC = () => {
    const {
        ynabCategories, ynabMappings, ynabFundingSettings, setYnabFundingSettings,
        registerYnabFundingOrders, brokers, portfolios, assetSettings, transactions,
        marketData, freeCommissionPeriods,
    } = usePortfolio();

    const [expanded, setExpanded] = useState<string | null>(null);
    const [creditTransfers, setCreditTransfers] = useState(true);

    const plan = useMemo(() => buildYnabFundingPlan({
        categories: ynabCategories,
        mappings: ynabMappings,
        brokers,
        portfolios,
        assetSettings,
        prices: marketData,
        transactions,
        freeCommissionPeriods,
        settings: ynabFundingSettings,
    }), [ynabCategories, ynabMappings, brokers, portfolios, assetSettings, marketData, transactions, freeCommissionPeriods, ynabFundingSettings]);

    const { orders, deposits, transfers, ignored, totals } = plan;
    const registerable = orders.filter(isRegisterableOrder);
    const repeated = registerable.filter(o => o.warnings.includes('already-registered')).length;

    const handleRegister = async () => {
        const confirm = await Swal.fire({
            title: 'Register these purchases?',
            html: `${registerable.length} buy transaction(s) will be created for ${eur(registerable.reduce((s, o) => s + o.gross, 0))}`
                + `${creditTransfers && totals.transfer > 0 ? `, and ${eur(totals.transfer)} credited to the brokers as the wire arriving.` : '.'}`
                + `${orders.length > registerable.length ? `<br/><br/>${orders.length - registerable.length} order(s) are not ready and will be left out.` : ''}`
                + `${repeated > 0 ? `<br/><br/><strong>${repeated} of them were already registered today</strong> — register again only if you really bought twice.` : ''}`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Register',
        });
        if (!confirm.isConfirmed) return;

        const result = registerYnabFundingOrders(orders, {
            creditTransfers: creditTransfers ? transfers : undefined,
        });
        if (!result.ok) {
            Swal.fire({ title: 'Nothing registered', text: result.error, icon: 'error' });
            return;
        }
        Swal.fire({
            title: 'Purchases registered',
            html: `${result.registered} transaction(s) created${result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.`
                + '<br/><br/>The YNAB side is yours to record: move the money out of those categories in YNAB too.',
            icon: 'success',
        });
    };

    const patch = (values: Partial<typeof ynabFundingSettings>) =>
        setYnabFundingSettings(prev => ({ ...prev, ...values }));

    if (orders.length === 0 && deposits.length === 0) {
        return (
            <div className="ynab-plan-card">
                <h3 style={{ margin: 0 }}>Funding plan</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 0 }}>
                    Map a category to an asset above and this becomes the wire to send and the orders to place.
                    {ignored.length > 0 && ' Every mapped category is currently empty.'}
                </p>
                <style>{cardStyle}</style>
            </div>
        );
    }

    return (
        <div className="ynab-plan-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div>
                    <h3 style={{ margin: 0 }}>Funding plan</h3>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                        {eur(totals.budget, 0)} mapped · commissions priced for {formatMonthKey(plan.monthKey)}
                        {totals.feesSaved > 0 && <> · {eur(totals.feesSaved)} waived by free plans</>}
                    </div>
                </div>
                {registerable.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                            <input type="checkbox" checked={creditTransfers} onChange={e => setCreditTransfers(e.target.checked)} />
                            Also credit the wires
                        </label>
                        <button type="button" className="btn btn-primary" onClick={handleRegister}>
                            Register {registerable.length} purchase{registerable.length === 1 ? '' : 's'}
                        </button>
                    </div>
                )}
            </div>

            {/* ── Headline: the figure to wire ─────────────────────────── */}
            <div className="plan-headline">
                <div className="plan-figure">
                    <span className="plan-figure-label">To wire to the brokers</span>
                    <strong>{eur(totals.transfer)}</strong>
                    {totals.transferCost > 0 && (
                        <span className="plan-figure-note" title="Bank fees on the wires, charged on the sending side — not added to the amounts above.">
                            + {eur(totals.transferCost)} of bank fees
                        </span>
                    )}
                </div>
                <div className="plan-figure">
                    <span className="plan-figure-label">Purchases</span>
                    <strong>{eur(totals.gross)}</strong>
                    <span className="plan-figure-note">{totals.orders} order{totals.orders === 1 ? '' : 's'}</span>
                </div>
                <div className="plan-figure">
                    <span className="plan-figure-label">Commissions</span>
                    <strong>{eur(totals.commission)}</strong>
                    <span className="plan-figure-note">
                        {totals.gross > 0 ? `${((totals.commission / totals.gross) * 100).toFixed(2)}% of the trades` : '—'}
                    </span>
                </div>
                {totals.deposits > 0 && (
                    <div className="plan-figure">
                        <span className="plan-figure-label">Kept as cash</span>
                        <strong>{eur(totals.deposits)}</strong>
                    </div>
                )}
                <div className="plan-figure">
                    <span className="plan-figure-label">Left uninvested</span>
                    <strong>{eur(totals.leftover)}</strong>
                    <span className="plan-figure-note">rounding residue</span>
                </div>
            </div>

            {/* ── Options ──────────────────────────────────────────────── */}
            <div className="plan-options">
                <label>
                    Fund from
                    <select
                        className="form-select"
                        value={ynabFundingSettings.source}
                        onChange={e => patch({ source: e.target.value as 'balance' | 'budgeted' })}
                    >
                        <option value="balance">Category available</option>
                        <option value="budgeted">Budgeted this month</option>
                    </select>
                </label>
                <label>
                    Order size
                    <select
                        className="form-select"
                        value={ynabFundingSettings.rounding}
                        onChange={e => patch({ rounding: e.target.value as 'lot' | 'fractional' })}
                    >
                        <option value="lot">Whole units / bond lots</option>
                        <option value="fractional">Fractional shares</option>
                    </select>
                </label>
                <label>
                    Round wires to
                    <select
                        className="form-select"
                        value={ynabFundingSettings.transferRoundingStep}
                        onChange={e => patch({ transferRoundingStep: Number(e.target.value) })}
                    >
                        {ROUNDING_STEPS.map(step => (
                            <option key={step} value={step}>{step === 0 ? 'the cent' : `€${step}`}</option>
                        ))}
                    </select>
                </label>
                <label>
                    Flag fees over
                    <select
                        className="form-select"
                        value={ynabFundingSettings.feeWarnPercent}
                        onChange={e => patch({ feeWarnPercent: Number(e.target.value) })}
                    >
                        {[0.25, 0.5, 1, 2, 5].map(pct => <option key={pct} value={pct}>{pct}%</option>)}
                    </select>
                </label>
                <label className="plan-check">
                    <input
                        type="checkbox"
                        checked={ynabFundingSettings.feesFromBudget}
                        onChange={e => patch({ feesFromBudget: e.target.checked })}
                    />
                    Fees paid out of the category
                </label>
                <label className="plan-check">
                    <input
                        type="checkbox"
                        checked={ynabFundingSettings.useBrokerCash}
                        onChange={e => patch({ useBrokerCash: e.target.checked })}
                    />
                    Use the cash already at the broker
                </label>
            </div>

            {/* ── Wires ────────────────────────────────────────────────── */}
            <h4 className="plan-section-title">Transfers to make</h4>
            <div className="plan-table-wrap">
                <table className="plan-table">
                    <thead>
                        <tr>
                            <th>Broker</th>
                            <th style={{ textAlign: 'right' }}>Orders</th>
                            <th style={{ textAlign: 'right' }}>Cash top-up</th>
                            <th style={{ textAlign: 'right' }}>Needed</th>
                            <th style={{ textAlign: 'right' }}>Usable cash</th>
                            <th style={{ textAlign: 'right' }}>To wire</th>
                            <th style={{ textAlign: 'right' }}>Wire cost</th>
                        </tr>
                    </thead>
                    <tbody>
                        {transfers.map(t => (
                            <tr key={t.brokerId ?? 'unknown'} className="plan-transfer-row">
                                <td className="tr-cell-broker">
                                    <strong>{t.brokerName}</strong>
                                    {t.warnings.includes('unknown-broker') && (
                                        <span className="pill pill-warn" title="These orders have no broker: pick one on the mapping.">
                                            unassigned
                                        </span>
                                    )}
                                    {t.warnings.includes('earmark-shortfall') && (
                                        <div className="cell-note" title="Cash this broker reserves for portfolios the plan does not buy into.">
                                            {eur(t.earmarkedElsewhere, 0)} earmarked elsewhere
                                        </div>
                                    )}
                                    {t.minLiquidity > 0 && (
                                        <div className="cell-note">min liquidity {eur(t.minLiquidity, 0)}</div>
                                    )}
                                </td>
                                <td className="num-cell" data-label="Orders" style={{ textAlign: 'right' }}>{eur(t.ordersOutlay)}</td>
                                <td className="num-cell" data-label="Cash top-up" style={{ textAlign: 'right' }}>{t.deposits > 0 ? eur(t.deposits) : '—'}</td>
                                <td className="num-cell" data-label="Needed" style={{ textAlign: 'right' }}>{eur(t.required)}</td>
                                <td className="num-cell" data-label="Usable cash" style={{ textAlign: 'right' }}>
                                    {eur(t.usableCash)}
                                    {t.surplus > 0 && <div className="cell-note">{eur(t.surplus, 0)} left after</div>}
                                </td>
                                <td className="num-cell" data-label="To wire" style={{ textAlign: 'right' }}>
                                    <strong className={t.transfer > 0 ? 'wire-amount' : 'muted-cell'}>
                                        {t.transfer > 0 ? eur(t.transfer) : 'covered'}
                                    </strong>
                                </td>
                                <td className="num-cell" data-label="Wire cost" style={{ textAlign: 'right' }}>
                                    {t.transfer === 0 ? (
                                        <span className="muted-cell">—</span>
                                    ) : t.cost === 0 ? (
                                        <span className="pill pill-ok" title="This broker's wires are free.">free</span>
                                    ) : (
                                        <>
                                            {eur(t.cost)}
                                            <div className="cell-note">{t.costPercent.toFixed(2)}% of the wire</div>
                                        </>
                                    )}
                                    {t.warnings.includes('costly-transfer') && (
                                        <div className="warning-pills">
                                            <span className="pill pill-warn" title="The bank fee is a large slice of this wire — batching a bigger one costs proportionally less.">
                                                costly wire
                                            </span>
                                        </div>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr className="plan-total-row">
                            <td className="tr-cell-broker">Total</td>
                            <td className="num-cell" data-label="Orders" style={{ textAlign: 'right' }}>{eur(totals.outlay)}</td>
                            <td className="num-cell" data-label="Cash top-up" style={{ textAlign: 'right' }}>{totals.deposits > 0 ? eur(totals.deposits) : '—'}</td>
                            <td className="num-cell" data-label="Needed" style={{ textAlign: 'right' }}>{eur(totals.outlay + totals.deposits)}</td>
                            <td className="is-empty" />
                            <td className="num-cell" data-label="To wire" style={{ textAlign: 'right' }}><strong className="wire-amount">{eur(totals.transfer)}</strong></td>
                            <td className="num-cell" data-label="Wire cost" style={{ textAlign: 'right' }}>{totals.transferCost > 0 ? eur(totals.transferCost) : '—'}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>

            {/* ── Orders ───────────────────────────────────────────────── */}
            <h4 className="plan-section-title">Purchases to execute</h4>
            <div className="plan-table-wrap">
                <table className="plan-table">
                    <thead>
                        <tr>
                            <th>Asset</th>
                            <th>Broker · portfolio</th>
                            <th style={{ textAlign: 'right' }}>Budget</th>
                            <th style={{ textAlign: 'right' }}>Price</th>
                            <th style={{ textAlign: 'right' }}>Quantity</th>
                            <th style={{ textAlign: 'right' }}>Trade value</th>
                            <th style={{ textAlign: 'right' }}>Commission</th>
                            <th style={{ textAlign: 'right' }}>Total cost</th>
                            <th style={{ textAlign: 'right' }}>Residue</th>
                        </tr>
                    </thead>
                    <tbody>
                        {orders.map(order => (
                            <React.Fragment key={order.id}>
                                <tr className={`plan-order-row${order.quantity > 0 ? '' : ' row-idle'}`}>
                                    <td className="ord-cell-asset">
                                        <button
                                            type="button"
                                            className="link-btn"
                                            onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                                            title="Show the categories funding this order"
                                        >
                                            {order.label}
                                        </button>
                                        <div className="cell-note">{order.ticker}</div>
                                    </td>
                                    <td className="ord-cell-where">
                                        {order.brokerName ?? <span className="muted-cell">no broker</span>}
                                        <div className="cell-note">{order.portfolioName ?? 'no portfolio'}</div>
                                    </td>
                                    <td className="num-cell" data-label="Budget" style={{ textAlign: 'right' }}>{eur(order.budget)}</td>
                                    <td className="num-cell" data-label="Price" style={{ textAlign: 'right' }}>{order.price !== undefined ? eur(order.price) : '—'}</td>
                                    <td className="num-cell" data-label="Quantity" style={{ textAlign: 'right' }}>
                                        {order.quantity > 0 ? units(order.quantity) : '—'}
                                        {order.lotUnits > 1 && <div className="cell-note">lots of {order.lotUnits}</div>}
                                    </td>
                                    <td className="num-cell" data-label="Trade value" style={{ textAlign: 'right' }}>{eur(order.gross)}</td>
                                    <td className="num-cell" data-label="Commission" style={{ textAlign: 'right' }}>
                                        {order.commissionFree && order.quantity > 0 ? (
                                            <span
                                                className="pill pill-ok"
                                                title={order.freeReason === 'promo'
                                                    ? 'A free-buy promotion covers this ISIN at this broker this month.'
                                                    : 'This broker has no commission plan configured — a free plan.'}
                                            >
                                                free
                                            </span>
                                        ) : (
                                            <>
                                                {eur(order.commission)}
                                                {order.commission > 0 && (
                                                    <div className="cell-note">{order.feePercent.toFixed(2)}%</div>
                                                )}
                                            </>
                                        )}
                                    </td>
                                    <td className="num-cell" data-label="Total cost" style={{ textAlign: 'right' }}>{eur(order.outlay)}</td>
                                    <td className="num-cell" data-label="Residue" style={{ textAlign: 'right' }}>
                                        {eur(order.leftover)}
                                        {order.topUpForNextUnit !== undefined && (
                                            <div
                                                className="cell-note"
                                                title={`Add this to the order's budget — by wiring a little more — and one more ${order.lotUnits > 1 ? 'lot' : 'unit'} fits, commission included.`}
                                            >
                                                +{eur(order.topUpForNextUnit)} → 1 more
                                            </div>
                                        )}
                                        {order.warnings.length > 0 && (
                                            <div className="warning-pills">
                                                {order.warnings.map(w => (
                                                    <span key={w} className="pill pill-warn" title={WARNING_LABELS[w]}>
                                                        {WARNING_SHORT[w]}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </td>
                                </tr>
                                {expanded === order.id && (
                                    <tr className="sources-row">
                                        <td colSpan={10}>
                                            <span className="cell-note">Funded by</span>
                                            <ul>
                                                {order.sources.map(source => (
                                                    <li key={source.categoryId}>
                                                        {source.groupName} › <strong>{source.categoryName}</strong> — {eur(source.amount)}
                                                    </li>
                                                ))}
                                            </ul>
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        ))}
                    </tbody>
                </table>
            </div>

            {deposits.length > 0 && (
                <>
                    <h4 className="plan-section-title">Kept as cash</h4>
                    <ul className="plan-list">
                        {deposits.map(deposit => (
                            <li key={deposit.brokerId}>
                                <strong>{eur(deposit.amount)}</strong> to {deposit.brokerName} —{' '}
                                <span className="cell-note">{deposit.sources.map(s => s.categoryName).join(', ')}</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}

            {ignored.length > 0 && (
                <p className="plan-footnote">
                    {ignored.length} mapped categor{ignored.length === 1 ? 'y holds' : 'ies hold'} no money
                    {ignored.some(i => i.reason === 'category-missing') && ' or no longer exist in YNAB'} and are left out:{' '}
                    {ignored.map(i => i.categoryName).join(', ')}.
                </p>
            )}

            <style>{cardStyle}</style>
        </div>
    );
};

const cardStyle = `
    .ynab-plan-card {
        background: var(--bg-card);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        margin-bottom: 1.5rem;
    }
    .plan-headline {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        margin-top: 1rem;
    }
    .plan-figure {
        flex: 1 1 150px;
        background: var(--bg-app);
        border-radius: var(--radius-md);
        padding: 0.7rem 0.9rem;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
    }
    .plan-figure-label {
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
    }
    .plan-figure strong { font-size: 1.25rem; }
    .plan-figure:first-child strong { color: var(--color-primary); }
    .plan-figure-note { font-size: 0.75rem; color: var(--text-muted); }
    .plan-options {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem 1.25rem;
        align-items: flex-end;
        margin-top: 1rem;
        padding: 0.75rem 0;
        border-top: 1px solid var(--border-color);
        border-bottom: 1px solid var(--border-color);
    }
    .plan-options label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
    }
    .plan-options .form-select { padding: 0.3rem 0.45rem; font-size: 0.85rem; }
    .plan-options .plan-check {
        flex-direction: row;
        align-items: center;
        gap: 0.4rem;
        text-transform: none;
        letter-spacing: normal;
        font-size: 0.85rem;
        color: var(--text-secondary);
        padding-bottom: 0.3rem;
    }
    .plan-section-title {
        margin: 1.25rem 0 0.5rem;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
    }
    .plan-table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
    }
    .plan-table { width: 100%; border-collapse: collapse; font-size: 0.87rem; }
    .plan-table th,
    .plan-table td {
        padding: 0.45rem 0.7rem;
        text-align: left;
        border-bottom: 1px solid var(--border-color);
        white-space: nowrap;
        vertical-align: top;
    }
    .plan-table thead th {
        background: var(--bg-surface);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
    }
    .plan-table tfoot td { font-weight: 600; background: var(--bg-app); }
    .plan-table .row-idle { opacity: 0.65; }
    /* The asset name is the only long cell: cap it so the money columns all fit. */
    .plan-table td:first-child { max-width: 190px; white-space: normal; }
    .plan-table .sources-row td { background: var(--bg-app); white-space: normal; }
    .plan-table .sources-row ul { margin: 0.25rem 0 0; padding-left: 1.1rem; font-size: 0.82rem; }
    .cell-note { font-size: 0.72rem; color: var(--text-muted); }
    .muted-cell { color: var(--text-muted); font-weight: 400; }
    .wire-amount { color: var(--color-primary); }
    .warning-pills { display: flex; flex-wrap: wrap; gap: 0.25rem; margin-top: 0.2rem; justify-content: flex-end; }
    .pill {
        display: inline-block;
        padding: 0.1rem 0.45rem;
        border-radius: var(--radius-full);
        font-size: 0.72rem;
        font-weight: 500;
    }
    .pill-ok { background: rgba(16, 185, 129, 0.15); color: #059669; }
    .pill-warn { background: rgba(245, 158, 11, 0.18); color: #b45309; cursor: help; }
    .plan-list { margin: 0; padding-left: 1.1rem; font-size: 0.87rem; }
    .plan-footnote { margin: 0.75rem 0 0; font-size: 0.8rem; color: var(--text-muted); }
    .link-btn {
        background: none;
        border: none;
        color: var(--color-primary);
        cursor: pointer;
        padding: 0;
        font-size: 0.87rem;
        font-weight: 600;
        text-align: left;
    }
`;

export default YnabFundingPlanView;
