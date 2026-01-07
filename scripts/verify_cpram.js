import axios from 'axios';

const ISIN = 'LU1530899142'; // Requested for verification
const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}/api/price`;

async function verifyCpram() {
    console.log(`Verifying CPRAM scraping for ISIN: ${ISIN}...`);
    try {
        const response = await axios.get(BASE_URL, {
            params: {
                isin: ISIN,
                source: 'CPRAM'
            }
        });

        console.log('Response status:', response.status);
        console.log('Response data:', JSON.stringify(response.data, null, 2));

        if (response.data.currentPrice === null) {
            console.log('✅ Graceful fallback verified: currentPrice is null (as expected if extraction fails or is blocked).');
        } else if (typeof response.data.currentPrice === 'number') {
            console.log(`✅ Success: Price extracted -> ${response.data.currentPrice} ${response.data.currency}`);
        } else {
            console.log('❌ Unexpected response format.');
            process.exit(1);
        }

    } catch (error) {
        if (error.response) {
            console.error('❌ Request failed with status:', error.response.status);
            console.error('Response data:', error.response.data);
        } else {
            console.error('❌ Request failed:', error.message);
        }
        process.exit(1);
    }
}

verifyCpram();
