import type { AssetClass, AssetSubClass } from '../types';
import type { MonthlyReturnSampler } from './forecastCalculations';

/**
 * Scripted crashes for the Forecast — "what if the market falls while this plan
 * is running", answered per asset class instead of per portfolio.
 *
 * The deterministic projection grows every portfolio at its own CAGR, month
 * after month, so the cash-flow table reads as an unbroken climb: no year ever
 * shows the market taking money away. Monte Carlo does produce falls, but they
 * are random and unnamed — you cannot ask it for "a 2008" and read the plan
 * against it.
 *
 * A drawdown here is a SHOCK ON TOP OF THE DRIFT, not a replacement for it:
 * each month's return is (1 + drift) × (1 + shock) − 1, so a money-market
 * portfolio keeps earning its yield through a crash that barely touches it,
 * and the projection continues undisturbed before and after the window.
 *
 * Three things keep it honest:
 *
 *  - **The severity belongs to the asset class, not to the portfolio.** Equity
 *    falls 20/35/50/80% depending on the scenario; bonds move by duration and
 *    by which way rates went (a flight to quality lifts them, a rate shock takes
 *    30% off the long end); money-market barely registers, a few tenths of a
 *    percent and only in a systemic freeze; gold and crypto go wherever the
 *    scenario says. A portfolio's fall is then its own mix — 40% equity and 60%
 *    short bonds cannot lose 50%, and the simulation will not pretend it can.
 *
 *  - **Classes do not move in lockstep.** They share the timing of the event —
 *    that is what makes it one crash — but each has its own depth, its own
 *    recovery and its own path. Gold rising while equity capitulates is the
 *    point, not a rounding error.
 *
 *  - **The path is a path, not a step.** The fall is spread over months with a
 *    Brownian bridge pinned to the trough and to the end of the window, so
 *    there are bear-market rallies and green months inside a red year, and the
 *    trough and the exit level still land exactly where the scenario says.
 */

// ── Classes ──────────────────────────────────────────────────────────────────

/**
 * The granularity a crash actually distinguishes. Bonds are split by duration
 * because that, not the label "bond", decides whether a rate shock costs 4% or
 * 30%.
 */
export type ShockClass =
    | 'equity'
    | 'bondShort'
    | 'bondMedium'
    | 'bondLong'
    | 'cash'
    | 'gold'
    | 'crypto'
    | 'balanced';

export const SHOCK_CLASS_LABELS: Record<ShockClass, string> = {
    equity: 'Equity',
    bondShort: 'Bonds · short',
    bondMedium: 'Bonds · medium',
    bondLong: 'Bonds · long',
    cash: 'Money market',
    gold: 'Gold',
    crypto: 'Crypto',
    balanced: 'Pension fund',
};

export const SHOCK_CLASS_ORDER: ShockClass[] = [
    'equity', 'balanced', 'bondShort', 'bondMedium', 'bondLong', 'gold', 'crypto', 'cash',
];

/** An asset's shock class. Bonds fall back to medium duration when unstated. */
export const classifyForShock = (assetClass: AssetClass, assetSubClass?: AssetSubClass): ShockClass => {
    switch (assetClass) {
        case 'Stock': return 'equity';
        case 'Bond':
            if (assetSubClass === 'Short') return 'bondShort';
            if (assetSubClass === 'Long') return 'bondLong';
            return 'bondMedium';
        case 'Commodity': return 'gold';
        case 'Crypto': return 'crypto';
        case 'Cash': return 'cash';
        case 'PensionFund': return 'balanced';
        default: return 'equity';
    }
};

/** Value weights per shock class, summing to 1 (or empty for an empty portfolio). */
export type ShockMix = Partial<Record<ShockClass, number>>;

/** Weights from valued holdings. Zero-value assets are ignored, not counted as 0%. */
export const shockMixOf = (
    holdings: { assetClass: AssetClass; assetSubClass?: AssetSubClass; currentValue: number }[]
): ShockMix => {
    const byClass: ShockMix = {};
    let total = 0;
    holdings.forEach(h => {
        if (!(h.currentValue > 0)) return;
        const key = classifyForShock(h.assetClass, h.assetSubClass);
        byClass[key] = (byClass[key] ?? 0) + h.currentValue;
        total += h.currentValue;
    });
    if (total <= 0) return {};
    (Object.keys(byClass) as ShockClass[]).forEach(k => { byClass[k] = byClass[k]! / total; });
    return byClass;
};

// ── Scenarios ────────────────────────────────────────────────────────────────

