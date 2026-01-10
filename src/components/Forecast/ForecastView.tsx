import React, { useState, useEffect, useMemo } from 'react';
import Chart from 'react-apexcharts';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateForecastWithState, type ForecastPortfolioInput } from '../../utils/forecastCalculations';

const ForecastView: React.FC = () => {
    const { portfolios, brokers, assets, marketData } = usePortfolio();

    // Inputs
    const [timeHorizon, setTimeHorizon] = useState<number>(10);
    const [monthlySavings, setMonthlySavings] = useState<number>(1000);
    const [monthlyExpenses, setMonthlyExpenses] = useState<number>(2000);
    const [portfolioReturns, setPortfolioReturns] = useState<Record<string, number>>({});

    // Initialize default returns if not set
    useEffect(() => {
        if (portfolios.length > 0 && Object.keys(portfolioReturns).length === 0) {
            const defaults: Record<string, number> = {};
            portfolios.forEach(p => {
                defaults[p.id] = 5; // Default 5%
            });
            setPortfolioReturns(defaults);
        }
    }, [portfolios]);

    const handleReturnChange = (id: string, value: number) => {
        setPortfolioReturns(prev => ({
            ...prev,
            [id]: value
        }));
    };

    // Calculate current values for portfolios to pass to forecast
    const enrichedPortfolios: ForecastPortfolioInput[] = useMemo(() => {
        return portfolios.map(p => {
            // Calculate total value of this portfolio based on assets
            // We need a helper or do it here. 
            // Assets need to be filtered by portfolio. 
            // Currently assets don't have explicit portfolio link in `Asset` interface in `index.ts`?
            // Wait, `Asset` is derived from transactions. 
            // Transactions have `portfolioId`. 
            // BUT `Asset` (calculated) doesn't explicitly store `portfolioId`? 
            // Let's check `portfolioCalculations.ts` or just filter transactions again?
            // Less efficient but safer: Filter assets matching transactions of this portfolio?
            // Actually `assets` in context are aggregated by ticker. 
            // If the same ticker is in multiple portfolios, `assets` array merges them?
            // Checking `PortfolioContext.tsx`: `calculateAssets` aggregates by ticker.
            // So `assets` in context are GLOBAL.
            // We need PER PORTFOLIO value.
            // We can re-calculate or just sum `allocations` * `price`? 
            // No, `allocations` are just targets.
            // We need to sum the actual holdings.
            // We should use `transactions` to match portfolioId.
            // But `transactions` is available in context.
            // Let's use `transactions` to sum values.
            return {
                ...p,
                currentValue: 0 // Placeholder, we will calculate below
            };
        });
    }, [portfolios]);

    // We need to calculate Current Portfolio Value properly.
    // Since `assets` are global, we might need to derive per-portfolio value from transactions + current prices.
    const { transactions } = usePortfolio();

    const currentPortfolioValues = useMemo(() => {
        const values: Record<string, number> = {};

        // Initialize
        portfolios.forEach(p => values[p.id] = 0);

        // Group holdings by portfolio
        const portfolioHoldings: Record<string, Record<string, number>> = {}; // pid -> ticker -> qty

        transactions.forEach(t => {
            if (!t.portfolioId) return;
            if (!portfolioHoldings[t.portfolioId]) portfolioHoldings[t.portfolioId] = {};

            const currentQty = portfolioHoldings[t.portfolioId][t.ticker] || 0;
            if (t.direction === 'Buy') {
                portfolioHoldings[t.portfolioId][t.ticker] = currentQty + t.amount;
            } else {
                portfolioHoldings[t.portfolioId][t.ticker] = currentQty - t.amount;
            }
        });

        // Calculate value
        Object.entries(portfolioHoldings).forEach(([pid, holdings]) => {
            let total = 0;
            Object.entries(holdings).forEach(([ticker, qty]) => {
                const priceData = marketData[ticker] || marketData[ticker.toUpperCase()]; // handle case
                const price = priceData?.price || 0;
                // If price is 0, maybe fallback to avg price from transactions? 
                // For forecast, current market value is best.
                total += qty * price;
            });
            values[pid] = total;
        });

        return values;
    }, [transactions, marketData, portfolios]);

    // Generate Forecast Data
    const forecastData = useMemo(() => {
        const inputPortfolios = portfolios.map(p => ({
            ...p,
            currentValue: currentPortfolioValues[p.id] || 0
        }));

        return calculateForecastWithState(
            inputPortfolios,
            brokers,
            monthlySavings,
            timeHorizon,
            portfolioReturns
        );
    }, [portfolios, currentPortfolioValues, brokers, monthlySavings, timeHorizon, portfolioReturns]);

    // Chart Config
    const chartOptions = {
        chart: {
            id: 'forecast-chart',
            stacked: true,
            background: 'transparent',
            toolbar: { show: false }
        },
        theme: { mode: 'dark' as 'dark' }, // Force dark or dynamic? Use context if available
        xaxis: {
            categories: forecastData.map(d => `Year ${Math.ceil(d.month / 12)}`),
            tickAmount: 10,
            labels: { style: { colors: '#9ca3af' } }
        },
        yaxis: {
            labels: {
                formatter: (val: number) => `€${val.toLocaleString()}`,
                style: { colors: '#9ca3af' }
            }
        },
        colors: ['#10b981', '#3b82f6', '#8b5cf6'],
        fill: { type: 'gradient' },
        dataLabels: { enabled: false },
        stroke: { curve: 'smooth' as 'smooth', width: 2 },
        tooltip: { theme: 'dark' }
    };

    const chartSeries = [
        {
            name: 'Total Liquidity',
            data: forecastData.map(d => Math.round(d.liquidityValue))
        },
        {
            name: 'Invested Capital',
            data: forecastData.map(d => Math.round(d.investedValue))
        }
    ];

    const finalResult = forecastData[forecastData.length - 1] || { totalValue: 0, investedValue: 0, liquidityValue: 0 };

    return (
        <div className="forecast-container" style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) 3fr', gap: '2rem' }}>
            {/* Sidebar Controls */}
            <div className="forecast-controls card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1.5rem', color: 'var(--text-primary)' }}>Configuration</h2>

                <div className="form-group" style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Time Horizon (Years)</label>
                    <input
                        type="number"
                        value={timeHorizon}
                        onChange={e => setTimeHorizon(Number(e.target.value))}
                        style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                    />
                </div>

                <div className="form-group" style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Monthly Savings (€)</label>
                    <input
                        type="number"
                        value={monthlySavings}
                        onChange={e => setMonthlySavings(Number(e.target.value))}
                        style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                    />
                </div>

                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Monthly Expenses (€)</label>
                    <input
                        type="number"
                        value={monthlyExpenses}
                        onChange={e => setMonthlyExpenses(Number(e.target.value))}
                        style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                    />
                    <small style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>For reference/tracking</small>
                </div>

                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>Expected Returns (%)</h3>
                {portfolios.map(p => (
                    <div key={p.id} className="form-group" style={{ marginBottom: '0.75rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{p.name}</label>
                        <input
                            type="number"
                            value={portfolioReturns[p.id] || 0}
                            onChange={e => handleReturnChange(p.id, Number(e.target.value))}
                            step="0.1"
                            style={{ width: '100%', padding: '0.4rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                        />
                    </div>
                ))}
            </div>

            {/* Results Area */}
            <div className="forecast-results" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {/* Summary Cards */}
                <div className="summary-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
                    <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                        <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Projected Net Worth</h4>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-primary)' }}>
                            €{Math.round(finalResult.totalValue).toLocaleString()}
                        </div>
                    </div>
                    <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                        <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Invested Total</h4>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-accent)' }}>
                            €{Math.round(finalResult.investedValue).toLocaleString()}
                        </div>
                    </div>
                    <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                        <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Liquidity Total</h4>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#10b981' }}>
                            €{Math.round(finalResult.liquidityValue).toLocaleString()}
                        </div>
                    </div>
                </div>

                {/* Chart */}
                <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', flex: 1, minHeight: '400px' }}>
                    <Chart
                        options={chartOptions}
                        series={chartSeries}
                        type="area"
                        height="100%"
                    />
                </div>
            </div>
        </div>
    );
};

export default ForecastView;
