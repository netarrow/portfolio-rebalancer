import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import {
    acquireFreeSlot,
    releaseFreeSlot,
    waitWhilePremium,
    beginFreeWork,
    endFreeWork,
    runExclusivePremium,
} from './concurrency.js';
import { fetchHistoryForToken } from './history.js';
import { scrapeBondMonitor, filterByMaturityWindow } from './bondMonitor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Trust Azure App Service / reverse proxy so rate-limit sees the real client IP
// from X-Forwarded-For instead of grouping every request under the loopback hop.
app.set('trust proxy', 1);

// Security headers — only in production. In dev Vite HMR requires 'unsafe-eval'
// / 'unsafe-inline' on script-src, which would weaken the prod policy.
if (isProduction) {
    app.use(helmet({
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                'default-src': ["'self'"],
                'script-src': ["'self'"],
                'style-src': ["'self'", "'unsafe-inline'"],
                'img-src': ["'self'", 'data:'],
                'font-src': ["'self'", 'data:'],
                'connect-src': [
                    "'self'",
                    'https://api.ynab.com',
                    'https://*.blob.core.windows.net',
                    'wss:', 'ws:',
                ],
                'frame-ancestors': ["'none'"],
                'object-src': ["'none'"],
                'base-uri': ["'self'"],
                'form-action': ["'self'"],
            },
        },
        crossOriginEmbedderPolicy: false,
    }));
}

// Common middleware
const allowedOrigin = process.env.cors_domain || /^http:\/\/localhost(:\d+)?$/;
app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '16kb' })); // Enable JSON body parsing with size cap

// Catch body-parser errors (oversized payloads, malformed JSON) and return a
// clean JSON response instead of Express's default HTML stack-trace page.
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body too large.' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON payload.' });
    }
    next(err);
});

// Max ISINs accepted in a single price request (HTTP or socket).
const MAX_TOKENS_PER_REQUEST = 50;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

// --- PREMIUM ACCESS ---------------------------------------------------------
// Valid premium keys live ONLY in the Azure App Service configuration
// (env var PREMIUM_KEYS, comma-separated). They must never be committed to the
// repo or exposed to the client. A request that presents a valid key bypasses
// the free-tier concurrency cap and the in-memory cache; an absent or unknown
// key is treated as "free tier".
const PREMIUM_KEYS = new Set(
    (process.env.PREMIUM_KEYS || '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
);
if (PREMIUM_KEYS.size === 0) {
    console.warn('[premium] No PREMIUM_KEYS configured — every request runs on the rate-limited free tier.');
}

function isValidPremiumKey(key) {
    return typeof key === 'string' && key.length > 0 && PREMIUM_KEYS.has(key.trim());
}

// --- FREE-TIER PRICE CACHE --------------------------------------------------
// Keyless requests for an ISIN are served from this in-memory cache for up to a
// day, so repeated free-tier polling returns the previously scraped (possibly
// stale) value without ever launching Puppeteer. Entries auto-expire via a
// timer; premium requests neither read nor write this cache.
const FREE_CACHE_TTL_MS = Number(process.env.FREE_PRICE_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const priceCache = new Map(); // `${source}:${isin}` -> { result, expiresAt, timer }

function cacheKey(source, isin) {
    return `${source}:${isin}`;
}

function getCached(source, isin) {
    const entry = priceCache.get(cacheKey(source, isin));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        clearTimeout(entry.timer);
        priceCache.delete(cacheKey(source, isin));
        return null;
    }
    return entry.result;
}

function setCached(source, isin, result) {
    const key = cacheKey(source, isin);
    const existing = priceCache.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const timer = setTimeout(() => priceCache.delete(key), FREE_CACHE_TTL_MS);
    if (timer.unref) timer.unref();
    priceCache.set(key, { result, expiresAt: Date.now() + FREE_CACHE_TTL_MS, timer });
}

// Rate-limit the expensive Puppeteer-backed price endpoint per client IP.
const priceLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many price requests, please retry in a minute.' },
});

