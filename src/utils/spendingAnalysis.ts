import type { YnabDecisionHorizon, YnabGoal, YnabMacroCategory, YnabMacroMappings, YnabMonthSnapshot } from '../types';

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
export const PAST_SAVINGS_SHARE_ALERT = 0.10; // of total outflows

const toEur = (milliunits: number): number => milliunits / 1000;

export function effectiveMacro(
    mappings: YnabMacroMappings,
    groupId: string,
    categoryId: string,
): YnabMacroCategory | null {
    return mappings.categories[categoryId] ?? mappings.groups[groupId] ?? null;
}

export function effectiveDecision(
    mappings: YnabMacroMappings,
    groupId: string,
    categoryId: string,
): YnabDecisionHorizon | null {
    return mappings.decisionCategories?.[categoryId] ?? mappings.decisionGroups?.[groupId] ?? null;
}

export const DECISION_ORDER: YnabDecisionHorizon[] = ['past', 'current', 'future'];
export const DECISION_LABELS: Record<YnabDecisionHorizon, string> = {
    past: 'Past decision',
    current: 'Current decision',
    future: 'Future decision',
};

export interface MacroCategoryTotal {
    categoryId: string;
    name: string;
    groupId: string;
    groupName: string;
    totalOutflow: number;   // EUR, positive = money spent
    totalBudgeted: number;  // EUR
    // Set on the share of a linked category attributed to one category of the
    // linked budget: which category of this budget the money came from.
    linkedFrom?: { categoryId: string; name: string; budgetId: string };
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
    // Money moved into investments is saved, not spent: none of the savings
    // figures below subtract it.
    investmentsOutflow: number;
    spendingOutflow: number;   // totalOutflow − investments (operating + dated + unmapped)
    // Savings measures, from the narrowest to the broadest:
    operatingSavings: number;  // income − consumption (operating expenses only)
    operatingSavingsRate: number | null;
    // income − the spending this period's income paid for: dated and unmapped
    // spending count only for the part not drawn from previous years' savings.
    savingsFromIncome: number;
    savingsFromIncomeRate: number | null;
    // Spending (investments excluded) paid from savings built before the window.
    pastSavingsOnSpending: number;
    netSavings: number;        // income − spending: savingsFromIncome − pastSavingsOnSpending
    savingsRate: number | null;
    macros: Record<YnabMacroCategory, MacroTotals>;
    unmappedCategories: MacroCategoryTotal[]; // with activity or budgeted, no macro
    unmappedOutflow: number;
    // Spending funded by savings built before the window: for each category,
    // outflows in excess of what was assigned to it during the window must
    // have been covered by its pre-existing YNAB balance (past years' savings).
    pastSavingsSpent: number;
    budgetFundedSpending: number; // totalOutflow − pastSavingsSpent
    pastSavingsCategories: (MacroCategoryTotal & { pastSavingsOutflow: number })[]; // drawdown desc
    // Categories handed to another budget, split by that budget's spending mix.
    linkedSplits: LinkedBudgetSplit[];
    // Every outflow by when it was decided; linked shares follow the linked
    // budget's categories. 'unset' = no decision mapped.
    decisionTotals: Record<YnabDecisionHorizon | 'unset', number>;
    /**
     * What makes up 'unset', by category, largest first. `budgetId` is set for
     * a linked budget's category: its decision is mapped on that budget's tab.
     */
    decisionUnset: {
        categoryId: string; name: string; groupId: string; groupName: string; outflow: number; budgetId?: string;
        /** A category linked to `budgetId`, whose history is not synced here: its decisions cannot be read. */
        linkedNotSynced?: boolean;
    }[];
}

export interface LinkedBudgetSplit {
    categoryId: string;
    name: string;
    groupName: string;
    budgetId: string;
    totalOutflow: number;
    /** Share of the linked budget's mapped spending per class; null = that budget has no synced history. */
    shares: Record<YnabMacroCategory, number> | null;
}

