import React, { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets, calculateRequiredLiquidityForOnlyBuy } from '../../utils/portfolioCalculations';
import './Dashboard.css';

const AllocationOverview: React.FC = () => {
    const { portfolios, transactions, assetSettings, marketData, updatePortfolio, addTransactionsBulk } = usePortfolio();

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
                        onAddTransactions={addTransactionsBulk}
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
    onAddTransactions: (transactions: import('../../types').Transaction[]) => void;
}

const PortfolioAllocationTable: React.FC<AllocationTableProps> = ({ portfolio, allTransactions, assetSettings, marketData, onUpdatePortfolio, onAddTransactions }) => {
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

    // --- Execution Handlers ---
    const handleExecuteRebalance = async (mode: 'Full' | 'BuyOnly') => {
        const Swal = (await import('sweetalert2')).default;

        const transactionsToCreate: import('../../types').Transaction[] = [];

        // Wait, for Full Rebalance we iterate allTickers and calc difference to Target.
        // For Buy Only, we iterate allTickers and use buyOnlyAllocations.

        allTickers.forEach(ticker => {
            const asset = assets.find(a => a.ticker === ticker);
            const currentPrice = asset?.currentPrice || 0;
            const targetPerc = allocations[ticker] || 0;
            const quantity = asset?.quantity || 0;

            if (quantity <= 0 && targetPerc <= 0) return;

            let shares = 0;


            if (mode === 'Full') {
                // Rebalance Calc
                const targetValue = totalPortfolioValue * (targetPerc / 100);
                const idealDiff = targetValue - (asset ? asset.currentValue : 0);
                if (currentPrice > 0) {
                    shares = Math.round(idealDiff / currentPrice);
                }
            } else {
                // Buy Only Calc
                const buyOnlyAmountIdeal = buyOnlyAllocations[ticker] || 0;
                if (currentPrice > 0) {
                    shares = Math.round(buyOnlyAmountIdeal / currentPrice);
                }
            }

            if (shares !== 0 && currentPrice > 0) {
                // Try to resolve broker. 
                const lastTx = allTransactions.filter(t => t.ticker === ticker && t.portfolioId === portfolio.id).pop();
                const brokerId = lastTx?.brokerId;

                transactionsToCreate.push({
                    id: `auto-rebal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    portfolioId: portfolio.id,
                    ticker: ticker,
                    date: new Date().toISOString().split('T')[0],
                    amount: Math.abs(shares),
                    price: currentPrice,
                    direction: shares > 0 ? 'Buy' : 'Sell',
                    brokerId: brokerId
                });
            }
        });

        if (transactionsToCreate.length === 0) {
            Swal.fire({
                title: 'No Actions',
                text: 'There are no actions to execute for this mode.',
                icon: 'info',
                confirmButtonColor: '#3B82F6'
            });
            return;
        }

        const modeLabel = mode === 'Full' ? 'Full Rebalance' : 'Buy Only Rebalance';

        const result = await Swal.fire({
            title: `Execute ${modeLabel}?`,
            html: `This will create <b>${transactionsToCreate.length}</b> transactions based on current market prices.<br/><br/>` +
                `<small style="color:var(--text-muted)">Ensure prices are displayed correctly! Transactions will be created at the current dashboard price.</small>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, Create Transactions',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#10B981',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)'
        });

        if (result.isConfirmed) {
            onAddTransactions(transactionsToCreate);
            Swal.fire({
                title: 'Success',
                text: `${transactionsToCreate.length} transactions created!`,
                icon: 'success',
                timer: 2000,
                showConfirmButton: false,
                background: 'var(--bg-card)',
                color: 'var(--text-primary)'
            });
        }
    };

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
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-color)',
                            width: '100px',
                            textAlign: 'right'
                        }}
                    />
                    {(() => {
                        const requiredTotalLiq = calculateRequiredLiquidityForOnlyBuy(assets, allocations);
                        // existing liquidity is portfolio.liquidity. We need to add the difference?
                        // "Liquidity to Invest" usually means "Cash Available to Buy".
                        // The user asked: "indicare la quantità di liquidità da investire per poter portare le % ... correttamente con solo azioni Only Buy"
                        // If I have 0 cash, I need X cash.
                        // If I have 100 cash, and need 100 total, I need 0 more.
                        // But usually the user wants to know the Total Amount of Cash required to make the "Only Buy" rebalance work.
                        // Let's show "Req for Only Buy: €X".

                        // Wait, if I already HAVE liquidity in the input, does the user want to know how much MORE?
                        // "indicare la quantità di liquidità da investire" -> "Amount of liquidity to invest".
                        // Use case: User asks "How much money do I need to deposit to balance this?"
                        // So it means "Total Required Liquidity" (assuming current cash is 0 or part of it).
                        // If I have 500 cash in input, and I need 1000 total. Do I interpret "Liquidity to invest" as 1000? Or 500 more?
                        // Let's display "Min Liq: €X" where X is the TOTAL liquidity needed.
                        // The user can then type that into the input. 

                        return (
                            <div
                                style={{ fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'var(--space-2)' }}
                                title="Click to set Liquidity to this value"
                                onClick={() => onUpdatePortfolio({ ...portfolio, liquidity: parseFloat(requiredTotalLiq.toFixed(2)) })}
                            >
                                (Rebalancing Buy Only Liquidity: <span style={{ textDecoration: 'underline' }}>€{requiredTotalLiq.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</span>)
                            </div>
                        );
                    })()}
                </div>
            </div>


            {/* Rebalancing Actions Toolbar */}
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)', justifyContent: 'flex-end' }}>
                <button
                    className="btn-secondary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => handleExecuteRebalance('BuyOnly')}
                >
                    Exec Buy Only
                </button>
                <button
                    className="btn-primary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => handleExecuteRebalance('Full')}
                >
                    Exec Full Rebalance
                </button>
            </div>

            <div className="allocation-details" style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                <div className="allocation-row desktop-only" style={{ fontWeight: 600, color: 'var(--text-muted)', border: 'none' }}>
                    <div style={{ flex: 1 }}>Asset</div>
                    <div style={{ width: '100px', textAlign: 'center' }}>Qty</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Pmc</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Mkt Price</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Value</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Gain</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Target</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Actual</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Action</div>
                    <div style={{ width: '90px', textAlign: 'center' }}>Post Act %</div>
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

                        // Projected % after Rebalancing (Buy/Sell)
                        // This assumes full rebalancing: NewValue = CurrentValue + RebalanceAmount (Buy is +, Sell is -)
                        // And usually Standard Rebalancing tends to keep Total Portfolio Value same (Sell X to Buy Y), 
                        // UNLESS we are adding liquidity? 
                        // Standard rebalance in this tool seems to be "Ideal Diff" based on CURRENT Total Value (Assets + Liq).
                        // So if we execute it, the Asset Value becomes TargetValue.
                        // So PostRebalance % should be virtually equal to Target %, unless integer share rounding makes it slightly different.
                        // Let's calculate exactly based on integer shares:
                        const postRebalanceValue = currentValue + rebalanceAmount;
                        const postRebalancePerc = totalPortfolioValue > 0
                            ? (postRebalanceValue / totalPortfolioValue) * 100
                            : 0;

                        const setting = assetSettings.find(s => s.ticker === ticker);
                        const assetClass = setting?.assetClass || asset?.assetClass || 'Stock';

                        const label = setting?.label || asset?.label;

                        return (
                            <AllocationRow
                                key={ticker}
                                ticker={ticker}
                                label={label}
                                assetClass={assetClass}
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
                                postRebalancePerc={postRebalancePerc}
                                projectedPerc={projectedPerc}
                            />
                        );
                    })
                )}
            </div>
        </div >
    );
};

