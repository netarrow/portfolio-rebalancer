/**
 * YNAB write-back: the only place that writes to YNAB.
 *
 * Phase 3 writes one thing, the migration of ONE broker account: an optional
 * realignment of its balance, then one tracking-to-tracking transfer per
 * destination (🎯 goal, 🏦 portfolio …), creating the destination accounts that
 * do not exist yet. Three steps, kept apart so each can be reviewed:
 *
 *  1. buildMigrationPreview — pure: the exact operations, or the reasons they
 *     cannot run (blockers). Nothing is sent.
 *  2. executeMigration — re-reads YNAB, refuses if the source balance moved
 *     since the preview, checks every account against the write guard, then
 *     creates the accounts and the transactions. Each step is reported to the
 *     caller so the log is saved before and after every write.
 *  3. rollbackWriteEntry — deletes every transaction the entry created, both
 *     sides of each transfer. Accounts cannot be deleted through the API: the
 *     ones it created are left empty, for the person to close.
 *
 * Every transaction carries the [PRB] memo prefix, the purple flag and an
 * import id unique to the entry, so the tool's writes are easy to spot in YNAB
 * and a retried request can never book them twice.
 */
import type { YnabGoalQuote, YnabTrackingConfig, YnabWriteLogEntry, YnabWriteLogTransaction } from '../types';
import type { YnabAccountSummary, YnabApiResult, YnabFlagColor, YnabNewTransaction, YnabSavedTransaction } from '../services/ynabApi';
import type { TrackingAccountRef, TrackingPlan } from './ynabTrackingPlan';
import { checkYnabGuardBudget, checkYnabWriteTarget } from './ynabWriteGuard';

export const PRB_MEMO_PREFIX = '[PRB]';
export const PRB_FLAG: YnabFlagColor = 'purple';
export const PRB_PAYEE = 'Portfolio Rebalancer';
const MEMO_MAX = 500;
const PIECES_IN_MEMO = 3;

export const toMilliunits = (eur: number): number => Math.round(eur * 100) * 10;
const cents = (v: number): number => Math.round(v * 100) / 100;

/** `PRB:<8 chars of the entry>:<n>` — at most 36 characters, as YNAB requires. */
export const prbImportId = (entryId: string, seq: number): string =>
    `PRB:${entryId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}:${seq}`;

export interface MigrationTransferOp {
    destinationKey: string;
    accountName: string;
    /** Linked YNAB account; absent = the account is created first. */
    accountId?: string;
    amount: number;              // € leaving the broker account
    memo: string;
    importId: string;
}

export interface MigrationPreview {
    entryId: string;
    budgetId: string;
    brokerId: string;
    brokerName: string;
    date: string;
    source?: { accountId: string; name: string; balanceSeen: number };
    /** € booked on the source first so it matches the tool's value (0 = none). */
    realignment: number;
    realignMemo: string;
    realignImportId: string;
    createAccounts: { destinationKey: string; name: string }[];
    transfers: MigrationTransferOp[];
    staysInPlace: { destinationKey: string; accountName: string; amount: number }[];
    /** Goal shares of this broker's holdings, frozen in units on success. */
    quotes: Omit<YnabGoalQuote, 'entryId' | 'frozenAt'>[];
    /** Why it cannot run. Empty = ready. */
    blockers: string[];
}

export interface MigrationPreviewInput {
    plan: TrackingPlan;
    brokerId: string;
    /** Accounts of the budget, as just loaded (with transfer payees). */
    accounts: (TrackingAccountRef & { transferPayeeId?: string })[] | null;
    config: YnabTrackingConfig;
    budgetId: string;
    entryId: string;
    date: string;
    /** Names chosen in the preview for the accounts to create, by destination key. */
    nameOverrides?: Record<string, string>;
}

const qty = (q: number) => q.toLocaleString('en-US', { maximumFractionDigits: 4 });

