import React, { useState, useEffect } from 'react';
import type { Asset, Portfolio } from '../../types';
import { calculateWithdrawalProjection } from '../../utils/withdrawalCalculations';
import type { WithdrawalProjection } from '../../utils/withdrawalCalculations';

interface WithdrawalModalProps {
    isOpen: boolean;
    onClose: () => void;
    assets: Asset[];
    portfolio: Portfolio;
}

export const WithdrawalModal: React.FC<WithdrawalModalProps> = ({ isOpen, onClose, assets, portfolio }) => {
    const [netNeeded, setNetNeeded] = useState<number>(0);
    const [projection, setProjection] = useState<WithdrawalProjection | null>(null);

    useEffect(() => {
        if (isOpen) {
            setNetNeeded(0);
            setProjection(null);
        }
    }, [isOpen]);

    const handleCalculate = () => {
        if (netNeeded <= 0) return;

        const allocations = portfolio.allocations || {};
        const res = calculateWithdrawalProjection(assets, allocations, netNeeded);
        setProjection(res);
    };

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
            <div className="modal-content" style={{
                backgroundColor: 'var(--bg-card)',
                padding: 'var(--space-6)',
                borderRadius: 'var(--radius-lg)',
                maxWidth: '800px',
                width: '90%',
                maxHeight: '90vh',
                overflowY: 'auto'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
                    <h2 style={{ margin: 0 }}>Simulate Withdrawal (Decumulo)</h2>
                    <button className="btn-icon" onClick={onClose}>✕</button>
                </div>

                <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>
                    Calculate how much to sell to net the desired cash amount, accounting for taxes (26% / 12.5%), while maintaining target allocation.
                </p>

                <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'flex-end', marginBottom: 'var(--space-6)' }}>
                    <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', marginBottom: 'var(--space-2)', fontWeight: 500 }}>Net Cash Needed (€)</label>
                        <input
                            type="number"
                            className="input-field"
                            value={netNeeded || ''}
                            onChange={(e) => setNetNeeded(parseFloat(e.target.value))}
                            onKeyDown={(e) => e.key === 'Enter' && handleCalculate()}
                            placeholder="e.g. 10000"
                            style={{
                                width: '100%',
                                padding: '10px',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--border-color)',
                                backgroundColor: 'var(--bg-default)',
                                color: 'var(--text-primary)',
                                fontSize: '1.1rem'
                            }}
                        />
                    </div>
                    <button
                        className="btn-primary"
                        onClick={handleCalculate}
                        disabled={!netNeeded || netNeeded <= 0}
                        style={{ padding: '10px 20px', fontSize: '1rem' }}
                    >
                        Calculate
                    </button>
                </div>

                {projection && (
                    <div className="projection-results" style={{ animation: 'fadeIn 0.3s ease' }}>

                        <div className="summary-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
                            <div className="stat-card" style={{ padding: 'var(--space-4)', backgroundColor: 'var(--bg-default)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Gross To Sell</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                    €{projection.grossTotal.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                </div>
                            </div>
                            <div className="stat-card" style={{ padding: 'var(--space-4)', backgroundColor: 'var(--bg-default)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Est. Tax</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--color-danger)' }}>
                                    €{projection.taxTotal.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                </div>
                            </div>
                            <div className="stat-card" style={{ padding: 'var(--space-4)', backgroundColor: 'var(--bg-default)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-success)' }}>
                                <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Net Proceeds</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--color-success)' }}>
                                    €{projection.netTotal.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                </div>
                            </div>
                        </div>

                        <h3 style={{ marginBottom: 'var(--space-3)' }}>Sell Actions</h3>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)', textAlign: 'left' }}>
                                    <th style={{ padding: '8px' }}>Asset</th>
                                    <th style={{ padding: '8px', textAlign: 'right' }}>Gross Sell</th>
                                    <th style={{ padding: '8px', textAlign: 'right' }}>Tax</th>
                                    <th style={{ padding: '8px', textAlign: 'right' }}>Net</th>
                                    <th style={{ padding: '8px', textAlign: 'right' }}>Post Value</th>
                                </tr>
                            </thead>
                            <tbody>
                                {projection.breakdown.map(action => (
                                    <tr key={action.ticker} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                        <td style={{ padding: '8px', fontWeight: 500 }}>{action.ticker}</td>
                                        <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-primary)' }}>
                                            €{action.grossSellAmount.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </td>
                                        <td style={{ padding: '8px', textAlign: 'right', color: 'var(--color-danger)' }}>
                                            €{action.estimatedTax.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </td>
                                        <td style={{ padding: '8px', textAlign: 'right', color: 'var(--color-success)', fontWeight: 600 }}>
                                            €{action.netProceeds.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </td>
                                        <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>
                                            €{action.postSellValue.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        <div style={{ marginTop: 'var(--space-4)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                            * Tax calculation assumes 26% for Stocks/Crypto/Gold and 12.5% for Bonds/Cash.
                            It applies only to the Gain portion of the sold amount (Gain = SellPrice - AvgPrice).
                            Losses are ignored (conservative).
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
