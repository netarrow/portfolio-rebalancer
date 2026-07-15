import type { YnabGoal, YnabMacroCategory, YnabMacroMappings, YnabMonthSnapshot } from '../types';

// Deterministic analysis of the rolling-year YNAB spending history:
// macro-category totals, income/savings breakdown, narrative sentences
// and rule-based suggestions. No randomness, no external calls.

export const MACRO_ORDER: YnabMacroCategory[] = ['structural', 'variable', 'compressible', 'sinking', 'investments'];

export const MACRO_LABELS: Record<YnabMacroCategory, string> = {
    structural: 'Structural',
    variable: 'Variable',
    compressible: 'Compressible',
    sinking: 'Sinking funds',
    investments: 'Investments',
};

export const MACRO_DESCRIPTIONS: Record<YnabMacroCategory, string> = {
    structural: 'Fixed recurring costs (rent/mortgage, utilities, insurance)',
    variable: 'Necessary but fluctuating costs (groceries, transport, health)',
    compressible: 'Discretionary costs you could cut (dining out, subscriptions, hobbies)',
    sinking: 'Money set aside for planned future expenses',
    investments: 'Contributions to long-term investments',
};

// Rule constants for the suggestion engine.
export const PROTECTION_FUND_MONTHS = 6;
export const SECURITY_HORIZON_YEARS = 7;
export const UPCOMING_EXPENSE_DAYS = 90;
export const COMPRESSIBLE_INCOME_SHARE_ALERT = 0.15;

const toEur = (milliunits: number): number => milliunits / 1000;

export function effectiveMacro(
    mappings: YnabMacroMappings,
    groupId: string,
    categoryId: string,
): YnabMacroCategory | null {
    return mappings.categories[categoryId] ?? mappings.groups[groupId] ?? null;
}

export interface MacroCategoryTotal {
    categoryId: string;
    name: string;
    groupId: string;
    groupName: string;
    totalOutflow: number;   // EUR, positive = money spent
    totalBudgeted: number;  // EUR
}

export interface MacroTotals {
    macro: YnabMacroCategory;
    totalOutflow: number;
    totalBudgeted: number;
    avgMonthlyOutflow: number;
    shareOfIncome: number | null; // 0..1, null when income is 0
    categories: MacroCategoryTotal[]; // sorted by outflow desc
}

export interface SpendingAnalysis {
    monthsCount: number;
    firstMonth: string | null; // 'YYYY-MM-01'
    lastMonth: string | null;
    totalIncome: number;
    avgMonthlyIncome: number;
    totalOutflow: number;      // every category, mapped or not
    consumptionOutflow: number; // structural + variable + compressible
    netSavings: number;        // income − total outflows
    savingsRate: number | null;
    macros: Record<YnabMacroCategory, MacroTotals>;
    unmappedCategories: MacroCategoryTotal[]; // with activity or budgeted, no macro
    unmappedOutflow: number;
}

