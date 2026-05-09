import axios from 'axios';
import type { YnabCategory } from '../types';

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
        if (status === 401) return 'Chiave API non valida o scaduta.';
        if (status === 403) return 'Accesso negato dal server YNAB.';
        if (status === 404) return 'Risorsa non trovata su YNAB (controlla il budget ID).';
        if (status === 429) return 'Limite di richieste YNAB superato (200/ora). Riprova più tardi.';
        if (status && status >= 500) return `Errore server YNAB (HTTP ${status}).`;
        if (e.code === 'ERR_NETWORK') return 'Errore di rete: impossibile contattare YNAB.';
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
