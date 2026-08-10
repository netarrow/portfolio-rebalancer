import React from 'react';
import type { RelocationPlan, RelocationWarning } from '../../utils/fundRelocation';

const eur = (v: number) => `€${v.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const eur0 = (v: number) => `€${Math.round(v).toLocaleString('it-IT')}`;
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
const FrictionSummary: React.FC<{ plan: RelocationPlan }> = ({ plan }) => (
    <div className="reloc-card">
        <h3 className="reloc-section-title">Costo dello spostamento</h3>
        <div className="reloc-friction-grid">
            <div className="reloc-stat">
                <div className="reloc-stat-label">{plan.grossSold > 0 ? 'Venduto (lordo)' : 'Cassa impiegata'}</div>
                <div className="reloc-stat-value">{eur0(plan.grossSold > 0 ? plan.grossSold : plan.cashDrawn)}</div>
            </div>
            <div className="reloc-stat">
                <div className="reloc-stat-label">Imposte</div>
                <div className="reloc-stat-value negative">{plan.tax > 0 ? `−${eur0(plan.tax)}` : eur0(0)}</div>
                <div className="reloc-stat-sub">capital gain sulla quota venduta</div>
            </div>
            <div className="reloc-stat">
                <div className="reloc-stat-label">Commissioni</div>
                <div className="reloc-stat-value negative">
                    {plan.sellCommission + plan.buyCommission > 0 ? `−${eur(plan.sellCommission + plan.buyCommission)}` : eur0(0)}
                </div>
                <div className="reloc-stat-sub">
                    vendita {eur(plan.sellCommission)} · acquisto {eur(plan.buyCommission)}
                </div>
            </div>
            <div className="reloc-stat">
                <div className="reloc-stat-label">Frizione totale</div>
                <div className="reloc-stat-value negative">{plan.friction > 0 ? `−${eur0(plan.friction)}` : eur0(0)}</div>
                <div className="reloc-stat-sub">{pct(plan.frictionPercent)} di quanto arriva</div>
            </div>
            <div className="reloc-stat">
                <div className="reloc-stat-label">Arriva a destinazione</div>
                <div className="reloc-stat-value positive">{eur0(plan.netDelivered)}</div>
                <div className="reloc-stat-sub">richiesti {eur0(plan.netRequested)}</div>
            </div>
            {plan.spreadCost > 0 && (
                <div className="reloc-stat">
                    <div className="reloc-stat-label">Costo implicito</div>
                    <div className="reloc-stat-value">{eur(plan.spreadCost)}</div>
                    <div className="reloc-stat-sub">metà spread, non dedotto</div>
                </div>
            )}
        </div>
    </div>
);

const SellTable: React.FC<{ plan: RelocationPlan }> = ({ plan }) => {
    if (plan.sells.length === 0) return null;
    return (
        <div className="reloc-card">
            <h3 className="reloc-section-title">Vendite</h3>
            <div className="reloc-table-wrap">
                <table className="reloc-table">
                    <thead>
                        <tr>
                            <th>Asset</th>
                            <th>Quote</th>
                            <th>Prezzo</th>
                            <th>PMC</th>
                            <th>Lordo</th>
                            <th>Plus. tassabile</th>
                            <th>Imposta</th>
                            <th>Commiss.</th>
                            <th>Netto</th>
                            <th>Quote residue</th>
                        </tr>
                    </thead>
                    <tbody>
                        {plan.sells.map(s => (
                            <tr key={s.ticker}>
                                <td>
                                    <span className="reloc-ticker">{s.ticker}</span>
                                    <span className="reloc-badge sell">VENDI</span>
                                    {s.label && <span className="reloc-ticker-label">{s.label}</span>}
                                    {s.brokerName && <span className="reloc-ticker-label">{s.brokerName}</span>}
                                </td>
                                <td>{s.shares.toLocaleString('it-IT')}</td>
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
                                <td>{s.remainingShares.toLocaleString('it-IT')}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td>Totale</td>
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
            <p className="reloc-hint">
                L&apos;imposta colpisce solo la porzione venduta (quote × (prezzo − PMC)). Una gamba in
                perdita è tassata 0 e la minusvalenza <strong>non</strong> compensa le plusvalenze delle
                altre: servirebbe lo zainetto fiscale, che l&apos;app non modella, quindi la stima resta prudenziale.
            </p>
        </div>
    );
};

const BuyTable: React.FC<{ plan: RelocationPlan }> = ({ plan }) => {
    if (plan.buys.length === 0) return null;
    return (
        <div className="reloc-card">
            <h3 className="reloc-section-title">Acquisti</h3>
            <div className="reloc-table-wrap">
                <table className="reloc-table">
                    <thead>
                        <tr>
                            <th>Asset</th>
                            <th>Quote</th>
                            <th>Prezzo</th>
                            <th>Controvalore</th>
                            <th>Commiss.</th>
                            <th>Quote finali</th>
                        </tr>
                    </thead>
                    <tbody>
                        {plan.buys.map(b => (
                            <tr key={b.ticker}>
                                <td>
                                    <span className="reloc-ticker">{b.ticker}</span>
                                    <span className="reloc-badge buy">COMPRA</span>
                                    {b.freeCommission && <span className="reloc-badge free">FREE</span>}
                                    {b.label && <span className="reloc-ticker-label">{b.label}</span>}
                                    {b.brokerName && <span className="reloc-ticker-label">{b.brokerName}</span>}
                                </td>
                                <td>{b.shares.toLocaleString('it-IT')}</td>
                                <td>{eur(b.price)}</td>
                                <td>{eur0(b.gross)}</td>
                                <td>{b.commission > 0 ? eur(b.commission) : '—'}</td>
                                <td>{b.resultingShares.toLocaleString('it-IT')}</td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td>Totale</td>
                            <td colSpan={2} />
                            <td>{eur0(plan.buys.reduce((s, b) => s + b.gross, 0))}</td>
                            <td>{eur(plan.buyCommission)}</td>
                            <td />
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
};

const RelocationActions: React.FC<{ plan: RelocationPlan }> = ({ plan }) => (
    <>
        <RelocationWarnings warnings={plan.warnings} />
        <FrictionSummary plan={plan} />
        <SellTable plan={plan} />
        <BuyTable plan={plan} />
    </>
);

export default RelocationActions;
