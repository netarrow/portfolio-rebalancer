// Known-answer checks for the off-budget map: goal shares carved out of the
// holdings, portfolios merged parent + children, type A/B brokers, the
// migration out of each broker account, latent tax and the warnings.
// Every name and figure below is invented.
// Run with: npx esbuild scripts/verify-ynab-tracking-plan.ts --bundle --format=esm | node --input-type=module
import type { AssetDefinition, Broker, Portfolio, Transaction, YnabGoal, YnabGoalAllocation, YnabTrackingConfig } from '../src/types';
import { buildTrackingPlan, normalizeYnabTrackingConfig, withEntry, type TrackingAccountRef, type TrackingPlanInput } from '../src/utils/ynabTrackingPlan';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
};

// Brokers: A has an on-budget account for its cash; B keeps cash and
// securities together off budget; a pension fund; a family member's PAC.
const brokers: Broker[] = [
    { id: 'bank', name: 'Alpha Bank', currentLiquidity: 4000 },
    { id: 'fin', name: 'Beta Broker', currentLiquidity: 1000 },
    { id: 'pens', name: 'Gamma Pension', illiquid: true },
    { id: 'kid', name: 'Kid Broker', familyAsset: true },
];

const portfolios: Portfolio[] = [
    { id: 'growth', name: 'Growth', order: 0 },
    { id: 'sat', name: 'Satellite', parentId: 'growth', order: 1 },
    { id: 'safe', name: 'Safe', order: 2 },
    { id: 'pension', name: 'Pension', order: 3 },
    { id: 'kidpac', name: 'Kid PAC', order: 4 },
];

const assetSettings: AssetDefinition[] = [
    { ticker: 'WORLD', label: 'World ETF', assetClass: 'Stock' },
    { ticker: 'SATX', label: 'Satellite ETF', assetClass: 'Stock' },
    { ticker: 'GOVB', label: 'Gov Bond', assetClass: 'Bond' },
    { ticker: 'PFUND', label: 'Pension Fund', assetClass: 'PensionFund' },
    { ticker: 'KIDX', label: 'Kid ETF', assetClass: 'Stock' },
];

let n = 0;
const buy = (portfolioId: string, brokerId: string, ticker: string, amount: number, price: number): Transaction =>
    ({ id: `t${n++}`, portfolioId, brokerId, ticker, amount, price, date: '2025-01-15', direction: 'Buy' });

const transactions: Transaction[] = [
    buy('growth', 'bank', 'WORLD', 100, 80),   // now 12,000 (cost 8,000)
    buy('growth', 'fin', 'WORLD', 50, 100),    // now  6,000 (cost 5,000)
    buy('sat', 'fin', 'SATX', 10, 100),        // now    900 (cost 1,000)
    buy('safe', 'fin', 'GOVB', 50, 100),       // now  5,000 (cost 5,000)
    buy('pension', 'pens', 'PFUND', 100, 20),  // now  2,500 (cost 2,000)
    buy('kidpac', 'kid', 'KIDX', 10, 50),      // now    600, family: out
];

const marketData = Object.fromEntries(
    Object.entries({ WORLD: 120, SATX: 90, GOVB: 100, PFUND: 25, KIDX: 60 })
        .map(([t, price]) => [t, { price, lastUpdated: '2026-10-01' }]),
);

const goal = (id: string, name: string): YnabGoal =>
    ({ id, ynabBudgetId: 'budget', name, cashCoverage: 0, targetSource: 'parsed-name', lastSyncedAt: '2026-10-01' });
const goals: YnabGoal[] = [
    goal('g-bath', 'Bathroom'),
    goal('g-car', 'Car'),
    goal('g-tent', 'Awning'),
    goal('g-over', 'Too much'),
    goal('g-kid', 'Kid share'),
    { ...goal('g-old', 'Archived'), archived: true },
];

const alloc = (id: string, ynabGoalId: string, portfolioId: string, amount: number, ticker?: string): YnabGoalAllocation =>
    ({ id, ynabGoalId, portfolioId, amount, ...(ticker ? { ticker } : {}), createdAt: '2026-01-01', updatedAt: '2026-01-01' });
