import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { useSecurity } from '../../context/SecurityContext';

const UnlockGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { sleEnabled, isLocked, unlock, wipeLocalData } = useSecurity();
    const [pw, setPw] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    if (!sleEnabled || !isLocked) {
        return <>{children}</>;
    }

    const handleUnlock = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!pw || busy) return;
        setBusy(true);
        setError(null);
        try {
            const ok = await unlock(pw);
            if (!ok) {
                setError('Wrong passphrase. Try again or wipe local data to start over.');
                setPw('');
            }
        } finally {
            setBusy(false);
        }
    };

    const handleWipe = async () => {
        const confirm1 = await Swal.fire({
            title: 'Wipe all local data?',
            text: 'This will erase every portfolio_* entry from this browser. If you have an Azure backup you can restore it after re-entering the app.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Continue',
            confirmButtonColor: '#d33',
        });
        if (!confirm1.isConfirmed) return;
        const confirm2 = await Swal.fire({
            title: 'Are you absolutely sure?',
            input: 'text',
            inputLabel: 'Type WIPE to confirm',
            inputPlaceholder: 'WIPE',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            inputValidator: (v) => (v === 'WIPE' ? null : 'You must type WIPE exactly'),
        });
        if (!confirm2.isConfirmed) return;
        wipeLocalData();
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#0f172a', color: '#e2e8f0', zIndex: 9999, padding: '1rem',
        }}>
            <form onSubmit={handleUnlock} style={{
                background: '#1e293b', padding: '2rem', borderRadius: '12px', maxWidth: '420px', width: '100%',
                boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
            }}>
                <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem' }}>🔒 Locked</h2>
                <p style={{ margin: '0 0 1.5rem', color: '#94a3b8', fontSize: '0.9rem' }}>
                    Enter your local-encryption passphrase to unlock your portfolio data.
                </p>
                <input
                    type="password"
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
                <button
                    type="button"
                    onClick={handleWipe}
                    disabled={busy}
                    style={{
                        width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #475569',
                        background: 'transparent', color: '#94a3b8', fontSize: '0.85rem', cursor: 'pointer',
                    }}
                >
                    Reset &amp; wipe local data
                </button>
            </form>
        </div>
    );
};

export default UnlockGate;
