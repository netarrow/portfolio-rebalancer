import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { TransactionType } from '../../types';
import './Dashboard.css';

const AllocationOverview: React.FC = () => {
    const { summary, targets } = usePortfolio();

    // Helper to get target for type
    const getTarget = (type: TransactionType) => targets.find(t => t.type === type)?.targetPercentage || 0;

    const etfCurrent = summary.allocation['ETF'];
    const bondCurrent = summary.allocation['Bond'];

    const etfTarget = getTarget('ETF');
    const bondTarget = getTarget('Bond');

    // Calculate deviation from target value
    // Target Value = Total Portfolio Value * (Target% / 100)
    // Diff = Current Value in that type - Target Value
    // If Diff is positive, we have TOO MUCH (Sell). If negative, we have TOO LITTLE (Buy).

    const calculateRebalanceAmount = (type: TransactionType, currentPerc: number) => {
        const targetPerc = getTarget(type);
        const targetValue = summary.totalValue * (targetPerc / 100);
        const currentValue = summary.totalValue * (currentPerc / 100);
        return targetValue - currentValue; // Positive means "Buy to reach target", Negative means "Sell to reach target" (Wait, usually Rebalancing amount is Target - Current. If Result > 0, Buy. If Result < 0, Sell).
    };

    const etfRebalance = calculateRebalanceAmount('ETF', etfCurrent);
    const bondRebalance = calculateRebalanceAmount('Bond', bondCurrent);

    return (
        <div className="allocation-card">
            <h3 className="section-title">Asset Allocation</h3>

            {/* Visual Bar */}
            <div className="allocation-bar-container">
                <div className="allocation-segment segment-etf" style={{ width: `${etfCurrent}%` }} title={`ETF: ${etfCurrent.toFixed(1)}%`} />
                <div className="allocation-segment segment-bond" style={{ width: `${bondCurrent}%` }} title={`Bond: ${bondCurrent.toFixed(1)}%`} />
            </div>

            <div className="allocation-details">
                {/* ETF Row */}
                <AllocationRow
                    type="ETF"
                    currentPerc={etfCurrent}
                    targetPerc={etfTarget}
                    rebalanceAmount={etfRebalance}
                    colorClass="dot-etf"
                />

                {/* Bond Row */}
                <AllocationRow
                    type="Bond"
                    currentPerc={bondCurrent}
                    targetPerc={bondTarget}
                    rebalanceAmount={bondRebalance}
                    colorClass="dot-bond"
                />
            </div>
        </div>
    );
};

interface RowProps {
    type: string;
    currentPerc: number;
    targetPerc: number;
    rebalanceAmount: number;
    colorClass: string;
}

const AllocationRow: React.FC<RowProps> = ({ type, currentPerc, targetPerc, rebalanceAmount, colorClass }) => {
    const diff = currentPerc - targetPerc;
    // If rebalanceAmount > 0, we need to BUY.
    // If rebalanceAmount < 0, we need to SELL.

    return (
        <div className="allocation-row">
            <div className="allocation-type">
                <div className={`dot ${colorClass}`} />
                <div>
                    <strong>{type}</strong>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Target: {targetPerc}%</div>
                </div>
            </div>
            <div className="allocation-stats">
                <div className="allocation-perc">{currentPerc.toFixed(1)}%</div>
                <div className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`}>
                    {diff > 0 ? '+' : ''}{diff.toFixed(1)}% ({Math.abs(rebalanceAmount) < 1 ? 'OK' : rebalanceAmount > 0 ? 'Under' : 'Over'})
                </div>
                <div style={{ fontSize: '0.75rem', marginTop: '4px', fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                    {Math.abs(rebalanceAmount) > 1 && (
                        <>
                            {rebalanceAmount > 0 ? 'Buy' : 'Sell'} €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default AllocationOverview;
