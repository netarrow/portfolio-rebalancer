import React, { useMemo } from 'react';
import './Dashboard.css'; // Reusing common dashboard styles

interface Props {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    currentData: Record<string, number>;
    proposedData: Record<string, number>;
    onApply: () => void;
}

const ProposedDistributionModal: React.FC<Props> = ({ isOpen, onClose, title, currentData, proposedData, onApply }) => {
    if (!isOpen) return null;

    // Normalize keys to ensure we show everything relevant
    const allKeys = useMemo(() => {
        return Array.from(new Set([...Object.keys(currentData), ...Object.keys(proposedData)]));
    }, [currentData, proposedData]);

    return (
        <div className="modal-overlay">
            <div className="modal-content" style={{ maxWidth: '600px', width: '90%' }}>
                <h3 style={{ marginBottom: '1.5rem', color: 'var(--text-primary)' }}>{title}</h3>

                <div style={{ maxHeight: '400px', overflowY: 'auto', marginBottom: '1.5rem' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                <th style={{ padding: '0.75rem', color: 'var(--text-secondary)' }}>Category</th>
                                <th style={{ padding: '0.75rem', color: 'var(--text-secondary)', textAlign: 'right' }}>Current Target</th>
                                <th style={{ padding: '0.75rem', color: 'var(--text-secondary)', textAlign: 'right' }}>Proposed Target</th>
                                <th style={{ padding: '0.75rem', color: 'var(--text-secondary)', textAlign: 'right' }}>Change</th>
                            </tr>
                        </thead>
                        <tbody>
                            {allKeys.map(key => {
                                const current = currentData[key] || 0;
                                const proposed = proposedData[key] || 0;
                                const diff = proposed - current;

                                return (
                                    <tr key={key} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                        <td style={{ padding: '0.75rem', fontWeight: 500 }}>{key}</td>
                                        <td style={{ padding: '0.75rem', textAlign: 'right' }}>{current.toFixed(1)}%</td>
                                        <td style={{ padding: '0.75rem', textAlign: 'right', fontWeight: 'bold', color: 'var(--color-primary)' }}>
                                            {proposed.toFixed(1)}%
                                        </td>
                                        <td style={{ padding: '0.75rem', textAlign: 'right', color: diff > 0 ? 'var(--color-success)' : (diff < 0 ? 'var(--color-danger)' : 'var(--text-muted)') }}>
                                            {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
                    <button
                        className="btn-secondary"
                        onClick={onClose}
                        style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
                    >
                        Cancel
                    </button>
                    <button
                        className="btn-primary"
                        onClick={() => { onApply(); onClose(); }}
                        style={{ padding: '0.5rem 1rem', borderRadius: 'var(--radius-md)', cursor: 'pointer', background: 'var(--color-primary)', color: 'white', border: 'none' }}
                    >
                        Apply Proposal
                    </button>
                </div>

                <button
                    className="modal-close-btn"
                    onClick={onClose}
                    style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: 'var(--text-primary)' }}
                >
                    &times;
                </button>
            </div>
        </div>
    );
};

export default ProposedDistributionModal;
