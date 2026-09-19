/**
 * YNAB funding plan: from mapped categories to "wire this, then buy that".
 *
 * A YNAB category that has been pointed at an asset is money already decided:
 * it sits in the budget waiting to become shares. This turns those categories
 * into the two concrete steps that follow — **how much to wire to each broker**
 * and **which orders to place there** — priced against the broker's own
 * commission plan, the free-buy promotions of the month and the cash the broker
 * already holds.
 *
 * Deliberate simplifications, in the spirit of the rest of the tool:
 *  - categories pointing at the same ticker/broker/portfolio are merged into a
 *    single order, so one commission is paid instead of one per category;
 *  - nothing is ever sold, and no order is ever sized beyond the money its
 *    categories hold;
 *  - a broker with no commission plan configured is treated as free (that is
 *    what a zero-commission plan looks like in this app), and flagged as such
 *    rather than guessed at.
 */
import type {
    AssetDefinition,
    Broker,
    FreeCommissionPeriod,
    Portfolio,
    Transaction,
    YnabCategory,
    YnabCategoryMapping,
    YnabFundingSettings,
} from '../types';
import { calculateCommission } from './portfolioCalculations';
import { currentMonthKey, isFreeBuyIsin } from './freeCommissions';
import { lotUnitsFor } from './amountTargets';

/**
 * Id prefix of the transactions the plan books. The plan cannot see what was
 * moved inside YNAB, so it uses these to notice an order it has already placed
 * today and warn instead of proposing the same purchase twice.
 */
export const YNAB_FUNDING_TX_PREFIX = 'ynab-fund-';

export const roundCents = (value: number): number => Math.round(value * 100) / 100;

/** Rounds a wire amount UP to a whole multiple of `step` (step ≤ 0 = to the cent). */
export const roundUpTo = (value: number, step: number): number => {
    if (!(value > 0)) return 0;
    if (!(step > 0)) return roundCents(value);
    return Math.ceil(roundCents(value) / step) * step;
};

/** One YNAB category contributing its money to an order or a cash top-up. */
export interface FundingSource {
    categoryId: string;
    categoryName: string;
    groupName: string;
    amount: number;
}

export type FundingOrderWarning =
    | 'no-price'            // no known price: the order cannot be sized
    | 'no-broker'           // no broker resolved: the commission is unknown
    | 'no-portfolio'        // nowhere to book the trade, so it cannot be registered
    | 'budget-too-small'    // not even one unit (or bond lot) is affordable
    | 'high-fee'            // the commission eats more than the configured %
    | 'no-commission-plan'  // broker without a plan: priced as free
    | 'already-registered'; // the same order was already booked today

/** Why an order pays no commission. */
export type FundingFreeReason = 'promo' | 'no-plan';

export interface FundingOrder {
    /** `ticker|brokerId|portfolioId` — the identity the categories were merged on. */
    id: string;
    ticker: string;
    label: string;
    brokerId?: string;
    brokerName?: string;
    portfolioId?: string;
    portfolioName?: string;
    /** € the mapped categories put behind this ticker. */
    budget: number;
    price?: number;
    /** Units of a minimum lot: 1 for ETFs, 10 for a €1,000 BTP lot quoted per 100. */
    lotUnits: number;
    quantity: number;
    /** quantity × price */
    gross: number;
    commission: number;
    commissionFree: boolean;
    freeReason?: FundingFreeReason;
    /** commission as a % of the trade value, 0 when nothing is bought. */
    feePercent: number;
    /** What leaves the account for this order: gross + commission. */
    outlay: number;
    /** Money of the categories this order does not manage to invest. */
    leftover: number;
    sources: FundingSource[];
    warnings: FundingOrderWarning[];
}

/** A category mapped straight to broker cash: money to park, not to invest. */
export interface FundingDeposit {
    brokerId: string;
    brokerName: string;
    amount: number;
    sources: FundingSource[];
}

export type FundingTransferWarning =
    | 'unknown-broker'   // orders with no broker: the wire cannot be addressed
    | 'earmark-shortfall'; // the broker's usable cash is held back by other portfolios

