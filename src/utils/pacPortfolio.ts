// PAC plans that buy a whole portfolio instead of one asset: each
// installment's amount is spread over the portfolio's assets by its target
// quotas, the same way the Dashboard's Buy only column deploys cash
// (underweight assets first, in proportion to how far below target they are).
// Pure logic, no React — see scripts/verify-pac-portfolio.ts.
import type { AssetDefinition, Broker, PacPlan, Portfolio, PriceHistoryMap, Transaction } from '../types';
import { isCashTicker, isGroupKey } from './portfolioCalculations';
import { buyRecipientOf, distributeGroupDelta, memberInfoFromAssets, resolveGroups } from './allocationGroups';
import { buildPortfolioCalc, buildRebalanceOrders, computeBuyOnly } from './rebalanceOrders';
import { estimateFee } from './pacSchedule';
import { priceAtDetailed } from './priceHistory';

type MarketData = Record<string, { price: number; lastUpdated: string }>;

const roundCents = (v: number): number => Math.round(v * 100) / 100;
const roundQty = (v: number): number => Math.round(v * 1e6) / 1e6;

export const isPortfolioPac = (plan: Pick<PacPlan, 'target'>): boolean => plan.target === 'portfolio';

/** What a plan buys, in a few words: the ticker, or "Portfolio <name>". */
export const pacSubject = (plan: PacPlan, portfolios: Portfolio[]): string =>
    isPortfolioPac(plan)
        ? `Portfolio ${portfolios.find(p => p.id === plan.portfolioId)?.name ?? '—'}`
        : plan.ticker;

export interface PacOrder {
    ticker: string;
    quantity: number;
    price: number;
    tradeValue: number;
    fee: number;
}

export interface PortfolioInstalment {
    orders: PacOrder[];
    /** amount + carryIn: what this installment may spend, fees included or not. */
    budget: number;
    invested: number;
    fees: number;
    totalOutlay: number;
    carryIn: number;
    /** Left uninvested (whole-unit rounding), parked on the broker for the portfolio. */
    carryOut: number;
    parkedDelta: number;
}

interface Row { ticker: string; price: number; eur: number }

/**
 * Fractional split: every euro is invested. Each unit (standalone ticker or
 * allocation group) gets a share proportional to its underweight gap once the
 * new money is in; with nothing underweight, proportional to its target. A
 * group's share goes to its members the way the group's own rules route a buy.
 */
const fractionalRows = (portfolio: Portfolio, pc: ReturnType<typeof buildPortfolioCalc>, marketData: MarketData, budget: number): Row[] => {
    const allocations = portfolio.allocations || {};
    const resolved = resolveGroups(portfolio);
    const base = pc.totalValue + budget;
    const units: { key: string; gap: number; target: number; price?: number; group?: string }[] = [];

    Object.entries(allocations).forEach(([key, target]) => {
        if (!(target > 0) || isCashTicker(key)) return;
        if (isGroupKey(key)) {
            const group = resolved.groupById[key];
            if (!group) return;
            const info = memberInfoFromAssets(group.members, pc.assets, marketData);
            if (!buyRecipientOf(group, info)) return;
            const value = Object.values(info).reduce((s, m) => s + m.currentValue, 0);
            units.push({ key, gap: base * target / 100 - value, target, group: key });
            return;
        }
        if (resolved.tickerToGroupId[key.toUpperCase()]) return;
        const asset = pc.assets.find(a => a.ticker === key);
        const price = asset?.currentPrice || marketData[key]?.price || marketData[key.toUpperCase()]?.price || 0;
        if (!(price > 0)) return;
        units.push({ key, gap: base * target / 100 - (asset?.currentValue || 0), target, price });
    });

    const totalGap = units.reduce((s, u) => s + Math.max(0, u.gap), 0);
    const totalTarget = units.reduce((s, u) => s + u.target, 0);
    const weight = (u: (typeof units)[number]) => totalGap > 0 ? Math.max(0, u.gap) / totalGap : u.target / totalTarget;
    if (totalGap <= 0 && totalTarget <= 0) return [];

    const rows: Row[] = [];
    units.forEach(u => {
        const eur = budget * weight(u);
        if (eur <= 0) return;
        if (!u.group) { rows.push({ ticker: u.key, price: u.price!, eur }); return; }
        const group = resolved.groupById[u.group];
        const info = memberInfoFromAssets(group.members, pc.assets, marketData);
        const buys = Object.values(distributeGroupDelta({ deltaEur: eur, members: group.members, memberInfo: info, rules: group.memberRules }).actions)
            .filter(a => a.eur > 0);
        const sum = buys.reduce((s, a) => s + a.eur, 0);
        if (sum > 0) {
            buys.forEach(a => rows.push({ ticker: a.ticker, price: info[a.ticker.toUpperCase()]?.price || 0, eur: eur * a.eur / sum }));
        } else {
            // Too little for a whole share of anything: the group's buy recipient takes it.
            const r = buyRecipientOf(group, info)!;
            rows.push({ ticker: r.ticker, price: r.price, eur });
        }
    });
    return rows.filter(r => r.price > 0);
};

