// ECB deposit facility rate (DFR) history, straight from the ECB Data Portal.
//
// The DFR is what a euro earns overnight with no risk, which makes it the
// natural risk-free leg of a Sharpe ratio for a euro investor. The app used to
// subtract one hand-typed rate from the whole history; with this series every
// stretch of the track record is compared with the rate in force at the time
// (negative until mid-2022, 4% in 2023-24, …).
//
// Series FM.B.U2.EUR.4F.KR.DFR.LEV is the "date of changes" flavour: one row
// per rate decision since 1999 (a few dozen rows), each valid until the next.
//
//   KEY,FREQ,…,TIME_PERIOD,OBS_VALUE,…
//   FM.B.U2.EUR.4F.KR.DFR.LEV,B,…,2025-06-11,2,…

const ECB_DFR_URL = 'https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.DFR.LEV?format=csvdata&detail=dataonly';
export const ECB_DFR_SOURCE = 'ECB Data Portal — FM.B.U2.EUR.4F.KR.DFR.LEV';

// Rate decisions come every six weeks at most; twice a day is plenty.
const TTL_MS = 12 * 60 * 60 * 1000;
let cache = null; // { payload, expiresAt }
let inFlight = null;

/** Split one CSV line, honouring double-quoted fields. */
function splitCsvLine(line) {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

/**
 * Decode the ECB csvdata payload into [{ date: 'YYYY-MM-DD', ratePct }], sorted
 * by date. Columns are located by header name, so extra/reordered columns
 * (detail=full vs dataonly) don't matter.
 */
export function parseEcbRatesCsv(csv) {
    const lines = String(csv || '').split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) throw new Error('ECB payload carried no observations');

    const header = splitCsvLine(lines[0]);
    const dateCol = header.indexOf('TIME_PERIOD');
    const valueCol = header.indexOf('OBS_VALUE');
    if (dateCol === -1 || valueCol === -1) throw new Error('ECB payload is missing TIME_PERIOD/OBS_VALUE');

    const byDate = new Map();
    for (const line of lines.slice(1)) {
        const cells = splitCsvLine(line);
        const date = cells[dateCol];
        const raw = cells[valueCol];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || raw === undefined || raw === '') continue;
        const ratePct = Number(raw);
        // The DFR has lived between -0.5% and 3.75%; anything far outside
        // means we are not reading the column we think we are.
        if (!Number.isFinite(ratePct) || ratePct < -5 || ratePct > 25) continue;
        byDate.set(date, ratePct);
    }
    if (byDate.size === 0) throw new Error('ECB payload carried no usable rates');

    return [...byDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, ratePct]) => ({ date, ratePct }));
}

async function fetchDepositRates() {
    const res = await fetch(ECB_DFR_URL, {
        headers: { Accept: 'text/csv' },
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`ECB Data Portal returned HTTP ${res.status}`);
    const rates = parseEcbRatesCsv(await res.text());
    return {
        series: 'ECB deposit facility rate',
        source: ECB_DFR_SOURCE,
        rates,
        fetchedAt: new Date().toISOString(),
    };
}

/**
 * Deposit facility rate history: { series, source, rates, fetchedAt }.
 * Cached for 12h; if a refresh fails the last good copy keeps being served
 * (the past never changes, only the newest decision could be missing).
 */
export async function getDepositFacilityRates({ force = false } = {}) {
    if (!force && cache && Date.now() < cache.expiresAt) return cache.payload;
    if (inFlight) return inFlight;

    inFlight = fetchDepositRates()
        .then((payload) => {
            cache = { payload, expiresAt: Date.now() + TTL_MS };
            const last = payload.rates[payload.rates.length - 1];
            console.log(`[ecb] deposit facility rate: ${payload.rates.length} changes, now ${last.ratePct}% (since ${last.date})`);
            return payload;
        })
        .catch((err) => {
            if (cache) {
                console.warn(`[ecb] refresh failed (${err.message}), serving the cached series`);
                return cache.payload;
            }
            throw err;
        })
        .finally(() => { inFlight = null; });

    return inFlight;
}
