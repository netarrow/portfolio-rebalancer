// Known-answer checks for PAC scheduling and installment math: due-date
// generation, rounding modes, fee handling, and the parking/carry invariant.
// Run with: npx esbuild scripts/verify-pac-schedule.ts --bundle --format=esm | node --input-type=module
import type { Broker, PacExecution, PacPlan } from '../src/types';
import { addPeriods, carryInFor, computeInstalment, generateInstalments } from '../src/utils/pacSchedule';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};
const assertArrayEq = (label: string, actual: string[], expected: string[]) => {
    if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
        throw new Error(`${label}: expected [${expected.join(',')}], got [${actual.join(',')}]`);
    }
    console.log(`ok ${label} = [${actual.join(',')}]`);
};

const basePlan: PacPlan = {
    id: 'p1', name: 'Test PAC', ticker: 'VWCE', portfolioId: 'port1', brokerId: 'brk1',
    mode: 'amount', amount: 100, frequency: 'monthly', startDate: '2025-01-15',
    costMode: 'none', costsIncluded: true, rounding: 'fractional', active: true,
    createdAt: '2025-01-01T00:00:00.000Z',
};

// ── 0. addPeriods across all frequencies ──
assertEq('weekly +1', new Date(addPeriods('2025-01-01', 'weekly', 1)).getTime(), new Date('2025-01-08').getTime());
assertEq('biweekly +1', new Date(addPeriods('2025-01-01', 'biweekly', 1)).getTime(), new Date('2025-01-15').getTime());
assertTrue('monthly +1', addPeriods('2025-01-15', 'monthly', 1) === '2025-02-15');
assertTrue('bimonthly +1', addPeriods('2025-01-15', 'bimonthly', 1) === '2025-03-15');
assertTrue('quarterly +1', addPeriods('2025-01-15', 'quarterly', 1) === '2025-04-15');
assertTrue('semiannual +1', addPeriods('2025-01-15', 'semiannual', 1) === '2025-07-15');
assertTrue('annual +1', addPeriods('2025-01-15', 'annual', 1) === '2026-01-15');

// ── 1. generateInstalments: due dates through today, capped at endDate ──
{
    const dates = generateInstalments(basePlan, '2025-04-20');
    assertArrayEq('monthly schedule through Apr', dates, ['2025-01-15', '2025-02-15', '2025-03-15', '2025-04-15']);
}
{
    const capped: PacPlan = { ...basePlan, endDate: '2025-03-15' };
    const dates = generateInstalments(capped, '2025-12-31');
    assertArrayEq('schedule stops at endDate', dates, ['2025-01-15', '2025-02-15', '2025-03-15']);
}
{
    const dates = generateInstalments(basePlan, '2025-01-15', 2);
    assertArrayEq('extraFuture previews upcoming rows', dates, ['2025-01-15', '2025-02-15', '2025-03-15']);
}

// ── 2. Fractional rounding: no residue, exact fractional shares ──
{
    const math = computeInstalment({ plan: basePlan, price: 30, carryIn: 0 });
    assertEq('fractional quantity', math.quantity, 100 / 30);
    assertEq('fractional tradeValue', math.tradeValue, 100);
    assertEq('fractional carryOut', math.carryOut, 0);
    assertEq('fractional parkedDelta', math.parkedDelta, 0);
    assertEq('fractional totalOutlay', math.totalOutlay, 100);
}

// ── 3. Floor rounding: residue parked, never reused ──
{
    const plan: PacPlan = { ...basePlan, rounding: 'floor' };
    const math = computeInstalment({ plan, price: 30, carryIn: 0 });
    assertEq('floor quantity', math.quantity, 3); // floor(100/30)
    assertEq('floor tradeValue', math.tradeValue, 90);
    assertEq('floor carryOut', math.carryOut, 10);
    assertEq('floor parkedDelta (no carryIn to net out)', math.parkedDelta, 10);
}

