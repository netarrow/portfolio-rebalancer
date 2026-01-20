import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Common middleware
app.use(cors());

app.use(express.json()); // Enable JSON body parsing

// --- API ROUTES ---
app.post('/api/price', async (req, res) => {
    const { tokens } = req.body; // Expecting { tokens: [{ isin, source }, ...] }

    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
        return res.status(400).json({ error: 'List of tokens (ISINs) is required' });
    }

    console.log(`Received bulk price request for ${tokens.length} assets`);

    let browser;
    const results = [];

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        // Use a single page for all requests to save resources, or new page per request?
        // New page per request is safer for isolating sessions (cookies, etc), but slower.
        // Let's try reusing one page first for speed, but reloading it. 
        // Actually, for Borsa Italiana cookie limits etc, maybe new page is safer. 
        // Given the requirement "unioca istanza di puppeter, in una unica sessione", reusing the browser is key.
        // We can reuse the page object or create new ones from the same browser. 
        // Creating new page per ISIN is fast enough and safer.
        
        // Let's process in sequence to avoid race conditions if we were to share a page, 
        // or effectively parallelize with Promise.all if we use multiple pages. 
        // For now, let's do sequential to be nice to the CPU and avoid detection spikes, 
        // but fast sequential using the same browser instance.

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');

        for (const token of tokens) {
            const { isin, source = 'ETF' } = token;
            
            // Re-validate per ISIN
            const isinRegex = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
            if (!isinRegex.test(isin)) {
                results.push({ isin, error: 'Invalid ISIN format', success: false });
                continue;
            }

            console.log(`Processing: ${isin} (${source})`);
            
            try {
                let url, priceText;
                let currency = 'EUR'; // Default

                if (source === 'MOT') {
                     url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}.html?lang=it`;
                     
                     await page.goto(url, { waitUntil: 'domcontentloaded' });
                     
                     // Cookie handling (only needed once per session technically, but safe to check)
                     try {
                        const cookieSelectors = ['#ccc-recommended-settings', '#cookiewall-container button', '#onetrust-accept-btn-handler', '.qc-cmp2-summary-buttons button:last-child'];
                        for (const sel of cookieSelectors) {
                            if (await page.$(sel)) {
                                await page.click(sel);
                                await new Promise(r => setTimeout(r, 1000)); // Short wait
                                break;
                            }
                        }
                     } catch (e) {}
                     
                     const priceSelector = 'span.-formatPrice strong';
                     try {
                        await page.waitForSelector(priceSelector, { timeout: 10000 }); // Shorter timeout for bulk
                        priceText = await page.$eval(priceSelector, el => el.textContent.trim());
                     } catch(e) {
                         // warning handled below
                     }

                } else if (source === 'CPRAM') {
                     url = `https://cpram.com/ita/it/privati/products/${isin}`;
                     await page.goto(url, { waitUntil: 'domcontentloaded' });

                     // Splash/Cookie handling
                     // ... compacted for bulk ...
                     // (Leaving simplified logic here assuming session cookies persist if we reused page, 
                     // but CPRAM might be tricky. Let's re-run simplified clickers)
                     
                     try {
                        // Accetto tutto
                        const btns = await page.$$('button, a');
                        for(const b of btns) {
                            const t = await b.evaluate(el => el.textContent);
                            if(t && (t.includes('Sì, accetto') || t.includes('Accettare tutto'))) {
                                await b.click();
                                await new Promise(r => setTimeout(r, 1000));
                            }
                        }
                     } catch(e) {}

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

                } else {
                     // JustETF
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

                if (!priceText) {
                    throw new Error('Price element empty or not found');
                }

                // Parse Price
                let cleanPrice;
                if (source === 'ETF') {
                    // JustETF English format usually
                    cleanPrice = priceText.replace(/EUR/g, '').replace(/,/g, '').trim(); 
                } else {
                    // Italian format
                    cleanPrice = priceText
                    .replace(/[^\d.,-]/g, '')
                    .replace(/\./g, '')
                    .replace(/,/g, '.')
                    .trim();
                }
                
                const finalPrice = parseFloat(cleanPrice);
                
                if (isNaN(finalPrice)) throw new Error(`Failed to parse price: ${priceText}`);

                results.push({
                    isin,
                    success: true,
                    data: {
                        currentPrice: finalPrice,
                        currency: currency,
                        lastUpdated: new Date().toISOString()
                    }
                });

            } catch (err) {
                console.warn(`Error processing ${isin}: ${err.message}`);
                results.push({
                    isin,
                    success: false,
                    error: err.message
                });
            }
        }
        
    } catch (globalError) {
        console.error('Global puppeteer error:', globalError);
        return res.status(500).json({ error: 'Major server error', details: globalError.message });
    } finally {
        if (browser) await browser.close();
    }

    // Return all results (successes and failures)
    res.json({ results });
});

// --- FRONTEND SERVING ---
async function setupServer() {
    if (isProduction) {
        // Production: Serve static files from 'dist'
        // Assuming 'dist' is in the project root found by resizing relative path
        const distPath = path.resolve(__dirname, '../dist');
        app.use(express.static(distPath));
        
        // SPA Fallback
        // SPA Fallback
        app.get(/.*/, (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
        console.log('Running in PRODUCTION mode (serving from /dist)');
    } else {
        // Development: Use Vite Middleware
        console.log('Running in DEVELOPMENT mode (using Vite Middleware)');
        const { createServer: createViteServer } = await import('vite');
        
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa', // serve index.html for unknown routes
            root: path.resolve(__dirname, '..') // Project root
        });

        // Use vite's connect instance as middleware
        app.use(vite.middlewares);
    }

    app.listen(port, () => {
        console.log(`Server listening at http://localhost:${port}`);
    });
}

setupServer();
