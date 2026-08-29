import type { AssetDefinition, Broker, Portfolio, Transaction } from '../types';
import { isCashTicker } from './portfolioCalculations';
import { buildPortfolioTree, aggregateGroup, type PortfolioGroup } from './portfolioGroups';
import {
    buildMergedGroup,
    configuredShares,
    mergedRatio,
    routeOrder,
    type MemberValue,
    type MergedMemberRatio,
    type RatioSource,
} from './mergedGroup';

/**
 * Every parent/child group in the app collapsed into one portfolio, in a single
 * bundle.
 *
 * `mergedGroup.ts` can already fold ONE group into a synthetic portfolio; the
 * Dashboard has used it for a while. This lifts that to the whole portfolio
 * list, so the Fund Relocation planner, the goal pyramid and anything else that
 * wants to see a group as one thing can ask for the merged reading of the world
 * instead of re-deriving it.
 *
 * ── The rule that keeps the totals honest ───────────────────────────────────
 *
 * The bundle is a SUBSTITUTION, never an addition. Portfolios, transactions and
 * brokers come out together and must be used together: a member's transactions
 * are re-tagged onto the synthetic id (not copied), and its broker earmarks are
 * moved onto it (not duplicated). Mixing halves — merged portfolios alongside
 * the real transaction list, say — is the one way to get a wrong number here.
 *
 * It happens to fail safe: a `_MERGED_x` id matches no real transaction and no
 * real earmark, so a stray merged portfolio next to its members reads as an
 * empty row rather than a doubled one. Do not rely on that. Take the bundle
 * whole, and `verify-merged-portfolio-view.ts` asserts the invariants that say
 * you did: same total, same unassigned liquidity, same transactions, same
 * pyramid total.
 */

type MarketData = Record<string, { price: number; lastUpdated: string }>;

export interface MergedGroupInfo {
    /** Synthetic portfolio id (`_MERGED_<parentId>`). */
    id: string;
    parentId: string;
    /** Parent first, then children in order. */
    memberIds: string[];
    members: MergedMemberRatio[];
    ratioSource: RatioSource;
    /** unit key (standalone ticker or groupId) -> owning member portfolioId. */
    ownerByUnit: Record<string, string>;
    /** portfolioId -> ticker -> quantity held, for routing an order back. */
    quantityByMember: Record<string, Record<string, number>>;
    /** Members' values today, in `memberIds` order. */
    valueByMember: Record<string, number>;
}

export interface MergedPortfolioView {
    /** Merged groups plus every standalone portfolio — an exact partition. */
    portfolios: Portfolio[];
    /** Every transaction, with grouped members' re-tagged onto the group id. */
    transactions: Transaction[];
    /** Every broker, with grouped members' earmarks moved onto the group id. */
    brokers: Broker[];
    groups: MergedGroupInfo[];
    /** Synthetic group id -> its info. */
    groupById: Record<string, MergedGroupInfo>;
    /** Real member portfolio id -> the synthetic group id holding it. */
    groupIdByMember: Record<string, string>;
}

export const isMergedGroupId = (id: string, view: MergedPortfolioView): boolean =>
    Object.prototype.hasOwnProperty.call(view.groupById, id);

export interface BuildMergedPortfolioViewInput {
    portfolios: Portfolio[];
    transactions: Transaction[];
    brokers: Broker[];
    assetSettings: AssetDefinition[];
    marketData: MarketData;
}

/** Member values in the dashboard convention: invested + allocated broker cash. */
const memberValuesOf = (
    group: PortfolioGroup,
    input: BuildMergedPortfolioViewInput,
): MemberValue[] => {
    const aggregate = aggregateGroup(
        group,
        input.transactions,
        input.assetSettings,
        input.marketData,
        input.brokers,
    );

    return aggregate.memberCalcs.map(mc => {
        const valueByTicker: Record<string, number> = {};
        const quantityByTicker: Record<string, number> = {};
        mc.assets.forEach(a => {
            if (isCashTicker(a.ticker)) return;
            valueByTicker[a.ticker] = (valueByTicker[a.ticker] || 0) + a.currentValue;
            quantityByTicker[a.ticker] = (quantityByTicker[a.ticker] || 0) + a.quantity;
        });
        return {
            portfolio: mc.portfolio,
            totalValue: mc.totalValue,
            valueByTicker,
            quantityByTicker,
        };
    });
};

