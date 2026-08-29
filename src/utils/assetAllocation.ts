import type {
  AssetAllocationSettings,
  LiquidityTargetConfig,
  PortfolioTargetConfig,
  PortfolioTargetMode,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const roundToCents = (value: number): number => Math.round(value * 100) / 100;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const sanitizeNumber = (value: unknown, fallback = 0): number =>
  isFiniteNumber(value) ? value : fallback;

const VALID_PORTFOLIO_MODES: PortfolioTargetMode[] = ['excluded', 'locked', 'fixed', 'percent'];

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

export const normalizeAssetAllocationSettings = (raw: unknown): AssetAllocationSettings => {
  const base: AssetAllocationSettings = { portfolioTargets: {} };

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
      portfolioTargets[portfolioId] = { mode, value: roundToCents(value) };
    }
  }

  return { liquidityTarget, portfolioTargets };
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
  fixedValue?: number;     // EUR for fixed mode
  percentValue?: number;   // % for percent mode
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

  // 4. Remainder
  const totalAssigned = liquidityBudget + lockedBudget + fixedBudget + percentBudget;
  const remainder = roundToCents(eligibleTotal - totalAssigned);

  // 5. Sustainability
  let sustainable = true;
  let shortfall = 0;
  let unallocatedRemainder = 0;

  if (remainder < -0.005) {
    sustainable = false;
    shortfall = roundToCents(-remainder);
  } else if (remainder > 0.005) {
    unallocatedRemainder = remainder;
    warnings.push(
      `€${remainder.toFixed(2)} non allocati: alza i target dei portafogli o della liquidità per assorbirli.`
    );
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
      `The sum of portfolio percentages (${totalPercentConfig.toFixed(1)}%) exceeds 100%.`
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
    sustainabilityMessage = `Unsustainable configuration: €${shortfall.toFixed(
      2
    )} of additional liquidity required (or reduce targets).`;
  } else if (unallocatedRemainder > 0.01) {
    sustainabilityMessage = `Sustainable with €${unallocatedRemainder.toFixed(2)} of unallocated surplus.`;
  } else {
    sustainabilityMessage = 'Sustainable and fully allocated.';
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

// ---------------------------------------------------------------------------
// Ratio-group removal (one-shot migration)
// ---------------------------------------------------------------------------

/**
 * Rewrite the targets of a settings blob that still uses ratio groups.
 *
 * Ratio groups let several portfolios share one budget by relative weight.
 * That was the only way to express a parent/child split before the ratio moved
 * onto the portfolios themselves, and with it gone the mechanism has no job
 * left — so it is removed rather than kept as a second, overlapping way to say
 * the same thing.
 *
 * The conversion keeps each member's intent where the group stated a number:
 *
 *   - a `fixed` group of €F  → each member `fixed`, F × its share of the weights;
 *   - a `percent` group of P% → each member `percent`, P × its share;
 *   - a `remainder` group     → each member `locked`.
 *
 * The last one is a real loss and is deliberate: "whatever is left over" has no
 * number of its own, and inventing one would quietly commit the user to a plan
 * they never chose. `locked` keeps the portfolio counted in the total at
 * exactly what it holds, so nothing is proposed until they say what they meant.
 * `convertedFromRemainder` names those portfolios so the caller can say so.
 *
 * Takes the RAW stored object rather than a normalized one: by the time
 * normalization runs, ratio modes are no longer valid and the information this
 * needs is already gone.
 */
export interface RatioGroupMigrationResult {
  portfolioTargets: Record<string, PortfolioTargetConfig>;
  /** True when the input actually used ratio groups. */
  changed: boolean;
  /** Portfolio ids that fell back to `locked` for want of a stated budget. */
  convertedFromRemainder: string[];
}

export const migrateRatioGroups = (raw: unknown): RatioGroupMigrationResult => {
  const empty: RatioGroupMigrationResult = {
    portfolioTargets: {},
    changed: false,
    convertedFromRemainder: []
  };
  if (!raw || typeof raw !== 'object') return empty;
  const src = raw as Record<string, unknown>;

  const rawTargets =
    src.portfolioTargets && typeof src.portfolioTargets === 'object'
      ? (src.portfolioTargets as Record<string, Record<string, unknown>>)
      : {};

  type GroupMode = 'fixed' | 'percent' | 'remainder';
  const groups = new Map<string, { mode: GroupMode; value: number }>();
  if (Array.isArray(src.ratioGroups)) {
    for (const item of src.ratioGroups) {
      if (!item || typeof item !== 'object') continue;
      const g = item as Record<string, unknown>;
      const id = typeof g.id === 'string' ? g.id : '';
      const mode = g.groupTargetMode;
      if (!id || (mode !== 'fixed' && mode !== 'percent' && mode !== 'remainder')) continue;
      groups.set(id, { mode, value: Math.max(0, sanitizeNumber(g.groupTargetValue, 0)) });
    }
  }

  // Weight totals per group, so a member's share is its weight over the rest.
  const weightTotals = new Map<string, number>();
  for (const cfg of Object.values(rawTargets)) {
    if (!cfg || cfg.mode !== 'ratio') continue;
    const gid = typeof cfg.ratioGroupId === 'string' ? cfg.ratioGroupId : '';
    if (!groups.has(gid)) continue;
    weightTotals.set(gid, (weightTotals.get(gid) ?? 0) + Math.max(0, sanitizeNumber(cfg.value, 0)));
  }

  const portfolioTargets: Record<string, PortfolioTargetConfig> = {};
  const convertedFromRemainder: string[] = [];
  let changed = groups.size > 0;

  for (const [portfolioId, cfg] of Object.entries(rawTargets)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const mode = cfg.mode;
    const value = Math.max(0, sanitizeNumber(cfg.value, 0));

    if (mode !== 'ratio') {
      if (mode === 'excluded' || mode === 'locked' || mode === 'fixed' || mode === 'percent') {
        portfolioTargets[portfolioId] = { mode, value: roundToCents(value) };
      }
      continue;
    }

    changed = true;
    const gid = typeof cfg.ratioGroupId === 'string' ? cfg.ratioGroupId : '';
    const group = groups.get(gid);
    const total = weightTotals.get(gid) ?? 0;
    // An orphaned ratio target never had a budget to draw on, so it was already
    // contributing nothing: excluded is what it effectively was.
    if (!group || total <= 0) {
      portfolioTargets[portfolioId] = { mode: 'excluded', value: 0 };
      continue;
    }

    const share = value / total;
    if (group.mode === 'remainder') {
      portfolioTargets[portfolioId] = { mode: 'locked', value: 0 };
      convertedFromRemainder.push(portfolioId);
    } else {
      portfolioTargets[portfolioId] = {
        mode: group.mode,
        value: roundToCents(group.value * share)
      };
    }
  }

  return { portfolioTargets, changed, convertedFromRemainder };
};
