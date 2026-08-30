// Merged view for a parent/child dashboard group: the whole group rendered as
// ONE virtual portfolio, so the Allocations table can price it with exactly the
// same code path it uses for a standalone portfolio.
//
// The point of the merge is not cosmetic. Each member's target vector is
// normalized to 100 and then scaled by that member's share of the group, so:
//
//   • per member — the merged targets of a member's own assets sum to
//     share_m × 100, i.e. its value at target is groupTotal × share_m. That IS
//     the parent/child ratio computeGroupRebalance plans for.
//   • inside a member — its assets keep their original relative proportions,
//     because they are all scaled by the same share_m.
//
// So an ordinary rebalance against the merged targets closes the internal
// allocation AND the parent/child ratio in one plan, with no inter-portfolio
// transfer legs to price. This relies on members holding disjoint assets: an
// asset held by two members has a single merged row and the view can no longer
// tell which member is off. `routeOrder` still splits such a row pro-rata so
// nothing breaks, but the ratio is only closed for the disjoint part.

import type { AllocationGroup, AllocationMemberRule, Broker, Portfolio, Transaction } from '../types';
import { isGroupKey } from './portfolioCalculations';
import { resolveGroups } from './allocationGroups';

/** Prefix of the synthetic portfolio id. Distinct from _GRP_ and _CASH_. */
export const MERGED_PORTFOLIO_PREFIX = '_MERGED_';

export const isMergedPortfolioId = (id: string): boolean =>
    id.startsWith(MERGED_PORTFOLIO_PREFIX);

export interface MergedMemberRatio {
    portfolioId: string;
    name: string;
    /** Share of the group, 0..1. The shares always sum to 1. */
    share: number;
}

export interface MemberValue {
    portfolio: Portfolio;
    /** Invested assets + broker cash allocated to the member (dashboard convention). */
    totalValue: number;
    /** Current value per ticker, used as the target of a member that has none. */
    valueByTicker: Record<string, number>;
    /** Current quantity per ticker, used to route orders and cap sells. */
    quantityByTicker: Record<string, number>;
}

export interface MergedGroup {
    /** Synthetic portfolio: blended allocations, union of the members' groups. */
    portfolio: Portfolio;
    /** The members' transactions, re-tagged onto the synthetic id. */
    transactions: Transaction[];
    /** The members' liquidityAllocations collapsed onto the synthetic id. */
    brokers: Broker[];
    members: MergedMemberRatio[];
    /** Where the parent/child ratio came from. */
    ratioSource: RatioSource;
    /** unit key (standalone ticker or groupId) -> owning portfolioId. */
    ownerByUnit: Record<string, string>;
}

const roundPct = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * 'config' = at least one member carries a `groupSharePercent` set on the
 * Portfolios page; 'value' = nobody does, so the group is split by what the
 * members are worth today.
 */
export type RatioSource = 'config' | 'value';

/**
 * The ratio configured on the Portfolios page: portfolioId -> share %, keeping
 * only the members that actually carry one. A share of 0 is a real answer
 * ("plan this member down to nothing") and is kept; a missing, negative or
 * non-finite one is not a configuration at all and is left out, so the member
 * falls back to its current share of the group's value.
 */
export const configuredShares = (portfolios: Portfolio[]): Record<string, number> => {
    const out: Record<string, number> = {};
    portfolios.forEach(p => {
        const share = p.groupSharePercent;
        if (typeof share === 'number' && Number.isFinite(share) && share >= 0) {
            out[p.id] = share;
        }
    });
    return out;
};

/**
 * Parent/child shares for the merge.
 *
 * Members with a share configured on the Portfolios page are split by it;
 * members without one keep their current share of the group, and the
 * configured block keeps its own current share as a whole. That way a member
 * added to the group later is neither dropped nor silently re-sized until
 * somebody actually gives it a share.
 */
