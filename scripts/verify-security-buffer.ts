// Known-answer and property checks for the Security Buffer target.
// Invented data only: no real tickers, portfolio names or amounts.
// Run with: npx esbuild scripts/verify-security-buffer.ts --bundle --platform=node --format=esm | node --input-type=module
import type { Portfolio, SecurityBufferSettings, YnabGoal, YnabGoalAllocation } from '../src/types';
import {
    bufferCoefficient, bufferTarget, buildSecurityBufferReport, emergencyCoverage, goalRequirement, goalsCoverage,
    proposeGroupRatio, type GoalInput,
} from '../src/utils/securityBuffer';

let checks = 0;
const assertEq = (label: string, actual: number | null | undefined, expected: number, tol = 0.01) => {
    if (actual === null || actual === undefined || Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    checks++;
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    checks++;
    console.log(`ok ${label}`);
};

const NOW = new Date('2026-01-01T00:00:00Z');
const plusYears = (y: number) => {
    const d = new Date(NOW);
    d.setUTCMonth(d.getUTCMonth() + Math.round(y * 12));
    return d.toISOString().slice(0, 10);
};

// ── Base case: age 40, rf 2%, min 10%, credit 0.5, L3 = 85k + 15k ──────
const settings = (over: Partial<SecurityBufferSettings> = {}): SecurityBufferSettings => ({
    birthYear: NOW.getUTCFullYear() - 40, riskFreePct: 2, riskFreeDate: '2025-12-01',
    minPct: 10, pyramidCredit: 0.5,
    roles: { growth: 'growth', fund: 'emergency', goals: 'goal' },
    ...over,
});
const portfolios: Portfolio[] = [
    { id: 'growth', name: 'G', order: 0, groupSharePercent: 85 },
    { id: 'buffer', name: 'B', order: 1, parentId: 'growth', groupSharePercent: 15 },
    { id: 'fund', name: 'F', order: 2 },
    { id: 'goals', name: 'S', order: 3 },
];
const goal = (id: string, amount: number, years: number, cycle?: number, cash = 0): YnabGoal => ({
    id, ynabBudgetId: 'bud', name: id, targetAmount: amount, targetDate: plusYears(years), cashCoverage: cash,
    targetSource: 'manual-override', lastSyncedAt: NOW.toISOString(), ...(cycle ? { cycle: { years: cycle } } : {}),
});
const alloc = (goalId: string, portfolioId: string, amount: number): YnabGoalAllocation => ({
    id: `${goalId}-${portfolioId}`, portfolioId, ynabGoalId: goalId, amount, createdAt: '', updatedAt: '',
});
const report = (o: { l1: number; goals?: YnabGoal[]; allocations?: YnabGoalAllocation[]; s?: Partial<SecurityBufferSettings>; values?: Record<string, number> }) => {
    const values: Record<string, number> = { growth: 85000, buffer: 15000, fund: o.l1, goals: 50000, ...(o.values ?? {}) };
    return buildSecurityBufferReport({
        portfolios, settings: settings(o.s), valueOf: id => values[id] ?? 0,
        goals: o.goals ?? [], allocations: o.allocations ?? [], coveredOf: a => a.amount,
        l1Target: 10000, now: NOW,
    });
};

assertEq('b = 0.25', bufferCoefficient(40, 2), 0.25, 1e-9);

// L1 full, goals all covered → C = 1 → 17,500.
{
    const covered = report({ l1: 10000, goals: [goal('car', 6000, 0.5)], allocations: [alloc('car', 'goals', 6000)] });
    const g = covered.groups[0];
    assertEq('base: b', covered.b, 0.25, 1e-9);
    assertEq('base: L3', g.l3, 100000);
    assertEq('base: Max', g.target!.max, 25000);
    assertEq('base: Min', g.target!.min, 10000);
    assertEq('base: C', covered.coverage, 1, 1e-9);
    assertEq('base: target', g.target!.target, 17500);
    assertEq('base: gap', g.gap, 2500);
    assertEq('base: gap % of L3', g.gapPctOfL3, 2.5);
    assertEq('base: child share now', g.childShareNow, 15);
    assertEq('base: child share target', g.childShareTarget, 17.5);
    assertEq('base: parent share target', g.parentShareTarget, 82.5);
    assertEq('base: proposed child', g.proposedRatio!.buffer, 17.5);
    assertEq('base: proposed parent', g.proposedRatio!.growth, 82.5);
    assertTrue('base: flows go to the buffer, then growth', g.flows.map(f => f.level).join('>') === 'BUFFER>CRESCITA');
    assertTrue('base: no sell is ever suggested', g.flows.every(f => f.amount === null || f.amount > 0));
}

// L1 empty → C_L1 = 0, C = 0.5 → 21,250.
{
    const r = report({ l1: 0, goals: [goal('car', 6000, 0.5)], allocations: [alloc('car', 'goals', 6000)] });
    assertEq('L1 = 0: C', r.coverage, 0.5, 1e-9);
    assertEq('L1 = 0: target', r.groups[0].target!.target, 21250);
    assertTrue('L1 = 0: L1 flow first', r.groups[0].flows[0].level === 'L1' && r.groups[0].flows[0].amount === 10000);
}

// No goal at all → Σ required = 0 → C_L2 = 1 → 17,500.
{
    const r = report({ l1: 10000 });
    assertEq('no goals: C_L2', r.cL2, 1, 1e-9);
    assertEq('no goals: target', r.groups[0].target!.target, 17500);
}

// 12,000 due in 3 years on a 6-year cycle → required 6,000; funded 3,000 → C_L2 = 0.5.
{
    const req = goalRequirement({ id: 'g', name: 'g', amount: 12000, targetDate: plusYears(3), cycleYears: 6, funded: 3000 }, NOW);
    assertEq('cycle: required', req.required, 6000);
    assertEq('cycle: covered', req.covered, 3000);
    const r = report({ l1: 10000, goals: [goal('boiler', 12000, 3, 6)], allocations: [alloc('boiler', 'goals', 3000)] });
    assertEq('cycle: C_L2', r.cL2, 0.5, 1e-9);
    assertTrue('cycle: L2 flow of 3,000', r.groups[0].flows.some(f => f.level === 'L2' && f.amount === 3000));
}

// Due within 12 months → the whole amount, cycle or not.
{
    const req = goalRequirement({ id: 'g', name: 'g', amount: 4000, targetDate: plusYears(0.75), cycleYears: 5, funded: 0 }, NOW);
    assertEq('due soon: required = amount', req.required, 4000);
    assertTrue('due soon: basis', req.basis === 'due');
    const past = goalRequirement({ id: 'g', name: 'g', amount: 4000, targetDate: plusYears(-0.25), funded: 0 }, NOW);
    assertEq('overdue: required = amount', past.required, 4000);
}

// Funded beyond what is required → covered capped at required.
{
    const req = goalRequirement({ id: 'g', name: 'g', amount: 12000, targetDate: plusYears(3), cycleYears: 6, funded: 9000 }, NOW);
    assertEq('over-funded: covered = required', req.covered, 6000);
}

// No cycle and more than 12 months away → whole amount, with a warning.
{
    const r = report({ l1: 10000, goals: [goal('trip', 5000, 2)], allocations: [alloc('trip', 'goals', 5000)] });
    assertEq('no cycle: required = amount', r.goals.goals[0].required, 5000);
    assertTrue('no cycle: warned', r.warnings.some(w => w.kind === 'goal-no-cycle'));
}

// Dedicated cash counts as funded; allocations from non-GOAL portfolios do not.
{
    const r = report({ l1: 10000, goals: [goal('car', 6000, 0.5, undefined, 1000)], allocations: [alloc('car', 'goals', 2000), alloc('car', 'growth', 3000)] });
    assertEq('cash + GOAL allocation', r.goals.goals[0].funded, 3000);
    assertTrue('allocation outside GOAL portfolios warned', r.warnings.some(w => w.kind === 'funding-outside-goal-portfolios'));
}

// Warnings: stale rf, missing parameters.
{
    assertTrue('stale rf warned', report({ l1: 10000, s: { riskFreeDate: '2025-09-01' } }).warnings.some(w => w.kind === 'stale-rf'));
    assertTrue('fresh rf not warned', !report({ l1: 10000 }).warnings.some(w => w.kind === 'stale-rf'));
    const missing = report({ l1: 10000, s: { birthYear: undefined } });
    assertTrue('missing birth year: no target', missing.b === null && missing.groups[0].target === null);
    assertTrue('missing birth year warned', missing.warnings.some(w => w.kind === 'missing-birth-year'));
    assertTrue('missing rf warned', report({ l1: 10000, s: { riskFreePct: undefined } }).warnings.some(w => w.kind === 'missing-rf'));
}

// Buffer above target: the flows skip the buffer, never a sale.
{
    const r = report({ l1: 10000, values: { growth: 70000, buffer: 30000 } });
    assertEq('over target: gap negative', r.groups[0].gap, -12500);
    assertTrue('over target: no buffer flow', !r.groups[0].flows.some(f => f.level === 'BUFFER'));
}

// Two children share the target child quota by their configured shares.
{
    const ratio = proposeGroupRatio({ parentId: 'p', children: [{ id: 'a', value: 1, sharePercent: 10 }, { id: 'b', value: 1, sharePercent: 5 }], childSharePercent: 18 });
    assertEq('two children: a', ratio.a, 12);
    assertEq('two children: b', ratio.b, 6);
    assertEq('two children: parent', ratio.p, 82);
}

// ── Properties ───────────────────────────────────────────────────────
let seed = 42;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const target = (age: number, rf: number, l1: number, funded: number, l3 = 100000) => {
    const b = bufferCoefficient(age, rf);
    const cL2 = goalsCoverage([{ id: 'g', name: 'g', amount: 10000, targetDate: plusYears(3), cycleYears: 6, funded }], NOW).ratio;
    return bufferTarget({ b, l3, minPct: 10, credit: 0.5, coverage: (emergencyCoverage(l1, 10000) + cL2) / 2 });
};
for (let i = 0; i < 500; i++) {
    const age = 18 + Math.floor(rand() * 70), rf = rand() * 6, l1 = rand() * 15000, funded = rand() * 8000;
    const t = target(age, rf, l1, funded, 1000 + rand() * 500000);
    if (t.target < t.min - 1e-6 || t.target > t.max + 1e-6) throw new Error(`target out of [Min, Max] at ${age}/${rf}`);
    const lessL1 = target(age, rf, l1 * rand(), funded);
    const ref = target(age, rf, l1, funded);
    if (lessL1.target < ref.target - 1e-6) throw new Error('target decreased with less L1');
    const lessFunded = target(age, rf, l1, funded * rand());
    if (lessFunded.target < ref.target - 1e-6) throw new Error('target decreased with less funded');
    const older = target(age + 1 + Math.floor(rand() * 10), rf, l1, funded);
    const higherRf = target(age, rf + rand() * 2, l1, funded);
    if (older.b < ref.b || older.target < ref.target - 1e-6) throw new Error('older did not raise b/target');
    if (higherRf.b < ref.b || higherRf.target < ref.target - 1e-6) throw new Error('higher rf did not raise b/target');
    const childPct = ref.l3 > 0 ? ref.target / ref.l3 * 100 : 0;
    const ratio = proposeGroupRatio({ parentId: 'p', children: [{ id: 'c', value: 1 }], childSharePercent: childPct });
    if (Math.abs(ratio.p + ratio.c - 100) > 1e-9) throw new Error('parent + child != 100');
}
checks += 5;
console.log('ok properties: target in [Min, Max]; non-decreasing as L1 or funded fall; b and target rise with age and rf; parent + child = 100 (500 samples)');

// Strict check: within (Min, Max) the target actually rises with age and rf.
assertTrue('age 40 → 50 raises the target', target(50, 2, 5000, 1000).target > target(40, 2, 5000, 1000).target);
assertTrue('rf 2 → 3 raises the target', target(40, 3, 5000, 1000).target > target(40, 2, 5000, 1000).target);

// Removing a fully covered goal leaves C_L2 unchanged when the others are covered.
{
    const all: GoalInput[] = [
        { id: 'a', name: 'a', amount: 6000, targetDate: plusYears(0.5), funded: 6000 },
        { id: 'b', name: 'b', amount: 12000, targetDate: plusYears(3), cycleYears: 6, funded: 7000 },
    ];
    assertEq('remove covered goal: before', goalsCoverage(all, NOW).ratio, 1, 1e-9);
    assertEq('remove covered goal: after', goalsCoverage(all.slice(1), NOW).ratio, 1, 1e-9);
    // Spending a goal at its due date removes required and funded together: no hole opens.
    assertEq('spent goal: no hole', goalsCoverage([], NOW).ratio, 1, 1e-9);
}

console.log(`all ${checks} security buffer checks passed`);
