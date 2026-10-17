// Known-answer checks for a category linked to another budget: its outflow is
// split by that budget's mix of mapped spending, the link wins over a class,
// and an unsynced linked budget leaves the category unmapped.
// Run with: npx esbuild scripts/verify-linked-budget-split.ts --bundle --format=esm | node --input-type=module
import { analyzeSpending } from '../src/utils/spendingAnalysis';
import type { YnabMacroMappings, YnabMonthSnapshot } from '../src/types';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};

const month = (m: string, income: number, cats: [string, string, number][]): YnabMonthSnapshot => ({
    month: m, incomeMilliunits: income * 1000, budgetedMilliunits: 0, activityMilliunits: 0, syncedAt: '',
    categories: cats.map(([id, group, spent]) => ({
        categoryId: id, name: id, groupId: group, groupName: group,
        budgetedMilliunits: spent * 1000, activityMilliunits: -spent * 1000,
    })),
});

// Personal budget: €1,000 handed to the family budget each month, €200 of own fun.
const personal = [
    month('2026-01-01', 3000, [['family-share', 'g-transfer', 1000], ['fun', 'g-fun', 200]]),
    month('2026-02-01', 3000, [['family-share', 'g-transfer', 1000], ['fun', 'g-fun', 200]]),
];
// Family budget: 50% fixed, 30% variable, 20% compressible.
const family = [
    month('2026-01-01', 0, [['rent', 'g-home', 1000], ['food', 'g-food', 600], ['dining', 'g-out', 400]]),
];
const mappings: YnabMacroMappings = {
    groups: { 'g-fun': 'compressible', 'g-home': 'structural', 'g-food': 'variable', 'g-out': 'compressible' },
    categories: { 'family-share': 'investments' }, // a stale class: the link must win over it
    linkedBudgets: { 'family-share': 'family' },
};

const a = analyzeSpending(personal, mappings, { family });
assertEq('structural = 2000 × 50%', a.macros.structural.totalOutflow, 1000);
assertEq('variable = 2000 × 30%', a.macros.variable.totalOutflow, 600);
assertEq('compressible = 2000 × 20% + 400 own', a.macros.compressible.totalOutflow, 800);
assertEq('the stale class gets nothing', a.macros.investments.totalOutflow, 0);
assertEq('nothing unmapped', a.unmappedOutflow, 0);
assertEq('one linked split', a.linkedSplits.length, 1);
assertEq('split share structural', a.linkedSplits[0].shares!.structural, 0.5);
assertEq('total outflow is unchanged', a.totalOutflow, 2400);

// The split lands on the linked budget's own categories, tagged with their source.
const rentShare = a.macros.structural.categories.find(c => c.categoryId === 'family-share>rent');
assertTrue('rent of the family budget appears under structural', !!rentShare);
assertEq('rent share = 2000 × 50%', rentShare!.totalOutflow, 1000);
assertTrue('rent share comes from the family-share category', rentShare!.linkedFrom?.categoryId === 'family-share' && rentShare!.linkedFrom?.budgetId === 'family');
const dining = a.macros.compressible.categories.find(c => c.categoryId === 'family-share>dining');
assertEq('dining share = 2000 × 20%', dining!.totalOutflow, 400);
const own = a.macros.compressible.categories.find(c => c.categoryId === 'fun');
assertTrue('own categories are not tagged', !!own && !own.linkedFrom);
const sumOf = (m: 'structural' | 'variable' | 'compressible') => a.macros[m].categories.reduce((s, c) => s + c.totalOutflow, 0);
assertEq('categories add up to the class (compressible)', sumOf('compressible'), a.macros.compressible.totalOutflow);

// A refund in the linked budget does not inflate the other categories.
const familyWithRefund = [month('2026-01-01', 0, [['rent', 'g-home', 1000], ['food', 'g-food', 600], ['dining', 'g-out', 400], ['refund', 'g-out', -100]])];
const withRefund = analyzeSpending(personal, mappings, { family: familyWithRefund });
const compSplit = withRefund.macros.compressible.categories.filter(c => c.linkedFrom).reduce((s, c) => s + c.totalOutflow, 0);
assertEq('linked compressible = 2000 × share of the class', compSplit, 2000 * withRefund.linkedSplits[0].shares!.compressible);

// Decision horizon: own categories by their group, linked shares by the
// linked budget's categories; anything without a decision lands in 'unset'.
const withDecisions: YnabMacroMappings = { ...mappings, decisionGroups: { 'g-home': 'past', 'g-food': 'current', 'g-fun': 'current' } };
const d = analyzeSpending(personal, withDecisions, { family }).decisionTotals;
assertEq('past = rent share', d.past, 1000);
assertEq('current = food share + own fun', d.current, 600 + 400);
assertEq('unset = dining share (no decision on g-out)', d.unset, 400);
assertEq('decisions add up to total outflow', d.past + d.current + d.future + d.unset, 2400);

const noHistory = analyzeSpending(personal, mappings, {});
assertTrue('unsynced budget: shares are null', noHistory.linkedSplits[0].shares === null);
assertEq('unsynced budget: the category is unmapped', noHistory.unmappedOutflow, 2000);

// The linked budget's own links are not followed (no cycles).
const cyclic: YnabMacroMappings = { ...mappings, linkedBudgets: { 'family-share': 'family', rent: 'personal' } };
const c = analyzeSpending(personal, cyclic, { family, personal });
assertEq('a link inside the linked budget is ignored', c.macros.structural.totalOutflow, 1000);

console.log('verify-linked-budget-split: all checks passed');
