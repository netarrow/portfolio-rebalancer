// Known-answer checks for retiring ratio groups: every portfolio that used one
// must come out with a target that still says what it said, and the one case
// that cannot (a "remainder" group, which stated no number) must fall back
// visibly rather than invent one.
// Run with: npx esbuild scripts/verify-ratio-group-migration.ts --bundle --format=esm | node --input-type=module
import { migrateRatioGroups, normalizeAssetAllocationSettings } from '../src/utils/assetAllocation';

const assertEq = (label: string, actual: number, expected: number, tol = 1e-6) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    console.log(`ok ${label} = ${actual}`);
};
const assertStr = (label: string, actual: string, expected: string) => {
    if (actual !== expected) throw new Error(`${label}: expected "${expected}", got "${actual}"`);
    console.log(`ok ${label} = ${actual}`);
};
const assertTrue = (label: string, cond: boolean) => {
    if (!cond) throw new Error(`${label}: expected true`);
    console.log(`ok ${label}`);
};

// ── 1. A percent group splits its percentage by weight ──
{
    const out = migrateRatioGroups({
        portfolioTargets: {
            a: { mode: 'ratio', value: 3, ratioGroupId: 'g1' },
            b: { mode: 'ratio', value: 1, ratioGroupId: 'g1' },
            c: { mode: 'percent', value: 20 },
        },
        ratioGroups: [{ id: 'g1', name: 'Core', groupTargetMode: 'percent', groupTargetValue: 40 }],
    });
    assertTrue('m1 changed', out.changed);
    assertStr('m1 a mode', out.portfolioTargets.a.mode, 'percent');
    assertEq('m1 a takes 3/4 of 40', out.portfolioTargets.a.value, 30);
    assertEq('m1 b takes 1/4 of 40', out.portfolioTargets.b.value, 10);
    assertEq('m1 the group percentage is preserved',
        out.portfolioTargets.a.value + out.portfolioTargets.b.value, 40);
    assertStr('m1 an untouched target survives', out.portfolioTargets.c.mode, 'percent');
    assertEq('m1 and keeps its value', out.portfolioTargets.c.value, 20);
    assertEq('m1 nothing fell back', out.convertedFromRemainder.length, 0);
}

// ── 2. A fixed group splits its euros by weight ──
{
    const out = migrateRatioGroups({
        portfolioTargets: {
            a: { mode: 'ratio', value: 1, ratioGroupId: 'g1' },
            b: { mode: 'ratio', value: 1, ratioGroupId: 'g1' },
        },
        ratioGroups: [{ id: 'g1', name: 'Core', groupTargetMode: 'fixed', groupTargetValue: 50000 }],
    });
    assertStr('m2 mode is fixed', out.portfolioTargets.a.mode, 'fixed');
    assertEq('m2 split evenly', out.portfolioTargets.a.value, 25000);
    assertEq('m2 the budget is preserved',
        out.portfolioTargets.a.value + out.portfolioTargets.b.value, 50000);
}

// ── 3. A remainder group has no number to keep ──
{
    const out = migrateRatioGroups({
        portfolioTargets: {
            a: { mode: 'ratio', value: 2, ratioGroupId: 'g1' },
            b: { mode: 'ratio', value: 1, ratioGroupId: 'g1' },
        },
        ratioGroups: [{ id: 'g1', name: 'Rest', groupTargetMode: 'remainder', groupTargetValue: 0 }],
    });
    assertStr('m3 falls back to locked', out.portfolioTargets.a.mode, 'locked');
    assertStr('m3 both members', out.portfolioTargets.b.mode, 'locked');
    assertEq('m3 and says so', out.convertedFromRemainder.length, 2);
    assertTrue('m3 naming the portfolios',
        out.convertedFromRemainder.includes('a') && out.convertedFromRemainder.includes('b'));
}

// ── 4. Degenerate inputs ──
{
    // A ratio target pointing at a group that no longer exists never had a
    // budget to draw on, so it was already contributing nothing.
    const orphan = migrateRatioGroups({
        portfolioTargets: { a: { mode: 'ratio', value: 5, ratioGroupId: 'gone' } },
        ratioGroups: [],
    });
    assertStr('m4 orphan ratio → excluded', orphan.portfolioTargets.a.mode, 'excluded');

    // Weights that are all zero carry no proportion.
    const zero = migrateRatioGroups({
        portfolioTargets: {
            a: { mode: 'ratio', value: 0, ratioGroupId: 'g1' },
            b: { mode: 'ratio', value: 0, ratioGroupId: 'g1' },
        },
        ratioGroups: [{ id: 'g1', name: 'Core', groupTargetMode: 'percent', groupTargetValue: 40 }],
    });
    assertStr('m4 zero weights → excluded', zero.portfolioTargets.a.mode, 'excluded');

    // Settings that never used ratio groups come back untouched and unflagged.
    const clean = migrateRatioGroups({
        portfolioTargets: { a: { mode: 'percent', value: 30 }, b: { mode: 'locked', value: 0 } },
    });
    assertTrue('m4 nothing to change', !clean.changed);
    assertEq('m4 targets preserved', Object.keys(clean.portfolioTargets).length, 2);
    assertEq('m4 percent kept', clean.portfolioTargets.a.value, 30);

    assertEq('m4 garbage in → empty out', Object.keys(migrateRatioGroups(null).portfolioTargets).length, 0);
}

// ── 5. The normalizer no longer accepts a ratio target ──
{
    const normalized = normalizeAssetAllocationSettings({
        portfolioTargets: {
            a: { mode: 'ratio', value: 3, ratioGroupId: 'g1' },
            b: { mode: 'percent', value: 25 },
        },
        ratioGroups: [{ id: 'g1', name: 'Core', groupTargetMode: 'percent', groupTargetValue: 40 }],
    });
    assertEq('m5 the ratio target is dropped',
        Object.keys(normalized.portfolioTargets).length, 1);
    assertStr('m5 the valid one survives', normalized.portfolioTargets.b.mode, 'percent');
    assertTrue('m5 no ratioGroups field',
        !Object.prototype.hasOwnProperty.call(normalized, 'ratioGroups'));
    // Which is exactly why the migration must run on the RAW object.
    assertEq('m5 the migration still rescues it',
        migrateRatioGroups({
            portfolioTargets: {
                a: { mode: 'ratio', value: 3, ratioGroupId: 'g1' },
                b: { mode: 'percent', value: 25 },
            },
            ratioGroups: [{ id: 'g1', name: 'Core', groupTargetMode: 'percent', groupTargetValue: 40 }],
        }).portfolioTargets.a.value, 40);
}

console.log('\nAll ratio-group migration checks passed.');
