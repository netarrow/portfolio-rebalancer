// End-to-end checks of the YNAB write-back engine against an in-memory fake
// YNAB: preview, guard, migration of one broker account, balances afterwards,
// rollback (both sides of every transfer), stale balances and failures.
// Every name and figure below is invented.
// Run with: npx esbuild scripts/verify-ynab-write-back.ts --bundle --format=esm | node --input-type=module
import type { Broker, Portfolio, Transaction, YnabGoal, YnabGoalAllocation, YnabGoalQuote, YnabTrackingConfig, YnabWriteLogEntry } from '../src/types';
import type { YnabAccountSummary, YnabNewTransaction } from '../src/services/ynabApi';
import { buildTrackingPlan, type TrackingPlanInput } from '../src/utils/ynabTrackingPlan';
import { mergeYnabGoalsFromCandidates } from '../src/utils/ynabGoalSync';
import { buildMigrationPreview, buildOrphanRelease, buildReassignmentPreview, buildRevaluationPreview, currentTaxLines, goalHeldUnits, goalsHoldingShares, executeMigration, executeReassignment, executeRevaluation, migrationWritePlan, rollbackDependents, rollbackWriteEntry, suggestReassignments, type MigrationPreview, type YnabWriteApi } from '../src/utils/ynabWriteBack';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
};

