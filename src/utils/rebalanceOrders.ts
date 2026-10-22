import {
    calculateAssets,
    injectCashAssets,
    isCashTicker,
    isGroupKey,
} from './portfolioCalculations';
import {
    distributeGroupDelta,
    largestRemainderBuyOnly,
    buyRecipientOf,
    memberInfoFromAssets,
    groupWeightConfig,
    isFullyFrozen,
    type BuyOnlyCandidate,
    type GroupDistribution,
    type MemberAction,
    type ResolvedGroups,
} from './allocationGroups';
import {
    computeSellFriction,
    buyBudgetScale,
    scaledBuyShares,
    resolveAssetClass,
    projectBrokerCash,
    type CashProjection,
    type SellFriction,
    type SellLeg,
} from './rebalanceCosts';
import type { Portfolio, Transaction, AssetDefinition, Broker, Asset } from '../types';

/**
 * A portfolio's rebalance orders, Full or Buy only: the plans the Dashboard
 * Action / Buy Only columns show, and the transactions they turn into. Shared
 * by the Dashboard and the Operations page so both execute the same orders.
 */

export interface PortfolioCalc {
    portfolio: Portfolio;
    assets: Asset[];
    summary: ReturnType<typeof calculateAssets>['summary'];
    totalValue: number;
    cashAssetsValue: number;
    transactions: Transaction[];
}

/** Assets, totals and broker cash of one portfolio, as the Dashboard computes them. */
export const buildPortfolioCalc = (
    portfolio: Portfolio,
    allTransactions: Transaction[],
    assetSettings: AssetDefinition[],
    marketData: Record<string, { price: number; lastUpdated: string }>,
    brokers: Broker[],
): PortfolioCalc => {
    const transactions = allTransactions.filter(t => t.portfolioId === portfolio.id);
    const { assets: rawAssets, summary } = calculateAssets(transactions, assetSettings, marketData);
    const assets = injectCashAssets(rawAssets, brokers, portfolio.id);
    const cashAssetsValue = assets.filter(a => isCashTicker(a.ticker)).reduce((s, a) => s + a.currentValue, 0);
    return { portfolio, assets, summary, totalValue: summary.totalValue + cashAssetsValue, cashAssetsValue, transactions };
};

export interface BuyOnlyPlan {
    /** unit key (standalone ticker or groupId) -> euro to deploy */
    byUnit: Record<string, number>;
    /** ticker (UPPERCASE) -> member buy action, for tickers bought through their group */
    memberBuy: Record<string, MemberAction>;
}

export const EMPTY_BUY_ONLY: BuyOnlyPlan = { byUnit: {}, memberBuy: {} };

