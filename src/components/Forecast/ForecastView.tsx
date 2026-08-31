import React, { useState, useMemo, useRef, useLayoutEffect } from 'react';
import Chart from 'react-apexcharts';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import AssetScopeToggles from '../Layout/AssetScopeToggles';
import { calculateForecastWithState, runMonteCarloForecast, runMonteCarloScenario, getAssetVolatility } from '../../utils/forecastCalculations';
import type { ForecastResult } from '../../utils/forecastCalculations';
import { buildCashflowTable } from '../../utils/forecastCashflow';
import type { CashflowGranularity } from '../../utils/forecastCashflow';
import ForecastCashflowTable from './ForecastCashflowTable';
import { forecastYearForDate } from '../../utils/plannedForecastExpenses';
import { calculatePortfolioPerformance, calculateAssets } from '../../utils/portfolioCalculations';
import {
    computeRealizedVolatility, computeReturnStats, computeFlowAdjustedFactors,
    aggregateMonthlyLogReturns, getPortfolioValueSeries, getCashFlowsByDate
} from '../../utils/performanceCalculations';
import type { ReturnStats } from '../../utils/performanceCalculations';
import {
    computeForecastCashflow, DEFAULT_FORECAST_EXPENSE_MACROS,
    MACRO_ORDER, MACRO_LABELS, MACRO_DESCRIPTIONS
} from '../../utils/spendingAnalysis';
import { isIncomeDirection } from '../../types';
import type { TransactionDirection, YnabMacroCategory } from '../../types';

// Household source a YNAB budget's income and expenses count as, when no
// person is assigned to it.
const FAMILY_SOURCE = 'family';

// Breathing room left under the chart so it stops just short of the fold.
const CHART_BOTTOM_GAP = 24;

// Segmented control button (chart/table, scenario, granularity).
const segButtonStyle = (active: boolean): React.CSSProperties => ({
    padding: '0.3rem 0.7rem',
    background: active ? 'var(--color-primary)' : 'var(--bg-card)',
    color: active ? 'white' : 'var(--text-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.75rem',
});

// Chip row picking which Goals — and so which portfolios — an expense may draw
// from. Used both by the new-expense form and by the already-planned expenses.
const AllowedGoalsChips: React.FC<{
    goals: { id: string; title: string }[];
    selected: string[];
    onToggle: (goalId: string) => void;
}> = ({ goals, selected, onToggle }) => (
    <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {goals.map(goal => (
                <div
                    key={goal.id}
                    onClick={() => onToggle(goal.id)}
                    style={{
                        padding: '0.2rem 0.6rem',
                        borderRadius: '12px',
                        background: selected.includes(goal.id) ? 'var(--color-primary)' : 'var(--bg-card)',
                        color: selected.includes(goal.id) ? 'white' : 'var(--text-secondary)',
                        cursor: 'pointer',
                        border: '1px solid var(--border-color)'
                    }}
                >
                    {goal.title}
                </div>
            ))}
        </div>
        {goals.length === 0 ? (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.35rem' }}>
                No goals defined — the expense can draw from all portfolios.
            </div>
        ) : selected.length === 0 && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.35rem' }}>
                No goal selected — the expense can draw from all portfolios.
            </div>
        )}
    </>
);

// Per-expense funding order. With erosion on, the expense drains broker
// liquidity before anything is sold; with it off liquidity is untouchable and
// the shortfall goes straight to the allowed portfolios. In both cases the
// monthly inflow of the year the expense falls in pays first.
const ErosionToggle: React.FC<{ allowed: boolean; onToggle: () => void }> = ({ allowed, onToggle }) => (
    <button
        type="button"
        onClick={onToggle}
        title={allowed
            ? 'Erodes liquidity first: inflow → broker liquidity → allowed portfolios. Click to protect liquidity instead.'
            : 'Liquidity is protected: inflow → allowed portfolios, brokers untouched. Click to let this expense erode liquidity first.'}
        style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontSize: '0.75rem',
            textAlign: 'left',
            textDecoration: 'underline dotted',
            color: allowed ? 'var(--color-danger)' : 'var(--text-muted)',
        }}
    >
        {allowed ? '⚠ Erodes liquidity first' : '🛡 Liquidity safe'}
    </button>
);


