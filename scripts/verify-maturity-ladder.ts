// Known-answer checks for the capex maturity ladder: a capex is covered by
// bonds maturing before its date, then cash, then a sale; bonds maturing
// later are locked; what is left is missing, or planned on a virtual bond.
// Run with: npx esbuild scripts/verify-maturity-ladder.ts --bundle --format=esm | node --input-type=module
import { buildMaturityLadder, maturityFromLabel, type LadderHolding } from '../src/utils/maturityLadder';
import type { YnabGoal, YnabGoalAllocation } from '../src/types';

const assertEq = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
    console.log(`ok ${label} = ${a}`);
};

const goal = (id: string, target: number, date: string, cash = 0): YnabGoal => ({
    id, ynabBudgetId: 'b', name: id, targetAmount: target, targetDate: date, cashCoverage: cash, targetSource: 'parsed-name', lastSyncedAt: '',
});
const alloc = (goalId: string, portfolioId: string, amount: number, ticker?: string): YnabGoalAllocation => ({
    id: `${goalId}-${portfolioId}-${ticker ?? ''}`, ynabGoalId: goalId, portfolioId, amount, ...(ticker ? { ticker } : {}), createdAt: '', updatedAt: '',
});
const bond = (key: string, value: number, maturityDate: string): LadderHolding => ({ key, label: key, value, kind: 'bond', maturityDate });

// 10k of bonds maturing in mid-2029 back two capex due after it; a third,
// due in six months, is allocated to the same portfolio.
const security = { id: 'sec', name: 'Security', holdings: [bond('BTP29', 10000, '2029-06-01')] };
const l = buildMaturityLadder({
    portfolios: [security],
    goals: [goal('X', 5000, '2029-12-01'), goal('Y', 5000, '2030-06-01'), goal('Z', 5000, '2027-04-30')],
    allocations: [alloc('X', 'sec', 5000), alloc('Y', 'sec', 5000), alloc('Z', 'sec', 5000)],
});
assertEq('Z, due first, finds no bond in time', [l.goals.get('Z')!.missing, l.goals.get('Z')!.status], [5000, 'missing']);
assertEq('the 2029 bond is locked for X and Y', l.goals.get('Z')!.locked.map(b => [b.label, b.usedBy]), [['BTP29', ['X', 'Y']]]);
assertEq('X and Y are covered at maturity', [l.goals.get('X')!.status, l.goals.get('Y')!.status, l.goals.get('X')!.fromMaturity[0].amount], ['covered', 'covered', 5000]);
assertEq('portfolio: 10k held, 15k counted on, 5k missing', [l.portfolios[0].held, l.portfolios[0].demand, l.portfolios[0].missing], [10000, 15000, 5000]);

// The same with 15k of 2029 bonds: X and Y claim 10k, the other 5k is free
// and covers Z, but only by selling before maturity.
const more = buildMaturityLadder({
    portfolios: [{ ...security, holdings: [bond('BTP29', 15000, '2029-06-01')] }],
    goals: [goal('X', 5000, '2029-12-01'), goal('Y', 5000, '2030-06-01'), goal('Z', 5000, '2027-04-30')],
    allocations: [alloc('X', 'sec', 5000), alloc('Y', 'sec', 5000), alloc('Z', 'sec', 5000)],
});
assertEq('Z covered by selling the unclaimed 5k of the 2029 bond', [more.goals.get('Z')!.status, more.goals.get('Z')!.fromSelling[0].amount, more.goals.get('Z')!.missing], ['selling', 5000, 0]);

// A bond maturing in time, then cash, then a sale.
const mixed = buildMaturityLadder({
    portfolios: [{ id: 'p', name: 'P', holdings: [bond('BOT27', 3000, '2027-03-14'), { key: '_CASH_', label: 'Cash', value: 1000, kind: 'cash' }, { key: 'ETF', label: 'ETF', value: 4000, kind: 'liquid' }] }],
    goals: [goal('Z', 5000, '2027-04-30')],
    allocations: [alloc('Z', 'p', 5000)],
});
const z = mixed.goals.get('Z')!;
assertEq('maturity 3k + cash 1k + sale 1k', [z.fromMaturity[0].amount, z.fromCash[0].amount, z.fromSelling[0].amount, z.missing, z.status], [3000, 1000, 1000, 0, 'selling']);

// Pinned to a virtual bond not bought yet: parked cash, the rest planned.
const planned = buildMaturityLadder({
    portfolios: [{ id: 'p', name: 'P', holdings: [{ key: '_VBOND_1', label: 'BTP 2027', value: 1000, kind: 'cash', plannedBond: true }] }],
    goals: [goal('Z', 4000, '2027-12-01')],
    allocations: [alloc('Z', 'p', 4000, '_VBOND_1')],
});
const pz = planned.goals.get('Z')!;
assertEq('parked 1k, 3k planned, nothing missing', [pz.fromCash[0].amount, pz.planned[0].amount, pz.missing, pz.status], [1000, 3000, 0, 'planned']);

const empty = buildMaturityLadder({
    portfolios: [{ id: 'p', name: 'P', holdings: [{ key: '_VBOND_2', label: 'BTP 2028', value: 0, kind: 'cash', plannedBond: true }] }],
    goals: [goal('Q', 2000, '2028-12-01')],
    allocations: [alloc('Q', 'p', 2000, '_VBOND_2')],
});
assertEq('a virtual bond with nothing parked yet is all planned', [empty.goals.get('Q')!.planned[0].amount, empty.goals.get('Q')!.status], [2000, 'planned']);

// The part of a capex no portfolio is counted on for is missing too.
const un = buildMaturityLadder({
    portfolios: [{ id: 'p', name: 'P', holdings: [bond('B', 5000, '2027-01-01')] }],
    goals: [goal('W', 10000, '2027-06-01', 2000)],
    allocations: [alloc('W', 'p', 5000)],
});
assertEq('need 8k, 5k allocated and covered, 3k unassigned', [un.goals.get('W')!.need, un.goals.get('W')!.unassigned, un.goals.get('W')!.missing], [8000, 3000, 3000]);

// A bond pinned to a capex but maturing after it: covered only by selling it.
const late = buildMaturityLadder({
    portfolios: [{ id: 'p', name: 'P', holdings: [bond('B30', 5000, '2030-01-01')] }],
    goals: [goal('V', 5000, '2027-06-01')],
    allocations: [alloc('V', 'p', 5000, 'B30')],
});
assertEq('pinned bond maturing late = a sale', [late.goals.get('V')!.fromSelling[0].amount, late.goals.get('V')!.status], [5000, 'selling']);

assertEq('maturity read from a bond name', [maturityFromLabel('BTP 01/11/2027 6,5%'), maturityFromLabel('iShares Core MSCI World')], ['2027-11-01', undefined]);

console.log('verify-maturity-ladder: all checks passed');
