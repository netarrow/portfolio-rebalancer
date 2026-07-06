import type { Asset, AllocationGroup, AllocationMemberRule, Portfolio } from '../types';

/**
 * Multi-asset "market" allocation groups.
 *
 * A group (e.g. "All World" = VWCE + XMAU) holds a single target % stored in
 * `Portfolio.allocations[groupId]`. The members are interchangeable for that
 * exposure; an ordered priority list decides where buys land (index 0 first)
 * and where sells are drained from (last index first). Per-member `noBuy` /
 * `noSell` flags constrain the direction.
 *
 * Scope (first iteration): per-portfolio rebalance table only.
 */

export interface ResolvedGroups {
    groupById: Record<string, AllocationGroup>;
    /** ticker (UPPERCASE) -> groupId */
    tickerToGroupId: Record<string, string>;
}

/** Build lookup maps from a single portfolio's allocationGroups. */
export const resolveGroups = (portfolio: Portfolio): ResolvedGroups => {
    const groupById: Record<string, AllocationGroup> = {};
    const tickerToGroupId: Record<string, string> = {};
    (portfolio.allocationGroups || []).forEach(g => {
        groupById[g.id] = g;
        g.members.forEach(m => { tickerToGroupId[m.toUpperCase()] = g.id; });
    });
    return { groupById, tickerToGroupId };
};

export interface MemberMarketInfo {
    ticker: string;
    currentValue: number;
    price: number;
}

export interface MemberAction {
    ticker: string;
    eur: number;    // signed: positive = buy, negative = sell
    shares: number; // signed
}

/** Why a single member could not take the group's pending action. */
export interface MemberBlockReason {
    ticker: string;
    reason: string;
}

/** Structured explanation shown when a group is "Not eligible". */
export interface GroupBlockReason {
    /** direction the group needed to move */
    direction: 'buy' | 'sell';
    /** euro amount that could not be actioned */
    deltaEur: number;
    /** per-member explanation of why each one was skipped */
    members: MemberBlockReason[];
}

export interface GroupDistribution {
    /** by ticker (UPPERCASE) */
    actions: Record<string, MemberAction>;
    /** true when the delta could not be actioned at all because rules froze every eligible member */
    blocked: boolean;
    /** populated only when `blocked` — explains, per member, why nothing could be actioned */
    blockReason?: GroupBlockReason;
    /** euro amount left unactioned (rounding leftover or frozen members) */
    unallocated: number;
}

const ruleFor = (
    ticker: string,
    rules?: Record<string, AllocationMemberRule>
): AllocationMemberRule => rules?.[ticker] ?? rules?.[ticker.toUpperCase()] ?? {};

const EPS = 0.5; // half a euro tolerance for "no action needed"

/**
 * Decide which member(s) of a group to buy/sell to move the group's value by `deltaEur`.
 * - deltaEur > 0 (group underweight): buy the first buy-eligible member by priority.
 * - deltaEur < 0 (group overweight): sell from the lowest-priority sellable members first,
 *   capped at each member's current value, cascading up the priority list.
 */
export const distributeGroupDelta = (params: {
    deltaEur: number;
    members: string[];
    memberInfo: Record<string, MemberMarketInfo>;
    rules?: Record<string, AllocationMemberRule>;
}): GroupDistribution => {
    const { deltaEur, members, memberInfo, rules } = params;
    const actions: Record<string, MemberAction> = {};

    if (Math.abs(deltaEur) < EPS) {
        return { actions, blocked: false, unallocated: 0 };
    }

    const infoOf = (t: string) => memberInfo[t] ?? memberInfo[t.toUpperCase()];

    if (deltaEur > 0) {
        // BUY: route to first buy-eligible member by priority.
        const recipient = members.find(m => {
            const info = infoOf(m);
            return info && info.price > 0 && !ruleFor(m, rules).noBuy;
        });
        if (!recipient) {
            const memberReasons: MemberBlockReason[] = members.map(m => {
                const info = infoOf(m);
                if (!info || info.price <= 0) return { ticker: m, reason: 'No price available (run Update Prices)' };
                if (ruleFor(m, rules).noBuy) return { ticker: m, reason: 'Has a "Never buy" rule' };
                return { ticker: m, reason: 'Eligible' };
            });
            return {
                actions,
                blocked: true,
                blockReason: { direction: 'buy', deltaEur, members: memberReasons },
                unallocated: deltaEur,
            };
        }
        const info = infoOf(recipient)!;
        const shares = Math.round(deltaEur / info.price);
        if (shares <= 0) {
            return { actions, blocked: false, unallocated: deltaEur };
        }
        const eur = shares * info.price;
        actions[recipient.toUpperCase()] = { ticker: recipient, eur, shares };
        return { actions, blocked: false, unallocated: deltaEur - eur };
    }

    // SELL: drain lowest-priority sellable members first.
    let need = -deltaEur;
    let anyEligible = false;
    for (let i = members.length - 1; i >= 0 && need >= EPS; i--) {
        const m = members[i];
        const info = infoOf(m);
        if (!info || info.price <= 0 || info.currentValue <= 0) continue;
        if (ruleFor(m, rules).noSell) continue;
        anyEligible = true;
        const maxShares = Math.floor(info.currentValue / info.price);
        if (maxShares <= 0) continue;
        const wanted = Math.round(need / info.price);
        const shares = Math.min(wanted, maxShares);
        if (shares <= 0) continue;
        const eur = shares * info.price;
        actions[m.toUpperCase()] = { ticker: m, eur: -eur, shares: -shares };
        need -= eur;
    }

    const blockReason: GroupBlockReason | undefined = anyEligible
        ? undefined
        : {
            direction: 'sell',
            deltaEur,
            members: members.map(m => {
                const info = infoOf(m);
                if (!info || info.price <= 0) return { ticker: m, reason: 'No price available (run Update Prices)' };
                if (info.currentValue <= 0) return { ticker: m, reason: 'Not held (no position to sell)' };
                if (ruleFor(m, rules).noSell) return { ticker: m, reason: 'Has a "Never sell" rule' };
                return { ticker: m, reason: 'Eligible' };
            }),
        };

    return {
        actions,
        blocked: !anyEligible,
        blockReason,
        unallocated: Math.max(0, need),
    };
};

