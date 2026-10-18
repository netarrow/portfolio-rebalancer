import type { YnabGoal, YnabGoalAllocation } from '../types';

/**
 * Capex maturity ladder: whether the money a planned capex counts on in a
 * portfolio is back in time, not just there.
 *
 * Each portfolio holds bonds (with a maturity), cash, and liquid assets (ETFs,
 * stocks, bonds of unknown maturity: sellable any day, at a price risk). Its
 * capex, nearest date first, take bonds maturing on or before their date
 * (earliest maturity first, each euro once), then cash. Only then, for what
 * is still short, a sale: liquid assets, or what no other capex counts on of
 * the bonds maturing later. A bond maturing after a capex date and claimed by
 * a later capex is locked. What nothing covers is missing; what is pinned to a
 * virtual bond not bought yet is planned.
 */

export type HoldingKind = 'bond' | 'cash' | 'liquid';

export interface LadderHolding {
    key: string;
    label: string;
    value: number;
    kind: HoldingKind;
    /** Bonds only. */
    maturityDate?: string;
    /** A virtual bond not bought yet: its value is parked cash, its target a plan. */
    plannedBond?: boolean;
}

export interface LadderPortfolio {
    id: string;
    name: string;
    holdings: LadderHolding[];
}

export interface LadderPart {
    portfolioId: string;
    label: string;
    amount: number;
    maturityDate?: string;
}

export type LadderStatus = 'covered' | 'selling' | 'planned' | 'missing';

export interface GoalLadder {
    goalId: string;
    name: string;
    date?: string;
    /** target − YNAB cash: what the portfolios are counted on for. */
    need: number;
    /** Allocated to portfolios. */
    assigned: number;
    fromMaturity: LadderPart[];
    fromCash: LadderPart[];
    fromSelling: LadderPart[];
    /** Pinned to a virtual bond still to buy. */
    planned: LadderPart[];
    /** need not allocated to any portfolio. */
    unassigned: number;
    /** Uncovered: unassigned + what the portfolios cannot provide in time. */
    missing: number;
    /** Of `missing`, what each portfolio it is allocated to cannot provide in time. */
    missingByPortfolio: Record<string, number>;
    /** Bonds in its portfolios maturing after its date: they cannot pay it. */
    locked: (LadderPart & { usedBy: string[] })[];
    status: LadderStatus;
}

export interface PortfolioLadder {
    portfolioId: string;
    name: string;
    held: number;
    /** Allocated to its capex. */
    demand: number;
    missing: number;
    /** Held and not counted on by any capex. */
    spare: number;
}

export interface MaturityLadder {
    goals: Map<string, GoalLadder>;
    portfolios: PortfolioLadder[];
}

const round = (x: number) => Math.round(x * 100) / 100;
const EPS = 0.005;