export const buildMergedPortfolioView = (
    input: BuildMergedPortfolioViewInput,
): MergedPortfolioView => {
    const { portfolios, transactions, brokers } = input;
    const { groups, standalones } = buildPortfolioTree(portfolios);

    // Substitution, applied group by group: the members' transactions leave the
    // pool as their re-tagged copies enter it, and each group's broker earmarks
    // are folded into the brokers the previous group already produced.
    const remainingTransactions = new Map(transactions.map(t => [t.id, t]));
    const mergedTransactions: Transaction[] = [];
    let workingBrokers = brokers;

    const mergedPortfolios: Portfolio[] = [];
    const infos: MergedGroupInfo[] = [];
    const existingPortfolioIds = portfolios.map(p => p.id);

    groups.forEach(group => {
        const members = memberValuesOf(group, input);
        const { members: ratio, ratioSource } = mergedRatio(
            members,
            configuredShares(group.members),
        );
        const built = buildMergedGroup({
            members,
            ratio,
            ratioSource,
            transactions,
            brokers: workingBrokers,
            existingPortfolioIds,
        });

        group.members.forEach(m => {
            transactions.forEach(t => {
                if (t.portfolioId === m.id) remainingTransactions.delete(t.id);
            });
        });
        mergedTransactions.push(...built.transactions);
        workingBrokers = built.brokers;

        // The group is one portfolio, so it needs the one identity the members
        // shared: the parent's goal. A member attached to a different goal is
        // NOT quietly re-homed here — `goalDistribution` counts it at the
        // parent's level but colours it as borrowed, so the move is visible.
        mergedPortfolios.push({
            ...built.portfolio,
            goalId: group.parent.goalId,
            description: group.parent.description,
        });

        infos.push({
            id: built.portfolio.id,
            parentId: group.parent.id,
            memberIds: group.members.map(m => m.id),
            members: ratio,
            ratioSource,
            ownerByUnit: built.ownerByUnit,
            quantityByMember: Object.fromEntries(
                members.map(m => [m.portfolio.id, m.quantityByTicker]),
            ),
            valueByMember: Object.fromEntries(
                members.map(m => [m.portfolio.id, m.totalValue]),
            ),
        });
    });

    const groupById = Object.fromEntries(infos.map(g => [g.id, g]));
    const groupIdByMember: Record<string, string> = {};
    infos.forEach(g => g.memberIds.forEach(id => { groupIdByMember[id] = g.id; }));

    return {
        portfolios: [...mergedPortfolios, ...standalones].sort((a, b) => a.order - b.order),
        transactions: [...Array.from(remainingTransactions.values()), ...mergedTransactions],
        brokers: workingBrokers,
        groups: infos,
        groupById,
        groupIdByMember,
    };
};

/**
 * Split one merged order back onto the real member portfolios.
 *
 * Thin wrapper over `routeOrder` so callers holding a `MergedGroupInfo` don't
 * have to reassemble its holdings map themselves.
 */
export const routeGroupOrder = (
    group: MergedGroupInfo,
    unitKey: string,
    ticker: string,
    shares: number,
): { portfolioId: string; shares: number }[] => {
    const upper = ticker.toUpperCase();
    const holdingsByMember: Record<string, number> = {};
    Object.entries(group.quantityByMember).forEach(([portfolioId, byTicker]) => {
        const key = Object.keys(byTicker).find(t => t.toUpperCase() === upper);
        const qty = key ? byTicker[key] : 0;
        if (qty > 0) holdingsByMember[portfolioId] = qty;
    });

    return routeOrder({
        unitKey,
        ticker,
        shares,
        ownerByUnit: group.ownerByUnit,
        holdingsByMember,
        fallbackPortfolioId: group.parentId,
    });
};

export interface GroupAmountLeg {
    portfolioId: string;
    amount: number;
}

const roundCents = (v: number): number => Math.round(v * 100) / 100;

/**
 * Spread a euro amount moving in or out of a whole group across its members.
 *
 * A group endpoint on the Fund Relocation page is not a portfolio the ledger
 * knows, so the move has to become real per-member moves before anything is
 * queued. The split is the one that also does the group some good: money
 * leaving is taken from whoever is heaviest against the configured ratio, money
 * arriving goes to whoever is lightest, so relocating between goals quietly
 * closes the parent/child ratio instead of dragging it further off.
 *
 * `amount` is positive for money arriving, negative for money leaving. Legs
 * come back in the same sign, and a withdrawal never takes more from a member
 * than it is worth.
 */
