import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateRealizedGains } from '../../utils/portfolioCalculations';
import { RealizedGainsModal } from './RealizedGainsModal';
import './Dashboard.css';

const SummaryCards: React.FC = () => {
    const { summary, brokers, transactions, assetSettings } = usePortfolio();
    const [showRealizedModal, setShowRealizedModal] = React.useState(false);

    const { totalRealized, details, totalCommissions, totalTax } = React.useMemo(
        () => calculateRealizedGains(transactions, brokers, assetSettings),
        [transactions, brokers, assetSettings]
    );

    const totalLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
    const netWorth = summary.totalValue + totalLiquidity;

    const returnValue = summary.totalValue - summary.totalCost;
    const returnPerc = summary.totalCost > 0 ? (returnValue / summary.totalCost) * 100 : 0;

    const isPositive = returnValue >= 0;

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
                    className="summary-card"
                    style={{ cursor: details.length > 0 ? 'pointer' : 'default' }}
                    onClick={() => { if (details.length > 0) setShowRealizedModal(true); }}
                >
                    <span className="card-label">Realized Gains</span>
                    <span className={`card-value ${totalRealized >= 0 ? 'trend-up' : 'trend-down'}`}>
                        {totalRealized >= 0 ? '+' : ''}€{Math.abs(totalRealized).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    {details.length > 0 && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>Tap to see breakdown</span>
                    )}
                </div>

                <RealizedGainsModal
                    isOpen={showRealizedModal}
                    onClose={() => setShowRealizedModal(false)}
                    title="Realized Gains Breakdown"
                    details={details}
                    totalRealized={totalRealized}
                    totalCommissions={totalCommissions}
                    totalTax={totalTax}
                    getLabel={getLabel}
                />
            </div>
        </div>
    );
};

export default SummaryCards;
