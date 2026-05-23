import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabGoal, YnabGoalAllocation } from '../../types';

interface Props {
    ynabGoal: YnabGoal;
    editing: YnabGoalAllocation | null;
    onClose: () => void;
}

const formatCurrency = (value: number, iso: string = 'EUR') =>
    new Intl.NumberFormat('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 2 }).format(value);

const AllocationModal: React.FC<Props> = ({ ynabGoal, editing, onClose }) => {
    const {
        portfolios,
        addAllocation,
        updateAllocation,
        getPortfolioAllocationSummary,
        ynabGoalAllocations,
    } = usePortfolio();

    const [portfolioId, setPortfolioId] = useState<string>(editing?.portfolioId ?? '');
    const [amount, setAmount] = useState<string>(editing ? String(editing.amount) : '');
    const [allowOver, setAllowOver] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    const summary = useMemo(() => {
        if (!portfolioId) return null;
        const s = getPortfolioAllocationSummary(portfolioId);
        if (editing && editing.portfolioId === portfolioId) {
            return { ...s, available: s.available + editing.amount };
        }
        return s;
        // ynabGoalAllocations included so summary recomputes when allocations change
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [portfolioId, ynabGoalAllocations, editing]);

    const amountNumber = parseFloat(amount);
    const overAlloc = summary !== null && isFinite(amountNumber) && amountNumber > summary.available;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!portfolioId) {
            setError('Select a portfolio.');
            return;
        }
        if (!isFinite(amountNumber) || amountNumber <= 0) {
            setError('Enter a valid amount.');
            return;
        }
        const result = editing
            ? updateAllocation(editing.id, { amount: amountNumber, allowOverallocation: allowOver })
            : addAllocation({ portfolioId, ynabGoalId: ynabGoal.id, amount: amountNumber, allowOverallocation: allowOver });
        if (!result.ok) {
            setError(result.error || 'Save failed.');
            return;
        }
        onClose();
    };

    const portfolioOptions = useMemo(() => {
        return [...portfolios].sort((a, b) => a.order - b.order).map(p => {
            const s = getPortfolioAllocationSummary(p.id);
            const avail = editing && editing.portfolioId === p.id ? s.available + editing.amount : s.available;
            return {
                id: p.id,
                label: `${p.name} — available ${formatCurrency(avail)} of ${formatCurrency(s.currentValue)}`,
            };
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [portfolios, ynabGoalAllocations, editing]);

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 520, width: '95vw' }}>
                <h3 style={{ marginTop: 0 }}>
                    {editing ? 'Edit allocation' : 'Add allocation'} · {ynabGoal.name}
                </h3>
                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label">Portfolio</label>
                        <select
                            className="form-select"
                            value={portfolioId}
                            onChange={e => { setPortfolioId(e.target.value); setError(null); }}
                            disabled={!!editing}
                        >
                            <option value="">— Select portfolio —</option>
                            {portfolioOptions.map(o => (
                                <option key={o.id} value={o.id}>{o.label}</option>
                            ))}
                        </select>
                    </div>
                    <div className="form-group">
                        <label className="form-label">Amount (€)</label>
                        <input
                            type="number"
                            step="0.01"
                            className="form-input"
                            value={amount}
                            onChange={e => { setAmount(e.target.value); setError(null); }}
                            autoFocus
                        />
                        {summary !== null && (
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                                Available: <strong>{formatCurrency(summary.available)}</strong> of {formatCurrency(summary.currentValue)}
                                {summary.allocated > 0 && (
                                    <> · already allocated {formatCurrency(summary.allocated)} on other goals</>
                                )}
                            </div>
                        )}
                    </div>
                    {overAlloc && (
                        <div style={{ background: 'rgba(245, 158, 11, 0.12)', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-md)', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
                            Over the portfolio's available value.
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
                                <input type="checkbox" checked={allowOver} onChange={e => setAllowOver(e.target.checked)} />
                                Allow over-allocation (accept drift)
                            </label>
                        </div>
                    )}
                    {error && (
                        <div style={{ background: 'rgba(220, 38, 38, 0.1)', color: '#b91c1c', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-md)', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
                            {error}
                        </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                        <button type="button" className="btn" onClick={onClose}>Cancel</button>
                        <button
                            type="submit"
                            className="btn btn-primary"
                            disabled={overAlloc && !allowOver}
                        >
                            {editing ? 'Save' : 'Add'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default AllocationModal;
