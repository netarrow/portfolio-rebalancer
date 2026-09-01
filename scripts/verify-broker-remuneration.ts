// Known-answer checks for broker cash remuneration: the remunerated base, the
// credit schedule of each frequency, and the accrual window that the liquidity
// update credits.
// Run with: npx esbuild scripts/verify-broker-remuneration.ts --bundle --format=esm | node --input-type=module
import type { Broker, BrokerRemuneration } from '../src/types';
import {
    computeBrokerAccrual,
    creditDatesBetween,
    describeRemuneration,
    remuneratedBase,
} from '../src/utils/brokerRemuneration';

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

const plan = (over: Partial<BrokerRemuneration> = {}): BrokerRemuneration => ({
    annualRatePercent: 3,
    frequency: 'monthly',
    creditDay: 1,
    startDate: '2026-01-01',
    ...over,
});

const broker = (rem: BrokerRemuneration | undefined, liquidity = 10000): Broker => ({
    id: 'b1',
    name: 'Bank',
    currentLiquidity: liquidity,
    remuneration: rem,
});

console.log('remuneratedBase');

check('all remunerates the whole liquidity', remuneratedBase(plan(), 10000), 10000);
check('capped stops at the ceiling', remuneratedBase(plan({ baseType: 'capped', baseCap: 6000 }), 10000), 6000);
check('capped below the ceiling remunerates everything', remuneratedBase(plan({ baseType: 'capped', baseCap: 60000 }), 10000), 10000);
check('percent takes its share', remuneratedBase(plan({ baseType: 'percent', basePercent: 40 }), 10000), 4000);
check('a negative balance earns nothing', remuneratedBase(plan(), -500), 0);

console.log('creditDatesBetween');

check(
    'monthly pays on the credit day of every month',
    creditDatesBetween(plan(), '2026-01-01', '2026-04-15'),
    ['2026-02-01', '2026-03-01', '2026-04-01'],
);

check(
    'a credit day past the end of the month falls back to its last day',
    creditDatesBetween(plan({ creditDay: 31 }), '2026-01-01', '2026-04-15'),
    ['2026-01-31', '2026-02-28', '2026-03-31'],
);

check(
    'quarterly is anchored on the month the plan started in',
    creditDatesBetween(plan({ frequency: 'quarterly', startDate: '2026-02-10', creditDay: 10 }), '2026-02-10', '2027-01-01'),
    ['2026-05-10', '2026-08-10', '2026-11-10'],
);

check(
    'yearly pays once a year',
    creditDatesBetween(plan({ frequency: 'annual', startDate: '2024-06-30', creditDay: 30 }), '2024-06-30', '2026-09-01'),
    ['2025-06-30', '2026-06-30'],
);

check(
    'daily pays every day and ignores the credit day',
    creditDatesBetween(plan({ frequency: 'daily', creditDay: 15 }), '2026-01-01', '2026-01-04'),
    ['2026-01-02', '2026-01-03', '2026-01-04'],
);

check('nothing is due before the first credit date', creditDatesBetween(plan(), '2026-01-01', '2026-01-20'), []);

console.log('computeBrokerAccrual');

// 10.000 € at 3% for the 31 days of January: 10000 * 0.03 * 31/365 = 25.48.
check(
    'a single monthly period pays the ACT/365 interest of its days',
    computeBrokerAccrual(broker(plan()), '2026-02-05'),
    { fromDate: '2026-01-01', toDate: '2026-02-01', amount: 25.48, grossAmount: 25.48, withheld: 0, credits: 1, base: 10000, annualRatePercent: 3, withholdingPercent: 0 },
);

check(
    'nothing accrues before the first credit date',
    computeBrokerAccrual(broker(plan()), '2026-01-20'),
    null,
);

check(
    'the watermark shortens the window to the uncredited part',
    computeBrokerAccrual(broker({ ...plan(), lastCreditDate: '2026-02-01' }), '2026-03-05'),
    { fromDate: '2026-02-01', toDate: '2026-03-01', amount: 23.01, grossAmount: 23.01, withheld: 0, credits: 1, base: 10000, annualRatePercent: 3, withholdingPercent: 0 },
);

// Two periods: 31 days then 28, with the first credit compounding into the second.
const twoPeriods = computeBrokerAccrual(broker(plan()), '2026-03-05');
check('several missed periods are credited in one go', twoPeriods?.credits, 2);
check('and the second period compounds on the first', twoPeriods?.amount, 48.55);
check('the window ends on the last credit date, not today', twoPeriods?.toDate, '2026-03-01');

// Only 6.000 € of the 10.000 are remunerated: 6000 * 0.03 * 31/365 = 15.29.
check(
    'the cap limits what earns interest',
    computeBrokerAccrual(broker(plan({ baseType: 'capped', baseCap: 6000 })), '2026-02-05')?.amount,
    15.29,
);

// The Italian 26% on deposit interest: 25.48 gross becomes 18.85 on the account.
const taxed = computeBrokerAccrual(broker(plan({ withholdingPercent: 26 })), '2026-02-05');
check('the credited amount is net of the withholding', taxed?.amount, 18.85);
check('and the gross is reported alongside it', taxed?.grossAmount, 25.48);
check('as is the tax withheld', taxed?.withheld, 6.63);

// Only the net stays on the account, so that is what the next period compounds on.
check(
    'compounding runs on the net, not the gross',
    computeBrokerAccrual(broker(plan({ withholdingPercent: 26 })), '2026-03-05')?.amount,
    35.92,
);

check(
    'a full withholding leaves nothing to credit',
    computeBrokerAccrual(broker(plan({ withholdingPercent: 100 })), '2026-02-05'),
    null,
);

check('a plan with no rate never accrues', computeBrokerAccrual(broker(plan({ annualRatePercent: 0 })), '2026-06-01'), null);
check('a broker with no plan never accrues', computeBrokerAccrual(broker(undefined), '2026-06-01'), null);
check('an empty account never accrues', computeBrokerAccrual(broker(plan(), 0), '2026-06-01'), null);

// A rate so small the period is worth less than a cent: the watermark must not
// move, so the window keeps growing until it is.
check(
    'a sub-cent period stays uncredited',
    computeBrokerAccrual(broker(plan({ annualRatePercent: 0.001 }), 10), '2026-02-05'),
    null,
);

console.log('describeRemuneration');

check(
    'the summary names rate, schedule and base',
    describeRemuneration(plan({ baseType: 'capped', baseCap: 100000, withholdingPercent: 26 })),
    '3% per year · monthly, on the 1st · on the first €100,000 · 26% tax withheld',
);
check(
    'daily plans do not mention a credit day',
    describeRemuneration(plan({ frequency: 'daily' })),
    '3% per year · credited daily · on the whole liquidity · paid gross',
);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
if (failures > 0) process.exitCode = 1;
