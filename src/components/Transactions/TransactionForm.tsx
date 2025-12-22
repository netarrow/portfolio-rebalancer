import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { TransactionDirection } from '../../types';
import './Transactions.css';

const TransactionForm: React.FC = () => {
    const { addTransaction } = usePortfolio();

    const [ticker, setTicker] = useState('');

    const [direction, setDirection] = useState<TransactionDirection>('Buy');
    const [amount, setAmount] = useState('');
    const [price, setPrice] = useState('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);



    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!ticker || !amount || !price) return;

        addTransaction({
            id: crypto.randomUUID(),
            date,
            ticker: ticker.toUpperCase(),

            direction,
            amount: Number(amount),
            price: Number(price)
        });

        // Reset form
        setTicker('');
        setAmount('');
        setPrice('');
        setDirection('Buy');

    };

    return (
        <div className="transaction-form-card">
            <h2>Add Transaction</h2>
            <form onSubmit={handleSubmit}>
                <div className="form-group">
                    <label>Date</label>
                    <input
                        type="date"
                        className="form-input"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        required
                    />
                </div>

                <div className="form-group">
                    <label>Direction</label>
                    <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                            type="button"
                            onClick={() => setDirection('Buy')}
                            className={`btn-toggle ${direction === 'Buy' ? 'active-buy' : ''}`}
                            style={{
                                flex: 1,
                                padding: '10px',
                                border: '1px solid var(--bg-card)',
                                borderRadius: 'var(--radius-md)',
                                backgroundColor: direction === 'Buy' ? 'rgba(16, 185, 129, 0.2)' : 'transparent',
                                color: direction === 'Buy' ? 'var(--color-success)' : 'var(--text-secondary)',
                                fontWeight: 600
                            }}
                        >
                            Buy
                        </button>
                        <button
                            type="button"
                            onClick={() => setDirection('Sell')}
                            className={`btn-toggle ${direction === 'Sell' ? 'active-sell' : ''}`}
                            style={{
                                flex: 1,
                                padding: '10px',
                                border: '1px solid var(--bg-card)',
                                borderRadius: 'var(--radius-md)',
                                backgroundColor: direction === 'Sell' ? 'rgba(239, 68, 68, 0.2)' : 'transparent',
                                color: direction === 'Sell' ? 'var(--color-danger)' : 'var(--text-secondary)',
                                fontWeight: 600
                            }}
                        >
                            Sell
                        </button>
                    </div>
                </div>

                <div className="form-group">
                    <label>Ticker / Symbol</label>
                    <input
                        type="text"
                        className="form-input"
                        placeholder="e.g. VWCE"
                        value={ticker}
                        onChange={(e) => setTicker(e.target.value)}
                        required
                    />
                </div>



                <div className="form-group">
                    <label>Quantity</label>
                    <input
                        type="number"
                        className="form-input"
                        placeholder="0.00"
                        step="any"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                    />
                </div>

                <div className="form-group">
                    <label>Price per unit</label>
                    <input
                        type="number"
                        className="form-input"
                        placeholder="0.00"
                        step="any"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        required
                    />
                </div>

                <button type="submit" className="btn-submit">Add Transaction</button>
            </form>
        </div>
    );
};

export default TransactionForm;
