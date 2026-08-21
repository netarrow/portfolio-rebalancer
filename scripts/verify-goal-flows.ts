// Known-answer checks for the goal-flow planner: the split of wealth across
// goals, and the whole-portfolio moves that would close the gap between where
// it sits and where the target bar says it should sit.
// Run with: npx esbuild scripts/verify-goal-flows.ts --bundle --format=esm | node --input-type=module
import { buildGoalFlowPlan, DEFAULT_MIN_MOVE } from '../src/utils/goalFlows';
import type { AssetDefinition, Broker, Goal, Portfolio, Transaction } from '../src/types';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};

// ── Fixture ──────────────────────────────────────────────────────────────────
const assetSettings: AssetDefinition[] = [
    { ticker: 'SWDA', assetClass: 'Stock', assetSubClass: 'International' },
    { ticker: 'AGGH', assetClass: 'Bond', assetSubClass: 'Medium' },
] as AssetDefinition[];

const marketData = {
    SWDA: { price: 100, lastUpdated: '2026-01-01' },
    AGGH: { price: 50, lastUpdated: '2026-01-01' },
};

const buy = (ticker: string, amount: number, price: number, portfolioId: string, brokerId = 'b1'): Transaction =>
    ({ id: `${ticker}-${portfolioId}`, ticker, amount, price, date: '2020-01-01', direction: 'Buy', portfolioId, brokerId }) as Transaction;

const goals: Goal[] = [
    { id: 'g-growth', title: 'Growth', order: 0 },
    { id: 'g-security', title: 'Security', order: 1 },
] as Goal[];

// Growth holds €60k over two portfolios (45k + 15k), Security €40k.
const pGrowthCore: Portfolio = { id: 'p1', name: 'Core', order: 0, goalId: 'g-growth', allocations: { SWDA: 100 } };
const pGrowthTilt: Portfolio = { id: 'p2', name: 'Tilt', order: 1, goalId: 'g-growth', allocations: { SWDA: 100 } };
const pSecurity: Portfolio = { id: 'p3', name: 'Bonds', order: 2, goalId: 'g-security', allocations: { AGGH: 100 } };

const portfolios = [pGrowthCore, pGrowthTilt, pSecurity];
const transactions = [
    buy('SWDA', 450, 100, 'p1'),
    buy('SWDA', 150, 100, 'p2'),
    buy('AGGH', 800, 50, 'p3'),
];
const brokers: Broker[] = [{ id: 'b1', name: 'Broker', currentLiquidity: 0 } as Broker];

const planWith = (targets: Record<string, number>, over: Partial<Parameters<typeof buildGoalFlowPlan>[0]> = {}) =>
    buildGoalFlowPlan({ goals, portfolios, transactions, brokers, assetSettings, marketData, targets, ...over });

// ── 1. The split, and a gap closed out of both portfolios of the donor goal ──
{
    const plan = planWith({ 'g-growth': 50, 'g-security': 50 });

    assertEq('1 total is the goals only', plan.total, 100_000);
    assertEq('1 growth today', plan.goals[0].currentValue, 60_000);
    assertEq('1 security today', plan.goals[1].currentValue, 40_000);
    assertEq('1 growth must shrink', plan.goals[0].gap, -10_000);

    // Growth is drained proportionally to what each of its portfolios holds
    // (45k / 15k = 3:1), so the mix inside the goal survives the move.
    assertEq('1 two moves', plan.moves.length, 2);
    assertEq('1 core gives 3/4', plan.moves[0].amount, 7_500);
    assertEq('1 tilt gives 1/4', plan.moves[1].amount, 2_500);
    assertTrue('1 both land in the receiving goal', plan.moves.every(m => m.toPortfolioId === 'p3'));
    assertEq('1 moved total closes the gap', plan.moves.reduce((s, m) => s + m.amount, 0), 10_000);
}

// ── 2. Already on target: nothing to move ────────────────────────────────────
{
    const plan = planWith({ 'g-growth': 60, 'g-security': 40 });
    assertEq('2 no moves', plan.moves.length, 0);
    assertEq('2 no gap', plan.goals[0].gap, 0);
}

// ── 3. Legs under the minimum are dropped, and said so ───────────────────────
{
    // A 0.05pp drift is €50 across a €100k pyramid: under the floor, and worth
    // less than the tax and two commissions the round trip would cost.
    const plan = planWith({ 'g-growth': 59.95, 'g-security': 40.05 });
    assertEq('3 nothing queued', plan.moves.length, 0);
    const dropped = plan.issues.find(i => i.kind === 'below-minimum');
    assertTrue('3 the drop is reported', !!dropped);
    assertTrue('3 dropped amount is under the floor', (dropped?.amount ?? 0) < DEFAULT_MIN_MOVE);
}

// ── 4. A goal with no portfolio cannot receive ───────────────────────────────
{
    const orphanGoals = [...goals, { id: 'g-house', title: 'House', order: 2 } as Goal];
    const plan = buildGoalFlowPlan({
        goals: orphanGoals, portfolios, transactions, brokers, assetSettings, marketData,
        targets: { 'g-growth': 50, 'g-security': 40, 'g-house': 10 },
    });

    const issue = plan.issues.find(i => i.kind === 'no-destination');
    assertTrue('4 the dead end is reported', !!issue);
    assertEq('4 the whole share is stranded', issue?.amount ?? 0, 10_000);
    // The donors are still matched with the receivers that DO exist: Growth
    // (−10k) into Security, which is the only goal that can take it.
    assertTrue('4 nothing is routed to the empty goal', plan.moves.every(m => m.toGoalId !== 'g-house'));
}

// ── 5. Portfolios outside every goal stay outside the arithmetic ─────────────
{
    const loose: Portfolio = { id: 'p9', name: 'Unassigned', order: 9, allocations: {} } as Portfolio;
    const plan = buildGoalFlowPlan({
        goals,
        portfolios: [...portfolios, loose],
        transactions: [...transactions, buy('SWDA', 100, 100, 'p9')],
        brokers, assetSettings, marketData,
        targets: { 'g-growth': 50, 'g-security': 50 },
    });

    assertEq('5 the loose portfolio is not in the base', plan.total, 100_000);
    assertEq('5 it is listed as outside', plan.orphanPortfolios.length, 1);
    assertEq('5 with its value', plan.orphanPortfolios[0].value, 10_000);
    assertTrue('5 and never moved', plan.moves.every(m => m.fromPortfolioId !== 'p9' && m.toPortfolioId !== 'p9'));
}

// ── 6. Earmarked broker cash counts inside its portfolio's goal ──────────────
{
    // €5k of broker cash reserved for the Security portfolio: the goal levels
    // count it, exactly as the pyramid does, so it is part of what can move.
    const withCash: Broker[] = [
        { id: 'b1', name: 'Broker', currentLiquidity: 12_000, liquidityAllocations: { p3: 5_000 } } as Broker,
    ];
    const plan = planWith({ 'g-growth': 50, 'g-security': 50 }, { brokers: withCash });

    assertEq('6 security counts its earmark', plan.goals[1].currentValue, 45_000);
    assertEq('6 total grows by the earmark only', plan.total, 105_000);
    // Unassigned cash (12k − 5k) is level 0 of the pyramid, below every goal:
    // it must not inflate the base the percentages apply to.
    assertEq('6 growth gap', plan.goals[0].gap, 52_500 - 60_000);
}

console.log('\nAll goal-flow checks passed.');
