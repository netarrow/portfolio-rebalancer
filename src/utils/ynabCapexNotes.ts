import type { YnabGoal } from '../types';
import { formatPrbLine, parsePrbLine, upsertPrbLine, withInvestedTag, type PrbLine } from './ynabGoalParser';

/**
 * What the YNAB Writeback keeps on each capex category:
 *  - in its note, the [PRB] line with the target set in the tool. A line
 *    edited in YNAB wins: it is not overwritten, the next sync takes it;
 *  - on its name, the "[Invested]" postfix while part of the capex is
 *    invested and its YNAB cash alone does not cover it.
 */
export type CapexNoteStatus = 'write' | 'changed-in-ynab' | 'missing';

export interface CapexNoteRow {
    goalId: string;
    name: string;
    /** The note now, and what it becomes; `after` null = left as it is. */
    before: string | null;
    after: string | null;
    /** The name now, and what it becomes; `nameAfter` null = left as it is. */
    nameBefore: string;
    nameAfter: string | null;
    /** The [PRB] line was edited in YNAB since the last sync. */
    noteEditedInYnab: boolean;
    status: CapexNoteStatus;
}

/** Category as just read from YNAB: its note and its name as YNAB has it. */
export interface FreshCapexCategory {
    note: string | null;
    rawName: string;
}

/** Wants the "[Invested]" postfix: partly invested, and cash alone falls short. */
export const wantsInvestedTag = (row: { invested: number; cash: number; target: number }): boolean =>
    row.invested > 0.5 && !(row.target > 0 && row.cash >= row.target);

const samePrb = (a: PrbLine | null, b: PrbLine | null) =>
    (a?.amount ?? null) === (b?.amount ?? null) && (a?.date ?? null) === (b?.date ?? null);

const goalPrb = (g: YnabGoal): PrbLine => ({ amount: g.targetAmount ?? null, date: g.targetDate?.slice(0, 10) ?? null });

const hasTarget = (g: YnabGoal) => g.targetAmount != null || !!g.targetDate;

/** Capex of the goals group, still active. */
const candidates = (goals: YnabGoal[]) => goals.filter(g => !g.archived && g.origin !== 'category');

/** What the stored notes and names say is out of date: no reading of YNAB needed. */
export const capexNotesOutOfDate = (goals: YnabGoal[], tagOf: (goalId: string) => boolean): YnabGoal[] =>
    candidates(goals).filter(g =>
        (hasTarget(g) && !samePrb(parsePrbLine(g.ynabNote), goalPrb(g)))
        || !!g.ynabInvestedTag !== tagOf(g.id));

/**
 * What to write, from the categories just read from YNAB (absent = the
 * category is gone from the capex group).
 */
export const buildCapexNoteRows = (
    goals: YnabGoal[],
    fresh: Map<string, FreshCapexCategory>,
    tagOf: (goalId: string) => boolean,
): CapexNoteRow[] =>
    candidates(goals).flatMap((g): CapexNoteRow[] => {
        const cat = fresh.get(g.id);
        if (!cat) {
            const touches = hasTarget(g) || tagOf(g.id);
            return touches ? [{ goalId: g.id, name: g.name, before: g.ynabNote ?? null, after: null, nameBefore: g.name, nameAfter: null, noteEditedInYnab: false, status: 'missing' }] : [];
        }
        const before = cat.note;
        const now = parsePrbLine(before);
        const target = goalPrb(g);
        let after: string | null = null;
        let noteEditedInYnab = false;
        if (hasTarget(g) && !samePrb(now, target)) {
            if (now && !samePrb(now, parsePrbLine(g.ynabNote))) noteEditedInYnab = true;
            else after = upsertPrbLine(before, formatPrbLine(target.amount, target.date));
        }
        const wanted = withInvestedTag(cat.rawName, tagOf(g.id));
        const nameAfter = wanted !== cat.rawName ? wanted : null;
        if (after === null && nameAfter === null && !noteEditedInYnab) return [];
        const status: CapexNoteStatus = after !== null || nameAfter !== null ? 'write' : 'changed-in-ynab';
        return [{ goalId: g.id, name: g.name, before, after, nameBefore: cat.rawName, nameAfter, noteEditedInYnab, status }];
    });
