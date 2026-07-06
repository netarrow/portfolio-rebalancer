import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import { parseIsinList, upsertFreeCommissionPeriod, currentMonthKey, formatMonthKey } from '../../utils/freeCommissions';

/**
 * Settings card for broker-specific "free buy" promotions: a button opens a
 * popup where the user pastes free text containing the promo ISIN list and
 * picks the reference month and the broker running the promo. The saved lists
 * drive the free-buy toggle in the rebalancing trade-cost popover and the
 * "missing Free flag?" warning in the transaction list — both only for
 * trades at that broker.
 */
const FreeCommissionCard: React.FC = () => {
    const { freeCommissionPeriods, setFreeCommissionPeriods, brokers } = usePortfolio();
    const [showModal, setShowModal] = useState(false);
    const [monthKey, setMonthKey] = useState(currentMonthKey());
    const [brokerId, setBrokerId] = useState('');
    const [rawText, setRawText] = useState('');

    const brokerName = (id?: string) => {
        if (!id) return 'Any broker';
        return brokers.find(b => b.id === id)?.name ?? 'Deleted broker';
    };

    const openModal = () => {
        setMonthKey(currentMonthKey());
        setBrokerId(brokers.length === 1 ? brokers[0].id : '');
        setRawText('');
        setShowModal(true);
    };

    const handleSave = () => {
        const isins = parseIsinList(rawText);
        if (!monthKey) {
            Swal.fire({ title: 'Pick a month', text: 'Select the month the promotion applies to.', icon: 'warning' });
            return;
        }
        if (!brokerId) {
            Swal.fire({ title: 'Pick a broker', text: 'Promotions are broker-specific: select the broker offering the free buys.', icon: 'warning' });
            return;
        }
        if (isins.length === 0) {
            Swal.fire({ title: 'No ISINs found', text: 'The text does not contain anything that looks like an ISIN (e.g. IE00BK5BQT80).', icon: 'warning' });
            return;
        }
        setFreeCommissionPeriods(prev => upsertFreeCommissionPeriod(prev, monthKey, brokerId, isins));
        setShowModal(false);
        Swal.fire({
            title: 'Saved',
            text: `${isins.length} ISIN${isins.length !== 1 ? 's' : ''} marked as free buy at ${brokerName(brokerId)} for ${formatMonthKey(monthKey)}.`,
            icon: 'success', timer: 2000, showConfirmButton: false,
        });
    };

    const handleDeletePeriod = async (period: { monthKey: string; brokerId?: string }) => {
        const confirm = await Swal.fire({
            title: `Remove ${formatMonthKey(period.monthKey)} — ${brokerName(period.brokerId)}?`,
            text: 'The free-buy list for this month and broker will be deleted.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Remove',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#d33',
        });
        if (!confirm.isConfirmed) return;
        setFreeCommissionPeriods(prev => prev.filter(p => !(p.monthKey === period.monthKey && p.brokerId === period.brokerId)));
    };

    const removeIsin = (period: { monthKey: string; brokerId?: string }, isin: string) => {
        setFreeCommissionPeriods(prev => prev
            .map(p => (p.monthKey === period.monthKey && p.brokerId === period.brokerId)
                ? { ...p, isins: p.isins.filter(i => i !== isin) }
                : p)
            .filter(p => p.isins.length > 0));
    };

    const nowKey = currentMonthKey();

    return (
        <div style={{ marginBottom: '3rem' }}>
            <h2 className="section-title">Free Buy Promotions</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                Paste a broker's monthly list of commission-free ISINs. Rebalancing marks buys of these
                assets as free for the current month at that broker, and the transaction list warns about
                buys that look free but are missing the "Free" flag.
            </p>
            <button
                onClick={openModal}
                style={{
                    padding: '0.6rem 1.2rem',
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--color-primary)',
                    color: 'var(--color-primary)',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    fontWeight: 600,
                    marginBottom: '1rem',
                }}
            >
                + Add free ISIN list
            </button>

            {freeCommissionPeriods.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {freeCommissionPeriods.map(period => (
                        <div
                            key={`${period.monthKey}|${period.brokerId ?? ''}`}
                            style={{
                                border: '1px solid var(--border-color)',
                                borderRadius: 'var(--radius-md)',
                                padding: '0.6rem 0.8rem',
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <strong style={{ fontSize: '0.9rem' }}>
                                    {formatMonthKey(period.monthKey)}
                                    <span style={{ fontWeight: 500, color: 'var(--text-secondary)' }}> — {brokerName(period.brokerId)}</span>
                                    {period.monthKey === nowKey && (
                                        <span style={{
                                            marginLeft: '0.5rem', fontSize: '0.68rem', fontWeight: 700,
                                            color: 'var(--color-success)', border: '1px solid var(--color-success)',
                                            borderRadius: '4px', padding: '1px 5px', verticalAlign: 'middle',
                                        }}>ACTIVE</span>
                                    )}
                                </strong>
                                <button
                                    onClick={() => handleDeletePeriod(period)}
                                    style={{
                                        background: 'transparent', border: '1px solid var(--color-danger)',
                                        color: 'var(--color-danger)', borderRadius: 'var(--radius-sm)',
                                        padding: '2px 8px', fontSize: '0.75rem', cursor: 'pointer', flexShrink: 0,
                                    }}
                                >
                                    Remove
                                </button>
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                                {period.isins.map(isin => (
                                    <span
                                        key={isin}
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                                            fontFamily: 'monospace', fontSize: '0.75rem',
                                            background: 'rgba(16,185,129,0.1)', color: 'var(--text-primary)',
                                            border: '1px solid rgba(16,185,129,0.35)',
                                            borderRadius: '4px', padding: '2px 6px',
                                        }}
                                    >
                                        {isin}
                                        <button
                                            onClick={() => removeIsin(period, isin)}
                                            title={`Remove ${isin}`}
                                            style={{
                                                background: 'none', border: 'none', cursor: 'pointer',
                                                color: 'var(--text-muted)', padding: 0, fontSize: '0.8rem', lineHeight: 1,
                                            }}
                                        >×</button>
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)}>
                    <div
                        className="modal-content"
                        style={{ position: 'relative', width: 'min(480px, 92vw)' }}
                        onClick={e => e.stopPropagation()}
                    >
                        <button
                            className="modal-close-btn"
                            type="button"
                            onClick={() => setShowModal(false)}
                        >×</button>
                        <h3 style={{ marginTop: 0 }}>Free buy ISINs</h3>
                        <div className="form-group">
                            <label htmlFor="free-commission-month">Reference month</label>
                            <input
                                id="free-commission-month"
                                type="month"
                                className="form-input"
                                value={monthKey}
                                onChange={e => setMonthKey(e.target.value)}
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="free-commission-broker">Broker</label>
                            <select
                                id="free-commission-broker"
                                className="form-input"
                                value={brokerId}
                                onChange={e => setBrokerId(e.target.value)}
                            >
                                <option value="">Select broker...</option>
                                {brokers.map(b => (
                                    <option key={b.id} value={b.id}>{b.name}</option>
                                ))}
                            </select>
                            {brokers.length === 0 && (
                                <small style={{ color: 'var(--color-warning, orange)' }}>
                                    No brokers configured — create one in the Brokers tab first.
                                </small>
                            )}
                        </div>
                        <div className="form-group">
                            <label htmlFor="free-commission-text">ISIN list (free text)</label>
                            <textarea
                                id="free-commission-text"
                                className="form-input"
                                rows={7}
                                value={rawText}
                                onChange={e => setRawText(e.target.value)}
                                placeholder={'Paste the broker promo text here — ISINs are extracted automatically.\ne.g. "This month buy IE00BK5BQT80 and LU1829221024 for free"'}
                                style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.8rem' }}
                            />
                            <small style={{ color: 'var(--text-muted)' }}>
                                {parseIsinList(rawText).length} ISIN(s) detected. Saving merges with any list already stored for the month/broker.
                            </small>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                            <button className="btn-primary" onClick={handleSave} style={{ flex: 1 }}>
                                Save
                            </button>
                            <button className="btn-secondary" onClick={() => setShowModal(false)} style={{ flex: 1 }}>
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default FreeCommissionCard;
