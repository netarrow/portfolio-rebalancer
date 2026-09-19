// Known-answer checks for the YNAB funding plan: order merging, commission
// pricing (fixed, percent-with-minimum, free-buy promos, no-plan brokers), bond
// lot sizing, and the wire each broker needs once its own cash is counted.
// Run with: npx esbuild scripts/verify-ynab-funding-plan.ts --bundle --format=esm | node --input-type=module
import type {
    AssetDefinition, Broker, FreeCommissionPeriod, Portfolio, Transaction,
    YnabCategory, YnabCategoryMapping, YnabFundingSettings,
} from '../src/types';
import { DEFAULT_YNAB_FUNDING_SETTINGS } from '../src/types';
import {
    buildYnabFundingPlan, isRegisterableOrder, roundUpTo, transferCostFor, YNAB_FUNDING_TX_PREFIX,
} from '../src/utils/ynabFundingPlan';

let failures = 0;

const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
    }
};

const MONTH = '2026-09';
const TODAY = '2026-09-19';

// ── Fixtures ────────────────────────────────────────────────────────
// Degiro charges €2.50 flat; Directa 0.19% with a €2.95 floor; Trade Republic
// runs a free-buy promo on SWDA this month; Banca Semplice has no plan at all.
const brokers: Broker[] = [
    {
        id: 'b-degiro', name: 'Degiro', commissionType: 'fixed', commissionFixed: 2.5, currentLiquidity: 300,
        transferCost: { type: 'percent', percent: 0.1, min: 1, max: 5 },
    },
    {
        id: 'b-directa', name: 'Directa', commissionType: 'percent', commissionPercent: 0.19,
        commissionMin: 2.95, commissionMax: 19, currentLiquidity: 6000,
        minLiquidityType: 'fixed', minLiquidityAmount: 5000,
        liquidityAllocations: { 'p-other': 400 },
    },
    {
        id: 'b-tr', name: 'Trade Republic', commissionType: 'fixed', commissionFixed: 1, currentLiquidity: 0,
        transferCost: { type: 'fixed', fixed: 0.95 },
    },
    { id: 'b-plain', name: 'Banca Semplice', currentLiquidity: 0 },
];

const portfolios: Portfolio[] = [
    { id: 'p-growth', name: 'Growth', order: 0 },
    { id: 'p-bonds', name: 'Bonds', order: 1, preferredBrokerId: 'b-directa' },
    { id: 'p-other', name: 'Elsewhere', order: 2 },
];

const assetSettings: AssetDefinition[] = [
    { ticker: 'IE00B4L5Y983', label: 'MSCI World', source: 'ETF', assetClass: 'Stock' },
    { ticker: 'IE00BKM4GZ66', label: 'EM IMI', source: 'ETF', assetClass: 'Stock' },
    { ticker: 'IT0005534141', label: 'BTP Dec-2027', source: 'MOT', assetClass: 'Bond' },
];

const prices = {
    IE00B4L5Y983: { price: 100 },
    IE00BKM4GZ66: { price: 31.2 },
    IT0005534141: { price: 99.8 },
};

const cat = (id: string, name: string, balance: number, budgeted = 0): YnabCategory => ({
    id, groupId: 'g1', groupName: 'Investments', name,
    balanceMilliunits: balance * 1000,
    budgetedMilliunits: budgeted * 1000,
});

const categories: YnabCategory[] = [
    cat('c-world-a', 'World ETF', 600, 200),
    cat('c-world-b', 'Year-end top-up', 900, 100),
    cat('c-em', 'Emerging markets', 250, 50),
    cat('c-btp', 'BTP ladder', 2500, 500),
    cat('c-buffer', 'Broker buffer', 400, 0),
    cat('c-empty', 'Not funded yet', 0, 0),
];

const mappings: YnabCategoryMapping[] = [
    // Two categories on the same ticket: one order, one commission.
    { categoryId: 'c-world-a', target: { kind: 'asset', ticker: 'IE00B4L5Y983', brokerId: 'b-degiro', portfolioId: 'p-growth' } },
    { categoryId: 'c-world-b', target: { kind: 'asset', ticker: 'IE00B4L5Y983', brokerId: 'b-degiro', portfolioId: 'p-growth' } },
    // No broker named: the portfolio's preferred broker has to be found.
    { categoryId: 'c-btp', target: { kind: 'asset', ticker: 'IT0005534141', portfolioId: 'p-bonds' } },
    // Neither broker nor portfolio: the last buy of the ticker decides.
    { categoryId: 'c-em', target: { kind: 'asset', ticker: 'IE00BKM4GZ66' } },
    { categoryId: 'c-buffer', target: { kind: 'cash', brokerId: 'b-tr' } },
    { categoryId: 'c-empty', target: { kind: 'asset', ticker: 'IE00BKM4GZ66', brokerId: 'b-degiro', portfolioId: 'p-growth' } },
];

