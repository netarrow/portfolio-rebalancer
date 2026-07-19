import type { Portfolio, Broker, AssetClass, AssetSubClass } from '../types';

export interface ForecastResult {
    month: number;
    totalValue: number;
    investedValue: number;
    liquidityValue: number;
    portfolios: Record<string, number>;
    cashflow: number;
    insolvent?: boolean;
    ruleBreach?: boolean;
    failureReason?: string;
}

export interface ForecastPortfolioInput extends Portfolio {
    currentValue: number;
    // goalId (inherited from Portfolio) links the portfolio to a user-defined Goal;
    // expense eligibility is matched on it.
}

export interface ForecastExpense {
    year: number;
    amount: number;
    allowedGoalIds?: string[]; // Goal ids whose linked portfolios may fund this. Empty/undefined = all portfolios.
    allowedGoalLabels?: string[]; // Display titles for warnings only (not used for matching)
    erosionAllowed?: boolean; // If true, can take from liquidity
}

// Returns the fractional return (e.g. 0.005 = +0.5%) applied to a portfolio for a given month.
// When omitted, the deterministic monthly-compounded CAGR is used.
export type MonthlyReturnSampler = (portfolioId: string, month: number) => number;

export interface ForecastOptions {
    // When true, monthly contributions are split by the year-0 value mix and the
    // invested total is rebalanced back to that mix once a year. When false,
    // contributions follow current weights, so winners attract more new money
    // (momentum drift).
    rebalanceToInitialWeights?: boolean;
}

