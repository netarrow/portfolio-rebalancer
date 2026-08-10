import React from 'react';
import type { BuyAction, RelocationPlan, RelocationWarning, SellAction } from '../../utils/fundRelocation';

const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;
const pct = (v: number) => `${v.toFixed(2)}%`;

const CRITICAL: RelocationWarning['kind'][] = ['source-shortfall', 'cash-overdraft', 'no-price', 'no-target'];

export const RelocationWarnings: React.FC<{ warnings: RelocationWarning[] }> = ({ warnings }) => {
    if (warnings.length === 0) return null;
    return (
        <div style={{ marginBottom: 'var(--space-6)' }}>
            {warnings.map((w, i) => (
                <div key={`${w.kind}-${i}`} className={`reloc-warning${CRITICAL.includes(w.kind) ? ' critical' : ''}`}>
                    <span aria-hidden="true">{CRITICAL.includes(w.kind) ? '⛔' : '⚠️'}</span>
                    <span>{w.message}</span>
                </div>
            ))}
        </div>
    );
};

/**
 * The friction readout. The number that matters is the net worth loss: unlike a
 * rebalance inside one portfolio, a relocation permanently destroys tax and
 * commissions, so the money that arrives is strictly less than the money that
 * left.
 */
const FrictionSummary: React.FC<{ plan: RelocationPlan; cardClass: string }> = ({ plan, cardClass }) => (
    <div className={cardClass}>
        <h3 className="reloc-section-title">Cost of the move</h3>
        <div className="reloc-friction-grid">
            <div className="reloc-stat">
                <div className="reloc-stat-label">{plan.grossSold > 0 ? 'Sold (gross)' : 'Cash used'}</div>
                <div className="reloc-stat-value">{eur0(plan.grossSold > 0 ? plan.grossSold : plan.cashDrawn)}</div>
            </div>
            <div className="reloc-stat">
                <div className="reloc-stat-label">Tax</div>
                <div className="reloc-stat-value negative">{plan.tax > 0 ? `−${eur0(plan.tax)}` : eur0(0)}</div>
                <div className="reloc-stat-sub">capital gains on the sold portion</div>
            </div>
            <div className="reloc-stat">
                <div className="reloc-stat-label">Commissions</div>
                <div className="reloc-stat-value negative">
                    {plan.sellCommission + plan.buyCommission > 0 ? `−${eur(plan.sellCommission + plan.buyCommission)}` : eur0(0)}
                </div>
                <div className="reloc-stat-sub">
                    sell {eur(plan.sellCommission)} · buy {eur(plan.buyCommission)}
                </div>
            </div>
            <div className="reloc-stat">
                <div className="reloc-stat-label">Total friction</div>
                <div className="reloc-stat-value negative">{plan.friction > 0 ? `−${eur0(plan.friction)}` : eur0(0)}</div>
                <div className="reloc-stat-sub">{pct(plan.frictionPercent)} of what lands</div>
            </div>
            <div className="reloc-stat">
                <div className="reloc-stat-label">Lands in the destination</div>
                <div className="reloc-stat-value positive">{eur0(plan.netDelivered)}</div>
                <div className="reloc-stat-sub">{eur0(plan.netRequested)} requested</div>
            </div>
            {plan.spreadCost > 0 && (
                <div className="reloc-stat">
                    <div className="reloc-stat-label">Implicit cost</div>
                    <div className="reloc-stat-value">{eur(plan.spreadCost)}</div>
                    <div className="reloc-stat-sub">half spread, not deducted</div>
                </div>
            )}
        </div>
    </div>
);

/**
 * Phone rendering of one sell leg (mrow pattern, styles/mobile-list.css).
 *
 * Ten columns cannot be read on a 390px screen, and a horizontally scrolled
 * table hides the very numbers this page exists for. Collapsed the row shows
 * what is sold and what it nets; expanded, every column of the desktop table.
 */