interface RowProps {
    ticker: string;
    label?: string;
    assetClass: string;

    // assetSubClass?: string; // UNUSED
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
    postRebalancePerc: number;
    projectedPerc: number;
}

const AllocationRow: React.FC<RowProps> = ({ ticker, label, assetClass, currentPerc, targetPerc, rebalanceAmount, rebalanceShares, buyOnlyAmount, buyOnlyShares, currentValue, quantity, averagePrice, currentPrice, gain, gainPerc, postRebalancePerc, projectedPerc }) => {
    const diff = currentPerc - targetPerc;

    const colorMap: Record<string, string> = {
        'Stock': 'dot-etf',
        'Bond': 'dot-bond',
        'Commodity': 'dot-commodity',
        'Crypto': 'dot-crypto'
    };

    const colorClass = colorMap[assetClass] || 'dot-neutral';

    return (
        <React.Fragment>
            {/* Desktop Table Row */}
            <div className="allocation-row desktop-only" style={{ padding: 'var(--space-3) 0' }}>
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

                <div style={{ width: '90px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text-muted)' }}>{postRebalancePerc.toFixed(1)}%</div>
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

            {/* Mobile Card Layout */}
            <div className="allocation-mobile-card mobile-only">
                <div className="mobile-card-header">
                    <div className="mobile-card-title">
                        <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                        <strong>{label || ticker}</strong>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '1rem', fontWeight: 600 }}>€{currentValue.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</div>
                        <div style={{ fontSize: '0.8rem', color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)} ({gainPerc.toFixed(1)}%)
                        </div>
                    </div>
                </div>

                <div className="mobile-card-grid">
                    <div className="mobile-detail-group">
                        <span className="mobile-label">Price</span>
                        <span className="mobile-value">€{currentPrice.toFixed(2)}</span>
                    </div>
                    <div className="mobile-detail-group">
                        <span className="mobile-label">Qty</span>
                        <span className="mobile-value">{parseFloat(quantity.toFixed(4))}</span>
                    </div>
                    <div className="mobile-detail-group">
                        <span className="mobile-label">Target</span>
                        <span className="mobile-value">{targetPerc}%</span>
                    </div>
                    <div className="mobile-detail-group">
                        <span className="mobile-label">Actual</span>
                        <span className="mobile-value">
                            {currentPerc.toFixed(1)}%
                            <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px', fontSize: '0.75rem' }}>
                                ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                            </span>
                        </span>
                    </div>
                </div>

                <div className="mobile-actions">
                    <div className="mobile-action-box">
                        <div className="mobile-action-title">Standard Rebal</div>
                        <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {rebalanceShares === 0 ? (
                                <span>OK</span>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                    <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="mobile-action-box">
                        <div className="mobile-action-title">Buy Only</div>
                        <div style={{ fontWeight: 600, color: buyOnlyAmount > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                            {buyOnlyShares === 0 ? (
                                <span>-</span>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                    <span>Buy {Math.abs(buyOnlyShares)}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </React.Fragment>
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
