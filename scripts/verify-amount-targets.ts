// Known-answer checks for amount-mode (asset-liability) portfolios: € targets
// from linked YNAB goals or manual figures, derived weights, MOT bond lots and
// the nearest-due-date-first buy plan that never sells.
// Run with: npx esbuild scripts/verify-amount-targets.ts --bundle --format=esm | node --input-type=module
import {
    resolveAmountTargets, derivePercentAllocations, sameAllocations, lotUnitsFor,
    planAmountBuys, suggestLotQuantity, type AmountPlanUnit,
} from '../src/utils/amountTargets';
import type { Portfolio, YnabGoal, YnabGoalAllocation, VirtualBond, AssetDefinition } from '../src/types';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};

const VB = '_VBOND_aa-bb';
const portfolio: Portfolio = {
    id: 'p1', name: 'Security', order: 0, targetMode: 'amount',
    amountTargets: { IT0005: 5000, [VB]: 1234, IE00ETF: 2000 },
};
const goals: YnabGoal[] = [
    { id: 'g1', ynabBudgetId: 'b', name: 'Car', targetAmount: 3000, targetDate: '2028-06-01', cashCoverage: 0, targetSource: 'parsed-name', lastSyncedAt: '' },
    { id: 'g2', ynabBudgetId: 'b', name: 'Roof', targetAmount: 2000, targetDate: '2027-03-01', cashCoverage: 0, targetSource: 'parsed-name', lastSyncedAt: '' },
];
const allocs: YnabGoalAllocation[] = [
    { id: 'a1', portfolioId: 'p1', ynabGoalId: 'g1', amount: 3000, ticker: VB, createdAt: '', updatedAt: '' },
    { id: 'a2', portfolioId: 'p1', ynabGoalId: 'g2', amount: 2000, ticker: VB, createdAt: '', updatedAt: '' },
    // whole-portfolio allocation and another portfolio's: never a row target
    { id: 'a3', portfolioId: 'p1', ynabGoalId: 'g1', amount: 999, createdAt: '', updatedAt: '' },
    { id: 'a4', portfolioId: 'p2', ynabGoalId: 'g1', amount: 777, ticker: 'IT0005', createdAt: '', updatedAt: '' },
    // lower-case ticker still lands on the IT0005 row
    { id: 'a5', portfolioId: 'p1', ynabGoalId: 'g2', amount: 500, ticker: 'it0005', createdAt: '', updatedAt: '' },
];
const vbonds: VirtualBond[] = [
    { id: 'aa-bb', label: 'BTP 2029', targetMaturityDate: '2029-01-01', universe: 'IT', minMonthsBefore: 1, maxMonthsBefore: 6, createdAt: '' },
];

// ── 1. Target resolution ──
{
    const rows = resolveAmountTargets(portfolio, allocs, goals, vbonds);
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    assertEq('t1 row count', rows.length, 3);
    assertEq('t1 vbond target = sum of linked goals (manual ignored)', by[VB].target, 5000);
    assertTrue('t1 vbond source goals', by[VB].source === 'goals');
    assertTrue('t1 vbond due = nearest goal date', by[VB].dueDate === '2027-03-01');
    assertEq('t1 IT0005 target from goal link, case-insensitive', by['IT0005'].target, 500);
    assertEq('t1 ETF manual target', by['IE00ETF'].target, 2000);
    assertTrue('t1 ETF no due date', by['IE00ETF'].dueDate === undefined);

    // unlinked virtual bond falls back to its maturity
    const rows2 = resolveAmountTargets({ ...portfolio, amountTargets: { [VB]: 1000 } }, [], goals, vbonds);
    assertTrue('t1 vbond due = maturity when unlinked', rows2[0].dueDate === '2029-01-01');

    // zero manual, no goals → no row
    const rows3 = resolveAmountTargets({ ...portfolio, amountTargets: { X: 0 } }, [], goals, vbonds);
    assertEq('t1 empty row dropped', rows3.length, 0);
}

// ── 2. Derived weights ──
{
    const rows = resolveAmountTargets(portfolio, allocs, goals, vbonds); // 5000 + 500 + 2000
    const w = derivePercentAllocations(rows);
    assertEq('w2 vbond weight', w[VB], Math.round(5000 / 7500 * 1e6) / 1e4);
    assertEq('w2 sums to 100', Object.values(w).reduce((s, v) => s + v, 0), 100, 1e-3);
    assertTrue('w2 same allocations', sameAllocations(w, { ...w }));
    assertTrue('w2 differs on extra key', !sameAllocations(w, { ...w, Z: 1 }));
}

