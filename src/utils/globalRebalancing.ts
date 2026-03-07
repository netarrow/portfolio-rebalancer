import type { GlobalRebalancingSettings } from '../types';

export interface GlobalRebalancingPortfolioInput {
  portfolioId: string;
  name: string;
  currentInvestedValue: number;
  currentLiquidity: number;
  currentTotalValue: number;
  targetWeight: number;
  included: boolean;
}

export interface GlobalRebalancingPortfolioResult extends GlobalRebalancingPortfolioInput {
  normalizedWeight: number;
  currentWeight: number;
  targetValue: number;
  gapToTarget: number;
  suggestedInvestment: number;
  projectedValue: number;
  projectedWeight: number;
}

export interface GlobalRebalancingResult {
  portfolios: GlobalRebalancingPortfolioResult[];
  totalInvestmentAmount: number;
  totalSelectedValue: number;
  totalAfterInvestment: number;
  totalIncludedWeight: number;
  blockingIssues: string[];
  warnings: string[];
}

const roundToCents = (value: number): number => Math.round(value * 100) / 100;

export const normalizeGlobalRebalancingSettings = (
  settings: unknown
): { weightsByPortfolioId: Record<string, number> } => {
  if (!settings || typeof settings !== 'object') {
    return { weightsByPortfolioId: {} };
  }

  const rawWeights =
    'weightsByPortfolioId' in settings &&
    settings.weightsByPortfolioId &&
    typeof settings.weightsByPortfolioId === 'object'
      ? settings.weightsByPortfolioId
      : {};

  const weightsByPortfolioId = Object.entries(rawWeights).reduce<Record<string, number>>((acc, [portfolioId, weight]) => {
    const numericWeight = typeof weight === 'number' ? weight : Number(weight);
    if (Number.isFinite(numericWeight) && numericWeight > 0) {
      acc[portfolioId] = roundToCents(numericWeight);
    }
    return acc;
  }, {});

  return { weightsByPortfolioId };
};

const allocateByLargestRemainder = (
  amount: number,
  rows: Array<{ portfolioId: string; weight: number }>
): Record<string, number> => {
  const totalCents = Math.max(0, Math.round(amount * 100));
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);

  if (totalCents === 0 || totalWeight <= 0) {
    return {};
  }

  const provisional = rows.map((row) => {
    const rawCents = (row.weight / totalWeight) * totalCents;
    const floorCents = Math.floor(rawCents);
    return {
      portfolioId: row.portfolioId,
      cents: floorCents,
      remainder: rawCents - floorCents
    };
  });

  let remainingCents = totalCents - provisional.reduce((sum, row) => sum + row.cents, 0);

  provisional
    .sort((a, b) => b.remainder - a.remainder)
    .forEach((row) => {
      if (remainingCents > 0) {
        row.cents += 1;
        remainingCents -= 1;
      }
    });

  return provisional.reduce<Record<string, number>>((acc, row) => {
    if (row.cents > 0) {
      acc[row.portfolioId] = row.cents / 100;
    }
    return acc;
  }, {});
};