export function buildMigrationPreview(input: MigrationPreviewInput): MigrationPreview {
    const { plan, brokerId, accounts, config, budgetId, entryId, date } = input;
    const blockers: string[] = [];
    const broker = plan.brokers.find(b => b.brokerId === brokerId);
    const migration = plan.migrations.find(m => m.brokerId === brokerId);
    const destinationByKey = new Map(plan.destinations.map(d => [d.key, d]));
    const accountById = new Map((accounts ?? []).map(a => [a.id, a]));

    const preview: MigrationPreview = {
        entryId, budgetId, brokerId,
        brokerName: broker?.name ?? brokerId,
        date,
        realignment: 0,
        realignMemo: `${PRB_MEMO_PREFIX} Riallineamento al valore del tool prima della migrazione`,
        realignImportId: prbImportId(entryId, 0),
        createAccounts: [],
        transfers: [],
        staysInPlace: [],
        quotes: [],
        blockers,
    };

    if (!accounts) blockers.push('YNAB accounts are not loaded.');
    const budgetVerdict = checkYnabGuardBudget(config, budgetId);
    if (!budgetVerdict.ok) blockers.push(budgetVerdict.message);
    if (!broker) { blockers.push('Broker not found.'); return preview; }
    if (!broker.included) blockers.push(`${broker.name} is excluded from the split.`);
    if (broker.migrated) blockers.push(`${broker.name} has already been migrated: roll that back first to migrate it again.`);
    if (!plan.balanced) blockers.push('The accounts by purpose do not add up to the invested value: fix the warnings first.');
    if (!migration || migration.transfers.length === 0) { blockers.push('Nothing to move out of this broker account.'); return preview; }

    const source = broker.sourceAccountId ? accountById.get(broker.sourceAccountId) : undefined;
    if (!broker.sourceAccountId) blockers.push(`${broker.name} has no YNAB account linked.`);
    else if (accounts && !source) blockers.push(`The YNAB account linked to ${broker.name} no longer exists.`);
    if (source) {
        preview.source = { accountId: source.id, name: source.name, balanceSeen: source.balance };
        const verdict = checkYnabWriteTarget(config, { budgetId, accountId: source.id, onBudget: source.onBudget, accountName: source.name });
        if (!verdict.ok) blockers.push(verdict.message);
        preview.realignment = cents(broker.expected - source.balance);
    }

    const existingNames = new Set((accounts ?? []).map(a => a.name.trim().toLowerCase()));
    const namesToCreate = new Set<string>();
    let seq = 1;
    for (const t of migration.transfers) {
        const d = destinationByKey.get(t.toKey);
        const name = d?.accountName ?? t.toKey;
        if (t.staysInPlace) {
            preview.staysInPlace.push({ destinationKey: t.toKey, accountName: source?.name ?? name, amount: t.amount });
            continue;
        }
        const linkedId = config.destinationAccounts[t.toKey];
        let accountName = name;
        if (linkedId) {
            const account = accountById.get(linkedId);
            if (accounts && !account) blockers.push(`The YNAB account linked to ${name} no longer exists.`);
            if (account) {
                accountName = account.name;
                const verdict = checkYnabWriteTarget(config, { budgetId, accountId: account.id, onBudget: account.onBudget, accountName: account.name });
                if (!verdict.ok) blockers.push(verdict.message);
                else if (!account.transferPayeeId) blockers.push(`YNAB gave no transfer payee for "${account.name}": reload the accounts.`);
            }
        } else {
            accountName = (input.nameOverrides?.[t.toKey] ?? name).trim();
            const lower = accountName.toLowerCase();
            if (!accountName) blockers.push(`The new account for ${name} needs a name.`);
            else if (existingNames.has(lower)) blockers.push(`An account named "${accountName}" already exists: link it instead of creating a new one.`);
            else if (namesToCreate.has(lower)) blockers.push(`Two new accounts would both be named "${accountName}".`);
            namesToCreate.add(lower);
            preview.createAccounts.push({ destinationKey: t.toKey, name: accountName });
        }
        const pieces = (d?.pieces ?? []).filter(p => p.brokerId === brokerId);
        const listed = pieces.slice(0, PIECES_IN_MEMO).map(p => `${p.label} ${qty(p.quantity)} q`);
        const more = pieces.length > PIECES_IN_MEMO ? ` +${pieces.length - PIECES_IN_MEMO}` : '';
        const memo = `${PRB_MEMO_PREFIX} Migrazione da ${source?.name ?? broker.name}${listed.length ? ` · ${listed.join(' · ')}${more}` : ''}`;
        preview.transfers.push({
            destinationKey: t.toKey,
            accountName,
            ...(linkedId ? { accountId: linkedId } : {}),
            amount: t.amount,
            memo: memo.length > MEMO_MAX ? `${memo.slice(0, MEMO_MAX - 1)}…` : memo,
            importId: prbImportId(entryId, seq++),
        });
    }

    // The goal shares this migration moves, frozen in units once it succeeds.
    for (const d of plan.destinations) {
        if (d.kind !== 'goal' || !d.goalId) continue;
        for (const p of d.pieces) {
            if (p.brokerId !== brokerId) continue;
            const [portfolioId] = p.holdingKey.split('|');
            preview.quotes.push({ goalId: d.goalId, portfolioId, brokerId, ticker: p.ticker, quantity: p.quantity, cost: p.cost });
        }
    }
    return preview;
}

