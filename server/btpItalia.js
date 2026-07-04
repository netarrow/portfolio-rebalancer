import axios from 'axios';
import * as cheerio from 'cheerio';

// Same UA family used elsewhere in server/ (index.js, bondMonitor.js) — both
// Borsa Italiana and rivaluta.it apply light bot-detection to generic clients.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// Recognises an inflation-linked BTP Italia from its Borsa Italiana
// "Denominazione" (e.g. "Btp Italia Mz28 Eur", "Btp€i ...").
const BTP_ITALIA_NAME_RE = /italia|€i|\bei\b|indicizz/i;

// Officially published semester base index (numero indice alla cedola
// precedente), taken by hand from the MEF "coefficienti di indicizzazione
// BTP Italia" table. ISTAT periodically rebases the FOI series (a "raccordo"
// jump between two consecutive months) — deriving a base across such a
// rebasing from raw FOI values would silently produce a wrong number (see
// deriveBaseIndexFromFoi), so any semester whose [cm-3, cm-2] window straddles
// a known rebasing MUST have its base hardcoded here. Semesters without a
// rebasing in that window are derived automatically and don't need an entry.
const BASE_INDEX_OVERRIDES = {
    IT0005532723: { '2026-03-14': 100.21557 }, // BTP Italia Mz28 2,00%
};

// --- Pure math (no I/O — every function below is offline-testable) --------

