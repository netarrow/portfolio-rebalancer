import type { Asset, AssetDefinition, Broker, FreeCommissionPeriod, Portfolio, Transaction } from '../types';
import {
    calculateAssets,
    calculateCommission,
    estimateTradeCost,
    injectCashAssets,
    isCashTicker,
} from './portfolioCalculations';
import { capitalGainsRate, resolveAssetClass } from './rebalanceCosts';
import { calculateWithdrawalProjection } from './withdrawalCalculations';
import {
    buyRecipientOf,
    largestRemainderBuyOnly,
    memberInfoFromAssets,
    resolveGroups,
    type BuyOnlyCandidate,
} from './allocationGroups';
import { currentMonthKey, isFreeBuyIsin } from './freeCommissions';

/**
 * Fund relocation: what it really costs to move money from one place to another.
 *
 * Portfolios here are logical buckets over `Transaction.portfolioId`, so moving
 * funds between them is NOT a bookkeeping edit — it is sell there, buy here, and
 * the money goes through cash. That round trip leaks capital-gains tax and two
 * sets of commissions, which is exactly what this module prices.
 *
 * Cash is a first-class endpoint rather than a side effect: "portfolio → cash"
 * is a divestment, "cash → portfolio" an investment (no sale, so no tax), and
 * "portfolio → portfolio" the full round trip. One union covers all three.
 *
 * The amount is always stated as the NET that must LAND in the destination, and
 * the sell side is solved backwards from it — the sizing question a user
 * actually has ("I want €20k working in the bond bucket"), not the one that is
 * easy to compute.
 */

// ── Request ──────────────────────────────────────────────────────────────────

export type RelocationEndpoint =
    /** `ticker` pins the exact asset to sell from / buy into; omit to let the solver choose. */
    | { kind: 'portfolio'; portfolioId: string; ticker?: string }
    /** `brokerId` picks whose cash moves; omit on the destination to leave it unassigned. */
    | { kind: 'cash'; brokerId?: string };

export interface RelocationRequest {
    from: RelocationEndpoint;
    to: RelocationEndpoint;
    /** € that must end up invested in (or credited to) the destination. */
    netAmount: number;
    /** Waive the buy commission on ISINs covered by a free-buy promo this month. */
    applyFreeBuyPromo?: boolean;
}

export interface RelocationContext {
    portfolios: Portfolio[];
    brokers: Broker[];
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string; spreadPercent?: number | null }>;
    freeCommissionPeriods?: FreeCommissionPeriod[];
    /** 'YYYY-MM' used to resolve free-buy promos; defaults to the current month. */
    monthKey?: string;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface SellAction {
    ticker: string;
    label?: string;
    shares: number;
    price: number;
    averagePrice: number;
    gross: number;
    /** Taxable portion of THIS sale (0 when sold at a loss). */
    gain: number;
    taxRate: number;
    tax: number;
    commission: number;
    /** gross − tax − commission */
    net: number;
    brokerId?: string;
    brokerName?: string;
    /** Implicit half-spread cost, shown but not deducted from the budget. */
    spreadCost: number;
    remainingShares: number;
}

export interface BuyAction {
    ticker: string;
    label?: string;
    shares: number;
    price: number;
    /** shares × price */
    gross: number;
    commission: number;
    /** True when a free-buy promo waived the commission. */
    freeCommission: boolean;
    brokerId?: string;
    brokerName?: string;
    spreadCost: number;
    resultingShares: number;
}

export type RelocationWarningKind =
    | 'source-shortfall'      // the source cannot raise the requested amount
    | 'buy-shortfall'         // whole-share rounding left budget undeployed
    | 'cross-broker'          // proceeds must physically move between brokers
    | 'cash-overdraft'        // the cash source does not hold enough
    | 'cash-min-liquidity'    // the move drops a broker under its configured floor
    | 'cash-earmark'          // it eats cash earmarked for other portfolios
    | 'no-price'              // an asset has no usable price
    | 'no-target';            // the destination has no underweight asset to buy

export interface RelocationWarning {
    kind: RelocationWarningKind;
    message: string;
    amount?: number;
}