const allocations: YnabGoalAllocation[] = [
    alloc('a1', 'g-bath', 'growth', 3000, 'WORLD'), // split 2:1 between the two brokers holding WORLD
    alloc('a2', 'g-car', 'safe', 2000),             // whole portfolio
    alloc('a3', 'g-tent', 'growth', 500, 'GOVB'),   // Growth holds no GOVB: unbacked
    alloc('a4', 'g-over', 'sat', 1500, 'SATX'),     // asks 1,500 of a 900 holding
    alloc('a5', 'g-kid', 'kidpac', 300),            // sits at an excluded broker
    alloc('a6', 'g-old', 'growth', 999),            // archived goal: ignored
];

const accounts: TrackingAccountRef[] = [
    { id: 'acc-bank-inv', name: 'Alpha Investments', onBudget: false, balance: 12000, clearedBalance: 12000 },
    { id: 'acc-fin', name: 'Beta Investments', onBudget: false, balance: 12500, clearedBalance: 12500 },
    { id: 'acc-pens', name: 'Gamma', onBudget: false, balance: 2400, clearedBalance: 2400 },
    { id: 'acc-checking', name: 'Alpha Checking', onBudget: true, balance: 4000, clearedBalance: 4000 },
    { id: 'acc-bath', name: '🎯 Bathroom', onBudget: false, balance: 0, clearedBalance: 0 },
];

const config: YnabTrackingConfig = {
    brokerSources: { bank: 'acc-bank-inv', fin: 'acc-fin', pens: 'acc-pens' },
    destinationAccounts: {
        'goal:g-bath': 'acc-bath',
        'goal:g-car': 'acc-checking',        // on budget: must be flagged
        'cash:fin': 'acc-fin',               // the broker account keeps its cash
        'portfolio:pension': 'acc-pens',     // the pension account stays as it is
    },
};

const base: TrackingPlanInput = {
    portfolios, transactions, brokers, assetSettings, marketData, goals, allocations,
    virtualBonds: [],
    liquidityMappings: { bank: { budgetId: 'budget', accountId: 'acc-checking' } },
    config,
    accounts,
};

const plan = buildTrackingPlan(base);
const dest = (key: string) => plan.destinations.find(d => d.key === key);
const broker = (id: string) => plan.brokers.find(b => b.brokerId === id);
const migration = (id: string) => plan.migrations.find(m => m.brokerId === id);

console.log('Brokers');
check('A/B kinds', plan.brokers.map(b => [b.brokerId, b.kind, b.included]), [
    ['bank', 'A', true], ['fin', 'B', true], ['pens', 'B', true], ['kid', 'B', false],
]);
check('family broker excluded by default', broker('kid')?.excludedBy, 'family');
check('type A: securities only', [broker('bank')?.securities, broker('bank')?.cash, broker('bank')?.expected], [12000, 0, 12000]);
check('type B: securities + cash', [broker('fin')?.securities, broker('fin')?.cash, broker('fin')?.expected], [11900, 1000, 12900]);
check('realignment = expected − YNAB balance', [broker('bank')?.realignment, broker('fin')?.realignment, broker('pens')?.realignment], [0, 400, 100]);

console.log('Goal accounts');
check('goal pinned to an asset: split by broker value', dest('goal:g-bath')?.pieces.map(p => [p.brokerId, Math.round(p.value)]), [['bank', 2000], ['fin', 1000]]);
check('goal pinned to an asset: units follow the price', dest('goal:g-bath')?.pieces.map(p => Math.round(p.quantity * 100) / 100), [16.67, 8.33]);
check('goal latent tax at 26% on its share of the gain', dest('goal:g-bath')?.latentTax, 216.67);
check('goal net = gross − latent tax', dest('goal:g-bath')?.net, 2783.33);
check('goal on a whole portfolio', [dest('goal:g-car')?.value, dest('goal:g-car')?.latentTax], [2000, 0]);
check('over-allocated claim capped at the holding', dest('goal:g-over')?.value, 900);
check('unbacked goal gets no account', dest('goal:g-tent'), undefined);
check('excluded-broker goal gets no account', dest('goal:g-kid'), undefined);
check('archived goal ignored', dest('goal:g-old'), undefined);
check('linked goal account balance compared', dest('goal:g-bath')?.accountDifference, 3000);

check('cash staying in the broker account: compared after the split', [dest('cash:fin')?.accountDifference, dest('cash:fin')?.sharesSourceAccount], [400, true]);
check('pension left in place: no outflow, plain comparison', [dest('portfolio:pension')?.accountDifference, dest('portfolio:pension')?.sharesSourceAccount], [100, undefined]);