const ForecastView: React.FC = () => {
    // Scoped: the family/illiquid toggles decide what the forecast simulates
    const { portfolios, scopedBrokers: brokers, marketData, scopedTransactions: transactions, assetSettings, goals, priceHistory,
        plannedForecastExpenses, setPlannedForecastExpenses, restorePlannedForecastExpenses,
        ynabGoals, ynabConfig, ynabSpendingHistoryByBudget, ynabMacroMappings,
        ynabBudgetOwners, setYnabBudgetOwner, syncYnabSpending, ynabSpendingSyncing, people } = usePortfolio();

    // null = never seeded (context auto-imports as soon as forecastable goals exist)
    const ynabPlannedExpenses = plannedForecastExpenses ?? [];
    // Goals YNAB knows about but that carry no target amount + date, so they can
    // never become a planned expense. Explains an empty list.
    const goalsWithoutTarget = useMemo(
        () => ynabGoals.filter(g => !g.archived && !((g.targetAmount ?? 0) > 0 && g.targetDate)).length,
        [ynabGoals]);

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

    // ── Cashflow from YNAB ───────────────────────────────────────────
    // Income and expenses come from the rolling-year spending history, filtered
    // by household source (which budgets count) and by expense class.
    const [excludedSources, setExcludedSources] = useState<string[]>([]);
    const [expenseMacros, setExpenseMacros] = useState<YnabMacroCategory[]>(DEFAULT_FORECAST_EXPENSE_MACROS);
    const [useYnabCashflow, setUseYnabCashflow] = useState(true);
    const [showSourceMapping, setShowSourceMapping] = useState(false);

    // Budgets the token knows about, or at least the primary one.
    const ynabBudgets = useMemo(() => {
        const cached = ynabConfig?.budgets;
        if (cached && cached.length > 0) return cached;
        if (!ynabConfig) return [];
        return [{ id: ynabConfig.budgetId, name: ynabConfig.budgetName || ynabConfig.budgetId, currencyIso: ynabConfig.currencyIso || 'EUR' }];
    }, [ynabConfig]);

    // A budget counts as family until it is attributed to a person who still exists.
    const sourceOfBudget = useMemo(() => {
        const personIds = new Set(people.map(p => p.id));
        return (budgetId: string): string => {
            const owner = ynabBudgetOwners[budgetId];
            return owner && personIds.has(owner) ? owner : FAMILY_SOURCE;
        };
    }, [ynabBudgetOwners, people]);

    // One chip per source actually backing a budget: family plus each person who
    // owns one. A single-budget setup therefore shows just "Family".
    const cashflowSources = useMemo(() => {
        const used = new Set(ynabBudgets.map(b => sourceOfBudget(b.id)));
        const list: { key: string; label: string }[] = [];
        if (used.has(FAMILY_SOURCE)) list.push({ key: FAMILY_SOURCE, label: '👪 Family' });
        for (const p of [...people].sort((a, b) => a.order - b.order)) {
            if (used.has(p.id)) list.push({ key: p.id, label: `👤 ${p.name}` });
        }
        return list;
    }, [ynabBudgets, people, sourceOfBudget]);

    const includedBudgetIds = useMemo(
        () => ynabBudgets.filter(b => !excludedSources.includes(sourceOfBudget(b.id))).map(b => b.id),
        [ynabBudgets, excludedSources, sourceOfBudget]);

    const ynabCashflow = useMemo(
        () => computeForecastCashflow(ynabSpendingHistoryByBudget, ynabMacroMappings, includedBudgetIds, expenseMacros),
        [ynabSpendingHistoryByBudget, ynabMacroMappings, includedBudgetIds, expenseMacros]);

    // Averages drive the simulation only while there is a history to average and
    // the user hasn't taken the inputs over.
    const cashflowFromYnab = useYnabCashflow && ynabCashflow.monthsCount > 0;
    const effectiveMonthlyIncome = cashflowFromYnab
        ? Math.round(ynabCashflow.avgMonthlyIncome)
        : (Number(monthlyIncome) || 0);
    const effectiveMonthlyExpenses = cashflowFromYnab
        ? Math.round(ynabCashflow.avgMonthlyExpenses)
        : (Number(monthlyExpenses) || 0);

    const toggleSource = (key: string) => {
        setExcludedSources(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    };

    const toggleExpenseMacro = (macro: YnabMacroCategory) => {
        setExpenseMacros(prev => prev.includes(macro) ? prev.filter(m => m !== macro) : [...prev, macro]);
    };

    // Refresh the rolling-year history of every known budget, so a source that
    // was just attributed or re-included has numbers to contribute.
    const handleSyncCashflow = async () => {
        if (ynabBudgets.length === 0) {
            Swal.fire({ title: 'YNAB not configured', text: 'Connect YNAB in Settings to import income and expenses.', icon: 'info' });
            return;
        }
        const errors: string[] = [];
        for (const budget of ynabBudgets) {
            const res = await syncYnabSpending(budget.id);
            if (!res.ok) errors.push(`${budget.name}: ${res.error || 'sync failed'}`);
        }
        if (errors.length > 0) {
            Swal.fire({ title: 'Sync incomplete', html: errors.join('<br/>'), icon: 'warning' });
            return;
        }
        Swal.fire({
            title: 'Income & expenses updated',
            text: `Rolling-year history refreshed for ${ynabBudgets.length} budget${ynabBudgets.length === 1 ? '' : 's'}.`,
            icon: 'success',
            timer: 2500,
            showConfirmButton: false,
        });
    };

    // Monte Carlo (volatility) simulation
    // Results area: the projection as a chart, or as a cash-flow table.
    const [resultView, setResultView] = useState<'chart' | 'table'>('chart');
    const [tableGranularity, setTableGranularity] = useState<CashflowGranularity>('year');
    // Which simulated path the table walks through, once Monte Carlo is on.
    const [scenarioKey, setScenarioKey] = useState<'p10' | 'p50' | 'p90'>('p50');

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

    // Which already-planned expense has its funding sources open for editing
    // (one at a time; ids are unique across the manual and YNAB lists).
    const [editingSourcesFor, setEditingSourcesFor] = useState<string | null>(null);
    const toggleSourcesEditor = (id: string) => setEditingSourcesFor(prev => prev === id ? null : id);

    const toggleGoalIn = (allowedGoalIds: string[], goalId: string): string[] =>
        allowedGoalIds.includes(goalId)
            ? allowedGoalIds.filter(id => id !== goalId)
            : [...allowedGoalIds, goalId];

    // Funding sources stay editable after the expense has been planned
    const toggleExpenseAllowedGoal = (expenseId: string, goalId: string) => {
        setYearlyExpenses(prev => prev.map(e =>
            e.id === expenseId ? { ...e, allowedGoalIds: toggleGoalIn(e.allowedGoalIds, goalId) } : e));
    };

    const toggleYnabExpenseAllowedGoal = (expenseId: string, goalId: string) => {
        setPlannedForecastExpenses(prev => (prev ?? []).map(e =>
            e.id === expenseId ? { ...e, allowedGoalIds: toggleGoalIn(e.allowedGoalIds, goalId) } : e));
    };

    // Whether an expense may eat into broker liquidity before it touches the
    // portfolios — decided per expense, on both lists.
    const toggleExpenseErosion = (expenseId: string) => {
        setYearlyExpenses(prev => prev.map(e =>
            e.id === expenseId ? { ...e, erosionAllowed: !e.erosionAllowed } : e));
    };

    const toggleYnabExpenseErosion = (expenseId: string) => {
        setPlannedForecastExpenses(prev => (prev ?? []).map(e =>
            e.id === expenseId ? { ...e, erosionAllowed: !e.erosionAllowed } : e));
    };

    // YNAB goal expenses (persisted in context; enabled ones join the simulation)
    const toggleYnabExpense = (id: string) => {
        setPlannedForecastExpenses(prev => (prev ?? []).map(e => e.id === id ? { ...e, enabled: !e.enabled } : e));
    };

    const removeYnabExpense = (id: string) => {
        setPlannedForecastExpenses(prev => (prev ?? []).filter(e => e.id !== id));
    };

    // Rebuilds the list from the YNAB Goals section — the enriched local copy,
    // with its targets (parsed, YNAB-native or manually overridden) and its
    // portfolio allocations. YNAB itself is contacted only by the Goals sync.
    const handleSyncYnabExpenses = async () => {
        const result = await Swal.fire({
            title: 'Sync from YNAB Goals?',
            text: 'The planned expense list is rebuilt from the goals in the YNAB Goals section, with their targets and portfolio allocations. Removed entries come back and enable/disable flags are reset; the per-expense liquidity-erosion choice is kept.',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Sync',
            cancelButtonText: 'Cancel',
        });
        if (!result.isConfirmed) return;

        const rebuilt = restorePlannedForecastExpenses();
        Swal.fire({
            title: 'Synced',
            html: `${rebuilt.length} planned expense${rebuilt.length === 1 ? '' : 's'} from the YNAB Goals section.`
                + (rebuilt.length === 0
                    ? '<br/><span style="font-size:0.85rem">No goal there carries both a target amount and a target date — set one in YNAB Goals, or sync the goals from YNAB first.</span>'
                    : ''),
            icon: rebuilt.length === 0 ? 'info' : 'success',
            timer: rebuilt.length === 0 ? undefined : 2500,
            showConfirmButton: rebuilt.length === 0,
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

    // What every simulation starts from — shared by the deterministic forecast,
    // the Monte Carlo ensemble and the single path the cash-flow table replays,
    // so the three can never drift apart.
    const simulationInputs = useMemo(() => {
        const inputPortfolios = portfolios.map(p => ({
            ...p,
            currentValue: currentPortfolioValues[p.id] || 0
        }));
        const returns: Record<string, number> = {};
        portfolios.forEach(p => {
            returns[p.id] = portfolioPerformance[p.id]?.cagr || 0;
        });
        const expenses = [
            ...yearlyExpenses.map(e => ({
                year: e.year,
                amount: e.amount,
                allowedGoalIds: e.allowedGoalIds,
                allowedGoalLabels: e.allowedGoalIds.map(id => goalTitleById[id] || id),
                erosionAllowed: e.erosionAllowed
            })),
            ...ynabSimulationExpenses
        ];
        return { portfolios: inputPortfolios, returns, expenses, years: Number(timeHorizon) || 10 };
    }, [portfolios, currentPortfolioValues, portfolioPerformance, yearlyExpenses, ynabSimulationExpenses, goalTitleById, timeHorizon]);

    // Generate Forecast Data
    const forecastData = useMemo(() => calculateForecastWithState(
        simulationInputs.portfolios,
        brokers,
        effectiveMonthlyIncome,
        effectiveMonthlyExpenses,
        simulationInputs.years,
        simulationInputs.returns,
        simulationInputs.expenses,
        undefined,
        { rebalanceToInitialWeights: rebalanceAnnually }
    ), [simulationInputs, brokers, effectiveMonthlyIncome, effectiveMonthlyExpenses, rebalanceAnnually]);

    // Year 0 — the money as it stands today, before the first simulated month
    // runs. It is the very state the engine starts from, so plotting it makes
    // the first step of the chart show what the nearest expenses actually cost
    // instead of hiding them inside the opening data point.
    const year0Point = useMemo<ForecastResult>(() => {
        const portfolioValues: Record<string, number> = {};
        let invested = 0;
        portfolios.forEach(p => {
            const value = currentPortfolioValues[p.id] || 0;
            portfolioValues[p.id] = value;
            invested += value;
        });
        const liquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
        return {
            month: 0,
            totalValue: invested + liquidity,
            investedValue: invested,
            liquidityValue: liquidity,
            portfolios: portfolioValues,
            cashflow: 0,
            incomeFlow: 0,
            plannedExpense: 0,
            marketPnl: 0,
        };
    }, [portfolios, currentPortfolioValues, brokers]);

    // What the charts plot: the simulation with today prepended.
    const chartData = useMemo(() => [year0Point, ...forecastData], [year0Point, forecastData]);

    const effectiveVolatilities = useMemo(() => {
        const vols: Record<string, number> = {};
        portfolios.forEach(p => {
            const override = volatilityOverrides[p.id];
            vols[p.id] = override !== undefined && override !== '' ? Number(override) : (estimatedVolatilities[p.id] || 0);
        });
        return vols;
    }, [portfolios, volatilityOverrides, estimatedVolatilities]);

    // Monte Carlo simulation (only when enabled)
    // Calibration shared by the ensemble and the replayed single path.
    const mcCalibration = useMemo(() => ({
        monthlyLogReturnsByPortfolio: historicalCalibration.monthlyLogReturns,
        // A manual volatility override means the user wants the
        // lognormal model driven by that number, not the history.
        forceLognormal: portfolios
            .filter(p => volatilityOverrides[p.id] !== undefined && volatilityOverrides[p.id] !== '')
            .map(p => p.id),
        historicalMaxDrawdownPct: historicalCalibration.netWorthMaxDrawdownPct,
    }), [historicalCalibration, portfolios, volatilityOverrides]);

    const monteCarloData = useMemo(() => {
        if (!monteCarloEnabled) return null;

        return runMonteCarloForecast(
            simulationInputs.portfolios,
            brokers,
            effectiveMonthlyIncome,
            effectiveMonthlyExpenses,
            simulationInputs.years,
            simulationInputs.returns,
            effectiveVolatilities,
            simulationInputs.expenses,
            500,
            mcSeed,
            { rebalanceToInitialWeights: rebalanceAnnually },
            mcCalibration
        );
    }, [monteCarloEnabled, simulationInputs, brokers, effectiveMonthlyIncome, effectiveMonthlyExpenses, effectiveVolatilities, mcSeed, rebalanceAnnually, mcCalibration]);

    // Cash-flow table: the deterministic path, or — with Monte Carlo on — one
    // real simulated run replayed month by month. The percentile curves the
    // chart draws are an envelope across runs, not a possible future, so they
    // can't be broken down into cash flows; a single run can, drawdowns and all.
    const scenarioResults = useMemo(() => {
        if (resultView !== 'table' || !monteCarloData) return null;
        return runMonteCarloScenario(
            simulationInputs.portfolios,
            brokers,
            effectiveMonthlyIncome,
            effectiveMonthlyExpenses,
            simulationInputs.years,
            simulationInputs.returns,
            effectiveVolatilities,
            simulationInputs.expenses,
            mcSeed,
            { rebalanceToInitialWeights: rebalanceAnnually },
            mcCalibration,
            monteCarloData.scenarioRuns[scenarioKey]
        );
    }, [resultView, monteCarloData, scenarioKey, simulationInputs, brokers, effectiveMonthlyIncome, effectiveMonthlyExpenses, effectiveVolatilities, mcSeed, rebalanceAnnually, mcCalibration]);

    const cashflowTable = useMemo(
        () => buildCashflowTable(scenarioResults ?? forecastData, year0Point, tableGranularity),
        [scenarioResults, forecastData, year0Point, tableGranularity]
    );

    // Effective volatility per portfolio (manual override wins over the estimate)


    // Chart Config
    const chartOptions = {
        chart: {
            id: 'forecast-chart',
            stacked: true,
            background: 'transparent',
            toolbar: { show: false },
            // The chart keeps its initial frame: no drag/wheel/trackpad-pinch
            // zoom, so a scroll gesture over it scrolls the page instead.
            zoom: { enabled: false, allowMouseWheelZoom: false },
            selection: { enabled: false }
        },
        theme: { mode: 'dark' as 'dark' },
        xaxis: {
            categories: chartData.map(d => (d.month === 0 ? 'Year 0' : `Year ${Math.ceil(d.month / 12)}`)),
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
                    const data = chartData[opts.dataPointIndex];
                    if (!data) return val;
                    // The axis label repeats per month, so name the point from
                    // the month itself — and call the anchor what it is.
                    const label = data.month === 0
                        ? 'Year 0 — today, before any expense'
                        : `Year ${Math.ceil(data.month / 12)}, Month ${((data.month - 1) % 12) + 1}`;
                    const flow = Math.round(data.cashflow);
                    const flowStr = flow >= 0 ? `+€${flow.toLocaleString()}` : `-€${Math.abs(flow).toLocaleString()}`;
                    return `${label} | Total: €${Math.round(data.totalValue).toLocaleString()} | Flow: ${flowStr}`;
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
            data: chartData.map(d => Math.round(d.liquidityValue))
        },
        ...portfolios.map(p => ({
            name: p.name,
            data: chartData.map(d => Math.round(d.portfolios[p.id] || 0))
        }))
    ];

    // Monte Carlo chart: percentile bands (10-90, 25-75) + median line
    const mcChartOptions = {
        chart: {
            id: 'forecast-mc-chart',
            background: 'transparent',
            toolbar: { show: false },
            animations: { enabled: false },
            // Same as the deterministic chart: the frame stays put.
            zoom: { enabled: false, allowMouseWheelZoom: false },
            selection: { enabled: false }
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
                    if (val === 0) return 'Year 0 — today, before any expense';
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

    // Every simulated path leaves from the same place, so the bands start as a
    // single point at Year 0 rather than opening a year in.
    const mcYear0 = Math.round(year0Point.totalValue);

    const mcChartSeries = monteCarloData ? [
        {
            type: 'rangeArea',
            name: '10th–90th percentile',
            data: [{ x: 0, y: [mcYear0, mcYear0] }, ...monteCarloData.months.map((m, i) => ({
                x: m,
                y: [Math.round(monteCarloData.p10[i]), Math.round(monteCarloData.p90[i])]
            }))]
        },
        {
            type: 'rangeArea',
            name: '25th–75th percentile',
            data: [{ x: 0, y: [mcYear0, mcYear0] }, ...monteCarloData.months.map((m, i) => ({
                x: m,
                y: [Math.round(monteCarloData.p25[i]), Math.round(monteCarloData.p75[i])]
            }))]
        },
        {
            type: 'line',
            name: 'Median',
            data: [{ x: 0, y: mcYear0 }, ...monteCarloData.months.map((m, i) => ({
                x: m,
                y: Math.round(monteCarloData.p50[i])
            }))]
        }
    ] : [];

    const finalResult = forecastData[forecastData.length - 1] || { totalValue: 0, investedValue: 0, liquidityValue: 0, insolvent: false, ruleBreach: false, failureReason: '' };
    // Growth is measured from today, so the first year's expenses count against it.
    const startValue = year0Point.totalValue;

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

    // The chart keeps the height of the screen it is opened in: it must not grow
    // with the (much taller) side columns. Its own document offset varies with the
    // summary row above it (4 cards in Monte Carlo mode, 3 otherwise), so measure
    // rather than subtract a fixed constant.
    const chartCardRef = useRef<HTMLDivElement>(null);
    const summaryRef = useRef<HTMLDivElement>(null);
    const [chartHeight, setChartHeight] = useState<number | null>(null);

    useLayoutEffect(() => {
        const card = chartCardRef.current;
        if (!card) return;
        const measure = () => {
            const top = card.getBoundingClientRect().top + window.scrollY;
            setChartHeight(Math.max(320, window.innerHeight - top - CHART_BOTTOM_GAP));
        };
        measure();
        window.addEventListener('resize', measure);
        // the summary row changes height when Monte Carlo is toggled on/off
        const observer = new ResizeObserver(measure);
        if (summaryRef.current) observer.observe(summaryRef.current);
        return () => {
            window.removeEventListener('resize', measure);
            observer.disconnect();
        };
    }, []);

    return (
        <div className="forecast-container" style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 320px) 1fr 280px', gap: '1.5rem', width: '100%', maxWidth: '100%' }}>
            {/* Sidebar Controls */}
            <div className="forecast-controls" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', height: 'fit-content' }}>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem', color: 'var(--text-primary)' }}>Configuration</h2>

                <AssetScopeToggles style={{ marginBottom: '1rem' }} />

                {/* Cashflow sources: which budgets and which expense classes feed
                    the monthly income/expense figures the simulation runs on. */}
                <div className="form-group" style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <label style={{ color: 'var(--text-secondary)' }}>Income & Expenses (YNAB)</label>
                        <button
                            onClick={handleSyncCashflow}
                            disabled={ynabSpendingSyncing}
                            title="Refresh the rolling-year income and spending history of every YNAB budget"
                            style={{ padding: '0.2rem 0.6rem', background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', cursor: ynabSpendingSyncing ? 'wait' : 'pointer', fontSize: '0.8rem' }}
                        >
                            {ynabSpendingSyncing ? '…' : '↻ Sync'}
                        </button>
                    </div>

                    {ynabBudgets.length === 0 ? (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                            YNAB is not connected — type the monthly figures below by hand.
                        </div>
                    ) : (
                        <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>Sources:</span>
                                {cashflowSources.map(source => {
                                    const included = !excludedSources.includes(source.key);
                                    return (
                                        <button
                                            key={source.key}
                                            onClick={() => toggleSource(source.key)}
                                            title={included
                                                ? `Counted in income and expenses — click to leave out`
                                                : `Left out of income and expenses — click to count`}
                                            style={{
                                                padding: '0.2rem 0.6rem', borderRadius: '14px', fontSize: '0.74rem', cursor: 'pointer',
                                                background: included ? 'var(--color-primary)' : 'var(--bg-card)',
                                                color: included ? 'white' : 'var(--text-tertiary)',
                                                border: included ? '1px solid var(--color-primary)' : '1px solid var(--border-color)',
                                                textDecoration: included ? 'none' : 'line-through',
                                            }}
                                        >
                                            {source.label}
                                        </button>
                                    );
                                })}
                                <button
                                    onClick={() => setShowSourceMapping(v => !v)}
                                    title="Assign each YNAB budget to the family or to a person"
                                    style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
                                >
                                    ⚙
                                </button>
                            </div>

                            {showSourceMapping && (
                                <div style={{ marginBottom: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                    {ynabBudgets.map(budget => (
                                        <div key={budget.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
                                            <span style={{ flex: 1, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={budget.name}>
                                                {budget.name}
                                            </span>
                                            <select
                                                value={sourceOfBudget(budget.id)}
                                                onChange={e => setYnabBudgetOwner(budget.id, e.target.value)}
                                                style={{ padding: '0.15rem 0.3rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: '0.75rem' }}
                                            >
                                                <option value={FAMILY_SOURCE}>Family</option>
                                                {[...people].sort((a, b) => a.order - b.order).map(p => (
                                                    <option key={p.id} value={p.id}>{p.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                    ))}
                                    {people.length === 0 && (
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
                                            Add people in Settings to attribute a budget to one of them.
                                        </div>
                                    )}
                                </div>
                            )}

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                                <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>Expenses counted:</span>
                                {MACRO_ORDER.map(macro => {
                                    const on = expenseMacros.includes(macro);
                                    const avg = ynabCashflow.avgMonthlyByMacro[macro];
                                    return (
                                        <button
                                            key={macro}
                                            onClick={() => toggleExpenseMacro(macro)}
                                            title={`${MACRO_DESCRIPTIONS[macro]} — €${Math.round(avg).toLocaleString()}/month`}
                                            style={{
                                                padding: '0.2rem 0.6rem', borderRadius: '14px', fontSize: '0.74rem', cursor: 'pointer',
                                                background: on ? 'var(--color-primary)' : 'var(--bg-card)',
                                                color: on ? 'white' : 'var(--text-tertiary)',
                                                border: on ? '1px solid var(--color-primary)' : '1px solid var(--border-color)',
                                                textDecoration: on ? 'none' : 'line-through',
                                            }}
                                        >
                                            {MACRO_LABELS[macro]}
                                        </button>
                                    );
                                })}
                            </div>

                            {ynabCashflow.monthsCount === 0 ? (
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                                    No spending history for the selected sources — hit ↻ Sync to import the rolling year.
                                </div>
                            ) : (
                                <>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                                        Average over {ynabCashflow.monthsCount} month{ynabCashflow.monthsCount === 1 ? '' : 's'}:
                                        {' '}<strong style={{ color: '#10b981' }}>€{Math.round(ynabCashflow.avgMonthlyIncome).toLocaleString()}</strong> in,
                                        {' '}<strong style={{ color: '#ef4444' }}>€{Math.round(ynabCashflow.avgMonthlyExpenses).toLocaleString()}</strong> out
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
                                        <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Use these averages</label>
                                        <input
                                            type="checkbox"
                                            checked={useYnabCashflow}
                                            onChange={e => {
                                                // Taking the inputs over starts from the YNAB figures
                                                // rather than from two empty fields.
                                                if (!e.target.checked) {
                                                    if (monthlyIncome === '') setMonthlyIncome(Math.round(ynabCashflow.avgMonthlyIncome));
                                                    if (monthlyExpenses === '') setMonthlyExpenses(Math.round(ynabCashflow.avgMonthlyExpenses));
                                                }
                                                setUseYnabCashflow(e.target.checked);
                                            }}
                                            title="Off = type the monthly income and expenses by hand"
                                        />
                                    </div>
                                    {ynabCashflow.avgMonthlyUnmapped >= 1 && (
                                        <div style={{ fontSize: '0.7rem', color: 'var(--color-warning, #F59E0B)', marginTop: '0.35rem' }}>
                                            ⚠ €{Math.round(ynabCashflow.avgMonthlyUnmapped).toLocaleString()}/month sits in categories with no expense class — map them in Summary to count them.
                                        </div>
                                    )}
                                </>
                            )}
                        </>
                    )}
                </div>

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
                        value={cashflowFromYnab ? effectiveMonthlyIncome : monthlyIncome}
                        onChange={e => setMonthlyIncome(e.target.value === '' ? '' : Number(e.target.value))}
                        placeholder="0"
                        disabled={cashflowFromYnab}
                        title={cashflowFromYnab ? 'YNAB average — untick "Use these averages" to type your own' : undefined}
                        style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)', opacity: cashflowFromYnab ? 0.7 : 1 }}
                    />
                    {cashflowFromYnab && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>from YNAB</div>
                    )}
                </div>

                <div className="form-group" style={{ marginBottom: '1.5rem' }}>
                    <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Monthly Expenses (€)</label>
                    <input
                        type="number"
                        value={cashflowFromYnab ? effectiveMonthlyExpenses : monthlyExpenses}
                        onChange={e => setMonthlyExpenses(e.target.value === '' ? '' : Number(e.target.value))}
                        placeholder="0"
                        disabled={cashflowFromYnab}
                        title={cashflowFromYnab ? 'YNAB average — untick "Use these averages" to type your own' : undefined}
                        style={{ width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', background: 'var(--bg-input)', color: 'var(--text-primary)', opacity: cashflowFromYnab ? 0.7 : 1 }}
                    />
                    {cashflowFromYnab && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>
                            from YNAB · {expenseMacros.length === 0
                                ? 'no expense class selected'
                                : MACRO_ORDER.filter(m => expenseMacros.includes(m)).map(m => MACRO_LABELS[m].toLowerCase()).join(' + ')}
                        </div>
                    )}
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
                            <label
                                style={{ color: 'var(--text-secondary)' }}
                                title="On: the expense drains broker liquidity before selling from the portfolios. Off: liquidity is untouched and the portfolios pay. Changeable per expense afterwards."
                            >
                                Allow Erosion of Liquidity?
                            </label>
                            <input
                                type="checkbox"
                                checked={newExpErosionAllowed}
                                onChange={e => setNewExpErosionAllowed(e.target.checked)}
                            />
                        </div>
                        <label style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Allowed Goals (linked portfolios):</label>
                        <AllowedGoalsChips goals={sortedGoals} selected={newExpAllowedGoalIds} onToggle={toggleAllowedGoal} />
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
                                <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-tertiary)', flexWrap: 'wrap', alignItems: 'center' }}>
                                    <ErosionToggle
                                        allowed={expense.erosionAllowed}
                                        onToggle={() => toggleExpenseErosion(expense.id)}
                                    />
                                    <span>|</span>
                                    <button
                                        onClick={() => toggleSourcesEditor(expense.id)}
                                        title="Change which Goals (linked portfolios) fund this expense"
                                        style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left', textDecoration: 'underline dotted' }}
                                    >
                                        {expense.allowedGoalIds.length === 0 || expense.allowedGoalIds.length === goals.length
                                            ? 'All Portfolios'
                                            : expense.allowedGoalIds.map(id => goalTitleById[id] || id).join(', ')}
                                        {' ✏'}
                                    </button>
                                </div>
                                {editingSourcesFor === expense.id && (
                                    <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-color)' }}>
                                        <label style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '0.35rem' }}>Allowed Goals (linked portfolios):</label>
                                        <AllowedGoalsChips
                                            goals={sortedGoals}
                                            selected={expense.allowedGoalIds}
                                            onToggle={goalId => toggleExpenseAllowedGoal(expense.id, goalId)}
                                        />
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                <div className="form-group" style={{ marginBottom: '1.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <label style={{ color: 'var(--text-secondary)' }}>YNAB Goal Expenses</label>
                        <button
                            onClick={handleSyncYnabExpenses}
                            title="Rebuild this list from the goals in the YNAB Goals section"
                            style={{ padding: '0.2rem 0.6rem', background: 'var(--bg-input)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '0.8rem' }}
                        >
                            ↻ Sync from YNAB Goals
                        </button>
                    </div>
                    {ynabPlannedExpenses.length === 0 ? (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                            No YNAB goal expenses in the plan. Goals with a target amount and date are imported automatically from the YNAB Goals section; use Sync to re-import them.
                            {goalsWithoutTarget > 0 && (
                                <div style={{ marginTop: '0.35rem', color: 'var(--color-warning, #F59E0B)' }}>
                                    ⚠ {goalsWithoutTarget} goal{goalsWithoutTarget === 1 ? ' in' : 's in'} YNAB Goals {goalsWithoutTarget === 1 ? 'has' : 'have'} no target amount + date, so {goalsWithoutTarget === 1 ? 'it cannot' : 'they cannot'} become a planned expense. Give {goalsWithoutTarget === 1 ? 'it' : 'them'} a target there (or in YNAB, then sync the goals) and Sync here.
                                </div>
                            )}
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
                                        <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--text-tertiary)', flexWrap: 'wrap', alignItems: 'center' }}>
                                            <span>🎯 {expense.targetDate}</span>
                                            <span>|</span>
                                            <ErosionToggle
                                                allowed={expense.erosionAllowed}
                                                onToggle={() => toggleYnabExpenseErosion(expense.id)}
                                            />
                                            <span>|</span>
                                            <button
                                                onClick={() => toggleSourcesEditor(expense.id)}
                                                title="Change which Goals (linked portfolios) fund this expense. Syncing from YNAB Goals resets it."
                                                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left', textDecoration: 'underline dotted' }}
                                            >
                                                {expense.allowedGoalIds.length === 0
                                                    ? 'All Portfolios'
                                                    : expense.allowedGoalIds.map(id => goalTitleById[id] || id).join(', ')}
                                                {' ✏'}
                                            </button>
                                            {beyondHorizon && (
                                                <>
                                                    <span>|</span>
                                                    <span style={{ color: 'var(--color-warning, #F59E0B)' }}>⚠ Beyond horizon — not simulated</span>
                                                </>
                                            )}
                                        </div>
                                        {editingSourcesFor === expense.id && (
                                            <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border-color)' }}>
                                                <label style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.8rem', marginBottom: '0.35rem' }}>Allowed Goals (linked portfolios):</label>
                                                <AllowedGoalsChips
                                                    goals={sortedGoals}
                                                    selected={expense.allowedGoalIds}
                                                    onToggle={goalId => toggleYnabExpenseAllowedGoal(expense.id, goalId)}
                                                />
                                            </div>
                                        )}
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
            <div className="forecast-results" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', alignSelf: 'start', minWidth: 0 }}>
                <div ref={summaryRef} className="summary-grid forecast-summary-grid" style={{ display: 'grid', gridTemplateColumns: monteCarloData ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)', gap: '1rem' }}>
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
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }} title="Net worth as it stands today, before the simulation spends anything">
                            Year 0: €{Math.round(year0Point.totalValue).toLocaleString()}
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
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }} title="Invested today, before the simulation spends anything">
                                    Year 0: €{Math.round(year0Point.investedValue).toLocaleString()}
                                </div>
                            </div>
                            <div className="card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                                <h4 style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Liquidity Total</h4>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#10b981' }}>
                                    €{Math.round(finalResult.liquidityValue).toLocaleString()}
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }} title="Liquidity on the brokers today, before the nearest expenses erode it">
                                    Year 0: €{Math.round(year0Point.liquidityValue).toLocaleString()}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Chart or cash-flow table — same projection, two readings */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                        <button
                            onClick={() => setResultView('chart')}
                            style={segButtonStyle(resultView === 'chart')}
                            title="The projection as a chart"
                        >
                            Chart
                        </button>
                        <button
                            onClick={() => setResultView('table')}
                            style={segButtonStyle(resultView === 'table')}
                            title="The projection as a cash-flow table: net worth, income, planned expenses and market swings period by period"
                        >
                            Cash-flow table
                        </button>
                    </div>

                    {resultView === 'table' && (
                        <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap', alignItems: 'center' }}>
                            {monteCarloData && (
                                <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>Scenario</span>
                                    {([
                                        ['p10', 'Pessimistic', 'The run whose final net worth lands on the 10th percentile'],
                                        ['p50', 'Median', 'The run whose final net worth lands on the 50th percentile'],
                                        ['p90', 'Optimistic', 'The run whose final net worth lands on the 90th percentile'],
                                    ] as const).map(([key, label, tip]) => (
                                        <button
                                            key={key}
                                            onClick={() => setScenarioKey(key)}
                                            style={segButtonStyle(scenarioKey === key)}
                                            title={`${tip} — a real simulated path, with the drawdowns it actually went through.`}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <div style={{ display: 'flex', gap: '0.3rem' }}>
                                <button onClick={() => setTableGranularity('year')} style={segButtonStyle(tableGranularity === 'year')}>Yearly</button>
                                <button onClick={() => setTableGranularity('month')} style={segButtonStyle(tableGranularity === 'month')}>Monthly</button>
                            </div>
                        </div>
                    )}
                </div>

                <div ref={chartCardRef} className="card forecast-chart-card" style={{ padding: '1.5rem', background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', flex: 'none', height: chartHeight ?? 'calc(100vh - 280px)', minHeight: '320px' }}>
                    {resultView === 'table' ? (
                        <ForecastCashflowTable
                            table={cashflowTable}
                            granularity={tableGranularity}
                            sourceLabel={monteCarloData
                                ? `Monte Carlo · ${scenarioKey === 'p10' ? 'pessimistic' : scenarioKey === 'p90' ? 'optimistic' : 'median'} run out of ${monteCarloData.simulations} — one simulated future, month by month: returns are drawn at random (block-bootstrapped from your real monthly history where there is enough of it), so the dips below are drawdowns this path actually went through.`
                                : 'Deterministic projection — every portfolio grows at its historical CAGR, month after month, with no volatility. Switch Monte Carlo on to see a path with real ups and downs.'}
                            note={monteCarloData
                                ? `across all runs, cash flows included (so planned spending counts too): median max drawdown ${monteCarloData.maxDrawdownP50.toFixed(1)}%, worst 10% ${monteCarloData.maxDrawdownP90.toFixed(1)}% — the Dip column below is market-only`
                                : undefined}
                        />
                    ) : monteCarloData ? (
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
