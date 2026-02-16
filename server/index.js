import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Common middleware
const allowedOrigin = process.env.cors_domain || /^http:\/\/localhost(:\d+)?$/;
app.use(cors({ origin: allowedOrigin }));

app.use(express.json()); // Enable JSON body parsing

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

    socket.on('request_price_update', async (tokens) => {
        console.log(`Received socket price update request for ${tokens?.length} assets from ${socket.id}`);
        
        if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
            socket.emit('price_update_error', { message: 'List of tokens (ISINs) is required' });
            return;
        }

        let browser;
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });

            const page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');

            for (const token of tokens) {
                const { isin, source = 'ETF' } = token;

                // Notify client we are starting this ISIN
                socket.emit('price_update_progress', { isin, status: 'processing' });

                // Re-validate per ISIN
                const isinRegex = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
                if (!isinRegex.test(isin)) {
                    socket.emit('price_update_item', { isin, error: 'Invalid ISIN format', success: false });
                    continue;
                }

                console.log(`Processing: ${isin} (${source})`);
                
                try {
                    let url, priceText;
                    let currency = 'EUR'; // Default

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
                            priceText = await page.$eval(priceSelector, el => el.textContent.trim());
                         } catch(e) {}

                    } else if (source === 'CPRAM') {
                         url = `https://cpram.com/ita/it/privati/products/${isin}`;
                         await page.goto(url, { waitUntil: 'domcontentloaded' });

                         try {
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
                        cleanPrice = priceText.replace(/EUR/g, '').replace(/,/g, '').trim(); 
                    } else {
                        cleanPrice = priceText.replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(/,/g, '.').trim();
                    }
                    
                    const finalPrice = parseFloat(cleanPrice);
                    if (isNaN(finalPrice)) throw new Error(`Failed to parse price: ${priceText}`);

                    const result = {
                        isin,
                        success: true,
                        data: {
                            currentPrice: finalPrice,
                            currency: currency,
                            lastUpdated: new Date().toISOString()
                        }
                    };
                    
                    // Emit success for this ISIN
                    socket.emit('price_update_item', result);

                } catch (err) {
                    console.warn(`Error processing ${isin}: ${err.message}`);
                    socket.emit('price_update_item', {
                        isin,
                        success: false,
                        error: err.message
                    });
                }
            }
            
            // Finished all
            socket.emit('price_update_complete', { message: 'All requested prices processed' });

        } catch (globalError) {
            console.error('Global puppeteer error:', globalError);
            socket.emit('price_update_error', { message: 'Major server error', details: globalError.message });
        } finally {
            if (browser) await browser.close();
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected', socket.id);
    });
});

// --- API ROUTES ---
app.post('/api/price', async (req, res) => {
    // Keep existing API for backward compatibility or direct calls if needed
    // Logic duplicated for now, or could call a shared function. 
    // Given the task is to switch to Websocket, we can leave this as a fallback 
    // or eventually deprecate it. The user asked for the update flow to be modified.
    // For SAFETY, I will keep the original implementation here (abbreviated in thought, but full in code)
    // Actually, to avoid huge code duplication, I should probably extract the logic.
    // However, for this specific task, I'll just keep the existing handler as is 
    // (copy-pasted from original read) so standard HTTP calls still work if any.
    
    const { tokens } = req.body; 

    if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
        return res.status(400).json({ error: 'List of tokens (ISINs) is required' });
    }

    // ... (Existing logic logic reused or kept) ...
    // Since I'm replacing the file, I must provide the full content.
    // I'll paste the original logic back here for safety.
    
    console.log(`Received bulk price request for ${tokens.length} assets (HTTP)`);
    let browser;
    const results = [];
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');

        for (const token of tokens) {
            const { isin, source = 'ETF' } = token;
            const isinRegex = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
            if (!isinRegex.test(isin)) { results.push({ isin, error: 'Invalid ISIN format', success: false }); continue; }
            
            try {
                let url, priceText, currency = 'EUR';
                if (source === 'MOT') {
                     url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}.html?lang=it`;
                     await page.goto(url, { waitUntil: 'domcontentloaded' });
                     try {
                        const cookieSelectors = ['#ccc-recommended-settings', '#cookiewall-container button', '#onetrust-accept-btn-handler', '.qc-cmp2-summary-buttons button:last-child'];
                        for (const sel of cookieSelectors) {
                            if (await page.$(sel)) { await page.click(sel); await new Promise(r => setTimeout(r, 1000)); break; }
                        }
                     } catch (e) {}
                     const priceSelector = 'span.-formatPrice strong';
                     await page.waitForSelector(priceSelector, { timeout: 10000 });
                     priceText = await page.$eval(priceSelector, el => el.textContent.trim());
                } else if (source === 'CPRAM') {
                     url = `https://cpram.com/ita/it/privati/products/${isin}`;
                     await page.goto(url, { waitUntil: 'domcontentloaded' });
                     try {
                        const btns = await page.$$('button, a');
                        for(const b of btns) {
                            const t = await b.evaluate(el => el.textContent);
                            if(t && (t.includes('Sì, accetto') || t.includes('Accettare tutto'))) { await b.click(); await new Promise(r => setTimeout(r, 1000)); }
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
                     url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
                     await page.goto(url, { waitUntil: 'domcontentloaded' });
                     const priceSelector = '[data-testid="realtime-quotes_price-value"]';
                     const currencySelector = '[data-testid="realtime-quotes_price-currency"]';
                     await page.waitForSelector(priceSelector, { timeout: 10000 });
                     priceText = await page.$eval(priceSelector, el => el.textContent?.trim());
                     currency = await page.$eval(currencySelector, el => el.textContent?.trim()).catch(() => 'EUR');
                }

                if (!priceText) throw new Error('Price element empty');
                let cleanPrice;
                if (source === 'ETF') cleanPrice = priceText.replace(/EUR/g, '').replace(/,/g, '').trim(); 
                else cleanPrice = priceText.replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(/,/g, '.').trim();
                const finalPrice = parseFloat(cleanPrice);
                if (isNaN(finalPrice)) throw new Error(`Failed to parse: ${priceText}`);

                results.push({ isin, success: true, data: { currentPrice: finalPrice, currency: currency, lastUpdated: new Date().toISOString() } });
            } catch (err) {
                results.push({ isin, success: false, error: err.message });
            }
        }
    } catch (globalError) {
        return res.status(500).json({ error: 'Major server error', details: globalError.message });
    } finally {
        if (browser) await browser.close();
    }
    res.json({ results });
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