// ── Execution ───────────────────────────────────────────────────────

/** The YNAB calls the engine needs, bound to one token and budget. */
export interface YnabWriteApi {
    listAccounts(): Promise<YnabApiResult<YnabAccountSummary[]>>;
    createTrackingAccount(name: string): Promise<YnabApiResult<YnabAccountSummary>>;
    createTransactions(transactions: YnabNewTransaction[]): Promise<YnabApiResult<{ transactions: YnabSavedTransaction[]; duplicateImportIds: string[] }>>;
    deleteTransaction(id: string): Promise<YnabApiResult<{ notFound: boolean }>>;
}

export interface ExecuteHooks {
    /** Called with every new state of the entry: persist it each time. */
    report: (entry: YnabWriteLogEntry) => void;
    /** A destination account was just created (to allow it in the guard and link it). */
    onAccountCreated?: (destinationKey: string, account: YnabAccountSummary) => void;
    now?: () => string;
}

const allowing = (config: YnabTrackingConfig, extra: string[]): YnabTrackingConfig =>
    ({ ...config, guardAccountIds: [...(config.guardAccountIds ?? []), ...extra] });

export async function executeMigration(
    api: YnabWriteApi,
    preview: MigrationPreview,
    config: YnabTrackingConfig,
    hooks: ExecuteHooks,
): Promise<{ ok: boolean; entry: YnabWriteLogEntry; error?: string }> {
    const now = hooks.now ?? (() => new Date().toISOString());
    let entry: YnabWriteLogEntry = {
        id: preview.entryId,
        kind: 'migration',
        budgetId: preview.budgetId,
        brokerId: preview.brokerId,
        label: `Migration of ${preview.brokerName}`,
        date: preview.date,
        createdAt: now(),
        updatedAt: now(),
        status: 'pending',
        createdAccounts: [],
        transactions: [],
    };
    const save = (patch: Partial<YnabWriteLogEntry>) => {
        entry = { ...entry, ...patch, updatedAt: now() };
        hooks.report(entry);
        return entry;
    };
    const fail = (error: string) => ({ ok: false, entry: save({ status: 'failed', error }), error });

    if (preview.blockers.length > 0) return fail(`Not ready: ${preview.blockers[0]}`);
    if (!preview.source) return fail('No source account.');
    save({});

    // 1. Fresh look at YNAB: nothing may have moved since the preview.
    const fresh = await api.listAccounts();
    if (!fresh.success || !fresh.data) return fail(fresh.error || 'Unable to re-read the YNAB accounts.');
    const accountById = new Map(fresh.data.map(a => [a.id, a]));
    const source = accountById.get(preview.source.accountId);
    if (!source) return fail(`"${preview.source.name}" is no longer in YNAB.`);
    if (Math.abs(source.balanceMilliunits / 1000 - preview.source.balanceSeen) >= 0.005) {
        return fail(`The balance of "${source.name}" changed since the preview: reload and check again.`);
    }
    const guardOk = (cfg: YnabTrackingConfig, a: YnabAccountSummary) =>
        checkYnabWriteTarget(cfg, { budgetId: preview.budgetId, accountId: a.id, onBudget: a.onBudget, accountName: a.name });
    const sourceVerdict = guardOk(config, source);
    if (!sourceVerdict.ok) return fail(sourceVerdict.message);

    const target = new Map<string, { accountId: string; transferPayeeId?: string }>();
    for (const t of preview.transfers) {
        if (!t.accountId) continue;
        const a = accountById.get(t.accountId);
        if (!a) return fail(`"${t.accountName}" is no longer in YNAB.`);
        const verdict = guardOk(config, a);
        if (!verdict.ok) return fail(verdict.message);
        target.set(t.destinationKey, { accountId: a.id, transferPayeeId: a.transferPayeeId });
    }
    const takenNames = new Set(fresh.data.map(a => a.name.trim().toLowerCase()));
    for (const c of preview.createAccounts) {
        if (takenNames.has(c.name.trim().toLowerCase())) return fail(`An account named "${c.name}" appeared in YNAB since the preview.`);
    }

    // 2. Accounts to create. Each is recorded as soon as it exists.
    let effective = config;
    for (const c of preview.createAccounts) {
        const created = await api.createTrackingAccount(c.name);
        if (!created.success || !created.data) return fail(created.error || `Unable to create "${c.name}".`);
        save({ createdAccounts: [...entry.createdAccounts, { id: created.data.id, name: created.data.name, destinationKey: c.destinationKey }] });
        effective = allowing(effective, [created.data.id]);
        hooks.onAccountCreated?.(c.destinationKey, created.data);
        target.set(c.destinationKey, { accountId: created.data.id, transferPayeeId: created.data.transferPayeeId });
    }

    // 3. The transactions, in one request.
    const transactions: YnabNewTransaction[] = [];
    const roles = new Map<string, Pick<YnabWriteLogTransaction, 'role' | 'destinationKey'>>();
    const common = { date: preview.date, cleared: 'cleared' as const, approved: true, flag_color: PRB_FLAG };
    if (Math.abs(preview.realignment) >= 0.01) {
        transactions.push({
            ...common,
            account_id: source.id,
            amount: toMilliunits(preview.realignment),
            payee_name: PRB_PAYEE,
            memo: preview.realignMemo,
            import_id: preview.realignImportId,
        });
        roles.set(preview.realignImportId, { role: 'realign' });
    }
    for (const t of preview.transfers) {
        const dest = target.get(t.destinationKey);
        if (!dest?.transferPayeeId) return fail(`No transfer payee for "${t.accountName}": reload the accounts.`);
        const destAccount = accountById.get(dest.accountId);
        if (destAccount) {
            const verdict = guardOk(effective, destAccount);
            if (!verdict.ok) return fail(verdict.message);
        } else if (!(effective.guardAccountIds ?? []).includes(dest.accountId)) {
            return fail(`"${t.accountName}" is not allowed by the write guard.`);
        }
        transactions.push({
            ...common,
            account_id: source.id,
            amount: -toMilliunits(t.amount),
            payee_id: dest.transferPayeeId,
            memo: t.memo,
            import_id: t.importId,
        });
        roles.set(t.importId, { role: 'transfer', destinationKey: t.destinationKey });
    }
    if (transactions.length === 0) return fail('Nothing to write.');

    const saved = await api.createTransactions(transactions);
    if (!saved.success || !saved.data) return fail(saved.error || 'YNAB refused the transactions.');
    const logged: YnabWriteLogTransaction[] = saved.data.transactions
        .filter(t => t.importId && roles.has(t.importId))
        .map(t => ({
            id: t.id,
            accountId: t.accountId,
            amount: t.amountMilliunits / 1000,
            importId: t.importId!,
            ...roles.get(t.importId!)!,
            ...(t.transferAccountId ? { transferAccountId: t.transferAccountId } : {}),
            ...(t.transferTransactionId ? { transferTransactionId: t.transferTransactionId } : {}),
        }));
    const missing = transactions.length - logged.length;
    save({
        transactions: logged,
        ...(saved.data.duplicateImportIds.length ? { duplicateImportIds: saved.data.duplicateImportIds } : {}),
        status: 'applied',
        ...(missing > 0 ? { error: `${missing} transaction(s) were not created by YNAB (duplicates).` } : {}),
    });
    return { ok: true, entry };
}

