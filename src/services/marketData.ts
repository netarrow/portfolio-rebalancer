import axios from 'axios';

interface MarketData {
    currentPrice: number;
    currency: string;
    lastUpdated: string;
}

export const fetchAssetPrice = async (isin: string, source: 'ETF' | 'MOT' | 'CPRAM' = 'ETF'): Promise<MarketData | null> => {
    try {
        // Call our local API (relative path)
        const response = await axios.get(`/api/price?isin=${isin}&source=${source}`);
        return response.data;
    } catch (error) {
        console.error(`Error fetching price for ${isin}:`, error);
        return null;
    }
};
