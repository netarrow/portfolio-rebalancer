/**
 * The pyramid Expense Planning implies, level by level, for the Fund
 * Relocation bar:
 *  - the cash level (level 0) holds the liquidity Expense Planning asks for:
 *    operating cash + the capex held as cash;
 *  - a bucket mostly earmarked by Expense Planning — it holds an emergency
 *    fund portfolio, or its portfolios' targets (fund + capex) are at least
 *    half of what it holds — is set to exactly those targets;
 *  - the other buckets keep their own targets (if any) and share what is left
 *    of the wealth, in proportion to what they hold beyond those targets
 *    ("takes the rest").
 * Percentages are of the pyramid's own total, like the bar's.
 */
export interface PyramidLevelInput {
    id: string;
    title: string;
    color: string;
    kind: 'goal' | 'cash';
    currentValue: number;
    /** Portfolios attached to the level and counted in it. */
    portfolioIds: string[];
    /** Holds an emergency-fund portfolio: never takes the rest. */
    holdsFund?: boolean;
}

export interface PyramidLevel {
    id: string;
    title: string;
    color: string;
    kind: 'goal' | 'cash';
    current: number;
    computed: number;
    /** What the computed value comes from, in a few words. */
    source: 'liquidity' | 'expense' | 'rest' | 'kept';
    /** Of `computed`, the part set by Expense Planning targets. */
    fixed: number;
}

export interface ExpensePyramid {
    levels: PyramidLevel[];
    total: number;
    /** goalId → % (2 decimals, summing to 100): what "Use as targets" sets. */
    percents: Record<string, number>;
    /** Expense Planning asks for more than the pyramid holds. */
    shortfall: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export const buildExpensePyramid = (input: {
    levels: PyramidLevelInput[];
    total: number;
    /** € per portfolio from Expense Planning (fund + capex). */
    targetOf: (portfolioId: string) => number;
    /** The liquidity Expense Planning asks for; null keeps the cash level as it is. */
    liquidity: number | null;
}): ExpensePyramid => {
    const total = Math.max(0, input.total);
    const levels: PyramidLevel[] = input.levels.map(l => {
        if (l.kind === 'cash') {
            const v = input.liquidity ?? l.currentValue;
            return { ...base(l), computed: v, fixed: v, source: input.liquidity === null ? 'kept' : 'liquidity' };
        }
        const fixed = l.portfolioIds.reduce((s, id) => s + Math.max(0, input.targetOf(id)), 0);
        const earmarked = !!l.holdsFund || (fixed > 0.5 && fixed >= 0.5 * l.currentValue);
        return { ...base(l), computed: fixed, fixed, source: earmarked ? 'expense' : 'rest' };
    });

    const assigned = levels.reduce((s, l) => s + l.computed, 0);
    const rest = total - assigned;
    const takers = levels.filter(l => l.source === 'rest');
    let shortfall = 0;
    if (rest < 0) {
        shortfall = round2(-rest);
    } else if (takers.length > 0) {
        const free = takers.reduce((s, l) => s + Math.max(0, l.current - l.fixed), 0);
        takers.forEach(l => { l.computed += free > 0 ? rest * Math.max(0, l.current - l.fixed) / free : rest / takers.length; });
    } else if (levels.length > 0) {
        // Nobody takes the rest: it stays with the top of the pyramid.
        const top = [...levels].reverse().find(l => l.kind === 'goal') ?? levels[levels.length - 1];
        top.computed += rest;
    }
    levels.forEach(l => { l.computed = round2(Math.max(0, l.computed)); });

    // Percentages of what the levels add up to (equal to the total unless
    // Expense Planning asks for more than there is), summing to 100.
    const sum = levels.reduce((s, l) => s + l.computed, 0);
    const percents: Record<string, number> = {};
    let placed = 0;
    levels.forEach((l, i) => {
        const v = i < levels.length - 1 ? round2(sum > 0 ? (l.computed / sum) * 100 : 100 / levels.length) : round2(100 - placed);
        placed += v;
        percents[l.id] = v;
    });
    return { levels, total: round2(total), percents, shortfall };
};

const base = (l: PyramidLevelInput) => ({ id: l.id, title: l.title, color: l.color, kind: l.kind, current: l.currentValue });
