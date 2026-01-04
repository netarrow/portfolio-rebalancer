import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import PortfolioForm from './PortfolioForm';
import type { Portfolio } from '../../types';

const PortfolioList: React.FC = () => {
    const { portfolios, addPortfolio, updatePortfolio, deletePortfolio, transactions } = usePortfolio();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingPortfolio, setEditingPortfolio] = useState<Portfolio | null>(null);

    const handleCreate = (data: Omit<Portfolio, 'id'>) => {
        addPortfolio({
            ...data,
            id: String(Date.now())
        });
        setIsModalOpen(false);
    };

    const handleUpdate = (data: Omit<Portfolio, 'id'>) => {
        if (editingPortfolio) {
            updatePortfolio({
                ...editingPortfolio,
                ...data
            });
            setEditingPortfolio(null);
            setIsModalOpen(false);
        }
    };

    const handleDelete = (id: string, name: string) => {
        const confirmMsg = `Are you sure you want to delete portfolio "${name}"? Transactions associated with this portfolio will be unlinked.`;
        if (window.confirm(confirmMsg)) {
            deletePortfolio(id);
        }
    };

    const openCreateModal = () => {
        setEditingPortfolio(null);
        setIsModalOpen(true);
    };

    const openEditModal = (portfolio: Portfolio) => {
        setEditingPortfolio(portfolio);
        setIsModalOpen(true);
    };

    const closeModal = () => {
        setEditingPortfolio(null);
        setIsModalOpen(false);
    };

    const getTransactionCount = (portfolioId: string) => {
        return transactions.filter(t => t.portfolioId === portfolioId).length;
    };

    return (
        <div className="portfolio-list-container">
            <div className="header-actions">
                <h2>Your Portfolios</h2>
                <button className="btn btn-primary" onClick={openCreateModal}>
                    + New Portfolio
                </button>
            </div>

            <div className="portfolio-grid">
                {portfolios.length === 0 ? (
                    <div className="empty-state">
                        <p>No portfolios created yet. Create one to organize your transactions.</p>
                    </div>
                ) : (
                    portfolios.map(portfolio => (
                        <div key={portfolio.id} className="portfolio-card">
                            <div className="card-header">
                                <h3>{portfolio.name}</h3>
                                <div className="card-actions">
                                    <button
                                        className="btn-icon"
                                        onClick={() => openEditModal(portfolio)}
                                        title="Edit"
                                        aria-label="Edit portfolio"
                                    >
                                        ✏️
                                    </button>
                                    <button
                                        className="btn-icon delete"
                                        onClick={() => handleDelete(portfolio.id, portfolio.name)}
                                        title="Delete"
                                        aria-label="Delete portfolio"
                                    >
                                        🗑️
                                    </button>
                                </div>
                            </div>
                            <div className="card-body">
                                {portfolio.description && (
                                    <p className="description">{portfolio.description}</p>
                                )}
                                <div className="stats">
                                    <span className="stat-pill">
                                        {getTransactionCount(portfolio.id)} Transactions
                                    </span>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {isModalOpen && (
                <PortfolioForm
                    initialData={editingPortfolio}
                    onSubmit={editingPortfolio ? handleUpdate : handleCreate}
                    onCancel={closeModal}
                />
            )}

            <style>{`
                .portfolio-list-container {
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

                .portfolio-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                    gap: var(--space-6);
                }

                .portfolio-card {
                    background-color: var(--bg-surface);
                    border: 1px solid var(--bg-card);
                    border-radius: var(--radius-lg);
                    padding: var(--space-5);
                    transition: transform 0.2s, box-shadow 0.2s;
                }

                .portfolio-card:hover {
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

export default PortfolioList;