export function analyzeSpending(
    history: YnabMonthSnapshot[],
    mappings: YnabMacroMappings,
): SpendingAnalysis {
    const months = [...history].sort((a, b) => a.month.localeCompare(b.month));
    const monthsCount = months.length;

    const emptyMacro = (macro: YnabMacroCategory): MacroTotals => ({
        macro, totalOutflow: 0, totalBudgeted: 0, avgMonthlyOutflow: 0, shareOfIncome: null, categories: [],
    });
    const macros = Object.fromEntries(MACRO_ORDER.map(m => [m, emptyMacro(m)])) as Record<YnabMacroCategory, MacroTotals>;

    let totalIncome = 0;
    let totalOutflow = 0;
    const catTotals = new Map<string, MacroCategoryTotal & { macro: YnabMacroCategory | null }>();

    for (const snap of months) {
        totalIncome += toEur(snap.incomeMilliunits);
        for (const c of snap.categories) {
            const outflow = -toEur(c.activityMilliunits); // negative activity = money out
            const budgeted = toEur(c.budgetedMilliunits);
            totalOutflow += outflow;
            let entry = catTotals.get(c.categoryId);
            if (!entry) {
                entry = {
                    categoryId: c.categoryId,
                    name: c.name,
                    groupId: c.groupId,
                    groupName: c.groupName,
                    totalOutflow: 0,
                    totalBudgeted: 0,
                    macro: effectiveMacro(mappings, c.groupId, c.categoryId),
                };
                catTotals.set(c.categoryId, entry);
            }
            entry.totalOutflow += outflow;
            entry.totalBudgeted += budgeted;
        }
    }

    const unmappedCategories: MacroCategoryTotal[] = [];
    for (const entry of catTotals.values()) {
        const { macro, ...cat } = entry;
        if (macro) {
            macros[macro].totalOutflow += cat.totalOutflow;
            macros[macro].totalBudgeted += cat.totalBudgeted;
            macros[macro].categories.push(cat);
        } else if (Math.abs(cat.totalOutflow) >= 0.005 || Math.abs(cat.totalBudgeted) >= 0.005) {
            unmappedCategories.push(cat);
        }
    }

    for (const m of MACRO_ORDER) {
        macros[m].categories.sort((a, b) => b.totalOutflow - a.totalOutflow);
        macros[m].avgMonthlyOutflow = monthsCount > 0 ? macros[m].totalOutflow / monthsCount : 0;
        macros[m].shareOfIncome = totalIncome > 0 ? macros[m].totalOutflow / totalIncome : null;
    }
    unmappedCategories.sort((a, b) => b.totalOutflow - a.totalOutflow);

    const consumptionOutflow = macros.structural.totalOutflow + macros.variable.totalOutflow + macros.compressible.totalOutflow;
    const netSavings = totalIncome - totalOutflow;

    return {
        monthsCount,
        firstMonth: months[0]?.month ?? null,
        lastMonth: months[months.length - 1]?.month ?? null,
        totalIncome,
        avgMonthlyIncome: monthsCount > 0 ? totalIncome / monthsCount : 0,
        totalOutflow,
        consumptionOutflow,
        netSavings,
        savingsRate: totalIncome > 0 ? netSavings / totalIncome : null,
        macros,
        unmappedCategories,
        unmappedOutflow: unmappedCategories.reduce((s, c) => s + c.totalOutflow, 0),
    };
}

const fmt = (value: number, iso: string): string =>
    new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 0 }).format(value);

const pct = (share: number): string => `${Math.round(share * 100)}%`;

