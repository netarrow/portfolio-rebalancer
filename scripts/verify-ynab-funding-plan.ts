// Known-answer checks for the YNAB funding plan: order merging, commission
// pricing (fixed, percent-with-minimum, free-buy promos, no-plan brokers), bond
// lot sizing, the wire each broker needs once its own cash is counted, and the
// split of a category that funds a whole portfolio.
// Run with: npx esbuild scripts/verify-ynab-funding-plan.ts --bundle --format=esm | node --input-type=module
import type {
    AssetDefinition, Broker, FreeCommissionPeriod, Portfolio, Transaction,
    YnabCategory, YnabCategoryMapping, YnabFundingSettings,
} from '../src/types';
import { DEFAULT_YNAB_FUNDING_SETTINGS } from '../src/types';
import {
    buildYnabFundingPlan, isRegisterableOrder, roundUpTo, transferCostFor, YNAB_FUNDING_TX_PREFIX,
} from '../src/utils/ynabFundingPlan';
import { splitPortfolioBudget } from '../src/utils/ynabPortfolioSplit';
import type { Asset } from '../src/types';

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
    // The current account the money is wired from: no commission plan (it trades
    // nothing), a flat fee on what it sends, and a floor it must keep.
    {
        id: 'b-bank', name: 'Conto Corrente', currentLiquidity: 5000,
        minLiquidityType: 'fixed', minLiquidityAmount: 1000,
        transferCost: { type: 'fixed', fixed: 0.95 },
    },
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
// The base fixture names no source account, so every wire also carries
// 'unknown-source' — checked on its own further down.
check('and the earmark is flagged', directa.warnings.includes('earmark-shortfall'), true);

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

console.log('where the money comes from, and what the sender pays');

check('the percent floor applies to a small wire', transferCostFor(brokers[0], 200), 1);
check('and the cap to a large one', transferCostFor(brokers[0], 100000), 5);
check('an account with no transfer cost configured sends for free',
    transferCostFor(brokers.find(b => b.id === 'b-plain'), 5000), 0);
check('nothing wired costs nothing', transferCostFor(brokers[0], 0), 0);

// Every category funded from the current account, by default.
const fromBank = build({ defaultSourceBrokerId: 'b-bank' });
check('each wire names the account it leaves from',
    transferOf(fromBank, 'b-degiro').legs.map(l => l.sourceBrokerName), ['Conto Corrente']);
check('and is priced with THAT account\'s plan, not the destination\'s',
    transferOf(fromBank, 'b-degiro').cost, 0.95);
// A destination holding enough cash needs no wire at all, so nothing leaves.
const covered = build({ defaultSourceBrokerId: 'b-bank' }, {
    brokers: brokers.map(b => b.id === 'b-degiro' ? { ...b, currentLiquidity: 50000 } : b),
});
check('a destination that is already covered is wired nothing, so it has no legs',
    [transferOf(covered, 'b-degiro').transfer, transferOf(covered, 'b-degiro').legs.length], [0, 0]);

const bankRow = fromBank.sources.find(s => s.brokerId === 'b-bank')!;
check('the sending account is summed up across every wire',
    [bankRow.amountOut, bankRow.cost, bankRow.totalOut],
    [
        Math.round(fromBank.transfers.reduce((s, t) => s + t.transfer, 0) * 100) / 100,
        2.85,  // three wires at €0.95
        Math.round((fromBank.transfers.reduce((s, t) => s + t.transfer, 0) + 2.85) * 100) / 100,
    ]);
// €5,000 held less the €1,000 floor it has to keep.
check('its free cash is what is left above its own floor', bankRow.availableCash, 4000);
check('which covers what it is asked to send', [bankRow.warnings, bankRow.remaining > 0], [[], true]);

// The same plan against a thinner balance: the account cannot cover it.
const short = build({ defaultSourceBrokerId: 'b-bank' }, {
    brokers: brokers.map(b => b.id === 'b-bank' ? { ...b, currentLiquidity: 2000 } : b),
});
const shortRow = short.sources.find(s => s.brokerId === 'b-bank')!;
check('an account short of the money is flagged before anything moves',
    [shortRow.availableCash, shortRow.warnings], [1000, ['insufficient']]);
check('and by how much', Math.round(shortRow.remaining * 100) / 100 < 0, true);

