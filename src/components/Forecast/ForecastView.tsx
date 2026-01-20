import React, { useState, useMemo } from 'react';
import Chart from 'react-apexcharts';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateForecastWithState } from '../../utils/forecastCalculations';
import { calculatePortfolioPerformance, calculateAssets } from '../../utils/portfolioCalculations';
import { getAssetGoal } from '../../utils/goalCalculations';

const EXPENSE_TYPES = ['Growth', 'Protection', 'Security'];

const ForecastView: React.FC = () => {
    const { portfolios, brokers, marketData, transactions, assetSettings } = usePortfolio();

    // Inputs
    const [timeHorizon, setTimeHorizon] = useState<number | ''>('');
    const [monthlyIncome, setMonthlyIncome] = useState<number | ''>('');
    const [monthlyExpenses, setMonthlyExpenses] = useState<number | ''>('');

    // Expense State
    const [yearlyExpenses, setYearlyExpenses] = useState<{
        id: string;
        year: number;
        amount: number;
        description: string;
        allowedTypes: string[];
        erosionAllowed: boolean;
    }[]>([]);

    // New Expense Form
    const [newExpYear, setNewExpYear] = useState<number | ''>('');
    const [newExpAmount, setNewExpAmount] = useState<number | ''>('');
    const [newExpDesc, setNewExpDesc] = useState('');
    const [newExpAllowedTypes, setNewExpAllowedTypes] = useState<string[]>(['Growth', 'Protection', 'Security']);
    const [newExpErosionAllowed, setNewExpErosionAllowed] = useState(false);

    const handleAddExpense = () => {
        if (!newExpYear || !newExpAmount) return;
        setYearlyExpenses([...yearlyExpenses, {
            id: crypto.randomUUID(),
            year: Number(newExpYear),
            amount: Number(newExpAmount),
            description: newExpDesc || 'Expense',
            allowedTypes: newExpAllowedTypes,
            erosionAllowed: newExpErosionAllowed
        }]);
        setNewExpYear('');
        setNewExpAmount('');
        setNewExpDesc('');
        // Reset defaults
        setNewExpAllowedTypes(['Growth', 'Protection', 'Security']);
        setNewExpErosionAllowed(false);
    };

    const handleRemoveExpense = (id: string) => {
        setYearlyExpenses(yearlyExpenses.filter(e => e.id !== id));
    };

    const toggleAllowedType = (type: string) => {
        if (newExpAllowedTypes.includes(type)) {
            setNewExpAllowedTypes(newExpAllowedTypes.filter(t => t !== type));
        } else {
            setNewExpAllowedTypes([...newExpAllowedTypes, type]);
        }
    };

    // Calculated returns (Read-Only)
    const portfolioPerformance = useMemo(() => {
        const perf: Record<string, { cagr: number; years: number }> = {};

        portfolios.forEach(p => {
            const pTx = transactions.filter(t => t.portfolioId === p.id);
            const { cagr, yearsElapsed } = calculatePortfolioPerformance(pTx, marketData);
            perf[p.id] = {
                cagr: isNaN(cagr) ? 0 : cagr,
                years: yearsElapsed
            };
        });

        return perf;
    }, [portfolios, transactions, marketData]);

    const currentPortfolioValues = useMemo(() => {
        const values: Record<string, number> = {};
        portfolios.forEach(p => values[p.id] = 0);

        const portfolioHoldings: Record<string, Record<string, number>> = {};

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

        Object.entries(portfolioHoldings).forEach(([pid, holdings]) => {
            let total = 0;
            Object.entries(holdings).forEach(([ticker, qty]) => {
                const priceData = marketData[ticker] || marketData[ticker.toUpperCase()];
                const price = priceData?.price || 0;
                total += qty * price;
            });
            values[pid] = total;
        });

        return values;
    }, [transactions, marketData, portfolios]);

    // Calculate Primary Goal for each Portfolio
    const portfolioGoals = useMemo(() => {
        const goals: Record<string, string> = {};

        portfolios.forEach(p => {
            const pTx = transactions.filter(t => t.portfolioId === p.id);
            const { assets } = calculateAssets(pTx, assetSettings, marketData);

            // Sum value by Goal
            const goalValues: Record<string, number> = { 'Growth': 0, 'Protection': 0, 'Security': 0 };

            assets.forEach(asset => {
                const goal = getAssetGoal(asset.assetClass, asset.assetSubClass);
                goalValues[goal] = (goalValues[goal] || 0) + asset.currentValue;
            });

            // Find max
            let maxGoal = 'Growth';
            let maxValue = -1;
            Object.entries(goalValues).forEach(([g, v]) => {
                if (v > maxValue) {
                    maxValue = v;
                    maxGoal = g;
                }
            });
            goals[p.id] = maxGoal;
        });

        return goals;
    }, [portfolios, transactions, assetSettings, marketData]);

    // Generate Forecast Data
    const forecastData = useMemo(() => {
        const inputPortfolios = portfolios.map(p => ({
            ...p,
            currentValue: currentPortfolioValues[p.id] || 0,
            primaryGoal: portfolioGoals[p.id]
        }));

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
            returnsSearchMap,
            yearlyExpenses.map(e => ({
                year: e.year,
                amount: e.amount,
                allowedTypes: e.allowedTypes,
                erosionAllowed: e.erosionAllowed
            }))
        );
    }, [portfolios, currentPortfolioValues, brokers, monthlyIncome, monthlyExpenses, timeHorizon, portfolioPerformance, yearlyExpenses, portfolioGoals]);

    // Chart Config
    const chartOptions = {
        chart: {
            id: 'forecast-chart',
            stacked: true,
            background: 'transparent',
            toolbar: { show: false }
        },
        theme: { mode: 'dark' as 'dark' },
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
        colors: undefined,
        fill: { type: 'gradient' },
        dataLabels: { enabled: false },
        stroke: { curve: 'smooth' as 'smooth', width: 2 },
        tooltip: {
            theme: 'dark',
            x: {
                formatter: (val: string, opts: any) => {
                    const data = forecastData[opts.dataPointIndex];
                    if (!data) return val;
                    const flow = Math.round(data.cashflow);
                    const flowStr = flow >= 0 ? `+€${flow.toLocaleString()}` : `-€${Math.abs(flow).toLocaleString()}`;
                    return `${val} | Total: €${Math.round(data.totalValue).toLocaleString()} | Flow: ${flowStr}`;
                }
            },
            y: {
                formatter: (val: number) => `€${Math.round(val).toLocaleString()}`
            }
        }
    };

    const chartSeries = [
        {
            name: 'Total Liquidity',
            data: forecastData.map(d => Math.round(d.liquidityValue))
        },
        ...portfolios.map(p => ({
            name: p.name,
            data: forecastData.map(d => Math.round(d.portfolios[p.id] || 0))
        }))
    ];

    const finalResult = forecastData[forecastData.length - 1] || { totalValue: 0, investedValue: 0, liquidityValue: 0, insolvent: false, ruleBreach: false, failureReason: '' };
    const startValue = forecastData[0]?.totalValue || 0;

    // Find first occurrence of issues
    const insolvencyDetected = forecastData.find(d => d.insolvent);
    const ruleBreachDetected = forecastData.find(d => d.ruleBreach);

    const sustainabilityStatus = useMemo(() => {
        if (!startValue) return { status: 'Unknown', color: 'var(--text-tertiary)', icon: '?' };

        if (insolvencyDetected) {
            return {
                status: 'Failed',
                label: 'Failed - Insolvency',
                tooltip: insolvencyDetected.failureReason,
                color: '#EF4444',
                icon: (
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                        <line x1="12" y1="9" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                )
            };
        }

        if (ruleBreachDetected) {
            return {
                status: 'Risky',
                label: 'Risky - Rule Hazard',
                tooltip: ruleBreachDetected.failureReason,
                color: '#ea580c', // Orange-600
                icon: (
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a10 10 0 1 0 10 10H12V2z"></path>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                )
            };
        }

        const ratio = finalResult.totalValue / startValue;

        if (ratio < 1) {
            return {
                status: 'Failed',
                label: 'Failed - Value Loss',
                color: '#EF4444',
                icon: (
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                    </svg>
                )
            };
        } else if (ratio < 1.05) {
            return {
                status: 'Fragile',
                label: 'Fragile',
                color: '#F59E0B',
                icon: (
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a10 10 0 1 0 10 10H12V2z"></path>
                    </svg>
                )
            };
        } else {
            return {
                status: 'Sustainable',
                label: 'Sustainable',
                color: '#10B981',
                icon: (
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                        <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                )
            };
        }
    }, [startValue, finalResult.totalValue, insolvencyDetected, ruleBreachDetected]);

    return (
        <div className="forecast-container" style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 320px) 1fr 280px', gap: '1.5rem', width: '100%', maxWidth: '100%' }}>
            {/* Sidebar Controls */}
            <div className="forecast-controls card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', height: 'fit-content' }}>
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
                </div>

                <div className="form-group" style={{ marginBottom: '1.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Planned Annual Expenses</label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <input
                            type="number"
                            value={newExpYear}
                            onChange={e => setNewExpYear(e.target.value === '' ? '' : Number(e.target.value))}
                            placeholder="Year (e.g. 5)"
                            style={{ padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)', width: '100%' }}
                        />
                        <input
                            type="number"
                            value={newExpAmount}
                            onChange={e => setNewExpAmount(e.target.value === '' ? '' : Number(e.target.value))}
                            placeholder="Amount (€)"
                            style={{ padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)', width: '100%' }}
                        />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <input
                            type="text"
                            value={newExpDesc}
                            onChange={e => setNewExpDesc(e.target.value)}
                            placeholder="Description (optional)"
                            style={{ padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}
                        />
                    </div>

                    {/* Expense Controls */}
                    <div style={{ marginBottom: '1rem', padding: '0.5rem', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <label style={{ color: 'var(--text-secondary)' }}>Allow Erosion of Liquidity?</label>
                            <input
                                type="checkbox"
                                checked={newExpErosionAllowed}
                                onChange={e => setNewExpErosionAllowed(e.target.checked)}
                            />
                        </div>
                        <label style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Allowed Sources:</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                            {EXPENSE_TYPES.map(type => (
                                <div
                                    key={type}
                                    onClick={() => toggleAllowedType(type)}
                                    style={{
                                        padding: '0.2rem 0.6rem',
                                        borderRadius: '12px',
                                        background: newExpAllowedTypes.includes(type) ? 'var(--color-primary)' : 'var(--bg-card)',
                                        color: newExpAllowedTypes.includes(type) ? 'white' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        border: '1px solid var(--border-color)'
                                    }}
                                >
                                    {type}
                                </div>
                            ))}
                        </div>
                    </div>

                    <button
                        onClick={handleAddExpense}
                        style={{ width: '100%', padding: '0.5rem', background: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', marginBottom: '1rem' }}
                    >
                        Add Expense
                    </button>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {yearlyExpenses.sort((a, b) => a.year - b.year).map(expense => (
                            <div key={expense.id} style={{ background: 'var(--bg-input)', padding: '0.75rem', borderRadius: 'var(--radius-md)', fontSize: '0.9rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                    <div>
                                        <span style={{ fontWeight: 600, color: 'var(--color-accent)' }}>Year {expense.year}</span>
                                        <span style={{ marginLeft: '0.5rem', color: 'var(--text-primary)' }}>€{expense.amount.toLocaleString()}</span>
                                    </div>
                                    <button
                                        onClick={() => handleRemoveExpense(expense.id)}
                                        style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: '1.2rem', padding: '0 0.5rem' }}
                                    >
                                        &times;
                                    </button>
                                </div>
                                {expense.description && <div style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', marginBottom: '0.25rem' }}>{expense.description}</div>}
                                <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-tertiary)', flexWrap: 'wrap' }}>
                                    <span style={{ color: expense.erosionAllowed ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                        {expense.erosionAllowed ? '⚠ Liquidity Eroded' : '🛡 Liquidity Safe'}
                                    </span>
                                    <span>|</span>
                                    <span>{expense.allowedTypes.length === 4 ? 'All Portfolios' : expense.allowedTypes.join(', ')}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '1rem', fontStyle: 'italic' }}>
                    * Projections use historical returns. Expenses deplete specified portfolios if possible.
                </div>
            </div>

            {/* Results Area */}
            <div className="forecast-results" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <div className="summary-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
                    <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', position: 'relative' }}>
                        <div style={{ position: 'absolute', top: '1rem', right: '1rem', color: sustainabilityStatus.color }} title={sustainabilityStatus.label}>
                            {sustainabilityStatus.icon}
                        </div>
                        <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Projected Net Worth</h4>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-primary)' }}>
                            €{Math.round(finalResult.totalValue).toLocaleString()}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: sustainabilityStatus.color, marginTop: '0.25rem', fontWeight: 500 }}>
                            {sustainabilityStatus.label}
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

                <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', flex: 1, minHeight: '400px' }}>
                    <Chart
                        options={chartOptions}
                        series={chartSeries}
                        type="area"
                        height="100%"
                    />
                </div>
            </div>

            {/* Right: Portfolio Performance */}
            <div className="forecast-performance card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', height: 'fit-content' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)' }}>Estimated Returns</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {portfolios.map(p => {
                        const perf = portfolioPerformance[p.id] || { cagr: 0, years: 0 };
                        const goal = portfolioGoals[p.id] || 'Growth';
                        const goalColor = goal === 'Security' ? '#8B5CF6' : goal === 'Protection' ? '#10B981' : '#3B82F6';

                        return (
                            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-input)', padding: '0.75rem', borderRadius: 'var(--radius-md)' }}>
                                <div>
                                    <div style={{ color: 'var(--text-primary)', fontSize: '0.9rem', fontWeight: 500 }}>{p.name}</div>
                                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
                                        <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: '4px', background: goalColor + '20', color: goalColor, border: `1px solid ${goalColor}50` }}>
                                            {goal}
                                        </span>
                                    </div>
                                    <div style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                                        {perf.years < 1 ? '< 1yr data' : `${perf.years.toFixed(1)} yrs data`}
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
                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '1rem', fontStyle: 'italic', lineHeight: '1.4' }}>
                    * Returns based on historical transaction data weighted by time. Used for future projections.
                </div>
            </div>
        </div>
    );
};

export default ForecastView;