// ── Rollback ────────────────────────────────────────────────────────

export async function rollbackWriteEntry(
    api: YnabWriteApi,
    entry: YnabWriteLogEntry,
    config: YnabTrackingConfig,
    hooks: Pick<ExecuteHooks, 'report' | 'now'>,
): Promise<{ ok: boolean; entry: YnabWriteLogEntry; error?: string; accountsLeft: { id: string; name: string }[] }> {
    const now = hooks.now ?? (() => new Date().toISOString());
    let current = entry;
    const save = (patch: Partial<YnabWriteLogEntry>) => {
        current = { ...current, ...patch, updatedAt: now() };
        hooks.report(current);
        return current;
    };
    const accountsLeft = entry.createdAccounts.map(a => ({ id: a.id, name: a.name }));

    if (entry.status === 'rolled-back') return { ok: true, entry, accountsLeft };
    const budget = checkYnabGuardBudget(config, entry.budgetId);
    if (!budget.ok) return { ok: false, entry, error: budget.message, accountsLeft };
    // Accounts the entry created were allowed when they were made.
    const effective = allowing(config, entry.createdAccounts.map(a => a.id));
    for (const t of entry.transactions) {
        for (const accountId of [t.accountId, t.transferAccountId].filter((x): x is string => !!x)) {
            const verdict = checkYnabWriteTarget(effective, { budgetId: entry.budgetId, accountId });
            if (!verdict.ok) return { ok: false, entry, error: `${verdict.message} Allow it again to roll back.`, accountsLeft };
        }
    }

    const errors: string[] = [];
    const remaining: YnabWriteLogTransaction[] = [];
    for (const t of entry.transactions) {
        const res = await api.deleteTransaction(t.id);
        if (!res.success) { errors.push(res.error || `Unable to delete ${t.id}.`); remaining.push(t); continue; }
        if (t.transferTransactionId) {
            const other = await api.deleteTransaction(t.transferTransactionId);
            if (!other.success) { errors.push(other.error || `Unable to delete ${t.transferTransactionId}.`); remaining.push({ ...t, id: t.transferTransactionId, transferTransactionId: undefined }); }
        }
    }
    if (errors.length > 0) {
        save({ status: 'rollback-partial', transactions: remaining, error: errors.join(' ') });
        return { ok: false, entry: current, error: errors.join(' '), accountsLeft };
    }
    save({ status: 'rolled-back', rolledBackAt: now(), error: undefined });
    return { ok: true, entry: current, accountsLeft };
}