// A category can override the default with its own account.
const mixed = build({ defaultSourceBrokerId: 'b-bank' }, {
    mappings: mappings.map(m => m.categoryId === 'c-buffer' ? { ...m, sourceBrokerId: 'b-plain' } : m),
});
check('a category funded elsewhere splits its destination\'s wire in two',
    transferOf(mixed, 'b-tr').legs.map(l => l.sourceBrokerName).sort(),
    ['Banca Semplice', 'Conto Corrente']);
check('and the legs still add up to the wire',
    Math.round(transferOf(mixed, 'b-tr').legs.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    transferOf(mixed, 'b-tr').transfer);
check('each leg paying its own account\'s fee',
    transferOf(mixed, 'b-tr').legs.find(l => l.sourceBrokerId === 'b-plain')!.cost, 0);

// Money already sitting at the destination cannot be wired to itself.
const selfFunded = build({ defaultSourceBrokerId: 'b-degiro' });
check('an account never wires to itself',
    transferOf(selfFunded, 'b-degiro').legs.every(l => l.sourceBrokerId !== 'b-degiro'), true);

const noSource = build();
check('with no account named the wire is flagged rather than priced',
    [transferOf(noSource, 'b-degiro').cost, transferOf(noSource, 'b-degiro').warnings.includes('unknown-source')],
    [0, true]);

const costly = build({ defaultSourceBrokerId: 'b-bank' }, {
    brokers: brokers.map(b => b.id === 'b-bank' ? { ...b, transferCost: { type: 'fixed' as const, fixed: 40 } } : b),
});
check('a wire fee larger than the configured share of itself is flagged',
    transferOf(costly, 'b-tr').warnings.includes('costly-transfer'), true);

check('the totals carry the wire fees separately from the wires',
    [fromBank.totals.transfer, fromBank.totals.transferCost],
    [fromBank.transfers.reduce((s, t) => s + t.transfer, 0), 2.85]);

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

console.log('a portfolio as the destination');

// A 60/40 portfolio holding €6,000 of World and €1,000 of EM: the EM row is the
// underweight one, so a contribution goes mostly there.
const tiltPortfolio: Portfolio = {
    id: 'p-tilt', name: 'Tactical Tilt', order: 3, preferredBrokerId: 'b-degiro',
    allocations: { IE00B4L5Y983: 60, IE00BKM4GZ66: 40 },
};

const tiltAssets: Asset[] = [
    { ticker: 'IE00B4L5Y983', assetClass: 'Stock', quantity: 60, averagePrice: 90, currentPrice: 100, currentValue: 6000 },
    { ticker: 'IE00BKM4GZ66', assetClass: 'Stock', quantity: 32, averagePrice: 30, currentPrice: 31.2, currentValue: 998.4 },
];

const split = splitPortfolioBudget({
    portfolio: tiltPortfolio,
    budget: 1000,
    assets: tiltAssets,
    marketData: prices,
    assetSettings,
});
// Post-contribution total €7,998.40: World wants €4,799.04 (already over it, so
// no gap), EM wants €3,199.36 against €998.40 — the whole €1,000 goes to EM.
check('the money goes to the underweight row', split.lines.map(l => l.ticker), ['IE00BKM4GZ66']);
// Not floored to 32 shares (€998.40) here: rounding happens once, downstream,
// where the commission is known. The row's gap is far larger than €1,000, so it
// takes all of it.
check('the row is handed the whole contribution, unrounded', split.lines[0].eur, 1000);
check('leaving nothing behind for the orders to miss', split.leftover, 0);

const onTarget = splitPortfolioBudget({
    portfolio: { ...tiltPortfolio, allocations: { IE00B4L5Y983: 100 } },
    budget: 100,
    assets: [tiltAssets[0]],
    marketData: prices,
    assetSettings,
});
// A single 100% row always has a gap once the money joins the pie, so being
// "on target" only happens when a row is genuinely overweight.
check('a lone row still absorbs the contribution', onTarget.lines.length, 1);

// A row never takes more than its own gap, however much money arrives.
const overflowing = splitPortfolioBudget({
    portfolio: { ...tiltPortfolio, allocations: { IE00BKM4GZ66: 10, IE00B4L5Y983: 90 } },
    budget: 100000,
    assets: tiltAssets,
    marketData: prices,
    assetSettings,
});
const emLine = overflowing.lines.find(l => l.ticker === 'IE00BKM4GZ66');
// EM's target is 10% of €106,998.40 = €10,699.84, against €998.40 held.
check('a row is never handed more than its gap',
    Math.round((emLine?.eur ?? 0) * 100) / 100 <= 9701.44 + 0.01, true);
check('and what no row can absorb stays uninvested',
    Math.round((overflowing.leftover + overflowing.lines.reduce((s, l) => s + l.eur, 0)) * 100) / 100,
    100000);

const noTargets = splitPortfolioBudget({
    portfolio: { id: 'p-none', name: 'No targets', order: 9 },
    budget: 500, assets: [], marketData: prices, assetSettings,
});
check('a portfolio with no targets places nothing and says so',
    [noTargets.lines.length, noTargets.leftover, noTargets.reason], [0, 500, 'no-targets']);

// Holdings with no price of their own and nothing in market data: the rows
// exist but nothing can be sized against them.
const pricelessSplit = splitPortfolioBudget({
    portfolio: tiltPortfolio,
    budget: 500,
    assets: tiltAssets.map(a => ({ ...a, currentPrice: undefined })),
    marketData: {},
    assetSettings,
});
check('rows with no price cannot receive the money',
    [pricelessSplit.lines.length, pricelessSplit.reason], [0, 'no-price']);

// An amount-mode portfolio targets € figures instead of weights, and fills them
// in whole bond lots.
const ladderSplit = splitPortfolioBudget({
    portfolio: {
        id: 'p-ladder', name: 'Goal Ladder', order: 4, targetMode: 'amount',
        amountTargets: { IT0005534141: 3000 },
    },
    budget: 1500,
    assets: [],
    marketData: prices,
    assetSettings,
});
check('an amount-mode portfolio buys toward its € target in whole lots',
    [ladderSplit.lines.map(l => l.ticker), ladderSplit.lines[0].eur], [['IT0005534141'], 998]);
check('what a second lot would have needed stays uninvested', ladderSplit.leftover, 502);

// The same portfolio, reached through a category mapped to it. The plan reads
// the portfolio's holdings from its own transactions, so the fixture states
// them as trades rather than as an assets array.
const tiltTransactions: Transaction[] = [
    { id: 'tt1', ticker: 'IE00B4L5Y983', amount: 60, price: 90, date: '2026-02-01', direction: 'Buy', brokerId: 'b-degiro', portfolioId: 'p-tilt' },
    { id: 'tt2', ticker: 'IE00BKM4GZ66', amount: 32, price: 30, date: '2026-02-01', direction: 'Buy', brokerId: 'b-degiro', portfolioId: 'p-tilt' },
];

const viaPortfolio = build({}, {
    portfolios: [...portfolios, tiltPortfolio],
    categories: [cat('c-tilt', 'Tilt top-up', 1000)],
    mappings: [{ categoryId: 'c-tilt', target: { kind: 'portfolio', portfolioId: 'p-tilt' } }],
    transactions: tiltTransactions,
});
check('the split becomes an ordinary order', viaPortfolio.orders.length, 1);
check('booked in the portfolio that was funded',
    [orderOf(viaPortfolio, 'IE00BKM4GZ66').portfolioId, orderOf(viaPortfolio, 'IE00BKM4GZ66').brokerId],
    ['p-tilt', 'b-degiro']);
check('the source says which portfolio split it',
    orderOf(viaPortfolio, 'IE00BKM4GZ66').sources[0].viaPortfolio, 'Tactical Tilt');
// The split hands the order the full €1,000; Degiro's €2.50 flat fee comes out
// of the same money, so 31 shares of €31.20 fit.
check('the order is then sized with its commission like any other',
    [orderOf(viaPortfolio, 'IE00BKM4GZ66').quantity, orderOf(viaPortfolio, 'IE00BKM4GZ66').commission],
    [31, 2.5]);
check('with the whole contribution placed, nothing is reported as unplaced',
    viaPortfolio.ignored.length, 0);
check('and it still adds up: gross + commission + leftover = the budget',
    Math.round((viaPortfolio.totals.gross + viaPortfolio.totals.commission + viaPortfolio.totals.leftover) * 100) / 100,
    viaPortfolio.totals.budget);

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