export const calculateGlobalRebalancingDistribution = (
  portfolios: GlobalRebalancingPortfolioInput[],
  investmentAmount: number
): GlobalRebalancingResult => {
  const normalizedPortfolios = portfolios.map((portfolio) => ({
    ...portfolio,
    currentInvestedValue: Number.isFinite(portfolio.currentInvestedValue) ? Math.max(0, portfolio.currentInvestedValue) : 0,
    currentLiquidity: Number.isFinite(portfolio.currentLiquidity) ? Math.max(0, portfolio.currentLiquidity) : 0,
    currentTotalValue: Number.isFinite(portfolio.currentTotalValue) ? Math.max(0, portfolio.currentTotalValue) : 0,
    targetWeight: Number.isFinite(portfolio.targetWeight) ? Math.max(0, portfolio.targetWeight) : 0
  }));

  const safeInvestmentAmount = Number.isFinite(investmentAmount) ? roundToCents(Math.max(0, investmentAmount)) : 0;
  const selectedPortfolios = normalizedPortfolios.filter((portfolio) => portfolio.included);
  const totalSelectedValue = roundToCents(
    selectedPortfolios.reduce((sum, portfolio) => sum + portfolio.currentTotalValue, 0)
  );
  const totalAfterInvestment = roundToCents(totalSelectedValue + safeInvestmentAmount);
  const totalIncludedWeight = roundToCents(
    selectedPortfolios.reduce((sum, portfolio) => sum + portfolio.targetWeight, 0)
  );
  const blockingIssues: string[] = [];
  const warnings: string[] = [];

  if (selectedPortfolios.length === 0) {
    blockingIssues.push('Select at least one portfolio.');
  }

  if (safeInvestmentAmount <= 0) {
    blockingIssues.push('Enter a positive amount to invest.');
  }

  if (selectedPortfolios.length > 0 && totalIncludedWeight <= 0) {
    blockingIssues.push('Set a global weight above 0% for at least one selected portfolio.');
  }

  const selectedWithTargets =
    totalIncludedWeight > 0
      ? selectedPortfolios.map((portfolio) => {
          const normalizedWeight = portfolio.targetWeight / totalIncludedWeight;
          const targetValue = totalAfterInvestment * normalizedWeight;
          const gapToTarget = targetValue - portfolio.currentTotalValue;
          return {
            portfolioId: portfolio.portfolioId,
            normalizedWeight,
            targetValue,
            gapToTarget
          };
        })
      : [];

  const positiveGaps = selectedWithTargets
    .filter((portfolio) => portfolio.gapToTarget > 0)
    .map((portfolio) => ({
      portfolioId: portfolio.portfolioId,
      weight: portfolio.gapToTarget
    }));

  const suggestedInvestments =
    blockingIssues.length === 0
      ? allocateByLargestRemainder(safeInvestmentAmount, positiveGaps)
      : {};

  const portfoliosResult = normalizedPortfolios.map<GlobalRebalancingPortfolioResult>((portfolio) => {
    const selectedTarget = selectedWithTargets.find((item) => item.portfolioId === portfolio.portfolioId);
    const suggestedInvestment = roundToCents(suggestedInvestments[portfolio.portfolioId] || 0);
    const projectedValue = roundToCents(portfolio.currentTotalValue + suggestedInvestment);
    const currentWeight = totalSelectedValue > 0 && portfolio.included
      ? (portfolio.currentTotalValue / totalSelectedValue) * 100
      : 0;
    const projectedWeight = totalAfterInvestment > 0 && portfolio.included
      ? (projectedValue / totalAfterInvestment) * 100
      : 0;

    return {
      ...portfolio,
      normalizedWeight: selectedTarget ? selectedTarget.normalizedWeight * 100 : 0,
      currentWeight,
      targetValue: roundToCents(selectedTarget?.targetValue || 0),
      gapToTarget: roundToCents(selectedTarget?.gapToTarget || 0),
      suggestedInvestment,
      projectedValue,
      projectedWeight
    };
  });

  const hasOverweightSelectedPortfolio = selectedWithTargets.some((portfolio) => portfolio.gapToTarget < 0);
  if (hasOverweightSelectedPortfolio) {
    warnings.push('Some selected portfolios are overweight. Distribution uses buy-only logic and will move the mix closer to target without selling.');
  }

  return {
    portfolios: portfoliosResult,
    totalInvestmentAmount: safeInvestmentAmount,
    totalSelectedValue,
    totalAfterInvestment,
    totalIncludedWeight,
    blockingIssues,
    warnings
  };
};

export const getWeightForPortfolio = (
  settings: GlobalRebalancingSettings | undefined,
  portfolioId: string
): number => {
  const normalizedSettings = normalizeGlobalRebalancingSettings(settings);
  return normalizedSettings.weightsByPortfolioId[portfolioId] || 0;
};
