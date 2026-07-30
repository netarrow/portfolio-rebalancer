import React, { useEffect, useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { PacContributionMode, PacCostMode, PacFrequency, PacPlan, PacRoundingMode } from '../../types';
import { computeInstalment } from '../../utils/pacSchedule';
import '../Transactions/Transactions.css'; // .modal-overlay, .modal-content, .form-group, .form-input

const FREQUENCY_LABELS: Record<PacFrequency, string> = {
    weekly: 'Weekly',
    biweekly: 'Every 2 weeks',
    monthly: 'Monthly',
    bimonthly: 'Every 2 months',
    quarterly: 'Quarterly',
    semiannual: 'Every 6 months',
    annual: 'Yearly',
};

interface PacPlanFormProps {
    initialData?: PacPlan | null;
    onSubmit: (data: Omit<PacPlan, 'id' | 'createdAt'>) => void;
    onCancel: () => void;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

const PacPlanForm: React.FC<PacPlanFormProps> = ({ initialData, onSubmit, onCancel }) => {
    const { portfolios, brokers, assetSettings, marketData } = usePortfolio();

    const [name, setName] = useState('');
    const [ticker, setTicker] = useState('');
    const [portfolioId, setPortfolioId] = useState('');
    const [brokerId, setBrokerId] = useState('');
    const [mode, setMode] = useState<PacContributionMode>('amount');
    const [amount, setAmount] = useState('');
    const [quantity, setQuantity] = useState('');
    const [frequency, setFrequency] = useState<PacFrequency>('monthly');
    const [startDate, setStartDate] = useState(todayISO());
    const [hasEndDate, setHasEndDate] = useState(false);
    const [endDate, setEndDate] = useState('');
    const [costMode, setCostMode] = useState<PacCostMode>('broker');
    const [costFixed, setCostFixed] = useState('');
    const [costPercent, setCostPercent] = useState('');
    const [costsIncluded, setCostsIncluded] = useState(true);
    const [rounding, setRounding] = useState<PacRoundingMode>('fractional');
    const [active, setActive] = useState(true);

    useEffect(() => {
        if (initialData) {
            setName(initialData.name);
            setTicker(initialData.ticker);
            setPortfolioId(initialData.portfolioId);
            setBrokerId(initialData.brokerId);
            setMode(initialData.mode);
            setAmount(initialData.amount !== undefined ? String(initialData.amount) : '');
            setQuantity(initialData.quantity !== undefined ? String(initialData.quantity) : '');
            setFrequency(initialData.frequency);
            setStartDate(initialData.startDate);
            setHasEndDate(!!initialData.endDate);
            setEndDate(initialData.endDate || '');
            setCostMode(initialData.costMode);
            setCostFixed(initialData.costFixed !== undefined ? String(initialData.costFixed) : '');
            setCostPercent(initialData.costPercent !== undefined ? String(initialData.costPercent) : '');
            setCostsIncluded(initialData.costsIncluded);
            setRounding(initialData.rounding);
            setActive(initialData.active);
        } else {
            setName('');
            setTicker('');
            setPortfolioId(portfolios[0]?.id || '');
            setBrokerId(brokers[0]?.id || '');
            setMode('amount');
            setAmount('');
            setQuantity('');
            setFrequency('monthly');
            setStartDate(todayISO());
            setHasEndDate(false);
            setEndDate('');
            setCostMode('broker');
            setCostFixed('');
            setCostPercent('');
            setCostsIncluded(true);
            setRounding('fractional');
            setActive(true);
        }
    }, [initialData, portfolios, brokers]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!name || !ticker || !portfolioId || !brokerId) return;
        if (mode === 'amount' && !amount) return;
        if (mode === 'quantity' && !quantity) return;

        onSubmit({
            name,
            ticker: ticker.toUpperCase(),
            portfolioId,
            brokerId,
            mode,
            amount: mode === 'amount' ? Number(amount) : undefined,
            quantity: mode === 'quantity' ? Number(quantity) : undefined,
            frequency,
            startDate,
            endDate: hasEndDate && endDate ? endDate : undefined,
            costMode,
            costFixed: costMode === 'fixed' ? Number(costFixed) : undefined,
            costPercent: costMode === 'percent' ? Number(costPercent) : undefined,
            costsIncluded,
            rounding,
            active,
        });
    };

    // Live preview using the latest known market price (no carried-in residue —
    // just illustrates roughly what one installment looks like today).
    const preview = useMemo(() => {
        const upperTicker = ticker.toUpperCase();
        const price = marketData[upperTicker]?.price;
        if (!price || price <= 0) return null;
        const broker = brokers.find(b => b.id === brokerId);
        const previewPlan: PacPlan = {
            id: 'preview', name, ticker: upperTicker, portfolioId, brokerId,
            mode,
            amount: mode === 'amount' ? Number(amount || 0) : undefined,
            quantity: mode === 'quantity' ? Number(quantity || 0) : undefined,
            frequency, startDate,
            costMode,
            costFixed: costMode === 'fixed' ? Number(costFixed || 0) : undefined,
            costPercent: costMode === 'percent' ? Number(costPercent || 0) : undefined,
            costsIncluded, rounding, active: true, createdAt: '',
        };
        return { price, math: computeInstalment({ plan: previewPlan, price, carryIn: 0, broker }) };
    }, [ticker, marketData, brokers, brokerId, name, portfolioId, mode, amount, quantity, frequency, startDate, costMode, costFixed, costPercent, costsIncluded, rounding]);

    const portfolioName = portfolios.find(p => p.id === portfolioId)?.name;

    return (
        <div className="modal-overlay">
            <div className="modal-content" style={{ position: 'relative', width: '480px', maxWidth: '95vw' }}>
                <button className="modal-close-btn" type="button" onClick={onCancel}>×</button>
                <h3>{initialData ? 'Edit PAC Plan' : 'New PAC Plan'}</h3>
                <form onSubmit={handleSubmit} style={{ overflowY: 'auto' }}>
                    <div className="form-group">
                        <label>Name</label>
                        <input
                            type="text" className="form-input" value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Monthly VWCE accumulation"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label>Ticker / ISIN</label>
                        <input
                            type="text" className="form-input" list="pac-ticker-options"
                            value={ticker} onChange={(e) => setTicker(e.target.value)}
                            placeholder="e.g. VWCE" required
                        />
                        <datalist id="pac-ticker-options">
                            {assetSettings.map(a => <option key={a.ticker} value={a.ticker} />)}
                        </datalist>
                    </div>

                    <div className="form-group">
                        <label>Portfolio</label>
                        <select className="form-input" value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)} required>
                            <option value="">Select portfolio...</option>
                            {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </div>

                    <div className="form-group">
                        <label>Broker</label>
                        <select className="form-input" value={brokerId} onChange={(e) => setBrokerId(e.target.value)} required>
                            <option value="">Select broker...</option>
                            {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                    </div>

                    <div className="form-group">
                        <label>Contribution</label>
                        <select className="form-input" value={mode} onChange={(e) => setMode(e.target.value as PacContributionMode)}>
                            <option value="amount">Fixed EUR amount</option>
                            <option value="quantity">Fixed quantity of units</option>
                        </select>
                    </div>

                    {mode === 'amount' ? (
                        <div className="form-group">
                            <label>Amount per installment (EUR)</label>
                            <input type="number" className="form-input" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} required />
                        </div>
                    ) : (
                        <div className="form-group">
                            <label>Units per installment</label>
                            <input type="number" className="form-input" step="any" min="0" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
                        </div>
                    )}

                    <div className="form-group">
                        <label>Frequency</label>
                        <select className="form-input" value={frequency} onChange={(e) => setFrequency(e.target.value as PacFrequency)}>
                            {(Object.keys(FREQUENCY_LABELS) as PacFrequency[]).map(f => (
                                <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
                            ))}
                        </select>
                    </div>

                    <div className="form-group">
                        <label>Start date</label>
                        <input type="date" className="form-input" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                    </div>

                    <div className="form-group">
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                            <input type="checkbox" checked={hasEndDate} onChange={(e) => setHasEndDate(e.target.checked)} />
                            <span>Set an end date</span>
                        </label>
                        {hasEndDate && (
                            <input type="date" className="form-input" style={{ marginTop: '8px' }} value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate} />
                        )}
                    </div>

                    <div className="form-group">
                        <label>Fee / commission</label>
                        <select className="form-input" value={costMode} onChange={(e) => setCostMode(e.target.value as PacCostMode)}>
                            <option value="broker">Use broker's commission plan</option>
                            <option value="fixed">Fixed fee (EUR)</option>
                            <option value="percent">Percent of trade value</option>
                            <option value="none">No fee</option>
                        </select>
                    </div>

                    {costMode === 'fixed' && (
                        <div className="form-group">
                            <label>Fixed fee (EUR)</label>
                            <input type="number" className="form-input" step="0.01" min="0" value={costFixed} onChange={(e) => setCostFixed(e.target.value)} required />
                        </div>
                    )}

                    {costMode === 'percent' && (
                        <div className="form-group">
                            <label>Fee (% of trade value)</label>
                            <input type="number" className="form-input" step="0.01" min="0" value={costPercent} onChange={(e) => setCostPercent(e.target.value)} required />
                        </div>
                    )}

                    {mode === 'amount' && (
                        <>
                            <div className="form-group">
                                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                    <input type="checkbox" checked={costsIncluded} onChange={(e) => setCostsIncluded(e.target.checked)} />
                                    <span>Fee comes out of the amount above (unchecked: fee is added on top)</span>
                                </label>
                            </div>

                            <div className="form-group">
                                <label>Rounding</label>
                                <select className="form-input" value={rounding} onChange={(e) => setRounding(e.target.value as PacRoundingMode)}>
                                    <option value="fractional">Fractional units — invest the full amount, no leftover</option>
                                    <option value="floor">Whole units only — park the remainder{portfolioName ? ` on ${portfolioName}` : ''}</option>
                                    <option value="floor-carry">Whole units only — park and reuse the remainder next time</option>
                                </select>
                            </div>
                        </>
                    )}

                    {initialData && (
                        <div className="form-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                                <span>Active (paused plans keep their history but stop suggesting new installments)</span>
                            </label>
                        </div>
                    )}

                    {preview && (
                        <div className="form-group" style={{ background: 'var(--bg-app)', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                            <strong style={{ color: 'var(--text-primary)' }}>Preview @ €{preview.price.toFixed(2)}/unit</strong>
                            <div>Quantity: {preview.math.quantity.toLocaleString('en-IE', { maximumFractionDigits: 6 })}</div>
                            <div>Fee: €{preview.math.fee.toFixed(2)}</div>
                            <div>Total outlay: €{preview.math.totalOutlay.toFixed(2)}</div>
                            {preview.math.carryOut > 0 && (
                                <div>€{preview.math.carryOut.toFixed(2)} earmarked to {portfolioName || 'the selected portfolio'}</div>
                            )}
                        </div>
                    )}

                    <div className="form-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
                        <button type="button" onClick={onCancel} className="btn btn-secondary">Cancel</button>
                        <button type="submit" className="btn btn-primary">Save Plan</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default PacPlanForm;
