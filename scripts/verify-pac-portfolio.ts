// Known-answer checks for PAC plans that buy a whole portfolio: the split by
// target quotas (underweight first), fractional vs whole units, fees taken
// out of the amount, and the residue that is parked. Invented data only.
// Run with: npx esbuild scripts/verify-pac-portfolio.ts --bundle --format=esm | node --input-type=module
import type { Broker, PacPlan, Portfolio, Transaction } from '../src/types';
import { computePortfolioInstalment } from '../src/utils/pacPortfolio';
import { detectPac } from '../src/utils/operationsQueue';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};

const portfolio: Portfolio = { id: 'pf', name: 'Core', allocations: { AAA: 60, BBB: 40 }, order: 0 } as Portfolio;
const marketData = { AAA: { price: 100, lastUpdated: '' }, BBB: { price: 50, lastUpdated: '' } };
const broker: Broker = { id: 'bk', name: 'Broker', currentLiquidity: 10_000 } as Broker;
// Held: AAA 6 × 100 = 600, BBB 4 × 50 = 200 → total 800; BBB is underweight.
const txs: Transaction[] = [
    { id: 't1', ticker: 'AAA', amount: 6, price: 100, date: '2026-01-02', direction: 'Buy', portfolioId: 'pf', brokerId: 'bk' },
    { id: 't2', ticker: 'BBB', amount: 4, price: 50, date: '2026-01-02', direction: 'Buy', portfolioId: 'pf', brokerId: 'bk' },
];
const plan: PacPlan = {
    id: 'pp', name: 'Monthly Core', target: 'portfolio', ticker: '', portfolioId: 'pf', brokerId: 'bk',
    mode: 'amount', amount: 200, frequency: 'monthly', startDate: '2026-02-01',
    costMode: 'none', costsIncluded: true, rounding: 'fractional', active: true, createdAt: '2026-01-15T00:00:00.000Z',
};
const run = (p: PacPlan, carryIn = 0) => computePortfolioInstalment({
    plan: p, portfolio, carryIn, broker, transactions: txs, assetSettings: [], marketData, brokers: [broker],
});

// Fractional: after the money, base 1000 → AAA wants 600 (gap 0), BBB wants 400 (gap 200): all to BBB.
const f = run(plan);
assertEq('fractional: one order', f.orders.length, 1);
assertTrue('fractional: buys BBB', f.orders[0].ticker === 'BBB');
assertEq('fractional: BBB qty', f.orders[0].quantity, 4);
assertEq('fractional: invested', f.invested, 200);
assertEq('fractional: no residue', f.carryOut, 0);

// Bigger amount, both underweight: 1200 → base 2000, AAA gap 600, BBB gap 600 → 600 each.
const f2 = run({ ...plan, amount: 1200 });
assertEq('fractional 1200: AAA qty', f2.orders.find(o => o.ticker === 'AAA')!.quantity, 6);
assertEq('fractional 1200: BBB qty', f2.orders.find(o => o.ticker === 'BBB')!.quantity, 12);

// Whole units with a residue: 230 → BBB gap 230 → 4 units (200), 30 parked.
const w = run({ ...plan, amount: 230, rounding: 'floor' });
assertEq('floor: invested', w.invested, 200);
assertEq('floor: residue parked', w.carryOut, 30);
assertEq('floor: parked delta', w.parkedDelta, 30);

// Carry-in reused: 230 + 30 carried → 260 → 5 units of BBB (250), 10 left.
const c = run({ ...plan, amount: 230, rounding: 'floor-carry' }, 30);
assertEq('floor-carry: budget', c.budget, 260);
assertEq('floor-carry: invested', c.invested, 250);
assertEq('floor-carry: carry out', c.carryOut, 10);
assertEq('floor-carry: parked delta', c.parkedDelta, -20);

// Fixed fee out of the amount: 200 − 2 = 198 into BBB.
const fee = run({ ...plan, costMode: 'fixed', costFixed: 2 });
assertEq('fee included: fee', fee.fees, 2);
assertEq('fee included: invested', fee.invested, 198);
assertEq('fee included: outlay = amount', fee.totalOutlay, 200);

// Operations to-do names what to buy.
const todos = detectPac({
    plans: [plan], executions: [], now: new Date('2026-02-01T10:00:00'),
    portfolios: [portfolio], transactions: txs, assetSettings: [], marketData, brokers: [broker],
});
assertEq('to-do: one instalment', todos.length, 1);
assertTrue('to-do: says what to buy', /buy BBB 4 × €50\.00/.test(todos[0].detail));
console.log(todos[0].title, '—', todos[0].detail);
console.log('all PAC portfolio checks passed');
