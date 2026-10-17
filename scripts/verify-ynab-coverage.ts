// Known-answer checks for the YNAB coverage check: where each category's money
// sits, the per-account shortfall and recommended minimum, the emergency fund
// and the progress of dated goals.
// Run with: npx esbuild scripts/verify-ynab-coverage.ts --bundle --format=esm | node --input-type=module
import type { Broker, YnabCategory, YnabCategoryMapping, YnabGoal, YnabGoalAllocation, YnabMacroMappings } from '../src/types';
import { averageSpentFromHistory, buildCoverageReport, monthsUntil } from '../src/utils/ynabCoverage';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
};

const TODAY = '2026-09-24';
const cat = (id: string, groupId: string, name: string, available: number, avgSpent: number, extra: Partial<YnabCategory> = {}): YnabCategory => ({
    id, groupId, groupName: groupId, name,
    balanceMilliunits: available * 1000,
    budgetedMilliunits: 0,
    avgSpentMilliunits: avgSpent * 1000,
    spentMonthsCount: 12,
    ...extra,
});

const categories: YnabCategory[] = [
    cat('rent', 'housing', 'Rent', 0, 900),
    cat('utilities', 'housing', 'Utilities', 150, 140),
    cat('groceries', 'food', 'Groceries', 300, 400),
    cat('dining', 'food', 'Dining out', 100, 150),
    cat('emergency', 'savings', 'Emergency Fund', 8000, 0),
    // Goal read off the name: 3000€ by 2026-11 — due within the 3-month horizon.
    cat('car', 'savings', 'Car service - 3000€ - 2026-11', 1000, 0),
    // Goal stored in YNAB Goals, partly invested.
    cat('house', 'savings', 'House', 5000, 0),
    // No account, no default: its money is unlocated.
    cat('gift', 'misc', 'Gifts', 200, 50),
];

const macroMappings: YnabMacroMappings = {
    groups: { housing: 'structural', food: 'variable', savings: 'sinking' },
    categories: { dining: 'compressible' },
};

const brokers: Broker[] = [
    { id: 'current', name: 'Current account', currentLiquidity: 1000, minLiquidityType: 'fixed', minLiquidityAmount: 500 } as Broker,
    { id: 'savings', name: 'Savings account', currentLiquidity: 15000 } as Broker,
];

const mappings: YnabCategoryMapping[] = [
    { categoryId: 'rent', target: { kind: 'unmapped' }, sourceBrokerId: 'current' },
    { categoryId: 'utilities', target: { kind: 'unmapped' }, sourceBrokerId: 'current' },
    { categoryId: 'groceries', target: { kind: 'unmapped' }, sourceBrokerId: 'current' },
    { categoryId: 'dining', target: { kind: 'unmapped' }, sourceBrokerId: 'current' },
    { categoryId: 'emergency', target: { kind: 'unmapped' }, sourceBrokerId: 'savings', emergencyFund: true },
    { categoryId: 'car', target: { kind: 'unmapped' }, sourceBrokerId: 'current' },
    { categoryId: 'house', target: { kind: 'unmapped' }, sourceBrokerId: 'savings' },
];

const goals: YnabGoal[] = [{
    id: 'house', ynabBudgetId: 'b', name: 'House', targetAmount: 20000, targetDate: '2028-09-01',
    cashCoverage: 5000, targetSource: 'manual-override', lastSyncedAt: TODAY,
}];
const allocations: YnabGoalAllocation[] = [
    { id: 'a1', portfolioId: 'p', ynabGoalId: 'house', amount: 6000, createdAt: TODAY, updatedAt: TODAY },
    { id: 'a2', portfolioId: 'p', ynabGoalId: 'emergency', amount: 2000, createdAt: TODAY, updatedAt: TODAY },
];

const report = buildCoverageReport({
    categories, mappings, macroMappings, brokers, goals, allocations,
    settings: { emergencyMonths: 6, workingCapitalMonths: 1, goalHorizonMonths: 3 },
    today: TODAY,
});
const account = (id: string) => report.accounts.find(a => a.brokerId === id)!;
const goal = (id: string) => report.goals.find(g => g.categoryId === id)!;

console.log('positions');
check('a category override wins over its group', report.positions.find(p => p.categoryId === 'dining')!.nature, 'compressible');
check('and the group nature is flagged as inherited',
    report.positions.find(p => p.categoryId === 'groceries')!.natureFromGroup, true);
check('invested money is the goal allocations', report.positions.find(p => p.categoryId === 'house')!.invested, 6000);

console.log('accounts');
// Current account: 150 + 300 + 100 + 1000 = 1,550 of Available on 1,000 of liquidity.
check('an account short of its categories says how much to deposit',
    [account('current').required, account('current').shortfall, account('current').surplus], [1550, 550, 0]);
