import axios from 'axios';
import * as cheerio from 'cheerio';

// simpletoolsforinvestors.eu switched monitors from named slugs (btp,
// altri_europa) to numeric ids. Current mapping (see monitors.php):
//   5  = "Italia" (Italian government bonds, incl. BTP)
//   66 = "Titoli di stato europei" (European government bonds)
// The old slugs now return an "il monitor non sembra esistere" alert and
// redirect, so scraping yielded zero bonds → always "no proposals".
const MONITORS = {
    IT: 'https://www.simpletoolsforinvestors.eu/monitor_info.php?monitor=5&yieldtype=G&timescale=DUR',
    EU: 'https://www.simpletoolsforinvestors.eu/monitor_info.php?monitor=66&yieldtype=G&timescale=DUR',
};

const bondProposalCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getCacheKey(universe) {
    return `bonds_${universe}`;
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Italian decimal format ("8,917" → 8.917, "1.234,56" → 1234.56).
function parseItNumber(s) {
    if (!s) return null;
    const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

// The monitor page is fully server-rendered: each bond is a <tr> whose cells
// are [ISIN, '', '', name, currency, maturity(ISO), lot, seniority, market,
// price, yield, …]. We parse the HTML directly with cheerio instead of driving
// a headless browser — datatables rewrites the DOM and drops the <tbody>, which
// is why the previous puppeteer/DOM heuristic only ever found bonds without a
// maturity date (via the JS-array fallback), so every proposal was filtered out.
async function scrapeBondMonitor(universe) {
    const cached = bondProposalCache.get(getCacheKey(universe));
    if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
        console.log(`[BondMonitor] cache hit for ${universe}`);
        return cached.data;
    }

    const url = MONITORS[universe];
    if (!url) throw new Error(`Unknown bond universe: ${universe}`);

    console.log(`[BondMonitor] scraping ${universe} from ${url}`);
    const { data: html } = await axios.get(url, {
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
    });

    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    // Header labels (it) → our fields. Each table carries its own <thead>, so we
    // resolve column indices per table rather than assuming a fixed layout.
    const colIndex = (headers, ...labels) =>
        headers.findIndex(h => labels.some(l => h.toLowerCase().includes(l)));

    $('table').each((_, table) => {
        const headers = $(table).find('thead th').map((__, th) => $(th).text().trim()).get();
        if (!headers.length) return;

        const iName = colIndex(headers, 'descrizione', 'nome');
        const iCur = colIndex(headers, 'divisa', 'valuta');
        const iMat = colIndex(headers, 'scadenza');
        const iYield = colIndex(headers, 'yield', 'rendimento');

        $(table).find('tbody tr, tr').each((__, tr) => {
            const cells = $(tr).find('td').map((___, td) => $(td).text().trim()).get();
            if (cells.length < 4) return;

            // ISIN: prefer the mapped/first cell, but fall back to a scan.
            const isin = (ISIN_RE.test(cells[0]) ? cells[0] : cells.find(c => ISIN_RE.test(c)));
            if (!isin || seen.has(isin)) return;

            const matCell = iMat >= 0 ? cells[iMat] : cells.find(c => ISO_DATE_RE.test(c));
            const maturityDate = matCell && ISO_DATE_RE.test(matCell) ? matCell : null;

            const name = (iName >= 0 && cells[iName])
                ? cells[iName]
                : (cells.find(c => /[A-Za-z]/.test(c) && c.length > 5 && c !== isin && c !== 'EUR') || isin);

            const currency = (iCur >= 0 && /^[A-Z]{3}$/.test(cells[iCur] || ''))
                ? cells[iCur]
                : (cells.find(c => /^[A-Z]{3}$/.test(c)) || 'EUR');

            const yieldVal = iYield >= 0 ? parseItNumber(cells[iYield]) : null;

            seen.add(isin);
            results.push({ isin, name, maturityDate, yield: yieldVal, currency, universe });
        });
    });

    bondProposalCache.set(getCacheKey(universe), { data: results, time: Date.now() });
    console.log(`[BondMonitor] found ${results.length} bonds for ${universe} (${results.filter(b => b.maturityDate).length} with maturity)`);
    return results;
}

function filterByMaturityWindow(bonds, targetDate, minMonthsBefore, maxMonthsBefore) {
    const target = new Date(targetDate);
    const latestMaturity = new Date(target);
    latestMaturity.setMonth(latestMaturity.getMonth() - minMonthsBefore);
    const earliestMaturity = new Date(target);
    earliestMaturity.setMonth(earliestMaturity.getMonth() - maxMonthsBefore);

    return bonds
        .filter(b => {
            if (!b.maturityDate) return false;
            const mat = new Date(b.maturityDate);
            return mat >= earliestMaturity && mat <= latestMaturity;
        })
        .sort((a, b) => {
            // Sort by yield descending, tie-break by closest to target
            if (a.yield != null && b.yield != null && a.yield !== b.yield) {
                return b.yield - a.yield;
            }
            const aDist = Math.abs(new Date(a.maturityDate).getTime() - target.getTime());
            const bDist = Math.abs(new Date(b.maturityDate).getTime() - target.getTime());
            return aDist - bDist;
        });
}

export { scrapeBondMonitor, filterByMaturityWindow, bondProposalCache };
