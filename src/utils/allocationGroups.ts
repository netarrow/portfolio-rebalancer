import type { Asset, AllocationGroup, AllocationMemberRule, PacConfig, Portfolio } from '../types';

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
    /** what blocked the group: member rules (default) or an invalid weight setup */
    kind?: 'rules' | 'invalidWeights';
    /** sum of the active members' weights, populated when kind = 'invalidWeights' */
    weightSum?: number;
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

/** A fully frozen member keeps its current value; its weight (if any) is ignored. */
export const isFullyFrozen = (rule: AllocationMemberRule): boolean =>
    !!rule.noBuy && !!rule.noSell;

export interface GroupWeightConfig {
    /** true when at least one active (non-frozen) member has a weight set */
    weighted: boolean;
    /** true when every active member has a weight and they sum to 100 (±0.01) */
    valid: boolean;
    /** sum of the active members' weights */
    sum: number;
    /** active members with no weight set (what makes a weighted group invalid) */
    missing: string[];
    /** ticker (UPPERCASE) -> weight, active members only */
    weights: Record<string, number>;
}

const WEIGHT_SUM_EPS = 0.01;

/**
 * Resolve a group's intra-group weight setup. Weighted mode is automatic:
 * it activates as soon as one active member has a weight. Fully frozen
 * members (noBuy && noSell) are excluded — their value stays put and their
 * weight doesn't count toward the 100% sum.
 */
export const groupWeightConfig = (
    members: string[],
    rules?: Record<string, AllocationMemberRule>
): GroupWeightConfig => {
    const weights: Record<string, number> = {};
    const missing: string[] = [];
    let sum = 0;
    let weighted = false;
    members.forEach(m => {
        const rule = ruleFor(m, rules);
        if (isFullyFrozen(rule)) return;
        if (rule.weight !== undefined) {
            weighted = true;
            weights[m.toUpperCase()] = rule.weight;
            sum += rule.weight;
        } else {
            missing.push(m);
        }
    });
    const valid = weighted && missing.length === 0 && Math.abs(sum - 100) <= WEIGHT_SUM_EPS;
    return { weighted, valid, sum, missing, weights };
};

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

    // Weighted mode: automatic as soon as one active member has a weight.
    const wcfg = groupWeightConfig(members, rules);
    if (wcfg.weighted && !wcfg.valid) {
        const memberReasons: MemberBlockReason[] = members.map(m => {
            const rule = ruleFor(m, rules);
            if (isFullyFrozen(rule)) return { ticker: m, reason: 'Frozen (weight ignored)' };
            if (rule.weight === undefined) return { ticker: m, reason: 'No weight set' };
            return { ticker: m, reason: `Weight ${rule.weight}%` };
        });
        return {
            actions,
            blocked: true,
            blockReason: {
                direction: deltaEur > 0 ? 'buy' : 'sell',
                deltaEur,
                members: memberReasons,
                kind: 'invalidWeights',
                weightSum: wcfg.sum,
            },
            unallocated: Math.abs(deltaEur),
        };
    }
    if (wcfg.weighted) {
        return distributeGroupDeltaWeighted({ deltaEur, members, memberInfo, rules });
    }

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

/**
 * Weighted intra-group distribution: active members converge toward ideal
 * values derived from their weights over the non-frozen pool. Only the
 * group-level delta is ever split (no internal sell+buy churn): buys fill
 * per-member gaps first (underweight members catch up), sells drain
 * per-member excesses first. Whole-share feasibility is preserved with
 * repeated top-up passes so a sub-1-share slice shifts to a member whose
 * share fits instead of being lost.
 */
