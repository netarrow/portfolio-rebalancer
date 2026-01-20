import axios from 'axios';

async function testBulkPrice() {
    const tokens = [
        { isin: 'IE00B4L5Y983', source: 'ETF' }, // iShares Core MSCI World
        { isin: 'LU0290358497', source: 'ETF' }, // XEON
        { isin: 'INVALID123', source: 'ETF' }   // Expected to fail
    ];

    console.log('Testing Bulk Price API...');
    try {
        const response = await axios.post('http://localhost:3001/api/price', { tokens });
        console.log('Response Status:', response.status);
        console.log('Response Data:', JSON.stringify(response.data, null, 2));
        
        const results = response.data.results;
        if (results.length === 3) {
            console.log('SUCCESS: Received correct number of results');
        } else {
            console.error('FAILURE: Incorrect number of results');
        }

        const valid = results.find(r => r.isin === 'IE00B4L5Y983');
        if (valid && valid.success && valid.data.currentPrice > 0) {
            console.log('SUCCESS: Valid ISIN fetched correctly');
        } else {
             console.error('FAILURE: Valid ISIN failed', valid);
        }

        const invalid = results.find(r => r.isin === 'INVALID123');
        if (invalid && !invalid.success) {
            console.log('SUCCESS: Invalid ISIN failed validation as expected');
        } else {
            console.error('FAILURE: Invalid ISIN should have failed', invalid);
        }

    } catch (error) {
        console.error('API Call Failed:', error.message);
        if (error.code) console.error('Error Code:', error.code);
        if (error.response) {
             console.error('Server Response Status:', error.response.status);
             console.error('Server Response Data:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

testBulkPrice();
