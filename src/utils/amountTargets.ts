/**
 * Amount-mode portfolios: asset-liability matching instead of weight keeping.
 *
 * Every row (ticker, `_GRP_` group or `_VBOND_` placeholder) carries a € target
 * — the sum of the YNAB goals linked to it, or a manual figure when no goal is
 * linked — and a due date, the nearest of those goals' dates (a virtual bond
 * with no goal falls back to its target maturity). The plan answers "where does
 * the next euro go": gaps are filled nearest due date first, in whole shares or,
 * for bonds bought on the MOT, in lots of €1,000 nominal. Nothing is ever sold
 * — a row above its target (a bond whose price rose) is only reported.
 */
import type { Portfolio, VirtualBond, YnabGoal, YnabGoalAllocation, AssetDefinition } from '../types';
import { isVirtualBondTicker, getVirtualBondId } from '../types';

/** Minimum bond lot on the MOT, in € of nominal. */
export const BOND_LOT_NOMINAL = 1000;

export interface AmountGoalLink {
    allocationId: string;
    goalId: string;
    goalName: string;
    amount: number;
    targetDate?: string;
}

export interface AmountTargetRow {
    key: string;
    target: number;
    source: 'goals' | 'manual';
    goals: AmountGoalLink[];
    /** Nearest goal date, or the virtual bond's maturity; absent = no deadline. */
    dueDate?: string;
}

/** A goal allocation belongs to a row when it names that row in the same portfolio. */
const linksTo = (a: YnabGoalAllocation, portfolioId: string, key: string) =>
    a.portfolioId === portfolioId && !!a.ticker &&
    (isVirtualBondTicker(key) ? a.ticker === key : a.ticker.toUpperCase() === key.toUpperCase());

const earliest = (dates: (string | undefined)[]): string | undefined =>
    dates.filter((d): d is string => !!d).sort()[0];

/**
 * The € target and due date of every row of a portfolio. A row linked to at
 * least one goal takes the sum of those allocations (its manual figure is kept
 * in storage but ignored); an unlinked row takes its manual figure. Rows with
 * neither are left out.
 */
export const resolveAmountTargets = (
    portfolio: Portfolio,
    goalAllocations: YnabGoalAllocation[],
    goals: YnabGoal[],
    virtualBonds: VirtualBond[] = []
): AmountTargetRow[] => {
    const manual = portfolio.amountTargets || {};
    const linkedKeys = goalAllocations
        .filter(a => a.portfolioId === portfolio.id && !!a.ticker)
        .map(a => a.ticker as string);

    // One row per key, case-insensitively for real tickers (the manual map is
    // keyed as typed, allocations may carry the upper-cased form).
    const keys: string[] = [];
    [...Object.keys(manual), ...linkedKeys].forEach(k => {
        const seen = keys.some(x => isVirtualBondTicker(k) ? x === k : x.toUpperCase() === k.toUpperCase());
        if (!seen) keys.push(k);
    });

    const goalById = new Map(goals.map(g => [g.id, g]));

    return keys.flatMap(key => {
        const links: AmountGoalLink[] = goalAllocations
            .filter(a => linksTo(a, portfolio.id, key))
            .map(a => {
                const g = goalById.get(a.ynabGoalId);
                return { allocationId: a.id, goalId: a.ynabGoalId, goalName: g?.name ?? a.ynabGoalId, amount: a.amount, targetDate: g?.targetDate };
            });

        const vb = isVirtualBondTicker(key) ? virtualBonds.find(b => b.id === getVirtualBondId(key)) : undefined;
        const target = links.length > 0
            ? links.reduce((s, l) => s + l.amount, 0)
            : (manual[key] || 0);
        if (!(target > 0) && links.length === 0) return [];

        return [{
            key,
            target,
            source: links.length > 0 ? 'goals' as const : 'manual' as const,
            goals: links,
            dueDate: earliest(links.map(l => l.targetDate)) ?? vb?.targetMaturityDate,
        }];
    });
};

/**
 * The weights equivalent to a set of € targets: each target over their sum,
 * i.e. the mix the portfolio will have once every gap is closed.
 */
export const derivePercentAllocations = (rows: AmountTargetRow[]): Record<string, number> => {
    const total = rows.reduce((s, r) => s + Math.max(0, r.target), 0);
    const out: Record<string, number> = {};
    if (total <= 0) return out;
    rows.forEach(r => {
        if (r.target > 0) out[r.key] = Math.round((r.target / total) * 100 * 10000) / 10000;
    });
    return out;
};

