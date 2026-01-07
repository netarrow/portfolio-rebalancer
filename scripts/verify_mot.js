import axios from 'axios';

const ISIN = 'IT0005532723'; // Reported failing on MOT
const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}/api/price`;

async function verifyMot() {
    console.log(`Verifying MOT scraping for ISIN: ${ISIN}...`);
    try {
        const response = await axios.get(BASE_URL, {
            params: {
                isin: ISIN,
                source: 'MOT'
            }
        });

        console.log('Response status:', response.status);
        console.log('Response data:', JSON.stringify(response.data, null, 2));

        if (response.data.currentPrice === null) {
            console.log('⚠️ Price is null. Extraction failed gracefully.');
        } else if (typeof response.data.currentPrice === 'number') {
            console.log(`✅ Success: Price extracted -> ${response.data.currentPrice} ${response.data.currency}`);
        } else {
            console.log('❌ Unexpected response format.');
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
