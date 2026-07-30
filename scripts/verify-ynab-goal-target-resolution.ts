// Known-answer checks for how a YNAB Goals sync candidate picks its target
// amount/date: name/note parse first, then YNAB's own goal fields, then the
// value already stored in YNAB Goals (so a re-sync proposes what is there
// instead of blanking it).
// Run with: npx esbuild scripts/verify-ynab-goal-target-resolution.ts --bundle --format=esm | node --input-type=module
import type { YnabGoal } from '../src/types';
import { parseGoalDescriptor, nativeGoalTarget } from '../src/utils/ynabGoalParser';
import { resolveGoalTarget } from '../src/utils/ynabGoalSync';

let failures = 0;

const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
    }
};

const stored = (over: Partial<YnabGoal> = {}): Pick<YnabGoal, 'targetAmount' | 'targetDate' | 'targetSource'> => ({
    targetAmount: 7000,
    targetDate: '2028-06-30',
    targetSource: 'manual-override',
    ...over,
});

const resolve = (
    name: string,
    note: string | null,
    cat: Parameters<typeof nativeGoalTarget>[0],
    existing: Pick<YnabGoal, 'targetAmount' | 'targetDate' | 'targetSource'> | null,
) => resolveGoalTarget(parseGoalDescriptor(name, note), nativeGoalTarget(cat), existing);

console.log('nativeGoalTarget');
check('TBD carries total + target month',
    nativeGoalTarget({ goalType: 'TBD', goalTargetMilliunits: 15000000, goalTargetMonth: '2029-06-30' }),
    { amount: 15000, date: '2029-06-30' });
check('MF monthly funding is not a total',
    nativeGoalTarget({ goalType: 'MF', goalTargetMilliunits: 250000, goalTargetMonth: '2029-06-30' }),
    { amount: null, date: null });
check('recurring NEED is not a one-off target',
    nativeGoalTarget({ goalType: 'NEED', goalTargetMilliunits: 300000, goalTargetMonth: '2026-09-30', goalCadence: 1 }),
    { amount: null, date: null });
check('one-off NEED counts',
    nativeGoalTarget({ goalType: 'NEED', goalTargetMilliunits: 300000, goalTargetMonth: '2026-09-30', goalCadence: 0 }),
    { amount: 300, date: '2026-09-30' });

console.log('resolveGoalTarget — precedence');
check('name/note parse wins over YNAB target and stored value',
    resolve('Bagno 9000€ 2030-03', null, { goalType: 'TBD', goalTargetMilliunits: 15000000, goalTargetMonth: '2029-06-30' }, stored()),
    { amount: 9000, date: '2030-03-31', amountSource: 'parsed-name', dateSource: 'parsed-name', source: 'parsed-name', confidence: 'high' });
check("YNAB's own target wins over the stored value",
    resolve('Wedding', null, { goalType: 'TBD', goalTargetMilliunits: 15000000, goalTargetMonth: '2029-06-30' }, stored()),
    { amount: 15000, date: '2029-06-30', amountSource: 'ynab-goal', dateSource: 'ynab-goal', source: 'ynab-goal', confidence: 'high' });
check('nothing in YNAB: the stored manual override is proposed again',
    resolve('Wedding', null, {}, stored()),
    { amount: 7000, date: '2028-06-30', amountSource: 'local', dateSource: 'local', source: null, confidence: 'high' });
check('stored parsed target keeps its source across a re-sync',
    resolve('Wedding', null, {}, stored({ targetSource: 'parsed-name' })),
    { amount: 7000, date: '2028-06-30', amountSource: 'parsed-name', dateSource: 'parsed-name', source: 'parsed-name', confidence: 'high' });

console.log('resolveGoalTarget — per field');
check('amount from YNAB, date kept from the stored goal',
    resolve('Wedding', null, { goalType: 'TB', goalTargetMilliunits: 20000000 }, stored()),
    { amount: 20000, date: '2028-06-30', amountSource: 'ynab-goal', dateSource: 'local', source: 'ynab-goal', confidence: 'high' });
check('amount parsed from the name, date kept from the stored goal',
    resolve('Wedding 20000€', null, {}, stored()),
    { amount: 20000, date: '2028-06-30', amountSource: 'parsed-name', dateSource: 'local', source: 'parsed-name', confidence: 'high' });
check('no source at all leaves both blank',
    resolve('Wedding', null, {}, null),
    { amount: null, date: null, amountSource: null, dateSource: null, source: null, confidence: 'low' });
check('a stored goal with only an amount stays partial (no invented date)',
    resolve('Wedding', null, {}, stored({ targetDate: undefined })),
    { amount: 7000, date: null, amountSource: 'local', dateSource: null, source: null, confidence: 'medium' });

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
if (failures > 0) process.exit(1);
