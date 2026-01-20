import axios from 'axios';

interface MarketData {
    currentPrice: number;
    currency: string;
    lastUpdated: string;
}

export interface PriceRequestToken {
    isin: string;
    source: 'ETF' | 'MOT' | 'CPRAM';
}

export interface PriceResult {
    isin: string;
    success: boolean;
    data?: MarketData;
    error?: string;
}

export const fetchAssetPrices = async (tokens: PriceRequestToken[]): Promise<PriceResult[]> => {
    try {
        const response = await axios.post('/api/price', { tokens });
        return response.data.results;
    } catch (error: any) {
        console.error('Error fetching bulk prices:', error);
        // If the whole request fails, try to return useful error structures or throw
        throw error;
    }
};