check('a covered account shows what is left unclaimed',
    [account('savings').required, account('savings').shortfall, account('savings').surplus], [13000, 0, 2000]);
// 900 + 140 + 400 + 150 of day-to-day spending, plus the car service due in
// two months (3,000, nothing invested) that must already be cash.
check('working capital: a month of day-to-day spending plus goals due soon',
    [account('current').monthlySpend, account('current').dueGoals, account('current').recommendedMin], [1590, 3000, 4590]);
check('next to the minimum configured on the broker', account('current').configuredMin, 500);
check('a category on no account is reported as unlocated', report.unlocated, { amount: 200, categoryIds: ['gift'] });

const withDefault = buildCoverageReport({
    categories, mappings, macroMappings, brokers, goals, allocations,
    defaultSourceBrokerId: 'current',
    settings: { emergencyMonths: 6, workingCapitalMonths: 1, goalHorizonMonths: 3 },
    today: TODAY,
});
check('the default account takes the categories that name none',
    [withDefault.unlocated.amount, withDefault.accounts.find(a => a.brokerId === 'current')!.required], [0, 1750]);

console.log('emergency fund');
// Fixed spending = rent 900 + utilities 140 = 1,040/month; 6 months = 6,240.
check('the target is N months of structural spending',
    [report.emergency.fixedMonthly, report.emergency.target], [1040, 6240]);
check('the fund counts its cash and its invested money',
    [report.emergency.cash, report.emergency.invested, report.emergency.current, report.emergency.gap], [8000, 2000, 10000, 0]);
check('and says how many months it covers', report.emergency.monthsCovered, 9.6);
check('the fund is not listed among the goals', report.goals.some(g => g.categoryId === 'emergency'), false);

console.log('emergency fund from groups and portfolios');
const fundWide = buildCoverageReport({
    categories, mappings, macroMappings, brokers, goals, allocations,
    settings: { emergencyMonths: 6, workingCapitalMonths: 1, goalHorizonMonths: 3, emergencyGroupIds: ['misc'], emergencyPortfolioIds: ['p'] },
    portfolioValueOf: id => (id === 'p' ? 10000 : 0),
    today: TODAY,
});
// Cash: Emergency 8,000 + Gifts 200 (its whole group is fund). Portfolio p: 10,000.
// The Emergency category's 2,000 invested in p is inside p's value: not twice.
check('a group puts every category of it in the fund',
    [fundWide.emergency.categoryIds, fundWide.emergency.flaggedCategoryIds, fundWide.emergency.groupIds], [['emergency', 'gift'], ['emergency'], ['misc']]);
check('a portfolio counts with its whole value, without double-counting the fund investments',
    [fundWide.emergency.cash, fundWide.emergency.invested, fundWide.emergency.fromPortfolios, fundWide.emergency.current], [8200, 0, 10000, 18200]);

console.log('goals');
check('a goal parsed from the category name', [goal('car').target, goal('car').date, goal('car').source], [3000, '2026-11-30', 'category']);
check('due within the horizon', [goal('car').status, goal('car').gap, goal('car').requiredMonthly], ['due-soon', 2000, 1000]);
check('a stored goal counts cash and investments',
    [goal('house').covered, goal('house').gap, goal('house').progress, goal('house').status], [11000, 9000, 0.55, 'on-track']);
check('months left to the date', goal('house').monthsLeft, 24);
check('goals come nearest date first', report.goals.map(g => g.categoryId), ['car', 'house']);

console.log('working capital flow');
// Three months of history on the current account's day-to-day categories:
// out 1,590 / 1,800 / 1,380 (avg 1,590, worst 1,800), all assigned in the month.
const month = (m: string, spent: Record<string, number>) => ({
    month: m,
    categories: Object.entries(spent).map(([categoryId, v]) => ({ categoryId, activityMilliunits: -v * 1000, budgetedMilliunits: v * 1000 })),
});
const history = [
    month('2026-06-01', { rent: 900, utilities: 140, groceries: 400, dining: 150, car: 0 }),
    month('2026-07-01', { rent: 900, utilities: 200, groceries: 500, dining: 200 }),
    month('2026-08-01', { rent: 900, utilities: 80, groceries: 300, dining: 100 }),
];
const flowReport = buildCoverageReport({
    categories, mappings, macroMappings, brokers, goals, allocations, history,
    settings: { emergencyMonths: 6, workingCapitalMonths: 1, goalHorizonMonths: 3 },
    today: TODAY,
});
const cur = flowReport.accounts.find(a => a.brokerId === 'current')!;
check('average in / out and the worst month', [cur.flowMonths, cur.avgIn, cur.avgOut, cur.peakOut], [3, 1590, 1590, 1800]);
check('operating cash = a month of average plus the swing of the worst', cur.operatingCash, 1800);
check('cash set aside for other purposes (the car service)', cur.earmarked, 1000);
check('free = liquidity − operating cash − set aside', cur.free, -1800);
check('suggested minimum = operating cash + goals due soon', cur.recommendedMin, 4800);
check('emergency-fund cash is told apart per account',
    flowReport.accounts.find(a => a.brokerId === 'savings')!.emergencyHere, 8000);

