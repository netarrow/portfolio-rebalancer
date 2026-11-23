/**
 * Security Buffer target: how much of a growth group to hold in its
 * psychological-safety component — the BUFFER children (short/medium bonds)
 * of a CRESCITA parent — combining an age/risk-free rule with how covered the
 * Omney pyramid is underneath it:
 *  - L1 Protezione: the EMERGENZA portfolios against the emergency fund target
 *    of Expense Planning;
 *  - L2 Sicurezza: the dated YNAB goals against what their saving plan should
 *    have set aside by now;
 *  - L3 Crescita: the CRESCITA parent plus its BUFFER children.
 *
 * The more the pyramid is uncovered, the higher the buffer; once it is rebuilt
 * the target comes down by itself. A goal spent at its due date is not a hole:
 * it leaves both the required and the funded side.
 *
 * The formula (all inputs from the user's settings, nothing hard-coded):
 *   b      = clamp((age + 5·rf − 25) / 100, 0, 1)          rf in %
 *   Max    = b · L3        Min = min% · L3                 (Max never below Min)
 *   C_L1   = min(1, L1 / L1_target)                        (1 when the target is 0)
 *   C_L2   = Σ covered / Σ required                         (1 when nothing is required)
 *   C      = (C_L1 + C_L2) / 2
 *   target = Max − (Max − Min) · C · credit
 *   gap    = target − BUFFER today
 *
 * It never suggests selling: a gap is closed with new money only, routed
 * L1 → L2 → BUFFER → CRESCITA.
 */
import type { Portfolio, PyramidRole, SecurityBufferSettings, YnabGoal, YnabGoalAllocation } from '../types';
import { buildPortfolioTree } from './portfolioGroups';

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** A risk-free rate older than this many months is flagged as stale. */
export const RF_STALE_MONTHS = 3;

// ── Pieces of the formula ───────────────────────────────────────────

/** b = clamp((age + 5·rf − 25) / 100, 0, 1), rf in percent (2 = 2%). */
export const bufferCoefficient = (age: number, riskFreePct: number): number =>
    clamp((age + 5 * riskFreePct - 25) / 100, 0, 1);

/** Years from `now` to `iso`, by calendar months (2026-01-01 → 2029-01-01 is exactly 3). Negative when past. */
export const yearsUntil = (iso: string, now: Date): number => {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    const months = (d.getUTCFullYear() - now.getUTCFullYear()) * 12
        + (d.getUTCMonth() - now.getUTCMonth())
        + (d.getUTCDate() - now.getUTCDate()) / 30.4375;
    return months / 12;
};

export interface GoalInput {
    id: string;
    name: string;
    amount: number;
    targetDate: string;
    /** How often the goal comes back, in years; absent = one-off. */
    cycleYears?: number;
    /** What is already set aside for it: allocations covered today + dedicated cash. */
    funded: number;
}

export interface GoalRequirement {
    id: string;
    name: string;
    amount: number;
    targetDate: string;
    yearsLeft: number;
    cycleYears?: number;
    funded: number;
    /** What the saving plan should hold by now. */
    required: number;
    /** min(funded, required). */
    covered: number;
    /** 'due' = within 12 months (full amount); 'cycle' = pro rata of the cycle; 'no-cycle' = more than 12 months away with no cycle (full amount, warned). */
    basis: 'due' | 'cycle' | 'no-cycle';
}

/**
 *   due within 12 months          → the whole amount
 *   further, with a cycle         → amount · (1 − yearsLeft / cycle), clamped 0..amount
 *   further, without a cycle      → the whole amount (and a warning)
 */