export interface ShockClassSpec {
    /** Total change at the trough, as a fraction (−0.5 = −50%). */
    trough: number;
    /** Share of the trough move given back by the end of the window (0..1). */
    recovery: number;
    /** Idiosyncratic monthly volatility inside the window (fraction). */
    noise: number;
}

export interface DrawdownScenario {
    id: string;
    label: string;
    /** One line: what this crash is. */
    story: string;
    /** Months from the first shocked month down to the trough. */
    crashMonths: number;
    /** Months from the trough to the end of the window. */
    recoveryMonths: number;
    classes: Record<ShockClass, ShockClassSpec>;
}

const spec = (trough: number, recovery: number, noise: number): ShockClassSpec =>
    ({ trough, recovery, noise });

/**
 * The menu. Each one is a coherent story, not a slider: the classes move the
 * way they moved when that story actually happened, including the ones that
 * went UP. Equity anchors the severity ladder the user thinks in — 20 / 35 /
 * 50 / 80 — and the rate shock is the case where bonds, not stocks, take the
 * damage.
 */
export const DRAWDOWN_SCENARIOS: DrawdownScenario[] = [
    {
        id: 'correction',
        label: 'Correction',
        story: 'A garden-variety equity correction: −20% over a couple of quarters, bonds a touch firmer, back to normal within a year.',
        crashMonths: 4,
        recoveryMonths: 12,
        classes: {
            equity: spec(-0.20, 0.80, 0.045),
            balanced: spec(-0.11, 0.80, 0.028),
            bondShort: spec(0.005, 0.30, 0.003),
            bondMedium: spec(0.015, 0.40, 0.008),
            bondLong: spec(0.03, 0.50, 0.016),
            cash: spec(0, 0, 0.0004),
            gold: spec(0.03, 0.40, 0.030),
            crypto: spec(-0.35, 0.70, 0.130),
        },
    },
    {
        id: 'bear',
        label: 'Bear market',
        story: 'A recession bear market: equity −35% over three quarters, money running to duration, gold bid. The classic flight to quality.',
        crashMonths: 9,
        recoveryMonths: 18,
        classes: {
            equity: spec(-0.35, 0.75, 0.050),
            balanced: spec(-0.19, 0.75, 0.030),
            bondShort: spec(0.01, 0.40, 0.004),
            bondMedium: spec(0.03, 0.50, 0.010),
            bondLong: spec(0.06, 0.60, 0.020),
            cash: spec(0, 0, 0.0004),
            gold: spec(0.08, 0.40, 0.035),
            crypto: spec(-0.55, 0.60, 0.150),
        },
    },
    {
        id: 'systemic',
        label: 'Systemic crash',
        story: '2008 in shape: equity halved over more than a year, credit seizing so even the long end sells off, gold the only thing bid — and the money market itself wobbles by a couple of tenths.',
        crashMonths: 14,
        recoveryMonths: 24,
        classes: {
            equity: spec(-0.50, 0.65, 0.060),
            balanced: spec(-0.28, 0.65, 0.035),
            bondShort: spec(-0.005, 0.80, 0.005),
            bondMedium: spec(0.02, 0.50, 0.014),
            bondLong: spec(-0.04, 0.70, 0.026),
            cash: spec(-0.002, 0.90, 0.0008),
            gold: spec(0.12, 0.35, 0.040),
            crypto: spec(-0.75, 0.55, 0.170),
        },
    },
    {
        id: 'depression',
        label: 'Lost decade',
        story: 'The tail nobody plans for: equity −80% over two and a half years and only a third of it back, nothing spared except gold.',
        crashMonths: 30,
        recoveryMonths: 36,
        classes: {
            equity: spec(-0.80, 0.35, 0.065),
            balanced: spec(-0.45, 0.35, 0.038),
            bondShort: spec(-0.01, 0.60, 0.006),
            bondMedium: spec(-0.03, 0.50, 0.016),
            bondLong: spec(-0.08, 0.50, 0.030),
            cash: spec(-0.005, 0.70, 0.0012),
            gold: spec(0.20, 0.30, 0.045),
            crypto: spec(-0.90, 0.40, 0.190),
        },
    },
    {
        id: 'rates',
        label: 'Rate & inflation shock',
        story: '2022 in shape: rates repriced upward, so the damage lands on duration — the long end −30% — and there is no hiding place, bonds and equities falling together.',
        crashMonths: 10,
        recoveryMonths: 14,
        classes: {
            equity: spec(-0.25, 0.60, 0.045),
            balanced: spec(-0.18, 0.55, 0.028),
            bondShort: spec(-0.04, 0.70, 0.006),
            bondMedium: spec(-0.12, 0.60, 0.014),
            bondLong: spec(-0.30, 0.55, 0.028),
            cash: spec(0, 0, 0.0004),
            gold: spec(-0.08, 0.60, 0.035),
            crypto: spec(-0.65, 0.50, 0.160),
        },
    },
];

