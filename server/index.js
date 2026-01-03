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

    console.log(`Fetching price for ISIN: ${isin} from ${source}`);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        let url, priceSelector, currencySelector;

        if (source === 'MOT') {
             url = `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}.html?lang=it`;
             
             // Cookie popup handling for Borsa Italiana
             await page.goto(url, { waitUntil: 'domcontentloaded' });
             
             try {
                const cookieSelector = '#ccc-recommended-settings';
                await page.waitForSelector(cookieSelector, { timeout: 3000 });
                await page.click(cookieSelector);
             } catch (e) {
                // Ignore if cookie banner not found
             }
             
             priceSelector = '.t-text.-black-warm-60.-formatPrice strong';
             // Currency is usually implied as EUR for BTP on MOT, but let's default or inspect if robust
             currencySelector = null; // Will default to EUR
        } else {
             // Default JustETF
             url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
             await page.goto(url, { waitUntil: 'domcontentloaded' });
             
             priceSelector = '[data-testid="realtime-quotes_price-value"]';
             currencySelector = '[data-testid="realtime-quotes_price-currency"]';
        }

        await page.waitForSelector(priceSelector, { timeout: 10000 });

        const priceText = await page.$eval(priceSelector, el => el.textContent?.trim());
        let currency = 'EUR';
        
        if (currencySelector) {
            currency = await page.$eval(currencySelector, el => el.textContent?.trim()).catch(() => 'EUR');
        }

        console.log(`Found price: ${priceText} ${currency}`);

        if (!priceText) {
             throw new Error('Price element empty');
        }

        const cleanPrice = priceText.replace(/,/g, '.');
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
