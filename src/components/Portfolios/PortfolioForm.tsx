import React, { useState, useEffect } from 'react';
import type { Portfolio } from '../../types';

interface PortfolioFormProps {
    initialData?: Portfolio | null;
    onSubmit: (data: Omit<Portfolio, 'id'>) => void;
    onCancel: () => void;
}

const PortfolioForm: React.FC<PortfolioFormProps> = ({ initialData, onSubmit, onCancel }) => {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');

    useEffect(() => {
        if (initialData) {
            setName(initialData.name);
            setDescription(initialData.description || '');
        } else {
            setName('');
            setDescription('');
        }
    }, [initialData]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit({
            name,
            description
        });
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content">
                <h3>{initialData ? 'Edit Portfolio' : 'New Portfolio'}</h3>
                <form onSubmit={handleSubmit} className="portfolio-form">
                    <div className="form-group">
                        <label htmlFor="name">Portfolio Name</label>
                        <input
                            type="text"
                            id="name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            required
                            placeholder="e.g., Retirement, Kids Savings"
                            className="form-input"
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="description">Description (Optional)</label>
                        <textarea
                            id="description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Brief description of this portfolio's goal"
                            className="form-input"
                            rows={3}
                        />
                    </div>

                    <div className="form-actions">
                        <button type="button" onClick={onCancel} className="btn btn-secondary">
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary">
                            Save Portfolio
                        </button>
                    </div>
                </form>
            </div>

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
                    border: 1px solid var(--bg-card);
                    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                }

                .modal-content h3 {
                    margin-top: 0;
                    margin-bottom: var(--space-4);
                    font-size: 1.25rem;
                    color: var(--text-primary);
                }

                .portfolio-form {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-4);
                }

                .form-group {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
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

export default PortfolioForm;