export const scenarioById = (id: string): DrawdownScenario | undefined =>
    DRAWDOWN_SCENARIOS.find(s => s.id === id);

// ── Paths ────────────────────────────────────────────────────────────────────

/** Deterministic PRNG, same one the Monte Carlo uses, so a seed replays a crash. */
const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const gaussianFrom = (rng: () => number) => (): number => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** S-curve: slow to start, capitulation in the middle, flattening into the trough. */
const smoothstep = (x: number): number => {
    const t = Math.min(1, Math.max(0, x));
    return t * t * (3 - 2 * t);
};

/**
 * A random walk pinned to zero at both ends (Brownian bridge), of `steps` steps.
 *
 * This is what makes the path a path: the wobble is real and unpredictable, but
 * because it is zero at the anchors, the trough and the exit level are still
 * exactly the ones the scenario declares. A plain random walk would drift them.
 */
const zeroPinnedWalk = (steps: number, gaussian: () => number): number[] => {
    if (steps <= 1) return new Array(steps + 1).fill(0);
    const walk = [0];
    for (let i = 1; i <= steps; i++) walk.push(walk[i - 1] + gaussian());
    const end = walk[steps];
    return walk.map((v, i) => v - (i / steps) * end);
};

/**
 * The level path of one class through the window: `L[0] = 1`, `L[crashMonths]`
 * exactly at the trough, `L[last]` exactly at the post-recovery level.
 */
export const buildClassPath = (
    classSpec: ShockClassSpec,
    crashMonths: number,
    recoveryMonths: number,
    gaussian: () => number
): number[] => {
    const crash = Math.max(1, Math.round(crashMonths));
    const recover = Math.max(0, Math.round(recoveryMonths));
    const { trough, recovery, noise } = classSpec;

    const base: number[] = [1];
    for (let t = 1; t <= crash; t++) base.push(1 + trough * smoothstep(t / crash));
    for (let t = 1; t <= recover; t++) {
        base.push(1 + trough * (1 - recovery * smoothstep(t / recover)));
    }

    // One bridge for the fall, one for the recovery: the trough is an anchor of
    // both, so it stays exact while each leg wobbles on its own.
    const fall = zeroPinnedWalk(crash, gaussian);
    const rise = zeroPinnedWalk(recover, gaussian);

    return base.map((level, i) => {
        const b = i <= crash ? fall[i] : rise[i - crash];
        // Levels never go to zero or negative: a class can be devastated, not erased.
        return Math.max(0.02, level * Math.exp(noise * b));
    });
};

// ── Sampler ──────────────────────────────────────────────────────────────────

export interface DrawdownConfig {
    /** 1-based month the fall starts. */
    startMonth: number;
    /** Re-roll the wobble without changing the scenario. */
    seed?: number;
}

/**
 * The shock a portfolio takes each month of the window.
 *
 * Class paths are drawn ONCE and shared by every portfolio, which is the whole
 * point — two portfolios holding equities fall together, and a bond-heavy one
 * next to them barely moves.
 *
 * The portfolio is then held, not rebalanced: its level is the weighted sum of
 * the class LEVELS, so a 40/60 mix through an equity halving is down 20% at the
 * trough — what the readout promises. Weighting the monthly returns instead
 * would quietly simulate buying the falling asset every month, and land the
 * same portfolio three points lower than the figure on screen.
 */
