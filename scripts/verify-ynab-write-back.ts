// End-to-end checks of the YNAB write-back engine against an in-memory fake
// YNAB: preview, guard, migration of one broker account, balances afterwards,
// rollback (both sides of every transfer), stale balances and failures.
// Every name and figure below is invented.
// Run with: npx esbuild scripts/verify-ynab-write-back.ts --bundle --format=esm | node --input-type=module
import type { Broker, Portfolio, Transaction, YnabGoal, YnabGoalAllocation, YnabGoalQuote, YnabTrackingConfig, YnabWriteLogEntry } from '../src/types';
import type { YnabAccountSummary, YnabNewTransaction } from '../src/services/ynabApi';
import { buildTrackingPlan, type TrackingPlanInput } from '../src/utils/ynabTrackingPlan';
import { buildMigrationPreview, buildReassignmentPreview, executeMigration, executeReassignment, rollbackDependents, rollbackWriteEntry, suggestReassignments, type YnabWriteApi } from '../src/utils/ynabWriteBack';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
};

// ── A fake YNAB budget ───────────────────────────────────────────────
interface FakeTx { id: string; accountId: string; amount: number; importId?: string; memo?: string; flag?: string; payeeName?: string; transferAccountId?: string; transferTransactionId?: string }
class FakeYnab implements YnabWriteApi {
    accounts = new Map<string, { id: string; name: string; onBudget: boolean; opening: number }>();
    txs = new Map<string, FakeTx>();
    deleteBothSides = true;
    failTransactions = false;
    writes = 0;
    private n = 0;
    add(id: string, name: string, opening: number, onBudget = false) { this.accounts.set(id, { id, name, onBudget, opening: opening * 1000 }); }
    balance(id: string) { let b = this.accounts.get(id)!.opening; for (const t of this.txs.values()) if (t.accountId === id) b += t.amount; return b / 1000; }
    private summary(id: string): YnabAccountSummary {
        const a = this.accounts.get(id)!;
        const bal = Math.round(this.balance(id) * 1000);
        return { id, name: a.name, type: 'otherAsset', onBudget: a.onBudget, balanceMilliunits: bal, clearedBalanceMilliunits: bal, transferPayeeId: `payee-${id}` };
    }
    async listAccounts() { return { success: true, data: [...this.accounts.keys()].map(id => this.summary(id)) }; }
    async createTrackingAccount(name: string) {
        this.writes++;
        const id = `new-${++this.n}`;
        this.add(id, name, 0);
        return { success: true, data: this.summary(id) };
    }
    async createTransactions(list: YnabNewTransaction[]) {
        this.writes++;
        if (this.failTransactions) return { success: false, error: 'YNAB server error (HTTP 500).' };
        const saved = [];
        const duplicateImportIds: string[] = [];
        for (const t of list) {
            if (t.import_id && [...this.txs.values()].some(x => x.accountId === t.account_id && x.importId === t.import_id)) { duplicateImportIds.push(t.import_id); continue; }
            const id = `tx-${++this.n}`;
            const tx: FakeTx = { id, accountId: t.account_id, amount: t.amount, importId: t.import_id, memo: t.memo, flag: t.flag_color, payeeName: t.payee_name };
            const toAccount = t.payee_id?.startsWith('payee-') ? t.payee_id.slice('payee-'.length) : undefined;
            if (toAccount) {
                const otherId = `tx-${++this.n}`;
                tx.transferAccountId = toAccount;
                tx.transferTransactionId = otherId;
                this.txs.set(otherId, { id: otherId, accountId: toAccount, amount: -t.amount, transferAccountId: t.account_id, transferTransactionId: id });
            }
            this.txs.set(id, tx);
            saved.push({ id, accountId: tx.accountId, amountMilliunits: tx.amount, importId: tx.importId, transferAccountId: tx.transferAccountId, transferTransactionId: tx.transferTransactionId });
        }
        return { success: true, data: { transactions: saved, duplicateImportIds } };
    }
    async deleteTransaction(id: string) {
        this.writes++;
        const t = this.txs.get(id);
        if (!t) return { success: true, data: { notFound: true } };
        this.txs.delete(id);
        if (this.deleteBothSides && t.transferTransactionId) this.txs.delete(t.transferTransactionId);
        return { success: true, data: { notFound: false } };
    }
}

