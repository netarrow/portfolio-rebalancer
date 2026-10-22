import React, { useState } from 'react';
import type { Broker } from '../../types';

export const OUTSIDE = '__outside__';

interface Props {
    title: string;
    brokers: Broker[];
    from: string;
    to: string;
    amount: number;
    onConfirm: (move: { from: string; to: string; amount: number }) => void;
    onClose: () => void;
}

const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A cash transfer between brokers, or to/from outside the tool (a bank
 * account the tool does not track): confirmed once it has been made, it moves
 * the brokers' liquidity. It is not a transaction: nothing is bought or sold.
 */
const CashTransferModal: React.FC<Props> = ({ title, brokers, from: from0, to: to0, amount: amount0, onConfirm, onClose }) => {
    const [from, setFrom] = useState(from0);
    const [to, setTo] = useState(to0);
    const [amount, setAmount] = useState(String(Math.round(amount0 * 100) / 100));
    const value = Number(amount.replace(',', '.'));
    const valid = value > 0 && from !== to && !(from === OUTSIDE && to === OUTSIDE);
    const nameOf = (id: string) => id === OUTSIDE ? 'outside the tool' : brokers.find(b => b.id === id)?.name ?? id;
    const liquidityOf = (id: string) => brokers.find(b => b.id === id)?.currentLiquidity || 0;

    const select = (v: string, set: (v: string) => void, label: string) => (
        <label className="ctm-field">
            <span>{label}</span>
            <select value={v} onChange={e => set(e.target.value)}>
                <option value={OUTSIDE}>Outside the tool (bank, deposit)</option>
                {brokers.map(b => <option key={b.id} value={b.id}>{b.name} · {eur(b.currentLiquidity || 0)}</option>)}
            </select>
        </label>
    );

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content ctm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
                <h3>{title}</h3>
                <p className="ctm-hint">Make the transfer, then confirm it here: the brokers' cash is updated. A broker read from YNAB takes its balance from there again at the next liquidity update.</p>
                <div className="ctm-grid">
                    {select(from, setFrom, 'From')}
                    {select(to, setTo, 'To')}
                    <label className="ctm-field">
                        <span>Amount (€)</span>
                        <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
                    </label>
                </div>
                {valid && (
                    <div className="ctm-after">
                        {from !== OUTSIDE && <div>{nameOf(from)}: {eur(liquidityOf(from))} → {eur(liquidityOf(from) - value)}</div>}
                        {to !== OUTSIDE && <div>{nameOf(to)}: {eur(liquidityOf(to))} → {eur(liquidityOf(to) + value)}</div>}
                    </div>
                )}
                <div className="ctm-actions">
                    <button type="button" className="btn" onClick={onClose}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={!valid} onClick={() => onConfirm({ from, to, amount: value })}>
                        Transfer made: update the cash
                    </button>
                </div>
                <style>{`
                    .ctm { max-width: 560px; width: 95vw; display: flex; flex-direction: column; gap: var(--space-3); }
                    .ctm h3 { margin: 0; }
                    .ctm-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .ctm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
                    .ctm-field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-secondary); min-width: 0; }
                    .ctm-field select, .ctm-field input { padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font-size: 0.88rem; min-width: 0; }
                    .ctm-after { font-size: 0.82rem; display: flex; flex-direction: column; gap: 0.2rem; font-variant-numeric: tabular-nums; }
                    .ctm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; flex-wrap: wrap; }
                    @media (max-width: 560px) { .ctm-grid { grid-template-columns: 1fr; } }
                `}</style>
            </div>
        </div>
    );
};

export default CashTransferModal;
