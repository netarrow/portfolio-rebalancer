import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';

const maskKey = (key: string) => {
    if (key.length <= 4) return '••••';
    return `${'•'.repeat(Math.max(4, key.length - 4))}${key.slice(-4)}`;
};

const PremiumPriceCard: React.FC = () => {
    const { premiumPriceKey, setPremiumPriceKey } = usePortfolio();
    const [draft, setDraft] = useState('');
    const [reveal, setReveal] = useState(false);

    const active = premiumPriceKey.trim().length > 0;

    const handleSave = async () => {
        const next = draft.trim();
        if (!next) return;
        setPremiumPriceKey(next);
        setDraft('');
        setReveal(false);
        await Swal.fire({
            title: 'Premium key saved',
            text: 'Update Price will now run without limits.',
            icon: 'success',
            timer: 1800,
            showConfirmButton: false,
        });
    };

    const handleRemove = async () => {
        const r = await Swal.fire({
            title: 'Remove Premium key?',
            text: 'Update Price will fall back to the limited free tier (throttled, data up to a day old).',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'Remove',
        });
        if (!r.isConfirmed) return;
        setPremiumPriceKey('');
        setDraft('');
    };

    return (
        <section className="sle-card">
            <header className="sle-card-head">
                <div className="sle-card-icon" aria-hidden>⚡</div>
                <div className="sle-card-titleblock">
                    <h3 className="sle-card-title">Premium Update Price</h3>
                    <span className={`sle-status ${active ? 'sle-status-on' : 'sle-status-off'}`}>
                        <i className="sle-status-dot" />
                        {active ? 'Active' : 'Free tier'}
                    </span>
                </div>
            </header>

            <p className="sle-card-desc">
                Without a Premium key, <b>Update Price</b> runs on a strongly limited free tier: requests share a
                server-wide concurrency cap and prices come from a cache that can be up to a day old. Enter a valid
                Premium key to unlock unlimited, real-time updates. Your key is stored only in this browser and is
                never uploaded with your Azure backup.
            </p>

            <div className="sle-card-body">
                {active && (
                    <div className="ppk-current">
                        <span className="ppk-current-label">Current key</span>
                        <code className="ppk-current-value">{maskKey(premiumPriceKey)}</code>
                    </div>
                )}

                <div className="ppk-input-row">
                    <div className="ppk-input">
                        <input
                            type={reveal ? 'text' : 'password'}
                            value={draft}
                            placeholder={active ? 'Enter a new key to replace' : 'Paste your Premium key'}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
                        />
                        <button
                            type="button"
                            className="ppk-reveal"
                            onClick={() => setReveal((v) => !v)}
                            aria-label={reveal ? 'Hide key' : 'Show key'}
                        >
                            {reveal ? '🙈' : '👁'}
                        </button>
                    </div>
                    <button
                        type="button"
                        className="sle-btn sle-btn-primary"
                        onClick={handleSave}
                        disabled={!draft.trim()}
                    >
                        Save
                    </button>
                    {active && (
                        <button
                            type="button"
                            className="sle-btn sle-btn-danger"
                            onClick={handleRemove}
                        >
                            Remove
                        </button>
                    )}
                </div>
            </div>

            <style>{`
                .ppk-current {
                    display: flex;
                    align-items: center;
                    gap: 0.6rem;
                }
                .ppk-current-label {
                    font-size: 0.78rem;
                    color: var(--text-muted);
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.04em;
                }
                .ppk-current-value {
                    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                    font-size: 0.9rem;
                    color: var(--text-primary);
                    background: var(--bg-surface);
                    border: 1px solid rgba(148, 163, 184, 0.2);
                    border-radius: var(--radius-sm);
                    padding: 0.2rem 0.55rem;
                }
                .ppk-input-row {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: stretch;
                    gap: var(--space-2);
                }
                .ppk-input {
                    position: relative;
                    flex: 1 1 220px;
                    display: flex;
                    align-items: center;
                    background: var(--bg-surface);
                    border: 1px solid rgba(148, 163, 184, 0.2);
                    border-radius: var(--radius-md);
                    transition: border-color 0.15s ease;
                }
                .ppk-input:focus-within { border-color: var(--color-primary); }
                .ppk-input input {
                    flex: 1;
                    background: transparent;
                    border: none;
                    outline: none;
                    color: var(--text-primary);
                    font-size: 0.9rem;
                    padding: 0.55rem 0.4rem 0.55rem 0.75rem;
                }
                .ppk-reveal {
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    font-size: 1rem;
                    padding: 0 0.6rem;
                    opacity: 0.8;
                }
                .ppk-reveal:hover { opacity: 1; }
                @media (max-width: 480px) {
                    .ppk-input-row { flex-direction: column; align-items: stretch; }
                    .ppk-input-row .sle-btn { align-self: stretch; }
                }
            `}</style>
        </section>
    );
};

export default PremiumPriceCard;
