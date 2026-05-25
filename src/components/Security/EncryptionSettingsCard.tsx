import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { useSecurity } from '../../context/SecurityContext';

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
            inputLabel: 'Choose a passphrase',
            inputAttributes: { autocomplete: 'new-password' },
            showCancelButton: true,
            confirmButtonText: 'Next',
            inputValidator: (v) => (v ? null : 'Passphrase is required'),
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
            inputLabel: 'New passphrase',
            showCancelButton: true,
            inputValidator: (v) => (v ? null : 'Passphrase is required'),
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
        <section className="sle-card">
            <header className="sle-card-head">
                <div className="sle-card-icon" aria-hidden>🔒</div>
                <div className="sle-card-titleblock">
                    <h3 className="sle-card-title">Local data encryption</h3>
                    <span className={`sle-status ${sleEnabled ? 'sle-status-on' : 'sle-status-off'}`}>
                        <i className="sle-status-dot" />
                        {sleEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                </div>
            </header>

            <p className="sle-card-desc">
                Optional second-layer encryption for all data stored in this browser (transactions, portfolios,
                YNAB API key, Azure passphrase, …). When enabled, the app asks for your passphrase at every load.
                The encrypted blob you upload to Azure uses its own separate passphrase and is unaffected.
            </p>

            <div className="sle-card-body">
                {!sleEnabled && (
                    <button
                        onClick={handleEnable}
                        disabled={busy}
                        className="sle-btn sle-btn-primary"
                    >
                        Enable encryption
                    </button>
                )}

                {sleEnabled && (
                    <>
                        <div className="sle-actions">
                            <button
                                onClick={handleChangePassphrase}
                                disabled={busy}
                                className="sle-btn sle-btn-secondary"
                            >
                                Change passphrase
                            </button>
                            <button
                                onClick={handleDisable}
                                disabled={busy}
                                className="sle-btn sle-btn-danger"
                            >
                                Disable encryption
                            </button>
                        </div>

                        <div className="sle-divider" />

                        <div className="sle-timeout">
                            <div className="sle-timeout-text">
                                <span className="sle-timeout-label">Auto-lock</span>
                                <span className="sle-timeout-help">Lock the app after a period of inactivity.</span>
                            </div>
                            <div className="sle-timeout-input">
                                <input
                                    type="number"
                                    min={1}
                                    max={120}
                                    value={timeoutDraft}
                                    onChange={(e) => setTimeoutDraft(Number(e.target.value) || 1)}
                                    onBlur={() => setIdleTimeout(timeoutDraft)}
                                />
                                <span>min</span>
                            </div>
                        </div>
                    </>
                )}
            </div>

            <style>{`
                .sle-card {
                    background: var(--bg-card);
                    border-radius: var(--radius-xl);
                    padding: var(--space-6);
                    margin-bottom: var(--space-6);
                    box-shadow: var(--shadow-md);
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-4);
                }
                .sle-card-head {
                    display: flex;
                    align-items: center;
                    gap: var(--space-3);
                }
                .sle-card-icon {
                    width: 2.5rem;
                    height: 2.5rem;
                    flex-shrink: 0;
                    border-radius: var(--radius-md);
                    background: rgba(99, 102, 241, 0.15);
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.25rem;
                }
                .sle-card-titleblock {
                    display: flex;
                    flex-direction: column;
                    gap: 0.15rem;
                    min-width: 0;
                }
                .sle-card-title {
                    margin: 0;
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: var(--text-primary);
                    letter-spacing: -0.01em;
                }
                .sle-status {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.4rem;
                    font-size: 0.75rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                }
                .sle-status-dot {
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    display: inline-block;
                }
                .sle-status-on { color: var(--color-success); }
                .sle-status-on .sle-status-dot {
                    background: var(--color-success);
                    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18);
                }
                .sle-status-off { color: var(--text-muted); }
                .sle-status-off .sle-status-dot { background: var(--text-muted); }

                .sle-card-desc {
                    margin: 0;
                    font-size: 0.875rem;
                    line-height: 1.55;
                    color: var(--text-secondary);
                }
                .sle-card-body {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-4);
                }
                .sle-actions {
                    display: flex;
                    flex-wrap: wrap;
                    gap: var(--space-2);
                }
                .sle-btn {
                    padding: 0.55rem 1.1rem;
                    border-radius: var(--radius-md);
                    font-size: 0.875rem;
                    font-weight: 600;
                    cursor: pointer;
                    border: 1px solid transparent;
                    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.05s ease;
                    line-height: 1.2;
                }
                .sle-btn:disabled { opacity: 0.55; cursor: wait; }
                .sle-btn:active:not(:disabled) { transform: translateY(1px); }

                .sle-btn-primary {
                    background: var(--color-primary);
                    color: white;
                    align-self: flex-start;
                }
                .sle-btn-primary:hover:not(:disabled) {
                    background: var(--color-primary-hover);
                }
                .sle-btn-secondary {
                    background: var(--bg-surface);
                    color: var(--text-primary);
                    border-color: rgba(148, 163, 184, 0.2);
                }
                .sle-btn-secondary:hover:not(:disabled) {
                    border-color: var(--color-primary);
                    color: var(--color-primary);
                }
                .sle-btn-danger {
                    background: transparent;
                    color: var(--color-danger);
                    border-color: rgba(239, 68, 68, 0.4);
                }
                .sle-btn-danger:hover:not(:disabled) {
                    background: rgba(239, 68, 68, 0.12);
                    border-color: var(--color-danger);
                }

                .sle-divider {
                    height: 1px;
                    background: rgba(148, 163, 184, 0.15);
                    margin: 0;
                }

                .sle-timeout {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: var(--space-4);
                    flex-wrap: wrap;
                }
                .sle-timeout-text {
                    display: flex;
                    flex-direction: column;
                    gap: 0.15rem;
                }
                .sle-timeout-label {
                    font-size: 0.875rem;
                    font-weight: 600;
                    color: var(--text-primary);
                }
                .sle-timeout-help {
                    font-size: 0.78rem;
                    color: var(--text-muted);
                }
                .sle-timeout-input {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    background: var(--bg-surface);
                    border: 1px solid rgba(148, 163, 184, 0.2);
                    border-radius: var(--radius-md);
                    padding: 0.3rem 0.6rem 0.3rem 0.75rem;
                    transition: border-color 0.15s ease;
                }
                .sle-timeout-input:focus-within {
                    border-color: var(--color-primary);
                }
                .sle-timeout-input input {
                    width: 3rem;
                    background: transparent;
                    border: none;
                    color: var(--text-primary);
                    font-size: 0.9rem;
                    font-weight: 600;
                    font-variant-numeric: tabular-nums;
                    padding: 0;
                    text-align: right;
                    outline: none;
                    -moz-appearance: textfield;
                }
                .sle-timeout-input input::-webkit-outer-spin-button,
                .sle-timeout-input input::-webkit-inner-spin-button {
                    -webkit-appearance: none;
                    margin: 0;
                }
                .sle-timeout-input span {
                    font-size: 0.78rem;
                    color: var(--text-muted);
                    font-weight: 500;
                }

                @media (max-width: 480px) {
                    .sle-actions { flex-direction: column; align-items: stretch; }
                    .sle-btn-primary { align-self: stretch; }
                }
            `}</style>
        </section>
    );
};

export default EncryptionSettingsCard;
