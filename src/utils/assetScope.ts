import type { AssetScope, Broker } from '../types';

// Asset scope: which brokers are left out of the counting views.
//
// A broker is excluded when any of these holds:
//   - it is a family asset and family assets are toggled off
//   - it is illiquid and illiquid assets are toggled off
//   - it is personal, attributed to a person, and that person is excluded
//
// Personal brokers with no person assigned are always counted — same rule as
// transactions with no brokerId, which can't be attributed either.
export function getExcludedBrokerIds(brokers: Broker[], scope: AssetScope): Set<string> {
    const excludedPersons = new Set(scope.excludedPersonIds ?? []);
    const ids = new Set<string>();
    brokers.forEach(b => {
        if (b.familyAsset && !scope.includeFamily) {
            ids.add(b.id);
            return;
        }
        if (b.illiquid && !scope.includeIlliquid) {
            ids.add(b.id);
            return;
        }
        if (!b.familyAsset && b.ownerId && excludedPersons.has(b.ownerId)) {
            ids.add(b.id);
        }
    });
    return ids;
}

// True when at least one broker carries something the scope chips can filter
// on; the chips render nothing otherwise.
export function hasScopeFlags(brokers: Broker[]): boolean {
    return brokers.some(b => b.familyAsset || b.illiquid || b.ownerId);
}
