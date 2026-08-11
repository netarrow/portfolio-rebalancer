// Currency conversion to EUR.
//
// The app values everything in euro: prices are stored as bare numbers and every
// total/chart formats them as EUR. A source that quotes in another currency —
// FT Markets in particular, which serves plenty of USD-denominated funds — would
// otherwise silently poison those totals, so any non-EUR quote is converted here
// before it ever leaves the server.
//
// Two rates are needed, and they come from two different xe.com pages:
//
//   * the spot rate, for live quotes — from the converter page. It is
//     client-rendered, but the server response embeds the data the page hydrates
//     from: {"from":"USD","to":"EUR","rate":0.8668651706,…}.
//   * the daily history, for historical series — from the JSON the currency
//     charts page (…/currencycharts/?from=USD&to=EUR) fetches, so every past
//     point is converted at the rate of ITS OWN day instead of today's.

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const RATE_TTL_MS = 60 * 60 * 1000; // FX moves slowly enough for an hourly rate.
const rateCache = new Map(); // 'USD' -> { rate, expiresAt }
const inFlight = new Map(); // 'USD' -> Promise<number>, so a batch fetches once

// The daily series only gains one point a day, so it is cached far longer.
const SERIES_TTL_MS = 12 * 60 * 60 * 1000;
const seriesCache = new Map(); // 'USD' -> { series, expiresAt }
const seriesInFlight = new Map();

// Currencies quoted in minor units (GBX/GBp = pence, ZAC = cents): convert the
// amount to the major unit first, then apply that currency's rate.
const MINOR_UNITS = { GBX: 'GBP', ZAC: 'ZAR', ILA: 'ILS' };

/** 'GBp' → { code: 'GBP', divisor: 100 }; 'usd' → { code: 'USD', divisor: 1 }. */
export function normalizeCurrency(currency) {
    const raw = String(currency || '').trim();
    if (!raw) return null;
    // 'GBp' (lowercase p) is the conventional pence marker and must not be
    // upper-cased into GBP before the minor-unit check.
    if (raw === 'GBp') return { code: 'GBP', divisor: 100 };
    const upper = raw.toUpperCase();
    if (MINOR_UNITS[upper]) return { code: MINOR_UNITS[upper], divisor: 100 };
    if (!/^[A-Z]{3}$/.test(upper)) return null;
    return { code: upper, divisor: 1 };
}

function xeUrl(from) {
    return `https://www.xe.com/currencyconverter/convert/?Amount=1&From=${from}&To=EUR`;
}

async function scrapeEurRate(code) {
    const res = await fetch(xeUrl(code), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`xe.com returned HTTP ${res.status}`);
    const html = await res.text();

    const m = html.match(new RegExp(`"from"\\s*:\\s*"${code}"\\s*,\\s*"to"\\s*:\\s*"EUR"\\s*,\\s*"rate"\\s*:\\s*([\\d.eE+-]+)`));
    if (!m) throw new Error(`xe.com page carried no ${code}→EUR rate`);

    const rate = Number(m[1]);
    // A plausible FX rate is positive and nowhere near these bounds; anything
    // else means the page changed shape and we matched the wrong number.
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1e6) {
        throw new Error(`Implausible ${code}→EUR rate from xe.com: ${m[1]}`);
    }
    return rate;
}

/** Rate that turns one unit of `code` into euro. EUR itself is free. */
export async function getEurRate(code) {
    if (code === 'EUR') return 1;

    const cached = rateCache.get(code);
    if (cached && Date.now() < cached.expiresAt) return cached.rate;

    // Collapse the concurrent lookups a multi-asset batch would otherwise fire.
    const pending = inFlight.get(code);
    if (pending) return pending;

    const promise = scrapeEurRate(code)
        .then((rate) => {
            rateCache.set(code, { rate, expiresAt: Date.now() + RATE_TTL_MS });
            console.log(`[fx] ${code}→EUR = ${rate} (xe.com)`);
            return rate;
        })
        .finally(() => inFlight.delete(code));

    inFlight.set(code, promise);
    return promise;
}

/**
 * Convert `amount` from `currency` to EUR.
 * Returns { amount, currency: 'EUR', sourceCurrency, fxRate } — sourceCurrency
 * and fxRate are null when the amount was already in euro. Throws if the rate
 * cannot be obtained, so callers decide what to do with an unconverted price.
 */
