// ALIFOND (fondo pensione complementare dell'industria alimentare) — monthly
// "valore quota" for the DINAMICO comparto.
//
// The andamento page is fully server-rendered: the chart is only a 13-point
// Highcharts config, but the page also carries the FULL monthly series as one
// <table class="dataset"> per year (rows: month number, quota). We parse those
// tables, so no Puppeteer is needed — plain fetch + cheerio, like FT/bondMonitor.
//
// Numbers here use a DOT as the decimal separator ("26.911" = 26,911 €), unlike
// the Italian convention used elsewhere on the site, hence the local parser.

import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// index.jsp?show=andamento&folder=<n> — one folder per comparto.
export const ALIFOND_COMPARTI = {
    BILANCIATO: 1,
    GARANTITO: 2,
    DINAMICO: 3,
};

export const DEFAULT_ALIFOND_COMPARTO = 'DINAMICO';

// The page publishes one new quota per month, so a short TTL is enough to keep
// a price update and a history backfill of the same asset to a single request.
const PAGE_TTL_MS = 30 * 60 * 1000;
const pageCache = new Map(); // comparto -> { points, expiresAt }

/** An ALIFOND ticker is free text (no ISIN); let it name its own comparto,
 *  e.g. 'ALIFOND-BILANCIATO'. Anything else falls back to DINAMICO. */
export function compartoFromTicker(ticker) {
    const t = String(ticker || '').toUpperCase();
    for (const name of Object.keys(ALIFOND_COMPARTI)) {
        if (t.includes(name)) return name;
    }
    return DEFAULT_ALIFOND_COMPARTO;
}

function alifondUrl(comparto) {
    const folder = ALIFOND_COMPARTI[comparto];
    if (!folder) throw new Error(`Unknown ALIFOND comparto: ${comparto}`);
    return `https://www.alifond.it/index.jsp?show=andamento&folder=${folder}`;
}

function lastDayOfMonth(year, month) {
    const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** '26.911' → 26.911. A comma, if present, wins as decimal separator and dots
 *  are then thousands separators ('1.234,56' → 1234.56). */
function parseAlifondNumber(text) {
    let cleaned = String(text || '').replace(/[^\d.,-]/g, '');
    if (!cleaned) return null;
    if (cleaned.includes(',')) cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    const val = parseFloat(cleaned);
    return Number.isFinite(val) ? val : null;
}

/**
 * Parse the andamento page into ascending [{date, price}].
 * The dataset tables are read in document order: a row holding "Anno YYYY" sets
 * the year for the (month, quota) rows that follow it.
 */
export function parseAlifondPage(html) {
    const $ = cheerio.load(html || '');
    const byDate = new Map();
    let year = null;

    $('table.dataset tr').each((_, tr) => {
        const cells = $(tr).find('td');
        if (cells.length < 2) return;

        const first = $(cells[0]).text().replace(/\s+/g, ' ').trim();
        const second = $(cells[1]).text().replace(/\s+/g, ' ').trim();

        const yearMatch = first.match(/anno\s+(\d{4})/i);
        if (yearMatch) {
            year = Number(yearMatch[1]);
            return;
        }

        if (year === null) return;
        if (!/^\d{1,2}$/.test(first)) return;
        const month = Number(first);
        if (month < 1 || month > 12) return;

        const price = parseAlifondNumber(second);
        // A quota is a small positive euro amount; anything else is a stray row.
        if (price === null || price <= 0 || price > 10000) return;

        // The month labels resolve to the end of the month, like COMETA's series.
        byDate.set(lastDayOfMonth(year, month), price);
    });

    return [...byDate.entries()]
        .map(([date, price]) => ({ date, price }))
        .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchAlifondPoints(comparto = DEFAULT_ALIFOND_COMPARTO) {
    const cached = pageCache.get(comparto);
    if (cached && Date.now() < cached.expiresAt) return cached.points;

    const res = await fetch(alifondUrl(comparto), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`ALIFOND returned HTTP ${res.status}`);

    const points = parseAlifondPage(await res.text());
    if (points.length === 0) {
        throw new Error(`No ALIFOND quota values found for comparto ${comparto}`);
    }
    pageCache.set(comparto, { points, expiresAt: Date.now() + PAGE_TTL_MS });
    return points;
}

/** Latest published monthly NAV. The fund has no intraday price. */
export async function fetchAlifondQuote(comparto = DEFAULT_ALIFOND_COMPARTO) {
    const points = await fetchAlifondPoints(comparto);
    const last = points[points.length - 1];
    return { price: last.price, currency: 'EUR', date: last.date, comparto };
}

export async function fetchAlifondHistory(comparto = DEFAULT_ALIFOND_COMPARTO) {
    const points = await fetchAlifondPoints(comparto);
    return { points, currency: 'EUR' };
}