/** True when two weight maps hold the same keys and (near-)identical values. */
export const sameAllocations = (a: Record<string, number>, b: Record<string, number>): boolean => {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => k in b && Math.abs(a[k] - b[k]) < 1e-6);
};

/**
 * How many units make up the minimum lot of a ticker. Only single bonds quoted
 * on the MOT trade in lots: their price is per 100 of nominal, so a €1,000 lot
 * is 10 units. A price near 1 means the position was recorded per € of nominal
 * instead, where the lot is 1,000 units. Everything else — ETFs, bond ETFs,
 * virtual-bond parking at price 1 — moves in single units.
 */
export const lotUnitsFor = (ticker: string, price: number, assetSettings: AssetDefinition[]): number => {
    if (isVirtualBondTicker(ticker)) return 1;
    const def = assetSettings.find(s => s.ticker.toUpperCase() === ticker.toUpperCase());
    if (def?.source !== 'MOT' || def.assetClass !== 'Bond') return 1;
    return price >= 5 ? BOND_LOT_NOMINAL / 100 : BOND_LOT_NOMINAL;
};

export interface AmountPlanUnit {
    key: string;
    price: number;        // € per unit of the instrument that receives the buy
    currentValue: number; // € held today in this row
    target: number;
    dueDate?: string;
    lotUnits: number;     // 1, or the units of a minimum bond lot
    order: number;        // tie-break among rows with the same (or no) due date
}

export type AmountPlanStatus =
    | 'covered'    // already at or above target
    | 'funded'     // the whole gap is bought
    | 'partial'    // some lots bought, the budget ran out
    | 'unfunded'   // gap open, nothing left in the budget for one lot
    | 'below-lot'  // gap smaller than half a lot: rounding says buy nothing
    | 'no-price';  // no price to size an order

export interface AmountPlanLine {
    key: string;
    gap: number;          // target − current, floored at 0
    excess: number;       // current − target, floored at 0 (reported, never sold)
    shares: number;
    eur: number;
    residualGap: number;  // gap still open after this buy (negative = rounded past target)
    status: AmountPlanStatus;
    lotUnits: number;
}

export interface AmountPlan {
    lines: Record<string, AmountPlanLine>;
    spent: number;
    leftover: number;
    /** Cash needed to close every gap to the nearest lot, ignoring the budget. */
    required: number;
    totalGap: number;
}

const byDueDate = (a: AmountPlanUnit, b: AmountPlanUnit) => {
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1;
    return a.order - b.order;
};

/**
 * Spend `budget` on the gaps, nearest due date first. Each gap is rounded to
 * the nearest lot (whole share for non-bonds); a row that cannot afford that
 * gets as many lots as the budget still pays for, and the rest of the budget
 * moves on to the next deadline — so a large bond lot never blocks a smaller
 * purchase further down the list.
 */
export const planAmountBuys = (units: AmountPlanUnit[], budget: number): AmountPlan => {
    const lines: Record<string, AmountPlanLine> = {};
    let remaining = Math.max(0, budget);
    let required = 0;
    let totalGap = 0;

    [...units].sort(byDueDate).forEach(u => {
        const gap = Math.max(0, u.target - u.currentValue);
        const excess = Math.max(0, u.currentValue - u.target);
        const lotUnits = Math.max(1, u.lotUnits);
        totalGap += gap;
        const line: AmountPlanLine = { key: u.key, gap, excess, shares: 0, eur: 0, residualGap: gap, status: 'covered', lotUnits };
        lines[u.key] = line;
        if (gap <= 0) return;
        if (!(u.price > 0)) { line.status = 'no-price'; return; }

        const lotCost = u.price * lotUnits;
        const wanted = Math.round(gap / lotCost);
        if (wanted === 0) { line.status = 'below-lot'; return; }
        required += wanted * lotCost;

        const affordable = Math.floor(remaining / lotCost + 1e-9);
        const lots = Math.min(wanted, affordable);
        line.shares = lots * lotUnits;
        line.eur = line.shares * u.price;
        line.residualGap = gap - line.eur;
        line.status = lots === wanted ? 'funded' : lots > 0 ? 'partial' : 'unfunded';
        remaining -= line.eur;
    });

    return { lines, spent: Math.max(0, budget) - remaining, leftover: remaining, required, totalGap };
};

/**
 * Units of a bond to buy so the position reaches `target` € of market value,
 * in whole lots — what the concretize dialog proposes once a price is known.
 */
export const suggestLotQuantity = (target: number, price: number, lotUnits: number): number => {
    if (!(target > 0) || !(price > 0)) return 0;
    const lots = Math.max(1, Math.round(target / (price * lotUnits)));
    return lots * lotUnits;
};
