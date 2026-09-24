import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabCategory, YnabMappingTarget } from '../../types';
import { milliunitsToEur } from '../../services/ynabApi';
import { buildPortfolioTree } from '../../utils/portfolioGroups';
import { resolveGroups } from '../../utils/allocationGroups';
import { isGroupKey } from '../../utils/portfolioCalculations';
import type { YnabMacroCategory } from '../../types';
import { useYnabCoverage } from './useYnabCoverage';
import CategoryDetailModal from './CategoryDetailModal';

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
 * the one entity the rest of the app treats it as: it can be funded as a whole
 * (the money is spread over its members) or through any one member alone,
 * parent included. The broker the order goes through stays
 * optional: naming it is what lets the funding plan price the commission.
 *
 * A second view, "Location & nature", says where each category's money is
 * today rather than where it goes: the account its Available sits on (the same
 * account the wires leave from), what it has invested, what kind of spending it
 * is (the Summary's classes) and the goal it saves toward. The coverage panel
 * below reads all of it.
 */

const eur = (value: number) =>
    value.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

// The Summary's macro classes, in the words this view uses for them.
const NATURE_OPTIONS: { value: YnabMacroCategory; label: string }[] = [
    { value: 'structural', label: 'Fixed (structural)' },
    { value: 'variable', label: 'Variable' },
    { value: 'compressible', label: 'Compressible' },
    { value: 'sinking', label: 'Goal (dated expense)' },
    { value: 'investments', label: 'Investments' },
];
const natureLabel = (nature: YnabMacroCategory) => NATURE_OPTIONS.find(o => o.value === nature)?.label ?? nature;

const shortDate = (iso: string) =>
    new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IE', { month: 'short', year: 'numeric', timeZone: 'UTC' });

type MappingView = 'funding' | 'location';
const VIEW_KEY = 'ynab_mapping_view';

const CASH_PREFIX = 'cash:';
const ASSET_PREFIX = 'asset:';
const PORTFOLIO_PREFIX = 'portfolio:';
const GROUP_PREFIX = 'group:';

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
    /** Parent first, then the children — each also fundable on its own. */
    members: { id: string; name: string }[];
    /** Assets the entity targets, each with the member portfolio that books it. */
    assets: { ticker: string; label: string; portfolioId: string }[];
}