export const goalRequirement = (goal: GoalInput, now: Date): GoalRequirement => {
    const amount = Math.max(0, goal.amount);
    const yearsLeft = yearsUntil(goal.targetDate, now);
    const cycle = goal.cycleYears && goal.cycleYears > 0 ? goal.cycleYears : undefined;
    let required: number;
    let basis: GoalRequirement['basis'];
    if (yearsLeft <= 1) { required = amount; basis = 'due'; }
    else if (cycle) { required = clamp(amount * (1 - yearsLeft / cycle), 0, amount); basis = 'cycle'; }
    else { required = amount; basis = 'no-cycle'; }
    const funded = Math.max(0, goal.funded);
    return {
        id: goal.id, name: goal.name, amount, targetDate: goal.targetDate, yearsLeft, cycleYears: cycle,
        funded: round2(funded), required: round2(required), covered: round2(Math.min(funded, required)), basis,
    };
};

export interface GoalsCoverage {
    goals: GoalRequirement[];
    required: number;
    covered: number;
    /** Σ covered / Σ required; 1 when nothing is required. */
    ratio: number;
}

export const goalsCoverage = (goals: GoalInput[], now: Date): GoalsCoverage => {
    const rows = goals.map(g => goalRequirement(g, now));
    const required = rows.reduce((s, r) => s + r.required, 0);
    const covered = rows.reduce((s, r) => s + r.covered, 0);
    return { goals: rows, required: round2(required), covered: round2(covered), ratio: required > 0 ? covered / required : 1 };
};

/** C_L1 = min(1, L1 / target); 1 when there is no target. */
export const emergencyCoverage = (l1: number, l1Target: number): number =>
    l1Target > 0 ? clamp(Math.max(0, l1) / l1Target, 0, 1) : 1;

export interface BufferTarget {
    b: number;
    l3: number;
    max: number;
    min: number;
    /** b · L3 was below the floor: Max is raised to Min. */
    maxRaisedToMin: boolean;
    coverage: number;
    target: number;
}

/** Target = Max − (Max − Min) · C · credit, always within [Min, Max]. */
export const bufferTarget = (input: { b: number; l3: number; minPct: number; credit: number; coverage: number }): BufferTarget => {
    const l3 = Math.max(0, input.l3);
    const min = clamp(input.minPct, 0, 100) / 100 * l3;
    const rawMax = clamp(input.b, 0, 1) * l3;
    const max = Math.max(rawMax, min);
    const c = clamp(input.coverage, 0, 1);
    const k = clamp(input.credit, 0, 1);
    const target = clamp(max - (max - min) * c * k, min, max);
    return { b: input.b, l3: round2(l3), max: round2(max), min: round2(min), maxRaisedToMin: rawMax < min - 1e-9, coverage: c, target: round2(target) };
};

/**
 * New group ratio for a target child share: the BUFFER children split it in
 * proportion to their configured shares (or their value when not all are
 * configured, or equally when they hold nothing), the parent takes the rest.
 * Rounded to one decimal; the parent absorbs the rounding so it sums to 100.
 */
export const proposeGroupRatio = (input: {
    parentId: string;
    children: { id: string; value: number; sharePercent?: number }[];
    childSharePercent: number;
}): Record<string, number> => {
    const r1 = (x: number) => Math.round(x * 10) / 10;
    const total = clamp(input.childSharePercent, 0, 100);
    const kids = input.children;
    const configured = kids.length > 0 && kids.every(k => k.sharePercent !== undefined)
        && kids.reduce((s, k) => s + (k.sharePercent ?? 0), 0) > 0;
    const weightOf = (k: typeof kids[number]) => configured ? k.sharePercent ?? 0 : Math.max(0, k.value);
    const weightSum = kids.reduce((s, k) => s + weightOf(k), 0);
    const out: Record<string, number> = {};
    let placed = 0;
    kids.forEach(k => {
        const share = r1(weightSum > 0 ? total * weightOf(k) / weightSum : total / kids.length);
        out[k.id] = share;
        placed += share;
    });
    out[input.parentId] = r1(100 - placed);
    return out;
};

// ── The report, from the app's data ─────────────────────────────────

