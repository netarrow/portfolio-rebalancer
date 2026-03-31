import React, { useState, useEffect, useMemo } from 'react';
import type { Broker, Portfolio, CommissionType } from '../../types';

interface BrokerFormProps {
    initialData?: Broker | null;
    portfolios: Portfolio[];
    onSubmit: (data: Omit<Broker, 'id'>) => void;
    onCancel: () => void;
}

const BrokerForm: React.FC<BrokerFormProps> = ({ initialData, portfolios, onSubmit, onCancel }) => {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [currentLiquidity, setCurrentLiquidity] = useState<number | ''>('');

    // Liquidity Target
    const [liquidityType, setLiquidityType] = useState<'percent' | 'fixed'>('percent');
    const [minLiquidityPercentage, setMinLiquidityPercentage] = useState<number | ''>('');
    const [minLiquidityAmount, setMinLiquidityAmount] = useState<number | ''>('');

    // Liquidity Allocations to Portfolios
    const [liquidityAllocations, setLiquidityAllocations] = useState<Record<string, number | ''>>({});

    // Commission Plan
    const [commissionType, setCommissionType] = useState<CommissionType | ''>('');
    const [commissionFixed, setCommissionFixed] = useState<number | ''>('');
    const [commissionPercent, setCommissionPercent] = useState<number | ''>('');
    const [commissionMin, setCommissionMin] = useState<number | ''>('');
    const [commissionMax, setCommissionMax] = useState<number | ''>('');

    useEffect(() => {
        if (initialData) {
            setName(initialData.name);
            setDescription(initialData.description || '');
            setCurrentLiquidity(initialData.currentLiquidity !== undefined ? initialData.currentLiquidity : '');

            const type = initialData.minLiquidityType || 'percent';
            setLiquidityType(type);
            setMinLiquidityPercentage(initialData.minLiquidityPercentage !== undefined ? initialData.minLiquidityPercentage : '');
            setMinLiquidityAmount(initialData.minLiquidityAmount !== undefined ? initialData.minLiquidityAmount : '');

            // Load existing allocations
            const allocs: Record<string, number | ''> = {};
            if (initialData.liquidityAllocations) {
                Object.entries(initialData.liquidityAllocations).forEach(([pid, amount]) => {
                    allocs[pid] = amount;
                });
            }
            setLiquidityAllocations(allocs);

            setCommissionType(initialData.commissionType || '');
            setCommissionFixed(initialData.commissionFixed !== undefined ? initialData.commissionFixed : '');
            setCommissionPercent(initialData.commissionPercent !== undefined ? initialData.commissionPercent : '');
            setCommissionMin(initialData.commissionMin !== undefined ? initialData.commissionMin : '');
            setCommissionMax(initialData.commissionMax !== undefined ? initialData.commissionMax : '');
        } else {
            setName('');
            setDescription('');
            setCurrentLiquidity('');
            setLiquidityType('percent');
            setMinLiquidityPercentage('');
            setMinLiquidityAmount('');
            setLiquidityAllocations({});
            setCommissionType('');
            setCommissionFixed('');
            setCommissionPercent('');
            setCommissionMin('');
            setCommissionMax('');
        }
    }, [initialData]);

    // Compute the min liquidity target value for display
    const minLiquidityTarget = useMemo(() => {
        if (liquidityType === 'fixed') {
            return minLiquidityAmount === '' ? 0 : Number(minLiquidityAmount);
        }
        // For percent type, we can't compute exact target without total broker value,
        // so we show the percentage info only
        return null; // null means "percentage mode, can't compute absolute target here"
    }, [liquidityType, minLiquidityAmount]);

    const hasMinLiquidity = liquidityType === 'fixed'
        ? (minLiquidityAmount !== '' && Number(minLiquidityAmount) > 0)
        : (minLiquidityPercentage !== '' && Number(minLiquidityPercentage) > 0);

    const totalAllocated = useMemo(() => {
        return Object.values(liquidityAllocations).reduce<number>((sum, v) => sum + (v === '' ? 0 : Number(v)), 0);
    }, [liquidityAllocations]);

    const handleAllocationChange = (portfolioId: string, value: string) => {
        setLiquidityAllocations(prev => ({
            ...prev,
            [portfolioId]: value === '' ? '' : Number(value)
        }));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        // Build clean liquidityAllocations (only non-zero values)
        const cleanAllocations: Record<string, number> = {};
        Object.entries(liquidityAllocations).forEach(([pid, amount]) => {
            const num = amount === '' ? 0 : Number(amount);
            if (num > 0) {
                cleanAllocations[pid] = num;
            }
        });

        onSubmit({
            name,
            description,
            currentLiquidity: currentLiquidity === '' ? undefined : Number(currentLiquidity),
            minLiquidityType: liquidityType,
            minLiquidityPercentage: minLiquidityPercentage === '' ? undefined : Number(minLiquidityPercentage),
            minLiquidityAmount: minLiquidityAmount === '' ? undefined : Number(minLiquidityAmount),
            liquidityAllocations: Object.keys(cleanAllocations).length > 0 ? cleanAllocations : undefined,
            commissionType: commissionType || undefined,
            commissionFixed: commissionType === 'fixed' && commissionFixed !== '' ? Number(commissionFixed) : undefined,
            commissionPercent: commissionType === 'percent' && commissionPercent !== '' ? Number(commissionPercent) : undefined,
            commissionMin: commissionType === 'percent' && commissionMin !== '' ? Number(commissionMin) : undefined,
            commissionMax: commissionType === 'percent' && commissionMax !== '' ? Number(commissionMax) : undefined,
        });
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content" style={{ position: 'relative' }}>
                <button className="modal-close-btn" type="button" onClick={onCancel}>×</button>
                <h3>{initialData ? 'Edit Broker' : 'New Broker'}</h3>
                <form onSubmit={handleSubmit} className="broker-form">
                    <div className="form-group">
                        <label htmlFor="name">Broker Name</label>
                        <input
                            type="text"
                            id="name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            placeholder="e.g., Degiro, Interactive Brokers"
                            className="form-input"
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="description">Description (Optional)</label>
                        <textarea
                            id="description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Additional details"
                            className="form-input"
                            rows={3}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="currentLiquidity">Current Liquidity (€)</label>
                        <input
                            type="number"
                            id="currentLiquidity"
                            value={currentLiquidity}
                            onChange={(e) => setCurrentLiquidity(e.target.value === '' ? '' : Number(e.target.value))}
                            placeholder="0.00"
                            step="0.01"
                            className="form-input"
                        />
                    </div>

                    <div className="form-group">
                        <label style={{ display: 'block', marginBottom: '0.5rem' }}>Minimum Liquidity Target</label>

                        <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem' }}>
                            <label style={{ fontWeight: 'normal', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                                <input
                                    type="radio"
                                    name="liquidityType"
                                    value="percent"
                                    checked={liquidityType === 'percent'}
                                    onChange={() => setLiquidityType('percent')}
                                />
                                Percentage of Value
                            </label>
                            <label style={{ fontWeight: 'normal', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                                <input
                                    type="radio"
                                    name="liquidityType"
                                    value="fixed"
                                    checked={liquidityType === 'fixed'}
                                    onChange={() => setLiquidityType('fixed')}
                                />
                                Fixed Amount
                            </label>
                        </div>

                        {liquidityType === 'percent' ? (
                            <div className="input-with-suffix">
                                <input
                                    type="number"
                                    id="minLiquidityPercentage"
                                    value={minLiquidityPercentage}
                                    onChange={(e) => setMinLiquidityPercentage(e.target.value === '' ? '' : Number(e.target.value))}
                                    placeholder="e.g. 5"
                                    step="0.1"
                                    min="0"
                                    max="100"
                                    className="form-input"
                                />
                                <span className="input-suffix">%</span>
                            </div>
                        ) : (
                            <div className="input-with-suffix">
                                <span className="input-prefix">€</span>
                                <input
                                    type="number"
                                    id="minLiquidityAmount"
                                    value={minLiquidityAmount}
                                    onChange={(e) => setMinLiquidityAmount(e.target.value === '' ? '' : Number(e.target.value))}
                                    placeholder="e.g. 1000"
                                    step="1"
                                    min="0"
                                    className="form-input"
                                    style={{ paddingLeft: '1.8rem' }}
                                />
                            </div>
                        )}
                    </div>

                    {hasMinLiquidity && portfolios.length > 0 && (
                        <div className="form-group">
                            <label style={{ display: 'block', marginBottom: '0.5rem' }}>Allocate Liquidity to Portfolios</label>
                            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 0.75rem 0' }}>
                                Optionally assign part of the minimum liquidity reserve to specific portfolios. It will appear as a Cash asset in their allocation.
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                {portfolios.map(p => (
                                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                        <span style={{ flex: 1, fontSize: '0.9rem', color: 'var(--text-primary)' }}>{p.name}</span>
                                        <div className="input-with-suffix" style={{ width: '140px' }}>
                                            <span className="input-prefix">€</span>
                                            <input
                                                type="number"
                                                value={liquidityAllocations[p.id] ?? ''}
                                                onChange={(e) => handleAllocationChange(p.id, e.target.value)}
                                                placeholder="0"
                                                step="1"
                                                min="0"
                                                className="form-input"
                                                style={{ paddingLeft: '1.8rem', width: '100%' }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Summary */}
                            <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--bg-background)', fontSize: '0.85rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>Total Allocated:</span>
                                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                        €{totalAllocated.toLocaleString('en-IE', { minimumFractionDigits: 2 })}
                                        {minLiquidityTarget !== null && ` / €${minLiquidityTarget.toLocaleString('en-IE', { minimumFractionDigits: 2 })}`}
                                    </span>
                                </div>
                                {minLiquidityTarget !== null && totalAllocated > minLiquidityTarget && (
                                    <div style={{ color: '#F59E0B', marginTop: '0.25rem', fontSize: '0.8rem' }}>
                                        Warning: total allocated exceeds the minimum liquidity target.
                                    </div>
                                )}
                                {currentLiquidity !== '' && Number(currentLiquidity) < totalAllocated && (
                                    <div style={{ color: '#EF4444', marginTop: '0.25rem', fontSize: '0.8rem' }}>
                                        Warning: current liquidity (€{Number(currentLiquidity).toLocaleString('en-IE', { minimumFractionDigits: 2 })}) is below the total allocated amount.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Commission Plan */}
                    <div className="form-group">
                        <label style={{ display: 'block', marginBottom: '0.5rem' }}>Commission Plan</label>

                        <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.75rem' }}>
                            <label style={{ fontWeight: 'normal', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                                <input
                                    type="radio"
                                    name="commissionType"
                                    value=""
                                    checked={commissionType === ''}
                                    onChange={() => setCommissionType('')}
                                />
                                None
                            </label>
                            <label style={{ fontWeight: 'normal', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                                <input
                                    type="radio"
                                    name="commissionType"
                                    value="fixed"
                                    checked={commissionType === 'fixed'}
                                    onChange={() => setCommissionType('fixed')}
                                />
                                Fixed
                            </label>
                            <label style={{ fontWeight: 'normal', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                                <input
                                    type="radio"
                                    name="commissionType"
                                    value="percent"
                                    checked={commissionType === 'percent'}
                                    onChange={() => setCommissionType('percent')}
                                />
                                Percentage
                            </label>
                        </div>

                        {commissionType === 'fixed' && (
                            <div className="input-with-suffix">
                                <span className="input-prefix">€</span>
                                <input
                                    type="number"
                                    value={commissionFixed}
                                    onChange={e => setCommissionFixed(e.target.value === '' ? '' : Number(e.target.value))}
                                    placeholder="e.g. 2.00"
                                    step="0.01"
                                    min="0"
                                    className="form-input"
                                    style={{ paddingLeft: '1.8rem' }}
                                />
                            </div>
                        )}

                        {commissionType === 'percent' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div className="input-with-suffix">
                                    <input
                                        type="number"
                                        value={commissionPercent}
                                        onChange={e => setCommissionPercent(e.target.value === '' ? '' : Number(e.target.value))}
                                        placeholder="e.g. 0.20"
                                        step="0.01"
                                        min="0"
                                        className="form-input"
                                    />
                                    <span className="input-suffix">%</span>
                                </div>
                                <div style={{ display: 'flex', gap: '0.75rem' }}>
                                    <div style={{ flex: 1 }}>
                                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>Min fee (optional)</label>
                                        <div className="input-with-suffix">
                                            <span className="input-prefix">€</span>
                                            <input
                                                type="number"
                                                value={commissionMin}
                                                onChange={e => setCommissionMin(e.target.value === '' ? '' : Number(e.target.value))}
                                                placeholder="e.g. 1.50"
                                                step="0.01"
                                                min="0"
                                                className="form-input"
                                                style={{ paddingLeft: '1.8rem' }}
                                            />
                                        </div>
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>Max fee (optional)</label>
                                        <div className="input-with-suffix">
                                            <span className="input-prefix">€</span>
                                            <input
                                                type="number"
                                                value={commissionMax}
                                                onChange={e => setCommissionMax(e.target.value === '' ? '' : Number(e.target.value))}
                                                placeholder="e.g. 10.00"
                                                step="0.01"
                                                min="0"
                                                className="form-input"
                                                style={{ paddingLeft: '1.8rem' }}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="form-actions">
                        <button type="button" onClick={onCancel} className="btn btn-secondary">
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary">
                            Save Broker
                        </button>
                    </div>
                </form>
            </div>

            <style>{`
                .input-with-suffix {
                    position: relative;
                }
                .input-suffix {
                    position: absolute;
                    right: 12px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: var(--text-secondary);
                }
                .input-prefix {
                    position: absolute;
                    left: 10px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: var(--text-secondary);
                }
            `}</style>

            <style>{`
                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                }

                .modal-content {
                    background-color: var(--bg-surface);
                    padding: var(--space-6);
                    border-radius: var(--radius-lg);
                    width: 100%;
                    max-width: 500px;
                    max-height: 90vh;
                    overflow-y: auto;
                    border: 1px solid var(--bg-card);
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                }

                .modal-content h3 {
                    margin-top: 0;
                    margin-bottom: var(--space-4);
                    font-size: 1.25rem;
                    color: var(--text-primary);
                }

                .broker-form {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-4);
                }

                .form-group {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                    flex: 1;
                }

                .form-row {
                    display: flex;
                    gap: var(--space-4);
                }

                .form-group label {
                    font-size: 0.875rem;
                    font-weight: 500;
                    color: var(--text-secondary);
                }

                .form-input {
                    padding: var(--space-2) var(--space-3);
                    border-radius: var(--radius-md);
                    border: 1px solid var(--bg-card);
                    background-color: var(--bg-background);
                    color: var(--text-primary);
                    font-size: 0.9rem;
                    transition: border-color 0.2s;
                }

                .form-input:focus {
                    outline: none;
                    border-color: var(--color-primary);
                }

                .form-actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: var(--space-3);
                    margin-top: var(--space-2);
                }

                .btn {
                    padding: var(--space-2) var(--space-4);
                    border-radius: var(--radius-md);
                    font-weight: 500;
                    cursor: pointer;
                    border: none;
                    font-size: 0.9rem;
                }

                .btn-primary {
                    background-color: var(--color-primary);
                    color: white;
                }

                .btn-primary:hover {
                    opacity: 0.9;
                }

                .btn-secondary {
                    background-color: transparent;
                    border: 1px solid var(--bg-card);
                    color: var(--text-secondary);
                }

                .btn-secondary:hover {
                    background-color: var(--bg-card);
                    color: var(--text-primary);
                }
            `}</style>
        </div>
    );
};

export default BrokerForm;
