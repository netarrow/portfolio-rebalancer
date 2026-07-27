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

// Preview of "broker liquidity ← YNAB account balance". Rows whose account no
// longer exists in YNAB are shown for context but can never be applied.
const BrokerLiquiditySyncModal: React.FC<Props> = ({ rows, currencyIso, onConfirm, onCancel }) => {
    const [selected, setSelected] = useState<Set<string>>(
        () => new Set(rows.filter(r => r.status === 'ok' && r.delta !== 0).map(r => r.brokerId))
    );

    const toggle = (brokerId: string) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(brokerId)) next.delete(brokerId); else next.add(brokerId);
            return next;
        });
    };

    const applicable = rows.filter(r => r.status === 'ok');
    const allSelected = applicable.length > 0 && applicable.every(r => selected.has(r.brokerId));

    // The budget column only earns its space when brokers span several budgets.
    const showBudget = new Set(rows.map(r => r.ynabBudgetId)).size > 1;

    const toggleAll = () => {
        setSelected(allSelected ? new Set() : new Set(applicable.map(r => r.brokerId)));
    };

    const handleConfirm = () => {
        onConfirm(rows.filter(r => r.status === 'ok' && selected.has(r.brokerId)));
    };

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal-content liquidity-sync-modal" onClick={e => e.stopPropagation()}>
                <h3 style={{ marginTop: 0 }}>Update broker liquidity from YNAB</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: 0 }}>
                    Each broker takes the working balance (cleared + uncleared) of the YNAB account it is mapped to.
                    Uncheck a row to leave that broker untouched.
                </p>

                {currencyIso !== 'EUR' && (
                    <div style={{ color: 'var(--color-warning, orange)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                        ⚠ The YNAB budget currency is {currencyIso}, not EUR. Balances are copied as-is, without conversion.
                    </div>
                )}

                {rows.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)' }}>No broker is mapped to a YNAB account.</p>
                ) : (
                    <div className="liquidity-sync-table-wrap">
                        <table className="liquidity-sync-table">
                            <thead>
                                <tr>
                                    <th style={{ width: '2rem' }}>
                                        <input
                                            type="checkbox"
                                            checked={allSelected}
                                            onChange={toggleAll}
                                            disabled={applicable.length === 0}
                                            aria-label="Select all brokers"
                                        />
                                    </th>
                                    <th>Broker</th>
                                    {showBudget && <th>Budget</th>}
                                    <th>YNAB account</th>
                                    <th>Current</th>
                                    <th>New</th>
                                    <th>Delta</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(row => {
                                    const missing = row.status !== 'ok';
                                    const shortfall = !missing && row.allocatedTotal > 0 && row.newLiquidity < row.allocatedTotal;
                                    return (
                                        <React.Fragment key={row.brokerId}>
                                            <tr className={missing ? 'row-missing' : undefined}>
                                                <td>
                                                    <input
                                                        type="checkbox"
                                                        checked={selected.has(row.brokerId)}
                                                        onChange={() => toggle(row.brokerId)}
                                                        disabled={missing}
                                                        aria-label={`Update ${row.brokerName}`}
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
                                                <td style={{ color: row.delta > 0 ? '#059669' : row.delta < 0 ? '#DC2626' : 'var(--text-muted)' }}>
                                                    {missing ? '—' : `${row.delta > 0 ? '+' : ''}${formatCurrency(row.delta, currencyIso)}`}
                                                </td>
                                            </tr>
                                            {shortfall && (
                                                <tr>
                                                    <td />
                                                    <td colSpan={showBudget ? 6 : 5} style={{ color: '#F59E0B', fontSize: '0.8rem', paddingTop: 0 }}>
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
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                    <button type="button" className="btn" onClick={onCancel}>Cancel</button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleConfirm}
                        disabled={selected.size === 0}
                    >
                        Update {selected.size > 0 ? `${selected.size} broker${selected.size > 1 ? 's' : ''}` : ''}
                    </button>
                </div>

                <style>{`
                    .liquidity-sync-modal {
                        max-width: 900px;
                        width: 95vw;
                    }
                    .liquidity-sync-table-wrap {
                        overflow-x: auto;
                        margin-top: 1rem;
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
                    .row-missing { opacity: 0.6; }
                    .pill {
                        display: inline-block;
                        padding: 0.15rem 0.5rem;
                        border-radius: var(--radius-full);
                        font-size: 0.75rem;
                        font-weight: 500;
                    }
                    .pill-warn { background: rgba(245, 158, 11, 0.18); color: #b45309; }
                `}</style>
            </div>
        </div>
    );
};

export default BrokerLiquiditySyncModal;