// ── Tool data: one type-B broker holding two portfolios ──────────────
const brokers: Broker[] = [{ id: 'fin', name: 'Beta Broker', currentLiquidity: 1000 }];
const portfolios: Portfolio[] = [{ id: 'growth', name: 'Growth', order: 0 }, { id: 'safe', name: 'Safe', order: 1 }];
const transactions: Transaction[] = [
    { id: 't1', portfolioId: 'growth', brokerId: 'fin', ticker: 'WORLD', amount: 50, price: 100, date: '2025-01-15', direction: 'Buy' },
    { id: 't2', portfolioId: 'safe', brokerId: 'fin', ticker: 'GOVB', amount: 50, price: 100, date: '2025-01-15', direction: 'Buy' },
];
const marketData = { WORLD: { price: 120, lastUpdated: '2026-10-01' }, GOVB: { price: 100, lastUpdated: '2026-10-01' } };
const goals: YnabGoal[] = [
    { id: 'g-bath', ynabBudgetId: 'budget', name: 'Bathroom', cashCoverage: 0, targetSource: 'parsed-name', lastSyncedAt: '2026-10-01' },
    { id: 'g-car', ynabBudgetId: 'budget', name: 'Car', cashCoverage: 0, targetSource: 'parsed-name', lastSyncedAt: '2026-10-01' },
];
const allocations: YnabGoalAllocation[] = [
    { id: 'a1', ynabGoalId: 'g-bath', portfolioId: 'growth', ticker: 'WORLD', amount: 1200, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    { id: 'a2', ynabGoalId: 'g-car', portfolioId: 'safe', amount: 2000, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
];

const fresh = () => {
    const y = new FakeYnab();
    y.add('acc-fin', 'Beta Investments', 12500);   // tool says 6,000 + 5,000 + 1,000 cash = 12,000
    y.add('acc-bath', '🎯 Bathroom', 0);
    y.add('acc-house', 'House', 250000);
    y.add('acc-checking', 'Checking', 3000, true);
    return y;
};

const baseConfig: YnabTrackingConfig = {
    brokerSources: { fin: 'acc-fin' },
    destinationAccounts: { 'goal:g-bath': 'acc-bath', 'cash:fin': 'acc-fin' },
    guardBudgetId: 'budget',
    guardAccountIds: ['acc-fin', 'acc-bath'],
};

const planFor = async (y: FakeYnab, config: YnabTrackingConfig, migratedBrokerIds: string[] = [], goalQuotes: YnabGoalQuote[] = []) => {
    const res = await y.listAccounts();
    const accounts = res.data!.map(a => ({ id: a.id, name: a.name, onBudget: a.onBudget, balance: a.balanceMilliunits / 1000, clearedBalance: a.clearedBalanceMilliunits / 1000, transferPayeeId: a.transferPayeeId }));
    const input: TrackingPlanInput = {
        portfolios, transactions, brokers, assetSettings: [], marketData, goals, allocations, virtualBonds: [],
        liquidityMappings: {}, config, accounts, budgetId: 'budget', migratedBrokerIds, goalQuotes,
    };
    return { plan: buildTrackingPlan(input), accounts };
};

const run = async () => {
    console.log('Preview');
    let y = fresh();
    let config = { ...baseConfig };
    let { plan, accounts } = await planFor(y, config);
    const preview = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'e1a2b3c4d5', date: '2026-10-12' });
    check('ready', preview.blockers, []);
    check('realignment to the tool value first', preview.realignment, -500);
    check('transfers out of the broker account', preview.transfers.map(t => [t.destinationKey, t.amount, t.accountId ?? 'new']), [
        ['portfolio:growth', 4800, 'new'], ['portfolio:safe', 3000, 'new'], ['goal:g-car', 2000, 'new'], ['goal:g-bath', 1200, 'acc-bath'],
    ]);
    check('cash stays in the broker account', preview.staysInPlace.map(s => [s.destinationKey, s.amount]), [['cash:fin', 1000]]);
    check('accounts to create, prefixed', preview.createAccounts.map(c => c.name), ['🏦 Growth', '🏦 Safe', '🎯 Car']);
    check('memo marks the tool and lists the holdings', preview.transfers[3].memo, '[PRB] Migrazione da Beta Investments · WORLD 10 q');
    check('import ids unique and ≤ 36 chars', [new Set(preview.transfers.map(t => t.importId)).size, preview.transfers.every(t => t.importId.length <= 36), preview.transfers[0].importId], [4, true, 'PRB:e1a2b3c4:1']);
    check('goal shares frozen in units', preview.quotes.map(q => [q.goalId, q.ticker, q.quantity, q.cost]), [['g-bath', 'WORLD', 10, 1000], ['g-car', 'GOVB', 20, 2000]]);

    console.log('Guard and blockers');
    const noGuard = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config: { ...config, guardAccountIds: ['acc-bath'] }, budgetId: 'budget', entryId: 'x', date: '2026-10-12' });
    check('source outside the guard blocks', noGuard.blockers.some(b => b.includes('Beta Investments')), true);
    const otherBudget = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'other', entryId: 'x', date: '2026-10-12' });
    check('another budget blocks', otherBudget.blockers.length > 0, true);
    const clash = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-12', nameOverrides: { 'goal:g-car': 'House' } });
    check('a new account cannot take an existing name', clash.blockers.some(b => b.includes('"House" already exists')), true);
    const blocked = await executeMigration(y, noGuard, config, { report: () => {} });
    check('execute refuses a blocked preview, no write', [blocked.ok, y.writes], [false, 0]);

    console.log('Execute');
    const log: YnabWriteLogEntry[] = [];
    const created: string[] = [];
    const res = await executeMigration(y, preview, config, {
        report: e => log.push(e),
        onAccountCreated: (key, a) => {
            created.push(key);
            config = { ...config, guardAccountIds: [...(config.guardAccountIds ?? []), a.id], destinationAccounts: { ...config.destinationAccounts, [key]: a.id } };
        },
        now: () => '2026-10-12T10:00:00Z',
    });
    check('applied', [res.ok, res.entry.status, res.error ?? null], [true, 'applied', null]);
    check('log saved before and after each write', log.map(e => e.status), ['pending', 'pending', 'pending', 'pending', 'applied']);
    check('created accounts reported', created, ['portfolio:growth', 'portfolio:safe', 'goal:g-car']);
    const balances = () => Object.fromEntries([...y.accounts.values()].map(a => [a.name, y.balance(a.id)]));
    check('balances after the migration', balances(), {
        'Beta Investments': 1000, '🎯 Bathroom': 1200, House: 250000, Checking: 3000, '🏦 Growth': 4800, '🏦 Safe': 3000, '🎯 Car': 2000,
    });
    const mine = [...y.txs.values()].filter(t => t.importId);
    check('every transaction flagged, memo-tagged, cleared booking', [mine.length, mine.every(t => t.flag === 'purple' && t.memo?.startsWith('[PRB]'))], [5, true]);
    check('realignment booked to the tool payee', mine.find(t => t.importId === 'PRB:e1a2b3c4:0')?.payeeName, 'Portfolio Rebalancer');
    check('logged: realign + 4 transfers, with the other sides', [res.entry.transactions.length, res.entry.transactions.filter(t => t.transferTransactionId).length], [5, 4]);
    check('untouched accounts untouched', [y.balance('acc-house'), y.balance('acc-checking')], [250000, 3000]);

    console.log('Plan after the migration');
    const frozen: YnabGoalQuote[] = preview.quotes.map(q => ({ ...q, entryId: res.entry.id, frozenAt: '2026-10-12T10:00:00Z' }));
    ({ plan, accounts } = await planFor(y, config, ['fin'], frozen));
    check('broker marked migrated, migration done', [plan.brokers[0].migrated, plan.migrations[0].done], [true, true]);
    check('broker account aligned on what stays', plan.brokers[0].realignment, 0);
    check('destinations match YNAB', plan.destinations.map(d => [d.key, d.accountDifference]), [
        ['goal:g-bath', 0], ['goal:g-car', 0], ['portfolio:growth', 0], ['portfolio:safe', 0], ['cash:fin', 0],
    ]);
    const again = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'e2', date: '2026-10-12' });
    check('cannot migrate twice', again.blockers.some(b => b.includes('already been migrated')), true);

    console.log('Rollback');
    const rb = await rollbackWriteEntry(y, res.entry, config, { report: () => {}, now: () => '2026-10-12T11:00:00Z' });
    check('rolled back', [rb.ok, rb.entry.status, rb.entry.rolledBackAt], [true, 'rolled-back', '2026-10-12T11:00:00Z']);
    check('every transaction gone, both sides', y.txs.size, 0);
    check('balances restored', balances(), {
        'Beta Investments': 12500, '🎯 Bathroom': 0, House: 250000, Checking: 3000, '🏦 Growth': 0, '🏦 Safe': 0, '🎯 Car': 0,
    });
    check('created accounts left empty, to close by hand', rb.accountsLeft.map(a => a.name), ['🏦 Growth', '🏦 Safe', '🎯 Car']);

    console.log('Rollback when YNAB keeps the other side');
    y = fresh(); y.deleteBothSides = false; config = { ...baseConfig };
    ({ plan, accounts } = await planFor(y, config));
    const p2 = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'f00d', date: '2026-10-12' });
    const r2 = await executeMigration(y, p2, config, { report: () => {}, onAccountCreated: (k, a) => { config = { ...config, guardAccountIds: [...config.guardAccountIds!, a.id] }; } });
    await rollbackWriteEntry(y, r2.entry, config, { report: () => {} });
    check('the other sides are deleted too', y.txs.size, 0);

    console.log('Stale preview');
    y = fresh(); config = { ...baseConfig };
    ({ plan, accounts } = await planFor(y, config));
    const p3 = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'beef', date: '2026-10-12' });
    y.accounts.get('acc-fin')!.opening += 10_000; // someone edits YNAB meanwhile
    const r3 = await executeMigration(y, p3, config, { report: () => {} });
    check('refused before any write', [r3.ok, r3.entry.status, y.writes, y.txs.size], [false, 'failed', 0, 0]);
    check('says why', r3.error?.includes('changed since the preview'), true);

    console.log('Failure after the accounts were created');
    y = fresh(); y.failTransactions = true; config = { ...baseConfig };
    ({ plan, accounts } = await planFor(y, config));
    const p4 = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'cafe', date: '2026-10-12' });
    const r4 = await executeMigration(y, p4, config, { report: () => {}, onAccountCreated: (k, a) => { config = { ...config, guardAccountIds: [...config.guardAccountIds!, a.id] }; } });
    check('failed, created accounts recorded', [r4.ok, r4.entry.status, r4.entry.createdAccounts.length, r4.entry.transactions.length], [false, 'failed', 3, 0]);
    const r4b = await rollbackWriteEntry(y, r4.entry, config, { report: () => {} });
    check('rollback of a failed entry is clean', [r4b.ok, r4b.entry.status, r4b.accountsLeft.length], [true, 'rolled-back', 3]);

    console.log('Rollback stays inside the guard');
    y = fresh(); config = { ...baseConfig };
    ({ plan, accounts } = await planFor(y, config));
    const p5 = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'abcd', date: '2026-10-12' });
    const r5 = await executeMigration(y, p5, config, { report: () => {}, onAccountCreated: (k, a) => { config = { ...config, guardAccountIds: [...config.guardAccountIds!, a.id] }; } });
    const writesBefore = y.writes;
    const r5b = await rollbackWriteEntry(y, r5.entry, { ...config, guardAccountIds: ['acc-bath'] }, { report: () => {} });
    check('refused when the source is no longer allowed, nothing deleted', [r5b.ok, y.writes === writesBefore], [false, true]);
};