const transactions: Transaction[] = [
    { id: 't1', ticker: 'IE00BKM4GZ66', amount: 10, price: 28, date: '2026-01-10', direction: 'Buy', brokerId: 'b-degiro', portfolioId: 'p-growth' },
    { id: 't2', ticker: 'IE00BKM4GZ66', amount: 10, price: 30, date: '2026-05-10', direction: 'Buy', brokerId: 'b-tr', portfolioId: 'p-growth' },
];

const promos: FreeCommissionPeriod[] = [
    { monthKey: MONTH, brokerId: 'b-tr', isins: ['IE00B4L5Y983'] },
];

const settings: YnabFundingSettings = { ...DEFAULT_YNAB_FUNDING_SETTINGS, transferRoundingStep: 0 };

const build = (overrides: Partial<YnabFundingSettings> = {}, extra: Partial<Parameters<typeof buildYnabFundingPlan>[0]> = {}) =>
    buildYnabFundingPlan({
        categories, mappings, brokers, portfolios, assetSettings, prices,
        transactions, freeCommissionPeriods: promos,
        settings: { ...settings, ...overrides },
        monthKey: MONTH,
        today: TODAY,
        ...extra,
    });

const plan = build();
const orderOf = (p: ReturnType<typeof buildYnabFundingPlan>, ticker: string) =>
    p.orders.find(o => o.ticker === ticker)!;
const transferOf = (p: ReturnType<typeof buildYnabFundingPlan>, brokerId: string | undefined) =>
    p.transfers.find(t => t.brokerId === brokerId)!;

console.log('order merging and sizing');

const world = orderOf(plan, 'IE00B4L5Y983');
check('categories on the same ticker/broker/portfolio merge into one order', world.sources.length, 2);
check('the merged budget is the sum of their balances', world.budget, 1500);
// €1,500 at €100 with a €2.50 flat fee paid out of the same money: 14 shares
// (15 would cost €1,502.50), so €1,400 of shares + €2.50 of fee.
check('the fee is paid out of the budget, so one share less is bought', world.quantity, 14);
check('the trade value is the shares actually bought', world.gross, 1400);
check('the flat commission is charged once for the merged order', world.commission, 2.5);
check('the outlay is shares plus commission', world.outlay, 1402.5);
check('what the budget cannot invest stays as residue', world.leftover, 97.5);
check('a merged order with a broker and a portfolio is registerable', isRegisterableOrder(world), true);

const feesOnTop = build({ feesFromBudget: false });
const worldOnTop = orderOf(feesOnTop, 'IE00B4L5Y983');
check('with fees on top the whole budget is invested', worldOnTop.quantity, 15);
check('and the commission is an extra outlay', worldOnTop.outlay, 1502.5);
check('leaving no residue of the budget itself', worldOnTop.leftover, 0);

const fractional = build({ rounding: 'fractional' });
const worldFractional = orderOf(fractional, 'IE00B4L5Y983');
check('fractional sizing invests the budget net of the fee', worldFractional.gross, 1497.5);
check('as a fractional share count', worldFractional.quantity, 14.975);

console.log('bond lots and broker fallbacks');

const btp = orderOf(plan, 'IT0005534141');
// A BTP quoted per 100 trades in €1,000 lots = 10 units at €99.80 = €998 a lot.
check('a MOT bond is sized in whole €1,000 lots', btp.quantity, 20);
check('two lots of €998 leave the rest uninvested', btp.gross, 1996);
// 0.19% of €1,996 = €3.79, above Directa's €2.95 floor.
check('the percent plan of the portfolio-preferred broker is applied', btp.commission, 3.79);
check('the broker is taken from the portfolio when the mapping omits it', btp.brokerId, 'b-directa');

