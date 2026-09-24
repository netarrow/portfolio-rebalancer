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
 *    rather than guessed at;
 *  - the bank fee on the wire itself is estimated but never added to the wire:
 *    it is charged on the sending side, which this app does not model.
 *
 * A category may also name a whole portfolio rather than one asset; the money
 * is then spread over that portfolio's own targets (see utils/ynabPortfolioSplit)
 * and each resulting slice enters the same order pipeline as any other.
 */
import type {
    AssetDefinition,
    Broker,
    FreeCommissionPeriod,
    Portfolio,
    Transaction,
    VirtualBond,
    YnabCategory,
    YnabCategoryMapping,
    YnabFundingSettings,
    YnabGoal,
    YnabGoalAllocation,
} from '../types';
import { calculateAssets, calculateCommission } from './portfolioCalculations';
import { splitPortfolioBudget, type PortfolioSplitReason } from './ynabPortfolioSplit';
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
    /** Set when the category funded a whole portfolio and this is its slice. */
    viaPortfolio?: string;
    /** Account this money leaves from, per the category's mapping. */
    sourceBrokerId?: string;
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
    /**
     * € to add to this order's budget to fit one more whole unit (or bond lot),
     * commission included. Absent when the size is not rounded, when there is no
     * price, or when nothing would be gained. This is the figure to look at
     * before deciding to wire a little more than the plan asks.
     */
    topUpForNextUnit?: number;
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
    | 'unknown-broker'     // orders with no broker: the wire cannot be addressed
    | 'earmark-shortfall'  // the broker's usable cash is held back by other portfolios
    | 'costly-transfer'    // the bank fee on the wire is a large slice of it
    | 'unknown-source';    // no source account named: nothing pays the fee

/** One wire: money leaving one account for the broker of its transfer. */
export interface FundingTransferLeg {
    sourceBrokerId?: string;
    sourceBrokerName: string;
    amount: number;
    /** Fee of the SOURCE account's own plan — the sender pays it. */
    cost: number;
}

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
    /** The accounts this wire actually leaves from, one leg each. */
    legs: FundingTransferLeg[];
    /** Bank fee on this wire: the sum of its legs, charged by the senders. */
    cost: number;
    /** cost as a % of the wire, 0 when nothing is wired. */
    costPercent: number;
    warnings: FundingTransferWarning[];
}

/** What one account has to send out, and whether it can afford to. */
export interface FundingSourceAccount {
    brokerId?: string;
    brokerName: string;
    /** € wired out of this account across every destination. */
    amountOut: number;
    /** Fees this account's own plan charges on those wires. */
    cost: number;
    /** amountOut + cost: what actually leaves the balance. */
    totalOut: number;
    currentLiquidity: number;
    minLiquidity: number;
    /** Cash reserved here for portfolios, which the wires must not eat into. */
    earmarked: number;
    /** currentLiquidity − minLiquidity − earmarked, floored at 0. */
    availableCash: number;
    /** availableCash − totalOut; negative means the account is short. */
    remaining: number;
    /** 'insufficient' = this account cannot cover what it is asked to send. */
    warnings: ('insufficient' | 'unknown-source')[];
}

/** A mapped category whose money never reaches the plan, and why. */
export interface FundingIgnored {
    categoryId: string;
    categoryName: string;
    amount: number;
    /** 'not-placed' = a portfolio split could not put this money anywhere. */
    reason: 'no-funds' | 'category-missing' | 'not-placed';
    /** Why the split placed nothing, on a 'not-placed' row. */
    splitReason?: PortfolioSplitReason;
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
    /** Σ of the bank fees on those wires — paid on the sending side. */
    transferCost: number;
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
    /** One row per account the money leaves from. */
    sources: FundingSourceAccount[];
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
    /** Read by a portfolio destination: an amount-mode portfolio targets these. */
    goalAllocations?: YnabGoalAllocation[];
    goals?: YnabGoal[];
    virtualBonds?: VirtualBond[];
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

/**
 * € the bank charges to wire `amount` to this broker. A broker with no transfer
 * cost configured is treated as free — saying "I do not know" here would only
 * add a number nobody asked for.
 */
export const transferCostFor = (broker: Broker | undefined, amount: number): number => {
    const cost = broker?.transferCost;
    if (!cost || cost.type === 'free' || !(amount > 0)) return 0;
    if (cost.type === 'fixed') return roundCents(Math.max(0, cost.fixed ?? 0));
    let fee = amount * (Math.max(0, cost.percent ?? 0) / 100);
    if (cost.min !== undefined) fee = Math.max(fee, cost.min);
    if (cost.max !== undefined) fee = Math.min(fee, cost.max);
    return roundCents(Math.max(0, fee));
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
}): { quantity: number; gross: number; commission: number; hasPlan: boolean; topUpForNextUnit?: number } => {
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

    // What one more lot would cost over the budget — the "is it worth wiring a
    // bit more?" figure. The fee is recomputed at the larger size, since a
    // percent plan charges more on a bigger trade.
    const nextGross = roundCents((lots + 1) * lotCost);
    const nextTotal = settings.feesFromBudget ? roundCents(nextGross + fee(nextGross).fee) : nextGross;
    const topUp = roundCents(Math.max(0, nextTotal - budget));

    return {
        quantity: lots * lotUnits,
        gross,
        commission: lots > 0 ? priced.fee : 0,
        hasPlan: priced.hasPlan,
        topUpForNextUnit: topUp > 0 ? topUp : undefined,
    };
};

