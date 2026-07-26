// Known-answer checks for the counting-scope filter: family/illiquid flags plus
// per-person exclusions on personal brokers.
// Run with: npx esbuild scripts/verify-asset-scope.ts --bundle --format=esm | node --input-type=module
import type { AssetScope, Broker } from '../src/types';
import { getExcludedBrokerIds, hasScopeFlags } from '../src/utils/assetScope';

const broker = (b: Partial<Broker> & { id: string }): Broker => ({ name: b.id, ...b });

// b1/b3 → Marco, b2 → Giulia, b4 family, b5 family + illiquid,
// b6 personal but unattributed, b7 personal + illiquid.
const brokers: Broker[] = [
    broker({ id: 'b1', ownerId: 'marco' }),
    broker({ id: 'b2', ownerId: 'giulia' }),
    broker({ id: 'b3', ownerId: 'marco' }),
    broker({ id: 'b4', familyAsset: true }),
    broker({ id: 'b5', familyAsset: true, illiquid: true }),
    broker({ id: 'b6' }),
    broker({ id: 'b7', ownerId: 'giulia', illiquid: true }),
];

const scope = (s: Partial<AssetScope> = {}): AssetScope => ({
    includeFamily: true, includeIlliquid: true, ...s,
});

const assertExcluded = (label: string, actual: Set<string>, expected: string[]) => {
    const got = [...actual].sort().join(',');
    const want = [...expected].sort().join(',');
    if (got !== want) throw new Error(`${label}: expected [${want}], got [${got}]`);
    console.log(`ok ${label} → [${got}]`);
};

// ── 1. Everything included: identity pass-through (empty set) ──
assertExcluded('all included', getExcludedBrokerIds(brokers, scope()), []);

// ── 2. Family off ──
assertExcluded('family off', getExcludedBrokerIds(brokers, scope({ includeFamily: false })), ['b4', 'b5']);

// ── 3. Illiquid off ──
assertExcluded('illiquid off', getExcludedBrokerIds(brokers, scope({ includeIlliquid: false })), ['b5', 'b7']);

// ── 4. Both off: the flags are OR'd, b5 carries both ──
assertExcluded(
    'family + illiquid off',
    getExcludedBrokerIds(brokers, scope({ includeFamily: false, includeIlliquid: false })),
    ['b4', 'b5', 'b7'],
);

// ── 5. One person excluded; the unattributed personal broker stays ──
assertExcluded(
    'giulia excluded',
    getExcludedBrokerIds(brokers, scope({ excludedPersonIds: ['giulia'] })),
    ['b2', 'b7'],
);

// ── 6. "Only Marco": family off + Giulia excluded ──
assertExcluded(
    'only marco (+ unattributed)',
    getExcludedBrokerIds(brokers, scope({ includeFamily: false, excludedPersonIds: ['giulia'] })),
    ['b2', 'b4', 'b5', 'b7'],
);

// ── 7. "Marco + family": only Giulia excluded ──
assertExcluded(
    'marco + family',
    getExcludedBrokerIds(brokers, scope({ excludedPersonIds: ['giulia'] })),
    ['b2', 'b7'],
);

// ── 8. A family broker is never filtered by person, even with an ownerId ──
assertExcluded(
    'family broker ignores ownerId',
    getExcludedBrokerIds([broker({ id: 'bf', familyAsset: true, ownerId: 'marco' })], scope({ excludedPersonIds: ['marco'] })),
    [],
);

// ── 9. Unknown person id in the exclusion list is a no-op ──
assertExcluded('unknown person id', getExcludedBrokerIds(brokers, scope({ excludedPersonIds: ['nobody'] })), []);

// ── 10. hasScopeFlags gates the chips ──
if (hasScopeFlags([broker({ id: 'x' })])) throw new Error('a plain broker must not surface the chips');
if (!hasScopeFlags([broker({ id: 'x', ownerId: 'marco' })])) throw new Error('an owned broker must surface the chips');
if (!hasScopeFlags([broker({ id: 'x', familyAsset: true })])) throw new Error('a family broker must surface the chips');
if (!hasScopeFlags([broker({ id: 'x', illiquid: true })])) throw new Error('an illiquid broker must surface the chips');
console.log('ok hasScopeFlags gating');

console.log('\nAll asset-scope checks passed ✓');
