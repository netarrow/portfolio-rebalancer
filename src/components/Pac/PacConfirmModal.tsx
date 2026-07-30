import React, { useEffect, useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { PacPlan } from '../../types';
import { priceAtDetailed } from '../../utils/priceHistory';
import { carryInFor, computeInstalment } from '../../utils/pacSchedule';
import '../Transactions/Transactions.css';

interface PacConfirmModalProps {
    plan: PacPlan;
    dueDate: string;
    onClose: () => void;
}

const PacConfirmModal: React.FC<PacConfirmModalProps> = ({ plan, dueDate, onClose }) => {
    const { priceHistory, brokers, portfolios, assetSettings, pacExecutions, confirmPacInstalment, backfillTickerHistory } = usePortfolio();

    // Recomputed every render straight from context, so it reflects a
    // just-completed backfill (which updates priceHistory) automatically —
    // no need to cache it in local state.
    const resolved = priceAtDetailed(priceHistory[plan.ticker.toUpperCase()], dueDate);

    const [priceInput, setPriceInput] = useState(resolved ? String(resolved.price) : '');
    const [userEdited, setUserEdited] = useState(false);
    const [backfilling, setBackfilling] = useState(false);
    const [backfillError, setBackfillError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    // Auto-fill the price field whenever a fresh history lookup resolves
    // (initial mount or right after a successful backfill), as long as the
    // user hasn't typed their own value.
    useEffect(() => {
        if (!userEdited && resolved) setPriceInput(String(resolved.price));
    }, [resolved?.price, resolved?.asOfDate, userEdited]);

    const broker = brokers.find(b => b.id === plan.brokerId);
    const portfolio = portfolios.find(p => p.id === plan.portfolioId);

    const priceValue = Number(priceInput);
    const carryIn = carryInFor(plan, pacExecutions, dueDate);
    const math = useMemo(() => {
        if (!priceValue || priceValue <= 0) return null;
        return computeInstalment({ plan, price: priceValue, carryIn, broker });
    }, [plan, priceValue, carryIn, broker]);

    const handleBackfill = async () => {
        setBackfilling(true);
        setBackfillError(null);
        const source = assetSettings.find(a => a.ticker === plan.ticker)?.source || 'ETF';
        const result = await backfillTickerHistory(plan.ticker, source, dueDate);
        setBackfilling(false);
        if (!result.ok) {
            setBackfillError(result.error || 'Backfill failed');
        }
    };

    const handleConfirm = () => {
        if (!priceValue || priceValue <= 0) return;
        setSubmitting(true);
        setSubmitError(null);
        const manualPrice = (userEdited || !resolved) ? priceValue : undefined;
        const result = confirmPacInstalment(plan.id, dueDate, { manualPrice });
        setSubmitting(false);
        if (!result.ok) {
            setSubmitError(result.error || 'Failed to confirm installment');
            return;
        }
        onClose();
    };

    const exceedsLiquidity = math && broker && broker.currentLiquidity !== undefined && math.totalOutlay > broker.currentLiquidity;
    const resultingParked = (broker?.liquidityAllocations?.[plan.portfolioId] ?? 0) + (math?.parkedDelta ?? 0);

    return (
        <div className="modal-overlay">
            <div className="modal-content" style={{ position: 'relative', width: '440px', maxWidth: '95vw' }}>
                <button className="modal-close-btn" type="button" onClick={onClose}>×</button>
                <h3>Confirm installment</h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 'var(--space-3)' }}>
                    {plan.name} · {plan.ticker} · due {dueDate}
                </p>

                <div className="form-group">
                    <label>Unit price on {dueDate} (EUR)</label>
                    <input
                        type="number" step="any" min="0" className="form-input"
                        value={priceInput}
                        onChange={(e) => { setPriceInput(e.target.value); setUserEdited(true); }}
                        placeholder="Enter price"
                    />
                    {resolved && !userEdited && (
                        <p style={{ fontSize: '0.8rem', color: resolved.exact ? 'var(--text-secondary)' : '#b45309', marginTop: '4px' }}>
                            {resolved.exact
                                ? 'From local price history.'
                                : `No exact price for ${dueDate} — carried forward from ${resolved.asOfDate}.`}
                        </p>
                    )}
                    {!resolved && (
                        <div style={{ marginTop: '8px' }}>
                            <p style={{ fontSize: '0.8rem', color: '#b45309' }}>No local price history for this date.</p>
                            <button type="button" className="btn btn-secondary" disabled={backfilling} onClick={handleBackfill}>
                                {backfilling ? 'Fetching history…' : 'Backfill price history'}
                            </button>
                            {backfillError && <p style={{ fontSize: '0.8rem', color: 'var(--color-danger)' }}>{backfillError}</p>}
                            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                                Or enter the price manually above.
                            </p>
                        </div>
                    )}
                </div>

                {math && (
                    <div className="form-group" style={{ background: 'var(--bg-app)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        <div>Quantity: <strong style={{ color: 'var(--text-primary)' }}>{math.quantity.toLocaleString('en-IE', { maximumFractionDigits: 6 })}</strong></div>
                        <div>Trade value: €{math.tradeValue.toFixed(2)}</div>
                        <div>Fee: €{math.fee.toFixed(2)}</div>
                        <div>Total outlay: €{math.totalOutlay.toFixed(2)}</div>
                        {carryIn > 0 && <div>Carry-in used: €{carryIn.toFixed(2)}</div>}
                        {math.carryOut > 0 && <div>Residue parked: €{math.carryOut.toFixed(2)}</div>}
                        <div>Broker allocation for {portfolio?.name} after confirm: €{resultingParked.toFixed(2)}</div>
                        {exceedsLiquidity && (
                            <p style={{ color: '#b45309', marginTop: '6px' }}>
                                This exceeds {broker?.name}'s current liquidity (€{broker?.currentLiquidity?.toFixed(2)}).
                            </p>
                        )}
                    </div>
                )}

                {submitError && <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem' }}>{submitError}</p>}

                <div className="form-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
                    <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
                    <button type="button" onClick={handleConfirm} className="btn btn-primary" disabled={!math || submitting}>
                        {submitting ? 'Confirming…' : 'Confirm'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PacConfirmModal;
