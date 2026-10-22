import React, { useMemo, useState } from 'react';
import type { AssetDefinition, Broker, Portfolio, Transaction } from '../../types';
import { buildCashInvestOrders } from '../../utils/operationsQueue';

interface Props {
    broker: Broker;
    amount: number;
    portfolios: Portfolio[];
    transactions: Transaction[];
    brokers: Broker[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    onReview: (portfolio: Portfolio, orders: Transaction[]) => void;
    onClose: () => void;
}

const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Invest a broker's free cash: pick the portfolio and the amount, and the
 * portfolio's own Buy only plan turns it into orders at that broker, to be
 * reviewed before they are recorded.
 */
const InvestCashModal: React.FC<Props> = ({ broker, amount: amount0, portfolios, transactions, brokers, assetSettings, marketData, onReview, onClose }) => {
    const candidates = useMemo(() => {
        const atBroker = (p: Portfolio) => transactions.filter(t => t.portfolioId === p.id && t.brokerId === broker.id).length;
        return portfolios
            .filter(p => p.targetMode !== 'amount' && Object.values(p.allocations || {}).some(v => (v || 0) > 0))
            .sort((a, b) => Number(b.preferredBrokerId === broker.id) - Number(a.preferredBrokerId === broker.id) || atBroker(b) - atBroker(a));
    }, [portfolios, transactions, broker.id]);
    const [portfolioId, setPortfolioId] = useState(candidates[0]?.id ?? '');
    const [amount, setAmount] = useState(String(Math.floor(amount0)));
    const value = Number(amount.replace(',', '.'));
    const portfolio = candidates.find(p => p.id === portfolioId);
    const orders = useMemo(() => portfolio && value > 0
        ? buildCashInvestOrders({ portfolio, amount: value, broker, transactions, assetSettings, marketData, brokers })
        : [], [portfolio, value, broker, transactions, assetSettings, marketData, brokers]);
    const cost = orders.reduce((s, o) => s + o.amount * o.price, 0);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content icm" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Invest from ${broker.name}`}>
                <h3>Invest from {broker.name}</h3>
                <p className="icm-hint">The portfolio's Buy only plan decides what to buy with this cash; every order is placed at {broker.name}. You review the orders next.</p>
                {candidates.length === 0 ? (
                    <p className="icm-err">No portfolio with % targets to invest in.</p>
                ) : (
                    <div className="icm-grid">
                        <label className="icm-field">
                            <span>Portfolio</span>
                            <select value={portfolioId} onChange={e => setPortfolioId(e.target.value)}>
                                {candidates.map(p => <option key={p.id} value={p.id}>{p.name}{p.preferredBrokerId === broker.id ? ' · its broker' : ''}</option>)}
                            </select>
                        </label>
                        <label className="icm-field">
                            <span>Amount (€)</span>
                            <input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
                        </label>
                    </div>
                )}
                {portfolio && value > 0 && (
                    <div className="icm-sum">
                        {orders.length > 0
                            ? <>{orders.length} order{orders.length === 1 ? '' : 's'} · {eur(cost)}: {orders.map(o => `${o.amount} × ${o.ticker}`).join(', ')}</>
                            : 'Nothing to buy with this amount: the targets are met, or the prices are missing.'}
                    </div>
                )}
                <div className="icm-actions">
                    <button type="button" className="btn" onClick={onClose}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={!portfolio || orders.length === 0} onClick={() => portfolio && onReview(portfolio, orders)}>
                        Review orders…
                    </button>
                </div>
                <style>{`
                    .icm { max-width: 560px; width: 95vw; display: flex; flex-direction: column; gap: var(--space-3); }
                    .icm h3 { margin: 0; }
                    .icm-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .icm-err { margin: 0; font-size: 0.85rem; color: var(--color-danger); }
                    .icm-grid { display: grid; grid-template-columns: 2fr 1fr; gap: var(--space-3); }
                    .icm-field { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-secondary); min-width: 0; }
                    .icm-field select, .icm-field input { padding: 0.4rem 0.5rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font-size: 0.88rem; min-width: 0; }
                    .icm-sum { font-size: 0.84rem; overflow-wrap: anywhere; }
                    .icm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
                    @media (max-width: 560px) { .icm-grid { grid-template-columns: 1fr; } }
                `}</style>
            </div>
        </div>
    );
};

export default InvestCashModal;
