import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import './Transactions.css';

const TransactionList: React.FC = () => {
    const { transactions, deleteTransaction } = usePortfolio();

    // Sort by date desc
    const sortedTransactions = [...transactions].sort((a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return (
        <div className="transaction-list-card">
            <h2 style={{ marginBottom: 'var(--space-4)' }}>History</h2>
            {transactions.length === 0 ? (
                <p style={{ color: 'var(--text-muted)' }}>No transactions yet.</p>
            ) : (
                <table className="transaction-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Ticker</th>
                            <th>Side</th>
                            <th>Type</th>
                            <th>Qty</th>
                            <th>Price</th>
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
                                    <span className={`type-badge type-${tx.type.toLowerCase()}`}>
                                        {tx.type}
                                    </span>
                                </td>
                                <td>{tx.amount}</td>
                                <td>{tx.price.toFixed(2)}</td>
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
