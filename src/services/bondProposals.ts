import axios from 'axios';
import type { BondProposal, BondUniverse } from '../types';

export interface BondProposalRequest {
    targetDate: string;
    universe: BondUniverse;
    minMonthsBefore?: number;
    maxMonthsBefore?: number;
}

export interface BondProposalResponse {
    proposals: BondProposal[];
    error?: string;
}

export const fetchBondProposals = async (request: BondProposalRequest): Promise<BondProposal[]> => {
    try {
        const response = await axios.post<BondProposalResponse>('/api/bond-proposals', request);
        return response.data.proposals || [];
    } catch (error: any) {
        console.error('Error fetching bond proposals:', error);
        return [];
    }
};

/** Maturity dates of bonds by ISIN, from the bond monitors; unknown ISINs are left out. */
export const fetchBondMaturities = async (isins: string[]): Promise<Record<string, string>> => {
    try {
        const response = await axios.post<{ maturities: Record<string, string> }>('/api/bond-maturities', { isins });
        return response.data.maturities || {};
    } catch (error) {
        console.error('Error fetching bond maturities:', error);
        return {};
    }
};
