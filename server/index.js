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

// --- API ROUTES ---
app.get('/api/price', async (req, res) => {
    const { isin, source = 'ETF' } = req.query;

    if (!isin || typeof isin !== 'string') {
        return res.status(400).json({ error: 'ISIN is required' });
    }

    // ISIN Validation: 2 uppercase letters + 9 alphanumeric + 1 check digit
    const isinRegex = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
    if (!isinRegex.test(isin)) {
        return res.status(400).json({ error: 'Invalid ISIN format' });
    }

    console.log(`Fetching price for ISIN: ${isin} from ${source}`);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');

        let url, priceSelector, currencySelector, priceText;

        if (source === 'MOT') {
             url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}.html?lang=it`;
             
             // Cookie popup handling for Borsa Italiana - robust check
             await page.goto(url, { waitUntil: 'domcontentloaded' });
             
             try {
                const cookieSelectors = ['#ccc-recommended-settings', '#cookiewall-container button', '#onetrust-accept-btn-handler', '.qc-cmp2-summary-buttons button:last-child'];
                for (const sel of cookieSelectors) {
                    if (await page.$(sel)) {
                        console.log(`MOT: Clicking cookie banner: ${sel}`);
                        await page.click(sel);
                        await new Promise(r => setTimeout(r, 1000));
                        break;
                    }
                }
             } catch (e) {
                // Ignore
             }
             
             // Robust selector: span.-formatPrice strong (removed color dependency)
             priceSelector = 'span.-formatPrice strong';
             
             try {
                await page.waitForSelector(priceSelector, { timeout: 10000 });
                // CRITICAL FIX: Actually extract the price!
                priceText = await page.$eval(priceSelector, el => el.textContent.trim());
             } catch(e) {
                 console.warn('MOT: Timeout waiting for price selector or extraction failed', e.message);
                 await page.screenshot({ path: 'debug_mot_error.png' });
             }

             // Currency is usually implied as EUR for BTP on MOT
             currencySelector = null; 
        } else if (source === 'CPRAM') {
             url = `https://cpram.com/ita/it/privati/products/${isin}`;
             await page.goto(url, { waitUntil: 'domcontentloaded' });

             // Handle Splash Screen: Click "Sì, accetto e continuo"
             try {
                // Look for button with specific text
                 const splashButton = await page.waitForFunction(
                     () => {
                         const buttons = Array.from(document.querySelectorAll('button, a'));
                         return buttons.find(b => b.textContent.includes('Sì, accetto e continuo'));
                     },
                     { timeout: 5000 }
                 );
                 if (splashButton) {
                     await splashButton.click();
                     // Wait for splash to disappear or next content to load
                     await new Promise(r => setTimeout(r, 3000));
                 }
             } catch (e) {
                 console.log('CPRAM Splash screen not found or timed out', e.message);
             }

             // Handle Cookie Banner: Click "Accettare tutto"
             try {
                 const cookieButton = await page.waitForFunction(
                     () => {
                         const buttons = Array.from(document.querySelectorAll('button, a'));
                         return buttons.find(b => b.textContent.includes('Accettare tutto'));
                     },
                     { timeout: 3000 }
                 );
                 if (cookieButton) {
                     await cookieButton.click();
                     await new Promise(r => setTimeout(r, 1000));
                 }
             } catch (e) {
                  // Ignore if cookie banner not found
             }

             // Robust selector for price: Look for 'Valore dalla quota' label and find associated value
             priceSelector = null;
             
             try {
                // Wait for the data to be rendered
                await page.waitForSelector('.headline-4', { timeout: 15000 });
             } catch (e) {
                 console.warn('CPRAM: Timeout waiting for .headline-4 elements.');
             }
             
             const extractedData = await page.evaluate(() => {
                // Find all summary blocks (they incorrectly share id="list-item")
                const items = document.querySelectorAll('#list-item');
                
                for (const item of items) {
                    // Check if this block contains our target label
                    if (item.textContent.includes('Valore dalla quota')) {
                        // The price is in the class 'headline-4' within this block
                        const valueEl = item.querySelector('.headline-4');
                        if (valueEl) {
                            return valueEl.textContent.trim();
                        }
                    }
                }
                return null;
             });

             if (extractedData) {
                 console.log(`CPRAM Raw Price: ${extractedData}`);
                 // Store properly to be picked up below
                 priceText = extractedData;
             } else {
                 console.warn('CPRAM: Could not extract value via label search. Returning null price.');
             }

        } else {
             // Default JustETF
             url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
             await page.goto(url, { waitUntil: 'domcontentloaded' });
             
             priceSelector = '[data-testid="realtime-quotes_price-value"]';
             currencySelector = '[data-testid="realtime-quotes_price-currency"]';
             
             // For JustETF, we use standard selector waiting
             try {
                await page.waitForSelector(priceSelector, { timeout: 10000 });
                priceText = await page.$eval(priceSelector, el => el.textContent?.trim());
             } catch (e) {
                 console.warn(`JustETF: Could not find price selector for ${isin}`);
             }
        }

        let currency = 'EUR';
        
        if (currencySelector) {
            currency = await page.$eval(currencySelector, el => el.textContent?.trim()).catch(() => 'EUR');
        } else if (source === 'CPRAM' && priceText) {
             if (priceText.includes('€')) currency = 'EUR';
             else if (priceText.includes('$')) currency = 'USD';
             // etc.
        }

        console.log(`Found price: ${priceText} ${currency}`);

        if (!priceText) {
             if (source === 'CPRAM') {
                 console.warn(`CPRAM: Price not found for ${isin}. Returning null.`);
                 return res.json({
                     currentPrice: null,
                     currency: currency,
                     lastUpdated: new Date().toISOString()
                 });
             }
             throw new Error('Price element empty');
        }

        let cleanPrice = priceText
            .replace(/EUR/g, '')
            .replace(/€/g, '')
            .replace(/\./g, '')  // Remove thousands separator (dots)
            .replace(/,/g, '.')  // Replace decimal separator (comma) with dot
            .trim();

        // Special handling for JustETF format if needed (usually just comma/dot swap for European format)
        // Check if the original source was JustETF which might use different formatting?
        // JustETF usually: "123.45" or "123,45". The replace logic above assumes European "1.234,56" -> "1234.56"
        // Let's be careful.
        // JustETF (English) typically uses "." for decimal. 
        // CPRAM (Italian) uses "." for thousands and "," for decimal.
        
        if (source === 'ETF') {
            // JustETF English: "123.45 EUR" or "1,234.56"
            // If it has commas as thousands separators, remove them.
            // If it has dots as decimal, keep them.
            cleanPrice = priceText.replace(/EUR/g, '').replace(/,/g, '').trim(); 
        } else {
            // MOT and CPRAM (Italian/European format): "1.234,56"
            cleanPrice = priceText
            .replace(/[^\d.,-]/g, '') // Remove currency symbols and text
            .replace(/\./g, '')       // Remove thousands dots
            .replace(/,/g, '.')       // Convert decimal comma to dot
            .trim();
        }
        const price = parseFloat(cleanPrice);

        res.json({
            currentPrice: price,
            currency: currency,
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error(`Error fetching price for ${isin}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch price', details: error.message });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
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