const em = orderOf(plan, 'IE00BKM4GZ66');
check('with no broker and no portfolio, the last buy of the ticker decides', em.brokerId, 'b-tr');
check('an order with no portfolio cannot be registered', isRegisterableOrder(em), false);
check('and says so', em.warnings, ['no-portfolio']);

console.log('free plans');

const freePlan = build({}, {
    mappings: [{ categoryId: 'c-world-a', target: { kind: 'asset', ticker: 'IE00B4L5Y983', brokerId: 'b-tr', portfolioId: 'p-growth' } }],
});
const freeOrder = orderOf(freePlan, 'IE00B4L5Y983');
check('a free-buy promo month waives the commission', freeOrder.commission, 0);
check('and the whole budget buys shares', freeOrder.quantity, 6);
check('the reason is recorded', [freeOrder.commissionFree, freeOrder.freeReason], [true, 'promo']);
check('the saving is the fee the plan would have charged', freePlan.totals.feesSaved, 1);

const noPlan = build({}, {
    mappings: [{ categoryId: 'c-world-a', target: { kind: 'asset', ticker: 'IE00B4L5Y983', brokerId: 'b-plain', portfolioId: 'p-growth' } }],
});
const noPlanOrder = orderOf(noPlan, 'IE00B4L5Y983');
check('a broker with no commission plan is priced as free', noPlanOrder.commission, 0);
check('and flagged rather than guessed at', noPlanOrder.warnings, ['no-commission-plan']);

const pricelessPlan = build({}, { prices: {} });
const priceless = orderOf(pricelessPlan, 'IE00B4L5Y983');
check('without a price nothing is sized', [priceless.quantity, priceless.outlay], [0, 0]);
check('and the whole budget is reported as residue', priceless.leftover, 1500);
check('with the reason attached', priceless.warnings, ['no-price']);

const tinyPlan = build({}, {
    categories: [cat('c-tiny', 'Just started', 40)],
    mappings: [{ categoryId: 'c-tiny', target: { kind: 'asset', ticker: 'IE00B4L5Y983', brokerId: 'b-degiro', portfolioId: 'p-growth' } }],
});
check('a budget below one unit buys nothing', orderOf(tinyPlan, 'IE00B4L5Y983').quantity, 0);
check('and says the money is not enough yet', orderOf(tinyPlan, 'IE00B4L5Y983').warnings, ['budget-too-small']);

console.log('empty and stale mappings');

check('a mapped category holding no money is listed as ignored',
    plan.ignored.map(i => [i.categoryId, i.reason]),
    [['c-empty', 'no-funds']]);

const stale = build({}, {
    categories: [],
    mappings: [{ categoryId: 'gone', target: { kind: 'asset', ticker: 'IE00B4L5Y983' } }],
});
check('a mapping whose category is gone from YNAB is reported, not planned',
    [stale.orders.length, stale.ignored[0].reason], [0, 'category-missing']);

console.log('transfers');

const degiro = transferOf(plan, 'b-degiro');
check('the wire covers the orders minus the cash already there',
    [degiro.required, degiro.usableCash, degiro.transfer], [1402.5, 300, 1102.5]);

const directa = transferOf(plan, 'b-directa');
// €6,000 held − €5,000 minimum − €400 earmarked for a portfolio out of the plan.
check('a minimum liquidity and other portfolios\' earmarks are not usable', directa.usableCash, 600);
check('so the wire makes up the difference', directa.transfer, 1399.79);
check('and the earmark is flagged', directa.warnings, ['earmark-shortfall']);

const tr = transferOf(plan, 'b-tr');
// The EM order landed here too (last-buy fallback), so this broker's wire has
// to cover both its own order and the €400 of cash the budget parks with it.
check('a cash-mapped category becomes a top-up alongside the orders',
    [tr.deposits, tr.ordersOutlay, tr.required, tr.transfer],
    [400, 219.4, 619.4, 619.4]);

const ignoringCash = build({ useBrokerCash: false });
check('ignoring the broker cash wires the whole requirement',
    transferOf(ignoringCash, 'b-degiro').transfer, 1402.5);

const rounded = build({ transferRoundingStep: 50 });
check('wires round up to the configured step', transferOf(rounded, 'b-degiro').transfer, 1150);
check('rounding up never lands below the requirement',
    transferOf(rounded, 'b-degiro').transfer >= transferOf(rounded, 'b-degiro').shortfall, true);

