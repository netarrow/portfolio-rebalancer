// Known-answer checks for the capex ↔ bond match: an allocation pinned to a
// bond (real or virtual) is matched by its maturity; anything else needs a
// bond search for what no on-time bond covers.
// Run with: npx esbuild scripts/verify-capex-bond-match.ts --bundle --format=esm | node --input-type=module
import { capexBondMatch } from '../src/utils/capexBondMatch';
import type { AssetDefinition, VirtualBond, YnabGoal, YnabGoalAllocation } from '../src/types';

const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
    console.log(`ok ${label} = ${a}`);
};

const goal = (id: string, target: number, date: string | undefined, cash = 0): YnabGoal => ({
    id, ynabBudgetId: 'b', name: id, targetAmount: target, targetDate: date, cashCoverage: cash, targetSource: 'parsed-name', lastSyncedAt: '',
});
const alloc = (goalId: string, amount: number, ticker?: string): YnabGoalAllocation => ({
    id: `${goalId}-${ticker ?? 'p'}`, ynabGoalId: goalId, portfolioId: 'p', amount, ...(ticker ? { ticker } : {}), createdAt: '', updatedAt: '',
});
const defs: AssetDefinition[] = [
    { ticker: 'IT0000000017', label: 'BTP 01/06/2027 2%', assetClass: 'Bond', source: 'MOT' },
    { ticker: 'IT0000000025', label: 'BTP Long', assetClass: 'Bond', source: 'MOT', maturityDate: '2031-01-01' },
    { ticker: 'IE0000000001', label: 'Bond ETF', assetClass: 'Bond', source: 'ETF' },
];
const vbs: VirtualBond[] = [{ id: 'v1', label: 'BTP ~2028', targetMaturityDate: '2028-03-01', universe: 'IT', minMonthsBefore: 1, maxMonthsBefore: 6, createdAt: '' }];

const generic = capexBondMatch(goal('A', 5000, '2027-09-01', 1000), [alloc('A', 4000)], defs, vbs);
check('on the portfolio as a whole: search for target − cash', [generic.needsSearch, generic.toMatch, generic.generic], [true, 4000, 4000]);

const tied = capexBondMatch(goal('B', 5000, '2027-09-01'), [alloc('B', 5000, 'IT0000000017')], defs, vbs);
check('tied to a bond maturing in time (date read from its name): nothing to search', [tied.needsSearch, tied.bonds[0].maturityDate, tied.bonds[0].late], [false, '2027-06-01', false]);

const late = capexBondMatch(goal('C', 5000, '2027-09-01'), [alloc('C', 5000, 'IT0000000025')], defs, vbs);
check('tied to a bond maturing too late: still to search', [late.needsSearch, late.toMatch, late.bonds[0].late], [true, 5000, true]);

const mixed = capexBondMatch(goal('D', 6000, '2028-06-01'), [alloc('D', 4000, '_VBOND_v1'), alloc('D', 2000, 'IE0000000001')], defs, vbs);
check('a planned virtual bond counts; the ETF part does not', [mixed.bonds[0].planned, mixed.generic, mixed.toMatch, mixed.needsSearch], [true, 2000, 2000, true]);

const undated = capexBondMatch(goal('E', 3000, undefined), [alloc('E', 3000)], defs, vbs);
check('no date: no search flag', undated.needsSearch, false);

console.log('verify-capex-bond-match: all checks passed');
