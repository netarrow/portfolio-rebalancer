import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { YnabGoal, YnabGoalAllocation } from '../../types';
import { getVirtualBondTicker, getVirtualBondId, isVirtualBondTicker } from '../../types';

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
        assetSettings,
        virtualBonds,
    } = usePortfolio();

    const [portfolioId, setPortfolioId] = useState<string>(editing?.portfolioId ?? '');
    const [ticker, setTicker] = useState<string>(editing?.ticker ?? '');
    const [amount, setAmount] = useState<string>(editing ? String(editing.amount) : '');

    const selectedPortfolio = portfolios.find(p => p.id === portfolioId);

    // Rows of the chosen portfolio a goal can be pinned to: its targets, its
    // market groups and every virtual bond still waiting to be concretized.
    const rowOptions = useMemo(() => {
        if (!selectedPortfolio) return [];
        const keys = new Set<string>([
            ...Object.keys(selectedPortfolio.allocations || {}),
            ...Object.keys(selectedPortfolio.amountTargets || {}),
            ...(selectedPortfolio.allocationGroups || []).map(g => g.id),
            ...virtualBonds.filter(vb => !vb.resolvedIsin).map(vb => getVirtualBondTicker(vb.id)),
        ]);
        if (editing?.ticker) keys.add(editing.ticker);
        return Array.from(keys).map(key => {
            const group = selectedPortfolio.allocationGroups?.find(g => g.id === key);
            const vb = isVirtualBondTicker(key) ? virtualBonds.find(b => b.id === getVirtualBondId(key)) : undefined;
            const label = group ? `${group.label} (group)`
                : vb ? `${vb.label} (virtual bond, ${vb.targetMaturityDate})`
                : `${assetSettings.find(s => s.ticker.toUpperCase() === key.toUpperCase())?.label || key} (${key})`;
            return { key, label };
        }).sort((a, b) => a.label.localeCompare(b.label));
    }, [selectedPortfolio, virtualBonds, assetSettings, editing]);

    // On a row of an amount-mode portfolio the amount is that row's € target,
    // so it isn't capped by what the portfolio holds today.
    const isRowTarget = !!ticker && selectedPortfolio?.targetMode === 'amount';
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
    const overAlloc = !isRowTarget && summary !== null && isFinite(amountNumber) && amountNumber > summary.available;

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
            ? updateAllocation(editing.id, { amount: amountNumber, ticker: ticker || undefined, allowOverallocation: allowOver })
            : addAllocation({ portfolioId, ynabGoalId: ynabGoal.id, amount: amountNumber, ticker: ticker || undefined, allowOverallocation: allowOver });
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
                            onChange={e => { setPortfolioId(e.target.value); setTicker(''); setError(null); }}
                            disabled={!!editing}
                        >
                            <option value="">— Select portfolio —</option>
                            {portfolioOptions.map(o => (
                                <option key={o.id} value={o.id}>{o.label}</option>
                            ))}
                        </select>
                    </div>
                    {selectedPortfolio && (
                        <div className="form-group">
                            <label className="form-label">Covering asset</label>
                            <select
                                className="form-select"
                                value={ticker}
                                onChange={e => { setTicker(e.target.value); setError(null); }}
                            >
                                <option value="">Whole portfolio</option>
                                {rowOptions.map(o => (
                                    <option key={o.key} value={o.key}>{o.label}</option>
                                ))}
                            </select>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                                {selectedPortfolio.targetMode === 'amount'
                                    ? 'Goal matching portfolio: the asset\'s € target becomes the sum of the goals pinned to it, due by the nearest goal date.'
                                    : 'Switch this portfolio to "Target in €" to plan buys from the goals pinned to its assets.'}
                            </div>
                        </div>
                    )}
                    <div className="form-group">
                        <label className="form-label">{isRowTarget ? 'Target for this asset (€)' : 'Amount (€)'}</label>
                        <input
                            type="number"
                            step="0.01"
                            className="form-input"
                            value={amount}
                            onChange={e => { setAmount(e.target.value); setError(null); }}
                            autoFocus
                        />
                        {summary !== null && !isRowTarget && (
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
