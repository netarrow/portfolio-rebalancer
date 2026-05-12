import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { milliunitsToEur } from '../../services/ynabApi';
import type { YnabCategory, YnabMappingTarget } from '../../types';
import Swal from 'sweetalert2';

const formatCurrency = (value: number, iso: string = 'EUR') =>
    new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 2 }).format(value);

interface Props {
    onNavigateToSettings?: () => void;
}

const YnabImportView: React.FC<Props> = ({ onNavigateToSettings }) => {
    const {
        ynabConfig,
        ynabCategories,
        ynabMappings,
        syncYnabBudget,
        setYnabMapping,
        ynabSyncing,
        assetSettings,
        brokers,
    } = usePortfolio();

    const [search, setSearch] = useState('');

    const currencyIso = ynabConfig?.currencyIso || 'EUR';

    const mappingByCategory = useMemo(() => {
        const map = new Map<string, YnabMappingTarget>();
        for (const m of ynabMappings) map.set(m.categoryId, m.target);
        return map;
    }, [ynabMappings]);

    const filteredCategories = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return ynabCategories;
        return ynabCategories.filter(c =>
            c.name.toLowerCase().includes(q) || c.groupName.toLowerCase().includes(q)
        );
    }, [ynabCategories, search]);

    const grouped = useMemo(() => {
        const groups = new Map<string, YnabCategory[]>();
        for (const c of filteredCategories) {
            const arr = groups.get(c.groupName) || [];
            arr.push(c);
            groups.set(c.groupName, arr);
        }
        return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [filteredCategories]);

    const aggregateByTarget = useMemo(() => {
        type Bucket = { label: string; total: number; totalAvg: number; count: number };
        const buckets = new Map<string, Bucket>();
        let unmappedTotal = 0;
        let unmappedAvg = 0;
        let unmappedCount = 0;

        for (const c of ynabCategories) {
            const eur = milliunitsToEur(c.balanceMilliunits);
            const eurAvg = c.avgBudgetedMilliunits != null ? milliunitsToEur(c.avgBudgetedMilliunits) : 0;
            const target = mappingByCategory.get(c.id);
            if (!target || target.kind === 'unmapped') {
                unmappedTotal += eur;
                unmappedAvg += eurAvg;
                unmappedCount += 1;
                continue;
            }
            let key: string;
            let label: string;
            if (target.kind === 'asset') {
                key = `asset:${target.ticker}`;
                const def = assetSettings.find(a => a.ticker === target.ticker);
                label = def?.label ? `${def.label} (${target.ticker})` : target.ticker;
            } else {
                key = `cash:${target.brokerId}`;
                const broker = brokers.find(b => b.id === target.brokerId);
                label = `Cash · ${broker?.name || target.brokerId}`;
            }
            const existing = buckets.get(key) || { label, total: 0, totalAvg: 0, count: 0 };
            existing.total += eur;
            existing.totalAvg += eurAvg;
            existing.count += 1;
            buckets.set(key, existing);
        }

        return {
            items: Array.from(buckets.values()).sort((a, b) => b.totalAvg - a.totalAvg),
            unmappedTotal,
            unmappedAvg,
            unmappedCount,
        };
    }, [ynabCategories, mappingByCategory, assetSettings, brokers]);

    const totalBudget = useMemo(
        () => ynabCategories.reduce((s, c) => s + milliunitsToEur(c.balanceMilliunits), 0),
        [ynabCategories]
    );

    const totalBudgetAvg = useMemo(
        () => ynabCategories.reduce((s, c) => s + (c.avgBudgetedMilliunits != null ? milliunitsToEur(c.avgBudgetedMilliunits) : 0), 0),
        [ynabCategories]
    );

    const maxAvgMonths = useMemo(
        () => ynabCategories.reduce((m, c) => Math.max(m, c.avgMonthsCount ?? 0), 0),
        [ynabCategories]
    );
    const avgLabel = maxAvgMonths > 0 ? `Avg ${maxAvgMonths}m` : 'Average';

    const handleSync = async () => {
        const result = await syncYnabBudget();
        if (!result.ok) {
            Swal.fire({ title: 'Sync error', text: result.error, icon: 'error' });
        }
    };

    const handleMappingChange = (categoryId: string, value: string) => {
        if (value === '__unmapped') {
            setYnabMapping(categoryId, { kind: 'unmapped' });
            return;
        }
        if (value.startsWith('asset:')) {
            setYnabMapping(categoryId, { kind: 'asset', ticker: value.slice('asset:'.length) });
            return;
        }
        if (value.startsWith('cash:')) {
            setYnabMapping(categoryId, { kind: 'cash', brokerId: value.slice('cash:'.length) });
            return;
        }
    };

    const getDropdownValue = (categoryId: string): string => {
        const target = mappingByCategory.get(categoryId);
        if (!target || target.kind === 'unmapped') return '__unmapped';
        if (target.kind === 'asset') return `asset:${target.ticker}`;
        return `cash:${target.brokerId}`;
    };

    if (!ynabConfig) {
        return (
            <div style={{ maxWidth: 720, margin: '2rem auto', padding: '2rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
                <h2 style={{ marginBottom: '1rem' }}>YNAB not configured</h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                    To import your budget categories, enter your YNAB API key in Settings.
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
                <div>
                    <h2 style={{ margin: 0 }}>YNAB Budget</h2>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                        Budget: <strong>{ynabConfig.budgetName || ynabConfig.budgetId}</strong> · Currency {currencyIso}
                        {ynabConfig.lastSyncAt && (
                            <> · Last sync: {new Date(ynabConfig.lastSyncAt).toLocaleString('en-IE')}</>
                        )}
                    </div>
                </div>
                <button
                    onClick={handleSync}
                    disabled={ynabSyncing}
                    style={{ padding: '0.7rem 1.4rem', backgroundColor: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontWeight: 600 }}
                >
                    {ynabSyncing ? 'Syncing…' : 'Sync now'}
                </button>
            </div>

            {ynabCategories.length === 0 ? (
                <div style={{ padding: '2rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    No categories imported. Press <strong>Sync now</strong> to load data for the current month.
                </div>
            ) : (
                <>
                    <input
                        type="text"
                        className="form-input"
                        placeholder="Search category or group…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        style={{ width: '100%', maxWidth: '400px', marginBottom: '1rem' }}
                    />

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px 1fr', gap: '1rem', padding: '0 1rem 0.5rem 1rem', fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        <span>Category</span>
                        <span style={{ textAlign: 'right' }}>Current</span>
                        <span style={{ textAlign: 'right' }}>{avgLabel}</span>
                        <span>Mapping</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                        {grouped.map(([groupName, items]) => {
                            const groupTotal = items.reduce((s, c) => s + milliunitsToEur(c.balanceMilliunits), 0);
                            const groupAvg = items.reduce((s, c) => s + (c.avgBudgetedMilliunits != null ? milliunitsToEur(c.avgBudgetedMilliunits) : 0), 0);
                            return (
                                <div key={groupName} style={{ backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                                    <div style={{ padding: '0.75rem 1rem', backgroundColor: 'var(--bg-surface)', display: 'grid', gridTemplateColumns: '1fr 120px 120px 1fr', alignItems: 'center', gap: '1rem', fontWeight: 600 }}>
                                        <span>{groupName}</span>
                                        <span style={{ textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                            {formatCurrency(groupTotal, currencyIso)}
                                        </span>
                                        <span style={{ textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                                            {formatCurrency(groupAvg, currencyIso)}
                                        </span>
                                        <span />
                                    </div>
                                    <div>
                                        {items.map(c => {
                                            const eur = milliunitsToEur(c.balanceMilliunits);
                                            const eurAvg = c.avgBudgetedMilliunits != null ? milliunitsToEur(c.avgBudgetedMilliunits) : null;
                                            return (
                                                <div
                                                    key={c.id}
                                                    style={{
                                                        display: 'grid',
                                                        gridTemplateColumns: '1fr 120px 120px 1fr',
                                                        alignItems: 'center',
                                                        gap: '1rem',
                                                        padding: '0.6rem 1rem',
                                                        borderTop: '1px solid var(--border-color)',
                                                    }}
                                                >
                                                    <span>{c.name}</span>
                                                    <span style={{ textAlign: 'right', fontFamily: 'monospace', color: eur < 0 ? 'var(--color-danger)' : 'inherit' }}>
                                                        {formatCurrency(eur, currencyIso)}
                                                    </span>
                                                    <span style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                                        {eurAvg != null ? formatCurrency(eurAvg, currencyIso) : '—'}
                                                    </span>
                                                    <select
                                                        className="form-select"
                                                        value={getDropdownValue(c.id)}
                                                        onChange={e => handleMappingChange(c.id, e.target.value)}
                                                    >
                                                        <option value="__unmapped">— Unmapped —</option>
                                                        {assetSettings.length > 0 && (
                                                            <optgroup label="Investment assets">
                                                                {assetSettings.map(a => (
                                                                    <option key={a.ticker} value={`asset:${a.ticker}`}>
                                                                        {a.label ? `${a.label} (${a.ticker})` : a.ticker}
                                                                    </option>
                                                                ))}
                                                            </optgroup>
                                                        )}
                                                        {brokers.length > 0 && (
                                                            <optgroup label="Cash (broker)">
                                                                {brokers.map(b => (
                                                                    <option key={b.id} value={`cash:${b.id}`}>
                                                                        Cash · {b.name}
                                                                    </option>
                                                                ))}
                                                            </optgroup>
                                                        )}
                                                    </select>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Aggregate summary */}
                    <div style={{ marginTop: '2rem', padding: '1.25rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                        <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Summary by asset</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 140px', gap: '1rem', marginBottom: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            <span></span>
                            <span style={{ textAlign: 'right' }}>Current</span>
                            <span style={{ textAlign: 'right' }}>{avgLabel}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 140px', gap: '1rem', marginBottom: '0.75rem', fontWeight: 600, paddingBottom: '0.5rem', borderBottom: '1px solid var(--border-color)' }}>
                            <span>Total budget</span>
                            <span style={{ fontFamily: 'monospace', textAlign: 'right' }}>{formatCurrency(totalBudget, currencyIso)}</span>
                            <span style={{ fontFamily: 'monospace', textAlign: 'right' }}>{formatCurrency(totalBudgetAvg, currencyIso)}</span>
                        </div>
                        {aggregateByTarget.items.length === 0 && aggregateByTarget.unmappedCount === 0 ? (
                            <div style={{ color: 'var(--text-muted)' }}>No categories.</div>
                        ) : (
                            <>
                                {aggregateByTarget.items.map(item => (
                                    <div key={item.label} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 140px', gap: '1rem', padding: '0.4rem 0', borderBottom: '1px solid var(--border-color)' }}>
                                        <span>{item.label} <small style={{ color: 'var(--text-muted)' }}>({item.count} cat.)</small></span>
                                        <span style={{ fontFamily: 'monospace', textAlign: 'right' }}>{formatCurrency(item.total, currencyIso)}</span>
                                        <span style={{ fontFamily: 'monospace', textAlign: 'right', color: 'var(--text-secondary)' }}>{formatCurrency(item.totalAvg, currencyIso)}</span>
                                    </div>
                                ))}
                                {aggregateByTarget.unmappedCount > 0 && (
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 140px', gap: '1rem', padding: '0.4rem 0', color: 'var(--text-muted)' }}>
                                        <span>Unmapped <small>({aggregateByTarget.unmappedCount} cat.)</small></span>
                                        <span style={{ fontFamily: 'monospace', textAlign: 'right' }}>{formatCurrency(aggregateByTarget.unmappedTotal, currencyIso)}</span>
                                        <span style={{ fontFamily: 'monospace', textAlign: 'right' }}>{formatCurrency(aggregateByTarget.unmappedAvg, currencyIso)}</span>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

export default YnabImportView;
