// Pure logic for PAC (piano di accumulo) auto-tracking: due-date generation
// and per-installment share/fee/residue math. No React, no context — safe to
// unit test directly (see scripts/verify-pac-schedule.ts).
import type { Broker, PacExecution, PacFrequency, PacPlan } from '../types';

const roundCents = (value: number): number => Math.round(value * 1e2) / 1e2;

/** Add `n` periods (n may be negative) to an ISO date, in local time. */
export const addPeriods = (dateISO: string, frequency: PacFrequency, n: number): string => {
    const [y, m, d] = dateISO.slice(0, 10).split('-').map(Number);
    const date = new Date(y, (m ?? 1) - 1, d ?? 1);
    switch (frequency) {
        case 'weekly': date.setDate(date.getDate() + 7 * n); break;
        case 'biweekly': date.setDate(date.getDate() + 14 * n); break;
        case 'monthly': date.setMonth(date.getMonth() + n); break;
        case 'bimonthly': date.setMonth(date.getMonth() + 2 * n); break;
        case 'quarterly': date.setMonth(date.getMonth() + 3 * n); break;
        case 'semiannual': date.setMonth(date.getMonth() + 6 * n); break;
        case 'annual': date.setFullYear(date.getFullYear() + n); break;
    }
    const yy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
};

/**
 * Due dates of a plan from its startDate through `throughDateISO` (inclusive),
 * capped at plan.endDate if set. Pass `extraFuture` to additionally preview
 * that many due dates past throughDateISO (still capped at endDate) — used to
 * show "next up" rows in the schedule table.
 */
export const generateInstalments = (plan: PacPlan, throughDateISO: string, extraFuture = 0): string[] => {
    const dates: string[] = [];
    const hardCap = plan.endDate ? plan.endDate.slice(0, 10) : null;
    let current = plan.startDate.slice(0, 10);
    let future = extraFuture;
    const MAX_ITERATIONS = 5000; // safety valve against misconfigured frequencies
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (hardCap && current > hardCap) break;
        if (current > throughDateISO) {
            if (future <= 0) break;
            future--;
        }
        dates.push(current);
        if (hardCap && current === hardCap) break;
        current = addPeriods(current, plan.frequency, 1);
    }
    return dates;
};

/**
 * Carry-in budget for a due date: only 'amount' mode with 'floor-carry'
 * rounding reuses a prior residue, and only the most recent one — each
 * installment's carryOut chains into the next one's carryIn.
 */
export const carryInFor = (plan: PacPlan, executions: PacExecution[], dueDate: string): number => {
    if (plan.mode !== 'amount' || plan.rounding !== 'floor-carry') return 0;
    const prior = executions
        .filter(e => e.planId === plan.id && !e.skipped && e.dueDate < dueDate && e.carryOut !== undefined)
        .sort((a, b) => b.dueDate.localeCompare(a.dueDate))[0];
    return prior?.carryOut ?? 0;
};

/**
 * Estimated fee for a trade of the given value, per the plan's cost
 * configuration. 'broker' mode mirrors calculateCommission's fixed/percent
 * math but is evaluated on the pre-share-count trade value (an approximation
 * for 'percent' fees, since the exact share count isn't known until the fee
 * itself is netted out when costsIncluded is true).
 */
export const estimateFee = (tradeValueGuess: number, plan: PacPlan, broker?: Broker): number => {
    switch (plan.costMode) {
        case 'none':
            return 0;
        case 'fixed':
            return plan.costFixed ?? 0;
        case 'percent':
            return roundCents(tradeValueGuess * (plan.costPercent ?? 0) / 100);
        case 'broker': {
            if (!broker || !broker.commissionType) return 0;
            if (broker.commissionType === 'fixed') return broker.commissionFixed ?? 0;
            let fee = tradeValueGuess * (broker.commissionPercent ?? 0) / 100;
            if (broker.commissionMin !== undefined) fee = Math.max(fee, broker.commissionMin);
            if (broker.commissionMax !== undefined) fee = Math.min(fee, broker.commissionMax);
            return roundCents(fee);
        }
    }
};

export interface InstalmentMath {
    quantity: number;
    tradeValue: number;
    fee: number;
    totalOutlay: number;
    /** Residue left uninvested by this installment, always parked on the broker. */
    carryOut: number;
    /** Net change to apply to Broker.liquidityAllocations[portfolioId] (carryOut − carryIn). */
    parkedDelta: number;
}

/**
 * Core PAC math for one installment. Quantity-mode installments always buy
 * the exact configured unit count and never touch parking (carryOut/carryIn
 * are always 0). Amount-mode installments spend `plan.amount + carryIn`,
 * netting the fee out of it when costsIncluded, then apply rounding —
 * 'fractional' leaves no residue, 'floor'/'floor-carry' park whatever wasn't
 * spent on whole units (the two differ only in whether the caller re-feeds
 * that residue back in as the next installment's carryIn, via carryInFor).
 */
export const computeInstalment = (params: {
    plan: PacPlan;
    price: number;
    carryIn: number;
    broker?: Broker;
}): InstalmentMath => {
    const { plan, price, carryIn, broker } = params;

    if (plan.mode === 'quantity') {
        const quantity = plan.quantity ?? 0;
        const tradeValue = roundCents(quantity * price);
        const fee = estimateFee(tradeValue, plan, broker);
        return { quantity, tradeValue, fee, totalOutlay: roundCents(tradeValue + fee), carryOut: 0, parkedDelta: 0 };
    }

    const budget = roundCents((plan.amount ?? 0) + carryIn);

    if (plan.costsIncluded) {
        const fee = estimateFee(budget, plan, broker);
        const netForShares = Math.max(0, roundCents(budget - fee));
        const raw = price > 0 ? netForShares / price : 0;
        const quantity = plan.rounding === 'fractional' ? raw : Math.floor(raw);
        const tradeValue = roundCents(quantity * price);
        const carryOut = plan.rounding === 'fractional' ? 0 : roundCents(netForShares - tradeValue);
        return {
            quantity, tradeValue, fee,
            totalOutlay: roundCents(tradeValue + fee),
            carryOut,
            parkedDelta: roundCents(carryOut - carryIn),
        };
    }

    // Fee is an outlay on top of the invested budget.
    const fee = estimateFee(budget, plan, broker);
    const raw = price > 0 ? budget / price : 0;
    const quantity = plan.rounding === 'fractional' ? raw : Math.floor(raw);
    const tradeValue = roundCents(quantity * price);
    const carryOut = plan.rounding === 'fractional' ? 0 : roundCents(budget - tradeValue);
    return {
        quantity, tradeValue, fee,
        totalOutlay: roundCents(tradeValue + fee),
        carryOut,
        parkedDelta: roundCents(carryOut - carryIn),
    };
};

/** Convenience wrapper for live previews: resolves carryIn from history, then computes the math. */
export const estimateInstalment = (
    plan: PacPlan,
    price: number,
    executions: PacExecution[],
    dueDate: string,
    broker?: Broker
): InstalmentMath & { carryIn: number } => {
    const carryIn = carryInFor(plan, executions, dueDate);
    return { ...computeInstalment({ plan, price, carryIn, broker }), carryIn };
};
