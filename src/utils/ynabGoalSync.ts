import type { YnabGoal, YnabGoalAllocation, YnabGoalSyncCandidate } from '../types';

export interface YnabGoalSyncReport {
    created: number;
    updated: number;
    skipped: number;
    archived: number;
    deleted: number;
}

// Merge a reviewed set of sync candidates into the stored YNAB goals. Pure, so
// the caller can both persist the result and immediately reuse it (e.g. to
// rebuild the forecast's planned expenses from the goals it just synced).
//
// Goals whose category disappeared from the YNAB group are archived when
// allocations still point at them, and dropped otherwise.
export function mergeYnabGoalsFromCandidates(
    previous: YnabGoal[],
    candidates: YnabGoalSyncCandidate[],
    opts: { budgetId: string; allocations: YnabGoalAllocation[]; now?: string },
): { goals: YnabGoal[]; report: YnabGoalSyncReport } {
    const now = opts.now ?? new Date().toISOString();
    const report: YnabGoalSyncReport = { created: 0, updated: 0, skipped: 0, archived: 0, deleted: 0 };
    const incomingIds = new Set(candidates.filter(c => c.action !== 'skip').map(c => c.ynabCategoryId));
    const allFetchedIds = new Set(candidates.map(c => c.ynabCategoryId));

    const byId = new Map<string, YnabGoal>();
    for (const g of previous) byId.set(g.id, g);

    for (const c of candidates) {
        if (c.action === 'skip') {
            report.skipped += 1;
            continue;
        }
        const existing = byId.get(c.ynabCategoryId) ?? null;

        let targetSource: YnabGoal['targetSource'];
        if (existing && existing.targetSource === 'manual-override') {
            const sameAmount = (existing.targetAmount ?? null) === c.parsedAmount;
            const sameDate = (existing.targetDate ?? null) === c.parsedDate;
            targetSource = sameAmount && sameDate
                ? (c.parsedSource ?? 'manual-override')
                : 'manual-override';
        } else {
            targetSource = c.parsedSource ?? 'manual-override';
        }

        byId.set(c.ynabCategoryId, {
            id: c.ynabCategoryId,
            ynabBudgetId: opts.budgetId,
            name: c.ynabCategoryName,
            targetAmount: c.parsedAmount ?? undefined,
            targetDate: c.parsedDate ?? undefined,
            cashCoverage: c.cashCoverage,
            ynabMonthlyFunding: c.ynabMonthlyFunding ?? undefined,
            ynabActivityThisMonth: c.ynabActivityThisMonth ?? undefined,
            goalType: c.goalType ?? undefined,
            targetSource,
            lastSyncedAt: now,
            archived: false,
        });
        if (existing) report.updated += 1;
        else report.created += 1;
    }

    for (const g of previous) {
        if (allFetchedIds.has(g.id)) continue;
        if (incomingIds.has(g.id)) continue;
        if (opts.allocations.some(a => a.ynabGoalId === g.id)) {
            byId.set(g.id, { ...g, archived: true, lastSyncedAt: now });
            report.archived += 1;
        } else {
            byId.delete(g.id);
            report.deleted += 1;
        }
    }

    return { goals: Array.from(byId.values()), report };
}
