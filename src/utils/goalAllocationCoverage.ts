import type { AssetDefinition, Portfolio, Transaction, VirtualBond, YnabGoal, YnabGoalAllocation } from '../types';
import { isVirtualBondTicker } from '../types';
import { calculateAssets } from './portfolioCalculations';
import { resolveGroups } from './allocationGroups';
import { resolveAmountTargets } from './amountTargets';

type MarketData = Record<string, { price: number; lastUpdated: string }>;

/**
 * What each allocation pinned to a row of a goal-matching (amount-mode)
 * portfolio actually covers today.
 *
 * Such an allocation is a target, not money set aside: it covers its share of
 * what the row holds, the row's goals being funded pro rata. Allocations not
 * in the map cover their own amount.
 */
export function pinnedAllocationCoverage(input: {
    portfolios: Portfolio[];
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: MarketData;
    allocations: YnabGoalAllocation[];
    goals: YnabGoal[];
    virtualBonds: VirtualBond[];
}): Map<string, number> {
    const { portfolios, transactions, assetSettings, marketData, allocations, goals, virtualBonds } = input;
    const out = new Map<string, number>();
    portfolios.filter(p => p.targetMode === 'amount').forEach(p => {
        const { assets } = calculateAssets(transactions.filter(t => t.portfolioId === p.id), assetSettings, marketData);
        const { groupById } = resolveGroups(p);
        const valueOf = (key: string) => {
            const tickers = groupById[key]?.members ?? [key];
            return tickers.reduce((s, t) => s + (assets.find(a =>
                isVirtualBondTicker(t) ? a.ticker === t : a.ticker.toUpperCase() === t.toUpperCase())?.currentValue || 0), 0);
        };
        resolveAmountTargets(p, allocations, goals, virtualBonds).forEach(row => {
            const ratio = row.target > 0 ? Math.min(1, valueOf(row.key) / row.target) : 0;
            row.goals.forEach(g => out.set(g.allocationId, g.amount * ratio));
        });
    });
    return out;
}