const SellCard: React.FC<{ sell: SellAction }> = ({ sell }) => {
    const [open, setOpen] = React.useState(false);
    return (
        <div className={`mrow ${open ? 'is-open' : ''}`}>
            <div className="mrow-head" onClick={() => setOpen(v => !v)}>
                <span className="mrow-chevron">▶</span>
                <div className="mrow-main">
                    <div className="mrow-line1">
                        <span className="mrow-title">{sell.ticker}</span>
                        <span className="reloc-badge sell">SELL</span>
                    </div>
                    <div className="mrow-line2">
                        <span>{sell.shares.toLocaleString('en-IE')} × {eur(sell.price)}</span>
                        {sell.brokerName && <span>{sell.brokerName}</span>}
                    </div>
                </div>
                <div className="mrow-side">
                    <div className="mrow-side-primary">{eur0(sell.net)}</div>
                    <div className="mrow-side-secondary" style={{ color: sell.tax > 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                        {sell.tax > 0 ? `−${eur0(sell.tax)} tax` : 'no tax'}
                    </div>
                </div>
            </div>
            {open && (
                <div className="mrow-details">
                    <div className="mrow-detail">
                        <span className="mrow-label">Avg cost</span>
                        <span className="mrow-value">{eur(sell.averagePrice)}</span>
                    </div>
                    <div className="mrow-detail">
                        <span className="mrow-label">Gross</span>
                        <span className="mrow-value">{eur0(sell.gross)}</span>
                    </div>
                    <div className="mrow-detail">
                        <span className="mrow-label">Taxable gain</span>
                        <span className="mrow-value">{sell.gain > 0 ? eur0(sell.gain) : '—'}</span>
                    </div>
                    <div className="mrow-detail">
                        <span className="mrow-label">Tax {sell.gain > 0 ? `(${(sell.taxRate * 100).toFixed(1)}%)` : ''}</span>
                        <span className="mrow-value">{sell.tax > 0 ? eur(sell.tax) : '—'}</span>
                    </div>
                    <div className="mrow-detail">
                        <span className="mrow-label">Fee</span>
                        <span className="mrow-value">{sell.commission > 0 ? eur(sell.commission) : '—'}</span>
                    </div>
                    <div className="mrow-detail">
                        <span className="mrow-label">Shares left</span>
                        <span className="mrow-value">{sell.remainingShares.toLocaleString('en-IE')}</span>
                    </div>
                    {sell.label && (
                        <div className="mrow-detail mrow-detail--wide">
                            <span className="mrow-label">Asset</span>
                            <span className="mrow-value">{sell.label}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const BuyCard: React.FC<{ buy: BuyAction }> = ({ buy }) => {
    const [open, setOpen] = React.useState(false);
    return (
        <div className={`mrow ${open ? 'is-open' : ''}`}>
            <div className="mrow-head" onClick={() => setOpen(v => !v)}>
                <span className="mrow-chevron">▶</span>
                <div className="mrow-main">
                    <div className="mrow-line1">
                        <span className="mrow-title">{buy.ticker}</span>
                        <span className="reloc-badge buy">BUY</span>
                        {buy.freeCommission && <span className="reloc-badge free">FREE</span>}
                    </div>
                    <div className="mrow-line2">
                        <span>{buy.shares.toLocaleString('en-IE')} × {eur(buy.price)}</span>
                        {buy.brokerName && <span>{buy.brokerName}</span>}
                    </div>
                </div>
                <div className="mrow-side">
                    <div className="mrow-side-primary">{eur0(buy.gross)}</div>
                    <div className="mrow-side-secondary" style={{ color: 'var(--text-muted)' }}>
                        {buy.commission > 0 ? `${eur(buy.commission)} fee` : 'no fee'}
                    </div>
                </div>
            </div>
            {open && (
                <div className="mrow-details">
                    <div className="mrow-detail">
                        <span className="mrow-label">Price</span>
                        <span className="mrow-value">{eur(buy.price)}</span>
                    </div>
                    <div className="mrow-detail">
                        <span className="mrow-label">Fee</span>
                        <span className="mrow-value">{buy.commission > 0 ? eur(buy.commission) : '—'}</span>
                    </div>
                    <div className="mrow-detail">
                        <span className="mrow-label">Final shares</span>
                        <span className="mrow-value">{buy.resultingShares.toLocaleString('en-IE')}</span>
                    </div>
                    {buy.label && (
                        <div className="mrow-detail mrow-detail--wide">
                            <span className="mrow-label">Asset</span>
                            <span className="mrow-value">{buy.label}</span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

/** Totals line for the phone lists, which have no <tfoot> to carry them. */
const MobileTotals: React.FC<{ items: { label: string; value: string }[] }> = ({ items }) => (
    <div className="reloc-mobile-totals">
        {items.map(i => (
            <div key={i.label} className="reloc-mobile-total">
                <span className="mrow-label">{i.label}</span>
                <span className="mrow-value">{i.value}</span>
            </div>
        ))}
    </div>
);

const SellTable: React.FC<{ plan: RelocationPlan; cardClass: string; compact: boolean }> = ({ plan, cardClass, compact }) => {
    if (plan.sells.length === 0) return null;
    return (
        <div className={cardClass}>
            <h3 className="reloc-section-title">Sells</h3>
            <div className="reloc-table-wrap desktop-only">
                <table className="reloc-table">
                    <thead>
                        <tr>
                            <th>Asset</th>
                            <th>Shares</th>
                            <th>Price</th>
                            <th>Avg cost</th>
                            <th>Gross</th>
                            <th>Taxable gain</th>
                            <th>Tax</th>
                            <th>Fee</th>
                            <th>Net</th>
                            <th>Shares left</th>
                        </tr>
                    </thead>
                    <tbody>
                        {plan.sells.map(s => (
                            <tr key={s.ticker}>
                                <td>
                                    <span className="reloc-ticker">{s.ticker}</span>
                                    <span className="reloc-badge sell">SELL</span>
                                    {s.label && <span className="reloc-ticker-label">{s.label}</span>}
                                    {s.brokerName && <span className="reloc-ticker-label">{s.brokerName}</span>}
                                </td>
                                <td>{s.shares.toLocaleString('en-IE')}</td>
                                <td>{eur(s.price)}</td>
                                <td>{eur(s.averagePrice)}</td>
                                <td>{eur0(s.gross)}</td>
                                <td>{s.gain > 0 ? eur0(s.gain) : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                                <td>
                                    {s.tax > 0 ? eur(s.tax) : '—'}
                                    {s.gain > 0 && <span className="reloc-ticker-label">{(s.taxRate * 100).toFixed(1)}%</span>}
                                </td>
                                <td>{s.commission > 0 ? eur(s.commission) : '—'}</td>
                                <td>{eur0(s.net)}</td>
                                <td>{s.remainingShares.toLocaleString('en-IE')}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td>Total</td>
                            <td colSpan={3} />
                            <td>{eur0(plan.grossSold)}</td>
                            <td>{eur0(plan.sells.reduce((s, l) => s + l.gain, 0))}</td>
                            <td>{eur(plan.tax)}</td>
                            <td>{eur(plan.sellCommission)}</td>
                            <td>{eur0(plan.grossSold - plan.tax - plan.sellCommission)}</td>
                            <td />
                        </tr>
                    </tfoot>
                </table>
            </div>

            <div className="mobile-only">
                <div className="mrow-list">
                    {plan.sells.map(s => <SellCard key={s.ticker} sell={s} />)}
                </div>
                <MobileTotals
                    items={[
                        { label: 'Gross', value: eur0(plan.grossSold) },
                        { label: 'Tax', value: eur0(plan.tax) },
                        { label: 'Fees', value: eur0(plan.sellCommission) },
                        { label: 'Net', value: eur0(plan.grossSold - plan.tax - plan.sellCommission) },
                    ]}
                />
            </div>

            {!compact && (
                <p className="reloc-hint">
                    Tax hits only the sold portion (shares × (price − average cost)). A leg sold at a loss is
                    taxed 0 and its loss does <strong>not</strong> offset the gains of the other legs: netting
                    would need the tax-credit balance the app does not model, so the estimate stays conservative.
                </p>
            )}
        </div>
    );
};

const BuyTable: React.FC<{ plan: RelocationPlan; cardClass: string }> = ({ plan, cardClass }) => {
    if (plan.buys.length === 0) return null;
    return (
        <div className={cardClass}>
            <h3 className="reloc-section-title">Buys</h3>
            <div className="reloc-table-wrap desktop-only">
                <table className="reloc-table">
                    <thead>
                        <tr>
                            <th>Asset</th>
                            <th>Shares</th>
                            <th>Price</th>
                            <th>Value</th>
                            <th>Fee</th>
                            <th>Final shares</th>
                        </tr>
                    </thead>
                    <tbody>
                        {plan.buys.map(b => (
                            <tr key={b.ticker}>
                                <td>
                                    <span className="reloc-ticker">{b.ticker}</span>
                                    <span className="reloc-badge buy">BUY</span>
                                    {b.freeCommission && <span className="reloc-badge free">FREE</span>}
                                    {b.label && <span className="reloc-ticker-label">{b.label}</span>}
                                    {b.brokerName && <span className="reloc-ticker-label">{b.brokerName}</span>}
                                </td>
                                <td>{b.shares.toLocaleString('en-IE')}</td>
                                <td>{eur(b.price)}</td>
                                <td>{eur0(b.gross)}</td>
                                <td>{b.commission > 0 ? eur(b.commission) : '—'}</td>
                                <td>{b.resultingShares.toLocaleString('en-IE')}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td>Total</td>
                            <td colSpan={2} />
                            <td>{eur0(plan.buys.reduce((s, b) => s + b.gross, 0))}</td>
                            <td>{eur(plan.buyCommission)}</td>
                            <td />
                        </tr>
                    </tfoot>
                </table>
            </div>

            <div className="mobile-only">
                <div className="mrow-list">
                    {plan.buys.map(b => <BuyCard key={b.ticker} buy={b} />)}
                </div>
                <MobileTotals
                    items={[
                        { label: 'Invested', value: eur0(plan.buys.reduce((s, b) => s + b.gross, 0)) },
                        { label: 'Fees', value: eur0(plan.buyCommission) },
                    ]}
                />
            </div>
        </div>
    );
};

interface RelocationActionsProps {
    plan: RelocationPlan;
    /** Rendered inside a step of the sequence: flatter cards, no long hints. */
    compact?: boolean;
}

const RelocationActions: React.FC<RelocationActionsProps> = ({ plan, compact = false }) => {
    const cardClass = compact ? 'reloc-subcard' : 'reloc-card';
    return (
        <>
            <RelocationWarnings warnings={plan.warnings} />
            <FrictionSummary plan={plan} cardClass={cardClass} />
            <SellTable plan={plan} cardClass={cardClass} compact={compact} />
            <BuyTable plan={plan} cardClass={cardClass} />
        </>
    );
};

export default RelocationActions;
