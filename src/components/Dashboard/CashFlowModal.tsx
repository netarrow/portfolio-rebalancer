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
}) => {
    React.useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

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
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 'var(--space-3)', fontStyle: 'italic' }}>
                        All amounts are net at source (tax withheld at origin)
                    </div>

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
                        <span>Total Income</span>
                        <span style={{ color: '#3B82F6' }}>
                            +&euro;{fmt(totalIncome)}
                        </span>
                    </div>

                    {totalDividends > 0 && totalCoupons > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--text-muted)', padding: '2px 0' }}>
                            <span>Dividends &euro;{fmt(totalDividends)} + Coupons &euro;{fmt(totalCoupons)}</span>
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
};
