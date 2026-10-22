// Known-answer checks for the backup (JSON file and Azure blob): every synced
// state is carried, a restore round-trips it, and restoring an older backup
// into a tool that already holds data never wipes what the file does not carry.
// Run with: npx esbuild scripts/verify-backup-payload.ts --bundle --platform=node --format=esm | node --input-type=module
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
    BACKUP_STORAGE_KEYS,
    BACKUP_VERSION,
    backupStorageEntries,
    buildBackupData,
    parseBackupData,
    type BackupData,
} from '../src/utils/backupPayload';
import { decrypt, encrypt, type SyncPayload } from '../src/services/azureSync';
import { DEFAULT_YNAB_FUNDING_SETTINGS } from '../src/types';

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

// ── Fixtures ────────────────────────────────────────────────────────

// A tool full of data: every field non-empty, already in normalized shape.
const makeState = (tag: string): BackupData => ({
    transactions: [{ id: `t-${tag}`, ticker: 'VWCE', date: '2026-01-02', quantity: 3, price: 100, direction: 'Buy', brokerId: 'b1', portfolioId: 'p1' }],
    assetSettings: [{ ticker: 'VWCE', source: 'ETF', assetClass: 'Stock', assetSubClass: 'International', label: `asset-${tag}` }],
    portfolios: [{ id: 'p1', name: `Portfolio ${tag}`, order: 0 }],
    brokers: [{ id: 'b1', name: `Broker ${tag}` }],
    marketData: { VWCE: { price: 110, lastUpdated: `2026-02-0${tag === 'A' ? 1 : 2}` } },
    assetAllocationSettings: { portfolioTargets: {} },
    macroAllocations: { Stock: tag === 'A' ? 70 : 60 },
    goalAllocations: { Growth: 100 },
    goals: [{ id: `g-${tag}`, title: 'Growth' }],
    aggregateExcludedTickers: [`EXCL-${tag}`],
    goalModeTargets: { [`goal-${tag}`]: 50 },
    goalFlowPortfolioStates: { p1: tag === 'A' ? 'frozen' : 'ignored' },
    ynabMappings: [{ categoryId: `cat-${tag}`, target: { kind: 'portfolio', id: 'p1' } }],
    ynabFundingSettings: { ...DEFAULT_YNAB_FUNDING_SETTINGS },
    ynabAccountMappings: { b1: { budgetId: 'budget-1', accountId: `acc-${tag}` } },
    ynabGoals: [{ id: `yg-${tag}`, name: 'House' }],
    ynabGoalAllocations: [{ id: `ya-${tag}`, portfolioId: 'p1', ynabGoalId: `yg-${tag}`, amount: 1000 }],
    ynabMacroMappings: { groups: { [`grp-${tag}`]: 'Essentials' }, categories: { [`cat-${tag}`]: 'Leisure' } },
    ynabBudgetOwners: { 'budget-1': `person-${tag}` },
    ynabTrackingConfig: { brokerSources: { b1: `src-${tag}` }, destinationAccounts: { 'goal:g1': `dst-${tag}` }, guardBudgetId: 'budget-1', guardAccountIds: [`src-${tag}`] },
    ynabWriteLog: [{
        id: `w-${tag}`, kind: 'migration', budgetId: 'budget-1', brokerId: 'b1', label: 'Migration', date: '2026-03-01',
        createdAt: '2026-03-01T10:00:00Z', updatedAt: '2026-03-01T10:00:00Z', status: 'applied', createdAccounts: [], transactions: [],
    }],
    ynabGoalQuotes: [{ entryId: `w-${tag}`, goalId: 'g1', portfolioId: 'p1', brokerId: 'b1', ticker: 'VWCE', quantity: 2, cost: 200, frozenAt: '2026-03-01' }],
    operations: [{ id: `op-${tag}`, key: 'prices', kind: 'prices', title: 'Update prices', status: 'done', at: '2026-03-03T08:00:00Z', detail: '3 tickers refreshed' }],
    ynabGoalsGroupId: `group-${tag}`,
    ynabGoalsGroupName: `Goals ${tag}`,
    ynabLastGoalsSyncAt: '2026-03-02T09:00:00Z',
    virtualBonds: [{ id: `vb-${tag}`, name: 'BTP parked', amount: 5000 }],
    freeCommissionPeriods: [{ id: `fc-${tag}`, month: '2026-04', isins: ['IE00B4L5Y983'] }],
    plannedForecastExpenses: [{ id: `pe-${tag}`, name: 'Car', amount: 20000, date: '2028-01-01', enabled: true }],
    assetScope: { includeFamily: tag === 'A', includeIlliquid: true, excludedPersonIds: [] },
    people: [{ id: `person-${tag}`, name: `Person ${tag}` }],
    pacPlans: [{ id: `pac-${tag}`, ticker: 'VWCE', amount: 200 }],
    pacExecutions: [{ id: `pe-${tag}`, planId: `pac-${tag}`, dueDate: '2026-05-01', status: 'done' }],
} as unknown as BackupData);

