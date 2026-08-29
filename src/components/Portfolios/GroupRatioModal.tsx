import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets, injectCashAssets, isCashTicker } from '../../utils/portfolioCalculations';
import { buildPortfolioTree, GROUP_MEMBER_COLORS } from '../../utils/portfolioGroups';
import type { Portfolio } from '../../types';

/**
 * The parent/child ratio, edited where the relationship itself is: on the
 * Portfolios page.
 *
 * It used to be inferred from the per-portfolio targets in Global Rebalancing,
 * which meant the shape of a group was decided on a page about something else.
 * Now the group's INTERNAL split lives here and Global Rebalancing decides only
 * how big the group is as a whole.
 *
 * A member left blank is not a member set to zero: it keeps whatever share of
 * the group it holds today, so adding a portfolio to a group never plans it
 * down to nothing before anybody has said what it should be.
 */

const eur = (v: number) =>
    `€${Math.round(v).toLocaleString('en-IE')}`;

interface Props {
    parent: Portfolio;
    onClose: () => void;
}

interface Row {
    portfolio: Portfolio;
    value: number;
    isParent: boolean;
}

const GroupRatioModal: React.FC<Props> = ({ parent, onClose }) => {
    const {
        portfolios,
        goals,
        updatePortfolio,
        scopedTransactions: transactions,
        scopedBrokers: brokers,
        effectiveAssetSettings: assetSettings,
        marketData,
    } = usePortfolio();

    const members = useMemo((): Portfolio[] => {
        const group = buildPortfolioTree(portfolios).groups.find(g => g.parent.id === parent.id);
        return group ? group.members : [parent];
    }, [portfolios, parent]);

    // Same convention as the Dashboard: invested assets + the broker cash
    // earmarked to the portfolio. Per-portfolio liquidity is rebalancing-only
    // money and is left out, here as there.
    const rows = useMemo((): Row[] => members.map(portfolio => {
        const txs = transactions.filter(t => t.portfolioId === portfolio.id);
        const { assets: rawAssets, summary } = calculateAssets(txs, assetSettings, marketData);
        const cash = injectCashAssets(rawAssets, brokers, portfolio.id)
            .filter(a => isCashTicker(a.ticker))
            .reduce((s, a) => s + a.currentValue, 0);
        return {
            portfolio,
            value: summary.totalValue + cash,
            isParent: portfolio.id === parent.id,
        };
    }), [members, transactions, assetSettings, marketData, brokers, parent.id]);

    const groupTotal = rows.reduce((s, r) => s + r.value, 0);

    // Drafts are strings so a half-typed "1" on the way to "12" doesn't get
    // rewritten under the cursor. Empty string = no share configured.
    const [drafts, setDrafts] = useState<Record<string, string>>(() =>
        Object.fromEntries(members.map(m => [
            m.id,
            m.groupSharePercent !== undefined ? String(m.groupSharePercent) : '',
        ]))
    );

    const parsed = useMemo(() => {
        const out: Record<string, number | undefined> = {};
        rows.forEach(r => {
            const raw = (drafts[r.portfolio.id] ?? '').trim().replace(',', '.');
            if (raw === '') { out[r.portfolio.id] = undefined; return; }
            const n = Number(raw);
            out[r.portfolio.id] = Number.isFinite(n) && n >= 0 ? n : undefined;
        });
        return out;
    }, [drafts, rows]);

    const configuredRows = rows.filter(r => parsed[r.portfolio.id] !== undefined);
    const sum = configuredRows.reduce((s, r) => s + (parsed[r.portfolio.id] as number), 0);
    const anyConfigured = configuredRows.length > 0;
    const sumIsOff = anyConfigured && Math.abs(sum - 100) > 0.05;
    // One member alone carrying the whole ratio has nothing to be a ratio
    // against: the others would silently keep their value share.
    const partial = anyConfigured && configuredRows.length < rows.length;

    /** Goals differing from the parent's — the members the pyramid will tint. */
    const divergentGoals = useMemo(() => {
        const titleOf = (id?: string) => goals.find(g => g.id === id)?.title;
        return rows
            .filter(r => !r.isParent && r.portfolio.goalId && r.portfolio.goalId !== parent.goalId)
            .map(r => ({ name: r.portfolio.name, goalTitle: titleOf(r.portfolio.goalId) ?? 'another goal' }));
    }, [rows, goals, parent.goalId]);

    const goallessMembers = useMemo(
        () => rows.filter(r => !r.portfolio.goalId).map(r => r.portfolio.name),
        [rows]
    );

    const setDraft = (id: string, value: string) =>
        setDrafts(prev => ({ ...prev, [id]: value }));

    /** Scale the configured shares so they land on 100 without changing their proportions. */
    const normalize = () => {
        if (sum <= 0) return;
        setDrafts(prev => {
            const next = { ...prev };
            configuredRows.forEach(r => {
                const share = ((parsed[r.portfolio.id] as number) / sum) * 100;
                next[r.portfolio.id] = String(Math.round(share * 10) / 10);
            });
            return next;
        });
    };

    /** Seed every member from what it is worth right now. */
    const seedFromValue = () => {
        if (groupTotal <= 0) return;
        setDrafts(Object.fromEntries(rows.map(r => [
            r.portfolio.id,
            String(Math.round((r.value / groupTotal) * 1000) / 10),
        ])));
    };

    /** Back to "no ratio configured": every member reverts to its value share. */
    const clearAll = () => setDrafts(Object.fromEntries(rows.map(r => [r.portfolio.id, ''])));

    const save = () => {
        rows.forEach(r => {
            const share = parsed[r.portfolio.id];
            const current = r.portfolio.groupSharePercent;
            if (share === current) return;
            updatePortfolio(
                share === undefined
                    ? { ...r.portfolio, groupSharePercent: undefined }
                    : { ...r.portfolio, groupSharePercent: share }
            );
        });
        onClose();
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content ratio-modal">
                <button className="modal-close-btn" type="button" onClick={onClose}>×</button>
                <h3>Group ratio — {parent.name}</h3>
                <p className="ratio-intro">
                    How this group splits internally. Global Rebalancing sets how big the whole group
                    should be; this decides how that size is shared between parent and children.
                    Leave a member blank to let it keep its current share of the group.
                </p>

                <div className="ratio-table">
                    <div className="ratio-head">
                        <span>Portfolio</span>
                        <span className="ratio-num">Current</span>
                        <span className="ratio-num">Current %</span>
                        <span className="ratio-num">Ratio %</span>
                        <span className="ratio-num">At ratio</span>
                    </div>
                    {rows.map((r, i) => {
                        const share = parsed[r.portfolio.id];
                        const currentPct = groupTotal > 0 ? (r.value / groupTotal) * 100 : 0;
                        const atRatio = share !== undefined && sum > 0
                            ? groupTotal * (share / sum)
                            : null;
                        return (
                            <div className="ratio-row" key={r.portfolio.id}>
                                <span className="ratio-name">
                                    <span
                                        className="ratio-dot"
                                        style={{ backgroundColor: GROUP_MEMBER_COLORS[i % GROUP_MEMBER_COLORS.length] }}
                                    />
                                    {r.isParent ? <strong>{r.portfolio.name}</strong> : r.portfolio.name}
                                    {r.isParent && <span className="ratio-tag">parent</span>}
                                </span>
                                <span className="ratio-num">{eur(r.value)}</span>
                                <span className="ratio-num ratio-muted">{currentPct.toFixed(1)}%</span>
                                <span className="ratio-num">
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        className="ratio-input"
                                        value={drafts[r.portfolio.id] ?? ''}
                                        onChange={e => setDraft(r.portfolio.id, e.target.value)}
                                        placeholder="—"
                                        aria-label={`Ratio % for ${r.portfolio.name}`}
                                    />
                                </span>
                                <span className="ratio-num ratio-muted">
                                    {atRatio === null ? '—' : eur(atRatio)}
                                </span>
                            </div>
                        );
                    })}
                    <div className="ratio-row ratio-total">
                        <span className="ratio-name">Total</span>
                        <span className="ratio-num">{eur(groupTotal)}</span>
                        <span className="ratio-num ratio-muted">100%</span>
                        <span className={`ratio-num ${sumIsOff ? 'ratio-bad' : 'ratio-ok'}`}>
                            {anyConfigured ? `${(Math.round(sum * 10) / 10)}%` : '—'}
                        </span>
                        <span className="ratio-num" />
                    </div>
                </div>

                <div className="ratio-tools">
                    <button type="button" className="btn btn-secondary" onClick={normalize} disabled={!anyConfigured || sum <= 0}>
                        Normalise to 100
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={seedFromValue} disabled={groupTotal <= 0}>
                        Seed from current values
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={clearAll} disabled={!anyConfigured}>
                        Clear
                    </button>
                </div>

                {sumIsOff && (
                    <p className="ratio-note ratio-note-warn">
                        The shares add up to {(Math.round(sum * 10) / 10)}%, not 100%. They are used as relative
                        weights, so this still works — but normalising makes the numbers mean what they say.
                    </p>
                )}
                {partial && (
                    <p className="ratio-note">
                        {configuredRows.length} of {rows.length} members have a share. The others keep their
                        current share of the group, and the configured ones split what is left between them.
                    </p>
                )}
                {divergentGoals.length > 0 && (
                    <p className="ratio-note ratio-note-warn">
                        {divergentGoals.map(d => `${d.name} (${d.goalTitle})`).join(', ')}
                        {divergentGoals.length === 1 ? ' is' : ' are'} attached to a different goal than the parent.
                        Because the group counts as one portfolio, that value sits at the parent's level in the
                        pyramid — shown there in a lighter shade, so you can see it is on loan. The pyramid's
                        total does not change.
                    </p>
                )}
                {goallessMembers.length > 0 && (
                    <p className="ratio-note">
                        {goallessMembers.join(', ')} {goallessMembers.length === 1 ? 'has' : 'have'} no goal, so
                        {goallessMembers.length === 1 ? ' it stays' : ' they stay'} out of the pyramid — the same
                        as any portfolio without a goal, group or not.
                    </p>
                )}

                <div className="form-actions">
                    <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
                    <button type="button" onClick={save} className="btn btn-primary">Save ratio</button>
                </div>
            </div>

            <style>{`
                .modal-overlay {
                    position: fixed; inset: 0;
                    background-color: rgba(0, 0, 0, 0.5);
                    display: flex; align-items: center; justify-content: center;
                    z-index: 1000; padding: var(--space-4);
                }
                .modal-content.ratio-modal {
                    position: relative;
                    background-color: var(--bg-surface);
                    padding: var(--space-6);
                    border-radius: var(--radius-lg);
                    width: 100%; max-width: 660px;
                    max-height: 90vh; overflow-y: auto;
                    border: 1px solid var(--bg-card);
                }
                .ratio-modal h3 { margin: 0 0 var(--space-2); font-size: 1.2rem; color: var(--text-primary); }
                .ratio-intro { margin: 0 0 var(--space-4); font-size: 0.83rem; color: var(--text-muted); line-height: 1.5; }
                .ratio-table { display: flex; flex-direction: column; gap: 2px; }
                .ratio-head, .ratio-row {
                    display: grid;
                    grid-template-columns: minmax(120px, 1.6fr) 0.9fr 0.7fr 0.8fr 0.9fr;
                    gap: var(--space-2); align-items: center;
                }
                .ratio-head {
                    font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em;
                    color: var(--text-muted); padding-bottom: var(--space-2);
                    border-bottom: 1px solid var(--bg-card);
                }
                .ratio-row { padding: var(--space-2) 0; font-size: 0.86rem; color: var(--text-primary); }
                .ratio-row + .ratio-row { border-top: 1px solid var(--bg-card); }
                .ratio-total { border-top: 1px solid var(--border-color); font-weight: 600; }
                .ratio-name { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
                .ratio-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
                .ratio-tag {
                    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.04em;
                    color: var(--text-muted); border: 1px solid var(--bg-card);
                    border-radius: var(--radius-sm); padding: 0 4px;
                }
                .ratio-num { text-align: right; font-variant-numeric: tabular-nums; }
                .ratio-muted { color: var(--text-muted); }
                .ratio-ok { color: var(--color-success, #10B981); }
                .ratio-bad { color: var(--color-warning, #F59E0B); }
                .ratio-input {
                    width: 100%; max-width: 78px; text-align: right;
                    padding: var(--space-1) var(--space-2);
                    border-radius: var(--radius-md); border: 1px solid var(--bg-card);
                    background-color: var(--bg-background); color: var(--text-primary);
                    font-size: 0.86rem; font-variant-numeric: tabular-nums;
                }
                .ratio-input:focus { outline: none; border-color: var(--color-primary); }
                .ratio-tools { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-4); }
                .ratio-note {
                    margin: var(--space-3) 0 0; font-size: 0.78rem; line-height: 1.5;
                    color: var(--text-muted);
                }
                .ratio-note-warn { color: var(--color-warning, #F59E0B); }
                .form-actions {
                    display: flex; justify-content: flex-end; gap: var(--space-3);
                    margin-top: var(--space-5);
                }
                .btn {
                    padding: var(--space-2) var(--space-4); border-radius: var(--radius-md);
                    font-weight: 500; cursor: pointer; border: none; font-size: 0.88rem;
                }
                .btn:disabled { opacity: 0.45; cursor: not-allowed; }
                .btn-primary { background-color: var(--color-primary); color: white; }
                .btn-secondary {
                    background-color: transparent; border: 1px solid var(--bg-card);
                    color: var(--text-secondary);
                }
                .btn-secondary:hover:not(:disabled) { background-color: var(--bg-card); color: var(--text-primary); }
                .modal-close-btn {
                    position: absolute; top: var(--space-3); right: var(--space-3);
                    background: transparent; border: none; color: var(--text-muted);
                    font-size: 1.4rem; line-height: 1; cursor: pointer;
                }
                @media (max-width: 560px) {
                    .ratio-head { display: none; }
                    .ratio-row {
                        grid-template-columns: 1fr auto;
                        grid-auto-rows: min-content;
                        row-gap: 2px;
                    }
                    .ratio-row .ratio-num { text-align: right; font-size: 0.8rem; }
                }
            `}</style>
        </div>
    );
};

export default GroupRatioModal;