// Italian decimal format ("8,917" → 8.917, "1.234,56" → 1234.56).
function parseItNumber(s) {
    if (!s) return null;
    const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

// Domain rule: truncate to the 6th decimal, then round to the 5th. The
// epsilon guards against binary floating-point artifacts (e.g. an exact
// 1.02308 arriving as 1.0230799999999998 after division).
export function truncRound(x) {
    const t6 = Math.trunc(x * 1e6 + 1e-9) / 1e6;
    return Math.round(t6 * 1e5) / 1e5;
}

export function daysInMonth(year, month /* 1-12 */) {
    return new Date(year, month, 0).getDate();
}

// Month `offset` positions before (year, month); offset is positive (e.g.
// offset=3 for "3 months before").
export function monthBefore(year, month, offset) {
    let m = month - offset;
    let y = year;
    while (m <= 0) { m += 12; y -= 1; }
    return { year: y, month: m };
}

function toUTCDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function isoFromUTC(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(aISO, bISO) {
    return Math.round((toUTCDate(bISO) - toUTCDate(aISO)) / 86400000);
}

// Linear interpolation between the FOI of the two months preceding the query
// month: Indice(d) = FOI[m-3] + (d-1)/gg_mese × (FOI[m-2] - FOI[m-3]).
export function interpolateIndex(foiPrev, foiCur, day, dim) {
    return foiPrev + ((day - 1) / dim) * (foiCur - foiPrev);
}

export function applyDeflationFloor(ci) {
    return ci < 1 ? 1 : ci;
}

// Indice(dateISO) using the FOI pair for (month-3, month-2) of dateISO.
export function computeIndexNumber(dateISO, foiPair) {
    const [y, m, d] = dateISO.split('-').map(Number);
    const dim = daysInMonth(y, m);
    return interpolateIndex(foiPair.indiceDal, foiPair.indiceAl, d, dim);
}

// BTP Italia pays semi-annual coupons on the day-of-month of `maturityISO`,
// six months apart (e.g. maturity 14/03 → coupons every 14/03 and 14/09).
// Returns the semester (as ISO date strings) that dateISO falls in; the
// coupon day itself belongs to the new semester (rateo resets to 0 that day).
export function currentSemester(maturityISO, dateISO) {
    const [, mm, dd] = maturityISO.split('-').map(Number);
    const [dy] = dateISO.split('-').map(Number);
    const otherMonth = ((mm - 1 + 6) % 12) + 1;
    const months = [mm, otherMonth].sort((a, b) => a - b);

    const candidates = [];
    for (const y of [dy - 1, dy, dy + 1]) {
        for (const m of months) candidates.push(Date.UTC(y, m - 1, dd));
    }
    candidates.sort((a, b) => a - b);

    const dateMs = toUTCDate(dateISO);
    for (let i = 0; i < candidates.length - 1; i++) {
        if (candidates[i] <= dateMs && dateMs < candidates[i + 1]) {
            return { start: isoFromUTC(candidates[i]), end: isoFromUTC(candidates[i + 1]) };
        }
    }
    throw new Error(`Could not resolve semester for ${dateISO} (maturity ${maturityISO})`);
}

// Derive a semester's base index from raw FOI values. Throws if a rebasing
// (raccordo != 1) sits inside the [cm-3, cm-2] window instead of silently
// interpolating across it — validated live: FOI Dic-2025→Gen-2026 carries a
// real raccordo of 1,214, which would otherwise poison this calculation.
export function deriveBaseIndexFromFoi(isin, semesterStartISO, foiPair) {
    if (foiPair.raccordo != null && Math.abs(foiPair.raccordo - 1) > 1e-6) {
        throw new Error(
            `FOI rebasing (raccordo=${foiPair.raccordo}) straddles semester start ${semesterStartISO} for ${isin} — a MEF base-index override is required`
        );
    }
    const baseIndex = truncRound(computeIndexNumber(semesterStartISO, foiPair));
    console.warn(`[BtpItalia] derived base index for ${isin} ${semesterStartISO}: ${baseIndex} (no override — verify against MEF)`);
    return baseIndex;
}

export function getBaseIndexOverride(isin, semesterStartISO) {
    return BASE_INDEX_OVERRIDES[isin]?.[semesterStartISO] ?? null;
}

// CI(d) = truncRound(Indice(d) / base). Floor for deflation is applied
// separately (ciFloored) so the official (possibly <1) value stays reported.
export function computeCI(dateISO, foiPair, baseIndex) {
    const indice = computeIndexNumber(dateISO, foiPair);
    const ci = truncRound(indice / baseIndex);
    return { ci, ciFloored: applyDeflationFloor(ci), indice };
}

// Rateo = (tasso reale annuo / 2) sul semestre, convenzione effettivi/effettivi,
// poi rivalutato per il CI del giorno. Calendar date, no settlement lag —
// validated against a real portfolio total (04/07/2026: rateo 93,41 su 15.000
// nominali) to the cent.
export function computeRateoPer100(realRate, semester, dateISO, ci) {
    const elapsed = daysBetween(semester.start, dateISO);
    const total = daysBetween(semester.start, semester.end);
    return (realRate / 2) * (elapsed / total) * 100 * ci;
}

// Controvalore = Nominale × (Prezzo/100) × CI + Rateo_indicizzato.
export function computeCountervalue({ nominal, price, ciFloored, rateoPer100 }) {
    return nominal * (price / 100) * ciFloored + (rateoPer100 / 100) * nominal;
}

// Markup-agnostic like bondMonitor.js: resolve columns from the header row
// instead of hardcoding indices, so a rivaluta.it layout tweak degrades to a
// clear error instead of silently reading the wrong cell.
export function parseFoiPair(html) {
    const $ = cheerio.load(html);
    const table = $('table.table-bordered').first();
    const rows = table.find('tr');
    if (rows.length < 2) throw new Error('FOI table parse failed (no data row)');

    const headers = $(rows[0]).find('td').map((_, td) => $(td).text().trim().toLowerCase()).get();
    const cells = $(rows[1]).find('td').map((_, td) => $(td).text().trim()).get();

    const iDal = headers.findIndex(h => h.includes('indice dal'));
    const iAl = headers.findIndex(h => h.includes('indice al'));
    const iRacc = headers.findIndex(h => h.includes('racc'));

    if (iDal < 0 || iAl < 0 || cells.length <= Math.max(iDal, iAl)) {
        throw new Error('FOI table parse failed (Indice Dal/Indice Al columns not found)');
    }

    const indiceDal = parseItNumber(cells[iDal]);
    const indiceAl = parseItNumber(cells[iAl]);
    const raccordo = iRacc >= 0 ? parseItNumber(cells[iRacc]) : null;
    if (indiceDal == null || indiceAl == null) {
        throw new Error('FOI table parse failed (non-numeric index values)');
    }

    return { indiceDal, indiceAl, raccordo };
}

function parseBorsaDate(s) {
    // "14/03/28" -> "2028-03-14"
    const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(s || '');
    if (!m) return null;
    const [, dd, mm, yy] = m;
    return `${2000 + Number(yy)}-${mm}-${dd}`;
}

export function isBtpItaliaName(name) {
    return BTP_ITALIA_NAME_RE.test(name || '');
}

function todayISO() {
    // Rome-local calendar date — the domain rules are day-of-month sensitive,
    // so using the server's UTC date would occasionally be off by one day
    // around midnight CET/CEST.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
}

// --- Fetch + cache (rivaluta.it — sole external source) --------------------

const RIVALUTA_URL = process.env.BTP_ITALIA_FOI_URL || 'https://www.rivaluta.it/rivaluta3_partner.asp';
const RIVALUTA_REFERER = 'https://www.rivaluta.it/rivalutazionemonetaria/calcolo-aumento-istat.asp';
const REQUEST_TIMEOUT_MS = Number(process.env.BTP_ITALIA_TIMEOUT_MS || 20000);
const FOI_TTL_MS = Number(process.env.BTP_ITALIA_FOI_TTL_MS || 24 * 60 * 60 * 1000);
const FOI_NEGATIVE_TTL_MS = 15 * 60 * 1000;
// Bond identity/maturity/coupon rate never change during the bond's life —
// a long cache avoids re-scraping Borsa Italiana on every price update.
const BOND_META_TTL_MS = Number(process.env.BTP_ITALIA_META_TTL_MS || 30 * 24 * 60 * 60 * 1000);

const foiPairCache = new Map(); // `${yA}-${mA}:${yB}-${mB}` -> { indiceDal, indiceAl, raccordo, time }
const bondMetaCache = new Map(); // isin -> { name, maturity, realRate, isBtpItalia, time }
let foiFailedAt = 0;

function ymKey({ year, month }) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

async function fetchFoiPair(a, b) {
    const key = `${ymKey(a)}:${ymKey(b)}`;
    const cached = foiPairCache.get(key);
    if (cached && Date.now() - cached.time < FOI_TTL_MS) {
        console.log(`[BtpItalia] FOI pair ${key} (rivaluta.it, cached)`);
        return { ...cached, cached: true };
    }
    if (Date.now() - foiFailedAt < FOI_NEGATIVE_TTL_MS) {
        throw new Error('rivaluta.it FOI fetch recently failed — backing off');
    }

    const dal = `${a.year}-${String(a.month).padStart(2, '0')}-01`;
    const al = `${b.year}-${String(b.month).padStart(2, '0')}-01`;
    try {
        const { data: html } = await axios.post(
            RIVALUTA_URL,
            new URLSearchParams({ t: 'FOI', dal, al, txtimporto: '1000' }).toString(),
            {
                timeout: REQUEST_TIMEOUT_MS,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
                    'Referer': RIVALUTA_REFERER,
                },
            }
        );
        const pair = parseFoiPair(html);
        console.log(`[BtpItalia] FOI pair fetched from rivaluta.it: ${ymKey(a)}=${pair.indiceDal} ${ymKey(b)}=${pair.indiceAl}`);
        const entry = { ...pair, time: Date.now() };
        foiPairCache.set(key, entry);
        return { ...entry, cached: false };
    } catch (err) {
        foiFailedAt = Date.now();
        throw new Error(`rivaluta.it FOI fetch failed: ${err.message}`);
    }
}

async function resolveBaseIndex(isin, semesterStartISO) {
    const override = getBaseIndexOverride(isin, semesterStartISO);
    if (override != null) return { baseIndex: override, derived: false };

    const [sy, sm] = semesterStartISO.split('-').map(Number);
    const pair = await fetchFoiPair(monthBefore(sy, sm, 3), monthBefore(sy, sm, 2));
    return { baseIndex: deriveBaseIndexFromFoi(isin, semesterStartISO, pair), derived: true };
}

// Scrapes maturity + periodic real coupon rate from the same Borsa Italiana
// MOT page already used for price/rateo — server-rendered, no Puppeteer
// needed for these fields. This is what makes the module ISIN-agnostic: a
// new BTP Italia added to the portfolio is recognised and configured
// automatically, no registry entry required.
async function fetchBondMeta(isin) {
    const cached = bondMetaCache.get(isin);
    if (cached && Date.now() - cached.time < BOND_META_TTL_MS) return cached;

    const url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}.html?lang=it`;
    const { data: html } = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'it-IT,it;q=0.9' },
    });

    const $ = cheerio.load(html);
    const fieldValue = (label) => {
        let value = null;
        $('table.m-table tr').each((_, tr) => {
            if ($(tr).text().includes(label)) {
                value = $(tr).find('td:last-child span.t-text').first().text().trim();
            }
        });
        return value;
    };

    const name = fieldValue('Denominazione');
    const maturity = parseBorsaDate(fieldValue('Scadenza'));
    const tassoPeriodale = parseItNumber(fieldValue('Tasso Cedola Periodale'));
    const realRate = tassoPeriodale != null ? tassoPeriodale / 50 : null; // periodale% × 2 / 100
    const isBtpItalia = isBtpItaliaName(name);

    const meta = { isin, name, maturity, realRate, isBtpItalia, time: Date.now() };
    bondMetaCache.set(isin, meta);
    if (isBtpItalia) {
        console.log(`[BtpItalia] bond meta for ${isin}: "${name}" — maturity ${maturity ?? 'n/a'}, real rate ${realRate != null ? (realRate * 100).toFixed(2) + '%' : 'n/a'}`);
    }
    return meta;
}

// --- Orchestration ----------------------------------------------------------

export async function getBondMeta(isin) {
    return fetchBondMeta(isin);
}

export async function getIndexationCoefficient(isin, dateISO = todayISO()) {
    const meta = await fetchBondMeta(isin);
    if (!meta.isBtpItalia) {
        throw new Error(`${isin} does not look like a BTP Italia (Denominazione: "${meta.name ?? 'n/a'}")`);
    }
    if (!meta.maturity || meta.realRate == null) {
        throw new Error(`${isin}: could not read maturity/coupon rate from Borsa Italiana`);
    }

    const semester = currentSemester(meta.maturity, dateISO);
    const { baseIndex, derived } = await resolveBaseIndex(isin, semester.start);

    const [qy, qm] = dateISO.split('-').map(Number);
    const queryPair = await fetchFoiPair(monthBefore(qy, qm, 3), monthBefore(qy, qm, 2));
    const { ci, ciFloored, indice } = computeCI(dateISO, queryPair, baseIndex);
    const rateoPer100 = computeRateoPer100(meta.realRate, semester, dateISO, ci);

    console.log(`[BtpItalia] ${isin} ${dateISO} CI=${ci}${queryPair.cached ? ' (rivaluta FOI, cached)' : ' (rivaluta FOI)'}`);

    return {
        isin,
        date: dateISO,
        ci,
        ciFloored,
        indice,
        baseIndex,
        baseDerived: derived,
        semester,
        rateoPer100,
        source: 'rivaluta-foi',
        cached: queryPair.cached,
    };
}

export async function computeTelQuel(isin, { date = todayISO(), nominal, price } = {}) {
    const coeff = await getIndexationCoefficient(isin, date);
    const countervalue = (nominal != null && price != null)
        ? computeCountervalue({ nominal, price, ciFloored: coeff.ciFloored, rateoPer100: coeff.rateoPer100 })
        : null;
    return { ...coeff, countervalue };
}