// The JSON file exactly as the app writes it (TargetSettings.handleBackup).
const jsonFile = (state: BackupData) =>
    JSON.parse(JSON.stringify({ version: BACKUP_VERSION, timestamp: '2026-10-13T10:00:00Z', ...buildBackupData(state) }));

// A v6 file, as written before this fix: only these fields.
const V6_FIELDS = ['transactions', 'assetSettings', 'portfolios', 'brokers', 'marketData', 'assetAllocationSettings',
    'macroAllocations', 'goalAllocations', 'goals', 'freeCommissionPeriods', 'plannedForecastExpenses', 'people',
    'ynabAccountMappings', 'pacPlans', 'pacExecutions'] as const;
const v6File = (state: BackupData) => {
    const out: Record<string, unknown> = { version: 6, timestamp: '2025-12-01T10:00:00Z' };
    for (const f of V6_FIELDS) out[f] = (state as unknown as Record<string, unknown>)[f];
    return JSON.parse(JSON.stringify(out));
};

// localStorage as the app sees it, and the restore exactly as importData
// writes it (parseBackupData + backupStorageEntries).
type Store = Map<string, string>;
const storeFrom = (state: BackupData): Store => {
    const s: Store = new Map();
    for (const [field, key] of Object.entries(BACKUP_STORAGE_KEYS)) {
        s.set(key, JSON.stringify((state as unknown as Record<string, unknown>)[field]));
    }
    return s;
};
const restore = (store: Store, data: unknown, budgetId = 'budget-1') => {
    const parsed = parseBackupData(data, budgetId);
    for (const [, key, value] of backupStorageEntries(parsed)) store.set(key, JSON.stringify(value));
    return parsed;
};
const read = (store: Store, field: keyof typeof BACKUP_STORAGE_KEYS) => {
    const raw = store.get(BACKUP_STORAGE_KEYS[field]);
    return raw === undefined ? undefined : JSON.parse(raw);
};
const stored = Object.keys(BACKUP_STORAGE_KEYS) as (keyof typeof BACKUP_STORAGE_KEYS)[];

const A = makeState('A');
const B = makeState('B');

// ── 1. Every persisted state is either backed up or local-only on purpose ──

console.log('coverage of the persisted states');

