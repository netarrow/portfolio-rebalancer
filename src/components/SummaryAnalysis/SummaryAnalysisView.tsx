import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabMacroCategory } from '../../types';
import {
    analyzeSpending,
    generateNarrative,
    generateSuggestions,
    effectiveMacro,
    MACRO_ORDER,
    MACRO_LABELS,
    MACRO_DESCRIPTIONS,
    PROTECTION_FUND_MONTHS,
    SECURITY_HORIZON_YEARS,
} from '../../utils/spendingAnalysis';
import Swal from 'sweetalert2';

interface Props {
    onNavigateToSettings?: () => void;
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

const INSIGHT_COLORS: Record<'info' | 'suggestion' | 'warning', string> = {
    info: '#94a3b8',
    suggestion: '#3b82f6',
    warning: '#ef4444',
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

const SummaryAnalysisView: React.FC<Props> = ({ onNavigateToSettings }) => {
    const {
        ynabConfig,
        ynabSpendingHistory,
        ynabMacroMappings,
        syncYnabSpending,
        setYnabGroupMacro,
        setYnabCategoryMacro,
        ynabSpendingSyncing,
        ynabGoals,
    } = usePortfolio();

    const currencyIso = ynabConfig?.currencyIso || 'EUR';
    const [showMapping, setShowMapping] = useState(false);

    const analysis = useMemo(
        () => analyzeSpending(ynabSpendingHistory, ynabMacroMappings),
        [ynabSpendingHistory, ynabMacroMappings],
    );
    const narrative = useMemo(() => generateNarrative(analysis, currencyIso), [analysis, currencyIso]);
    const suggestions = useMemo(
        () => generateSuggestions(analysis, ynabGoals, currencyIso),
        [analysis, ynabGoals, currencyIso],
    );

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

    const handleSync = async () => {
        const result = await syncYnabSpending();
        if (!result.ok) {
            Swal.fire({ title: 'Sync error', text: result.error, icon: 'error' });
        }
    };

    if (!ynabConfig) {
        return (
            <div style={{ maxWidth: 720, margin: '2rem auto', padding: '2rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
                <h2 style={{ marginBottom: '1rem' }}>YNAB not configured</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                    The Summary Analysis is built from your YNAB budget. Enter your YNAB API key in Settings first.
                </p>
                {onNavigateToSettings && (
                    <button
                        onClick={onNavigateToSettings}
                        style={{ padding: '0.7rem 1.5rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                    >
                        Go to Settings
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
                    <h2 style={{ margin: 0 }}>Summary Analysis</h2>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                        Budget: <strong>{ynabConfig.budgetName || ynabConfig.budgetId}</strong>
                        {analysis.monthsCount > 0 && analysis.firstMonth && analysis.lastMonth && (
                            <> · {analysis.monthsCount} months ({monthLabel(analysis.firstMonth)} – {monthLabel(analysis.lastMonth)})</>
                        )}
                        {ynabConfig.lastSpendingSyncAt && (
                            <> · Last sync: {new Date(ynabConfig.lastSpendingSyncAt).toLocaleString('en-IE')}</>
                        )}
                    </div>
                </div>
                <button
                    onClick={handleSync}
                    disabled={ynabSpendingSyncing}
                    style={{ padding: '0.7rem 1.4rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                >
                    {ynabSpendingSyncing ? 'Syncing…' : 'Sync spending'}
                </button>
            </div>

            {analysis.monthsCount === 0 ? (
                <div style={{ ...cardStyle, textAlign: 'center', padding: '2rem' }}>
                    <h3 style={{ marginTop: 0 }}>No spending history yet</h3>
                    <p style={{ color: 'var(--text-secondary)' }}>
                        Run a sync to import the last 12 months of budget, spending and income from YNAB.
                        Data is kept locally with a rolling one-year window.
                    </p>
                </div>
            ) : (
                <>
                    {/* KPI row */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
                        {[
                            { label: 'Income', value: analysis.totalIncome, sub: `${formatCurrency(analysis.avgMonthlyIncome, currencyIso)}/month` },
                            { label: 'Consumption', value: analysis.consumptionOutflow, sub: 'structural + variable + compressible' },
                            { label: 'Investments', value: analysis.macros.investments.totalOutflow, sub: analysis.macros.investments.shareOfIncome != null ? `${Math.round(analysis.macros.investments.shareOfIncome * 100)}% of income` : '' },
                            { label: 'Net savings', value: analysis.netSavings, sub: analysis.savingsRate != null ? `${Math.round(analysis.savingsRate * 100)}% of income` : '' },
                        ].map(kpi => (
                            <div key={kpi.label} style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '1rem 1.25rem' }}>
                                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{kpi.label}</div>
                                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: kpi.label === 'Net savings' && kpi.value < 0 ? '#ef4444' : 'var(--text-primary)' }}>
                                    {formatCurrency(kpi.value, currencyIso)}
                                </div>
                                {kpi.sub && <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.15rem' }}>{kpi.sub}</div>}
                            </div>
                        ))}
                    </div>

                    {/* Yearly narrative */}
                    <div style={cardStyle}>
                        <h3 style={{ marginTop: 0, marginBottom: '0.75rem' }}>Yearly summary</h3>
                        <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'var(--text-primary)', lineHeight: 1.7 }}>
                            {narrative.map((line, i) => <li key={i}>{line}</li>)}
                        </ul>
                    </div>

                    {/* Suggestions */}
                    <div style={cardStyle}>
                        <h3 style={{ marginTop: 0, marginBottom: '0.35rem' }}>Suggestions</h3>
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.9rem' }}>
                            Deterministic rules: protection fund = {PROTECTION_FUND_MONTHS} months of recurring expenses,
                            security bucket = goals due within {SECURITY_HORIZON_YEARS} years.
                        </div>
                        {suggestions.length === 0 ? (
                            <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Nothing to report.</p>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                {suggestions.map(s => (
                                    <div key={s.id} style={{ borderLeft: `4px solid ${INSIGHT_COLORS[s.kind]}`, padding: '0.5rem 0.9rem', background: 'var(--bg-secondary, rgba(128,128,128,0.06))', borderRadius: 'var(--radius-md)' }}>
                                        {s.text}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Macro breakdown */}
                    <div style={cardStyle}>
                        <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Spending by macro category</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
                            {MACRO_ORDER.map(macro => {
                                const m = analysis.macros[macro];
                                return (
                                    <div key={macro} style={{ border: '1px solid var(--border-color, rgba(128,128,128,0.25))', borderRadius: 'var(--radius-md)', padding: '0.9rem 1rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: MACRO_COLORS[macro], display: 'inline-block' }} />
                                            <strong>{MACRO_LABELS[macro]}</strong>
                                        </div>
                                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginBottom: '0.5rem' }}>{MACRO_DESCRIPTIONS[macro]}</div>
                                        <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{formatCurrency(m.totalOutflow, currencyIso)}</div>
                                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                                            {formatCurrency(m.avgMonthlyOutflow, currencyIso)}/month
                                            {m.shareOfIncome != null && <> · {Math.round(m.shareOfIncome * 100)}% of income</>}
                                        </div>
                                        {m.categories.length > 0 && (
                                            <div style={{ marginTop: '0.6rem', fontSize: '0.82rem' }}>
                                                {m.categories.slice(0, 3).map(c => (
                                                    <div key={c.categoryId} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', color: 'var(--text-secondary)' }}>
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                                                        <span>{formatCurrency(c.totalOutflow, currencyIso)}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Macro mapping editor */}
                    <div style={cardStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                            <div>
                                <h3 style={{ margin: 0 }}>Macro category mapping</h3>
                                <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
                                    Assign each YNAB category group to a macro class; individual categories can override their group.
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
                                                <select
                                                    value={groupMacro}
                                                    onChange={e => setYnabGroupMacro(g.id, (e.target.value || null) as YnabMacroCategory | null)}
                                                    style={selectStyle}
                                                >
                                                    <option value="">Not mapped</option>
                                                    {MACRO_ORDER.map(m => <option key={m} value={m}>{MACRO_LABELS[m]}</option>)}
                                                </select>
                                            </div>
                                            <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                                {g.categories.map(c => {
                                                    const override = ynabMacroMappings.categories[c.id] ?? '';
                                                    const effective = effectiveMacro(ynabMacroMappings, g.id, c.id);
                                                    return (
                                                        <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', paddingLeft: '1rem', fontSize: '0.9rem' }}>
                                                            <span style={{ color: 'var(--text-secondary)' }}>
                                                                {c.name}
                                                                {effective && (
                                                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: MACRO_COLORS[effective] }}>
                                                                        {MACRO_LABELS[effective]}{override ? ' (override)' : ''}
                                                                    </span>
                                                                )}
                                                            </span>
                                                            <select
                                                                value={override}
                                                                onChange={e => setYnabCategoryMacro(c.id, (e.target.value || null) as YnabMacroCategory | null)}
                                                                style={{ ...selectStyle, fontSize: '0.85rem' }}
                                                            >
                                                                <option value="">Inherit from group</option>
                                                                {MACRO_ORDER.map(m => <option key={m} value={m}>{MACRO_LABELS[m]}</option>)}
                                                            </select>
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
        </div>
    );
};

export default SummaryAnalysisView;
