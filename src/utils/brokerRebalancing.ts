// Pure logic for the Dashboard "By Broker" rebalancing mode.
// Targets are the CURRENT weights of the holdings at a broker: adding
// investable liquidity buys proportionally to the existing composition,
// whole shares only (largest-remainder), never selling.
// No React imports — bundled standalone by scripts/verify-broker-rebalance.ts.
import type { Asset, Transaction } from '../types';
import { CASH_TICKER_PREFIX } from '../types';
import { largestRemainderBuyOnly, type BuyOnlyCandidate } from './allocationGroups';

export interface BrokerBuyLine {
    ticker: string;
    currentWeight: number;   // 0-100, over the broker's non-cash holdings
    eur: number;             // whole-share cost assigned to this ticker
    shares: number;
    projectedWeight: number; // after the buy, over (currentTotal + totalSpent)
}

export interface BrokerBuyPlan {
    lines: BrokerBuyLine[];
    totalSpent: number;
    leftover: number; // liquidity - totalSpent (stays cash)
}

/**
 * Buy plan that preserves the broker's current composition: each held asset's
 * current weight acts as its target. Only assets with a positive quantity and
 * a known price can receive buys; priceless holdings still count in the weight
 * denominator so weights reflect the real composition.
 */
export const buildBrokerBuyPlan = (assets: Asset[], liquidity: number): BrokerBuyPlan => {
    const held = assets.filter(a =>
        !a.ticker.startsWith(CASH_TICKER_PREFIX) &&
        a.quantity > 0.000001 &&
        a.currentValue > 0
    );
    const totalValue = held.reduce((s, a) => s + a.currentValue, 0);
    if (totalValue <= 0 || liquidity <= 0) {
        return { lines: [], totalSpent: 0, leftover: Math.max(liquidity, 0) };
    }

    const candidates: BuyOnlyCandidate[] = held
        .filter(a => (a.currentPrice ?? 0) > 0)
        .map(a => ({
            key: a.ticker,
            gap: liquidity * (a.currentValue / totalValue),
            price: a.currentPrice as number,
        }));
    const byTicker = largestRemainderBuyOnly(candidates, liquidity);
    const totalSpent = Object.values(byTicker).reduce((s, v) => s + v, 0);

    // Leftover stays cash and is excluded from the projected denominator,
    // consistent with weights being computed over invested value only.
    const projectedTotal = totalValue + totalSpent;
    const lines: BrokerBuyLine[] = held.map(a => {
        const eur = byTicker[a.ticker] ?? 0;
        const price = a.currentPrice ?? 0;
        return {
            ticker: a.ticker,
            currentWeight: (a.currentValue / totalValue) * 100,
            eur,
            shares: price > 0 ? Math.round(eur / price) : 0,
            projectedWeight: projectedTotal > 0 ? ((a.currentValue + eur) / projectedTotal) * 100 : 0,
        };
    });

    return { lines, totalSpent, leftover: liquidity - totalSpent };
};

/** Group transactions by brokerId; key '' collects legacy ones with no broker. */
export const groupTransactionsByBroker = (txs: Transaction[]): Map<string, Transaction[]> => {
    const map = new Map<string, Transaction[]>();
    txs.forEach(tx => {
        const key = tx.brokerId ?? '';
        const list = map.get(key);
        if (list) list.push(tx); else map.set(key, [tx]);
    });
    return map;
};

/**
 * Portfolio to attribute a broker-mode buy to: the one holding the largest
 * remaining quantity of the ticker at this broker (Buy − Sell replay);
 * ties broken by most recent transaction date.
 */
export const assignPortfolioForBuy = (
    ticker: string,
    brokerTxs: Transaction[]
): string | undefined => {
    const upper = ticker.toUpperCase();
    const byPortfolio = new Map<string, { qty: number; lastDate: string }>();
    brokerTxs.forEach(tx => {
        if (tx.ticker.toUpperCase() !== upper || !tx.portfolioId) return;
        const direction = tx.direction || 'Buy';
        if (direction !== 'Buy' && direction !== 'Sell') return;
        const entry = byPortfolio.get(tx.portfolioId) ?? { qty: 0, lastDate: '' };
        entry.qty += direction === 'Buy' ? Number(tx.amount) : -Number(tx.amount);
        if (tx.date > entry.lastDate) entry.lastDate = tx.date;
        byPortfolio.set(tx.portfolioId, entry);
    });

    let best: { id: string; qty: number; lastDate: string } | undefined;
    byPortfolio.forEach((entry, id) => {
        if (entry.qty <= 0.000001) return;
        if (!best || entry.qty > best.qty || (entry.qty === best.qty && entry.lastDate > best.lastDate)) {
            best = { id, ...entry };
        }
    });
    return best?.id;
};
