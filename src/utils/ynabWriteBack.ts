/**
 * YNAB write-back: the only place that writes to YNAB.
 *
 * Every account by purpose (🎯 goal, 🏦 portfolio, 🏛 pension) reads in three
 * parts: the transfers in and out, at cost basis (PMC); ONE cleared P/L line
 * (value − PMC); ONE uncleared latent-tax line. The two lines are created
 * once and then updated in place, so the account never fills with
 * revaluation rows.
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
import type { TrackingAccountRef, TrackingDestination, TrackingPlan } from './ynabTrackingPlan';
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
    amount: number;              // € leaving the broker account: the cost basis (PMC)
    value: number;               // market value of what moves
    memo: string;
    importId: string;
}

/** One of an account's own lines — P/L or latent tax — set to a new amount. */
export interface AccountLineOp {
    role: 'pl' | 'tax';
    destinationKey: string;
    accountName: string;
    /** Absent: the account is created by the same write. */
    accountId?: string;
    amount: number;              // the line's new amount
    previous: number;            // its amount today (0 = no line yet)
    existingId?: string;
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
    /**
     * The unrealised gains leave the broker account (−Σ value − PMC): they
     * move to the P/L lines of the accounts by purpose.
     */
    plMove: number;
    plMoveMemo: string;
    plMoveImportId: string;
    createAccounts: { destinationKey: string; name: string }[];
    transfers: MigrationTransferOp[];
    /** P/L and latent-tax lines the migration sets. */
    lines: AccountLineOp[];
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
    /** The write log: the P/L and tax lines already in YNAB. */
    log?: YnabWriteLogEntry[];
}