/** A unit competing for liquidity in buy-only mode: a standalone ticker or a whole group. */
export interface BuyOnlyCandidate {
    key: string;   // ticker or groupId
    gap: number;   // positive underweight gap in euro
    price: number; // price of the share that will actually be bought (recipient member for groups)
}

/**
 * Largest-remainder distribution of `liquidity` across underweight candidates,
 * proportional to their gap, converting to whole shares without overspending.
 * Returns key -> euro to deploy. (Same algorithm already used for per-ticker buy-only.)
 */
export const largestRemainderBuyOnly = (
    candidates: BuyOnlyCandidate[],
    liquidity: number
): Record<string, number> => {
    const valid = candidates.filter(c => c.gap > 0 && c.price > 0);
    const totalGap = valid.reduce((s, c) => s + c.gap, 0);
    if (liquidity <= 0 || totalGap <= 0) return {};

    const dist = valid.map(c => {
        const raw = (c.gap / totalGap) * liquidity;
        const ideal = raw / c.price;
        const floored = Math.floor(ideal);
        return { ...c, shares: floored, fraction: ideal - floored, cost: floored * c.price };
    });

    let remaining = liquidity - dist.reduce((s, d) => s + d.cost, 0);
    const order = dist.map((_, i) => i).sort((a, b) => dist[b].fraction - dist[a].fraction);
    for (const idx of order) {
        if (remaining >= dist[idx].price) {
            dist[idx].shares += 1;
            dist[idx].cost += dist[idx].price;
            remaining -= dist[idx].price;
        }
    }

    const result: Record<string, number> = {};
    dist.forEach(d => { if (d.shares > 0) result[d.key] = d.shares * d.price; });
    return result;
};

/** Find the member that would receive a buy for this group (first buy-eligible by priority). */
export const buyRecipientOf = (
    group: AllocationGroup,
    memberInfo: Record<string, MemberMarketInfo>
): MemberMarketInfo | undefined => {
    for (const m of group.members) {
        const info = memberInfo[m] ?? memberInfo[m.toUpperCase()];
        if (info && info.price > 0 && !(group.memberRules?.[m]?.noBuy)) return info;
    }
    return undefined;
};

/**
 * Build the member market-info map for a group from an assets list.
 *
 * A member may be added to a group purely as an alternative buy target before
 * any shares are held (e.g. VWCE set to `noBuy`, ACWI added to receive buys).
 * Such a member is absent from `assets` (which is derived from transactions),
 * so its price falls back to `marketData` when available — otherwise the group
 * would have no buy-eligible member and report "Blocked".
 */
export const memberInfoFromAssets = (
    members: string[],
    assets: Asset[],
    marketData?: Record<string, { price: number }>
): Record<string, MemberMarketInfo> => {
    const map: Record<string, MemberMarketInfo> = {};
    members.forEach(m => {
        const asset = assets.find(a => a.ticker.toUpperCase() === m.toUpperCase());
        const fallbackPrice = marketData
            ? (marketData[m]?.price ?? marketData[m.toUpperCase()]?.price ?? 0)
            : 0;
        map[m.toUpperCase()] = {
            ticker: m,
            currentValue: asset?.currentValue ?? 0,
            price: asset?.currentPrice ?? (fallbackPrice || 0),
        };
    });
    return map;
};