export type SecurityBufferWarning =
    | { kind: 'missing-birth-year' }
    | { kind: 'missing-rf' }
    | { kind: 'missing-rf-date' }
    | { kind: 'stale-rf'; date: string; months: number }
    | { kind: 'missing-l1-target' }
    | { kind: 'no-growth-group' }
    | { kind: 'no-buffer-child'; parentId: string }
    | { kind: 'goal-no-cycle'; goalId: string; name: string }
    | { kind: 'goal-incomplete'; goalId: string; name: string }
    | { kind: 'funding-outside-goal-portfolios'; goalId: string; name: string; portfolioIds: string[]; amount: number }
    | { kind: 'unassigned-portfolios'; portfolioIds: string[] }
    | { kind: 'max-raised-to-min' };

export interface FlowStep {
    level: 'L1' | 'L2' | 'BUFFER' | 'CRESCITA';
    /** € of new money this step can take before the next one; null = whatever is left. */
    amount: number | null;
    /** Portfolios the money goes to. */
    portfolioIds: string[];
    /** L2 only: the goal it closes. */
    goalId?: string;
    label: string;
}

export interface SecurityBufferGroupReport {
    parentId: string;
    childIds: string[];
    parentValue: number;
    bufferValue: number;
    l3: number;
    target: BufferTarget | null;
    gap: number | null;
    gapPctOfL3: number | null;
    /** BUFFER / L3 today, %. */
    childShareNow: number;
    /** Σ groupSharePercent of the children; null when not every member has one. */
    childShareConfigured: number | null;
    childShareTarget: number | null;
    parentShareTarget: number | null;
    /** portfolioId → % to save, when a target exists and there is a child. */
    proposedRatio: Record<string, number> | null;
    flows: FlowStep[];
}

export interface SecurityBufferReport {
    age: number | null;
    b: number | null;
    l1: number;
    l1Target: number;
    l1PortfolioIds: string[];
    cL1: number;
    goals: GoalsCoverage;
    cL2: number;
    coverage: number;
    /** Free value of GOAL portfolios not allocated to any goal (informative, outside the formula). */
    goalFreeValue: number;
    /** Children of CRESCITA parents: BUFFER by derivation. */
    bufferIds: string[];
    /** portfolioId → role actually used (buffer included). */
    roleOf: Record<string, PyramidRole | 'buffer' | undefined>;
    groups: SecurityBufferGroupReport[];
    warnings: SecurityBufferWarning[];
}

export interface SecurityBufferInput {
    portfolios: Portfolio[];
    settings: SecurityBufferSettings;
    /** Market value of a portfolio's holdings, broker cash excluded. */
    valueOf: (portfolioId: string) => number;
    goals: YnabGoal[];
    allocations: YnabGoalAllocation[];
    /** What an allocation covers today (as on the YNAB Goals page). */
    coveredOf: (a: YnabGoalAllocation) => number;
    /** The emergency fund target of Expense Planning, €; 0 = not available. */
    l1Target: number;
    /** Goal ids that are the emergency fund itself (left out of L2). */
    emergencyGoalIds?: string[];
    now: Date;
}

const monthsSince = (iso: string, now: Date): number => -yearsUntil(iso, now) * 12;