// ── Stored state ────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Reads a stored or imported log, dropping malformed entries. */
export function normalizeYnabWriteLog(raw: unknown): YnabWriteLogEntry[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is YnabWriteLogEntry =>
        isObj(e) && typeof e.id === 'string' && e.kind === 'migration' && typeof e.budgetId === 'string'
        && typeof e.brokerId === 'string' && typeof e.status === 'string'
        && Array.isArray(e.transactions) && Array.isArray(e.createdAccounts));
}

export function normalizeYnabGoalQuotes(raw: unknown): YnabGoalQuote[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((q): q is YnabGoalQuote =>
        isObj(q) && typeof q.entryId === 'string' && typeof q.goalId === 'string' && typeof q.portfolioId === 'string'
        && typeof q.brokerId === 'string' && typeof q.ticker === 'string'
        && typeof q.quantity === 'number' && Number.isFinite(q.quantity) && typeof q.cost === 'number');
}

/**
 * Brokers whose account a write-back has split and that is still in place in
 * this budget. A partial rollback still counts: something of it is in YNAB.
 */
export function migratedBrokerIds(log: YnabWriteLogEntry[], budgetId: string | undefined): string[] {
    return [...new Set(log
        .filter(e => e.budgetId === budgetId && e.kind === 'migration'
            && (e.status === 'applied' || e.status === 'rollback-partial'))
        .map(e => e.brokerId))];
}

/** Puts an entry in the log, replacing the one with the same id. Newest first. */
export const upsertWriteLogEntry = (log: YnabWriteLogEntry[], entry: YnabWriteLogEntry): YnabWriteLogEntry[] =>
    [entry, ...log.filter(e => e.id !== entry.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