// ── 3. Lots ──
{
    const settings: AssetDefinition[] = [
        { ticker: 'IT0005', source: 'MOT', assetClass: 'Bond' },
        { ticker: 'IE00BOND', source: 'ETF', assetClass: 'Bond' },
    ];
    assertEq('l3 MOT per-100 price → 10 units', lotUnitsFor('IT0005', 98.5, settings), 10);
    assertEq('l3 MOT per-1 price → 1000 units', lotUnitsFor('IT0005', 0.985, settings), 1000);
    assertEq('l3 bond ETF → 1', lotUnitsFor('IE00BOND', 5, settings), 1);
    assertEq('l3 vbond → 1', lotUnitsFor(VB, 1, settings), 1);
    assertEq('l3 suggest 5k at 98 → 5 lots', suggestLotQuantity(5000, 98, 10), 50);
    assertEq('l3 suggest 5k at 104 → 5 lots', suggestLotQuantity(5000, 104, 10), 50);
    assertEq('l3 suggest 400 → at least 1 lot', suggestLotQuantity(400, 98, 10), 10);
}

// ── 4. Plan: nearest due first, lots, budget carries on ──
{
    const units: AmountPlanUnit[] = [
        { key: 'ETF', price: 100, currentValue: 0, target: 1000, lotUnits: 1, order: 0 },               // no date → last
        { key: 'BTP27', price: 98, currentValue: 0, target: 3000, dueDate: '2027-01-01', lotUnits: 10, order: 1 },
        { key: 'BTP26', price: 99, currentValue: 0, target: 2000, dueDate: '2026-12-01', lotUnits: 10, order: 2 },
    ];
    // Budget 4000: BTP26 gets 2 lots (1980), BTP27 wants 3 lots (2940) but only
    // 2 fit (1960 → 60 left), ETF gets 0 (60 < 100).
    const plan = planAmountBuys(units, 4000);
    assertEq('p4 BTP26 shares', plan.lines.BTP26.shares, 20);
    assertTrue('p4 BTP26 funded', plan.lines.BTP26.status === 'funded');
    assertEq('p4 BTP27 shares', plan.lines.BTP27.shares, 20);
    assertTrue('p4 BTP27 partial', plan.lines.BTP27.status === 'partial');
    assertEq('p4 ETF shares', plan.lines.ETF.shares, 0);
    assertTrue('p4 ETF unfunded', plan.lines.ETF.status === 'unfunded');
    assertEq('p4 spent', plan.spent, 3940);
    assertEq('p4 leftover', plan.leftover, 60);
    assertEq('p4 required', plan.required, 1980 + 2940 + 1000);

    // A lot the budget can't pay for doesn't block a cheaper, later row.
    const plan2 = planAmountBuys([
        { key: 'BTP', price: 100, currentValue: 0, target: 1000, dueDate: '2026-01-01', lotUnits: 10, order: 0 },
        { key: 'ETF', price: 50, currentValue: 0, target: 500, dueDate: '2027-01-01', lotUnits: 1, order: 1 },
    ], 600);
    assertEq('p4 big lot skipped', plan2.lines.BTP.shares, 0);
    assertEq('p4 cheaper row still bought', plan2.lines.ETF.shares, 10);

    // Above target: reported as excess, never sold.
    const plan3 = planAmountBuys([{ key: 'BTP', price: 105, currentValue: 5250, target: 5000, lotUnits: 10, order: 0 }], 1000);
    assertTrue('p4 above target covered', plan3.lines.BTP.status === 'covered');
    assertEq('p4 excess', plan3.lines.BTP.excess, 250);
    assertEq('p4 no sell', plan3.lines.BTP.shares, 0);
    assertEq('p4 budget untouched', plan3.leftover, 1000);

    // Gap under half a lot: nothing to buy.
    const plan4 = planAmountBuys([{ key: 'BTP', price: 100, currentValue: 4700, target: 5000, lotUnits: 10, order: 0 }], 5000);
    assertTrue('p4 below lot', plan4.lines.BTP.status === 'below-lot');

    // Virtual bond parking: euro-exact at price 1.
    const plan5 = planAmountBuys([{ key: VB, price: 1, currentValue: 1200, target: 5000, lotUnits: 1, order: 0 }], 10000);
    assertEq('p4 parking eur', plan5.lines[VB].eur, 3800);
}

console.log('\nall amount-target checks passed');
