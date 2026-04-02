import React, { useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { TransactionDirection } from '../../types';
import { isIncomeDirection } from '../../types';
import './Transactions.css';

const directionConfig: { value: TransactionDirection; label: string; color: string; bg: string }[] = [
    { value: 'Buy', label: 'Buy', color: 'var(--color-success)', bg: 'rgba(16, 185, 129, 0.2)' },
    { value: 'Sell', label: 'Sell', color: 'var(--color-danger)', bg: 'rgba(239, 68, 68, 0.2)' },
    { value: 'Dividend', label: 'Dividend', color: '#3B82F6', bg: 'rgba(59, 130, 246, 0.2)' },
    { value: 'Coupon', label: 'Coupon', color: '#8B5CF6', bg: 'rgba(139, 92, 246, 0.2)' },
];

const TransactionForm: React.FC = () => {
    const { addTransaction, portfolios, brokers } = usePortfolio();

    const [ticker, setTicker] = useState('');

    const [direction, setDirection] = useState<TransactionDirection>('Buy');
    const [amount, setAmount] = useState('');
    const [price, setPrice] = useState('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [portfolioId, setPortfolioId] = useState('');
    const [broker, setBroker] = useState('');
    const [freeCommission, setFreeCommission] = useState(false);

    const isIncome = isIncomeDirection(direction);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!ticker) return;

        if (isIncome) {
            if (!amount) return;
            addTransaction({
                id: crypto.randomUUID(),
                date,
                ticker: ticker.toUpperCase(),
                direction,
                amount: Number(amount),
                price: 1,
                portfolioId: portfolioId || undefined,
                brokerId: broker || undefined,
            });
        } else {
            if (!amount || !price) return;
            addTransaction({
                id: crypto.randomUUID(),
                date,
                ticker: ticker.toUpperCase(),
                direction,
                amount: Number(amount),
                price: Number(price),
                portfolioId: portfolioId || undefined,
                brokerId: broker || undefined,
                freeCommission: freeCommission || undefined
            });
        }

        // Reset form
        setTicker('');
        setAmount('');
        setPrice('');
        setBroker('');
        setDirection('Buy');
        setFreeCommission(false);
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
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                        {directionConfig.map(d => (
                            <button
                                key={d.value}
                                type="button"
                                onClick={() => setDirection(d.value)}
                                className={`btn-toggle ${direction === d.value ? 'active' : ''}`}
                                style={{
                                    flex: 1,
                                    minWidth: '70px',
                                    padding: '10px',
                                    border: '1px solid var(--bg-card)',
                                    borderRadius: 'var(--radius-md)',
                                    backgroundColor: direction === d.value ? d.bg : 'transparent',
                                    color: direction === d.value ? d.color : 'var(--text-secondary)',
                                    fontWeight: 600
                                }}
                            >
                                {d.label}
                            </button>
                        ))}
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

                {isIncome ? (
                    <div className="form-group">
                        <label>Amount (EUR)</label>
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
                ) : (
                    <>
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
                    </>
                )}

                <div className="form-group">
                    <label>Portfolio (Optional)</label>
                    <select
                        className="form-input"
                        value={portfolioId}
                        onChange={(e) => setPortfolioId(e.target.value)}
                    >
                        <option value="">Select Portfolio...</option>
                        {portfolios.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                    {portfolios.length === 0 && (
                        <p style={{ marginTop: '5px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                            No portfolios available. Go to the Portfolios page to create one.
                        </p>
                    )}
                </div>

                <div className="form-group">
                    <label>Broker (Optional)</label>
                    <select
                        className="form-input"
                        value={broker}
                        onChange={(e) => setBroker(e.target.value)}
                    >
                        <option value="">Select Broker...</option>
                        {brokers.map(b => (
                            <option key={b.id} value={b.id}>
                                {b.name}
                            </option>
                        ))}
                    </select>
                </div>

                {!isIncome && (
                    <div className="form-group">
                        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={freeCommission}
                                onChange={(e) => setFreeCommission(e.target.checked)}
                                style={{ width: '18px', height: '18px', accentColor: 'var(--color-success)', cursor: 'pointer' }}
                            />
                            <span>Free commission (no fee)</span>
                        </label>
                    </div>
                )}

                <button type="submit" className="btn-submit">Add Transaction</button>
            </form>
        </div>
    );
};

export default TransactionForm;
