import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabCategory, YnabMappingTarget } from '../../types';
import { milliunitsToEur } from '../../services/ynabApi';
import { buildPortfolioTree } from '../../utils/portfolioGroups';
import { resolveGroups } from '../../utils/allocationGroups';
import { isGroupKey } from '../../utils/portfolioCalculations';

/**
 * Where each YNAB category's money is meant to end up.
 *
 * One row per category, grouped as YNAB groups them. Each mapped category says
 * which account its money leaves from — a current account is a broker like any
 * other — and where it ends up: shares of one asset, a whole portfolio (its own
 * targets then decide what to buy), or simply cash at a broker.
 *
 * The destination is a single list, grouped by portfolio: each portfolio offers
 * itself as a whole and then the assets it targets, so picking an asset also
 * says which portfolio books the trade. A parent/child group is listed once, as
 * the one entity the rest of the app treats it as — funding it as a whole
 * spreads the money over its members. The broker the order goes through stays
 * optional: naming it is what lets the funding plan price the commission.
 */

const eur = (value: number) =>
    value.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

const CASH_PREFIX = 'cash:';
const ASSET_PREFIX = 'asset:';
const PORTFOLIO_PREFIX = 'portfolio:';

/** `asset:<portfolioId>|<ticker>`; an empty portfolio id means "no portfolio". */
const assetValue = (ticker: string, portfolioId?: string) => `${ASSET_PREFIX}${portfolioId ?? ''}|${ticker}`;

