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

export type CashWarningKind =
    | 'overdraft'      // the rebalance costs more cash than the broker has
    | 'earmark'        // it eats into cash reserved for other portfolios
    | 'min-liquidity'; // it drops the broker below its configured floor

export interface CashWarning {
    kind: CashWarningKind;
    /** € missing against the relevant floor */
    deficit: number;
    /** the floor itself (0 for an overdraft) */
    threshold: number;
}

export interface CashProjection {
    brokerName: string;
    /** broker cash before the rebalance */
    before: number;
    /** gross cost of the buy legs */
    buyGross: number;
    /** commissions owed on the buy legs (0 when no plan is configured) */
    buyCommission: number;
    /** before + net sale proceeds − buys − buy commissions */
    after: number;
    /** cash this broker has earmarked for OTHER portfolios */
    earmarkedElsewhere: number;
    /** the broker's configured minimum liquidity, 0 when unset */
    minLiquidity: number;
    warnings: CashWarning[];
}

/**
 * Projects the cash left at the portfolio's broker once the rebalance settles.
 *
 * Only meaningful when the portfolio declares a single broker: the sale
 * proceeds and the purchases have to clear the SAME account, so a plan that
 * balances at portfolio level can still overdraw one broker. Buy commissions
 * are counted here (the broker is known, so they are computable) even though
 * they deliberately do not shrink the buy sizing — the projection is a check,
 * not a constraint. Free-buy promotions are ignored, which only makes the
 * estimate more conservative.
 */
export const projectBrokerCash = (params: {
    broker: Broker;
    portfolioId: string;
    friction: SellFriction;
    buys: { shares: number; price: number }[];
}): CashProjection => {
    const { broker, portfolioId, friction, buys } = params;

    const before = broker.currentLiquidity ?? 0;
    const buyGross = buys.reduce((s, b) => s + b.shares * b.price, 0);
    const buyCommission = buys.reduce((s, b) => {
        if (b.shares <= 0 || !(b.price > 0)) return s;
        return s + (calculateCommission({ amount: b.shares, price: b.price } as Transaction, broker) ?? 0);
    }, 0);
    const after = before + friction.net - buyGross - buyCommission;

    const earmarkedElsewhere = Object.entries(broker.liquidityAllocations || {})
        .filter(([pid]) => pid !== portfolioId)
        .reduce((s, [, v]) => s + (v || 0), 0);

    let minLiquidity = 0;
    if (broker.minLiquidityType === 'fixed') {
        minLiquidity = broker.minLiquidityAmount || 0;
    } else if (broker.minLiquidityType === 'percent') {
        minLiquidity = before * ((broker.minLiquidityPercentage || 0) / 100);
    }

    const warnings: CashWarning[] = [];
    if (after < 0) {
        // An overdraft subsumes the softer floors — report the hard failure only.
        warnings.push({ kind: 'overdraft', deficit: -after, threshold: 0 });
    } else {
        if (earmarkedElsewhere > 0 && after < earmarkedElsewhere) {
            warnings.push({ kind: 'earmark', deficit: earmarkedElsewhere - after, threshold: earmarkedElsewhere });
        }
        if (minLiquidity > 0 && after < minLiquidity) {
            warnings.push({ kind: 'min-liquidity', deficit: minLiquidity - after, threshold: minLiquidity });
        }
    }

    return { brokerName: broker.name, before, buyGross, buyCommission, after, earmarkedElsewhere, minLiquidity, warnings };
};
