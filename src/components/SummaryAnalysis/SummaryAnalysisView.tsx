import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabDecisionHorizon, YnabMacroCategory } from '../../types';
import {
    analyzeSpending,
    effectiveMacro,
    effectiveDecision,
    DECISION_ORDER,
    DECISION_LABELS,
    MACRO_ORDER,
    MACRO_LABELS,
    MACRO_DESCRIPTIONS,
    COMPRESSIBLE_INCOME_SHARE_ALERT,
    PAST_SAVINGS_SHARE_ALERT,
} from '../../utils/spendingAnalysis';
import Swal from 'sweetalert2';
import YnabCoveragePanel from '../YnabImport/YnabCoveragePanel';

interface Props {
    onNavigateToSettings?: () => void;
    /** Shown inside Expense Planning, which already carries the page title. */
    embedded?: boolean;
}

const formatCurrency = (value: number | undefined | null, iso: string = 'EUR') =>
    value == null || Number.isNaN(value)
        ? '—'
        : new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 0 }).format(value);

const MACRO_COLORS: Record<YnabMacroCategory, string> = {
    structural: '#6366f1',
    variable: '#0ea5e9',
    compressible: '#f59e0b',
    sinking: '#14b8a6',
    investments: '#8b5cf6',
};

const DECISION_COLORS: Record<YnabDecisionHorizon | 'unset', string> = {
    past: '#a78bfa',
    current: '#f59e0b',
    future: '#10b981',
    unset: '#64748b',
};