// Per-socket sliding-window limiter for `request_price_update`. The socket path
// triggers the same Puppeteer cost as /api/price, so without this an attacker
// could spawn a single WS connection and bypass the HTTP limit entirely.
const SOCKET_RATE_WINDOW_MS = 60_000;
const SOCKET_RATE_LIMIT = 10;

// --- SHARED SCRAPING --------------------------------------------------------
// Single source of truth for turning one (isin, source) into a price result.
// Used by both the socket and HTTP paths so the scraping logic lives in one
// place instead of being duplicated.
async function withBrowser(fn) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        return await fn(page);
    } finally {
        if (browser) await browser.close();
    }
}

// Best-effort extraction of bid/ask spread (%) and average annual volatility (%)
// from whatever page is currently loaded. Both fields are purely supplemental:
// if the page doesn't expose them (layout differs, data not published, etc.)
// this returns nulls and the caller proceeds as if they were never requested.
async function extractSpreadAndVolatility(page, currentPrice) {
    let bid = null, ask = null, volatility = null, spread = null;

    try {
        const result = await page.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const parseNum = (s) => {
                if (!s) return null;
                let cleaned = s.replace(/[^\d.,-]/g, '');
                if (!cleaned) return null;
                if (cleaned.includes(',') && cleaned.includes('.')) {
                    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
                } else if (cleaned.includes(',')) {
                    cleaned = cleaned.replace(',', '.');
                }
                const val = parseFloat(cleaned);
                return isNaN(val) ? null : val;
            };

            let bidVal = null, askVal = null, volVal = null, spreadVal = null;

            // 1. Table-row based labels (Borsa Italiana style: "Denaro" / "Lettera" / "Volatilità" / "Spread")
            const rows = document.querySelectorAll('table tr');
            for (const row of rows) {
                const cells = row.querySelectorAll('td, th');
                if (cells.length < 2) continue;
                const label = norm(row.textContent);
                const lastCellText = norm(cells[cells.length - 1].textContent);

                if (bidVal === null && /(^|\s)(denaro|bid)(\s|$)/i.test(label)) {
                    bidVal = parseNum(lastCellText);
                }
                if (askVal === null && /(^|\s)(lettera|ask)(\s|$)/i.test(label)) {
                    askVal = parseNum(lastCellText);
                }
                if (volVal === null && /volatilit[aà]|volatility/i.test(label)) {
                    volVal = parseNum(lastCellText);
                }
                if (spreadVal === null && /(^|\s)spread(\s|$)/i.test(label)) {
                    spreadVal = parseNum(lastCellText);
                }
            }

            // 2. data-testid based (JustETF realtime quote widget)
            const bidEl = document.querySelector('[data-testid="realtime-quotes_bid-value"]');
            const askEl = document.querySelector('[data-testid="realtime-quotes_ask-value"]');
            if (bidVal === null && bidEl) bidVal = parseNum(bidEl.textContent);
            if (askVal === null && askEl) askVal = parseNum(askEl.textContent);

            // 3. Generic label/value pairs (e.g. "Spread" / "Volatility 1Y" stat cards on JustETF)
            const candidates = document.querySelectorAll('dt, th, label, span, div, td');
            for (const el of candidates) {
                const text = norm(el.textContent);

                if (spreadVal === null && /^spread:?$/i.test(text)) {
                    const valueEl = el.nextElementSibling;
                    if (valueEl) {
                        const v = parseNum(valueEl.textContent);
                        if (v !== null) spreadVal = v;
                    }
                }

                if (volVal === null && /^(volatility|volatilit[aà])(\s*1\s*y|\s*1\s*anno|\s*annua)?:?$/i.test(text)) {
                    const valueEl = el.nextElementSibling;
                    if (valueEl) {
                        const v = parseNum(valueEl.textContent);
                        if (v !== null) volVal = v;
                    }
                }

                if (spreadVal !== null && volVal !== null) break;
            }

            return { bidVal, askVal, volVal, spreadVal };
        });

        bid = result.bidVal;
        ask = result.askVal;
        volatility = result.volVal;
        spread = result.spreadVal;
    } catch (e) {
        // Defensive: extraction is best-effort and must never break the price scrape
    }

    let spreadPercent = null;
    if (spread !== null) {
        spreadPercent = spread;
    } else if (bid !== null && ask !== null && currentPrice > 0) {
        spreadPercent = ((ask - bid) / currentPrice) * 100;
    }

    return { spreadPercent, volatility };
}