export const calculateForecastWithState = (
    portfolios: ForecastPortfolioInput[],
    brokers: Broker[],
    monthlySavings: number,
    monthlyExpenses: number,
    timeHorizonYears: number,
    portfolioReturns: Record<string, number>,
    yearlyExpenses: ForecastExpense[] = [],
    monthlyReturnSampler?: MonthlyReturnSampler,
    options: ForecastOptions = {}
): ForecastResult[] => {
    const months = timeHorizonYears * 12;
    const results: ForecastResult[] = [];

    // 1. Initialize State
    // brokers
    let brokerState = brokers.map(b => ({
        ...b,
        liquidity: b.currentLiquidity || 0
    }));

    // portfolios
    let portfolioState = portfolios.map(p => ({
        id: p.id,
        value: p.currentValue,
        goalId: p.goalId // undefined = not linked to any Goal
    }));

    // Year-0 value mix, used when rebalanceToInitialWeights is on
    const initialTotal = portfolios.reduce((sum, p) => sum + p.currentValue, 0);
    const initialWeights: Record<string, number> = {};
    portfolios.forEach(p => {
        initialWeights[p.id] = initialTotal > 0
            ? p.currentValue / initialTotal
            : (portfolios.length > 0 ? 1 / portfolios.length : 0);
    });

    let hasInsolvency = false;
    let hasRuleBreach = false;
    let failureReason = '';

    for (let month = 1; month <= months; month++) {
        // Net Monthly Inflow = Savings - Expenses
        let monthlyInflow = monthlySavings - monthlyExpenses;
        let expensesForMonth: ForecastExpense[] = [];

        // Identify Expenses for this Month (Year Start)
        const currentYear = Math.ceil(month / 12);
        const isStartOfYear = (month - 1) % 12 === 0;

        if (isStartOfYear) {
            expensesForMonth = yearlyExpenses.filter(e => e.year === currentYear);
        }

        // Process Yearly Expenses
        for (const expense of expensesForMonth) {
            let expenseAmount = expense.amount;

            // 1. Pay with Inflow first (if positive)
            if (monthlyInflow > 0) {
                const covered = Math.min(monthlyInflow, expenseAmount);
                monthlyInflow -= covered;
                expenseAmount -= covered;
            }

            if (expenseAmount <= 0) continue;

            // 2. Pay with Liquidity (IF allowed)
            if (expense.erosionAllowed) {
                brokerState.forEach(broker => {
                    if (expenseAmount <= 0) return;
                    if (broker.liquidity > 0) {
                        const contribution = Math.min(broker.liquidity, expenseAmount);
                        broker.liquidity -= contribution;
                        expenseAmount -= contribution;
                    }
                });
            }

            if (expenseAmount <= 0) continue;

            // 3. Pay with Allowed Portfolios (matched on the Portfolio→Goal link)
            const allowedGoalIds = expense.allowedGoalIds;
            const restricted = !!allowedGoalIds && allowedGoalIds.length > 0;
            const eligiblePortfolios = portfolioState.filter(p => {
                if (!restricted) return true;
                return !!p.goalId && allowedGoalIds!.includes(p.goalId);
            });

            const eligibleTotalValue = eligiblePortfolios.reduce((sum, p) => sum + p.value, 0);

            if (eligibleTotalValue < expenseAmount) {
                // Check Global Solvency (All Portfolios + Liquidity)
                const allPortfoliosValue = portfolioState.reduce((sum, p) => sum + p.value, 0);
                const allLiquidity = brokerState.reduce((sum, b) => sum + b.liquidity, 0);
                const totalGlobal = allPortfoliosValue + allLiquidity;

                if (totalGlobal < expenseAmount) {
                    // INSOLVENCY: Impossible to pay even if we broke all rules
                    hasInsolvency = true;
                    failureReason = `Insolvency Year ${currentYear}: Needed €${expenseAmount.toFixed(0)}, available €${totalGlobal.toFixed(0)}.`;
                } else {
                    // RULE BREACH: Can pay, but unauthorized
                    hasRuleBreach = true;
                    // Only overwrite reason if it's the first breach, or if we escalate to insolvency later
                    if (!failureReason || !hasInsolvency) {
                        const sourcesLabel = expense.allowedGoalLabels?.join(', ') || 'the allowed goals';
                        failureReason = `Risk Warning Year ${currentYear}: Insufficient funds in portfolios linked to ${sourcesLabel}. Needed €${expenseAmount.toFixed(0)}.`;
                    }
                }
            }

            // Withdraw from eligible portfolios proportionally
            if (eligibleTotalValue > 0) {
                const fromEligible = Math.min(eligibleTotalValue, expenseAmount);
                eligiblePortfolios.forEach(p => {
                    const share = (p.value / eligibleTotalValue) * fromEligible;
                    p.value -= Math.min(p.value, share);
                });
                expenseAmount -= fromEligible;
            }

            // Remainder: rules already breached above — pull from the other
            // portfolios so Net Worth reflects the payment, then debt as last resort.
            if (expenseAmount > 0) {
                const otherPortfolios = portfolioState.filter(p => !eligiblePortfolios.includes(p));
                const otherTotal = otherPortfolios.reduce((sum, p) => sum + p.value, 0);
                if (otherTotal > 0) {
                    const fromOthers = Math.min(otherTotal, expenseAmount);
                    otherPortfolios.forEach(p => {
                        const share = (p.value / otherTotal) * fromOthers;
                        p.value -= Math.min(p.value, share);
                    });
                    expenseAmount -= fromOthers;
                }
                if (expenseAmount > 0 && brokerState.length > 0) {
                    // Debt on broker
                    brokerState[0].liquidity -= expenseAmount;
                }
            }
        }

        const currentCashflow = monthlyInflow;

        if (monthlyInflow < 0) {
            // Negative Cashflow: Withdraw from Liquidity first
            let deficit = -monthlyInflow;

            // Try to cover deficit with broker liquidity
            brokerState.forEach(broker => {
                if (deficit <= 0) return;

                if (broker.liquidity > 0) {
                    const contribution = Math.min(broker.liquidity, deficit);
                    broker.liquidity -= contribution;
                    deficit -= contribution;
                }
            });

            // If deficit remains, withdraw from portfolios proportionally
            if (deficit > 0) {
                const totalPortfolioValue = portfolioState.reduce((sum, p) => sum + p.value, 0);

                if (totalPortfolioValue > 0) {
                    portfolioState.forEach(p => {
                        // Proportional share of the deficit
                        const share = (p.value / totalPortfolioValue) * deficit;
                        // Ensure we don't withdraw more than available
                        const withdraw = Math.min(p.value, share);
                        p.value -= withdraw;
                    });
                }
            }

            // Inflow is now fully handled
            monthlyInflow = 0;
        }

        // 2. Liquidity Check & Replenishment
        let totalLiquidity = 0;
        let totalInvested = 0;

        // Update Broker Liquidity from Inflow (Only if positive)
        if (monthlyInflow > 0) {
            brokerState.forEach(broker => {
                let minReq = 0;
                if (broker.minLiquidityType === 'fixed') {
                    minReq = broker.minLiquidityAmount || 0;
                } else if (broker.minLiquidityType === 'percent') {
                    minReq = broker.minLiquidityAmount || 0;
                }

                const current = broker.liquidity;
                if (current < minReq) {
                    const deficit = minReq - current;
                    const contribution = Math.min(monthlyInflow, deficit);
                    broker.liquidity += contribution;
                    monthlyInflow -= contribution;
                }
            });
        }

        // 3. Investment of Surplus
        if (monthlyInflow > 0) {
            if (options.rebalanceToInitialWeights) {
                // Contributions stick to the year-0 mix
                portfolioState.forEach(p => {
                    p.value += monthlyInflow * (initialWeights[p.id] || 0);
                });
            } else {
                // Distribute remaining inflow to portfolios based on their CURRENT value ratios
                const totalPortfolioValue = portfolioState.reduce((sum, p) => sum + p.value, 0);

                if (totalPortfolioValue > 0) {
                    portfolioState.forEach(p => {
                        const weight = p.value / totalPortfolioValue;
                        const allocation = monthlyInflow * weight;
                        p.value += allocation;
                    });
                } else {
                    // Split evenly if starting from 0
                    const share = monthlyInflow / portfolioState.length;
                    portfolioState.forEach(p => p.value += share);
                }
            }
        }

        // 4. Compound Growth
        portfolioState.forEach(p => {
            let monthlyRate: number;
            if (monthlyReturnSampler) {
                monthlyRate = monthlyReturnSampler(p.id, month);
            } else {
                const annualRate = portfolioReturns[p.id] || 0; // %
                monthlyRate = Math.pow(1 + annualRate / 100, 1 / 12) - 1;
            }
            p.value = p.value * (1 + monthlyRate);
        });

        // 4b. Annual rebalance back to the year-0 mix (end of each year)
        if (options.rebalanceToInitialWeights && month % 12 === 0) {
            const totalInvestedNow = portfolioState.reduce((sum, p) => sum + p.value, 0);
            portfolioState.forEach(p => {
                p.value = totalInvestedNow * (initialWeights[p.id] || 0);
            });
        }

        // 5. Record Results
        totalInvested = portfolioState.reduce((sum, p) => sum + p.value, 0);
        totalLiquidity = brokerState.reduce((sum, b) => sum + b.liquidity, 0);

        results.push({
            month,
            totalValue: totalInvested + totalLiquidity,
            investedValue: totalInvested,
            liquidityValue: totalLiquidity,
            portfolios: portfolioState.reduce((acc, p) => {
                acc[p.id] = p.value;
                return acc;
            }, {} as Record<string, number>),
            cashflow: currentCashflow,
            insolvent: hasInsolvency,
            ruleBreach: hasRuleBreach,
            failureReason: failureReason || undefined
        });
    }

    return results;
};