export interface FundingTransfer {
    brokerId?: string;
    brokerName: string;
    /** Σ outlay of this broker's orders. */
    ordersOutlay: number;
    /** Σ of the cash top-ups addressed to this broker. */
    deposits: number;
    /** ordersOutlay + deposits: what the account has to be able to pay. */
    required: number;
    currentLiquidity: number;
    minLiquidity: number;
    /** Cash reserved for portfolios this plan does not touch. */
    earmarkedElsewhere: number;
    /** currentLiquidity − minLiquidity − earmarkedElsewhere, floored at 0. */
    usableCash: number;
    /** required − usableCash before rounding, floored at 0. */
    shortfall: number;
    /** The figure to wire: `shortfall` rounded up to the configured step. */
    transfer: number;
    /** Usable cash left over once the plan settles. */
    surplus: number;
    warnings: FundingTransferWarning[];
}

/** A mapped category whose money never reaches the plan, and why. */
export interface FundingIgnored {
    categoryId: string;
    categoryName: string;
    amount: number;
    reason: 'no-funds' | 'category-missing';
}

export interface FundingTotals {
    /** € the mapped categories hold. */
    budget: number;
    gross: number;
    commission: number;
    outlay: number;
    deposits: number;
    /** Σ of the wires, after rounding. */
    transfer: number;
    /** Money the orders cannot invest (flooring residue and unsized orders). */
    leftover: number;
    orders: number;
    /** € saved by the free-buy promos and the commission-free brokers. */
    feesSaved: number;
}

export interface YnabFundingPlan {
    orders: FundingOrder[];
    deposits: FundingDeposit[];
    transfers: FundingTransfer[];
    ignored: FundingIgnored[];
    totals: FundingTotals;
    /** Month the free-buy promos were evaluated for ('YYYY-MM'). */
    monthKey: string;
}

export interface YnabFundingPlanInput {
    categories: YnabCategory[];
    mappings: YnabCategoryMapping[];
    brokers: Broker[];
    portfolios: Portfolio[];
    assetSettings: AssetDefinition[];
    /** ticker → € price per unit; keys are matched case-insensitively. */
    prices: Record<string, { price: number } | number>;
    transactions?: Transaction[];
    freeCommissionPeriods?: FreeCommissionPeriod[];
    settings: YnabFundingSettings;
    /** Defaults to the current month; injectable so the checks stay stable. */
    monthKey?: string;
    /** Today's ISO date; injectable for the same reason. */
    today?: string;
}

const priceOf = (
    prices: YnabFundingPlanInput['prices'],
    ticker: string,
): number | undefined => {
    const upper = ticker.toUpperCase();
    const entry = prices[ticker] ?? prices[upper]
        ?? Object.entries(prices).find(([k]) => k.toUpperCase() === upper)?.[1];
    if (entry === undefined) return undefined;
    const value = typeof entry === 'number' ? entry : entry.price;
    return value > 0 ? value : undefined;
};

/** € the broker charges on a trade of `tradeValue`, and whether it has a plan at all. */
const feeFor = (broker: Broker | undefined, tradeValue: number): { fee: number; hasPlan: boolean } => {
    if (!broker || !broker.commissionType || !(tradeValue > 0)) return { fee: 0, hasPlan: !!broker?.commissionType };
    const fee = calculateCommission({ amount: tradeValue, price: 1 } as Transaction, broker);
    return { fee: fee === undefined ? 0 : roundCents(fee), hasPlan: fee !== undefined };
};

/** The broker that last bought this ticker — the app's usual fallback. */
const lastBrokerForTicker = (transactions: Transaction[], ticker: string): string | undefined => {
    const upper = ticker.toUpperCase();
    const candidates = transactions
        .filter(t => t.ticker?.toUpperCase() === upper && !!t.brokerId)
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return candidates[candidates.length - 1]?.brokerId;
};

/** The € a category puts on the table, per the configured source field. */
export const categoryFunds = (category: YnabCategory, settings: YnabFundingSettings): number => {
    const milli = settings.source === 'budgeted'
        ? (category.budgetedMilliunits ?? 0)
        : category.balanceMilliunits;
    return roundCents(milli / 1000);
};