export function analyzeSpending(
    history: YnabMonthSnapshot[],
    mappings: YnabMacroMappings,
    // Spending history of the other budgets, by id: a category linked to one of
    // them (mappings.linkedBudgets) is split by that budget's own class mix.
    linkedHistories?: Record<string, YnabMonthSnapshot[]>,
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

    // Class mix of a linked budget: the share of its mapped spending per class,
    // computed once per budget, without following its own links (no cycles).
    type Mix = { shares: Record<YnabMacroCategory, number>; other: SpendingAnalysis };
    const mixCache = new Map<string, Mix | null>();
    // Categories of a linked budget paid one by one through a specific link
    // (from any budget): already counted there, so out of the generic split.
    const pinnedTargets = new Map<string, Set<string>>();
    Object.values(mappings.linkedCategories ?? {}).forEach(t => {
        const set = pinnedTargets.get(t.budgetId) ?? new Set<string>();
        set.add(t.categoryId);
        pinnedTargets.set(t.budgetId, set);
    });
    const mixOf = (budgetId: string): Mix | null => {
        if (mixCache.has(budgetId)) return mixCache.get(budgetId)!;
        const pinned = pinnedTargets.get(budgetId);
        const linkedHistory = linkedHistories?.[budgetId]?.map(m => pinned
            ? { ...m, categories: m.categories.filter(c => !pinned.has(c.categoryId)) }
            : m);
        let mix: Mix | null = null;
        if (linkedHistory && linkedHistory.length > 0) {
            const other = analyzeSpending(linkedHistory, { ...mappings, linkedBudgets: {}, linkedCategories: {} });
            const mapped = MACRO_ORDER.reduce((sum, m) => sum + Math.max(0, other.macros[m].totalOutflow), 0);
            if (mapped > 0) {
                const shares = Object.fromEntries(MACRO_ORDER.map(m => [m, Math.max(0, other.macros[m].totalOutflow) / mapped])) as Record<YnabMacroCategory, number>;
                mix = { shares, other };
            }
        }
        mixCache.set(budgetId, mix);
        return mix;
    };
    const linkedSplits: LinkedBudgetSplit[] = [];
    // A category of a linked budget, as its synced history names it.
    const targetCategory = (budgetId: string, categoryId: string) => {
        for (const m of linkedHistories?.[budgetId] ?? []) {
            const c = m.categories.find(x => x.categoryId === categoryId);
            if (c) return { categoryId: c.categoryId, name: c.name, groupId: c.groupId, groupName: c.groupName };
        }
        return null;
    };
    const decisionTotals: Record<YnabDecisionHorizon | 'unset', number> = { past: 0, current: 0, future: 0, unset: 0 };
    const unsetByCategory = new Map<string, SpendingAnalysis['decisionUnset'][number]>();
    const addDecision = (
        cat: { categoryId: string; name: string; groupId: string; groupName: string },
        outflow: number,
        budgetId?: string,
        linkedNotSynced?: boolean,
    ) => {
        const decision = effectiveDecision(mappings, cat.groupId, cat.categoryId);
        decisionTotals[decision ?? 'unset'] += outflow;
        if (decision) return;
        const key = `${budgetId ?? ''}|${cat.categoryId}`;
        const e = unsetByCategory.get(key) ?? { categoryId: cat.categoryId, name: cat.name, groupId: cat.groupId, groupName: cat.groupName, outflow: 0, budgetId, linkedNotSynced };
        e.outflow += outflow;
        unsetByCategory.set(key, e);
    };

    const unmappedCategories: MacroCategoryTotal[] = [];
    const pastSavingsCategories: (MacroCategoryTotal & { pastSavingsOutflow: number })[] = [];
    let pastSavingsSpent = 0;
    let pastSavingsInvesting = 0; // the part of pastSavingsSpent that went into investments
    for (const entry of catTotals.values()) {
        const { macro, ...cat } = entry;
        // Outflows beyond the window's assignments were paid from the balance
        // the category carried into the window, i.e. previous years' savings.
        const pastSavingsOutflow = Math.max(0, cat.totalOutflow - Math.max(0, cat.totalBudgeted));
        if (pastSavingsOutflow >= 0.005) {
            pastSavingsSpent += pastSavingsOutflow;
            pastSavingsCategories.push({ ...cat, pastSavingsOutflow });
        }
        // Paying for one specific category of another budget: counts as that
        // category, its class and decision, shown under its name.
        const pinnedTo = mappings.linkedCategories?.[cat.categoryId];
        if (pinnedTo) {
            const target = targetCategory(pinnedTo.budgetId, pinnedTo.categoryId);
            const tMacro = target ? effectiveMacro(mappings, target.groupId, target.categoryId) : null;
            pastSavingsInvesting += pastSavingsOutflow >= 0.005 && tMacro === 'investments' ? pastSavingsOutflow : 0;
            if (target) {
                addDecision(target, cat.totalOutflow, pinnedTo.budgetId);
                if (tMacro) {
                    const part: MacroCategoryTotal = {
                        categoryId: `${cat.categoryId}>${target.categoryId}`,
                        name: target.name, groupId: target.groupId, groupName: target.groupName,
                        totalOutflow: cat.totalOutflow, totalBudgeted: cat.totalBudgeted,
                        linkedFrom: { categoryId: cat.categoryId, name: cat.name, budgetId: pinnedTo.budgetId },
                    };
                    macros[tMacro].totalOutflow += part.totalOutflow;
                    macros[tMacro].totalBudgeted += part.totalBudgeted;
                    macros[tMacro].categories.push(part);
                    continue;
                }
            } else {
                addDecision(cat, cat.totalOutflow, pinnedTo.budgetId, true);
            }
            // Target not synced here, or with no class: unmapped.
            if (Math.abs(cat.totalOutflow) >= 0.005 || Math.abs(cat.totalBudgeted) >= 0.005) unmappedCategories.push(cat);
            continue;
        }
        const linkedId = mappings.linkedBudgets?.[cat.categoryId];
        const investingShare = linkedId ? (mixOf(linkedId)?.shares.investments ?? 0) : macro === 'investments' ? 1 : 0;
        pastSavingsInvesting += pastSavingsOutflow >= 0.005 ? pastSavingsOutflow * investingShare : 0;
        if (linkedId) {
            const mix = mixOf(linkedId);
            linkedSplits.push({ categoryId: cat.categoryId, name: cat.name, groupName: cat.groupName, budgetId: linkedId, totalOutflow: cat.totalOutflow, shares: mix?.shares ?? null });
            if (mix) {
                // Each class gets its share, attributed to the linked budget's
                // own categories pro rata, so the breakdown shows where it goes.
                for (const m of MACRO_ORDER) {
                    if (mix.shares[m] <= 0) continue;
                    // Within a class, pro rata to its categories that spent:
                    // the class total stays exactly its share.
                    const children = mix.other.macros[m].categories.filter(c => c.totalOutflow > 0);
                    const spent = children.reduce((sum, c) => sum + c.totalOutflow, 0);
                    for (const child of children) {
                        const ratio = mix.shares[m] * (child.totalOutflow / spent);
                        const part: MacroCategoryTotal = {
                            categoryId: `${cat.categoryId}>${child.categoryId}`,
                            name: child.name,
                            groupId: child.groupId,
                            groupName: child.groupName,
                            totalOutflow: cat.totalOutflow * ratio,
                            totalBudgeted: cat.totalBudgeted * ratio,
                            linkedFrom: { categoryId: cat.categoryId, name: cat.name, budgetId: linkedId },
                        };
                        macros[m].totalOutflow += part.totalOutflow;
                        macros[m].totalBudgeted += part.totalBudgeted;
                        macros[m].categories.push(part);
                        addDecision(child, part.totalOutflow, linkedId);
                    }
                }
                continue;
            }
            // Linked budget not synced yet: the category stays unmapped below,
            // and its decision unknown unless its own group carries one.
        }
        if (linkedId) addDecision(cat, cat.totalOutflow, linkedId, true);
        else addDecision(cat, cat.totalOutflow);
        if (macro && !linkedId) {
            macros[macro].totalOutflow += cat.totalOutflow;
            macros[macro].totalBudgeted += cat.totalBudgeted;
            macros[macro].categories.push(cat);
        } else if (Math.abs(cat.totalOutflow) >= 0.005 || Math.abs(cat.totalBudgeted) >= 0.005) {
            unmappedCategories.push(cat);
        }
    }
    pastSavingsCategories.sort((a, b) => b.pastSavingsOutflow - a.pastSavingsOutflow);

    for (const m of MACRO_ORDER) {
        macros[m].categories.sort((a, b) => b.totalOutflow - a.totalOutflow);
        macros[m].avgMonthlyOutflow = monthsCount > 0 ? macros[m].totalOutflow / monthsCount : 0;
        macros[m].shareOfIncome = totalIncome > 0 ? macros[m].totalOutflow / totalIncome : null;
    }
    unmappedCategories.sort((a, b) => b.totalOutflow - a.totalOutflow);

    const consumptionOutflow = macros.structural.totalOutflow + macros.variable.totalOutflow + macros.compressible.totalOutflow;
    const investmentsOutflow = macros.investments.totalOutflow;
    const spendingOutflow = totalOutflow - investmentsOutflow;
    const pastSavingsOnSpending = pastSavingsSpent - pastSavingsInvesting;
    const operatingSavings = totalIncome - consumptionOutflow;
    const savingsFromIncome = totalIncome - (spendingOutflow - pastSavingsOnSpending);
    const netSavings = totalIncome - spendingOutflow;
    const rate = (v: number) => (totalIncome > 0 ? v / totalIncome : null);

    return {
        monthsCount,
        firstMonth: months[0]?.month ?? null,
        lastMonth: months[months.length - 1]?.month ?? null,
        totalIncome,
        avgMonthlyIncome: monthsCount > 0 ? totalIncome / monthsCount : 0,
        totalOutflow,
        consumptionOutflow,
        investmentsOutflow,
        spendingOutflow,
        operatingSavings,
        operatingSavingsRate: rate(operatingSavings),
        savingsFromIncome,
        savingsFromIncomeRate: rate(savingsFromIncome),
        pastSavingsOnSpending,
        netSavings,
        savingsRate: rate(netSavings),
        macros,
        unmappedCategories,
        unmappedOutflow: unmappedCategories.reduce((s, c) => s + c.totalOutflow, 0),
        pastSavingsSpent,
        budgetFundedSpending: totalOutflow - pastSavingsSpent,
        pastSavingsCategories,
        linkedSplits,
        decisionTotals,
        decisionUnset: [...unsetByCategory.values()].filter(e => Math.abs(e.outflow) >= 0.5).sort((a, b) => b.outflow - a.outflow),
    };
}