// ---------------------------------------------------------------------------
// Monte Carlo simulation (simplified)
// ---------------------------------------------------------------------------
// Each portfolio's monthly return is sampled from a lognormal distribution
// calibrated so that the *median* compound growth matches the deterministic
// CAGR. Portfolios are treated as independent (no cross-correlation) — a
// deliberate simplification.

// Typical annualized volatility (%) by asset class, used as a default estimate.
export const getAssetVolatility = (assetClass: AssetClass, assetSubClass?: AssetSubClass): number => {
    switch (assetClass) {
        case 'Stock': return 15;
        case 'Bond':
            if (assetSubClass === 'Short') return 2;
            if (assetSubClass === 'Long') return 9;
            return 5; // Medium / unspecified
        case 'Commodity': return 14;
        case 'Crypto': return 60;
        case 'Cash': return 0.5;
        case 'PensionFund': return 8;
        default: return 10;
    }
};

export interface MonteCarloSummary {
    months: number[];
    p10: number[];
    p25: number[];
    p50: number[];
    p75: number[];
    p90: number[];
    /** Share of runs ending solvent with final net worth >= starting net worth */
    successProbability: number;
    /** Share of runs hitting insolvency at any point */
    insolvencyProbability: number;
    finalP10: number;
    finalP50: number;
    finalP90: number;
    startValue: number;
    simulations: number;
    /** Per-run max drawdown (≤ 0, %) of the net-worth path: median / worst decile */
    maxDrawdownP50: number;
    maxDrawdownP90: number;
    /** Share of runs whose max drawdown is deeper than the historical reference (null when no reference) */
    probExceedHistoricalMaxDD: number | null;
    /** The historical reference drawdown (≤ 0, %) the probability is measured against */
    historicalMaxDrawdownPct: number | null;
    /** Sampling model actually used per portfolio (for UI display) */
    modelByPortfolio: Record<string, 'bootstrap' | 'lognormal'>;
}

