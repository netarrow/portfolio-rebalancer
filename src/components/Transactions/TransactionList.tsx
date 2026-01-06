import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { Transaction, TransactionDirection } from '../../types';
import ImportTransactionsModal from './ImportTransactionsModal';
import './Transactions.css';

const TransactionList: React.FC = () => {
    const { transactions, assets, targets, deleteTransaction, updateTransaction, updateTransactionsBulk, refreshPrices, addTransaction, portfolios, brokers } = usePortfolio();
    const [updating, setUpdating] = useState(false);
    const [showImport, setShowImport] = useState(false);

    // View State
    const [groupBy, setGroupBy] = useState<'None' | 'Portfolio' | 'Broker'>('None');

    // Bulk Selection State
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    // Bulk Update State
    const [bulkPortfolioId, setBulkPortfolioId] = useState('');
    const [bulkBroker, setBulkBroker] = useState('');

    // Editing State (Single Row)
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editForm, setEditForm] = useState<Transaction | null>(null);

    const getAssetPrice = (ticker: string) => {
        const asset = assets.find(a => a.ticker === ticker);
        return asset?.currentPrice;
    };

    const getSourceUrl = (ticker: string) => {
        const target = targets.find(t => t.ticker === ticker);
        const source = target?.source || 'ETF';
        if (source === 'MOT') {
            return `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${ticker}.html?lang=it`;
        }
        return `https://www.justetf.com/en/etf-profile.html?isin=${ticker}`;
    };

    const handleRefresh = async () => {
        setUpdating(true);
        await refreshPrices();
        setUpdating(false);
    };

    // --- Bulk Selection Handlers ---
    const toggleSelectAll = (subsetTransactions: Transaction[] = transactions) => {
        const subsetIds = subsetTransactions.map(t => t.id);
        const allSubsetSelected = subsetIds.length > 0 && subsetIds.every(id => selectedIds.has(id));

        const newSet = new Set(selectedIds);
        if (allSubsetSelected) {
            subsetIds.forEach(id => newSet.delete(id));
        } else {
            subsetIds.forEach(id => newSet.add(id));
        }
        setSelectedIds(newSet);
    };

    const toggleSelectRow = (id: string) => {
        const newSet = new Set(selectedIds);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        setSelectedIds(newSet);
    };

    const handleBulkUpdate = () => {
        if (selectedIds.size === 0) return;
        const updates: Partial<Transaction> = {};
        if (bulkPortfolioId) updates.portfolioId = bulkPortfolioId;
        if (bulkBroker) updates.brokerId = bulkBroker;

        if (Object.keys(updates).length === 0) return;

        updateTransactionsBulk(Array.from(selectedIds), updates);
        setSelectedIds(new Set()); // Reset selection
        setBulkPortfolioId(''); // Reset input
        setBulkBroker('');
    };

    // --- Single Edit Handlers ---
    const startEditing = (tx: Transaction) => {
        setEditingId(tx.id);
        setEditForm({ ...tx });
    };

    const cancelEditing = () => {
        setEditingId(null);
        setEditForm(null);
    };

    const saveEditing = () => {
        if (editForm) {
            updateTransaction(editForm);
            setEditingId(null);
            setEditForm(null);
        }
    };

    const handleEditChange = (field: keyof Transaction, value: any) => {
        if (!editForm) return;
        setEditForm(prev => prev ? ({ ...prev, [field]: value }) : null);
    };

    const getAssetName = (ticker: string) => {
        const target = targets.find(t => t.ticker === ticker);
        return target?.label || '';
    };

    // Sort by date desc
    const sortedTransactions = [...transactions].sort((a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const getPortfolioName = (id?: string) => {
        if (!id) return 'Unassigned';
        const p = portfolios.find(p => p.id === id);
        return p ? p.name : 'Unassigned';
    };

    const getBrokerName = (id?: string, legacyName?: string) => {
        if (id) {
            const b = brokers.find(b => b.id === id);
            if (b) return b.name;
        }
        return legacyName || '-';
    };

    const groupedTransactions = sortedTransactions.reduce((acc, tx) => {
        let key = 'Unassigned';
        if (groupBy === 'Portfolio') {
            key = getPortfolioName(tx.portfolioId);
        } else if (groupBy === 'Broker') {
            key = getBrokerName(tx.brokerId, tx.broker) === '-' ? 'No Broker' : getBrokerName(tx.brokerId, tx.broker);
        }

        if (!acc[key]) acc[key] = [];
        acc[key].push(tx);
        return acc;
    }, {} as Record<string, Transaction[]>);

    const renderTable = (txs: Transaction[]) => (
        <table className="transaction-table">
            <thead>
                <tr>
                    <th style={{ width: '40px' }}>
                        <input
                            type="checkbox"
                            onChange={() => toggleSelectAll(txs)}
                            checked={txs.length > 0 && txs.every(t => selectedIds.has(t.id))}
                        />
                    </th>
                    <th>Date</th>
                    <th>Ticker</th>
                    <th>Side</th>
                    <th>Portfolio</th>
                    <th>Broker</th>
                    <th>Name</th>
                    <th>Qty</th>
                    <th>Price (Exec)</th>
                    <th>Price (Mkt)</th>
                    <th>Total</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
                {txs.map((tx) => {
                    const isEditing = editingId === tx.id;
                    const isSelected = selectedIds.has(tx.id);

                    if (isEditing && editForm) {
                        return (
                            <tr key={tx.id} className="editing-row">
                                <td></td>
                                <td>
                                    <input
                                        type="date"
                                        value={editForm.date}
                                        onChange={e => handleEditChange('date', e.target.value)}
                                        className="edit-input"
                                    />
                                </td>
                                <td>
                                    <input
                                        type="text"
                                        value={editForm.ticker}
                                        onChange={e => handleEditChange('ticker', e.target.value.toUpperCase())}
                                        className="edit-input"
                                        style={{ width: '80px' }}
                                    />
                                </td>
                                <td>
                                    <select
                                        value={editForm.direction}
                                        onChange={e => handleEditChange('direction', e.target.value as TransactionDirection)}
                                        className="edit-input"
                                    >
                                        <option value="Buy">Buy</option>
                                        <option value="Sell">Sell</option>
                                    </select>
                                </td>
                                <td>
                                    <input
                                        type="text"
                                        value={editForm.portfolio || ''}
                                        onChange={e => handleEditChange('portfolio', e.target.value)}
                                        className="edit-input"
                                        style={{ width: '80px' }}
                                        placeholder="Default"
                                    />
                                </td>
                                <td>
                                    <select
                                        value={editForm.brokerId || ''}
                                        onChange={e => handleEditChange('brokerId', e.target.value)}
                                        className="edit-input"
                                        style={{ width: '80px' }}
                                    >
                                        <option value="">-</option>
                                        {brokers.map(b => (
                                            <option key={b.id} value={b.id}>
                                                {b.name}
                                            </option>
                                        ))}
                                    </select>
                                </td>
                                <td>
                                    <span style={{ color: 'var(--text-secondary)' }}>-</span>
                                </td>
                                <td>
                                    <input
                                        type="number"
                                        value={editForm.amount}
                                        onChange={e => handleEditChange('amount', Number(e.target.value))}
                                        className="edit-input"
                                        style={{ width: '60px' }}
                                    />
                                </td>
                                <td>
                                    <input
                                        type="number"
                                        value={editForm.price}
                                        onChange={e => handleEditChange('price', Number(e.target.value))}
                                        className="edit-input"
                                        style={{ width: '80px' }}
                                    />
                                </td>
                                <td style={{ color: 'var(--text-muted)' }}>-</td>
                                <td>{(editForm.amount * editForm.price).toFixed(2)}</td>
                                <td>
                                    <div style={{ display: 'flex', gap: '5px' }}>
                                        <button className="btn-save" onClick={saveEditing}>Save</button>
                                        <button className="btn-cancel" onClick={cancelEditing}>X</button>
                                    </div>
                                </td>
                            </tr>
                        )
                    }

                    return (
                        <tr key={tx.id} style={isSelected ? { backgroundColor: 'var(--bg-app)' } : undefined}>
                            <td>
                                <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelectRow(tx.id)}
                                />
                            </td>
                            <td>{tx.date}</td>
                            <td style={{ fontWeight: 600 }}>{tx.ticker}</td>
                            <td>
                                <span style={{
                                    color: tx.direction === 'Sell' ? 'var(--color-danger)' : 'var(--color-success)',
                                    fontWeight: 600
                                }}>
                                    {tx.direction || 'Buy'}
                                </span>
                            </td>
                            <td style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                {getPortfolioName(tx.portfolioId) === 'Unassigned' ? '-' : getPortfolioName(tx.portfolioId)}
                            </td>
                            <td style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                {getBrokerName(tx.brokerId, tx.broker)}
                            </td>
                            <td style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                {getAssetName(tx.ticker) || '-'}
                            </td>
                            <td>{tx.amount}</td>
                            <td>{tx.price.toFixed(2)}</td>
                            <td style={{ color: 'var(--text-muted)' }}>
                                <a
                                    href={getSourceUrl(tx.ticker)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}
                                >
                                    {getAssetPrice(tx.ticker)?.toFixed(2) || '-'}
                                </a>
                            </td>
                            <td>
                                {((tx.price || 0) * tx.amount).toFixed(2)}
                            </td>
                            <td>
                                <div style={{ display: 'flex', gap: '5px' }}>
                                    <button
                                        className="btn-edit"
                                        onClick={() => startEditing(tx)}
                                    >
                                        Edit
                                    </button>
                                    <button
                                        className="btn-delete"
                                        onClick={() => deleteTransaction(tx.id)}
                                    >
                                        Del
                                    </button>
                                </div>
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );

    return (
        <div className="transaction-list-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
                <h2>History</h2>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    <button
                        onClick={() => {
                            if (groupBy === 'None') setGroupBy('Portfolio');
                            else if (groupBy === 'Portfolio') setGroupBy('Broker');
                            else setGroupBy('None');
                        }}
                        className="btn-secondary"
                        style={{
                            fontSize: '0.9rem',
                            padding: '0.4rem 0.8rem',
                            backgroundColor: groupBy !== 'None' ? 'var(--border-color)' : undefined
                        }}
                    >
                        Group By: {groupBy}
                    </button>
                    <button
                        onClick={() => setShowImport(true)}
                        className="btn-secondary"
                        style={{ fontSize: '0.9rem', padding: '0.4rem 0.8rem' }}
                    >
                        Import Excel
                    </button>
                    <button
                        onClick={handleRefresh}
                        disabled={updating}
                        className="btn-primary"
                        style={{ fontSize: '0.9rem', padding: '0.4rem 0.8rem' }}
                    >
                        {updating ? 'Updating...' : 'Update Prices'}
                    </button>
                </div>
            </div>

            {/* Bulk Action Bar - Sticky when items selected */}
            {selectedIds.size > 0 && (
                <div style={{
                    position: 'sticky',
                    top: '1rem',
                    zIndex: 10,
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--color-primary)',
                    borderRadius: 'var(--radius-md)',
                    padding: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '1rem',
                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
                }}>
                    <span style={{ fontWeight: 600, color: 'var(--color-primary)' }}>
                        {selectedIds.size} selected
                    </span>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <select
                            value={bulkPortfolioId}
                            onChange={e => setBulkPortfolioId(e.target.value)}
                            className="form-input"
                            style={{ margin: 0, padding: '0.4rem', fontSize: '0.9rem', width: '200px' }}
                        >
                            <option value="">Select Portfolio...</option>
                            {portfolios.map(p => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                        <select
                            value={bulkBroker}
                            onChange={e => setBulkBroker(e.target.value)}
                            className="form-input"
                            style={{ margin: 0, padding: '0.4rem', fontSize: '0.9rem', width: '150px' }}
                        >
                            <option value="">Set Broker...</option>
                            {brokers.map(b => (
                                <option key={b.id} value={b.id}>
                                    {b.name}
                                </option>
                            ))}
                        </select>
                        <button
                            className="btn-primary"
                            onClick={handleBulkUpdate}
                            style={{ padding: '0.4rem 0.8rem', fontSize: '0.9rem' }}
                        >
                            Update
                        </button>
                        <button
                            className="btn-secondary"
                            onClick={() => setSelectedIds(new Set())}
                            style={{ padding: '0.4rem 0.8rem', fontSize: '0.9rem' }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {transactions.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>No transactions yet.</p>
            ) : (
                <>
                    {groupBy !== 'None' ? (
                        Object.keys(groupedTransactions).sort().map((groupKey) => (
                            <div key={groupKey} style={{ marginBottom: '2rem' }}>
                                <h3 style={{
                                    padding: '0.5rem 0',
                                    borderBottom: '2px solid var(--border-color)',
                                    marginBottom: '1rem',
                                    color: 'var(--color-primary)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between'
                                }}>
                                    <span>{groupKey}</span>
                                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 'normal' }}>
                                        {groupedTransactions[groupKey].length} transactions
                                    </span>
                                </h3>
                                {renderTable(groupedTransactions[groupKey])}
                            </div>
                        ))
                    ) : (
                        renderTable(sortedTransactions)
                    )}
                </>
            )}

            {showImport && (
                <ImportTransactionsModal
                    onClose={() => setShowImport(false)}
                    onImport={(newTransactions) => {
                        newTransactions.forEach(addTransaction);
                    }}
                />
            )}
        </div>
    );
};

export default TransactionList;
