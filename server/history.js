// Historical price fetching. Unlike the live-price scrapers in index.js these
// sources are plain JSON/HTML endpoints, so everything here runs on global
// fetch — Puppeteer is only needed for COMETA, whose chart data lives in a
// JS global on a WordPress page.

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const ISIN_REGEX = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function todayISO() {
    return new Date().toISOString().slice(0, 10);
}

function oneYearAgoISO() {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
}

// --- BORSA ITALIANA (grafici.borsaitaliana.it) -------------------------------
// The "Grafico interattivo" tab on borsaitaliana.it is an iframe whose static
// HTML embeds a long-lived JWT and the chart API base URL. We scrape that
// token once, cache it, and call the JSON API directly. Works for both ETFs
// and MOT bonds (exchcode XMIL); bonds come back as clean price (corso secco).
let biTokenCache = null; // { token, apiBase }

export async function getBorsaItalianaToken(forceRefresh = false) {
    if (biTokenCache && !forceRefresh) return biTokenCache;
    // Any listed instrument serves the same token; use a liquid ETF page.
    const res = await fetch('https://grafici.borsaitaliana.it/interactive-chart/IE00B4L5Y983-ETFP?lang=it', {
        headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`Token page returned HTTP ${res.status}`);
    const html = await res.text();
    const tokenMatch = html.match(/token="([^"]+)"/);
    const urlMatch = html.match(/url="([^"]+)"/);
    if (!tokenMatch) throw new Error('Unable to extract Borsa Italiana chart token');
    biTokenCache = {
        token: tokenMatch[1],
        apiBase: (urlMatch?.[1] || 'https://grafici.borsaitaliana.it/api/').replace(/\/+$/, ''),
    };
    return biTokenCache;
}

async function biApiGet(path, params) {
    let { token, apiBase } = await getBorsaItalianaToken();
    const buildUrl = (base) => {
        const u = new URL(base + path);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        return u;
    };
    const doFetch = (tok, base) => fetch(buildUrl(base), {
        headers: { 'User-Agent': USER_AGENT, Authorization: `Bearer ${tok}` },
    });
    let res = await doFetch(token, apiBase);
    if (res.status === 401 || res.status === 403) {
        // Token rotated since we cached it: re-scrape once and retry.
        ({ token, apiBase } = await getBorsaItalianaToken(true));
        res = await doFetch(token, apiBase);
    }
    if (!res.ok) throw new Error(`Borsa Italiana history API returned HTTP ${res.status}`);
    return res.json();
}