const distributeGroupDeltaWeighted = (params: {
    deltaEur: number;
    members: string[];
    memberInfo: Record<string, MemberMarketInfo>;
    rules?: Record<string, AllocationMemberRule>;
}): GroupDistribution => {
    const { deltaEur, members, memberInfo, rules } = params;
    const actions: Record<string, MemberAction> = {};
    const infoOf = (t: string) => memberInfo[t] ?? memberInfo[t.toUpperCase()];

    // Frozen members keep their value; the weighted pool is what's left of the group target.
    const groupTargetValue = members.reduce((s, m) => s + (infoOf(m)?.currentValue ?? 0), 0) + deltaEur;
    const frozenValue = members.reduce(
        (s, m) => (isFullyFrozen(ruleFor(m, rules)) ? s + (infoOf(m)?.currentValue ?? 0) : s),
        0
    );
    const pool = Math.max(0, groupTargetValue - frozenValue);

    interface WeightedMember {
        ticker: string;
        upper: string;
        info: MemberMarketInfo;
        rule: AllocationMemberRule;
        weight: number;
        ideal: number;
        shares: number;
        cost: number;
    }
    const active: WeightedMember[] = [];
    members.forEach(m => {
        const rule = ruleFor(m, rules);
        if (isFullyFrozen(rule)) return;
        const info = infoOf(m);
        if (!info) return;
        const weight = rule.weight ?? 0;
        active.push({
            ticker: m, upper: m.toUpperCase(), info, rule, weight,
            ideal: pool * (weight / 100), shares: 0, cost: 0,
        });
    });

    const blockedResult = (direction: 'buy' | 'sell'): GroupDistribution => ({
        actions,
        blocked: true,
        blockReason: {
            direction,
            deltaEur,
            members: members.map(m => {
                const info = infoOf(m);
                const rule = ruleFor(m, rules);
                if (!info || info.price <= 0) return { ticker: m, reason: 'No price available (run Update Prices)' };
                if (direction === 'buy' && rule.noBuy) return { ticker: m, reason: 'Has a "Never buy" rule' };
                if (direction === 'sell' && info.currentValue <= 0) return { ticker: m, reason: 'Not held (no position to sell)' };
                if (direction === 'sell' && rule.noSell) return { ticker: m, reason: 'Has a "Never sell" rule' };
                return { ticker: m, reason: 'Eligible' };
            }),
        },
        unallocated: Math.abs(deltaEur),
    });

    if (deltaEur > 0) {
        // BUY: fill gaps toward ideals; any surplus splits by weight.
        const budget = deltaEur;
        const eligible = active.filter(e => e.info.price > 0 && !e.rule.noBuy);
        if (eligible.length === 0) return blockedResult('buy');

        const gaps = eligible.map(e => Math.max(0, e.ideal - e.info.currentValue));
        const totalGap = gaps.reduce((s, g) => s + g, 0);
        const amounts = eligible.map((e, i) => {
            if (totalGap >= budget) return totalGap > 0 ? budget * (gaps[i] / totalGap) : 0;
            const weightSum = eligible.reduce((s, x) => s + x.weight, 0);
            const surplus = budget - totalGap;
            return gaps[i] + (weightSum > 0 ? surplus * (e.weight / weightSum) : 0);
        });

        let remaining = budget;
        eligible.forEach((e, i) => {
            e.shares = Math.floor(amounts[i] / e.info.price);
            e.cost = e.shares * e.info.price;
            remaining -= e.cost;
        });

        // Repeated top-up: add whole shares where they fit, favoring the member
        // furthest below its intended amount, until nothing else fits the budget.
        let changed = true;
        while (changed) {
            changed = false;
            const order = eligible
                .map((e, i) => ({ e, deficit: amounts[i] - e.cost }))
                .sort((a, b) => b.deficit - a.deficit);
            for (const { e } of order) {
                if (remaining >= e.info.price) {
                    e.shares += 1;
                    e.cost += e.info.price;
                    remaining -= e.info.price;
                    changed = true;
                }
            }
        }

        eligible.forEach(e => {
            if (e.shares > 0) actions[e.upper] = { ticker: e.ticker, eur: e.cost, shares: e.shares };
        });
        return { actions, blocked: false, unallocated: Math.max(0, remaining) };
    }

    // SELL: drain excesses over ideals; if not enough, sell deeper pro-rata.
    const need = -deltaEur;
    const eligible = active.filter(e => e.info.price > 0 && e.info.currentValue > 0 && !e.rule.noSell);
    if (eligible.length === 0) return blockedResult('sell');

    const excesses = eligible.map(e => Math.max(0, e.info.currentValue - e.ideal));
    const totalExcess = excesses.reduce((s, x) => s + x, 0);
    const amounts = eligible.map((e, i) => {
        if (totalExcess >= need) return totalExcess > 0 ? need * (excesses[i] / totalExcess) : 0;
        // Sell all excess, then dig into remaining sellable value pro-rata.
        const sellableLeft = eligible.map(x => Math.max(0, x.info.currentValue - Math.max(0, x.info.currentValue - x.ideal)));
        const totalLeft = sellableLeft.reduce((s, x) => s + x, 0);
        const shortfall = need - totalExcess;
        const extra = totalLeft > 0 ? shortfall * (sellableLeft[i] / totalLeft) : 0;
        return Math.min(e.info.currentValue, excesses[i] + extra);
    });

    let sold = 0;
    eligible.forEach((e, i) => {
        const maxShares = Math.floor(e.info.currentValue / e.info.price);
        e.shares = Math.min(Math.round(amounts[i] / e.info.price), maxShares);
        if (e.shares < 0) e.shares = 0;
        e.cost = e.shares * e.info.price;
        sold += e.cost;
    });

    // Bounded top-up: while short of the need, sell one more share from the
    // member with the largest remaining excess that still has shares to give —
    // but only when overshooting by a share beats staying short (round semantics).
    let guard = 10000;
    while (sold < need - EPS && guard-- > 0) {
        const candidates = eligible.filter(e =>
            e.shares < Math.floor(e.info.currentValue / e.info.price)
            && e.info.price < 2 * (need - sold)
        );
        if (candidates.length === 0) break;
        const pick = candidates.reduce((best, e) => {
            const remExcess = (x: WeightedMember) => x.info.currentValue - x.cost - x.ideal;
            return remExcess(e) > remExcess(best) ? e : best;
        });
        pick.shares += 1;
        pick.cost += pick.info.price;
        sold += pick.info.price;
    }

    eligible.forEach(e => {
        if (e.shares > 0) actions[e.upper] = { ticker: e.ticker, eur: -e.cost, shares: -e.shares };
    });
    return { actions, blocked: false, unallocated: Math.max(0, need - sold) };
};