export const buildMaturityLadder = (input: {
    portfolios: LadderPortfolio[];
    goals: YnabGoal[];
    allocations: YnabGoalAllocation[];
}): MaturityLadder => {
    const active = input.goals.filter(g => !g.archived);
    const goalById = new Map(active.map(g => [g.id, g]));
    const goals = new Map<string, GoalLadder>(active.map(g => {
        const need = Math.max(0, (g.targetAmount ?? 0) - (g.cashCoverage || 0));
        const assigned = input.allocations.filter(a => a.ynabGoalId === g.id).reduce((s, a) => s + Math.max(0, a.amount), 0);
        return [g.id, {
            goalId: g.id, name: g.name, date: g.targetDate?.slice(0, 10), need: round(need), assigned: round(assigned),
            fromMaturity: [], fromCash: [], fromSelling: [], planned: [], locked: [],
            unassigned: round(Math.max(0, need - assigned)), missing: 0, missingByPortfolio: {}, status: 'covered' as LadderStatus,
        }];
    }));

    const portfolios: PortfolioLadder[] = input.portfolios.map(p => {
        const supply = p.holdings.filter(h => h.value > EPS || h.plannedBond).map(h => ({ ...h, left: Math.max(0, h.value), usedBy: new Set<string>() }));
        const demands = input.allocations
            .filter(a => a.portfolioId === p.id && goalById.has(a.ynabGoalId) && a.amount > EPS)
            .map(a => ({ a, goal: goalById.get(a.ynabGoalId)!, date: goalById.get(a.ynabGoalId)!.targetDate?.slice(0, 10) }))
            // Nearest date first; undated last; pinned rows before the pool.
            .sort((x, y) => (x.date ?? '9999').localeCompare(y.date ?? '9999') || Number(!x.a.ticker) - Number(!y.a.ticker));

        let missing = 0;
        const take = (h: typeof supply[number], amount: number, goalId: string) => {
            const used = Math.min(h.left, amount);
            h.left -= used;
            if (used > EPS) h.usedBy.add(goalId);
            return used;
        };
        const record = (gl: GoalLadder, h: typeof supply[number], used: number, date?: string) => {
            if (used <= EPS) return;
            const part: LadderPart = { portfolioId: p.id, label: h.label, amount: round(used), maturityDate: h.maturityDate };
            if (h.kind === 'cash') gl.fromCash.push(part);
            else if (h.kind === 'bond' && (!date || !h.maturityDate || h.maturityDate <= date)) gl.fromMaturity.push(part);
            else gl.fromSelling.push(part);
        };

        const short: { goal: YnabGoal; date?: string; left: number }[] = [];
        for (const { a, goal, date } of demands) {
            const gl = goals.get(goal.id)!;
            let left = a.amount;
            // A pinned row is used first, whatever it is.
            const pinned = a.ticker ? supply.find(h => h.key.toUpperCase() === a.ticker!.toUpperCase()) : undefined;
            if (pinned) { const u = take(pinned, left, goal.id); record(gl, pinned, u, date); left -= u; }
            // Pinned to a virtual bond still to buy: the rest is a plan, not a gap.
            if (left > EPS && pinned?.plannedBond) {
                gl.planned.push({ portfolioId: p.id, label: pinned.label, amount: round(left), maturityDate: pinned.maturityDate });
                continue;
            }
            const eligibleBonds = supply
                .filter(h => h.kind === 'bond' && h.left > EPS && (!date || !h.maturityDate || h.maturityDate <= date))
                .sort((x, y) => (x.maturityDate ?? '').localeCompare(y.maturityDate ?? ''));
            for (const h of eligibleBonds) { if (left <= EPS) break; const u = take(h, left, goal.id); record(gl, h, u, date); left -= u; }
            for (const h of supply.filter(x => x.kind === 'cash' && x.left > EPS)) { if (left <= EPS) break; const u = take(h, left, goal.id); record(gl, h, u, date); left -= u; }
            if (left > EPS) short.push({ goal, date, left });
        }
        // Second pass, once every capex has had its bonds and cash: what is
        // still short is sold from liquid assets, then from what is left of late bonds.
        for (const sh of short) {
            const gl = goals.get(sh.goal.id)!;
            let left = sh.left;
            const sellable = [
                ...supply.filter(x => x.kind === 'liquid' && x.left > EPS),
                // What the earlier capex left of a later bond is free, at a price risk.
                ...supply.filter(x => x.kind === 'bond' && x.left > EPS),
            ];
            for (const h of sellable) { if (left <= EPS) break; const u = take(h, left, sh.goal.id); record(gl, h, u, sh.date); left -= u; }
            if (left > EPS) {
                gl.missing += left;
                missing += left;
                gl.missingByPortfolio[p.id] = round((gl.missingByPortfolio[p.id] ?? 0) + left);
            }
        }

        // Bonds maturing after a capex date that falls short: they cannot pay it.
        for (const { goal, date } of demands) {
            const gl = goals.get(goal.id)!;
            if (!date || gl.missing <= EPS || gl.locked.some(l => l.portfolioId === p.id)) continue;
            supply
                .filter(h => h.kind === 'bond' && h.maturityDate && h.maturityDate > date)
                .forEach(h => gl.locked.push({
                    portfolioId: p.id, label: h.label, amount: round(h.value), maturityDate: h.maturityDate,
                    usedBy: [...h.usedBy].filter(id => id !== goal.id).map(id => goalById.get(id)?.name ?? id),
                }));
        }

        const held = p.holdings.reduce((s, h) => s + Math.max(0, h.value), 0);
        const demand = demands.reduce((s, d) => s + d.a.amount, 0);
        return {
            portfolioId: p.id, name: p.name, held: round(held), demand: round(demand), missing: round(missing),
            spare: round(supply.reduce((s, h) => s + Math.max(0, h.left), 0)),
        };
    }).filter(p => p.demand > EPS);

    goals.forEach(gl => {
        gl.missing = round(gl.missing + gl.unassigned);
        gl.status = gl.missing > EPS ? 'missing'
            : gl.planned.length > 0 ? 'planned'
            : gl.fromSelling.length > 0 ? 'selling'
            : 'covered';
    });
    return { goals, portfolios };
};

/** A maturity date written in a bond's name ("BTP 01/11/2027 6,5%"), 'YYYY-MM-DD'. */
export const maturityFromLabel = (label?: string): string | undefined => {
    const m = label?.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (!m) return undefined;
    const [, d, mo, y] = m;
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? undefined : iso;
};