const monthLabel = (isoMonth: string): string =>
    new Date(`${isoMonth.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-IE', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const cardStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    borderRadius: 'var(--radius-lg)',
    padding: '1.25rem',
    marginBottom: '1.5rem',
};

const selectStyle: React.CSSProperties = {
    padding: '0.3rem 0.5rem',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border-color, #444)',
    background: 'var(--bg-secondary, transparent)',
    color: 'var(--text-primary)',
};

const SummaryAnalysisView: React.FC<Props> = ({ onNavigateToSettings, embedded }) => {
    const {
        ynabConfig,
        ynabSummaryBudgetId,
        setYnabSummaryBudget,
        ynabSpendingHistory,
        ynabSpendingHistoryByBudget,
        ynabSpendingLastSyncAt,
        ynabMacroMappings,
        syncYnabSpending,
        syncYnabBudget,
        ynabSyncing,
        setYnabGroupMacro,
        setYnabCategoryMacro,
        setYnabCategoryLinkedBudget,
        setYnabGroupDecision,
        setYnabCategoryDecision,
        ynabSpendingSyncing,
        refreshYnabBudgets,
        brokers,
        ynabMappings,
        setYnabMappingSource,
        ynabFundingSettings,
    } = usePortfolio();

    const [showMapping, setShowMapping] = useState(false);
    // Macro cards opened to list every category, not just the top ones.
    const [openMacros, setOpenMacros] = useState<Record<string, boolean>>({});
    // Macro cards in totals over the window, or as monthly averages.
    const [macroMonthly, setMacroMonthly] = useState(false);
    // KPI boxes: the whole window, its monthly average, or one month ('YYYY-MM-01').
    const [kpiView, setKpiView] = useState<'total' | 'avg' | string>('total');
    const [reloadingBudgets, setReloadingBudgets] = useState(false);

    // Every budget of the token can be analysed. Before the cached list is
    // populated (or on an older config) only the primary one is offered.
    const budgets = useMemo(() => {
        const cached = ynabConfig?.budgets;
        if (cached && cached.length > 0) return cached;
        if (!ynabConfig) return [];
        return [{ id: ynabConfig.budgetId, name: ynabConfig.budgetName || ynabConfig.budgetId, currencyIso: ynabConfig.currencyIso || 'EUR' }];
    }, [ynabConfig]);

    const selectedBudget = budgets.find(b => b.id === ynabSummaryBudgetId);
    const selectedBudgetName = selectedBudget?.name || ynabSummaryBudgetId || '';
    const isPrimaryBudget = ynabSummaryBudgetId === ynabConfig?.budgetId;
    // Amounts belong to the analysed budget, which may not be the primary one.
    const currencyIso = selectedBudget?.currencyIso || ynabConfig?.currencyIso || 'EUR';

    const analysis = useMemo(
        () => analyzeSpending(ynabSpendingHistory, ynabMacroMappings, ynabSpendingHistoryByBudget),
        [ynabSpendingHistory, ynabMacroMappings, ynabSpendingHistoryByBudget],
    );

    const kpiMonths = useMemo(
        () => [...new Set(ynabSpendingHistory.map(m => m.month))].sort().reverse(),
        [ynabSpendingHistory],
    );
    const kpiMonth = kpiView !== 'total' && kpiView !== 'avg' && kpiMonths.includes(kpiView) ? kpiView : null;
    // One month on its own; a linked budget is split by that month's mix when
    // it has it, else by its whole window.
    const kpiAnalysis = useMemo(() => {
        if (!kpiMonth) return analysis;
        const linked = Object.fromEntries(Object.entries(ynabSpendingHistoryByBudget).map(([id, h]) => {
            const same = h.filter(m => m.month === kpiMonth);
            return [id, same.length > 0 ? same : h];
        }));
        return analyzeSpending(ynabSpendingHistory.filter(m => m.month === kpiMonth), ynabMacroMappings, linked);
    }, [kpiMonth, analysis, ynabSpendingHistory, ynabMacroMappings, ynabSpendingHistoryByBudget]);

    // Union of every group/category seen in the rolling window — the mapping
    // editor works even for categories no longer present in the current month.
    const mappingGroups = useMemo(() => {
        const groups = new Map<string, { id: string; name: string; categories: Map<string, { id: string; name: string }> }>();
        for (const snap of ynabSpendingHistory) {
            for (const c of snap.categories) {
                let g = groups.get(c.groupId);
                if (!g) {
                    g = { id: c.groupId, name: c.groupName, categories: new Map() };
                    groups.set(c.groupId, g);
                }
                if (!g.categories.has(c.categoryId)) g.categories.set(c.categoryId, { id: c.categoryId, name: c.name });
            }
        }
        return [...groups.values()]
            .map(g => ({ ...g, categories: [...g.categories.values()].sort((a, b) => a.name.localeCompare(b.name)) }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [ynabSpendingHistory]);

    // One button for the whole page: the spending history of the analysed
    // budget and, for the primary one, this month's categories that the
    // mapping and the liquidity coverage read.
    // Account each category's money sits on ("Cash at"), from the category mappings.
    const sourceByCategory = useMemo(
        () => new Map(ynabMappings.filter(m => m.sourceBrokerId).map(m => [m.categoryId, m.sourceBrokerId as string])),
        [ynabMappings],
    );
    const defaultSourceName = brokers.find(b => b.id === ynabFundingSettings.defaultSourceBrokerId)?.name;

    const budgetName = (id: string) => budgets.find(b => b.id === id)?.name ?? id;
    const otherBudgets = budgets.filter(b => b.id !== ynabSummaryBudgetId);

    const handleSync = async () => {
        const result = await syncYnabSpending();
        if (!result.ok) {
            Swal.fire({ title: 'Sync error', text: result.error, icon: 'error' });
            return;
        }
        // The budgets its categories are linked to are read for the split and
        // the decisions: their history is local to this browser, so sync them too.
        const linked = [...new Set(Object.values(ynabMacroMappings.linkedBudgets ?? {}))]
            .filter(id => id !== ynabSummaryBudgetId && budgets.some(b => b.id === id));
        for (const id of linked) {
            const r = await syncYnabSpending(id);
            if (!r.ok) {
                Swal.fire({ title: 'Sync error', text: `${budgetName(id)}: ${r.error}`, icon: 'error' });
                return;
            }
        }
        if (isPrimaryBudget) {
            const budget = await syncYnabBudget();
            if (!budget.ok) Swal.fire({ title: 'Sync error', text: budget.error, icon: 'error' });
        }
    };

    const handleReloadBudgets = async () => {
        setReloadingBudgets(true);
        const result = await refreshYnabBudgets();
        setReloadingBudgets(false);
        if (!result.ok) {
            Swal.fire({ title: 'Unable to load budgets', text: result.error, icon: 'error' });
        }
    };

    if (!ynabConfig) {
        return (
            <div style={{ maxWidth: 720, margin: '2rem auto', padding: '2rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
                <h2 style={{ marginBottom: '1rem' }}>YNAB not configured</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                    Expense Planning is built from your YNAB budget. Enter your YNAB API key in Settings › YNAB Integration first.
                </p>
                {onNavigateToSettings && (
                    <button
                        onClick={onNavigateToSettings}
                        style={{ padding: '0.7rem 1.5rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                    >
                        Go to YNAB Integration
                    </button>
                )}
            </div>
        );
    }

    return (
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
                <div>
                    {!embedded && <h2 style={{ margin: 0 }}>Expense Planning</h2>}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: embedded ? 0 : '0.5rem' }}>
                        <div className="ea-budget-tabs" role="tablist" aria-label="Budget">
                            {budgets.map(b => (
                                <button
                                    key={b.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={b.id === ynabSummaryBudgetId}
                                    className={b.id === ynabSummaryBudgetId ? 'active' : ''}
                                    onClick={() => setYnabSummaryBudget(b.id)}
                                >
                                    {b.name}{b.id === ynabConfig.budgetId ? ' · primary' : ''}
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={handleReloadBudgets}
                            disabled={reloadingBudgets}
                            title="Reload the budget list from YNAB"
                            style={{ padding: '0.3rem 0.6rem', background: 'transparent', color: 'var(--color-primary)', border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
                        >
                            {reloadingBudgets ? '…' : '↻'}
                        </button>
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.35rem' }}>
                        {analysis.monthsCount > 0 && analysis.firstMonth && analysis.lastMonth
                            ? <>{analysis.monthsCount} months ({monthLabel(analysis.firstMonth)} – {monthLabel(analysis.lastMonth)})</>
                            : <>Not synced yet</>}
                        {ynabSpendingLastSyncAt && (
                            <> · Last sync: {new Date(ynabSpendingLastSyncAt).toLocaleString('en-IE')}</>
                        )}
                    </div>
                </div>
                <button
                    onClick={handleSync}
                    disabled={ynabSpendingSyncing || ynabSyncing}
                    style={{ padding: '0.7rem 1.4rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                >
                    {ynabSpendingSyncing || ynabSyncing ? 'Syncing…' : 'Sync from YNAB'}
                </button>
            </div>

            {analysis.monthsCount === 0 ? (
                <div style={{ ...cardStyle, textAlign: 'center', padding: '2rem' }}>
                    <h3 style={{ marginTop: 0}}>No spending history for “{selectedBudgetName}”</h3>
                    <p style={{ color: 'var(--text-secondary)' }}>
                        Run a sync to import the last 12 months of budget, spending and income from this budget.
                        Each budget keeps its own history locally, on a rolling one-year window, so you can
                        switch back and forth without re-syncing.
                    </p>
                </div>
            ) : (
                <>
                    {/* KPI row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
                        <div className="ea-budget-tabs" role="tablist" aria-label="Period">
                            <button type="button" role="tab" aria-selected={kpiView === 'total'} className={kpiView === 'total' ? 'active' : ''} onClick={() => setKpiView('total')}>
                                Total · {analysis.monthsCount} months
                            </button>
                            <button type="button" role="tab" aria-selected={kpiView === 'avg'} className={kpiView === 'avg' ? 'active' : ''} onClick={() => setKpiView('avg')}>
                                Monthly average
                            </button>
                        </div>
                        <select
                            className={`ea-month-select${kpiMonth ? ' active' : ''}`}
                            aria-label="Month"
                            value={kpiMonth ?? ''}
                            onChange={e => setKpiView(e.target.value || 'total')}
                        >
                            <option value="">Single month…</option>
                            {kpiMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                        </select>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
                        {(() => {
                            const a = kpiAnalysis;
                            const avg = kpiView === 'avg';
                            const v = (x: number) => (avg ? x / Math.max(1, a.monthsCount) : x);
                            const ofIncome = (r: number | null) => (r != null ? `${Math.round(r * 100)}% of income` : '');
                            return [
                                { label: 'Income', value: v(a.totalIncome), sub: kpiMonth ? monthLabel(kpiMonth) : avg ? `${a.monthsCount}-month average` : `${formatCurrency(a.avgMonthlyIncome, currencyIso)}/month`, savings: false },
                                { label: 'Operating expenses', value: v(a.consumptionOutflow), sub: 'structural + variable + compressible', savings: false },
                                { label: 'Operating savings', value: v(a.operatingSavings), sub: `${ofIncome(a.operatingSavingsRate)} · income − operating expenses`, savings: true },
                                { label: 'Savings from income', value: v(a.savingsFromIncome), sub: `${ofIncome(a.savingsFromIncomeRate)} · after dated expenses paid by income`, savings: true },
                                { label: 'Drawn from past savings', value: v(a.pastSavingsOnSpending), sub: 'spending paid from previous years', savings: false },
                                { label: 'Net savings', value: v(a.netSavings), sub: `${ofIncome(a.savingsRate)} · of which invested ${formatCurrency(v(a.investmentsOutflow), currencyIso)}`, savings: true },
                            ];
                        })().map(kpi => (
                            <div key={kpi.label} style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '1rem 1.25rem' }}>
                                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{kpi.label}</div>
                                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: kpi.savings && kpi.value < 0 ? '#ef4444' : 'var(--text-primary)' }}>
                                    {formatCurrency(kpi.value, currencyIso)}
                                </div>
                                {kpi.sub && <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.15rem' }}>{kpi.sub}</div>}
                            </div>
                        ))}
                    </div>

                    {/* Key figures: monthly averages and ratios, no prose */}
                    {(() => {
                        const months = Math.max(1, analysis.monthsCount);
                        const income = analysis.totalIncome;
                        const pct = (v: number, of: number) => (of > 0 ? `${Math.round((v / of) * 100)}%` : '—');
                        const monthly = (v: number) => formatCurrency(v / months, currencyIso);
                        const consumption = analysis.consumptionOutflow;
                        const compressible = analysis.macros.compressible.totalOutflow;
                        const rows: { label: string; value: string; share: string; color?: string; warn?: boolean }[] = [
                            { label: 'Income', value: monthly(income), share: '100%' },
                            ...MACRO_ORDER.map(m => ({
                                label: MACRO_LABELS[m],
                                value: monthly(analysis.macros[m].totalOutflow),
                                share: pct(analysis.macros[m].totalOutflow, income),
                                color: MACRO_COLORS[m],
                                warn: m === 'compressible' && income > 0 && compressible / income > COMPRESSIBLE_INCOME_SHARE_ALERT,
                            })),
                            { label: 'Unmapped', value: monthly(analysis.unmappedOutflow), share: pct(analysis.unmappedOutflow, income), warn: analysis.unmappedOutflow > 0.5 },
                            { label: 'Operating savings', value: monthly(analysis.operatingSavings), share: pct(analysis.operatingSavings, income) },
                            { label: 'Savings from income', value: monthly(analysis.savingsFromIncome), share: pct(analysis.savingsFromIncome, income) },
                            { label: 'Drawn from past savings', value: monthly(analysis.pastSavingsOnSpending), share: pct(analysis.pastSavingsOnSpending, income) },
                            { label: 'Net savings', value: monthly(analysis.netSavings), share: pct(analysis.netSavings, income) },
                        ];
                        const ratios: { label: string; value: string; hint: string; warn?: boolean }[] = [
                            { label: 'Operating savings rate', value: pct(analysis.operatingSavings, income), hint: 'income − operating expenses' },
                            { label: 'Savings rate', value: pct(analysis.savingsFromIncome, income), hint: 'savings from income / income' },
                            { label: 'Consumption / income', value: pct(consumption, income), hint: 'structural + variable + compressible' },
                            { label: 'Compressible / income', value: pct(compressible, income), hint: `alert above ${Math.round(COMPRESSIBLE_INCOME_SHARE_ALERT * 100)}%`, warn: income > 0 && compressible / income > COMPRESSIBLE_INCOME_SHARE_ALERT },
                            { label: 'From past savings', value: pct(analysis.pastSavingsOnSpending, analysis.spendingOutflow), hint: `of spending · alert above ${Math.round(PAST_SAVINGS_SHARE_ALERT * 100)}%`, warn: analysis.spendingOutflow > 0 && analysis.pastSavingsOnSpending / analysis.spendingOutflow > PAST_SAVINGS_SHARE_ALERT },
                            { label: 'Unmapped categories', value: String(analysis.unmappedCategories.length), hint: formatCurrency(analysis.unmappedOutflow, currencyIso), warn: analysis.unmappedCategories.length > 0 },
                        ];
                        const drawdown = [...analysis.pastSavingsCategories].slice(0, 5);
                        return (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem', marginBottom: '1.5rem' }}>
                                <div style={{ ...cardStyle, marginBottom: 0 }}>
                                    <h3 style={{ marginTop: 0, marginBottom: '0.75rem' }}>Monthly averages</h3>
                                    <table className="ea-table">
                                        <thead><tr><th>Line</th><th className="num">€ / month</th><th className="num">% of income</th></tr></thead>
                                        <tbody>
                                            {rows.map(row => (
                                                <tr key={row.label}>
                                                    <td>
                                                        {row.color && <span className="ea-dot" style={{ background: row.color }} />}
                                                        {row.label}
                                                    </td>
                                                    <td className="num">{row.value}</td>
                                                    <td className={`num${row.warn ? ' ea-warn' : ''}`}>{row.share}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                <div style={{ ...cardStyle, marginBottom: 0 }}>
                                    <h3 style={{ marginTop: 0, marginBottom: '0.75rem' }}>Ratios</h3>
                                    <div className="ea-ratios">
                                        {ratios.map(r => (
                                            <div key={r.label} className={`ea-ratio${r.warn ? ' is-warn' : ''}`}>
                                                <div className="ea-ratio-label">{r.label}</div>
                                                <div className="ea-ratio-value">{r.value}</div>
                                                <div className="ea-ratio-hint">{r.hint}</div>
                                            </div>
                                        ))}
                                    </div>
                                    {drawdown.length > 0 && (
                                        <>
                                            <h4 style={{ margin: '1rem 0 0.5rem' }}>Spent from past savings</h4>
                                            <table className="ea-table">
                                                <tbody>
                                                    {drawdown.map(c => (
                                                        <tr key={c.categoryId}>
                                                            <td>{c.name}<span className="ea-muted"> · {c.groupName}</span></td>
                                                            <td className="num">{formatCurrency(c.pastSavingsOutflow, currencyIso)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </>
                                    )}
                                </div>
                                <style>{`
                                    .ea-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
                                    .ea-table th { text-align: left; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); padding: 0.35rem 0.4rem; border-bottom: 1px solid var(--border-color); }
                                    .ea-table td { padding: 0.45rem 0.4rem; border-bottom: 1px solid var(--border-color); }
                                    .ea-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
                                    .ea-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 0.5rem; }
                                    .ea-warn { color: #f59e0b; font-weight: 600; }
                                    .ea-muted { color: var(--text-muted); font-size: 0.8rem; }
                                    .ea-ratios { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.6rem; }
                                    .ea-ratio { border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.6rem 0.75rem; }
                                    .ea-ratio.is-warn { border-color: #f59e0b; }
                                    .ea-ratio-label { font-size: 0.75rem; color: var(--text-secondary); }
                                    .ea-ratio-value { font-size: 1.25rem; font-weight: 700; }
                                    .ea-ratio.is-warn .ea-ratio-value { color: #f59e0b; }
                                    .ea-ratio-hint { font-size: 0.72rem; color: var(--text-muted); }
                                `}</style>
                            </div>
                        );
                    })()}

                    {/* Linked budgets: categories handed to another budget, split by its mix */}
                    {analysis.linkedSplits.length > 0 && (
                        <div style={cardStyle}>
                            <h3 style={{ marginTop: 0, marginBottom: '0.75rem' }}>Linked budgets</h3>
                            <table className="ea-table">
                                <thead>
                                    <tr>
                                        <th>Category</th>
                                        <th>Split by</th>
                                        <th className="num">€ / month</th>
                                        {(['structural', 'variable', 'compressible', 'sinking', 'investments'] as YnabMacroCategory[]).map(m => (
                                            <th key={m} className="num"><span className="ea-dot" style={{ background: MACRO_COLORS[m] }} />{MACRO_LABELS[m]}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {analysis.linkedSplits.map(l => {
                                        const months = Math.max(1, analysis.monthsCount);
                                        return (
                                            <tr key={l.categoryId}>
                                                <td>{l.name}<span className="ea-muted"> · {l.groupName}</span></td>
                                                <td>{budgetName(l.budgetId)}</td>
                                                <td className="num">{formatCurrency(l.totalOutflow / months, currencyIso)}</td>
                                                {l.shares
                                                    ? (['structural', 'variable', 'compressible', 'sinking', 'investments'] as YnabMacroCategory[]).map(m => (
                                                        <td key={m} className="num">
                                                            {l.shares![m] > 0
                                                                ? <>{formatCurrency((l.totalOutflow * l.shares![m]) / months, currencyIso)}<span className="ea-muted"> {Math.round(l.shares![m] * 100)}%</span></>
                                                                : '—'}
                                                        </td>
                                                    ))
                                                    : <td colSpan={5} className="ea-warn">No spending history for {budgetName(l.budgetId)}: open its tab and sync it.</td>}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                            <div className="ea-muted" style={{ marginTop: '0.5rem' }}>
                                Each linked category is split by the linked budget's own mix of mapped spending over its synced months.
                            </div>
                        </div>
                    )}

                    {/* Macro breakdown */}
                    <div style={cardStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                            <h3 style={{ margin: 0 }}>Spending by macro category</h3>
                            <div className="ea-budget-tabs" role="tablist" aria-label="Amounts shown">
                                <button type="button" role="tab" aria-selected={!macroMonthly} className={!macroMonthly ? 'active' : ''} onClick={() => setMacroMonthly(false)}>
                                    Total · {analysis.monthsCount} months
                                </button>
                                <button type="button" role="tab" aria-selected={macroMonthly} className={macroMonthly ? 'active' : ''} onClick={() => setMacroMonthly(true)}>
                                    Monthly average
                                </button>
                            </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: '1rem' }}>
                            {MACRO_ORDER.map(macro => {
                                const m = analysis.macros[macro];
                                // Every amount of the card, in the unit picked above.
                                const amount = (v: number) => formatCurrency(macroMonthly ? v / Math.max(1, analysis.monthsCount) : v, currencyIso);
                                return (
                                    <div key={macro} style={{ border: '1px solid var(--border-color, rgba(128,128,128,0.25))', borderRadius: 'var(--radius-md)', padding: '0.9rem 1rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: MACRO_COLORS[macro], display: 'inline-block' }} />
                                            <strong>{MACRO_LABELS[macro]}</strong>
                                        </div>
                                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginBottom: '0.5rem' }}>{MACRO_DESCRIPTIONS[macro]}</div>
                                        <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{amount(m.totalOutflow)}{macroMonthly && <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--text-secondary)' }}>/month</span>}</div>
                                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                                            {macroMonthly
                                                ? <>{formatCurrency(m.totalOutflow, currencyIso)} in {analysis.monthsCount} months</>
                                                : <>{formatCurrency(m.avgMonthlyOutflow, currencyIso)}/month</>}
                                            {m.shareOfIncome != null && <> · {Math.round(m.shareOfIncome * 100)}% of income</>}
                                        </div>
                                        {m.categories.length > 0 && (() => {
                                            const open = !!openMacros[macro];
                                            const own = m.categories.filter(c => !c.linkedFrom);
                                            // Shares of linked categories, grouped by the category they came from.
                                            const linkedBlocks = new Map<string, { name: string; budgetId: string; total: number; items: typeof m.categories }>();
                                            for (const c of m.categories) {
                                                if (!c.linkedFrom) continue;
                                                const block = linkedBlocks.get(c.linkedFrom.categoryId)
                                                    ?? { name: c.linkedFrom.name, budgetId: c.linkedFrom.budgetId, total: 0, items: [] };
                                                block.total += c.totalOutflow;
                                                block.items.push(c);
                                                linkedBlocks.set(c.linkedFrom.categoryId, block);
                                            }
                                            const ownShown = open ? own : own.slice(0, 3);
                                            const childLimit = open ? Infinity : 3;
                                            const hidden = (own.length - ownShown.length)
                                                + [...linkedBlocks.values()].reduce((n, b) => n + Math.max(0, b.items.length - childLimit), 0);
                                            const line = (key: string, name: React.ReactNode, value: number, indent = false) => (
                                                <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', color: 'var(--text-secondary)', paddingLeft: indent ? '0.9rem' : 0 }}>
                                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                                                    <span>{amount(value)}</span>
                                                </div>
                                            );
                                            return (
                                                <div style={{ marginTop: '0.6rem', fontSize: '0.82rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                                                    {ownShown.map(c => line(c.categoryId, c.name, c.totalOutflow))}
                                                    {[...linkedBlocks.entries()].map(([fromId, b]) => (
                                                        <div key={fromId} style={{ marginTop: '0.35rem' }}>
                                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>↔ {b.name} · {budgetName(b.budgetId)}</span>
                                                                <span>{amount(b.total)}</span>
                                                            </div>
                                                            {b.items.slice(0, childLimit).map(c => line(c.categoryId, c.name, c.totalOutflow, true))}
                                                        </div>
                                                    ))}
                                                    {(hidden > 0 || open) && (
                                                        <button
                                                            type="button"
                                                            onClick={() => setOpenMacros(prev => ({ ...prev, [macro]: !open }))}
                                                            style={{ alignSelf: 'flex-start', marginTop: '0.35rem', background: 'transparent', border: 0, padding: 0, color: 'var(--color-primary)', cursor: 'pointer', fontSize: '0.8rem' }}
                                                        >
                                                            {open ? 'Show less' : `Show all (+${hidden})`}
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Spending by decision horizon: when each outflow was decided */}
                    {(() => {
                        const months = Math.max(1, analysis.monthsCount);
                        const slices = ([...DECISION_ORDER, 'unset'] as (YnabDecisionHorizon | 'unset')[])
                            .map(key => ({ key, value: Math.max(0, analysis.decisionTotals[key]) }))
                            .filter(sl => sl.key !== 'unset' || sl.value > 0.5);
                        const total = slices.reduce((sum, sl) => sum + sl.value, 0);
                        let cursor = 0;
                        const stops = slices.map(sl => {
                            const from = cursor;
                            cursor += total > 0 ? (sl.value / total) * 100 : 0;
                            return `${DECISION_COLORS[sl.key]} ${from}% ${cursor}%`;
                        });
                        const label = (key: YnabDecisionHorizon | 'unset') => (key === 'unset' ? 'Not set' : DECISION_LABELS[key]);
                        return (
                            <div style={cardStyle}>
                                <h3 style={{ marginTop: 0, marginBottom: '0.25rem' }}>Spending by decision</h3>
                                <div className="ea-muted" style={{ marginBottom: '1rem' }}>
                                    Every outflow by when it was decided: commitments taken in the past, choices made now,
                                    money set aside for the future. A category linked to another budget is spread over the
                                    decisions mapped on that budget's categories (set them on its tab).
                                </div>
                                {total <= 0 ? (
                                    <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Nothing to show yet: set a decision on the groups in Category mapping.</p>
                                ) : (
                                    <div style={{ display: 'flex', gap: '2rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                        <div
                                            role="img"
                                            aria-label={slices.map(sl => `${label(sl.key)} ${Math.round((sl.value / total) * 100)}%`).join(', ')}
                                            style={{ width: 180, height: 180, borderRadius: '50%', background: `conic-gradient(${stops.join(', ')})`, flexShrink: 0 }}
                                        />
                                        <table className="ea-table" style={{ flex: '1 1 320px', width: 'auto' }}>
                                            <thead><tr><th>Decision</th><th className="num">€ / month</th><th className="num">Total</th><th className="num">Share</th></tr></thead>
                                            <tbody>
                                                {slices.map(sl => (
                                                    <tr key={sl.key}>
                                                        <td><span className="ea-dot" style={{ background: DECISION_COLORS[sl.key] }} />{label(sl.key)}</td>
                                                        <td className="num">{formatCurrency(sl.value / months, currencyIso)}</td>
                                                        <td className="num">{formatCurrency(sl.value, currencyIso)}</td>
                                                        <td className={`num${sl.key === 'unset' ? ' ea-warn' : ''}`}>{Math.round((sl.value / total) * 100)}%</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                                {analysis.decisionUnset.length > 0 && (
                                    <details className="ea-unset">
                                        <summary>
                                            Not set: {analysis.decisionUnset.length} categor{analysis.decisionUnset.length === 1 ? 'y' : 'ies'}
                                            {analysis.decisionUnset.some(u => u.linkedNotSynced)
                                                ? <> (a linked budget is not synced in this browser)</>
                                                : analysis.decisionUnset.some(u => u.budgetId) && <> (some in a linked budget: set them on its tab)</>}
                                        </summary>
                                        <table className="ea-table">
                                            <thead><tr><th>Category</th><th>Group</th><th>Budget</th><th className="num">Total</th></tr></thead>
                                            <tbody>
                                                {analysis.decisionUnset.map(u => (
                                                    <tr key={`${u.budgetId ?? ''}|${u.categoryId}`}>
                                                        <td>{u.name}</td>
                                                        <td>{u.groupName}</td>
                                                        <td>
                                                            {u.linkedNotSynced
                                                                ? <span className="ea-warn">linked to {budgetName(u.budgetId!)}, not synced in this browser: open its tab and Sync</span>
                                                                : u.budgetId ? <>↔ {budgetName(u.budgetId)}</> : 'this budget'}
                                                        </td>
                                                        <td className="num">{formatCurrency(u.outflow, currencyIso)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </details>
                                )}
                            </div>
                        );
                    })()}
                </>
            )}

            {isPrimaryBudget && <YnabCoveragePanel hideCapex />}

            {analysis.monthsCount > 0 && (
                <>
                    {/* Category mapping: nature per group (categories may override) and,
                        on the primary budget, the account each category's money sits on. */}
                    <div style={cardStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                            <div style={{ flex: '1 1 420px', minWidth: 0 }}>
                                <h3 style={{ margin: 0 }}>Category mapping</h3>
                                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                                    Assign each YNAB category group to a macro class; individual categories can override their group.
                                    {isPrimaryBudget && <> Pick the account each category's money sits on.</>}
                                    {analysis.unmappedCategories.length > 0 && (
                                        <span style={{ color: '#f59e0b' }}> {analysis.unmappedCategories.length} unmapped.</span>
                                    )}
                                </div>
                            </div>
                            <button
                                onClick={() => setShowMapping(v => !v)}
                                style={{ padding: '0.45rem 1rem', background: 'transparent', color: 'var(--color-primary)', border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                            >
                                {showMapping ? 'Hide' : 'Configure'}
                            </button>
                        </div>
                        {showMapping && (
                            <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
                                {mappingGroups.map(g => {
                                    const groupMacro = ynabMacroMappings.groups[g.id] ?? '';
                                    return (
                                        <div key={g.id} style={{ border: '1px solid var(--border-color, rgba(128,128,128,0.25))', borderRadius: 'var(--radius-md)', padding: '0.75rem 1rem' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                                                <strong>{g.name}</strong>
                                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                                    <select
                                                        value={groupMacro}
                                                        onChange={e => setYnabGroupMacro(g.id, (e.target.value || null) as YnabMacroCategory | null)}
                                                        style={selectStyle}
                                                        aria-label={`Macro class of the ${g.name} group`}
                                                    >
                                                        <option value="">Not mapped</option>
                                                        {MACRO_ORDER.map(m => <option key={m} value={m}>{MACRO_LABELS[m]}</option>)}
                                                    </select>
                                                    <select
                                                        value={ynabMacroMappings.decisionGroups?.[g.id] ?? ''}
                                                        onChange={e => setYnabGroupDecision(g.id, (e.target.value || null) as YnabDecisionHorizon | null)}
                                                        style={selectStyle}
                                                        aria-label={`Decision of the ${g.name} group`}
                                                    >
                                                        <option value="">Decision: not set</option>
                                                        {DECISION_ORDER.map(d => <option key={d} value={d}>{DECISION_LABELS[d]}</option>)}
                                                    </select>
                                                </div>
                                            </div>
                                            <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                                {g.categories.map(c => {
                                                    const override = ynabMacroMappings.categories[c.id] ?? '';
                                                    const effective = effectiveMacro(ynabMacroMappings, g.id, c.id);
                                                    const linked = ynabMacroMappings.linkedBudgets?.[c.id];
                                                    const decision = effectiveDecision(ynabMacroMappings, g.id, c.id);
                                                    const decisionOverride = ynabMacroMappings.decisionCategories?.[c.id] ?? '';
                                                    return (
                                                        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', paddingLeft: '1rem', fontSize: '0.9rem' }}>
                                                            <span style={{ color: 'var(--text-secondary)' }}>
                                                                {c.name}
                                                                {linked ? (
                                                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                                                                        ↔ split by {budgetName(linked)}
                                                                    </span>
                                                                ) : effective && (
                                                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: MACRO_COLORS[effective] }}>
                                                                        {MACRO_LABELS[effective]}{override ? ' (override)' : ''}
                                                                    </span>
                                                                )}
                                                                {decision && !linked && (
                                                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: DECISION_COLORS[decision] }}>
                                                                        {DECISION_LABELS[decision]}{decisionOverride ? ' (override)' : ''}
                                                                    </span>
                                                                )}
                                                            </span>
                                                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                                                <select
                                                                    value={linked ? `link:${linked}` : override}
                                                                    onChange={e => {
                                                                        const v = e.target.value;
                                                                        if (v.startsWith('link:')) {
                                                                            setYnabCategoryLinkedBudget(c.id, v.slice(5));
                                                                            return;
                                                                        }
                                                                        if (linked) setYnabCategoryLinkedBudget(c.id, null);
                                                                        setYnabCategoryMacro(c.id, (v || null) as YnabMacroCategory | null);
                                                                    }}
                                                                    style={{ ...selectStyle, fontSize: '0.85rem' }}
                                                                    aria-label={`Macro class of ${c.name}`}
                                                                >
                                                                    <option value="">Inherit from group</option>
                                                                    {MACRO_ORDER.map(m => <option key={m} value={m}>{MACRO_LABELS[m]}</option>)}
                                                                    {(otherBudgets.length > 0 || linked) && (
                                                                        <optgroup label="Split by another budget">
                                                                            {otherBudgets.map(b => <option key={b.id} value={`link:${b.id}`}>↔ {b.name}</option>)}
                                                                            {linked && !otherBudgets.some(b => b.id === linked) && (
                                                                                <option value={`link:${linked}`}>↔ {budgetName(linked)}</option>
                                                                            )}
                                                                        </optgroup>
                                                                    )}
                                                                </select>
                                                                {linked ? (
                                                                    // A linked category is split by the linked budget's own
                                                                    // categories, for the decision as for the class.
                                                                    <select
                                                                        value=""
                                                                        disabled
                                                                        style={{ ...selectStyle, fontSize: '0.85rem', opacity: 0.7 }}
                                                                        aria-label={`Decision of ${c.name}`}
                                                                        title={`Split by the decisions mapped on ${budgetName(linked)}'s categories`}
                                                                    >
                                                                        <option value="">Decision: ↔ {budgetName(linked)}</option>
                                                                    </select>
                                                                ) : (
                                                                    <select
                                                                        value={decisionOverride}
                                                                        onChange={e => setYnabCategoryDecision(c.id, (e.target.value || null) as YnabDecisionHorizon | null)}
                                                                        style={{ ...selectStyle, fontSize: '0.85rem' }}
                                                                        aria-label={`Decision of ${c.name}`}
                                                                    >
                                                                        <option value="">Decision: inherit</option>
                                                                        {DECISION_ORDER.map(d => <option key={d} value={d}>{DECISION_LABELS[d]}</option>)}
                                                                    </select>
                                                                )}
                                                                {isPrimaryBudget && (
                                                                    <select
                                                                        value={sourceByCategory.get(c.id) ?? ''}
                                                                        onChange={e => setYnabMappingSource(c.id, e.target.value || null)}
                                                                        style={{ ...selectStyle, fontSize: '0.85rem', minWidth: 170 }}
                                                                        aria-label={`Account holding ${c.name}`}
                                                                        title="Account the category's money sits on"
                                                                    >
                                                                        <option value="">{defaultSourceName ? `🏦 Default · ${defaultSourceName}` : '🏦 No account'}</option>
                                                                        {brokers.map(b => <option key={b.id} value={b.id}>🏦 {b.name}</option>)}
                                                                    </select>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </>
            )}
            <style>{`
                .ea-budget-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--radius-md); background: var(--bg-card); flex-wrap: wrap; }
                .ea-budget-tabs button { border: 0; background: transparent; color: var(--text-secondary); font-weight: 600; font-size: 0.85rem;
                    padding: 0.4rem 0.8rem; border-radius: var(--radius-sm); cursor: pointer; }
                .ea-budget-tabs button.active { background: var(--color-primary); color: white; }
.ea-unset { margin-top: 1rem; font-size: 0.85rem; }
                .ea-unset summary { cursor: pointer; color: var(--text-secondary); font-weight: 600; }
                .ea-unset table { margin-top: 0.5rem; }
                                .ea-month-select { background: var(--bg-card); color: var(--text-secondary); border: 1px solid var(--border-color);
                    border-radius: var(--radius-md); padding: 0.4rem 0.6rem; font-weight: 600; font-size: 0.85rem; cursor: pointer; }
                .ea-month-select.active { background: var(--color-primary); color: white; border-color: var(--color-primary); }
            `}</style>
        </div>
    );
};

export default SummaryAnalysisView;
