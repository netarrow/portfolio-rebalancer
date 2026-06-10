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
    primaryGoal?: string; // e.g. 'Growth', 'Protection'
}

export interface ForecastExpense {
    year: number;
    amount: number;
    allowedTypes?: string[]; // If empty/undefined, all allowed
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
        primaryGoal: p.primaryGoal || 'Growth' // Default fallback
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

            // 3. Pay with Allowed Portfolios
            const allowedTypes = expense.allowedTypes;
            const eligiblePortfolios = portfolioState.filter(p => {
                if (!allowedTypes || allowedTypes.length === 0) return true;
                return allowedTypes.includes(p.primaryGoal);
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
                        failureReason = `Risk Warning Year ${currentYear}: Insufficient funds in ${allowedTypes?.join(', ') || 'All Allowed Protocols'}. Needed €${expenseAmount.toFixed(0)}.`;
                    }
                }
            }

            if (eligibleTotalValue > 0) {
                eligiblePortfolios.forEach(p => {
                    const share = (p.value / eligibleTotalValue) * expenseAmount;
                    const withdraw = Math.min(p.value, share);
                    p.value -= withdraw;
                });
            } else {
                // Fallback: If we are here, we either breached rules or are insolvent.
                // Logic: Iterate ALL portfolios if eligible are empty/insufficient, to show the impact on Net Worth.
                if (portfolioState.length > 0) {
                    const totalP = portfolioState.reduce((sum, p) => sum + p.value, 0);
                    if (totalP > 0) {
                        portfolioState.forEach(p => {
                            const share = (p.value / totalP) * expenseAmount;
                            p.value -= Math.min(p.value, share);
                        });
                    } else {
                        // Debt on broker
                        if (brokerState.length > 0) brokerState[0].liquidity -= expenseAmount;
                    }
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
    options: ForecastOptions = {}
): MonteCarloSummary => {
    const months = timeHorizonYears * 12;
    const rng = mulberry32(seed);

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

    const startValue =
        portfolios.reduce((sum, p) => sum + p.currentValue, 0) +
        brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);

    // totalsByMonth[month][sim] = total net worth
    const totalsByMonth: number[][] = Array.from({ length: months }, () => new Array<number>(simulations));
    let successes = 0;
    let insolvencies = 0;

    for (let sim = 0; sim < simulations; sim++) {
        const sampler: MonthlyReturnSampler = (pid) => {
            const { m, s } = params[pid] || { m: 0, s: 0 };
            if (s === 0) return Math.exp(m) - 1;
            return Math.exp(m + s * gaussian()) - 1;
        };

        const run = calculateForecastWithState(
            portfolios, brokers, monthlySavings, monthlyExpenses,
            timeHorizonYears, portfolioReturns, yearlyExpenses, sampler, options
        );

        for (let i = 0; i < months; i++) {
            totalsByMonth[i][sim] = run[i]?.totalValue ?? 0;
        }

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

    return {
        months: monthIdx,
        p10, p25, p50, p75, p90,
        successProbability: simulations > 0 ? successes / simulations : 0,
        insolvencyProbability: simulations > 0 ? insolvencies / simulations : 0,
        finalP10: p10[p10.length - 1] ?? 0,
        finalP50: p50[p50.length - 1] ?? 0,
        finalP90: p90[p90.length - 1] ?? 0,
        startValue,
        simulations
    };
};
