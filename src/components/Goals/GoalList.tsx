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
        <div className="portfolio-list-container">
            <div className="header-actions">
                <h2>Goals</h2>
                <button className="btn btn-primary" onClick={openCreateModal}>
                    + New Goal
                </button>
            </div>

            <div className="portfolio-grid">
                {sortedGoals.length === 0 ? (
                    <div className="empty-state">
                        <p>No goals created yet. Create goals to categorize your portfolios.</p>
                    </div>
                ) : (
                    sortedGoals.map(goal => {
                        const linked = getLinkedPortfolios(goal.id);
                        return (
                            <div key={goal.id} className="portfolio-card">
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
                .stats {
                    display: flex;
                    flex-wrap: wrap;
                    gap: var(--space-2);
                }
            `}</style>
        </div>
    );
};

export default GoalList;
