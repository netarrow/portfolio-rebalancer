import axios from 'axios';

interface MarketData {
    currentPrice: number;
    currency: string;
    lastUpdated: string;
}

export const fetchAssetPrice = async (isin: string): Promise<MarketData | null> => {
    try {
        // Call our local Node.js proxy
        const response = await axios.get(`http://localhost:3001/api/price?isin=${isin}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching price for ${isin}:`, error);
        return null;
    }
};
