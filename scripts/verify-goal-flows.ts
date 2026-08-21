// Known-answer checks for the goal-flow planner: the split of wealth across the
// pyramid — the cash level plus the goals — and the moves that would close the
// gap between where it sits and where the target bar says it should sit.
// Run with: npx esbuild scripts/verify-goal-flows.ts --bundle --format=esm | node --input-type=module
import { buildGoalFlowPlan, DEFAULT_MIN_MOVE, LIQUIDITY_LEVEL_ID } from '../src/utils/goalFlows';
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

/** plan.goals[0] is always the cash level, so the goals start at index 1. */
const CASH = 0, GROWTH = 1, SECURITY = 2;

// ── 1. The split, and a gap closed out of both portfolios of the donor goal ──
{
    const plan = planWith({ 'g-growth': 50, 'g-security': 50 });

    assertEq('1 total is the whole pyramid', plan.total, 100_000);
    assertTrue('1 the cash level comes first', plan.goals[CASH].id === LIQUIDITY_LEVEL_ID);
    assertEq('1 no unearmarked cash', plan.goals[CASH].currentValue, 0);
    assertEq('1 growth today', plan.goals[GROWTH].currentValue, 60_000);
    assertEq('1 security today', plan.goals[SECURITY].currentValue, 40_000);
    assertEq('1 growth must shrink', plan.goals[GROWTH].gap, -10_000);

    // Growth is drained proportionally to what each of its portfolios holds
    // (45k / 15k = 3:1), so the mix inside the goal survives the move.
    assertEq('1 two moves', plan.moves.length, 2);
    assertEq('1 core gives 3/4', plan.moves[0].amount, 7_500);
    assertEq('1 tilt gives 1/4', plan.moves[1].amount, 2_500);
    assertTrue('1 both land in the receiving goal', plan.moves.every(m => m.to.portfolioId === 'p3'));
    assertEq('1 moved total closes the gap', plan.moves.reduce((s, m) => s + m.amount, 0), 10_000);
}

// ── 2. Already on target: nothing to move ────────────────────────────────────
{
    const plan = planWith({ 'g-growth': 60, 'g-security': 40 });
    assertEq('2 no moves', plan.moves.length, 0);
    assertEq('2 no gap', plan.goals[GROWTH].gap, 0);
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
    assertTrue('4 nothing is routed to the empty goal', plan.moves.every(m => m.to.goalId !== 'g-house'));
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
    assertTrue('5 and never moved', plan.moves.every(m => m.from.portfolioId !== 'p9' && m.to.portfolioId !== 'p9'));
}

// ── 6. Earmarked cash counts inside its goal, the rest is the cash level ─────
{
    // €5k of broker cash reserved for the Security portfolio: the goal levels
    // count it, exactly as the pyramid does, so it is part of what can move.
    // The other €7k is earmarked to nobody — level 0, and movable in its own
    // right.
    const withCash: Broker[] = [
        { id: 'b1', name: 'Broker', currentLiquidity: 12_000, liquidityAllocations: { p3: 5_000 } } as Broker,
    ];
    const plan = planWith({ [LIQUIDITY_LEVEL_ID]: 0, 'g-growth': 50, 'g-security': 50 }, { brokers: withCash });

    assertEq('6 security counts its earmark', plan.goals[SECURITY].currentValue, 45_000);
    assertEq('6 the cash level holds what is left', plan.goals[CASH].currentValue, 7_000);
    assertEq('6 total is the whole net worth', plan.total, 112_000);
    assertEq('6 growth gap', plan.goals[GROWTH].gap, 56_000 - 60_000);
}

// ── 7. Cash asked to empty is deployed, never sold ───────────────────────────
{
    const withCash: Broker[] = [{ id: 'b1', name: 'Broker', currentLiquidity: 10_000 } as Broker];
    // 110k pyramid: cash to zero, the goals keeping their 60/40 shares of it.
    const plan = planWith({ [LIQUIDITY_LEVEL_ID]: 0, 'g-growth': 60, 'g-security': 40 }, { brokers: withCash });

    assertEq('7 total includes the cash', plan.total, 110_000);
    assertEq('7 the cash level must empty', plan.goals[CASH].gap, -10_000);
    assertTrue('7 every move leaves cash', plan.moves.every(m => m.from.kind === 'cash'));
    assertTrue('7 and none of them sells', plan.moves.every(m => m.to.kind === 'portfolio'));
    assertEq('7 the whole pot is deployed', plan.moves.reduce((s, m) => s + m.amount, 0), 10_000);
    // 66k target vs 60k held, and 44k vs 40k: proportional to what each goal is short.
    assertEq('7 growth takes its share', plan.moves.filter(m => m.to.goalId === 'g-growth').reduce((s, m) => s + m.amount, 0), 6_000);
    assertEq('7 security takes the rest', plan.moves.filter(m => m.to.goalId === 'g-security').reduce((s, m) => s + m.amount, 0), 4_000);
}