const LOCAL_ONLY = new Set([
    'portfolio_targets_v2',               // legacy, migrated away
    'portfolio_price_history',            // own JSON export, MBs
    'portfolio_azure_config',             // credential
    'portfolio_premium_price_key',        // credential
    'portfolio_ynab_config',              // API key (goals-group fields travel separately)
    'portfolio_ynab_categories',          // snapshot, refetched from YNAB
    'portfolio_ynab_spending_history',    // rebuilt from YNAB with one sync
    'portfolio_risk_free_rate',           // per-device view preference
    'portfolio_broker_reserve_allocated_cash', // per-device view preference
]);
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(name) ? [p] : [];
});
const persistedKeys = new Set<string>();
for (const file of sourceFiles('src')) {
    for (const m of readFileSync(file, 'utf8').matchAll(/useLocalStorage<[\s\S]*?>\(\s*'([^']+)'/g)) persistedKeys.add(m[1]);
}
const backedUp = new Set<string>(Object.values(BACKUP_STORAGE_KEYS));
check('found the persisted states in the source', persistedKeys.size > 30, true);
check('every persisted state is backed up or listed as local-only',
    [...persistedKeys].filter(k => !backedUp.has(k) && !LOCAL_ONLY.has(k)), []);
check('every backed-up key is a real persisted state',
    [...backedUp].filter(k => !persistedKeys.has(k)), []);

// ── 2. The JSON file and the Azure blob carry the same data ──

console.log('\nJSON file vs Azure payload');

const built = buildBackupData(A);
check('the backup carries every restored field',
    [...stored, 'ynabGoalsGroupId', 'ynabGoalsGroupName', 'ynabLastGoalsSyncAt'].filter(f => !(f in built)), []);
const azure: SyncPayload = { syncVersion: 1, syncTimestamp: '2026-10-13T10:00:00Z', ...buildBackupData(A) };
const file = jsonFile(A);
const strip = (o: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
check('the JSON file holds exactly the Azure payload\'s data',
    strip(file, 'version', 'timestamp'), strip(JSON.parse(JSON.stringify(azure)), 'syncVersion', 'syncTimestamp'));
check('the JSON file is version 7', file.version, 7);

// ── 3. Round trip: what is backed up is what comes back ──

console.log('\nround trip');

const fresh: Store = new Map();
const parsedFull = restore(fresh, file);
for (const field of stored) check(`${field} restored on an empty device`, read(fresh, field), (A as unknown as Record<string, unknown>)[field]);
check('YNAB goals group travels', [parsedFull.ynabGoalsGroupId, parsedFull.ynabGoalsGroupName, parsedFull.ynabLastGoalsSyncAt],
    [A.ynabGoalsGroupId, A.ynabGoalsGroupName, A.ynabLastGoalsSyncAt]);

// The Azure path end to end: encrypt → decrypt → restore.
const blob = await encrypt(JSON.stringify(azure), 'correct horse battery staple');
const decrypted = JSON.parse(await decrypt(blob, 'correct horse battery staple'));
const viaAzure: Store = new Map();
restore(viaAzure, decrypted);
check('an encrypted Azure blob restores the same data as the JSON file',
    stored.map(f => read(viaAzure, f)), stored.map(f => read(fresh, f)));

// ── 4. A full backup replaces the data of a tool already in use ──

console.log('\nfull backup over existing data');

const inUse = storeFrom(A);
restore(inUse, jsonFile(B));
check('every field now holds the backup\'s value',
    stored.filter(f => JSON.stringify(read(inUse, f)) !== JSON.stringify((B as unknown as Record<string, unknown>)[f])), []);

// Empty lists in the backup are real values: they do empty the tool.
const emptied = storeFrom(A);
restore(emptied, jsonFile({ ...B, virtualBonds: [], ynabWriteLog: [], plannedForecastExpenses: null }));
check('an empty list in the backup empties the field', read(emptied, 'virtualBonds'), []);
check('an empty write log in the backup empties the log', read(emptied, 'ynabWriteLog'), []);
check('a never-seeded forecast plan (null) is restored as null', read(emptied, 'plannedForecastExpenses'), null);

// ── 5. An older backup never wipes what it does not carry ──

console.log('\nolder backups into a tool with data');

const oldInto = storeFrom(A);
const parsedV6 = restore(oldInto, v6File(B));
for (const f of V6_FIELDS) check(`v6 field ${f} is restored`, read(oldInto, f), (B as unknown as Record<string, unknown>)[f]);
const notInV6 = stored.filter(f => !(V6_FIELDS as readonly string[]).includes(f));
check('the v6 file leaves 15 fields to the tool', notInV6.length, 15);
for (const f of notInV6) check(`${f} keeps the local value`, read(oldInto, f), (A as unknown as Record<string, unknown>)[f]);
check('the local YNAB goals group is kept', [parsedV6.ynabGoalsGroupId, parsedV6.ynabGoalsGroupName], [undefined, undefined]);

// v5 account mappings held a bare account id: adopted by the configured budget.
const v5 = { ...v6File(B), version: 5, ynabAccountMappings: { b1: 'acc-legacy' } };
const v5Into = storeFrom(A);
restore(v5Into, v5, 'budget-9');
check('a v5 bare account id is attached to the configured budget', read(v5Into, 'ynabAccountMappings'), { b1: { budgetId: 'budget-9', accountId: 'acc-legacy' } });

// An Azure blob written by the first-upload path, which lacked the macro mappings.
const azureOld = JSON.parse(JSON.stringify({ syncVersion: 1, syncTimestamp: 'x', ...buildBackupData(B) }));
delete azureOld.ynabMacroMappings;
const azureOldInto = storeFrom(A);
restore(azureOldInto, azureOld);
check('an Azure blob without macro mappings keeps the local ones', read(azureOldInto, 'ynabMacroMappings'), A.ynabMacroMappings);
check('…and still restores everything else', read(azureOldInto, 'virtualBonds'), B.virtualBonds);

// The oldest shape: only transactions and assets.
const minimalInto = storeFrom(A);
restore(minimalInto, { transactions: B.transactions, assetSettings: B.assetSettings });
check('a minimal backup keeps the local virtual bonds', read(minimalInto, 'virtualBonds'), A.virtualBonds);
check('a minimal backup keeps the local YNAB write log', read(minimalInto, 'ynabWriteLog'), A.ynabWriteLog);

// ── 6. Malformed and invalid input ──

console.log('\nmalformed input');

const bad = { ...jsonFile(B), virtualBonds: 'oops', ynabMacroMappings: 42, assetScope: null, ynabFundingSettings: 'x', ynabWriteLog: [{ id: 1 }] };
const badParsed = parseBackupData(bad, 'budget-1');
check('a malformed list degrades to empty', badParsed.virtualBonds, []);
check('malformed macro mappings degrade to empty', badParsed.ynabMacroMappings, { groups: {}, categories: {} });
check('a null asset scope degrades to include-all', badParsed.assetScope, { includeFamily: true, includeIlliquid: true, excludedPersonIds: [] });
check('malformed funding settings degrade to the defaults', badParsed.ynabFundingSettings, DEFAULT_YNAB_FUNDING_SETTINGS);
check('malformed write-log entries are dropped', badParsed.ynabWriteLog, []);

const throws = (label: string, data: unknown) => {
    let threw = false;
    try { parseBackupData(data); } catch { threw = true; }
    check(label, threw, true);
};
throws('a file that is not a backup is refused', { hello: 'world' });
throws('a backup without assets is refused', { transactions: [] });
throws('null is refused', null);
const untouched = storeFrom(A);
try { restore(untouched, { foo: 1 }); } catch { /* refused before any write */ }
check('a refused file writes nothing', stored.map(f => read(untouched, f)), stored.map(f => read(storeFrom(A), f)));

if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll checks passed');