// Calibration from real history (Performance data). Portfolios with at least
// `minBootstrapMonths` monthly flow-adjusted log-returns are simulated by
// block-bootstrapping those returns (blocks of consecutive months preserve
// volatility clustering, so realistic drawdown streaks survive resampling);
// the others fall back to the lognormal model.
export interface MonteCarloCalibration {
    /** Historical monthly log-returns per portfolio id (flow-adjusted) */
    monthlyLogReturnsByPortfolio?: Record<string, number[]>;
    /** Portfolio ids that must use lognormal even with enough history (e.g. manual vol override) */
    forceLognormal?: string[];
    minBootstrapMonths?: number; // default 10
    blockMonths?: number;        // default 3
    /** Historical net-worth max drawdown (≤ 0, %) used as stress reference */
    historicalMaxDrawdownPct?: number | null;
}

// Deterministic PRNG so the same inputs render the same chart (re-roll via seed).
const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const percentile = (sorted: number[], p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

export const runMonteCarloForecast = (
    portfolios: ForecastPortfolioInput[],
    brokers: Broker[],
    monthlySavings: number,
    monthlyExpenses: number,
    timeHorizonYears: number,
    portfolioReturns: Record<string, number>,
    portfolioVolatilities: Record<string, number>, // annualized %
    yearlyExpenses: ForecastExpense[] = [],
    simulations: number = 500,
    seed: number = 12345,
    options: ForecastOptions = {},
    calibration: MonteCarloCalibration = {}
): MonteCarloSummary => {
    const months = timeHorizonYears * 12;
    const rng = mulberry32(seed);
    const minBootstrapMonths = calibration.minBootstrapMonths ?? 10;
    const blockMonths = Math.max(1, calibration.blockMonths ?? 3);
    const forceLognormal = new Set(calibration.forceLognormal ?? []);

    // Box-Muller transform, caching the spare deviate
    let spare: number | null = null;
    const gaussian = (): number => {
        if (spare !== null) {
            const v = spare;
            spare = null;
            return v;
        }
        let u = 0, v = 0;
        while (u === 0) u = rng();
        while (v === 0) v = rng();
        const mag = Math.sqrt(-2 * Math.log(u));
        spare = mag * Math.sin(2 * Math.PI * v);
        return mag * Math.cos(2 * Math.PI * v);
    };

    // Pre-compute lognormal params per portfolio:
    // monthly return = exp(m + s*Z) - 1, with median compounding to the CAGR
    const params: Record<string, { m: number; s: number }> = {};
    portfolios.forEach(p => {
        const mu = (portfolioReturns[p.id] || 0) / 100;
        const sigma = Math.max(0, portfolioVolatilities[p.id] || 0) / 100;
        const s = sigma / Math.sqrt(12);
        const m = Math.log(1 + Math.max(mu, -0.99)) / 12;
        params[p.id] = { m, s };
    });

    // Pick the sampling model per portfolio: historical bootstrap when enough
    // monthly returns exist (and not overridden), lognormal otherwise.
    const historyByPortfolio = calibration.monthlyLogReturnsByPortfolio ?? {};
    const modelByPortfolio: Record<string, 'bootstrap' | 'lognormal'> = {};
    portfolios.forEach(p => {
        const hist = historyByPortfolio[p.id];
        modelByPortfolio[p.id] =
            !forceLognormal.has(p.id) && hist && hist.length >= minBootstrapMonths
                ? 'bootstrap'
                : 'lognormal';
    });

    const startValue =
        portfolios.reduce((sum, p) => sum + p.currentValue, 0) +
        brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);

    // totalsByMonth[month][sim] = total net worth
    const totalsByMonth: number[][] = Array.from({ length: months }, () => new Array<number>(simulations));
    let successes = 0;
    let insolvencies = 0;
    const runMaxDrawdowns: number[] = []; // ≤ 0, fraction

    for (let sim = 0; sim < simulations; sim++) {
        // Bootstrap portfolios: pre-draw the whole path as wraparound blocks of
        // consecutive historical months, so bad streaks stay together.
        const bootstrapSeq: Record<string, number[]> = {};
        portfolios.forEach(p => {
            if (modelByPortfolio[p.id] !== 'bootstrap') return;
            const src = historyByPortfolio[p.id]!;
            const seq: number[] = [];
            while (seq.length < months) {
                const start = Math.floor(rng() * src.length);
                for (let k = 0; k < blockMonths && seq.length < months; k++) {
                    seq.push(src[(start + k) % src.length]);
                }
            }
            bootstrapSeq[p.id] = seq;
        });

        const sampler: MonthlyReturnSampler = (pid, month) => {
            const seq = bootstrapSeq[pid];
            if (seq) return Math.exp(seq[month - 1]) - 1;
            const { m, s } = params[pid] || { m: 0, s: 0 };
            if (s === 0) return Math.exp(m) - 1;
            return Math.exp(m + s * gaussian()) - 1;
        };

        const run = calculateForecastWithState(
            portfolios, brokers, monthlySavings, monthlyExpenses,
            timeHorizonYears, portfolioReturns, yearlyExpenses, sampler, options
        );

        // Max drawdown of this run's net-worth path (cashflows included: it
        // answers "how deep could my wealth dip", not pure return drawdown).
        let peak = startValue > 0 ? startValue : (run[0]?.totalValue ?? 0);
        let maxDD = 0;
        for (let i = 0; i < months; i++) {
            const v = run[i]?.totalValue ?? 0;
            totalsByMonth[i][sim] = v;
            if (v > peak) peak = v;
            else if (peak > 0) {
                const dd = v / peak - 1;
                if (dd < maxDD) maxDD = dd;
            }
        }
        runMaxDrawdowns.push(maxDD);

        const last = run[run.length - 1];
        if (last?.insolvent) insolvencies++;
        if (last && !last.insolvent && last.totalValue >= startValue) successes++;
    }

    const p10: number[] = [], p25: number[] = [], p50: number[] = [], p75: number[] = [], p90: number[] = [];
    const monthIdx: number[] = [];

    for (let i = 0; i < months; i++) {
        const sorted = [...totalsByMonth[i]].sort((a, b) => a - b);
        monthIdx.push(i + 1);
        p10.push(percentile(sorted, 0.10));
        p25.push(percentile(sorted, 0.25));
        p50.push(percentile(sorted, 0.50));
        p75.push(percentile(sorted, 0.75));
        p90.push(percentile(sorted, 0.90));
    }

    // Drawdown distribution: P50 = typical run, P90 = worst decile boundary
    // (both reported as negative %). Magnitudes are sorted ascending so the
    // 90th percentile of magnitude is the deep tail.
    const ddMagnitudes = runMaxDrawdowns.map(d => -d).sort((a, b) => a - b);
    const maxDrawdownP50 = -percentile(ddMagnitudes, 0.50) * 100;
    const maxDrawdownP90 = -percentile(ddMagnitudes, 0.90) * 100;

    const histDD = calibration.historicalMaxDrawdownPct ?? null;
    const probExceedHistoricalMaxDD = histDD !== null && histDD < 0 && simulations > 0
        ? runMaxDrawdowns.filter(d => d * 100 < histDD).length / simulations
        : null;

    return {
        months: monthIdx,
        p10, p25, p50, p75, p90,
        successProbability: simulations > 0 ? successes / simulations : 0,
        insolvencyProbability: simulations > 0 ? insolvencies / simulations : 0,
        finalP10: p10[p10.length - 1] ?? 0,
        finalP50: p50[p50.length - 1] ?? 0,
        finalP90: p90[p90.length - 1] ?? 0,
        startValue,
        simulations,
        maxDrawdownP50,
        maxDrawdownP90,
        probExceedHistoricalMaxDD,
        historicalMaxDrawdownPct: histDD,
        modelByPortfolio
    };
};
