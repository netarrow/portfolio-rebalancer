// Inter-portfolio rebalance plan for a parent/child dashboard group whose
// members have targets configured in Global Rebalancing (Asset Allocation).
// The plan only moves value BETWEEN the group's portfolios — the asset-level
// rebalance inside each portfolio is a separate concern and stays untouched.
//
// Targets are used as *relative* proportions: each member's engine target
// value is normalized over the group members, so "Core 80% / Bond Buffer 20%"
// holds regardless of how the rest of the wealth is allocated.

export interface GroupRebalanceMemberInput {
    portfolioId: string;
    name: string;
    currentValue: number; // member's value within the dashboard group
    targetBasis: number;  // target € from the global rebalance engine (used relatively)
}

export interface GroupRebalanceMemberPlan {
    portfolioId: string;
    name: string;
    currentValue: number;
    currentShare: number;  // % of the group total
    targetShare: number;   // % of the group total (normalized target)
    targetValue: number;   // € = groupTotal × targetShare
    delta: number;         // Sell+Buy €: positive = buy, negative = sell
    buyOnlyAmount: number; // Buy Only €: fresh cash to add to this member
}

export interface GroupTransfer {
    fromId: string;
    fromName: string;
    toId: string;
    toName: string;
    amount: number; // €
}

export interface GroupRebalancePlan {
    members: GroupRebalanceMemberPlan[];
    groupTotal: number;
    /** € tolerance under which a member counts as on-target: max(€1, 0.5% of group). */
    tolerance: number;
    balanced: boolean;
    /** Sell+Buy mode: value to move between members (group total unchanged). */
    transfers: GroupTransfer[];
    /** Buy Only mode: minimum fresh liquidity to restore proportions without selling. */
    buyOnlyRequired: number;
    /** True when a member holds value but has a 0% target share — unfixable without selling. */
    buyOnlyUnreachable: boolean;
}

const roundCents = (v: number): number => Math.round(v * 100) / 100;

export const computeGroupRebalance = (
    members: GroupRebalanceMemberInput[]
): GroupRebalancePlan | null => {
    const valid = members.filter(
        m => Number.isFinite(m.currentValue) && Number.isFinite(m.targetBasis)
    );
    if (valid.length < 2) return null;

    const groupTotal = valid.reduce((s, m) => s + Math.max(0, m.currentValue), 0);
    const basisTotal = valid.reduce((s, m) => s + Math.max(0, m.targetBasis), 0);
    if (groupTotal <= 0 || basisTotal <= 0) return null;

    const plans: GroupRebalanceMemberPlan[] = valid.map(m => {
        const currentValue = Math.max(0, m.currentValue);
        const targetShare = (Math.max(0, m.targetBasis) / basisTotal) * 100;
        const targetValue = roundCents((groupTotal * targetShare) / 100);
        return {
            portfolioId: m.portfolioId,
            name: m.name,
            currentValue: roundCents(currentValue),
            currentShare: (currentValue / groupTotal) * 100,
            targetShare,
            targetValue,
            delta: roundCents(targetValue - currentValue),
            buyOnlyAmount: 0,
        };
    });

    // Buy Only: the smallest post-buy group total that satisfies every target
    // share without selling is max(currentValue / targetShare) — same implied-
    // total approach as calculateRequiredLiquidityForOnlyBuy at asset level.
    let impliedTotal = groupTotal;
    let buyOnlyUnreachable = false;
    plans.forEach(p => {
        if (p.targetShare > 0) {
            impliedTotal = Math.max(impliedTotal, p.currentValue / (p.targetShare / 100));
        } else if (p.currentValue > 0) {
            buyOnlyUnreachable = true;
        }
    });
    const buyOnlyRequired = roundCents(Math.max(0, impliedTotal - groupTotal));
    if (buyOnlyRequired > 0) {
        plans.forEach(p => {
            p.buyOnlyAmount = roundCents(
                Math.max(0, (impliedTotal * p.targetShare) / 100 - p.currentValue)
            );
        });
    }

    const tolerance = Math.max(1, groupTotal * 0.005);
    const balanced = plans.every(p => Math.abs(p.delta) <= tolerance);

    // Sell+Buy transfers: pair the largest seller with the largest buyer until
    // both sides are exhausted (a 2-member group yields a single transfer).
    const transfers: GroupTransfer[] = [];
    if (!balanced) {
        const sellers = plans
            .filter(p => p.delta < 0)
            .map(p => ({ id: p.portfolioId, name: p.name, remaining: -p.delta }))
            .sort((a, b) => b.remaining - a.remaining);
        const buyers = plans
            .filter(p => p.delta > 0)
            .map(p => ({ id: p.portfolioId, name: p.name, remaining: p.delta }))
            .sort((a, b) => b.remaining - a.remaining);
        let si = 0;
        let bi = 0;
        while (si < sellers.length && bi < buyers.length) {
            const amount = roundCents(Math.min(sellers[si].remaining, buyers[bi].remaining));
            if (amount >= 1) {
                transfers.push({
                    fromId: sellers[si].id,
                    fromName: sellers[si].name,
                    toId: buyers[bi].id,
                    toName: buyers[bi].name,
                    amount,
                });
            }
            sellers[si].remaining = roundCents(sellers[si].remaining - amount);
            buyers[bi].remaining = roundCents(buyers[bi].remaining - amount);
            if (sellers[si].remaining < 0.01) si += 1;
            if (buyers[bi].remaining < 0.01) bi += 1;
        }
    }

    return {
        members: plans,
        groupTotal: roundCents(groupTotal),
        tolerance,
        balanced,
        transfers,
        buyOnlyRequired,
        buyOnlyUnreachable,
    };
};