// ── 4. Floor-carry chain: carryOut feeds into next installment's carryIn ──
{
    const plan: PacPlan = { ...basePlan, rounding: 'floor-carry' };
    const executions: PacExecution[] = [];

    // Installment 1: budget 100 @ price 30 -> qty 3, carryOut 10
    const carryIn1 = carryInFor(plan, executions, '2025-01-15');
    assertEq('carry-carry c1 carryIn', carryIn1, 0);
    const m1 = computeInstalment({ plan, price: 30, carryIn: carryIn1 });
    assertEq('carry-carry c1 quantity', m1.quantity, 3);
    assertEq('carry-carry c1 carryOut', m1.carryOut, 10);
    assertEq('carry-carry c1 parkedDelta', m1.parkedDelta, 10);
    executions.push({ planId: 'p1', dueDate: '2025-01-15', carryIn: carryIn1, carryOut: m1.carryOut, parkedDelta: m1.parkedDelta });

    // Installment 2: budget 100 + carryIn 10 = 110 @ price 30 -> qty 3, carryOut 20
    const carryIn2 = carryInFor(plan, executions, '2025-02-15');
    assertEq('carry-carry c2 carryIn (reused from c1 carryOut)', carryIn2, 10);
    const m2 = computeInstalment({ plan, price: 30, carryIn: carryIn2 });
    assertEq('carry-carry c2 quantity', m2.quantity, 3); // floor(110/30) = 3
    assertEq('carry-carry c2 carryOut', m2.carryOut, 20); // 110 - 90
    assertEq('carry-carry c2 parkedDelta', m2.parkedDelta, 10); // 20 - 10
    executions.push({ planId: 'p1', dueDate: '2025-02-15', carryIn: carryIn2, carryOut: m2.carryOut, parkedDelta: m2.parkedDelta });

    // Installment 3: budget 100 + carryIn 20 = 120 @ price 30 -> qty 4 exactly, carryOut 0
    const carryIn3 = carryInFor(plan, executions, '2025-03-15');
    assertEq('carry-carry c3 carryIn', carryIn3, 20);
    const m3 = computeInstalment({ plan, price: 30, carryIn: carryIn3 });
    assertEq('carry-carry c3 quantity', m3.quantity, 4);
    assertEq('carry-carry c3 carryOut', m3.carryOut, 0);
    assertEq('carry-carry c3 parkedDelta', m3.parkedDelta, -20);
    executions.push({ planId: 'p1', dueDate: '2025-03-15', carryIn: carryIn3, carryOut: m3.carryOut, parkedDelta: m3.parkedDelta });

    // Invariant: sum of parkedDelta across the chain == last execution's carryOut
    const sumParkedDelta = executions.reduce((s, e) => s + (e.parkedDelta ?? 0), 0);
    const lastCarryOut = executions[executions.length - 1].carryOut ?? 0;
    assertEq('floor-carry: sum(parkedDelta) == last carryOut', sumParkedDelta, lastCarryOut);
}

// ── 5. Floor (no reuse): residue accumulates, sum(parkedDelta) == sum(carryOut) ──
{
    const plan: PacPlan = { ...basePlan, rounding: 'floor' };
    const executions: PacExecution[] = [];
    let totalParked = 0;
    for (const dueDate of ['2025-01-15', '2025-02-15', '2025-03-15']) {
        const carryIn = carryInFor(plan, executions, dueDate);
        assertEq(`floor-no-reuse ${dueDate} carryIn always 0`, carryIn, 0);
        const m = computeInstalment({ plan, price: 30, carryIn });
        executions.push({ planId: 'p1', dueDate, carryIn, carryOut: m.carryOut, parkedDelta: m.parkedDelta });
        totalParked += m.parkedDelta;
    }
    assertEq('floor-no-reuse total parked = 3 * 10', totalParked, 30);
}

// ── 6. Cost handling: costsIncluded nets fee out of the budget ──
{
    const plan: PacPlan = { ...basePlan, costMode: 'fixed', costFixed: 5, costsIncluded: true, rounding: 'fractional' };
    const math = computeInstalment({ plan, price: 30, carryIn: 0 });
    assertEq('costsIncluded fee', math.fee, 5);
    assertEq('costsIncluded netForShares quantity', math.quantity, (100 - 5) / 30);
    assertEq('costsIncluded totalOutlay == budget', math.totalOutlay, 100);
}
{
    const plan: PacPlan = { ...basePlan, costMode: 'fixed', costFixed: 5, costsIncluded: false, rounding: 'fractional' };
    const math = computeInstalment({ plan, price: 30, carryIn: 0 });
    assertEq('costsExcluded fee', math.fee, 5);
    assertEq('costsExcluded full-budget quantity', math.quantity, 100 / 30);
    assertEq('costsExcluded totalOutlay == budget + fee', math.totalOutlay, 105);
}

// ── 7. Broker commission mode: percent with min/max clamp ──
{
    const broker: Broker = { id: 'brk1', name: 'Test Broker', commissionType: 'percent', commissionPercent: 1, commissionMin: 2, commissionMax: 10 };
    const plan: PacPlan = { ...basePlan, costMode: 'broker', costsIncluded: true, rounding: 'fractional', amount: 1000 };
    const math = computeInstalment({ plan, price: 30, broker, carryIn: 0 });
    assertEq('broker percent fee (1% of 1000, within min/max)', math.fee, 10); // clamped to max
}

// ── 8. Quantity mode: fixed units, never touches parking ──
{
    const plan: PacPlan = { ...basePlan, mode: 'quantity', quantity: 5, rounding: 'floor-carry' };
    const math = computeInstalment({ plan, price: 30, carryIn: 999 }); // carryIn should be irrelevant/unused
    assertEq('quantity mode buys exact units', math.quantity, 5);
    assertEq('quantity mode tradeValue', math.tradeValue, 150);
    assertEq('quantity mode carryOut always 0', math.carryOut, 0);
    assertEq('quantity mode parkedDelta always 0', math.parkedDelta, 0);
}

console.log('\nAll PAC schedule checks passed.');
