// Known-answer checks for the broker ↔ YNAB account mappings: legacy migration,
// 1:1 assignment scoped to (budgetId, accountId), and grouping by budget.
// Run with: npx esbuild scripts/verify-ynab-account-mappings.ts --bundle --format=esm | node --input-type=module
import type { YnabAccountMappings } from '../src/types';
import {
    assignYnabAccountMapping,
    groupMappingsByBudget,
    normalizeYnabAccountMappings,
} from '../src/utils/ynabAccountMappings';

let failures = 0;

const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
    }
};

console.log('normalizeYnabAccountMappings');

// Legacy shape: bare account ids belong to the only budget of the time.
check(
    'legacy string entries are attached to the fallback budget',
    normalizeYnabAccountMappings({ b1: 'acc-1', b2: 'acc-2' }, 'budget-A'),
    { b1: { budgetId: 'budget-A', accountId: 'acc-1' }, b2: { budgetId: 'budget-A', accountId: 'acc-2' } },
);

check(
    'legacy entries are dropped when no budget can own them',
    normalizeYnabAccountMappings({ b1: 'acc-1' }, undefined),
    {},
);

check(
    'current shape passes through unchanged',
    normalizeYnabAccountMappings({ b1: { budgetId: 'budget-B', accountId: 'acc-9' } }, 'budget-A'),
    { b1: { budgetId: 'budget-B', accountId: 'acc-9' } },
);

check(
    'mixed legacy and current entries both survive',
    normalizeYnabAccountMappings({ b1: 'acc-1', b2: { budgetId: 'budget-B', accountId: 'acc-1' } }, 'budget-A'),
    { b1: { budgetId: 'budget-A', accountId: 'acc-1' }, b2: { budgetId: 'budget-B', accountId: 'acc-1' } },
);

check(
    'malformed entries are dropped, valid siblings kept',
    normalizeYnabAccountMappings(
        { b1: null, b2: {}, b3: { budgetId: 'budget-A' }, b4: { accountId: 'acc-4' }, b5: { budgetId: 'budget-A', accountId: 'acc-5' } },
        'budget-A',
    ),
    { b5: { budgetId: 'budget-A', accountId: 'acc-5' } },
);

check('non-object input yields an empty map', normalizeYnabAccountMappings('nope', 'budget-A'), {});
check('array input yields an empty map', normalizeYnabAccountMappings(['acc-1'], 'budget-A'), {});
check('undefined input yields an empty map', normalizeYnabAccountMappings(undefined, 'budget-A'), {});

check(
    'a duplicated (budget, account) pair keeps only the first broker',
    normalizeYnabAccountMappings({
        b1: { budgetId: 'budget-A', accountId: 'acc-1' },
        b2: { budgetId: 'budget-A', accountId: 'acc-1' },
    }),
    { b1: { budgetId: 'budget-A', accountId: 'acc-1' } },
);

console.log('assignYnabAccountMapping');

const base: YnabAccountMappings = {
    b1: { budgetId: 'budget-A', accountId: 'acc-1' },
    b2: { budgetId: 'budget-B', accountId: 'acc-2' },
};

check(
    'the same account id in another budget is free to assign',
    assignYnabAccountMapping(base, 'b3', { budgetId: 'budget-B', accountId: 'acc-1' }),
    {
        b1: { budgetId: 'budget-A', accountId: 'acc-1' },
        b2: { budgetId: 'budget-B', accountId: 'acc-2' },
        b3: { budgetId: 'budget-B', accountId: 'acc-1' },
    },
);

check(
    'the same (budget, account) pair moves off the broker that held it',
    assignYnabAccountMapping(base, 'b3', { budgetId: 'budget-A', accountId: 'acc-1' }),
    {
        b2: { budgetId: 'budget-B', accountId: 'acc-2' },
        b3: { budgetId: 'budget-A', accountId: 'acc-1' },
    },
);

check(
    'null clears the broker mapping and leaves the others alone',
    assignYnabAccountMapping(base, 'b1', null),
    { b2: { budgetId: 'budget-B', accountId: 'acc-2' } },
);

check(
    'remapping a broker to another budget replaces its entry',
    assignYnabAccountMapping(base, 'b1', { budgetId: 'budget-B', accountId: 'acc-7' }),
    {
        b2: { budgetId: 'budget-B', accountId: 'acc-2' },
        b1: { budgetId: 'budget-B', accountId: 'acc-7' },
    },
);

check('clearing an unmapped broker is a no-op', assignYnabAccountMapping(base, 'b9', null), base);

console.log('groupMappingsByBudget');

check(
    'brokers are grouped by the budget of their account',
    [...groupMappingsByBudget({
        b1: { budgetId: 'budget-A', accountId: 'acc-1' },
        b2: { budgetId: 'budget-B', accountId: 'acc-2' },
        b3: { budgetId: 'budget-A', accountId: 'acc-3' },
    }).entries()],
    [['budget-A', ['b1', 'b3']], ['budget-B', ['b2']]],
);

check('an empty map groups to nothing', [...groupMappingsByBudget({}).entries()], []);

if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll checks passed');
