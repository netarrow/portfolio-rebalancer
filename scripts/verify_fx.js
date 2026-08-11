// Verifies EUR conversion: the xe.com rate lookup, the currency normalization
// rules, and the fact that a USD-quoted FT asset now reaches the client in EUR.
//
//   node scripts/verify_fx.js [ISIN]     # default: a USD-quoted FT fund
import { getEurRate, normalizeCurrency, amountToEur, isEur, getEurRateHistory, parseXeChartRates, seriesToEur } from '../server/fx.js';
import { fetchFtQuote } from '../server/ftMarkets.js';
import { fetchHistoryForToken } from '../server/history.js';

const ISIN = process.argv[2] || 'LU0079474960'; // JPM US Select Equity, quoted in USD

let failed = false;
const check = (ok, msg) => {
    console.log(`${ok ? '✅' : '❌'} ${msg}`);
    if (!ok) failed = true;
};

// --- rate + normalization -----------------------------------------------------
const usdRate = await getEurRate('USD');
console.log(`USD→EUR = ${usdRate}`);
check(Number.isFinite(usdRate) && usdRate > 0.5 && usdRate < 1.5, 'USD→EUR rate is plausible');
check(await getEurRate('EUR') === 1, 'EUR→EUR is 1 without a lookup');

check(normalizeCurrency('GBp')?.divisor === 100, 'GBp is treated as pence');
check(normalizeCurrency('GBX')?.divisor === 100, 'GBX is treated as pence');
check(normalizeCurrency('usd')?.code === 'USD', 'currency codes are case-insensitive');
check(normalizeCurrency('') === null, 'empty currency is rejected');
check(isEur('EUR') && !isEur('USD'), 'isEur only accepts euro');

const hundredUsd = await amountToEur('test', 100, 'USD');
check(hundredUsd.converted && Math.abs(hundredUsd.amount - 100 * usdRate) < 1e-9, '100 USD converts at the USD rate');
check(hundredUsd.currency === 'EUR' && hundredUsd.sourceCurrency === 'USD', 'conversion reports EUR + source currency');

const pence = await amountToEur('test', 100, 'GBp');
const gbpRate = await getEurRate('GBP');
check(Math.abs(pence.amount - gbpRate) < 1e-9, '100 GBp equals 1 GBP in euro');

const unknown = await amountToEur('test', 42, 'XYZ!');
check(!unknown.converted && unknown.currency === 'EUR' && unknown.amount === 42,
    'an unusable currency label passes through as EUR (pre-conversion behaviour)');

const euro = await amountToEur('test', 42, 'EUR');
check(!euro.converted && euro.amount === 42 && euro.fxRate === null, 'a euro amount is left alone');

// --- daily rate history (xe.com currency charts) ------------------------------
// The offset encoding: rates[0] is added to every other element, and element i
// is sampled at startTime + interval * (i - 1).
const decoded = parseXeChartRates({
    batchList: [{ startTime: Date.UTC(2020, 0, 1), interval: 86400000, rates: [10, 10.9, 10.8] }],
});
check(Math.abs(decoded.get('2020-01-01') - 0.9) < 1e-9 && Math.abs(decoded.get('2020-01-02') - 0.8) < 1e-9,
    'chart payload decodes offset + interval correctly');

const usdHistory = await getEurRateHistory('USD');
console.log(`USD→EUR history: ${usdHistory.first} → ${usdHistory.last}`);
check(usdHistory.first < '2020-01-01', 'history reaches back several years');
check(usdHistory.last >= new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10), 'history is up to date');
check(Math.abs(usdHistory.rateOn(usdHistory.last) - usdRate) < 0.01, 'latest historical rate matches the spot rate');

const covidRate = usdHistory.rateOn('2022-09-27'); // EUR/USD bottomed near parity
check(covidRate > 0.95 && covidRate < 1.10, `Sept 2022 USD→EUR near parity (${covidRate.toFixed(4)})`);
// xe publishes a value for every calendar day (weekends included), so the
// carry-forward path only has to cover the edges of the series.
check(usdHistory.byDate.size >= 3600, `series is dense: ${usdHistory.byDate.size} days over ~10 years`);
check(usdHistory.rateOn('2099-01-01') === usdHistory.rateOn(usdHistory.last), 'a date past the series carries the last rate forward');
check(usdHistory.rateOn('1990-01-01') === usdHistory.rateOn(usdHistory.first), 'dates before the series use its oldest rate');

const series = await seriesToEur('test', [
    { date: '2022-09-27', price: 100 },
    { date: usdHistory.last, price: 100 },
], 'USD');
check(series.fxBasis === 'historical', 'series conversion uses per-day rates');
check(series.points[0].price !== series.points[1].price,
    'two equal USD amounts on different days give different euro amounts');
check(Math.abs(series.points[0].price - 100 * covidRate) < 1e-9, 'the 2022 point uses the 2022 rate');

// --- end to end on a real USD-quoted FT asset ---------------------------------
const raw = await fetchFtQuote(ISIN);
console.log(`FT raw quote: ${raw.price} ${raw.currency} (${raw.date})`);

const hist = await fetchHistoryForToken({ isin: ISIN, source: 'FT', beginDate: '2026-01-01' });
check(hist.success, `FT history fetched (${hist.error || 'no error'})`);
check(hist.data?.currency === 'EUR', 'history is delivered in EUR');
if (raw.currency !== 'EUR') {
    check(hist.data?.sourceCurrency === raw.currency, `history reports the source currency (${raw.currency})`);
    check(hist.data?.fxBasis === 'historical', 'history was converted with per-day rates');
    const last = hist.data.points[hist.data.points.length - 1];
    const expected = raw.price * (await getEurRate(raw.currency));
    console.log(`Last history point: ${last.date} = ${last.price.toFixed(4)} EUR (raw ${raw.price} ${raw.currency})`);
    check(last.price < raw.price * 1.2 && last.price > raw.price * 0.5, 'converted point is in the expected range');
    const rates = await getEurRateHistory(raw.currency);
    check(Math.abs(hist.data.fxRate - rates.rateOn(last.date)) < 1e-9, 'reported fxRate is the rate of the last point');
    console.log(`(latest quote converts at the spot rate to ${expected.toFixed(4)} EUR)`);
} else {
    console.log('Note: this ISIN is quoted in EUR, so the conversion path was not exercised end to end.');
}

// --- no rate available: the amount must keep its own currency -----------------
// 'XXX' is the ISO code for "no currency", so it passes the format check but
// xe.com publishes no rate for it — the same outcome as an unreachable xe.com.
const stranded = await amountToEur('test', 100, 'XXX');
check(!stranded.converted && stranded.amount === 100 && stranded.currency === 'XXX',
    'a failed rate lookup leaves the amount in its own currency (never mislabeled EUR)');

process.exit(failed ? 1 : 0);
