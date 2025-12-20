import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';

const app = express();
const port = 3001;

app.use(cors());

app.get('/api/price', async (req, res) => {
    const { isin } = req.query;

    if (!isin || typeof isin !== 'string') {
        return res.status(400).json({ error: 'ISIN is required' });
    }

    console.log(`Fetching price for ISIN: ${isin}`);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new', // Use new headless mode
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // Set a realistic User-Agent
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });

        // Selector from our manual verification
        const priceSelector = '[data-testid="realtime-quotes_price-value"]';
        const currencySelector = '[data-testid="realtime-quotes_price-currency"]';

        // Wait for the price element to appear (timeout 10s)
        await page.waitForSelector(priceSelector, { timeout: 10000 });

        const priceText = await page.$eval(priceSelector, el => el.textContent?.trim());
        const currency = await page.$eval(currencySelector, el => el.textContent?.trim()).catch(() => 'EUR');

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

app.listen(port, () => {
    console.log(`Proxy server listening at http://localhost:${port}`);
});
