import axios from 'axios';
import type { PriceSource } from '../types';

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
    source: PriceSource;
}

export interface PriceResult {
    isin: string;
    success: boolean;
    data?: MarketData;
    error?: string;
}

export const fetchAssetPrices = async (tokens: PriceRequestToken[], privateKey?: string): Promise<PriceResult[]> => {
    try {
        const response = await axios.post('/api/price', { tokens, privateKey: privateKey?.trim() || undefined });
        return response.data.results;
    } catch (error: any) {
        console.error('Error fetching bulk prices:', error);
        // If the whole request fails, try to return useful error structures or throw
        throw error;
    }
};

export interface HistoryRequestToken extends PriceRequestToken {
    beginDate?: string; // 'YYYY-MM-DD'; server defaults to one year ago
}

export interface HistoryResult {
    isin: string;
    success: boolean;
    data?: {
        points: { date: string; price: number }[];
        granularity: 'D' | 'M';
        priceBasis?: 'clean' | 'dirty';
        currency?: string;
        lastUpdated: string;
    };
    error?: string;
    cached?: boolean;
}

/** HTTP (non-socket) targeted history fetch — used for on-demand PAC price backfill. */
export const fetchAssetHistory = async (tokens: HistoryRequestToken[], privateKey?: string): Promise<HistoryResult[]> => {
    try {
        const response = await axios.post('/api/history', { tokens, privateKey: privateKey?.trim() || undefined });
        return response.data.results;
    } catch (error: any) {
        console.error('Error fetching bulk history:', error);
        throw error;
    }
};