// ── Forecast cashflow ────────────────────────────────────────────────
// The Forecast needs a single monthly income/expense pair, taken from the same
// rolling-year history the Summary analyses. Several budgets can be counted
// together (one per household source), and only the selected macro classes
// count as expenses — so "structural only" or "without compressible" become
// two clicks instead of a hand-computed figure.

// Expense classes counted by default: what the household actually consumes.
// Sinking funds are the planned expenses the goals already model, and
// investments are contributions the forecast grows on its own.
export const DEFAULT_FORECAST_EXPENSE_MACROS: YnabMacroCategory[] = ['structural', 'variable', 'compressible'];

export interface ForecastCashflowPerBudget {
    budgetId: string;
    monthsCount: number;
    avgMonthlyIncome: number;
    avgMonthlyExpenses: number;
}

export interface ForecastCashflow {
    // Longest history among the counted budgets, for "over the last N months".
    monthsCount: number;
    firstMonth: string | null;
    lastMonth: string | null;
    avgMonthlyIncome: number;
    avgMonthlyExpenses: number;      // selected macro classes only
    avgMonthlyByMacro: Record<YnabMacroCategory, number>;
    // Categories with no macro class: never counted, surfaced so the number can
    // be recognised as incomplete.
    avgMonthlyUnmapped: number;
    perBudget: ForecastCashflowPerBudget[];
}