export function computeBuyOnly(
    pc: PortfolioCalc,
    resolved: ResolvedGroups,
    marketData: Record<string, { price: number; lastUpdated: string }>,
): BuyOnlyPlan {
    const liq = pc.portfolio.liquidity || 0;
    if (liq <= 0) return EMPTY_BUY_ONLY;
    const allocations = pc.portfolio.allocations || {};
    const { tickerToGroupId, groupById } = resolved;
    // Buy-Only deploys portfolio.liquidity, so its target base is the
    // portfolio total plus that cash (the total itself excludes it).
    const targetBase = pc.totalValue + liq;

    const candidates: BuyOnlyCandidate[] = [];

    // Standalone tickers: group members compete through their group, not alone.
    const unitKeys = new Set<string>([
        ...pc.assets.map(a => a.ticker),
        ...Object.keys(allocations),
    ]);
    unitKeys.forEach(ticker => {
        if (isCashTicker(ticker) || isGroupKey(ticker) || tickerToGroupId[ticker.toUpperCase()]) return;
        const asset = pc.assets.find(a => a.ticker === ticker);
        const currentValue = asset?.currentValue || 0;
        const price = asset?.currentPrice || 0;
        const targetPerc = allocations[ticker] || 0;
        const gap = targetBase * (targetPerc / 100) - currentValue;
        candidates.push({ key: ticker, gap, price });
    });

    // Groups — one candidate each, same pricing as the single-portfolio view:
    // priority groups at the buy-recipient member, weighted groups at the
    // cheapest buy-eligible active member (invalid weighted setups are skipped).
    Object.values(groupById).forEach(group => {
        const memberInfo = memberInfoFromAssets(group.members, pc.assets, marketData);
        const wcfg = groupWeightConfig(group.members, group.memberRules);
        let price: number | undefined;
        if (wcfg.weighted) {
            if (!wcfg.valid) return;
            group.members.forEach(m => {
                const rule = group.memberRules?.[m] ?? group.memberRules?.[m.toUpperCase()] ?? {};
                if (isFullyFrozen(rule) || rule.noBuy) return;
                const mi = memberInfo[m.toUpperCase()];
                if (mi && mi.price > 0 && (price === undefined || mi.price < price)) price = mi.price;
            });
        } else {
            price = buyRecipientOf(group, memberInfo)?.price;
        }
        if (price === undefined) return;
        const currentValue = Object.values(memberInfo).reduce((s, mi) => s + mi.currentValue, 0);
        const gap = targetBase * (((allocations[group.id] || 0)) / 100) - currentValue;
        candidates.push({ key: group.id, gap, price });
    });

    const byUnit = largestRemainderBuyOnly(candidates, liq);

    // Route each group's assigned euro to its member buy action(s).
    const memberBuy: Record<string, MemberAction> = {};
    Object.values(groupById).forEach(group => {
        const euro = byUnit[group.id] || 0;
        if (euro <= 0) return;
        const memberInfo = memberInfoFromAssets(group.members, pc.assets, marketData);
        const dist = distributeGroupDelta({ deltaEur: euro, members: group.members, memberInfo, rules: group.memberRules });
        Object.values(dist.actions).forEach(a => { memberBuy[a.ticker.toUpperCase()] = a; });
    });

    return { byUnit, memberBuy };
}

export interface FullRebalancePlan {
    /** standalone ticker -> netted action in whole shares (signed: + buy, − sell) */
    standalone: Record<string, { shares: number; amount: number }>;
    /** groupId -> netted member distribution */
    groupDist: Record<string, GroupDistribution>;
    friction: SellFriction;
    /** fraction of the gross buys that survives the sell-side friction */
    scale: number;
    grossBuyTotal: number;
    /** what the netted buy legs actually cost */
    netBuyTotal: number;
    /** portfolio total once tax and fees have left the account */
    postTotal: number;
    /** cash left at the portfolio's broker — null in multi-broker mode */
    cash: CashProjection | null;
}

/**
 * Full-rebalance plan for one portfolio, netted for sell-side friction.
 *
 * Selling X does not free X euro of cash: the broker settles the sale minus
 * capital-gains tax on the sold portion (26% / 12.5% by asset class) and minus
 * its own sell commission. So the gross plan is priced first, then the BUY legs
 * are re-sized on what the sales actually credit — otherwise the orders cost
 * more than the account receives and settlement goes short. Sells are never
 * re-sized: the target allocation decides what has to go.
 *
 * With a preferred broker the whole plan is priced against that one commission
 * plan and checked against its cash; without one (multi-broker portfolios) the
 * broker is guessed per ticker from its last transaction and no cash check is
 * possible, since the legs may settle at different brokers.
 */
