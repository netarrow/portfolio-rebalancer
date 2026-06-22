import React, { useState, useEffect } from 'react';
import type { VirtualBond, BondProposal, Broker, Portfolio } from '../../types';
import { fetchBondProposals } from '../../services/bondProposals';
import '../Dashboard/Dashboard.css';

interface Props {
    bond: VirtualBond;
    brokers: Broker[];
    portfolios: Portfolio[];
    onConfirm: (fill: {
        isin: string; quantity: number; price: number;
        brokerId?: string; portfolioId?: string;
        source?: 'ETF' | 'MOT'; label?: string;
    }) => void;
    onClose: () => void;
}

const ConcretizeModal: React.FC<Props> = ({ bond, brokers, portfolios, onConfirm, onClose }) => {
    const [proposals, setProposals] = useState<BondProposal[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const [selectedIsin, setSelectedIsin] = useState('');
    const [manualIsin, setManualIsin] = useState('');
    const [quantity, setQuantity] = useState('');
    const [price, setPrice] = useState('');
    const [label, setLabel] = useState('');
    const [brokerId, setBrokerId] = useState('');
    const [portfolioId, setPortfolioId] = useState('');
    const [source, setSource] = useState<'ETF' | 'MOT'>(bond.universe === 'IT' ? 'MOT' : 'ETF');

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError('');
        fetchBondProposals({
            targetDate: bond.targetMaturityDate,
            universe: bond.universe,
            minMonthsBefore: bond.minMonthsBefore,
            maxMonthsBefore: bond.maxMonthsBefore,
        }).then(result => {
            if (!cancelled) {
                setProposals(result);
                setLoading(false);
            }
        }).catch(() => {
            if (!cancelled) {
                setError('Failed to fetch proposals');
                setLoading(false);
            }
        });
        return () => { cancelled = true; };
    }, [bond]);

    const effectiveIsin = selectedIsin || manualIsin;
    const selectedProposal = proposals.find(p => p.isin === effectiveIsin);
    const effectiveLabel = label || selectedProposal?.name || '';

    const handleConfirm = () => {
        if (!effectiveIsin || !quantity || !price) return;
        onConfirm({
            isin: effectiveIsin,
            quantity: Number(quantity),
            price: Number(price),
            brokerId: brokerId || undefined,
            portfolioId: portfolioId || undefined,
            source,
            label: effectiveLabel || undefined,
        });
    };

    return (
        <div className="modal-overlay" style={{ zIndex: 1100 }}>
            <div className="modal-content" style={{ maxWidth: '700px', width: '95%', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
                    <h3 style={{ margin: 0, color: '#8B5CF6' }}>Concretizza: {bond.label}</h3>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
                </div>

                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>
                    Target maturity: <strong>{bond.targetMaturityDate}</strong> | Universe: <strong>{bond.universe === 'IT' ? 'Italy' : 'Europe'}</strong> | Window: {bond.minMonthsBefore}-{bond.maxMonthsBefore} months before
                </div>

                {/* Proposals section */}
                <div style={{ marginBottom: 'var(--space-4)' }}>
                    <h4 style={{ marginTop: 0, marginBottom: 'var(--space-2)' }}>Proposed Bonds</h4>
                    {loading ? (
                        <div style={{ padding: 'var(--space-4)', textAlign: 'center', color: 'var(--text-muted)' }}>
                            Loading proposals...
                        </div>
                    ) : error ? (
                        <div style={{ padding: 'var(--space-3)', color: 'var(--color-danger)', fontSize: '0.85rem' }}>
                            {error}. You can still enter an ISIN manually below.
                        </div>
                    ) : proposals.length === 0 ? (
                        <div style={{ padding: 'var(--space-3)', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            No bonds found in the {bond.minMonthsBefore}-{bond.maxMonthsBefore} month window. Enter an ISIN manually below.
                        </div>
                    ) : (
                        <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid var(--border-color)', position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
                                        <th style={{ padding: '6px 8px', textAlign: 'left' }}>ISIN</th>
                                        <th style={{ padding: '6px 8px', textAlign: 'left' }}>Name</th>
                                        <th style={{ padding: '6px 8px', textAlign: 'center' }}>Maturity</th>
                                        <th style={{ padding: '6px 8px', textAlign: 'center' }}>Yield</th>
                                        <th style={{ padding: '6px 8px', textAlign: 'center' }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {proposals.map(p => (
                                        <tr
                                            key={p.isin}
                                            style={{
                                                borderBottom: '1px solid var(--border-color)',
                                                backgroundColor: selectedIsin === p.isin ? 'rgba(139, 92, 246, 0.1)' : 'transparent',
                                                cursor: 'pointer',
                                            }}
                                            onClick={() => {
                                                setSelectedIsin(p.isin);
                                                setManualIsin('');
                                                setLabel(p.name);
                                                setSource(bond.universe === 'IT' ? 'MOT' : 'ETF');
                                            }}
                                        >
                                            <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: '0.75rem' }}>{p.isin}</td>
                                            <td style={{ padding: '6px 8px' }}>{p.name}</td>
                                            <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.maturityDate || '-'}</td>
                                            <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--color-success)' }}>
                                                {p.yield != null ? `${p.yield.toFixed(2)}%` : '-'}
                                            </td>
                                            <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                                                {selectedIsin === p.isin && <span style={{ color: '#8B5CF6', fontWeight: 600 }}>Selected</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Manual ISIN + fill details */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
                    <div>
                        <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '4px' }}>ISIN {selectedIsin ? '(from proposal)' : '(manual)'}</label>
                        <input
                            type="text"
                            className="form-input"
                            placeholder="e.g. IT0005..."
                            value={selectedIsin || manualIsin}
                            onChange={e => {
                                setManualIsin(e.target.value.toUpperCase());
                                setSelectedIsin('');
                            }}
                        />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '4px' }}>Label</label>
                        <input
                            type="text"
                            className="form-input"
                            placeholder="Bond name"
                            value={label}
                            onChange={e => setLabel(e.target.value)}
                        />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '4px' }}>Quantity</label>
                        <input
                            type="number"
                            className="form-input"
                            placeholder="0"
                            step="any"
                            value={quantity}
                            onChange={e => setQuantity(e.target.value)}
                        />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '4px' }}>Price per unit (EUR)</label>
                        <input
                            type="number"
                            className="form-input"
                            placeholder="0.00"
                            step="any"
                            value={price}
                            onChange={e => setPrice(e.target.value)}
                        />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '4px' }}>Source</label>
                        <select className="form-input" value={source} onChange={e => setSource(e.target.value as 'ETF' | 'MOT')}>
                            <option value="MOT">MOT (Borsa Italiana)</option>
                            <option value="ETF">ETF (JustETF)</option>
                        </select>
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '4px' }}>Broker</label>
                        <select className="form-input" value={brokerId} onChange={e => setBrokerId(e.target.value)}>
                            <option value="">Select...</option>
                            {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                    </div>
                </div>

                <div style={{ marginBottom: 'var(--space-3)' }}>
                    <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '4px' }}>Portfolio</label>
                    <select className="form-input" value={portfolioId} onChange={e => setPortfolioId(e.target.value)}>
                        <option value="">Select...</option>
                        {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                </div>

                <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end', marginTop: 'var(--space-2)' }}>
                    <button className="btn" onClick={onClose}>Cancel</button>
                    <button
                        className="btn btn-primary"
                        onClick={handleConfirm}
                        disabled={!effectiveIsin || !quantity || !price}
                        style={{ backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' }}
                    >
                        Concretizza
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ConcretizeModal;
