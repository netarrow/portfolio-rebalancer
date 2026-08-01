// FT Markets (markets.ft.com) — quotes and daily history for instruments the
// other sources don't cover, most notably Luxembourg-domiciled mutual funds
// whose NAV is not published by Borsa Italiana or JustETF.
//
// Everything here is plain HTTP: FT exposes a security search that maps an ISIN
// to an internal numeric id ("xid"), and an AJAX endpoint that returns the daily
// OHLC table for that xid. No Puppeteer needed.

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const SEARCH_URL = 'https://markets.ft.com/data/searchapi/searchsecurities';
const HISTORY_URL = 'https://markets.ft.com/data/equities/ajax/get-historical-prices';
const DATA_BASE = 'https://markets.ft.com/data';

const MONTHS = {
    January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
    July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};
const DATE_IN_ROW = new RegExp(`(${Object.keys(MONTHS).join('|')})\\s+(\\d{1,2}),\\s*(\\d{4})`);

// isin -> { xid, symbol, currency, name, expiresAt }. FT ids are stable, so a
// day of caching saves two HTTP round-trips per price update.
const RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;
const resolveCache = new Map();

async function ftFetch(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' },
    });
    if (!res.ok) throw new Error(`FT returned HTTP ${res.status}`);
    return res;
}

/** Currency is the trailing segment of an FT symbol when it is a 3-letter code
 *  ('LU0115773425:EUR', 'VWCE:GER:EUR'); plain equity symbols ('ASY:LSE') omit it. */
function currencyFromSymbol(symbol) {
    const last = String(symbol || '').split(':').pop();
    return /^[A-Z]{3}$/.test(last) ? last : null;
}

function tearsheetUrl(entry) {
    // Search results carry a site-relative url like '~/funds/tearsheet/summary?s=...'
    const raw = String(entry?.url || '');
    if (!raw.startsWith('~/')) return null;
    return DATA_BASE + raw.slice(1);
}

/** The search endpoint matches fuzzily: an ISIN it doesn't know still comes back
 *  with an unrelated security. Anything whose symbol doesn't already embed the
 *  ISIN must therefore be confirmed against its own tearsheet before use. */
async function confirmsIsin(entry, isin) {
    const url = tearsheetUrl(entry);
    if (!url) return false;
    try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
        if (!res.ok) return false;
        return (await res.text()).includes(isin);
    } catch (e) {
        return false;
    }
}

export async function resolveFtSecurity(isin, { forceRefresh = false } = {}) {
    const cached = resolveCache.get(isin);
    if (cached && !forceRefresh && Date.now() < cached.expiresAt) return cached;

    const u = new URL(SEARCH_URL);
    u.searchParams.set('query', isin);
    const json = await (await ftFetch(u)).json();
    const candidates = json?.data?.security;
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error(`FT has no security for ${isin}`);
    }

    // Funds are addressed by ISIN directly, so those results are self-proving and
    // are tried first. Otherwise prefer a EUR listing (the app values in EUR),
    // then FT's own primary listing.
    const score = (c) => {
        const sym = String(c.symbol || '');
        if (sym.toUpperCase().startsWith(`${isin}:`)) return 0;
        if (currencyFromSymbol(sym) === 'EUR') return 1;
        if (c.isPrimary) return 2;
        return 3;
    };
    const ordered = [...candidates].sort((a, b) => score(a) - score(b));

    for (const entry of ordered) {
        const symbol = String(entry.symbol || '');
        const xid = String(entry.xid || '');
        if (!xid) continue;
        const selfProving = symbol.toUpperCase().startsWith(`${isin}:`);
        if (!selfProving && !(await confirmsIsin(entry, isin))) continue;

        const resolved = {
            xid,
            symbol,
            currency: currencyFromSymbol(symbol) || 'EUR',
            name: String(entry.name || ''),
            expiresAt: Date.now() + RESOLVE_TTL_MS,
        };
        resolveCache.set(isin, resolved);
        return resolved;
    }

    throw new Error(`FT returned no security matching ${isin}`);
}

function parseFtNumber(text) {
    const cleaned = String(text || '').replace(/,/g, '').trim();
    if (!cleaned || cleaned === '--') return null;
    const val = parseFloat(cleaned);
    return isFinite(val) ? val : null;
}

/** Parse the AJAX table into ascending [{date, price}] using the close column. */
function parseHistoryHtml(html) {
    const points = [];
    for (const row of String(html || '').match(/<tr>[\s\S]*?<\/tr>/g) || []) {
        const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
        if (cells.length < 5) continue;
        const strip = (c) => c.replace(/<[^>]+>/g, ' ');
        const m = DATE_IN_ROW.exec(strip(cells[0]));
        if (!m) continue;
        const price = parseFtNumber(strip(cells[4]));
        if (price === null) continue;
        points.push({
            date: `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}`,
            price,
        });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    return points;
}

async function historyRows(xid, beginDate, endDate) {
    const u = new URL(HISTORY_URL);
    u.searchParams.set('startDate', beginDate);
    u.searchParams.set('endDate', endDate);
    u.searchParams.set('symbol', xid);
    const json = await (await ftFetch(u)).json();
    return parseHistoryHtml(json?.html);
}

export async function fetchFtHistory(isin, beginDate, endDate) {
    const { xid, currency } = await resolveFtSecurity(isin);
    const points = await historyRows(xid, beginDate, endDate);
    if (points.length === 0) throw new Error('FT history contained no usable points');
    return { points, currency };
}

function isoDaysAgo(days) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
}

/** Latest published close/NAV. FT has no separate realtime endpoint for funds,
 *  so the most recent row of the daily table is the quote. The lookback widens
 *  once because a fund can go days without a new valuation. */
export async function fetchFtQuote(isin) {
    const { xid, currency } = await resolveFtSecurity(isin);
    const endDate = new Date().toISOString().slice(0, 10);
    for (const lookback of [14, 60]) {
        const points = await historyRows(xid, isoDaysAgo(lookback), endDate);
        if (points.length > 0) {
            const last = points[points.length - 1];
            return { price: last.price, currency, date: last.date };
        }
    }
    throw new Error(`FT published no price for ${isin} in the last 60 days`);
}
