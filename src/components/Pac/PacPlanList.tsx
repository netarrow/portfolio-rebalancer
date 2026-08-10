import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { PacFrequency, PacPlan } from '../../types';
import { generateInstalments } from '../../utils/pacSchedule';
import PacPlanForm from './PacPlanForm';
import Swal from 'sweetalert2';

const FREQUENCY_LABELS: Record<PacFrequency, string> = {
    weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly',
    bimonthly: 'Every 2 months', quarterly: 'Quarterly', semiannual: 'Every 6 months', annual: 'Yearly',
};

const todayISO = () => new Date().toISOString().slice(0, 10);

const PacPlanList: React.FC = () => {
    const { pacPlans, addPacPlan, updatePacPlan, deletePacPlan, portfolios, brokers } = usePortfolio();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingPlan, setEditingPlan] = useState<PacPlan | null>(null);

    const openCreate = () => { setEditingPlan(null); setIsModalOpen(true); };
    const openEdit = (plan: PacPlan) => { setEditingPlan(plan); setIsModalOpen(true); };
    const closeModal = () => { setEditingPlan(null); setIsModalOpen(false); };

    const handleSubmit = (data: Omit<PacPlan, 'id' | 'createdAt'>) => {
        if (editingPlan) {
            updatePacPlan({ ...editingPlan, ...data });
        } else {
            addPacPlan({ ...data, id: crypto.randomUUID(), createdAt: new Date().toISOString() });
        }
        closeModal();
    };

    const togglePause = (plan: PacPlan) => {
        updatePacPlan({ ...plan, active: !plan.active });
    };

    const handleDelete = (plan: PacPlan) => {
        const broker = brokers.find(b => b.id === plan.brokerId);
        const parked = broker?.liquidityAllocations?.[plan.portfolioId] ?? 0;
        const portfolioName = portfolios.find(p => p.id === plan.portfolioId)?.name || 'this portfolio';
        Swal.fire({
            title: 'Delete PAC plan?',
            html: `Delete "<b>${plan.name}</b>"? Its installment history is removed too.` +
                (parked > 0
                    ? `<p style="margin-top:8px;font-size:0.85rem;color:#b45309">€${parked.toFixed(2)} is currently parked on ${broker?.name || 'this broker'} for ${portfolioName} — deleting the plan will NOT remove it; manage it from the Broker page if needed.</p>`
                    : ''),
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'Yes, delete it',
        }).then(result => {
            if (result.isConfirmed) {
                deletePacPlan(plan.id);
                Swal.fire('Deleted!', 'The PAC plan has been deleted.', 'success');
            }
        });
    };

    return (
        <div className="pac-plan-list">
            <div className="header-actions">
                <h2>PAC Plans</h2>
                <button className="btn btn-primary" onClick={openCreate}>+ New Plan</button>
            </div>

            {pacPlans.length === 0 ? (
                <div className="pac-empty-state">No PAC plans yet. Create one to start auto-tracking a recurring investment.</div>
            ) : (
                <div className="pac-plan-grid">
                    {pacPlans.map(plan => {
                        const portfolio = portfolios.find(p => p.id === plan.portfolioId);
                        const broker = brokers.find(b => b.id === plan.brokerId);
                        const parked = broker?.liquidityAllocations?.[plan.portfolioId] ?? 0;
                        const nextDue = generateInstalments(plan, todayISO(), 1).slice(-1)[0];
                        return (
                            <div key={plan.id} className={`pac-plan-card ${!plan.active ? 'paused' : ''}`}>
                                <div className="card-header">
                                    <div>
                                        <h3>{plan.name}</h3>
                                        <span className="pac-ticker-badge">{plan.ticker}</span>
                                        {!plan.active && <span className="pac-paused-badge">Paused</span>}
                                    </div>
                                    <div className="card-actions">
                                        <button className="btn-icon" title="Edit" onClick={() => openEdit(plan)}>✏️</button>
                                        <button className="btn-icon" title={plan.active ? 'Pause' : 'Resume'} onClick={() => togglePause(plan)}>
                                            {plan.active ? '⏸️' : '▶️'}
                                        </button>
                                        <button className="btn-icon delete" title="Delete" onClick={() => handleDelete(plan)}>🗑️</button>
                                    </div>
                                </div>
                                <div className="pac-plan-details">
                                    <div>{plan.mode === 'amount' ? `€${plan.amount?.toFixed(2)}` : `${plan.quantity} units`} · {FREQUENCY_LABELS[plan.frequency]}</div>
                                    <div>Portfolio: {portfolio?.name || '—'}</div>
                                    <div>Broker: {broker?.name || '—'}</div>
                                    {nextDue && <div>Next due: {nextDue}</div>}
                                    {parked > 0 && (
                                        <div className="pac-parked-note">
                                            €{parked.toFixed(2)} parked on {broker?.name} for {portfolio?.name} (shared broker-level allocation)
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {isModalOpen && (
                <PacPlanForm initialData={editingPlan} onSubmit={handleSubmit} onCancel={closeModal} />
            )}

            <style>{`
                .header-actions {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: var(--space-4);
                }
                .header-actions h2 { margin: 0; font-size: 1.5rem; color: var(--text-primary); }

                .pac-empty-state {
                    text-align: center;
                    padding: var(--space-8);
                    color: var(--text-secondary);
                    background-color: var(--bg-surface);
                    border-radius: var(--radius-lg);
                    border: 1px dashed var(--bg-card);
                }

                .pac-plan-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
                    gap: var(--space-4);
                }

                .pac-plan-card {
                    background-color: var(--bg-surface);
                    border: 1px solid var(--bg-card);
                    border-radius: var(--radius-lg);
                    padding: var(--space-4);
                }

                .pac-plan-card.paused { opacity: 0.65; }

                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: var(--space-3);
                }

                .card-header h3 { margin: 0 0 4px 0; font-size: 1.05rem; color: var(--text-primary); }

                .card-actions { display: flex; gap: var(--space-1); flex-shrink: 0; }

                .btn-icon {
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    font-size: 1rem;
                    padding: var(--space-1);
                    border-radius: var(--radius-sm);
                }
                .btn-icon:hover { background-color: var(--bg-card); }
                .btn-icon.delete:hover { background-color: #fee2e2; }

                .pac-ticker-badge {
                    display: inline-block;
                    background-color: var(--bg-card);
                    color: var(--text-primary);
                    padding: 2px 8px;
                    border-radius: var(--radius-full);
                    font-size: 0.75rem;
                    font-weight: 600;
                    margin-right: 6px;
                }

                .pac-paused-badge {
                    display: inline-block;
                    background-color: rgba(245, 158, 11, 0.15);
                    color: #b45309;
                    padding: 2px 8px;
                    border-radius: var(--radius-full);
                    font-size: 0.75rem;
                    font-weight: 600;
                }

                .pac-plan-details {
                    font-size: 0.85rem;
                    color: var(--text-secondary);
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }

                .pac-parked-note {
                    margin-top: 4px;
                    color: #b45309;
                }
            `}</style>
        </div>
    );
};

export default PacPlanList;