async function scrapeToken(page, isin, source = 'ETF') {
    // Re-validate per ISIN
    const isinRegex = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
    if (source !== 'COMETA' && !isinRegex.test(isin)) {
        return { isin, success: false, error: 'Invalid ISIN format' };
    }

    console.log(`Processing: ${isin} (${source})`);

    try {
        let url, priceText;
        let currency = 'EUR'; // Default
        let fetchedFromMIL = false;
        let indexationCoefficient = null;

        if (source === 'MOT') {
            url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}.html?lang=it`;

            await page.goto(url, { waitUntil: 'domcontentloaded' });

            // Cookie handling
            try {
                const cookieSelectors = ['#ccc-recommended-settings', '#cookiewall-container button', '#onetrust-accept-btn-handler', '.qc-cmp2-summary-buttons button:last-child'];
                for (const sel of cookieSelectors) {
                    if (await page.$(sel)) {
                        await page.click(sel);
                        await new Promise(r => setTimeout(r, 1000));
                        break;
                    }
                }
            } catch (e) {}

            const priceSelector = 'span.-formatPrice strong';
            try {
                await page.waitForSelector(priceSelector, { timeout: 10000 });
                const cleanPriceText = await page.$eval(priceSelector, el => el.textContent.trim());

                // Extract Rateo Lordo (gross accrued interest) and, for inflation-linked
                // bonds (BTP Italia / BTP€i), the Coefficiente di Indicizzazione that
                // revalues the principal with inflation.
                const extractBondFields = () => page.evaluate(() => {
                    const result = { rateo: null, coefficiente: null };
                    const rows = document.querySelectorAll('table.m-table tr');
                    for (const row of rows) {
                        const valueCell = row.querySelector('td:last-child span.t-text');
                        if (!valueCell) continue;
                        if (result.rateo === null && row.textContent.includes('Rateo Lordo')) {
                            result.rateo = valueCell.textContent.trim();
                        } else if (result.coefficiente === null && /indicizzazione/i.test(row.textContent)) {
                            result.coefficiente = valueCell.textContent.trim();
                        }
                    }
                    return result;
                });

                let { rateo: rateoText, coefficiente: coeffText } = await extractBondFields();

                if (coeffText === null) {
                    // The summary page may omit the coefficient. Only for bonds whose
                    // name suggests inflation indexation, look it up on the full-data
                    // page, so plain bonds don't pay a second navigation.
                    const bondName = await page.evaluate(() =>
                        (document.querySelector('h1')?.textContent || document.title || '').trim()
                    );
                    if (/italia|€i|\bei\b|indicizz/i.test(bondName)) {
                        try {
                            await page.goto(`https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}/dati-completi.html?lang=it`, { waitUntil: 'domcontentloaded' });
                            const full = await extractBondFields();
                            coeffText = full.coefficiente;
                        } catch (e) {}
                        // Back to the summary page: spread/volatility are extracted
                        // from the current page after this block.
                        try { await page.goto(url, { waitUntil: 'domcontentloaded' }); } catch (e) {}
                    }
                }

                const parseItNumber = (text) => parseFloat(text.replace(/\./g, '').replace(',', '.'));
                const cleanPrice = parseItNumber(cleanPriceText);
                const rateo = rateoText ? parseItNumber(rateoText) : 0;
                const coeff = coeffText ? parseItNumber(coeffText) : NaN;
                // Sanity bound: a real indexation coefficient sits near 1; anything
                // outside means the wrong table row or a misparsed number.
                if (!isNaN(coeff) && coeff > 0.5 && coeff < 3) indexationCoefficient = coeff;
                // Tel quel = (corso secco + rateo lordo) × coefficiente di indicizzazione.
                // MOT convention for indexed bonds: both the clean price and the real
                // accrued interest are scaled by the indexation coefficient.
                priceText = String((cleanPrice + rateo) * (indexationCoefficient ?? 1));
            } catch (e) {}

        } else if (source === 'CPRAM') {
            url = `https://cpram.com/ita/it/privati/products/${isin}`;
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            try {
                const btns = await page.$$('button, a');
                for (const b of btns) {
                    const t = await b.evaluate(el => el.textContent);
                    if (t && (t.includes('Sì, accetto') || t.includes('Accettare tutto'))) {
                        await b.click();
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            } catch (e) {}

            try {
                await page.waitForSelector('.headline-4', { timeout: 10000 });
                const extractedData = await page.evaluate(() => {
                    const items = document.querySelectorAll('#list-item');
                    for (const item of items) {
                        if (item.textContent.includes('Valore dalla quota')) {
                            const valueEl = item.querySelector('.headline-4');
                            if (valueEl) return valueEl.textContent.trim();
                        }
                    }
                    return null;
                });
                if (extractedData) priceText = extractedData;
            } catch (e) {}

        } else if (source === 'COMETA') {
            url = 'https://www.cometafondo.it/andamenti/crescita/';
            await page.goto(url, { waitUntil: 'networkidle2' });

            const extractedPrice = await page.evaluate(() => {
                // Method 1: wpDataCharts JS global
                try {
                    if (typeof wpDataCharts !== 'undefined' && wpDataCharts[6]) {
                        const chart = wpDataCharts[6];
                        const series = (chart.render_data || chart).series;
                        if (series?.[0]?.data?.length > 0) {
                            const dataArray = series[0].data;
                            const lastValue = dataArray[dataArray.length - 1];
                            let val;
                            if (typeof lastValue === 'number') {
                                val = lastValue;
                            } else if (Array.isArray(lastValue)) {
                                val = lastValue[1] ?? lastValue[0];
                            } else if (typeof lastValue === 'object' && lastValue !== null) {
                                val = lastValue.y ?? lastValue.value ?? lastValue.v;
                            }
                            if (typeof val === 'number' && !isNaN(val)) return String(val);
                        }
                    }
                } catch (e) {}
                // Method 2: regex on script tag source
                try {
                    for (const script of document.scripts) {
                        const txt = script.textContent || '';
                        if (!txt.includes('wpDataCharts')) continue;
                        // Extract last decimal number before closing ] of the data array
                        const m = txt.match(/"data"\s*:\s*\[[\s\S]*?([\d]+\.[\d]+)\s*\]/);
                        if (m) return m[1];
                    }
                } catch (e) {}
                return null;
            });
            if (extractedPrice && !isNaN(parseFloat(extractedPrice))) {
                priceText = extractedPrice;
            } else {
                // Fallback: HTML table last row, QUOTA column (Italian decimal: comma)
                const fallbackPrice = await page.evaluate(() => {
                    const rows = document.querySelectorAll('table tbody tr');
                    if (rows.length === 0) return null;
                    const lastRow = rows[rows.length - 1];
                    const cells = lastRow.querySelectorAll('td');
                    return cells.length >= 2 ? cells[1].textContent.trim() : null;
                });
                if (fallbackPrice) priceText = fallbackPrice;
            }
            currency = 'EUR';

        } else {
            // ETF: try Borsa Italiana (MIL) first, fall back to JustETF (XETRA/gettex)
            try {
                await page.goto(`https://www.borsaitaliana.it/borsa/etf/scheda/${isin}.html?lang=it`, { waitUntil: 'domcontentloaded' });

                // Cookie handling (same as MOT)
                try {
                    const cookieSelectors = ['#ccc-recommended-settings', '#cookiewall-container button', '#onetrust-accept-btn-handler', '.qc-cmp2-summary-buttons button:last-child'];
                    for (const sel of cookieSelectors) {
                        if (await page.$(sel)) {
                            await page.click(sel);
                            await new Promise(r => setTimeout(r, 1000));
                            break;
                        }
                    }
                } catch (e) {}

                const priceEl = await page.$('span.-formatPrice strong');
                if (priceEl) {
                    const raw = await priceEl.evaluate(el => el.textContent.trim());
                    // Italian format: "114,65" or "1.234,56" → normalize to JS number string
                    const parsed = parseFloat(raw.replace(/\./g, '').replace(',', '.'));
                    if (!isNaN(parsed)) {
                        priceText = String(parsed);
                        fetchedFromMIL = true;
                        console.log(`[ETF] ${isin} fetched from Borsa Italiana (MIL): ${priceText}`);
                    }
                }
            } catch (e) {}

            // Fallback: JustETF (XETRA / gettex)
            if (!fetchedFromMIL) {
                console.log(`[ETF] ${isin} not on MIL, falling back to JustETF`);
                url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
                await page.goto(url, { waitUntil: 'domcontentloaded' });

                const priceSelector = '[data-testid="realtime-quotes_price-value"]';
                const currencySelector = '[data-testid="realtime-quotes_price-currency"]';

                try {
                    await page.waitForSelector(priceSelector, { timeout: 10000 });
                    priceText = await page.$eval(priceSelector, el => el.textContent?.trim());
                    currency = await page.$eval(currencySelector, el => el.textContent?.trim()).catch(() => 'EUR');
                } catch (e) {}
            }
        }

        if (!priceText) {
            throw new Error('Price element empty or not found');
        }

        // Parse Price
        let cleanPrice;
        if (source === 'ETF') {
            cleanPrice = priceText.replace(/EUR/g, '').replace(/,/g, '').trim();
        } else if (source === 'COMETA') {
            if (priceText.includes(',') && !priceText.includes('.')) {
                cleanPrice = priceText.replace(/[^\d,]/g, '').replace(/,/g, '.').trim();
            } else {
                cleanPrice = priceText.replace(/[^\d.]/g, '').trim();
            }
        } else if (source === 'MOT') {
            // Already computed as JS number string (tel quel = corso secco + rateo)
            cleanPrice = priceText;
        } else {
            cleanPrice = priceText.replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(/,/g, '.').trim();
        }

        const finalPrice = parseFloat(cleanPrice);
        if (isNaN(finalPrice)) throw new Error(`Failed to parse price: ${priceText}`);

        let { spreadPercent, volatility } = await extractSpreadAndVolatility(page, finalPrice);

        // If the price came from Borsa Italiana (MIL) and that page didn't expose
        // Denaro/Lettera/Volatilità/Spread, do a best-effort extra visit to JustETF
        // just for these supplemental fields (price/currency are kept from MIL).
        if (source === 'ETF' && fetchedFromMIL && spreadPercent === null && volatility === null) {
            try {
                await page.goto(`https://www.justetf.com/en/etf-profile.html?isin=${isin}`, { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('[data-testid="realtime-quotes_price-value"]', { timeout: 10000 });
                const extra = await extractSpreadAndVolatility(page, finalPrice);
                spreadPercent = extra.spreadPercent;
                volatility = extra.volatility;
            } catch (e) {
                // JustETF doesn't have this ISIN or layout differs — leave as null
            }
        }

        return {
            isin,
            success: true,
            data: {
                currentPrice: finalPrice,
                currency: currency,
                lastUpdated: new Date().toISOString(),
                spreadPercent,
                volatility,
                indexationCoefficient,
            },
        };
    } catch (err) {
        console.warn(`Error processing ${isin}: ${err.message}`);
        return { isin, success: false, error: err.message };
    }
}

function validateTokens(tokens) {
    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
        return 'List of tokens (ISINs) is required';
    }
    if (tokens.length > MAX_TOKENS_PER_REQUEST) {
        return `Too many tokens in one request (max ${MAX_TOKENS_PER_REQUEST}).`;
    }
    return null;
}

// --- HTTP SERVER & SOCKET.IO SETUP ---
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigin,
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('New client connected', socket.id);
    let socketRequestTimestamps = [];

    socket.on('request_price_update', async (payload) => {
        // Accept both the legacy bare-array payload and the new
        // { tokens, premiumKey } envelope.
        let tokens, premiumKey;
        if (Array.isArray(payload)) {
            tokens = payload;
            premiumKey = undefined;
        } else {
            tokens = payload?.tokens;
            premiumKey = payload?.premiumKey;
        }

        const isPremium = isValidPremiumKey(premiumKey);

        // Per-socket sliding-window rate limit applies to free tier only.
        if (!isPremium) {
            const now = Date.now();
            socketRequestTimestamps = socketRequestTimestamps.filter(t => now - t < SOCKET_RATE_WINDOW_MS);
            if (socketRequestTimestamps.length >= SOCKET_RATE_LIMIT) {
                socket.emit('price_update_error', { message: 'Too many price requests, please retry in a minute.' });
                return;
            }
            socketRequestTimestamps.push(now);
        }

        console.log(`Received socket price update request for ${tokens?.length} assets from ${socket.id} (${isPremium ? 'PREMIUM' : 'free'})`);

        const validationError = validateTokens(tokens);
        if (validationError) {
            socket.emit('price_update_error', { message: validationError });
            return;
        }

        try {
            if (isPremium) {
                // Premium: exclusive priority — one premium scrape at a time, and
                // all free scrapes are held until it finishes. No cache, no cap.
                await runExclusivePremium(() => withBrowser(async (page) => {
                    for (const token of tokens) {
                        const { isin, source = 'ETF' } = token;
                        socket.emit('price_update_progress', { isin, status: 'processing' });
                        const result = await scrapeToken(page, isin, source);
                        socket.emit('price_update_item', result);
                    }
                }));
            } else {
                // Free tier: serve cached ISINs immediately, scrape the rest under
                // the global concurrency cap and refresh the cache.
                const uncached = [];
                for (const token of tokens) {
                    const { isin, source = 'ETF' } = token;
                    socket.emit('price_update_progress', { isin, status: 'processing' });
                    // In local development, always re-scrape so changes to the
                    // scraping logic can be verified without waiting out the
                    // free-tier cache TTL.
                    const cached = isProduction ? getCached(source, isin) : null;
                    if (cached) {
                        socket.emit('price_update_item', { ...cached, cached: true });
                    } else {
                        uncached.push(token);
                    }
                }

                if (uncached.length > 0) {
                    let slotAcquired = false;
                    try {
                        // Yield to any active/pending premium before opening a browser.
                        await waitWhilePremium();
                        await acquireFreeSlot();
                        slotAcquired = true;
                        await withBrowser(async (page) => {
                            for (const token of uncached) {
                                const { isin, source = 'ETF' } = token;
                                // Park between ISINs if a premium wants the machine.
                                await waitWhilePremium();
                                beginFreeWork();
                                try {
                                    const result = await scrapeToken(page, isin, source);
                                    if (result.success && isProduction) setCached(source, isin, result);
                                    socket.emit('price_update_item', result);
                                } finally {
                                    endFreeWork();
                                }
                            }
                        });
                    } catch (slotErr) {
                        // Couldn't get a slot (server saturated): mark the uncached ISINs as failed.
                        for (const token of uncached) {
                            socket.emit('price_update_item', { isin: token.isin, success: false, error: slotErr.message });
                        }
                    } finally {
                        if (slotAcquired) releaseFreeSlot();
                    }
                }
            }

            // Finished all
            socket.emit('price_update_complete', { message: 'All requested prices processed' });

        } catch (globalError) {
            console.error('Global puppeteer error:', globalError);
            socket.emit('price_update_error', { message: 'Server error while fetching prices. Please try again.' });
        }
    });

    socket.on('request_history_update', async (payload) => {
        const tokens = payload?.tokens;
        const premiumKey = payload?.premiumKey;
        const isPremium = isValidPremiumKey(premiumKey);

        // Same per-socket sliding window as price updates: history fetches hit
        // external services too, just via fetch instead of Puppeteer.
        if (!isPremium) {
            const now = Date.now();
            socketRequestTimestamps = socketRequestTimestamps.filter(t => now - t < SOCKET_RATE_WINDOW_MS);
            if (socketRequestTimestamps.length >= SOCKET_RATE_LIMIT) {
                socket.emit('history_update_error', { message: 'Too many price requests, please retry in a minute.' });
                return;
            }
            socketRequestTimestamps.push(now);
        }

        console.log(`Received socket history request for ${tokens?.length} assets from ${socket.id} (${isPremium ? 'PREMIUM' : 'free'})`);

        const validationError = validateTokens(tokens);
        if (validationError) {
            socket.emit('history_update_error', { message: validationError });
            return;
        }

        try {
            if (isPremium) {
                await runExclusivePremium(async () => {
                    for (const token of tokens) {
                        socket.emit('history_update_progress', { isin: token.isin, status: 'processing' });
                        const result = await fetchHistoryForToken(token, { withBrowserFn: withBrowser });
                        socket.emit('history_update_item', result);
                    }
                });
            } else {
                // Serve cached histories immediately, fetch the rest under the
                // free-tier discipline (browser opened lazily, only for COMETA).
                const uncached = [];
                for (const token of tokens) {
                    const { isin, source = 'ETF', beginDate = '' } = token;
                    socket.emit('history_update_progress', { isin, status: 'processing' });
                    const cached = isProduction ? getCached(`hist:${beginDate}:${source}`, isin) : null;
                    if (cached) {
                        socket.emit('history_update_item', { ...cached, cached: true });
                    } else {
                        uncached.push(token);
                    }
                }

                if (uncached.length > 0) {
                    let slotAcquired = false;
                    try {
                        await waitWhilePremium();
                        await acquireFreeSlot();
                        slotAcquired = true;
                        for (const token of uncached) {
                            const { isin, source = 'ETF', beginDate = '' } = token;
                            await waitWhilePremium();
                            beginFreeWork();
                            try {
                                const result = await fetchHistoryForToken(token, { withBrowserFn: withBrowser });
                                if (result.success && isProduction) setCached(`hist:${beginDate}:${source}`, isin, result);
                                socket.emit('history_update_item', result);
                            } finally {
                                endFreeWork();
                            }
                        }
                    } catch (slotErr) {
                        for (const token of uncached) {
                            socket.emit('history_update_item', { isin: token.isin, success: false, error: slotErr.message });
                        }
                    } finally {
                        if (slotAcquired) releaseFreeSlot();
                    }
                }
            }

            socket.emit('history_update_complete', { message: 'All requested histories processed' });

        } catch (globalError) {
            console.error('Global history error:', globalError);
            socket.emit('history_update_error', { message: 'Server error while fetching price history. Please try again.' });
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected', socket.id);
    });
});