console.log('Portfolio accounts');
check('parent + child merged, minus goal shares', [dest('portfolio:growth')?.value, dest('portfolio:growth')?.memberNames], [15000, ['Growth', 'Satellite']]);
check('standalone portfolio, minus goal shares', dest('portfolio:safe')?.value, 3000);
check('illiquid-only portfolio reads as pension', [dest('portfolio:pension')?.kind, dest('portfolio:pension')?.accountName, dest('portfolio:pension')?.value], ['pension', '🏦 Pension', 2500]);
check('type B cash account', [dest('cash:fin')?.kind, dest('cash:fin')?.accountName, dest('cash:fin')?.value], ['broker-cash', '💵 Beta Broker', 1000]);
check('account names carry the prefix', [dest('goal:g-bath')?.accountName, dest('portfolio:growth')?.accountName], ['🎯 Bathroom', '💼 Growth']);
check('destination order: goals, portfolios, pension, cash', plan.destinations.map(d => d.kind), ['goal', 'goal', 'goal', 'portfolio', 'portfolio', 'pension', 'broker-cash']);

console.log('Totals');
check('securities and cash of included brokers', plan.totals, { securities: 26400, cash: 1000, destinations: 27400 });
check('balanced', plan.balanced, true);

console.log('Migration');
check('type A broker', migration('bank')?.transfers.map(t => [t.toKey, t.amount, t.staysInPlace]), [
    ['portfolio:growth', 10000, false], ['goal:g-bath', 2000, false],
]);
check('type B broker: cash stays in place', migration('fin')?.transfers.map(t => [t.toKey, t.amount, t.staysInPlace]), [
    ['portfolio:growth', 5000, false], ['portfolio:safe', 3000, false], ['goal:g-car', 2000, false],
    ['goal:g-bath', 1000, false], ['cash:fin', 1000, true], ['goal:g-over', 900, false],
]);
check('migration total = broker expected', migration('fin')?.total, 12900);
check('pension account stays as it is', migration('pens')?.transfers.map(t => [t.toKey, t.staysInPlace]), [['portfolio:pension', true]]);
check('excluded broker not migrated', migration('kid'), undefined);

console.log('Warnings');
const kinds = plan.warnings.map(w => w.kind).sort();
check('warning kinds', kinds, ['account-on-budget', 'excluded-broker-claim', 'over-allocated', 'unbacked-allocation']);

console.log('Inclusion overrides');
const forced = buildTrackingPlan({ ...base, config: { ...config, brokerInclusion: { kid: true, pens: false } } });
check('family broker forced in, pension forced out', forced.brokers.map(b => [b.brokerId, b.included, b.excludedBy ?? null]), [
    ['bank', true, null], ['fin', true, null], ['kid', true, null], ['pens', false, 'manual'],
]);
check('forced-in family broker adds its goal and a missing-source warning', [
    forced.destinations.find(d => d.key === 'goal:g-kid')?.value,
    forced.warnings.some(w => w.kind === 'missing-source'),
], [300, true]);
check('still balanced', forced.balanced, true);

console.log('Without YNAB accounts loaded');
const offline = buildTrackingPlan({ ...base, accounts: undefined });
check('no balance comparison, no account warnings', [
    offline.brokers.every(b => b.realignment === undefined),
    offline.warnings.some(w => w.kind === 'account-on-budget' || w.kind === 'account-missing'),
], [true, false]);

console.log('Reused account');
const reused = buildTrackingPlan({ ...base, config: { ...config, destinationAccounts: { ...config.destinationAccounts, 'portfolio:safe': 'acc-bath' } } });
check('one account for two destinations is flagged', reused.warnings.some(w => w.kind === 'account-reused'), true);

console.log('Stored config');
check('malformed entries are dropped', normalizeYnabTrackingConfig({
    brokerSources: { fin: 'acc-fin', bad: 42, '': 'x' },
    destinationAccounts: 'nope',
    brokerInclusion: { kid: true, pens: 'yes' },
}), { brokerSources: { fin: 'acc-fin' }, destinationAccounts: {}, brokerInclusion: { kid: true } });
check('nothing stored', normalizeYnabTrackingConfig(undefined), { brokerSources: {}, destinationAccounts: {} });
check('withEntry sets and clears', [withEntry({ a: '1' }, 'b', '2'), withEntry({ a: '1' }, 'a', null)], [{ a: '1', b: '2' }, {}]);

if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll checks passed');
