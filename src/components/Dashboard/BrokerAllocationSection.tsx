import React, { useMemo, useState } from 'react';
import type { Broker, Transaction, AssetDefinition } from '../../types';
import { calculateAssets, calculateCommission, CASH_TICKER_PREFIX } from '../../utils/portfolioCalculations';
import { buildBrokerBuyPlan, groupTransactionsByBroker, assignPortfolioForBuy, type BrokerBuyLine } from '../../utils/brokerRebalancing';
import './Dashboard.css';

// "By Broker" rebalancing mode: one table per broker, where each holding's
// CURRENT weight acts as its target. Entering investable liquidity produces a
// buy-only plan that preserves the broker's existing composition.

interface BrokerAllocationSectionProps {
    brokers: Broker[];
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    onAddTransactions: (txs: Transaction[]) => void;
}

const BrokerAllocationSection: React.FC<BrokerAllocationSectionProps> = ({
    brokers, transactions, assetSettings, marketData, onAddTransactions,
}) => {
    const txByBroker = useMemo(() => groupTransactionsByBroker(transactions), [transactions]);
    const unassignedCount = txByBroker.get('')?.length ?? 0;

    if (brokers.length === 0) {
        return (
            <div className="allocation-card">
                <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>
                    No brokers configured. Create a broker to use broker-mode rebalancing.
                </p>
            </div>
        );
    }

    return (
        <>
            {unassignedCount > 0 && (
                <div style={{
                    padding: 'var(--space-2) var(--space-3)',
                    border: '1px solid rgba(245,158,11,0.45)',
                    background: 'rgba(245,158,11,0.08)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.82rem',
                    color: 'var(--text-primary)',
                }}>
                    ⚠ {unassignedCount === 1
                        ? '1 transaction has no broker assigned and is not shown in broker mode.'
                        : `${unassignedCount} transactions have no broker assigned and are not shown in broker mode.`}
                </div>
            )}
            {brokers.map(broker => (
                <BrokerAllocationTable
                    key={broker.id}
                    broker={broker}
                    brokerTxs={txByBroker.get(broker.id) ?? []}
                    assetSettings={assetSettings}
                    marketData={marketData}
                    onAddTransactions={onAddTransactions}
                />
            ))}
        </>
    );
};

interface BrokerAllocationTableProps {
    broker: Broker;
    brokerTxs: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    onAddTransactions: (txs: Transaction[]) => void;
}

