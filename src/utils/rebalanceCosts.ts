import type { Asset, AssetClass, AssetDefinition, Broker, Transaction } from '../types';
import { calculateCommission, isCashTicker, isVirtualBondTicker } from './portfolioCalculations';
import { TAX_RATES } from './withdrawalCalculations';

/**
 * Sell-side friction of a rebalance, and how much of the gross proceeds is
 * actually reinvestable.
 *
 * A full rebalance that sells X to buy Y does NOT free X euro of cash: the
 * broker settles the sale net of capital-gains tax and of its own commission.
 * Sizing the buys on the gross proceeds means ordering more than the account
 * can pay for, and the settlement goes negative.
 */

/**
 * Capital-gains rate for an asset class: 26% on equities/crypto/gold, 12.5% on
 * (white-list) bonds and monetary funds, 20% on Italian pension funds.
 * Single source of truth shared with the Withdrawal tool.
 */
export const capitalGainsRate = (assetClass?: string): number =>
    TAX_RATES[(assetClass ?? 'Stock') as AssetClass] ?? 0.26;

/**
 * Asset class as the allocation rows resolve it: the settings override wins,
 * cash tickers are Cash and unresolved virtual bonds count as Bond. Drives the
 * capital-gains rate applied to a sale.
 */
export const resolveAssetClass = (asset: Asset, settings: AssetDefinition[]): string => {
    if (isCashTicker(asset.ticker)) return 'Cash';
    if (isVirtualBondTicker(asset.ticker)) return 'Bond';
    return settings.find(s => s.ticker === asset.ticker)?.assetClass || asset.assetClass || 'Stock';
};

export interface SellLeg {
    ticker: string;
    /** Whole shares being sold (positive). */
    shares: number;
    /** Current market price used to size the sale. */
    price: number;
    /** Average cost of the position (PMC) — the basis of the sold portion. */
    averagePrice: number;
    assetClass?: string;
    /** Broker whose commission plan the sale is simulated against. */
    broker?: Broker;
}

export interface SellLegCost {
    ticker: string;
    /** shares × price */
    gross: number;
    /** Taxable portion of the sale — 0 when the sold portion is at a loss. */
    gain: number;
    taxRate: number;
    tax: number;
    commission: number;
    /** gross − tax − commission: what the broker actually credits. */
    net: number;
}

export interface SellFriction {
    legs: SellLegCost[];
    tax: number;
    commission: number;
    /** tax + commission — the money that leaves the portfolio entirely. */
    total: number;
    gross: number;
    net: number;
}

const EMPTY_FRICTION: SellFriction = { legs: [], tax: 0, commission: 0, total: 0, gross: 0, net: 0 };

/**
 * Prices the tax and commission owed on a set of sales.
 *
 * Tax hits only the *sold* portion of each position — shares × (price − PMC) —
 * never the whole unrealized gain. A sale at a loss is taxed 0 and its loss is
 * NOT netted against the gains of the other legs: offsetting needs the broker's
 * accumulated tax-credit balance, which isn't modelled here, so the estimate
 * stays conservative (same rule as the Withdrawal tool).
 */
export const computeSellFriction = (legs: SellLeg[]): SellFriction => {
    if (legs.length === 0) return EMPTY_FRICTION;

    const priced: SellLegCost[] = [];
    legs.forEach(leg => {
        const shares = Math.abs(leg.shares);
        if (shares <= 0 || !(leg.price > 0)) return;

        const gross = shares * leg.price;
        const gain = Math.max(0, gross - shares * leg.averagePrice);
        const taxRate = capitalGainsRate(leg.assetClass);
        const tax = gain * taxRate;
        const commission = leg.broker
            ? (calculateCommission({ amount: shares, price: leg.price } as Transaction, leg.broker) ?? 0)
            : 0;

        priced.push({ ticker: leg.ticker, gross, gain, taxRate, tax, commission, net: gross - tax - commission });
    });

    const tax = priced.reduce((s, l) => s + l.tax, 0);
    const commission = priced.reduce((s, l) => s + l.commission, 0);
    const gross = priced.reduce((s, l) => s + l.gross, 0);

    return { legs: priced, tax, commission, total: tax + commission, gross, net: gross - tax - commission };
};

/**
 * Fraction of each gross buy that stays affordable once the sell leg's tax and
 * commissions are paid out of the same pot.
 *
 * Returns exactly 1 when there is nothing to absorb (no sales, sales at a loss
 * with no commission, or a buy-only rebalance) — callers must then leave their
 * original sizing untouched, so this correction is a no-op unless the rebalance
 * really does sell something.
 */
export const buyBudgetScale = (grossBuyTotal: number, friction: number): number => {
    if (!(grossBuyTotal > 0) || !(friction > 0)) return 1;
    return Math.max(0, (grossBuyTotal - friction) / grossBuyTotal);
};

/**
 * Applies `scale` to a gross buy expressed in whole shares.
 *
 * Rounds DOWN: the basket must never cost more than the sells actually settle
 * for. The euro left over by the flooring simply stays as cash.
 */
export const scaledBuyShares = (grossShares: number, scale: number): number => {
    if (scale >= 1) return grossShares;
    return Math.max(0, Math.floor(grossShares * scale));
};
