// Known-answer checks for weighted intra-group distribution: buy convergence,
// proportional splits, frozen-member exclusion, whole-share feasibility,
// weighted sells, invalid-weight blocking, and priority-mode regression.
// Run with: npx esbuild scripts/verify-weighted-groups.ts --bundle --format=esm | node --input-type=module
import type { AllocationMemberRule } from '../src/types';
import { distributeGroupDelta, groupWeightConfig, isFullyFrozen, type MemberMarketInfo } from '../src/utils/allocationGroups';

const info = (entries: [string, number, number][]): Record<string, MemberMarketInfo> => {
    const map: Record<string, MemberMarketInfo> = {};
    entries.forEach(([ticker, currentValue, price]) => {
        map[ticker.toUpperCase()] = { ticker, currentValue, price };
    });
    return map;
};

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

const MEMBERS = ['VWCE', 'SWDA', 'XMME'];
// VWCE frozen (its weight must be ignored), SWDA 85 / XMME 15
const RULES: Record<string, AllocationMemberRule> = {
    VWCE: { noBuy: true, noSell: true, weight: 100 },
    SWDA: { weight: 85 },
    XMME: { weight: 15 },
};
// Prices: VWCE 130, SWDA 110, XMME 30

// ── 0. Weight config resolution ──
const cfg = groupWeightConfig(MEMBERS, RULES);
assertTrue('weighted mode active', cfg.weighted);
assertTrue('weights valid (frozen VWCE weight ignored)', cfg.valid);
assertEq('active weight sum', cfg.sum, 100);
assertTrue('isFullyFrozen(VWCE)', isFullyFrozen(RULES.VWCE));

// ── 1. Buy convergence: small buy lands entirely on the underweight member ──
{
    // Pool ideals with +1000: pool = (10000+8500+500+1000) - 10000 = 10000 → SWDA 8500 / XMME 1500
    const d = distributeGroupDelta({
        deltaEur: 1000, members: MEMBERS, memberInfo: info([['VWCE', 10000, 130], ['SWDA', 8500, 110], ['XMME', 500, 30]]),
        rules: RULES,
    });
    assertTrue('c1 not blocked', !d.blocked);
    assertTrue('c1 no VWCE action (frozen)', !d.actions.VWCE);
    assertTrue('c1 no SWDA action (at ideal)', !d.actions.SWDA);
    assertEq('c1 XMME shares', d.actions.XMME?.shares ?? 0, 33); // floor(1000/30)
    assertEq('c1 unallocated', d.unallocated, 1000 - 33 * 30);
}

// ── 2. Balanced holdings: buy splits ≈85/15, leftover under min price ──
{
    // Pool with +2000: 12000 → ideals 10200/1800, gaps 1700/300
    const d = distributeGroupDelta({
        deltaEur: 2000, members: MEMBERS, memberInfo: info([['VWCE', 10000, 130], ['SWDA', 8500, 110], ['XMME', 1500, 30]]),
        rules: RULES,
    });
    assertTrue('c2 not blocked', !d.blocked);
    assertEq('c2 SWDA shares', d.actions.SWDA?.shares ?? 0, 15);  // floor(1700/110)
    assertEq('c2 XMME shares', d.actions.XMME?.shares ?? 0, 11);  // floor(300/30) + 1 top-up
    const spent = (d.actions.SWDA?.eur ?? 0) + (d.actions.XMME?.eur ?? 0);
    assertEq('c2 conservation', spent + d.unallocated, 2000);
    assertTrue('c2 unallocated < min eligible price', d.unallocated < 30);
}

// ── 3. Rounding feasibility: sub-share slices shift to a member whose share fits ──
{
    // +50: amounts 42.5/7.5, both below one share → top-up lands one XMME share
    const d = distributeGroupDelta({
        deltaEur: 50, members: MEMBERS, memberInfo: info([['VWCE', 10000, 130], ['SWDA', 8500, 110], ['XMME', 1500, 30]]),
        rules: RULES,
    });
    assertTrue('c3 not blocked', !d.blocked);
    assertEq('c3 XMME shares (feasible top-up)', d.actions.XMME?.shares ?? 0, 1);
    assertTrue('c3 no SWDA action (110 > 50)', !d.actions.SWDA);
    assertEq('c3 unallocated', d.unallocated, 20);
}

