import type { AssetDefinition, VirtualBond, YnabGoal, YnabGoalAllocation } from '../types';
import { getVirtualBondId, isVirtualBondTicker } from '../types';
import { maturityFromLabel } from './maturityLadder';
import { isGroupKey } from './portfolioCalculations';

/**
 * Whether a planned capex still has to be tied to a precise product. An
 * allocation pinned to a bond maturing in time (a real one, or a virtual bond)
 * is matched: that bond pays it at maturity. One pinned to another precise
 * product (an ETF, a stock) is a choice already made: no bond to search. What
 * is allocated to the portfolio as a whole (or to a group of tickers), or to a
 * bond maturing too late, still has to be tied to a product: that part is
 * flagged for a bond search. What is not invested yet (saved as cash in YNAB,
 * or not funded) waits.
 */
export interface CapexBond {
    label: string;
    amount: number;
    maturityDate?: string;
    /** A virtual bond not bought yet. */
    planned: boolean;
    /** Matures after the capex date: it will not be back in time. */
    late: boolean;
}

export interface CapexBondMatch {
    bonds: CapexBond[];
    /** Allocated to the portfolio as a whole, or to a group of tickers: no product chosen yet. */
    generic: number;
    /** Pinned to a precise product that is not a bond (an ETF, a stock): already chosen. */
    pinned: number;
    /**
     * What needs a bond now: the invested part not tied to a product yet
     * (allocated to the portfolio as a whole or to a group) or on a late bond,
     * up to target − YNAB cash − on-time bonds. What is still being saved as
     * cash in the YNAB category gets its bond later, once it is invested.
     */
    toMatch: number;
    /** target − YNAB cash − on-time bonds, invested or not. */
    uncovered: number;
    /** Dated, active, and with an invested part left to match. */
    needsSearch: boolean;
}

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const round = (x: number) => Math.round(x * 100) / 100;

export const capexBondMatch = (
    goal: YnabGoal,
    allocations: YnabGoalAllocation[],
    assetDefs: AssetDefinition[],
    virtualBonds: VirtualBond[],
): CapexBondMatch => {
    const defByTicker = new Map(assetDefs.map(d => [d.ticker.toUpperCase(), d]));
    const date = goal.targetDate?.slice(0, 10);
    const bonds: CapexBond[] = [];
    let generic = 0;
    let pinned = 0;
    allocations.filter(a => a.ynabGoalId === goal.id && a.amount > 0).forEach(a => {
        const ticker = a.ticker;
        if (ticker && isVirtualBondTicker(ticker)) {
            const vb = virtualBonds.find(b => b.id === getVirtualBondId(ticker));
            const maturityDate = vb?.targetMaturityDate;
            bonds.push({ label: vb?.label ?? 'Virtual bond', amount: a.amount, maturityDate, planned: !vb?.resolvedIsin, late: !!(date && maturityDate && maturityDate > date) });
            return;
        }
        const def = ticker ? defByTicker.get(ticker.toUpperCase()) : undefined;
        if (ticker && def?.assetClass === 'Bond' && def.source !== 'ETF' && ISIN_RE.test(ticker.toUpperCase())) {
            const label = def.label || ticker;
            const maturityDate = def.maturityDate ?? maturityFromLabel(label);
            bonds.push({ label, amount: a.amount, maturityDate, planned: false, late: !!(date && maturityDate && maturityDate > date) });
            return;
        }
        if (ticker && !isGroupKey(ticker)) pinned += a.amount;
        else generic += a.amount;
    });
    const need = Math.max(0, (goal.targetAmount ?? 0) - (goal.cashCoverage || 0));
    // A bond maturing too late does not cover the capex.
    const onTime = bonds.filter(b => !b.late).reduce((s, b) => s + b.amount, 0);
    const uncovered = Math.max(0, need - onTime);
    const late = bonds.filter(b => b.late).reduce((s, b) => s + b.amount, 0);
    const toMatch = round(Math.min(uncovered, generic + late));
    return { bonds, generic: round(generic), pinned: round(pinned), toMatch, uncovered: round(uncovered), needsSearch: !goal.archived && !!date && toMatch > 0.5 };
};
