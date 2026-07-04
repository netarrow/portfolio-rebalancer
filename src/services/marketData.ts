import axios from 'axios';

interface MarketData {
    currentPrice: number;
    currency: string;
    lastUpdated: string;
    // Optional supplemental data — present only when the scraped page exposes it.
    spreadPercent?: number | null;
    volatility?: number | null;
    // Inflation-linked bonds only: principal revaluation coefficient already
    // folded into currentPrice.
    indexationCoefficient?: number | null;
}

export interface PriceRequestToken {
    isin: string;
    source: 'ETF' | 'MOT' | 'CPRAM' | 'COMETA';
}

export interface PriceResult {
    isin: string;
    success: boolean;
    data?: MarketData;
    error?: string;
}

export const fetchAssetPrices = async (tokens: PriceRequestToken[], premiumKey?: string): Promise<PriceResult[]> => {
    try {
        const response = await axios.post('/api/price', { tokens, premiumKey: premiumKey?.trim() || undefined });
        return response.data.results;
    } catch (error: any) {
        console.error('Error fetching bulk prices:', error);
        // If the whole request fails, try to return useful error structures or throw
        throw error;
    }
};