export function computeFullRebalance(
    pc: PortfolioCalc,
    resolved: ResolvedGroups,
    marketData: Record<string, { price: number; lastUpdated: string }>,
    assetSettings: AssetDefinition[],
    brokers: Broker[],
    preferredBroker?: Broker,
): FullRebalancePlan {
    const allocations = pc.portfolio.allocations || {};
    const { tickerToGroupId, groupById } = resolved;

    const sellLegFor = (ticker: string, shares: number, price: number): SellLeg | null => {
        const asset = pc.assets.find(a => a.ticker.toUpperCase() === ticker.toUpperCase());
        if (!asset || shares <= 0 || price <= 0) return null;
        const tickerTxs = pc.transactions.filter(t => t.ticker === ticker);
        const lastBrokerId = tickerTxs[tickerTxs.length - 1]?.brokerId;
        return {
            ticker,
            shares,
            price,
            averagePrice: asset.averagePrice,
            assetClass: resolveAssetClass(asset, assetSettings),
            broker: preferredBroker
                ?? brokers.find(b => b.id === lastBrokerId)
                ?? (brokers.length === 1 ? brokers[0] : undefined),
        };
    };

    // Pass 1 — gross legs. Standalone tickers only; group members trade through
    // their group (treating them as standalone with target 0 would sell them off).
    const unitKeys = new Set<string>([...pc.assets.map(a => a.ticker), ...Object.keys(allocations)]);
    const standaloneLegs: { ticker: string; price: number; shares: number }[] = [];
    unitKeys.forEach(ticker => {
        if (isCashTicker(ticker) || isGroupKey(ticker) || tickerToGroupId[ticker.toUpperCase()]) return;
        const asset = pc.assets.find(a => a.ticker === ticker);
        const price = asset?.currentPrice || 0;
        const targetPerc = allocations[ticker] || 0;
        if (price <= 0 || ((asset?.quantity || 0) <= 0 && targetPerc <= 0)) return;
        const shares = Math.round((pc.totalValue * (targetPerc / 100) - (asset?.currentValue || 0)) / price);
        if (shares !== 0) standaloneLegs.push({ ticker, price, shares });
    });

    const groups = Object.values(groupById).map(group => {
        const memberInfo = memberInfoFromAssets(group.members, pc.assets, marketData);
        const currentValue = Object.values(memberInfo).reduce((s, mi) => s + mi.currentValue, 0);
        const delta = pc.totalValue * ((allocations[group.id] || 0) / 100) - currentValue;
        return { group, memberInfo, delta, dist: distributeGroupDelta({ deltaEur: delta, members: group.members, memberInfo, rules: group.memberRules }) };
    });

    // Pass 2 — price every sale, then shrink the buy side by what they cost.
    const sellLegs = [
        ...standaloneLegs.filter(l => l.shares < 0).map(l => sellLegFor(l.ticker, -l.shares, l.price)),
        ...groups.flatMap(g =>
            Object.values(g.dist.actions)
                .filter(a => a.shares < 0)
                .map(a => sellLegFor(a.ticker, -a.shares, g.memberInfo[a.ticker.toUpperCase()]?.price || 0))
        ),
    ].filter((l): l is SellLeg => l !== null);

    const friction = computeSellFriction(sellLegs);
    const grossBuyTotal =
        standaloneLegs.filter(l => l.shares > 0).reduce((s, l) => s + l.shares * l.price, 0) +
        groups.reduce((s, g) => s + Object.values(g.dist.actions).filter(a => a.shares > 0).reduce((t, a) => t + a.eur, 0), 0);
    const scale = buyBudgetScale(grossBuyTotal, friction.total);

    const standalone: Record<string, { shares: number; amount: number }> = {};
    standaloneLegs.forEach(l => {
        const shares = l.shares > 0 ? scaledBuyShares(l.shares, scale) : l.shares;
        if (shares !== 0) standalone[l.ticker] = { shares, amount: shares * l.price };
    });

    // Groups re-run their own distribution on the scaled delta, so member rules
    // (priority, frozen members, weights) keep deciding who actually trades.
    const groupDist: Record<string, GroupDistribution> = {};
    groups.forEach(g => {
        groupDist[g.group.id] = (scale < 1 && g.delta > 0)
            ? distributeGroupDelta({ deltaEur: g.delta * scale, members: g.group.members, memberInfo: g.memberInfo, rules: g.group.memberRules })
            : g.dist;
    });

    // Netted buy legs, for the cash projection.
    const buys = [
        ...standaloneLegs
            .filter(l => l.shares > 0)
            .map(l => ({ shares: scaledBuyShares(l.shares, scale), price: l.price })),
        ...groups.flatMap(g =>
            Object.values(groupDist[g.group.id]?.actions ?? {})
                .filter(a => a.shares > 0)
                .map(a => ({ shares: a.shares, price: g.memberInfo[a.ticker.toUpperCase()]?.price || 0 }))
        ),
    ].filter(b => b.shares > 0 && b.price > 0);
    const netBuyTotal = buys.reduce((s, b) => s + b.shares * b.price, 0);

    const cash = preferredBroker
        ? projectBrokerCash({ broker: preferredBroker, portfolioId: pc.portfolio.id, friction, buys })
        : null;

    return { standalone, groupDist, friction, scale, grossBuyTotal, netBuyTotal, postTotal: pc.totalValue - friction.total, cash };
}

