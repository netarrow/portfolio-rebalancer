import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabCategory, YnabMappingTarget } from '../../types';
import { milliunitsToEur } from '../../services/ynabApi';

/**
 * Where each YNAB category's money is meant to end up.
 *
 * One row per category, grouped as YNAB groups them. Each mapped category says
 * which account its money leaves from — a current account is a broker like any
 * other — and where it ends up: shares of one asset, a whole portfolio (its own
 * targets then decide what to buy), or simply cash at a broker. An asset row can also
 * name the broker the order goes through and the portfolio it belongs to — both
 * optional, but naming them is what lets the funding plan below price the
 * commission and register the trade.
 */

const eur = (value: number) =>
    value.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

const CASH_PREFIX = 'cash:';
const ASSET_PREFIX = 'asset:';
const PORTFOLIO_PREFIX = 'portfolio:';

const YnabCategoryMappings: React.FC = () => {
    const {
        ynabCategories, ynabMappings, setYnabMapping, setYnabMappingSource,
        ynabFundingSettings, assetSettings, brokers, portfolios,
    } = usePortfolio();

    const [search, setSearch] = useState('');
    const [mappedOnly, setMappedOnly] = useState(false);

    const mappingByCategory = useMemo(
        () => new Map(ynabMappings.map(m => [m.categoryId, m])),
        [ynabMappings],
    );

    const defaultSourceName = brokers.find(b => b.id === ynabFundingSettings.defaultSourceBrokerId)?.name;

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
            const target = mappingByCategory.get(category.id)?.target;
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
        if (target.kind === 'portfolio') return `${PORTFOLIO_PREFIX}${target.portfolioId}`;
        return `${ASSET_PREFIX}${target.ticker}`;
    };

    // Changing the destination keeps the broker already chosen, so re-pointing a
    // category at a sibling ETF — or at the whole portfolio — does not undo the
    // rest of the row.
    const handleTargetChange = (categoryId: string, value: string, previous: YnabMappingTarget | undefined) => {
        if (!value) {
            setYnabMapping(categoryId, { kind: 'unmapped' });
            return;
        }
        if (value.startsWith(CASH_PREFIX)) {
            setYnabMapping(categoryId, { kind: 'cash', brokerId: value.slice(CASH_PREFIX.length) });
            return;
        }
        const keptBroker = previous && previous.kind !== 'unmapped' ? previous.brokerId : undefined;
        if (value.startsWith(PORTFOLIO_PREFIX)) {
            setYnabMapping(categoryId, {
                kind: 'portfolio',
                portfolioId: value.slice(PORTFOLIO_PREFIX.length),
                brokerId: keptBroker,
            });
            return;
        }
        const kept = previous?.kind === 'asset' ? previous : undefined;
        setYnabMapping(categoryId, {
            kind: 'asset',
            ticker: value.slice(ASSET_PREFIX.length),
            brokerId: keptBroker,
            portfolioId: kept?.portfolioId,
        });
    };

    const handleDetailChange = (
        categoryId: string,
        target: YnabMappingTarget,
        patch: { brokerId?: string; portfolioId?: string },
    ) => {
        if (target.kind === 'asset') {
            setYnabMapping(categoryId, {
                ...target,
                ...('brokerId' in patch ? { brokerId: patch.brokerId || undefined } : {}),
                ...('portfolioId' in patch ? { portfolioId: patch.portfolioId || undefined } : {}),
            });
            return;
        }
        // A portfolio destination has no asset to pick, only the broker its
        // orders go through.
        if (target.kind === 'portfolio' && 'brokerId' in patch) {
            setYnabMapping(categoryId, { ...target, brokerId: patch.brokerId || undefined });
        }
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
                        Where each category's money starts and where it should end up. {mappedCount} of{' '}
                        {ynabCategories.length} mapped. The <em>From</em> account pays the wire out of its own
                        liquidity; naming a broker and a portfolio lets the plan price the commission and book the trade.
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
                            <th>From</th>
                            <th>Destination</th>
                            <th>Broker</th>
                            <th>Portfolio</th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map(group => (
                            <React.Fragment key={group.name}>
                                <tr className="group-row">
                                    <td colSpan={7}>{group.name}</td>
                                </tr>
                                {group.categories.map(category => {
                                    const mapping = mappingByCategory.get(category.id);
                                    const target = mapping?.target;
                                    const isAsset = target?.kind === 'asset';
                                    const isPortfolio = target?.kind === 'portfolio';
                                    const isMapped = !!target && target.kind !== 'unmapped';
                                    // A portfolio destination buys through a broker too, so the
                                    // broker cell stays live; the portfolio cell instead explains
                                    // which rule will split the money.
                                    const fundedPortfolio = isPortfolio
                                        ? portfolios.find(p => p.id === target.portfolioId)
                                        : undefined;
                                    const available = milliunitsToEur(category.balanceMilliunits);
                                    return (
                                        <tr key={category.id} className={isMapped ? 'mapped-row' : undefined}>
                                            <td className="map-cell-name">{category.name}</td>
                                            <td className="map-cell-avail" data-label="Available" style={{ textAlign: 'right', color: available < 0 ? 'var(--color-danger)' : undefined }}>
                                                {eur(available)}
                                            </td>
                                            <td className="map-cell-budgeted" data-label="Budgeted" style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                                                {eur(milliunitsToEur(category.budgetedMilliunits ?? 0))}
                                            </td>
                                            {/* Where the money starts: a real account, whose own
                                                liquidity pays the wire and its outgoing fee. */}
                                            <td className={`map-cell-source${isMapped ? '' : ' is-empty'}`} data-label="From">
                                                {isMapped ? (
                                                    <select
                                                        className="form-select"
                                                        value={mapping?.sourceBrokerId || ''}
                                                        // The dense desktop table clips the option text; the
                                                        // tooltip keeps the whole name reachable.
                                                        title={mapping?.sourceBrokerId
                                                            ? brokers.find(b => b.id === mapping.sourceBrokerId)?.name
                                                            : defaultSourceName
                                                                ? `Default account: ${defaultSourceName}`
                                                                : 'No account set — the wire is not priced'}
                                                        onChange={e => setYnabMappingSource(category.id, e.target.value || null)}
                                                    >
                                                        <option value="">
                                                            {defaultSourceName ? `Default · ${defaultSourceName}` : 'Not set'}
                                                        </option>
                                                        {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                                                    </select>
                                                ) : (
                                                    <span className="muted-cell">—</span>
                                                )}
                                            </td>
                                            <td className="map-cell-dest" data-label="Destination">
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
                                                    <optgroup label="Fund portfolio">
                                                        {/* No asset named: the portfolio's own targets
                                                            decide what the money buys. */}
                                                        {portfolios.map(p => (
                                                            <option key={p.id} value={`${PORTFOLIO_PREFIX}${p.id}`}>{p.name}</option>
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
                                            {/* `is-empty` marks the cells a non-asset row has nothing to
                                                say in: on mobile, where every cell becomes its own line,
                                                they are hidden instead of printing a labelled dash. */}
                                            <td className={`map-cell-broker${isAsset || isPortfolio ? '' : ' is-empty'}`} data-label="Broker">
                                                {(isAsset || isPortfolio) ? (
                                                    <select
                                                        className="form-select"
                                                        value={target.brokerId || ''}
                                                        onChange={e => handleDetailChange(category.id, target, { brokerId: e.target.value })}
                                                    >
                                                        <option value="">Auto</option>
                                                        {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                                                    </select>
                                                ) : (
                                                    <span className="muted-cell">—</span>
                                                )}
                                            </td>
                                            <td className={`map-cell-portfolio${isAsset || isPortfolio ? '' : ' is-empty'}`} data-label="Portfolio">
                                                {isPortfolio ? (
                                                    <span
                                                        className="split-note"
                                                        title={fundedPortfolio?.targetMode === 'amount'
                                                            ? 'The money fills this portfolio\'s € targets, nearest due date first.'
                                                            : 'The money is spread over this portfolio\'s underweight rows, proportionally to their gap.'}
                                                    >
                                                        {fundedPortfolio?.targetMode === 'amount' ? 'by € targets' : 'by target %'}
                                                    </span>
                                                ) : isAsset ? (
                                                    <select
                                                        className="form-select"
                                                        value={target.portfolioId || ''}
                                                        onChange={e => handleDetailChange(category.id, target, { portfolioId: e.target.value })}
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
                                <td colSpan={7} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
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
                .ynab-map-table .split-note {
                    font-size: 0.75rem;
                    color: var(--text-muted);
                    font-style: italic;
                    cursor: help;
                }
            `}</style>
        </div>
    );
};

export default YnabCategoryMappings;