// ── A fake YNAB budget ───────────────────────────────────────────────
interface FakeTx { id: string; accountId: string; amount: number; cleared?: string; importId?: string; memo?: string; flag?: string; payeeName?: string; transferAccountId?: string; transferTransactionId?: string }
class FakeYnab implements YnabWriteApi {
    accounts = new Map<string, { id: string; name: string; onBudget: boolean; opening: number }>();
    txs = new Map<string, FakeTx>();
    deleteBothSides = true;
    failTransactions = false;
    writes = 0;
    private n = 0;
    add(id: string, name: string, opening: number, onBudget = false) { this.accounts.set(id, { id, name, onBudget, opening: opening * 1000 }); }
    balance(id: string) { let b = this.accounts.get(id)!.opening; for (const t of this.txs.values()) if (t.accountId === id) b += t.amount; return b / 1000; }
    cleared(id: string) { let b = this.accounts.get(id)!.opening; for (const t of this.txs.values()) if (t.accountId === id && t.cleared !== 'uncleared') b += t.amount; return b / 1000; }
    private summary(id: string): YnabAccountSummary {
        const a = this.accounts.get(id)!;
        const bal = Math.round(this.balance(id) * 1000);
        return { id, name: a.name, type: 'otherAsset', onBudget: a.onBudget, balanceMilliunits: bal, clearedBalanceMilliunits: Math.round(this.cleared(id) * 1000), transferPayeeId: `payee-${id}` };
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
            const tx: FakeTx = { id, accountId: t.account_id, amount: t.amount, cleared: t.cleared, importId: t.import_id, memo: t.memo, flag: t.flag_color, payeeName: t.payee_name };
            const toAccount = t.payee_id?.startsWith('payee-') ? t.payee_id.slice('payee-'.length) : undefined;
            if (toAccount) {
                const otherId = `tx-${++this.n}`;
                tx.transferAccountId = toAccount;
                tx.transferTransactionId = otherId;
                this.txs.set(otherId, { id: otherId, accountId: toAccount, amount: -t.amount, cleared: t.cleared, transferAccountId: t.account_id, transferTransactionId: id });
            }
            this.txs.set(id, tx);
            saved.push({ id, accountId: tx.accountId, amountMilliunits: tx.amount, importId: tx.importId, transferAccountId: tx.transferAccountId, transferTransactionId: tx.transferTransactionId });
        }
        return { success: true, data: { transactions: saved, duplicateImportIds } };
    }
    updates = 0;
    async updateTransaction(id: string, patch: { amount?: number; memo?: string; date?: string }) {
        this.writes++; this.updates++;
        const t = this.txs.get(id);
        if (!t) return { success: true, data: { notFound: true } };
        if (patch.amount !== undefined) t.amount = patch.amount;
        if (patch.memo !== undefined) t.memo = patch.memo;
        return { success: true, data: { notFound: false, transaction: { id, accountId: t.accountId, amountMilliunits: t.amount } } };
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

const planFor = async (y: FakeYnab, config: YnabTrackingConfig, migratedBrokerIds: string[] = [], goalQuotes: YnabGoalQuote[] = [], log: YnabWriteLogEntry[] = []) => {
    const res = await y.listAccounts();
    const accounts = res.data!.map(a => ({ id: a.id, name: a.name, onBudget: a.onBudget, balance: a.balanceMilliunits / 1000, clearedBalance: a.clearedBalanceMilliunits / 1000, transferPayeeId: a.transferPayeeId }));
    const taxLineAmounts = Object.fromEntries([...currentTaxLines(log, 'budget')].map(([id, t]) => [id, t.amount]));
    const input: TrackingPlanInput = {
        portfolios, transactions, brokers, assetSettings: [], marketData, goals, allocations, virtualBonds: [],
        liquidityMappings: {}, config, accounts, budgetId: 'budget', migratedBrokerIds, goalQuotes, taxLineAmounts,
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
    check('transfers out of the broker account, at cost basis (PMC)', preview.transfers.map(t => [t.destinationKey, t.amount, t.value, t.accountId ?? 'new']), [
        ['portfolio:growth', 4000, 4800, 'new'], ['portfolio:safe', 3000, 3000, 'new'], ['goal:g-car', 2000, 2000, 'new'], ['goal:g-bath', 1000, 1200, 'acc-bath'],
    ]);
    check('the gains leave the broker account', [preview.plMove, preview.plMoveImportId], [-1000, 'PRB:e1a2b3c4:5']);
    check('one P/L and one tax line per account with a gain', preview.lines.map(l => [l.destinationKey, l.role, l.amount, l.accountId ?? 'new', l.existingId ?? null]), [
        ['portfolio:growth', 'pl', 800, 'new', null], ['portfolio:growth', 'tax', -208, 'new', null],
        ['goal:g-bath', 'pl', 200, 'acc-bath', null], ['goal:g-bath', 'tax', -52, 'acc-bath', null],
    ]);
    check('cash stays in the broker account', preview.staysInPlace.map(s => [s.destinationKey, s.amount]), [['cash:fin', 1000]]);
    check('accounts to create, prefixed', preview.createAccounts.map(c => c.name), ['🏦 Growth', '🏦 Safe', '🎯 Car']);
    check('memo marks the tool and lists the holdings', preview.transfers[3].memo, '[PRB] Migrazione al PMC da Beta Investments · WORLD 10 q');
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
    check('log saved before and after each write', log.map(e => e.status), ['pending', 'pending', 'pending', 'pending', 'pending', 'applied']);
    check('created accounts reported', created, ['portfolio:growth', 'portfolio:safe', 'goal:g-car']);
    const balances = () => Object.fromEntries([...y.accounts.values()].map(a => [a.name, y.balance(a.id)]));
    check('working balances after the migration (gross − latent tax)', balances(), {
        'Beta Investments': 1000, '🎯 Bathroom': 1148, House: 250000, Checking: 3000, '🏦 Growth': 4592, '🏦 Safe': 3000, '🎯 Car': 2000,
    });
    check('cleared balances are the gross value', [y.cleared('acc-bath'), y.cleared(config.destinationAccounts['portfolio:growth'])], [1200, 4800]);
    const mine = [...y.txs.values()].filter(t => t.importId);
    check('every transaction flagged, memo-tagged', [mine.length, mine.every(t => t.flag === 'purple' && t.memo?.startsWith('[PRB]'))], [10, true]);
    check('realignment booked to the tool payee', mine.find(t => t.importId === 'PRB:e1a2b3c4:0')?.payeeName, 'Portfolio Rebalancer');
    const bathLines = mine.filter(t => t.accountId === 'acc-bath' && t.payeeName === 'Portfolio Rebalancer').map(t => [t.amount / 1000, t.cleared, t.memo]);
    check('the goal account reads PMC + P/L + latent tax', bathLines, [
        [200, 'cleared', '[PRB] P/L latente (valore − PMC) · 12/10/2026'], [-52, 'uncleared', '[PRB] Tasse latenti su plusvalenza · 12/10/2026'],
    ]);
    check('logged: realign, gains, 4 transfers with the other sides, 4 lines', [res.entry.transactions.length, res.entry.transactions.filter(t => t.transferTransactionId).length, res.entry.transactions.map(t => t.role).filter(r => r === 'pl' || r === 'tax').length], [10, 4, 4]);
    check('untouched accounts untouched', [y.balance('acc-house'), y.balance('acc-checking')], [250000, 3000]);

    console.log('Plan after the migration');
    const frozen: YnabGoalQuote[] = preview.quotes.map(q => ({ ...q, entryId: res.entry.id, frozenAt: '2026-10-12T10:00:00Z' }));
    ({ plan, accounts } = await planFor(y, config, ['fin'], frozen, log));
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
    const refresh = async () => ({ plan, accounts } = await planFor(y, config, ['fin'], ledger, log));
    await refresh();
    const reassign = async (fromKey: string, toKey: string, amount: number, entryId: string) => {
        const p = buildReassignmentPreview({ plan, fromKey, toKey, amount, accounts, config, budgetId: 'budget', entryId, date: '2026-10-12', log });
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
    check('one transfer between the two goal accounts, at PMC', [r1.ok, r1.p.amount, r1.p.cost, r1.p.from.accountName, r1.p.to.accountName], [true, 600, 500, '🎯 Bathroom', '🎯 Car']);
    check('units move with their cost basis', r1.p.quotes.map(q => [q.goalId, q.ticker, q.quantity, q.cost]), [['g-bath', 'WORLD', -5, -500], ['g-car', 'WORLD', 5, 500]]);
    check('memo says reassignment', r1.p.memo, '[PRB] Riassegnazione al PMC da 🎯 Bathroom · WORLD 5 q');
    check('P/L and tax follow the shares: updated on one side, created on the other', r1.p.lines.map(l => [l.destinationKey, l.role, l.previous, l.amount, !!l.existingId]), [
        ['goal:g-bath', 'pl', 200, 100, true], ['goal:g-bath', 'tax', -52, -26, true], ['goal:g-car', 'pl', 0, 100, false], ['goal:g-car', 'tax', 0, -26, false],
    ]);
    check('YNAB balances (cleared = gross)', [y.cleared('acc-bath'), y.cleared(config.destinationAccounts['goal:g-car'])], [600, 2600]);
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

    const ghost = buildReassignmentPreview({ plan, fromKey: 'goal:g-bath', toKey: 'goal:g-car', amount: 100, accounts: accounts.map(a => a.id === 'acc-bath' ? { ...a, balance: a.balance + 300 } : a), config, budgetId: 'budget', entryId: 'x', date: '2026-10-12', log });
    check('an account off its PMC in YNAB asks for a revaluation first', [ghost.unaligned.length, ghost.blockers.some(b => b.includes('revalue it first'))], [1, true]);

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
    check('lines restored before being deleted', y.updates > 0, true);
    check('ledger empty again', ledger.length, 0);
};

const revaluations = async () => {
    let clock = 0;
    const now = () => `2026-10-13T10:${String(clock++).padStart(2, '0')}:00Z`;
    const y = fresh();
    let config: YnabTrackingConfig = { ...baseConfig };
    const ledger: YnabGoalQuote[] = [];
    const log: YnabWriteLogEntry[] = [];
    const keep = (e: YnabWriteLogEntry) => { const i = log.findIndex(x => x.id === e.id); if (i >= 0) log[i] = e; else log.push(e); };
    const linkCreated = (key: string, a: { id: string }) => {
        config = { ...config, guardAccountIds: [...config.guardAccountIds!, a.id], destinationAccounts: { ...config.destinationAccounts, [key]: a.id } };
    };
    const planAt = async (prices: Record<string, number>, migrated: string[]) => {
        const res = await y.listAccounts();
        const accounts = res.data!.map(a => ({ id: a.id, name: a.name, onBudget: a.onBudget, balance: a.balanceMilliunits / 1000, clearedBalance: a.clearedBalanceMilliunits / 1000, transferPayeeId: a.transferPayeeId }));
        const md = Object.fromEntries(Object.entries(prices).map(([t, price]) => [t, { price, lastUpdated: '2026-10-13' }]));
        const taxLineAmounts = Object.fromEntries([...currentTaxLines(log, 'budget')].map(([id, t]) => [id, t.amount]));
        const plan = buildTrackingPlan({ portfolios, transactions, brokers, assetSettings: [], marketData: md, goals, allocations, virtualBonds: [], liquidityMappings: {}, config, accounts, budgetId: 'budget', migratedBrokerIds: migrated, goalQuotes: ledger, taxLineAmounts });
        return { plan, accounts };
    };
    let { plan, accounts } = await planAt({ WORLD: 120, GOVB: 100 }, []);
    const mig = buildMigrationPreview({ plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'mig00009', date: '2026-10-13' });
    const migRes = await executeMigration(y, mig, config, { report: keep, onAccountCreated: linkCreated, now });
    ledger.push(...mig.quotes.map(q => ({ ...q, entryId: migRes.entry.id, frozenAt: now() })));
    const growthId = () => config.destinationAccounts['portfolio:growth'];

    console.log('Revaluation: prices up');
    ({ plan, accounts } = await planAt({ WORLD: 132, GOVB: 100 }, ['fin']));
    const p1 = buildRevaluationPreview({ plan, accounts, config, budgetId: 'budget', entryId: 'rev00001', date: '2026-10-13', log });
    check('only the accounts whose value moved', p1.accounts.map(a => [a.destinationKey, a.costAdjust, a.plSeen, a.plTarget, a.delta, a.taxTarget, a.taxSeen]), [
        ['goal:g-bath', 0, 200, 320, 120, -83.2, -52], ['portfolio:growth', 0, 800, 1280, 480, -332.8, -208],
    ]);
    check('P/L memo with units and prices', p1.accounts[0].plMemo, '[PRB] P/L latente (valore − PMC) · 13/10/2026 · WORLD 10 q @ 132,00');
    check('nothing suspicious after a price move', p1.accounts.map(a => [a.suspicious, a.conversion]), [[false, false], [false, false]]);
    const txBefore = y.txs.size;
    const r1 = await executeRevaluation(y, p1, new Set(p1.accounts.map(a => a.destinationKey)), config, { report: keep, now });
    check('applied: both lines updated in place, no new rows', [r1.ok, r1.entry.transactions.map(t => t.role).sort(), r1.entry.transactions.every(t => t.updatedInPlace), y.txs.size - txBefore], [true, ['pl', 'pl', 'tax', 'tax'], true, 0]);
    check('cleared = gross, working = net', [y.cleared('acc-bath'), y.balance('acc-bath'), y.cleared(growthId()), y.balance(growthId())], [1320, 1236.8, 5280, 4947.2]);
    ({ plan, accounts } = await planAt({ WORLD: 132, GOVB: 100 }, ['fin']));
    check('the page compares without the tax line: nothing left', plan.destinations.map(d => d.accountDifference), [0, 0, 0, 0, 0]);
    const again = buildRevaluationPreview({ plan, accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-13' , log });
    check('revaluing twice at the same prices does nothing', again.accounts.length, 0);

    console.log('Revaluation: prices down, tax updated in place');
    ({ plan, accounts } = await planAt({ WORLD: 126, GOVB: 100 }, ['fin']));
    const taxIdBefore = currentTaxLines(log, 'budget').get('acc-bath')?.transactionId;
    const p2 = buildRevaluationPreview({ plan, accounts, config, budgetId: 'budget', entryId: 'rev00002', date: '2026-10-14', log });
    check('PMC read from the account without its two lines', p2.accounts.map(a => [a.destinationKey, a.costSeen, a.plSeen, a.plTarget, a.delta, a.taxTarget, a.taxSeen]), [
        ['goal:g-bath', 1000, 320, 260, -60, -67.6, -83.2], ['portfolio:growth', 4000, 1280, 1040, -240, -270.4, -332.8],
    ]);
    const updatesBefore = y.updates;
    const r2 = await executeRevaluation(y, p2, new Set(p2.accounts.map(a => a.destinationKey)), config, { report: keep, now });
    check('the same lines, updated in place', [r2.ok, y.updates - updatesBefore, currentTaxLines(log, 'budget').get('acc-bath')?.transactionId === taxIdBefore], [true, 4, true]);
    check('balances after', [y.cleared('acc-bath'), y.balance('acc-bath')], [1260, 1192.4]);
    check('one tax line per account in YNAB', [...y.txs.values()].filter(t => t.accountId === 'acc-bath' && t.cleared === 'uncleared').length, 1);

    console.log('Revaluation: rollback');
    check('the first waits for the second', rollbackDependents(log, 'rev00001').map(e => e.id), ['rev00002']);
    await rollbackWriteEntry(y, log.find(e => e.id === 'rev00002')!, config, { report: keep, now });
    check('second undone: tax line back to its previous amount, same line', [y.cleared('acc-bath'), y.balance('acc-bath'), currentTaxLines(log, 'budget').get('acc-bath')?.amount], [1320, 1236.8, -83.2]);
    await rollbackWriteEntry(y, log.find(e => e.id === 'rev00001')!, config, { report: keep, now });
    check('first undone: back to the migration', [y.balance('acc-bath'), y.balance(growthId()), currentTaxLines(log, 'budget').get('acc-bath')?.amount], [1148, 4592, -52]);

    console.log('Revaluation: a move bigger than the market');
    y.txs.set('manual-1', { id: 'manual-1', accountId: 'acc-bath', amount: 500_000, cleared: 'uncleared' }); // a transfer the tool does not know about
    ({ plan, accounts } = await planAt({ WORLD: 121, GOVB: 100 }, ['fin']));
    const p3 = buildRevaluationPreview({ plan, accounts, config, budgetId: 'budget', entryId: 'rev00003', date: '2026-10-15', log });
    check('flagged as suspicious, so left unticked', [p3.accounts.find(a => a.destinationKey === 'goal:g-bath')?.suspicious, p3.accounts.find(a => a.destinationKey === 'goal:g-bath')?.costAdjust], [true, -500]);
    const narrow = { ...config, guardAccountIds: config.guardAccountIds!.filter(id => id !== growthId()) };
    const p4 = buildRevaluationPreview({ plan, accounts, config: narrow, budgetId: 'budget', entryId: 'rev00004', date: '2026-10-15', log });
    check('an account outside the guard is shown but blocked', p4.accounts.find(a => a.destinationKey === 'portfolio:growth')?.blocked?.includes('not among'), true);
    const early = buildRevaluationPreview({ plan: (await planAt({ WORLD: 121, GOVB: 100 }, [])).plan, accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-15', log });
    check('nothing to revalue before a migration', early.blockers.some(b => b.includes('Nothing is migrated')), true);

    console.log('Migration where everything stays');
    const staysOnly: MigrationPreview = {
        entryId: 'stay0001', budgetId: 'budget', brokerId: 'pens', brokerName: 'Pension', date: '2026-10-15',
        source: { accountId: 'acc-house', name: 'Pension', balanceSeen: 250000 }, realignment: 0, realignMemo: '', realignImportId: 'PRB:stay0001:0',
        plMove: 0, plMoveMemo: '', plMoveImportId: '', lines: [],
        createAccounts: [], transfers: [], staysInPlace: [{ destinationKey: 'portfolio:pension', accountName: 'Pension', amount: 250000 }], quotes: [], blockers: [],
    };
    check('nothing to write, still a valid migration', migrationWritePlan(staysOnly).allowNoWrites, true);
};

const conversion = async () => {
    console.log('Account migrated before P/L lines existed');
    // Its transfer carried the market value (1,200) and it has no P/L line.
    const y = fresh();
    y.accounts.get('acc-bath')!.opening = 1_200_000;
    const config: YnabTrackingConfig = { ...baseConfig };
    const ledger: YnabGoalQuote[] = [
        { entryId: 'old', goalId: 'g-bath', portfolioId: 'growth', brokerId: 'fin', ticker: 'WORLD', quantity: 10, cost: 1000, frozenAt: '2026-10-01' },
        { entryId: 'old', goalId: 'g-car', portfolioId: 'safe', brokerId: 'fin', ticker: 'GOVB', quantity: 20, cost: 2000, frozenAt: '2026-10-01' },
    ];
    const log: YnabWriteLogEntry[] = [];
    const { plan, accounts } = await planFor(y, config, ['fin'], ledger, log);
    const blocked = buildReassignmentPreview({ plan, fromKey: 'goal:g-bath', toKey: 'goal:g-car', amount: 100, accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-20', log });
    check('a reassignment waits for the revaluation', blocked.unaligned.some(b => b.includes('🎯 Bathroom')), true);
    const p = buildRevaluationPreview({ plan, accounts, config, budgetId: 'budget', entryId: 'conv0001', date: '2026-10-20', log });
    const bath = p.accounts.find(a => a.destinationKey === 'goal:g-bath')!;
    check('the gain moves out of the PMC into a new P/L line', [bath.costSeen, bath.costAdjust, bath.plTarget, bath.delta, bath.taxTarget], [1200, -200, 200, 0, -52]);
    check('a one-time reclassification, not suspicious', [bath.conversion, bath.suspicious, bath.costMemo.includes('Riclassifica')], [true, false, true]);
    const res = await executeRevaluation(y, p, new Set([bath.destinationKey]), config, { report: e => { const i = log.findIndex(x => x.id === e.id); if (i >= 0) log[i] = e; else log.push(e); } });
    check('written: reclassification, P/L line, tax line', [res.ok, res.entry.transactions.map(t => [t.role, t.amount])], [true, [['revalue', -200], ['pl', 200], ['tax', -52]]]);
    check('cleared still gross, working net', [y.cleared('acc-bath'), y.balance('acc-bath')], [1200, 1148]);
    const after = await planFor(y, config, ['fin'], ledger, log);
    const ok = buildReassignmentPreview({ plan: after.plan, fromKey: 'goal:g-bath', toKey: 'goal:g-car', amount: 100, accounts: after.accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-20', log });
    check('then the reassignment can run', ok.unaligned, []);
    check('and nothing is left to revalue', buildRevaluationPreview({ plan: after.plan, accounts: after.accounts, config, budgetId: 'budget', entryId: 'x', date: '2026-10-20', log }).accounts.filter(a => a.destinationKey === 'goal:g-bath').length, 0);
};

const lifecycle = async () => {
    const y = fresh();
    let config: YnabTrackingConfig = { ...baseConfig };
    const ledger: YnabGoalQuote[] = [];
    const log: YnabWriteLogEntry[] = [];
    const keep = (e: YnabWriteLogEntry) => { const i = log.findIndex(x => x.id === e.id); if (i >= 0) log[i] = e; else log.push(e); };
    const linkCreated = (key: string, a: { id: string }) => {
        config = { ...config, guardAccountIds: [...config.guardAccountIds!, a.id], destinationAccounts: { ...config.destinationAccounts, [key]: a.id } };
    };
    const start = await planFor(y, config);
    let accounts = start.accounts;
    const mig = buildMigrationPreview({ plan: start.plan, brokerId: 'fin', accounts, config, budgetId: 'budget', entryId: 'mig00020', date: '2026-10-16' });
    const migRes = await executeMigration(y, mig, config, { report: keep, onAccountCreated: linkCreated });
    ledger.push(...mig.quotes.map(q => ({ ...q, entryId: migRes.entry.id, frozenAt: '2026-10-16' })));
    ({ accounts } = await planFor(y, config, ['fin'], ledger));
    const planWith = (over: Partial<TrackingPlanInput>) => buildTrackingPlan({
        portfolios, transactions, brokers, assetSettings: [], marketData, goals, allocations, virtualBonds: [], liquidityMappings: {},
        config, accounts, budgetId: 'budget', migratedBrokerIds: ['fin'], goalQuotes: ledger,
        taxLineAmounts: Object.fromEntries([...currentTaxLines(log, 'budget')].map(([id, t]) => [id, t.amount])), ...over,
    });

    console.log('Goal archived or removed while holding shares');
    check('which goals hold shares', [...goalsHoldingShares(ledger)].sort(), ['g-bath', 'g-car']);
    check('units held by a goal', goalHeldUnits(ledger, 'g-bath'), 10);
    const archived = planWith({
        goals: goals.map(g => g.id === 'g-bath' ? { ...g, archived: true } : g),
        allocations: allocations.filter(a => a.ynabGoalId !== 'g-bath'),
    });
    const bath = archived.destinations.find(d => d.key === 'goal:g-bath');
    check('archived goal keeps its account and value', [bath?.inactiveGoal, bath?.value, bath?.desiredValue, bath?.accountDifference], ['archived', 1200, 0, 0]);
    check('and says so', archived.warnings.some(w => w.kind === 'shares-of-inactive-goal'), true);
    check('suggested back to its portfolio', suggestReassignments(archived), [{ fromKey: 'goal:g-bath', toKey: 'portfolio:growth', amount: 1200 }]);
    const removed = planWith({ goals: goals.filter(g => g.id !== 'g-bath'), allocations: allocations.filter(a => a.ynabGoalId !== 'g-bath') });
    check('removed goal still listed', [removed.destinations.find(d => d.key === 'goal:g-bath')?.inactiveGoal, removed.destinations.find(d => d.key === 'goal:g-bath')?.accountName], ['removed', '🎯 Removed capex']);
    check('still balanced', [archived.balanced, removed.balanced], [true, true]);

    console.log('Goal sync keeps goals holding shares');
    const merged = mergeYnabGoalsFromCandidates(goals.filter(g => !g.archived), [], { budgetId: 'budget', allocations: [], heldGoalIds: new Set(['g-bath']) });
    check('held goal archived, others dropped', [merged.goals.map(g => [g.id, g.archived]), merged.report.archived], [[['g-bath', true]], 1]);

    console.log('Orphan shares');
    const soldAll: Transaction[] = [...transactions, { id: 't9', portfolioId: 'growth', brokerId: 'fin', ticker: 'WORLD', amount: 50, price: 120, date: '2026-10-16', direction: 'Sell' }];
    const sold = planWith({ transactions: soldAll });
    check('a holding sold out leaves orphan shares', sold.orphanShares.map(o => [o.goalId, o.ticker, o.quantity]), [['g-bath', 'WORLD', 10]]);
    check('warned', sold.warnings.some(w => w.kind === 'orphan-goal-shares'), true);
    const release = buildOrphanRelease(sold.orphanShares, { entryId: 'rel00001', budgetId: 'budget', now: '2026-10-16T12:00:00Z' });
    check('release: a ledger entry, no YNAB transaction', [release.entry.kind, release.entry.status, release.entry.transactions.length, release.quotes.map(q => [q.goalId, q.quantity, q.cost])], ['release', 'applied', 0, [['g-bath', -10, -1000]]]);
    const afterRelease = planWith({ transactions: soldAll, goalQuotes: [...ledger, ...release.quotes] });
    check('no orphan left', afterRelease.orphanShares.length, 0);
    const rebought: Transaction[] = [...soldAll, { id: 't10', portfolioId: 'growth', brokerId: 'fin', ticker: 'WORLD', amount: 5, price: 120, date: '2026-10-17', direction: 'Buy' }];
    const back = planWith({ transactions: rebought, goalQuotes: [...ledger, ...release.quotes] });
    check('buying the ticker again does not hand it to the old goal', back.destinations.find(d => d.key === 'goal:g-bath')?.pieces.filter(p => p.ticker === 'WORLD').length ?? 0, 0);
    const writes = y.writes;
    const rb = await rollbackWriteEntry(y, release.entry, config, { report: () => {} });
    check('a release rolls back without touching YNAB', [rb.ok, rb.entry.status, y.writes === writes], [true, 'rolled-back', true]);
};

run().then(reassignments).then(revaluations).then(conversion).then(lifecycle).then(() => {
    if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
    console.log('\nAll checks passed');
});
