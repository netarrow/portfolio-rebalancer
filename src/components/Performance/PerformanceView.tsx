import React, { useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { usePortfolio } from '../../context/PortfolioContext';
import { getPortfolioValueSeries, getNetWorthSeries, getAssetPriceSeries, getCashFlowsByDate, computeTWR } from '../../utils/performanceCalculations';
import '../Dashboard/Dashboard.css';

type RangeKey = '1M' | '6M' | '1Y' | 'MAX';

const RANGE_MONTHS: Record<Exclude<RangeKey, 'MAX'>, number> = { '1M': 1, '6M': 6, '1Y': 12 };

function rangeFrom(range: RangeKey): string | undefined {
    if (range === 'MAX') return undefined;
    const d = new Date();
    d.setMonth(d.getMonth() - RANGE_MONTHS[range]);
    return d.toISOString().slice(0, 10);
}

const PerformanceView: React.FC = () => {
    const { transactions, priceHistory, portfolios, brokers, assetSettings, refreshHistory } = usePortfolio();

    // Scope: 'networth' | 'p:<portfolioId>' | 'a:<ticker>'
    const [scope, setScope] = useState('networth');
    const [range, setRange] = useState<RangeKey>('1Y');
    const [includeLiquidity, setIncludeLiquidity] = useState(true);
    const [returnMode, setReturnMode] = useState<'mwr' | 'twr'>('twr');

    const hasHistory = Object.keys(priceHistory).length > 0;

    const currentLiquidity = useMemo(() => {
        const brokerLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
        const portfolioLiquidity = portfolios.reduce((sum, p) => sum + (p.liquidity || 0), 0);
        return brokerLiquidity + portfolioLiquidity;
    }, [brokers, portfolios]);

    const tickersWithHistory = useMemo(
        () => new Set(Object.keys(priceHistory)),
        [priceHistory]
    );

    const assetOptions = useMemo(() => {
        const tickers = new Set<string>();
        for (const t of Object.keys(priceHistory)) tickers.add(t);
        for (const s of assetSettings) tickers.add(s.ticker.toUpperCase());
        return Array.from(tickers).sort().map(ticker => ({
            ticker,
            label: assetSettings.find(s => s.ticker.toUpperCase() === ticker)?.label || ticker,
        }));
    }, [priceHistory, assetSettings]);

    const from = rangeFrom(range);

    // Series without the liquidity overlay: returns (TWR/MWR) are computed on
    // this one, because a constant cash overlay has no history and would dampen
    // every percentage toward zero.
    const baseSeries = useMemo(() => {
        if (scope === 'networth') {
            return getPortfolioValueSeries(transactions, priceHistory, { from });
        }
        if (scope.startsWith('p:')) {
            return getPortfolioValueSeries(transactions, priceHistory, {
                portfolioId: scope.slice(2),
                from,
            });
        }
        return getAssetPriceSeries(scope.slice(2), priceHistory, { from });
    }, [scope, from, transactions, priceHistory]);

    // Chart series: net worth optionally overlays today's liquidity as a constant.
    const series = useMemo(() => {
        if (scope === 'networth' && includeLiquidity && currentLiquidity !== 0) {
            return getNetWorthSeries(transactions, priceHistory, { from, liquidity: currentLiquidity });
        }
        return baseSeries;
    }, [scope, includeLiquidity, currentLiquidity, baseSeries, transactions, priceHistory, from]);

    const isAssetScope = scope.startsWith('a:');
    const assetHistory = isAssetScope ? priceHistory[scope.slice(2).toUpperCase()] : undefined;
    const assetSource = isAssetScope
        ? assetSettings.find(s => s.ticker.toUpperCase() === scope.slice(2).toUpperCase())?.source
        : undefined;

    // Tickers held in the selected scope but with no price history yet (their
    // value falls back to the last transaction price → a flat line).
    const missingHistoryTickers = useMemo(() => {
        if (isAssetScope) return [];
        const portfolioId = scope.startsWith('p:') ? scope.slice(2) : undefined;
        const tickers = new Set<string>();
        for (const tx of transactions) {
            if (portfolioId && tx.portfolioId !== portfolioId) continue;
            const t = tx.ticker.toUpperCase();
            if (!t.startsWith('_') && !tickersWithHistory.has(t)) tickers.add(t);
        }
        return Array.from(tickers).sort();
    }, [scope, isAssetScope, transactions, tickersWithHistory]);

    // Tickers in scope whose history is the clean price (corso secco): their
    // series value excludes accrued interest, while the Dashboard values them
    // at the tel-quel live price — totals can differ by the accrued part.
    const cleanBasisTickers = useMemo(() => {
        if (isAssetScope) return [];
        const portfolioId = scope.startsWith('p:') ? scope.slice(2) : undefined;
        const tickers = new Set<string>();
        for (const tx of transactions) {
            if (portfolioId && tx.portfolioId !== portfolioId) continue;
            const t = tx.ticker.toUpperCase();
            if (priceHistory[t]?.priceBasis === 'clean') tickers.add(t);
        }
        return Array.from(tickers).sort();
    }, [scope, isAssetScope, transactions, priceHistory]);

    const chartOptions = {
        chart: {
            id: 'performance-chart',
            background: 'transparent',
            toolbar: { show: false },
            animations: { enabled: false },
            zoom: { enabled: true }
        },
        theme: { mode: 'dark' as const },
        colors: ['#3B82F6'],
        fill: {
            type: 'gradient',
            gradient: { shadeIntensity: 0.6, opacityFrom: 0.35, opacityTo: 0.02 }
        },
        dataLabels: { enabled: false },
        stroke: { curve: 'straight' as const, width: 2 },
        xaxis: {
            type: 'datetime' as const,
            labels: { style: { colors: '#9ca3af' } }
        },
        yaxis: {
            labels: {
                formatter: (val: number) => isAssetScope
                    ? `€${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                    : `€${Math.round(val).toLocaleString()}`,
                style: { colors: '#9ca3af' }
            }
        },
        tooltip: {
            theme: 'dark',
            x: { format: 'dd MMM yyyy' },
            y: {
                formatter: (val: number) => `€${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            }
        }
    };

    const chartSeries = [{
        name: scope === 'networth'
            ? 'Net Worth'
            : scope.startsWith('p:')
                ? (portfolios.find(p => p.id === scope.slice(2))?.name || 'Portfolio')
                : scope.slice(2),
        data: series.map(p => ({ x: p.date, y: Math.round(p.value * 100) / 100 }))
    }];

    const firstValue = series[0]?.value ?? 0;
    const lastValue = series[series.length - 1]?.value ?? 0;
    const delta = lastValue - firstValue;
    const deltaPct = firstValue > 0 ? (delta / firstValue) * 100 : 0;

    const twrPct = useMemo(() => {
        if (isAssetScope) return null;
        const portfolioId = scope.startsWith('p:') ? scope.slice(2) : undefined;
        const cashFlows = getCashFlowsByDate(transactions, portfolioId);
        return computeTWR(baseSeries, cashFlows);
    }, [baseSeries, scope, isAssetScope, transactions]);

    // Money-Weighted Return: net gain (value change minus net contributions)
    // over capital deployed (initial value + buys in range). On MAX this matches
    // the Dashboard's "Total Appreciation" (unrealized + realized over total
    // capital invested); distributions are tracked separately in the Dashboard.
    const mwr = useMemo(() => {
        if (isAssetScope || baseSeries.length === 0) return null;
        const portfolioId = scope.startsWith('p:') ? scope.slice(2) : undefined;
        const first = baseSeries[0];
        const last = baseSeries[baseSeries.length - 1];
        let netFlows = 0;
        let buys = 0;
        for (const tx of transactions) {
            if (portfolioId && tx.portfolioId !== portfolioId) continue;
            const direction = tx.direction || 'Buy';
            if (direction !== 'Buy' && direction !== 'Sell') continue;
            const date = (tx.date || '').slice(0, 10);
            if (date <= first.date || date > last.date) continue;
            const cost = (Number(tx.amount) || 0) * (Number(tx.price) || 0);
            if (direction === 'Buy') { netFlows += cost; buys += cost; }
            else netFlows -= cost;
        }
        const gain = last.value - first.value - netFlows;
        const capital = first.value + buys;
        return { gain, pct: capital > 0 ? (gain / capital) * 100 : 0 };
    }, [baseSeries, scope, isAssetScope, transactions]);

    if (!hasHistory) {
        return (
            <div className="dashboard-container">
                <h2 className="section-title">Performance</h2>
                <div style={{
                    background: 'var(--bg-card)', borderRadius: 'var(--radius-md)',
                    padding: '3rem 2rem', textAlign: 'center', color: 'var(--text-secondary)'
                }}>
                    <p style={{ marginBottom: '1rem', fontSize: '1.05rem' }}>
                        No price history yet.
                    </p>
                    <p style={{ marginBottom: '1.5rem', fontSize: '0.9rem' }}>
                        Backfill daily prices from each asset's first purchase date to unlock
                        performance charts. Regular price updates will then keep it growing day by day.
                    </p>
                    <button
                        onClick={() => refreshHistory()}
                        style={{
                            padding: '0.75rem 1.5rem', background: 'var(--color-primary)', color: 'white',
                            border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600
                        }}
                    >
                        ⟳ Update History
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="dashboard-container">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
                <h2 className="section-title" style={{ margin: 0 }}>Performance</h2>
                <button
                    onClick={() => refreshHistory()}
                    style={{
                        padding: '0.4rem 0.9rem', background: 'var(--bg-card)',
                        border: '1px solid var(--color-primary)', color: 'var(--color-primary)',
                        borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem'
                    }}
                >
                    ⟳ Update History
                </button>
            </div>

            {/* Controls */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem' }}>
                <select
                    value={scope}
                    onChange={e => setScope(e.target.value)}
                    style={{
                        padding: '0.5rem 0.75rem', background: 'var(--bg-card)', color: 'var(--text-primary)',
                        border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', minWidth: '220px'
                    }}
                >
                    <option value="networth">Net Worth (all portfolios)</option>
                    <optgroup label="Portfolios">
                        {portfolios.map(p => (
                            <option key={p.id} value={`p:${p.id}`}>{p.name}</option>
                        ))}
                    </optgroup>
                    <optgroup label="Assets">
                        {assetOptions.map(a => (
                            <option key={a.ticker} value={`a:${a.ticker}`}>{a.label}</option>
                        ))}
                    </optgroup>
                </select>

                <div style={{ display: 'flex', gap: '0.25rem' }}>
                    {(['1M', '6M', '1Y', 'MAX'] as RangeKey[]).map(r => (
                        <button
                            key={r}
                            onClick={() => setRange(r)}
                            style={{
                                padding: '0.4rem 0.8rem',
                                background: range === r ? 'var(--color-primary)' : 'var(--bg-card)',
                                color: range === r ? 'white' : 'var(--text-secondary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem'
                            }}
                        >
                            {r}
                        </button>
                    ))}
                </div>

                {scope === 'networth' && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={includeLiquidity}
                            onChange={e => setIncludeLiquidity(e.target.checked)}
                        />
                        Include liquidity (current value, no history)
                    </label>
                )}
            </div>

            {/* Summary */}
            {series.length > 0 && (
                <div style={{ display: 'flex', gap: '2rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
                    <div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Latest ({series[series.length - 1].date})</div>
                        <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '1.3rem' }}>
                            €{lastValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </div>
                    </div>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Change over range</div>
                            {!isAssetScope && (
                                <div style={{ display: 'flex', gap: '0.15rem' }}>
                                    {(['twr', 'mwr'] as const).map(m => (
                                        <button
                                            key={m}
                                            onClick={() => setReturnMode(m)}
                                            title={m === 'mwr'
                                                ? 'Money-Weighted Return: net gain (deposits/withdrawals stripped out) over capital deployed — on MAX it matches the Dashboard\'s Total Appreciation'
                                                : 'Time-Weighted Return: excludes the effect of cash deposits/withdrawals'}
                                            style={{
                                                padding: '0.05rem 0.4rem',
                                                background: returnMode === m ? 'var(--color-primary)' : 'var(--bg-card)',
                                                color: returnMode === m ? 'white' : 'var(--text-secondary)',
                                                border: '1px solid var(--border-color)',
                                                borderRadius: '999px', cursor: 'pointer', fontWeight: 600, fontSize: '0.65rem',
                                                textTransform: 'uppercase'
                                            }}
                                        >
                                            {m}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div style={{
                            color: (isAssetScope || (returnMode === 'mwr' ? mwr === null : twrPct === null)
                                ? delta
                                : returnMode === 'mwr' ? mwr!.gain : twrPct!) >= 0
                                ? 'var(--color-success)' : 'var(--color-danger)',
                            fontWeight: 700, fontSize: '1.3rem'
                        }}>
                            {isAssetScope || (returnMode === 'mwr' ? mwr === null : twrPct === null) ? (
                                <>
                                    {delta >= 0 ? '+' : ''}€{delta.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                    {firstValue > 0 && ` (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%)`}
                                </>
                            ) : returnMode === 'mwr' ? (
                                <>
                                    {mwr!.gain >= 0 ? '+' : ''}€{mwr!.gain.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                    {` (${mwr!.pct >= 0 ? '+' : ''}${mwr!.pct.toFixed(2)}%)`}
                                </>
                            ) : (
                                `${twrPct! >= 0 ? '+' : ''}${twrPct!.toFixed(2)}%`
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Caveat badges */}
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                {isAssetScope && assetHistory?.priceBasis === 'clean' && (
                    <span style={badgeStyle} title="Bond history from Borsa Italiana is the clean price (corso secco), without accrued interest">
                        corso secco
                    </span>
                )}
                {isAssetScope && assetHistory?.granularity === 'M' && (
                    <span style={badgeStyle} title="This source publishes one NAV point per month">monthly NAV</span>
                )}
                {isAssetScope && assetSource === 'CPRAM' && (
                    <span style={badgeStyle} title="No historical source for CPRAM — points accumulate from regular price updates only">
                        snapshots only{assetHistory?.points?.[0] ? ` since ${assetHistory.points[0][0]}` : ''}
                    </span>
                )}
                {!isAssetScope && cleanBasisTickers.length > 0 && (
                    <span style={badgeStyle} title={`Bond history is the clean price (corso secco), without accrued interest: ${cleanBasisTickers.join(', ')} — the Dashboard uses the tel-quel live price, so totals can differ by the accrued part`}>
                        {cleanBasisTickers.length} bond{cleanBasisTickers.length > 1 ? 's' : ''} at corso secco
                    </span>
                )}
                {!isAssetScope && missingHistoryTickers.length > 0 && (
                    <span style={badgeStyle} title={`No price history for: ${missingHistoryTickers.join(', ')} — their value uses the last transaction price`}>
                        {missingHistoryTickers.length} asset{missingHistoryTickers.length > 1 ? 's' : ''} without history
                    </span>
                )}
            </div>

            {series.length === 0 ? (
                <div style={{
                    background: 'var(--bg-card)', borderRadius: 'var(--radius-md)',
                    padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)'
                }}>
                    No data points in the selected range.
                </div>
            ) : (
                <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', padding: '1rem' }}>
                    <Chart options={chartOptions} series={chartSeries} type="area" height={420} />
                </div>
            )}
        </div>
    );
};

const badgeStyle: React.CSSProperties = {
    background: 'rgba(245, 158, 11, 0.15)',
    color: '#f59e0b',
    borderRadius: '999px',
    padding: '0.2rem 0.7rem',
    fontSize: '0.75rem',
    fontWeight: 600,
};

export default PerformanceView;
