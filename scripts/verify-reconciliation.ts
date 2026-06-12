// Numeric check that the Dashboard net worth and the Performance "Latest"
// net worth coincide (modulo clean-price bonds, which are documented).
// Run with: npx esbuild scripts/verify-reconciliation.ts --bundle --format=esm | node --input-type=module
import type { Transaction, PriceHistoryMap } from '../src/types';
import { calculateAssets, calculateRealizedGains } from '../src/utils/portfolioCalculations';
import { mergeLatestCloses } from '../src/utils/priceHistory';
import { getNetWorthSeries, getPortfolioValueSeries } from '../src/utils/performanceCalculations';

const tx = (t: Partial<Transaction>): Transaction => ({
    id: Math.random().toString(36).slice(2),
    ticker: 'AAA', amount: 0, price: 0, date: '2024-01-02', direction: 'Buy', portfolioId: 'p1',
    ...t,
});

const transactions: Transaction[] = [
    tx({ ticker: 'AAA', amount: 10, price: 100, date: '2024-01-02' }),
    tx({ ticker: 'AAA', amount: 5, price: 110, date: '2024-06-03' }),
    tx({ ticker: 'AAA', amount: 3, price: 115, date: '2025-01-10', direction: 'Sell' }),
    tx({ ticker: 'AAA', amount: 15, price: 1, date: '2025-03-01', direction: 'Dividend' }),
    tx({ ticker: 'BBB', amount: 100, price: 50, date: '2024-02-01', portfolioId: 'p2' }),
    tx({ ticker: 'CCC', amount: 10, price: 97, date: '2024-03-01' }),
];

const priceHistory: PriceHistoryMap = {
    AAA: { granularity: 'D', points: [['2024-01-02', 100], ['2024-06-03', 111], ['2025-01-10', 115], ['2026-06-10', 120], ['2026-06-11', 121]] },
    BBB: { granularity: 'M', points: [['2024-02-29', 50], ['2026-05-31', 55]] }, // never price-updated
    CCC: { granularity: 'D', priceBasis: 'clean', points: [['2024-03-01', 97], ['2026-06-10', 98]] }, // MOT bond, corso secco
};

// AAA updated today (snapshot already appended, real flow); CCC live tel quel
const marketData = {
    AAA: { price: 121, lastUpdated: '2026-06-11T10:00:00Z' },
    CCC: { price: 99.5, lastUpdated: '2026-06-11T10:00:00Z' },
};

const brokerLiquidity = 5000; // includes 2000 allocated to p1 — counted once
const portfolioLiquidity = 1500;
const totalLiquidity = brokerLiquidity + portfolioLiquidity;

// ── Dashboard ──
const effective = mergeLatestCloses(marketData, priceHistory);
const { summary } = calculateAssets(transactions, [], effective);
const dashboardNetWorth = summary.totalValue + totalLiquidity;

// ── Performance (Latest) ──
const series = getNetWorthSeries(transactions, priceHistory, { liquidity: totalLiquidity });
const performanceLatest = series[series.length - 1].value;

// Documented residual: clean-price bond valued tel quel on the Dashboard
const bondGap = 10 * (99.5 - 98);

const diff = dashboardNetWorth - performanceLatest;
console.log(`Dashboard net worth:   €${dashboardNetWorth.toFixed(2)}`);
console.log(`Performance latest:    €${performanceLatest.toFixed(2)}`);
console.log(`Difference:            €${diff.toFixed(2)} (expected bond accrued gap: €${bondGap.toFixed(2)})`);
if (Math.abs(diff - bondGap) > 1e-6) throw new Error('NET WORTH MISMATCH beyond the documented bond gap');

// ── Return %: Performance MWR (MAX) vs Dashboard Total Appreciation ──
const base = getPortfolioValueSeries(transactions, priceHistory, {});
const first = base[0], last = base[base.length - 1];
let netFlows = 0, buys = 0;
for (const t of transactions) {
    const d = t.direction || 'Buy';
    if (d !== 'Buy' && d !== 'Sell') continue;
    const date = t.date.slice(0, 10);
    if (date <= first.date || date > last.date) continue;
    const cost = t.amount * t.price;
    if (d === 'Buy') { netFlows += cost; buys += cost; } else netFlows -= cost;
}
const mwrGain = last.value - first.value - netFlows;
const mwrCapital = first.value + buys;
const mwrPct = (mwrGain / mwrCapital) * 100;

const totalBuyInvested = transactions.filter(t => (t.direction || 'Buy') === 'Buy').reduce((s, t) => s + t.amount * t.price, 0);
const { totalRealized } = calculateRealizedGains(transactions);
const unrealized = summary.totalValue - summary.totalCost;
const dashAppreciation = unrealized + totalRealized;
const dashAppreciationPct = (dashAppreciation / totalBuyInvested) * 100;

console.log(`\nPerformance MWR (MAX): €${mwrGain.toFixed(2)} on €${mwrCapital.toFixed(2)} = ${mwrPct.toFixed(2)}%`);
console.log(`Dashboard Total Appr.: €${dashAppreciation.toFixed(2)} on €${totalBuyInvested.toFixed(2)} = ${dashAppreciationPct.toFixed(2)}%`);
if (Math.abs(mwrCapital - totalBuyInvested) > 1e-6) throw new Error('CAPITAL BASE MISMATCH');
if (Math.abs(mwrGain - (dashAppreciation - bondGap)) > 1e-6) throw new Error('GAIN MISMATCH beyond the documented bond gap');

console.log('\n✓ Dashboard and Performance reconcile (residual = clean-price bonds only)');