export const mergedRatio = (
    members: MemberValue[],
    shares: Record<string, number>,
): { members: MergedMemberRatio[]; ratioSource: RatioSource } => {
    const equal = (): MergedMemberRatio[] =>
        members.map(m => ({
            portfolioId: m.portfolio.id,
            name: m.portfolio.name,
            share: members.length > 0 ? 1 / members.length : 0,
        }));

    // Only shares belonging to THIS group count: a stale entry for a portfolio
    // that has since been re-parented must not steer somebody else's ratio.
    const memberIds = new Set(members.map(m => m.portfolio.id));
    const configured = new Map(
        Object.entries(shares).filter(([id]) => memberIds.has(id))
    );
    const configuredTotal = Array.from(configured.values()).reduce((s, v) => s + v, 0);
    // Shares that sum to nothing carry no proportion at all — treat them as
    // absent rather than dividing by zero further down.
    const hasConfig = configured.size > 0 && configuredTotal > 0;
    const ratioSource: RatioSource = hasConfig ? 'config' : 'value';

    const groupTotal = members.reduce((s, m) => s + Math.max(0, m.totalValue), 0);
    if (members.length === 0) return { members: [], ratioSource: 'value' };
    if (groupTotal <= 0) {
        if (!hasConfig) return { members: equal(), ratioSource };
        // Nothing invested yet: the configured shares ARE the answer, and the
        // unconfigured members have no value to claim a share with.
        return {
            members: members.map(m => ({
                portfolioId: m.portfolio.id,
                name: m.portfolio.name,
                share: (configured.get(m.portfolio.id) ?? 0) / configuredTotal,
            })),
            ratioSource,
        };
    }
    if (!hasConfig) {
        return {
            members: members.map(m => ({
                portfolioId: m.portfolio.id,
                name: m.portfolio.name,
                share: Math.max(0, m.totalValue) / groupTotal,
            })),
            ratioSource,
        };
    }

    // The configured members share out the slice of the group they hold today;
    // the rest keep their own slice untouched.
    const coveredValue = members
        .filter(m => configured.has(m.portfolio.id))
        .reduce((s, m) => s + Math.max(0, m.totalValue), 0);
    const coveredWeight = coveredValue / groupTotal;

    const raw = members.map(m => {
        const configuredShare = configured.get(m.portfolio.id);
        const share = configuredShare !== undefined
            ? coveredWeight * (configuredShare / configuredTotal)
            : Math.max(0, m.totalValue) / groupTotal;
        return { portfolioId: m.portfolio.id, name: m.portfolio.name, share };
    });

    // Renormalize: a configured member worth 0 contributes nothing to
    // coveredWeight, so the raw shares can fall short of 1.
    const sum = raw.reduce((s, r) => s + r.share, 0);
    const normalized = sum > 0
        ? raw.map(r => ({ ...r, share: r.share / sum }))
        : equal();

    return { members: normalized, ratioSource };
};

/**
 * A member's target vector normalized to sum 100.
 *
 * Normalizing is what makes the per-member identity hold: without it a member
 * whose targets sum to 90 would be planned at 90% of its share and the ratio
 * would never close. A member with no targets at all falls back to its current
 * mix, so it keeps its value instead of being planned down to zero.
 */
const normalizedTargets = (member: MemberValue): Record<string, number> => {
    const allocations = member.portfolio.allocations || {};
    const total = Object.values(allocations).reduce((s, v) => s + (v || 0), 0);
    if (total > 0) {
        const out: Record<string, number> = {};
        Object.entries(allocations).forEach(([key, pct]) => {
            if (pct > 0) out[key] = (pct / total) * 100;
        });
        return out;
    }

    const valueTotal = Object.values(member.valueByTicker).reduce((s, v) => s + v, 0);
    if (valueTotal <= 0) return {};
    const out: Record<string, number> = {};
    Object.entries(member.valueByTicker).forEach(([ticker, value]) => {
        if (value > 0) out[ticker] = (value / valueTotal) * 100;
    });
    return out;
};

/**
 * Member rules for a group that lost members to an earlier claimant.
 *
 * A weighted group is only honoured when its active members' weights sum to
 * 100 (`groupWeightConfig`); dropping a member would leave the rest short and
 * the group would be skipped entirely, so the survivors' weights are rescaled.
 * Rules for tickers that are no longer members are dropped with them.
 */
const rescaledRules = (
    kept: string[],
    rules?: Record<string, AllocationMemberRule>,
): Record<string, AllocationMemberRule> | undefined => {
    if (!rules) return undefined;
    const ruleFor = (t: string) => rules[t] ?? rules[t.toUpperCase()];
    const out: Record<string, AllocationMemberRule> = {};
    kept.forEach(t => {
        const rule = ruleFor(t);
        if (rule) out[t] = { ...rule };
    });

    const weighted = kept.filter(t => out[t]?.weight !== undefined);
    // Rescale only when every survivor is weighted; a partially weighted setup
    // was already invalid and must stay that way rather than be silently fixed.
    if (weighted.length === 0 || weighted.length !== kept.length) return out;
    const sum = weighted.reduce((s, t) => s + (out[t].weight || 0), 0);
    if (sum <= 0) return out;
    weighted.forEach(t => { out[t].weight = ((out[t].weight || 0) / sum) * 100; });
    return out;
};

/** `_MERGED_<parentId>`, suffixed until it collides with no real portfolio. */
const uniqueMergedId = (parentId: string, taken: Set<string>): string => {
    let id = `${MERGED_PORTFOLIO_PREFIX}${parentId}`;
    let n = 2;
    while (taken.has(id)) id = `${MERGED_PORTFOLIO_PREFIX}${parentId}_${n++}`;
    return id;
};