const holdsShares = (kind: string | undefined) => kind === 'goal' || kind === 'portfolio' || kind === 'pension';
const clip = (memo: string) => memo.length > MEMO_MAX ? `${memo.slice(0, MEMO_MAX - 1)}…` : memo;
const ddmmyyyy = (date: string) => date.split('-').reverse().join('/');
const plMemo = (date: string) => `${PRB_MEMO_PREFIX} P/L latente (valore − PMC) · ${ddmmyyyy(date)}`;
const taxMemo = (date: string) => `${PRB_MEMO_PREFIX} Tasse latenti su plusvalenza · ${ddmmyyyy(date)}`;

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
        plMove: 0,
        plMoveMemo: `${PRB_MEMO_PREFIX} Plusvalenze latenti spostate nelle righe P/L dei conti per scopo`,
        plMoveImportId: '',
        createAccounts: [],
        transfers: [],
        lines: [],
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
    const plLines = currentLines(input.log ?? [], budgetId, 'pl');
    const taxLines = currentLines(input.log ?? [], budgetId, 'tax');
    const lineTargets: { d: TrackingDestination; accountId?: string; accountName: string; gain: number; latentTax: number }[] = [];
    for (const t of migration.transfers) {
        const d = destinationByKey.get(t.toKey);
        const name = d?.accountName ?? t.toKey;
        if (t.staysInPlace) {
            preview.staysInPlace.push({ destinationKey: t.toKey, accountName: source?.name ?? name, amount: t.amount });
            if (d && holdsShares(d.kind)) lineTargets.push({ d, accountId: source?.id, accountName: source?.name ?? name, gain: t.amount - t.cost, latentTax: t.latentTax });
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
        const memo = `${PRB_MEMO_PREFIX} Migrazione al PMC da ${source?.name ?? broker.name}${listed.length ? ` · ${listed.join(' · ')}${more}` : ''}`;
        preview.transfers.push({
            destinationKey: t.toKey,
            accountName,
            ...(linkedId ? { accountId: linkedId } : {}),
            amount: t.cost,
            value: t.amount,
            memo: clip(memo),
            importId: prbImportId(entryId, seq++),
        });
        if (d && holdsShares(d.kind)) lineTargets.push({ d, accountId: linkedId, accountName, gain: t.amount - t.cost, latentTax: t.latentTax });
    }

    // The gains leave the broker account and land on each account's P/L
    // line; the latent tax on its tax line. A line already there (another
    // broker's migration) grows by this broker's part.
    preview.plMove = cents(-lineTargets.reduce((s, l) => s + l.gain, 0));
    if (Math.abs(preview.plMove) >= 0.01) preview.plMoveImportId = prbImportId(entryId, seq++);
    for (const l of lineTargets) {
        const pl = l.accountId ? plLines.get(l.accountId) : undefined;
        const tax = l.accountId ? taxLines.get(l.accountId) : undefined;
        const base = { destinationKey: l.d.key, accountName: l.accountName, ...(l.accountId ? { accountId: l.accountId } : {}) };
        const plTarget = cents((pl?.amount ?? 0) + l.gain);
        if (pl || Math.abs(plTarget) >= 0.01) {
            preview.lines.push({ ...base, role: 'pl', amount: plTarget, previous: pl?.amount ?? 0, ...(pl ? { existingId: pl.transactionId } : {}), memo: plMemo(date), importId: prbImportId(entryId, seq++) });
        }
        const taxTarget = cents((tax?.amount ?? 0) - l.latentTax);
        if (tax || Math.abs(taxTarget) >= 0.01) {
            preview.lines.push({ ...base, role: 'tax', amount: taxTarget, previous: tax?.amount ?? 0, ...(tax ? { existingId: tax.transactionId } : {}), memo: taxMemo(date), importId: prbImportId(entryId, seq++) });
        }
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
    updateTransaction(id: string, patch: { amount?: number; memo?: string; date?: string }): Promise<YnabApiResult<{ transaction?: YnabSavedTransaction; notFound: boolean }>>;
}

export interface ExecuteHooks {
    /** Called with every new state of the entry: persist it each time. */
    report: (entry: YnabWriteLogEntry) => void;
    /** A destination account was just created (to allow it in the guard and link it). */
    onAccountCreated?: (destinationKey: string, account: YnabAccountSummary) => void;
    now?: () => string;
}

/**
 * One write to YNAB, whatever it is for (a migration, a reassignment…): the
 * balances that must not have moved since the preview, the accounts to
 * create, and the transactions — balance adjustments and transfers between
 * tracking accounts. Every write goes through executeWritePlan.
 */
export type WriteOp =
    | { kind: 'adjust'; role?: 'realign' | 'revalue'; accountId: string; amount: number; memo: string; importId: string }
    /**
     * One of the account's own lines — its P/L (cleared) or latent tax
     * (uncleared) — set to `amount`: updated in place when it exists, created
     * otherwise, on a linked account or one this write creates.
     */
    | { kind: 'line'; role: 'pl' | 'tax'; accountId?: string; destinationKey?: string; amount: number; memo: string; importId: string; existingId?: string; previousAmount: number }
    | {
        kind: 'transfer';
        fromAccountId: string;
        /** A linked account, or a destination whose account is created first. */
        to: { destinationKey: string; accountId?: string; accountName: string };
        amount: number;          // € leaving fromAccountId
        memo: string;
        importId: string;
    };

export interface WritePlan {
    entryId: string;
    kind: YnabWriteLogEntry['kind'];
    budgetId: string;
    brokerId: string;            // '' when the write is not about one broker
    label: string;
    date: string;
    checks: { accountId: string; name: string; balanceSeen: number }[];
    createAccounts: { destinationKey: string; name: string }[];
    ops: WriteOp[];
    blockers: string[];
    /** A plan that legitimately writes nothing (a migration where everything stays put). */
    allowNoWrites?: boolean;
}

const allowing = (config: YnabTrackingConfig, extra: string[]): YnabTrackingConfig =>
    ({ ...config, guardAccountIds: [...(config.guardAccountIds ?? []), ...extra] });

export async function executeWritePlan(
    api: YnabWriteApi,
    plan: WritePlan,
    config: YnabTrackingConfig,
    hooks: ExecuteHooks,
): Promise<{ ok: boolean; entry: YnabWriteLogEntry; error?: string }> {
    const now = hooks.now ?? (() => new Date().toISOString());
    let entry: YnabWriteLogEntry = {
        id: plan.entryId,
        kind: plan.kind,
        budgetId: plan.budgetId,
        brokerId: plan.brokerId,
        label: plan.label,
        date: plan.date,
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

    if (plan.blockers.length > 0) return fail(`Not ready: ${plan.blockers[0]}`);
    if (plan.ops.length === 0 && !plan.allowNoWrites) return fail('Nothing to write.');
    save({});

    // 1. Fresh look at YNAB: nothing may have moved since the preview.
    const fresh = await api.listAccounts();
    if (!fresh.success || !fresh.data) return fail(fresh.error || 'Unable to re-read the YNAB accounts.');
    const accountById = new Map(fresh.data.map(a => [a.id, a]));
    for (const c of plan.checks) {
        const a = accountById.get(c.accountId);
        if (!a) return fail(`"${c.name}" is no longer in YNAB.`);
        if (Math.abs(a.balanceMilliunits / 1000 - c.balanceSeen) >= 0.005) {
            return fail(`The balance of "${a.name}" changed since the preview: reload and check again.`);
        }
    }
    const guardOk = (cfg: YnabTrackingConfig, a: YnabAccountSummary) =>
        checkYnabWriteTarget(cfg, { budgetId: plan.budgetId, accountId: a.id, onBudget: a.onBudget, accountName: a.name });
    // Every existing account the plan touches, before anything is written.
    const touched = new Set<string>();
    for (const op of plan.ops) {
        if (op.kind === 'transfer') { touched.add(op.fromAccountId); if (op.to.accountId) touched.add(op.to.accountId); }
        else if (op.accountId) touched.add(op.accountId);
        else if (op.kind === 'line' && op.existingId) return fail('A line to update has no account.');
    }
    for (const id of touched) {
        const a = accountById.get(id);
        if (!a) return fail('An account of this write is no longer in YNAB.');
        const verdict = guardOk(config, a);
        if (!verdict.ok) return fail(verdict.message);
    }
    const takenNames = new Set(fresh.data.map(a => a.name.trim().toLowerCase()));
    for (const c of plan.createAccounts) {
        if (takenNames.has(c.name.trim().toLowerCase())) return fail(`An account named "${c.name}" appeared in YNAB since the preview.`);
    }

    // 2. Accounts to create. Each is recorded as soon as it exists.
    const created = new Map<string, YnabAccountSummary>();
    for (const c of plan.createAccounts) {
        const res = await api.createTrackingAccount(c.name);
        if (!res.success || !res.data) return fail(res.error || `Unable to create "${c.name}".`);
        save({ createdAccounts: [...entry.createdAccounts, { id: res.data.id, name: res.data.name, destinationKey: c.destinationKey }] });
        hooks.onAccountCreated?.(c.destinationKey, res.data);
        created.set(c.destinationKey, res.data);
    }
    const effective = allowing(config, [...created.values()].map(a => a.id));

    // 3. The transactions, in one request.
    const transactions: YnabNewTransaction[] = [];
    const roles = new Map<string, Pick<YnabWriteLogTransaction, 'role' | 'destinationKey'>>();
    const common = { date: plan.date, cleared: 'cleared' as const, approved: true, flag_color: PRB_FLAG };
    const updates: (Extract<WriteOp, { kind: 'line' }> & { accountId: string })[] = [];
    for (const op of plan.ops) {
        if (op.kind === 'adjust') {
            if (Math.abs(op.amount) < 0.01) continue;
            transactions.push({ ...common, account_id: op.accountId, amount: toMilliunits(op.amount), payee_name: PRB_PAYEE, memo: op.memo, import_id: op.importId });
            roles.set(op.importId, { role: op.role ?? 'realign' });
            continue;
        }
        if (op.kind === 'line') {
            if (op.existingId) { updates.push({ ...op, accountId: op.accountId! }); continue; }
            if (Math.abs(op.amount) < 0.01) continue;
            const accountId = op.accountId ?? (op.destinationKey ? created.get(op.destinationKey)?.id : undefined);
            if (!accountId) return fail(`No account for the ${op.role === 'pl' ? 'P/L' : 'latent-tax'} line.`);
            transactions.push({ ...common, cleared: op.role === 'tax' ? 'uncleared' : 'cleared', account_id: accountId, amount: toMilliunits(op.amount), payee_name: PRB_PAYEE, memo: op.memo, import_id: op.importId });
            roles.set(op.importId, { role: op.role });
            continue;
        }
        const dest = op.to.accountId ? accountById.get(op.to.accountId) : created.get(op.to.destinationKey);
        if (!dest) return fail(`No account for "${op.to.accountName}".`);
        if (!guardOk(effective, dest).ok) return fail(`"${op.to.accountName}" is not allowed by the write guard.`);
        if (!dest.transferPayeeId) return fail(`No transfer payee for "${op.to.accountName}": reload the accounts.`);
        if (dest.id === op.fromAccountId) continue;
        transactions.push({ ...common, account_id: op.fromAccountId, amount: -toMilliunits(op.amount), payee_id: dest.transferPayeeId, memo: op.memo, import_id: op.importId });
        roles.set(op.importId, { role: 'transfer', destinationKey: op.to.destinationKey });
    }
    if (transactions.length === 0 && updates.length === 0) {
        if (plan.allowNoWrites) { save({ status: 'applied' }); return { ok: true, entry }; }
        return fail('Nothing to write.');
    }

    const saved = transactions.length > 0
        ? await api.createTransactions(transactions)
        : { success: true as const, data: { transactions: [] as YnabSavedTransaction[], duplicateImportIds: [] as string[] } };
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
    save({ transactions: logged });

    // 4. Lines updated in place (P/L, latent tax), one request each, each
    //    recorded with the amount it had so a rollback can put it back.
    for (const op of updates) {
        const what = op.role === 'pl' ? 'P/L' : 'latent-tax';
        const res = await api.updateTransaction(op.existingId!, { amount: toMilliunits(op.amount), memo: op.memo, date: plan.date });
        if (!res.success || !res.data) return fail(res.error || `YNAB refused to update the ${what} line.`);
        if (res.data.notFound) {
            // Deleted in YNAB meanwhile: open a new one instead.
            const made = await api.createTransactions([{ ...common, cleared: op.role === 'tax' ? 'uncleared' : 'cleared', account_id: op.accountId, amount: toMilliunits(op.amount), payee_name: PRB_PAYEE, memo: op.memo, import_id: op.importId }]);
            const t = made.success ? made.data?.transactions[0] : undefined;
            if (!t) return fail(made.error || `Unable to recreate the ${what} line.`);
            logged.push({ id: t.id, accountId: t.accountId, amount: t.amountMilliunits / 1000, importId: op.importId, role: op.role });
        } else {
            logged.push({ id: op.existingId!, accountId: op.accountId, amount: op.amount, importId: op.importId, role: op.role, previousAmount: op.previousAmount, updatedInPlace: true });
        }
        save({ transactions: [...logged] });
    }

    const missing = transactions.length - saved.data.transactions.filter(t => t.importId && roles.has(t.importId)).length;
    save({
        transactions: logged,
        ...(saved.data.duplicateImportIds.length ? { duplicateImportIds: saved.data.duplicateImportIds } : {}),
        status: 'applied',
        ...(missing > 0 ? { error: `${missing} transaction(s) were not created by YNAB (duplicates).` } : {}),
    });
    return { ok: true, entry };
}

const lineOp = (l: AccountLineOp): WriteOp => ({
    kind: 'line', role: l.role,
    ...(l.accountId ? { accountId: l.accountId } : { destinationKey: l.destinationKey }),
    amount: l.amount, memo: l.memo, importId: l.importId,
    ...(l.existingId ? { existingId: l.existingId } : {}),
    previousAmount: l.previous,
});

/** A migration preview as a write plan. */
export function migrationWritePlan(preview: MigrationPreview): WritePlan {
    const ops: WriteOp[] = [];
    const blockers = [...preview.blockers];
    if (!preview.source && blockers.length === 0) blockers.push('No source account.');
    if (preview.source) {
        if (Math.abs(preview.realignment) >= 0.01) {
            ops.push({ kind: 'adjust', accountId: preview.source.accountId, amount: preview.realignment, memo: preview.realignMemo, importId: preview.realignImportId });
        }
        if (Math.abs(preview.plMove) >= 0.01) {
            ops.push({ kind: 'adjust', accountId: preview.source.accountId, amount: preview.plMove, memo: preview.plMoveMemo, importId: preview.plMoveImportId });
        }
        for (const t of preview.transfers) {
            ops.push({
                kind: 'transfer',
                fromAccountId: preview.source.accountId,
                to: { destinationKey: t.destinationKey, accountId: t.accountId, accountName: t.accountName },
                amount: t.amount,
                memo: t.memo,
                importId: t.importId,
            });
        }
        ops.push(...preview.lines.map(lineOp));
    }
    return {
        entryId: preview.entryId,
        kind: 'migration',
        budgetId: preview.budgetId,
        brokerId: preview.brokerId,
        label: `Migration of ${preview.brokerName}`,
        date: preview.date,
        checks: preview.source ? [{ accountId: preview.source.accountId, name: preview.source.name, balanceSeen: preview.source.balanceSeen }] : [],
        createAccounts: preview.createAccounts,
        ops,
        blockers,
        // A pension fund that simply stays where it is: nothing to write, but
        // the broker still counts as migrated so its account can be revalued.
        allowNoWrites: preview.transfers.length === 0 && preview.staysInPlace.length > 0,
    };
}

export const executeMigration = (api: YnabWriteApi, preview: MigrationPreview, config: YnabTrackingConfig, hooks: ExecuteHooks) =>
    executeWritePlan(api, migrationWritePlan(preview), config, hooks);

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
    for (const t of [...entry.transactions].reverse()) {
        if (t.updatedInPlace) {
            // A line this write only updated (the latent tax): put its amount back.
            const back = await api.updateTransaction(t.id, { amount: toMilliunits(t.previousAmount ?? 0) });
            if (!back.success) { errors.push(back.error || `Unable to restore ${t.id}.`); remaining.push(t); }
            continue;
        }
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
        isObj(e) && typeof e.id === 'string' && (e.kind === 'migration' || e.kind === 'reassignment' || e.kind === 'revaluation' || e.kind === 'release') && typeof e.budgetId === 'string'
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


/** Accounts an entry wrote to (both sides of every transfer). */
export const entryAccounts = (e: YnabWriteLogEntry): Set<string> =>
    new Set(e.transactions.flatMap(t => [t.accountId, t.transferAccountId].filter((x): x is string => !!x)));

/**
 * Later writes that must be rolled back before this one: a newer entry, still
 * in place, that touched one of the same accounts. Undoing in the opposite
 * order would leave YNAB and the frozen shares out of step.
 */
export function rollbackDependents(log: YnabWriteLogEntry[], entryId: string): YnabWriteLogEntry[] {
    const entry = log.find(e => e.id === entryId);
    if (!entry) return [];
    const mine = entryAccounts(entry);
    return log.filter(e => e.id !== entryId && e.createdAt > entry.createdAt
        && (e.status === 'applied' || e.status === 'rollback-partial')
        && [...entryAccounts(e)].some(id => mine.has(id)));
}

// ── Reassignment ────────────────────────────────────────────────────
// Moves goal shares between accounts by purpose once a broker is migrated:
// "from portfolio X to goal Y", "from goal A to goal B", "from goal A back to
// its portfolio". Units move, not euros: the receiving account takes the
// holdings with their own cost basis, so gains, losses and latent tax follow.
// Only holdings at migrated brokers move this way — elsewhere the goal
// allocations still decide, and the migration will carry them over.

export interface ReassignmentPreview {
    entryId: string;
    budgetId: string;
    date: string;
    from: { destinationKey: string; accountName: string; accountId?: string; balanceSeen?: number };
    to: { destinationKey: string; accountName: string; accountId?: string };
    /** € moved, at today's prices. */
    amount: number;
    /** Their cost basis (PMC): what the YNAB transfer carries. */
    cost: number;
    /** The slices of holdings that move, in units. */
    pieces: { holdingKey: string; brokerId: string; ticker: string; label: string; quantity: number; value: number; cost: number; latentTax: number }[];
    /** The P/L and latent-tax lines of both accounts, following the shares. */
    lines: AccountLineOp[];
    /** Blockers that a revaluation clears (an account off its PMC in YNAB). */
    unaligned: string[];
    memo: string;
    importId: string;
    createAccounts: { destinationKey: string; name: string }[];
    /** Movements of the goal-share ledger, booked on success. */
    quotes: Omit<YnabGoalQuote, 'entryId' | 'frozenAt'>[];
    blockers: string[];
}

export interface ReassignmentInput {
    plan: TrackingPlan;
    fromKey: string;
    toKey: string;
    /** € to move; capped by nothing — more than is available is a blocker. */
    amount: number;
    accounts: (TrackingAccountRef & { transferPayeeId?: string })[] | null;
    config: YnabTrackingConfig;
    budgetId: string;
    entryId: string;
    date: string;
    /** Name of the target account when it has to be created. */
    newAccountName?: string;
    /** The write log: the P/L and tax lines already in YNAB. */
    log?: YnabWriteLogEntry[];
}

export function buildReassignmentPreview(input: ReassignmentInput): ReassignmentPreview {
    const { plan, fromKey, toKey, accounts, config, budgetId, entryId, date } = input;
    const blockers: string[] = [];
    const from = plan.destinations.find(d => d.key === fromKey);
    const to = plan.destinations.find(d => d.key === toKey);
    const accountById = new Map((accounts ?? []).map(a => [a.id, a]));
    const migrated = new Set(plan.brokers.filter(b => b.migrated).map(b => b.brokerId));
    const preview: ReassignmentPreview = {
        entryId, budgetId, date,
        from: { destinationKey: fromKey, accountName: from?.accountName ?? fromKey },
        to: { destinationKey: toKey, accountName: to?.accountName ?? toKey },
        amount: 0, cost: 0, pieces: [], lines: [], unaligned: [], memo: '', importId: prbImportId(entryId, 1),
        createAccounts: [], quotes: [], blockers,
    };

    if (!accounts) blockers.push('YNAB accounts are not loaded.');
    const budgetVerdict = checkYnabGuardBudget(config, budgetId);
    if (!budgetVerdict.ok) blockers.push(budgetVerdict.message);
    if (!from) { blockers.push('The account to move from is not in the plan.'); return preview; }
    if (!to) { blockers.push('The account to move to is not in the plan: give the goal an allocation first.'); return preview; }
    const sharesKind = (k: string) => k === 'goal' ? 'goal' : (k === 'portfolio' || k === 'pension') ? 'portfolio' : null;
    const fromKind = sharesKind(from.kind);
    const toKind = sharesKind(to.kind);
    if (!fromKind || !toKind) { blockers.push('Only goal and portfolio accounts hold shares that can be reassigned.'); return preview; }
    if (fromKey === toKey) blockers.push('Pick two different accounts.');
    if (fromKind === 'portfolio' && toKind === 'portfolio') blockers.push('Holdings belong to their own portfolio: move them to a goal instead.');

    const available = from.pieces.filter(p => migrated.has(p.brokerId));
    const availableValue = available.reduce((s, p) => s + p.value, 0);
    if (available.length === 0) {
        blockers.push(`${from.accountName} holds nothing at a migrated broker yet: change the goal allocations instead, the migration will follow them.`);
        return preview;
    }
    const amount = cents(input.amount);
    if (!(amount > 0)) blockers.push('Enter an amount to move.');
    else if (amount > availableValue + 0.005) blockers.push(`${from.accountName} holds ${cents(availableValue)} € at migrated brokers: move at most that.`);
    const share = availableValue > 0 ? Math.min(1, amount / availableValue) : 0;
    preview.amount = amount;
    preview.pieces = available.map(p => ({
        holdingKey: p.holdingKey, brokerId: p.brokerId, ticker: p.ticker, label: p.label,
        quantity: p.quantity * share, value: p.value * share, cost: p.cost * share, latentTax: p.latentTax * share,
    })).filter(p => p.quantity > 1e-9);

    // Units can only go back to the portfolio that holds them.
    if (toKind === 'portfolio') {
        const members = new Set(to.memberIds ?? []);
        for (const p of preview.pieces) {
            const [portfolioId] = p.holdingKey.split('|');
            if (!members.has(portfolioId)) {
                blockers.push(`${p.label} is not held by ${to.accountName}: it can only go back to its own portfolio.`);
                break;
            }
        }
    }

    // Ledger movements.
    for (const p of preview.pieces) {
        const [portfolioId, brokerId, ticker] = p.holdingKey.split('|');
        if (fromKind === 'goal' && from.goalId) preview.quotes.push({ goalId: from.goalId, portfolioId, brokerId, ticker, quantity: -p.quantity, cost: -p.cost });
        if (toKind === 'goal' && to.goalId) preview.quotes.push({ goalId: to.goalId, portfolioId, brokerId, ticker, quantity: p.quantity, cost: p.cost });
    }

    // Accounts: the source exists (it was filled by the migration); the target
    // may have to be created.
    const fromAccount = from.accountId ? accountById.get(from.accountId) : undefined;
    if (!fromAccount) blockers.push(`${from.accountName} has no YNAB account linked.`);
    else {
        preview.from = { ...preview.from, accountId: fromAccount.id, accountName: fromAccount.name, balanceSeen: fromAccount.balance };
        const v = checkYnabWriteTarget(config, { budgetId, accountId: fromAccount.id, onBudget: fromAccount.onBudget, accountName: fromAccount.name });
        if (!v.ok) blockers.push(v.message);
    }
    const toAccount = to.accountId ? accountById.get(to.accountId) : undefined;
    if (to.accountId && accounts && !toAccount) blockers.push(`The YNAB account linked to ${to.accountName} no longer exists.`);
    if (toAccount) {
        preview.to = { ...preview.to, accountId: toAccount.id, accountName: toAccount.name };
        const v = checkYnabWriteTarget(config, { budgetId, accountId: toAccount.id, onBudget: toAccount.onBudget, accountName: toAccount.name });
        if (!v.ok) blockers.push(v.message);
        else if (!toAccount.transferPayeeId) blockers.push(`YNAB gave no transfer payee for "${toAccount.name}": reload the accounts.`);
    } else if (!to.accountId) {
        const name = (input.newAccountName ?? to.accountName).trim();
        if (!name) blockers.push('The new account needs a name.');
        else if ((accounts ?? []).some(a => a.name.trim().toLowerCase() === name.toLowerCase())) blockers.push(`An account named "${name}" already exists: link it instead of creating a new one.`);
        preview.to.accountName = name;
        preview.createAccounts.push({ destinationKey: toKey, name });
    }

    // The transfer carries the PMC; each side's P/L and tax lines follow the
    // shares. Both accounts must already hold their PMC in YNAB, or the new
    // lines would hide the gap: a revaluation aligns them first.
    const moved = preview.pieces.reduce((m, p) => ({ value: m.value + p.value, cost: m.cost + p.cost, tax: m.tax + p.latentTax }), { value: 0, cost: 0, tax: 0 });
    preview.cost = cents(moved.cost);
    const plLines = currentPlLines(input.log ?? [], budgetId);
    const taxLines = currentTaxLines(input.log ?? [], budgetId);
    let seq = 2;
    const side = (d: TrackingDestination, accountId: string | undefined, accountName: string, sign: 1 | -1) => {
        const pl = accountId ? plLines.get(accountId) : undefined;
        const tax = accountId ? taxLines.get(accountId) : undefined;
        const account = accountId ? accountById.get(accountId) : undefined;
        if (account) {
            const gap = cents(account.balance - (pl?.amount ?? 0) - (tax?.amount ?? 0) - d.migratedCost);
            if (Math.abs(gap) >= 1) {
                const message = `${accountName} does not match its cost basis in YNAB (${gap > 0 ? '+' : ''}${gap} €): revalue it first.`;
                blockers.push(message);
                preview.unaligned.push(message);
            }
        }
        const base = { destinationKey: d.key, accountName, ...(accountId ? { accountId } : {}) };
        const plTarget = cents(d.migratedValue + sign * moved.value - (d.migratedCost + sign * moved.cost));
        if (pl ? Math.abs(plTarget - pl.amount) >= 0.01 : Math.abs(plTarget) >= 0.01) {
            preview.lines.push({ ...base, role: 'pl', amount: plTarget, previous: pl?.amount ?? 0, ...(pl ? { existingId: pl.transactionId } : {}), memo: plMemo(date), importId: prbImportId(entryId, seq++) });
        }
        const taxTarget = cents(-(d.migratedLatentTax + sign * moved.tax));
        if (tax ? Math.abs(taxTarget - tax.amount) >= 0.01 : Math.abs(taxTarget) >= 0.01) {
            preview.lines.push({ ...base, role: 'tax', amount: taxTarget, previous: tax?.amount ?? 0, ...(tax ? { existingId: tax.transactionId } : {}), memo: taxMemo(date), importId: prbImportId(entryId, seq++) });
        }
    };
    if (preview.pieces.length > 0) {
        side(from, preview.from.accountId, preview.from.accountName, -1);
        side(to, preview.to.accountId, preview.to.accountName, 1);
    }

    const listed = preview.pieces.slice(0, PIECES_IN_MEMO).map(p => `${p.label} ${qty(p.quantity)} q`);
    const more = preview.pieces.length > PIECES_IN_MEMO ? ` +${preview.pieces.length - PIECES_IN_MEMO}` : '';
    const memo = `${PRB_MEMO_PREFIX} Riassegnazione al PMC da ${preview.from.accountName}${listed.length ? ` · ${listed.join(' · ')}${more}` : ''}`;
    preview.memo = memo.length > MEMO_MAX ? `${memo.slice(0, MEMO_MAX - 1)}…` : memo;
    return preview;
}

/** A reassignment preview as a write plan: one transfer between two tracking accounts. */
export function reassignmentWritePlan(preview: ReassignmentPreview): WritePlan {
    const blockers = [...preview.blockers];
    const ops: WriteOp[] = [];
    if (preview.from.accountId) {
        ops.push({
            kind: 'transfer',
            fromAccountId: preview.from.accountId,
            to: { destinationKey: preview.to.destinationKey, accountId: preview.to.accountId, accountName: preview.to.accountName },
            amount: preview.cost,
            memo: preview.memo,
            importId: preview.importId,
        });
        ops.push(...preview.lines.map(lineOp));
    } else if (blockers.length === 0) blockers.push('No account to move from.');
    return {
        entryId: preview.entryId,
        kind: 'reassignment',
        budgetId: preview.budgetId,
        brokerId: '',
        label: `Reassignment: ${preview.from.accountName} → ${preview.to.accountName}`,
        date: preview.date,
        checks: preview.from.accountId && preview.from.balanceSeen !== undefined
            ? [{ accountId: preview.from.accountId, name: preview.from.accountName, balanceSeen: preview.from.balanceSeen }]
            : [],
        createAccounts: preview.createAccounts,
        ops,
        blockers,
    };
}

export const executeReassignment = (api: YnabWriteApi, preview: ReassignmentPreview, config: YnabTrackingConfig, hooks: ExecuteHooks) =>
    executeWritePlan(api, reassignmentWritePlan(preview), config, hooks);

export interface ReassignmentSuggestion {
    fromKey: string;
    toKey: string;
    amount: number;
}

/**
 * The moves that would bring the accounts by purpose back to what the goal
 * allocations ask, once brokers are migrated: accounts holding more than
 * asked give to accounts holding less, largest gaps first. Pairs the engine
 * would refuse (portfolio → portfolio, a holding going back to a portfolio
 * that does not hold it) are left out by checking each one.
 */
export function suggestReassignments(
    plan: TrackingPlan,
    check?: (s: ReassignmentSuggestion) => boolean,
): ReassignmentSuggestion[] {
    const holdsShares = (k: string) => k === 'goal' || k === 'portfolio' || k === 'pension';
    const migrated = new Set(plan.brokers.filter(b => b.migrated).map(b => b.brokerId));
    const movable = (key: string) => plan.destinations.find(d => d.key === key)?.pieces
        .filter(p => migrated.has(p.brokerId)).reduce((s, p) => s + p.value, 0) ?? 0;
    const surplus = plan.destinations
        .filter(d => holdsShares(d.kind) && d.value - d.desiredValue >= 1)
        .map(d => ({ key: d.key, kind: d.kind, left: Math.min(d.value - d.desiredValue, movable(d.key)) }))
        .filter(x => x.left >= 1)
        .sort((a, b) => b.left - a.left);
    const deficit = plan.destinations
        .filter(d => holdsShares(d.kind) && d.desiredValue - d.value >= 1)
        .map(d => ({ key: d.key, kind: d.kind, left: d.desiredValue - d.value }))
        .sort((a, b) => b.left - a.left);
    const out: ReassignmentSuggestion[] = [];
    for (const s of surplus) {
        for (const d of deficit) {
            if (s.left < 1) break;
            if (d.left < 1) continue;
            if (s.kind !== 'goal' && d.kind !== 'goal') continue; // portfolio → portfolio
            const suggestion = { fromKey: s.key, toKey: d.key, amount: cents(Math.min(s.left, d.left)) };
            if (check && !check(suggestion)) continue;
            out.push(suggestion);
            s.left -= suggestion.amount;
            d.left -= suggestion.amount;
        }
    }
    return out;
}

// ── Revaluation ─────────────────────────────────────────────────────
// After a price update, brings each account by purpose to the value of what
// it holds by updating its two lines in place: the P/L (cleared, value − PMC)
// and the latent tax (uncleared). When the PMC in YNAB no longer matches the
// shares held (a purchase, a sale, a manual transfer) one cleared alignment
// line closes the gap. The cleared balance reads the gross value, the
// working balance the net one.

/**
 * The P/L or latent-tax line of each account, as the last write still in
 * place left it: the newest applied entry that wrote one wins.
 */
export function currentLines(log: YnabWriteLogEntry[], budgetId: string | undefined, role: 'pl' | 'tax'): Map<string, { transactionId: string; amount: number }> {
    const out = new Map<string, { transactionId: string; amount: number }>();
    const live = log
        .filter(e => e.budgetId === budgetId && (e.status === 'applied' || e.status === 'rollback-partial'))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const e of live) for (const t of e.transactions) {
        if (t.role === role) out.set(t.accountId, { transactionId: t.id, amount: t.amount });
    }
    return out;
}

export const currentTaxLines = (log: YnabWriteLogEntry[], budgetId: string | undefined) => currentLines(log, budgetId, 'tax');
export const currentPlLines = (log: YnabWriteLogEntry[], budgetId: string | undefined) => currentLines(log, budgetId, 'pl');

export interface RevaluationAccount {
    destinationKey: string;
    accountId: string;
    accountName: string;
    /** Gross value of what the account holds in YNAB (migrated shares). */
    value: number;
    /** Their cost basis (PMC). */
    cost: number;
    latentTax: number;
    balanceSeen: number;          // working balance read for the preview
    plSeen: number;               // the tool's P/L line in it today
    taxSeen: number;              // the tool's latent-tax line in it (≤ 0)
    /** The account without its P/L and tax lines: the PMC it holds in YNAB. */
    costSeen: number;
    /** cost − costSeen: booked (cleared) only when a purchase, sale or transfer left them apart. */
    costAdjust: number;
    /** The P/L line becomes value − cost. */
    plTarget: number;
    /** The tax line becomes −latentTax. */
    taxTarget: number;
    /** Total change of the cleared balance: value − (balance − tax line). */
    delta: number;
    plLineId?: string;
    taxLineId?: string;
    costMemo: string;
    plMemo: string;
    taxMemo: string;
    importId: string;
    plImportId: string;
    taxImportId: string;
    /**
     * The account has no P/L line yet but its transfers carried market value
     * (migrated before P/L lines existed): the gain moves out of the PMC into
     * the new line. Expected once, not suspicious.
     */
    conversion: boolean;
    /** The PMC moved more than a price move would explain: a transfer may be missing. Unticked by default. */
    suspicious: boolean;
    blocked?: string;
}

export interface RevaluationPreview {
    entryId: string;
    budgetId: string;
    date: string;
    accounts: RevaluationAccount[];
    blockers: string[];
}

export interface RevaluationInput {
    plan: TrackingPlan;
    accounts: (TrackingAccountRef & { transferPayeeId?: string })[] | null;
    config: YnabTrackingConfig;
    budgetId: string;
    entryId: string;
    date: string;
    log: YnabWriteLogEntry[];
}

const eu = (v: number, digits = 2) => v.toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function buildRevaluationPreview(input: RevaluationInput): RevaluationPreview {
    const { plan, accounts, config, budgetId, entryId, date, log } = input;
    const blockers: string[] = [];
    const preview: RevaluationPreview = { entryId, budgetId, date, accounts: [], blockers };
    if (!accounts) blockers.push('YNAB accounts are not loaded.');
    const budgetVerdict = checkYnabGuardBudget(config, budgetId);
    if (!budgetVerdict.ok) blockers.push(budgetVerdict.message);
    if (!plan.brokers.some(b => b.migrated)) blockers.push('Nothing is migrated yet: there is nothing in YNAB to revalue.');
    if (blockers.length > 0) return preview;

    const accountById = new Map((accounts ?? []).map(a => [a.id, a]));
    const taxLines = currentTaxLines(log, budgetId);
    const plLines = currentPlLines(log, budgetId);
    const migrated = new Set(plan.brokers.filter(b => b.migrated).map(b => b.brokerId));
    const dd = ddmmyyyy(date);
    let seq = 1;
    for (const d of plan.destinations) {
        if (!holdsShares(d.kind)) continue;
        if (!d.accountId) continue;
        const account = accountById.get(d.accountId);
        const tax = taxLines.get(d.accountId);
        const pl = plLines.get(d.accountId);
        if (!account || (!(d.migratedValue > 0) && !tax && !pl)) continue;
        const taxSeen = tax?.amount ?? 0;
        const plSeen = pl?.amount ?? 0;
        const costSeen = cents(account.balance - taxSeen - plSeen);
        const costAdjust = cents(d.migratedCost - costSeen);
        const plTarget = cents(d.migratedValue - d.migratedCost);
        const taxTarget = cents(-d.migratedLatentTax);
        if (Math.abs(costAdjust) < 0.01 && Math.abs(plTarget - plSeen) < 0.01 && Math.abs(taxTarget - taxSeen) < 0.01) continue;
        const delta = cents(costAdjust + plTarget - plSeen);
        const verdict = checkYnabWriteTarget(config, { budgetId, accountId: account.id, onBudget: account.onBudget, accountName: account.name });
        const pieces = d.pieces.filter(p => migrated.has(p.brokerId));
        const listed = pieces.slice(0, PIECES_IN_MEMO).map(p => `${p.label} ${qty(p.quantity)} q @ ${eu(p.value / p.quantity)}`);
        const more = pieces.length > PIECES_IN_MEMO ? ` +${pieces.length - PIECES_IN_MEMO}` : '';
        // Market moves rarely shift an account by more than a tenth in one go.
        const tolerance = Math.max(50, Math.abs(d.migratedValue) * 0.1);
        const conversion = !pl && Math.abs(costAdjust) >= 0.01 && Math.abs(delta) <= tolerance;
        preview.accounts.push({
            destinationKey: d.key,
            accountId: account.id,
            accountName: account.name,
            value: d.migratedValue,
            cost: d.migratedCost,
            latentTax: d.migratedLatentTax,
            balanceSeen: account.balance,
            plSeen,
            taxSeen,
            costSeen,
            costAdjust,
            plTarget,
            taxTarget,
            delta,
            ...(pl ? { plLineId: pl.transactionId } : {}),
            ...(tax ? { taxLineId: tax.transactionId } : {}),
            costMemo: conversion
                ? `${PRB_MEMO_PREFIX} Riclassifica: la plusvalenza passa dal PMC alla riga P/L · ${dd}`
                : `${PRB_MEMO_PREFIX} Allineamento al PMC (acquisti, vendite o trasferimenti) · ${dd}`,
            plMemo: clip(`${plMemo(date)}${listed.length ? ` · ${listed.join(' · ')}${more}` : ''}`),
            taxMemo: taxMemo(date),
            importId: prbImportId(entryId, seq++),
            plImportId: prbImportId(entryId, seq++),
            taxImportId: prbImportId(entryId, seq++),
            conversion,
            suspicious: !conversion && Math.abs(costAdjust) > tolerance,
            ...(!verdict.ok ? { blocked: verdict.message } : {}),
        });
    }
    if (preview.accounts.length === 0) blockers.push('Every account is already at its value: nothing to revalue.');
    return preview;
}

/** The accounts picked in the preview, as a write plan. */
export function revaluationWritePlan(preview: RevaluationPreview, selected: Set<string>): WritePlan {
    const blockers = [...preview.blockers];
    const ops: WriteOp[] = [];
    const picked = preview.accounts.filter(a => selected.has(a.destinationKey) && !a.blocked);
    if (picked.length === 0 && blockers.length === 0) blockers.push('Tick at least one account.');
    for (const a of picked) {
        if (Math.abs(a.costAdjust) >= 0.01) ops.push({ kind: 'adjust', role: 'revalue', accountId: a.accountId, amount: a.costAdjust, memo: a.costMemo, importId: a.importId });
        // The P/L line is rewritten even when unchanged in amount, so its memo carries today's prices.
        if (a.plLineId || Math.abs(a.plTarget) >= 0.01) {
            ops.push({ kind: 'line', role: 'pl', accountId: a.accountId, amount: a.plTarget, memo: a.plMemo, importId: a.plImportId, existingId: a.plLineId, previousAmount: a.plSeen });
        }
        if (Math.abs(a.taxTarget - a.taxSeen) >= 0.01) {
            ops.push({ kind: 'line', role: 'tax', accountId: a.accountId, amount: a.taxTarget, memo: a.taxMemo, importId: a.taxImportId, existingId: a.taxLineId, previousAmount: a.taxSeen });
        }
    }
    return {
        entryId: preview.entryId,
        kind: 'revaluation',
        budgetId: preview.budgetId,
        brokerId: '',
        label: `Revaluation of ${picked.length} account${picked.length === 1 ? '' : 's'}`,
        date: preview.date,
        checks: picked.map(a => ({ accountId: a.accountId, name: a.accountName, balanceSeen: a.balanceSeen })),
        createAccounts: [],
        ops,
        blockers,
    };
}

export const executeRevaluation = (api: YnabWriteApi, preview: RevaluationPreview, selected: Set<string>, config: YnabTrackingConfig, hooks: ExecuteHooks) =>
    executeWritePlan(api, revaluationWritePlan(preview, selected), config, hooks);


// ── Release of orphan shares ────────────────────────────────────────

/** Total units a goal holds in the ledger, all holdings together. */
export const goalHeldUnits = (ledger: YnabGoalQuote[], goalId: string): number =>
    ledger.filter(q => q.goalId === goalId).reduce((s, q) => s + q.quantity, 0);

/** Goals that still hold frozen shares. */
export const goalsHoldingShares = (ledger: YnabGoalQuote[]): Set<string> => {
    const units = new Map<string, number>();
    for (const q of ledger) units.set(q.goalId, (units.get(q.goalId) ?? 0) + q.quantity);
    return new Set([...units].filter(([, u]) => u > 1e-9).map(([id]) => id));
};

/**
 * A log entry and the ledger movements that drop orphan shares — frozen units
 * of a holding that no longer exists. Nothing is written to YNAB; rolling the
 * entry back brings the units back.
 */
export function buildOrphanRelease(
    orphans: TrackingPlan['orphanShares'],
    opts: { entryId: string; budgetId: string; now: string },
): { entry: YnabWriteLogEntry; quotes: YnabGoalQuote[] } {
    const entry: YnabWriteLogEntry = {
        id: opts.entryId,
        kind: 'release',
        budgetId: opts.budgetId,
        brokerId: '',
        label: `Release of ${orphans.map(o => `${o.ticker} from ${o.goalName}`).join(', ')}`,
        date: opts.now.slice(0, 10),
        createdAt: opts.now,
        updatedAt: opts.now,
        status: 'applied',
        createdAccounts: [],
        transactions: [],
    };
    const quotes: YnabGoalQuote[] = orphans.map(o => ({
        entryId: opts.entryId, goalId: o.goalId, portfolioId: o.portfolioId, brokerId: o.brokerId, ticker: o.ticker,
        quantity: -o.quantity, cost: -o.cost, frozenAt: opts.now,
    }));
    return { entry, quotes };
}
