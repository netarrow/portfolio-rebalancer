// How far each parent/child group sits from the ratio configured on the
// Portfolios page, and the two ways back: buying only (new cash into the light
// members, nothing sold) or a full rebalance (money moved from the heavy
// members to the light ones). Read-only: nothing here is queued or recorded.
// See scripts/verify-group-ratio-drift.ts.
import type { MergedGroupInfo } from './mergedPortfolioView';

export interface GroupRatioMember {
    portfolioId: string;
    name: string;
    value: number;
    currentShare: number; // 0..1
    targetShare: number;  // 0..1
    /** Buy only: cash to add to this member. */
    buy: number;
}

export interface GroupRatioMove {
    fromId: string;
    toId: string;
    amount: number;
}

export interface GroupRatioDrift {
    groupId: string;
    parentId: string;
    total: number;
    members: GroupRatioMember[];
    /** Largest |current − target|, in percentage points. */
    driftPoints: number;
    /** Buy only: total new cash that brings every member to its share without selling. */
    buyOnlyCash: number;
    /**
     * A member with a 0% share still holding money can never be bought back
     * into line: buy only leaves it out, only a full rebalance empties it.
     */
    buyOnlyPartial: boolean;
    /** Full rebalance: moves between members, total value unchanged. */
    moves: GroupRatioMove[];
    moveTotal: number;
}

const roundCents = (v: number): number => Math.round(v * 100) / 100;

/**
 * Groups whose ratio was configured on the Portfolios page ('config'); a group
 * split by what it is worth today has no target to drift from.
 */
export const groupRatioDrifts = (groups: MergedGroupInfo[], nameOf: (id: string) => string): GroupRatioDrift[] =>
    groups.filter(g => g.ratioSource === 'config').flatMap(g => {
        const total = g.memberIds.reduce((s, id) => s + Math.max(0, g.valueByMember[id] ?? 0), 0);
        if (total <= 0) return [];
        const shareOf = (id: string) => g.members.find(m => m.portfolioId === id)?.share ?? 0;
        const base = g.memberIds.map(id => {
            const value = Math.max(0, g.valueByMember[id] ?? 0);
            return { portfolioId: id, name: nameOf(id), value, currentShare: value / total, targetShare: shareOf(id) };
        });
        const driftPoints = Math.max(0, ...base.map(m => Math.abs(m.currentShare - m.targetShare) * 100));

        // Buy only: the group must grow until the heaviest member (against its
        // share) fits; everyone else is then topped up to their share of it.
        const sized = base.filter(m => m.targetShare > 0);
        const grown = Math.max(total, ...sized.map(m => m.value / m.targetShare));
        const members: GroupRatioMember[] = base.map(m => ({
            ...m,
            buy: m.targetShare > 0 ? Math.max(0, roundCents(m.targetShare * grown - m.value)) : 0,
        }));
        const buyOnlyCash = roundCents(members.reduce((s, m) => s + m.buy, 0));
        const buyOnlyPartial = base.some(m => m.targetShare <= 0 && m.value > 0.5);

        // Full: from whoever is over its share to whoever is under, largest first.
        const over = base.map(m => ({ id: m.portfolioId, left: m.value - m.targetShare * total })).filter(x => x.left > 0.5).sort((a, b) => b.left - a.left);
        const under = base.map(m => ({ id: m.portfolioId, left: m.targetShare * total - m.value })).filter(x => x.left > 0.5).sort((a, b) => b.left - a.left);
        const moves: GroupRatioMove[] = [];
        for (const o of over) {
            for (const u of under) {
                if (o.left <= 0.5) break;
                if (u.left <= 0.5) continue;
                const amount = Math.min(o.left, u.left);
                moves.push({ fromId: o.id, toId: u.id, amount: roundCents(amount) });
                o.left -= amount;
                u.left -= amount;
            }
        }
        return [{
            groupId: g.id, parentId: g.parentId, total, members, driftPoints,
            buyOnlyCash, buyOnlyPartial, moves,
            moveTotal: roundCents(moves.reduce((s, m) => s + m.amount, 0)),
        }];
    });
