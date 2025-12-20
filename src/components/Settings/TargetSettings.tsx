import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { TransactionType } from '../../types';
import '../Transactions/Transactions.css'; // Reuse form styles

const TargetSettings: React.FC = () => {
    const { targets, updateTarget } = usePortfolio();

    const getTarget = (type: TransactionType) => targets.find(t => t.type === type)?.targetPercentage || 0;

    const etfTarget = getTarget('ETF');
    const bondTarget = getTarget('Bond');
    const total = etfTarget + bondTarget;

    const handleUpdate = (type: TransactionType, value: string) => {
        updateTarget(type, Number(value));
    };

    return (
        <div className="transaction-form-card" style={{ maxWidth: '600px', margin: '0 auto' }}>
            <h2>Target Allocation</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-6)' }}>
                Define your desired portfolio allocation. The total should equal 100%.
            </p>

            <div className="form-group">
                <label>ETF Target (%)</label>
                <input
                    type="number"
                    className="form-input"
                    value={etfTarget}
                    onChange={(e) => handleUpdate('ETF', e.target.value)}
                    min="0"
                    max="100"
                />
            </div>

            <div className="form-group">
                <label>Bond Target (%)</label>
                <input
                    type="number"
                    className="form-input"
                    value={bondTarget}
                    onChange={(e) => handleUpdate('Bond', e.target.value)}
                    min="0"
                    max="100"
                />
            </div>

            <div style={{
                marginTop: 'var(--space-4)',
                padding: 'var(--space-3)',
                backgroundColor: 'var(--bg-app)',
                borderRadius: 'var(--radius-md)',
                textAlign: 'center',
                color: total === 100 ? 'var(--color-success)' : 'var(--color-warning)',
                fontWeight: 600
            }}>
                Total: {total}%
            </div>
        </div>
    );
};

export default TargetSettings;