export const splitGroupAmount = (
    group: Pick<MergedGroupInfo, 'memberIds' | 'members' | 'valueByMember'>,
    amount: number,
): GroupAmountLeg[] => {
    if (!Number.isFinite(amount) || amount === 0) return [];

    const shareById = new Map(group.members.map(m => [m.portfolioId, m.share]));
    const members = group.memberIds.map(portfolioId => ({
        portfolioId,
        value: Math.max(0, group.valueByMember[portfolioId] ?? 0),
        share: shareById.get(portfolioId) ?? 0,
    }));
    if (members.length === 0) return [];

    const groupTotal = members.reduce((s, m) => s + m.value, 0);
    const postTotal = Math.max(0, groupTotal + amount);

    // Distance from where each member should sit once the move has happened.
    // Positive = it needs to grow, negative = it needs to shrink.
    const needs = members.map(m => ({
        portfolioId: m.portfolioId,
        value: m.value,
        need: postTotal * m.share - m.value,
    }));

    const wanted = amount > 0
        ? needs.filter(n => n.need > 0)
        // Only members that actually hold something can give.
        : needs.filter(n => n.need < 0 && n.value > 0);

    // Nobody is off-ratio in the direction of the move (or the ratio is flat):
    // fall back to weight — by target share when adding, by what each member
    // holds when taking, so a withdrawal can never overdraw a member.
    const weights = wanted.length > 0
        ? wanted.map(n => ({ portfolioId: n.portfolioId, weight: Math.abs(n.need), cap: n.value }))
        : members
            .map(m => ({
                portfolioId: m.portfolioId,
                weight: amount > 0 ? m.share : m.value,
                cap: m.value,
            }))
            .filter(w => w.weight > 0);

    const weightTotal = weights.reduce((s, w) => s + w.weight, 0);
    if (weightTotal <= 0) return [];

    if (amount > 0) {
        const legs = weights.map(w => ({
            portfolioId: w.portfolioId,
            amount: roundCents((amount * w.weight) / weightTotal),
        }));
        // Nothing caps an inflow, so the legs can always be made to sum exactly.
        return settleRounding(legs, amount, () => Infinity);
    }

    // Taking out: never past what a member holds, redistributing the shortfall
    // over whoever still has room. Asking for more than the group is worth
    // therefore yields LESS than the request — a cap, not a rounding error, and
    // one that must survive the settling below rather than be papered over.
    let remaining = -amount;
    const legs: GroupAmountLeg[] = [];
    const capById = new Map(weights.map(w => [w.portfolioId, w.cap]));
    const pool = weights
        .map(w => ({ ...w }))
        .sort((a, b) => b.weight - a.weight);

    let weightLeft = weightTotal;
    pool.forEach(w => {
        if (remaining <= 0 || weightLeft <= 0) return;
        const ideal = (remaining * w.weight) / weightLeft;
        const take = Math.min(ideal, w.cap, remaining);
        weightLeft -= w.weight;
        if (take <= 0) return;
        legs.push({ portfolioId: w.portfolioId, amount: -roundCents(take) });
        remaining -= take;
    });

    // Settle against what was actually taken, not what was asked for.
    const taken = roundCents(-amount - Math.max(0, remaining));
    return settleRounding(legs, -taken, id => capById.get(id) ?? Infinity);
};

/**
 * Push the rounding residue onto a leg that can absorb it, so the legs sum to
 * `amount` exactly — a queue that moves a cent less than planned would drift.
 *
 * `capOf` is what stops that correction overdrawing somebody: the residue goes
 * to the largest leg with room for it, and is dropped rather than forced if no
 * leg has any. A stray cent is a smaller lie than a member sold below zero.
 */
const settleRounding = (
    legs: GroupAmountLeg[],
    amount: number,
    capOf: (portfolioId: string) => number,
): GroupAmountLeg[] => {
    const kept = legs.filter(l => l.amount !== 0);
    if (kept.length === 0) return [];
    const residue = roundCents(amount - kept.reduce((s, l) => s + l.amount, 0));
    if (residue !== 0) {
        const fits = (leg: GroupAmountLeg) =>
            Math.abs(leg.amount + residue) <= capOf(leg.portfolioId) + 1e-9;
        const candidates = kept.filter(fits);
        if (candidates.length > 0) {
            const biggest = candidates.reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
            biggest.amount = roundCents(biggest.amount + residue);
        }
    }
    return kept.filter(l => l.amount !== 0);
};
