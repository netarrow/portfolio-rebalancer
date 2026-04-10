import React, { useMemo, useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets } from '../../utils/portfolioCalculations';
import {
    calculateAssetAllocation,
    type AssetAllocationAction,
    type AssetAllocationPortfolioInput
} from '../../utils/assetAllocation';
import type {
    LiquidityTargetConfig,
    PortfolioTargetConfig,
    PortfolioTargetMode,
    RatioGroupConfig,
    RatioGroupTargetMode
} from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatCurrency = (value: number): string =>
    value.toLocaleString('en-IE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

const formatSignedCurrency = (value: number): string => {
    const sign = value > 0 ? '+' : value < 0 ? '' : '';
    return `${sign}${formatCurrency(value)}`;
};

const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const parseNumericInput = (raw: string): number => {
    if (!raw) return 0;
    const sanitized = raw.trim().replace(/[^\d,.-]/g, '');
    if (!sanitized) return 0;
    const lastComma = sanitized.lastIndexOf(',');
    const lastDot = sanitized.lastIndexOf('.');
    let normalized = sanitized;
    if (lastComma > lastDot) {
        normalized = sanitized.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
        normalized = sanitized.replace(/,/g, '');
    } else {
        normalized = sanitized.replace(',', '.');
    }
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
};

const generateId = (): string =>
    `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const modeLabels: Record<PortfolioTargetMode, string> = {
    excluded: 'Excluded',
    locked: 'Locked at current',
    fixed: 'Fixed EUR',
    percent: '% of total',
    ratio: 'Ratio (group)'
};

const groupModeLabels: Record<RatioGroupTargetMode, string> = {
    fixed: 'Fixed EUR',
    percent: '% of total',
    remainder: 'Remainder'
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const GlobalRebalancingView: React.FC = () => {
    const {
        portfolios,
        transactions,
        assetSettings,
        marketData,
        brokers,
        assetAllocationSettings,
        updatePortfolioTarget,
        updateLiquidityTarget,
        upsertRatioGroup,
        deleteRatioGroup
    } = usePortfolio();

    // Compute each portfolio's current state
    const portfolioInputs = useMemo<AssetAllocationPortfolioInput[]>(() => {
        return portfolios.map((p) => {
            const txs = transactions.filter((t) => t.portfolioId === p.id);
            const { summary } = calculateAssets(txs, assetSettings, marketData);
            const liquidity = Number.isFinite(p.liquidity) ? p.liquidity || 0 : 0;
            return {
                portfolioId: p.id,
                name: p.name,
                currentInvestedValue: summary.totalValue,
                currentPortfolioLiquidity: liquidity,
                currentTotalValue: summary.totalValue + liquidity
            };
        });
    }, [assetSettings, marketData, portfolios, transactions]);

    const brokerLiquidity = useMemo(
        () => brokers.reduce((s, b) => s + (Number.isFinite(b.currentLiquidity) ? b.currentLiquidity || 0 : 0), 0),
        [brokers]
    );

    const result = useMemo(
        () =>
            calculateAssetAllocation({
                portfolios: portfolioInputs,
                brokerLiquidity,
                settings: assetAllocationSettings
            }),
        [portfolioInputs, brokerLiquidity, assetAllocationSettings]
    );

    // --- Liquidity target handlers ---
    const liquidityTarget = assetAllocationSettings.liquidityTarget;
    const [liquidityDraftValue, setLiquidityDraftValue] = useState<string>(
        liquidityTarget ? String(liquidityTarget.value) : ''
    );
    // Keep local draft in sync if settings change externally
    React.useEffect(() => {
        setLiquidityDraftValue(liquidityTarget ? String(liquidityTarget.value) : '');
    }, [liquidityTarget?.mode, liquidityTarget?.value]);

    const handleToggleLiquidityTarget = () => {
        if (liquidityTarget) {
            updateLiquidityTarget(undefined);
        } else {
            updateLiquidityTarget({ mode: 'fixed', value: 0 });
        }
    };

    const handleLiquidityModeChange = (mode: 'fixed' | 'percent') => {
        const val = parseNumericInput(liquidityDraftValue);
        updateLiquidityTarget({ mode, value: val });
    };

    const handleLiquidityValueBlur = () => {
        if (!liquidityTarget) return;
        const val = parseNumericInput(liquidityDraftValue);
        updateLiquidityTarget({ mode: liquidityTarget.mode, value: val });
    };

    // --- Portfolio target handlers ---
    const handleChangePortfolioMode = (portfolioId: string, mode: PortfolioTargetMode) => {
        if (mode === 'excluded') {
            updatePortfolioTarget(portfolioId, { mode: 'excluded', value: 0 });
            return;
        }
        if (mode === 'locked') {
            updatePortfolioTarget(portfolioId, { mode: 'locked', value: 0 });
            return;
        }
        const existing = assetAllocationSettings.portfolioTargets[portfolioId];
        if (mode === 'ratio') {
            const firstGroup = assetAllocationSettings.ratioGroups[0];
            if (!firstGroup) {
                Swal.fire({
                    title: 'Nessun ratio group disponibile',
                    text: 'Crea prima un ratio group per assegnare questo portafoglio.',
                    icon: 'info',
                    confirmButtonColor: '#6366f1',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)'
                });
                return;
            }
            updatePortfolioTarget(portfolioId, {
                mode: 'ratio',
                value: existing?.value ?? 1,
                ratioGroupId: existing?.ratioGroupId ?? firstGroup.id
            });
            return;
        }
        updatePortfolioTarget(portfolioId, {
            mode,
            value: existing && existing.mode === mode ? existing.value : 0
        });
    };

    const handleChangePortfolioValue = (portfolioId: string, rawValue: string) => {
        const existing = assetAllocationSettings.portfolioTargets[portfolioId];
        if (!existing || existing.mode === 'excluded' || existing.mode === 'locked') return;
        const val = parseNumericInput(rawValue);
        updatePortfolioTarget(portfolioId, { ...existing, value: val });
    };

    const handleChangePortfolioRatioGroup = (portfolioId: string, groupId: string) => {
        const existing = assetAllocationSettings.portfolioTargets[portfolioId];
        if (!existing || existing.mode !== 'ratio') return;
        updatePortfolioTarget(portfolioId, { ...existing, ratioGroupId: groupId });
    };

    // --- Ratio group handlers ---
    const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
    const [groupDraft, setGroupDraft] = useState<RatioGroupConfig>({
        id: '',
        name: '',
        groupTargetMode: 'remainder',
        groupTargetValue: 0
    });

    const startAddGroup = () => {
        setGroupDraft({
            id: generateId(),
            name: '',
            groupTargetMode: 'remainder',
            groupTargetValue: 0
        });
        setEditingGroupId('__new__');
    };

    const startEditGroup = (g: RatioGroupConfig) => {
        setGroupDraft({ ...g });
        setEditingGroupId(g.id);
    };

    const cancelEditGroup = () => {
        setEditingGroupId(null);
    };

    const saveGroup = () => {
        if (!groupDraft.name.trim()) {
            Swal.fire({
                title: 'Nome mancante',
                text: 'Inserisci un nome per il ratio group.',
                icon: 'warning',
                confirmButtonColor: '#6366f1',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)'
            });
            return;
        }
        upsertRatioGroup({
            ...groupDraft,
            name: groupDraft.name.trim(),
            groupTargetValue:
                groupDraft.groupTargetMode === 'remainder' ? 0 : Math.max(0, groupDraft.groupTargetValue)
        });
        setEditingGroupId(null);
    };

    const handleDeleteGroup = async (g: RatioGroupConfig) => {
        const confirmation = await Swal.fire({
            title: `Eliminare "${g.name}"?`,
            text: 'I portafogli che usano questo gruppo verranno resettati a Excluded.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Elimina',
            cancelButtonText: 'Annulla',
            confirmButtonColor: '#ef4444',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)'
        });
        if (!confirmation.isConfirmed) return;
        deleteRatioGroup(g.id);
    };

    // --- Empty state ---
    if (portfolios.length === 0) {
        return (
            <div className="aa-empty">
                <h2>Asset Allocation</h2>
                <p>Crea almeno un portfolio prima di configurare l'asset allocation.</p>
                <style>{`
                    .aa-empty {
                        background: var(--bg-surface);
                        border: 1px solid var(--border-color);
                        border-radius: var(--radius-lg);
                        padding: var(--space-8);
                        text-align: center;
                    }
                `}</style>
            </div>
        );
    }

    const existingRemainderGroup = assetAllocationSettings.ratioGroups.find(
        (g) => g.groupTargetMode === 'remainder'
    );
    const editingIsDifferentRemainder =
        groupDraft.groupTargetMode === 'remainder' &&
        existingRemainderGroup &&
        existingRemainderGroup.id !== groupDraft.id;

    return (
        <div className="aa-page">
            {/* ============ HERO ============ */}
            <section className="aa-card aa-hero-card">
                <div>
                    <h2>Asset Allocation</h2>
                    <p>
                        Configura target high-level per ogni portfolio (fisso in EUR, % del totale, locked, escluso
                        o ratio di gruppo). Il sistema calcola la distribuzione attesa, suggerisce sell/buy e segnala
                        se la configurazione è sostenibile.
                    </p>
                </div>
                <div className="aa-metrics">
                    <div className="aa-metric">
                        <span className="aa-metric-label">Total Wealth</span>
                        <strong>{formatCurrency(result.totalWealth)}</strong>
                    </div>
                    <div className="aa-metric">
                        <span className="aa-metric-label">Liquidity (broker)</span>
                        <strong>
                            {formatCurrency(result.liquidity.current)}
                            {result.liquidity.hasTarget && (
                                <span className={`aa-sub ${Math.abs(result.liquidity.delta) < 0.01 ? 'ok' : 'warn'}`}>
                                    {' '}
                                    → {formatCurrency(result.liquidity.target)}
                                </span>
                            )}
                        </strong>
                    </div>
                    <div className="aa-metric">
                        <span className="aa-metric-label">Sustainability</span>
                        <strong className={result.sustainability.sustainable ? 'ok' : 'bad'}>
                            {result.sustainability.sustainable
                                ? '✓ Sostenibile'
                                : `⚠ Manca ${formatCurrency(result.sustainability.shortfall)}`}
                        </strong>
                    </div>
                    <div className="aa-metric">
                        <span className="aa-metric-label">Portafogli configurati</span>
                        <strong>
                            {Object.keys(assetAllocationSettings.portfolioTargets).length} / {portfolios.length}
                        </strong>
                    </div>
                </div>
            </section>

            {/* ============ LIQUIDITY TARGET ============ */}
            <section className="aa-card">
                <div className="aa-section-head">
                    <h3>Liquidity Target (broker cash)</h3>
                    <label className="aa-toggle">
                        <input
                            type="checkbox"
                            checked={!!liquidityTarget}
                            onChange={handleToggleLiquidityTarget}
                        />
                        <span>{liquidityTarget ? 'Attivo' : 'Disattivo'}</span>
                    </label>
                </div>
                {liquidityTarget ? (
                    <div className="aa-liquidity-row">
                        <div className="aa-field">
                            <label>Modalità</label>
                            <div className="aa-radio-group">
                                <label>
                                    <input
                                        type="radio"
                                        name="liquidity-mode"
                                        checked={liquidityTarget.mode === 'fixed'}
                                        onChange={() => handleLiquidityModeChange('fixed')}
                                    />
                                    <span>Fixed EUR</span>
                                </label>
                                <label>
                                    <input
                                        type="radio"
                                        name="liquidity-mode"
                                        checked={liquidityTarget.mode === 'percent'}
                                        onChange={() => handleLiquidityModeChange('percent')}
                                    />
                                    <span>% del totale</span>
                                </label>
                            </div>
                        </div>
                        <div className="aa-field">
                            <label>
                                Valore {liquidityTarget.mode === 'fixed' ? '(EUR)' : '(%)'}
                            </label>
                            <input
                                type="text"
                                className="aa-input"
                                value={liquidityDraftValue}
                                onChange={(e) => setLiquidityDraftValue(e.target.value)}
                                onBlur={handleLiquidityValueBlur}
                                placeholder={liquidityTarget.mode === 'fixed' ? 'es. 30000' : 'es. 10'}
                            />
                        </div>
                        <div className="aa-field">
                            <label>Target calcolato</label>
                            <div className="aa-readout">{formatCurrency(result.liquidity.target)}</div>
                        </div>
                        <div className="aa-field">
                            <label>Delta</label>
                            <div
                                className={`aa-readout ${
                                    Math.abs(result.liquidity.delta) < 0.01
                                        ? ''
                                        : result.liquidity.delta > 0
                                        ? 'ok'
                                        : 'warn'
                                }`}
                            >
                                {formatSignedCurrency(result.liquidity.delta)}
                            </div>
                        </div>
                    </div>
                ) : (
                    <p className="aa-muted">
                        Nessun target per la liquidità. La liquidità broker corrente (
                        {formatCurrency(result.liquidity.current)}) viene mantenuta al valore attuale.
                    </p>
                )}
            </section>

            {/* ============ RATIO GROUPS ============ */}
            <section className="aa-card">
                <div className="aa-section-head">
                    <h3>Ratio Groups</h3>
                    <button className="btn btn-secondary" onClick={startAddGroup}>
                        + Nuovo gruppo
                    </button>
                </div>
                {assetAllocationSettings.ratioGroups.length === 0 && editingGroupId !== '__new__' && (
                    <p className="aa-muted">
                        Nessun ratio group definito. Crea un gruppo per assegnare portafogli in modalità ratio (es.
                        "Core/Satellite" con target Remainder).
                    </p>
                )}
                <div className="aa-group-list">
                    {assetAllocationSettings.ratioGroups.map((g) => {
                        const isEditing = editingGroupId === g.id;
                        const resultGroup = result.ratioGroups.find((rg) => rg.id === g.id);
                        return (
                            <div key={g.id} className={`aa-group-item ${isEditing ? 'editing' : ''}`}>
                                {!isEditing ? (
                                    <>
                                        <div className="aa-group-info">
                                            <strong>{g.name}</strong>
                                            <span className="aa-group-meta">
                                                {groupModeLabels[g.groupTargetMode]}
                                                {g.groupTargetMode !== 'remainder' &&
                                                    ` (${g.groupTargetMode === 'fixed' ? formatCurrency(g.groupTargetValue) : `${g.groupTargetValue}%`})`}
                                                {resultGroup && ` • Budget: ${formatCurrency(resultGroup.budget)}`}
                                                {resultGroup && resultGroup.members.length > 0 && ` • ${resultGroup.members.length} membri`}
                                            </span>
                                        </div>
                                        <div className="aa-group-actions">
                                            <button className="btn-icon" onClick={() => startEditGroup(g)}>
                                                ✎
                                            </button>
                                            <button className="btn-icon danger" onClick={() => handleDeleteGroup(g)}>
                                                ✕
                                            </button>
                                        </div>
                                    </>
                                ) : (
                                    <GroupEditor
                                        draft={groupDraft}
                                        setDraft={setGroupDraft}
                                        onSave={saveGroup}
                                        onCancel={cancelEditGroup}
                                        conflictRemainder={!!editingIsDifferentRemainder}
                                    />
                                )}
                            </div>
                        );
                    })}
                    {editingGroupId === '__new__' && (
                        <div className="aa-group-item editing">
                            <GroupEditor
                                draft={groupDraft}
                                setDraft={setGroupDraft}
                                onSave={saveGroup}
                                onCancel={cancelEditGroup}
                                conflictRemainder={!!editingIsDifferentRemainder}
                            />
                        </div>
                    )}
                </div>
            </section>

            {/* ============ PORTFOLIO TARGETS TABLE ============ */}
            <section className="aa-card">
                <div className="aa-section-head">
                    <h3>Portfolio Targets</h3>
                    <span className="aa-muted">{portfolios.length} portafogli</span>
                </div>
                <div className="aa-table-scroll">
                    <table className="aa-table">
                        <thead>
                            <tr>
                                <th>Portfolio</th>
                                <th>Mode</th>
                                <th>Value</th>
                                <th>Ratio Group</th>
                                <th>Current</th>
                                <th>Current %</th>
                                <th>Target</th>
                                <th>Target %</th>
                                <th>Delta</th>
                            </tr>
                        </thead>
                        <tbody>
                            {result.portfolios.map((row) => {
                                const cfg = assetAllocationSettings.portfolioTargets[row.portfolioId];
                                const mode = cfg?.mode ?? 'excluded';
                                const muted = mode === 'excluded';
                                const valueDisabled = mode === 'excluded' || mode === 'locked';
                                const unitLabel =
                                    mode === 'fixed' ? '€' : mode === 'percent' ? '%' : mode === 'ratio' ? 'w' : '—';
                                const displayValue =
                                    cfg && !valueDisabled ? String(cfg.value) : '';
                                return (
                                    <tr key={row.portfolioId} className={muted ? 'muted' : ''}>
                                        <td className="td-name">
                                            <strong>{row.name}</strong>
                                        </td>
                                        <td>
                                            <select
                                                className="aa-select"
                                                value={mode}
                                                onChange={(e) =>
                                                    handleChangePortfolioMode(
                                                        row.portfolioId,
                                                        e.target.value as PortfolioTargetMode
                                                    )
                                                }
                                            >
                                                {(Object.keys(modeLabels) as PortfolioTargetMode[]).map((m) => (
                                                    <option key={m} value={m}>
                                                        {modeLabels[m]}
                                                    </option>
                                                ))}
                                            </select>
                                        </td>
                                        <td>
                                            <div className="aa-value-cell">
                                                <input
                                                    type="text"
                                                    className="aa-input small"
                                                    value={displayValue}
                                                    onChange={(e) =>
                                                        handleChangePortfolioValue(row.portfolioId, e.target.value)
                                                    }
                                                    disabled={valueDisabled}
                                                    placeholder={valueDisabled ? '—' : '0'}
                                                />
                                                <span className="aa-unit">{unitLabel}</span>
                                            </div>
                                        </td>
                                        <td>
                                            {mode === 'ratio' ? (
                                                <select
                                                    className="aa-select"
                                                    value={cfg?.ratioGroupId ?? ''}
                                                    onChange={(e) =>
                                                        handleChangePortfolioRatioGroup(
                                                            row.portfolioId,
                                                            e.target.value
                                                        )
                                                    }
                                                >
                                                    {assetAllocationSettings.ratioGroups.map((g) => (
                                                        <option key={g.id} value={g.id}>
                                                            {g.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            ) : (
                                                <span className="aa-muted">—</span>
                                            )}
                                        </td>
                                        <td>{formatCurrency(row.currentValue)}</td>
                                        <td>{muted ? '—' : formatPercent(row.currentWeight)}</td>
                                        <td>{muted ? '—' : formatCurrency(row.targetValue)}</td>
                                        <td>{muted ? '—' : formatPercent(row.targetWeight)}</td>
                                        <td
                                            className={
                                                muted
                                                    ? ''
                                                    : Math.abs(row.delta) < 0.01
                                                    ? ''
                                                    : row.delta > 0
                                                    ? 'ok'
                                                    : 'warn'
                                            }
                                        >
                                            {muted ? '—' : formatSignedCurrency(row.delta)}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Mobile card list */}
                <div className="aa-mobile-list">
                    {result.portfolios.map((row) => {
                        const cfg = assetAllocationSettings.portfolioTargets[row.portfolioId];
                        const mode = cfg?.mode ?? 'excluded';
                        const muted = mode === 'excluded';
                        const valueDisabled = mode === 'excluded' || mode === 'locked';
                        const unitLabel =
                            mode === 'fixed' ? '€' : mode === 'percent' ? '%' : mode === 'ratio' ? 'w' : '—';
                        const displayValue = cfg && !valueDisabled ? String(cfg.value) : '';
                        return (
                            <article
                                key={`${row.portfolioId}-m`}
                                className={`aa-mobile-card ${muted ? 'muted' : ''}`}
                            >
                                <header>
                                    <strong>{row.name}</strong>
                                </header>
                                <div className="aa-mobile-field">
                                    <label>Mode</label>
                                    <select
                                        className="aa-select"
                                        value={mode}
                                        onChange={(e) =>
                                            handleChangePortfolioMode(
                                                row.portfolioId,
                                                e.target.value as PortfolioTargetMode
                                            )
                                        }
                                    >
                                        {(Object.keys(modeLabels) as PortfolioTargetMode[]).map((m) => (
                                            <option key={m} value={m}>
                                                {modeLabels[m]}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="aa-mobile-field">
                                    <label>Value ({unitLabel})</label>
                                    <input
                                        type="text"
                                        className="aa-input"
                                        value={displayValue}
                                        onChange={(e) =>
                                            handleChangePortfolioValue(row.portfolioId, e.target.value)
                                        }
                                        disabled={valueDisabled}
                                        placeholder={valueDisabled ? '—' : '0'}
                                    />
                                </div>
                                {mode === 'ratio' && (
                                    <div className="aa-mobile-field">
                                        <label>Ratio Group</label>
                                        <select
                                            className="aa-select"
                                            value={cfg?.ratioGroupId ?? ''}
                                            onChange={(e) =>
                                                handleChangePortfolioRatioGroup(row.portfolioId, e.target.value)
                                            }
                                        >
                                            {assetAllocationSettings.ratioGroups.map((g) => (
                                                <option key={g.id} value={g.id}>
                                                    {g.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                                <dl className="aa-mobile-metrics">
                                    <div>
                                        <dt>Current</dt>
                                        <dd>{formatCurrency(row.currentValue)}</dd>
                                    </div>
                                    <div>
                                        <dt>Current %</dt>
                                        <dd>{muted ? '—' : formatPercent(row.currentWeight)}</dd>
                                    </div>
                                    <div>
                                        <dt>Target</dt>
                                        <dd>{muted ? '—' : formatCurrency(row.targetValue)}</dd>
                                    </div>
                                    <div>
                                        <dt>Target %</dt>
                                        <dd>{muted ? '—' : formatPercent(row.targetWeight)}</dd>
                                    </div>
                                    <div>
                                        <dt>Delta</dt>
                                        <dd
                                            className={
                                                muted
                                                    ? ''
                                                    : Math.abs(row.delta) < 0.01
                                                    ? ''
                                                    : row.delta > 0
                                                    ? 'ok'
                                                    : 'warn'
                                            }
                                        >
                                            {muted ? '—' : formatSignedCurrency(row.delta)}
                                        </dd>
                                    </div>
                                </dl>
                            </article>
                        );
                    })}
                </div>
            </section>

            {/* ============ ACTIONS ============ */}
            <section className="aa-card">
                <div className="aa-section-head">
                    <h3>Azioni consigliate</h3>
                    <span className="aa-muted">{result.actions.length} azioni</span>
                </div>
                {result.actions.length === 0 ? (
                    <p className="aa-muted">Il portafoglio è allineato ai target ✓</p>
                ) : (
                    <ul className="aa-actions-list">
                        {result.actions.map((a, i) => (
                            <li key={i} className={`aa-action ${actionClass(a)}`}>
                                <span className="aa-action-icon">{actionIcon(a)}</span>
                                <span className="aa-action-text">{actionLabel(a)}</span>
                                <strong className="aa-action-amount">{formatCurrency(a.amount)}</strong>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* ============ SUSTAINABILITY / WARNINGS ============ */}
            <section
                className={`aa-card aa-status-card ${
                    !result.sustainability.sustainable
                        ? 'bad'
                        : result.warnings.length > 0 || result.unallocatedRemainder > 0.01
                        ? 'warn'
                        : 'ok'
                }`}
            >
                <h3>Stato configurazione</h3>
                <p className="aa-status-main">{result.sustainability.message}</p>
                {result.warnings.length > 0 && (
                    <ul className="aa-warning-list">
                        {result.warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                        ))}
                    </ul>
                )}
            </section>

            <style>{`
                .aa-page {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-6);
                }
                .aa-card {
                    background: linear-gradient(180deg, rgba(30, 41, 59, 0.96), rgba(15, 23, 42, 0.96));
                    border: 1px solid rgba(148, 163, 184, 0.16);
                    border-radius: var(--radius-lg);
                    padding: var(--space-6);
                    box-shadow: var(--shadow-md);
                }
                .aa-card h2, .aa-card h3 {
                    margin: 0 0 var(--space-2) 0;
                }
                .aa-hero-card p {
                    margin: 0;
                    color: var(--text-secondary);
                    max-width: 760px;
                    line-height: 1.5;
                }
                .aa-metrics {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: var(--space-4);
                    margin-top: var(--space-6);
                }
                .aa-metric {
                    padding: var(--space-4);
                    border-radius: var(--radius-md);
                    background: rgba(15, 23, 42, 0.72);
                    border: 1px solid rgba(148, 163, 184, 0.12);
                }
                .aa-metric-label {
                    display: block;
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    margin-bottom: var(--space-2);
                }
                .aa-metric strong {
                    font-size: 1.1rem;
                }
                .aa-sub {
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: var(--text-secondary);
                }
                .aa-sub.ok { color: var(--color-success); }
                .aa-sub.warn { color: var(--color-warning); }
                .aa-metric strong.ok, .ok { color: var(--color-success); }
                .aa-metric strong.bad, .bad { color: #ef4444; }
                .aa-metric strong.warn, .warn { color: var(--color-warning); }

                .aa-section-head {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: var(--space-3);
                    margin-bottom: var(--space-4);
                    flex-wrap: wrap;
                }
                .aa-section-head h3 { margin: 0; }
                .aa-muted { color: var(--text-secondary); font-size: 0.9rem; }

                .aa-toggle {
                    display: inline-flex;
                    align-items: center;
                    gap: var(--space-2);
                    cursor: pointer;
                    color: var(--text-secondary);
                }
                .aa-toggle input { width: 18px; height: 18px; cursor: pointer; }

                .aa-liquidity-row {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: var(--space-4);
                }
                .aa-field {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                }
                .aa-field label {
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    font-weight: 600;
                }
                .aa-input {
                    width: 100%;
                    border-radius: var(--radius-md);
                    border: 1px solid var(--border-color);
                    background: rgba(15, 23, 42, 0.92);
                    color: var(--text-primary);
                    padding: var(--space-3);
                    font: inherit;
                }
                .aa-input:disabled {
                    opacity: 0.45;
                    cursor: not-allowed;
                }
                .aa-input.small {
                    padding: var(--space-2);
                    text-align: right;
                    width: 90px;
                    min-width: 90px;
                    flex: 0 0 90px;
                }
                .aa-input:focus { outline: none; border-color: var(--color-primary); }
                .aa-readout {
                    padding: var(--space-3);
                    border-radius: var(--radius-md);
                    background: rgba(15, 23, 42, 0.5);
                    border: 1px solid rgba(148, 163, 184, 0.12);
                    font-weight: 600;
                }
                .aa-radio-group {
                    display: flex;
                    gap: var(--space-3);
                    flex-wrap: wrap;
                }
                .aa-radio-group label {
                    display: inline-flex;
                    align-items: center;
                    gap: var(--space-2);
                    cursor: pointer;
                    color: var(--text-primary);
                    font-weight: 400;
                    font-size: 0.9rem;
                }

                .aa-group-list {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-3);
                }
                .aa-group-item {
                    padding: var(--space-3) var(--space-4);
                    border: 1px solid rgba(148, 163, 184, 0.18);
                    border-radius: var(--radius-md);
                    background: rgba(15, 23, 42, 0.55);
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: var(--space-3);
                }
                .aa-group-item.editing {
                    display: block;
                }
                .aa-group-info { display: flex; flex-direction: column; gap: 2px; }
                .aa-group-meta { color: var(--text-secondary); font-size: 0.8rem; }
                .aa-group-actions { display: flex; gap: var(--space-2); }
                .btn-icon {
                    background: rgba(99, 102, 241, 0.12);
                    border: 1px solid rgba(99, 102, 241, 0.3);
                    color: var(--color-primary);
                    border-radius: var(--radius-sm);
                    width: 32px;
                    height: 32px;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.95rem;
                }
                .btn-icon.danger {
                    background: rgba(239, 68, 68, 0.12);
                    border-color: rgba(239, 68, 68, 0.3);
                    color: #f87171;
                }

                .aa-group-editor {
                    display: grid;
                    grid-template-columns: 2fr 1fr 1fr auto auto;
                    gap: var(--space-3);
                    align-items: end;
                }
                .aa-group-editor .aa-field { flex: 1; }
                .aa-group-editor .aa-select {
                    min-width: 140px;
                }
                .aa-select {
                    border-radius: var(--radius-md);
                    border: 1px solid var(--border-color);
                    background: rgba(15, 23, 42, 0.92);
                    color: var(--text-primary);
                    padding: var(--space-2) var(--space-3);
                    font: inherit;
                    cursor: pointer;
                }
                .aa-conflict {
                    grid-column: 1 / -1;
                    color: var(--color-warning);
                    font-size: 0.85rem;
                }
                .aa-group-editor-actions {
                    display: flex;
                    gap: var(--space-2);
                }

                .aa-table-scroll { overflow-x: auto; }
                .aa-table {
                    width: 100%;
                    border-collapse: collapse;
                    min-width: 1000px;
                }
                .aa-table th,
                .aa-table td {
                    padding: var(--space-3);
                    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
                    text-align: right;
                    white-space: nowrap;
                    vertical-align: middle;
                }
                .aa-table th { color: var(--text-secondary); font-weight: 600; font-size: 0.82rem; }
                .aa-table th:first-child,
                .aa-table td:first-child { text-align: left; }
                .aa-table tr.muted { opacity: 0.5; }
                .aa-value-cell {
                    display: inline-flex;
                    align-items: center;
                    gap: var(--space-2);
                    justify-content: flex-end;
                }
                .aa-unit {
                    color: var(--text-secondary);
                    font-size: 0.75rem;
                    width: 14px;
                    text-align: left;
                }

                .aa-mobile-list { display: none; }
                .aa-mobile-card {
                    border: 1px solid rgba(148, 163, 184, 0.2);
                    border-radius: var(--radius-md);
                    padding: var(--space-4);
                    background: rgba(15, 23, 42, 0.7);
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-3);
                }
                .aa-mobile-card.muted { opacity: 0.5; }
                .aa-mobile-field { display: flex; flex-direction: column; gap: var(--space-2); }
                .aa-mobile-field label { font-size: 0.75rem; color: var(--text-secondary); font-weight: 600; }
                .aa-mobile-metrics {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: var(--space-2);
                    margin: 0;
                }
                .aa-mobile-metrics div {
                    background: rgba(15, 23, 42, 0.5);
                    padding: var(--space-2);
                    border-radius: var(--radius-sm);
                    border: 1px solid rgba(148, 163, 184, 0.12);
                }
                .aa-mobile-metrics dt { color: var(--text-secondary); font-size: 0.7rem; }
                .aa-mobile-metrics dd { margin: 2px 0 0 0; font-size: 0.85rem; font-weight: 600; }

                .aa-actions-list {
                    list-style: none;
                    padding: 0;
                    margin: 0;
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                }
                .aa-action {
                    display: flex;
                    align-items: center;
                    gap: var(--space-3);
                    padding: var(--space-3) var(--space-4);
                    border-radius: var(--radius-md);
                    background: rgba(15, 23, 42, 0.6);
                    border-left: 3px solid transparent;
                }
                .aa-action.buy { border-left-color: var(--color-success); }
                .aa-action.sell { border-left-color: #ef4444; }
                .aa-action.liquidity { border-left-color: var(--color-primary); }
                .aa-action-icon { font-size: 1.1rem; }
                .aa-action-text { flex: 1; color: var(--text-primary); }
                .aa-action-amount { color: var(--text-primary); font-size: 1.05rem; }

                .aa-status-card.ok {
                    border-color: rgba(16, 185, 129, 0.4);
                    background: linear-gradient(180deg, rgba(16, 185, 129, 0.1), rgba(15, 23, 42, 0.96));
                }
                .aa-status-card.warn {
                    border-color: rgba(245, 158, 11, 0.4);
                    background: linear-gradient(180deg, rgba(245, 158, 11, 0.12), rgba(15, 23, 42, 0.96));
                }
                .aa-status-card.bad {
                    border-color: rgba(239, 68, 68, 0.4);
                    background: linear-gradient(180deg, rgba(239, 68, 68, 0.12), rgba(15, 23, 42, 0.96));
                }
                .aa-status-main { margin: 0 0 var(--space-3) 0; font-weight: 600; }
                .aa-warning-list {
                    margin: 0;
                    padding-left: var(--space-5);
                    color: var(--text-secondary);
                }

                @media (max-width: 1024px) {
                    .aa-card { padding: var(--space-5); }
                    .aa-group-editor {
                        grid-template-columns: 1fr 1fr;
                    }
                }
                @media (max-width: 768px) {
                    .aa-card { padding: var(--space-4); }
                    .aa-page { gap: var(--space-4); }
                    .aa-metrics { grid-template-columns: 1fr 1fr; }
                }
                @media (max-width: 430px) {
                    .aa-table-scroll { display: none; }
                    .aa-mobile-list {
                        display: flex;
                        flex-direction: column;
                        gap: var(--space-3);
                    }
                    .aa-metrics { grid-template-columns: 1fr; }
                    .aa-card { padding: var(--space-3); }
                    .aa-group-editor { grid-template-columns: 1fr; }
                }
            `}</style>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Subcomponents / helpers
// ---------------------------------------------------------------------------

interface GroupEditorProps {
    draft: RatioGroupConfig;
    setDraft: (g: RatioGroupConfig) => void;
    onSave: () => void;
    onCancel: () => void;
    conflictRemainder: boolean;
}

const GroupEditor: React.FC<GroupEditorProps> = ({ draft, setDraft, onSave, onCancel, conflictRemainder }) => {
    return (
        <div className="aa-group-editor">
            <div className="aa-field">
                <label>Nome</label>
                <input
                    type="text"
                    className="aa-input"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="es. Core/Satellite"
                />
            </div>
            <div className="aa-field">
                <label>Target mode</label>
                <select
                    className="aa-select"
                    value={draft.groupTargetMode}
                    onChange={(e) =>
                        setDraft({ ...draft, groupTargetMode: e.target.value as RatioGroupTargetMode })
                    }
                >
                    <option value="remainder">Remainder</option>
                    <option value="percent">% of total</option>
                    <option value="fixed">Fixed EUR</option>
                </select>
            </div>
            <div className="aa-field">
                <label>Value {draft.groupTargetMode === 'fixed' ? '(€)' : draft.groupTargetMode === 'percent' ? '(%)' : ''}</label>
                <input
                    type="text"
                    className="aa-input"
                    value={draft.groupTargetMode === 'remainder' ? '' : String(draft.groupTargetValue)}
                    disabled={draft.groupTargetMode === 'remainder'}
                    onChange={(e) =>
                        setDraft({
                            ...draft,
                            groupTargetValue: parseNumericInput(e.target.value)
                        })
                    }
                    placeholder={draft.groupTargetMode === 'remainder' ? '—' : '0'}
                />
            </div>
            <div className="aa-group-editor-actions">
                <button className="btn btn-primary" onClick={onSave}>
                    Salva
                </button>
                <button className="btn btn-secondary" onClick={onCancel}>
                    Annulla
                </button>
            </div>
            {conflictRemainder && (
                <div className="aa-conflict">
                    ⚠ Esiste già un gruppo "remainder": verrà convertito in "percent 0" al salvataggio.
                </div>
            )}
        </div>
    );
};

const actionClass = (a: AssetAllocationAction): string => {
    if (a.kind === 'buy') return 'buy';
    if (a.kind === 'sell') return 'sell';
    return 'liquidity';
};

const actionIcon = (a: AssetAllocationAction): string => {
    if (a.kind === 'buy') return '🟢';
    if (a.kind === 'sell') return '🔴';
    return '💧';
};

const actionLabel = (a: AssetAllocationAction): string => {
    if (a.kind === 'buy') return `Inietta in ${a.name}`;
    if (a.kind === 'sell') return `Vendi da ${a.name}`;
    if (a.kind === 'liquidity-increase') return 'Aumenta liquidità broker';
    return 'Riduci liquidità broker';
};

export default GlobalRebalancingView;
