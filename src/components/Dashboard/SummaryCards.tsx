import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import './Dashboard.css';

const SummaryCards: React.FC = () => {
    const { summary, brokers } = usePortfolio();

    const totalLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
    const netWorth = summary.totalValue + totalLiquidity;

    const returnValue = summary.totalValue - summary.totalCost;
    const returnPerc = summary.totalCost > 0 ? (returnValue / summary.totalCost) * 100 : 0;

    const isPositive = returnValue >= 0;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className="summary-grid">
                <div className="summary-card">
                    <span className="card-label">Total Cost</span>
                    <span className="card-value">€{summary.totalCost.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>

                <div className="summary-card">
                    <span className="card-label">Invested Value</span>
                    <span className="card-value">€{summary.totalValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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
                    <span className="card-value">€{totalLiquidity.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>

                <div className="summary-card">
                    <span className="card-label">Net Worth</span>
                    <span className="card-value">€{netWorth.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
            </div>
        </div>
    );
};

export default SummaryCards;
