import React from 'react';
import { createPortal } from 'react-dom';
import type { CashFlowDetail } from '../../utils/portfolioCalculations';

interface CashFlowModalProps {
    isOpen: boolean;
    onClose: () => void;
    details: CashFlowDetail[];
    totalDividends: number;
    totalCoupons: number;
    totalIncome: number;
    getLabel: (ticker: string) => string;
    getAssetClass?: (ticker: string) => string | undefined;
}

const fmt = (n: number) => n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const CashFlowModal: React.FC<CashFlowModalProps> = ({
    isOpen,
    onClose,
    details,
    totalDividends,
    totalCoupons,
    totalIncome,
    getLabel,
    getAssetClass,
}) => {
    React.useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    // Estimate tax: 26% for dividends (stocks), 12.5% for coupons (bonds)
    const totalTax = details.reduce((sum, d) => {
        const isBond = getAssetClass?.(d.ticker) === 'Bond';
        const dividendTax = d.totalDividends * 0.26;
        const couponTax = d.totalCoupons * (isBond ? 0.125 : 0.26);
        return sum + dividendTax + couponTax;
    }, 0);

    const net = totalIncome - totalTax;

    const dividendDetails = details.filter(d => d.totalDividends > 0);
    const couponDetails = details.filter(d => d.totalCoupons > 0);

    return createPortal(
        <div
            className="realized-modal-overlay"
            onClick={onClose}
        >
            <div
                className="realized-modal"
                onClick={e => e.stopPropagation()}
            >
                <div className="realized-modal-header">
                    <span className="realized-modal-title">Distributions Breakdown</span>
                    <button className="realized-modal-close" onClick={onClose} aria-label="Close">&#x2715;</button>
                </div>

                <div className="realized-modal-body">
                    {dividendDetails.length > 0 && (
                        <>
                            <div className="realized-tooltip-section-label" style={{ color: '#3B82F6' }}>Dividends</div>
                            {dividendDetails.map(d => (
                                <div key={`div-${d.ticker}`} className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                    <span className="realized-tooltip-prices">{d.events.filter(e => e.direction === 'Dividend').length} payments</span>
                                    <span className="realized-tooltip-amount" style={{ color: '#3B82F6' }}>
                                        +&euro;{fmt(d.totalDividends)}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}

                    {couponDetails.length > 0 && (
                        <>
                            <div className="realized-tooltip-section-label" style={{ color: '#8B5CF6' }}>Coupons</div>
                            {couponDetails.map(d => (
                                <div key={`cpn-${d.ticker}`} className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                    <span className="realized-tooltip-prices">{d.events.filter(e => e.direction === 'Coupon').length} payments</span>
                                    <span className="realized-tooltip-amount" style={{ color: '#8B5CF6' }}>
                                        +&euro;{fmt(d.totalCoupons)}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}

                    <hr className="realized-tooltip-divider" />
                    <div className="realized-tooltip-total">
                        <span>Gross Income</span>
                        <span style={{ color: '#3B82F6' }}>
                            +&euro;{fmt(totalIncome)}
                        </span>
                    </div>

                    {totalDividends > 0 && totalCoupons > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)', padding: '2px 0' }}>
                            <span>Dividends &euro;{fmt(totalDividends)} + Coupons &euro;{fmt(totalCoupons)}</span>
                        </div>
                    )}

                    {totalTax > 0 && (
                        <>
                            <div className="realized-tooltip-section-label" style={{ marginTop: 'var(--space-2)' }}>Taxes (est.)</div>
                            {details.filter(d => d.totalIncome > 0).map(d => {
                                const isBond = getAssetClass?.(d.ticker) === 'Bond';
                                const tax = d.totalDividends * 0.26 + d.totalCoupons * (isBond ? 0.125 : 0.26);
                                if (tax <= 0) return null;
                                const rate = isBond && d.totalDividends === 0 ? '12.5%' : d.totalCoupons === 0 ? '26%' : 'mixed';
                                return (
                                    <div key={d.ticker} className="realized-tooltip-row" style={{ paddingLeft: 8 }}>
                                        <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                        <span className="realized-tooltip-prices">{rate}</span>
                                        <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                            -&euro;{fmt(tax)}
                                        </span>
                                    </div>
                                );
                            })}
                            <div className="realized-tooltip-row" style={{ borderTop: '1px dashed var(--border-color)', paddingTop: 4, marginTop: 2 }}>
                                <span className="realized-tooltip-label" style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Total taxes (est.)</span>
                                <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>-&euro;{fmt(totalTax)}</span>
                            </div>

                            <hr className="realized-tooltip-divider" />
                            <div className="realized-tooltip-total">
                                <span>Net (est.)</span>
                                <span style={{ color: net >= 0 ? '#3B82F6' : 'var(--color-danger)' }}>
                                    +&euro;{fmt(net)}
                                </span>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
};