interface DestinationEntity {
    /** Root portfolio: the id a "whole portfolio" mapping points at. */
    rootId: string;
    /** The root's name: a group goes by its parent, as on the Dashboard. */
    name: string;
    /** Members counted as one entity; 1 for a standalone portfolio. */
    memberCount: number;
    isGroup: boolean;
    /** Assets the entity targets, each with the member portfolio that books it. */
    assets: { ticker: string; label: string; portfolioId: string }[];
}

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

    const labelOf = useMemo(() => {
        const byTicker = new Map(assetSettings.map(a => [a.ticker.toUpperCase(), a.label || a.ticker]));
        return (ticker: string) => byTicker.get(ticker.toUpperCase()) ?? ticker;
    }, [assetSettings]);

    // One entity per standalone portfolio and one per parent/child group, each
    // listing the assets it targets (allocation groups expanded to their
    // members). Within a group an asset is booked on the first member — parent
    // first — that targets it, so it appears once.
    const entities = useMemo((): DestinationEntity[] => {
        const assetsOf = (members: typeof portfolios) => {
            const seen = new Map<string, DestinationEntity['assets'][number]>();
            for (const member of members) {
                const { groupById } = resolveGroups(member);
                for (const key of Object.keys(member.allocations || {})) {
                    const tickers = isGroupKey(key) ? groupById[key]?.members ?? [] : [key];
                    for (const ticker of tickers) {
                        // Cash, virtual-bond and other pseudo-tickers are not buyable.
                        if (ticker.startsWith('_') || seen.has(ticker.toUpperCase())) continue;
                        seen.set(ticker.toUpperCase(), { ticker, label: labelOf(ticker), portfolioId: member.id });
                    }
                }
            }
            return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
        };
        const tree = buildPortfolioTree(portfolios);
        return [
            ...tree.groups.map(g => ({
                parent: g.parent,
                entity: {
                    rootId: g.parent.id,
                    name: g.parent.name,
                    memberCount: g.members.length,
                    isGroup: true,
                    assets: assetsOf(g.members),
                },
            })),
            ...tree.standalones.map(p => ({
                parent: p,
                entity: { rootId: p.id, name: p.name, memberCount: 1, isGroup: false, assets: assetsOf([p]) },
            })),
        ]
            .sort((a, b) => a.parent.order - b.parent.order)
            .map(e => e.entity);
    }, [portfolios, labelOf]);

    // Registry assets no portfolio targets: still fundable, with no portfolio.
    const looseAssets = useMemo(() => {
        const targeted = new Set(entities.flatMap(e => e.assets.map(a => a.ticker.toUpperCase())));
        return assetSettings
            .filter(a => !a.ticker.startsWith('_') && !targeted.has(a.ticker.toUpperCase()))
            .map(a => ({ ticker: a.ticker, label: a.label || a.ticker }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }, [assetSettings, entities]);

    const offeredValues = useMemo(() => new Set([
        ...entities.flatMap(e => [
            `${PORTFOLIO_PREFIX}${e.rootId}`,
            ...e.assets.map(a => assetValue(a.ticker, a.portfolioId)),
        ]),
        ...looseAssets.map(a => assetValue(a.ticker)),
        ...brokers.map(b => `${CASH_PREFIX}${b.id}`),
    ]), [entities, looseAssets, brokers]);

    const portfolioName = (id: string | undefined) => portfolios.find(p => p.id === id)?.name;

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
        return assetValue(target.ticker, target.portfolioId);
    };

    /**
     * A saved mapping the list no longer offers — an asset booked on a portfolio
     * that stopped targeting it, a child portfolio funded on its own before the
     * group existed — still has to show, or the select would silently read as
     * something else.
     */
    const legacyLabel = (target: YnabMappingTarget): string => {
        if (target.kind === 'portfolio') return `${portfolioName(target.portfolioId) ?? 'Missing portfolio'} · whole`;
        if (target.kind === 'asset') {
            const where = portfolioName(target.portfolioId);
            return where ? `${labelOf(target.ticker)} · ${where}` : labelOf(target.ticker);
        }
        if (target.kind === 'cash') return `Cash · ${brokers.find(b => b.id === target.brokerId)?.name ?? 'missing broker'}`;
        return '';
    };

    // Changing the destination keeps the broker already chosen, so re-pointing a
    // category at a sibling ETF — or at the whole portfolio — does not undo the
    // rest of the row. The portfolio now comes with the asset itself.
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
        const rest = value.slice(ASSET_PREFIX.length);
        const bar = rest.indexOf('|');
        setYnabMapping(categoryId, {
            kind: 'asset',
            ticker: rest.slice(bar + 1),
            brokerId: keptBroker,
            portfolioId: rest.slice(0, bar) || undefined,
        });
    };

    const handleBrokerChange = (categoryId: string, target: YnabMappingTarget, brokerId: string) => {
        if (target.kind === 'asset' || target.kind === 'portfolio') {
            setYnabMapping(categoryId, { ...target, brokerId: brokerId || undefined });
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
                        liquidity; the destination names the portfolio that books the trade, and a broker lets the
                        plan price the commission.
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
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map(group => (
                            <React.Fragment key={group.name}>
                                <tr className="group-row">
                                    <td colSpan={6}>{group.name}</td>
                                </tr>
                                {group.categories.map(category => {
                                    const mapping = mappingByCategory.get(category.id);
                                    const target = mapping?.target;
                                    const isAsset = target?.kind === 'asset';
                                    const isPortfolio = target?.kind === 'portfolio';
                                    const isMapped = !!target && target.kind !== 'unmapped';
                                    // A portfolio destination buys through a broker too, so the
                                    // broker cell stays live; a note says which rule will split
                                    // the money.
                                    const fundedPortfolio = isPortfolio
                                        ? portfolios.find(p => p.id === target.portfolioId)
                                        : undefined;
                                    const fundedEntity = isPortfolio
                                        ? entities.find(e => e.rootId === target.portfolioId)
                                        : undefined;
                                    const value = selectValue(target);
                                    const isLegacy = !!value && !offeredValues.has(value);
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
                                                <div className="dest-wrap">
                                                    <select
                                                        className="form-select"
                                                        value={value}
                                                        onChange={e => handleTargetChange(category.id, e.target.value, target)}
                                                    >
                                                        <option value="">— Not invested —</option>
                                                        {isLegacy && target && <option value={value}>{legacyLabel(target)}</option>}
                                                        {entities.map(entity => (
                                                            <optgroup key={entity.rootId} label={entity.isGroup ? `${entity.name} · group of ${entity.memberCount}` : entity.name}>
                                                                {/* No asset named: the portfolio's own targets
                                                                    decide what the money buys. */}
                                                                <option value={`${PORTFOLIO_PREFIX}${entity.rootId}`}>
                                                                    {entity.isGroup ? `Whole group · ${entity.name}` : `Whole portfolio · ${entity.name}`}
                                                                </option>
                                                                {entity.assets.map(a => (
                                                                    <option key={a.ticker} value={assetValue(a.ticker, a.portfolioId)}>{a.label}</option>
                                                                ))}
                                                            </optgroup>
                                                        ))}
                                                        {looseAssets.length > 0 && (
                                                            <optgroup label="Other assets (no portfolio)">
                                                                {looseAssets.map(a => (
                                                                    <option key={a.ticker} value={assetValue(a.ticker)}>{a.label}</option>
                                                                ))}
                                                            </optgroup>
                                                        )}
                                                        <optgroup label="Keep as cash at">
                                                            {/* Prefixed, so a closed select never reads as an asset named after a broker. */}
                                                            {brokers.map(b => (
                                                                <option key={b.id} value={`${CASH_PREFIX}${b.id}`}>Cash · {b.name}</option>
                                                            ))}
                                                        </optgroup>
                                                    </select>
                                                    {isPortfolio && (
                                                        <span
                                                            className="split-note"
                                                            title={fundedEntity?.isGroup
                                                                ? 'Shared over the group\'s members by their configured ratio, then over each member\'s own targets.'
                                                                : fundedPortfolio?.targetMode === 'amount'
                                                                    ? 'The money fills this portfolio\'s € targets, nearest due date first.'
                                                                    : 'The money is spread over this portfolio\'s underweight rows, proportionally to their gap.'}
                                                        >
                                                            {fundedEntity?.isGroup
                                                                ? 'by group ratio'
                                                                : fundedPortfolio?.targetMode === 'amount' ? 'by € targets' : 'by target %'}
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            {/* `is-empty` marks the cells a non-asset row has nothing to
                                                say in: on mobile, where every cell becomes its own line,
                                                they are hidden instead of printing a labelled dash. */}
                                            <td className={`map-cell-broker${isAsset || isPortfolio ? '' : ' is-empty'}`} data-label="Broker">
                                                {(isAsset || isPortfolio) ? (
                                                    <select
                                                        className="form-select"
                                                        value={target.brokerId || ''}
                                                        onChange={e => handleBrokerChange(category.id, target, e.target.value)}
                                                    >
                                                        <option value="">Auto</option>
                                                        {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
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
                .ynab-map-table .dest-wrap {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }
                .ynab-map-table .map-cell-dest .form-select { min-width: 220px; }
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
