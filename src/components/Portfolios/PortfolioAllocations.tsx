import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import '../Transactions/Transactions.css'; // Reuse form styles
import type { AssetClass, AssetSubClass, AllocationGroup, BondUniverse } from '../../types';
import { isVirtualBondTicker, getVirtualBondId } from '../../types';
import { getCashTicker, isCashTicker, makeGroupId } from '../../utils/portfolioCalculations';
import { groupWeightConfig, isFullyFrozen } from '../../utils/allocationGroups';

interface PortfolioAllocationsProps {
    portfolioId: string;
    onClose: () => void;
}

const PortfolioAllocations: React.FC<PortfolioAllocationsProps> = ({ portfolioId, onClose }) => {
    const { portfolios, brokers, assetSettings, updatePortfolioAllocation, updatePortfolioPacConfig, updateAssetSettings, upsertAllocationGroup, deleteAllocationGroup, virtualBonds, addVirtualBond, deleteVirtualBond } = usePortfolio();

    // On mobile the three "add" entry points (asset / group / bond) are hidden
    // behind this toggle so they don't eat vertical space until needed.
    const [addToolsOpen, setAddToolsOpen] = useState(false);

    // UI State for "Add Asset" mode
    const [isAddingAsset, setIsAddingAsset] = useState(false);
    const [newAssetTicker, setNewAssetTicker] = useState('');
    const [newAssetLabel, setNewAssetLabel] = useState('');
    const [newAssetClass, setNewAssetClass] = useState<AssetClass>('Stock');
    const [newAssetSubClass, setNewAssetSubClass] = useState<AssetSubClass>('International');

    // UI State for groups
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
    const [isCreatingGroup, setIsCreatingGroup] = useState(false);
    const [newGroupLabel, setNewGroupLabel] = useState('');
    const [newGroupMembers, setNewGroupMembers] = useState<string[]>([]);

    // Virtual bond form
    const [isAddingVBond, setIsAddingVBond] = useState(false);
    const [vbondLabel, setVbondLabel] = useState('');
    const [vbondMaturity, setVbondMaturity] = useState('');
    const [vbondUniverse, setVbondUniverse] = useState<BondUniverse>('IT');

    const portfolio = portfolios.find(p => p.id === portfolioId);
    const allocations = portfolio?.allocations || {};
    const pacConfigs = portfolio?.pacConfigs || {};
    const groups = useMemo(() => portfolio?.allocationGroups || [], [portfolio]);
    const groupedTickers = useMemo(() => {
        const set = new Set<string>();
        groups.forEach(g => g.members.forEach(m => set.add(m.toUpperCase())));
        return set;
    }, [groups]);

    // Compute virtual cash tickers from brokers that have liquidity allocated to this portfolio
    const cashTickers = useMemo(() => {
        return brokers
            .filter(b => (b.liquidityAllocations?.[portfolioId] || 0) > 0)
            .map(b => ({
                ticker: getCashTicker(b.id),
                label: `Cash (${b.name})`,
                assetClass: 'Cash' as AssetClass,
            }));
    }, [brokers, portfolioId]);

    // Get all assets defined in settings + virtual cash/bond tickers, excluding
    // tickers that belong to a group (those are edited inside the group, not standalone).
    const vbondTickers = useMemo(() => {
        return virtualBonds
            .filter(vb => !vb.resolvedIsin)
            .map(vb => `_VBOND_${vb.id}`);
    }, [virtualBonds]);

    const tickers = useMemo(() => {
        const settingTickers = assetSettings.map(s => s.ticker);
        const cashTickerIds = cashTickers.map(c => c.ticker);
        const allTickers = [...settingTickers, ...cashTickerIds, ...vbondTickers]
            .filter(t => !groupedTickers.has(t.toUpperCase()));

        return allTickers.sort((a, b) => {
                const valA = allocations[a] || 0;
                const valB = allocations[b] || 0;
                if (valB !== valA) return valB - valA;
                return a.localeCompare(b);
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [assetSettings, cashTickers, groupedTickers, vbondTickers]);

    // Tickers available to add to a group: defined assets, non-cash, not already grouped.
    const availableForGroup = useMemo(() => {
        return assetSettings
            .map(s => s.ticker)
            .filter(t => !isCashTicker(t) && !groupedTickers.has(t.toUpperCase()));
    }, [assetSettings, groupedTickers]);

    if (!portfolio) return null;

    const total = Object.values(allocations).reduce((sum, val) => sum + val, 0);

    const handleUpdate = (ticker: string, value: string) => {
        const num = parseFloat(value);
        updatePortfolioAllocation(portfolioId, ticker, isNaN(num) ? 0 : num);
    };

    // PAC flag + priority cell for an allocation entry (ticker or group id).
    // New liquidity (Buy Only) funds PAC entries first, by ascending priority.
    const renderPacCell = (key: string) => {
        const cfg = pacConfigs[key];
        const enabled = !!cfg?.enabled;
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => updatePortfolioPacConfig(portfolioId, key, { enabled: !enabled, priority: cfg?.priority || 1 })}
                    title="PAC: new liquidity funds this entry first"
                />
                {enabled ? (
                    <input
                        type="number"
                        className="form-input"
                        value={cfg?.priority ?? 1}
                        onChange={(e) => {
                            const p = parseInt(e.target.value, 10);
                            updatePortfolioPacConfig(portfolioId, key, { enabled: true, priority: isNaN(p) || p < 1 ? 1 : p });
                        }}
                        min="1"
                        step="1"
                        style={{ width: '54px', textAlign: 'right', padding: '2px 6px' }}
                        title="PAC priority (1 = highest, funded first)"
                    />
                ) : (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>PAC</span>
                )}
            </div>
        );
    };

    const handleAddAsset = () => {
        if (!newAssetTicker) return;

        // Add to settings (Registry)
        // updateAssetSettings(ticker, source, label, assetClass, assetSubClass)
        updateAssetSettings(
            newAssetTicker.toUpperCase(),
            'ETF',
            newAssetLabel || newAssetTicker.toUpperCase(),
            newAssetClass,
            newAssetSubClass
        );

        // Reset form
        setNewAssetTicker('');
        setNewAssetLabel('');
        setIsAddingAsset(false);
    };

    const labelFor = (ticker: string) => {
        if (isVirtualBondTicker(ticker)) {
            const vb = virtualBonds.find(b => `_VBOND_${b.id}` === ticker);
            return vb?.label || ticker;
        }
        return assetSettings.find(s => s.ticker === ticker)?.label || ticker;
    };

    const vbondFor = (ticker: string) => {
        if (!isVirtualBondTicker(ticker)) return null;
        return virtualBonds.find(b => b.id === getVirtualBondId(ticker)) || null;
    };

    const handleAddVBond = () => {
        if (!vbondLabel.trim() || !vbondMaturity) return;
        const id = crypto.randomUUID();
        const bond = {
            id,
            label: vbondLabel.trim(),
            targetMaturityDate: vbondMaturity,
            universe: vbondUniverse,
            minMonthsBefore: 1,
            maxMonthsBefore: 6,
            createdAt: new Date().toISOString(),
        };
        addVirtualBond(bond);
        const ticker = `_VBOND_${id}`;
        updatePortfolioAllocation(portfolioId, ticker, 0);
        setVbondLabel('');
        setVbondMaturity('');
        setVbondUniverse('IT');
        setIsAddingVBond(false);
    };

    const handleDeleteVBond = (ticker: string) => {
        const vbId = getVirtualBondId(ticker);
        deleteVirtualBond(vbId);
    };

    const handleCreateGroup = () => {
        if (!newGroupLabel.trim() || newGroupMembers.length < 2) return;
        const id = makeGroupId();
        const group: AllocationGroup = {
            id,
            label: newGroupLabel.trim(),
            members: [...newGroupMembers],
            memberRules: {},
        };
        // Initial group target = sum of members' existing standalone allocations (preserves total %).
        const initialTarget = newGroupMembers.reduce((sum, m) => sum + (allocations[m] || allocations[m.toUpperCase()] || 0), 0);
        upsertAllocationGroup(portfolioId, group);
        updatePortfolioAllocation(portfolioId, id, initialTarget);
        setExpandedGroups(prev => ({ ...prev, [id]: true }));
        setNewGroupLabel('');
        setNewGroupMembers([]);
        setIsCreatingGroup(false);
    };

    const updateGroup = (group: AllocationGroup, changes: Partial<AllocationGroup>) => {
        upsertAllocationGroup(portfolioId, { ...group, ...changes });
    };

    const moveMember = (group: AllocationGroup, index: number, dir: -1 | 1) => {
        const members = [...group.members];
        const target = index + dir;
        if (target < 0 || target >= members.length) return;
        [members[index], members[target]] = [members[target], members[index]];
        updateGroup(group, { members });
    };

    const toggleMemberRule = (group: AllocationGroup, ticker: string, rule: 'noBuy' | 'noSell') => {
        const memberRules = { ...(group.memberRules || {}) };
        const current = { ...(memberRules[ticker] || {}) };
        current[rule] = !current[rule];
        memberRules[ticker] = current;
        updateGroup(group, { memberRules });
    };

    const setMemberWeight = (group: AllocationGroup, ticker: string, raw: string) => {
        const memberRules = { ...(group.memberRules || {}) };
        const current = { ...(memberRules[ticker] || {}) };
        if (raw.trim() === '') {
            delete current.weight;
        } else {
            const parsed = parseFloat(raw);
            if (isNaN(parsed)) return;
            current.weight = Math.min(100, Math.max(0, parsed));
        }
        memberRules[ticker] = current;
        updateGroup(group, { memberRules });
    };

    const removeMember = (group: AllocationGroup, ticker: string) => {
        const members = group.members.filter(m => m !== ticker);
        const memberRules = { ...(group.memberRules || {}) };
        delete memberRules[ticker];
        if (members.length === 0) {
            deleteAllocationGroup(portfolioId, group.id);
        } else {
            updateGroup(group, { members, memberRules });
        }
    };

    const addMemberToGroup = (group: AllocationGroup, ticker: string) => {
        if (!ticker || group.members.includes(ticker)) return;
        updateGroup(group, { members: [...group.members, ticker] });
    };

    const toggleNewGroupMember = (ticker: string) => {
        setNewGroupMembers(prev =>
            prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker]
        );
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content" style={{ maxWidth: '800px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
                    <h3>Allocations: {portfolio.name}</h3>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
                </div>

                <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
                    Set target percentages for this portfolio. Total should be 100%.
                </p>

                <div className="alloc-list-scroll" style={{ maxHeight: '50vh', overflowY: 'auto', paddingRight: 'var(--space-2)' }}>
                    {tickers.length === 0 && groups.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)' }}>No assets defined. Add an asset below to start.</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                            <div className="allocation-header alloc-modal-header-row" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 90px 100px', gap: 'var(--space-4)', paddingBottom: 'var(--space-2)', borderBottom: '1px solid var(--border-color)', fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                <div>Ticker</div>
                                <div>Asset</div>
                                <div>Class</div>
                                <div title="PAC: new liquidity funds flagged entries first, by priority (1 = highest)">PAC / Prio</div>
                                <div>Target %</div>
                            </div>

                            {/* Market group rows */}
                            {groups.map(group => {
                                const expanded = !!expandedGroups[group.id];
                                const groupPerc = allocations[group.id] || 0;
                                const wcfg = groupWeightConfig(group.members, group.memberRules);
                                return (
                                    <div key={group.id} style={{ border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                                        <div className="alloc-modal-row alloc-group-row" style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 90px 100px', gap: 'var(--space-4)', alignItems: 'center', padding: 'var(--space-2) var(--space-3)', backgroundColor: 'var(--bg-app)' }}>
                                            <div className="alloc-cell alloc-cell-ticker" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                                                <button
                                                    onClick={() => setExpandedGroups(prev => ({ ...prev, [group.id]: !expanded }))}
                                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.8rem', width: '16px' }}
                                                    title={expanded ? 'Collapse' : 'Expand'}
                                                >
                                                    {expanded ? '▾' : '▸'}
                                                </button>
                                                <strong>{group.label}</strong>
                                            </div>
                                            <div className="alloc-cell alloc-cell-asset" data-label="Assets" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                                {group.members.map(m => m.toUpperCase()).join(' + ')}
                                            </div>
                                            <div className="alloc-cell alloc-cell-grouptag" style={{ fontSize: '0.8rem', color: 'var(--color-primary)', fontWeight: 600 }}>
                                                Group
                                            </div>
                                            <div className="alloc-cell alloc-cell-pac" data-label="PAC / Prio">
                                                {renderPacCell(group.id)}
                                            </div>
                                            <div className="alloc-cell alloc-cell-target" data-label="Target %">
                                                <input
                                                    type="number"
                                                    className="form-input"
                                                    value={groupPerc}
                                                    onChange={(e) => handleUpdate(group.id, e.target.value)}
                                                    min="0"
                                                    max="100"
                                                    step="0.1"
                                                    style={{ textAlign: 'right' }}
                                                />
                                            </div>
                                        </div>

                                        {expanded && (
                                            <div style={{ padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                                                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                                                    {wcfg.weighted
                                                        ? 'Weighted mode: buys and sells keep the members close to their weight % (frozen members excluded).'
                                                        : 'Priority order: buys go to the top member, sells drain from the bottom first. Set weight % to switch to proportional mode.'}
                                                </div>
                                                {group.members.map((m, idx) => {
                                                    const rule = group.memberRules?.[m] || {};
                                                    const frozen = isFullyFrozen(rule);
                                                    return (
                                                        <div key={m} className="alloc-group-member" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: '0.85rem' }}>
                                                            <div className="alloc-member-reorder" style={{ display: 'flex', flexDirection: 'column', lineHeight: 0.8 }}>
                                                                <button onClick={() => moveMember(group, idx, -1)} disabled={idx === 0} style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'default' : 'pointer', color: idx === 0 ? 'var(--text-muted)' : 'var(--text-secondary)', fontSize: '0.7rem' }} title="Move up">▲</button>
                                                                <button onClick={() => moveMember(group, idx, 1)} disabled={idx === group.members.length - 1} style={{ background: 'none', border: 'none', cursor: idx === group.members.length - 1 ? 'default' : 'pointer', color: idx === group.members.length - 1 ? 'var(--text-muted)' : 'var(--text-secondary)', fontSize: '0.7rem' }} title="Move down">▼</button>
                                                            </div>
                                                            <span className="alloc-member-index" style={{ width: '20px', color: 'var(--text-muted)' }}>#{idx + 1}</span>
                                                            <div className="alloc-member-name" style={{ flex: 1 }}>
                                                                <strong>{m.toUpperCase()}</strong>
                                                                <span style={{ color: 'var(--text-secondary)', marginLeft: 'var(--space-2)' }}>{labelFor(m)}</span>
                                                            </div>
                                                            <label
                                                                className="alloc-member-weight"
                                                                style={{ display: 'flex', alignItems: 'center', gap: '4px', color: frozen ? 'var(--text-muted)' : 'var(--text-secondary)' }}
                                                                title={frozen ? 'Weight ignored: this member has both "Never buy" and "Never sell" (its value stays put)' : 'Intra-group weight %: active members must sum to 100'}
                                                            >
                                                                <input
                                                                    type="number"
                                                                    className="form-input"
                                                                    value={rule.weight ?? ''}
                                                                    onChange={(e) => setMemberWeight(group, m, e.target.value)}
                                                                    disabled={frozen}
                                                                    min="0"
                                                                    max="100"
                                                                    step="0.01"
                                                                    placeholder="—"
                                                                    style={{ width: '64px', textAlign: 'right', padding: '2px 6px', fontSize: '0.8rem' }}
                                                                />
                                                                %
                                                            </label>
                                                            <label className="alloc-member-rule" style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: rule.noBuy ? 'var(--color-danger)' : 'var(--text-secondary)' }}>
                                                                <input type="checkbox" checked={!!rule.noBuy} onChange={() => toggleMemberRule(group, m, 'noBuy')} />
                                                                Never buy
                                                            </label>
                                                            <label className="alloc-member-rule" style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: rule.noSell ? 'var(--color-danger)' : 'var(--text-secondary)' }}>
                                                                <input type="checkbox" checked={!!rule.noSell} onChange={() => toggleMemberRule(group, m, 'noSell')} />
                                                                Never sell
                                                            </label>
                                                            <button className="alloc-member-remove" onClick={() => removeMember(group, m)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '1rem' }} title="Remove from group">&times;</button>
                                                        </div>
                                                    );
                                                })}
                                                {wcfg.weighted && (
                                                    <div style={{ fontSize: '0.75rem', color: wcfg.valid ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }}>
                                                        Weights: {Math.round(wcfg.sum * 100) / 100}% / 100%
                                                        {!wcfg.valid && (
                                                            <span style={{ fontWeight: 400, display: 'block' }}>
                                                                Group not eligible for rebalancing until active weights sum to 100%.
                                                                {wcfg.missing.length > 0 && ` Missing weight: ${wcfg.missing.map(t => t.toUpperCase()).join(', ')}.`}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                <div className="alloc-group-footer" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
                                                    {availableForGroup.length > 0 && (
                                                        <select
                                                            className="form-input"
                                                            value=""
                                                            onChange={(e) => { addMemberToGroup(group, e.target.value); e.target.value = ''; }}
                                                            style={{ fontSize: '0.8rem', maxWidth: '220px' }}
                                                        >
                                                            <option value="">+ Add asset to group…</option>
                                                            {availableForGroup.map(t => (
                                                                <option key={t} value={t}>{t} — {labelFor(t)}</option>
                                                            ))}
                                                        </select>
                                                    )}
                                                    <button
                                                        onClick={() => deleteAllocationGroup(portfolioId, group.id)}
                                                        style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--color-danger)', color: 'var(--color-danger)', borderRadius: 'var(--radius-sm)', padding: '2px 8px', cursor: 'pointer', fontSize: '0.8rem' }}
                                                    >
                                                        Delete group
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {tickers.map(ticker => {
                                const isCash = isCashTicker(ticker);
                                const isVBond = isVirtualBondTicker(ticker);
                                const vb = isVBond ? vbondFor(ticker) : null;
                                const setting = assetSettings.find(s => s.ticker === ticker);
                                const cashInfo = cashTickers.find(c => c.ticker === ticker);
                                const currentPerc = allocations[ticker] || 0;

                                return (
                                    <div key={ticker} className="alloc-modal-row alloc-asset-row" data-ticker={isCash ? 'CASH' : isVBond ? 'VBOND' : ticker} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 90px 100px', gap: 'var(--space-4)', alignItems: 'center' }}>
                                        <div className="alloc-cell alloc-cell-ticker" style={{ fontWeight: 500, color: isCash ? 'var(--text-secondary)' : isVBond ? '#8B5CF6' : undefined }}>
                                            {isCash ? 'CASH' : isVBond ? (
                                                <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                                    <span style={{ fontSize: '0.7rem', background: '#8B5CF6', color: '#fff', borderRadius: '3px', padding: '1px 4px' }}>VBOND</span>
                                                    <button onClick={() => handleDeleteVBond(ticker)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.9rem', padding: 0 }} title="Remove virtual bond">&times;</button>
                                                </span>
                                            ) : ticker}
                                        </div>
                                        <div className="alloc-cell alloc-cell-asset" data-label="Asset">
                                            {isCash ? cashInfo?.label : isVBond ? (
                                                <span>{vb?.label || ticker} <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>mat. {vb?.targetMaturityDate}</span></span>
                                            ) : (setting?.label || '-')}
                                        </div>
                                        <div className="alloc-cell alloc-cell-class" data-label="Class" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                            {isCash ? 'Cash' : isVBond ? (
                                                <span style={{ color: '#8B5CF6' }}>Bond <span style={{ opacity: 0.7 }}>• {vb?.universe}</span></span>
                                            ) : (
                                                <>
                                                    {setting?.assetClass}
                                                    {setting?.assetSubClass && <span style={{ opacity: 0.7 }}> • {setting.assetSubClass}</span>}
                                                </>
                                            )}
                                        </div>
                                        <div className="alloc-cell alloc-cell-pac" data-label="PAC / Prio">
                                            {isCash ? <span style={{ color: 'var(--text-muted)' }}>-</span> : renderPacCell(ticker)}
                                        </div>
                                        <div className="alloc-cell alloc-cell-target" data-label="Target %">
                                            <input
                                                type="number"
                                                className="form-input"
                                                value={currentPerc}
                                                onChange={(e) => handleUpdate(ticker, e.target.value)}
                                                min="0"
                                                max="100"
                                                step="0.1"
                                                style={{ textAlign: 'right' }}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Add tools (asset / group / bond) — collapsed behind a single
                    toggle on mobile so they don't take space until needed. */}
                <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border-color)' }}>
                    <button
                        type="button"
                        className="btn alloc-add-toggle"
                        aria-expanded={addToolsOpen}
                        style={{ width: '100%', border: '1px dashed var(--border-color)', color: 'var(--text-secondary)', backgroundColor: 'transparent' }}
                        onClick={() => setAddToolsOpen(o => !o)}
                    >
                        {addToolsOpen ? '− Hide add options' : '+ Add asset, group or bond…'}
                    </button>

                    <div className={`alloc-add-tools${addToolsOpen ? ' open' : ''}`}>
                {/* Add New Asset Section */}
                <div>
                    {!isAddingAsset ? (
                        <button
                            className="btn"
                            style={{
                                width: '100%',
                                border: '1px dashed var(--border-color)',
                                color: 'var(--text-secondary)',
                                backgroundColor: 'transparent'
                            }}
                            onClick={() => setIsAddingAsset(true)}
                        >
                            + Add New Asset to Allocation
                        </button>
                    ) : (
                        <div style={{
                            padding: 'var(--space-4)',
                            backgroundColor: 'var(--bg-app)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--color-primary)'
                        }}>
                            <h4 style={{ marginTop: 0, marginBottom: 'var(--space-3)' }}>Define New Asset</h4>
                            <div className="alloc-modal-add-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Ticker (ISIN)</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="IE00..."
                                        value={newAssetTicker}
                                        onChange={e => setNewAssetTicker(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Label (Name)</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="iShares World..."
                                        value={newAssetLabel}
                                        onChange={e => setNewAssetLabel(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Class</label>
                                    <select
                                        className="form-input"
                                        value={newAssetClass}
                                        onChange={e => setNewAssetClass(e.target.value as AssetClass)}
                                    >
                                        <option value="Stock">Stock</option>
                                        <option value="Bond">Bond</option>
                                        <option value="Commodity">Commodity</option>
                                        <option value="Crypto">Crypto</option>
                                        <option value="Cash">Cash</option>
                                    </select>
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Sub-Class</label>
                                    <select
                                        className="form-input"
                                        value={newAssetSubClass}
                                        onChange={e => setNewAssetSubClass(e.target.value as AssetSubClass)}
                                    >
                                        <option value="International">International</option>
                                        <option value="Local">Local</option>
                                        <option value="Short">Bond: Short Term</option>
                                        <option value="Medium">Bond: Medium Term</option>
                                        <option value="Long">Bond: Long Term</option>
                                        <option value="Gold">Commodity: Gold</option>
                                        <option value="">None/Other</option>
                                    </select>
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                                <button className="btn" onClick={() => setIsAddingAsset(false)}>Cancel</button>
                                <button className="btn btn-primary" onClick={handleAddAsset} disabled={!newAssetTicker}>Add Asset</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Create Market Group Section */}
                <div>
                    {!isCreatingGroup ? (
                        <button
                            className="btn"
                            style={{
                                width: '100%',
                                border: '1px dashed var(--color-primary)',
                                color: 'var(--color-primary)',
                                backgroundColor: 'transparent'
                            }}
                            onClick={() => setIsCreatingGroup(true)}
                            disabled={availableForGroup.length < 2}
                            title={availableForGroup.length < 2 ? 'Need at least 2 ungrouped assets' : ''}
                        >
                            + Create Market Group (e.g. "All World" = VWCE + XMAU)
                        </button>
                    ) : (
                        <div style={{
                            padding: 'var(--space-4)',
                            backgroundColor: 'var(--bg-app)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--color-primary)'
                        }}>
                            <h4 style={{ marginTop: 0, marginBottom: 'var(--space-3)' }}>New Market Group</h4>
                            <div style={{ marginBottom: 'var(--space-3)' }}>
                                <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Group label</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="All World"
                                    value={newGroupLabel}
                                    onChange={e => setNewGroupLabel(e.target.value)}
                                />
                            </div>
                            <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-2)' }}>Members (pick at least 2)</label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', maxHeight: '180px', overflowY: 'auto', marginBottom: 'var(--space-3)' }}>
                                {availableForGroup.map(t => (
                                    <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', fontSize: '0.85rem' }}>
                                        <input type="checkbox" checked={newGroupMembers.includes(t)} onChange={() => toggleNewGroupMember(t)} />
                                        <strong>{t}</strong>
                                        <span style={{ color: 'var(--text-secondary)' }}>{labelFor(t)}</span>
                                    </label>
                                ))}
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                                <button className="btn" onClick={() => { setIsCreatingGroup(false); setNewGroupLabel(''); setNewGroupMembers([]); }}>Cancel</button>
                                <button className="btn btn-primary" onClick={handleCreateGroup} disabled={!newGroupLabel.trim() || newGroupMembers.length < 2}>Create Group</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Add Virtual Bond Section */}
                <div>
                    {!isAddingVBond ? (
                        <button
                            className="btn"
                            style={{
                                width: '100%',
                                border: '1px dashed #8B5CF6',
                                color: '#8B5CF6',
                                backgroundColor: 'transparent'
                            }}
                            onClick={() => setIsAddingVBond(true)}
                        >
                            + Add Virtual Bond (placeholder for future bond purchase)
                        </button>
                    ) : (
                        <div style={{
                            padding: 'var(--space-4)',
                            backgroundColor: 'var(--bg-app)',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid #8B5CF6'
                        }}>
                            <h4 style={{ marginTop: 0, marginBottom: 'var(--space-3)', color: '#8B5CF6' }}>New Virtual Bond</h4>
                            <div className="alloc-modal-add-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Label</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="e.g. BTP 2030"
                                        value={vbondLabel}
                                        onChange={e => setVbondLabel(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Target Maturity Date</label>
                                    <input
                                        type="date"
                                        className="form-input"
                                        value={vbondMaturity}
                                        onChange={e => setVbondMaturity(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: 'var(--space-1)' }}>Universe</label>
                                    <select
                                        className="form-input"
                                        value={vbondUniverse}
                                        onChange={e => setVbondUniverse(e.target.value as BondUniverse)}
                                    >
                                        <option value="IT">Italy only (BTP, CCT...)</option>
                                        <option value="EU">All European</option>
                                    </select>
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
                                <button className="btn" onClick={() => setIsAddingVBond(false)}>Cancel</button>
                                <button className="btn btn-primary" onClick={handleAddVBond} disabled={!vbondLabel.trim() || !vbondMaturity}>Add Virtual Bond</button>
                            </div>
                        </div>
                    )}
                </div>
                    </div>
                </div>

                <div style={{
                    marginTop: 'var(--space-4)',
                    padding: 'var(--space-3)',
                    backgroundColor: 'var(--bg-app)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontWeight: 600
                }}>
                    <span>Total Allocation</span>
                    <span style={{
                        color: Math.abs(total - 100) < 0.1 ? 'var(--color-success)' : 'var(--color-warning)',
                        fontSize: '1.1rem'
                    }}>
                        {total.toFixed(1)}%
                    </span>
                </div>

                <div className="form-actions" style={{ marginTop: 'var(--space-6)' }}>
                    <button onClick={onClose} className="btn btn-primary">
                        Done
                    </button>
                </div>
            </div>

            <style>{`
                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                }

                .modal-content {
                    background-color: var(--bg-surface);
                    padding: var(--space-6);
                    border-radius: var(--radius-lg);
                    width: 100%;
                    border: 1px solid var(--bg-card);
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                }

                .btn {
                    padding: var(--space-2) var(--space-4);
                    border-radius: var(--radius-md);
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    font-size: 0.9rem;
                }

                .btn-primary {
                    background-color: var(--color-primary);
                    color: white;
                }

                .btn-primary:hover {
                    opacity: 0.9;
                }
                
                .btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                /* The three add entry-points stack with even spacing. On wide
                   screens they're always visible and the mobile toggle is hidden;
                   mobile.css flips this to a collapsed, on-demand panel. */
                .alloc-add-tools {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-3);
                }

                .alloc-add-toggle {
                    display: none;
                }
            `}</style>
        </div>
    );
};

export default PortfolioAllocations;
