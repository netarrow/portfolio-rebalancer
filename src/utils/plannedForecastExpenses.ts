import type { PlannedForecastExpense, Portfolio, YnabGoal, YnabGoalAllocation } from '../types';

// A YNAB goal becomes a forecast expense only when it has both a target amount
// and a target date; archived goals are excluded.
export const isForecastableYnabGoal = (g: YnabGoal): boolean =>
    !g.archived && (g.targetAmount ?? 0) > 0 && !!g.targetDate;

// Forecast years are relative (Year 1 = current calendar year of the simulation
// start). Map the goal's absolute target date onto that scale; past dates clamp
// to Year 1 so the expense still hits the simulation immediately.
export const forecastYearForDate = (targetDate: string, now: Date = new Date()): number => {
    const targetYear = parseInt(targetDate.slice(0, 4), 10);
    if (!isFinite(targetYear)) return 1;
    return Math.max(1, targetYear - now.getFullYear() + 1);
};

// Build the planned-expense list from the current YNAB goals. The allowed
// funding Goals are derived from the goal's portfolio allocations: portfolios
// funding the YNAB goal → their linked manual Goal. No allocations (or
// allocations to portfolios without a Goal) → empty list = all portfolios.
export const buildPlannedForecastExpenses = (
    ynabGoals: YnabGoal[],
    ynabGoalAllocations: YnabGoalAllocation[],
    portfolios: Portfolio[]
): PlannedForecastExpense[] => {
    const goalIdByPortfolio: Record<string, string | undefined> = {};
    portfolios.forEach(p => { goalIdByPortfolio[p.id] = p.goalId; });

    const now = new Date().toISOString();

    return ynabGoals
        .filter(isForecastableYnabGoal)
        .map(g => {
            const allowedGoalIds = Array.from(new Set(
                ynabGoalAllocations
                    .filter(a => a.ynabGoalId === g.id)
                    .map(a => goalIdByPortfolio[a.portfolioId])
                    .filter((id): id is string => !!id)
            ));
            return {
                id: g.id,
                ynabGoalId: g.id,
                description: g.name,
                targetDate: g.targetDate!,
                amount: g.targetAmount!,
                enabled: true,
                allowedGoalIds,
                erosionAllowed: false,
                importedAt: now,
            };
        })
        .sort((a, b) => a.targetDate.localeCompare(b.targetDate));
};