// --- API ROUTES ---
app.post('/api/price', priceLimiter, async (req, res) => {
    const { tokens, premiumKey } = req.body;

    const validationError = validateTokens(tokens);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    const isPremium = isValidPremiumKey(premiumKey);
    console.log(`Received bulk price request for ${tokens.length} assets (HTTP, ${isPremium ? 'PREMIUM' : 'free'})`);

    const results = [];
    try {
        if (isPremium) {
            // Premium: exclusive priority, holds all free scrapes until done.
            await runExclusivePremium(() => withBrowser(async (page) => {
                for (const token of tokens) {
                    const { isin, source = 'ETF' } = token;
                    results.push(await scrapeToken(page, isin, source));
                }
            }));
        } else {
            const uncached = [];
            for (const token of tokens) {
                const { isin, source = 'ETF' } = token;
                const cached = getCached(source, isin);
                if (cached) {
                    results.push({ ...cached, cached: true });
                } else {
                    uncached.push(token);
                }
            }

            if (uncached.length > 0) {
                let slotAcquired = false;
                try {
                    // Yield to any active/pending premium before opening a browser.
                    await waitWhilePremium();
                    await acquireFreeSlot();
                    slotAcquired = true;
                    await withBrowser(async (page) => {
                        for (const token of uncached) {
                            const { isin, source = 'ETF' } = token;
                            // Park between ISINs if a premium wants the machine.
                            await waitWhilePremium();
                            beginFreeWork();
                            try {
                                const result = await scrapeToken(page, isin, source);
                                if (result.success) setCached(source, isin, result);
                                results.push(result);
                            } finally {
                                endFreeWork();
                            }
                        }
                    });
                } catch (slotErr) {
                    return res.status(503).json({ error: slotErr.message });
                } finally {
                    if (slotAcquired) releaseFreeSlot();
                }
            }
        }
    } catch (globalError) {
        console.error('Global puppeteer error (HTTP):', globalError);
        return res.status(500).json({ error: 'Server error while fetching prices. Please try again.' });
    }
    res.json({ results });
});

