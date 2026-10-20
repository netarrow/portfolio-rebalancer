// Known-answer checks for the pyramid Expense Planning implies: the cash level
// takes the liquidity asked for, a bucket the sum of its portfolios' targets,
// the rest goes to the buckets with no target by what they hold today.
// Run with: npx esbuild scripts/verify-expense-pyramid.ts --bundle --format=esm | node --input-type=module
import { buildExpensePyramid, type PyramidLevelInput } from '../src/utils/expensePyramid';

const check = (label: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
    console.log(`ok ${label} = ${a}`);
};

const lv = (id: string, kind: 'goal' | 'cash', current: number, portfolioIds: string[] = [], holdsFund = false): PyramidLevelInput =>
    ({ id, title: id, color: '#000', kind, currentValue: current, portfolioIds, holdsFund });
const targets: Record<string, number> = { safe: 6000, ladder: 30000, ladder2: 15000, main: 3500 };

const p = buildExpensePyramid({
    levels: [lv('cash', 'cash', 28000), lv('protection', 'goal', 90000, ['safe'], true), lv('security', 'goal', 8000, ['ladder', 'ladder2']), lv('growth', 'goal', 54000, ['main']), lv('spec', 'goal', 0, ['btc'])],
    total: 180000,
    targetOf: id => targets[id] ?? 0,
    liquidity: 17000,
});
check('cash level = liquidity asked for', p.levels[0].computed, 17000);
check('protection = its fund target', [p.levels[1].computed, p.levels[1].source], [6000, 'expense']);
check('security = its capex targets', p.levels[2].computed, 45000);
check('growth: a little capex, so it still takes the rest (spec holds nothing)', [p.levels[3].source, p.levels[3].computed, p.levels[4].computed], ['rest', 112000, 0]);
check('the fund level is fixed even if it holds a lot', p.levels[1].source, 'expense');
check('percents sum to 100', Math.round(Object.values(p.percents).reduce((s, v) => s + v, 0) * 100) / 100, 100);
check('growth percent', p.percents.growth, 62.22);

const short = buildExpensePyramid({ levels: [lv('cash', 'cash', 1000), lv('sec', 'goal', 1000, ['ladder'])], total: 2000, targetOf: id => targets[id] ?? 0, liquidity: 500 });
check('asking for more than there is: shortfall', short.shortfall, 28500);

const noYnab = buildExpensePyramid({ levels: [lv('cash', 'cash', 5000), lv('g', 'goal', 5000, ['x'])], total: 10000, targetOf: () => 0, liquidity: null });
check('without Expense Planning: cash kept, the rest as is', [noYnab.levels[0].source, noYnab.levels[0].computed, noYnab.levels[1].computed], ['kept', 5000, 5000]);

console.log('verify-expense-pyramid: all checks passed');
