import React, { useEffect, useMemo, useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import { fetchBondProposals } from '../../services/bondProposals';
import { BOND_LOT_NOMINAL } from '../../utils/amountTargets';
import { monthsUntil } from '../../utils/ynabCoverage';
import { rankCapexBonds } from '../../utils/bondRanking';
import type { BondProposal, BondUniverse, YnabGoal } from '../../types';

interface Props {
    goal: YnabGoal;
    /** What the capex still misses: target − cash − invested. */
    gap: number;
    currencyIso: string;
    onClose: () => void;
}

const eur = (v: number, iso: string) =>
    v.toLocaleString('en-IE', { style: 'currency', currency: iso, maximumFractionDigits: 0 });

/**
 * Find a bond maturing just before a planned capex, for the part it still
 * misses, and plan it as a virtual bond in a € target portfolio: the capex
 * gets an allocation pinned to the new bond, so the portfolio's target (and
 * Asset Allocation) count it from now on. The bond is bought later with
 * "Concretize", as any virtual bond.
 */
const CapexBondModal: React.FC<Props> = ({ goal, gap, currencyIso, onClose }) => {
    const { portfolios, ynabGoalAllocations, virtualBonds, addVirtualBond, addAllocation } = usePortfolio();
    // Bonds already planned for this capex and not bought yet: their amount is
    // still part of the gap, so it is not proposed a second time.
    const planned = ynabGoalAllocations
        .filter(a => a.ynabGoalId === goal.id && a.ticker?.startsWith('_VBOND_'))
        .map(a => ({ a, vb: virtualBonds.find(b => `_VBOND_${b.id}` === a.ticker) }))
        .filter(x => x.vb && !x.vb.resolvedIsin);
    const plannedTotal = planned.reduce((s, x) => s + x.a.amount, 0);
    const toPlan = Math.max(0, gap - plannedTotal);
    const [universe, setUniverse] = useState<BondUniverse>('IT');
    const [minMonths, setMinMonths] = useState(1);
    const [maxMonths, setMaxMonths] = useState(6);
    // Proposals of the last search answered, keyed by its parameters: a search
    // still running shows as loading until its key matches.
    const [found, setFound] = useState<{ key: string; list: BondProposal[] }>({ key: '', list: [] });
    // null = not picked yet: the best fit is preselected.
    const [pickedIsin, setPickedIsin] = useState<string | null>(null);
    const [amount, setAmount] = useState(String(Math.round(toPlan)));

    // Only € target portfolios: there a capex allocation pinned to a row sets
    // that row's target, which is what planning a bond means.
    const amountPortfolios = portfolios.filter(p => p.targetMode === 'amount');
    const usual = ynabGoalAllocations.find(a => a.ynabGoalId === goal.id && amountPortfolios.some(p => p.id === a.portfolioId))?.portfolioId;
    const [portfolioId, setPortfolioId] = useState(usual ?? amountPortfolios[0]?.id ?? '');

    const date = goal.targetDate;
    const searchKey = `${date}|${universe}|${minMonths}|${maxMonths}`;
    useEffect(() => {
        if (!date) return;
        let cancelled = false;
        fetchBondProposals({ targetDate: date.slice(0, 10), universe, minMonthsBefore: minMonths, maxMonthsBefore: maxMonths })
            .then(list => { if (!cancelled) setFound({ key: searchKey, list }); });
        return () => { cancelled = true; };
    }, [date, universe, minMonths, maxMonths, searchKey]);
    const loading = found.key !== searchKey;
    const proposals = loading ? [] : found.list;

    // Nearest to the capex date first: the latest maturity still before it.
    // Below par, low coupon, redeemed at 100 first; zero-coupon and
    // inflation-linked last.
    const ranked = useMemo(() => rankCapexBonds(proposals), [proposals]);
    const selectedIsin = pickedIsin ?? (ranked[0]?.fit === 0 ? ranked[0].bond.isin : '');
    const selected = ranked.find(r => r.bond.isin === selectedIsin)?.bond;
    const amountNum = Math.max(0, Number(amount) || 0);
    const nominal = Math.ceil(amountNum / BOND_LOT_NOMINAL) * BOND_LOT_NOMINAL;

    const plan = () => {
        if (!date || !portfolioId || amountNum <= 0) return;
        const id = crypto.randomUUID();
        addVirtualBond({
            id,
            label: selected ? `${goal.name} · ${selected.name}` : `${goal.name} bond`,
            targetMaturityDate: (selected?.maturityDate ?? date).slice(0, 10),
            universe,
            minMonthsBefore: minMonths,
            maxMonthsBefore: maxMonths,
            createdAt: new Date().toISOString(),
        });
        const res = addAllocation({ portfolioId, ynabGoalId: goal.id, amount: amountNum, ticker: `_VBOND_${id}` });
        if (!res.ok) {
            Swal.fire({ title: 'Could not plan the bond', text: res.error, icon: 'error' });
            return;
        }
        const pName = portfolios.find(p => p.id === portfolioId)?.name ?? portfolioId;
        Swal.fire({
            title: 'Bond planned',
            html: `${eur(amountNum, currencyIso)} of <strong>${goal.name}</strong> now targets a bond in <strong>${pName}</strong>${selected ? ` (${selected.isin})` : ''}. Buy it with Concretize when ready.`,
            icon: 'success',
        });
        onClose();
    };

    return (
        <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={onClose}>
            <div className="modal-content cbm" onClick={e => e.stopPropagation()}>
                <div className="cbm-head">
                    <h3 style={{ margin: 0 }}>Find a bond for {goal.name}</h3>
                    <button type="button" className="cbm-close" onClick={onClose} aria-label="Close">&times;</button>
                </div>

                {!date ? (
                    <p className="cbm-muted">This capex has no target date: set one to look for a bond maturing before it.</p>
                ) : (
                    <>
                        <div className="cbm-facts">
                            <div><span>Due</span><strong>{date.slice(0, 10)}</strong></div>
                            <div><span>Target</span><strong>{goal.targetAmount != null ? eur(goal.targetAmount, currencyIso) : '—'}</strong></div>
                            <div><span>Still missing</span><strong>{eur(gap, currencyIso)}</strong></div>
                            {plannedTotal > 0 && <div><span>Left to plan</span><strong>{eur(toPlan, currencyIso)}</strong></div>}
                        </div>
                        {planned.length > 0 && (
                            <div className="cbm-muted">
                                Already planned, not bought yet:{' '}
                                {planned.map(x => `${eur(x.a.amount, currencyIso)} ${x.vb!.label} (${portfolios.find(p => p.id === x.a.portfolioId)?.name ?? x.a.portfolioId})`).join(' · ')}
                            </div>
                        )}

                        <div className="cbm-filters">
                            <label>Market
                                <select className="form-select" value={universe} onChange={e => setUniverse(e.target.value as BondUniverse)}>
                                    <option value="IT">Italy</option>
                                    <option value="EU">Europe</option>
                                </select>
                            </label>
                            <label>Maturing between
                                <span className="cbm-range">
                                    <input type="number" className="form-input" min={0} max={36} value={maxMonths} onChange={e => setMaxMonths(Math.max(minMonths, Number(e.target.value) || 0))} />
                                    and
                                    <input type="number" className="form-input" min={0} max={36} value={minMonths} onChange={e => setMinMonths(Math.min(maxMonths, Number(e.target.value) || 0))} />
                                    months before
                                </span>
                            </label>
                        </div>

                        <p className="cbm-hint">★ first: bonds below par that redeem at 100, lowest coupon first (most of the return comes from the pull to 100). Zero-coupon, inflation-linked and non-EUR bonds go last.</p>
                        <div className="cbm-list">
                            {loading ? (
                                <p className="cbm-muted">Looking for bonds…</p>
                            ) : ranked.length === 0 ? (
                                <p className="cbm-muted">No bond found in that window. Widen it, or plan a generic bond for the date.</p>
                            ) : (
                                <table>
                                    <thead><tr><th /><th>Bond</th><th>Maturity</th><th className="num">Price</th><th className="num">Coupon</th><th className="num">Yield</th></tr></thead>
                                    <tbody>
                                        {ranked.map(({ bond: p, fit, tags }) => (
                                            <tr key={p.isin} className={`${p.isin === selectedIsin ? 'sel' : ''} fit-${fit}`} onClick={() => setPickedIsin(p.isin === selectedIsin ? '' : p.isin)}>
                                                <td><input type="radio" readOnly checked={p.isin === selectedIsin} aria-label={`Pick ${p.name}`} /></td>
                                                <td>
                                                    <div>{fit === 0 && <span className="cbm-star" title="Below par, redeemed at 100, coupon: preferred">★ </span>}{p.name}</div>
                                                    <small>{p.isin}{tags.length > 0 && <> · {tags.join(' · ')}</>}</small>
                                                </td>
                                                <td>{p.maturityDate.slice(0, 10)}<small> · {monthsUntil(p.maturityDate, date)}m before</small></td>
                                                <td className="num">{p.price != null ? p.price.toFixed(2) : '—'}</td>
                                                <td className="num">{p.zeroCoupon ? 'ZC' : p.coupon != null ? `${p.coupon.toFixed(2)}%` : '—'}</td>
                                                <td className="num">{p.yield != null ? `${p.yield.toFixed(2)}%` : '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>

                        <div className="cbm-plan">
                            <label>Amount
                                <input type="number" className="form-input" min={0} value={amount} onChange={e => setAmount(e.target.value)} />
                                <small>{amountNum > 0 ? `≈ ${nominal / BOND_LOT_NOMINAL} lot${nominal / BOND_LOT_NOMINAL === 1 ? '' : 's'} of €${BOND_LOT_NOMINAL.toLocaleString('en-IE')} nominal` : ''}</small>
                            </label>
                            <label>Portfolio
                                {amountPortfolios.length === 0 ? (
                                    <small className="cbm-warn">No portfolio uses € targets: switch one to € targets on the Portfolios page to plan bonds there.</small>
                                ) : (
                                    <select className="form-select" value={portfolioId} onChange={e => setPortfolioId(e.target.value)}>
                                        {amountPortfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                    </select>
                                )}
                            </label>
                        </div>

                        <div className="cbm-actions">
                            <button type="button" className="btn" onClick={onClose}>Cancel</button>
                            <button type="button" className="btn btn-primary" onClick={plan} disabled={!portfolioId || amountNum <= 0}>
                                {selected ? `Plan ${selected.isin}` : 'Plan a bond for the date'}
                            </button>
                        </div>
                    </>
                )}

                <style>{`
                    .cbm { max-width: 720px; width: 95%; max-height: 88vh; overflow-y: auto; display: flex; flex-direction: column; gap: 1rem; }
                    .cbm-head { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
                    .cbm-close { background: none; border: 0; font-size: 1.5rem; cursor: pointer; color: var(--text-secondary); }
                    .cbm-muted { color: var(--text-secondary); margin: 0; font-size: 0.9rem; }
                    .cbm-warn { color: var(--color-warning, #f59e0b); }
                    .cbm-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.5rem; }
                    .cbm-facts div { background: var(--bg-input); border-radius: var(--radius-md); padding: 0.5rem 0.75rem; display: flex; flex-direction: column; }
                    .cbm-facts span { font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; }
                    .cbm-filters, .cbm-plan { display: flex; gap: 1rem; flex-wrap: wrap; }
                    .cbm-filters label, .cbm-plan label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-secondary); }
                    .cbm-range { display: flex; align-items: center; gap: 0.4rem; color: var(--text-secondary); }
                    .cbm-range input { width: 4.5rem; }
                    .cbm-list { border: 1px solid var(--border-color); border-radius: var(--radius-md); max-height: 260px; overflow-y: auto; }
                    .cbm-list table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
                    .cbm-list th { position: sticky; top: 0; background: var(--bg-card); text-align: left; padding: 0.4rem 0.6rem; font-size: 0.75rem; color: var(--text-secondary); }
                    .cbm-list td { padding: 0.4rem 0.6rem; border-top: 1px solid var(--border-color); vertical-align: top; }
                    .cbm-list td small { color: var(--text-secondary); }
                    .cbm-list tr { cursor: pointer; }
                    .cbm-list tr.sel td { background: color-mix(in srgb, var(--color-primary) 18%, transparent); }
                    .cbm-list .num { text-align: right; }
                    .cbm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
                    .cbm-star { color: #f59e0b; }
                    .cbm-list tr.fit-2 td { opacity: 0.6; }
                    .cbm-hint { font-size: 0.8rem; color: var(--text-secondary); margin: 0; }
                `}</style>
            </div>
        </div>
    );
};

export default CapexBondModal;
