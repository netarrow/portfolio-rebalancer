import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import './Transactions.css';

const TransactionList: React.FC = () => {
    const { transactions, assets, deleteTransaction, refreshPrices } = usePortfolio();
    const [updating, setUpdating] = React.useState(false);

    const getAssetPrice = (ticker: string) => {
        const asset = assets.find(a => a.ticker === ticker);
        return asset?.currentPrice;
    };

    const handleRefresh = async () => {
        setUpdating(true);
        await refreshPrices();
        setUpdating(false);
    };

    // Sort by date desc
    const sortedTransactions = [...transactions].sort((a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return (
        <div className="transaction-list-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
                <h2>History</h2>
                <button
                    onClick={handleRefresh}
                    disabled={updating}
                    className="btn-primary"
                    style={{ fontSize: '0.9rem', padding: '0.4rem 0.8rem' }}
                >
                    {updating ? 'Updating...' : 'Update Prices'}
                </button>
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
                        {sortedTransactions.map((tx) => (
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
                                    {getAssetPrice(tx.ticker)?.toFixed(2) || '-'}
                                </td>
                                <td>{(tx.amount * tx.price).toFixed(2)}</td>
                                <td>
                                    <button
                                        className="btn-delete"
                                        onClick={() => deleteTransaction(tx.id)}
                                    >
                                        Delete
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
};

export default TransactionList;
