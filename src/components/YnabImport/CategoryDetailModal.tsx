import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabGoal, YnabGoalAllocation } from '../../types';
import { getVirtualBondId, isVirtualBondTicker } from '../../types';
import type { CategoryPosition } from '../../utils/ynabCoverage';
import AllocationModal from '../YnabGoals/AllocationModal';

/**
 * Where one category's money is, beyond its Available: the target it saves
 * toward, whether it is part of the emergency fund, and the money it has
 * invested in portfolios or assets.
 *
 * The invested parts are the allocations of the YNAB goal tracking the
 * category — the same records the YNAB Goals page shows — so a category
 * outside the goals group gets such a goal the first time one is added.
 */

const eur = (value: number) =>
    value.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });

interface Props {
    position: CategoryPosition;
    onClose: () => void;
}

const CategoryDetailModal: React.FC<Props> = ({ position, onClose }) => {
    const {
        portfolios, effectiveAssetSettings, virtualBonds, removeAllocation,
        ensureCategoryGoal, setCategoryGoalTarget, setYnabMappingEmergency,
    } = usePortfolio();

    const [amount, setAmount] = useState(position.goal?.amount ? String(position.goal.amount) : '');
    const [date, setDate] = useState(position.goal?.date ?? '');
    const [allocationDialog, setAllocationDialog] = useState<{ goal: YnabGoal; editing: YnabGoalAllocation | null } | null>(null);

    const goalDirty = (amount || '') !== (position.goal?.amount ? String(position.goal.amount) : '')
        || (date || '') !== (position.goal?.date ?? '');

    const saveGoal = () => {
        const value = parseFloat(amount);
        setCategoryGoalTarget(position.categoryId, {
            amount: Number.isFinite(value) && value > 0 ? value : null,
            date: date || null,
        });
    };

    const openAllocation = (editing: YnabGoalAllocation | null) => {
        const goal = ensureCategoryGoal(position.categoryId);
        if (goal) setAllocationDialog({ goal, editing });
    };

    const rowLabel = (a: YnabGoalAllocation) => {
        const portfolio = portfolios.find(p => p.id === a.portfolioId);
        if (!a.ticker) return portfolio?.name ?? 'Missing portfolio';
        const group = portfolio?.allocationGroups?.find(g => g.id === a.ticker);
        const label = group?.label
            ?? (isVirtualBondTicker(a.ticker)
                ? virtualBonds.find(b => b.id === getVirtualBondId(a.ticker!))?.label ?? 'Virtual bond'
                : effectiveAssetSettings.find(s => s.ticker.toUpperCase() === a.ticker!.toUpperCase())?.label ?? a.ticker);
        return `${portfolio?.name ?? 'Missing portfolio'} › ${label}`;
    };

    const handleRemove = (a: YnabGoalAllocation) => {
        Swal.fire({
            title: 'Remove this holding?',
            text: `${rowLabel(a)} · ${eur(a.amount)}`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Remove',
        }).then(r => { if (r.isConfirmed) removeAllocation(a.id); });
    };

    const covered = Math.max(0, position.available) + position.invested;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content ycd-modal" onClick={e => e.stopPropagation()}>
                <h3>{position.name}</h3>
                <div className="ycd-figures">
                    <div><span>Available (cash)</span><strong>{eur(position.available)}</strong></div>
                    <div><span>Invested</span><strong>{eur(position.invested)}</strong></div>
                    <div><span>Total</span><strong>{eur(covered)}</strong></div>
                </div>

                <section className="ycd-section">
                    <h4>Goal</h4>
                    <p className="ycd-hint">
                        {position.goal?.source === 'goal'
                            ? 'Stored in YNAB Goals — editing it here edits it there too.'
                            : position.goal
                                ? 'Read from the category name, note or YNAB goal. Saving stores it as a goal.'
                                : 'Optional: a target and a date turn this category into a tracked goal.'}
                    </p>
                    <div className="ycd-goal-row">
                        <label>
                            <span>Target (€)</span>
                            <input
                                type="number"
                                className="form-input"
                                min="0"
                                step="100"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                            />
                        </label>
                        <label>
                            <span>By</span>
                            <input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} />
                        </label>
                        <button type="button" className="btn btn-primary" onClick={saveGoal} disabled={!goalDirty}>
                            Save
                        </button>
                    </div>
                </section>

                <section className="ycd-section">
                    <label className="ycd-check">
                        <input
                            type="checkbox"
                            checked={position.emergencyFund}
                            onChange={e => setYnabMappingEmergency(position.categoryId, e.target.checked)}
                        />
                        Part of the emergency fund
                    </label>
                </section>

                <section className="ycd-section">
                    <div className="ycd-section-head">
                        <h4>Invested in</h4>
                        <button type="button" className="btn" onClick={() => openAllocation(null)}>+ Add</button>
                    </div>
                    {position.allocations.length === 0 ? (
                        <p className="ycd-hint">
                            Nothing yet. Add the portfolio or asset holding part of this category's money; its Available
                            stays the cash on the account.
                        </p>
                    ) : (
                        <ul className="ycd-list">
                            {position.allocations.map(a => (
                                <li key={a.id}>
                                    <span className="ycd-list-label">{rowLabel(a)}</span>
                                    <span className="ycd-list-amount">{eur(a.amount)}</span>
                                    <button type="button" className="ycd-link" onClick={() => openAllocation(a)}>Edit</button>
                                    <button type="button" className="ycd-link ycd-danger" onClick={() => handleRemove(a)}>Remove</button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>

                <div className="ycd-actions">
                    <button type="button" className="btn" onClick={onClose}>Close</button>
                </div>
            </div>

            {allocationDialog && (
                <div onClick={e => e.stopPropagation()}>
                    <AllocationModal
                        ynabGoal={allocationDialog.goal}
                        editing={allocationDialog.editing}
                        onClose={() => setAllocationDialog(null)}
                    />
                </div>
            )}

            <style>{`
                .modal-overlay {
                    position: fixed;
                    inset: 0;
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
                    max-width: 500px;
                    max-height: 90vh;
                    overflow-y: auto;
                    overflow-x: hidden;
                    border: 1px solid var(--bg-card);
                }
                .ycd-modal { max-width: 560px; width: 95vw; }
                .ycd-modal h3 { margin: 0 0 0.75rem; }
                .ycd-modal h4 { margin: 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
                .ycd-figures {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 0.5rem;
                }
                .ycd-figures div {
                    background: var(--bg-card);
                    border-radius: var(--radius-md);
                    padding: 0.5rem 0.65rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.15rem;
                }
                .ycd-figures span { font-size: 0.72rem; color: var(--text-muted); }
                .ycd-section { margin-top: 1rem; }
                .ycd-section-head { display: flex; justify-content: space-between; align-items: center; }
                .ycd-hint { font-size: 0.8rem; color: var(--text-secondary); margin: 0.35rem 0 0.5rem; }
                .ycd-goal-row { display: flex; gap: 0.5rem; align-items: flex-end; flex-wrap: wrap; }
                .ycd-goal-row label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.75rem; color: var(--text-muted); flex: 1 1 140px; }
                .ycd-check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; cursor: pointer; }
                .ycd-list { list-style: none; margin: 0.5rem 0 0; padding: 0; }
                .ycd-list li {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                    padding: 0.45rem 0;
                    border-bottom: 1px solid var(--border-color);
                    font-size: 0.88rem;
                }
                .ycd-list-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
                .ycd-list-amount { font-variant-numeric: tabular-nums; font-weight: 600; }
                .ycd-link { background: none; border: none; color: var(--color-primary); cursor: pointer; font-size: 0.8rem; padding: 0; }
                .ycd-danger { color: var(--color-danger); }
                .ycd-actions { display: flex; justify-content: flex-end; margin-top: 1.25rem; }
            `}</style>
        </div>
    );
};

export default CategoryDetailModal;
