import React, { useState } from 'react';
import type { BrokerLiquiditySyncRow } from '../../types';

interface Props {
    rows: BrokerLiquiditySyncRow[];
    currencyIso: string;
    onConfirm: (rows: BrokerLiquiditySyncRow[]) => void;
    onCancel: () => void;
}

const formatCurrency = (value: number, iso: string) =>
    new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 2 }).format(value);

const signed = (value: number, iso: string) =>
    `${value > 0 ? '+' : ''}${formatCurrency(value, iso)}`;

const deltaColor = (value: number) =>
    value > 0 ? '#059669' : value < 0 ? '#DC2626' : 'var(--text-muted)';

// Preview of the liquidity update. The two sources are kept in separate
// sections — balances read from YNAB, interest computed from each remuneration
// plan — so it is plain which figure comes from where and either one can be
// applied on its own. A broker that appears in both sections is flagged: its
// bank balance normally already contains the interest it earned.
const BrokerLiquiditySyncModal: React.FC<Props> = ({ rows, currencyIso, onConfirm, onCancel }) => {
    const [selected, setSelected] = useState<Set<string>>(() => new Set(
        rows.filter(r => r.status === 'ok' && r.delta !== 0 && !(r.kind === 'interest' && r.overlaps))
            .map(r => r.id)
    ));

    const toggle = (id: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const ynabRows = rows.filter(r => r.kind === 'ynab');
    const interestRows = rows.filter(r => r.kind === 'interest');

    // The budget column only earns its space when brokers span several budgets.
    const showBudget = new Set(ynabRows.map(r => r.ynabBudgetId)).size > 1;

    const applicable = (list: BrokerLiquiditySyncRow[]) => list.filter(r => r.status === 'ok');
    const pickedIn = (list: BrokerLiquiditySyncRow[]) => applicable(list).filter(r => selected.has(r.id));

    const toggleSection = (list: BrokerLiquiditySyncRow[]) => {
        const rowsOf = applicable(list);
        const allOn = rowsOf.length > 0 && rowsOf.every(r => selected.has(r.id));
        setSelected(prev => {
            const next = new Set(prev);
            for (const row of rowsOf) {
                if (allOn) next.delete(row.id); else next.add(row.id);
            }
            return next;
        });
    };

    const pickedYnab = pickedIn(ynabRows);
    const pickedInterest = pickedIn(interestRows);
    const interestTotal = pickedInterest.reduce((sum, r) => sum + (r.interest?.amount || 0), 0);
    // Brokers taking their bank balance *and* the interest on top of it.
    const doubleCounted = pickedInterest.filter(r => r.overlaps && pickedYnab.some(y => y.brokerId === r.brokerId));
    const totalPicked = pickedYnab.length + pickedInterest.length;

    const handleConfirm = () => {
        onConfirm(rows.filter(r => r.status === 'ok' && selected.has(r.id)));
    };

    const sectionCheckbox = (list: BrokerLiquiditySyncRow[], label: string) => {
        const rowsOf = applicable(list);
        return (
            <input
                type="checkbox"
                checked={rowsOf.length > 0 && rowsOf.every(r => selected.has(r.id))}
                onChange={() => toggleSection(list)}
                disabled={rowsOf.length === 0}
                aria-label={label}
            />
        );
    };

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal-content liquidity-sync-modal" onClick={e => e.stopPropagation()}>
                <h3 style={{ marginTop: 0 }}>Update broker liquidity</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: 0 }}>
                    {ynabRows.length > 0 && interestRows.length > 0
                        ? 'Two independent sources. Pick a whole section, single rows, or nothing — what you leave unchecked stays as it is.'
                        : 'Pick a whole section, single rows, or nothing — what you leave unchecked stays as it is.'}
                </p>

                {rows.length === 0 && (
                    <p style={{ color: 'var(--text-muted)' }}>Nothing to update: no broker is mapped to a YNAB account, and none has interest due.</p>
                )}

                {ynabRows.length > 0 && (
                    <section className="sync-section">
                        <header className="sync-section-header">
                            <span className="sync-section-title">🔗 Balances from YNAB</span>
                            <span className="sync-section-note">
                                Each broker takes the working balance (cleared + uncleared) of the account it is mapped to.
                            </span>
                        </header>

                        {currencyIso !== 'EUR' && (
                            <div style={{ color: 'var(--color-warning, orange)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                                ⚠ The YNAB budget currency is {currencyIso}, not EUR. Balances are copied as-is, without conversion.
                            </div>
                        )}

                        <div className="liquidity-sync-table-wrap">
                            <table className="liquidity-sync-table">
                                <thead>
                                    <tr>
                                        <th style={{ width: '2rem' }}>{sectionCheckbox(ynabRows, 'Select all YNAB balances')}</th>
                                        <th>Broker</th>
                                        {showBudget && <th>Budget</th>}
                                        <th>YNAB account</th>
                                        <th>Current</th>
                                        <th>YNAB balance</th>
                                        <th>Delta</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {ynabRows.map(row => {
                                        const missing = row.status !== 'ok';
                                        const shortfall = !missing && row.allocatedTotal > 0 && row.newLiquidity < row.allocatedTotal;
                                        return (
                                            <React.Fragment key={row.id}>
                                                <tr className={missing ? 'row-missing' : undefined}>
                                                    <td>
                                                        <input
                                                            type="checkbox"
                                                            checked={selected.has(row.id)}
                                                            onChange={() => toggle(row.id)}
                                                            disabled={missing}
                                                            aria-label={`Take the YNAB balance of ${row.brokerName}`}
                                                        />
                                                    </td>
                                                    <td style={{ fontWeight: 600 }}>{row.brokerName}</td>
                                                    {showBudget && <td>{row.ynabBudgetName}</td>}
                                                    <td>
                                                        {row.ynabAccountName}
                                                        {missing && (
                                                            <span className="pill pill-warn" style={{ marginLeft: '0.4rem' }}>
                                                                {row.status === 'budget-missing' ? 'budget not found' : 'not found'}
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td>{formatCurrency(row.currentLiquidity, currencyIso)}</td>
                                                    <td>{missing ? '—' : formatCurrency(row.newLiquidity, currencyIso)}</td>
                                                    <td style={{ color: deltaColor(row.delta) }}>
                                                        {missing ? '—' : signed(row.delta, currencyIso)}
                                                    </td>
                                                </tr>
                                                {shortfall && (
                                                    <tr>
                                                        <td />
                                                        <td colSpan={showBudget ? 6 : 5} className="sync-subrow" style={{ color: '#F59E0B' }}>
                                                            The new liquidity is below the {formatCurrency(row.allocatedTotal, currencyIso)} allocated to portfolios.
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </section>
                )}

                {interestRows.length > 0 && (
                    <section className="sync-section">
                        <header className="sync-section-header">
                            <span className="sync-section-title">💰 Interest to credit</span>
                            <span className="sync-section-note">
                                Computed from each remuneration plan: every credit date that has come due since the last
                                update, net of the withholding. Nothing is read from outside the app.
                            </span>
                        </header>

                        <div className="liquidity-sync-table-wrap">
                            <table className="liquidity-sync-table">
                                <thead>
                                    <tr>
                                        <th style={{ width: '2rem' }}>{sectionCheckbox(interestRows, 'Select all interest credits')}</th>
                                        <th>Broker</th>
                                        <th>Plan</th>
                                        <th>Period</th>
                                        <th>Gross</th>
                                        <th>Tax</th>
                                        <th>Net credited</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {interestRows.map(row => {
                                        const accrual = row.interest!;
                                        const alsoTakingYnab = row.overlaps && pickedYnab.some(y => y.brokerId === row.brokerId);
                                        return (
                                            <React.Fragment key={row.id}>
                                                <tr>
                                                    <td>
                                                        <input
                                                            type="checkbox"
                                                            checked={selected.has(row.id)}
                                                            onChange={() => toggle(row.id)}
                                                            aria-label={`Credit the interest of ${row.brokerName}`}
                                                        />
                                                    </td>
                                                    <td style={{ fontWeight: 600 }}>{row.brokerName}</td>
                                                    <td>
                                                        <span className="pill pill-interest">{accrual.annualRatePercent}% per year</span>
                                                    </td>
                                                    <td style={{ whiteSpace: 'nowrap' }}>
                                                        {accrual.fromDate} → {accrual.toDate}
                                                        <span style={{ color: 'var(--text-muted)' }}>
                                                            {' '}({accrual.credits} credit{accrual.credits === 1 ? '' : 's'})
                                                        </span>
                                                    </td>
                                                    <td>{formatCurrency(accrual.grossAmount, currencyIso)}</td>
                                                    <td style={{ color: accrual.withheld > 0 ? '#DC2626' : 'var(--text-muted)' }}>
                                                        {accrual.withheld > 0
                                                            ? `−${formatCurrency(accrual.withheld, currencyIso)} (${accrual.withholdingPercent}%)`
                                                            : '—'}
                                                    </td>
                                                    <td style={{ color: deltaColor(accrual.amount), fontWeight: 600 }}>
                                                        {signed(accrual.amount, currencyIso)}
                                                    </td>
                                                </tr>
                                                <tr>
                                                    <td />
                                                    <td colSpan={6} className="sync-subrow">
                                                        On {formatCurrency(accrual.base, currencyIso)} of remunerated liquidity.
                                                        {row.overlaps && alsoTakingYnab && (
                                                            <span style={{ color: '#F59E0B' }}>{' '}⚠ This broker is also taking its YNAB balance, which normally already
                                                                contains this interest — crediting both counts it twice.</span>
                                                        )}
                                                        {!selected.has(row.id) && (
                                                            <span>{' '}Left unchecked it stays pending, and is offered again at the next update.</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </section>
                )}

                {doubleCounted.length > 0 && (
                    <div className="sync-warning">
                        ⚠ {doubleCounted.map(r => r.brokerName).join(', ')} {doubleCounted.length === 1 ? 'takes' : 'take'} the
                        YNAB balance <em>and</em> the interest on top of it. Pick only one of the two unless the balance you
                        are importing predates the credit.
                    </div>
                )}

                <div className="sync-footer">
                    <div className="sync-summary">
                        {pickedYnab.length > 0 && (
                            <span>🔗 {pickedYnab.length} balance{pickedYnab.length === 1 ? '' : 's'} from YNAB</span>
                        )}
                        {pickedInterest.length > 0 && (
                            <span>💰 {pickedInterest.length} credit{pickedInterest.length === 1 ? '' : 's'}, <strong>{formatCurrency(interestTotal, currencyIso)}</strong> net of tax</span>
                        )}
                        {totalPicked === 0 && <span style={{ color: 'var(--text-muted)' }}>Nothing selected.</span>}
                    </div>
                    <button type="button" className="btn" onClick={onCancel}>Cancel</button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleConfirm}
                        disabled={totalPicked === 0}
                    >
                        Apply {totalPicked > 0 ? `${totalPicked} change${totalPicked === 1 ? '' : 's'}` : ''}
                    </button>
                </div>

                <style>{`
                    .liquidity-sync-modal {
                        max-width: 940px;
                        width: 95vw;
                    }
                    .sync-section {
                        margin-top: 1.25rem;
                    }
                    .sync-section-header {
                        display: flex;
                        flex-direction: column;
                        gap: 0.15rem;
                        margin-bottom: 0.5rem;
                    }
                    .sync-section-title {
                        font-size: 0.95rem;
                        font-weight: 600;
                        color: var(--text-primary);
                    }
                    .sync-section-note {
                        font-size: 0.8rem;
                        color: var(--text-muted);
                    }
                    .liquidity-sync-table-wrap {
                        overflow-x: auto;
                        border: 1px solid var(--border-color);
                        border-radius: var(--radius-md);
                    }
                    .liquidity-sync-table {
                        width: 100%;
                        border-collapse: collapse;
                        font-size: 0.9rem;
                    }
                    .liquidity-sync-table th,
                    .liquidity-sync-table td {
                        padding: 0.5rem 0.75rem;
                        text-align: left;
                        border-bottom: 1px solid var(--border-color);
                        vertical-align: middle;
                    }
                    .liquidity-sync-table thead th {
                        background: var(--bg-surface);
                        font-size: 0.75rem;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                        color: var(--text-muted);
                    }
                    .sync-subrow {
                        color: var(--text-muted);
                        font-size: 0.8rem;
                        padding-top: 0;
                    }
                    .row-missing { opacity: 0.6; }
                    .pill {
                        display: inline-block;
                        padding: 0.15rem 0.5rem;
                        border-radius: var(--radius-full);
                        font-size: 0.75rem;
                        font-weight: 500;
                        white-space: nowrap;
                    }
                    .pill-warn { background: rgba(245, 158, 11, 0.18); color: #b45309; }
                    .pill-interest { background: rgba(16, 185, 129, 0.18); color: #10B981; }
                    .sync-warning {
                        margin-top: 1rem;
                        padding: 0.5rem 0.75rem;
                        border-radius: var(--radius-md);
                        background: rgba(245, 158, 11, 0.12);
                        color: #F59E0B;
                        font-size: 0.82rem;
                    }
                    .sync-footer {
                        display: flex;
                        align-items: center;
                        gap: 0.5rem;
                        margin-top: 1rem;
                    }
                    .sync-summary {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 0.85rem;
                        margin-right: auto;
                        font-size: 0.85rem;
                        color: var(--text-secondary);
                    }
                `}</style>
            </div>
        </div>
    );
};

export default BrokerLiquiditySyncModal;
