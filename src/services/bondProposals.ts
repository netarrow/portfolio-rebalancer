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