export async function convertToEur(amount, currency) {
    const normalized = normalizeCurrency(currency);
    if (!normalized) throw new Error(`Unrecognized currency: ${currency}`);

    const { code, divisor } = normalized;
    if (code === 'EUR' && divisor === 1) {
        return { amount, currency: 'EUR', sourceCurrency: null, fxRate: null };
    }

    const rate = await getEurRate(code);
    return {
        amount: (amount / divisor) * rate,
        currency: 'EUR',
        sourceCurrency: String(currency),
        fxRate: rate / divisor,
    };
}

/** True when a quote in this currency needs converting at all. */
export function isEur(currency) {
    const normalized = normalizeCurrency(currency);
    return normalized?.code === 'EUR' && normalized.divisor === 1;
}

/**
 * The forgiving wrapper the scrapers use: never throws, and reports what it did.
 *
 * - already euro, or no usable currency label → passed through as EUR, which is
 *   how the app treated every quote before conversion existed;
 * - convertible → converted, `converted: true`;
 * - rate unavailable → amount AND currency left untouched, so downstream code
 *   can tell a real euro figure from an unconverted foreign one.
 *
 * `label` only identifies the asset in the logs.
 */
export async function amountToEur(label, amount, currency) {
    const passthrough = { amount, currency: 'EUR', sourceCurrency: null, fxRate: null, converted: false };

    const normalized = normalizeCurrency(currency);
    if (!normalized) {
        if (currency) console.warn(`[fx] ${label}: unrecognized currency "${currency}", treating the price as EUR`);
        return passthrough;
    }
    if (normalized.code === 'EUR' && normalized.divisor === 1) return passthrough;

    try {
        const converted = await convertToEur(amount, currency);
        return { ...converted, converted: true };
    } catch (e) {
        console.warn(`[fx] ${label}: leaving amount in ${currency}, conversion failed: ${e.message}`);
        return { amount, currency: String(currency), sourceCurrency: null, fxRate: null, converted: false };
    }
}

// --- DAILY RATE HISTORY --------------------------------------------------------
// The currency charts page reads /api/protected/charting-rates/, which needs an
// Authorization header. The credential is not a secret: xe's own front-end bundle
// builds it inline as `Basic ${btoa("…")}` and ships it to every visitor. We use
// the known value and re-scrape it from that bundle only if the API rejects it —
// the same "cache a public token, refresh on 401" shape as the Borsa Italiana
// chart token in history.js.
const XE_DEFAULT_CREDENTIAL = 'lodestar:pugsnax';
const XE_CHART_PAGE = 'https://www.xe.com/currencycharts/?from=USD&to=EUR';
let xeCredential = XE_DEFAULT_CREDENTIAL;

async function scrapeXeCredential() {
    const html = await (await fetch(XE_CHART_PAGE, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    })).text();

    // The fetcher that adds the header lives in the _app chunk.
    const chunks = [...html.matchAll(/src="(\/_next\/static\/chunks\/pages\/_app-[^"]+\.js)"/g)].map(m => m[1]);
    for (const chunk of chunks) {
        const js = await (await fetch(`https://www.xe.com${chunk}`, {
            headers: { 'User-Agent': USER_AGENT },
        })).text();
        const m = js.match(/\/api\/protected\/[\s\S]{0,600}?btoa\("([^"]+)"\)/);
        if (m) return m[1];
    }
    throw new Error('Could not find the xe.com chart API credential');
}

async function xeChartApi(code) {
    const url = `https://www.xe.com/api/protected/charting-rates/?fromCurrency=${code}&toCurrency=EUR&isExtended=true`;
    const call = () => fetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            Authorization: `Basic ${Buffer.from(xeCredential).toString('base64')}`,
        },
    });

    let res = await call();
    if (res.status === 401 || res.status === 403) {
        xeCredential = await scrapeXeCredential();
        console.log('[fx] refreshed the xe.com chart API credential');
        res = await call();
    }
    if (!res.ok) throw new Error(`xe.com chart API returned HTTP ${res.status}`);
    return res.json();
}

/**
 * Decode one charting-rates payload into a date → rate map.
 *
 * The payload is a list of batches at decreasing granularity (daily for the last
 * ~10 years, then hourly/15-min/1-min for recent days). Within a batch the FIRST
 * element of `rates` is an offset added to every other one, and element i (i ≥ 1)
 * is sampled at `startTime + interval * (i - 1)`:
 *
 *   {"startTime":1470873600000,"interval":86400000,
 *    "rates":[0.1882106334, 1.0822459307, …]}   →  2016-08-11 = 0.894035
 *
 * Batches are read in order and later samples overwrite earlier ones for the same
 * day, so each day ends up holding its latest observation.
 */
