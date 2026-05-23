import axios from 'axios';
import type { YnabCategory, YnabCategoryGroupSummary } from '../types';

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
            return { success: false, error: 'Goal category group not found in YNAB.' };
        }
        if (group.hidden || group.deleted) {
            return { success: false, error: 'Goal category group is hidden or deleted in YNAB.' };
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
}

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

export async function getAverageBudgetedByCategory(
    apiKey: string,
    budgetId: string,
    monthsBack: number = 6,
): Promise<YnabApiResult<Map<string, YnabAverageEntry>>> {
    try {
        const months = previousMonthsIso(monthsBack);
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

        const sums = new Map<string, { sum: number; count: number }>();
        for (const r of responses) {
            if (!r.ok) continue;
            const cats: any[] = r.data?.categories ?? [];
            for (const c of cats) {
                if (c.hidden || c.deleted) continue;
                const budgeted = typeof c.budgeted === 'number' ? c.budgeted : 0;
                const entry = sums.get(c.id) || { sum: 0, count: 0 };
                entry.sum += budgeted;
                entry.count += 1;
                sums.set(c.id, entry);
            }
        }

        const result = new Map<string, YnabAverageEntry>();
        for (const [id, { sum, count }] of sums) {
            if (count === 0) continue;
            result.set(id, { avgBudgetedMilliunits: sum / count, monthsCount: count });
        }

        return { success: true, data: result };
    } catch (e) {
        return { success: false, error: mapError(e) };
    }
}