const buildShockReturns = (
    mixByPortfolio: Record<string, ShockMix>,
    scenario: DrawdownScenario,
    seed: number
): { byPortfolio: Record<string, number[]>; byClass: Record<string, number[]>; windowMonths: number } => {
    const gaussian = gaussianFrom(mulberry32(seed));

    // Drawn in a fixed order so a seed always produces the same crash.
    const classLevels: Record<string, number[]> = {};
    SHOCK_CLASS_ORDER.forEach(cls => {
        classLevels[cls] = buildClassPath(scenario.classes[cls], scenario.crashMonths, scenario.recoveryMonths, gaussian);
    });

    const windowMonths = Math.max(1, Math.round(scenario.crashMonths)) + Math.max(0, Math.round(scenario.recoveryMonths));
    const byClass: Record<string, number[]> = {};
    SHOCK_CLASS_ORDER.forEach(cls => {
        const path = classLevels[cls];
        byClass[cls] = path.slice(1).map((level, i) => level / path[i] - 1);
    });

    const byPortfolio: Record<string, number[]> = {};
    Object.entries(mixByPortfolio).forEach(([pid, mix]) => {
        const held = (Object.keys(mix) as ShockClass[]).filter(cls => (mix[cls] ?? 0) > 0);
        const levels = new Array<number>(windowMonths + 1).fill(0);
        for (let i = 0; i <= windowMonths; i++) {
            held.forEach(cls => { levels[i] += (mix[cls] ?? 0) * classLevels[cls][i]; });
        }
        byPortfolio[pid] = levels.slice(1).map((level, i) =>
            levels[i] > 0 ? level / levels[i] - 1 : 0);
    });

    return { byPortfolio, byClass, windowMonths };
};

/**
 * A `MonthlyReturnSampler` that runs the deterministic CAGR everywhere and
 * multiplies the crash in over its window.
 *
 * Outside the window it returns exactly what the engine would have used on its
 * own, so switching a drawdown on changes the projection only where the crash
 * is — before it, the two paths are identical euro for euro.
 */
export const buildDrawdownSampler = (
    mixByPortfolio: Record<string, ShockMix>,
    portfolioReturns: Record<string, number>,
    scenario: DrawdownScenario,
    config: DrawdownConfig
): MonthlyReturnSampler => {
    const { byPortfolio, windowMonths } = buildShockReturns(mixByPortfolio, scenario, config.seed ?? 20260901);
    const start = Math.max(1, Math.round(config.startMonth));

    const drift: Record<string, number> = {};
    Object.keys(portfolioReturns).forEach(pid => {
        const cagr = (portfolioReturns[pid] || 0) / 100;
        drift[pid] = Math.pow(1 + Math.max(cagr, -0.99), 1 / 12) - 1;
    });

    return (portfolioId, month) => {
        const monthlyDrift = drift[portfolioId] ?? 0;
        const idx = month - start;
        if (idx < 0 || idx >= windowMonths) return monthlyDrift;
        const shock = byPortfolio[portfolioId]?.[idx] ?? 0;
        return (1 + monthlyDrift) * (1 + shock) - 1;
    };
};

// ── Readout ──────────────────────────────────────────────────────────────────

export interface DrawdownImpact {
    /** Blended trough shock per portfolio (fraction; negative = a fall). */
    byPortfolio: Record<string, number>;
    /** Value-weighted trough shock across the portfolios (fraction). */
    blended: number;
    /** The portfolios that actually take a hit, worst first. */
    worst: { portfolioId: string; shock: number }[];
}

/**
 * What the scenario means for THIS plan, before any month is simulated: the
 * mix-weighted trough per portfolio and for the whole invested capital.
 *
 * Read off the anchors, not off a simulated path — this is the scenario's own
 * statement of severity, so it does not move when the wobble is re-rolled.
 */
export const summarizeDrawdown = (
    mixByPortfolio: Record<string, ShockMix>,
    valueByPortfolio: Record<string, number>,
    scenario: DrawdownScenario
): DrawdownImpact => {
    const byPortfolio: Record<string, number> = {};
    let weighted = 0;
    let totalValue = 0;

    Object.entries(mixByPortfolio).forEach(([pid, mix]) => {
        let shock = 0;
        (Object.keys(mix) as ShockClass[]).forEach(cls => {
            shock += (mix[cls] ?? 0) * scenario.classes[cls].trough;
        });
        byPortfolio[pid] = shock;
        const value = valueByPortfolio[pid] || 0;
        if (value > 0) { weighted += value * shock; totalValue += value; }
    });

    return {
        byPortfolio,
        blended: totalValue > 0 ? weighted / totalValue : 0,
        worst: Object.entries(byPortfolio)
            .map(([portfolioId, shock]) => ({ portfolioId, shock }))
            .sort((a, b) => a.shock - b.shock),
    };
};

/** Classes actually held, in display order — the legend the readout prints. */
export const heldClasses = (mixByPortfolio: Record<string, ShockMix>): ShockClass[] => {
    const held = new Set<ShockClass>();
    Object.values(mixByPortfolio).forEach(mix => {
        (Object.keys(mix) as ShockClass[]).forEach(cls => {
            if ((mix[cls] ?? 0) > 0.0005) held.add(cls);
        });
    });
    return SHOCK_CLASS_ORDER.filter(c => held.has(c));
};
