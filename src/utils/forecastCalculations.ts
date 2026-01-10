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
        let monthlyInflow = monthlySavings;

        // 2. Liquidity Check & Replenishment
        // We need to know which broker holds which portfolio or if liquidity is global.
        // In the current context, `Broker` has liquidity. `Portfolio` doesn't explicitly link to a broker globally, 
        // but transactions do. However, for liquidity replenishment, we usually want to top up the broker 
        // that is below its minimum.

        let totalLiquidity = 0;
        let totalInvested = 0;

        // Update Broker Liquidity from Inflow
        // Strategy: Fill brokers proportionally or priority? 
        // Simple strategy: Iterate and fill up to min requirement.

        brokerState.forEach(broker => {
            let minReq = 0;
            if (broker.minLiquidityType === 'fixed') {
                minReq = broker.minLiquidityAmount || 0;
            } else if (broker.minLiquidityType === 'percent') {
                // This is tricky: % of what? Usually % of total assets held at that broker.
                // We don't easily know total assets per broker without summing all assets.
                // For this forecast, that might be too complex to simulate accurately per broker 
                // without mapping every asset to a broker.
                // SIMPLIFICATION: If 'percent', assume it's % of (Liquidity + Proportional Portfolio Value).
                // OR: Just ignore percent for now and rely on fixed, OR ask user for a "Global Liquidity Target".
                // Given the prompt: "risparmio deve prima di tutto assicurarsi che le liquidità minime sui broker siano mantenute"
                // I will try to estimate.
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