export interface BuildMergedGroupParams {
    /** Parent first, then the children — the order decides who wins a clash. */
    members: MemberValue[];
    ratio: MergedMemberRatio[];
    ratioSource: RatioSource;
    /** All transactions; only the members' own are taken. */
    transactions: Transaction[];
    brokers: Broker[];
    /** Every portfolio id in the app, so the synthetic id can't collide. */
    existingPortfolioIds: string[];
}

export const buildMergedGroup = (params: BuildMergedGroupParams): MergedGroup => {
    const { members, ratio, ratioSource, transactions, brokers, existingPortfolioIds } = params;
    const parent = members[0].portfolio;
    const mergedId = uniqueMergedId(parent.id, new Set(existingPortfolioIds));
    const shareById = new Map(ratio.map(r => [r.portfolioId, r.share]));

    // Union of the members' allocation groups, parent first — but a ticker may
    // only belong to ONE merged group. Portfolios define their groups
    // independently, so the same ticker can be a member of the parent's group
    // and of a child's (the shipped mock data does exactly this). resolveGroups
    // maps a ticker to a single group, so leaving it in both member lists would
    // count its value in both rows and blow the percentages past 100. The
    // groups are therefore partitioned: the first group to claim a ticker keeps
    // it, later ones drop it, and a group left with no members disappears.
    const allocationGroups: AllocationGroup[] = [];
    const seenGroupIds = new Set<string>();
    const claimedBy = new Map<string, string>();
    /** Fully absorbed group id -> the group that took its members. */
    const absorbedInto: Record<string, string> = {};
    members.forEach(m => {
        (m.portfolio.allocationGroups || []).forEach(g => {
            if (seenGroupIds.has(g.id)) return;
            seenGroupIds.add(g.id);
            const kept = g.members.filter(t => !claimedBy.has(t.toUpperCase()));
            if (kept.length === 0) {
                // Every member already belongs to an earlier group: this group
                // has no row of its own, so its target follows its members.
                const heir = claimedBy.get(g.members[0]?.toUpperCase() ?? '');
                if (heir) absorbedInto[g.id] = heir;
                return;
            }
            kept.forEach(t => claimedBy.set(t.toUpperCase(), g.id));
            allocationGroups.push(
                kept.length === g.members.length
                    ? g
                    : { ...g, members: kept, memberRules: rescaledRules(kept, g.memberRules) }
            );
        });
    });

    // Blend the normalized member targets.
    const allocations: Record<string, number> = {};
    members.forEach(m => {
        const share = shareById.get(m.portfolio.id) ?? 0;
        if (share <= 0) return;
        Object.entries(normalizedTargets(m)).forEach(([key, pct]) => {
            allocations[key] = (allocations[key] || 0) + share * pct;
        });
    });

    // A ticker that is standalone in one member but a group member in another
    // would vanish: resolveGroups hides member tickers from the standalone rows,
    // so its blended target has to be folded into the group's own target.
    const { tickerToGroupId } = resolveGroups({ ...parent, allocationGroups });
    Object.keys(allocations).forEach(key => {
        // An absorbed group has no row left; its target goes to its heir.
        const heir = absorbedInto[key];
        if (heir) {
            allocations[heir] = (allocations[heir] || 0) + allocations[key];
            delete allocations[key];
            return;
        }
        if (isGroupKey(key)) return;
        const groupId = tickerToGroupId[key.toUpperCase()];
        if (!groupId) return;
        allocations[groupId] = (allocations[groupId] || 0) + allocations[key];
        delete allocations[key];
    });
    Object.keys(allocations).forEach(key => { allocations[key] = roundPct(allocations[key]); });

    // One commission plan can only price the merged legs when every member
    // trades through the same broker; otherwise fall back to multi-broker mode.
    const brokerIds = new Set(members.map(m => m.portfolio.preferredBrokerId));
    const preferredBrokerId = brokerIds.size === 1 ? members[0].portfolio.preferredBrokerId : undefined;

    const portfolio: Portfolio = {
        id: mergedId,
        name: parent.name,
        allocations,
        allocationGroups: allocationGroups.length > 0 ? allocationGroups : undefined,
        liquidity: members.reduce((s, m) => s + (m.portfolio.liquidity || 0), 0) || undefined,
        preferredBrokerId,
        order: parent.order,
    };

    // Recomputed from the combined stream rather than summed per member, so a
    // ticker bought in the parent and sold in a child nets out and the average
    // price is the group's — which is what the sell-tax math needs.
    const memberIds = new Set(members.map(m => m.portfolio.id));
    const mergedTransactions = transactions
        .filter(t => t.portfolioId && memberIds.has(t.portfolioId))
        .map(t => ({ ...t, portfolioId: mergedId }));

    // Collapse the members' earmarked cash onto the synthetic id: one
    // _CASH_<brokerId> row per broker, and `earmarkedElsewhere` in
    // projectBrokerCash stops counting the members' own earmarks as foreign.
    const mergedBrokers = brokers.map(b => {
        const allocs = { ...(b.liquidityAllocations || {}) };
        let sum = 0;
        memberIds.forEach(id => {
            sum += allocs[id] || 0;
            delete allocs[id];
        });
        if (sum > 0) allocs[mergedId] = sum;
        return {
            ...b,
            liquidityAllocations: Object.keys(allocs).length > 0 ? allocs : undefined,
        };
    });

    // Which member owns each unit key. Keyed by the MERGED resolution, since
    // that is what the merged table renders as rows: a ticker standalone in one
    // member but grouped in another is addressed by the group's id here too.
    // Parent first, first claim wins.
    const ownerByUnit: Record<string, string> = {};
    const unitOf = (ticker: string) => tickerToGroupId[ticker.toUpperCase()] || ticker;
    const claim = (key: string, portfolioId: string) => {
        if (!ownerByUnit[key]) ownerByUnit[key] = portfolioId;
    };
    members.forEach(m => {
        Object.entries(m.quantityByTicker).forEach(([ticker, qty]) => {
            if (qty > 0) claim(unitOf(ticker), m.portfolio.id);
        });
        Object.entries(m.portfolio.allocations || {}).forEach(([key, pct]) => {
            if (pct > 0) claim(isGroupKey(key) ? key : unitOf(key), m.portfolio.id);
        });
    });

    return {
        portfolio,
        transactions: mergedTransactions,
        brokers: mergedBrokers,
        members: ratio,
        ratioSource,
        ownerByUnit,
    };
};