check('roundUpTo(0, 50) stays at zero', roundUpTo(0, 50), 0);
check('roundUpTo with no step keeps the cents', roundUpTo(1402.5, 0), 1402.5);
check('roundUpTo lifts an exact multiple no further', roundUpTo(100, 50), 100);

console.log('repeat protection');

const repeated = build({}, {
    transactions: [
        ...transactions,
        {
            id: `${YNAB_FUNDING_TX_PREFIX}1`, ticker: 'IE00B4L5Y983', amount: 14, price: 100,
            date: TODAY, direction: 'Buy', brokerId: 'b-degiro', portfolioId: 'p-growth',
        },
    ],
});
check('an order already booked today is flagged',
    orderOf(repeated, 'IE00B4L5Y983').warnings, ['already-registered']);

const yesterday = build({}, {
    transactions: [
        ...transactions,
        {
            id: `${YNAB_FUNDING_TX_PREFIX}1`, ticker: 'IE00B4L5Y983', amount: 14, price: 100,
            date: '2026-09-18', direction: 'Buy', brokerId: 'b-degiro', portfolioId: 'p-growth',
        },
    ],
});
check('yesterday\'s purchase does not block today\'s', orderOf(yesterday, 'IE00B4L5Y983').warnings, []);

console.log('wire costs');

check('a percent wire fee is charged on the amount wired',
    transferOf(plan, 'b-degiro').cost, 1.1);   // 0.1% of €1,102.50
check('a flat wire fee does not move with the amount',
    transferOf(plan, 'b-tr').cost, 0.95);
check('a broker that is already covered is wired nothing, so it costs nothing',
    transferOf(plan, 'b-directa').cost, 0);

check('the percent floor applies to a small wire', transferCostFor(brokers[0], 200), 1);
check('and the cap to a large one', transferCostFor(brokers[0], 100000), 5);
check('a broker with no transfer cost configured wires for free',
    transferCostFor(brokers.find(b => b.id === 'b-plain'), 5000), 0);
check('nothing wired costs nothing', transferCostFor(brokers[0], 0), 0);

const costly = build({}, {
    brokers: brokers.map(b => b.id === 'b-tr' ? { ...b, transferCost: { type: 'fixed' as const, fixed: 40 } } : b),
});
check('a wire fee larger than the configured share of itself is flagged',
    transferOf(costly, 'b-tr').warnings, ['costly-transfer']);

check('the totals carry the wire fees separately from the wires',
    [plan.totals.transfer, plan.totals.transferCost],
    [plan.transfers.reduce((s, t) => s + t.transfer, 0), 2.05]);

console.log('topping up for one more unit');

// €1,500 bought 14 shares of a €100 ETF with a €2.50 flat fee: €1,502.50 would
// have bought 15, so €2.50 more is the whole difference.
check('the plan says what one more share would cost over the budget',
    orderOf(plan, 'IE00B4L5Y983').topUpForNextUnit, 2.5);
// The €2,500 category buys 2 lots (€1,996); a third needs €2,994 of bonds plus
// the €5.69 the percent plan charges at that size — €499.69 more than it holds.
check('for a bond it is a whole lot, fee recomputed at the larger size',
    orderOf(plan, 'IT0005534141').topUpForNextUnit, 499.69);
check('with the fee on top, the top-up is the bare price of the next share',
    orderOf(feesOnTop, 'IE00B4L5Y983').topUpForNextUnit, 100);
check('an order too small to buy anything says what the first unit costs',
    orderOf(tinyPlan, 'IE00B4L5Y983').topUpForNextUnit, 62.5);
check('a fractional order has no next unit to reach for',
    orderOf(fractional, 'IE00B4L5Y983').topUpForNextUnit, undefined);

console.log('totals');

check('the budget total is every euro the mapped categories hold',
    plan.totals.budget, 1500 + 2500 + 250 + 400);
check('the wire total is the sum of the wires',
    plan.totals.transfer,
    plan.transfers.reduce((s, t) => s + t.transfer, 0));
check('nothing is invented: gross + commission + residue = the invested budget',
    Math.round((plan.totals.gross + plan.totals.commission + plan.totals.leftover) * 100) / 100,
    plan.totals.budget - plan.totals.deposits);

const budgetedPlan = build({ source: 'budgeted' });
check('funding from "budgeted this month" uses that figure instead',
    orderOf(budgetedPlan, 'IE00B4L5Y983').budget, 300);

if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll checks passed');
