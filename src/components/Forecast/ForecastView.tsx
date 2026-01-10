import React, { useState, useMemo } from 'react';
import Chart from 'react-apexcharts';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateForecastWithState, type ForecastPortfolioInput } from '../../utils/forecastCalculations';
import { calculatePortfolioPerformance } from '../../utils/portfolioCalculations';

const ForecastView: React.FC = () => {
    const { portfolios, brokers, marketData, transactions } = usePortfolio();

    // Inputs
    const [timeHorizon, setTimeHorizon] = useState<number | ''>('');
    const [monthlyIncome, setMonthlyIncome] = useState<number | ''>('');
    const [monthlyExpenses, setMonthlyExpenses] = useState<number | ''>('');

    // Calculated returns (Read-Only)
    const portfolioPerformance = useMemo(() => {
        const perf: Record<string, { cagr: number; years: number }> = {};

        portfolios.forEach(p => {
            // Filter transactions for this portfolio
            // Note: Currently transaction.portfolioId is the way to link.
            const pTx = transactions.filter(t => t.portfolioId === p.id);
            const { cagr, yearsElapsed } = calculatePortfolioPerformance(pTx, marketData);

            // Fallback for empty/new portfolios to a conservative default?
            // Or just 0.
            perf[p.id] = {
                cagr: isNaN(cagr) ? 0 : cagr,
                years: yearsElapsed
            };
        });

        return perf;
    }, [portfolios, transactions, marketData]);


    // We need to calculate Current Portfolio Value properly.
    // Since `assets` are global, we might need to derive per-portfolio value from transactions + current prices.

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

        // Construct returns map from calculated performance
        const returnsSearchMap: Record<string, number> = {};
        portfolios.forEach(p => {
            returnsSearchMap[p.id] = portfolioPerformance[p.id]?.cagr || 0;
        });

        return calculateForecastWithState(
            inputPortfolios,
            brokers,
            Number(monthlyIncome) || 0,
            Number(monthlyExpenses) || 0,
            Number(timeHorizon) || 10,
            returnsSearchMap
        );
    }, [portfolios, currentPortfolioValues, brokers, monthlyIncome, monthlyExpenses, timeHorizon, portfolioPerformance]);

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
                        onChange={e => setTimeHorizon(e.target.value === '' ? '' : Number(e.target.value))}
                        placeholder="10"
                        style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                    />
                </div>

                <div className="form-group" style={{ marginBottom: '1rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Monthly Income (€)</label>
                    <input
                        type="number"
                        value={monthlyIncome}
                        onChange={e => setMonthlyIncome(e.target.value === '' ? '' : Number(e.target.value))}
                        placeholder="0"
                        style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                    />
                </div>

                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Monthly Expenses (€)</label>
                    <input
                        type="number"
                        value={monthlyExpenses}
                        onChange={e => setMonthlyExpenses(e.target.value === '' ? '' : Number(e.target.value))}
                        placeholder="0"
                        style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                    />
                    <small style={{ color: 'var(--text-tertiary)', fontSize: '0.8rem' }}>For reference/tracking</small>
                </div>

                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>Historical Performance</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {portfolios.map(p => {
                        const perf = portfolioPerformance[p.id] || { cagr: 0, years: 0 };
                        return (
                            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-input)', padding: '0.75rem', borderRadius: 'var(--radius-md)' }}>
                                <div>
                                    <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 500 }}>{p.name}</div>
                                    <div style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
                                        {perf.years < 1 ? 'Last <1 year' : `${perf.years.toFixed(1)} years`}
                                    </div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <div style={{ color: perf.cagr >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>
                                        {perf.cagr > 0 ? '+' : ''}{perf.cagr.toFixed(2)}%
                                    </div>
                                    <div style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>Ann. Return</div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '1rem', fontStyle: 'italic' }}>
                    * Projections use these historical annual returns.
                </div>
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
