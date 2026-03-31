import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateRealizedGains } from '../../utils/portfolioCalculations';
import './Dashboard.css';

const SummaryCards: React.FC = () => {
    const { summary, brokers, transactions, assetSettings } = usePortfolio();
    const [showRealizedTooltip, setShowRealizedTooltip] = React.useState(false);

    const { totalRealized, details } = React.useMemo(
        () => calculateRealizedGains(transactions),
        [transactions]
    );

    const totalLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
    const netWorth = summary.totalValue + totalLiquidity;

    const returnValue = summary.totalValue - summary.totalCost;
    const returnPerc = summary.totalCost > 0 ? (returnValue / summary.totalCost) * 100 : 0;

    const isPositive = returnValue >= 0;

    const gains = details.filter(d => d.realized >= 0);
    const losses = details.filter(d => d.realized < 0);

    const fmt = (n: number) => n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const getLabel = (ticker: string) => assetSettings.find(s => s.ticker === ticker)?.label || ticker;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className="summary-grid">
                <div className="summary-card">
                    <span className="card-label">Total Cost</span>
                    <span className="card-value">€{fmt(summary.totalCost)}</span>
                </div>

                <div className="summary-card">
                    <span className="card-label">Invested Value</span>
                    <span className="card-value">€{fmt(summary.totalValue)}</span>
                </div>

                <div className="summary-card">
                    <span className="card-label">Total Return</span>
                    <span className={`card-value ${isPositive ? 'trend-up' : 'trend-down'}`}>
                        {isPositive ? '+' : ''}€{Math.abs(returnValue).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className={`card-trend ${isPositive ? 'trend-up' : 'trend-down'}`}>
                        {isPositive ? '▲' : '▼'} {Math.abs(returnPerc).toFixed(2)}%
                    </span>
                </div>
            </div>

            <div className="summary-grid">
                <div className="summary-card">
                    <span className="card-label">Liquidity</span>
                    <span className="card-value">€{fmt(totalLiquidity)}</span>
                </div>

                <div className="summary-card">
                    <span className="card-label">Net Worth</span>
                    <span className="card-value">€{fmt(netWorth)}</span>
                </div>

                <div
                    className="summary-card realized-tooltip-wrapper"
                    onMouseEnter={() => setShowRealizedTooltip(true)}
                    onMouseLeave={() => setShowRealizedTooltip(false)}
                >
                    <span className="card-label">Realized Gains</span>
                    <span className={`card-value ${totalRealized >= 0 ? 'trend-up' : 'trend-down'}`}>
                        {totalRealized >= 0 ? '+' : ''}€{Math.abs(totalRealized).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>

                    {showRealizedTooltip && details.length > 0 && (
                        <div className="realized-tooltip">
                            <div className="realized-tooltip-title">Realized Gains Breakdown</div>

                            {gains.length > 0 && (
                                <>
                                    <div className="realized-tooltip-section-label" style={{ color: 'var(--color-success)' }}>
                                        Gains
                                    </div>
                                    {gains.map(d => (
                                        <div key={d.ticker} className="realized-tooltip-row">
                                            <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                            <span className="realized-tooltip-prices">
                                                €{d.avgBuyPrice.toFixed(2)} → €{d.avgSellPrice.toFixed(2)}
                                            </span>
                                            <span className="realized-tooltip-amount" style={{ color: 'var(--color-success)' }}>
                                                +€{d.realized.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                            </span>
                                        </div>
                                    ))}
                                </>
                            )}

                            {losses.length > 0 && (
                                <>
                                    <div className="realized-tooltip-section-label" style={{ color: 'var(--color-danger)' }}>
                                        Losses
                                    </div>
                                    {losses.map(d => (
                                        <div key={d.ticker} className="realized-tooltip-row">
                                            <span className="realized-tooltip-label">{getLabel(d.ticker)}</span>
                                            <span className="realized-tooltip-prices">
                                                €{d.avgBuyPrice.toFixed(2)} → €{d.avgSellPrice.toFixed(2)}
                                            </span>
                                            <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                                €{d.realized.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                            </span>
                                        </div>
                                    ))}
                                </>
                            )}

                            <hr className="realized-tooltip-divider" />
                            <div className="realized-tooltip-total">
                                <span>Total</span>
                                <span style={{ color: totalRealized >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                    {totalRealized >= 0 ? '+' : ''}€{fmt(totalRealized)}
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default SummaryCards;
