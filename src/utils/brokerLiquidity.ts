import type { Broker } from '../types';

/**
 * Where a broker's cash stands against what it must keep: its minimum
 * (fixed, or a % of invested + cash) plus, optionally, the cash already
 * allocated to portfolios. The Dashboard's Broker Performance & Liquidity
 * cards and the Operations to-dos read the same figures.
 */
export interface BrokerLiquidityStatus {
    liquidity: number;
    /** The broker's own minimum, in €. */
    targetValue: number;
    targetLabel: string;
    /** Σ of the cash allocated to portfolios. */
    allocatedReserve: number;
    /** Cash to keep aside: minimum + (optionally) the allocated cash. */
    reserve: number;
    /** liquidity − reserve: > 0 above, < 0 below. */
    deviation: number;
    hasReserve: boolean;
}

export const brokerLiquidityStatus = (broker: Broker | undefined, investedValue: number, reserveAllocatedCash: boolean): BrokerLiquidityStatus => {
    const liquidity = broker?.currentLiquidity || 0;
    const total = investedValue + liquidity;
    let targetValue: number;
    let targetLabel: string;
    if ((broker?.minLiquidityType || 'percent') === 'fixed') {
        targetValue = broker?.minLiquidityAmount || 0;
        targetLabel = `€${targetValue.toLocaleString('en-IE', { minimumFractionDigits: 0 })}`;
    } else {
        const pct = broker?.minLiquidityPercentage || 0;
        targetValue = total * (pct / 100);
        targetLabel = `${pct}%`;
    }
    const allocatedReserve = Object.values(broker?.liquidityAllocations || {}).reduce((s, v) => s + (v || 0), 0);
    const reserve = targetValue + (reserveAllocatedCash ? allocatedReserve : 0);
    return { liquidity, targetValue, targetLabel, allocatedReserve, reserve, deviation: liquidity - reserve, hasReserve: reserve > 0 };
};

/** The Dashboard setting: keep the cash allocated to portfolios aside too. */
export const RESERVE_ALLOCATED_CASH_KEY = 'portfolio_broker_reserve_allocated_cash';
