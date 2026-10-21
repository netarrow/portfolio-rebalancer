// Known-answer checks for the capex [PRB] note line: it is parsed before the
// name and the rest of the note, merged into a note without touching the rest,
// and proposed for writing only when YNAB did not edit it since the last sync.
// Run with: npx esbuild scripts/verify-capex-notes.ts --bundle --format=esm --platform=node | node --input-type=module
import { formatPrbLine, parseGoalDescriptor, parsePrbLine, upsertPrbLine } from '../src/utils/ynabGoalParser';
import { buildCapexNoteRows, capexNotesOutOfDate } from '../src/utils/ynabCapexNotes';
import type { YnabGoal } from '../src/types';

const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
    console.log(`ok ${label} = ${a}`);
};

check('format', formatPrbLine(1800, '2031-12-31'), '[PRB] target: 1800€ · due: 2031-12-31');
check('format TBD', formatPrbLine(null, undefined), '[PRB] target: TBD · due: TBD');
check('parse', parsePrbLine('Some text\n[PRB] target: 1250.5€ · due: 2030-06-30'), { amount: 1250.5, date: '2030-06-30' });
check('parse TBD date', parsePrbLine('[PRB] target: 900€ · due: TBD'), { amount: 900, date: null });
check('no line', parsePrbLine('just a note 500€'), null);

check('upsert appends, rest kept', upsertPrbLine('Shop list', '[PRB] target: 1€ · due: TBD'), 'Shop list\n[PRB] target: 1€ · due: TBD');
check('upsert replaces in place', upsertPrbLine('a\n[PRB] target: 1€ · due: TBD\nb', '[PRB] target: 2€ · due: TBD'), 'a\n[PRB] target: 2€ · due: TBD\nb');
check('upsert empty', upsertPrbLine(undefined, 'L'), 'L');

const p1 = parseGoalDescriptor('Garden Shed - 2800€ - 2027', 'target: 100€ by 2026-01\n[PRB] target: 3000€ · due: 2028-05-31');
check('PRB wins over name and note text, name cleaned', [p1.name, p1.amount, p1.date, p1.source], ['Garden Shed', 3000, '2028-05-31', 'parsed-note']);
const p2 = parseGoalDescriptor('Garden Shed', null);
check('clean name, no note', [p2.amount, p2.date], [null, null]);

const goal = (id: string, amount: number | undefined, date: string | undefined, ynabNote?: string, extra: Partial<YnabGoal> = {}): YnabGoal => ({
    id, ynabBudgetId: 'b', name: id, cashCoverage: 0, targetSource: 'manual-override', lastSyncedAt: '',
    ...(amount ? { targetAmount: amount } : {}), ...(date ? { targetDate: date } : {}), ...(ynabNote ? { ynabNote } : {}), ...extra,
});
const goals = [
    goal('A', 1800, '2031-12-31'),                                                   // no note yet
    goal('B', 900, '2029-01-31', '[PRB] target: 900€ · due: 2029-01-31'),            // in line
    goal('C', 1200, '2030-03-31', 'keep me\n[PRB] target: 1000€ · due: 2030-03-31'), // edited in the tool
    goal('D', 700, '2028-10-31', '[PRB] target: 700€ · due: 2028-10-31'),            // edited in YNAB since
    goal('E', 500, undefined, undefined, { archived: true }),
    goal('F', 400, undefined, undefined, { origin: 'category' }),
    goal('G', undefined, undefined),
];
check('out of date from stored notes', capexNotesOutOfDate(goals).map(g => g.id), ['A', 'C']);

const fresh = new Map<string, string | null>([
    ['A', null],
    ['B', '[PRB] target: 900€ · due: 2029-01-31'],
    ['C', 'keep me\n[PRB] target: 1000€ · due: 2030-03-31'],
    ['D', '[PRB] target: 750€ · due: 2028-10-31'],
]);
const rows = buildCapexNoteRows(goals, fresh);
check('rows', rows.map(r => [r.goalId, r.status]), [['A', 'write'], ['C', 'write'], ['D', 'changed-in-ynab']]);
check('C keeps its text', rows.find(r => r.goalId === 'C')?.after, 'keep me\n[PRB] target: 1200€ · due: 2030-03-31');
check('missing category', buildCapexNoteRows([goal('Z', 100, undefined)], new Map()).map(r => r.status), ['missing']);
console.log('all capex note checks passed');
