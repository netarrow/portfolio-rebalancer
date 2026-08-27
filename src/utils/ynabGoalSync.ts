import type { YnabGoal, YnabGoalAllocation, YnabGoalSyncCandidate, YnabGoalFieldSource } from '../types';
import type { ParsedGoalDescriptor } from './ynabGoalParser';

export interface ResolvedGoalTarget {
    amount: number | null;
    date: string | null;
    amountSource: YnabGoalFieldSource | null;
    dateSource: YnabGoalFieldSource | null;
    // Aggregate origin, stored on the goal as its targetSource.
    source: YnabGoalSyncCandidate['parsedSource'];
    confidence: YnabGoalSyncCandidate['confidence'];
}

// Decide the target amount/date a sync candidate proposes, per field:
//   1. an explicit target written in the category name or note ("7000€ by 2028-06")
//   2. YNAB's own goal fields (goal_target / goal_target_month)
//   3. the value already stored in YNAB Goals
//
// Step 3 is what makes a re-sync additive: a due date typed once (or a target
// YNAB no longer exposes) is proposed again instead of coming back empty, so
// only what actually changed needs touching. Clearing a field in the modal
// still clears it — the fallback fills blanks, it does not lock values.
export function resolveGoalTarget(
    parsed: ParsedGoalDescriptor,
    native: { amount: number | null; date: string | null },
    existing: Pick<YnabGoal, 'targetAmount' | 'targetDate' | 'targetSource'> | null,
): ResolvedGoalTarget {
    const localAmount = existing?.targetAmount ?? null;
    const localDate = existing?.targetDate ?? null;
    // A goal kept from the local copy keeps the source it already had, so a
    // manual override stays flagged as one across syncs.
    const localSource: YnabGoalFieldSource | null = existing
        ? (existing.targetSource === 'manual-override' ? 'local' : existing.targetSource)
        : null;

    const amount = parsed.amount ?? native.amount ?? localAmount;
    const date = parsed.date ?? native.date ?? localDate;

    const amountSource: YnabGoalFieldSource | null =
        parsed.amount !== null ? (parsed.source ?? null)
            : native.amount !== null ? 'ynab-goal'
                : localAmount !== null ? (localSource ?? 'local')
                    : null;
    const dateSource: YnabGoalFieldSource | null =
        parsed.date !== null ? (parsed.source ?? null)
            : native.date !== null ? 'ynab-goal'
                : localDate !== null ? (localSource ?? 'local')
                    : null;

    // The goal's own targetSource follows whichever origin ranks highest among
    // the two fields; 'local' means neither YNAB nor the text said anything, so
    // the stored override stands.
    const rank = (s: YnabGoalFieldSource | null): number =>
        s === 'parsed-name' || s === 'parsed-note' ? 3 : s === 'ynab-goal' ? 2 : s === 'local' ? 1 : 0;
    const winner = rank(amountSource) >= rank(dateSource) ? amountSource : dateSource;
    const source: YnabGoalSyncCandidate['parsedSource'] =
        winner === 'local' || winner === null ? null : winner;

    const confidence: YnabGoalSyncCandidate['confidence'] =
        amount !== null && date !== null ? 'high'
            : winner === 'ynab-goal' || winner === 'local' ? 'medium'
                : parsed.confidence;

    return { amount, date, amountSource, dateSource, source, confidence };
}

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
            name: c.parsedName?.trim() || c.ynabCategoryName,
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
