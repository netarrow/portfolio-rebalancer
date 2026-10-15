import axios from 'axios';
import type { YnabCategory, YnabCategoryGroupSummary, YnabMonthSnapshot, YnabMonthCategorySnapshot } from '../types';

const YNAB_BASE = 'https://api.ynab.com/v1';

export interface YnabBudgetSummary {
    id: string;
    name: string;
    currencyIso: string;
}

export interface YnabApiResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}

function mapError(e: unknown): string {
    if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        if (status === 401) return 'Invalid or expired API key.';
        if (status === 403) return 'Access denied by the YNAB server.';
        if (status === 404) return 'Resource not found on YNAB (check the budget ID).';
        if (status === 429) return 'YNAB rate limit exceeded (200/hour). Try again later.';
        if (status && status >= 500) return `YNAB server error (HTTP ${status}).`;
        if (e.code === 'ERR_NETWORK') return 'Network error: unable to reach YNAB.';
        return e.message;
    }
    return e instanceof Error ? e.message : String(e);
}

export async function listBudgets(apiKey: string): Promise<YnabApiResult<YnabBudgetSummary[]>> {
    try {
        const response = await axios.get(`${YNAB_BASE}/budgets`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        const budgets = response.data?.data?.budgets ?? [];
        return {
            success: true,
            data: budgets.map((b: any) => ({
                id: b.id,
                name: b.name,
                currencyIso: b.currency_format?.iso_code ?? 'USD',
            })),
        };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

export interface YnabAccountSummary {
    id: string;
    name: string;
    type: string;              // 'checking' | 'savings' | 'otherAsset' | ...
    onBudget: boolean;
    balanceMilliunits: number;         // working balance: cleared + uncleared
    clearedBalanceMilliunits: number;
    // Payee to use on a transaction that transfers money INTO this account.
    transferPayeeId?: string;
}

// Account and transaction objects as the YNAB API returns them (the fields read here).
interface RawAccount {
    id: string;
    name: string;
    type?: unknown;
    on_budget?: boolean;
    balance?: unknown;
    cleared_balance?: unknown;
    transfer_payee_id?: unknown;
}
interface RawTransaction {
    id: string;
    account_id: string;
    amount?: unknown;
    import_id?: string | null;
    transfer_account_id?: string | null;
    transfer_transaction_id?: string | null;
}

const accountSummary = (a: RawAccount): YnabAccountSummary => ({
    id: a.id,
    name: a.name,
    type: typeof a.type === 'string' ? a.type : '',
    onBudget: !!a.on_budget,
    balanceMilliunits: typeof a.balance === 'number' ? a.balance : 0,
    clearedBalanceMilliunits: typeof a.cleared_balance === 'number' ? a.cleared_balance : 0,
    ...(typeof a.transfer_payee_id === 'string' && a.transfer_payee_id ? { transferPayeeId: a.transfer_payee_id } : {}),
});

// Open, non-deleted accounts of a budget. `balance` is the figure YNAB shows in
// the account sidebar, which is what we mirror into broker liquidity.
export async function listAccounts(
    apiKey: string,
    budgetId: string,
): Promise<YnabApiResult<YnabAccountSummary[]>> {
    try {
        const response = await axios.get(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/accounts`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const accounts: any[] = response.data?.data?.accounts ?? [];
        const result: YnabAccountSummary[] = [];
        for (const a of accounts) {
            if (a.deleted || a.closed) continue;
            result.push(accountSummary(a));
        }
        return { success: true, data: result };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

// Accounts of several budgets at once, one request each, keyed by budget id.
// Failures are per budget: an unreachable budget must not hide the accounts of
// the others, so its entry carries the error instead of rejecting the whole call.
export async function listAccountsByBudget(
    apiKey: string,
    budgetIds: string[],
): Promise<Map<string, YnabApiResult<YnabAccountSummary[]>>> {
    const unique = [...new Set(budgetIds)];
    const results = await Promise.all(unique.map(id => listAccounts(apiKey, id)));
    return new Map(unique.map((id, i) => [id, results[i]]));
}

const HIDDEN_GROUP_NAMES = new Set([
    'Internal Master Category',
    'Credit Card Payments',
    'Hidden Categories',
]);

export async function getCurrentMonthCategories(
    apiKey: string,
    budgetId: string,
): Promise<YnabApiResult<YnabCategory[]>> {
    try {
        const response = await axios.get(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/months/current`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const month = response.data?.data?.month;
        const rawCategories: any[] = month?.categories ?? [];

        // Group lookup needs another endpoint to know group names; we use /categories
        const groupsResp = await axios.get(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/categories`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const categoryGroups: any[] = groupsResp.data?.data?.category_groups ?? [];

        const groupById = new Map<string, { id: string; name: string; hidden: boolean; deleted: boolean }>();
        for (const g of categoryGroups) {
            groupById.set(g.id, { id: g.id, name: g.name, hidden: !!g.hidden, deleted: !!g.deleted });
        }

        const categories: YnabCategory[] = [];
        for (const c of rawCategories) {
            if (c.hidden || c.deleted) continue;
            const group = groupById.get(c.category_group_id);
            if (!group || group.hidden || group.deleted) continue;
            if (HIDDEN_GROUP_NAMES.has(group.name)) continue;
            categories.push({
                id: c.id,
                groupId: group.id,
                groupName: group.name,
                name: c.name,
                balanceMilliunits: typeof c.balance === 'number' ? c.balance : 0,
                budgetedMilliunits: typeof c.budgeted === 'number' ? c.budgeted : 0,
            });
        }

        return { success: true, data: categories };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

export const milliunitsToEur = (m: number): number => m / 1000;

export async function listCategoryGroups(
    apiKey: string,
    budgetId: string,
): Promise<YnabApiResult<YnabCategoryGroupSummary[]>> {
    try {
        const response = await axios.get(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/categories`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const categoryGroups: any[] = response.data?.data?.category_groups ?? [];
        const result: YnabCategoryGroupSummary[] = [];
        for (const g of categoryGroups) {
            if (g.hidden || g.deleted) continue;
            if (HIDDEN_GROUP_NAMES.has(g.name)) continue;
            const cats: any[] = Array.isArray(g.categories) ? g.categories : [];
            const count = cats.filter(c => !c.hidden && !c.deleted).length;
            result.push({ id: g.id, name: g.name, categoryCount: count });
        }
        return { success: true, data: result };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

export async function getGoalCategories(
    apiKey: string,
    budgetId: string,
    groupId: string,
): Promise<YnabApiResult<YnabCategory[]>> {
    try {
        const headers = { Authorization: `Bearer ${apiKey}` };
        const groupsResp = await axios.get(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/categories`,
            { headers },
        );
        const categoryGroups: any[] = groupsResp.data?.data?.category_groups ?? [];
        const group = categoryGroups.find(g => g.id === groupId);
        if (!group) {
            return { success: false, error: 'Capex category group not found in YNAB.' };
        }
        if (group.hidden || group.deleted) {
            return { success: false, error: 'Capex category group is hidden or deleted in YNAB.' };
        }

        const monthResp = await axios.get(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/months/current`,
            { headers },
        );
        const monthCats: any[] = monthResp.data?.data?.month?.categories ?? [];
        const monthById = new Map<string, any>();
        for (const c of monthCats) monthById.set(c.id, c);

        const out: YnabCategory[] = [];
        const rawCats: any[] = Array.isArray(group.categories) ? group.categories : [];
        for (const c of rawCats) {
            if (c.hidden || c.deleted) continue;
            const monthSnap = monthById.get(c.id);
            out.push({
                id: c.id,
                groupId: group.id,
                groupName: group.name,
                name: c.name,
                balanceMilliunits: typeof c.balance === 'number' ? c.balance : 0,
                budgetedMilliunits: typeof c.budgeted === 'number' ? c.budgeted : 0,
                note: typeof c.note === 'string' && c.note.length > 0 ? c.note : undefined,
                goalType: typeof c.goal_type === 'string' && c.goal_type.length > 0 ? c.goal_type : undefined,
                goalTargetMilliunits: typeof c.goal_target === 'number' ? c.goal_target : undefined,
                goalTargetMonth: typeof c.goal_target_month === 'string' && c.goal_target_month.length > 0
                    ? c.goal_target_month
                    : undefined,
                goalCadence: typeof c.goal_cadence === 'number' ? c.goal_cadence : undefined,
                activityMilliunits: typeof monthSnap?.activity === 'number'
                    ? monthSnap.activity
                    : (typeof c.activity === 'number' ? c.activity : undefined),
            });
        }
        return { success: true, data: out };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

export interface YnabAverageEntry {
    avgBudgetedMilliunits: number;
    monthsCount: number;
    /** Average monthly outflow (−activity) over the spending window. */
    avgSpentMilliunits: number;
    spentMonthsCount: number;
}

/** Months the average spending is taken over: a full year smooths out seasonality. */
export const SPENT_AVERAGE_MONTHS = 12;

function previousMonthsIso(monthsBack: number, now: Date = new Date()): string[] {
    const out: string[] = [];
    for (let i = 1; i <= monthsBack; i++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        out.push(`${yyyy}-${mm}-01`);
    }
    return out;
}

// One pass over the previous months gives both averages: what was budgeted
// over the configured window (`monthsBack`) and what was actually spent over
// the last `spentMonthsBack` months.
export async function getAverageBudgetedByCategory(
    apiKey: string,
    budgetId: string,
    monthsBack: number = 6,
    spentMonthsBack: number = SPENT_AVERAGE_MONTHS,
): Promise<YnabApiResult<Map<string, YnabAverageEntry>>> {
    try {
        // Most recent first, so index < window means "inside that window".
        const months = previousMonthsIso(Math.max(monthsBack, spentMonthsBack));
        const headers = { Authorization: `Bearer ${apiKey}` };

        const responses = await Promise.all(
            months.map(m =>
                axios
                    .get(`${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/months/${m}`, { headers })
                    .then(r => ({ ok: true as const, data: r.data?.data?.month }))
                    .catch(e => {
                        if (axios.isAxiosError(e) && e.response?.status === 404) {
                            return { ok: false as const, missing: true };
                        }
                        throw e;
                    }),
            ),
        );

        const sums = new Map<string, { sum: number; count: number; spent: number; spentCount: number }>();
        responses.forEach((r, index) => {
            if (!r.ok) return;
            const cats: any[] = r.data?.categories ?? [];
            for (const c of cats) {
                if (c.hidden || c.deleted) continue;
                const entry = sums.get(c.id) || { sum: 0, count: 0, spent: 0, spentCount: 0 };
                if (index < monthsBack) {
                    entry.sum += typeof c.budgeted === 'number' ? c.budgeted : 0;
                    entry.count += 1;
                }
                if (index < spentMonthsBack) {
                    entry.spent += typeof c.activity === 'number' ? -c.activity : 0;
                    entry.spentCount += 1;
                }
                sums.set(c.id, entry);
            }
        });

        const result = new Map<string, YnabAverageEntry>();
        for (const [id, { sum, count, spent, spentCount }] of sums) {
            if (count === 0 && spentCount === 0) continue;
            result.set(id, {
                avgBudgetedMilliunits: count > 0 ? sum / count : 0,
                monthsCount: count,
                avgSpentMilliunits: spentCount > 0 ? spent / spentCount : 0,
                spentMonthsCount: spentCount,
            });
        }

        return { success: true, data: result };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

// Months of the rolling window, oldest first: the previous `monthsBack`
// complete months (the current, partial month is excluded on purpose so
// averages are computed on full months only).
export function rollingMonthsIso(monthsBack: number, now: Date = new Date()): string[] {
    return previousMonthsIso(monthsBack, now).reverse();
}

export async function getMonthlyBudgetSnapshots(
    apiKey: string,
    budgetId: string,
    monthsIso: string[],
): Promise<YnabApiResult<YnabMonthSnapshot[]>> {
    try {
        const headers = { Authorization: `Bearer ${apiKey}` };

        const groupsResp = await axios.get(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/categories`,
            { headers },
        );
        const categoryGroups: any[] = groupsResp.data?.data?.category_groups ?? [];
        const groupById = new Map<string, { name: string; hidden: boolean; deleted: boolean }>();
        for (const g of categoryGroups) {
            groupById.set(g.id, { name: g.name, hidden: !!g.hidden, deleted: !!g.deleted });
        }

        const responses = await Promise.all(
            monthsIso.map(m =>
                axios
                    .get(`${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/months/${m}`, { headers })
                    .then(r => ({ month: m, data: r.data?.data?.month as any }))
                    .catch(e => {
                        // Months before the budget's first month don't exist.
                        if (axios.isAxiosError(e) && e.response?.status === 404) {
                            return { month: m, data: null };
                        }
                        throw e;
                    }),
            ),
        );

        const syncedAt = new Date().toISOString();
        const snapshots: YnabMonthSnapshot[] = [];
        for (const r of responses) {
            if (!r.data) continue;
            const rawCats: any[] = r.data.categories ?? [];
            const categories: YnabMonthCategorySnapshot[] = [];
            for (const c of rawCats) {
                if (c.hidden || c.deleted) continue;
                const group = groupById.get(c.category_group_id);
                if (!group || group.hidden || group.deleted) continue;
                if (HIDDEN_GROUP_NAMES.has(group.name)) continue;
                categories.push({
                    categoryId: c.id,
                    name: c.name,
                    groupId: c.category_group_id,
                    groupName: group.name,
                    budgetedMilliunits: typeof c.budgeted === 'number' ? c.budgeted : 0,
                    activityMilliunits: typeof c.activity === 'number' ? c.activity : 0,
                });
            }
            snapshots.push({
                month: r.month,
                incomeMilliunits: typeof r.data.income === 'number' ? r.data.income : 0,
                budgetedMilliunits: typeof r.data.budgeted === 'number' ? r.data.budgeted : 0,
                activityMilliunits: typeof r.data.activity === 'number' ? r.data.activity : 0,
                categories,
                syncedAt,
            });
        }

        return { success: true, data: snapshots };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

// ── Writes ──────────────────────────────────────────────────────────
// Called ONLY by utils/ynabWriteBack, which checks every target against the
// write guard (utils/ynabWriteGuard) before reaching these. Nothing else in the
// app writes to YNAB.

export type YnabFlagColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export interface YnabNewTransaction {
    account_id: string;
    date: string;                 // 'YYYY-MM-DD'
    amount: number;               // milliunits, negative = outflow
    payee_id?: string;            // a transfer_payee_id makes it a transfer
    payee_name?: string;          // max 200
    memo?: string;                // max 500
    cleared?: 'cleared' | 'uncleared' | 'reconciled';
    approved?: boolean;
    flag_color?: YnabFlagColor;
    import_id?: string;           // max 36, unique per account
}

export interface YnabSavedTransaction {
    id: string;
    accountId: string;
    amountMilliunits: number;
    importId?: string;
    transferAccountId?: string;
    transferTransactionId?: string;
}

const savedTransaction = (t: RawTransaction): YnabSavedTransaction => ({
    id: t.id,
    accountId: t.account_id,
    amountMilliunits: typeof t.amount === 'number' ? t.amount : 0,
    ...(t.import_id ? { importId: t.import_id } : {}),
    ...(t.transfer_account_id ? { transferAccountId: t.transfer_account_id } : {}),
    ...(t.transfer_transaction_id ? { transferTransactionId: t.transfer_transaction_id } : {}),
});

export async function createTransactions(
    apiKey: string,
    budgetId: string,
    transactions: YnabNewTransaction[],
): Promise<YnabApiResult<{ transactions: YnabSavedTransaction[]; duplicateImportIds: string[] }>> {
    try {
        const response = await axios.post(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/transactions`,
            { transactions },
            { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const data = response.data?.data ?? {};
        const saved: RawTransaction[] = Array.isArray(data.transactions) ? data.transactions : (data.transaction ? [data.transaction] : []);
        return {
            success: true,
            data: {
                transactions: saved.map(savedTransaction),
                duplicateImportIds: Array.isArray(data.duplicate_import_ids) ? data.duplicate_import_ids : [],
            },
        };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

export async function deleteTransaction(
    apiKey: string,
    budgetId: string,
    transactionId: string,
): Promise<YnabApiResult<{ notFound: boolean }>> {
    try {
        await axios.delete(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/transactions/${encodeURIComponent(transactionId)}`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        return { success: true, data: { notFound: false } };
    } catch (e) {
        // Already gone (e.g. the other side of a transfer went with it): fine.
        if (axios.isAxiosError(e) && e.response?.status === 404) return { success: true, data: { notFound: true } };
        return { success: false, error: mapError(e) };
    }
}

// A tracking (off-budget) asset account, opened at zero.
export async function createTrackingAccount(
    apiKey: string,
    budgetId: string,
    name: string,
): Promise<YnabApiResult<YnabAccountSummary>> {
    try {
        const response = await axios.post(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/accounts`,
            { account: { name, type: 'otherAsset', balance: 0 } },
            { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const account = response.data?.data?.account;
        if (!account?.id) return { success: false, error: 'YNAB did not return the new account.' };
        return { success: true, data: accountSummary(account) };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}

// Changes some fields of an existing transaction (the tool's own latent-tax
// line, updated in place at each revaluation). 404 = it was deleted in YNAB.
export async function updateTransaction(
    apiKey: string,
    budgetId: string,
    transactionId: string,
    patch: Partial<Pick<YnabNewTransaction, 'amount' | 'memo' | 'date' | 'cleared'>>,
): Promise<YnabApiResult<{ transaction?: YnabSavedTransaction; notFound: boolean }>> {
    try {
        const response = await axios.put(
            `${YNAB_BASE}/budgets/${encodeURIComponent(budgetId)}/transactions/${encodeURIComponent(transactionId)}`,
            { transaction: patch },
            { headers: { Authorization: `Bearer ${apiKey}` } },
        );
        const t: RawTransaction | undefined = response.data?.data?.transaction;
        return { success: true, data: { transaction: t ? savedTransaction(t) : undefined, notFound: false } };
    } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 404) return { success: true, data: { notFound: true } };
        return { success: false, error: mapError(e) };
    }
}
