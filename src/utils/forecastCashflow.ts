import type { ForecastResult } from './forecastCalculations';

// Turns the month-by-month forecast into cash-flow rows: where the money came
// from and where it went in each period, and what net worth was left. The
// engine already books every movement into one of three buckets, so each row
// reconciles exactly: opening + income − planned expenses + market P/L = closing.

export type CashflowGranularity = 'year' | 'month';

export interface CashflowRow {
    key: string;
    /** 'Year 3' or 'Year 3 · M07' */
    label: string;
    year: number;
    /** Month within the year (monthly granularity only) */
    monthOfYear?: number;
    openingValue: number;
    /** Recurring income minus recurring expenses over the period */
    income: number;
    /** One-off planned/YNAB expenses due in the period (full amount) */
    plannedExpenses: number;
    /** Market movement: what returns added or took away */
    marketPnl: number;
    closingValue: number;
    investedValue: number;
    liquidityValue: number;
    /** Liquidity change over the period (planned expenses erode it first) */
    liquidityDelta: number;
    /**
     * Deepest dip below the running high-water mark inside the period (≤ 0, %),
     * measured on the market-only index: income and planned expenses are taken
     * out of the movement, so spending 30k never reads as a 30k "crash" — the
     * expense has its own column.
     */
    drawdownPct: number;
    /** Net worth at the month of that dip */
    troughValue: number;
    /** The period where insolvency / a rule breach first shows up */
    insolvencyStarts: boolean;
    ruleBreachStarts: boolean;
}

export interface CashflowTable {
    rows: CashflowRow[];
    totals: {
        openingValue: number;
        income: number;
        plannedExpenses: number;
        marketPnl: number;
        closingValue: number;
    };
    /** Deepest market dip of the whole path (≤ 0, %) and when it happened */
    worstDrawdownPct: number;
    worstDrawdownLabel: string | null;
}

const EMPTY_TOTALS = {
    openingValue: 0, income: 0, plannedExpenses: 0, marketPnl: 0, closingValue: 0,
};

/**
 * @param results monthly forecast (month 1..N), deterministic or one Monte
 *                Carlo run replayed with `runMonteCarloScenario`
 * @param start   net worth and liquidity at month 0 — the opening of the first row
 */
export function buildCashflowTable(
    results: ForecastResult[],
    start: { totalValue: number; liquidityValue: number },
    granularity: CashflowGranularity = 'year'
): CashflowTable {
    const startValue = start.totalValue;
    if (results.length === 0) {
        return { rows: [], totals: { ...EMPTY_TOTALS }, worstDrawdownPct: 0, worstDrawdownLabel: null };
    }

    // Periods are contiguous groups of months; the high-water mark carries across
    // them, so a dip is measured against the best the path has ever been, not the
    // best of its own year.
    const groups = new Map<string, ForecastResult[]>();
    const order: string[] = [];
    for (const r of results) {
        const year = Math.ceil(r.month / 12);
        const key = granularity === 'year' ? `y${year}` : `m${r.month}`;
        const list = groups.get(key);
        if (list) list.push(r);
        else { groups.set(key, [r]); order.push(key); }
    }

    // Market-only index: each month's factor is the value change with that
    // month's flows removed (closing / (opening + income − expenses)), the same
    // flow-adjustment Performance uses. Drawdowns are measured on it.
    let index = 1;
    let peak = 1;
    let opening = startValue;
    let openingLiquidity = start.liquidityValue;
    let prevInsolvent = false;
    let prevRuleBreach = false;
    let worstDrawdownPct = 0;
    let worstDrawdownLabel: string | null = null;

    const rows: CashflowRow[] = [];
    const totals = { ...EMPTY_TOTALS, openingValue: startValue };

    for (const key of order) {
        const months = groups.get(key)!;
        const last = months[months.length - 1];
        const year = Math.ceil(last.month / 12);
        const monthOfYear = ((last.month - 1) % 12) + 1;

        let income = 0, plannedExpenses = 0, marketPnl = 0;
        let troughValue = Number.POSITIVE_INFINITY;
        let drawdownPct = 0;
        let prevValue = opening;
        for (const m of months) {
            income += m.incomeFlow;
            plannedExpenses += m.plannedExpense;
            marketPnl += m.marketPnl;

            const base = prevValue + m.incomeFlow - m.plannedExpense;
            if (base > 0) {
                index *= m.totalValue / base;
                if (index >= peak) peak = index;
                else {
                    const dd = (index / peak - 1) * 100;
                    if (dd < drawdownPct) { drawdownPct = dd; troughValue = m.totalValue; }
                }
            }
            prevValue = m.totalValue;
        }
        if (!Number.isFinite(troughValue)) troughValue = last.totalValue;

        const label = granularity === 'year' ? `Year ${year}` : `Year ${year} · M${String(monthOfYear).padStart(2, '0')}`;
        if (drawdownPct < worstDrawdownPct) {
            worstDrawdownPct = drawdownPct;
            worstDrawdownLabel = label;
        }

        rows.push({
            key,
            label,
            year,
            monthOfYear: granularity === 'month' ? monthOfYear : undefined,
            openingValue: opening,
            income,
            plannedExpenses,
            marketPnl,
            closingValue: last.totalValue,
            investedValue: last.investedValue,
            liquidityValue: last.liquidityValue,
            liquidityDelta: last.liquidityValue - openingLiquidity,
            drawdownPct,
            troughValue,
            insolvencyStarts: !!last.insolvent && !prevInsolvent,
            ruleBreachStarts: !!last.ruleBreach && !prevRuleBreach,
        });

        totals.income += income;
        totals.plannedExpenses += plannedExpenses;
        totals.marketPnl += marketPnl;
        opening = last.totalValue;
        openingLiquidity = last.liquidityValue;
        prevInsolvent = prevInsolvent || !!last.insolvent;
        prevRuleBreach = prevRuleBreach || !!last.ruleBreach;
    }

    totals.closingValue = rows.length > 0 ? rows[rows.length - 1].closingValue : startValue;
    return { rows, totals, worstDrawdownPct, worstDrawdownLabel };
}