console.log('planned capex due soon');
// A boiler due next month: 2,000, 500 in cash, 1,200 invested — bring 1,200
// back, 300 still missing. The car service has nothing invested: 2,000 missing.
const withBoiler = buildCoverageReport({
    categories: [...categories, cat('boiler', 'savings', 'Boiler', 500, 0)],
    mappings: [...mappings, { categoryId: 'boiler', target: { kind: 'unmapped' }, sourceBrokerId: 'savings' }],
    macroMappings, brokers,
    goals: [...goals, { id: 'boiler', ynabBudgetId: 'b', name: 'Boiler', targetAmount: 2000, targetDate: '2026-10-31',
        cashCoverage: 500, targetSource: 'manual-override', lastSyncedAt: TODAY }],
    allocations: [...allocations, { id: 'a3', portfolioId: 'p', ynabGoalId: 'boiler', amount: 1200, createdAt: TODAY, updatedAt: TODAY }],
    settings: { emergencyMonths: 6, workingCapitalMonths: 1, goalHorizonMonths: 3 },
    today: TODAY,
});
check('due within the horizon, nearest first', withBoiler.upcoming.map(u => u.categoryId), ['boiler', 'car']);
const boiler = withBoiler.upcoming[0];
check('what to bring back from investments and what is still missing', [boiler.toRecover, boiler.stillMissing, boiler.brokerId], [1200, 300, 'savings']);
check('the car service has nothing to bring back', [withBoiler.upcoming[1].toRecover, withBoiler.upcoming[1].stillMissing], [0, 2000]);
check('a goal beyond the horizon is not listed', withBoiler.upcoming.some(u => u.categoryId === 'house'), false);
const covered = buildCoverageReport({
    categories: [...categories, cat('tv', 'savings', 'TV', 900, 0)],
    mappings: [...mappings, { categoryId: 'tv', target: { kind: 'unmapped' }, sourceBrokerId: 'current' }],
    macroMappings, brokers,
    goals: [...goals, { id: 'tv', ynabBudgetId: 'b', name: 'TV', targetAmount: 800, targetDate: '2026-10-15',
        cashCoverage: 900, targetSource: 'manual-override', lastSyncedAt: TODAY }],
    allocations,
    settings: { emergencyMonths: 6, workingCapitalMonths: 1, goalHorizonMonths: 3 },
    today: TODAY,
});
const tv = covered.upcoming.find(u => u.categoryId === 'tv')!;
check('a capex already covered by cash is listed, needing nothing', [tv.toRecover, tv.stillMissing], [0, 0]);
check('each account sums what comes back to it',
    withBoiler.accounts.find(a => a.brokerId === 'savings')!.capexToRecover, 1200);
// After paying: savings 15,000 + 1,200 back − 2,000 = 14,200 against 13,000 that
// stays set aside (fund 8,000 + house 5,000) → in line with 1,200 spare.
check('an account still in line after the capex',
    withBoiler.accounts.find(a => a.brokerId === 'savings')!.afterCapex, { pay: 2000, recover: 1200, liquidityAfter: 14200, needAfter: 13000, topUp: 0, spare: 1200 });
// Current: 1,000 − 3,000 = −2,000 against 1,590 of operating cash → top up 3,590.
check('an account that needs a top-up after the capex',
    withBoiler.accounts.find(a => a.brokerId === 'current')!.afterCapex, { pay: 3000, recover: 0, liquidityAfter: -2000, needAfter: 1590, topUp: 3590, spare: 0 });
check('no projection on an account with no capex due',
    report.accounts.find(a => a.brokerId === 'savings')!.afterCapex, undefined);

console.log('totals and helpers');
check('available total', report.totals.available, 14750);
check('spending by nature', report.totals.spentByNature, { structural: 1040, variable: 400, compressible: 150, sinking: 0, unassigned: 50 });
check('months between dates', [monthsUntil('2026-09-24', '2026-11-01'), monthsUntil('2026-09-24', '2026-08-01')], [2, -1]);
check('history fallback averages outflows per category',
    [...averageSpentFromHistory([
        { categories: [{ categoryId: 'x', activityMilliunits: -100000 }] },
        { categories: [{ categoryId: 'x', activityMilliunits: -200000 }] },
    ])], [['x', { avg: 150, months: 2 }]]);

if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll checks passed');
