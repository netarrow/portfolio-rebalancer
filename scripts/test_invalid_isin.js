import axios from 'axios';

const INVALID_ISIN = 'INVALID123';
const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}/api/price`;

async function verifyInvalidIsin() {
    console.log(`Testing invalid ISIN rejection for: ${INVALID_ISIN}...`);
    try {
        await axios.get(BASE_URL, {
            params: {
                isin: INVALID_ISIN,
                source: 'ETF'
            }
        });
        console.error('❌ Failed: Server accepted invalid ISIN (Expected 400 Bad Request)');
        process.exit(1);
    } catch (error) {
        if (error.response && error.response.status === 400) {
            console.log('✅ Success: Server rejected invalid ISIN with 400 Bad Request');
            console.log('Error details:', error.response.data);
        } else {
            console.error('❌ Failed: Unexpected error or status code');
            if (error.response) {
                console.error(`Status: ${error.response.status}`);
                console.error('Data:', error.response.data);
            } else {
                console.error(error.message);
            }
            process.exit(1);
        }
    }
}

verifyInvalidIsin();
