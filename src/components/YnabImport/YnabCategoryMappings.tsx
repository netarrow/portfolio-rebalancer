import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabCategory, YnabMappingTarget } from '../../types';
import { milliunitsToEur } from '../../services/ynabApi';

/**
 * Where each YNAB category's money is meant to end up.
 *
 * One row per category, grouped as YNAB groups them: pick an asset (the money
 * becomes shares) or a broker's cash (it stays liquid there). An asset row can
 * also name the broker the order goes through and the portfolio it belongs to —
 * both optional, but naming them is what lets the funding plan below price the
 * commission and register the trade.
 */

const eur = (value: number) =>
    value.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

const CASH_PREFIX = 'cash:';
const ASSET_PREFIX = 'asset:';

const YnabCategoryMappings: React.FC = () => {
    const {
        ynabCategories, ynabMappings, setYnabMapping,
        assetSettings, brokers, portfolios,
    } = usePortfolio();

    const [search, setSearch] = useState('');
    const [mappedOnly, setMappedOnly] = useState(false);

    const mappingByCategory = useMemo(
        () => new Map(ynabMappings.map(m => [m.categoryId, m.target])),
        [ynabMappings],
    );

    // Assets worth offering: everything in the registry except the cash and
    // group pseudo-tickers, ordered by label so the select reads like the app.
    const assetOptions = useMemo(
        () => assetSettings
            .filter(a => !a.ticker.startsWith('_'))
            .map(a => ({ ticker: a.ticker, label: a.label || a.ticker }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        [assetSettings],
    );

    const groups = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const byGroup = new Map<string, { name: string; categories: YnabCategory[] }>();
        for (const category of ynabCategories) {
            const target = mappingByCategory.get(category.id);
            if (mappedOnly && (!target || target.kind === 'unmapped')) continue;
            if (needle && !`${category.name} ${category.groupName}`.toLowerCase().includes(needle)) continue;
            const entry = byGroup.get(category.groupId) ?? { name: category.groupName, categories: [] };
            entry.categories.push(category);
            byGroup.set(category.groupId, entry);
        }
        return [...byGroup.values()];
    }, [ynabCategories, mappingByCategory, mappedOnly, search]);

    const mappedCount = ynabMappings.filter(m => m.target.kind !== 'unmapped').length;

    const selectValue = (target: YnabMappingTarget | undefined): string => {
        if (!target || target.kind === 'unmapped') return '';
        if (target.kind === 'cash') return `${CASH_PREFIX}${target.brokerId}`;
        return `${ASSET_PREFIX}${target.ticker}`;
    };

    // Changing the destination keeps the broker/portfolio already chosen, so
    // re-pointing a category at a sibling ETF does not undo the rest of the row.
    const handleTargetChange = (categoryId: string, value: string, previous: YnabMappingTarget | undefined) => {
        if (!value) {
            setYnabMapping(categoryId, { kind: 'unmapped' });
            return;
        }
        if (value.startsWith(CASH_PREFIX)) {
            setYnabMapping(categoryId, { kind: 'cash', brokerId: value.slice(CASH_PREFIX.length) });
            return;
        }
        const kept = previous?.kind === 'asset' ? previous : undefined;
        setYnabMapping(categoryId, {
            kind: 'asset',
            ticker: value.slice(ASSET_PREFIX.length),
            brokerId: kept?.brokerId,
            portfolioId: kept?.portfolioId,
        });
    };

    const handleAssetDetailChange = (
        categoryId: string,
        target: YnabMappingTarget,
        patch: { brokerId?: string; portfolioId?: string },
    ) => {
        if (target.kind !== 'asset') return;
        setYnabMapping(categoryId, {
            ...target,
            ...('brokerId' in patch ? { brokerId: patch.brokerId || undefined } : {}),
            ...('portfolioId' in patch ? { portfolioId: patch.portfolioId || undefined } : {}),
        });
    };

    if (ynabCategories.length === 0) {
        return (
            <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', padding: '1.25rem', marginBottom: '1.5rem' }}>
                <h3 style={{ margin: 0 }}>Category mappings</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: 0 }}>
                    Run <strong>Sync now</strong> to pull this month's categories, then point each one at the asset
                    its money should become.
                </p>
            </div>
        );
    }

    return (
        <div className="ynab-map-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div>
                    <h3 style={{ margin: 0 }}>Category mappings</h3>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                        Where each category's money should end up. {mappedCount} of {ynabCategories.length} mapped.
                        Naming a broker and a portfolio lets the plan below price the commission and book the trade.
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <input
                        type="search"
                        className="form-input"
                        placeholder="Filter categories…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        style={{ minWidth: 200 }}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                        <input type="checkbox" checked={mappedOnly} onChange={e => setMappedOnly(e.target.checked)} />
                        Mapped only
                    </label>
                </div>
            </div>

            <div className="ynab-map-wrap">
                <table className="ynab-map-table">
                    <thead>
                        <tr>
                            <th>Category</th>
                            <th style={{ textAlign: 'right' }}>Available</th>
                            <th style={{ textAlign: 'right' }}>Budgeted</th>
                            <th>Destination</th>
                            <th>Broker</th>
                            <th>Portfolio</th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map(group => (
                            <React.Fragment key={group.name}>
                                <tr className="group-row">
                                    <td colSpan={6}>{group.name}</td>
                                </tr>
                                {group.categories.map(category => {
                                    const target = mappingByCategory.get(category.id);
                                    const isAsset = target?.kind === 'asset';
                                    const available = milliunitsToEur(category.balanceMilliunits);
                                    return (
                                        <tr key={category.id} className={target && target.kind !== 'unmapped' ? 'mapped-row' : undefined}>
                                            <td>{category.name}</td>
                                            <td style={{ textAlign: 'right', color: available < 0 ? 'var(--color-danger)' : undefined }}>
                                                {eur(available)}
                                            </td>
                                            <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                                                {eur(milliunitsToEur(category.budgetedMilliunits ?? 0))}
                                            </td>
                                            <td>
                                                <select
                                                    className="form-select"
                                                    value={selectValue(target)}
                                                    onChange={e => handleTargetChange(category.id, e.target.value, target)}
                                                >
                                                    <option value="">— Not invested —</option>
                                                    <optgroup label="Buy asset">
                                                        {assetOptions.map(a => (
                                                            <option key={a.ticker} value={`${ASSET_PREFIX}${a.ticker}`}>{a.label}</option>
                                                        ))}
                                                    </optgroup>
                                                    <optgroup label="Keep as cash at">
                                                        {/* Prefixed, so a closed select never reads as an asset named after a broker. */}
                                                        {brokers.map(b => (
                                                            <option key={b.id} value={`${CASH_PREFIX}${b.id}`}>Cash · {b.name}</option>
                                                        ))}
                                                    </optgroup>
                                                </select>
                                            </td>
                                            <td>
                                                {isAsset ? (
                                                    <select
                                                        className="form-select"
                                                        value={target.brokerId || ''}
                                                        onChange={e => handleAssetDetailChange(category.id, target, { brokerId: e.target.value })}
                                                    >
                                                        <option value="">Auto</option>
                                                        {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                                                    </select>
                                                ) : (
                                                    <span className="muted-cell">—</span>
                                                )}
                                            </td>
                                            <td>
                                                {isAsset ? (
                                                    <select
                                                        className="form-select"
                                                        value={target.portfolioId || ''}
                                                        onChange={e => handleAssetDetailChange(category.id, target, { portfolioId: e.target.value })}
                                                    >
                                                        <option value="">—</option>
                                                        {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                                    </select>
                                                ) : (
                                                    <span className="muted-cell">—</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </React.Fragment>
                        ))}
                        {groups.length === 0 && (
                            <tr>
                                <td colSpan={6} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
                                    No category matches the filter.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <style>{`
                .ynab-map-card {
                    background: var(--bg-card);
                    border-radius: var(--radius-lg);
                    padding: 1.25rem;
                    margin-bottom: 1.5rem;
                }
                .ynab-map-wrap {
                    overflow-x: auto;
                    margin-top: 1rem;
                    border: 1px solid var(--border-color);
                    border-radius: var(--radius-md);
                    max-height: 460px;
                    overflow-y: auto;
                }
                .ynab-map-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 0.88rem;
                }
                .ynab-map-table th,
                .ynab-map-table td {
                    padding: 0.4rem 0.7rem;
                    text-align: left;
                    border-bottom: 1px solid var(--border-color);
                    white-space: nowrap;
                }
                .ynab-map-table thead th {
                    position: sticky;
                    top: 0;
                    background: var(--bg-surface);
                    font-size: 0.72rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--text-muted);
                    z-index: 1;
                }
                .ynab-map-table .group-row td {
                    background: var(--bg-app);
                    font-weight: 600;
                    font-size: 0.78rem;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                    color: var(--text-secondary);
                }
                .ynab-map-table .mapped-row td:first-child {
                    border-left: 3px solid var(--color-primary);
                }
                .ynab-map-table .form-select {
                    min-width: 140px;
                    padding: 0.25rem 0.4rem;
                    font-size: 0.82rem;
                }
                .ynab-map-table .muted-cell { color: var(--text-muted); }
            `}</style>
        </div>
    );
};

export default YnabCategoryMappings;
