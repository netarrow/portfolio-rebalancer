import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateRealizedGains, calculateCashFlows } from '../../utils/portfolioCalculations';
import { RealizedGainsModal } from './RealizedGainsModal';
import { CashFlowModal } from './CashFlowModal';
import './Dashboard.css';

const SummaryCards: React.FC = () => {
    const { summary, brokers, transactions, assetSettings } = usePortfolio();
    const [showRealizedModal, setShowRealizedModal] = React.useState(false);
    const [showCashFlowModal, setShowCashFlowModal] = React.useState(false);

    const { totalRealized, details, totalCommissions, totalTax } = React.useMemo(
        () => calculateRealizedGains(transactions, brokers, assetSettings),
        [transactions, brokers, assetSettings]
    );

    const { totalIncome, totalDividends, totalCoupons, byTicker: cashFlowDetails } = React.useMemo(
        () => calculateCashFlows(transactions),
        [transactions]
    );

    const totalLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
    const netWorth = summary.totalValue + totalLiquidity;

    const returnValue = summary.totalValue - summary.totalCost;
    const returnPerc = summary.totalCost > 0 ? (returnValue / summary.totalCost) * 100 : 0;

    const isPositive = returnValue >= 0;

    const fmt = (n: number) => n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const getLabel = (ticker: string) => assetSettings.find(s => s.ticker === ticker)?.label || ticker;
    const getAssetClass = (ticker: string) => assetSettings.find(s => s.ticker === ticker)?.assetClass;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className="summary-grid">
                <div className="summary-card">
                    <span className="card-label">Total Cost</span>
                    <span className="card-value">&euro;{fmt(summary.totalCost)}</span>
                </div>

                <div className="summary-card">
                    <span className="card-label">Invested Value</span>
                    <span className="card-value">&euro;{fmt(summary.totalValue)}</span>
                </div>

                <div className="summary-card">
                    <span className="card-label">Total Return</span>
                    <span className={`card-value ${isPositive ? 'trend-up' : 'trend-down'}`}>
                        {isPositive ? '+' : ''}&euro;{Math.abs(returnValue).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span className={`card-trend ${isPositive ? 'trend-up' : 'trend-down'}`}>
                        {isPositive ? '\u25B2' : '\u25BC'} {Math.abs(returnPerc).toFixed(2)}%
                    </span>
                </div>
            </div>

            <div className="summary-grid">
                <div className="summary-card">
                    <span className="card-label">Liquidity</span>
                    <span className="card-value">&euro;{fmt(totalLiquidity)}</span>
                </div>

                <div className="summary-card">
                    <span className="card-label">Net Worth</span>
                    <span className="card-value">&euro;{fmt(netWorth)}</span>
                </div>

                <div
                    className="summary-card"
                    style={{ cursor: details.length > 0 ? 'pointer' : 'default' }}
                    onClick={() => { if (details.length > 0) setShowRealizedModal(true); }}
                >
                    <span className="card-label">Realized Gains</span>
                    <span className={`card-value ${totalRealized >= 0 ? 'trend-up' : 'trend-down'}`}>
                        {totalRealized >= 0 ? '+' : ''}&euro;{Math.abs(totalRealized).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    {details.length > 0 && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 2 }}>Tap to see breakdown</span>
                    )}
                </div>

                <div
                    className="summary-card"
                    style={{ cursor: cashFlowDetails.length > 0 ? 'pointer' : 'default' }}
                    onClick={() => { if (cashFlowDetails.length > 0) setShowCashFlowModal(true); }}
                >
                    <span className="card-label">Distributions</span>
                    <span className="card-value" style={{ color: totalIncome > 0 ? '#3B82F6' : 'var(--text-primary)' }}>
                        {totalIncome > 0 ? '+' : ''}&euro;{fmt(totalIncome)}
                    </span>
                    {cashFlowDetails.length > 0 && (
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

                <CashFlowModal
                    isOpen={showCashFlowModal}
                    onClose={() => setShowCashFlowModal(false)}
                    details={cashFlowDetails}
                    totalDividends={totalDividends}
                    totalCoupons={totalCoupons}
                    totalIncome={totalIncome}
                    getLabel={getLabel}
                    getAssetClass={getAssetClass}
                />
            </div>
        </div>
    );
};

export default SummaryCards;
