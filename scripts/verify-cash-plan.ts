// Known-answer checks for the cash plan: the layers of each account, the cash
// to hold (the broker minimum), the liquidity target and the moves crossing
// what to keep, what to move and what to cover. Invented figures only.
// Run with: npx esbuild scripts/verify-cash-plan.ts --bundle --format=esm | node --input-type=module
import type { Broker, YnabCategory, YnabCategoryMapping, YnabGoal, YnabGoalAllocation, YnabMacroMappings } from '../src/types';
import { buildCoverageReport } from '../src/utils/ynabCoverage';
import { buildCashPlan, type CashLayerKind } from '../src/utils/cashPlan';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
};

const TODAY = '2026-09-24';
const cat = (id: string, groupId: string, name: string, available: number, avgSpent: number): YnabCategory => ({
    id, groupId, groupName: groupId, name,
    balanceMilliunits: available * 1000, budgetedMilliunits: 0, avgSpentMilliunits: avgSpent * 1000, spentMonthsCount: 12,
});

const categories: YnabCategory[] = [
    cat('rent', 'housing', 'Rent', 0, 900),
    cat('utilities', 'housing', 'Utilities', 150, 140),
    cat('groceries', 'food', 'Groceries', 300, 400),
    cat('dining', 'food', 'Dining out', 100, 150),
    // Due in two months, nothing invested: 1,000 of cash on 3,000.
    cat('car', 'savings', 'Car service - 3000€ - 2026-11', 1000, 0),
    cat('emergency', 'savings', 'Emergency Fund', 8000, 0),
    // A planned capex two years out, partly invested in portfolio p.
    cat('house', 'savings', 'House', 5000, 0),
    // A sinking fund with no planned capex behind it: it stays cash.
    cat('holiday', 'savings', 'Holiday', 700, 0),
    cat('etf', 'invest', 'ETF savings plan', 400, 0),
];
const macroMappings: YnabMacroMappings = {
    groups: { housing: 'structural', food: 'variable', savings: 'sinking', invest: 'investments' },
    categories: { dining: 'compressible' },
};
const brokers: Broker[] = [
    { id: 'current', name: 'Current account', currentLiquidity: 1000 } as Broker,
    { id: 'savings', name: 'Savings account', currentLiquidity: 15000 } as Broker,
];
const on = (categoryId: string, sourceBrokerId: string, emergencyFund = false): YnabCategoryMapping =>
    ({ categoryId, target: { kind: 'unmapped' }, sourceBrokerId, ...(emergencyFund ? { emergencyFund } : {}) });
const mappings: YnabCategoryMapping[] = [
    on('rent', 'current'), on('utilities', 'current'), on('groceries', 'current'), on('dining', 'current'), on('car', 'current'),
    on('emergency', 'savings', true), on('house', 'savings'), on('holiday', 'savings'), on('etf', 'savings'),
];
const goals: YnabGoal[] = [{
    id: 'house', ynabBudgetId: 'b', name: 'House', targetAmount: 20000, targetDate: '2028-09-01',
    cashCoverage: 5000, targetSource: 'manual-override', lastSyncedAt: TODAY,
}];
const allocations: YnabGoalAllocation[] = [
    { id: 'a1', portfolioId: 'p', ynabGoalId: 'house', amount: 6000, createdAt: TODAY, updatedAt: TODAY },
];

const report = buildCoverageReport({
    categories, mappings, macroMappings, brokers, goals, allocations,
    settings: { emergencyMonths: 6, workingCapitalMonths: 1, goalHorizonMonths: 3 },
    today: TODAY,
});
const activeGoalIds = new Set(goals.map(g => g.id));
const plan = buildCashPlan({ report, fundPortfolioIds: [], activeGoalIds });
const account = (p: typeof plan, id: string) => p.accounts.find(a => a.brokerId === id)!;
const layer = (p: typeof plan, id: string, kind: CashLayerKind) => account(p, id).layers.find(l => l.kind === kind)!;
const asked = (p: typeof plan, id: string) => account(p, id).layers.map(l => l.amount);

console.log('layers');
// Current: a month of day-to-day (900 + 140 + 400 + 150) and the car's cash.
check('day-to-day money, then the cash of the capex due soon', asked(plan, 'current'), [1590, 1000, 0, 0, 0, 0]);
// Savings: holiday stays, the fund is held (no fund portfolio), house + ETF wait to leave.
check('set aside, emergency fund, in transit, and what is left free', asked(plan, 'savings'), [0, 0, 700, 8000, 5400, 900]);
check('the liquidity fills the layers in order', account(plan, 'current').layers.map(l => l.covered), [1000, 0, 0, 0, 0, 0]);
check('every euro of an account is in exactly one layer',
    ['current', 'savings'].map(id => account(plan, id).layers.reduce((s, l) => s + l.covered, 0)), [1000, 15000]);
