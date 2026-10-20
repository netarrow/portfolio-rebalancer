import React, { useState } from 'react';
import { useSecurity } from '../../context/SecurityContext';

const UnlockGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { sleEnabled, isLocked } = useSecurity();

    if (!sleEnabled || !isLocked) {
        return <>{children}</>;
    }
    // The form lives only while locked: each lock starts from an empty field,
    // so the passphrase typed last time is never there again.
    return <UnlockForm />;
};

const UnlockForm: React.FC = () => {
    const { unlock } = useSecurity();
    const [pw, setPw] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const handleUnlock = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!pw || busy) return;
        const attempt = pw;
        // Not kept in state while the key is derived, nor after.
        setPw('');
        setBusy(true);
        setError(null);
        try {
            const ok = await unlock(attempt);
            if (!ok) setError('Wrong passphrase. Try again.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#0f172a', color: '#e2e8f0', zIndex: 9999, padding: '1rem',
        }}>
            <form onSubmit={handleUnlock} autoComplete="off" style={{
                background: '#1e293b', padding: '2rem', borderRadius: '12px', maxWidth: '420px', width: '100%',
                boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
            }}>
                <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem' }}>🔒 Locked</h2>
                <p style={{ margin: '0 0 1.5rem', color: '#94a3b8', fontSize: '0.9rem' }}>
                    Enter your local-encryption passphrase to unlock your portfolio data.
                </p>
                <input
                    type="password"
                    name="sle-passphrase"
                    autoComplete="off"
                    value={pw}
                    autoFocus
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="Passphrase"
                    disabled={busy}
                    style={{
                        width: '100%', padding: '0.75rem', borderRadius: '6px', border: '1px solid #334155',
                        background: '#0f172a', color: '#e2e8f0', fontSize: '1rem', marginBottom: '1rem',
                        boxSizing: 'border-box',
                    }}
                />
                {error && (
                    <div style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</div>
                )}
                <button
                    type="submit"
                    disabled={!pw || busy}
                    style={{
                        width: '100%', padding: '0.75rem', borderRadius: '6px', border: 'none',
                        background: busy ? '#475569' : '#3b82f6', color: 'white', fontSize: '1rem',
                        cursor: busy || !pw ? 'not-allowed' : 'pointer', marginBottom: '0.5rem',
                    }}
                >
                    {busy ? 'Unlocking…' : 'Unlock'}
                </button>
                <div style={{ marginTop: '1rem', textAlign: 'center', color: '#64748b', fontSize: '0.75rem' }}>
                    v{__APP_VERSION__}
                </div>
            </form>
        </div>
    );
};

export default UnlockGate;