export const buildSecurityBufferReport = (input: SecurityBufferInput): SecurityBufferReport => {
    const { portfolios, settings, valueOf, now } = input;
    const warnings: SecurityBufferWarning[] = [];
    const roles = settings.roles ?? {};
    const tree = buildPortfolioTree(portfolios);

    // Roles: children of a CRESCITA root are BUFFER, whatever they say.
    const roleOf: SecurityBufferReport['roleOf'] = {};
    portfolios.forEach(p => { roleOf[p.id] = roles[p.id]; });
    const growthGroups = [
        ...tree.groups.filter(g => roles[g.parent.id] === 'growth'),
        ...tree.standalones.filter(p => roles[p.id] === 'growth').map(p => ({ parent: p, children: [] as Portfolio[], members: [p] })),
    ].sort((a, b) => a.parent.order - b.parent.order);
    const bufferIds: string[] = [];
    growthGroups.forEach(g => g.children.forEach(c => { roleOf[c.id] = 'buffer'; bufferIds.push(c.id); }));
    const unassigned = portfolios.filter(p => roleOf[p.id] === undefined).map(p => p.id);
    if (unassigned.length > 0) warnings.push({ kind: 'unassigned-portfolios', portfolioIds: unassigned });

    // Parameters.
    const age = settings.birthYear ? now.getUTCFullYear() - settings.birthYear : null;
    if (age === null) warnings.push({ kind: 'missing-birth-year' });
    const rf = settings.riskFreePct;
    if (rf === undefined || rf === null || !Number.isFinite(rf)) warnings.push({ kind: 'missing-rf' });
    if (!settings.riskFreeDate) warnings.push({ kind: 'missing-rf-date' });
    else {
        const months = monthsSince(settings.riskFreeDate, now);
        if (months > RF_STALE_MONTHS) warnings.push({ kind: 'stale-rf', date: settings.riskFreeDate, months: Math.floor(months) });
    }
    const b = age !== null && rf !== undefined && rf !== null && Number.isFinite(rf) ? bufferCoefficient(age, rf) : null;

    // L1.
    const l1PortfolioIds = portfolios.filter(p => roleOf[p.id] === 'emergency').map(p => p.id);
    const l1 = round2(l1PortfolioIds.reduce((s, id) => s + Math.max(0, valueOf(id)), 0));
    const l1Target = Math.max(0, input.l1Target || 0);
    if (l1Target <= 0) warnings.push({ kind: 'missing-l1-target' });
    const cL1 = emergencyCoverage(l1, l1Target);

    // L2: active dated goals; only GOAL portfolios fund them (plus their own cash).
    const goalPortfolios = new Set(portfolios.filter(p => roleOf[p.id] === 'goal').map(p => p.id));
    const emergencyGoals = new Set(input.emergencyGoalIds ?? []);
    const goalInputs: GoalInput[] = [];
    input.goals.filter(g => !g.archived && !emergencyGoals.has(g.id)).forEach(g => {
        if (!(g.targetAmount && g.targetAmount > 0) || !g.targetDate) {
            warnings.push({ kind: 'goal-incomplete', goalId: g.id, name: g.name });
            return;
        }
        const allocs = input.allocations.filter(a => a.ynabGoalId === g.id);
        const inside = allocs.filter(a => goalPortfolios.has(a.portfolioId));
        const outside = allocs.filter(a => !goalPortfolios.has(a.portfolioId));
        const outsideAmount = outside.reduce((s, a) => s + input.coveredOf(a), 0);
        if (outside.length > 0 && outsideAmount > 0.005) {
            warnings.push({
                kind: 'funding-outside-goal-portfolios', goalId: g.id, name: g.name,
                portfolioIds: [...new Set(outside.map(a => a.portfolioId))], amount: round2(outsideAmount),
            });
        }
        const funded = Math.max(0, g.cashCoverage || 0) + inside.reduce((s, a) => s + Math.max(0, input.coveredOf(a)), 0);
        goalInputs.push({ id: g.id, name: g.name, amount: g.targetAmount, targetDate: g.targetDate, cycleYears: g.cycle?.years, funded });
    });
    const goals = goalsCoverage(goalInputs, now);
    goals.goals.filter(r => r.basis === 'no-cycle').forEach(r => warnings.push({ kind: 'goal-no-cycle', goalId: r.id, name: r.name }));
    const cL2 = goals.ratio;
    const coverage = (cL1 + cL2) / 2;

    // Free part of the GOAL portfolios: outside the formula, shown for context.
    const goalFreeValue = round2([...goalPortfolios].reduce((s, id) => {
        const allocated = input.allocations.filter(a => a.portfolioId === id).reduce((t, a) => t + Math.max(0, input.coveredOf(a)), 0);
        return s + Math.max(0, valueOf(id) - allocated);
    }, 0));

    // Flows shared by every group: L1 first, then each goal behind plan.
    const l1Gap = round2(Math.max(0, l1Target - l1));
    const sharedFlows: FlowStep[] = [];
    if (l1Gap > 0) sharedFlows.push({ level: 'L1', amount: l1Gap, portfolioIds: l1PortfolioIds, label: 'Emergency fund below target' });
    goals.goals
        .filter(r => r.required - r.covered > 0.005)
        .sort((x, y) => x.yearsLeft - y.yearsLeft)
        .forEach(r => {
            const ids = [...new Set(input.allocations.filter(a => a.ynabGoalId === r.id && goalPortfolios.has(a.portfolioId)).map(a => a.portfolioId))];
            sharedFlows.push({ level: 'L2', amount: round2(r.required - r.covered), portfolioIds: ids, goalId: r.id, label: r.name });
        });

    if (growthGroups.length === 0) warnings.push({ kind: 'no-growth-group' });

    const groups: SecurityBufferGroupReport[] = growthGroups.map(g => {
        const parentValue = round2(Math.max(0, valueOf(g.parent.id)));
        const childValues = g.children.map(c => ({ id: c.id, value: Math.max(0, valueOf(c.id)), sharePercent: c.groupSharePercent }));
        const bufferValue = round2(childValues.reduce((s, c) => s + c.value, 0));
        const l3 = round2(parentValue + bufferValue);
        if (g.children.length === 0) warnings.push({ kind: 'no-buffer-child', parentId: g.parent.id });

        const target = b !== null
            ? bufferTarget({ b, l3, minPct: settings.minPct, credit: settings.pyramidCredit, coverage })
            : null;
        if (target?.maxRaisedToMin && !warnings.some(w => w.kind === 'max-raised-to-min')) warnings.push({ kind: 'max-raised-to-min' });
        const gap = target ? round2(target.target - bufferValue) : null;
        const childShareTarget = target && l3 > 0 ? round2(target.target / l3 * 100) : null;
        const allConfigured = g.members.every(m => m.groupSharePercent !== undefined);
        const childShareConfigured = g.children.length > 0 && allConfigured
            ? round2(g.children.reduce((s, c) => s + (c.groupSharePercent ?? 0), 0)) : null;
        const proposedRatio = childShareTarget !== null && g.children.length > 0
            ? proposeGroupRatio({ parentId: g.parent.id, children: childValues, childSharePercent: childShareTarget })
            : null;

        const flows: FlowStep[] = [...sharedFlows];
        if (gap !== null && gap > 0.005 && g.children.length > 0) {
            flows.push({ level: 'BUFFER', amount: gap, portfolioIds: g.children.map(c => c.id), label: 'Buffer below target' });
        }
        flows.push({ level: 'CRESCITA', amount: null, portfolioIds: [g.parent.id], label: 'Whatever is left' });

        return {
            parentId: g.parent.id,
            childIds: g.children.map(c => c.id),
            parentValue, bufferValue, l3, target, gap,
            gapPctOfL3: gap !== null && l3 > 0 ? round2(gap / l3 * 100) : null,
            childShareNow: l3 > 0 ? round2(bufferValue / l3 * 100) : 0,
            childShareConfigured,
            childShareTarget,
            parentShareTarget: childShareTarget !== null ? round2(100 - childShareTarget) : null,
            proposedRatio,
            flows,
        };
    });

    return {
        age, b, l1, l1Target: round2(l1Target), l1PortfolioIds, cL1, goals, cL2, coverage, goalFreeValue,
        bufferIds, roleOf, groups, warnings,
    };
};
