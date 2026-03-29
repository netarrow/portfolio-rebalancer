import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import GoalForm from './GoalForm';
import type { Goal } from '../../types';
import Swal from 'sweetalert2';

const GoalList: React.FC = () => {
    const { goals, addGoal, updateGoal, deleteGoal, portfolios } = usePortfolio();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingGoal, setEditingGoal] = useState<Goal | null>(null);

    const sortedGoals = [...goals].sort((a, b) => a.order - b.order);

    const handleCreate = (data: Omit<Goal, 'id'>) => {
        addGoal({
            ...data,
            id: String(Date.now())
        });
        setIsModalOpen(false);
    };

    const handleUpdate = (data: Omit<Goal, 'id'>) => {
        if (editingGoal) {
            updateGoal({
                ...editingGoal,
                ...data
            });
            setEditingGoal(null);
            setIsModalOpen(false);
        }
    };

    const handleDelete = (id: string, title: string) => {
        Swal.fire({
            title: 'Are you sure?',
            text: `Delete goal "${title}"? Portfolios linked to this goal will be unlinked.`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            cancelButtonColor: '#3085d6',
            confirmButtonText: 'Yes, delete it!'
        }).then((result) => {
            if (result.isConfirmed) {
                deleteGoal(id);
                Swal.fire('Deleted!', 'Goal has been deleted.', 'success');
            }
        });
    };

    const openCreateModal = () => {
        setEditingGoal(null);
        setIsModalOpen(true);
    };

    const openEditModal = (goal: Goal) => {
        setEditingGoal(goal);
        setIsModalOpen(true);
    };

    const closeModal = () => {
        setEditingGoal(null);
        setIsModalOpen(false);
    };

    const getLinkedPortfolios = (goalId: string) => {
        return portfolios.filter(p => p.goalId === goalId);
    };

    return (
        <div className="goal-list-container">
            <div className="header-actions">
                <h2>Goals</h2>
                <button className="btn btn-primary" onClick={openCreateModal}>
                    + New Goal
                </button>
            </div>

            <div className="goal-grid">
                {sortedGoals.length === 0 ? (
                    <div className="empty-state">
                        <p>No goals created yet. Create goals to categorize your portfolios.</p>
                    </div>
                ) : (
                    sortedGoals.map(goal => {
                        const linked = getLinkedPortfolios(goal.id);
                        return (
                            <div key={goal.id} className="goal-card">
                                <div className="card-header">
                                    <h3>{goal.title}</h3>
                                    <div className="card-actions">
                                        <button
                                            className="btn-icon"
                                            onClick={() => openEditModal(goal)}
                                            title="Edit"
                                        >
                                            ✏️
                                        </button>
                                        <button
                                            className="btn-icon delete"
                                            onClick={() => handleDelete(goal.id, goal.title)}
                                            title="Delete"
                                        >
                                            🗑️
                                        </button>
                                    </div>
                                </div>
                                <div className="card-body">
                                    {goal.description && (
                                        <p className="description">{goal.description}</p>
                                    )}
                                    <div className="stats">
                                        <span className="stat-pill">Order: {goal.order}</span>
                                        <span className="stat-pill">
                                            {linked.length} Portfolio{linked.length !== 1 ? 's' : ''}
                                            {linked.length > 0 && `: ${linked.map(p => p.name).join(', ')}`}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {isModalOpen && (
                <GoalForm
                    initialData={editingGoal}
                    onSubmit={editingGoal ? handleUpdate : handleCreate}
                    onCancel={closeModal}
                />
            )}

            <style>{`
                .goal-list-container {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-6);
                }

                .header-actions {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .header-actions h2 {
                    margin: 0;
                    font-size: 1.5rem;
                    color: var(--text-primary);
                }

                .goal-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                    gap: var(--space-6);
                }

                .goal-card {
                    background-color: var(--bg-surface);
                    border: 1px solid var(--bg-card);
                    border-radius: var(--radius-lg);
                    padding: var(--space-5);
                    transition: transform 0.2s, box-shadow 0.2s;
                }

                .goal-card:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                }

                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: var(--space-3);
                }

                .card-header h3 {
                    margin: 0;
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: var(--text-primary);
                }

                .card-actions {
                    display: flex;
                    gap: var(--space-2);
                }

                .btn-icon {
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    font-size: 1rem;
                    padding: var(--space-1);
                    border-radius: var(--radius-sm);
                    transition: background-color 0.2s;
                }

                .btn-icon:hover {
                    background-color: var(--bg-card);
                }

                .btn-icon.delete:hover {
                    background-color: #fee2e2;
                }

                .description {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    margin: 0 0 var(--space-4) 0;
                    line-height: 1.5;
                }

                .stats {
                    display: flex;
                    flex-wrap: wrap;
                    gap: var(--space-2);
                }

                .stat-pill {
                    background-color: var(--bg-card);
                    color: var(--text-primary);
                    padding: var(--space-1) var(--space-3);
                    border-radius: var(--radius-full);
                    font-size: 0.8rem;
                    font-weight: 500;
                }

                .empty-state {
                    grid-column: 1 / -1;
                    text-align: center;
                    padding: var(--space-8);
                    color: var(--text-secondary);
                    background-color: var(--bg-surface);
                    border-radius: var(--radius-lg);
                    border: 1px dashed var(--bg-card);
                }
            `}</style>
        </div>
    );
};

export default GoalList;