const minLiquidityOf = (broker: Broker): number => {
    if (broker.minLiquidityType === 'fixed') return Math.max(0, broker.minLiquidityAmount || 0);
    if (broker.minLiquidityType === 'percent') {
        return Math.max(0, (broker.currentLiquidity || 0) * ((broker.minLiquidityPercentage || 0) / 100));
    }
    return 0;
};

interface OrderDraft {
    ticker: string;
    brokerId?: string;
    portfolioId?: string;
    budget: number;
    sources: FundingSource[];
}

/**
 * Sizes one order: how many units the budget buys once the commission is
 * accounted for, and what it costs.
 *
 * With `feesFromBudget` the fee comes out of the same money as the shares, so
 * the quantity is the largest one whose gross + fee still fits the budget —
 * found by stepping down from the naive count, since a percent plan with a
 * minimum fee is not invertible in closed form. Without it the fee is an extra
 * outlay the wire has to cover, and the full budget is invested.
 */
const sizeOrder = (params: {
    budget: number;
    price: number;
    lotUnits: number;
    broker: Broker | undefined;
    free: boolean;
    settings: YnabFundingSettings;
}): { quantity: number; gross: number; commission: number; hasPlan: boolean } => {
    const { budget, price, lotUnits, broker, free, settings } = params;
    const fee = (value: number) => (free ? { fee: 0, hasPlan: feeFor(broker, value).hasPlan } : feeFor(broker, value));

    if (settings.rounding === 'fractional') {
        let value = budget;
        if (settings.feesFromBudget) {
            // Two passes are enough: the fee is a small, monotone function of the
            // value, so the second pass lands within a cent of the fixed point.
            for (let i = 0; i < 2; i++) {
                const f = fee(value).fee;
                value = Math.max(0, roundCents(budget - f));
            }
        }
        const priced = fee(value);
        return {
            quantity: value > 0 ? value / price : 0,
            gross: roundCents(value),
            commission: priced.fee,
            hasPlan: priced.hasPlan,
        };
    }

    const lotCost = price * lotUnits;
    let lots = Math.floor(roundCents(budget) / lotCost);
    if (settings.feesFromBudget) {
        while (lots > 0 && roundCents(lots * lotCost + fee(lots * lotCost).fee) > roundCents(budget)) lots--;
    }
    const gross = roundCents(lots * lotCost);
    const priced = fee(gross);
    return { quantity: lots * lotUnits, gross, commission: lots > 0 ? priced.fee : 0, hasPlan: priced.hasPlan };
};

/**
 * Builds the whole plan: the orders, the cash top-ups, the wire per broker and
 * the totals. Pure — every figure is derived from the input.
 */
