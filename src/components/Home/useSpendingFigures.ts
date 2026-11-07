import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabMacroCategory } from '../../types';
import { analyzeSpending } from '../../utils/spendingAnalysis';

const SPEND_MACROS: YnabMacroCategory[] = ['structural', 'variable', 'compressible', 'sinking'];
export const SPEND_COLORS: Record<string, string> = { structural: '#6366f1', variable: '#06b6d4', compressible: '#f59e0b', sinking: '#a855f7' };

/** The spending the YNAB history describes: income, consumption, savings. */
export const useSpendingFigures = () => {
    const { ynabSpendingHistory, ynabMacroMappings, ynabSpendingHistoryByBudget } = usePortfolio();
    return useMemo(() => {
        if (ynabSpendingHistory.length === 0) return null;
        const a = analyzeSpending(ynabSpendingHistory, ynabMacroMappings, ynabSpendingHistoryByBudget);
        if (a.monthsCount === 0) return null;
        // The last full month: the current one is still being spent.
        const thisMonth = `${new Date().toLocaleDateString('sv-SE').slice(0, 7)}-01`;
        const months = [...ynabSpendingHistory].sort((x, y) => x.month.localeCompare(y.month));
        const last = [...months].reverse().find(m => m.month < thisMonth) ?? months[months.length - 1];
        const lastA = analyzeSpending([last], ynabMacroMappings, ynabSpendingHistoryByBudget);
        const n = a.monthsCount;
        return {
            analysis: a,
            months: n,
            avgIncome: a.avgMonthlyIncome,
            /** Operating spending a month: structural + variable + compressible. */
            avgConsumption: a.consumptionOutflow / n,
            /** All spending a month, dated (sinking) and unmapped included, investments excluded. */
            avgSpending: a.spendingOutflow / n,
            lastMonth: last.month,
            lastConsumption: lastA.consumptionOutflow,
            byMacro: SPEND_MACROS.map(k => ({ key: k, value: a.macros[k].avgMonthlyOutflow })).filter(x => x.value > 0.5),
        };
    }, [ynabSpendingHistory, ynabMacroMappings, ynabSpendingHistoryByBudget]);
};

