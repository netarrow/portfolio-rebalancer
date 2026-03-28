import React, { useState, useEffect } from 'react';
import type { Goal } from '../../types';

interface GoalFormProps {
    initialData?: Goal | null;
    onSubmit: (data: Omit<Goal, 'id'>) => void;
    onCancel: () => void;
}

const GoalForm: React.FC<GoalFormProps> = ({ initialData, onSubmit, onCancel }) => {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [order, setOrder] = useState(0);

    useEffect(() => {
        if (initialData) {
            setTitle(initialData.title);
            setDescription(initialData.description || '');
            setOrder(initialData.order);
        } else {
            setTitle('');
            setDescription('');
            setOrder(0);
        }
    }, [initialData]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit({ title, description, order });
    };

    return (
        <div className="modal-overlay">
            <div className="modal-content">
                <h3>{initialData ? 'Edit Goal' : 'New Goal'}</h3>
                <form onSubmit={handleSubmit} className="portfolio-form">
                    <div className="form-group">
                        <label htmlFor="goal-title">Title</label>
                        <input
                            type="text"
                            id="goal-title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                            placeholder="e.g., Growth, Protection, Security"
                            className="form-input"
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="goal-description">Description (Optional)</label>
                        <textarea
                            id="goal-description"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Brief description of this goal"
                            className="form-input"
                            rows={3}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="goal-order">Order</label>
                        <input
                            type="number"
                            id="goal-order"
                            value={order}
                            onChange={(e) => setOrder(Number(e.target.value))}
                            required
                            placeholder="Display order (lower = left)"
                            className="form-input"
                        />
                    </div>

                    <div className="form-actions">
                        <button type="button" onClick={onCancel} className="btn btn-secondary">
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary">
                            Save Goal
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default GoalForm;