check('cash bound for a portfolio names it',
    layer(plan, 'savings', 'in-transit').items.map(i => [i.id, i.reason, i.portfolioIds]),
    [['house', 'capex', ['p']], ['etf', 'invest', []]]);

console.log('to hold');
check('the hold is layers 1–4', [account(plan, 'current').hold, account(plan, 'savings').hold], [2590, 8700]);
check('short, movable and free', [account(plan, 'current').short, account(plan, 'savings').movable, account(plan, 'savings').free], [1590, 6300, 900]);
// Without anything in transit the hold is what the coverage report already called "to hold".
check('equal to liquidity − free of the coverage report when nothing is in transit',
    account(plan, 'current').hold, report.accounts.find(a => a.brokerId === 'current')!.liquidity - report.accounts.find(a => a.brokerId === 'current')!.free);

console.log('liquidity target');
// 2,590 + 8,700 to hold, plus the 2,000 the car still lacks.
check('hold over every account plus the cash still to come in', [plan.totals.hold, plan.incoming, plan.target], [11290, 2000, 13290]);
check('totals per layer', plan.totals.byLayer, { operating: 1590, 'due-capex': 1000, 'set-aside': 700, emergency: 8000, 'in-transit': 5400, free: 900 });

console.log('moves');
check('free cash tops up the short account before anything is raised, and is not proposed for investing',
    plan.moves.map(m => [m.kind, m.amount, m.fromBrokerId ?? null, m.toBrokerId ?? null]),
    [
        ['wire', 900, 'savings', 'current'],
        ['raise', 1100, null, 'current'],
        ['raise', 1590, null, 'current'],
        ['place', 5000, 'savings', null],
        ['place', 400, 'savings', null],
    ]);

console.log('emergency fund with a fund portfolio');
const withFund = buildCashPlan({ report, fundPortfolioIds: ['fund'], activeGoalIds });
check('its cash is in transit to the fund, not held', asked(withFund, 'savings'), [0, 0, 700, 0, 13400, 900]);
check('and leaves the hold and the target', [account(withFund, 'savings').hold, withFund.target], [700, 5290]);
check('bound for the fund portfolios',
    layer(withFund, 'savings', 'in-transit').items.find(i => i.id === 'emergency'), { id: 'emergency', name: 'Emergency Fund', amount: 8000, reason: 'fund', portfolioIds: ['fund'] });

console.log('with the capex routing of Expense Planning');
const routed = buildCashPlan({
    report, fundPortfolioIds: [], activeGoalIds,
    capexLiquidity: [
        // The ladder frees 500 in time; 1,500 is not there.
        { goalId: 'car', name: 'Car service', amount: 3000, cash: 1000, divest: 500, missing: 1500, reason: 'due-soon' },
        // A capex whose category sits on no account: its cash still counts.
        { goalId: 'boat', name: 'Boat', amount: 300, cash: 300, divest: 0, reason: 'not-invested' },
    ],
});
check('what comes back, what is missing and unlocated capex cash enter the target',
    [routed.incoming, routed.unlocatedCapexCash, routed.target], [2000, 300, 13590]);
check('the sale is a move of its own', routed.moves.filter(m => m.kind === 'sell').map(m => [m.amount, m.toBrokerId]), [[500, 'current']]);

console.log('an account in line');
const rich = buildCashPlan({
    report: buildCoverageReport({
        categories, mappings, macroMappings, goals, allocations,
        brokers: [{ id: 'current', name: 'Current account', currentLiquidity: 6000 } as Broker, brokers[1]],
        settings: { emergencyMonths: 6, workingCapitalMonths: 1, goalHorizonMonths: 3 },
        today: TODAY,
    }),
    fundPortfolioIds: [], activeGoalIds,
});
// Current: 6,000 − 2,590 = 3,410 free; the car's missing 2,000 is paid from it, no wire.
check('free cash on the paying account covers its capex without a move, the rest can be invested',
    rich.moves.filter(m => m.kind !== 'place').map(m => [m.kind, m.amount, m.fromBrokerId ?? null]).sort((x, y) => String(x[2]).localeCompare(String(y[2]))),
    [['invest', 1410, 'current'], ['invest', 900, 'savings']]);

if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
