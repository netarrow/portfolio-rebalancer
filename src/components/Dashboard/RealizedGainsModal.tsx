import React from 'react';
import { createPortal } from 'react-dom';
import type { RealizedTickerDetail } from '../../utils/portfolioCalculations';

interface RealizedGainsModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    details: RealizedTickerDetail[];
    totalRealized: number;
    totalCommissions: number;
    totalTax: number;
    getLabel: (ticker: string) => string;
}

const fmt = (n: number) => n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const RealizedGainsModal: React.FC<RealizedGainsModalProps> = ({
    isOpen,
    onClose,
    title,
    details,
    totalRealized,
    totalCommissions,
    totalTax,
    getLabel,
}) => {
    React.useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const gains = details.filter(d => d.realized >= 0);
    const losses = details.filter(d => d.realized < 0);
    const net = totalRealized - totalCommissions - totalTax;

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
                    <span className="realized-modal-title">{title}</span>
                    <button className="realized-modal-close" onClick={onClose} aria-label="Close">✕</button>
                </div>

                <div className="realized-modal-body">
                    {gains.length > 0 && (
                        <>
                            <div className="realized-tooltip-section-label" style={{ color: 'var(--color-success)' }}>Gains</div>
                            {gains.map(d => (
                                <div key={d.ticker} className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                    <span className="realized-tooltip-prices">€{d.avgBuyPrice.toFixed(2)} → €{d.avgSellPrice.toFixed(2)}</span>
                                    <span className="realized-tooltip-amount" style={{ color: 'var(--color-success)' }}>
                                        +€{fmt(d.realized)}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}

                    {losses.length > 0 && (
                        <>
                            <div className="realized-tooltip-section-label" style={{ color: 'var(--color-danger)' }}>Losses</div>
                            {losses.map(d => (
                                <div key={d.ticker} className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                    <span className="realized-tooltip-prices">€{d.avgBuyPrice.toFixed(2)} → €{d.avgSellPrice.toFixed(2)}</span>
                                    <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                        €{fmt(d.realized)}
                                    </span>
                                </div>
                            ))}
                        </>
                    )}

                    <hr className="realized-tooltip-divider" />
                    <div className="realized-tooltip-total">
                        <span>Gross Realized</span>
                        <span style={{ color: totalRealized >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            {totalRealized >= 0 ? '+' : ''}€{fmt(totalRealized)}
                        </span>
                    </div>

                    {(totalCommissions > 0 || totalTax > 0) && (
                        <>
                            <div className="realized-tooltip-section-label" style={{ marginTop: 'var(--space-2)' }}>Impact</div>

                            {totalCommissions > 0 && (
                                <>
                                    <div className="realized-tooltip-row" style={{ marginBottom: 2 }}>
                                        <span className="realized-tooltip-label" style={{ fontWeight: 600 }}>Commissions</span>
                                    </div>
                                    {details.filter(d => d.commissions > 0).map(d => (
                                        <div key={d.ticker} className="realized-tooltip-row" style={{ paddingLeft: 8 }}>
                                            <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                            <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                                -€{fmt(d.commissions)}
                                            </span>
                                        </div>
                                    ))}
                                    <div className="realized-tooltip-row" style={{ borderTop: '1px dashed var(--border-color)', paddingTop: 4, marginTop: 2 }}>
                                        <span className="realized-tooltip-label" style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Total commissions</span>
                                        <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>-€{fmt(totalCommissions)}</span>
                                    </div>
                                </>
                            )}

                            {totalTax > 0 && (
                                <>
                                    <div className="realized-tooltip-row" style={{ marginTop: totalCommissions > 0 ? 'var(--space-2)' : 0, marginBottom: 2 }}>
                                        <span className="realized-tooltip-label" style={{ fontWeight: 600 }}>Taxes (est.)</span>
                                    </div>
                                    {details.filter(d => d.tax > 0).map(d => (
                                        <div key={d.ticker} className="realized-tooltip-row" style={{ paddingLeft: 8 }}>
                                            <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                            <span className="realized-tooltip-prices">{(d.taxRate * 100).toFixed(1)}%</span>
                                            <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                                -€{fmt(d.tax)}
                                            </span>
                                        </div>
                                    ))}
                                    <div className="realized-tooltip-row" style={{ borderTop: '1px dashed var(--border-color)', paddingTop: 4, marginTop: 2 }}>
                                        <span className="realized-tooltip-label" style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Total taxes (est.)</span>
                                        <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>-€{fmt(totalTax)}</span>
                                    </div>
                                </>
                            )}

                            <hr className="realized-tooltip-divider" />
                            <div className="realized-tooltip-total">
                                <span>Net (est.)</span>
                                <span style={{ color: net >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                    {net >= 0 ? '+' : ''}€{fmt(net)}
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