const YnabCategoryMappings: React.FC = () => {
    const {
        ynabCategories, ynabMappings, setYnabMapping, setYnabMappingSource,
        ynabFundingSettings, assetSettings, brokers, portfolios,
        ynabMacroMappings, setYnabCategoryMacro,
    } = usePortfolio();

    const [search, setSearch] = useState('');
    const [mappedOnly, setMappedOnly] = useState(false);
    const [view, setViewState] = useState<MappingView>(() => {
        try { return localStorage.getItem(VIEW_KEY) === 'location' ? 'location' : 'funding'; } catch { return 'funding'; }
    });
    const setView = (next: MappingView) => {
        setViewState(next);
        try { localStorage.setItem(VIEW_KEY, next); } catch { /* per-viewer convenience only */ }
    };
    const [detailId, setDetailId] = useState<string | null>(null);

    const { report } = useYnabCoverage();
    const positionById = useMemo(() => new Map(report.positions.map(p => [p.categoryId, p])), [report.positions]);
    const detailPosition = detailId ? positionById.get(detailId) : undefined;

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
                    members: g.members.map(m => ({ id: m.id, name: m.name })),
                    assets: assetsOf(g.members),
                },
            })),
            ...tree.standalones.map(p => ({
                parent: p,
                entity: { rootId: p.id, name: p.name, memberCount: 1, isGroup: false, members: [{ id: p.id, name: p.name }], assets: assetsOf([p]) },
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
            ...(e.isGroup ? [`${GROUP_PREFIX}${e.rootId}`] : []),
            ...e.members.map(m => `${PORTFOLIO_PREFIX}${m.id}`),
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
            if (view === 'funding' && mappedOnly && (!target || target.kind === 'unmapped')) continue;
            if (needle && !`${category.name} ${category.groupName}`.toLowerCase().includes(needle)) continue;
            const entry = byGroup.get(category.groupId) ?? { name: category.groupName, categories: [] };
            entry.categories.push(category);
            byGroup.set(category.groupId, entry);
        }
        return [...byGroup.values()];
    }, [ynabCategories, mappingByCategory, mappedOnly, search, view]);

    // Totals of what is on screen, per group and overall.
    const sumOf = (categories: YnabCategory[]) => categories.reduce((acc, c) => {
        const position = positionById.get(c.id);
        acc.available += milliunitsToEur(c.balanceMilliunits);
        acc.budgeted += milliunitsToEur(c.budgetedMilliunits ?? 0);
        acc.avgSpent += position?.avgSpent ?? 0;
        acc.invested += position?.invested ?? 0;
        return acc;
    }, { available: 0, budgeted: 0, avgSpent: 0, invested: 0 });
    const shownTotals = sumOf(groups.flatMap(g => g.categories));
    const columnCount = view === 'funding' ? 6 : 7;
    const hasAverages = report.positions.some(p => p.spentMonths > 0);

    const mappedCount = ynabMappings.filter(m => m.target.kind !== 'unmapped').length;

    const selectValue = (target: YnabMappingTarget | undefined): string => {
        if (!target || target.kind === 'unmapped') return '';
        if (target.kind === 'cash') return `${CASH_PREFIX}${target.brokerId}`;
        if (target.kind === 'portfolio') {
            return `${target.wholeGroup ? GROUP_PREFIX : PORTFOLIO_PREFIX}${target.portfolioId}`;
        }
        return assetValue(target.ticker, target.portfolioId);
    };

    /**
     * A saved mapping the list no longer offers — an asset booked on a portfolio
     * that stopped targeting it, a child portfolio funded on its own before the
     * group existed — still has to show, or the select would silently read as
     * something else.
     */
    const legacyLabel = (target: YnabMappingTarget): string => {
        if (target.kind === 'portfolio') {
            return `${portfolioName(target.portfolioId) ?? 'Missing portfolio'} · ${target.wholeGroup ? 'whole group' : 'whole'}`;
        }
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
        if (value.startsWith(GROUP_PREFIX)) {
            setYnabMapping(categoryId, {
                kind: 'portfolio',
                portfolioId: value.slice(GROUP_PREFIX.length),
                wholeGroup: true,
                brokerId: keptBroker,
            });
            return;
        }
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

    // The "Location & nature" cells of one row, after Category and Available.
    const renderLocationCells = (categoryId: string, sourceBrokerId: string | undefined) => {
        const position = positionById.get(categoryId);
        if (!position) return null;
        const groupNature = ynabMacroMappings.groups[position.groupId];
        const goal = position.goal;
        const goalText = goal && (goal.amount || goal.date)
            ? [goal.amount ? eur(goal.amount) : null, goal.date ? shortDate(goal.date) : null].filter(Boolean).join(' · ')
            : null;
        return (
            <>
                <td className="map-cell-avg" data-label="Avg / month" style={{ textAlign: 'right' }}
                    title={position.spentMonths > 0 ? `Average over ${position.spentMonths} month${position.spentMonths === 1 ? '' : 's'}` : 'No spending history yet'}>
                    {position.spentMonths > 0 ? eur(position.avgSpent) : <span className="muted-cell">—</span>}
                </td>
                <td className="map-cell-nature" data-label="Nature">
                    <select
                        className="form-select"
                        value={ynabMacroMappings.categories[categoryId] ?? ''}
                        onChange={e => setYnabCategoryMacro(categoryId, (e.target.value || null) as YnabMacroCategory | null)}
                    >
                        <option value="">{groupNature ? `Group · ${natureLabel(groupNature)}` : '— Not set —'}</option>
                        {NATURE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                </td>
                <td className="map-cell-cash" data-label="Cash at">
                    <select
                        className="form-select"
                        value={sourceBrokerId || ''}
                        onChange={e => setYnabMappingSource(categoryId, e.target.value || null)}
                    >
                        <option value="">{defaultSourceName ? `Default · ${defaultSourceName}` : 'Not set'}</option>
                        {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                </td>
                <td className="map-cell-invested" data-label="Invested" style={{ textAlign: 'right' }}>
                    <button type="button" className="cell-link" onClick={() => setDetailId(categoryId)}
                        title="Portfolios and assets holding part of this category's money">
                        {position.invested > 0 || position.allocations.length > 0
                            ? `${eur(position.invested)} · ${position.allocations.length}`
                            : '+ Add'}
                    </button>
                </td>
                <td className="map-cell-goal" data-label="Goal">
                    <button type="button" className={`cell-link${goalText ? '' : ' cell-link-muted'}`} onClick={() => setDetailId(categoryId)}>
                        {goalText ?? (position.nature === 'sinking' ? 'Set target' : 'Set')}
                    </button>
                    {position.emergencyFund && <span className="fund-badge" title="Counts toward the emergency fund">Emergency fund</span>}
                </td>
            </>
        );
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
                    <div className="map-view-tabs" role="tablist">
                        <button type="button" role="tab" aria-selected={view === 'funding'} className={view === 'funding' ? 'active' : ''} onClick={() => setView('funding')}>
                            Funding
                        </button>
                        <button type="button" role="tab" aria-selected={view === 'location'} className={view === 'location' ? 'active' : ''} onClick={() => setView('location')}>
                            Location &amp; nature
                        </button>
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                        {view === 'funding' ? (
                            <>
                                Where each category's money starts and where it should end up. {mappedCount} of{' '}
                                {ynabCategories.length} mapped. The <em>From</em> account pays the wire out of its own
                                liquidity; the destination names the portfolio that books the trade, and a broker lets the
                                plan price the commission.
                            </>
                        ) : (
                            <>
                                Where each category's money is today and what kind of spending it is. The Available sits
                                as cash on the <em>Cash at</em> account (the same one the wires leave from); anything it
                                has invested is listed under <em>Invested</em>. The nature is shared with the Summary.
                                {!hasAverages && <> Run <strong>Sync now</strong> to load the 12-month average spending.</>}
                            </>
                        )}
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
                    {view === 'funding' && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <input type="checkbox" checked={mappedOnly} onChange={e => setMappedOnly(e.target.checked)} />
                            Mapped only
                        </label>
                    )}
                </div>
            </div>

            <div className="ynab-map-wrap">
                <table className="ynab-map-table">
                    <thead>
                        {view === 'funding' ? (
                            <tr>
                                <th>Category</th>
                                <th style={{ textAlign: 'right' }}>Available</th>
                                <th style={{ textAlign: 'right' }}>Budgeted</th>
                                <th>From</th>
                                <th>Destination</th>
                                <th>Broker</th>
                            </tr>
                        ) : (
                            <tr>
                                <th>Category</th>
                                <th style={{ textAlign: 'right' }}>Available</th>
                                <th style={{ textAlign: 'right' }} title="Average monthly spending over the last 12 months">Avg / month</th>
                                <th>Nature</th>
                                <th>Cash at</th>
                                <th style={{ textAlign: 'right' }}>Invested</th>
                                <th>Goal</th>
                            </tr>
                        )}
                    </thead>
                    <tbody>
                        {groups.map(group => (
                            <React.Fragment key={group.name}>
                                <tr className="group-row">
                                    <td colSpan={columnCount}>
                                        <div className="group-row-inner">
                                            <span>{group.name}</span>
                                            <span className="group-totals">
                                                {(() => {
                                                    const t = sumOf(group.categories);
                                                    return view === 'funding'
                                                        ? `${eur(t.available)} available · ${eur(t.budgeted)} budgeted`
                                                        : `${eur(t.available)} available · ${eur(t.avgSpent)}/mo`;
                                                })()}
                                            </span>
                                        </div>
                                    </td>
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
                                    const fundsGroup = isPortfolio && !!target.wholeGroup
                                        && !!entities.find(e => e.rootId === target.portfolioId)?.isGroup;
                                    const value = selectValue(target);
                                    const isLegacy = !!value && !offeredValues.has(value);
                                    const available = milliunitsToEur(category.balanceMilliunits);
                                    return (
                                        <tr key={category.id} className={isMapped ? 'mapped-row' : undefined}>
                                            <td className="map-cell-name">{category.name}</td>
                                            <td className="map-cell-avail" data-label="Available" style={{ textAlign: 'right', color: available < 0 ? 'var(--color-danger)' : undefined }}>
                                                {eur(available)}
                                            </td>
                                            {view === 'location' ? renderLocationCells(category.id, mapping?.sourceBrokerId) : (<>
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
                                                                    decide what the money buys. A group offers
                                                                    itself as a whole, then each member alone. */}
                                                                {entity.isGroup && (
                                                                    <option value={`${GROUP_PREFIX}${entity.rootId}`}>
                                                                        Whole group · {entity.name}
                                                                    </option>
                                                                )}
                                                                {entity.members.map(m => (
                                                                    <option key={m.id} value={`${PORTFOLIO_PREFIX}${m.id}`}>
                                                                        {entity.isGroup ? `Only · ${m.name}` : `Whole portfolio · ${m.name}`}
                                                                    </option>
                                                                ))}
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
                                                            title={fundsGroup
                                                                ? 'Shared over the group\'s members by their configured ratio, then over each member\'s own targets.'
                                                                : fundedPortfolio?.targetMode === 'amount'
                                                                    ? 'The money fills this portfolio\'s € targets, nearest due date first.'
                                                                    : 'The money is spread over this portfolio\'s underweight rows, proportionally to their gap.'}
                                                        >
                                                            {fundsGroup
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
                                            </>)}
                                        </tr>
                                    );
                                })}
                            </React.Fragment>
                        ))}
                        {groups.length === 0 && (
                            <tr>
                                <td colSpan={columnCount} style={{ color: 'var(--text-muted)', textAlign: 'center' }}>
                                    No category matches the filter.
                                </td>
                            </tr>
                        )}
                    </tbody>
                    {groups.length > 0 && (
                        <tfoot>
                            <tr className="total-row">
                                <td className="map-cell-name">{search || (view === 'funding' && mappedOnly) ? 'Total shown' : 'Total'}</td>
                                <td data-label="Available" style={{ textAlign: 'right' }}>{eur(shownTotals.available)}</td>
                                {view === 'funding' ? (
                                    <>
                                        <td data-label="Budgeted" style={{ textAlign: 'right' }}>{eur(shownTotals.budgeted)}</td>
                                        <td colSpan={3} className="is-empty" />
                                    </>
                                ) : (
                                    <>
                                        <td data-label="Avg / month" style={{ textAlign: 'right' }}>{eur(shownTotals.avgSpent)}</td>
                                        <td colSpan={2} className="is-empty" />
                                        <td data-label="Invested" style={{ textAlign: 'right' }}>{eur(shownTotals.invested)}</td>
                                        <td className="is-empty" />
                                    </>
                                )}
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>

            {detailPosition && (
                <CategoryDetailModal
                    key={detailPosition.categoryId}
                    position={detailPosition}
                    onClose={() => setDetailId(null)}
                />
            )}

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
                .map-view-tabs {
                    display: inline-flex;
                    gap: 0.25rem;
                    margin-top: 0.6rem;
                    padding: 0.2rem;
                    background: var(--bg-app);
                    border-radius: var(--radius-md);
                }
                .map-view-tabs button {
                    border: none;
                    background: none;
                    color: var(--text-secondary);
                    padding: 0.35rem 0.8rem;
                    border-radius: var(--radius-sm, 6px);
                    font-size: 0.85rem;
                    cursor: pointer;
                }
                .map-view-tabs button.active {
                    background: var(--bg-card);
                    color: var(--text-primary);
                    font-weight: 600;
                }
                .ynab-map-table .group-row-inner {
                    display: flex;
                    justify-content: space-between;
                    gap: 1rem;
                    flex-wrap: wrap;
                }
                .ynab-map-table .group-totals {
                    font-weight: 500;
                    text-transform: none;
                    letter-spacing: 0;
                    color: var(--text-muted);
                    font-variant-numeric: tabular-nums;
                }
                .ynab-map-table tfoot td {
                    position: sticky;
                    bottom: 0;
                    background: var(--bg-surface);
                    font-weight: 600;
                    border-top: 2px solid var(--border-color);
                }
                .ynab-map-table .cell-link {
                    background: none;
                    border: none;
                    padding: 0;
                    color: var(--color-primary);
                    cursor: pointer;
                    font-size: 0.85rem;
                    font-variant-numeric: tabular-nums;
                }
                .ynab-map-table .cell-link-muted { color: var(--text-muted); }
                .ynab-map-table .fund-badge {
                    margin-left: 0.5rem;
                    font-size: 0.68rem;
                    padding: 0.1rem 0.4rem;
                    border-radius: 999px;
                    background: color-mix(in srgb, var(--color-primary) 18%, transparent);
                    color: var(--color-primary);
                }
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