app.post('/api/history', priceLimiter, async (req, res) => {
    const { tokens, premiumKey } = req.body;

    const validationError = validateTokens(tokens);
    if (validationError) {
        return res.status(400).json({ error: validationError });
    }

    const isPremium = isValidPremiumKey(premiumKey);
    console.log(`Received bulk history request for ${tokens.length} assets (HTTP, ${isPremium ? 'PREMIUM' : 'free'})`);

    const results = [];
    try {
        if (isPremium) {
            await runExclusivePremium(async () => {
                for (const token of tokens) {
                    results.push(await fetchHistoryForToken(token, { withBrowserFn: withBrowser }));
                }
            });
        } else {
            const uncached = [];
            for (const token of tokens) {
                const { isin, source = 'ETF', beginDate = '' } = token;
                const cached = getCached(`hist:${beginDate}:${source}`, isin);
                if (cached) {
                    results.push({ ...cached, cached: true });
                } else {
                    uncached.push(token);
                }
            }

            if (uncached.length > 0) {
                let slotAcquired = false;
                try {
                    await waitWhilePremium();
                    await acquireFreeSlot();
                    slotAcquired = true;
                    for (const token of uncached) {
                        const { isin, source = 'ETF', beginDate = '' } = token;
                        await waitWhilePremium();
                        beginFreeWork();
                        try {
                            const result = await fetchHistoryForToken(token, { withBrowserFn: withBrowser });
                            if (result.success) setCached(`hist:${beginDate}:${source}`, isin, result);
                            results.push(result);
                        } finally {
                            endFreeWork();
                        }
                    }
                } catch (slotErr) {
                    return res.status(503).json({ error: slotErr.message });
                } finally {
                    if (slotAcquired) releaseFreeSlot();
                }
            }
        }
    } catch (globalError) {
        console.error('Global history error (HTTP):', globalError);
        return res.status(500).json({ error: 'Server error while fetching price history. Please try again.' });
    }
    res.json({ results });
});

