import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { Transaction, TransactionDirection } from '../../types';
import { isIncomeDirection } from '../../types';
import { calculateCommission, calculateRealizedGains, calculateCashFlows } from '../../utils/portfolioCalculations';
import ImportTransactionsModal from './ImportTransactionsModal';
import './Transactions.css';

const TransactionList: React.FC = () => {
    const { transactions, assets, targets, deleteTransaction, updateTransaction, updateTransactionsBulk, refreshPrices, addTransaction, portfolios, brokers, updateMarketData } = usePortfolio();
    const [updating, setUpdating] = useState(false);
    const [showImport, setShowImport] = useState(false);

    // View State
    const [groupBy, setGroupBy] = useState<'None' | 'Portfolio' | 'Broker' | 'Ticker'>('None');
    const [showMetricsAsPercentage, setShowMetricsAsPercentage] = useState(false);

    // Bulk Selection State
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    // Bulk Update State
    const [bulkPortfolioId, setBulkPortfolioId] = useState('');
    const [bulkBroker, setBulkBroker] = useState('');
    const [bulkFreeCommission, setBulkFreeCommission] = useState<'' | 'free' | 'paid'>('');

    // Editing State (Single Row)
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editForm, setEditForm] = useState<Transaction | null>(null);
    const [editMarketPrice, setEditMarketPrice] = useState<number | undefined>(undefined);
    const [editAmountStr, setEditAmountStr] = useState<string>('');
    const [editPriceStr, setEditPriceStr] = useState<string>('');

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
        if (bulkFreeCommission === 'free') updates.freeCommission = true;
        else if (bulkFreeCommission === 'paid') updates.freeCommission = undefined;

        if (Object.keys(updates).length === 0) return;

        updateTransactionsBulk(Array.from(selectedIds), updates);
        setSelectedIds(new Set());
        setBulkPortfolioId('');
        setBulkBroker('');
        setBulkFreeCommission('');
    };

    // --- Single Edit Handlers ---
    const startEditing = (tx: Transaction) => {
        setEditingId(tx.id);
        setEditForm({ ...tx });
        setEditMarketPrice(getAssetPrice(tx.ticker));
        setEditAmountStr(String(tx.amount));
        setEditPriceStr(String(tx.price));
    };

    const cancelEditing = () => {
        setEditingId(null);
        setEditForm(null);
        setEditMarketPrice(undefined);
        setEditAmountStr('');
        setEditPriceStr('');
    };

    const saveEditing = () => {
        if (editForm) {
            const parsedAmount = parseFloat(editAmountStr.replace(',', '.'));
            const parsedPrice = parseFloat(editPriceStr.replace(',', '.'));
            const formToSave = {
                ...editForm,
                amount: isNaN(parsedAmount) ? editForm.amount : parsedAmount,
                price: isNaN(parsedPrice) ? editForm.price : parsedPrice,
            };
            updateTransaction(formToSave);

            // Allow manual overwrite of market price
            if (editMarketPrice !== undefined && !isNaN(editMarketPrice) && editMarketPrice > 0) {
                // We don't have lastUpdated here, so we use current time.
                updateMarketData(editForm.ticker, editMarketPrice, new Date().toISOString());
            }

            setEditingId(null);
            setEditForm(null);
            setEditMarketPrice(undefined);
            setEditAmountStr('');
            setEditPriceStr('');
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

    const getBrokerName = (id?: string) => {
        if (id) {
            const b = brokers.find(b => b.id === id);
            if (b) return b.name;
        }
        return '-';
    };

    const groupedTransactions = sortedTransactions.reduce((acc, tx) => {
        let key = 'Unassigned';
        if (groupBy === 'Portfolio') {
            key = getPortfolioName(tx.portfolioId);
        } else if (groupBy === 'Broker') {
            key = getBrokerName(tx.brokerId) === '-' ? 'No Broker' : getBrokerName(tx.brokerId);
        } else if (groupBy === 'Ticker') {
            key = tx.ticker.toUpperCase();
        }

        if (!acc[key]) acc[key] = [];
        acc[key].push(tx);
        return acc;
    }, {} as Record<string, Transaction[]>);

    const getGroupStats = (txs: Transaction[]) => {
        const boughtQty = txs.filter(t => t.direction === 'Buy').reduce((s, t) => s + Number(t.amount), 0);
        const soldQty = txs.filter(t => t.direction === 'Sell').reduce((s, t) => s + Number(t.amount), 0);
        const realized = calculateRealizedGains(txs, brokers, targets).totalRealized;
        const { totalIncome: distributions } = calculateCashFlows(txs);
        const distinctTickers = [...new Set(txs.map(t => t.ticker.toUpperCase()))];
        const unrealizedPnl = distinctTickers.reduce((sum, ticker) => {
            return sum + (assets.find(a => a.ticker === ticker)?.gain ?? 0);
        }, 0);
        const costBasisValue = distinctTickers.reduce((sum, ticker) => {
            const asset = assets.find(a => a.ticker === ticker);
            if (asset) {
                return sum + (asset.quantity * asset.averagePrice);
            }
            return sum;
        }, 0);
        const costBasisTotal = txs.filter(t => t.direction === 'Buy').reduce((sum, t) => sum + (t.price * t.amount), 0);
        const currentMarketValue = distinctTickers.reduce((sum, ticker) => {
            const asset = assets.find(a => a.ticker === ticker);
            if (asset) {
                return sum + (asset.currentValue ?? 0);
            }
            return sum;
        }, 0);
        const totalFees = txs.reduce((sum, tx) => {
            if (tx.freeCommission) return sum;
            const fee = calculateCommission(tx, brokers.find(b => b.id === tx.brokerId));
            return sum + (fee ?? 0);
        }, 0);
        const totalReturn = unrealizedPnl + realized + distributions;
        return { boughtQty, soldQty, realized, unrealizedPnl, costBasisValue, costBasisTotal, currentMarketValue, distributions, totalReturn, totalFees };
    };

    const fmtQty = (n: number) => n.toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
    const fmtEur = (n: number) => {
        const sign = n > 0 ? '+' : '';
        return `${sign}€${n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };
    const fmtPercentage = (value: number, basis: number) => {
        if (basis === 0) return '+0.00%';
        const perc = (value / basis) * 100;
        const sign = perc > 0 ? '+' : '';
        return `${sign}${perc.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
    };

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
                    <th>Est. Fee</th>
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
                                        <option value="Dividend">Dividend</option>
                                        <option value="Coupon">Coupon</option>
                                    </select>
                                </td>
                                <td>
                                    <select
                                        value={editForm.portfolioId || ''}
                                        onChange={e => handleEditChange('portfolioId', e.target.value)}
                                        className="edit-input"
                                        style={{ width: '80px' }}
                                    >
                                        <option value="">-</option>
                                        {portfolios.map(p => (
                                            <option key={p.id} value={p.id}>
                                                {p.name}
                                            </option>
                                        ))}
                                    </select>
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
                                        type="text"
                                        inputMode="decimal"
                                        value={editAmountStr}
                                        onChange={e => setEditAmountStr(e.target.value)}
                                        className="edit-input"
                                        style={{ width: '60px' }}
                                    />
                                </td>
                                <td>
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        value={editPriceStr}
                                        onChange={e => setEditPriceStr(e.target.value)}
                                        className="edit-input"
                                        style={{ width: '80px' }}
                                    />
                                </td>
                                <td style={{ color: 'var(--text-muted)' }}>
                                    <input
                                        type="number"
                                        placeholder="Mkt Px"
                                        value={editMarketPrice !== undefined ? editMarketPrice : ''}
                                        onChange={e => setEditMarketPrice(e.target.value === '' ? undefined : parseFloat(e.target.value))}
                                        className="edit-input"
                                        style={{ width: '80px', borderColor: 'var(--color-primary)' }}
                                    />
                                </td>
                                <td>{(editForm.amount * editForm.price).toFixed(2)}</td>
                                <td>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                        <input
                                            type="checkbox"
                                            checked={!!editForm.freeCommission}
                                            onChange={e => handleEditChange('freeCommission', e.target.checked || undefined)}
                                            style={{ accentColor: 'var(--color-success)', cursor: 'pointer' }}
                                        />
                                        <span style={{ fontSize: '0.8rem', color: 'var(--color-success)' }}>Free</span>
                                    </label>
                                </td>
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
                                    color: tx.direction === 'Sell' ? 'var(--color-danger)'
                                        : tx.direction === 'Dividend' ? '#3B82F6'
                                        : tx.direction === 'Coupon' ? '#8B5CF6'
                                        : 'var(--color-success)',
                                    fontWeight: 600
                                }}>
                                    {tx.direction || 'Buy'}
                                </span>
                            </td>
                            <td style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                {getPortfolioName(tx.portfolioId) === 'Unassigned' ? '-' : getPortfolioName(tx.portfolioId)}
                            </td>
                            <td style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                                {getBrokerName(tx.brokerId)}
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
                            <td style={{ fontSize: '0.85rem' }}>
                                {(() => {
                                    if (isIncomeDirection(tx.direction)) {
                                        return <span style={{ color: 'var(--text-muted)' }}>-</span>;
                                    }
                                    if (tx.freeCommission) {
                                        return (
                                            <span style={{ color: 'var(--color-success)' }}>
                                                €0.00
                                            </span>
                                        );
                                    }
                                    const broker = brokers.find(b => b.id === tx.brokerId);
                                    const fee = calculateCommission(tx, broker);
                                    if (fee === undefined) return <span style={{ color: 'var(--text-muted)' }}>-</span>;
                                    return (
                                        <span style={{ color: 'var(--color-danger)' }}>
                                            €{fee.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </span>
                                    );
                                })()}
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

    const renderMobileList = (txs: Transaction[]) => (
        <div className="mobile-list-view">
            {txs.map((tx) => {
                const isEditing = editingId === tx.id;

                if (isEditing && editForm) {
                    return (
                        <div key={tx.id} className="mobile-transaction-card mobile-editing-card">
                            <div className="mobile-card-header">
                                <div className="mobile-card-ticker">{editForm.ticker}</div>
                                <div className="mobile-card-date" style={{ color: 'var(--color-primary)', fontSize: '0.75rem' }}>Editing</div>
                            </div>
                            <div className="mobile-edit-form">
                                <div className="mobile-edit-field mobile-edit-field--full">
                                    <label className="detail-label">Date</label>
                                    <input
                                        type="date"
                                        value={editForm.date}
                                        onChange={e => handleEditChange('date', e.target.value)}
                                        className="edit-input"
                                    />
                                </div>
                                <div className="mobile-edit-field">
                                    <label className="detail-label">Ticker</label>
                                    <input
                                        type="text"
                                        value={editForm.ticker}
                                        onChange={e => handleEditChange('ticker', e.target.value.toUpperCase())}
                                        className="edit-input"
                                    />
                                </div>
                                <div className="mobile-edit-field">
                                    <label className="detail-label">Side</label>
                                    <select
                                        value={editForm.direction}
                                        onChange={e => handleEditChange('direction', e.target.value as TransactionDirection)}
                                        className="edit-input"
                                    >
                                        <option value="Buy">Buy</option>
                                        <option value="Sell">Sell</option>
                                        <option value="Dividend">Dividend</option>
                                        <option value="Coupon">Coupon</option>
                                    </select>
                                </div>
                                <div className="mobile-edit-field">
                                    <label className="detail-label">Portfolio</label>
                                    <select
                                        value={editForm.portfolioId || ''}
                                        onChange={e => handleEditChange('portfolioId', e.target.value)}
                                        className="edit-input"
                                    >
                                        <option value="">-</option>
                                        {portfolios.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="mobile-edit-field">
                                    <label className="detail-label">Broker</label>
                                    <select
                                        value={editForm.brokerId || ''}
                                        onChange={e => handleEditChange('brokerId', e.target.value)}
                                        className="edit-input"
                                    >
                                        <option value="">-</option>
                                        {brokers.map(b => (
                                            <option key={b.id} value={b.id}>{b.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="mobile-edit-field">
                                    <label className="detail-label">Qty</label>
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        value={editAmountStr}
                                        onChange={e => setEditAmountStr(e.target.value)}
                                        className="edit-input"
                                    />
                                </div>
                                <div className="mobile-edit-field">
                                    <label className="detail-label">Price (Exec)</label>
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        value={editPriceStr}
                                        onChange={e => setEditPriceStr(e.target.value)}
                                        className="edit-input"
                                    />
                                </div>
                                <div className="mobile-edit-field">
                                    <label className="detail-label">Price (Mkt)</label>
                                    <input
                                        type="number"
                                        placeholder="Mkt Px"
                                        value={editMarketPrice !== undefined ? editMarketPrice : ''}
                                        onChange={e => setEditMarketPrice(e.target.value === '' ? undefined : parseFloat(e.target.value))}
                                        className="edit-input"
                                        style={{ borderColor: 'var(--color-primary)' }}
                                    />
                                </div>
                                <div className="mobile-edit-field mobile-edit-field--full">
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={!!editForm.freeCommission}
                                            onChange={e => handleEditChange('freeCommission', e.target.checked || undefined)}
                                            style={{ width: '18px', height: '18px', accentColor: 'var(--color-success)', cursor: 'pointer' }}
                                        />
                                        <span className="detail-label" style={{ color: 'var(--color-success)' }}>Free commission (no fee)</span>
                                    </label>
                                </div>
                            </div>
                            <div className="mobile-card-actions">
                                <button className="btn-save" onClick={saveEditing} style={{ padding: '6px 20px', fontSize: '0.9rem' }}>Save</button>
                                <button className="btn-cancel" onClick={cancelEditing} style={{ padding: '6px 20px', fontSize: '0.9rem' }}>Cancel</button>
                            </div>
                        </div>
                    );
                }

                return (
                    <div key={tx.id} className="mobile-transaction-card">
                        <div className="mobile-card-header">
                            <div className="mobile-card-ticker">{tx.ticker}</div>
                            <div className="mobile-card-date">{tx.date}</div>
                        </div>
                        <div className="mobile-card-details">
                            <div className="detail-row">
                                <span className="detail-label">Side</span>
                                <span className="detail-value" style={{
                                    color: tx.direction === 'Sell' ? 'var(--color-danger)'
                                        : tx.direction === 'Dividend' ? '#3B82F6'
                                        : tx.direction === 'Coupon' ? '#8B5CF6'
                                        : 'var(--color-success)',
                                    fontWeight: 600
                                }}>
                                    {tx.direction || 'Buy'}
                                </span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Portfolio</span>
                                <span className="detail-value">{getPortfolioName(tx.portfolioId) === 'Unassigned' ? '-' : getPortfolioName(tx.portfolioId)}</span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Broker</span>
                                <span className="detail-value">{getBrokerName(tx.brokerId)}</span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Total</span>
                                <span className="detail-value">{((tx.price || 0) * tx.amount).toFixed(2)}</span>
                            </div>
                            {(() => {
                                if (isIncomeDirection(tx.direction)) return null;
                                if (tx.freeCommission) {
                                    return (
                                        <div className="detail-row">
                                            <span className="detail-label">Est. Fee</span>
                                            <span className="detail-value" style={{ color: 'var(--color-success)' }}>€0.00</span>
                                        </div>
                                    );
                                }
                                const broker = brokers.find(b => b.id === tx.brokerId);
                                const fee = calculateCommission(tx, broker);
                                if (fee === undefined) return null;
                                return (
                                    <div className="detail-row">
                                        <span className="detail-label">Est. Fee</span>
                                        <span className="detail-value" style={{ color: 'var(--color-danger)' }}>
                                            €{fee.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </span>
                                    </div>
                                );
                            })()}
                            <div className="detail-row">
                                <span className="detail-label">Qty</span>
                                <span className="detail-value">{tx.amount}</span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Price</span>
                                <span className="detail-value">{tx.price.toFixed(2)}</span>
                            </div>
                        </div>
                        <div className="mobile-card-actions">
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
                    </div>
                );
            })}
        </div>
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
                            else if (groupBy === 'Broker') setGroupBy('Ticker');
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
                        <select
                            value={bulkFreeCommission}
                            onChange={e => setBulkFreeCommission(e.target.value as '' | 'free' | 'paid')}
                            className="form-input"
                            style={{ margin: 0, padding: '0.4rem', fontSize: '0.9rem', width: '160px' }}
                        >
                            <option value="">Commission...</option>
                            <option value="free">Free (no fee)</option>
                            <option value="paid">Paid (use broker plan)</option>
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
                        Object.keys(groupedTransactions).sort().map((groupKey) => {
                            const txs = groupedTransactions[groupKey];
                            const { boughtQty, soldQty, realized, unrealizedPnl, costBasisValue, costBasisTotal, currentMarketValue, distributions, totalReturn, totalFees } = getGroupStats(txs);
                            const displayLabel = groupBy === 'Ticker' ? getAssetName(groupKey) || groupKey : groupKey;
                            return (
                                <div key={groupKey} style={{ marginBottom: '2rem' }}>
                                    <div style={{
                                        padding: '0.5rem 0',
                                        borderBottom: '2px solid var(--border-color)',
                                        marginBottom: '1rem',
                                        display: 'flex',
                                        alignItems: 'baseline',
                                        justifyContent: 'space-between',
                                        flexWrap: 'wrap',
                                        gap: '0.5rem'
                                    }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <h3 style={{ margin: 0, color: 'var(--color-primary)' }}>{displayLabel}</h3>
                                            <button
                                                onClick={() => setShowMetricsAsPercentage(!showMetricsAsPercentage)}
                                                style={{
                                                    fontSize: '0.7rem',
                                                    padding: '2px 6px',
                                                    border: '1px solid var(--border-color)',
                                                    borderRadius: 'var(--radius-sm)',
                                                    backgroundColor: showMetricsAsPercentage ? 'var(--color-primary)' : 'transparent',
                                                    color: showMetricsAsPercentage ? 'white' : 'var(--text-muted)',
                                                    cursor: 'pointer',
                                                    fontWeight: 'bold'
                                                }}
                                                title={showMetricsAsPercentage ? 'Click to show in euros' : 'Click to show as percentage'}
                                            >
                                                {showMetricsAsPercentage ? '%' : '€'}
                                            </button>
                                        </div>
                                        <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                                {txs.length} tx
                                            </span>
                                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                Bought: <strong style={{ color: 'var(--text-primary)' }}>{fmtQty(boughtQty)}</strong>
                                            </span>
                                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                Sold: <strong style={{ color: 'var(--text-primary)' }}>{fmtQty(soldQty)}</strong>
                                            </span>
                                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                Cost Basis: <strong style={{ color: 'var(--text-primary)' }}>{fmtEur(costBasisValue)}</strong>
                                            </span>
                                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                Market Value: <strong style={{ color: 'var(--text-primary)' }}>{fmtEur(currentMarketValue)}</strong>
                                            </span>
                                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                P&L: <strong style={{ color: unrealizedPnl > 0 ? 'var(--color-success)' : unrealizedPnl < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                                    {showMetricsAsPercentage ? fmtPercentage(unrealizedPnl, costBasisTotal) : fmtEur(unrealizedPnl)}
                                                </strong>
                                            </span>
                                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                                                Realized: <strong style={{ color: realized > 0 ? 'var(--color-success)' : realized < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                                    {showMetricsAsPercentage ? fmtPercentage(realized, costBasisTotal) : fmtEur(realized)}
                                                </strong>
                                            </span>
                                            {totalFees > 0 && (
                                                <span style={{ fontSize: '0.85rem', color: '#FF6B6B' }}>
                                                    Total Fees: <strong style={{ color: '#FF6B6B' }}>
                                                        {showMetricsAsPercentage ? `${fmtPercentage(totalFees, costBasisTotal)} (${fmtEur(totalFees)})` : `${fmtEur(totalFees)} (${fmtPercentage(totalFees, costBasisTotal)})`}
                                                    </strong>
                                                </span>
                                            )}
                                            {distributions > 0 && (
                                                <span style={{ fontSize: '0.85rem', color: '#3B82F6' }}>
                                                    Distributions: <strong style={{ color: '#3B82F6' }}>
                                                        {showMetricsAsPercentage ? fmtPercentage(distributions, costBasisTotal) : fmtEur(distributions)}
                                                    </strong>
                                                </span>
                                            )}
                                            <span style={{ fontSize: '0.85rem', color: totalReturn > 0 ? 'var(--color-success)' : totalReturn < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                                Total Return: <strong style={{ color: totalReturn > 0 ? 'var(--color-success)' : totalReturn < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                                    {showMetricsAsPercentage ? fmtPercentage(totalReturn, costBasisTotal) : fmtEur(totalReturn)}
                                                </strong>
                                            </span>
                                        </div>
                                    </div>
                                    {renderTable(txs)}
                                    {renderMobileList(txs)}
                                </div>
                            );
                        })
                    ) : (
                        <>
                            {renderTable(sortedTransactions)}
                            {renderMobileList(sortedTransactions)}
                        </>
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