const monthLabel = (isoMonth: string): string =>
    new Date(`${isoMonth.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-IE', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// Plain-language recap of the rolling year, one sentence per line.
export function generateNarrative(a: SpendingAnalysis, currencyIso: string = 'EUR'): string[] {
    if (a.monthsCount === 0) return [];
    const lines: string[] = [];
    const period = a.firstMonth && a.lastMonth
        ? `${monthLabel(a.firstMonth)} – ${monthLabel(a.lastMonth)}`
        : `${a.monthsCount} months`;

    lines.push(
        `Over the last ${a.monthsCount} months (${period}) you spent ` +
        `${fmt(a.macros.structural.totalOutflow, currencyIso)} in structural expenses (${fmt(a.macros.structural.avgMonthlyOutflow, currencyIso)}/month), ` +
        `${fmt(a.macros.variable.totalOutflow, currencyIso)} in variable expenses (${fmt(a.macros.variable.avgMonthlyOutflow, currencyIso)}/month) and ` +
        `${fmt(a.macros.compressible.totalOutflow, currencyIso)} in compressible expenses (${fmt(a.macros.compressible.avgMonthlyOutflow, currencyIso)}/month).`,
    );

    if (a.totalIncome > 0) {
        lines.push(`You earned ${fmt(a.totalIncome, currencyIso)} (${fmt(a.avgMonthlyIncome, currencyIso)}/month).`);
    }

    const sinking = a.macros.sinking;
    if (sinking.totalBudgeted > 0) {
        const top = sinking.categories
            .filter(c => c.totalBudgeted > 0)
            .sort((x, y) => y.totalBudgeted - x.totalBudgeted)
            .slice(0, 3);
        const names = top.map(c => `${c.name} (${fmt(c.totalBudgeted, currencyIso)})`).join(', ');
        lines.push(
            `Your income financed ${fmt(sinking.totalBudgeted, currencyIso)} of sinking funds` +
            (names ? `, mainly ${names}.` : '.'),
        );
    }

    const inv = a.macros.investments;
    if (inv.totalOutflow > 0) {
        lines.push(
            `You invested ${fmt(inv.totalOutflow, currencyIso)}` +
            (inv.shareOfIncome != null ? ` (${pct(inv.shareOfIncome)} of income)` : '') + '.',
        );
    }

    if (a.netSavings >= 0) {
        lines.push(
            `Overall you produced net cash savings of ${fmt(a.netSavings, currencyIso)}` +
            (a.savingsRate != null ? ` (${pct(a.savingsRate)} of income)` : '') + '.',
        );
    } else {
        lines.push(`Overall you spent ${fmt(-a.netSavings, currencyIso)} more than you earned.`);
    }

    return lines;
}

export interface SummaryInsight {
    id: string;
    kind: 'info' | 'suggestion' | 'warning';
    text: string;
}

export function generateSuggestions(
    a: SpendingAnalysis,
    goals: YnabGoal[],
    currencyIso: string = 'EUR',
    now: Date = new Date(),
): SummaryInsight[] {
    const insights: SummaryInsight[] = [];
    if (a.monthsCount === 0) return insights;

    // 1. Protection fund: N months of recurring (structural + variable) spending.
    const recurringMonthly = a.macros.structural.avgMonthlyOutflow + a.macros.variable.avgMonthlyOutflow;
    if (recurringMonthly > 0) {
        insights.push({
            id: 'protection-fund',
            kind: 'suggestion',
            text: `Based on your recurring expenses (${fmt(recurringMonthly, currencyIso)}/month structural + variable), ` +
                `you should keep a protection fund of at least ${fmt(recurringMonthly * PROTECTION_FUND_MONTHS, currencyIso)} ` +
                `(${PROTECTION_FUND_MONTHS} months of coverage).`,
        });
    }

    // 2. Security bucket: goals due within the horizon.
    const horizon = new Date(Date.UTC(now.getUTCFullYear() + SECURITY_HORIZON_YEARS, now.getUTCMonth(), now.getUTCDate()));
    const activeGoals = goals.filter(g => !g.archived && typeof g.targetAmount === 'number' && g.targetAmount > 0);
    const securityGoals = activeGoals.filter(g => g.targetDate && new Date(g.targetDate) <= horizon && new Date(g.targetDate) >= now);
    if (securityGoals.length > 0) {
        const need = securityGoals.reduce((s, g) => s + (g.targetAmount ?? 0), 0);
        const coverage = securityGoals.reduce((s, g) => s + g.cashCoverage, 0);
        insights.push({
            id: 'security-bucket',
            kind: 'suggestion',
            text: `Based on your ${securityGoals.length} goal${securityGoals.length > 1 ? 's' : ''} due within the next ${SECURITY_HORIZON_YEARS} years, ` +
                `your security bucket should reach at least ${fmt(need, currencyIso)} ` +
                `(current cash coverage: ${fmt(coverage, currencyIso)}).`,
        });
    }

    // 3. Upcoming planned expenses.
    const soon = new Date(now.getTime() + UPCOMING_EXPENSE_DAYS * 24 * 60 * 60 * 1000);
    for (const g of activeGoals) {
        if (!g.targetDate) continue;
        const due = new Date(g.targetDate);
        if (due < now || due > soon) continue;
        insights.push({
            id: `upcoming-${g.id}`,
            kind: 'warning',
            text: `You are about to face the planned expense “${g.name}” of ${fmt(g.targetAmount ?? 0, currencyIso)} ` +
                `around ${due.toLocaleDateString('en-IE', { month: 'long', year: 'numeric' })} — ` +
                `consider rebalancing to replenish your protection and security funds afterwards.`,
        });
    }

    // 4. Compressible margin.
    const comp = a.macros.compressible;
    if (comp.totalOutflow > 0) {
        const share = comp.shareOfIncome;
        insights.push({
            id: 'compressible-margin',
            kind: share != null && share > COMPRESSIBLE_INCOME_SHARE_ALERT ? 'suggestion' : 'info',
            text: `Compressible spending averages ${fmt(comp.avgMonthlyOutflow, currencyIso)}/month` +
                (share != null ? ` (${pct(share)} of income)` : '') +
                `: this is your main flexibility margin if you need to save more.`,
        });
    }

    // 5. Negative savings.
    if (a.netSavings < 0) {
        insights.push({
            id: 'negative-savings',
            kind: 'warning',
            text: `Over the period you spent ${fmt(-a.netSavings, currencyIso)} more than you earned — ` +
                `review compressible expenses or reduce sinking-fund contributions.`,
        });
    }

    // 6. Unmapped categories reduce accuracy.
    if (a.unmappedCategories.length > 0) {
        insights.push({
            id: 'unmapped-categories',
            kind: 'info',
            text: `${a.unmappedCategories.length} categor${a.unmappedCategories.length > 1 ? 'ies' : 'y'} totaling ` +
                `${fmt(a.unmappedOutflow, currencyIso)} of spending ${a.unmappedCategories.length > 1 ? 'are' : 'is'} not mapped ` +
                `to a macro class — map them below for a complete analysis.`,
        });
    }

    return insights;
}
