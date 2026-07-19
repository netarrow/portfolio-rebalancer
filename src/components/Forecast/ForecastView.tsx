import React, { useState, useMemo } from 'react';
import Chart from 'react-apexcharts';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import AssetScopeToggles from '../Layout/AssetScopeToggles';
import { calculateForecastWithState, runMonteCarloForecast, getAssetVolatility } from '../../utils/forecastCalculations';
import { forecastYearForDate } from '../../utils/plannedForecastExpenses';
import { calculatePortfolioPerformance, calculateAssets } from '../../utils/portfolioCalculations';
import {
    computeRealizedVolatility, computeReturnStats, computeFlowAdjustedFactors,
    aggregateMonthlyLogReturns, getPortfolioValueSeries, getCashFlowsByDate
} from '../../utils/performanceCalculations';
import type { ReturnStats } from '../../utils/performanceCalculations';
import { isIncomeDirection } from '../../types';
import type { TransactionDirection } from '../../types';

const ForecastView: React.FC = () => {
    // Scoped: the family/illiquid toggles decide what the forecast simulates
    const { portfolios, scopedBrokers: brokers, marketData, scopedTransactions: transactions, assetSettings, goals, priceHistory,
        plannedForecastExpenses, setPlannedForecastExpenses, restorePlannedForecastExpenses } = usePortfolio();

    // null = never seeded (context auto-imports as soon as forecastable goals exist)
    const ynabPlannedExpenses = plannedForecastExpenses ?? [];

    const sortedGoals = useMemo(() => [...goals].sort((a, b) => a.order - b.order), [goals]);
    const goalTitleById = useMemo(() => {
        const map: Record<string, string> = {};
        goals.forEach(g => { map[g.id] = g.title; });
        return map;
    }, [goals]);

    // Inputs
    const [timeHorizon, setTimeHorizon] = useState<number | ''>('');
    const [monthlyIncome, setMonthlyIncome] = useState<number | ''>('');
    const [monthlyExpenses, setMonthlyExpenses] = useState<number | ''>('');

    // Monte Carlo (volatility) simulation
    const [monteCarloEnabled, setMonteCarloEnabled] = useState(false);
    const [mcSeed, setMcSeed] = useState(12345);
    const [volatilityOverrides, setVolatilityOverrides] = useState<Record<string, number | ''>>({});

    // Contribution strategy: false = momentum (current weights), true = year-0 mix + annual rebalance
    const [rebalanceAnnually, setRebalanceAnnually] = useState(false);

    // Expense State
    const [yearlyExpenses, setYearlyExpenses] = useState<{
        id: string;
        year: number;
        amount: number;
        description: string;
        allowedGoalIds: string[];
        erosionAllowed: boolean;
    }[]>([]);

    // New Expense Form
    const [newExpYear, setNewExpYear] = useState<number | ''>('');
    const [newExpAmount, setNewExpAmount] = useState<number | ''>('');
    const [newExpDesc, setNewExpDesc] = useState('');
    const [newExpAllowedGoalIds, setNewExpAllowedGoalIds] = useState<string[]>(() => goals.map(g => g.id));
    const [newExpErosionAllowed, setNewExpErosionAllowed] = useState(false);

    const handleAddExpense = () => {
        if (!newExpYear || !newExpAmount) return;
        setYearlyExpenses([...yearlyExpenses, {
            id: crypto.randomUUID(),
            year: Number(newExpYear),
            amount: Number(newExpAmount),
            description: newExpDesc || 'Expense',
            allowedGoalIds: newExpAllowedGoalIds,
            erosionAllowed: newExpErosionAllowed
        }]);
        setNewExpYear('');
        setNewExpAmount('');
        setNewExpDesc('');
        // Reset defaults
        setNewExpAllowedGoalIds(goals.map(g => g.id));
        setNewExpErosionAllowed(false);
    };

    const handleRemoveExpense = (id: string) => {
        setYearlyExpenses(yearlyExpenses.filter(e => e.id !== id));
    };

    const toggleAllowedGoal = (goalId: string) => {
        if (newExpAllowedGoalIds.includes(goalId)) {
            setNewExpAllowedGoalIds(newExpAllowedGoalIds.filter(id => id !== goalId));
        } else {
            setNewExpAllowedGoalIds([...newExpAllowedGoalIds, goalId]);
        }
    };

    // YNAB goal expenses (persisted in context; enabled ones join the simulation)
    const toggleYnabExpense = (id: string) => {
        setPlannedForecastExpenses(prev => (prev ?? []).map(e => e.id === id ? { ...e, enabled: !e.enabled } : e));
    };

    const removeYnabExpense = (id: string) => {
        setPlannedForecastExpenses(prev => (prev ?? []).filter(e => e.id !== id));
    };

    const handleRestoreYnabExpenses = async () => {
        const result = await Swal.fire({
            title: 'Restore from YNAB Goals?',
            text: 'The planned expense list will be rebuilt from the current YNAB goals. Removed entries come back and enable/disable flags are reset.',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Restore',
            cancelButtonText: 'Cancel',
        });
        if (!result.isConfirmed) return;
        const rebuilt = restorePlannedForecastExpenses();
        Swal.fire({
            title: 'Restored',
            text: `${rebuilt.length} planned expense${rebuilt.length === 1 ? '' : 's'} imported from YNAB goals.`,
            icon: 'success',
            timer: 2500,
            showConfirmButton: false,
        });
    };

    // Enabled YNAB goal expenses mapped onto the forecast's relative-year scale
    const ynabSimulationExpenses = useMemo(() =>
        (plannedForecastExpenses ?? [])
            .filter(e => e.enabled)
            .map(e => ({
                year: forecastYearForDate(e.targetDate),
                amount: e.amount,
                allowedGoalIds: e.allowedGoalIds,
                allowedGoalLabels: e.allowedGoalIds.map(id => goalTitleById[id] || id),
                erosionAllowed: e.erosionAllowed
            })),
        [plannedForecastExpenses, goalTitleById]);

    // Calculated returns (Read-Only)
    const portfolioPerformance = useMemo(() => {
        const perf: Record<string, { cagr: number; years: number; unrealizedGain: number; realizedGain: number; totalIncome: number; totalGain: number; totalCost: number }> = {};

        portfolios.forEach(p => {
            const pTx = transactions.filter(t => t.portfolioId === p.id);
            const { cagr, yearsElapsed, unrealizedGain, realizedGain, totalIncome, totalGain, totalCost } = calculatePortfolioPerformance(pTx, marketData);
            perf[p.id] = {
                cagr: isNaN(cagr) ? 0 : cagr,
                years: yearsElapsed,
                unrealizedGain: unrealizedGain ?? 0,
                realizedGain: realizedGain ?? 0,
                totalIncome: totalIncome ?? 0,
                totalGain: totalGain ?? 0,
                totalCost: totalCost ?? 0,
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
            if (isIncomeDirection(t.direction as TransactionDirection)) return;
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

    // Historical calibration from the Performance data: per-portfolio monthly
    // flow-adjusted log-returns (bootstrap source), per-portfolio risk stats
    // (realized volatility, max drawdown) and the whole-account historical max
    // drawdown used as the stress reference.
    const historicalCalibration = useMemo(() => {
        const monthlyLogReturns: Record<string, number[]> = {};
        const stats: Record<string, ReturnStats | null> = {};
        portfolios.forEach(p => {
            const series = getPortfolioValueSeries(transactions, priceHistory, { portfolioId: p.id });
            const flows = getCashFlowsByDate(transactions, p.id);
            const { factors, dates } = computeFlowAdjustedFactors(series, flows);
            monthlyLogReturns[p.id] = aggregateMonthlyLogReturns(factors, dates);
            stats[p.id] = computeReturnStats(series, flows);
        });
        const netWorthSeries = getPortfolioValueSeries(transactions, priceHistory, {});
        const netWorthStats = computeReturnStats(netWorthSeries, getCashFlowsByDate(transactions));
        return {
            monthlyLogReturns,
            stats,
            netWorthMaxDrawdownPct: netWorthStats?.maxDrawdownPct ?? null,
        };
    }, [portfolios, transactions, priceHistory]);

    // Estimated volatility for each Portfolio. First choice: the realized
    // flow-adjusted volatility of the portfolio's own value series (same number
    // shown in Performance). Fallback: value-weighted per-ticker estimate —
    // downloaded volatility, else per-ticker realized, else asset-class figure.
    const estimatedVolatilities = useMemo(() => {
        const volatilities: Record<string, number> = {};

        portfolios.forEach(p => {
            const realized = historicalCalibration.stats[p.id]?.annualizedVolatilityPct;
            if (realized != null && realized > 0) {
                volatilities[p.id] = realized;
                return;
            }

            const pTx = transactions.filter(t => t.portfolioId === p.id);
            const { assets } = calculateAssets(pTx, assetSettings, marketData);

            let totalValue = 0;
            let weightedVol = 0;

            assets.forEach(asset => {
                if (asset.currentValue > 0) {
                    const md = marketData[asset.ticker] || marketData[asset.ticker.toUpperCase()];
                    const vol =
                        (md?.volatility != null ? md.volatility : null)
                        ?? computeRealizedVolatility(priceHistory[asset.ticker.toUpperCase()])
                        ?? getAssetVolatility(asset.assetClass, asset.assetSubClass);
                    totalValue += asset.currentValue;
                    weightedVol += asset.currentValue * vol;
                }
            });

            volatilities[p.id] = totalValue > 0 ? weightedVol / totalValue : 0;
        });

        return volatilities;
    }, [portfolios, transactions, assetSettings, marketData, priceHistory, historicalCalibration]);

    // Generate Forecast Data
    const forecastData = useMemo(() => {
        const inputPortfolios = portfolios.map(p => ({
            ...p,
            currentValue: currentPortfolioValues[p.id] || 0
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
            [
                ...yearlyExpenses.map(e => ({
                    year: e.year,
                    amount: e.amount,
                    allowedGoalIds: e.allowedGoalIds,
                    allowedGoalLabels: e.allowedGoalIds.map(id => goalTitleById[id] || id),
                    erosionAllowed: e.erosionAllowed
                })),
                ...ynabSimulationExpenses
            ],
            undefined,
            { rebalanceToInitialWeights: rebalanceAnnually }
        );
    }, [portfolios, currentPortfolioValues, brokers, monthlyIncome, monthlyExpenses, timeHorizon, portfolioPerformance, yearlyExpenses, ynabSimulationExpenses, goalTitleById, rebalanceAnnually]);

    // Effective volatility per portfolio (manual override wins over the estimate)
    const effectiveVolatilities = useMemo(() => {
        const vols: Record<string, number> = {};
        portfolios.forEach(p => {
            const override = volatilityOverrides[p.id];
            vols[p.id] = override !== undefined && override !== '' ? Number(override) : (estimatedVolatilities[p.id] || 0);
        });
        return vols;
    }, [portfolios, volatilityOverrides, estimatedVolatilities]);

    // Monte Carlo simulation (only when enabled)
    const monteCarloData = useMemo(() => {
        if (!monteCarloEnabled) return null;

        const inputPortfolios = portfolios.map(p => ({
            ...p,
            currentValue: currentPortfolioValues[p.id] || 0
        }));

        const returnsMap: Record<string, number> = {};
        portfolios.forEach(p => {
            returnsMap[p.id] = portfolioPerformance[p.id]?.cagr || 0;
        });

        return runMonteCarloForecast(
            inputPortfolios,
            brokers,
            Number(monthlyIncome) || 0,
            Number(monthlyExpenses) || 0,
            Number(timeHorizon) || 10,
            returnsMap,
            effectiveVolatilities,
            [
                ...yearlyExpenses.map(e => ({
                    year: e.year,
                    amount: e.amount,
                    allowedGoalIds: e.allowedGoalIds,
                    allowedGoalLabels: e.allowedGoalIds.map(id => goalTitleById[id] || id),
                    erosionAllowed: e.erosionAllowed
                })),
                ...ynabSimulationExpenses
            ],
            500,
            mcSeed,
            { rebalanceToInitialWeights: rebalanceAnnually },
            {
                monthlyLogReturnsByPortfolio: historicalCalibration.monthlyLogReturns,
                // A manual volatility override means the user wants the
                // lognormal model driven by that number, not the history.
                forceLognormal: portfolios
                    .filter(p => volatilityOverrides[p.id] !== undefined && volatilityOverrides[p.id] !== '')
                    .map(p => p.id),
                historicalMaxDrawdownPct: historicalCalibration.netWorthMaxDrawdownPct,
            }
        );
    }, [monteCarloEnabled, portfolios, currentPortfolioValues, brokers, monthlyIncome, monthlyExpenses, timeHorizon, portfolioPerformance, yearlyExpenses, ynabSimulationExpenses, goalTitleById, effectiveVolatilities, mcSeed, rebalanceAnnually, historicalCalibration, volatilityOverrides]);

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

    // Monte Carlo chart: percentile bands (10-90, 25-75) + median line
    const mcChartOptions = {
        chart: {
            id: 'forecast-mc-chart',
            background: 'transparent',
            toolbar: { show: false },
            animations: { enabled: false }
        },
        theme: { mode: 'dark' as const },
        colors: ['#3B82F6', '#3B82F6', '#10B981'],
        fill: { opacity: [0.18, 0.35, 1] },
        stroke: { curve: 'straight' as const, width: [0, 0, 2.5] },
        dataLabels: { enabled: false },
        legend: { labels: { colors: '#9ca3af' } },
        xaxis: {
            type: 'numeric' as const,
            tickAmount: 10,
            labels: {
                formatter: (val: string) => `Year ${Math.ceil(Number(val) / 12)}`,
                style: { colors: '#9ca3af' }
            }
        },
        yaxis: {
            labels: {
                formatter: (val: number) => `€${Math.round(val).toLocaleString()}`,
                style: { colors: '#9ca3af' }
            }
        },
        tooltip: {
            theme: 'dark',
            shared: true,
            x: {
                formatter: (val: number) => {
                    const year = Math.ceil(val / 12);
                    const monthInYear = ((val - 1) % 12) + 1;
                    return `Year ${year}, Month ${monthInYear}`;
                }
            },
            y: {
                formatter: (val: number) => (val !== null && val !== undefined ? `€${Math.round(val).toLocaleString()}` : '')
            }
        }
    };

    const mcChartSeries = monteCarloData ? [
        {
            type: 'rangeArea',
            name: '10th–90th percentile',
            data: monteCarloData.months.map((m, i) => ({
                x: m,
                y: [Math.round(monteCarloData.p10[i]), Math.round(monteCarloData.p90[i])]
            }))
        },
        {
            type: 'rangeArea',
            name: '25th–75th percentile',
            data: monteCarloData.months.map((m, i) => ({
                x: m,
                y: [Math.round(monteCarloData.p25[i]), Math.round(monteCarloData.p75[i])]
            }))
        },
        {
            type: 'line',
            name: 'Median',
            data: monteCarloData.months.map((m, i) => ({
                x: m,
                y: Math.round(monteCarloData.p50[i])
            }))
        }
    ] : [];

    const finalResult = forecastData[forecastData.length - 1] || { totalValue: 0, investedValue: 0, liquidityValue: 0, insolvent: false, ruleBreach: false, failureReason: '' };
    const startValue = forecastData[0]?.totalValue || 0;

    // Find first occurrence of issues
    const insolvencyDetected = forecastData.find(d => d.insolvent);
    const ruleBreachDetected = forecastData.find(d => d.ruleBreach);

    const sustainabilityStatus = useMemo(() => {
        if (!startValue) return { status: 'Unknown', color: 'var(--text-tertiary)', icon: '?' };

        // Monte Carlo mode: judge by probability of success across simulations
        if (monteCarloData) {
            const prob = monteCarloData.successProbability;
            const probPct = `${Math.round(prob * 100)}% of simulations succeed · median max drawdown ${monteCarloData.maxDrawdownP50.toFixed(1)}% (worst 10%: ${monteCarloData.maxDrawdownP90.toFixed(1)}%)`;
            if (prob >= 0.85) {
                return {
                    status: 'Sustainable',
                    label: 'Sustainable',
                    tooltip: probPct,
                    color: '#10B981',
                    icon: (
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                            <polyline points="22 4 12 14.01 9 11.01"></polyline>
                        </svg>
                    )
                };
            } else if (prob >= 0.6) {
                return {
                    status: 'Fragile',
                    label: 'Fragile',
                    tooltip: probPct,
                    color: '#F59E0B',
                    icon: (
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a10 10 0 1 0 10 10H12V2z"></path>
                        </svg>
                    )
                };
            }
            return {
                status: 'Failed',
                label: 'At Risk',
                tooltip: probPct,
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
    }, [startValue, finalResult.totalValue, insolvencyDetected, ruleBreachDetected, monteCarloData]);

    return (
        <div className="forecast-container" style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 320px) 1fr 280px', gap: '1.5rem', width: '100%', maxWidth: '100%' }}>
            {/* Sidebar Controls */}
            <div className="forecast-controls" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', height: 'fit-content' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)' }}>Configuration</h2>

                <AssetScopeToggles style={{ marginBottom: '1rem' }} />

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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                        <label style={{ color: 'var(--text-secondary)' }}>Annual Rebalance (Year-0 Mix)</label>
                        <input
                            type="checkbox"
                            checked={rebalanceAnnually}
                            onChange={e => setRebalanceAnnually(e.target.checked)}
                        />
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {rebalanceAnnually
                            ? 'Contributions follow the starting mix; invested total rebalanced to it yearly.'
                            : 'Contributions follow current weights — winners attract more new money (momentum).'}
                    </div>
                </div>

                <div className="form-group" style={{ marginBottom: '1.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <label style={{ color: 'var(--text-secondary)' }}>Monte Carlo (Volatility)</label>
                        <input
                            type="checkbox"
                            checked={monteCarloEnabled}
                            onChange={e => setMonteCarloEnabled(e.target.checked)}
                        />
                    </div>
                    {monteCarloEnabled && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                                500 simulations, percentile bands
                            </span>
                            <button
                                onClick={() => setMcSeed(Math.floor(Math.random() * 1_000_000))}
                                title="Re-roll simulations"
                                style={{ padding: '0.2rem 0.6rem', background: 'var(--bg-input)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '0.8rem' }}
                            >
                                ↻ Re-roll
                            </button>
                        </div>
                    )}
                </div>

                <div className="form-group" style={{ marginBottom: '1.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Planned Annual Expenses</label>
                    <div className="forecast-expense-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.5rem' }}>
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
                        <label style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Allowed Goals (linked portfolios):</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                            {sortedGoals.map(goal => (
                                <div
                                    key={goal.id}
                                    onClick={() => toggleAllowedGoal(goal.id)}
                                    style={{
                                        padding: '0.2rem 0.6rem',
                                        borderRadius: '12px',
                                        background: newExpAllowedGoalIds.includes(goal.id) ? 'var(--color-primary)' : 'var(--bg-card)',
                                        color: newExpAllowedGoalIds.includes(goal.id) ? 'white' : 'var(--text-secondary)',
                                        cursor: 'pointer',
                                        border: '1px solid var(--border-color)'
                                    }}
                                >
                                    {goal.title}
                                </div>
                            ))}
                        </div>
                        {sortedGoals.length === 0 ? (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.35rem' }}>
                                No goals defined — the expense can draw from all portfolios.
                            </div>
                        ) : newExpAllowedGoalIds.length === 0 && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.35rem' }}>
                                No goal selected — the expense can draw from all portfolios.
                            </div>
                        )}
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
                                    <span>
                                        {expense.allowedGoalIds.length === 0 || expense.allowedGoalIds.length === goals.length
                                            ? 'All Portfolios'
                                            : expense.allowedGoalIds.map(id => goalTitleById[id] || id).join(', ')}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="form-group" style={{ marginBottom: '1.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <label style={{ color: 'var(--text-secondary)' }}>YNAB Goal Expenses</label>
                        <button
                            onClick={handleRestoreYnabExpenses}
                            title="Rebuild this list from the current YNAB goals"
                            style={{ padding: '0.2rem 0.6rem', background: 'var(--bg-input)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '0.8rem' }}
                        >
                            ↻ Restore from YNAB
                        </button>
                    </div>
                    {ynabPlannedExpenses.length === 0 ? (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                            No YNAB goal expenses in the plan. Goals with a target amount and date are imported automatically; use Restore to re-import them.
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {ynabPlannedExpenses.map(expense => {
                                const year = forecastYearForDate(expense.targetDate);
                                const beyondHorizon = year > (Number(timeHorizon) || 10);
                                return (
                                    <div key={expense.id} style={{ background: 'var(--bg-input)', padding: '0.75rem', borderRadius: 'var(--radius-md)', fontSize: '0.9rem', opacity: expense.enabled ? 1 : 0.55 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={expense.enabled}
                                                    onChange={() => toggleYnabExpense(expense.id)}
                                                    title={expense.enabled ? 'Enabled in simulation — click to disable' : 'Disabled — click to include in simulation'}
                                                />
                                                <div>
                                                    <span style={{ fontWeight: 600, color: 'var(--color-accent)' }}>Year {year}</span>
                                                    <span style={{ marginLeft: '0.5rem', color: 'var(--text-primary)' }}>€{expense.amount.toLocaleString()}</span>
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => removeYnabExpense(expense.id)}
                                                title="Remove from the plan (Restore re-imports it)"
                                                style={{ background: 'none', border: 'none', color: 'var(--color-danger)', cursor: 'pointer', fontSize: '1.2rem', padding: '0 0.5rem' }}
                                            >
                                                &times;
                                            </button>
                                        </div>
                                        <div style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem', marginBottom: '0.25rem' }}>
                                            {expense.description}
                                        </div>
                                        <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-tertiary)', flexWrap: 'wrap' }}>
                                            <span>🎯 {expense.targetDate}</span>
                                            <span>|</span>
                                            <span>
                                                {expense.allowedGoalIds.length === 0
                                                    ? 'All Portfolios'
                                                    : expense.allowedGoalIds.map(id => goalTitleById[id] || id).join(', ')}
                                            </span>
                                            {beyondHorizon && (
                                                <>
                                                    <span>|</span>
                                                    <span style={{ color: 'var(--color-warning, #F59E0B)' }}>⚠ Beyond horizon — not simulated</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '1rem', fontStyle: 'italic' }}>
                    * Projections use historical returns. Expenses deplete only the portfolios linked to the allowed Goals; other portfolios are touched only if those are insufficient (flagged as risk).
                    {monteCarloEnabled && ' Monte Carlo prefers each portfolio\'s real monthly returns (Performance history) via block bootstrap — preserving fat tails and drawdown streaks; with too little history (or a manual σ) it falls back to lognormal sampling. Volatility defaults to the realized flow-adjusted figure and can be overridden per portfolio.'}
                </div>
            </div>

            {/* Results Area */}
            <div className="forecast-results" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                <div className="summary-grid forecast-summary-grid" style={{ display: 'grid', gridTemplateColumns: monteCarloData ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)', gap: '1rem' }}>
                    <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', position: 'relative' }}>
                        <div style={{ position: 'absolute', top: '1rem', right: '1rem', color: sustainabilityStatus.color }} title={sustainabilityStatus.tooltip || sustainabilityStatus.label}>
                            {sustainabilityStatus.icon}
                        </div>
                        <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                            {monteCarloData ? 'Projected Net Worth (Median)' : 'Projected Net Worth'}
                        </h4>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-primary)' }}>
                            €{Math.round(monteCarloData ? monteCarloData.finalP50 : finalResult.totalValue).toLocaleString()}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: sustainabilityStatus.color, marginTop: '0.25rem', fontWeight: 500 }}>
                            {sustainabilityStatus.label}
                        </div>
                    </div>
                    {monteCarloData ? (
                        <>
                            <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                                <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Pessimistic / Optimistic</h4>
                                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--color-accent)' }}>
                                    €{Math.round(monteCarloData.finalP10).toLocaleString()} – €{Math.round(monteCarloData.finalP90).toLocaleString()}
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                                    10th – 90th percentile
                                </div>
                            </div>
                            <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                                <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Success Probability</h4>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: monteCarloData.successProbability >= 0.85 ? '#10b981' : monteCarloData.successProbability >= 0.6 ? '#F59E0B' : '#EF4444' }}>
                                    {Math.round(monteCarloData.successProbability * 100)}%
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                                    {monteCarloData.insolvencyProbability > 0
                                        ? `${Math.round(monteCarloData.insolvencyProbability * 100)}% runs hit insolvency`
                                        : `${monteCarloData.simulations} runs ending above start value`}
                                </div>
                            </div>
                            <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}
                                title="Deepest peak-to-trough dip of the simulated net-worth paths (cashflows included). Compared against the historical max drawdown of your whole account from the Performance data.">
                                <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Max Drawdown (sim.)</h4>
                                <div style={{
                                    fontSize: '1.5rem', fontWeight: 700,
                                    color: (() => {
                                        const p90 = monteCarloData.maxDrawdownP90;
                                        const hist = monteCarloData.historicalMaxDrawdownPct;
                                        if (hist !== null && hist < 0) {
                                            if (p90 >= hist) return '#10b981';
                                            if (p90 >= hist * 1.5) return '#F59E0B';
                                            return '#EF4444';
                                        }
                                        return p90 > -20 ? '#10b981' : p90 > -35 ? '#F59E0B' : '#EF4444';
                                    })()
                                }}>
                                    {monteCarloData.maxDrawdownP50.toFixed(1)}%
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                                    median · worst 10%: {monteCarloData.maxDrawdownP90.toFixed(1)}%
                                    {monteCarloData.probExceedHistoricalMaxDD !== null && (
                                        <>
                                            <br />
                                            {Math.round(monteCarloData.probExceedHistoricalMaxDD * 100)}% of runs deeper than historical ({monteCarloData.historicalMaxDrawdownPct!.toFixed(1)}%)
                                        </>
                                    )}
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
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
                        </>
                    )}
                </div>

                <div className="card forecast-chart-card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', flex: 1, minHeight: '400px' }}>
                    {monteCarloData ? (
                        <Chart
                            key="mc"
                            options={mcChartOptions}
                            series={mcChartSeries}
                            type="rangeArea"
                            height="100%"
                        />
                    ) : (
                        <Chart
                            key="det"
                            options={chartOptions}
                            series={chartSeries}
                            type="area"
                            height="100%"
                        />
                    )}
                </div>
            </div>

            {/* Right: Portfolio Performance */}
            <div className="forecast-performance" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', height: 'fit-content' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)' }}>Estimated Returns</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {portfolios.map(p => {
                        const perf = portfolioPerformance[p.id] || { cagr: 0, years: 0, unrealizedGain: 0, realizedGain: 0, totalIncome: 0, totalGain: 0, totalCost: 0 };
                        const goal = (p.goalId && goalTitleById[p.goalId]) || 'No goal';
                        const goalColor = goal === 'No goal' ? '#6B7280' : goal === 'Security' ? '#8B5CF6' : goal === 'Protection' ? '#10B981' : '#3B82F6';
                        const hasRealized = perf.realizedGain !== 0 || perf.totalIncome !== 0;
                        const fmt = (n: number) => n.toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

                        return (
                            <div key={p.id} style={{ background: 'var(--bg-input)', padding: '0.75rem', borderRadius: 'var(--radius-md)' }}>
                                {/* Header row */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
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
                                        <div style={{ color: perf.cagr >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600, fontSize: '1rem' }}>
                                            {perf.cagr > 0 ? '+' : ''}{perf.cagr.toFixed(2)}%
                                        </div>
                                        <div style={{ color: 'var(--text-tertiary)', fontSize: '0.72rem' }}>Ann. Return</div>
                                        {perf.totalCost > 0 && (
                                            <div style={{ color: perf.totalGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)', fontSize: '0.72rem', marginTop: '0.15rem' }}>
                                                {perf.totalGain >= 0 ? '+' : ''}€{fmt(perf.totalGain)}
                                                <span style={{ color: 'var(--text-tertiary)', marginLeft: 3 }}>
                                                    ({perf.totalCost > 0 ? ((perf.totalGain / perf.totalCost) * 100).toFixed(1) : '0.0'}%)
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Volatility input + sampling model — only relevant in Monte Carlo mode */}
                                {monteCarloEnabled && (() => {
                                    const histMonths = historicalCalibration.monthlyLogReturns[p.id]?.length || 0;
                                    const histStats = historicalCalibration.stats[p.id];
                                    const model = monteCarloData?.modelByPortfolio[p.id]
                                        ?? (histMonths >= 10 && (volatilityOverrides[p.id] === undefined || volatilityOverrides[p.id] === '') ? 'bootstrap' : 'lognormal');
                                    return (
                                        <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.35rem', fontSize: '0.75rem' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span style={{ color: 'var(--text-tertiary)' }}>Volatility (σ ann.)</span>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        step={0.5}
                                                        value={volatilityOverrides[p.id] ?? ''}
                                                        placeholder={(estimatedVolatilities[p.id] || 0).toFixed(1)}
                                                        onChange={e => setVolatilityOverrides({
                                                            ...volatilityOverrides,
                                                            [p.id]: e.target.value === '' ? '' : Number(e.target.value)
                                                        })}
                                                        style={{ width: '64px', padding: '0.25rem 0.4rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: '0.75rem', textAlign: 'right' }}
                                                    />
                                                    <span style={{ color: 'var(--text-tertiary)' }}>%</span>
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                                                title={model === 'bootstrap'
                                                    ? `Future months are resampled in blocks from this portfolio's ${histMonths} real monthly returns (Performance history), preserving streaks of bad months.`
                                                    : 'Not enough monthly history (or manual σ set): returns are drawn from a lognormal distribution with the volatility above.'}>
                                                <span style={{ color: 'var(--text-tertiary)' }}>MC model</span>
                                                <span style={{
                                                    padding: '0.1rem 0.4rem', borderRadius: '4px', fontSize: '0.65rem',
                                                    background: model === 'bootstrap' ? '#10B98120' : '#6B728020',
                                                    color: model === 'bootstrap' ? '#10B981' : 'var(--text-secondary)',
                                                    border: `1px solid ${model === 'bootstrap' ? '#10B98150' : 'var(--border-color)'}`
                                                }}>
                                                    {model === 'bootstrap' ? `Historical (${histMonths} mo)` : 'Lognormal'}
                                                </span>
                                            </div>
                                            {histStats && (
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                                                    title="Realized max drawdown of this portfolio's flow-adjusted return index (same as Performance).">
                                                    <span style={{ color: 'var(--text-tertiary)' }}>Hist. Max DD</span>
                                                    <span style={{ color: histStats.maxDrawdownPct < 0 ? 'var(--color-danger)' : 'var(--text-secondary)' }}>
                                                        {histStats.maxDrawdownPct.toFixed(1)}%
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })()}

                                {/* P/L breakdown — shown when there are realized gains or income */}
                                {hasRealized && (
                                    <div style={{ marginTop: '0.6rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                                            <span style={{ color: 'var(--text-tertiary)' }}>Unrealized P/L</span>
                                            <span style={{ color: perf.unrealizedGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                                {perf.unrealizedGain >= 0 ? '+' : ''}€{fmt(perf.unrealizedGain)}
                                            </span>
                                        </div>
                                        {perf.realizedGain !== 0 && (
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                                                <span style={{ color: 'var(--text-tertiary)' }}>Realized P/L</span>
                                                <span style={{ color: perf.realizedGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                                    {perf.realizedGain >= 0 ? '+' : ''}€{fmt(perf.realizedGain)}
                                                </span>
                                            </div>
                                        )}
                                        {perf.totalIncome !== 0 && (
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                                                <span style={{ color: 'var(--text-tertiary)' }}>Income (Div/Coup)</span>
                                                <span style={{ color: 'var(--color-success)' }}>
                                                    +€{fmt(perf.totalIncome)}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-tertiary)', marginTop: '1rem', fontStyle: 'italic', lineHeight: '1.4' }}>
                    * Ann. Return is calculated on total capital deployed including realized gains from closed positions.
                </div>
            </div>
        </div>
    );
};

export default ForecastView;
