// Known-answer checks for the Fund Relocation what-if: the friction of moving
// money between portfolios (and to/from cash), the whole-share sizing, and the
// before/after snapshot that feeds the stats and the goal pyramid.
// Run with: npx esbuild scripts/verify-fund-relocation.ts --bundle --format=esm | node --input-type=module
import {
    planFundRelocation,
    applyRelocationToState,
    planRelocationSequence,
    planHasEffect,
    type RelocationContext,
    type RelocationRequest,
} from '../src/utils/fundRelocation';
import { buildSnapshot } from '../src/utils/relocationSnapshot';
import { UNASSIGNED_LIQUIDITY_ID } from '../src/utils/goalDistribution';
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
// SWDA: equity, 26%. AGGH: bond, 12.5%. COMETA: pension fund, 20%.
const assetSettings: AssetDefinition[] = [
    { ticker: 'SWDA', assetClass: 'Stock', assetSubClass: 'International' },
    { ticker: 'VWCE', assetClass: 'Stock', assetSubClass: 'International' },
    { ticker: 'AGGH', assetClass: 'Bond', assetSubClass: 'Medium' },
    { ticker: 'COMETA', assetClass: 'PensionFund', assetSubClass: 'Balanced' },
    { ticker: 'LOSER', assetClass: 'Stock', assetSubClass: 'International' },
] as AssetDefinition[];

const marketData = {
    SWDA: { price: 100, lastUpdated: '2026-01-01' },
    VWCE: { price: 25, lastUpdated: '2026-01-01' },
    AGGH: { price: 50, lastUpdated: '2026-01-01' },
    COMETA: { price: 100, lastUpdated: '2026-01-01' },
    LOSER: { price: 100, lastUpdated: '2026-01-01' },
};

const fixedBroker = (id: string, fee: number, cash = 0): Broker => ({
    id, name: `Fixed ${id}`, commissionType: 'fixed', commissionFixed: fee, currentLiquidity: cash,
} as Broker);
const freeBroker = (id: string, cash = 0): Broker => ({ id, name: `Free ${id}`, currentLiquidity: cash } as Broker);

const buy = (ticker: string, amount: number, price: number, portfolioId: string, brokerId?: string, date = '2020-01-01'): Transaction =>
    ({ id: `${ticker}-${portfolioId}-${date}`, ticker, amount, price, date, direction: 'Buy', portfolioId, brokerId }) as Transaction;

const growthPortfolio: Portfolio = { id: 'p1', name: 'Growth', order: 0, goalId: 'g-growth', allocations: { SWDA: 100 } };
const bondPortfolio: Portfolio = { id: 'p2', name: 'Bonds', order: 1, goalId: 'g-security', allocations: { AGGH: 100 } };

const ctxOf = (over: Partial<RelocationContext>): RelocationContext => ({
    portfolios: [growthPortfolio, bondPortfolio],
    brokers: [],
    transactions: [],
    assetSettings,
    marketData,
    ...over,
});

