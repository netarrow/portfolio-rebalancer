import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { Transaction, AssetClass, AssetSubClass, TransactionDirection } from '../../types';
import ImportTransactionsModal from './ImportTransactionsModal';
import './Transactions.css';

const TransactionList: React.FC = () => {
    const { transactions, assets, targets, deleteTransaction, updateTransaction, refreshPrices, addTransaction } = usePortfolio();
    const [updating, setUpdating] = useState(false);
    const [showImport, setShowImport] = useState(false);

    // Editing State
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

    // Helper for Class/Subclass change in edit mode
    const handleEditClassChange = (newClass: AssetClass) => {
        if (!editForm) return;
        let defaultSub: AssetSubClass = 'International';
        if (newClass === 'Bond') defaultSub = 'Medium';
        if (newClass === 'Commodity') defaultSub = 'Gold';
        if (newClass === 'Crypto') defaultSub = '';

        setEditForm(prev => prev ? ({ ...prev, assetClass: newClass, assetSubClass: defaultSub }) : null);
    };

    // Sort by date desc
    const sortedTransactions = [...transactions].sort((a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return (
        <div className="transaction-list-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
                <h2>History</h2>
                <div style={{ display: 'flex', gap: '1rem' }}>
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
            {transactions.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>No transactions yet.</p>
            ) : (
                <table className="transaction-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Ticker</th>
                            <th>Side</th>
                            <th>Class</th>
                            <th>Subclass</th>
                            <th>Qty</th>
                            <th>Price (Exec)</th>
                            <th>Price (Mkt)</th>
                            <th>Total</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sortedTransactions.map((tx) => {
                            const isEditing = editingId === tx.id;

                            if (isEditing && editForm) {
                                return (
                                    <tr key={tx.id} className="editing-row">
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
                                            <select
                                                value={editForm.assetClass}
                                                onChange={e => handleEditClassChange(e.target.value as AssetClass)}
                                                className="edit-input"
                                            >
                                                <option value="Stock">Stock</option>
                                                <option value="Bond">Bond</option>
                                                <option value="Commodity">Comp</option>
                                                <option value="Crypto">Crypto</option>
                                            </select>
                                        </td>
                                        <td>
                                            {editForm.assetClass !== 'Crypto' && (
                                                <select
                                                    value={editForm.assetSubClass}
                                                    onChange={e => handleEditChange('assetSubClass', e.target.value as AssetSubClass)}
                                                    className="edit-input"
                                                >
                                                    {editForm.assetClass === 'Stock' && (
                                                        <>
                                                            <option value="International">Intl</option>
                                                            <option value="Local">Local</option>
                                                        </>
                                                    )}
                                                    {editForm.assetClass === 'Bond' && (
                                                        <>
                                                            <option value="Short">Short</option>
                                                            <option value="Medium">Medium</option>
                                                            <option value="Long">Long</option>
                                                        </>
                                                    )}
                                                    {editForm.assetClass === 'Commodity' && <option value="Gold">Gold</option>}
                                                </select>
                                            )}
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
                                <tr key={tx.id}>
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
                                    <td>
                                        <span className={`type-badge type-${(tx.assetClass || 'stock').toLowerCase()}`}>
                                            {tx.assetClass}
                                        </span>
                                    </td>
                                    <td style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                        {tx.assetSubClass || '-'}
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
                                        {((getAssetPrice(tx.ticker) || 0) * tx.amount).toFixed(2)}
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
