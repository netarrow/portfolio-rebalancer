import type { YnabAccountMapping, YnabAccountMappings } from '../types';

// Broker ↔ YNAB account mappings.
//
// A mapping addresses an account by (budgetId, accountId): YNAB account ids are
// only unique inside their budget, and brokers may be spread over several
// budgets of the same token. The relation stays 1:1 on that pair — assigning an
// account that already backs another broker moves it rather than duplicating
// the balance — but the *same* account id in a different budget is a different
// account and maps independently.

// Key used to compare two mappings for identity.
export const mappingKey = (m: YnabAccountMapping): string => `${m.budgetId}:${m.accountId}`;

export const sameMapping = (a: YnabAccountMapping, b: YnabAccountMapping): boolean =>
    a.budgetId === b.budgetId && a.accountId === b.accountId;

// Accepts both the current shape and the legacy one (brokerId -> accountId
// string, from before mappings were budget-qualified). Legacy entries are
// attached to `fallbackBudgetId` — the budget that was necessarily theirs, since
// only one existed back then; without it they cannot be addressed and are
// dropped. Malformed entries are dropped too, so a corrupt backup degrades to
// "no mapping" instead of crashing the app.
export function normalizeYnabAccountMappings(
    raw: unknown,
    fallbackBudgetId?: string,
): YnabAccountMappings {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: YnabAccountMappings = {};
    const seen = new Set<string>();
    for (const [brokerId, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!brokerId) continue;
        let mapping: YnabAccountMapping | null = null;
        if (typeof value === 'string') {
            if (value && fallbackBudgetId) mapping = { budgetId: fallbackBudgetId, accountId: value };
        } else if (value && typeof value === 'object') {
            const { budgetId, accountId } = value as Partial<YnabAccountMapping>;
            if (typeof budgetId === 'string' && budgetId && typeof accountId === 'string' && accountId) {
                mapping = { budgetId, accountId };
            }
        }
        if (!mapping) continue;
        // Defend the 1:1 invariant against hand-edited or merged payloads.
        const key = mappingKey(mapping);
        if (seen.has(key)) continue;
        seen.add(key);
        out[brokerId] = mapping;
    }
    return out;
}

// Assign (or clear, with `mapping === null`) the account backing a broker,
// releasing the account from whichever broker held it.
export function assignYnabAccountMapping(
    prev: YnabAccountMappings,
    brokerId: string,
    mapping: YnabAccountMapping | null,
): YnabAccountMappings {
    const next: YnabAccountMappings = {};
    for (const [bId, existing] of Object.entries(prev)) {
        if (bId === brokerId) continue;
        if (mapping && sameMapping(existing, mapping)) continue;
        next[bId] = existing;
    }
    if (mapping) next[brokerId] = mapping;
    return next;
}

// brokerIds grouped by the budget their account lives in, so the liquidity sync
// hits each budget's /accounts endpoint exactly once.
export function groupMappingsByBudget(mappings: YnabAccountMappings): Map<string, string[]> {
    const byBudget = new Map<string, string[]>();
    for (const [brokerId, mapping] of Object.entries(mappings)) {
        const list = byBudget.get(mapping.budgetId);
        if (list) list.push(brokerId);
        else byBudget.set(mapping.budgetId, [brokerId]);
    }
    return byBudget;
}
