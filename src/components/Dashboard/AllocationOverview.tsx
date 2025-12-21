import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import './Dashboard.css';

const AllocationOverview: React.FC = () => {
    const { summary, targets, assets } = usePortfolio();

    const getTarget = (ticker: string) => targets.find(t => t.ticker === ticker)?.targetPercentage || 0;

    // We iterate over ASSETS to show allocation.
    // Note: if a target exists but no asset (quantity=0), it won't show up here unless we merge lists. 
    // For rebalancing, we usually want to see everything we PLAN to hold.
    // Let's union assets and targets.

    const assetTickers = assets.map(a => a.ticker);
    const targetTickers = targets.map(t => t.ticker);
    const allTickers = Array.from(new Set([...assetTickers, ...targetTickers])).sort();

    return (
        <div className="allocation-card">
            <h3 className="section-title">Asset Allocation</h3>

            {/* Table-like structure for specific assets */}
            <div className="allocation-details" style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                <div className="allocation-row" style={{ fontWeight: 600, color: 'var(--text-muted)', border: 'none' }}>
                    <div style={{ flex: 1 }}>Asset</div>
                    <div style={{ width: '100px', textAlign: 'right' }}>Qty</div>
                    <div style={{ width: '120px', textAlign: 'right' }}>Avg Price</div>
                    <div style={{ width: '120px', textAlign: 'right' }}>Mkt Price</div>
                    <div style={{ width: '120px', textAlign: 'right' }}>Value</div>
                    <div style={{ width: '120px', textAlign: 'right' }}>Gain</div>
                    <div style={{ width: '100px', textAlign: 'right' }}>Target</div>
                    <div style={{ width: '100px', textAlign: 'right' }}>Actual</div>
                    <div style={{ width: '140px', textAlign: 'right' }}>Action</div>
                </div>

                {allTickers.length === 0 ? (
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>No assets or targets defined.</p>
                ) : (
                    allTickers.map(ticker => {
                        const asset = assets.find(a => a.ticker === ticker);
                        const currentValue = asset ? asset.currentValue : 0;
                        const currentPerc = summary.totalValue > 0 ? (currentValue / summary.totalValue) * 100 : 0;
                        const targetPerc = getTarget(ticker);

                        // Rebalance Calc
                        const targetValue = summary.totalValue * (targetPerc / 100);
                        const rebalanceAmount = targetValue - currentValue;

                        const assetClass = asset?.assetClass || 'Stock';
                        const assetSubClass = asset?.assetSubClass || '';

                        return (
                            <AllocationRow
                                key={ticker}
                                ticker={ticker}
                                assetClass={assetClass}
                                assetSubClass={assetSubClass}
                                currentPerc={currentPerc}
                                targetPerc={targetPerc}
                                rebalanceAmount={rebalanceAmount}
                                currentValue={asset?.currentValue || 0}
                                quantity={asset?.quantity || 0}
                                averagePrice={asset?.averagePrice || 0}
                                currentPrice={asset?.currentPrice || 0}
                                gain={asset?.gain || 0}
                                gainPerc={asset?.gainPercentage || 0}
                            />
                        );
                    })
                )}
            </div>
        </div>
    );
};

interface RowProps {
    ticker: string;
    assetClass: string;
    assetSubClass?: string;
    currentPerc: number;
    targetPerc: number;
    rebalanceAmount: number;
    currentValue: number;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    gain: number;
    gainPerc: number;
}

const AllocationRow: React.FC<RowProps> = ({ ticker, assetClass, assetSubClass, currentPerc, targetPerc, rebalanceAmount, currentValue, quantity, averagePrice, currentPrice, gain, gainPerc }) => {
    const diff = currentPerc - targetPerc;

    const colorMap: Record<string, string> = {
        'Stock': 'dot-etf', // Reuse existing class names for now or map to new ones
        'Bond': 'dot-bond',
        'Commodity': 'dot-commodity',
        'Crypto': 'dot-crypto'
    };

    // Fallback if css classes aren't updated yet, but 'dot-etf' / 'dot-bond' exist
    // We should ideally update CSS to have generic classes like 'dot-blue', 'dot-green', etc. or class-specific
    const colorClass = colorMap[assetClass] || 'dot-neutral';

    return (
        <div className="allocation-row" style={{ padding: 'var(--space-3) 0' }}>
            <div className="allocation-type" style={{ flex: 1 }}>
                <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                <div>
                    <strong>{ticker}</strong>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {assetClass} {assetSubClass ? `• ${assetSubClass}` : ''}
                    </div>
                </div>
            </div>

            <div style={{ width: '100px', textAlign: 'right' }}>
                {parseFloat(quantity.toFixed(4))}
            </div>

            <div style={{ width: '120px', textAlign: 'right' }}>
                €{averagePrice.toFixed(2)}
            </div>

            <div style={{ width: '120px', textAlign: 'right' }}>
                €{currentPrice.toFixed(2)}
            </div>

            <div style={{ width: '120px', textAlign: 'right' }}>
                €{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>

            <div style={{ width: '120px', textAlign: 'right', fontSize: '0.9rem' }}>
                <div style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                </div>
                <div style={{ fontSize: '0.75rem', color: gainPerc >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {gainPerc.toFixed(1)}%
                </div>
            </div>

            <div style={{ width: '100px', textAlign: 'right' }}>
                {targetPerc}%
            </div>

            <div style={{ width: '100px', textAlign: 'right' }}>
                <div className="allocation-perc">{currentPerc.toFixed(1)}%</div>
                <div className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ fontSize: '0.75rem' }}>
                    {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                </div>
            </div>

            <div style={{ width: '140px', textAlign: 'right' }}>
                <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                    {Math.abs(rebalanceAmount) < 5 ? ( // Threshold to ignore small dust
                        <span className="trend-neutral">OK</span>
                    ) : (
                        <>
                            {rebalanceAmount > 0 ? 'Buy' : 'Sell'} €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

// Inline helper for colors until CSS is fully updated (though existing classes work too)
function getColorForClass(assetClass: string): string {
    switch (assetClass) {
        case 'Stock': return '#3B82F6';
        case 'Bond': return '#10B981';
        case 'Commodity': return '#F59E0B';
        case 'Crypto': return '#8B5CF6';
        default: return '#9CA3AF';
    }
}

export default AllocationOverview;
