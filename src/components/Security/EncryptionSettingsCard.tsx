import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { useSecurity } from '../../context/SecurityContext';

const cardStyle: React.CSSProperties = {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    padding: '1.25rem',
    marginBottom: '1.5rem',
};

const EncryptionSettingsCard: React.FC = () => {
    const {
        sleEnabled, idleTimeoutMinutes, enableSLE, disableSLE, changePassphrase, setIdleTimeout,
    } = useSecurity();
    const [busy, setBusy] = useState(false);
    const [timeoutDraft, setTimeoutDraft] = useState(idleTimeoutMinutes);

    React.useEffect(() => { setTimeoutDraft(idleTimeoutMinutes); }, [idleTimeoutMinutes]);

    const handleEnable = async () => {
        const first = await Swal.fire({
            title: 'Enable local encryption',
            html: `<p style="text-align:left;font-size:0.9rem">All portfolio data in this browser will be encrypted at rest with a passphrase you choose.</p>
                   <p style="text-align:left;font-size:0.9rem;color:#b45309"><b>Important:</b> if you forget this passphrase you cannot recover your data without an Azure backup.</p>`,
            input: 'password',
            inputLabel: 'Choose a passphrase (min 12 chars)',
            inputAttributes: { autocomplete: 'new-password' },
            showCancelButton: true,
            confirmButtonText: 'Next',
            inputValidator: (v) => {
                if (!v || v.length < 12) return 'Passphrase must be at least 12 characters';
                return null;
            },
        });
        if (!first.isConfirmed || !first.value) return;
        const second = await Swal.fire({
            title: 'Confirm passphrase',
            input: 'password',
            inputLabel: 'Re-enter the same passphrase',
            inputAttributes: { autocomplete: 'new-password' },
            showCancelButton: true,
            inputValidator: (v) => (v === first.value ? null : 'Passphrases do not match'),
        });
        if (!second.isConfirmed) return;
        setBusy(true);
        try {
            await enableSLE(first.value);
            await Swal.fire({ title: 'Encryption enabled', icon: 'success', timer: 1800, showConfirmButton: false });
        } catch (e) {
            await Swal.fire({ title: 'Failed to enable encryption', text: String(e), icon: 'error' });
        } finally {
            setBusy(false);
        }
    };

    const handleDisable = async () => {
        const r = await Swal.fire({
            title: 'Disable local encryption?',
            text: 'Your local data will be readable in plaintext again. Enter your current passphrase to confirm.',
            input: 'password',
            inputLabel: 'Current passphrase',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'Disable',
        });
        if (!r.isConfirmed || !r.value) return;
        setBusy(true);
        try {
            const ok = await disableSLE(r.value);
            if (ok) {
                await Swal.fire({ title: 'Encryption disabled', icon: 'success', timer: 1800, showConfirmButton: false });
            } else {
                await Swal.fire({ title: 'Wrong passphrase', icon: 'error' });
            }
        } finally {
            setBusy(false);
        }
    };

    const handleChangePassphrase = async () => {
        const oldR = await Swal.fire({
            title: 'Change passphrase',
            input: 'password',
            inputLabel: 'Current passphrase',
            showCancelButton: true,
        });
        if (!oldR.isConfirmed || !oldR.value) return;
        const newR = await Swal.fire({
            title: 'New passphrase',
            input: 'password',
            inputLabel: 'New passphrase (min 12 chars)',
            showCancelButton: true,
            inputValidator: (v) => (!v || v.length < 12 ? 'Passphrase must be at least 12 characters' : null),
        });
        if (!newR.isConfirmed || !newR.value) return;
        const confirmR = await Swal.fire({
            title: 'Confirm new passphrase',
            input: 'password',
            showCancelButton: true,
            inputValidator: (v) => (v === newR.value ? null : 'Passphrases do not match'),
        });
        if (!confirmR.isConfirmed) return;
        setBusy(true);
        try {
            const ok = await changePassphrase(oldR.value, newR.value);
            if (ok) {
                await Swal.fire({ title: 'Passphrase updated', icon: 'success', timer: 1800, showConfirmButton: false });
            } else {
                await Swal.fire({ title: 'Wrong current passphrase', icon: 'error' });
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={cardStyle}>
            <h3 style={{ marginTop: 0, color: '#0f172a' }}>🔒 Local data encryption</h3>
            <p style={{ fontSize: '0.9rem', color: '#475569', marginTop: 0 }}>
                Optional second-layer encryption for all data stored in this browser (transactions, portfolios,
                YNAB API key, Azure passphrase, …). When enabled, the app asks for your passphrase at every load.
                The encrypted blob you upload to Azure uses its own separate passphrase and is unaffected.
            </p>

            {!sleEnabled && (
                <button
                    onClick={handleEnable}
                    disabled={busy}
                    style={{
                        padding: '0.6rem 1.2rem', borderRadius: '6px', border: 'none',
                        background: '#3b82f6', color: 'white', cursor: busy ? 'wait' : 'pointer',
                    }}
                >
                    Enable encryption
                </button>
            )}

            {sleEnabled && (
                <>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                        <button
                            onClick={handleChangePassphrase}
                            disabled={busy}
                            style={{
                                padding: '0.5rem 1rem', borderRadius: '6px', border: '1px solid #cbd5e1',
                                background: 'white', cursor: busy ? 'wait' : 'pointer',
                            }}
                        >
                            Change passphrase
                        </button>
                        <button
                            onClick={handleDisable}
                            disabled={busy}
                            style={{
                                padding: '0.5rem 1rem', borderRadius: '6px', border: '1px solid #fca5a5',
                                background: 'white', color: '#b91c1c', cursor: busy ? 'wait' : 'pointer',
                            }}
                        >
                            Disable encryption
                        </button>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.9rem' }}>
                        <span>Auto-lock after</span>
                        <input
                            type="number"
                            min={1}
                            max={120}
                            value={timeoutDraft}
                            onChange={(e) => setTimeoutDraft(Number(e.target.value) || 1)}
                            onBlur={() => setIdleTimeout(timeoutDraft)}
                            style={{
                                width: '70px', padding: '0.3rem', borderRadius: '4px',
                                border: '1px solid #cbd5e1',
                            }}
                        />
                        <span>minutes of inactivity</span>
                    </label>
                </>
            )}
        </div>
    );
};

export default EncryptionSettingsCard;
