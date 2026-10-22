// Known-answer checks for the capex [PRB] note line: it is parsed before the
// name and the rest of the note, merged into a note without touching the rest,
// and proposed for writing only when YNAB did not edit it since the last sync.
// Run with: npx esbuild scripts/verify-capex-notes.ts --bundle --format=esm --platform=node | node --input-type=module
import { formatPrbLine, parseGoalDescriptor, parsePrbLine, stripInvestedTag, upsertPrbLine, withInvestedTag } from '../src/utils/ynabGoalParser';
import { buildCapexNoteRows, capexNotesOutOfDate, wantsInvestedTag, type FreshCapexCategory } from '../src/utils/ynabCapexNotes';
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
const noTag = () => false;
check('out of date from stored notes', capexNotesOutOfDate(goals, noTag).map(g => g.id), ['A', 'C']);

const fc = (note: string | null, rawName = 'x'): FreshCapexCategory => ({ note, rawName });
const fresh = new Map<string, FreshCapexCategory>([
    ['A', fc(null, 'A')],
    ['B', fc('[PRB] target: 900€ · due: 2029-01-31', 'B')],
    ['C', fc('keep me\n[PRB] target: 1000€ · due: 2030-03-31', 'C')],
    ['D', fc('[PRB] target: 750€ · due: 2028-10-31', 'D')],
]);
const rows = buildCapexNoteRows(goals, fresh, noTag);
check('rows', rows.map(r => [r.goalId, r.status]), [['A', 'write'], ['C', 'write'], ['D', 'changed-in-ynab']]);
check('C keeps its text', rows.find(r => r.goalId === 'C')?.after, 'keep me\n[PRB] target: 1200€ · due: 2030-03-31');
check('missing category', buildCapexNoteRows([goal('Z', 100, undefined)], new Map(), noTag).map(r => r.status), ['missing']);

// [Invested] postfix
check('strip', stripInvestedTag('Garden Shed [Invested]'), { name: 'Garden Shed', tagged: true });
check('strip case-insensitive', stripInvestedTag('Garden Shed  [invested] ').name, 'Garden Shed');
check('strip untagged', stripInvestedTag('Garden Shed'), { name: 'Garden Shed', tagged: false });
check('add', withInvestedTag('Garden Shed', true), 'Garden Shed [Invested]');
check('add once', withInvestedTag('Garden Shed [Invested]', true), 'Garden Shed [Invested]');
check('remove', withInvestedTag('Garden Shed [Invested]', false), 'Garden Shed');
check('parse a tagged name', parseGoalDescriptor(stripInvestedTag('Laptop - 1800€ - 2031 [Invested]').name, null).name, 'Laptop');

check('wants: partly invested', wantsInvestedTag({ invested: 300, cash: 200, target: 1000 }), true);
check('wants: cash covers the target', wantsInvestedTag({ invested: 300, cash: 1000, target: 1000 }), false);
check('wants: nothing invested', wantsInvestedTag({ invested: 0, cash: 100, target: 1000 }), false);
check('wants: invested, no target', wantsInvestedTag({ invested: 300, cash: 0, target: 0 }), true);

const inLine = goal('K', 500, '2030-01-31', '[PRB] target: 500€ · due: 2030-01-31');
const tagK = (id: string) => id === 'K';
check('tag wanted: out of date', capexNotesOutOfDate([inLine], tagK).map(g => g.id), ['K']);
check('tag stored: in line', capexNotesOutOfDate([{ ...inLine, ynabInvestedTag: true }], tagK).length, 0);
const kRows = buildCapexNoteRows([inLine], new Map([['K', fc('[PRB] target: 500€ · due: 2030-01-31', 'Bike')]]), tagK);
check('name only', kRows.map(r => [r.status, r.after, r.nameBefore, r.nameAfter]), [['write', null, 'Bike', 'Bike [Invested]']]);
const untag = buildCapexNoteRows([{ ...inLine, ynabInvestedTag: true }], new Map([['K', fc('[PRB] target: 500€ · due: 2030-01-31', 'Bike [Invested]')]]), noTag);
check('removed once covered', untag.map(r => r.nameAfter), ['Bike']);
const both = buildCapexNoteRows([goal('D', 700, '2028-10-31', '[PRB] target: 700€ · due: 2028-10-31')], new Map([['D', fc('[PRB] target: 750€ · due: 2028-10-31', 'D')]]), () => true);
check('note edited in YNAB, name still written', both.map(r => [r.status, r.after, r.nameAfter, r.noteEditedInYnab]), [['write', null, 'D [Invested]', true]]);
console.log('all capex note checks passed');