// ── 4. Weighted sell: respects noSell and rounds toward the need ──
{
    const rules: Record<string, AllocationMemberRule> = {
        VWCE: { noBuy: true, noSell: true },
        SWDA: { weight: 85 },
        XMME: { weight: 15, noSell: true },
    };
    // −2000: pool = 22000−2000−10000 = 10000 → ideals 8500/1500; XMME frozen for sells
    const d = distributeGroupDelta({
        deltaEur: -2000, members: MEMBERS, memberInfo: info([['VWCE', 10000, 130], ['SWDA', 10200, 110], ['XMME', 1800, 30]]),
        rules,
    });
    assertTrue('c4 not blocked', !d.blocked);
    assertTrue('c4 no XMME action (noSell)', !d.actions.XMME);
    assertTrue('c4 no VWCE action (frozen)', !d.actions.VWCE);
    assertEq('c4 SWDA shares', d.actions.SWDA?.shares ?? 0, -18); // round(2000/110), no overshooting top-up
    assertEq('c4 SWDA eur', d.actions.SWDA?.eur ?? 0, -1980);
}

// ── 5. Sell cap: never sells more than held ──
{
    const rules: Record<string, AllocationMemberRule> = { SWDA: { weight: 85 }, XMME: { weight: 15 } };
    const d = distributeGroupDelta({
        deltaEur: -3000, members: ['SWDA', 'XMME'], memberInfo: info([['SWDA', 2200, 110], ['XMME', 600, 30]]),
        rules,
    });
    assertTrue('c5 not blocked', !d.blocked);
    assertTrue('c5 SWDA capped at holdings', Math.abs(d.actions.SWDA?.eur ?? 0) <= 2200);
    assertTrue('c5 XMME capped at holdings', Math.abs(d.actions.XMME?.eur ?? 0) <= 600);
    const sold = -((d.actions.SWDA?.eur ?? 0) + (d.actions.XMME?.eur ?? 0));
    assertEq('c5 conservation', sold + d.unallocated, 3000);
}

// ── 6. Invalid weights: sum ≠ 100 and missing-weight variants block the group ──
{
    const badSum: Record<string, AllocationMemberRule> = {
        VWCE: { noBuy: true, noSell: true },
        SWDA: { weight: 85 },
        XMME: { weight: 5 },
    };
    const d1 = distributeGroupDelta({
        deltaEur: 1000, members: MEMBERS, memberInfo: info([['VWCE', 10000, 130], ['SWDA', 8500, 110], ['XMME', 1500, 30]]),
        rules: badSum,
    });
    assertTrue('c6 sum-90 blocked', d1.blocked);
    assertTrue('c6 kind invalidWeights', d1.blockReason?.kind === 'invalidWeights');
    assertEq('c6 weightSum', d1.blockReason?.weightSum ?? 0, 90);
    assertEq('c6 unallocated = full delta', d1.unallocated, 1000);

    const missing: Record<string, AllocationMemberRule> = { SWDA: { weight: 85 } }; // XMME has no weight
    const d2 = distributeGroupDelta({
        deltaEur: 1000, members: ['SWDA', 'XMME'], memberInfo: info([['SWDA', 8500, 110], ['XMME', 1500, 30]]),
        rules: missing,
    });
    assertTrue('c6 missing-weight blocked', d2.blocked);
    assertTrue('c6 missing-weight reason', d2.blockReason?.members.some(m => m.reason === 'No weight set') === true);

    // Tolerance: 33.33 + 33.33 + 33.34 must be valid
    const thirds = groupWeightConfig(['A', 'B', 'C'], { A: { weight: 33.33 }, B: { weight: 33.33 }, C: { weight: 33.34 } });
    assertTrue('c6 thirds valid within tolerance', thirds.valid);
}

// ── 7. Regression: group without weights keeps priority behavior ──
{
    const rules: Record<string, AllocationMemberRule> = { VWCE: { noBuy: true } };
    const d = distributeGroupDelta({
        deltaEur: 1000, members: MEMBERS, memberInfo: info([['VWCE', 10000, 130], ['SWDA', 8500, 110], ['XMME', 1500, 30]]),
        rules,
    });
    assertTrue('c7 not blocked', !d.blocked);
    assertEq('c7 buy goes to first eligible (SWDA)', d.actions.SWDA?.shares ?? 0, 9); // round(1000/110)
    assertTrue('c7 no XMME action', !d.actions.XMME);
}

// ── 8. Frozen value above group target: pool clamps to 0, no crash ──
{
    const d = distributeGroupDelta({
        deltaEur: -5000, members: MEMBERS, memberInfo: info([['VWCE', 10000, 130], ['SWDA', 500, 110], ['XMME', 0, 30]]),
        rules: RULES,
    });
    assertTrue('c8 not blocked', !d.blocked);
    assertEq('c8 SWDA shares (all sellable, floor-capped)', d.actions.SWDA?.shares ?? 0, -4); // floor(500/110)
    assertTrue('c8 no VWCE action (frozen)', !d.actions.VWCE);
    assertTrue('c8 unallocated ≥ 0', d.unallocated >= 0);
}

console.log('\nAll weighted-group checks passed.');