export interface RoutedLeg {
    portfolioId: string;
    shares: number;
}

export interface RouteOrderParams {
    /** Standalone ticker or groupId — how the merged table keys the row. */
    unitKey: string;
    ticker: string;
    /** Signed whole shares: positive buys, negative sells. */
    shares: number;
    ownerByUnit: Record<string, string>;
    /** portfolioId -> quantity of `ticker` held by that member. */
    holdingsByMember: Record<string, number>;
    /** Where a buy goes when nobody owns or holds the ticker. */
    fallbackPortfolioId: string;
}

/**
 * Split one merged order across the real member portfolios.
 *
 * With disjoint member assets — the case this view is designed for — every unit
 * belongs to exactly one member and this is a single leg. The pro-rata branch
 * only exists so overlapping data still produces a payable plan: sells are
 * capped at what each member actually holds, so no member is ever sold short.
 */
export const routeOrder = (params: RouteOrderParams): RoutedLeg[] => {
    const { unitKey, shares, ownerByUnit, holdingsByMember, fallbackPortfolioId } = params;
    if (shares === 0) return [];

    const holders = Object.entries(holdingsByMember)
        .filter(([, qty]) => qty > 0)
        .sort((a, b) => b[1] - a[1]);

    if (shares < 0) {
        // Sell: take from the largest holder down, never past what it holds.
        let remaining = -shares;
        const legs: RoutedLeg[] = [];
        holders.forEach(([portfolioId, qty]) => {
            if (remaining <= 0) return;
            const take = Math.min(remaining, Math.floor(qty));
            if (take > 0) {
                legs.push({ portfolioId, shares: -take });
                remaining -= take;
            }
        });
        // Fractional holdings can leave a share unplaced; the largest holder
        // absorbs it (its quantity still covers the sale).
        if (remaining > 0 && legs.length > 0) legs[0].shares -= remaining;
        else if (remaining > 0 && holders.length > 0) legs.push({ portfolioId: holders[0][0], shares: -remaining });
        return legs;
    }

    // Buy: the owner takes it; a shared unit is split pro-rata to the holdings.
    const owner = ownerByUnit[unitKey];
    if (holders.length <= 1) {
        const target = holders[0]?.[0] ?? owner ?? fallbackPortfolioId;
        return [{ portfolioId: target, shares }];
    }

    const totalHeld = holders.reduce((s, [, qty]) => s + qty, 0);
    const exact = holders.map(([portfolioId, qty]) => ({
        portfolioId,
        ideal: (shares * qty) / totalHeld,
    }));
    const legs = exact.map(e => ({ portfolioId: e.portfolioId, shares: Math.floor(e.ideal) }));
    let placed = legs.reduce((s, l) => s + l.shares, 0);
    // Largest remainder, so the legs sum to `shares` exactly.
    const order = exact
        .map((e, i) => ({ i, rem: e.ideal - Math.floor(e.ideal) }))
        .sort((a, b) => b.rem - a.rem);
    let oi = 0;
    while (placed < shares && order.length > 0) {
        legs[order[oi % order.length].i].shares += 1;
        placed += 1;
        oi += 1;
    }
    return legs.filter(l => l.shares !== 0);
};