// --- BOND PROPOSALS ---
app.post('/api/bond-proposals', priceLimiter, async (req, res) => {
    const { targetDate, universe = 'IT', minMonthsBefore = 1, maxMonthsBefore = 6 } = req.body || {};

    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return res.status(400).json({ error: 'targetDate is required (YYYY-MM-DD)' });
    }
    if (!['IT', 'EU'].includes(universe)) {
        return res.status(400).json({ error: 'universe must be IT or EU' });
    }

    try {
        // Scrape the universe the user asked for (IT = Italian govies,
        // EU = European govies). The pages are server-rendered, so no browser.
        const allBonds = await scrapeBondMonitor(universe);

        const filtered = filterByMaturityWindow(allBonds, targetDate, minMonthsBefore, maxMonthsBefore);

        res.json({ proposals: filtered });
    } catch (err) {
        console.error('[BondProposals] Error:', err.message);
        res.status(500).json({ error: 'Failed to fetch bond proposals', proposals: [] });
    }
});

// --- FRONTEND SERVING ---
async function setupServer() {
    if (isProduction) {
        const distPath = path.resolve(__dirname, '../dist');
        app.use(express.static(distPath));
        app.get(/.*/, (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
        console.log('Running in PRODUCTION mode (serving from /dist)');
    } else {
        console.log('Running in DEVELOPMENT mode (using Vite Middleware)');
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
            root: path.resolve(__dirname, '..')
        });
        app.use(vite.middlewares);
    }

    // Use httpServer.listen instead of app.listen
    const server = httpServer.listen(port, () => {
        console.log(`Server listening at http://localhost:${port}`);
    });

    server.timeout = 600000;
    server.keepAliveTimeout = 600000;
    server.headersTimeout = 600000;
}

setupServer();
