// Known-answer checks for executing a relocation: what becomes a transaction,
// what only moves cash, and whether the broker balances end where the what-if
// said they would.
// Run with: npx esbuild scripts/verify-relocation-execution.ts --bundle --format=esm | node --input-type=module
import { planRelocationSequence, type RelocationContext, type RelocationRequest } from '../src/utils/fundRelocation';
import { buildExecutionMoves, buildExecutionCommit } from '../src/utils/relocationExecution';
import type { AssetDefinition, Broker, Portfolio, Transaction } from '../src/types';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    // NaN and undefined slip through a bare `> tol` comparison, which would turn
    // a missing figure into a passing check.
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > tol) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};

const assetSettings: AssetDefinition[] = [
    { ticker: 'SWDA', assetClass: 'Stock', assetSubClass: 'International' },
    { ticker: 'AGGH', assetClass: 'Bond', assetSubClass: 'Medium' },
] as AssetDefinition[];

const marketData = {
    SWDA: { price: 100, lastUpdated: '2026-01-01' },
    AGGH: { price: 50, lastUpdated: '2026-01-01' },
};

const buy = (ticker: string, amount: number, price: number, portfolioId: string, brokerId: string): Transaction =>
    ({ id: `${ticker}-${portfolioId}`, ticker, amount, price, date: '2020-01-01', direction: 'Buy', portfolioId, brokerId }) as Transaction;

const portfolios: Portfolio[] = [
    { id: 'p1', name: 'Growth', order: 0, goalId: 'g1', allocations: { SWDA: 100 } },
    { id: 'p2', name: 'Bonds', order: 1, goalId: 'g2', allocations: { AGGH: 100 } },
];

