import type {
  AssetAllocationSettings,
  LiquidityTargetConfig,
  PortfolioTargetConfig,
  PortfolioTargetMode,
  RatioGroupConfig,
  RatioGroupTargetMode
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const roundToCents = (value: number): number => Math.round(value * 100) / 100;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const sanitizeNumber = (value: unknown, fallback = 0): number =>
  isFiniteNumber(value) ? value : fallback;

const VALID_PORTFOLIO_MODES: PortfolioTargetMode[] = ['excluded', 'locked', 'fixed', 'percent', 'ratio'];
const VALID_GROUP_MODES: RatioGroupTargetMode[] = ['fixed', 'percent', 'remainder'];

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export const normalizeAssetAllocationSettings = (raw: unknown): AssetAllocationSettings => {
  const base: AssetAllocationSettings = {
    portfolioTargets: {},
    ratioGroups: []
  };

  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const src = raw as Record<string, unknown>;

  // liquidityTarget
  let liquidityTarget: LiquidityTargetConfig | undefined;
  if (src.liquidityTarget && typeof src.liquidityTarget === 'object') {
    const lt = src.liquidityTarget as Record<string, unknown>;
    const mode = lt.mode === 'percent' ? 'percent' : lt.mode === 'fixed' ? 'fixed' : undefined;
    const value = sanitizeNumber(lt.value, 0);
    if (mode && value >= 0) {
      liquidityTarget = { mode, value: roundToCents(value) };
    }
  }

  // ratioGroups
  const ratioGroups: RatioGroupConfig[] = [];
  const seenGroupIds = new Set<string>();
  let remainderGroupFound = false;
  if (Array.isArray(src.ratioGroups)) {
    for (const item of src.ratioGroups) {
      if (!item || typeof item !== 'object') continue;
      const g = item as Record<string, unknown>;
      const id = typeof g.id === 'string' && g.id.trim() ? g.id : '';
      const name = typeof g.name === 'string' && g.name.trim() ? g.name : '';
      if (!id || !name || seenGroupIds.has(id)) continue;
      const modeRaw = g.groupTargetMode;
      if (!VALID_GROUP_MODES.includes(modeRaw as RatioGroupTargetMode)) continue;
      let mode = modeRaw as RatioGroupTargetMode;
      // Enforce "only one remainder group" rule during normalization
      if (mode === 'remainder') {
        if (remainderGroupFound) {
          // Demote to percent 0 (effectively inert) to keep data resilient
          mode = 'percent';
        } else {
          remainderGroupFound = true;
        }
      }
      const value = Math.max(0, sanitizeNumber(g.groupTargetValue, 0));
      seenGroupIds.add(id);
      ratioGroups.push({
        id,
        name,
        groupTargetMode: mode,
        groupTargetValue: roundToCents(value)
      });
    }
  }

  // portfolioTargets
  const portfolioTargets: Record<string, PortfolioTargetConfig> = {};
  if (src.portfolioTargets && typeof src.portfolioTargets === 'object') {
    for (const [portfolioId, raw] of Object.entries(src.portfolioTargets as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const pt = raw as Record<string, unknown>;
      const mode = VALID_PORTFOLIO_MODES.includes(pt.mode as PortfolioTargetMode)
        ? (pt.mode as PortfolioTargetMode)
        : undefined;
      if (!mode) continue;
      const value = Math.max(0, sanitizeNumber(pt.value, 0));
      let ratioGroupId: string | undefined;
      if (mode === 'ratio') {
        ratioGroupId = typeof pt.ratioGroupId === 'string' ? pt.ratioGroupId : undefined;
        if (!ratioGroupId || !seenGroupIds.has(ratioGroupId)) {
          // Orphaned ratio target -> treat as excluded
          portfolioTargets[portfolioId] = { mode: 'excluded', value: 0 };
          continue;
        }
      }
      portfolioTargets[portfolioId] = {
        mode,
        value: roundToCents(value),
        ...(ratioGroupId ? { ratioGroupId } : {})
      };
    }
  }

  return { liquidityTarget, portfolioTargets, ratioGroups };
};

// ---------------------------------------------------------------------------
// Largest remainder rounding (preserves totals to the cent)
// ---------------------------------------------------------------------------

export const allocateByLargestRemainder = (
  amount: number,
  rows: Array<{ key: string; weight: number }>
): Record<string, number> => {
  const totalCents = Math.max(0, Math.round(amount * 100));
  const totalWeight = rows.reduce((sum, row) => sum + Math.max(0, row.weight), 0);

  if (totalCents === 0 || totalWeight <= 0) {
    return {};
  }

  const provisional = rows.map((row) => {
    const w = Math.max(0, row.weight);
    const rawCents = (w / totalWeight) * totalCents;
    const floorCents = Math.floor(rawCents);
    return {
      key: row.key,
      cents: floorCents,
      remainder: rawCents - floorCents
    };
  });

  let remainingCents = totalCents - provisional.reduce((sum, row) => sum + row.cents, 0);

  provisional
    .slice()
    .sort((a, b) => b.remainder - a.remainder)
    .forEach((row) => {
      if (remainingCents > 0) {
        const ref = provisional.find((r) => r.key === row.key);
        if (ref) ref.cents += 1;
        remainingCents -= 1;
      }
    });

  return provisional.reduce<Record<string, number>>((acc, row) => {
    acc[row.key] = row.cents / 100;
    return acc;
  }, {});
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface AssetAllocationPortfolioInput {
  portfolioId: string;
  name: string;
  currentInvestedValue: number;
  currentPortfolioLiquidity: number;
  currentTotalValue: number;
}

export interface AssetAllocationInput {
  portfolios: AssetAllocationPortfolioInput[];
  brokerLiquidity: number;
  settings: AssetAllocationSettings;
}

export interface AssetAllocationPortfolioResult {
  portfolioId: string;
  name: string;
  mode: PortfolioTargetMode;
  currentValue: number;
  currentWeight: number;   // % on eligibleTotal
  targetValue: number;
  targetWeight: number;    // % on eligibleTotal
  delta: number;           // targetValue - currentValue
  ratioGroupId?: string;
  ratioValue?: number;     // relative weight for ratio mode
  fixedValue?: number;     // EUR for fixed mode
  percentValue?: number;   // % for percent mode
}

export interface AssetAllocationGroupResult {
  id: string;
  name: string;
  groupTargetMode: RatioGroupTargetMode;
  groupTargetValue: number;
  budget: number;
  members: string[];
  memberWeightsSum: number;
  orphan: boolean; // budget > 0 but no members
}

export type AssetAllocationAction =
  | { kind: 'buy'; portfolioId: string; name: string; amount: number }
  | { kind: 'sell'; portfolioId: string; name: string; amount: number }
  | { kind: 'liquidity-increase'; amount: number }
  | { kind: 'liquidity-decrease'; amount: number };

export interface AssetAllocationResult {
  totalWealth: number;
  eligibleTotal: number;
  liquidity: {
    current: number;
    target: number;
    delta: number;
    hasTarget: boolean;
  };
  portfolios: AssetAllocationPortfolioResult[];
  ratioGroups: AssetAllocationGroupResult[];
  actions: AssetAllocationAction[];
  sustainability: {
    sustainable: boolean;
    shortfall: number;
    message: string;
  };
  warnings: string[];
  unallocatedRemainder: number;
}

const resolveValue = (mode: 'fixed' | 'percent', value: number, base: number): number => {
  if (mode === 'fixed') return Math.max(0, value);
  return Math.max(0, (value / 100) * base);
};

export const calculateAssetAllocation = (input: AssetAllocationInput): AssetAllocationResult => {
  const settings = input.settings;
  const brokerLiquidity = Math.max(0, sanitizeNumber(input.brokerLiquidity, 0));
  const warnings: string[] = [];

  // 1. Classify portfolios by mode (default: excluded if no target configured)
  type Classified = AssetAllocationPortfolioInput & {
    config: PortfolioTargetConfig;
  };
  const classified: Classified[] = input.portfolios.map((p) => {
    const rawConfig = settings.portfolioTargets[p.portfolioId];
    const config: PortfolioTargetConfig = rawConfig ?? { mode: 'excluded', value: 0 };
    return { ...p, config };
  });

  // 2. eligibleTotal = non-excluded portfolio totals + brokerLiquidity
  const includedPortfolios = classified.filter((p) => p.config.mode !== 'excluded');
  const sumPortfoliosIncluded = includedPortfolios.reduce((sum, p) => sum + p.currentTotalValue, 0);
  const eligibleTotal = roundToCents(sumPortfoliosIncluded + brokerLiquidity);
  const totalWealth = eligibleTotal;

  // 3. Resolve explicit targets
  const liquidityHasTarget = !!settings.liquidityTarget;
  const liquidityBudget = liquidityHasTarget
    ? resolveValue(settings.liquidityTarget!.mode, settings.liquidityTarget!.value, eligibleTotal)
    : brokerLiquidity;

  let lockedBudget = 0;
  let fixedBudget = 0;
  let percentBudget = 0;

  for (const p of includedPortfolios) {
    if (p.config.mode === 'locked') lockedBudget += p.currentTotalValue;
    else if (p.config.mode === 'fixed') fixedBudget += Math.max(0, p.config.value);
    else if (p.config.mode === 'percent')
      percentBudget += (Math.max(0, p.config.value) / 100) * eligibleTotal;
  }

  // 4. Resolve ratio group budgets (fixed/percent first)
  let groupFixedBudget = 0;
  let groupPercentBudget = 0;
  const groupBudgetById: Record<string, number> = {};
  let remainderGroupId: string | null = null;

  for (const g of settings.ratioGroups) {
    if (g.groupTargetMode === 'fixed') {
      const b = Math.max(0, g.groupTargetValue);
      groupBudgetById[g.id] = b;
      groupFixedBudget += b;
    } else if (g.groupTargetMode === 'percent') {
      const b = Math.max(0, (g.groupTargetValue / 100) * eligibleTotal);
      groupBudgetById[g.id] = b;
      groupPercentBudget += b;
    } else if (g.groupTargetMode === 'remainder') {
      groupBudgetById[g.id] = 0; // computed below
      remainderGroupId = g.id;
    }
  }

  // 5. Remainder
  const totalAssigned =
    liquidityBudget + lockedBudget + fixedBudget + percentBudget + groupFixedBudget + groupPercentBudget;
  const remainder = roundToCents(eligibleTotal - totalAssigned);

  // 6. Sustainability & remainder group
  let sustainable = true;
  let shortfall = 0;
  let unallocatedRemainder = 0;

  if (remainder < -0.005) {
    sustainable = false;
    shortfall = roundToCents(-remainder);
  } else if (remainder > 0.005) {
    if (remainderGroupId) {
      groupBudgetById[remainderGroupId] = remainder;
    } else {
      unallocatedRemainder = remainder;
      warnings.push(
        `€${remainder.toFixed(2)} non allocati: aggiungi un ratio group "remainder" o alza i target per assorbirli.`
      );
    }
  } else if (remainderGroupId) {
    groupBudgetById[remainderGroupId] = 0;
  }

  // 7. Distribute ratio group budgets across members via largest remainder
  const membersByGroupId: Record<string, Array<{ portfolioId: string; weight: number }>> = {};
  for (const p of includedPortfolios) {
    if (p.config.mode === 'ratio' && p.config.ratioGroupId) {
      const gid = p.config.ratioGroupId;
      if (!groupBudgetById.hasOwnProperty(gid)) continue; // orphan reference (shouldn't happen after normalization)
      if (!membersByGroupId[gid]) membersByGroupId[gid] = [];
      membersByGroupId[gid].push({
        portfolioId: p.portfolioId,
        weight: Math.max(0, p.config.value)
      });
    }
  }

  const portfolioTargetById: Record<string, number> = {};
  const groupResults: AssetAllocationGroupResult[] = [];
  for (const g of settings.ratioGroups) {
    const budget = Math.max(0, groupBudgetById[g.id] ?? 0);
    const members = membersByGroupId[g.id] || [];
    const memberWeightsSum = members.reduce((s, m) => s + m.weight, 0);
    const orphan = budget > 0.005 && members.length === 0;
    if (orphan) {
      warnings.push(`Il gruppo "${g.name}" ha un budget di €${budget.toFixed(2)} ma nessun portafoglio membro.`);
    }
    if (members.length > 0 && memberWeightsSum > 0 && budget > 0) {
      const alloc = allocateByLargestRemainder(
        budget,
        members.map((m) => ({ key: m.portfolioId, weight: m.weight }))
      );
      for (const [pid, val] of Object.entries(alloc)) {
        portfolioTargetById[pid] = val;
      }
    } else if (members.length > 0) {
      // Budget zero or all weights zero -> every member gets 0
      for (const m of members) portfolioTargetById[m.portfolioId] = 0;
    }
    groupResults.push({
      id: g.id,
      name: g.name,
      groupTargetMode: g.groupTargetMode,
      groupTargetValue: g.groupTargetValue,
      budget: roundToCents(budget),
      members: members.map((m) => m.portfolioId),
      memberWeightsSum,
      orphan
    });
  }

  // 8. Compute targets for every portfolio (incl. excluded)
  const portfolioResults: AssetAllocationPortfolioResult[] = classified.map((p) => {
    const mode = p.config.mode;
    let targetValue = 0;
    if (mode === 'excluded') {
      targetValue = 0;
    } else if (mode === 'locked') {
      targetValue = p.currentTotalValue;
    } else if (mode === 'fixed') {
      targetValue = Math.max(0, p.config.value);
    } else if (mode === 'percent') {
      targetValue = (Math.max(0, p.config.value) / 100) * eligibleTotal;
    } else if (mode === 'ratio') {
      targetValue = portfolioTargetById[p.portfolioId] ?? 0;
    }
    targetValue = roundToCents(targetValue);
    const currentValue = roundToCents(p.currentTotalValue);
    const delta = roundToCents(targetValue - currentValue);
    const currentWeight =
      eligibleTotal > 0 && mode !== 'excluded' ? (currentValue / eligibleTotal) * 100 : 0;
    const targetWeight = eligibleTotal > 0 ? (targetValue / eligibleTotal) * 100 : 0;
    return {
      portfolioId: p.portfolioId,
      name: p.name,
      mode,
      currentValue,
      currentWeight,
      targetValue,
      targetWeight,
      delta,
      ratioGroupId: p.config.ratioGroupId,
      ratioValue: mode === 'ratio' ? p.config.value : undefined,
      fixedValue: mode === 'fixed' ? p.config.value : undefined,
      percentValue: mode === 'percent' ? p.config.value : undefined
    };
  });

  // Validate: sum of percent portfolios should not exceed 100
  const totalPercentConfig = includedPortfolios
    .filter((p) => p.config.mode === 'percent')
    .reduce((s, p) => s + Math.max(0, p.config.value), 0);
  if (totalPercentConfig > 100.01) {
    warnings.push(
      `La somma delle percentuali dei portafogli (${totalPercentConfig.toFixed(1)}%) supera il 100%.`
    );
  }

  // 9. Actions
  const liquidityDelta = roundToCents(liquidityBudget - brokerLiquidity);
  const actions: AssetAllocationAction[] = [];

  if (liquidityHasTarget && Math.abs(liquidityDelta) >= 0.01) {
    if (liquidityDelta > 0) {
      actions.push({ kind: 'liquidity-increase', amount: liquidityDelta });
    } else {
      actions.push({ kind: 'liquidity-decrease', amount: -liquidityDelta });
    }
  }

  for (const r of portfolioResults) {
    if (r.mode === 'excluded' || r.mode === 'locked') continue;
    if (Math.abs(r.delta) < 0.01) continue;
    if (r.delta > 0) {
      actions.push({ kind: 'buy', portfolioId: r.portfolioId, name: r.name, amount: r.delta });
    } else {
      actions.push({ kind: 'sell', portfolioId: r.portfolioId, name: r.name, amount: -r.delta });
    }
  }

  actions.sort((a, b) => {
    const amtA = 'amount' in a ? a.amount : 0;
    const amtB = 'amount' in b ? b.amount : 0;
    return amtB - amtA;
  });

  // Sustainability message
  let sustainabilityMessage = '';
  if (!sustainable) {
    sustainabilityMessage = `Configurazione non sostenibile: servono €${shortfall.toFixed(
      2
    )} di liquidità aggiuntiva (oppure riduci i target).`;
  } else if (unallocatedRemainder > 0.01) {
    sustainabilityMessage = `Sostenibile con €${unallocatedRemainder.toFixed(2)} di surplus non allocato.`;
  } else {
    sustainabilityMessage = 'Configurazione sostenibile e completamente allocata.';
  }

  return {
    totalWealth,
    eligibleTotal,
    liquidity: {
      current: roundToCents(brokerLiquidity),
      target: roundToCents(liquidityBudget),
      delta: liquidityDelta,
      hasTarget: liquidityHasTarget
    },
    portfolios: portfolioResults,
    ratioGroups: groupResults,
    actions,
    sustainability: {
      sustainable,
      shortfall,
      message: sustainabilityMessage
    },
    warnings,
    unallocatedRemainder: roundToCents(unallocatedRemainder)
  };
};
