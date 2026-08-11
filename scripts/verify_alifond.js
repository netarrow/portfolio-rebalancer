// Verifies the ALIFOND source end to end: live quote + monthly history, and a
// consistency check that the quote equals the last history point.
//
//   node scripts/verify_alifond.js            # DINAMICO (default comparto)
//   node scripts/verify_alifond.js BILANCIATO
import { fetchAlifondQuote, fetchAlifondHistory, compartoFromTicker } from '../server/alifond.js';
import { fetchHistoryForToken } from '../server/history.js';

const ticker = process.argv[2] ? `ALIFOND-${process.argv[2].toUpperCase()}` : 'ALIFOND-DINAMICO';
const comparto = compartoFromTicker(ticker);

let failed = false;
const check = (ok, msg) => {
    console.log(`${ok ? '✅' : '❌'} ${msg}`);
    if (!ok) failed = true;
};

const quote = await fetchAlifondQuote(comparto);
console.log(`Quote (${comparto}): ${quote.price} ${quote.currency} @ ${quote.date}`);
check(Number.isFinite(quote.price) && quote.price > 0, 'quote is a positive number');
check(/^\d{4}-\d{2}-\d{2}$/.test(quote.date), 'quote carries an ISO date');

const { points } = await fetchAlifondHistory(comparto);
console.log(`History: ${points.length} monthly points, ${points[0].date} → ${points[points.length - 1].date}`);
console.log('Last 6:', points.slice(-6).map(p => `${p.date}=${p.price}`).join('  '));

check(points.length >= 24, 'history has at least two years of points');
check(points.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.price > 0), 'every point has a valid date and price');
check(points.every((p, i) => i === 0 || p.date > points[i - 1].date), 'points are strictly ascending');
check(points[points.length - 1].price === quote.price, 'quote matches the last history point');

// Through the dispatcher the server actually calls (non-ISIN ticker allowed).
const res = await fetchHistoryForToken({ isin: ticker, source: 'ALIFOND', beginDate: '2024-01-01' });
check(res.success, `dispatcher returned success (${res.error || 'no error'})`);
check(res.data?.granularity === 'M', 'dispatcher reports monthly granularity');
check(res.data?.priceBasis === 'dirty', 'dispatcher reports dirty price basis');
check(res.data?.points?.every(p => p.date >= '2024-01-01') ?? false, 'dispatcher honours beginDate');

// An ISIN-shaped ticker must still resolve (it just falls back to DINAMICO).
const bad = await fetchHistoryForToken({ isin: 'not-an-isin', source: 'ALIFOND' });
check(bad.success, 'free-text ticker is not rejected by the ISIN check');

process.exit(failed ? 1 : 0);
