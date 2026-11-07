import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { PacPlan } from '../../types';
import { carryInFor, estimateFee } from '../../utils/pacSchedule';
import { computePortfolioInstalment, marketDataAt, portfolioPacTickers, summarizePortfolioInstalment, type PacOrder } from '../../utils/pacPortfolio';
import { realCashAllocations } from '../../utils/operationsQueue';
import '../Transactions/Transactions.css';

interface Props {
    plan: PacPlan;
    dueDate: string;
    onClose: () => void;
}

const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * One installment of a portfolio PAC: the amount split over the portfolio's
 * assets by its quotas, priced on the due date (local history, else today's
 * price). Quantities and prices can be corrected to what was actually filled.
 */
const PacPortfolioConfirmModal: React.FC<Props> = ({ plan, dueDate, onClose }) => {
    const {
        portfolios, brokers, transactions, effectiveAssetSettings, assetSettings, marketData, priceHistory,
        pacExecutions, confirmPacPortfolioInstalment,
    } = usePortfolio();
    const portfolio = portfolios.find(p => p.id === plan.portfolioId);
    const broker = brokers.find(b => b.id === plan.brokerId);
    const carryIn = carryInFor(plan, pacExecutions, dueDate);
    const labelOf = (t: string) => assetSettings.find(a => a.ticker === t)?.label || t;

    const proposed = useMemo(() => {
        if (!portfolio) return null;
        const prices = marketDataAt(marketData, priceHistory, portfolioPacTickers(portfolio), dueDate);
        // Only what was held before the due date sizes the split.
        const before = transactions.filter(t => t.date.slice(0, 10) <= dueDate);
        return computePortfolioInstalment({
            plan, portfolio, carryIn, broker, transactions: before,
            assetSettings: effectiveAssetSettings, marketData: prices, brokers: brokers.map(realCashAllocations),
        });
        // Computed once when the modal opens: later edits are the user's.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [rows, setRows] = useState(() => (proposed?.orders ?? []).map(o => ({ ticker: o.ticker, qty: String(o.quantity), price: String(o.price), on: true })));
    const [error, setError] = useState<string | null>(null);
    const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(prev => prev.map((r, j) => j === i ? { ...r, ...patch } : r));

    const orders: PacOrder[] = rows.filter(r => r.on).map(r => {
        const quantity = Number(r.qty.replace(',', '.'));
        const price = Number(r.price.replace(',', '.'));
        const tradeValue = Math.round(quantity * price * 100) / 100;
        return { ticker: r.ticker, quantity, price, tradeValue, fee: estimateFee(tradeValue, plan, broker) };
    });
    const invalid = orders.some(o => !(o.quantity > 0 && o.price > 0));
    const result = proposed ? summarizePortfolioInstalment(plan, orders, proposed.budget, carryIn) : null;
    const over = result ? result.invested + (plan.costsIncluded ? result.fees : 0) - result.budget : 0;

    const confirm = () => {
        if (!result || invalid) return;
        const res = confirmPacPortfolioInstalment(plan.id, dueDate, result);
        if (!res.ok) { setError(res.error || 'Could not record the installment'); return; }
        onClose();
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content ppc" style={{ position: 'relative' }}>
                <button className="modal-close-btn" type="button" onClick={onClose}>×</button>
                <h3>Confirm installment</h3>
                <p className="ppc-sub">{plan.name} · portfolio {portfolio?.name ?? '—'} · due {dueDate} · {eur(plan.amount ?? 0)}{carryIn > 0 ? ` + ${eur(carryIn)} carried in` : ''}</p>
                {!portfolio ? <p className="ppc-err">The plan's portfolio no longer exists.</p>
                    : rows.length === 0 ? <p className="ppc-err">Nothing to buy: the portfolio has no target with a price, or the amount buys no whole unit.</p>
                        : (
                            <>
                                <p className="ppc-hint">Split by the portfolio's target quotas, underweight assets first, at the {dueDate} prices where the local history has them. Correct quantity or price to what was filled; untick what you did not buy.</p>
                                <table className="ppc-table">
                                    <thead><tr><th /><th>Asset</th><th>Quantity</th><th>Price</th><th className="ppc-num">Value</th></tr></thead>
                                    <tbody>
                                        {rows.map((r, i) => {
                                            const v = Number(r.qty.replace(',', '.')) * Number(r.price.replace(',', '.'));
                                            return (
                                                <tr key={r.ticker} className={r.on ? '' : 'is-off'}>
                                                    <td><input type="checkbox" checked={r.on} onChange={e => set(i, { on: e.target.checked })} aria-label="Include order" /></td>
                                                    <td><strong>{labelOf(r.ticker)}</strong>{labelOf(r.ticker) !== r.ticker && <div className="ppc-muted">{r.ticker}</div>}</td>
                                                    <td><input className="ppc-in" inputMode="decimal" value={r.qty} disabled={!r.on} onChange={e => set(i, { qty: e.target.value })} /></td>
                                                    <td><input className="ppc-in" inputMode="decimal" value={r.price} disabled={!r.on} onChange={e => set(i, { price: e.target.value })} /></td>
                                                    <td className="ppc-num">{v > 0 ? eur(v) : '—'}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                                {result && (
                                    <div className="ppc-sum">
                                        <div>Invested: <strong>{eur(result.invested)}</strong> · fees {eur(result.fees)} · total outlay {eur(result.totalOutlay)}</div>
                                        {result.carryOut > 0 && <div>{eur(result.carryOut)} left over, parked on {broker?.name ?? 'the broker'} for {portfolio.name}{plan.rounding === 'floor-carry' ? ' and reused next time' : ''}</div>}
                                        {over > 0.5 && <div className="ppc-warn">{eur(over)} more than the installment's {eur(result.budget)}.</div>}
                                        {broker?.currentLiquidity !== undefined && result.totalOutlay > broker.currentLiquidity && (
                                            <div className="ppc-warn">This exceeds {broker.name}'s current liquidity ({eur(broker.currentLiquidity)}).</div>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                {error && <p className="ppc-err">{error}</p>}
                <div className="ppc-actions">
                    <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
                    <button type="button" className="btn btn-primary" onClick={confirm} disabled={!result || orders.length === 0 || invalid}>
                        Record {orders.length} transaction{orders.length === 1 ? '' : 's'}
                    </button>
                </div>
                <style>{`
                    .ppc { width: 640px; max-width: 95vw; max-height: 88vh; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-3); }
                    .ppc h3 { margin: 0; }
                    .ppc-sub, .ppc-hint { margin: 0; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.45; }
                    .ppc-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
                    .ppc-table th { text-align: left; font-size: 0.72rem; text-transform: uppercase; color: var(--text-secondary); font-weight: 600; padding: 0.3rem 0.4rem; }
                    .ppc-table td { padding: 0.4rem; border-top: 1px solid var(--border-color); vertical-align: middle; }
                    .ppc-table tr.is-off td { opacity: 0.5; }
                    .ppc-num { text-align: right; font-variant-numeric: tabular-nums; }
                    .ppc-muted { font-size: 0.72rem; color: var(--text-secondary); }
                    .ppc-in { width: 6.5rem; max-width: 100%; padding: 0.3rem 0.45rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font-variant-numeric: tabular-nums; }
                    .ppc-sum { font-size: 0.85rem; color: var(--text-secondary); background: var(--bg-app); padding: var(--space-3); border-radius: var(--radius-md); display: flex; flex-direction: column; gap: 4px; }
                    .ppc-warn { color: #b45309; }
                    .ppc-err { color: var(--color-danger); font-size: 0.85rem; margin: 0; }
                    .ppc-actions { display: flex; justify-content: flex-end; gap: var(--space-3); }
                `}</style>
            </div>
        </div>
    );
};

export default PacPortfolioConfirmModal;
