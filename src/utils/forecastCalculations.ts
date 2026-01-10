import type { Portfolio, Broker } from '../types';

export interface ForecastResult {
    month: number;
    totalValue: number;
    investedValue: number;
    liquidityValue: number;
    portfolios: Record<string, number>;
}

export interface ForecastPortfolioInput extends Portfolio {
    currentValue: number;
}

export const calculateForecastWithState = (
    portfolios: ForecastPortfolioInput[],
    brokers: Broker[],
    monthlySavings: number,
    monthlyExpenses: number,
    timeHorizonYears: number,
    portfolioReturns: Record<string, number>
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
        value: p.currentValue
    }));

    for (let month = 1; month <= months; month++) {
        // Net Monthly Inflow = Savings - Expenses
        // Assuming "Savings" input means "Income/Available" and "Expenses" reduces it.
        // If result is negative, we drain liquidity? For now let's floor at 0 to avoid complexity unless asked.
        // Actually, user said "take expenses into account". 
        // Simple Interpretation: Investable = Max(0, Savings - Expenses)
        let monthlyInflow = monthlySavings - monthlyExpenses;

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

            // If deficit remains, what do we do? 
            // 1. Sell assets? (Complex rebalancing)
            // 2. Go into negative liquidity (Debt)?
            // For now, let's allow negative liquidity on the first broker (or spread it) to represent debt/shortfall.
            // This ensures Net Worth drops.
            if (deficit > 0) {
                // Force debit on first broker or spread?
                // Let's just put remaining debt on the first broker found, or a "Main" one.
                // Simple approach: Apply to first broker.
                if (brokerState.length > 0) {
                    brokerState[0].liquidity -= deficit;
                }
            }
            // Inflow is now fully handled (absorbed by liquidity/debt)
            monthlyInflow = 0;
        }

        // 2. Liquidity Check & Replenishment
        // We need to know which broker holds which portfolio or if liquidity is global.
        // In the current context, `Broker` has liquidity. `Portfolio` doesn't explicitly link to a broker globally, 
        // but transactions do. However, for liquidity replenishment, we usually want to top up the broker 
        // that is below its minimum.

        let totalLiquidity = 0;
        let totalInvested = 0;

        // Update Broker Liquidity from Inflow (Only if positive)
        if (monthlyInflow > 0) {
            brokerState.forEach(broker => {
                let minReq = 0;
                if (broker.minLiquidityType === 'fixed') {
                    minReq = broker.minLiquidityAmount || 0;
                } else if (broker.minLiquidityType === 'percent') {
                    // SIMPLIFICATION: If 'percent', assume it's % of (Liquidity + Proportional Portfolio Value).
                    // Let's assume we just fill the "Fixed" requirements first as they are absolute.
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
            // (to maintain percentages as requested: "mantenendo le percentuali di allocazioni attuali tra portafogli")

            const totalPortfolioValue = portfolioState.reduce((sum, p) => sum + p.value, 0);

            if (totalPortfolioValue > 0) {
                portfolioState.forEach(p => {
                    const weight = p.value / totalPortfolioValue;
                    const allocation = monthlyInflow * weight;
                    p.value += allocation;
                });
            } else {
                // If no current value, distribute evenly? Or just to first?
                // Split evenly
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
            }, {} as Record<string, number>)
        });
    }

    return results;
};
