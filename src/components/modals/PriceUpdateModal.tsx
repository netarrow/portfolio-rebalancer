import React, { useEffect, useRef } from 'react';
import '../Dashboard/Dashboard.css'; // Reusing common styles

export interface PriceUpdateItem {
    isin: string;
    status: 'pending' | 'processing' | 'success' | 'error';
    price?: number;
    currency?: string;
    error?: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    items: PriceUpdateItem[];
    isComplete: boolean;
}

const PriceUpdateModal: React.FC<Props> = ({ isOpen, onClose, items, isComplete }) => {
    const listRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom as items update
    useEffect(() => {
        if (listRef.current) {
            listRef.current.scrollTop = listRef.current.scrollHeight;
        }
    }, [items]);

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" style={{ zIndex: 1100 }}> {/* Higher z-index than others if needed */}
            <div className="modal-content" style={{ maxWidth: '500px', width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
                <h3 style={{ marginBottom: '1rem', color: 'var(--text-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    Updating Prices
                    {!isComplete && <span className="loader-spinner" style={{ width: '20px', height: '20px', border: '3px solid var(--text-muted)', borderTop: '3px solid var(--color-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></span>}
                </h3>

                <div ref={listRef} style={{ flex: 1, overflowY: 'auto', marginBottom: '1rem', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '0.5rem' }}>
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {items.map((item) => (
                            <li key={item.isin} style={{
                                padding: '0.75rem',
                                borderBottom: '1px solid var(--border-color)',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                backgroundColor: item.status === 'processing' ? 'rgba(var(--color-primary-rgb), 0.05)' : 'transparent'
                            }}>
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{item.isin}</span>
                                    {item.error && <span style={{ fontSize: '0.8rem', color: 'var(--color-danger)' }}>{item.error}</span>}
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    {item.status === 'pending' && <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Pending...</span>}
                                    {item.status === 'processing' && <span style={{ color: 'var(--color-primary)', fontSize: '0.9rem' }}>Fetching...</span>}
                                    {item.status === 'success' && (
                                        <>
                                            <span style={{ fontWeight: 'bold', color: 'var(--color-success)' }}>
                                                {item.price?.toFixed(2)} {item.currency}
                                            </span>
                                            <span style={{ color: 'var(--color-success)' }}>✓</span>
                                        </>
                                    )}
                                    {item.status === 'error' && <span style={{ color: 'var(--color-danger)' }}>✗</span>}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                        className="btn-primary"
                        onClick={onClose}
                        disabled={!isComplete} // Prevent closing until done? Or allow minimizing? User asked for "man mano", implies watching. Let's allow close if they want, but typically wait.
                        style={{
                            padding: '0.5rem 1rem',
                            borderRadius: 'var(--radius-md)',
                            cursor: isComplete ? 'pointer' : 'not-allowed',
                            background: isComplete ? 'var(--color-primary)' : 'var(--text-muted)',
                            color: 'white',
                            border: 'none',
                            opacity: isComplete ? 1 : 0.7
                        }}
                    >
                        {isComplete ? 'Close' : 'Please Wait...'}
                    </button>
                </div>

                {/* Optional styling for spinner if not in global css */}
                <style>{`
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `}</style>
            </div>
        </div>
    );
};

export default PriceUpdateModal;