export const buildYnabFundingPlan = (input: YnabFundingPlanInput): YnabFundingPlan => {
    const {
        categories, mappings, brokers, portfolios, assetSettings, prices,
        transactions = [], freeCommissionPeriods = [], settings,
    } = input;
    const monthKey = input.monthKey ?? currentMonthKey();
    const today = input.today ?? new Date().toISOString().slice(0, 10);

    // Orders this plan already booked today, so the same purchase is not
    // proposed a second time without saying so.
    const registeredToday = new Set(transactions
        .filter(t => t.id?.startsWith(YNAB_FUNDING_TX_PREFIX) && t.date === today)
        .map(t => `${t.ticker?.toUpperCase()}|${t.brokerId ?? ''}|${t.portfolioId ?? ''}`));

    const categoryById = new Map(categories.map(c => [c.id, c]));
    const brokerById = new Map(brokers.map(b => [b.id, b]));
    const portfolioById = new Map(portfolios.map(p => [p.id, p]));

    const ignored: FundingIgnored[] = [];
    const drafts = new Map<string, OrderDraft>();
    const depositsByBroker = new Map<string, FundingDeposit>();

    for (const mapping of mappings) {
        if (mapping.target.kind === 'unmapped') continue;
        const category = categoryById.get(mapping.categoryId);
        if (!category) {
            ignored.push({ categoryId: mapping.categoryId, categoryName: mapping.categoryId, amount: 0, reason: 'category-missing' });
            continue;
        }
        const amount = categoryFunds(category, settings);
        const source: FundingSource = {
            categoryId: category.id,
            categoryName: category.name,
            groupName: category.groupName,
            amount,
        };
        if (!(amount > 0)) {
            ignored.push({ categoryId: category.id, categoryName: category.name, amount, reason: 'no-funds' });
            continue;
        }

        if (mapping.target.kind === 'cash') {
            const brokerId = mapping.target.brokerId;
            const entry = depositsByBroker.get(brokerId) ?? {
                brokerId,
                brokerName: brokerById.get(brokerId)?.name ?? 'Unknown broker',
                amount: 0,
                sources: [],
            };
            entry.amount = roundCents(entry.amount + amount);
            entry.sources.push(source);
            depositsByBroker.set(brokerId, entry);
            continue;
        }

        const ticker = mapping.target.ticker;
        const portfolioId = mapping.target.portfolioId;
        const brokerId = mapping.target.brokerId
            ?? (portfolioId ? portfolioById.get(portfolioId)?.preferredBrokerId : undefined)
            ?? lastBrokerForTicker(transactions, ticker);
        const id = `${ticker.toUpperCase()}|${brokerId ?? ''}|${portfolioId ?? ''}`;
        const draft = drafts.get(id) ?? { ticker, brokerId, portfolioId, budget: 0, sources: [] };
        draft.budget = roundCents(draft.budget + amount);
        draft.sources.push(source);
        drafts.set(id, draft);
    }

    const orders: FundingOrder[] = [...drafts.entries()].map(([id, draft]) => {
        const broker = draft.brokerId ? brokerById.get(draft.brokerId) : undefined;
        const portfolio = draft.portfolioId ? portfolioById.get(draft.portfolioId) : undefined;
        const definition = assetSettings.find(a => a.ticker.toUpperCase() === draft.ticker.toUpperCase());
        const price = priceOf(prices, draft.ticker);
        const free = isFreeBuyIsin(freeCommissionPeriods, draft.ticker, monthKey, draft.brokerId);

        const warnings: FundingOrderWarning[] = [];
        if (!broker) warnings.push('no-broker');
        if (!portfolio) warnings.push('no-portfolio');
        if (registeredToday.has(id)) warnings.push('already-registered');

        const base = {
            id,
            ticker: draft.ticker,
            label: definition?.label || draft.ticker,
            brokerId: draft.brokerId,
            brokerName: broker?.name,
            portfolioId: draft.portfolioId,
            portfolioName: portfolio?.name,
            budget: draft.budget,
            sources: draft.sources,
        };

        if (price === undefined) {
            warnings.push('no-price');
            return {
                ...base, price: undefined, lotUnits: 1, quantity: 0, gross: 0,
                commission: 0, commissionFree: free, feePercent: 0, outlay: 0,
                leftover: draft.budget, warnings,
            };
        }

        const lotUnits = lotUnitsFor(draft.ticker, price, assetSettings);
        const sized = sizeOrder({ budget: draft.budget, price, lotUnits, broker, free, settings });
        const outlay = roundCents(sized.gross + sized.commission);
        const leftover = roundCents(Math.max(0, draft.budget - (settings.feesFromBudget ? outlay : sized.gross)));
        const feePercent = sized.gross > 0 ? (sized.commission / sized.gross) * 100 : 0;

        if (sized.quantity <= 0) warnings.push('budget-too-small');
        if (!free && broker && !sized.hasPlan) warnings.push('no-commission-plan');
        if (sized.quantity > 0 && feePercent > settings.feeWarnPercent) warnings.push('high-fee');

        return {
            ...base,
            price,
            lotUnits,
            quantity: sized.quantity,
            gross: sized.gross,
            commission: sized.commission,
            commissionFree: free || (!!broker && !sized.hasPlan),
            freeReason: free ? 'promo' as const : (broker && !sized.hasPlan ? 'no-plan' as const : undefined),
            feePercent,
            outlay,
            leftover,
            warnings,
        };
    }).sort((a, b) => (b.outlay - a.outlay) || a.ticker.localeCompare(b.ticker));

    const deposits = [...depositsByBroker.values()].sort((a, b) => b.amount - a.amount);

    // ── Wires, one per broker the plan needs money at ───────────────────
    const brokerIds: (string | undefined)[] = [];
    for (const o of orders) if (!brokerIds.includes(o.brokerId)) brokerIds.push(o.brokerId);
    for (const d of deposits) if (!brokerIds.includes(d.brokerId)) brokerIds.push(d.brokerId);

    const transfers: FundingTransfer[] = brokerIds.map(brokerId => {
        const broker = brokerId ? brokerById.get(brokerId) : undefined;
        const brokerOrders = orders.filter(o => o.brokerId === brokerId);
        const ordersOutlay = roundCents(brokerOrders.reduce((s, o) => s + o.outlay, 0));
        const depositTotal = roundCents(deposits.filter(d => d.brokerId === brokerId).reduce((s, d) => s + d.amount, 0));
        const required = roundCents(ordersOutlay + depositTotal);

        const currentLiquidity = broker?.currentLiquidity ?? 0;
        const minLiquidity = broker ? roundCents(minLiquidityOf(broker)) : 0;
        // Cash a broker has reserved for a portfolio this plan buys into is this
        // plan's money too; anything reserved for the others is not available.
        const planPortfolios = new Set(brokerOrders.map(o => o.portfolioId).filter(Boolean) as string[]);
        const earmarkedElsewhere = roundCents(Object.entries(broker?.liquidityAllocations || {})
            .filter(([pid]) => !planPortfolios.has(pid))
            .reduce((s, [, v]) => s + (v || 0), 0));

        const usableCash = settings.useBrokerCash
            ? roundCents(Math.max(0, currentLiquidity - minLiquidity - earmarkedElsewhere))
            : 0;
        const shortfall = roundCents(Math.max(0, required - usableCash));
        const transfer = roundUpTo(shortfall, settings.transferRoundingStep);

        const warnings: FundingTransferWarning[] = [];
        if (!broker) warnings.push('unknown-broker');
        if (settings.useBrokerCash && earmarkedElsewhere > 0 && currentLiquidity - minLiquidity > usableCash) {
            warnings.push('earmark-shortfall');
        }

        return {
            brokerId,
            brokerName: broker?.name ?? 'Unknown broker',
            ordersOutlay,
            deposits: depositTotal,
            required,
            currentLiquidity,
            minLiquidity,
            earmarkedElsewhere,
            usableCash,
            shortfall,
            transfer,
            surplus: roundCents(Math.max(0, usableCash - required)),
            warnings,
        };
    }).sort((a, b) => (b.transfer - a.transfer) || a.brokerName.localeCompare(b.brokerName));

    const sum = (values: number[]) => roundCents(values.reduce((s, v) => s + v, 0));
    const depositTotal = sum(deposits.map(d => d.amount));
    const totals: FundingTotals = {
        budget: sum([...orders.map(o => o.budget), depositTotal]),
        gross: sum(orders.map(o => o.gross)),
        commission: sum(orders.map(o => o.commission)),
        outlay: sum(orders.map(o => o.outlay)),
        deposits: depositTotal,
        transfer: sum(transfers.map(t => t.transfer)),
        leftover: sum(orders.map(o => o.leftover)),
        orders: orders.filter(o => o.quantity > 0).length,
        // What the same orders would have cost at the broker's standard plan.
        feesSaved: sum(orders
            .filter(o => o.commissionFree && o.gross > 0)
            .map(o => feeFor(o.brokerId ? brokerById.get(o.brokerId) : undefined, o.gross).fee)),
    };

    return { orders, deposits, transfers, ignored, totals, monthKey };
};

/** True when an order can become a real transaction (sized, with a home). */
export const isRegisterableOrder = (order: FundingOrder): boolean =>
    order.quantity > 0 && !!order.price && !!order.brokerId && !!order.portfolioId;