export function computeForecastCashflow(
    historyByBudget: Record<string, YnabMonthSnapshot[]>,
    mappings: YnabMacroMappings,
    budgetIds: string[],
    macros: YnabMacroCategory[],
): ForecastCashflow {
    const selected = new Set(macros);
    const avgMonthlyByMacro = Object.fromEntries(MACRO_ORDER.map(m => [m, 0])) as Record<YnabMacroCategory, number>;
    const perBudget: ForecastCashflowPerBudget[] = [];
    let avgMonthlyIncome = 0;
    let avgMonthlyExpenses = 0;
    let avgMonthlyUnmapped = 0;
    let monthsCount = 0;
    let firstMonth: string | null = null;
    let lastMonth: string | null = null;

    for (const budgetId of budgetIds) {
        const history = historyByBudget[budgetId];
        if (!history || history.length === 0) continue;
        const a = analyzeSpending(history, mappings);
        const budgetExpenses = MACRO_ORDER
            .filter(m => selected.has(m))
            .reduce((sum, m) => sum + a.macros[m].avgMonthlyOutflow, 0);

        for (const m of MACRO_ORDER) avgMonthlyByMacro[m] += a.macros[m].avgMonthlyOutflow;
        avgMonthlyIncome += a.avgMonthlyIncome;
        avgMonthlyExpenses += budgetExpenses;
        avgMonthlyUnmapped += a.monthsCount > 0 ? a.unmappedOutflow / a.monthsCount : 0;
        monthsCount = Math.max(monthsCount, a.monthsCount);
        if (a.firstMonth && (firstMonth === null || a.firstMonth < firstMonth)) firstMonth = a.firstMonth;
        if (a.lastMonth && (lastMonth === null || a.lastMonth > lastMonth)) lastMonth = a.lastMonth;

        perBudget.push({
            budgetId,
            monthsCount: a.monthsCount,
            avgMonthlyIncome: a.avgMonthlyIncome,
            avgMonthlyExpenses: budgetExpenses,
        });
    }

    return {
        monthsCount,
        firstMonth,
        lastMonth,
        avgMonthlyIncome,
        avgMonthlyExpenses,
        avgMonthlyByMacro,
        avgMonthlyUnmapped,
        perBudget,
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

    if (a.totalOutflow > 0) {
        if (a.pastSavingsSpent >= 0.5) {
            const top = a.pastSavingsCategories
                .slice(0, 3)
                .map(c => `${c.name} (${fmt(c.pastSavingsOutflow, currencyIso)})`)
                .join(', ');
            lines.push(
                `Of your ${fmt(a.totalOutflow, currencyIso)} total outflows, ${fmt(a.budgetFundedSpending, currencyIso)} was covered by money assigned during the period ` +
                `and ${fmt(a.pastSavingsSpent, currencyIso)} drew down savings built in previous years` +
                (top ? `, mainly ${top}.` : '.'),
            );
        } else {
            lines.push(`All of your ${fmt(a.totalOutflow, currencyIso)} outflows were covered by money assigned during the period — no previous years' savings were consumed.`);
        }
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
            text: `Based on your ${securityGoals.length} planned capex item${securityGoals.length > 1 ? 's' : ''} due within the next ${SECURITY_HORIZON_YEARS} years, ` +
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

    // 5. Meaningful drawdown of previous years' savings.
    if (a.pastSavingsSpent >= 0.5 && a.totalOutflow > 0) {
        const share = a.pastSavingsSpent / a.totalOutflow;
        const top = a.pastSavingsCategories[0];
        insights.push({
            id: 'past-savings-drawdown',
            kind: share > PAST_SAVINGS_SHARE_ALERT ? 'warning' : 'info',
            text: `${fmt(a.pastSavingsSpent, currencyIso)} of your spending (${pct(share)} of outflows) was funded by savings from previous years` +
                (top ? `, mostly via “${top.name}”` : '') +
                ` — factor this into your budget and consider replenishing those funds.`,
        });
    }

    // 6. Negative savings.
    if (a.netSavings < 0) {
        insights.push({
            id: 'negative-savings',
            kind: 'warning',
            text: `Over the period you spent ${fmt(-a.netSavings, currencyIso)} more than you earned — ` +
                `review compressible expenses or reduce sinking-fund contributions.`,
        });
    }

    // 7. Unmapped categories reduce accuracy.
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