/** The transactions a Full or Buy only rebalance creates, as the Action / Buy Only columns show them. */
export const buildRebalanceOrders = (input: {
    mode: 'Full' | 'BuyOnly';
    portfolioCalc: PortfolioCalc;
    resolved: ResolvedGroups;
    marketData: Record<string, { price: number; lastUpdated: string }>;
    buyOnly: BuyOnlyPlan;
    fullRebalance?: FullRebalancePlan;
    allTransactions: Transaction[];
    preferredBroker?: Broker;
    date?: string;
}): Transaction[] => {
    const { mode, portfolioCalc, resolved, marketData, buyOnly, fullRebalance, allTransactions, preferredBroker } = input;
    const { portfolio, assets } = portfolioCalc;
    const allocations = portfolio.allocations || {};
    const date = input.date ?? new Date().toISOString().split('T')[0];
    const toCreate: Transaction[] = [];
    const { tickerToGroupId, groupById } = resolved;
    const pushTx = (ticker: string, shares: number, price: number) => {
        if (shares === 0 || price <= 0) return;
        const lastTx = allTransactions
            .filter(t => t.ticker === ticker && t.portfolioId === portfolio.id)
            .pop();
        toCreate.push({
            id: `auto-rebal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            portfolioId: portfolio.id,
            ticker,
            date,
            amount: Math.abs(shares),
            price,
            direction: shares > 0 ? 'Buy' : 'Sell',
            // The declared broker wins: it priced the commissions and the cash
            // check, so the recorded trade has to hit the same account.
            brokerId: preferredBroker?.id ?? lastTx?.brokerId,
        });
    };

    // Standalone tickers. Group members are traded through their group
    // below — treating them as standalone (target 0) would sell them off.
    const unitKeys = new Set<string>([
        ...assets.map(a => a.ticker),
        ...Object.keys(allocations),
    ]);
    unitKeys.forEach(ticker => {
        if (isCashTicker(ticker) || isGroupKey(ticker) || tickerToGroupId[ticker.toUpperCase()]) return;
        const asset = assets.find(a => a.ticker === ticker);
        const price = asset?.currentPrice || 0;
        const targetPerc = allocations[ticker] || 0;
        const quantity = asset?.quantity || 0;
        if (quantity <= 0 && targetPerc <= 0) return;

        let shares = 0;
        if (mode === 'Full') {
            // Netted plan (buys already sized on what the sells settle for),
            // so the orders created match the Action column exactly.
            shares = fullRebalance?.standalone[ticker]?.shares ?? 0;
        } else {
            const buyAmt = buyOnly.byUnit[ticker] || 0;
            if (price > 0) shares = Math.round(buyAmt / price);
        }
        pushTx(ticker, shares, price);
    });

    // Allocation groups: Full distributes the group delta by member rules;
    // Buy Only uses the member buys already routed by the buy-only plan.
    Object.values(groupById).forEach(group => {
        const memberInfo = memberInfoFromAssets(group.members, assets, marketData);
        let actions: MemberAction[];
        if (mode === 'Full') {
            actions = Object.values(fullRebalance?.groupDist[group.id]?.actions ?? {});
        } else {
            actions = group.members
                .map(m => buyOnly.memberBuy[m.toUpperCase()])
                .filter((a): a is MemberAction => !!a);
        }
        actions.forEach(a => pushTx(a.ticker, a.shares, memberInfo[a.ticker.toUpperCase()]?.price || 0));
    });
    return toCreate;
};
