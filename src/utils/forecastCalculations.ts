import type { Portfolio, Broker } from '../types';

export interface ForecastResult {
    month: number;
    totalValue: number;
    investedValue: number;
    liquidityValue: number;
    portfolios: Record<string, number>;
    cashflow: number;
    failed?: boolean;
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

export const calculateForecastWithState = (
    portfolios: ForecastPortfolioInput[],
    brokers: Broker[],
    monthlySavings: number,
    monthlyExpenses: number,
    timeHorizonYears: number,
    portfolioReturns: Record<string, number>,
    yearlyExpenses: ForecastExpense[] = []
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

    let hasFailed = false;
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
                // FAILURE: Insufficient funds in eligible portfolios
                hasFailed = true;
                failureReason = `Insufficient funds in ${allowedTypes?.join(', ') || 'All Portfolios'} for Year ${currentYear}. Needed €${expenseAmount.toFixed(0)}, available €${eligibleTotalValue.toFixed(0)}.`;
            }

            if (eligibleTotalValue > 0) {
                eligiblePortfolios.forEach(p => {
                    const share = (p.value / eligibleTotalValue) * expenseAmount;
                    const withdraw = Math.min(p.value, share);
                    p.value -= withdraw;
                });
            } else {
                // Fallback: Force debt on main broker
                if (brokerState.length > 0) {
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
                // If still deficit after draining everything, it's true debt (negative liquidity on main broker?)
                // For now, if portfolios are empty, we just let it go. 
                // Alternatively we could track negative liquidity.
                // Let's stop here as requested ("ridistribuito sui diversi portafogli")
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

        // 4. Compound Growth
        portfolioState.forEach(p => {
            const annualRate = portfolioReturns[p.id] || 0; // %
            const monthlyRate = Math.pow(1 + annualRate / 100, 1 / 12) - 1;
            p.value = p.value * (1 + monthlyRate);
        });

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
            failed: hasFailed,
            failureReason: failureReason || undefined
        });
    }

    return results;
};