// p1 trades at b1, p2 at b2 — so the proceeds have to be wired across.
const brokers: Broker[] = [
    ({ id: 'b1', name: 'Degiro', commissionType: 'fixed', commissionFixed: 5, currentLiquidity: 1_000 }) as Broker,
    ({ id: 'b2', name: 'Directa', commissionType: 'fixed', commissionFixed: 5, currentLiquidity: 500 }) as Broker,
];
// 300 SWDA bought at 80, now 100: €20 of gain per share, taxed 26%.
const transactions = [buy('SWDA', 300, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b2')];

const ctx: RelocationContext = { portfolios, brokers, transactions, assetSettings, marketData };
const request: RelocationRequest = {
    from: { kind: 'portfolio', portfolioId: 'p1' },
    to: { kind: 'portfolio', portfolioId: 'p2' },
    netAmount: 10_000,
};

const sequence = planRelocationSequence([request], ctx);
const plan = sequence.steps[0].plan;
const moves = buildExecutionMoves(sequence.steps, portfolios);
const commit = buildExecutionCommit(moves, '2026-08-21', 'test');

// ── 1. The checklist is sell → wire → buy, in that order ────────────────────
{
    const kinds = moves[0].steps.map(s => s.kind);
    assertEq('1 one move', moves.length, 1);
    assertTrue('1 it starts with the sells', kinds[0] === 'sell');
    assertTrue('1 the wire sits between the legs', kinds.indexOf('transfer') > kinds.indexOf('sell'));
    assertTrue('1 and the buys come last', kinds.lastIndexOf('buy') === kinds.length - 1);
}

// ── 2. Only the trades reach the ledger ─────────────────────────────────────
{
    assertEq('2 transactions written', commit.transactions.length, plan.sells.length + plan.buys.length);
    assertEq('2 sells recorded', commit.counts.sells, plan.sells.length);
    assertEq('2 buys recorded', commit.counts.buys, plan.buys.length);
    assertEq('2 wires planned', commit.counts.transfers, plan.transfers.length);
    assertTrue('2 no wire became a transaction', commit.transactions.every(t => t.direction === 'Buy' || t.direction === 'Sell'));
    assertTrue('2 every trade carries its portfolio and broker',
        commit.transactions.every(t => !!t.portfolioId && !!t.brokerId));
    assertTrue('2 ids are unique', new Set(commit.transactions.map(t => t.id)).size === commit.transactions.length);
}

// ── 3. Cash: up by the NET of a sale, down and up for the wire, down by a buy ─
{
    const sellNet = plan.sells.reduce((s, l) => s + l.net, 0);
    const buyGross = plan.buys.reduce((s, b) => s + b.gross, 0);
    const buyCost = plan.buys.reduce((s, b) => s + b.gross + b.commission, 0);
    const grossSold = plan.sells.reduce((s, l) => s + l.gross, 0);
    const wired = plan.transfers.reduce((s, t) => s + t.amount, 0);

    // Gross would have credited the seller with the tax and the fee it never sees.
    assertEq('3 tax and fees are not credited', grossSold - sellNet, plan.tax + plan.sellCommission, 1e-6);
    assertEq('3 the seller keeps its net minus what it wired', commit.liquidityDeltas['b1'] ?? 0, sellNet - wired, 0.01);
    // The wire covers the orders exactly, so the buying broker ends where it
    // started — it never had to dip into its own €500.
    assertEq('3 the buyer receives the wire and pays the orders', commit.liquidityDeltas['b2'] ?? 0, wired - buyCost, 0.01);
    assertEq('3 the wire is the outlay', wired, buyCost, 0.01);

    // The identity that ties execution to the what-if: cash moves by
    // sellNet − buyCost, positions by buyGross − grossSold, and the two together
    // are the friction and nothing else.
    const cashDelta = Object.values(commit.liquidityDeltas).reduce((s, v) => s + v, 0);
    assertEq('3 cash across all brokers', cashDelta, sellNet - buyCost, 0.01);
    assertEq('3 net worth falls by exactly the friction', -(cashDelta + buyGross - grossSold), plan.friction, 0.01);
}

// ── 4. No broker is left holding money it never received ────────────────────
{
    const after = brokers.map(b => ({
        id: b.id,
        cash: (b.currentLiquidity ?? 0) + (commit.liquidityDeltas[b.id] ?? 0),
    }));
    assertTrue('4 no negative balance', after.every(b => b.cash >= -0.01));
    // b2 started with €500 and could never have paid for a €10k purchase on its
    // own: without the wire it would end up €9.5k short, which is exactly the
    // hole the after-state used to hide.
    const unfunded = 500 - plan.buys.reduce((s, b) => s + b.gross + b.commission, 0);
    assertTrue('4 it would have gone short without the wire', unfunded < 0);
    assertEq('4 with it, it ends on its own cash', after.find(b => b.id === 'b2')!.cash, 500, 0.01);
}

// ── 5. Same broker on both legs: no wire, and the cash nets in one place ─────
{
    const oneBroker: Broker[] = [({ id: 'b1', name: 'Degiro', commissionType: 'fixed', commissionFixed: 5, currentLiquidity: 1_000 }) as Broker];
    const txs = [buy('SWDA', 300, 80, 'p1', 'b1'), buy('AGGH', 100, 40, 'p2', 'b1')];
    const seq = planRelocationSequence([request], { ...ctx, brokers: oneBroker, transactions: txs });
    const c = buildExecutionCommit(buildExecutionMoves(seq.steps, portfolios), '2026-08-21', 'test2');
    const p = seq.steps[0].plan;

    assertEq('5 no wire', c.counts.transfers, 0);
    assertEq('5 one balance moves',
        c.liquidityDeltas['b1'],
        p.sells.reduce((s, l) => s + l.net, 0) - p.buys.reduce((s, b) => s + b.gross + b.commission, 0),
        0.01);
}

// ── 6. A spend is a simulation: listed, never written ───────────────────────
{
    // Both halves matter. The spend must not reach the ledger — and neither must
    // the sale funding it, or the app would record a trade whose proceeds it
    // then pretends are still there.
    const spendRequest: RelocationRequest = {
        from: { kind: 'portfolio', portfolioId: 'p1' },
        to: { kind: 'spend' },
        netAmount: 6_000,
    };
    const seq = planRelocationSequence([request, spendRequest], ctx);
    const spendMoves = buildExecutionMoves(seq.steps, portfolios);
    const c = buildExecutionCommit(spendMoves, '2026-08-21', 'test3');
    const relocationMove = spendMoves[0];
    const spendMove = spendMoves[1];

    assertTrue('6 the spend move is flagged as simulated', spendMove.simulationOnly);
    assertTrue('6 the relocation is not', !relocationMove.simulationOnly);
    assertTrue('6 it is still listed, sells included',
        spendMove.steps.some(s => s.kind === 'sell') && spendMove.steps.some(s => s.kind === 'spend'));
    assertTrue('6 it reads as an outflow', spendMove.toLabel === 'Spent');

    // Only the first move is committed: same figures as when it was alone.
    assertEq('6 only the real move is written',
        c.transactions.length, seq.steps[0].plan.sells.length + seq.steps[0].plan.buys.length);
    assertTrue('6 nothing from the spend move reached the ledger',
        c.transactions.every(t => t.id.startsWith('test3-1-')));
    assertEq('6 and its cash never moved either',
        Object.values(c.liquidityDeltas).reduce((s, v) => s + v, 0),
        seq.steps[0].plan.sells.reduce((s, l) => s + l.net, 0)
        - seq.steps[0].plan.buys.reduce((s, b) => s + b.gross + b.commission, 0),
        0.01);
}

console.log('\nAll relocation-execution checks passed.');
