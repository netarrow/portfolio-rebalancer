import React, { useMemo, useState } from 'react';
import Chart from 'react-apexcharts';
import { usePortfolio } from '../../context/PortfolioContext';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { getPortfolioValueSeries, getNetWorthSeries, getAssetPriceSeries, getCashFlowsByDate, getAssetDistributionFlows, computeTWR, computeReturnStats, computeDrawdownAnalysis, type PortfolioScope } from '../../utils/performanceCalculations';
import { buildPortfolioTree } from '../../utils/portfolioGroups';
import AssetScopeToggles from '../Layout/AssetScopeToggles';
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
    // Scoped: respects the family/illiquid asset-scope toggles
    const { scopedTransactions: transactions, priceHistory, portfolios, scopedBrokers: brokers, assetSettings, refreshHistory } = usePortfolio();

    // Scope: 'networth' | 'g:<parentId>' | 'p:<portfolioId>' | 'a:<ticker>'
    const [scope, setScope] = useState('networth');
    const [range, setRange] = useState<RangeKey>('1Y');
    const [includeLiquidity, setIncludeLiquidity] = useState(true);
    const [returnMode, setReturnMode] = useState<'mwr' | 'twr'>('twr');
    // Total return (coupons/dividends credited on pay date) vs price-only.
    const [includeDistributions, setIncludeDistributions] = useState(true);
    // Underwater (distance-from-peak) chart under the value chart.
    const [showUnderwater, setShowUnderwater] = useState(false);
    // Annual risk-free rate (%) used for Sharpe; persisted locally.
    const [riskFreeRate, setRiskFreeRate] = useLocalStorage<number>('portfolio_risk_free_rate', 0);

    const hasHistory = Object.keys(priceHistory).length > 0;

    // Parent/child groups, so a group can be measured as the single portfolio
    // it effectively is. Every calculation below is already scope-aware
    // (`PortfolioScope` takes a list of ids), so a group is just the list of
    // its members — no separate code path, and no double counting: the select
    // is single-choice, a group or a member, never both.
    const groups = useMemo(() => buildPortfolioTree(portfolios).groups, [portfolios]);

    /** The portfolios the current scope covers, or undefined for the whole account. */
    const scopeIds = useMemo((): PortfolioScope | undefined => {
        if (scope.startsWith('p:')) return scope.slice(2);
        if (scope.startsWith('g:')) {
            const group = groups.find(g => g.parent.id === scope.slice(2));
            // A group that no longer exists (re-parented while selected) would
            // otherwise silently widen to the whole account.
            return group ? group.members.map(m => m.id) : [];
        }
        return undefined;
    }, [scope, groups]);

    const scopeLabel = useMemo(() => {
        if (scope === 'networth') return 'Net Worth';
        if (scope.startsWith('g:')) {
            const group = groups.find(g => g.parent.id === scope.slice(2));
            return group ? `${group.parent.name} (group)` : 'Group';
        }
        if (scope.startsWith('p:')) {
            return portfolios.find(p => p.id === scope.slice(2))?.name || 'Portfolio';
        }
        return scope.slice(2);
    }, [scope, groups, portfolios]);

    // Broker cash only — single source of truth for liquidity, matching the
    // Dashboard Net Worth card. Per-portfolio liquidity is rebalancing-only and
    // is not overlaid on the net-worth series.
    const currentLiquidity = useMemo(() => {
        return brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
    }, [brokers]);

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
        if (scope.startsWith('a:')) {
            return getAssetPriceSeries(scope.slice(2), priceHistory, { from });
        }
        return getPortfolioValueSeries(transactions, priceHistory, { portfolioId: scopeIds, from });
    }, [scope, scopeIds, from, transactions, priceHistory]);

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
    // A Set rather than a predicate closure: the scope is consulted inside two
    // hot loops, and memoizing the data keeps the React Compiler able to track it.
    // null = no scoping at all, every transaction counts.
    const scopeIdSet = useMemo(() => (
        scopeIds === undefined ? null : new Set(Array.isArray(scopeIds) ? scopeIds : [scopeIds])
    ), [scopeIds]);

    const missingHistoryTickers = useMemo(() => {
        if (isAssetScope) return [];
        const tickers = new Set<string>();
        for (const tx of transactions) {
            if (scopeIdSet && !(tx.portfolioId && scopeIdSet.has(tx.portfolioId))) continue;
            const t = tx.ticker.toUpperCase();
            if (!t.startsWith('_') && !tickersWithHistory.has(t)) tickers.add(t);
        }
        return Array.from(tickers).sort();
    }, [isAssetScope, scopeIdSet, transactions, tickersWithHistory]);

    // Tickers in scope whose history is the clean price (corso secco): their
    // series value excludes accrued interest, while the Dashboard values them
    // at the tel-quel live price — totals can differ by the accrued part.
    const cleanBasisTickers = useMemo(() => {
        if (isAssetScope) return [];
        const tickers = new Set<string>();
        for (const tx of transactions) {
            if (scopeIdSet && !(tx.portfolioId && scopeIdSet.has(tx.portfolioId))) continue;
            const t = tx.ticker.toUpperCase();
            if (priceHistory[t]?.priceBasis === 'clean') tickers.add(t);
        }
        return Array.from(tickers).sort();
    }, [isAssetScope, scopeIdSet, transactions, priceHistory]);

    const chartOptions = {
        chart: {
            id: 'performance-chart',
            background: 'transparent',
            toolbar: { show: false },
            animations: { enabled: false },
            // The chart keeps its initial frame: no drag/wheel/trackpad-pinch
            // zoom, so a scroll gesture over it scrolls the page instead.
            zoom: { enabled: false, allowMouseWheelZoom: false },
            selection: { enabled: false }
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
        name: scopeLabel,
        data: series.map(p => ({ x: p.date, y: Math.round(p.value * 100) / 100 }))
    }];

    const firstValue = series[0]?.value ?? 0;
    const lastValue = series[series.length - 1]?.value ?? 0;
    const delta = lastValue - firstValue;
    const deltaPct = firstValue > 0 ? (delta / firstValue) * 100 : 0;

    const twrPct = useMemo(() => {
        if (isAssetScope) return null;
        const cashFlows = getCashFlowsByDate(transactions, scopeIds, { includeDistributions });
        return computeTWR(baseSeries, cashFlows);
    }, [baseSeries, scopeIds, isAssetScope, transactions, includeDistributions]);

    // Risk metrics on the flow-adjusted return stream: deposits/withdrawals
    // are stripped from daily returns, so a disinvestment doesn't read as a
    // drawdown, while coupons/dividends are credited as return (unless the
    // total-return toggle is off → price-only). Asset scope uses per-unit
    // distribution flows on top of the close-price series.
    const cashFlows = useMemo(() => (
        isAssetScope
            ? (includeDistributions
                ? getAssetDistributionFlows(transactions, scope.slice(2))
                : new Map<string, number>())
            : getCashFlowsByDate(transactions, scopeIds, { includeDistributions })
    ), [scope, scopeIds, isAssetScope, transactions, includeDistributions]);

    const returnStats = useMemo(
        () => computeReturnStats(baseSeries, cashFlows, { riskFreePct: riskFreeRate }),
        [baseSeries, cashFlows, riskFreeRate]
    );

    // Distance from the high-water mark, measured on the same flow-adjusted
    // index: money paid in never sets a new peak and money taken out never digs
    // a drawdown, so these numbers answer "how far am I from my best moment"
    // rather than "how much has my balance changed".
    const drawdown = useMemo(
        () => computeDrawdownAnalysis(baseSeries, cashFlows),
        [baseSeries, cashFlows]
    );

    // Underwater curve: 0% on every new high, negative in between. Same axis
    // as the value chart, so the two read together.
    const underwaterOptions = {
        chart: {
            id: 'underwater-chart',
            background: 'transparent',
            toolbar: { show: false },
            animations: { enabled: false },
            zoom: { enabled: false, allowMouseWheelZoom: false },
            selection: { enabled: false }
        },
        theme: { mode: 'dark' as const },
        colors: ['#ef4444'],
        fill: {
            type: 'gradient',
            gradient: { shadeIntensity: 0.6, opacityFrom: 0.4, opacityTo: 0.03 }
        },
        dataLabels: { enabled: false },
        stroke: { curve: 'straight' as const, width: 2 },
        xaxis: { type: 'datetime' as const, labels: { style: { colors: '#9ca3af' } } },
        yaxis: {
            max: 0,
            labels: { formatter: (val: number) => `${val.toFixed(1)}%`, style: { colors: '#9ca3af' } }
        },
        tooltip: {
            theme: 'dark',
            x: { format: 'dd MMM yyyy' },
            y: { formatter: (val: number) => `${val.toFixed(2)}% from peak` }
        }
    };

    const underwaterSeries = [{
        name: 'From peak',
        data: (drawdown?.curve ?? []).map(p => ({ x: p.date, y: Math.round(p.ddPct * 100) / 100 }))
    }];

    const fmtEur = (v: number) => `€${v.toLocaleString(undefined, { maximumFractionDigits: isAssetScope ? 2 : 0 })}`;
    // 0.005% below the mark still rounds to 0.00%: call that a new high.
    const atNewHigh = !!drawdown && drawdown.currentDrawdownPct > -0.005;

    // Money-Weighted Return: net gain (value change minus net contributions)
    // over capital deployed (initial value + buys in range). On MAX this matches
    // the Dashboard's "Total Appreciation" (unrealized + realized over total
    // capital invested); distributions are tracked separately in the Dashboard.
    const mwr = useMemo(() => {
        if (isAssetScope || baseSeries.length === 0) return null;
        const first = baseSeries[0];
        const last = baseSeries[baseSeries.length - 1];
        let netFlows = 0;
        let buys = 0;
        for (const tx of transactions) {
            if (scopeIdSet && !(tx.portfolioId && scopeIdSet.has(tx.portfolioId))) continue;
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
    }, [baseSeries, isAssetScope, scopeIdSet, transactions]);

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
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    <h2 className="section-title" style={{ margin: 0 }}>Performance</h2>
                    <AssetScopeToggles />
                </div>
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
                    {groups.length > 0 && (
                        <optgroup label="Groups (parent + children)">
                            {groups.map(g => (
                                <option key={g.parent.id} value={`g:${g.parent.id}`}>
                                    {g.parent.name} ({g.members.length} portfolios)
                                </option>
                            ))}
                        </optgroup>
                    )}
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
                        <span title="Anchored to today's broker cash; moves back in time with uninvested sale proceeds, so a sell followed by a re-buy doesn't show as a crash">
                            Include liquidity (anchored to today)
                        </span>
                    </label>
                )}

                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem', cursor: 'pointer' }}>
                    <input
                        type="checkbox"
                        checked={includeDistributions}
                        onChange={e => setIncludeDistributions(e.target.checked)}
                    />
                    <span title="When on, coupons/dividends are credited as return on their pay date (total return). When off, only price movements count (price return).">
                        Total return (incl. coupons/dividends)
                    </span>
                </label>

                {!isAssetScope && (
                    <label
                        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}
                        title="Annual risk-free rate subtracted from the return in the Sharpe ratio (e.g. the yield of a short-term govt bond or overnight deposit). Saved locally."
                    >
                        Risk-free rate
                        <input
                            type="number"
                            step="0.1"
                            value={Number.isFinite(riskFreeRate) ? riskFreeRate : 0}
                            onChange={e => setRiskFreeRate(e.target.value === '' ? 0 : Number(e.target.value))}
                            style={{
                                width: '4.5rem', padding: '0.35rem 0.5rem', background: 'var(--bg-card)',
                                color: 'var(--text-primary)', border: '1px solid var(--border-color)',
                                borderRadius: 'var(--radius-md)', textAlign: 'right'
                            }}
                        />
                        %
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
                                                : 'Time-Weighted Return: excludes the effect of cash deposits/withdrawals; coupons/dividends are counted as return'}
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
                    {returnStats && (
                        <>
                            <div title="Compound annual growth rate of the flow-adjusted (TWR) return stream — deposits and withdrawals excluded">
                                <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Return (ann.)</div>
                                <div style={{ color: returnStats.annualizedReturnPct >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 700, fontSize: '1.3rem' }}>
                                    {returnStats.annualizedReturnPct >= 0 ? '+' : ''}{returnStats.annualizedReturnPct.toFixed(2)}%
                                </div>
                            </div>
                            {returnStats.annualizedVolatilityPct !== null && (
                                <div title="Annualized standard deviation of flow-adjusted returns">
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Volatility (ann.)</div>
                                    <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '1.3rem' }}>
                                        {returnStats.annualizedVolatilityPct.toFixed(2)}%
                                    </div>
                                </div>
                            )}
                            {returnStats.sharpe !== null && (
                                <div title={`Annualized excess return (over the ${riskFreeRate}% risk-free rate) divided by annualized volatility`}>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Sharpe (rf {riskFreeRate}%)</div>
                                    <div style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: '1.3rem' }}>
                                        {returnStats.sharpe.toFixed(2)}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}

            {/* Distance from the high-water mark: gains/losses only, flows removed */}
            {drawdown && (
                <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', padding: '0.9rem 1.1rem', marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
                        <div
                            style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}
                            title="Measured on the flow-adjusted return index, the same one behind TWR: money paid in never sets a new peak and money taken out never digs a drawdown, so only real gains and losses move these numbers."
                        >
                            Distance from peak — {range === 'MAX' ? 'peak over all history' : `peak within the last ${range}`}
                        </div>
                        <button
                            onClick={() => setShowUnderwater(v => !v)}
                            style={{
                                padding: '0.2rem 0.7rem',
                                background: showUnderwater ? 'var(--color-primary)' : 'transparent',
                                color: showUnderwater ? 'white' : 'var(--text-secondary)',
                                border: '1px solid var(--border-color)', borderRadius: '999px',
                                cursor: 'pointer', fontWeight: 600, fontSize: '0.7rem'
                            }}
                            title="Show the underwater curve: how far below the running peak the scope sat on every date"
                        >
                            {showUnderwater ? '▾' : '▸'} Underwater chart
                        </button>
                    </div>

                    <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                        <div title="How far the scope sits below its best moment, deposits and withdrawals excluded.">
                            <div style={ddLabelStyle}>From peak</div>
                            <div style={{ ...ddValueStyle, color: atNewHigh ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {atNewHigh ? 'At new high' : `${drawdown.currentDrawdownPct.toFixed(2)}%`}
                            </div>
                            <div style={ddSubStyle}>
                                {drawdown.peakDate ? `peak on ${drawdown.peakDate}` : ''}
                            </div>
                        </div>

                        <div title={isAssetScope
                            ? 'Gain still needed to get back to the peak, and what it is worth on one unit at today\'s price.'
                            : 'Gain still needed to get back to the peak, and what it is worth on the invested value of today (liquidity excluded) — comparing raw euro against an old peak would be meaningless once the capital changed.'}>
                            <div style={ddLabelStyle}>To recover</div>
                            <div style={{ ...ddValueStyle, color: atNewHigh ? 'var(--text-primary)' : 'var(--color-warning)' }}>
                                {atNewHigh ? '—' : `+${drawdown.recoveryNeededPct.toFixed(2)}%`}
                            </div>
                            <div style={ddSubStyle}>
                                {!atNewHigh && drawdown.recoveryNeededEur !== null
                                    ? `${fmtEur(drawdown.recoveryNeededEur)} to go${isAssetScope ? ' per unit' : ''}`
                                    : 'nothing to recover'}
                            </div>
                        </div>

                        <div title="Days spent below the current high-water mark, and the longest such stretch in the range.">
                            <div style={ddLabelStyle}>Under water</div>
                            <div style={{ ...ddValueStyle, color: drawdown.underwaterDays > 0 ? 'var(--text-primary)' : 'var(--color-success)' }}>
                                {drawdown.underwaterDays} {drawdown.underwaterDays === 1 ? 'day' : 'days'}
                            </div>
                            <div style={ddSubStyle}>longest {drawdown.longestUnderwaterDays}d</div>
                        </div>

                        <div title="Largest peak-to-trough loss in the range, on the same flow-adjusted index.">
                            <div style={ddLabelStyle}>Max drawdown</div>
                            <div style={{ ...ddValueStyle, color: drawdown.maxDrawdownPct < 0 ? 'var(--color-danger)' : 'var(--text-primary)' }}>
                                {drawdown.maxDrawdownPct.toFixed(2)}%
                            </div>
                            <div style={ddSubStyle}>
                                {drawdown.maxDrawdownDate
                                    ? `${drawdown.maxDrawdownPeakDate} → ${drawdown.maxDrawdownDate} · ${drawdown.maxDrawdownRecoveryDate ? `recovered ${drawdown.maxDrawdownRecoveryDate}` : 'not recovered'}`
                                    : 'never below a peak'}
                            </div>
                        </div>
                    </div>

                    {showUnderwater && (
                        <div style={{ marginTop: '0.75rem' }}>
                            <Chart options={underwaterOptions} series={underwaterSeries} type="area" height={180} />
                        </div>
                    )}
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

const ddLabelStyle: React.CSSProperties = {
    color: 'var(--text-muted)',
    fontSize: '0.75rem',
};

const ddValueStyle: React.CSSProperties = {
    fontWeight: 700,
    fontSize: '1.3rem',
    fontVariantNumeric: 'tabular-nums',
};

const ddSubStyle: React.CSSProperties = {
    color: 'var(--text-muted)',
    fontSize: '0.7rem',
    marginTop: '0.1rem',
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
