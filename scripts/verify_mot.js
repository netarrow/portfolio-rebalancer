import axios from 'axios';

// BTP Italia (inflation-linked): must expose an indexation coefficient.
const ISIN = process.argv[2] || 'IT0005532723';
const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}/api/price`;

async function verifyMot() {
    console.log(`Verifying MOT scraping for ISIN: ${ISIN}...`);
    try {
        const response = await axios.post(BASE_URL, {
            tokens: [{ isin: ISIN, source: 'MOT' }],
        });

        console.log('Response status:', response.status);
        const result = response.data.results?.[0];
        console.log('Result:', JSON.stringify(result, null, 2));

        if (!result?.success) {
            console.log('❌ Scrape failed:', result?.error);
            return;
        }

        const { currentPrice, currency, indexationCoefficient } = result.data;
        if (typeof currentPrice === 'number') {
            console.log(`✅ Price extracted -> ${currentPrice} ${currency} (tel quel, incl. accrued interest)`);
        } else {
            console.log('❌ Unexpected price format.');
            return;
        }

        if (indexationCoefficient != null) {
            console.log(`✅ Indexation coefficient extracted -> ${indexationCoefficient}`);
            console.log('   Price = (clean price + accrued) × coefficient. Cross-check the');
            console.log('   controvalore on the Borsa Italiana page for this bond.');
        } else {
            console.log('⚠️ No indexation coefficient. Expected for plain bonds; for an');
            console.log('   inflation-linked bond (BTP Italia / BTP€i) this means extraction failed.');
        }
    } catch (error) {
        if (error.response) {
            console.error('❌ Request failed with status:', error.response.status);
            console.error('Response data:', error.response.data);
        } else {
            console.error('❌ Request failed:', error.message);
        }
    }
}

verifyMot();
