import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import BrokerForm from './BrokerForm';
import type { Broker } from '../../types';

const BrokerList: React.FC = () => {
    const { brokers, addBroker, updateBroker, deleteBroker } = usePortfolio();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingBroker, setEditingBroker] = useState<Broker | null>(null);

    const handleCreate = (data: Omit<Broker, 'id'>) => {
        addBroker({
            ...data,
            id: String(Date.now())
        });
        setIsModalOpen(false);
    };

    const handleUpdate = (data: Omit<Broker, 'id'>) => {
        if (editingBroker) {
            updateBroker({
                ...editingBroker,
                ...data
            });
            setEditingBroker(null);
            setIsModalOpen(false);
        }
    };

    const handleDelete = (id: string, name: string) => {
        const confirmMsg = `Are you sure you want to delete broker "${name}"?`;
        if (window.confirm(confirmMsg)) {
            deleteBroker(id);
        }
    };

    const openCreateModal = () => {
        setEditingBroker(null);
        setIsModalOpen(true);
    };

    const openEditModal = (broker: Broker) => {
        setEditingBroker(broker);
        setIsModalOpen(true);
    };

    const closeModal = () => {
        setEditingBroker(null);
        setIsModalOpen(false);
    };

    return (
        <div className="broker-list-container">
            <div className="header-actions">
                <h2>Your Brokers</h2>
                <button className="btn btn-primary" onClick={openCreateModal}>
                    + New Broker
                </button>
            </div>

            <div className="broker-grid">
                {brokers.length === 0 ? (
                    <div className="empty-state">
                        <p>No brokers added yet. Add one to track your liquidity sources.</p>
                    </div>
                ) : (
                    brokers.map(broker => (
                        <div key={broker.id} className="broker-card">
                            <div className="card-header">
                                <h3>{broker.name}</h3>
                                <div className="card-actions">
                                    <button
                                        className="btn-icon"
                                        onClick={() => openEditModal(broker)}
                                        title="Edit"
                                        aria-label="Edit broker"
                                    >
                                        ✏️
                                    </button>
                                    <button
                                        className="btn-icon delete"
                                        onClick={() => handleDelete(broker.id, broker.name)}
                                        title="Delete"
                                        aria-label="Delete broker"
                                    >
                                        🗑️
                                    </button>
                                </div>
                            </div>
                            <div className="card-body">
                                {broker.description && (
                                    <p className="description">{broker.description}</p>
                                )}
                                <div className="stats-grid">
                                    <div className="stat">
                                        <span className="stat-label">Liquidity</span>
                                        <span className="stat-value">€{broker.currentLiquidity?.toLocaleString()}</span>
                                    </div>
                                    <div className="stat">
                                        <span className="stat-label">
                                            {broker.minLiquidityType === 'fixed' ? 'Min Amount' : 'Min %'}
                                        </span>
                                        <span className="stat-value">
                                            {broker.minLiquidityType === 'fixed'
                                                ? `€${broker.minLiquidityAmount?.toLocaleString() || 0}`
                                                : `${broker.minLiquidityPercentage || 0}%`
                                            }
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>

            {isModalOpen && (
                <BrokerForm
                    initialData={editingBroker}
                    onSubmit={editingBroker ? handleUpdate : handleCreate}
                    onCancel={closeModal}
                />
            )}

            <style>{`
                .broker-list-container {
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

                .broker-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                    gap: var(--space-6);
                }

                .broker-card {
                    background-color: var(--bg-surface);
                    border: 1px solid var(--bg-card);
                    border-radius: var(--radius-lg);
                    padding: var(--space-5);
                    transition: transform 0.2s, box-shadow 0.2s;
                }

                .broker-card:hover {
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

                .stats-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: var(--space-4);
                    margin-top: var(--space-2);
                }
                
                .stat {
                    display: flex;
                    flex-direction: column;
                }
                
                .stat-label {
                    font-size: 0.75rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    color: var(--text-secondary);
                    margin-bottom: var(--space-1);
                }
                
                .stat-value {
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: var(--text-primary);
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

export default BrokerList;