export interface RelocationPlan {
    sells: SellAction[];
    buys: BuyAction[];
    /** Gross market value sold (0 when the source is cash). */
    grossSold: number;
    /** Cash drawn straight from a broker (0 when the source is a portfolio). */
    cashDrawn: number;
    tax: number;
    sellCommission: number;
    buyCommission: number;
    /** tax + sellCommission + buyCommission — the euro that leave the net worth. */
    friction: number;
    /** Implicit bid/ask cost across both legs. Reported, not deducted. */
    spreadCost: number;
    /** € actually landing in the destination (invested, or credited when it is cash). */
    netDelivered: number;
    /** What was asked for. `netDelivered` may exceed it by rounding to whole shares. */
    netRequested: number;
    /** friction / netDelivered, as a %. */
    frictionPercent: number;
    warnings: RelocationWarning[];
}

const EPSILON = 1e-9;

/** Rounded euro amount for warning copy, in the app's usual en-IE formatting. */
const eurLabel = (value: number): string =>
    `€${Math.round(value).toLocaleString('en-IE')}`;

const emptyPlan = (netRequested: number, warnings: RelocationWarning[] = []): RelocationPlan => ({
    sells: [], buys: [], grossSold: 0, cashDrawn: 0, tax: 0, sellCommission: 0, buyCommission: 0,
    friction: 0, spreadCost: 0, netDelivered: 0, netRequested, frictionPercent: 0, warnings,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Holdings of a portfolio, with its earmarked broker cash injected as Cash assets. */
export const portfolioAssets = (portfolioId: string, ctx: RelocationContext): Asset[] => {
    const { assets } = calculateAssets(
        ctx.transactions.filter(t => t.portfolioId === portfolioId),
        ctx.assetSettings,
        ctx.marketData
    );
    return injectCashAssets(assets, ctx.brokers, portfolioId);
};

/**
 * Broker each ticker trades through: the portfolio's "broker di appoggio" when
 * one is configured, otherwise the broker of the most recent transaction on that
 * ticker — the same heuristic the Withdrawal simulation uses, so the two tools
 * price the same trade identically.
 */
export const brokerMapFor = (portfolio: Portfolio, ctx: RelocationContext): Record<string, Broker | undefined> => {
    const preferred = portfolio.preferredBrokerId
        ? ctx.brokers.find(b => b.id === portfolio.preferredBrokerId)
        : undefined;

    const map: Record<string, Broker | undefined> = {};
    const portfolioTxs = ctx.transactions.filter(t => t.portfolioId === portfolio.id);
    [...portfolioTxs]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .forEach(tx => {
            const key = tx.ticker.toUpperCase();
            if (!(key in map)) map[key] = preferred ?? ctx.brokers.find(b => b.id === tx.brokerId);
        });

    return new Proxy(map, {
        get: (target, prop: string) => (prop in target ? target[prop] : preferred),
    });
};

const spreadOf = (ticker: string, ctx: RelocationContext): number | null =>
    ctx.marketData[ticker]?.spreadPercent ?? ctx.marketData[ticker.toUpperCase()]?.spreadPercent ?? null;

const priceOf = (ticker: string, assets: Asset[], ctx: RelocationContext): number => {
    const held = assets.find(a => a.ticker.toUpperCase() === ticker.toUpperCase());
    if (held?.currentPrice && held.currentPrice > 0) return held.currentPrice;
    return ctx.marketData[ticker]?.price ?? ctx.marketData[ticker.toUpperCase()]?.price ?? 0;
};

// ── Sell side ────────────────────────────────────────────────────────────────

/**
 * Turns a whole-share sale into its priced legs.
 *
 * Tax hits only the sold portion — shares × (price − PMC) — and a leg sold at a
 * loss is taxed 0 without offsetting the gains of the other legs: netting would
 * need the broker's accumulated tax-credit balance ("zainetto fiscale"), which
 * this app does not model, so the estimate stays deliberately conservative. Same
 * rule as `computeSellFriction` and the Withdrawal tool.
 */
const priceSells = (
    picks: { asset: Asset; shares: number }[],
    brokers: Record<string, Broker | undefined>,
    ctx: RelocationContext
): SellAction[] =>
    picks
        .filter(p => p.shares > 0)
        .map(({ asset, shares }) => {
            const price = asset.currentPrice || 0;
            const gross = shares * price;
            const gain = Math.max(0, gross - shares * asset.averagePrice);
            const taxRate = capitalGainsRate(resolveAssetClass(asset, ctx.assetSettings));
            const tax = gain * taxRate;
            const broker = brokers[asset.ticker.toUpperCase()];
            const commission = broker
                ? (calculateCommission({ amount: shares, price } as Transaction, broker) ?? 0)
                : 0;
            const { spreadCost } = estimateTradeCost({ shares, price, spreadPercent: spreadOf(asset.ticker, ctx) });

            return {
                ticker: asset.ticker,
                label: asset.label,
                shares,
                price,
                averagePrice: asset.averagePrice,
                gross,
                gain,
                taxRate,
                tax,
                commission,
                net: gross - tax - commission,
                brokerId: broker?.id,
                brokerName: broker?.name,
                spreadCost,
                remainingShares: asset.quantity - shares,
            };
        });

/** Sell whole shares of one pinned ticker until the net proceeds cover `neededNet`. */
const sellExactTicker = (
    asset: Asset,
    neededNet: number,
    brokers: Record<string, Broker | undefined>,
    ctx: RelocationContext
): SellAction[] => {
    const price = asset.currentPrice || 0;
    if (!(price > 0) || asset.quantity < 1) return [];

    let shares = 0;
    let net = 0;
    while (net < neededNet - EPSILON && shares < Math.floor(asset.quantity)) {
        shares += 1;
        net = priceSells([{ asset, shares }], brokers, ctx)[0]?.net ?? 0;
    }
    return priceSells([{ asset, shares }], brokers, ctx);
};

/**
 * Sell across the portfolio to raise `neededNet`, reusing the Withdrawal
 * solver: whole shares, most overweight-vs-target sold first. That choice
 * matters — it means a relocation leaves the source CLOSER to its target
 * allocation instead of skewing it.
 */
const sellAcrossPortfolio = (
    assets: Asset[],
    portfolio: Portfolio,
    neededNet: number,
    brokers: Record<string, Broker | undefined>,
    ctx: RelocationContext
): SellAction[] => {
    const projection = calculateWithdrawalProjection(assets, portfolio.allocations || {}, neededNet, brokers);
    const picks = projection.breakdown.flatMap(action => {
        const asset = assets.find(a => a.ticker === action.ticker);
        return asset ? [{ asset, shares: action.sharesToSell }] : [];
    });
    return priceSells(picks, brokers, ctx);
};

// ── Buy side ─────────────────────────────────────────────────────────────────

const priceBuy = (
    ticker: string,
    label: string | undefined,
    shares: number,
    price: number,
    heldShares: number,
    broker: Broker | undefined,
    ctx: RelocationContext,
    applyFreeBuyPromo: boolean
): BuyAction => {
    const freeCommission = applyFreeBuyPromo && isFreeBuyIsin(
        ctx.freeCommissionPeriods || [],
        ticker,
        ctx.monthKey ?? currentMonthKey(),
        broker?.id
    );
    const commission = !broker || freeCommission
        ? 0
        : (calculateCommission({ amount: shares, price } as Transaction, broker) ?? 0);
    const { spreadCost } = estimateTradeCost({ shares, price, spreadPercent: spreadOf(ticker, ctx) });

    return {
        ticker,
        label,
        shares,
        price,
        gross: shares * price,
        commission,
        freeCommission,
        brokerId: broker?.id,
        brokerName: broker?.name,
        spreadCost,
        resultingShares: heldShares + shares,
    };
};

/**
 * Spread `budget` across the destination's underweight units.
 *
 * Units are standalone tickers or whole allocation groups, and a group's buy is
 * routed to its first buy-eligible member — the same resolution the Dashboard's
 * "Buy Only" column uses, so the two screens name the same instrument. Gaps are
 * measured against the POST-move total (current + budget): that is the size the
 * portfolio will actually have once the money lands.
 */
const buyAcrossPortfolio = (
    assets: Asset[],
    portfolio: Portfolio,
    budget: number,
    brokers: Record<string, Broker | undefined>,
    ctx: RelocationContext,
    applyFreeBuyPromo: boolean
): BuyAction[] => {
    const allocations = portfolio.allocations || {};
    const { groupById } = resolveGroups(portfolio);
    const investedAssets = assets.filter(a => !isCashTicker(a.ticker));
    const currentTotal = investedAssets.reduce((s, a) => s + a.currentValue, 0);
    const postTotal = currentTotal + budget;

    /** key -> the ticker that actually receives the order, with its price and held size. */
    const recipient: Record<string, { ticker: string; label?: string; price: number; heldShares: number }> = {};
    const candidates: BuyOnlyCandidate[] = [];

    Object.entries(allocations).forEach(([key, targetPerc]) => {
        if (!(targetPerc > 0)) return;

        const group = groupById[key];
        if (group) {
            const info = memberInfoFromAssets(group.members, investedAssets, ctx.marketData);
            const pick = buyRecipientOf(group, info);
            if (!pick || !(pick.price > 0)) return;
            const groupValue = group.members.reduce((s, m) => s + (info[m.toUpperCase()]?.currentValue ?? 0), 0);
            const gap = postTotal * (targetPerc / 100) - groupValue;
            if (gap <= 0) return;
            const held = investedAssets.find(a => a.ticker.toUpperCase() === pick.ticker.toUpperCase());
            recipient[key] = { ticker: pick.ticker, label: held?.label, price: pick.price, heldShares: held?.quantity ?? 0 };
            candidates.push({ key, gap, price: pick.price });
            return;
        }

        const held = investedAssets.find(a => a.ticker.toUpperCase() === key.toUpperCase());
        const price = priceOf(key, investedAssets, ctx);
        if (!(price > 0)) return;
        const gap = postTotal * (targetPerc / 100) - (held?.currentValue ?? 0);
        if (gap <= 0) return;
        recipient[key] = { ticker: held?.ticker ?? key, label: held?.label, price, heldShares: held?.quantity ?? 0 };
        candidates.push({ key, gap, price });
    });

    const distribution = largestRemainderBuyOnly(candidates, budget);

    return Object.entries(distribution).flatMap(([key, eur]) => {
        const target = recipient[key];
        if (!target) return [];
        const shares = Math.round(eur / target.price);
        if (shares <= 0) return [];
        const broker = brokers[target.ticker.toUpperCase()];
        return [priceBuy(target.ticker, target.label, shares, target.price, target.heldShares, broker, ctx, applyFreeBuyPromo)];
    });
};

// ── Planner ──────────────────────────────────────────────────────────────────

const portfolioOf = (id: string, ctx: RelocationContext) => ctx.portfolios.find(p => p.id === id);

/**
 * Prices a relocation.
 *
 * The sell side is solved backwards from the requested net, but the net needed
 * depends on the buy commissions, which depend on the buy legs, which depend on
 * the proceeds. Two extra passes close that loop: solve, price the buys, re-solve
 * for `netAmount + buyCommission`. Commissions are orders of magnitude smaller
 * than the amount moved, so it converges immediately; the iteration cap keeps a
 * pathological commission plan from spinning.
 */
export const planFundRelocation = (request: RelocationRequest, ctx: RelocationContext): RelocationPlan => {
    const { from, to, netAmount, applyFreeBuyPromo = false } = request;
    const warnings: RelocationWarning[] = [];

    if (!(netAmount > 0)) return emptyPlan(netAmount);

    const sourcePortfolio = from.kind === 'portfolio' ? portfolioOf(from.portfolioId, ctx) : undefined;
    const destPortfolio = to.kind === 'portfolio' ? portfolioOf(to.portfolioId, ctx) : undefined;
    if (from.kind === 'portfolio' && !sourcePortfolio) return emptyPlan(netAmount);
    if (to.kind === 'portfolio' && !destPortfolio) return emptyPlan(netAmount);

    const sourceAssets = sourcePortfolio ? portfolioAssets(sourcePortfolio.id, ctx) : [];
    const destAssets = destPortfolio ? portfolioAssets(destPortfolio.id, ctx) : [];
    const sourceBrokers = sourcePortfolio ? brokerMapFor(sourcePortfolio, ctx) : {};
    const destBrokers = destPortfolio ? brokerMapFor(destPortfolio, ctx) : {};

    // Cash held inside the source portfolio is NOT sold implicitly: to move cash
    // you pick Cash as the endpoint. Same exclusion the Withdrawal modal makes.
    const sellable = sourceAssets.filter(a => !isCashTicker(a.ticker));

    const raise = (neededNet: number): SellAction[] => {
        if (from.kind === 'cash') return [];
        if (from.ticker) {
            const asset = sellable.find(a => a.ticker.toUpperCase() === from.ticker!.toUpperCase());
            if (!asset) return [];
            return sellExactTicker(asset, neededNet, sourceBrokers, ctx);
        }
        return sellAcrossPortfolio(sellable, sourcePortfolio!, neededNet, sourceBrokers, ctx);
    };

    const deploy = (budget: number): BuyAction[] => {
        if (to.kind === 'cash' || budget <= 0) return [];
        if (to.ticker) {
            const price = priceOf(to.ticker, destAssets, ctx);
            if (!(price > 0)) return [];
            const shares = Math.floor(budget / price);
            if (shares <= 0) return [];
            const held = destAssets.find(a => a.ticker.toUpperCase() === to.ticker!.toUpperCase());
            const broker = destBrokers[to.ticker.toUpperCase()];
            return [priceBuy(held?.ticker ?? to.ticker, held?.label, shares, price, held?.quantity ?? 0, broker, ctx, applyFreeBuyPromo)];
        }
        return buyAcrossPortfolio(destAssets, destPortfolio!, budget, destBrokers, ctx, applyFreeBuyPromo);
    };

    // Converge on the buy commission that the sale also has to cover.
    let sells = raise(netAmount);
    let buys = deploy(from.kind === 'cash' ? netAmount : sells.reduce((s, l) => s + l.net, 0));
    for (let pass = 0; pass < 2; pass++) {
        const buyCommission = buys.reduce((s, b) => s + b.commission, 0);
        if (buyCommission <= EPSILON) break;
        const nextSells = raise(netAmount + buyCommission);
        const proceeds = from.kind === 'cash' ? netAmount + buyCommission : nextSells.reduce((s, l) => s + l.net, 0);
        const nextBuys = deploy(proceeds - buyCommission);
        sells = nextSells;
        buys = nextBuys;
    }

    // ── Totals ──
    const grossSold = sells.reduce((s, l) => s + l.gross, 0);
    const tax = sells.reduce((s, l) => s + l.tax, 0);
    const sellCommission = sells.reduce((s, l) => s + l.commission, 0);
    const buyCommission = buys.reduce((s, b) => s + b.commission, 0);
    const invested = buys.reduce((s, b) => s + b.gross, 0);
    const spreadCost = sells.reduce((s, l) => s + l.spreadCost, 0) + buys.reduce((s, b) => s + b.spreadCost, 0);

    const netProceeds = from.kind === 'cash' ? 0 : grossSold - tax - sellCommission;
    // Cash source: exactly what the destination needs plus the fee to get it there.
    const cashDrawn = from.kind === 'cash' ? (to.kind === 'cash' ? netAmount : invested + buyCommission) : 0;
    const netDelivered = to.kind === 'cash' ? (from.kind === 'cash' ? cashDrawn : netProceeds) : invested;
    const friction = tax + sellCommission + buyCommission;

    // ── Warnings ──
    if (from.kind === 'portfolio') {
        if (sells.length === 0) {
            warnings.push({
                kind: from.ticker ? 'no-price' : 'source-shortfall',
                message: from.ticker
                    ? `No sellable shares of ${from.ticker} in ${sourcePortfolio!.name} — the position is empty or has no price.`
                    : `${sourcePortfolio!.name} holds nothing sellable with a valid price.`,
            });
        } else {
            const deliverable = to.kind === 'cash' ? netProceeds : netProceeds - buyCommission;
            const shortfall = netAmount - deliverable;
            if (shortfall > 1) {
                warnings.push({
                    kind: 'source-shortfall',
                    message: from.ticker
                        ? `The ${from.ticker} position is too small: ${eurLabel(shortfall)} short of the requested net.`
                        : `${sourcePortfolio!.name} cannot cover the whole amount: ${eurLabel(shortfall)} short.`,
                    amount: shortfall,
                });
            }
        }
    }

    if (to.kind === 'portfolio') {
        const budget = (from.kind === 'cash' ? netAmount : netProceeds) - buyCommission;
        if (buys.length === 0 && budget > 0) {
            warnings.push({
                kind: 'no-target',
                message: to.ticker
                    ? `${to.ticker} has no usable price, so the buy cannot be sized.`
                    : `${destPortfolio!.name} has nothing underweight to buy (or the prices are missing).`,
            });
        } else {
            const undeployed = budget - invested;
            if (undeployed > 1) {
                warnings.push({
                    kind: 'buy-shortfall',
                    message: `${eurLabel(undeployed)} stays in cash: rounding to whole shares leaves it undeployed.`,
                    amount: undeployed,
                });
            }
        }
    }

    const sellBrokerIds = new Set(sells.map(s => s.brokerId).filter(Boolean));
    const buyBrokerIds = new Set(buys.map(b => b.brokerId).filter(Boolean));
    const cashSourceId = from.kind === 'cash' ? from.brokerId : undefined;
    if (cashSourceId) sellBrokerIds.add(cashSourceId);
    const crossBroker = [...buyBrokerIds].some(id => sellBrokerIds.size > 0 && !sellBrokerIds.has(id));
    if (crossBroker) {
        warnings.push({
            kind: 'cross-broker',
            message: 'Sales and purchases settle at different brokers: the cash has to physically move before the buys can clear.',
        });
    }

    if (from.kind === 'cash') {
        warnings.push(...cashSourceWarnings(from, cashDrawn, to, ctx));
    }

    return {
        sells,
        buys,
        grossSold,
        cashDrawn,
        tax,
        sellCommission,
        buyCommission,
        friction,
        spreadCost,
        netDelivered,
        netRequested: netAmount,
        frictionPercent: netDelivered > 0 ? (friction / netDelivered) * 100 : 0,
        warnings,
    };
};

/**
 * Capacity checks when the money comes out of a broker's cash: the same three
 * floors `projectBrokerCash` enforces for a rebalance — hard overdraft, cash
 * earmarked for other portfolios, and the broker's configured minimum liquidity.
 */
const cashSourceWarnings = (
    from: Extract<RelocationEndpoint, { kind: 'cash' }>,
    drawn: number,
    to: RelocationEndpoint,
    ctx: RelocationContext
): RelocationWarning[] => {
    const warnings: RelocationWarning[] = [];
    const broker = from.brokerId ? ctx.brokers.find(b => b.id === from.brokerId) : undefined;

    const before = broker
        ? (broker.currentLiquidity ?? 0)
        : ctx.brokers.reduce((s, b) => s + (b.currentLiquidity ?? 0), 0);
    const after = before - drawn;

    if (after < -EPSILON) {
        warnings.push({
            kind: 'cash-overdraft',
            message: broker
                ? `${broker.name} does not hold enough cash: ${eurLabel(-after)} short.`
                : `Total liquidity is not enough: ${eurLabel(-after)} short.`,
            amount: -after,
        });
        return warnings;
    }

    if (!broker) return warnings;

    const destPortfolioId = to.kind === 'portfolio' ? to.portfolioId : undefined;
    const earmarkedElsewhere = Object.entries(broker.liquidityAllocations || {})
        .filter(([pid]) => pid !== destPortfolioId)
        .reduce((s, [, v]) => s + (v || 0), 0);
    if (earmarkedElsewhere > 0 && after < earmarkedElsewhere) {
        warnings.push({
            kind: 'cash-earmark',
            message: `${eurLabel(after)} would be left at ${broker.name} against ${eurLabel(earmarkedElsewhere)} already earmarked for other portfolios.`,
            amount: earmarkedElsewhere - after,
        });
    }

    let minLiquidity = 0;
    if (broker.minLiquidityType === 'fixed') minLiquidity = broker.minLiquidityAmount || 0;
    else if (broker.minLiquidityType === 'percent') minLiquidity = before * ((broker.minLiquidityPercentage || 0) / 100);
    if (minLiquidity > 0 && after < minLiquidity) {
        warnings.push({
            kind: 'cash-min-liquidity',
            message: `${broker.name} would drop below its minimum liquidity of ${eurLabel(minLiquidity)}.`,
            amount: minLiquidity - after,
        });
    }

    return warnings;
};

// ── Simulated state ──────────────────────────────────────────────────────────

/**
 * Replays the plan onto a copy of the data so the SAME calculators that render
 * the real Stats page can measure the "after" state.
 *
 * This is the reason the what-if reconciles: nothing about net worth, macro
 * allocation or the goal pyramid is recomputed by hand here — the plan just
 * becomes synthetic transactions and adjusted broker cash, and everything
 * downstream is the production code path.
 */
export const applyRelocationToState = (
    transactions: Transaction[],
    brokers: Broker[],
    request: RelocationRequest,
    plan: RelocationPlan
): { transactions: Transaction[]; brokers: Broker[] } => {
    const { from, to } = request;
    const date = new Date().toISOString().slice(0, 10);
    const synthetic: Transaction[] = [];

    plan.sells.forEach((s, i) => {
        synthetic.push({
            id: `__reloc_sell_${i}`,
            ticker: s.ticker,
            amount: s.shares,
            price: s.price,
            date,
            direction: 'Sell',
            portfolioId: from.kind === 'portfolio' ? from.portfolioId : undefined,
            brokerId: s.brokerId,
        });
    });

    plan.buys.forEach((b, i) => {
        synthetic.push({
            id: `__reloc_buy_${i}`,
            ticker: b.ticker,
            amount: b.shares,
            price: b.price,
            date,
            direction: 'Buy',
            portfolioId: to.kind === 'portfolio' ? to.portfolioId : undefined,
            brokerId: b.brokerId,
            freeCommission: b.freeCommission || undefined,
        });
    });

    // Cash movements, netted per broker. Sales credit their broker net of tax and
    // commission; purchases debit theirs. A cash endpoint moves its own balance.
    const cashDelta: Record<string, number> = {};
    const bump = (brokerId: string | undefined, amount: number) => {
        if (!brokerId) return;
        cashDelta[brokerId] = (cashDelta[brokerId] || 0) + amount;
    };

    plan.sells.forEach(s => bump(s.brokerId, s.net));
    plan.buys.forEach(b => bump(b.brokerId, -(b.gross + b.commission)));

    if (from.kind === 'cash' && from.brokerId) bump(from.brokerId, -plan.cashDrawn);
    // A sale already credits the broker it settled at, so a cash DESTINATION
    // needs no second credit — only a pure cash→cash transfer does.
    if (to.kind === 'cash' && to.brokerId && from.kind === 'cash') bump(to.brokerId, plan.netDelivered);

    const nextBrokers = brokers.map(b => {
        const delta = cashDelta[b.id];
        if (!delta) return b;
        const next: Broker = { ...b, currentLiquidity: (b.currentLiquidity ?? 0) + delta };

        // Spending earmarked cash releases the earmark: the money stopped being
        // reserved the moment it bought something. Proceeds landing IN cash are
        // deliberately left unassigned instead — that is what puts them in the
        // pyramid's "Liquidity" level rather than back inside a goal.
        const allocations = { ...(b.liquidityAllocations || {}) };
        if (from.kind === 'cash' && from.brokerId === b.id && to.kind === 'portfolio') {
            const pid = to.portfolioId;
            if (pid in allocations) {
                allocations[pid] = Math.max(0, (allocations[pid] || 0) - plan.cashDrawn);
            }
        }

        const cash = next.currentLiquidity ?? 0;
        const assigned = Object.values(allocations).reduce((s, v) => s + (v || 0), 0);
        if (assigned > cash && assigned > 0) {
            const scale = cash / assigned;
            Object.keys(allocations).forEach(pid => { allocations[pid] = (allocations[pid] || 0) * scale; });
        }
        next.liquidityAllocations = allocations;
        return next;
    });

    return { transactions: [...transactions, ...synthetic], brokers: nextBrokers };
};