const BrokerAllocationTable: React.FC<BrokerAllocationTableProps> = ({
    broker, brokerTxs, assetSettings, marketData, onAddTransactions,
}) => {
    // Local simulation amount — typing here must NOT touch the broker's cash ledger.
    const [liquidity, setLiquidity] = useState<number | undefined>(
        broker.currentLiquidity !== undefined ? parseFloat(broker.currentLiquidity.toFixed(2)) : undefined
    );
    const liq = liquidity ?? 0;

    // No injectCashAssets here: broker cash is represented by the liquidity input.
    const assets = useMemo(() => {
        const { assets } = calculateAssets(brokerTxs, assetSettings, marketData);
        return assets.filter(a => !a.ticker.startsWith(CASH_TICKER_PREFIX) && a.quantity > 0.000001);
    }, [brokerTxs, assetSettings, marketData]);

    const totalValue = useMemo(() => assets.reduce((s, a) => s + a.currentValue, 0), [assets]);
    const plan = useMemo(() => buildBrokerBuyPlan(assets, liq), [assets, liq]);
    const planByTicker = useMemo(() => {
        const map: Record<string, BrokerBuyLine> = {};
        plan.lines.forEach(l => { map[l.ticker] = l; });
        return map;
    }, [plan]);

    const handleExecuteBuy = async () => {
        const Swal = (await import('sweetalert2')).default;

        const transactionsToCreate: Transaction[] = plan.lines
            .filter(l => l.shares > 0 && l.eur > 0)
            .map(l => {
                const price = assets.find(a => a.ticker === l.ticker)?.currentPrice ?? 0;
                return {
                    id: `auto-broker-rebal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    ticker: l.ticker,
                    date: new Date().toISOString().split('T')[0],
                    amount: l.shares,
                    price,
                    direction: 'Buy' as const,
                    brokerId: broker.id,
                    portfolioId: assignPortfolioForBuy(l.ticker, brokerTxs),
                };
            });

        if (transactionsToCreate.length === 0) {
            Swal.fire({
                title: 'No Actions',
                text: 'There are no buys to execute for this liquidity amount.',
                icon: 'info',
                confirmButtonColor: '#3B82F6'
            });
            return;
        }

        const result = await Swal.fire({
            title: `Execute Broker Buy — ${broker.name}?`,
            html: `This will create <b>${transactionsToCreate.length}</b> Buy transactions (€${plan.totalSpent.toLocaleString('en-IE', { maximumFractionDigits: 2 })}) based on current market prices.<br/><br/>` +
                `<small style="color:var(--text-muted)">Buys follow the broker's current weights and will be assigned to the portfolio holding each asset at this broker. Ensure prices are displayed correctly!</small>`,
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
            // addTransactionsBulk decrements broker.currentLiquidity for Buys with
            // a brokerId; realign the local input with the post-trade cash.
            setLiquidity(prev => {
                if (broker.currentLiquidity === undefined) return prev;
                return parseFloat(Math.max(broker.currentLiquidity - plan.totalSpent, 0).toFixed(2));
            });
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
                <h3 style={{ margin: 0 }}>
                    {broker.name}
                    <span style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: 'var(--text-muted)' }}>
                        Invested: €{totalValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                </h3>
                <div className="allocation-liquidity-controls" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Liquidity:</label>
                    <input
                        type="number"
                        placeholder="0.00"
                        value={liquidity !== undefined ? liquidity : ''}
                        onChange={e => setLiquidity(e.target.value === '' ? undefined : parseFloat(e.target.value))}
                        style={{ borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', width: '100px', textAlign: 'right' }}
                        disabled={assets.length === 0}
                    />
                    {broker.currentLiquidity !== undefined && (
                        <div
                            className="allocation-liquidity-hint"
                            style={{ fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer' }}
                            title="Click to set Liquidity to the broker's current cash"
                            onClick={() => setLiquidity(parseFloat((broker.currentLiquidity ?? 0).toFixed(2)))}
                        >
                            (Broker cash: <span style={{ textDecoration: 'underline' }}>€{(broker.currentLiquidity ?? 0).toLocaleString('en-IE', { maximumFractionDigits: 0 })}</span>)
                        </div>
                    )}
                    <button
                        className="btn-primary"
                        style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                        onClick={handleExecuteBuy}
                        disabled={plan.totalSpent <= 0}
                    >
                        Exec Buy
                    </button>
                </div>
            </div>

            {assets.length === 0 ? (
                <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>No holdings at this broker.</p>
            ) : (
                <>
                    <div className="allocation-details" style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                        <div className="allocation-row desktop-only" style={{ fontWeight: 600, color: 'var(--text-muted)', border: 'none' }}>
                            <div style={{ flex: 1 }}>Asset</div>
                            <div style={{ width: '100px', textAlign: 'center' }}>Qty</div>
                            <div style={{ width: '110px', textAlign: 'center' }}>Pmc</div>
                            <div style={{ width: '110px', textAlign: 'center' }}>Mkt Price</div>
                            <div style={{ width: '110px', textAlign: 'center' }}>Value</div>
                            <div style={{ width: '110px', textAlign: 'center' }}>Gain</div>
                            <div style={{ width: '90px', textAlign: 'center' }}>Weight %</div>
                            <div style={{ width: '130px', textAlign: 'center' }}>Buy Only</div>
                            <div style={{ width: '90px', textAlign: 'center' }}>Post Buy %</div>
                        </div>
                        {assets.map(asset => (
                            <BrokerAssetRow
                                key={asset.ticker}
                                label={assetSettings.find(s => s.ticker === asset.ticker)?.label || asset.label || asset.ticker}
                                assetClass={asset.assetClass}
                                quantity={asset.quantity}
                                averagePrice={asset.averagePrice}
                                currentPrice={asset.currentPrice || 0}
                                currentValue={asset.currentValue}
                                gain={asset.gain || 0}
                                gainPerc={asset.gainPercentage || 0}
                                line={planByTicker[asset.ticker]}
                                estFee={planByTicker[asset.ticker] && planByTicker[asset.ticker].shares > 0
                                    ? calculateCommission({ amount: planByTicker[asset.ticker].shares, price: asset.currentPrice || 0, direction: 'Buy' } as Transaction, broker)
                                    : undefined}
                            />
                        ))}
                    </div>
                    {liq > 0 && (
                        <div style={{ marginTop: 'var(--space-3)', fontSize: '0.82rem', color: 'var(--text-muted)', textAlign: 'right' }}>
                            Deploys €{plan.totalSpent.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} of €{liq.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} — leftover €{plan.leftover.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} stays cash
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

interface BrokerAssetRowProps {
    label: string;
    assetClass: string;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    currentValue: number;
    gain: number;
    gainPerc: number;
    line?: BrokerBuyLine;
    estFee?: number;
}

const BrokerAssetRow: React.FC<BrokerAssetRowProps> = ({
    label, assetClass, quantity, averagePrice, currentPrice, currentValue, gain, gainPerc, line, estFee,
}) => {
    const [mExpanded, setMExpanded] = useState(false);
    const colorMap: Record<string, string> = {
        'Stock': 'dot-etf',
        'Bond': 'dot-bond',
        'Commodity': 'dot-commodity',
        'Crypto': 'dot-crypto'
    };
    const colorClass = colorMap[assetClass] || 'dot-neutral';
    const hasPrice = currentPrice > 0;
    const buyEur = line?.eur ?? 0;
    const buyShares = line?.shares ?? 0;

    const buyCell = !hasPrice ? (
        <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>no price</span>
    ) : buyShares > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2', fontWeight: 600, color: 'var(--color-success)' }}>
            <span>Buy {buyShares}</span>
            <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                €{buyEur.toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                {estFee !== undefined && estFee > 0 && (
                    <span style={{ color: 'var(--text-muted)' }}> (fee €{estFee.toFixed(2)})</span>
                )}
            </span>
        </div>
    ) : (
        <span style={{ color: 'var(--text-muted)' }}>-</span>
    );

    return (
        <>
            {/* Desktop */}
            <div className="allocation-row desktop-only" style={{ padding: 'var(--space-3) 0', opacity: hasPrice ? 1 : 0.55 }}>
                <div className="allocation-type" style={{ flex: 1 }}>
                    <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                    <strong>{label}</strong>
                </div>
                <div style={{ width: '100px', textAlign: 'center' }}>{parseFloat(quantity.toFixed(4))}</div>
                <div style={{ width: '110px', textAlign: 'center' }}>€{averagePrice.toFixed(2)}</div>
                <div style={{ width: '110px', textAlign: 'center' }}>{hasPrice ? `€${currentPrice.toFixed(2)}` : '-'}</div>
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
                <div style={{ width: '90px', textAlign: 'center' }}>
                    <div className="allocation-perc">{(line?.currentWeight ?? 0).toFixed(1)}%</div>
                </div>
                <div style={{ width: '130px', textAlign: 'center' }}>{buyCell}</div>
                <div style={{ width: '90px', textAlign: 'center' }}>
                    {buyShares > 0 ? `${(line?.projectedWeight ?? 0).toFixed(1)}%` : <span style={{ color: 'var(--text-muted)' }}>-</span>}
                </div>
            </div>

            {/* Mobile dense expandable row (mrow pattern, styles/mobile-list.css) */}
            <div className={`mobile-only mrow ${mExpanded ? 'is-open' : ''}`} style={{ opacity: hasPrice ? 1 : 0.55 }}>
                <div className="mrow-head" onClick={() => setMExpanded(v => !v)}>
                    <span className="mrow-chevron">▶</span>
                    <div className="mrow-main">
                        <div className="mrow-line1">
                            <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass), flex: '0 0 auto' }} />
                            <span className="mrow-title">{label}</span>
                        </div>
                        <div className="mrow-line2">
                            <span style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)} ({gainPerc.toFixed(1)}%)
                            </span>
                            <span>{(line?.currentWeight ?? 0).toFixed(1)}%</span>
                        </div>
                    </div>
                    <div className="mrow-side">
                        <div className="mrow-side-primary">€{currentValue.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</div>
                        <div className="mrow-side-secondary" style={{ fontWeight: 600, color: buyShares > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                            {!hasPrice ? 'no price' : buyShares > 0
                                ? `Buy ${buyShares} · €${buyEur.toLocaleString('en-IE', { maximumFractionDigits: 0 })}`
                                : '-'}
                        </div>
                    </div>
                </div>
                {mExpanded && (
                    <div className="mrow-details">
                        <div className="mrow-detail">
                            <span className="mrow-label">Qty</span>
                            <span className="mrow-value">{parseFloat(quantity.toFixed(4))}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Pmc</span>
                            <span className="mrow-value">€{averagePrice.toFixed(2)}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Mkt Price</span>
                            <span className="mrow-value">{hasPrice ? `€${currentPrice.toFixed(2)}` : '-'}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Value</span>
                            <span className="mrow-value">€{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Weight</span>
                            <span className="mrow-value">{(line?.currentWeight ?? 0).toFixed(1)}%</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Post Buy %</span>
                            <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>
                                {buyShares > 0 ? `${(line?.projectedWeight ?? 0).toFixed(1)}%` : '-'}
                            </span>
                        </div>
                        {buyShares > 0 && (
                            <div className="mrow-detail mrow-detail--wide">
                                <span className="mrow-label">Buy Only</span>
                                <span className="mrow-value" style={{ color: 'var(--color-success)' }}>
                                    Buy {buyShares} (€{buyEur.toLocaleString('en-IE', { maximumFractionDigits: 0 })})
                                    {estFee !== undefined && estFee > 0 && (
                                        <span style={{ color: 'var(--text-muted)' }}> — fee €{estFee.toFixed(2)}</span>
                                    )}
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    );
};

function getColorForClass(assetClass: string): string {
    switch (assetClass) {
        case 'Stock': return '#3B82F6';
        case 'Bond': return '#10B981';
        case 'Commodity': return '#F59E0B';
        case 'Crypto': return '#8B5CF6';
        case 'Cash': return '#6B7280';
        default: return '#9CA3AF';
    }
}

export default BrokerAllocationSection;
