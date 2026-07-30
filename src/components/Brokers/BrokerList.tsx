import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import BrokerForm from './BrokerForm';
import BrokerLiquiditySyncModal from './BrokerLiquiditySyncModal';
import type { Broker, BrokerLiquiditySyncRow } from '../../types';
import Swal from 'sweetalert2';

const BrokerList: React.FC = () => {
    const {
        brokers, portfolios, people, addBroker, updateBroker, deleteBroker,
        ynabConfig, ynabAccountMappings, prepareBrokerLiquiditySync, applyBrokerLiquiditySync, brokerLiquiditySyncing,
    } = usePortfolio();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingBroker, setEditingBroker] = useState<Broker | null>(null);
    const [syncRows, setSyncRows] = useState<BrokerLiquiditySyncRow[] | null>(null);

    const personById = new Map(people.map(p => [p.id, p]));
    const canSyncLiquidity = !!ynabConfig && Object.keys(ynabAccountMappings).length > 0;

    // Name the budget on the badge: mappings can point at budgets other than the
    // one the rest of the YNAB integration reads from.
    const ynabBadgeTitle = (brokerId: string): string => {
        const mapping = ynabAccountMappings[brokerId];
        if (!mapping) return 'Liquidity can be updated from the mapped YNAB account';
        const budgetName = ynabConfig?.budgets?.find(b => b.id === mapping.budgetId)?.name
            ?? (mapping.budgetId === ynabConfig?.budgetId ? ynabConfig?.budgetName : undefined);
        return budgetName
            ? `Liquidity can be updated from the mapped YNAB account (budget: ${budgetName})`
            : 'Liquidity can be updated from the mapped YNAB account';
    };

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
        Swal.fire({
            title: 'Are you sure?',
            text: `Are you sure you want to delete broker "${name}"?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            cancelButtonColor: '#3085d6',
            confirmButtonText: 'Yes, delete it!'
        }).then((result) => {
            if (result.isConfirmed) {
                deleteBroker(id);
                Swal.fire(
                    'Deleted!',
                    'Your broker has been deleted.',
                    'success'
                );
            }
        });
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

    const handleOpenLiquiditySync = async () => {
        const res = await prepareBrokerLiquiditySync();
        if (!res.ok || !res.rows) {
            Swal.fire({ title: 'Unable to read YNAB', text: res.error, icon: 'error' });
            return;
        }
        setSyncRows(res.rows);
    };

    const handleConfirmLiquiditySync = (rows: BrokerLiquiditySyncRow[]) => {
        const res = applyBrokerLiquiditySync(rows);
        setSyncRows(null);
        Swal.fire({
            title: 'Liquidity updated',
            text: `${res.updated} broker${res.updated === 1 ? '' : 's'} updated from YNAB.`,
            icon: 'success',
            timer: 2000,
            showConfirmButton: false,
        });
    };

    return (
        <div className="broker-list-container">
            <div className="header-actions">
                <h2>Your Brokers</h2>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {canSyncLiquidity && (
                        <button
                            className="btn btn-secondary"
                            onClick={handleOpenLiquiditySync}
                            disabled={brokerLiquiditySyncing}
                            title="Read the mapped YNAB accounts and update each broker's liquidity"
                        >
                            {brokerLiquiditySyncing ? 'Reading YNAB…' : '🔄 Update liquidity from YNAB'}
                        </button>
                    )}
                    <button className="btn btn-primary" onClick={openCreateModal}>
                        + New Broker
                    </button>
                </div>
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
                                {(broker.familyAsset || broker.illiquid || broker.ownerId || ynabAccountMappings[broker.id]) && (
                                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                                        {!broker.familyAsset && broker.ownerId && personById.has(broker.ownerId) && (
                                            <span title="Personal asset — views can filter by person" style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '10px', background: '#0EA5E920', color: '#0EA5E9', border: '1px solid #0EA5E950' }}>
                                                👤 {personById.get(broker.ownerId)!.name}
                                            </span>
                                        )}
                                        {ynabAccountMappings[broker.id] && (
                                            <span title={ynabBadgeTitle(broker.id)} style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '10px', background: '#10B98120', color: '#10B981', border: '1px solid #10B98150' }}>
                                                🔗 YNAB
                                            </span>
                                        )}
                                        {broker.familyAsset && (
                                            <span title="Family asset — views can include/exclude it from totals" style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '10px', background: '#8B5CF620', color: '#8B5CF6', border: '1px solid #8B5CF650' }}>
                                                👪 Family
                                            </span>
                                        )}
                                        {broker.illiquid && (
                                            <span title="Illiquid — views can include/exclude it from totals" style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '10px', background: '#F59E0B20', color: '#F59E0B', border: '1px solid #F59E0B50' }}>
                                                🔒 Illiquid
                                            </span>
                                        )}
                                    </div>
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
                    portfolios={portfolios}
                    people={people}
                    onSubmit={editingBroker ? handleUpdate : handleCreate}
                    onCancel={closeModal}
                />
            )}

            {syncRows !== null && (
                <BrokerLiquiditySyncModal
                    rows={syncRows}
                    currencyIso={ynabConfig?.currencyIso || 'EUR'}
                    onConfirm={handleConfirmLiquiditySync}
                    onCancel={() => setSyncRows(null)}
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
