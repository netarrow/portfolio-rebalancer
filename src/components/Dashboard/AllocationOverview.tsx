import React, { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets } from '../../utils/portfolioCalculations';
import './Dashboard.css';

const AllocationOverview: React.FC = () => {
    const { portfolios, transactions, assetSettings, marketData, updatePortfolio } = usePortfolio();

    // 1. Group transactions by Portfolio
    // We only care about explicit portfolios, or maybe we want an "Unassigned" one?
    // User request: "ripetuta per ogni portafoglio ... specifici portafogli configurati" implies configured portfolios.
    // We will iterate `portfolios`.

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {portfolios.length === 0 ? (
                <div className="allocation-card">
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>
                        No portfolios configured. Create a portfolio to see allocation analysis.
                    </p>
                </div>
            ) : (
                portfolios.map(portfolio => (
                    <PortfolioAllocationTable
                        key={portfolio.id}
                        portfolio={portfolio}
                        allTransactions={transactions}
                        assetSettings={assetSettings}
                        marketData={marketData}
                        onUpdatePortfolio={updatePortfolio}
                    />
                ))
            )}
        </div>
    );
};

interface AllocationTableProps {
    portfolio: import('../../types').Portfolio;
    allTransactions: import('../../types').Transaction[];
    assetSettings: import('../../types').AssetDefinition[];
    marketData: Record<string, { price: number, lastUpdated: string }>;
    onUpdatePortfolio: (portfolio: import('../../types').Portfolio) => void;
}

