import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { TransactionType } from '../../types';
import './Transactions.css';

const TransactionForm: React.FC = () => {
    const { addTransaction } = usePortfolio();

    const [ticker, setTicker] = useState('');
    const [type, setType] = useState<TransactionType>('ETF');
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
            type,
            amount: Number(amount),
            price: Number(price),
            currency: 'EUR' // Default currency for now
        });

        // Reset form
        setTicker('');
        setAmount('');
        setPrice('');
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
                    <label>Type</label>
                    <select
                        className="form-select"
                        value={type}
                        onChange={(e) => setType(e.target.value as TransactionType)}
                    >
                        <option value="ETF">ETF</option>
                        <option value="Bond">Bond</option>
                    </select>
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