// ── 1. Cash → portfolio: no sale, so no tax; only the buy commission ─────────
{
    const brokers = [fixedBroker('b1', 5, 50_000)];
    const ctx = ctxOf({
        brokers,
        transactions: [buy('AGGH', 10, 50, 'p2', 'b1')],
    });
    const plan = planFundRelocation(
        { from: { kind: 'cash', brokerId: 'b1' }, to: { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' }, netAmount: 10_000 },
        ctx
    );

    assertEq('1 no tax on a cash source', plan.tax, 0);
    assertEq('1 no sell commission', plan.sellCommission, 0);
    assertEq('1 buy commission charged once', plan.buyCommission, 5);
    assertEq('1 friction is the buy fee only', plan.friction, 5);
    assertEq('1 shares bought', plan.buys[0].shares, 200);
    assertEq('1 net delivered', plan.netDelivered, 10_000);
    assertEq('1 cash drawn covers the fee too', plan.cashDrawn, 10_005);

    // Pricing the plan is only half the job: the what-if reads the state the plan
    // PRODUCES, and a cash source used to be debited twice there — once as
    // `cashDrawn` and again by the buy legs — so the table showed net worth
    // collapsing by the whole amount moved instead of by the fee.
    const request: RelocationRequest = {
        from: { kind: 'cash', brokerId: 'b1' },
        to: { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' },
        netAmount: 10_000,
    };
    const snapshotInput = {
        transactions: ctx.transactions, brokers, portfolios: ctx.portfolios, goals: [] as Goal[],
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const moved = applyRelocationToState(ctx.transactions, brokers, request, plan);
    const after = buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });

    assertEq('1 net worth drops by exactly the friction', before.netWorth - after.netWorth, plan.friction, 1e-6);
    assertEq('1 liquidity falls by the cash drawn ONCE', before.liquidity - after.liquidity, plan.cashDrawn, 1e-6);
    assertEq('1 invested rises by what landed', after.invested - before.invested, plan.netDelivered, 1e-6);
}

// ── 2. Portfolio → cash: net = gross − tax − commission ──────────────────────
{
    // 100 SWDA at PMC 80, now 100 → €20 gain per share, taxed 26%.
    const brokers = [fixedBroker('b1', 5, 0)];
    const ctx = ctxOf({ brokers, transactions: [buy('SWDA', 100, 80, 'p1', 'b1')] });
    const plan = planFundRelocation(
        { from: { kind: 'portfolio', portfolioId: 'p1', ticker: 'SWDA' }, to: { kind: 'cash', brokerId: 'b1' }, netAmount: 1_000 },
        ctx
    );

    // net(n) = 100n − 0.26·20n − 5 = 94.8n − 5 ⇒ n = 11 is the first ≥ 1000.
    assertEq('2 whole shares sold', plan.sells[0].shares, 11);
    assertEq('2 gross', plan.grossSold, 1_100);
    assertEq('2 taxable gain is the sold portion only', plan.sells[0].gain, 220);
    assertEq('2 tax at 26%', plan.tax, 57.2);
    assertEq('2 sell commission', plan.sellCommission, 5);
    assertEq('2 no buy commission into cash', plan.buyCommission, 0);
    assertEq('2 net delivered', plan.netDelivered, 1_037.8);
    assertTrue('2 delivers at least what was asked', plan.netDelivered >= 1_000);
    assertEq('2 friction', plan.friction, 62.2);

    // The whole point: net worth falls by exactly the friction.
    const snapshotInput = {
        transactions: ctx.transactions, brokers, portfolios: ctx.portfolios, goals: [] as Goal[],
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const moved = applyRelocationToState(ctx.transactions, brokers,
        { from: { kind: 'portfolio', portfolioId: 'p1', ticker: 'SWDA' }, to: { kind: 'cash', brokerId: 'b1' }, netAmount: 1_000 }, plan);
    const after = buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });

    assertEq('2 net worth drops by exactly the friction', before.netWorth - after.netWorth, plan.friction, 1e-6);
    assertEq('2 liquidity rises by the net proceeds', after.liquidity - before.liquidity, plan.netDelivered, 1e-6);
    assertEq('2 realized gain is booked', after.realizedGain - before.realizedGain, 220, 1e-6);
}

// ── 3. A loss leg is taxed 0 and does NOT offset the gains of the others ─────
{
    // Empty allocations ⇒ every asset scores MAX_VALUE ⇒ the solver drains them
    // in array order: LOSER first (bought earlier), then SWDA.
    const lossPortfolio: Portfolio = { id: 'p3', name: 'Mixed', order: 2, allocations: {} };
    const ctx = ctxOf({
        portfolios: [lossPortfolio],
        brokers: [freeBroker('b1')],
        transactions: [
            buy('LOSER', 10, 200, 'p3', 'b1', '2019-01-01'),  // 10 × (100 − 200) = −1000
            buy('SWDA', 100, 50, 'p3', 'b1', '2020-01-01'),   // €50 gain per share
        ],
    });
    const plan = planFundRelocation(
        { from: { kind: 'portfolio', portfolioId: 'p3' }, to: { kind: 'cash', brokerId: 'b1' }, netAmount: 2_000 },
        ctx
    );

    const loserLeg = plan.sells.find(s => s.ticker === 'LOSER')!;
    const winnerLeg = plan.sells.find(s => s.ticker === 'SWDA')!;
    assertEq('3 whole loss position sold', loserLeg.shares, 10);
    assertEq('3 loss leg has no taxable gain', loserLeg.gain, 0);
    assertEq('3 loss leg taxed 0', loserLeg.tax, 0);
    // 12 winner shares: 12 × 87 net = 1044, first to clear the €1000 still needed.
    assertEq('3 winner shares', winnerLeg.shares, 12);
    assertEq('3 tax ignores the realized loss', plan.tax, 12 * 50 * 0.26);
    assertTrue('3 the loss is NOT netted against the gain', plan.tax > 0);
}

// ── 4. Capital-gains rate follows the asset class ────────────────────────────
{
    const cases: [string, number, number][] = [
        // ticker, price, expected rate
        ['SWDA', 100, 0.26],
        ['AGGH', 50, 0.125],
        ['COMETA', 100, 0.20],
    ];
    cases.forEach(([ticker, price, rate]) => {
        const p: Portfolio = { id: 'px', name: 'One', order: 0, allocations: { [ticker]: 100 } };
        const ctx = ctxOf({
            portfolios: [p],
            brokers: [freeBroker('b1')],
            transactions: [buy(ticker, 100, price / 2, 'px', 'b1')],
        });
        const plan = planFundRelocation(
            { from: { kind: 'portfolio', portfolioId: 'px', ticker }, to: { kind: 'cash' }, netAmount: 500 },
            ctx
        );
        assertEq(`4 ${ticker} taxed at`, plan.sells[0].taxRate, rate);
    });
}

// ── 5. The sale also has to cover the BUY commission (convergence) ───────────
{
    const brokers = [fixedBroker('b1', 19, 0)];
    const ctx = ctxOf({
        brokers,
        transactions: [buy('SWDA', 500, 80, 'p1', 'b1'), buy('AGGH', 10, 50, 'p2', 'b1')],
    });
    const plan = planFundRelocation(
        {
            from: { kind: 'portfolio', portfolioId: 'p1', ticker: 'SWDA' },
            to: { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' },
            netAmount: 10_000,
        },
        ctx
    );

    const invested = plan.buys.reduce((s, b) => s + b.gross, 0);
    assertEq('5 both commissions charged', plan.sellCommission + plan.buyCommission, 38);
    assertTrue('5 invests at least the requested net', invested >= 10_000);
    assertEq('5 net delivered is what was invested', plan.netDelivered, invested);
    // Proceeds cover the buy outlay including its fee — the plan is payable.
    const proceeds = plan.grossSold - plan.tax - plan.sellCommission;
    assertTrue('5 the plan is payable out of the proceeds', proceeds >= invested + plan.buyCommission - 1e-6);
    // Whole-share rounding may overshoot, but never by a whole extra share.
    assertTrue('5 overshoot is under one share', invested - 10_000 < plan.buys[0].price);
    assertEq('5 friction', plan.friction, plan.tax + 38);
}

// ── 6. Source too small ⇒ explicit shortfall, never a silent under-delivery ──
{
    const ctx = ctxOf({
        brokers: [freeBroker('b1')],
        transactions: [buy('SWDA', 5, 80, 'p1', 'b1')], // only €500 of stock
    });
    const plan = planFundRelocation(
        { from: { kind: 'portfolio', portfolioId: 'p1', ticker: 'SWDA' }, to: { kind: 'cash' }, netAmount: 10_000 },
        ctx
    );

    assertEq('6 sells the whole position', plan.sells[0].shares, 5);
    assertTrue('6 reports a shortfall', plan.warnings.some(w => w.kind === 'source-shortfall'));
    assertTrue('6 delivers less than requested', plan.netDelivered < 10_000);
}

// ── 7. The exact asset is optional and independent on each side ──────────────
{
    const brokers = [freeBroker('b1')];
    const base = ctxOf({
        brokers,
        transactions: [
            buy('SWDA', 200, 80, 'p1', 'b1'),
            buy('VWCE', 200, 20, 'p1', 'b1'),
            buy('AGGH', 10, 50, 'p2', 'b1'),
        ],
    });
    const src: Portfolio = { ...growthPortfolio, allocations: { SWDA: 50, VWCE: 50 } };
    const dst: Portfolio = { ...bondPortfolio, allocations: { AGGH: 50, VWCE: 50 } };
    const ctx = { ...base, portfolios: [src, dst] };

    const run = (req: RelocationRequest) => planFundRelocation(req, ctx);

    // a) neither side pinned — the solver picks on both ends
    const free = run({ from: { kind: 'portfolio', portfolioId: 'p1' }, to: { kind: 'portfolio', portfolioId: 'p2' }, netAmount: 4_000 });
    assertTrue('7a solver chose what to sell', free.sells.length > 0);
    assertTrue('7a solver chose what to buy', free.buys.length > 0);

    // b) source pinned — only that ticker is sold
    const pinnedSrc = run({ from: { kind: 'portfolio', portfolioId: 'p1', ticker: 'VWCE' }, to: { kind: 'portfolio', portfolioId: 'p2' }, netAmount: 2_000 });
    assertEq('7b one sell leg', pinnedSrc.sells.length, 1);
    assertTrue('7b sells only the pinned ticker', pinnedSrc.sells[0].ticker === 'VWCE');

    // c) destination pinned — everything lands on that ticker
    const pinnedDst = run({ from: { kind: 'portfolio', portfolioId: 'p1' }, to: { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' }, netAmount: 2_000 });
    assertEq('7c one buy leg', pinnedDst.buys.length, 1);
    assertTrue('7c buys only the pinned ticker', pinnedDst.buys[0].ticker === 'AGGH');

    // d) both pinned — a straight X → Y swap
    const swap = run({ from: { kind: 'portfolio', portfolioId: 'p1', ticker: 'SWDA' }, to: { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' }, netAmount: 3_000 });
    assertEq('7d sells only X', swap.sells.length, 1);
    assertTrue('7d X is SWDA', swap.sells[0].ticker === 'SWDA');
    assertEq('7d buys only Y', swap.buys.length, 1);
    assertTrue('7d Y is AGGH', swap.buys[0].ticker === 'AGGH');
}

// ── 8. The pyramid moves, and the total shrinks by the friction ──────────────
{
    const goals: Goal[] = [
        { id: 'g-growth', title: 'Growth', order: 0 },
        { id: 'g-security', title: 'Security', order: 1 },
    ];
    const brokers = [fixedBroker('b1', 5, 0)];
    const transactions = [buy('SWDA', 200, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b1')];
    const ctx = ctxOf({ brokers, transactions });

    const request: RelocationRequest = {
        from: { kind: 'portfolio', portfolioId: 'p1' },
        to: { kind: 'portfolio', portfolioId: 'p2' },
        netAmount: 5_000,
    };
    const plan = planFundRelocation(request, ctx);
    const moved = applyRelocationToState(transactions, brokers, request, plan);

    const snapshotInput = {
        transactions, brokers, portfolios: ctx.portfolios, goals,
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const after = buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });

    const level = (s: typeof before, id: string) => s.goalPyramid.find(g => g.id === id)!.value;

    assertTrue('8 Growth level shrinks', level(after, 'g-growth') < level(before, 'g-growth'));
    assertTrue('8 Security level grows', level(after, 'g-security') > level(before, 'g-security'));
    assertEq('8 Security gains the invested amount', level(after, 'g-security') - level(before, 'g-security'), plan.netDelivered, 1e-6);
    assertEq('8 Growth loses the gross sold', level(before, 'g-growth') - level(after, 'g-growth'), plan.grossSold, 1e-6);
    // Whole-share rounding leaves a remainder; it is not lost, it stays as
    // unassigned cash and shows up in the pyramid's Liquidity level.
    const undeployed = plan.warnings.find(w => w.kind === 'buy-shortfall')?.amount ?? 0;
    assertTrue('8 rounding leaves a remainder', undeployed > 0);
    assertEq('8 the remainder lands in Liquidity',
        level(after, UNASSIGNED_LIQUIDITY_ID) - level(before, UNASSIGNED_LIQUIDITY_ID), undeployed, 1e-6);

    // The pyramid total IS net worth, so it must shrink by exactly the friction
    // — nothing else may leak out of the levels.
    assertEq('8 pyramid total falls by exactly the friction', before.goalPyramidTotal - after.goalPyramidTotal, plan.friction, 1e-6);
    assertEq('8 net worth matches the pyramid total', after.netWorth, after.goalPyramidTotal, 1e-6);

    // Macro allocation shifts from equity to bonds.
    const macro = (s: typeof before, name: string) => s.macro.find(m => m.name === name)!.value;
    assertTrue('8 equity exposure falls', macro(after, 'Stock') < macro(before, 'Stock'));
    assertTrue('8 bond exposure rises', macro(after, 'Bond') > macro(before, 'Bond'));
}

// ── 9. Cash capacity is checked against the broker's floors ──────────────────
{
    const broker: Broker = {
        ...fixedBroker('b1', 0, 10_000),
        minLiquidityType: 'fixed',
        minLiquidityAmount: 4_000,
    } as Broker;
    const ctx = ctxOf({ brokers: [broker], transactions: [buy('AGGH', 10, 50, 'p2', 'b1')] });

    const under = planFundRelocation(
        { from: { kind: 'cash', brokerId: 'b1' }, to: { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' }, netAmount: 7_000 },
        ctx
    );
    assertTrue('9 flags dropping under the minimum liquidity', under.warnings.some(w => w.kind === 'cash-min-liquidity'));

    const over = planFundRelocation(
        { from: { kind: 'cash', brokerId: 'b1' }, to: { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' }, netAmount: 20_000 },
        ctx
    );
    assertTrue('9 flags the overdraft', over.warnings.some(w => w.kind === 'cash-overdraft'));
}

// ── 10. Net worth falls by the friction on EVERY endpoint combination ────────
{
    // The invariant the what-if table states in words ("falls by exactly the
    // friction") held for portfolio sources but not for cash ones, and one broken
    // branch is invisible when the others are checked. So check the whole matrix.
    const goals: Goal[] = [];
    const fixture = () => {
        const brokers = [fixedBroker('b1', 5, 50_000), fixedBroker('b2', 5, 20_000)];
        const transactions = [buy('SWDA', 200, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b1')];
        return { brokers, transactions };
    };

    const check = (label: string, request: RelocationRequest) => {
        const { brokers, transactions } = fixture();
        const ctx = ctxOf({ brokers, transactions });
        const plan = planFundRelocation(request, ctx);
        const snapshotInput = {
            transactions, brokers, portfolios: ctx.portfolios, goals,
            assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
        };
        const before = buildSnapshot(snapshotInput);
        const moved = applyRelocationToState(transactions, brokers, request, plan);
        const after = buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });
        assertEq(`10 ${label}`, before.netWorth - after.netWorth, plan.friction, 1e-6);
    };

    const p2 = { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' } as const;
    check('cash(b1) → portfolio', { from: { kind: 'cash', brokerId: 'b1' }, to: p2, netAmount: 10_000 });
    check('cash(unpinned) → portfolio', { from: { kind: 'cash' }, to: p2, netAmount: 10_000 });
    check('cash(b2) → portfolio at b1', { from: { kind: 'cash', brokerId: 'b2' }, to: p2, netAmount: 10_000 });
    check('portfolio → cash', { from: { kind: 'portfolio', portfolioId: 'p1' }, to: { kind: 'cash', brokerId: 'b1' }, netAmount: 5_000 });
    check('portfolio → portfolio', { from: { kind: 'portfolio', portfolioId: 'p1' }, to: { kind: 'portfolio', portfolioId: 'p2' }, netAmount: 5_000 });
    check('cash(b1) → cash(b2)', { from: { kind: 'cash', brokerId: 'b1' }, to: { kind: 'cash', brokerId: 'b2' }, netAmount: 5_000 });
    check('cash(unpinned) → cash(b2)', { from: { kind: 'cash' }, to: { kind: 'cash', brokerId: 'b2' }, netAmount: 5_000 });
}

// ── 11. A chain holds the same invariant, cash leg included ──────────────────
{
    // What the "after all 3 moves" table actually compares: today against the end
    // of the whole chain. A single mispriced cash leg used to throw off the total.
    const brokers = [fixedBroker('b1', 5, 50_000)];
    const transactions = [buy('SWDA', 300, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b1')];
    const ctx = ctxOf({ brokers, transactions });

    const queue: RelocationRequest[] = [
        { from: { kind: 'portfolio', portfolioId: 'p1' }, to: { kind: 'portfolio', portfolioId: 'p2' }, netAmount: 3_000 },
        { from: { kind: 'cash', brokerId: 'b1' }, to: { kind: 'portfolio', portfolioId: 'p2', ticker: 'AGGH' }, netAmount: 4_000 },
        { from: { kind: 'portfolio', portfolioId: 'p2' }, to: { kind: 'portfolio', portfolioId: 'p1' }, netAmount: 2_000 },
    ];
    const sequence = planRelocationSequence(queue, ctx);

    // The pyramid only totals to net worth when the portfolios have goals to sit
    // in — otherwise their value is simply absent from every level.
    const goals: Goal[] = [
        { id: 'g-growth', title: 'Growth', order: 0 },
        { id: 'g-security', title: 'Security', order: 1 },
    ];
    const snapshotInput = {
        transactions, brokers, portfolios: ctx.portfolios, goals,
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const after = buildSnapshot({ ...snapshotInput, transactions: sequence.ctx.transactions, brokers: sequence.ctx.brokers });

    assertEq('11 three moves priced', sequence.steps.length, 3);
    assertTrue('11 every step does something', sequence.steps.every(s => planHasEffect(s.plan)));
    assertEq('11 net worth falls by the chain friction', before.netWorth - after.netWorth, sequence.totals.friction, 1e-6);
    assertEq('11 the pyramid total agrees', before.goalPyramidTotal - after.goalPyramidTotal, sequence.totals.friction, 1e-6);
}

// ── 12. A leg with no resolvable broker still moves its cash ─────────────────
{
    // No brokerId on the transaction and no preferred broker on the portfolio: the
    // proceeds used to be dropped on the floor, so net worth fell by the whole
    // gross sold instead of by the friction.
    const brokers = [fixedBroker('b1', 5, 1_000)];
    const transactions = [
        ({ id: 'x1', ticker: 'SWDA', amount: 300, price: 80, date: '2020-01-01', direction: 'Buy', portfolioId: 'p1' }) as Transaction,
        buy('AGGH', 100, 40, 'p2', 'b1'),
    ];
    const ctx = ctxOf({ brokers, transactions });
    const request: RelocationRequest = {
        from: { kind: 'portfolio', portfolioId: 'p1' },
        to: { kind: 'portfolio', portfolioId: 'p2' },
        netAmount: 3_000,
    };
    const plan = planFundRelocation(request, ctx);

    assertTrue('12 the sell leg has no broker', plan.sells.every(s => s.brokerId === undefined));

    const snapshotInput = {
        transactions, brokers, portfolios: ctx.portfolios, goals: [] as Goal[],
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const moved = applyRelocationToState(transactions, brokers, request, plan);
    const after = buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });

    assertEq('12 net worth still falls by exactly the friction', before.netWorth - after.netWorth, plan.friction, 1e-6);
}

// ── 13. Cross-broker: the wire is listed, and the after-state honours it ─────
{
    // p1 is held at b1, p2 at b2, and b2 holds far less cash than the buy costs
    // — with an earmark on top. The proceeds have to be wired from b1 to b2.
    const brokers = [
        ({ id: 'b1', name: 'Degiro', commissionType: 'fixed', commissionFixed: 5, currentLiquidity: 1_000 }) as Broker,
        ({ id: 'b2', name: 'Directa', commissionType: 'fixed', commissionFixed: 5, currentLiquidity: 2_000, liquidityAllocations: { p2: 1_500 } }) as Broker,
    ];
    const transactions = [buy('SWDA', 300, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b2')];
    const ctx = ctxOf({ brokers, transactions });
    const request: RelocationRequest = {
        from: { kind: 'portfolio', portfolioId: 'p1' },
        to: { kind: 'portfolio', portfolioId: 'p2' },
        netAmount: 20_000,
    };
    const plan = planFundRelocation(request, ctx);

    assertEq('13 one wire', plan.transfers.length, 1);
    assertEq('13 out of the selling broker', plan.transfers[0].fromBrokerId === 'b1' ? 1 : 0, 1);
    assertEq('13 into the buying broker', plan.transfers[0].toBrokerId === 'b2' ? 1 : 0, 1);
    assertTrue('13 the buys cannot clear without it', plan.transfers[0].required);
    // It carries the buy outlay: b2 pays gross + commission and holds nothing
    // like that much of its own.
    const outlay = plan.buys.reduce((s, b) => s + b.gross + b.commission, 0);
    assertEq('13 the wire carries the outlay', plan.transfers[0].amount, Math.min(outlay, plan.sells.reduce((s, l) => s + l.net, 0)), 1e-6);
    assertTrue('13 and it is flagged', plan.warnings.some(w => w.kind === 'cross-broker'));

    const goals: Goal[] = [
        { id: 'g-growth', title: 'Growth', order: 0 },
        { id: 'g-security', title: 'Security', order: 1 },
    ];
    const snapshotInput = {
        transactions, brokers, portfolios: ctx.portfolios, goals,
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const moved = applyRelocationToState(transactions, brokers, request, plan);
    const after = buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });

    // The regression this pins down: without the wire, b2 went €18k negative,
    // its earmark was rescaled by a NEGATIVE factor, and the pyramid's Liquidity
    // level grew by the whole amount moved — net worth and the pyramid total
    // disagreeing by €18k on a move that only costs its friction.
    assertTrue('13 no broker is driven negative', moved.brokers.every(b => (b.currentLiquidity ?? 0) >= 0));
    assertTrue('13 no earmark goes negative', moved.brokers.every(b =>
        Object.values(b.liquidityAllocations || {}).every(v => (v || 0) >= 0)));
    assertEq('13 net worth falls by exactly the friction', before.netWorth - after.netWorth, plan.friction, 1e-6);
    assertEq('13 the pyramid total agrees', before.goalPyramidTotal - after.goalPyramidTotal, plan.friction, 1e-6);
    // The only cash that appears out of the move is what whole-share rounding
    // could not deploy — it used to be the whole amount wired.
    const undeployed = plan.warnings.find(w => w.kind === 'buy-shortfall')?.amount ?? 0;
    assertEq('13 unassigned liquidity only grows by what stayed undeployed', after.liquidity - before.liquidity, undeployed, 1e-6);
}

// ── 14. Same broker on both legs: nothing to wire ────────────────────────────
{
    const brokers = [fixedBroker('b1', 5, 1_000)];
    const transactions = [buy('SWDA', 300, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b1')];
    const ctx = ctxOf({ brokers, transactions });
    const plan = planFundRelocation(
        { from: { kind: 'portfolio', portfolioId: 'p1' }, to: { kind: 'portfolio', portfolioId: 'p2' }, netAmount: 5_000 },
        ctx
    );
    assertEq('14 no wire needed', plan.transfers.length, 0);
    assertTrue('14 and nothing is flagged', !plan.warnings.some(w => w.kind === 'cross-broker'));
}

// ── 15. A destination that can pay its own way: a wire, but not a blocking one ─
{
    // Same crossing as 13, except b2 is sitting on enough cash to clear the buys
    // by itself: the money still belongs at b2, so the wire is listed — but it
    // does not stop anything, so it must not be flagged as a warning.
    const brokers = [
        ({ id: 'b1', name: 'Degiro', commissionType: 'fixed', commissionFixed: 5, currentLiquidity: 1_000 }) as Broker,
        ({ id: 'b2', name: 'Directa', commissionType: 'fixed', commissionFixed: 5, currentLiquidity: 80_000 }) as Broker,
    ];
    const transactions = [buy('SWDA', 300, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b2')];
    const ctx = ctxOf({ brokers, transactions });
    const plan = planFundRelocation(
        { from: { kind: 'portfolio', portfolioId: 'p1' }, to: { kind: 'portfolio', portfolioId: 'p2' }, netAmount: 20_000 },
        ctx
    );

    assertEq('15 the wire is still listed', plan.transfers.length, 1);
    assertTrue('15 but nothing is blocked', !plan.transfers[0].required);
    assertTrue('15 so no warning', !plan.warnings.some(w => w.kind === 'cross-broker'));
}

// ── 16. Spending cash: it simply stops being there ──────────────────────────
{
    // The point of the spend endpoint: no sale, no fee, no transaction — the
    // money leaves the net worth and the stats are read without it.
    const brokers = [fixedBroker('b1', 5, 30_000), fixedBroker('b2', 5, 10_000)];
    const transactions = [buy('SWDA', 200, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b1')];
    const ctx = ctxOf({ brokers, transactions });
    const request: RelocationRequest = {
        from: { kind: 'cash', brokerId: 'b1' },
        to: { kind: 'spend' },
        netAmount: 12_000,
    };
    const plan = planFundRelocation(request, ctx);

    assertEq('16 nothing is sold', plan.sells.length, 0);
    assertEq('16 nothing is bought', plan.buys.length, 0);
    assertEq('16 no friction at all', plan.friction, 0);
    assertEq('16 the whole amount is spent', plan.spent, 12_000);
    assertTrue('16 the move does something', planHasEffect(plan));

    const goals: Goal[] = [
        { id: 'g-growth', title: 'Growth', order: 0 },
        { id: 'g-security', title: 'Security', order: 1 },
    ];
    const snapshotInput = {
        transactions, brokers, portfolios: ctx.portfolios, goals,
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const moved = applyRelocationToState(transactions, brokers, request, plan);
    const after = buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });

    assertEq('16 no transaction is invented', moved.transactions.length, transactions.length);
    assertEq('16 liquidity falls by the spend', before.liquidity - after.liquidity, plan.spent, 1e-6);
    assertEq('16 the investments are untouched', after.invested - before.invested, 0, 1e-6);
    assertEq('16 net worth falls by exactly the spend', before.netWorth - after.netWorth, plan.spent, 1e-6);
    assertEq('16 the pyramid total agrees', before.goalPyramidTotal - after.goalPyramidTotal, plan.spent, 1e-6);
    assertEq('16 it comes out of the broker it was pinned to',
        (brokers[0].currentLiquidity ?? 0) - (moved.brokers[0].currentLiquidity ?? 0), 12_000, 1e-6);
    assertEq('16 and not out of the other one',
        (brokers[1].currentLiquidity ?? 0) - (moved.brokers[1].currentLiquidity ?? 0), 0, 1e-6);
}

// ── 17. Spending more than the cash: flagged like any other overdraft ───────
{
    const brokers = [fixedBroker('b1', 5, 5_000)];
    const ctx = ctxOf({ brokers, transactions: [buy('SWDA', 200, 80, 'p1', 'b1')] });
    const plan = planFundRelocation(
        { from: { kind: 'cash', brokerId: 'b1' }, to: { kind: 'spend' }, netAmount: 9_000 },
        ctx
    );
    assertTrue('17 the overdraft is flagged', plan.warnings.some(w => w.kind === 'cash-overdraft'));
}

// ── 18. Spending what a sale raises: friction AND the spend leave ───────────
{
    // The case the "falls by exactly the friction" invariant does not cover: a
    // spend is not a cost, so the drop has to be friction PLUS what was used.
    const brokers = [fixedBroker('b1', 5, 1_000)];
    const transactions = [buy('SWDA', 300, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b1')];
    const ctx = ctxOf({ brokers, transactions });
    const request: RelocationRequest = {
        from: { kind: 'portfolio', portfolioId: 'p1' },
        to: { kind: 'spend' },
        netAmount: 5_000,
    };
    const plan = planFundRelocation(request, ctx);

    assertTrue('18 something is sold', plan.sells.length > 0);
    assertTrue('18 nothing is bought', plan.buys.length === 0);
    assertTrue('18 no wire: the money is spent where it landed', plan.transfers.length === 0);
    assertEq('18 exactly the requested amount is spent', plan.spent, 5_000);
    assertTrue('18 the friction is only the sell side', plan.friction === plan.tax + plan.sellCommission);

    const goals: Goal[] = [
        { id: 'g-growth', title: 'Growth', order: 0 },
        { id: 'g-security', title: 'Security', order: 1 },
    ];
    const snapshotInput = {
        transactions, brokers, portfolios: ctx.portfolios, goals,
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const moved = applyRelocationToState(transactions, brokers, request, plan);
    const after = buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });

    assertEq('18 net worth falls by the friction plus the spend',
        before.netWorth - after.netWorth, plan.friction + plan.spent, 1e-6);
    // Whole shares cannot raise €5,000 to the euro: the change is reported and
    // stays in the account instead of being spent by accident.
    const change = plan.sells.reduce((s, l) => s + l.net, 0) - plan.spent;
    assertTrue('18 the change is kept, not spent', change > 0);
    assertEq('18 and it is reported',
        plan.warnings.find(w => w.kind === 'spend-residual')?.amount ?? 0, change, 1e-6);
    assertEq('18 liquidity rises by exactly that change', after.liquidity - before.liquidity, change, 1e-6);
    assertTrue('18 no broker is driven negative', moved.brokers.every(b => (b.currentLiquidity ?? 0) >= 0));
}

// ── 19. A spend inside a chain, priced on the state before it ───────────────
{
    const brokers = [fixedBroker('b1', 5, 20_000)];
    const transactions = [buy('SWDA', 300, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b1')];
    const ctx = ctxOf({ brokers, transactions });

    const queue: RelocationRequest[] = [
        { from: { kind: 'portfolio', portfolioId: 'p1' }, to: { kind: 'portfolio', portfolioId: 'p2' }, netAmount: 3_000 },
        { from: { kind: 'cash', brokerId: 'b1' }, to: { kind: 'spend' }, netAmount: 8_000 },
    ];
    const sequence = planRelocationSequence(queue, ctx);

    const goals: Goal[] = [
        { id: 'g-growth', title: 'Growth', order: 0 },
        { id: 'g-security', title: 'Security', order: 1 },
    ];
    const snapshotInput = {
        transactions, brokers, portfolios: ctx.portfolios, goals,
        assetSettings, marketData, macroAllocations: {}, goalAllocations: {},
    };
    const before = buildSnapshot(snapshotInput);
    const after = buildSnapshot({ ...snapshotInput, transactions: sequence.ctx.transactions, brokers: sequence.ctx.brokers });

    assertEq('19 the chain spends once', sequence.totals.spent, 8_000);
    assertEq('19 net worth falls by the friction plus the spend',
        before.netWorth - after.netWorth, sequence.totals.friction + sequence.totals.spent, 1e-6);
    assertEq('19 the pyramid total agrees',
        before.goalPyramidTotal - after.goalPyramidTotal, sequence.totals.friction + sequence.totals.spent, 1e-6);
    // The spend only ever touches cash, so the trades of step 1 are the only
    // transactions the chain produces.
    assertTrue('19 the spend adds no transaction',
        sequence.ctx.transactions.length === transactions.length + sequence.steps[0].plan.sells.length + sequence.steps[0].plan.buys.length);
}

// ── 20. Spend is a destination only ─────────────────────────────────────────
{
    const ctx = ctxOf({ brokers: [fixedBroker('b1', 5, 10_000)], transactions: [buy('SWDA', 100, 80, 'p1', 'b1')] });
    const plan = planFundRelocation(
        { from: { kind: 'spend' }, to: { kind: 'portfolio', portfolioId: 'p2' }, netAmount: 1_000 },
        ctx
    );
    assertTrue('20 nothing comes out of money that is gone', !planHasEffect(plan));
    assertEq('20 and nothing is spent', plan.spent, 0);
}

// ── 21. Spending the total liquidity: taken pro-rata, nobody goes negative ──
{
    // "Total liquidity" is not a pot: it is every broker at once. Draining the
    // first one until it goes negative would rescale its earmarks by a negative
    // factor and inflate the pyramid — the bug section 13 pins down for wires.
    const brokers = [fixedBroker('b1', 5, 4_000), fixedBroker('b2', 5, 16_000)];
    const request: RelocationRequest = { from: { kind: 'cash' }, to: { kind: 'spend' }, netAmount: 10_000 };
    const ctx = ctxOf({ brokers, transactions: [] });
    const plan = planFundRelocation(request, ctx);
    const moved = applyRelocationToState([], brokers, request, plan);

    assertEq('21 the whole amount is spent', plan.spent, 10_000);
    assertTrue('21 no broker is driven negative', moved.brokers.every(b => (b.currentLiquidity ?? 0) >= 0));
    assertEq('21 taken in proportion to what each holds',
        moved.brokers.find(b => b.id === 'b1')!.currentLiquidity ?? 0, 2_000, 1e-6);
    assertEq('21 total liquidity falls by the spend',
        brokers.reduce((s, b) => s + (b.currentLiquidity ?? 0), 0)
        - moved.brokers.reduce((s, b) => s + (b.currentLiquidity ?? 0), 0), 10_000, 1e-6);
}

console.log('\nAll fund-relocation checks passed.');
