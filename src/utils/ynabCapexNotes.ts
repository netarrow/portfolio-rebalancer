import type { YnabGoal } from '../types';
import { formatPrbLine, parsePrbLine, upsertPrbLine, type PrbLine } from './ynabGoalParser';

/**
 * The [PRB] line the YNAB Writeback keeps in each capex category's note: the
 * target is set in the tool, and the note carries it into YNAB. A line edited
 * in YNAB wins: it is not overwritten, the next sync takes it.
 */
export type CapexNoteStatus = 'write' | 'changed-in-ynab' | 'missing';

export interface CapexNoteRow {
    goalId: string;
    name: string;
    before: string | null;
    after: string;
    status: CapexNoteStatus;
}

const samePrb = (a: PrbLine | null, b: PrbLine | null) =>
    (a?.amount ?? null) === (b?.amount ?? null) && (a?.date ?? null) === (b?.date ?? null);

const goalPrb = (g: YnabGoal): PrbLine => ({ amount: g.targetAmount ?? null, date: g.targetDate?.slice(0, 10) ?? null });

/** Capex of the goals group whose target is set and that the YNAB note does not carry. */
const candidates = (goals: YnabGoal[]) => goals.filter(g =>
    !g.archived && g.origin !== 'category' && (g.targetAmount != null || !!g.targetDate));

/** What the stored notes say is out of date: no reading of YNAB needed. */
export const capexNotesOutOfDate = (goals: YnabGoal[]): YnabGoal[] =>
    candidates(goals).filter(g => !samePrb(parsePrbLine(g.ynabNote), goalPrb(g)));

/**
 * The notes to write, from the notes just read from YNAB (`fresh`: category
 * id → note, absent = the category is gone). A [PRB] line that differs from
 * the one last read was edited in YNAB: it is left alone.
 */
export const buildCapexNoteRows = (goals: YnabGoal[], fresh: Map<string, string | null>): CapexNoteRow[] =>
    candidates(goals).flatMap((g): CapexNoteRow[] => {
        const target = goalPrb(g);
        const after = formatPrbLine(target.amount, target.date);
        if (!fresh.has(g.id)) return [{ goalId: g.id, name: g.name, before: g.ynabNote ?? null, after, status: 'missing' }];
        const before = fresh.get(g.id) ?? null;
        const now = parsePrbLine(before);
        if (samePrb(now, target)) return [];
        const status: CapexNoteStatus = now && !samePrb(now, parsePrbLine(g.ynabNote)) ? 'changed-in-ynab' : 'write';
        return [{ goalId: g.id, name: g.name, before, after: upsertPrbLine(before, after), status }];
    });