// ── 8. Cash asked to grow is raised by selling into it ───────────────────────
{
    // 10% of a €100k pyramid in cash, from nothing: the goals give it up.
    const plan = planWith({ [LIQUIDITY_LEVEL_ID]: 10, 'g-growth': 54, 'g-security': 36 });

    assertEq('8 the cash level must grow', plan.goals[CASH].gap, 10_000);
    assertTrue('8 every leg lands in cash', plan.moves.every(m => m.to.kind === 'cash'));
    assertTrue('8 and starts in a portfolio', plan.moves.every(m => m.from.kind === 'portfolio'));
    assertEq('8 raised in full', plan.moves.reduce((s, m) => s + m.amount, 0), 10_000);
}

// ── 9. Cash cannot give what is earmarked elsewhere ──────────────────────────
{
    // €4k of the €5k is reserved for p3, so level 0 holds €1k: a target that
    // asks for €5k out of it is short by €4k, and says so instead of promising
    // a move that no cash exists for.
    const withCash: Broker[] = [
        { id: 'b1', name: 'Broker', currentLiquidity: 5_000, liquidityAllocations: { p3: 4_000 } } as Broker,
    ];
    const plan = buildGoalFlowPlan({
        goals, portfolios, transactions, brokers: withCash, assetSettings, marketData,
        // 105k pyramid, cash level €1k: asking for −4k more than it has.
        targets: { [LIQUIDITY_LEVEL_ID]: 0, 'g-growth': 100 * (60_000 / 105_000), 'g-security': 100 * (45_000 / 105_000) },
    });

    assertEq('9 the cash level holds only what is free', plan.goals[CASH].currentValue, 1_000);
    assertEq('9 nothing beyond the free cash is promised', plan.moves.reduce((s, m) => s + m.amount, 0), 1_000);
    assertTrue('9 no move drains more than the pot', plan.moves.every(m => m.from.kind !== 'cash' || m.amount <= 1_000));
}

// ── 10. A frozen portfolio still counts, but never gives ─────────────────────
{
    // Growth must give up €10k. The Tilt is frozen, so the whole leg comes out
    // of Core — and the goal's value is unchanged, because freezing says what
    // may MOVE, not what the wealth is.
    const plan = planWith({ 'g-growth': 50, 'g-security': 50 }, { portfolioStates: { p2: 'frozen' } });

    assertEq('10 the frozen portfolio still counts', plan.goals[GROWTH].currentValue, 60_000);
    assertEq('10 the base is unchanged', plan.total, 100_000);
    assertEq('10 one move only', plan.moves.length, 1);
    assertEq('10 all of it out of the free portfolio', plan.moves[0].amount, 10_000);
    assertTrue('10 and never out of the frozen one', plan.moves.every(m => m.from.portfolioId !== 'p2'));
}

// ── 11. Freezing more than the gap is reported, not silently re-routed ───────
{
    // Both of Growth's portfolios frozen: the €10k gap has nothing to come out
    // of, and that is said out loud rather than taken from another goal.
    const plan = planWith({ 'g-growth': 50, 'g-security': 50 }, { portfolioStates: { p1: 'frozen', p2: 'frozen' } });

    assertEq('11 nothing can move', plan.moves.length, 0);
    const short = plan.issues.find(i => i.kind === 'not-enough-to-drain');
    assertTrue('11 the shortfall is reported', !!short);
    assertEq('11 the whole gap is stranded', short?.amount ?? 0, 10_000);
}

// ── 12. An excluded portfolio leaves the base as well as the moves ───────────
{
    const plan = planWith({ 'g-growth': 50, 'g-security': 50 }, { portfolioStates: { p2: 'excluded' } });

    assertEq('12 out of its goal', plan.goals[GROWTH].currentValue, 45_000);
    assertEq('12 out of the base', plan.total, 85_000);
    assertEq('12 it is listed as skipped', plan.excludedPortfolios.length, 1);
    assertTrue('12 with the goal it belongs to', plan.excludedPortfolios[0].goalId === 'g-growth');
    // 42.5k target against 45k held: only the 2.5k of drift is left to move.
    assertEq('12 the gap is measured without it', plan.moves.reduce((s, m) => s + m.amount, 0), 2_500);
    assertTrue('12 and it is never moved', plan.moves.every(m => m.from.portfolioId !== 'p2' && m.to.portfolioId !== 'p2'));
}

// ── 13. A goal whose portfolios are all frozen cannot receive ────────────────
{
    const plan = planWith({ 'g-growth': 50, 'g-security': 50 }, { portfolioStates: { p3: 'frozen' } });

    const issue = plan.issues.find(i => i.kind === 'no-destination');
    assertTrue('13 the dead end is reported', !!issue);
    assertTrue('13 as a frozen one, not an unattached one', issue?.reason === 'none-active');
    assertEq('13 the whole share is stranded', issue?.amount ?? 0, 10_000);
    assertEq('13 nothing is moved', plan.moves.length, 0);
}

console.log('\nAll goal-flow checks passed.');
