import React, { useState } from 'react';
import type { Broker, Transaction } from '../../types';

interface Props {
    title: string;
    orders: Transaction[];
    brokers: Broker[];
    onConfirm: (orders: Transaction[]) => void;
    onClose: () => void;
}

const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The orders a rebalance would create, to check and correct before they become
 * transactions: quantity and price can be changed, an order can be left out.
 */
const OrdersReviewModal: React.FC<Props> = ({ title, orders, brokers, onConfirm, onClose }) => {
    const [rows, setRows] = useState(() => orders.map(o => ({ order: o, qty: String(o.amount), price: String(o.price), on: true })));
    const parsed = rows.map(r => ({ ...r, q: Number(r.qty.replace(',', '.')), p: Number(r.price.replace(',', '.')) }));
    const picked = parsed.filter(r => r.on && r.q > 0 && r.p > 0);
    const invalid = parsed.some(r => r.on && !(r.q > 0 && r.p > 0));
    const buys = picked.filter(r => r.order.direction === 'Buy').reduce((s, r) => s + r.q * r.p, 0);
    const sells = picked.filter(r => r.order.direction === 'Sell').reduce((s, r) => s + r.q * r.p, 0);
    const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(prev => prev.map((r, j) => j === i ? { ...r, ...patch } : r));
    const brokerName = (id?: string) => brokers.find(b => b.id === id)?.name ?? 'no broker';

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content orm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
                <h3>{title}</h3>
                <p className="orm-hint">Check the orders: change quantity or price if you placed them differently, untick the ones you skip. Confirming records them as transactions.</p>
                <table className="orm-table">
                    <thead>
                        <tr><th /><th>Order</th><th>Quantity</th><th>Price</th><th className="orm-num">Value</th></tr>
                    </thead>
                    <tbody>
                        {parsed.map((r, i) => (
                            <tr key={r.order.id} className={r.on ? '' : 'is-off'}>
                                <td><input type="checkbox" checked={r.on} onChange={e => set(i, { on: e.target.checked })} aria-label="Include order" /></td>
                                <td>
                                    <span className={`orm-dir orm-${r.order.direction.toLowerCase()}`}>{r.order.direction.toUpperCase()}</span>{' '}
                                    <strong>{r.order.ticker}</strong>
                                    <div className="orm-sub">{brokerName(r.order.brokerId)}</div>
                                </td>
                                <td><input className="orm-in" inputMode="decimal" value={r.qty} disabled={!r.on} onChange={e => set(i, { qty: e.target.value })} /></td>
                                <td><input className="orm-in" inputMode="decimal" value={r.price} disabled={!r.on} onChange={e => set(i, { price: e.target.value })} /></td>
                                <td className="orm-num">{r.q > 0 && r.p > 0 ? eur(r.q * r.p) : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div className="orm-total">
                    {picked.length} order{picked.length === 1 ? '' : 's'} · buys {eur(buys)} · sells {eur(sells)}
                    {invalid && <span className="orm-err"> · fix the quantity or price of the ticked orders</span>}
                </div>
                <div className="orm-actions">
                    <button type="button" className="btn" onClick={onClose}>Cancel</button>
                    <button
                        type="button"
                        className="btn btn-primary"
                        disabled={picked.length === 0 || invalid}
                        onClick={() => onConfirm(picked.map(r => ({ ...r.order, amount: r.q, price: r.p })))}
                    >Record {picked.length} transaction{picked.length === 1 ? '' : 's'}</button>
                </div>
                <style>{`
                    .orm { max-width: 680px; width: 95vw; display: flex; flex-direction: column; gap: var(--space-3); max-height: 88vh; overflow-y: auto; }
                    .orm h3 { margin: 0; }
                    .orm-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .orm-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
                    .orm-table th { text-align: left; font-size: 0.72rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 600; padding: 0.3rem 0.4rem; }
                    .orm-table td { padding: 0.4rem; border-top: 1px solid var(--border-color); vertical-align: middle; }
                    .orm-table tr.is-off td { opacity: 0.5; }
                    .orm-num { text-align: right; font-variant-numeric: tabular-nums; }
                    .orm-sub { font-size: 0.72rem; color: var(--text-secondary); }
                    .orm-in { width: 6.5rem; max-width: 100%; padding: 0.3rem 0.45rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font-variant-numeric: tabular-nums; }
                    .orm-dir { font-size: 0.66rem; font-weight: 700; border-radius: 4px; padding: 0.05rem 0.35rem; }
                    .orm-buy { color: var(--color-success); background: rgba(16, 185, 129, 0.14); }
                    .orm-sell { color: var(--color-danger); background: rgba(239, 68, 68, 0.14); }
                    .orm-total { font-size: 0.85rem; font-weight: 600; }
                    .orm-err { color: var(--color-danger); font-weight: 500; }
                    .orm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
                `}</style>
            </div>
        </div>
    );
};

export default OrdersReviewModal;
