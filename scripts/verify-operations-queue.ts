// Known-answer checks for Execute → Operations: each detector raises its to-do
// only while the condition holds, and snoozed keys stay hidden until their date.
// Run with: npx esbuild scripts/verify-operations-queue.ts --bundle --format=esm --platform=node | node --input-type=module
import {
    addOperationRecord, buildCashInvestOrders, detectBrokerCash, detectLiquidity, detectPac, detectPrices, detectRebalance, detectSyncs, detectVirtualBonds,
    normalizeOperations, visibleTodos, type OperationTodo,
} from '../src/utils/operationsQueue';
import type { Broker, OperationRecord, PacPlan, Portfolio, Transaction } from '../src/types';

const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
    console.log(`ok ${label} = ${a}`);
};

const now = new Date('2030-03-15T10:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

// Prices
const md = { AAA: { price: 10, lastUpdated: hoursAgo(2) }, BBB: { price: 20, lastUpdated: hoursAgo(30) } };
check('prices: one stale', detectPrices({ tickers: ['AAA', 'BBB'], marketData: md, now }).map(t => t.detail), ['1 of 2 tickers older than a day: BBB']);
check('prices: missing price counts', detectPrices({ tickers: ['CCC'], marketData: md, now }).length, 1);
check('prices: fresh', detectPrices({ tickers: ['AAA'], marketData: md, now }).length, 0);

// Liquidity: YNAB-mapped broker, last update from the records
const broker = { id: 'b1', name: 'Broker One', currentLiquidity: 1000 } as Broker;
const rec = (kind: OperationRecord['kind'], at: string, status: OperationRecord['status'] = 'done', key: string = kind, until?: string): OperationRecord =>
    ({ id: `${key}-${at}`, key, kind, title: key, status, at, ...(until ? { until } : {}) });
check('liquidity: never updated', detectLiquidity({ brokers: [broker], ynabBrokerIds: new Set(['b1']), records: [], now }).length, 1);
check('liquidity: updated 2 days ago', detectLiquidity({ brokers: [broker], ynabBrokerIds: new Set(['b1']), records: [rec('liquidity', hoursAgo(48))], now }).length, 0);
check('liquidity: not mapped, no plan', detectLiquidity({ brokers: [broker], ynabBrokerIds: new Set(), records: [], now }).length, 0);

// PAC
const plan = { id: 'p1', name: 'Monthly ETF', ticker: 'AAA', portfolioId: 'pf', brokerId: 'b1', mode: 'amount', amount: 100, frequency: 'monthly', startDate: '2030-01-10', costMode: 'none', costsIncluded: false, rounding: 'floor', active: true, createdAt: '' } as unknown as PacPlan;
const pac = detectPac({ plans: [plan], executions: [{ planId: 'p1', dueDate: '2030-01-10', transactionId: 't' }], now });
check('pac: due dates not actioned', pac.map(t => [t.key, t.urgency]), [['pac:p1:2030-02-10', 'overdue'], ['pac:p1:2030-03-10', 'overdue']]);
check('pac: nothing before the plan was created', detectPac({ plans: [{ ...plan, createdAt: '2030-03-01T09:00:00Z' }], executions: [], now }).map(t => t.dueDate), ['2030-03-10']);
check('pac: titled by the plan name', pac[0].title, 'PAC instalment: Monthly ETF');
check('pac: paused plan', detectPac({ plans: [{ ...plan, active: false }], executions: [], now }).length, 0);

// Rebalance: 80/20 target held 50/50 → drift 30 points
const pf: Portfolio = { id: 'pf', name: 'Core', allocations: { AAA: 80, BBB: 20 } } as Portfolio;
const tx = (ticker: string, amount: number, price: number): Transaction =>
    ({ id: `${ticker}-${amount}`, ticker, amount, price, date: '2030-01-02', direction: 'Buy', portfolioId: 'pf', brokerId: 'b1' } as Transaction);
const prices = { AAA: { price: 10, lastUpdated: hoursAgo(1) }, BBB: { price: 10, lastUpdated: hoursAgo(1) } };
const reb = detectRebalance({ portfolios: [pf], transactions: [tx('AAA', 50, 10), tx('BBB', 50, 10)], assetSettings: [], marketData: prices, brokers: [] });
check('rebalance: drifted', reb.map(t => [t.key, t.orders?.map(o => [o.direction, o.ticker, o.amount])]), [['rebalance:pf:full', [['Buy', 'AAA', 30], ['Sell', 'BBB', 30]]]]);
const onTarget = detectRebalance({ portfolios: [pf], transactions: [tx('AAA', 79, 10), tx('BBB', 21, 10)], assetSettings: [], marketData: prices, brokers: [] });
check('rebalance: within the threshold', onTarget.length, 0);
check('rebalance: amount mode left out', detectRebalance({ portfolios: [{ ...pf, targetMode: 'amount' }], transactions: [tx('AAA', 50, 10)], assetSettings: [], marketData: prices, brokers: [] }).length, 0);

// Buy only: never more than the cash the broker really holds for the portfolio
const cashPf: Portfolio = { ...pf, allocations: { AAA: 50, BBB: 50 }, liquidity: 5000, preferredBrokerId: 'b1' } as Portfolio;
const thin = { id: 'b1', name: 'Broker One', currentLiquidity: 600, liquidityAllocations: { pf: 1000, other: 200 } } as unknown as Broker;
const buy = detectRebalance({ portfolios: [cashPf], transactions: [tx('AAA', 50, 10), tx('BBB', 50, 10)], assetSettings: [], marketData: prices, brokers: [thin] })
    .find(t => t.mode === 'BuyOnly');
check('buy only capped to the real cash', [buy?.detail.startsWith('€500 to deploy'), buy?.orders?.reduce((s, o) => s + o.amount * o.price, 0)], [true, 500]);
check('no cash at the broker: no buy only', detectRebalance({ portfolios: [cashPf], transactions: [tx('AAA', 50, 10), tx('BBB', 50, 10)], assetSettings: [], marketData: prices, brokers: [{ ...thin, currentLiquidity: 0 }] }).length, 0);

// Virtual bonds with parked cash
const vb = { id: 'v1', label: 'BTP ~2032', targetMaturityDate: '2032-06-01', universe: 'IT', minMonthsBefore: 1, maxMonthsBefore: 6, createdAt: '' } as const;
const parked = { id: 'pk', ticker: '_VBOND_v1', amount: 2000, price: 1, date: '2030-01-01', direction: 'Buy' } as Transaction;
check('virtual bond: parked', detectVirtualBonds({ virtualBonds: [vb], transactions: [parked] }).map(t => t.key), ['virtual-bond:v1']);
check('virtual bond: resolved', detectVirtualBonds({ virtualBonds: [{ ...vb, resolvedIsin: 'IT0000000001' }], transactions: [parked] }).length, 0);

// Syncs
check('syncs', detectSyncs({ goalsGroupSet: true, lastGoalsSyncAt: hoursAgo(24 * 10), azureEnabled: true, azureLastSync: hoursAgo(24), now }).map(t => t.key), ['capex-sync']);

// Snooze, records
const todos: OperationTodo[] = [
    { key: 'a', kind: 'prices', title: 'a', detail: '', urgency: 'info' },
    { key: 'b', kind: 'pac', title: 'b', detail: '', urgency: 'overdue' },
];
const snoozed = [rec('prices', hoursAgo(1), 'snoozed', 'a', new Date(now.getTime() + 86_400_000).toISOString())];
check('snoozed hidden, overdue first', visibleTodos(todos, snoozed, now).map(t => t.key), ['b']);
check('snooze expired', visibleTodos(todos, [rec('prices', hoursAgo(50), 'snoozed', 'a', hoursAgo(1))], now).map(t => t.key), ['b', 'a']);
const replaced = addOperationRecord(snoozed, rec('prices', hoursAgo(0), 'snoozed', 'a', hoursAgo(0)));
check('a new snooze replaces the old one', replaced.length, 1);
check('done records accumulate', addOperationRecord(addOperationRecord([], rec('prices', hoursAgo(2))), rec('prices', hoursAgo(1))).length, 2);
check('normalize drops malformed', normalizeOperations([rec('prices', hoursAgo(1)), { id: 'x' }, null]).length, 1);


// Interest: a remunerated broker, a cent-sized accrual is not a to-do
const remunerated = (rate: number) => ({ id: 'r1', name: 'Saver', currentLiquidity: 10000, remuneration: { annualRatePercent: rate, frequency: 'monthly', creditDay: 1, startDate: '2030-01-01' } } as unknown as Broker);
check('interest due', detectLiquidity({ brokers: [remunerated(3)], ynabBrokerIds: new Set(), records: [], now }).length, 1);
check('interest of cents', detectLiquidity({ brokers: [remunerated(0.01)], ynabBrokerIds: new Set(), records: [], now }).length, 0);
// Broker cash out of range (same figures as the Dashboard cards)
const bc = (liq: number, min: number, alloc = 0): Broker => ({ id: 'c1', name: 'Cash Broker', currentLiquidity: liq, minLiquidityType: 'fixed', minLiquidityAmount: min, ...(alloc ? { liquidityAllocations: { pf: alloc } } : {}) } as Broker);
const cash = (b: Broker, reserve = true) => detectBrokerCash({ brokers: [b], transactions: [], assetSettings: [], marketData: {}, reserveAllocatedCash: reserve });
check('broker cash: below the minimum', cash(bc(800, 1000)).map(t => [t.urgency, t.amount]), [['due', -200]]);
check('broker cash: within tolerance', cash(bc(950, 1000)).length, 0);
check('broker cash: allocated cash reserved too', cash(bc(1200, 1000, 500)).map(t => t.amount), [-300]);
check('broker cash: allocated cash not reserved', cash(bc(1200, 1000, 500), false).map(t => t.amount), [200]);
check('broker cash: you can invest', cash(bc(3000, 1000)).map(t => [t.title, t.amount]), [['You can invest €2,000 from Cash Broker', 2000]]);
check('broker cash: from €100, like the Dashboard', [cash(bc(1100, 1000)).length, cash(bc(1099, 1000)).length], [1, 0]);
check('broker cash: no minimum, nothing to say', cash(bc(3000, 0)).length, 0);
check('broker cash: negative without a minimum', cash(bc(-400, 0)).map(t => t.amount), [-400]);
const invest = buildCashInvestOrders({ portfolio: pf, amount: 1000, broker: bc(3000, 1000), transactions: [tx('AAA', 50, 10), tx('BBB', 50, 10)], assetSettings: [], marketData: prices, brokers: [] });
check('invest free cash: Buy only toward the targets, at that broker', invest.map(o => [o.direction, o.ticker, o.amount, o.brokerId]), [['Buy', 'AAA', 100, 'c1']]);
console.log('all operations queue checks passed');