const PortfolioAllocationTable: React.FC<AllocationTableProps> = ({ portfolio, allTransactions, assetSettings, marketData, onUpdatePortfolio }) => {
    // Filter Txs for this portfolio
    const portfolioTxs = useMemo(() => {
        return allTransactions.filter(t => t.portfolioId === portfolio.id);
    }, [allTransactions, portfolio.id]);

    // Calculate Assets for this portfolio
    const { assets, summary } = useMemo(() => {
        // We import calculateAssets dynamically or assume it's available (it is imported at top of file in original, wait, I need to check imports)
        // I'll ensure imports are correct below.
        return calculateAssets(portfolioTxs, assetSettings, marketData);
    }, [portfolioTxs, assetSettings, marketData]);

    const allocations = portfolio.allocations || {};
    const liquidity = portfolio.liquidity || 0;

    const assetTickers = assets.map(a => a.ticker);
    const targetTickers = Object.keys(allocations);
    const allTickers = Array.from(new Set([...assetTickers, ...targetTickers])).sort();

    const totalPortfolioValue = summary.totalValue + liquidity;

    // Helper to calculate Buy Only amounts with integer share optimization
    // Strategy: Proportional Gap Filling + Largest Remainder Method
    const buyOnlyAllocations = useMemo(() => {
        const liq = portfolio.liquidity || 0;
        if (liq <= 0) return {};

        const totalVal = summary.totalValue + liq;

        // 1. Calculate weighted gaps (Ideal Allocation - Current Value)
        // We only care about positive gaps (Underweight assets)
        const candidates = allTickers.map(ticker => {
            const asset = assets.find(a => a.ticker === ticker);
            const currentValue = asset ? asset.currentValue : 0;
            const price = asset?.currentPrice || 0;
            const targetPerc = allocations[ticker] || 0;
            const targetValue = totalVal * (targetPerc / 100);
            const gap = targetValue - currentValue;

            return { ticker, gap, price };
        }).filter(c => c.gap > 0 && c.price > 0);

        const totalPositiveGap = candidates.reduce((sum, c) => sum + c.gap, 0);

        if (totalPositiveGap <= 0) return {};

        // 2. Initial Flow: Distribute Liquidity Proportional to Gap
        // This gives us the "Ideal Cash" for each asset.
        // Then convert to "Ideal Shares".
        let distribution = candidates.map(c => {
            const rawAlloc = (c.gap / totalPositiveGap) * liq;
            const idealShares = rawAlloc / c.price;
            const flooredShares = Math.floor(idealShares);
            const fraction = idealShares - flooredShares;

            return {
                ...c,
                shares: flooredShares,
                fraction: fraction,
                cost: flooredShares * c.price
            };
        });

        // 3. Optimization: Spend Remaining Liquidity
        // Sort by fractional part descending (Largest Remainder Methodish)
        // Only consider buying if we have enough cash for the share price
        let spent = distribution.reduce((sum, d) => sum + d.cost, 0);
        let remaining = liq - spent;

        // Sort candidates by potential benefit (fraction high = close to next share)
        const sortedIndices = distribution.map((_, i) => i).sort((a, b) => {
            return distribution[b].fraction - distribution[a].fraction;
        });

        // Greedy pass to buy extra shares
        // We iterate sorted candidates. If we can afford one share, we buy it.
        // We might need multiple passes or just one. Usually one pass through prioritized list is good.
        // But price constraint matters. High fraction but Price > Remaining -> Skip.
        for (const idx of sortedIndices) {
            const candidate = distribution[idx];

            if (remaining >= candidate.price) {
                distribution[idx].shares += 1;
                distribution[idx].cost += candidate.price;
                remaining -= candidate.price;
                // Update spent not strictly needed if we track remaining
            }
        }

        // 4. Build Result Map
        const finalMap: Record<string, number> = {};
        distribution.forEach(d => {
            if (d.shares > 0) {
                finalMap[d.ticker] = d.shares * d.price;
            }
        });

        return finalMap;
    }, [allTickers, allocations, assets, portfolio.liquidity, summary.totalValue]);

    return (
        <div className="allocation-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
                <h3 className="section-title" style={{ margin: 0 }}>
                    Rebalancing: {portfolio.name} <span style={{ fontSize: '0.9em', fontWeight: 'normal', color: 'var(--text-secondary)' }}>
                        ({summary.totalValue.toLocaleString('en-IE', { style: 'currency', currency: 'EUR' })})
                    </span>
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Liquidity:</label>
                    <input
                        type="number"
                        placeholder="0.00"
                        value={portfolio.liquidity !== undefined ? portfolio.liquidity : ''}
                        onChange={(e) => {
                            const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                            onUpdatePortfolio({ ...portfolio, liquidity: val });
                        }}
                        style={{
                            padding: 'var(--space-2)',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-color)',
                            width: '100px',
                            textAlign: 'right'
                        }}
                    />
                </div>
            </div>

            <div className="allocation-details" style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                <div className="allocation-row" style={{ fontWeight: 600, color: 'var(--text-muted)', border: 'none' }}>
                    <div style={{ flex: 1 }}>Asset</div>
                    <div style={{ width: '100px', textAlign: 'center' }}>Qty</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Pmc</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Mkt Price</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Value</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Gain</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Target</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Actual</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Action</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Buy Only</div>
                    <div style={{ width: '90px', textAlign: 'center' }}>Post Buy %</div>
                </div>

                {allTickers.length === 0 ? (
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>No activity or targets.</p>
                ) : (
                    allTickers.map(ticker => {
                        const asset = assets.find(a => a.ticker === ticker);
                        const currentValue = asset ? asset.currentValue : 0;
                        const currentPrice = asset?.currentPrice || 0;

                        // Actual % should be based on TOTAL (Invested + Liquidity) or just Invested?
                        // Usually Rebalancing compares Target % vs (Asset / TotalCapital).
                        // If I add liquidity, the TotalCapital increases.
                        // So correct math: currentPerc = (currentValue / totalPortfolioValue) * 100
                        const currentPerc = totalPortfolioValue > 0 ? (currentValue / totalPortfolioValue) * 100 : 0;

                        const targetPerc = allocations[ticker] || 0;
                        const quantity = asset?.quantity || 0;

                        // Filter: Hide if we don't hold it AND don't target it
                        if (quantity <= 0 && targetPerc <= 0) return null;

                        // Rebalance Calc
                        // 1. Ideal Monetary Diff
                        const targetValue = totalPortfolioValue * (targetPerc / 100);
                        const idealDiff = targetValue - currentValue;

                        // 2. Integer Share Optimization (Executability)
                        let rebalanceShares = 0;
                        let rebalanceAmount = idealDiff; // Default to ideal if no price (shouldn't happen for active assets)

                        if (currentPrice > 0) {
                            // Round to nearest share
                            rebalanceShares = Math.round(idealDiff / currentPrice);
                            rebalanceAmount = rebalanceShares * currentPrice;
                        }

                        const buyOnlyAmountIdeal = buyOnlyAllocations[ticker] || 0;
                        let buyOnlyShares = 0;
                        let buyOnlyAmount = buyOnlyAmountIdeal;

                        if (currentPrice > 0) {
                            // Buy Only is already conceptually "shares" in previous logic, but stored as amount.
                            // Let's recover shares:
                            buyOnlyShares = Math.round(buyOnlyAmountIdeal / currentPrice);
                            buyOnlyAmount = buyOnlyAmountIdeal; // It is already integer-aligned from computation
                        }


                        // Projected % after Buy Only
                        // Assumption: Buy Only action consumes existing Liquidity, so TotalPortfolioValue (Equity + Cash) is constant.
                        // projectedPerc = (NewEquity / TotalPortfolioValue) * 100
                        const projectedPerc = totalPortfolioValue > 0
                            ? ((currentValue + buyOnlyAmount) / totalPortfolioValue) * 100
                            : 0;

                        const setting = assetSettings.find(s => s.ticker === ticker);
                        const assetClass = setting?.assetClass || asset?.assetClass || 'Stock';
                        const assetSubClass = setting?.assetSubClass || asset?.assetSubClass || '';
                        const label = setting?.label || asset?.label;

                        return (
                            <AllocationRow
                                key={ticker}
                                ticker={ticker}
                                label={label}
                                assetClass={assetClass}
                                assetSubClass={assetSubClass}
                                currentPerc={currentPerc}
                                targetPerc={targetPerc}
                                rebalanceAmount={rebalanceAmount}
                                rebalanceShares={rebalanceShares}
                                buyOnlyAmount={buyOnlyAmount}
                                buyOnlyShares={buyOnlyShares}
                                currentValue={asset?.currentValue || 0}
                                quantity={asset?.quantity || 0}
                                averagePrice={asset?.averagePrice || 0}
                                currentPrice={asset?.currentPrice || 0}
                                gain={asset?.gain || 0}
                                gainPerc={asset?.gainPercentage || 0}
                                projectedPerc={projectedPerc}
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
    label?: string;
    assetClass: string;
    assetSubClass?: string;
    currentPerc: number;
    targetPerc: number;
    rebalanceAmount: number;
    rebalanceShares: number; // ADDED
    buyOnlyAmount: number;
    buyOnlyShares: number; // ADDED
    currentValue: number;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    gain: number;
    gainPerc: number;
    projectedPerc: number;
}

const AllocationRow: React.FC<RowProps> = ({ ticker, label, assetClass, assetSubClass, currentPerc, targetPerc, rebalanceAmount, rebalanceShares, buyOnlyAmount, buyOnlyShares, currentValue, quantity, averagePrice, currentPrice, gain, gainPerc, projectedPerc }) => {
    const diff = currentPerc - targetPerc;

    const colorMap: Record<string, string> = {
        'Stock': 'dot-etf',
        'Bond': 'dot-bond',
        'Commodity': 'dot-commodity',
        'Crypto': 'dot-crypto'
    };

    const colorClass = colorMap[assetClass] || 'dot-neutral';

    return (
        <div className="allocation-row" style={{ padding: 'var(--space-3) 0' }}>
            <div className="allocation-type" style={{ flex: 1 }}>
                <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                <div>
                    <strong>{label || ticker}</strong>
                </div>
            </div>

            <div style={{ width: '100px', textAlign: 'center' }}>
                {parseFloat(quantity.toFixed(4))}
            </div>

            <div style={{ width: '110px', textAlign: 'center' }}>
                €{averagePrice.toFixed(2)}
            </div>

            <div style={{ width: '110px', textAlign: 'center' }}>
                €{currentPrice.toFixed(2)}
            </div>

            <div style={{ width: '110px', textAlign: 'center' }}>
                €{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>

            <div style={{ width: '110px', textAlign: 'center', fontSize: '0.9rem' }}>
                <div style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                </div>
                <div style={{ fontSize: '0.75rem', color: gainPerc >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {gainPerc.toFixed(1)}%
                </div>
            </div>

            <div style={{ width: '80px', textAlign: 'center' }}>
                {targetPerc}%
            </div>

            <div style={{ width: '80px', textAlign: 'center' }}>
                <div className="allocation-perc">{currentPerc.toFixed(1)}%</div>
                <div className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ fontSize: '0.75rem' }}>
                    {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                </div>
            </div>

            <div style={{ width: '130px', textAlign: 'center' }}>
                <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                    {rebalanceShares === 0 ? (
                        <span className="trend-neutral">OK</span>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                            <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                            <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            <div style={{ width: '130px', textAlign: 'center' }}>
                <div style={{ fontWeight: 600, color: buyOnlyAmount > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                    {buyOnlyShares === 0 ? (
                        <span className="trend-neutral">-</span>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                            <span>Buy {Math.abs(buyOnlyShares)}</span>
                            <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                            </span>
                        </div>
                    )}
                </div>
            </div>

            <div style={{ width: '90px', textAlign: 'center' }}>
                <div style={{ color: 'var(--text-muted)' }}>{projectedPerc.toFixed(1)}%</div>
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