/** Whole-unit split: exactly the Buy only orders for that cash. */
const wholeRows = (portfolio: Portfolio, transactions: Transaction[], assetSettings: AssetDefinition[], marketData: MarketData, brokers: Broker[], budget: number): Row[] => {
    const p = { ...portfolio, liquidity: Math.max(0, budget) };
    const pc = buildPortfolioCalc(p, transactions, assetSettings, marketData, brokers);
    const resolved = resolveGroups(p);
    const buyOnly = computeBuyOnly(pc, resolved, marketData);
    return buildRebalanceOrders({ mode: 'BuyOnly', portfolioCalc: pc, resolved, marketData, buyOnly, allTransactions: transactions })
        .filter(o => o.direction === 'Buy')
        .map(o => ({ ticker: o.ticker, price: o.price, eur: o.amount * o.price }));
};

/**
 * One installment of a portfolio plan. `marketData` is the price list the
 * orders are sized on — pass due-date prices (marketDataAt) when recording.
 */
export const computePortfolioInstalment = (params: {
    plan: PacPlan;
    portfolio: Portfolio;
    carryIn: number;
    broker?: Broker;
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: MarketData;
    brokers: Broker[];
}): PortfolioInstalment => {
    const { plan, portfolio, carryIn, broker, transactions, assetSettings, marketData, brokers } = params;
    const budget = roundCents((plan.amount ?? 0) + carryIn);
    const fractional = plan.rounding === 'fractional';

    const split = (cash: number): PacOrder[] => {
        if (cash <= 0) return [];
        const rows = fractional
            ? fractionalRows(portfolio, buildPortfolioCalc(portfolio, transactions, assetSettings, marketData, brokers), marketData, cash)
            : wholeRows(portfolio, transactions, assetSettings, marketData, brokers, cash);
        // One order per ticker.
        const byTicker = new Map<string, Row>();
        rows.forEach(r => {
            const prev = byTicker.get(r.ticker);
            if (prev) prev.eur += r.eur; else byTicker.set(r.ticker, { ...r });
        });
        return [...byTicker.values()].map(r => {
            const quantity = fractional ? roundQty(r.eur / r.price) : Math.round(r.eur / r.price);
            const tradeValue = roundCents(quantity * r.price);
            return { ticker: r.ticker, quantity, price: r.price, tradeValue, fee: estimateFee(tradeValue, plan, broker) };
        }).filter(o => o.quantity > 0);
    };
    const feesOf = (orders: PacOrder[]) => roundCents(orders.reduce((s, o) => s + o.fee, 0));
    const spentOf = (orders: PacOrder[]) => roundCents(orders.reduce((s, o) => s + o.tradeValue, 0));

    let orders = split(budget);
    if (plan.costsIncluded) {
        // The fees come out of the amount: size again on what is left after them.
        orders = split(roundCents(budget - feesOf(orders)));
        // Whole units: a fee that grew with the new split may still overshoot — drop units until it fits.
        if (!fractional) {
            while (orders.length > 0 && spentOf(orders) + feesOf(orders) > budget + 0.005) {
                const biggest = [...orders].sort((a, b) => b.tradeValue - a.tradeValue)[0];
                biggest.quantity -= 1;
                biggest.tradeValue = roundCents(biggest.quantity * biggest.price);
                biggest.fee = estimateFee(biggest.tradeValue, plan, broker);
                orders = orders.filter(o => o.quantity > 0);
            }
        }
    }

    return summarizePortfolioInstalment(plan, orders, budget, carryIn);
};

/** Totals and residue of a set of orders (also used after the user edits them). */
export const summarizePortfolioInstalment = (plan: PacPlan, orders: PacOrder[], budget: number, carryIn: number): PortfolioInstalment => {
    const invested = roundCents(orders.reduce((s, o) => s + o.tradeValue, 0));
    const fees = roundCents(orders.reduce((s, o) => s + o.fee, 0));
    const left = budget - invested - (plan.costsIncluded ? fees : 0);
    const carryOut = plan.rounding === 'fractional' ? 0 : Math.max(0, roundCents(left));
    return {
        orders, budget, invested, fees,
        totalOutlay: roundCents(invested + fees),
        carryIn, carryOut,
        parkedDelta: roundCents(carryOut - carryIn),
    };
};

/**
 * `marketData` with each held or targeted ticker of the portfolio priced on
 * `dueDate` from the local history, where there is a point for it; the rest
 * keeps its latest price.
 */
export const marketDataAt = (marketData: MarketData, history: PriceHistoryMap, tickers: string[], dueDate: string): MarketData => {
    const out: MarketData = { ...marketData };
    tickers.forEach(t => {
        const p = priceAtDetailed(history[t.toUpperCase()], dueDate);
        if (p) out[t] = { price: p.price, lastUpdated: p.asOfDate };
    });
    return out;
};

/** Every ticker a portfolio plan may buy: the targets, group members included. */
export const portfolioPacTickers = (portfolio: Portfolio): string[] => {
    const resolved = resolveGroups(portfolio);
    const out = new Set<string>();
    Object.entries(portfolio.allocations || {}).forEach(([k, v]) => {
        if (!(v > 0) || isCashTicker(k)) return;
        if (isGroupKey(k)) resolved.groupById[k]?.members.forEach(m => out.add(m));
        else out.add(k);
    });
    return [...out];
};

/** "VWCE 2 × €110.00, AGGH 1.5 × €5.10" */
export const describePacOrders = (orders: { ticker: string; quantity: number; price: number }[], label: (t: string) => string = t => t): string =>
    orders.map(o => `${label(o.ticker)} ${o.quantity.toLocaleString('en-IE', { maximumFractionDigits: 4 })} × €${o.price.toFixed(2)}`).join(', ');