/** A unit competing for liquidity in buy-only mode: a standalone ticker or a whole group. */
export interface BuyOnlyCandidate {
    key: string;   // ticker or groupId
    gap: number;   // positive underweight gap in euro
    price: number; // price of the share that will actually be bought (recipient member for groups)
    /** PAC priority (1 = highest). Undefined = not a PAC (funded only after all PACs). */
    pacPriority?: number;
}

/** Resolve the PAC priority for an allocation key (ticker or groupId), case-tolerant. */
export const pacPriorityFor = (
    pacConfigs: Record<string, PacConfig> | undefined,
    key: string
): number | undefined => {
    const cfg = pacConfigs?.[key] ?? pacConfigs?.[key.toUpperCase()];
    return cfg?.enabled ? cfg.priority : undefined;
};

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

/**
 * PAC-aware buy-only distribution of new liquidity.
 *
 * PAC candidates are funded first, tier by tier in ascending `pacPriority`
 * (1 = highest). Each tier gets at most the sum of its members' gaps; within
 * a tier the budget is split proportionally to each gap (largest-remainder,
 * whole shares), so equal-priority PACs that are further behind target
 * receive more. Whatever euro is left after all PAC tiers (including share-
 * rounding leftovers) flows to the non-PAC candidates with the same
 * proportional-gap logic.
 *
 * Returns key -> euro to deploy (same shape as `largestRemainderBuyOnly`).
 */
export const distributeBuyOnlyWithPac = (
    candidates: BuyOnlyCandidate[],
    liquidity: number
): Record<string, number> => {
    if (liquidity <= 0) return {};
    const pacs = candidates.filter(c => c.pacPriority !== undefined);
    if (pacs.length === 0) return largestRemainderBuyOnly(candidates, liquidity);

    const result: Record<string, number> = {};
    let remaining = liquidity;

    const tiers = Array.from(new Set(pacs.map(c => c.pacPriority!))).sort((a, b) => a - b);
    for (const priority of tiers) {
        if (remaining <= 0) break;
        const tier = pacs.filter(c => c.pacPriority === priority && c.gap > 0 && c.price > 0);
        if (tier.length === 0) continue;
        // A tier never takes more than what it needs to reach target.
        const tierGap = tier.reduce((s, c) => s + c.gap, 0);
        const budget = Math.min(remaining, tierGap);
        const dist = largestRemainderBuyOnly(tier, budget);
        Object.entries(dist).forEach(([key, eur]) => {
            result[key] = (result[key] || 0) + eur;
            remaining -= eur;
        });
    }

    if (remaining > 0) {
        const rest = candidates.filter(c => c.pacPriority === undefined);
        const dist = largestRemainderBuyOnly(rest, remaining);
        Object.entries(dist).forEach(([key, eur]) => {
            result[key] = (result[key] || 0) + eur;
        });
    }

    return result;
};

/**
 * Cash needed on top of the current holdings to complete a buy-only rebalance:
 * the pie must grow until the most overweight unit fits its target %, then
 * every other unit can be bought up to target. Units are standalone tickers
 * or whole groups (group value = sum of members). Group-aware counterpart of
 * `calculateRequiredLiquidityForOnlyBuy`.
 */
export const requiredLiquidityForFullBuyOnly = (
    units: { currentValue: number; targetPerc: number }[]
): number => {
    let maxImplied = 0;
    let total = 0;
    units.forEach(u => {
        total += u.currentValue;
        if (u.targetPerc > 0) {
            maxImplied = Math.max(maxImplied, u.currentValue / (u.targetPerc / 100));
        }
    });
    return Math.max(0, maxImplied - total);
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