export async function fetchBorsaItalianaHistory(isin, beginDate, endDate) {
    const json = await biApiGet(`/instruments/${isin},XMIL,ISIN/history/range`, {
        'begin-date': beginDate,
        'end-date': endDate,
        adjustment: 'true',
        'add-last-price': 'true',
    });
    const rows = json?.history?.historyDt;
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('No history data from Borsa Italiana');
    }
    const points = [];
    for (const row of rows) {
        const dt = String(row.dt || '');
        const price = typeof row.closePx === 'number' ? row.closePx
            : typeof row.lastPx === 'number' ? row.lastPx : null;
        if (!/^\d{8}$/.test(dt) || price === null || !isFinite(price)) continue;
        points.push({ date: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`, price });
    }
    if (points.length === 0) throw new Error('Borsa Italiana history contained no usable points');
    return { points, currency: json?.history?.currency || 'EUR' };
}

// --- JUSTETF ------------------------------------------------------------------
export async function fetchJustEtfHistory(isin, dateFrom, dateTo) {
    const u = new URL(`https://www.justetf.com/api/etfs/${isin}/performance-chart`);
    u.searchParams.set('locale', 'en');
    u.searchParams.set('currency', 'EUR');
    u.searchParams.set('valuesType', 'MARKET_VALUE');
    u.searchParams.set('reduceData', 'true');
    u.searchParams.set('includeDividends', 'false');
    u.searchParams.set('dateFrom', dateFrom);
    u.searchParams.set('dateTo', dateTo);
    const res = await fetch(u, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`JustETF history API returned HTTP ${res.status}`);
    const json = await res.json();
    const series = json?.series;
    if (!Array.isArray(series) || series.length === 0) {
        throw new Error('No history data from JustETF');
    }
    const points = [];
    for (const item of series) {
        const date = item?.date;
        const price = item?.value?.raw;
        if (!DATE_REGEX.test(date || '') || typeof price !== 'number' || !isFinite(price)) continue;
        points.push({ date, price });
    }
    if (points.length === 0) throw new Error('JustETF history contained no usable points');
    return { points, currency: 'EUR' };
}

// --- COMETA -------------------------------------------------------------------
// The page the live scraper already uses contains the FULL monthly NAV series
// in the wpDataCharts global; the live scraper only takes the last value, here
// we take all points and zip them with their date categories.
const ITALIAN_MONTHS = {
    gen: 1, gennaio: 1, feb: 2, febbraio: 2, mar: 3, marzo: 3, apr: 4, aprile: 4,
    mag: 5, maggio: 5, giu: 6, giugno: 6, lug: 7, luglio: 7, ago: 8, agosto: 8,
    set: 9, settembre: 9, ott: 10, ottobre: 10, nov: 11, novembre: 11, dic: 12, dicembre: 12,
};

function lastDayOfMonth(year, month) {
    const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Parse the date labels found on the COMETA page into 'YYYY-MM-DD'.
// Seen/expected formats: '31/05/2026', '05/2026', '2026-05', 'mag 2026',
// 'maggio 2026'. Monthly labels resolve to the last day of the month.
export function parseCometaDateLabel(label) {
    const s = String(label || '').trim().toLowerCase();
    if (!s) return null;

    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // DD/MM/YYYY
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

    m = s.match(/^(\d{1,2})\/(\d{4})$/); // MM/YYYY
    if (m) return lastDayOfMonth(Number(m[2]), Number(m[1]));

    m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/); // YYYY-MM[-DD]
    if (m) {
        if (m[3]) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
        return lastDayOfMonth(Number(m[1]), Number(m[2]));
    }

    m = s.match(/^([a-zà]+)\.?\s+(\d{4})$/); // 'mag 2026' / 'maggio 2026'
    if (m && ITALIAN_MONTHS[m[1]]) return lastDayOfMonth(Number(m[2]), ITALIAN_MONTHS[m[1]]);

    return null;
}

function parseItalianNumber(text) {
    if (typeof text === 'number') return text;
    let cleaned = String(text || '').replace(/[^\d.,-]/g, '');
    if (!cleaned) return null;
    if (cleaned.includes(',')) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    const val = parseFloat(cleaned);
    return isFinite(val) ? val : null;
}

export async function fetchCometaHistory(page) {
    await page.goto('https://www.cometafondo.it/andamenti/crescita/', { waitUntil: 'networkidle2' });

    const extracted = await page.evaluate(() => {
        // Method 1: full series + x-axis categories from the wpDataCharts global.
        // wpDataTables puts the Highcharts config under render_data.options
        // (series AND xAxis.categories live there).
        try {
            if (typeof wpDataCharts !== 'undefined' && wpDataCharts[6]) {
                const chart = wpDataCharts[6];
                const rd = chart.render_data || chart;
                const data = rd.options?.series?.[0]?.data || rd.series?.[0]?.data;
                const categories = rd.options?.xAxis?.categories
                    || rd.options?.xaxis?.categories
                    || rd.xAxis?.categories
                    || null;
                if (Array.isArray(data) && data.length > 0) {
                    return {
                        data: JSON.parse(JSON.stringify(data)),
                        categories: Array.isArray(categories) ? JSON.parse(JSON.stringify(categories)) : null,
                    };
                }
            }
        } catch (e) {}
        // Method 2: HTML table rows (date, quota). The page hosts several
        // tables (monthly quota, annual returns, cookie policy...), so return
        // them separately and let the caller pick the one that parses best.
        try {
            const tables = [];
            for (const table of document.querySelectorAll('table')) {
                const rows = [];
                for (const row of table.querySelectorAll('tbody tr')) {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 2) {
                        rows.push({ label: cells[0].textContent.trim(), value: cells[1].textContent.trim() });
                    }
                }
                if (rows.length > 0) tables.push(rows);
            }
            if (tables.length > 0) return { tables };
        } catch (e) {}
        return null;
    });

    if (!extracted) throw new Error('No COMETA chart data found on page');

    let points = [];
    if (extracted.tables) {
        // Pick the table where the most rows parse as (date, value) — that is
        // the monthly quota table, not the annual-returns or cookie tables.
        for (const rows of extracted.tables) {
            const parsed = [];
            for (const row of rows) {
                const date = parseCometaDateLabel(row.label);
                const price = parseItalianNumber(row.value);
                if (date && price !== null) parsed.push({ date, price });
            }
            if (parsed.length > points.length) points = parsed;
        }
    } else {
        const { data, categories } = extracted;
        for (let i = 0; i < data.length; i++) {
            const raw = data[i];
            let value = null;
            let date = null;
            if (typeof raw === 'number') {
                value = raw;
            } else if (Array.isArray(raw)) {
                value = raw[1] ?? raw[0];
                // Highcharts [timestamp, y] pairs carry their own date
                if (raw.length >= 2 && typeof raw[0] === 'number' && raw[0] > 10_000_000_000) {
                    date = new Date(raw[0]).toISOString().slice(0, 10);
                }
            } else if (raw && typeof raw === 'object') {
                value = raw.y ?? raw.value ?? raw.v;
                if (raw.name) date = parseCometaDateLabel(raw.name);
            }
            if (!date && categories && categories[i] !== undefined) {
                date = parseCometaDateLabel(categories[i]);
            }
            if (date && typeof value === 'number' && isFinite(value)) {
                points.push({ date, price: value });
            }
        }
    }

    if (points.length === 0) throw new Error('COMETA chart data had no parseable date/value points');
    points.sort((a, b) => a.date.localeCompare(b.date));
    return { points, currency: 'EUR' };
}

// --- DISPATCHER ----------------------------------------------------------------
// Same envelope shape as scrapeToken in index.js so the socket/HTTP wiring and
// the client can treat both flows uniformly.
export async function fetchHistoryForToken(token, { withBrowserFn } = {}) {
    const { isin, source = 'ETF' } = token;
    let { beginDate } = token;

    if (source !== 'COMETA' && !ISIN_REGEX.test(isin)) {
        return { isin, success: false, error: 'Invalid ISIN format' };
    }
    if (!DATE_REGEX.test(beginDate || '')) beginDate = oneYearAgoISO();
    const endDate = todayISO();

    console.log(`History: ${isin} (${source}) from ${beginDate}`);

    try {
        if (source === 'CPRAM') {
            // No historical endpoint found for CPRAM; the client accumulates
            // daily snapshots from regular price updates instead.
            return { isin, success: false, error: 'history-unavailable' };
        }

        if (source === 'COMETA') {
            if (!withBrowserFn) throw new Error('Browser required for COMETA history');
            const { points, currency } = await withBrowserFn((page) => fetchCometaHistory(page));
            return historyResult(isin, points.filter(p => p.date >= beginDate), {
                granularity: 'M', priceBasis: 'dirty', currency,
            });
        }

        if (source === 'MOT') {
            // Chart API returns corso secco only — mark the series as clean so
            // the client never mixes it with tel-quel daily snapshots.
            const { points, currency } = await fetchBorsaItalianaHistory(isin, beginDate, endDate);
            return historyResult(isin, points, { granularity: 'D', priceBasis: 'clean', currency });
        }

        // ETF: Borsa Italiana first, JustETF fallback (mirrors the live scraper)
        try {
            const { points, currency } = await fetchBorsaItalianaHistory(isin, beginDate, endDate);
            return historyResult(isin, points, { granularity: 'D', priceBasis: 'dirty', currency });
        } catch (biErr) {
            console.log(`[history] ${isin} not on Borsa Italiana (${biErr.message}), falling back to JustETF`);
            const { points, currency } = await fetchJustEtfHistory(isin, beginDate, endDate);
            return historyResult(isin, points, { granularity: 'D', priceBasis: 'dirty', currency });
        }
    } catch (err) {
        console.warn(`Error fetching history for ${isin}: ${err.message}`);
        return { isin, success: false, error: err.message };
    }
}

function historyResult(isin, points, { granularity, priceBasis, currency }) {
    if (!points || points.length === 0) {
        return { isin, success: false, error: 'No history points in requested range' };
    }
    return {
        isin,
        success: true,
        data: {
            points,
            granularity,
            priceBasis,
            currency,
            lastUpdated: new Date().toISOString(),
        },
    };
}
