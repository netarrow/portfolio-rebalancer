// Known-answer checks for the sinking funds: the yearly quota of a cyclical
// capex, where it should stand today, its next cycle and its later purchases.
// Invented figures only.
// Run with: npx esbuild scripts/verify-sinking-funds.ts --bundle --format=esm | node --input-type=module
import type { YnabGoal } from '../src/types';
import { addYears, annualQuota, buildSinkingSummary, cycleStart, laterPurchases, nextCycle, sinkingFundStatus } from '../src/utils/sinkingFunds';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
};

const TODAY = '2026-07-01';
const goal = (id: string, extra: Partial<YnabGoal>): YnabGoal => ({
    id, ynabBudgetId: 'b', name: id, cashCoverage: 0, targetSource: 'manual-override', lastSyncedAt: TODAY, ...extra,
});
// A car every 10 years: 24,000 by 2030-07-01, so the cycle started 2020-07-01.
const car = goal('Car', { targetAmount: 24000, targetDate: '2030-07-01', cycle: { years: 10, inflationPercent: 2 } });
const laptop = goal('Laptop', { targetAmount: 1800, targetDate: '2027-07-01', cycle: { years: 4, startDate: '2025-07-01' } });
const house = goal('House', { targetAmount: 60000, targetDate: '2028-01-01' });

console.log('dates');
check('years are whole months', [addYears('2030-07-01', 10), addYears('2030-07-01', -10), addYears('2026-01-31', 0.0834)], ['2040-07-01', '2020-07-01', '2026-02-28']);
check('a cycle starts its length before the date, unless said otherwise', [cycleStart(car), cycleStart(laptop), cycleStart(house)], ['2020-07-01', '2025-07-01', undefined]);

console.log('quota');
check('the yearly cost is the target over the years', [annualQuota(car), annualQuota(laptop)], [2400, 450]);
check('a one-off capex has none', annualQuota(house), 0);
check('nor an archived one', annualQuota({ ...car, archived: true }), 0);

console.log('where it should stand');
// Six years of ten have passed (2,191 of 3,652 days): 14,398.69 expected.
const carStatus = sinkingFundStatus(car, 12000, TODAY)!;
check('a straight line from the start of the cycle to its date', [carStatus.expected, carStatus.behind, carStatus.ended], [14398.69, 2398.69, false]);
check('ahead of the line is not behind', sinkingFundStatus(laptop, 1500, TODAY)!.behind, 0);
check('past its date the cycle has ended', sinkingFundStatus(laptop, 1800, '2027-08-01')!.ended, true);
check('not a fund without a cycle', sinkingFundStatus(house, 0, TODAY), null);

console.log('next cycle');
// 24,000 × 1.02^10 = 29,255.87 → 29,256.
check('the next date, the price by then, a cycle starting where the last ended',
    nextCycle(car), { targetAmount: 29256, targetDate: '2040-07-01', cycle: { years: 10, inflationPercent: 2, startDate: '2030-07-01' } });
check('nothing to renew without a date', nextCycle({ ...car, targetDate: undefined }), null);

console.log('later purchases');
check('every cycle up to the last year, each at its price',
    laterPurchases({ amount: 24000, targetDate: '2030-07-01' }, car.cycle, 2055),
    [{ targetDate: '2040-07-01', amount: 29256 }, { targetDate: '2050-07-01', amount: 35663 }]);
check('none for a one-off', laterPurchases({ amount: 60000, targetDate: '2028-01-01' }, undefined, 2060), []);

console.log('summary');
const covered: Record<string, number> = { Car: 12000, Laptop: 1500, House: 70000 };
const summary = buildSinkingSummary([car, laptop, house, goal('Old', { targetAmount: 500, archived: true, cycle: { years: 1 } })], g => covered[g.id] ?? 0, TODAY);
check('quotas and what is behind, over the cyclical funds', [summary.funds.length, summary.annualQuota, summary.behind], [2, 2850, 2398.69]);
// 12,000 + 1,500 + the house up to its 60,000 target.
check('set aside counts every active capex, up to its target', summary.setAside, 73500);

if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