export function parseXeChartRates(payload) {
    const byDate = new Map();
    for (const batch of payload?.batchList || []) {
        const { startTime, interval, rates } = batch || {};
        if (!Number.isFinite(startTime) || !Number.isFinite(interval) || !Array.isArray(rates) || rates.length < 2) continue;
        const offset = rates[0];
        for (let i = 1; i < rates.length; i++) {
            const rate = rates[i] - offset;
            if (!Number.isFinite(rate) || rate <= 0) continue;
            const date = new Date(startTime + interval * (i - 1)).toISOString().slice(0, 10);
            byDate.set(date, rate);
        }
    }
    if (byDate.size === 0) throw new Error('xe.com chart payload carried no usable rates');
    return byDate;
}

/** Daily <currency>→EUR rates, newest ~10 years, as a lookup helper. */
export async function getEurRateHistory(code) {
    const cached = seriesCache.get(code);
    if (cached && Date.now() < cached.expiresAt) return cached.series;

    const pending = seriesInFlight.get(code);
    if (pending) return pending;

    const promise = xeChartApi(code)
        .then((payload) => {
            const byDate = parseXeChartRates(payload);
            const dates = [...byDate.keys()].sort();
            const series = {
                byDate,
                first: dates[0],
                last: dates[dates.length - 1],
                // Markets close at weekends and holidays while these series are
                // daily: carry the last known rate forward, and for a date older
                // than the series use its oldest rate rather than giving up.
                rateOn(date) {
                    const hit = byDate.get(date);
                    if (hit !== undefined) return hit;
                    let lo = 0, hi = dates.length - 1, best = -1;
                    while (lo <= hi) {
                        const mid = (lo + hi) >> 1;
                        if (dates[mid] <= date) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
                    }
                    return byDate.get(dates[best === -1 ? 0 : best]);
                },
            };
            seriesCache.set(code, { series, expiresAt: Date.now() + SERIES_TTL_MS });
            console.log(`[fx] ${code}→EUR daily history: ${dates.length} days, ${series.first} → ${series.last} (xe.com charts)`);
            return series;
        })
        .finally(() => seriesInFlight.delete(code));

    seriesInFlight.set(code, promise);
    return promise;
}

/**
 * Convert a dated series ([{date, price}]) to EUR, each point at the rate of its
 * own day. Never throws; like `amountToEur` it reports what it managed to do:
 *
 *   fxBasis 'historical' → per-day rates from the xe.com chart API;
 *   fxBasis 'spot'       → chart API unavailable, whole series rebased at today's
 *                          rate (levels shift, returns are unaffected);
 *   converted false      → no rate at all, points and currency left untouched.
 *
 * `fxRate` is the rate applied to the most recent point, for display.
 */
export async function seriesToEur(label, points, currency) {
    const passthrough = {
        points, currency: 'EUR', sourceCurrency: null, fxRate: null, fxBasis: null, converted: false,
    };

    const normalized = normalizeCurrency(currency);
    if (!normalized) {
        if (currency) console.warn(`[fx] ${label}: unrecognized currency "${currency}", treating the series as EUR`);
        return passthrough;
    }
    if (normalized.code === 'EUR' && normalized.divisor === 1) return passthrough;

    const { code, divisor } = normalized;

    try {
        const series = await getEurRateHistory(code);
        const converted = points.map(p => ({ ...p, price: (p.price / divisor) * series.rateOn(p.date) }));
        const lastDate = points[points.length - 1]?.date;
        return {
            points: converted,
            currency: 'EUR',
            sourceCurrency: String(currency),
            fxRate: series.rateOn(lastDate) / divisor,
            fxBasis: 'historical',
            converted: true,
        };
    } catch (e) {
        console.warn(`[fx] ${label}: no ${code} rate history (${e.message}), falling back to today's rate`);
    }

    // One euro is one euro, so converting a unit amount yields the multiplier
    // that rebases the whole series.
    const spot = await amountToEur(label, 1, currency);
    if (!spot.converted) {
        return { ...passthrough, currency: spot.currency, points };
    }
    return {
        points: points.map(p => ({ ...p, price: p.price * spot.amount })),
        currency: 'EUR',
        sourceCurrency: spot.sourceCurrency,
        fxRate: spot.amount,
        fxBasis: 'spot',
        converted: true,
    };
}
