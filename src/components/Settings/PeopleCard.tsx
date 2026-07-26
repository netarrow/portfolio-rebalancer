import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';

// Household members. A broker marked "Personal" can be attributed to one of
// them, which is what lets the counting views filter as "person A + family",
// "only person B", and so on.
const PeopleCard: React.FC = () => {
    const { people, brokers, addPerson, renamePerson, deletePerson } = usePortfolio();
    const [newName, setNewName] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingName, setEditingName] = useState('');

    const brokerCount = (personId: string) =>
        brokers.filter(b => !b.familyAsset && b.ownerId === personId).length;

    const handleAdd = () => {
        const trimmed = newName.trim();
        if (!trimmed) return;
        if (people.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
            Swal.fire({ title: 'Name already used', text: `"${trimmed}" is already in the list.`, icon: 'warning' });
            return;
        }
        addPerson(trimmed);
        setNewName('');
    };

    const startEditing = (id: string, name: string) => {
        setEditingId(id);
        setEditingName(name);
    };

    const commitEditing = () => {
        if (editingId && editingName.trim()) renamePerson(editingId, editingName);
        setEditingId(null);
        setEditingName('');
    };

    const handleDelete = async (id: string, name: string) => {
        const count = brokerCount(id);
        const confirm = await Swal.fire({
            title: `Delete ${name}?`,
            text: count > 0
                ? `${count} broker${count === 1 ? '' : 's'} will stay personal but without a person, so they are always counted.`
                : 'No broker references this person.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Delete',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#d33',
        });
        if (!confirm.isConfirmed) return;
        deletePerson(id);
    };

    return (
        <div style={{ marginBottom: '3rem' }}>
            <h2 className="section-title">People</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                Members of your household. In the broker form, a "Personal" broker can be attributed to one of
                them; the counting-scope chips then let you look at the portfolio per person (e.g. "A + family",
                "only A"). Personal brokers with no person assigned are always counted.
            </p>

            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                <input
                    type="text"
                    className="form-input"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
                    placeholder="e.g. Marco"
                    style={{ flex: 1, minWidth: '200px' }}
                />
                <button
                    onClick={handleAdd}
                    disabled={!newName.trim()}
                    style={{
                        padding: '0.6rem 1.2rem',
                        backgroundColor: 'var(--bg-card)',
                        border: '1px solid var(--color-primary)',
                        color: 'var(--color-primary)',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                        fontWeight: 600,
                    }}
                >
                    + Add person
                </button>
            </div>

            {people.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No people yet.</p>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {people.map(person => {
                        const count = brokerCount(person.id);
                        return (
                            <div
                                key={person.id}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
                                    border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
                                    padding: '0.5rem 0.75rem',
                                }}
                            >
                                {editingId === person.id ? (
                                    <input
                                        type="text"
                                        className="form-input"
                                        value={editingName}
                                        autoFocus
                                        onChange={e => setEditingName(e.target.value)}
                                        onBlur={commitEditing}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') { e.preventDefault(); commitEditing(); }
                                            if (e.key === 'Escape') { setEditingId(null); setEditingName(''); }
                                        }}
                                        style={{ flex: 1, minWidth: '160px' }}
                                    />
                                ) : (
                                    <strong style={{ flex: 1, minWidth: '160px', fontSize: '0.95rem' }}>
                                        👤 {person.name}
                                        <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
                                            {count} broker{count === 1 ? '' : 's'}
                                        </span>
                                    </strong>
                                )}
                                <button
                                    onClick={() => startEditing(person.id, person.name)}
                                    style={{
                                        background: 'transparent', border: '1px solid var(--border-color)',
                                        color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)',
                                        padding: '2px 8px', fontSize: '0.75rem', cursor: 'pointer',
                                    }}
                                >
                                    Rename
                                </button>
                                <button
                                    onClick={() => handleDelete(person.id, person.name)}
                                    style={{
                                        background: 'transparent', border: '1px solid var(--color-danger)',
                                        color: 'var(--color-danger)', borderRadius: 'var(--radius-sm)',
                                        padding: '2px 8px', fontSize: '0.75rem', cursor: 'pointer',
                                    }}
                                >
                                    Delete
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default PeopleCard;