/**
 * Builds the whole plan: the orders, the cash top-ups, the wire per broker and
 * the totals. Pure — every figure is derived from the input.
 */
export const buildYnabFundingPlan = (input: YnabFundingPlanInput): YnabFundingPlan => {
    const {
        categories, mappings, brokers, portfolios, assetSettings, prices,
        transactions = [], freeCommissionPeriods = [], settings,
        goalAllocations = [], goals = [], virtualBonds = [],
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

    /** Adds money to the order for this ticker/broker/portfolio, creating it if new. */
    const addToDraft = (
        ticker: string,
        brokerId: string | undefined,
        portfolioId: string | undefined,
        amount: number,
        source: FundingSource,
    ) => {
        const id = `${ticker.toUpperCase()}|${brokerId ?? ''}|${portfolioId ?? ''}`;
        const draft = drafts.get(id) ?? { ticker, brokerId, portfolioId, budget: 0, sources: [] };
        draft.budget = roundCents(draft.budget + amount);
        draft.sources.push(source);
        drafts.set(id, draft);
    };

    // A portfolio's holdings are needed to know how far each of its rows is
    // from target. Computed once per portfolio, however many categories fund it.
    const holdingsCache = new Map<string, ReturnType<typeof calculateAssets>['assets']>();
    const holdingsOf = (portfolioId: string) => {
        const cached = holdingsCache.get(portfolioId);
        if (cached) return cached;
        const { assets } = calculateAssets(
            transactions.filter(t => t.portfolioId === portfolioId),
            assetSettings,
            prices as Record<string, { price: number; lastUpdated: string }>,
        );
        holdingsCache.set(portfolioId, assets);
        return assets;
    };

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
            // The category's own account, or the plan's default one.
            sourceBrokerId: mapping.sourceBrokerId ?? settings.defaultSourceBrokerId,
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

        // A whole portfolio as the destination: its own targets decide what the
        // money buys, and each slice becomes an ordinary order from here on.
        if (mapping.target.kind === 'portfolio') {
            const portfolioId = mapping.target.portfolioId;
            const portfolio = portfolioById.get(portfolioId);
            if (!portfolio) {
                ignored.push({ categoryId: category.id, categoryName: category.name, amount, reason: 'not-placed', splitReason: 'no-targets' });
                continue;
            }
            const split = splitPortfolioBudget({
                portfolio,
                budget: amount,
                assets: holdingsOf(portfolioId),
                marketData: prices as Record<string, { price: number }>,
                assetSettings,
                goalAllocations,
                goals,
                virtualBonds,
            });
            for (const line of split.lines) {
                const brokerId = mapping.target.brokerId
                    ?? portfolio.preferredBrokerId
                    ?? lastBrokerForTicker(transactions, line.ticker);
                addToDraft(line.ticker, brokerId, portfolioId, line.eur, {
                    ...source,
                    amount: line.eur,
                    viaPortfolio: portfolio.name,
                });
            }
            // Money the split could not place is reported, never quietly dropped.
            if (split.leftover > 0) {
                ignored.push({
                    categoryId: category.id,
                    categoryName: category.name,
                    amount: split.leftover,
                    reason: 'not-placed',
                    splitReason: split.reason,
                });
            }
            continue;
        }

        const ticker = mapping.target.ticker;
        const portfolioId = mapping.target.portfolioId;
        const brokerId = mapping.target.brokerId
            ?? (portfolioId ? portfolioById.get(portfolioId)?.preferredBrokerId : undefined)
            ?? lastBrokerForTicker(transactions, ticker);
        addToDraft(ticker, brokerId, portfolioId, amount, source);
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
            topUpForNextUnit: sized.topUpForNextUnit,
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

        // Who sends the money: the accounts behind the categories that fund this
        // broker, each taking the share of the wire its categories contribute.
        // An account cannot wire to itself, so money already sitting at the
        // destination funds nothing — it is what `usableCash` above counts.
        const contributions = new Map<string | undefined, number>();
        const contributors = [
            ...brokerOrders.flatMap(o => o.sources),
            ...deposits.filter(d => d.brokerId === brokerId).flatMap(d => d.sources),
        ];
        for (const c of contributors) {
            const from = c.sourceBrokerId === brokerId ? undefined : c.sourceBrokerId;
            contributions.set(from, roundCents((contributions.get(from) ?? 0) + c.amount));
        }
        const contributed = [...contributions.values()].reduce((s, v) => s + v, 0);

        const legs: FundingTransferLeg[] = transfer <= 0 ? [] : [...contributions.entries()]
            .map(([sourceBrokerId, share]) => {
                const amount = contributed > 0
                    ? roundCents(transfer * (share / contributed))
                    : roundCents(transfer);
                const sourceBroker = sourceBrokerId ? brokerById.get(sourceBrokerId) : undefined;
                return {
                    sourceBrokerId,
                    sourceBrokerName: sourceBroker?.name ?? 'Unnamed account',
                    amount,
                    cost: transferCostFor(sourceBroker, amount),
                };
            })
            .filter(leg => leg.amount > 0)
            .sort((a, b) => b.amount - a.amount);

        // Rounding the shares can lose or gain a cent against the wire itself.
        const legTotal = roundCents(legs.reduce((s, l) => s + l.amount, 0));
        if (legs.length > 0 && legTotal !== transfer) {
            legs[0].amount = roundCents(legs[0].amount + (transfer - legTotal));
            legs[0].cost = transferCostFor(
                legs[0].sourceBrokerId ? brokerById.get(legs[0].sourceBrokerId) : undefined,
                legs[0].amount,
            );
        }

        const cost = roundCents(legs.reduce((s, l) => s + l.cost, 0));
        const costPercent = transfer > 0 ? (cost / transfer) * 100 : 0;

        const warnings: FundingTransferWarning[] = [];
        if (!broker) warnings.push('unknown-broker');
        if (settings.useBrokerCash && earmarkedElsewhere > 0 && currentLiquidity - minLiquidity > usableCash) {
            warnings.push('earmark-shortfall');
        }
        if (legs.some(l => !l.sourceBrokerId)) warnings.push('unknown-source');
        // Same yardstick as a trade commission: a wire that costs more than the
        // configured share of itself is worth batching instead of repeating.
        if (cost > 0 && costPercent > settings.feeWarnPercent) warnings.push('costly-transfer');

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
            legs,
            cost,
            costPercent,
            warnings,
        };
    }).sort((a, b) => (b.transfer - a.transfer) || a.brokerName.localeCompare(b.brokerName));

    // ── What leaves each account ────────────────────────────────────────
    // The mirror image of the wires: one row per sending account, so a plan
    // that drains a current account says so before the money moves.
    const sourceIds: (string | undefined)[] = [];
    for (const t of transfers) {
        for (const leg of t.legs) if (!sourceIds.includes(leg.sourceBrokerId)) sourceIds.push(leg.sourceBrokerId);
    }

    const sources: FundingSourceAccount[] = sourceIds.map(brokerId => {
        const broker = brokerId ? brokerById.get(brokerId) : undefined;
        const legs = transfers.flatMap(t => t.legs.filter(l => l.sourceBrokerId === brokerId));
        const amountOut = roundCents(legs.reduce((s, l) => s + l.amount, 0));
        const cost = roundCents(legs.reduce((s, l) => s + l.cost, 0));
        const totalOut = roundCents(amountOut + cost);

        const currentLiquidity = broker?.currentLiquidity ?? 0;
        const minLiquidity = broker ? roundCents(minLiquidityOf(broker)) : 0;
        // Whatever this account reserves for a portfolio is not free to leave.
        const earmarked = roundCents(Object.values(broker?.liquidityAllocations || {})
            .reduce((s, v) => s + (v || 0), 0));
        const availableCash = roundCents(Math.max(0, currentLiquidity - minLiquidity - earmarked));

        const warnings: FundingSourceAccount['warnings'] = [];
        if (!broker) warnings.push('unknown-source');
        else if (totalOut > availableCash) warnings.push('insufficient');

        return {
            brokerId,
            brokerName: broker?.name ?? 'Unnamed account',
            amountOut, cost, totalOut,
            currentLiquidity, minLiquidity, earmarked, availableCash,
            remaining: roundCents(availableCash - totalOut),
            warnings,
        };
    }).sort((a, b) => b.totalOut - a.totalOut);

    const sum = (values: number[]) => roundCents(values.reduce((s, v) => s + v, 0));
    const depositTotal = sum(deposits.map(d => d.amount));
    const totals: FundingTotals = {
        budget: sum([
            ...orders.map(o => o.budget),
            ...ignored.filter(i => i.reason === 'not-placed').map(i => i.amount),
            depositTotal,
        ]),
        gross: sum(orders.map(o => o.gross)),
        commission: sum(orders.map(o => o.commission)),
        outlay: sum(orders.map(o => o.outlay)),
        deposits: depositTotal,
        transfer: sum(transfers.map(t => t.transfer)),
        transferCost: sum(transfers.map(t => t.cost)),
        // Includes what a portfolio split could not place, so budget still
        // equals gross + commission + leftover (+ deposits).
        leftover: sum([
            ...orders.map(o => o.leftover),
            ...ignored.filter(i => i.reason === 'not-placed').map(i => i.amount),
        ]),
        orders: orders.filter(o => o.quantity > 0).length,
        // What the same orders would have cost at the broker's standard plan.
        feesSaved: sum(orders
            .filter(o => o.commissionFree && o.gross > 0)
            .map(o => feeFor(o.brokerId ? brokerById.get(o.brokerId) : undefined, o.gross).fee)),
    };

    return { orders, deposits, transfers, sources, ignored, totals, monthKey };
};

