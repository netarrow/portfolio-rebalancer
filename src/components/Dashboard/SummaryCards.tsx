import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import './Dashboard.css';

const SummaryCards: React.FC = () => {
    const { summary } = usePortfolio();

    const returnValue = summary.totalValue - summary.totalCost;
    const returnPerc = summary.totalCost > 0 ? (returnValue / summary.totalCost) * 100 : 0;

    const isPositive = returnValue >= 0;

    return (
        <div className="summary-grid">
            <div className="summary-card">
                <span className="card-label">Total Value</span>
                <span className="card-value">€{summary.totalValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>

            <div className="summary-card">
                <span className="card-label">Total Cost</span>
                <span className="card-value">€{summary.totalCost.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
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
    );
};

export default SummaryCards;