const reassignments = async () => {
    // Migrate first, keeping the ledger the way the app does.
    let clock = 0;
    const now = () => `2026-10-12T10:${String(clock++).padStart(2, '0')}:00Z`;
    const y = fresh();
    let config: YnabTrackingConfig = { ...baseConfig };
    const ledger: YnabGoalQuote[] = [];
    const log: YnabWriteLogEntry[] = [];
    const keep = (e: YnabWriteLogEntry) => { const i = log.findIndex(x => x.id === e.id); if (i >= 0) log[i] = e; else log.push(e); };
    const linkCreated = (key: string, a: { id: string }) => {
        config = { ...config, guardAccountIds: [...config.guardAccountIds!, a.id], destinationAccounts: { ...config.destinationAccounts, [key]: a.id } };
    };
    let { plan, accounts } = await planFor(y, config);
    const mig = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'mig00001', date: '2026-10-12' });
    const migRes = await executeMigration(y, mig, config, { report: keep, onAccountCreated: linkCreated, now });
    ledger.push(...mig.quotes.map(q => ({ ...q, entryId: migRes.entry.id, frozenAt: now() })));
    const refresh = async () => ({ plan, accounts } = await planFor(y, config, ['fin'], ledger));
    await refresh();
    const reassign = async (fromKey: string, toKey: string, amount: number, entryId: string) => {
        const p = buildReassignmentPreview({ plan, fromKey, toKey, amount, accounts, config, budgetId: 'budget', entryId, date: '2026-10-12' });
        if (p.blockers.length) return { p, ok: false };
        const r = await executeReassignment(y, p, config, { report: keep, onAccountCreated: linkCreated, now });
        if (r.ok) ledger.push(...p.quotes.map(q => ({ ...q, entryId: r.entry.id, frozenAt: now() })));
        await refresh();
        return { p, ok: r.ok, r };
    };
    const val = (key: string) => plan.destinations.find(d => d.key === key)?.value;
    const units = (key: string) => plan.destinations.find(d => d.key === key)?.pieces.map(p => [p.ticker, Math.round(p.quantity * 1000) / 1000]);

    console.log('Suggestions');
    check('nothing to suggest while shares match the allocations', suggestReassignments(plan), []);
    const halved = buildTrackingPlan({
        portfolios, transactions, brokers, assetSettings: [], marketData, goals, virtualBonds: [], liquidityMappings: {}, config, accounts,
        budgetId: 'budget', migratedBrokerIds: ['fin'], goalQuotes: ledger,
        allocations: allocations.map(a => a.id === 'a1' ? { ...a, amount: 600 } : a),
    });
    check('a smaller allocation suggests giving the difference back', suggestReassignments(halved), [{ fromKey: 'goal:g-bath', toKey: 'portfolio:growth', amount: 600 }]);
    const moved = buildTrackingPlan({
        portfolios, transactions, brokers, assetSettings: [], marketData, goals, virtualBonds: [], liquidityMappings: {}, config, accounts,
        budgetId: 'budget', migratedBrokerIds: ['fin'], goalQuotes: ledger,
        allocations: [...allocations.map(a => a.id === 'a1' ? { ...a, amount: 600 } : a), { id: 'a3', ynabGoalId: 'g-car', portfolioId: 'growth', ticker: 'WORLD', amount: 600, createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
    });
    check('moving an allocation between goals suggests goal → goal', suggestReassignments(moved), [{ fromKey: 'goal:g-bath', toKey: 'goal:g-car', amount: 600 }]);
    const viaCheck = suggestReassignments(moved, () => false);
    check('refused pairs are left out', viaCheck, []);

    console.log('Reassignment: from goal A to goal B');
    const r1 = await reassign('goal:g-bath', 'goal:g-car', 600, 'rea00001');
    check('one transfer between the two goal accounts', [r1.ok, r1.p.amount, r1.p.from.accountName, r1.p.to.accountName], [true, 600, '🎯 Bathroom', '🎯 Car']);
    check('units move with their cost basis', r1.p.quotes.map(q => [q.goalId, q.ticker, q.quantity, q.cost]), [['g-bath', 'WORLD', -5, -500], ['g-car', 'WORLD', 5, 500]]);
    check('memo says reassignment', r1.p.memo, '[PRB] Riassegnazione da 🎯 Bathroom · WORLD 5 q');
    check('YNAB balances', [y.balance('acc-bath'), y.balance(config.destinationAccounts['goal:g-car'])], [600, 2600]);
    check('plan follows the shares', [val('goal:g-bath'), val('goal:g-car'), units('goal:g-car')], [600, 2600, [['GOVB', 20], ['WORLD', 5]]]);
    check('desired still from the allocations', plan.destinations.find(d => d.key === 'goal:g-bath')?.desiredValue, 1200);

    console.log('Reassignment: from a goal back to its portfolio');
    const r2 = await reassign('goal:g-bath', 'portfolio:growth', 200, 'rea00002');
    check('goal → its own portfolio', [r2.ok, val('goal:g-bath'), val('portfolio:growth')], [true, 400, 5000]);
    const wrong = buildReassignmentPreview({ plan, fromKey: 'goal:g-car', toKey: 'portfolio:growth', amount: 100, accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-12' });
    check('a holding cannot go to a portfolio that does not hold it', wrong.blockers.some(b => b.includes('GOVB is not held by')), true);

    console.log('Reassignment: from portfolio X to goal Y');
    const r3 = await reassign('portfolio:safe', 'goal:g-bath', 1000, 'rea00003');
    check('portfolio → goal', [r3.ok, val('portfolio:safe'), val('goal:g-bath')], [true, 2000, 1400]);
    check('the goal now holds both', units('goal:g-bath'), [['GOVB', 10], ['WORLD', 3.333]]);
    check('ledger adds up per goal', [
        ledger.filter(q => q.goalId === 'g-bath' && q.ticker === 'WORLD').reduce((s, q) => s + q.quantity, 0),
        ledger.filter(q => q.goalId === 'g-bath' && q.ticker === 'GOVB').reduce((s, q) => s + q.quantity, 0),
    ].map(v => Math.round(v * 1000) / 1000), [3.333, 10]);
    check('everything still balanced', plan.balanced, true);
    check('YNAB matches the plan', plan.destinations.map(d => [d.key, d.accountDifference]), [
        ['goal:g-bath', 0], ['goal:g-car', 0], ['portfolio:growth', 0], ['portfolio:safe', 0], ['cash:fin', 0],
    ]);

    console.log('Reassignment: refused cases');
    const tooMuch = buildReassignmentPreview({ plan, fromKey: 'goal:g-bath', toKey: 'goal:g-car', amount: 5000, accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-12' });
    check('more than the account holds', tooMuch.blockers.some(b => b.includes('move at most')), true);
    const p2p = buildReassignmentPreview({ plan, fromKey: 'portfolio:safe', toKey: 'portfolio:growth', amount: 100, accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-12' });
    check('portfolio → portfolio is not a reassignment', p2p.blockers.some(b => b.includes('own portfolio')), true);
    const notMigrated = buildTrackingPlan({ portfolios, transactions, brokers, assetSettings: [], marketData, goals, allocations, virtualBonds: [], liquidityMappings: {}, config, accounts, budgetId: 'budget' });
    const early = buildReassignmentPreview({ plan: notMigrated, fromKey: 'goal:g-bath', toKey: 'goal:g-car', amount: 100, accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-12' });
    check('before the migration, allocations decide', early.blockers.some(b => b.includes('nothing at a migrated broker')), true);

    console.log('Rollback order');
    check('the migration waits for the reassignments on its accounts', rollbackDependents(log, migRes.entry.id).map(e => e.id), ['rea00001', 'rea00002', 'rea00003']);
    check('the latest reassignment has no dependents', rollbackDependents(log, 'rea00003'), []);
    for (const id of ['rea00003', 'rea00002', 'rea00001', migRes.entry.id]) {
        const e = log.find(x => x.id === id)!;
        const rb = await rollbackWriteEntry(y, e, config, { report: keep, now });
        if (rb.ok) ledger.splice(0, ledger.length, ...ledger.filter(q => q.entryId !== id));
    }
    check('all rolled back in order', log.map(e => e.status), ['rolled-back', 'rolled-back', 'rolled-back', 'rolled-back']);
    check('YNAB back to the start', [y.txs.size, y.balance('acc-fin'), y.balance('acc-bath')], [0, 12500, 0]);
    check('ledger empty again', ledger.length, 0);
};

run().then(reassignments).then(() => {
    if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
    console.log('\nAll checks passed');
});