/** True when an order can become a real transaction (sized, with a home). */
export const isRegisterableOrder = (order: FundingOrder): boolean =>
    order.quantity > 0 && !!order.price && !!order.brokerId && !!order.portfolioId;

/** What registering a plan writes: the buy transactions and the cash each broker gains or loses. */
export interface FundingCommit {
    transactions: Transaction[];
    /** brokerId → € added to (positive) or taken from (negative) its liquidity. */
    liquidityDeltas: Record<string, number>;
    /** Orders left out because they cannot become a transaction yet. */
    skipped: number;
}

/**
 * The single definition of what "Register" does, shared by the context and by
 * the before/after preview — so the preview is the registered state, not an
 * approximation of it.
 *
 * A wire has two ends: the money lands at the destination and leaves the
 * account that sent it, which also pays the bank's fee out of its own balance.
 * An account the plan could not name sends nothing here — there is no balance
 * to debit.
 */
export const buildFundingCommit = (
    orders: FundingOrder[],
    opts: { date: string; stamp: number | string; creditTransfers?: FundingTransfer[] },
): FundingCommit => {
    const registerable = orders.filter(isRegisterableOrder);

    const transactions: Transaction[] = registerable.map((order, i) => ({
        id: `${YNAB_FUNDING_TX_PREFIX}${opts.stamp}-${i}`,
        ticker: order.ticker,
        amount: order.quantity,
        price: order.price as number,
        date: opts.date,
        direction: 'Buy',
        portfolioId: order.portfolioId,
        brokerId: order.brokerId,
        freeCommission: order.commission === 0 ? true : undefined,
    }));

    const liquidityDeltas: Record<string, number> = {};
    const move = (brokerId: string, amount: number) => {
        liquidityDeltas[brokerId] = roundCents((liquidityDeltas[brokerId] ?? 0) + amount);
    };
    for (const transfer of opts.creditTransfers ?? []) {
        if (transfer.brokerId && transfer.transfer > 0) move(transfer.brokerId, transfer.transfer);
        for (const leg of transfer.legs) {
            if (leg.sourceBrokerId) move(leg.sourceBrokerId, -(leg.amount + leg.cost));
        }
    }
    for (const order of registerable) {
        if (order.brokerId) move(order.brokerId, -order.outlay);
    }

    return { transactions, liquidityDeltas, skipped: orders.length - registerable.length };
};
