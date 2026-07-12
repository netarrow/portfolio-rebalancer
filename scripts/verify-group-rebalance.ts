// Known-answer checks for the parent/child inter-portfolio rebalance plan:
// Sell+Buy deltas & transfers, Buy-Only required liquidity & splits, target
// normalization, tolerance/balanced detection, and degenerate inputs.
// Run with: npx esbuild scripts/verify-group-rebalance.ts --bundle --format=esm | node --input-type=module
import { computeGroupRebalance } from '../src/utils/groupRebalance';

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

// ── 1. Core 80 / Bond Buffer 20, Core overweight ──
{
    const plan = computeGroupRebalance([
        { portfolioId: 'core', name: 'Core', currentValue: 8400, targetBasis: 8000 },
        { portfolioId: 'buf', name: 'Bond Buffer', currentValue: 1600, targetBasis: 2000 },
    ])!;
    assertTrue('p1 plan exists', !!plan);
    assertEq('p1 group total', plan.groupTotal, 10000);
    const core = plan.members.find(m => m.portfolioId === 'core')!;
    const buf = plan.members.find(m => m.portfolioId === 'buf')!;
    assertEq('p1 core target share', core.targetShare, 80);
    assertEq('p1 buffer target share', buf.targetShare, 20);
    // Sell+Buy: move €400 Core → Buffer
    assertEq('p1 core delta (sell)', core.delta, -400);
    assertEq('p1 buffer delta (buy)', buf.delta, 400);
    assertTrue('p1 not balanced', !plan.balanced);
    assertEq('p1 one transfer', plan.transfers.length, 1);
    assertEq('p1 transfer amount', plan.transfers[0].amount, 400);
    assertTrue('p1 transfer core→buffer', plan.transfers[0].fromId === 'core' && plan.transfers[0].toId === 'buf');
    // Buy Only: implied total = 8400/0.8 = 10500 → add €500, all into Buffer
    assertEq('p1 buy-only required', plan.buyOnlyRequired, 500);
    assertEq('p1 buy-only core', core.buyOnlyAmount, 0);
    assertEq('p1 buy-only buffer', buf.buyOnlyAmount, 500);
    assertTrue('p1 reachable buy-only', !plan.buyOnlyUnreachable);
}

// ── 2. Target basis is relative: 0.8/0.2 behaves exactly like 8000/2000 ──
{
    const plan = computeGroupRebalance([
        { portfolioId: 'core', name: 'Core', currentValue: 8400, targetBasis: 0.8 },
        { portfolioId: 'buf', name: 'Bond Buffer', currentValue: 1600, targetBasis: 0.2 },
    ])!;
    assertEq('p2 core delta', plan.members[0].delta, -400);
    assertEq('p2 buy-only required', plan.buyOnlyRequired, 500);
}

// ── 3. Already on target → balanced, no transfers ──
{
    const plan = computeGroupRebalance([
        { portfolioId: 'core', name: 'Core', currentValue: 8000, targetBasis: 80 },
        { portfolioId: 'buf', name: 'Bond Buffer', currentValue: 2000, targetBasis: 20 },
    ])!;
    assertTrue('p3 balanced', plan.balanced);
    assertEq('p3 no transfers', plan.transfers.length, 0);
    assertEq('p3 buy-only required', plan.buyOnlyRequired, 0);
}

// ── 4. Small drift within tolerance (max(€1, 0.5%)) still counts as balanced ──
{
    const plan = computeGroupRebalance([
        { portfolioId: 'core', name: 'Core', currentValue: 8030, targetBasis: 80 },
        { portfolioId: 'buf', name: 'Bond Buffer', currentValue: 1970, targetBasis: 20 },
    ])!;
    assertEq('p4 tolerance', plan.tolerance, 50); // 0.5% of 10000
    assertTrue('p4 balanced within tolerance', plan.balanced);
}

// ── 5. Three members: one seller funds two buyers ──
{
    const plan = computeGroupRebalance([
        { portfolioId: 'a', name: 'A', currentValue: 7000, targetBasis: 50 },
        { portfolioId: 'b', name: 'B', currentValue: 2000, targetBasis: 30 },
        { portfolioId: 'c', name: 'C', currentValue: 1000, targetBasis: 20 },
    ])!;
    // Targets on 10000: A 5000 (−2000), B 3000 (+1000), C 2000 (+1000)
    assertEq('p5 A delta', plan.members[0].delta, -2000);
    assertEq('p5 transfers count', plan.transfers.length, 2);
    const total = plan.transfers.reduce((s, t) => s + t.amount, 0);
    assertEq('p5 transfers total', total, 2000);
    assertTrue('p5 all from A', plan.transfers.every(t => t.fromId === 'a'));
    // Buy Only: implied total = 7000/0.5 = 14000 → add 4000: B +2200, C +1800
    assertEq('p5 buy-only required', plan.buyOnlyRequired, 4000);
    assertEq('p5 buy-only B', plan.members[1].buyOnlyAmount, 2200);
    assertEq('p5 buy-only C', plan.members[2].buyOnlyAmount, 1800);
}

// ── 6. 0%-target member holding value → flagged unreachable in Buy Only ──
{
    const plan = computeGroupRebalance([
        { portfolioId: 'a', name: 'A', currentValue: 8000, targetBasis: 100 },
        { portfolioId: 'b', name: 'B', currentValue: 2000, targetBasis: 0 },
    ])!;
    assertTrue('p6 buy-only unreachable', plan.buyOnlyUnreachable);
    // Sell+Buy still works: sell all of B into A
    assertEq('p6 B delta', plan.members[1].delta, -2000);
}

// ── 7. Degenerate inputs → null ──
{
    assertTrue('p7 single member → null', computeGroupRebalance([
        { portfolioId: 'a', name: 'A', currentValue: 8000, targetBasis: 100 },
    ]) === null);
    assertTrue('p7 zero basis → null', computeGroupRebalance([
        { portfolioId: 'a', name: 'A', currentValue: 8000, targetBasis: 0 },
        { portfolioId: 'b', name: 'B', currentValue: 2000, targetBasis: 0 },
    ]) === null);
    assertTrue('p7 zero value → null', computeGroupRebalance([
        { portfolioId: 'a', name: 'A', currentValue: 0, targetBasis: 80 },
        { portfolioId: 'b', name: 'B', currentValue: 0, targetBasis: 20 },
    ]) === null);
}

console.log('\nAll group-rebalance checks passed.');
