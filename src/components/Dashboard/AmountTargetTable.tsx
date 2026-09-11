import React, { useMemo, useState } from 'react';
import type { Portfolio, Transaction, AssetDefinition, Broker, VirtualBond } from '../../types';
import { isVirtualBondTicker, getVirtualBondId } from '../../types';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets, isCashTicker, isGroupKey } from '../../utils/portfolioCalculations';
import { resolveGroups, memberInfoFromAssets, buyRecipientOf, distributeGroupDelta } from '../../utils/allocationGroups';
import { resolveAmountTargets, planAmountBuys, lotUnitsFor, BOND_LOT_NOMINAL, type AmountPlanUnit, type AmountPlanLine } from '../../utils/amountTargets';
import ConcretizeModal from '../modals/ConcretizeModal';

const eur0 = (n: number) => `€${n.toLocaleString('en-IE', { maximumFractionDigits: 0 })}`;
const eur2 = (n: number) => `€${n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso?: string) => iso
    ? new Date(iso).toLocaleDateString('en-IE', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';

interface Props {
    portfolio: Portfolio;
    allTransactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    brokers: Broker[];
    onUpdatePortfolio: (portfolio: Portfolio) => void;
    onAddTransactions: (transactions: Transaction[]) => void;
    /** The portfolio's broker selector, rendered by the dashboard. */
    brokerPicker?: React.ReactNode;
}

const STATUS_TEXT: Record<AmountPlanLine['status'], string> = {
    covered: '✓ covered',
    funded: 'funded',
    partial: 'partial — cash ran out',
    unfunded: 'waiting for cash',
    'below-lot': 'gap under ½ lot',
    'no-price': 'no price',
};

const STATUS_COLOR: Record<AmountPlanLine['status'], string> = {
    covered: 'var(--color-success)',
    funded: 'var(--color-success)',
    partial: 'var(--color-warning)',
    unfunded: 'var(--text-muted)',
    'below-lot': 'var(--text-muted)',
    'no-price': 'var(--color-danger)',
};

/**
 * Rebalancing table for an amount-mode portfolio: one row per € target, sorted
 * by due date, showing how much is missing and what the Liquidity buys toward
 * it. No sell ever appears — see utils/amountTargets.
 */
const AmountTargetTable: React.FC<Props> = ({ portfolio, allTransactions, assetSettings, marketData, brokers, onUpdatePortfolio, onAddTransactions, brokerPicker }) => {
    const { ynabGoals, ynabGoalAllocations, virtualBonds, portfolios, concretizeVirtualBond } = usePortfolio();
    const [concretizing, setConcretizing] = useState<{ bond: VirtualBond; target: number; parked: number } | null>(null);

    const portfolioTxs = useMemo(() => allTransactions.filter(t => t.portfolioId === portfolio.id), [allTransactions, portfolio.id]);
    const { assets, summary } = useMemo(() => calculateAssets(portfolioTxs, assetSettings, marketData), [portfolioTxs, assetSettings, marketData]);

    const rows = useMemo(
        () => resolveAmountTargets(portfolio, ynabGoalAllocations, ynabGoals, virtualBonds),
        [portfolio, ynabGoalAllocations, ynabGoals, virtualBonds]
    );
    const { groupById, tickerToGroupId } = useMemo(() => resolveGroups(portfolio), [portfolio]);
    const liquidity = portfolio.liquidity || 0;
    const brokerCash = brokers.reduce((s, b) => s + (b.liquidityAllocations?.[portfolio.id] || 0), 0);

    const findAsset = (ticker: string) => assets.find(a =>
        isVirtualBondTicker(ticker) ? a.ticker === ticker : a.ticker.toUpperCase() === ticker.toUpperCase());

    // One planning unit per row: a group is priced at the member its buys go to.
    const units = useMemo(() => rows.map((r, order) => {
        const group = groupById[r.key];
        if (group) {
            const memberInfo = memberInfoFromAssets(group.members, assets, marketData);
            const currentValue = Object.values(memberInfo).reduce((s, mi) => s + mi.currentValue, 0);
            const pick = buyRecipientOf(group, memberInfo);
            const price = pick?.price || 0;
            return {
                unit: { key: r.key, price, currentValue, target: r.target, dueDate: r.dueDate, lotUnits: pick ? lotUnitsFor(pick.ticker, price, assetSettings) : 1, order } as AmountPlanUnit,
                memberInfo,
            };
        }
        const asset = findAsset(r.key);
        const price = isVirtualBondTicker(r.key) ? 1 : (asset?.currentPrice || marketData[r.key.toUpperCase()]?.price || 0);
        return {
            unit: { key: r.key, price, currentValue: asset?.currentValue || 0, target: r.target, dueDate: r.dueDate, lotUnits: lotUnitsFor(r.key, price, assetSettings), order } as AmountPlanUnit,
            memberInfo: undefined,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [rows, groupById, assets, marketData, assetSettings]);

    const plan = useMemo(() => planAmountBuys(units.map(u => u.unit), liquidity), [units, liquidity]);

    // Same order the plan fills them in: nearest due date first.
    const orderedRows = useMemo(() => [...rows].sort((a, b) => {
        if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
        if (!!a.dueDate !== !!b.dueDate) return a.dueDate ? -1 : 1;
        return rows.indexOf(a) - rows.indexOf(b);
    }), [rows]);

    // Held positions no target speaks for: shown, never traded.
    const untargeted = useMemo(() => {
        const targetKeys = new Set(rows.map(r => r.key.toUpperCase()));
        return assets.filter(a => {
            if (a.quantity <= 0 || isCashTicker(a.ticker) || isGroupKey(a.ticker)) return false;
            if (targetKeys.has(a.ticker.toUpperCase())) return false;
            const gid = tickerToGroupId[a.ticker.toUpperCase()];
            return !(gid && targetKeys.has(gid.toUpperCase()));
        });
    }, [assets, rows, tickerToGroupId]);

    const totalTarget = rows.reduce((s, r) => s + r.target, 0);
    const totalCovered = units.reduce((s, u) => s + Math.min(u.unit.currentValue, u.unit.target), 0);
    const coveragePct = totalTarget > 0 ? (totalCovered / totalTarget) * 100 : 0;
    const residualGap = Object.values(plan.lines).reduce((s, l) => s + Math.max(0, l.residualGap), 0);

    const labelOf = (key: string) => {
        const group = groupById[key];
        if (group) return group.label;
        if (isVirtualBondTicker(key)) return virtualBonds.find(b => b.id === getVirtualBondId(key))?.label || key;
        return assetSettings.find(s => s.ticker.toUpperCase() === key.toUpperCase())?.label || key;
    };

    const handleExecute = async () => {
        const Swal = (await import('sweetalert2')).default;
        const today = new Date().toISOString().split('T')[0];
        const txs: Transaction[] = [];
        const push = (ticker: string, shares: number, price: number) => {
            if (!(shares > 0) || !(price > 0)) return;
            const lastTx = portfolioTxs.filter(t => t.ticker === ticker).pop();
            txs.push({
                id: `auto-alm-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                portfolioId: portfolio.id,
                ticker,
                date: today,
                amount: shares,
                price,
                direction: 'Buy',
                brokerId: portfolio.preferredBrokerId ?? lastTx?.brokerId,
            });
        };
        units.forEach(({ unit, memberInfo }) => {
            const line = plan.lines[unit.key];
            if (!line || line.shares <= 0) return;
            const group = groupById[unit.key];
            if (group && memberInfo) {
                // The group's own rules (priority, frozen members, weights) pick who buys.
                const dist = distributeGroupDelta({ deltaEur: line.eur, members: group.members, memberInfo, rules: group.memberRules });
                Object.values(dist.actions).forEach(a => push(a.ticker, a.shares, memberInfo[a.ticker.toUpperCase()]?.price || 0));
                return;
            }
            push(unit.key, line.shares, unit.price);
        });

        if (txs.length === 0) {
            Swal.fire({ title: 'Nothing to buy', text: 'Every target is covered, or the Liquidity does not reach the next lot.', icon: 'info', confirmButtonColor: '#3B82F6' });
            return;
        }
        const total = txs.reduce((s, t) => s + t.amount * t.price, 0);
        const res = await Swal.fire({
            title: 'Execute goal-matching buys?',
            html: `This will create <b>${txs.length}</b> Buy transactions for <b>${eur2(total)}</b> at current prices.<br/><br/>` +
                `<small style="color:var(--text-muted)">Virtual bonds are bought at price 1: the cash is parked until you concretize them.</small>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, Create Transactions',
            confirmButtonColor: '#10B981',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
        });
        if (!res.isConfirmed) return;
        onAddTransactions(txs);
        // The Liquidity was the budget; what the orders consumed is gone.
        onUpdatePortfolio({ ...portfolio, liquidity: Math.max(0, Math.round((liquidity - total) * 100) / 100) });
    };

    const cell: React.CSSProperties = { padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' };
    const head: React.CSSProperties = { ...cell, fontWeight: 600, color: 'var(--text-muted)', fontSize: '0.8rem' };

    return (
        <div className="allocation-card">
            <div className="allocation-header-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
                <h3 className="section-title" style={{ margin: 0 }}>
                    Goal matching: {portfolio.name}{' '}
                    <span style={{ fontSize: '0.9em', fontWeight: 'normal', color: 'var(--text-secondary)' }}>({eur2(summary.totalValue)})</span>
                    <span style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: coveragePct >= 99.95 ? 'var(--color-success)' : 'var(--color-warning)' }}>
                        Targets: {eur0(totalTarget)} · covered {coveragePct.toFixed(1)}%
                    </span>
                </h3>
                <div className="allocation-liquidity-controls" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                    {brokerPicker}
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Liquidity:</label>
                        <input
                            type="number"
                            placeholder="0.00"
                            value={portfolio.liquidity !== undefined ? portfolio.liquidity : ''}
                            onChange={e => onUpdatePortfolio({ ...portfolio, liquidity: e.target.value === '' ? undefined : parseFloat(e.target.value) })}
                            style={{ borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', width: '100px', textAlign: 'right' }}
                        />
                        <span
                            className="allocation-liquidity-hint"
                            style={{ fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer' }}
                            title="Cash that closes every gap to the nearest lot — click to set Liquidity to it"
                            onClick={() => onUpdatePortfolio({ ...portfolio, liquidity: Math.round(plan.required * 100) / 100 })}
                        >
                            (To close all gaps: <span style={{ textDecoration: 'underline' }}>{eur0(plan.required)}</span>)
                        </span>
                    </span>
                </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-3)', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <span>
                    Nearest due date first · bonds on the MOT in lots of {eur0(BOND_LOT_NOMINAL)} nominal · never sells.
                    {liquidity > 0 && <> Plan spends <strong>{eur0(plan.spent)}</strong>, leaves <strong>{eur0(plan.leftover)}</strong>.</>}
                    {residualGap > 0.5 && <> Still open after it: <strong style={{ color: 'var(--color-warning)' }}>{eur0(residualGap)}</strong>.</>}
                    {brokerCash > 0 && <> Broker cash earmarked here: {eur0(brokerCash)}.</>}
                </span>
                <button className="btn-primary" style={{ fontSize: '0.85rem', padding: '4px 8px' }} onClick={handleExecute}>
                    Exec Goal Buys
                </button>
            </div>

            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                            <th style={{ ...head, textAlign: 'left' }}>Asset · goals</th>
                            <th style={head}>Due</th>
                            <th style={head}>Value</th>
                            <th style={head}>Target</th>
                            <th style={head}>Gap</th>
                            <th style={head}>Buy</th>
                            <th style={head}>After buy</th>
                            <th style={{ ...head, textAlign: 'left' }}>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {orderedRows.length === 0 && (
                            <tr><td colSpan={8} style={{ ...cell, textAlign: 'left', color: 'var(--text-muted)' }}>
                                No € targets yet. Set them in the portfolio's Allocations, or link YNAB goals to its assets.
                            </td></tr>
                        )}
                        {orderedRows.map(r => {
                            const u = units.find(x => x.unit.key === r.key)!.unit;
                            const line = plan.lines[r.key];
                            const isVBond = isVirtualBondTicker(r.key);
                            const vb = isVBond ? virtualBonds.find(b => b.id === getVirtualBondId(r.key)) : undefined;
                            const after = u.currentValue + (line?.eur || 0);
                            const lots = line && line.lotUnits > 1 ? line.shares / line.lotUnits : null;
                            return (
                                <tr key={r.key} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal' }}>
                                        {isVBond && <span style={{ fontSize: '0.65rem', background: '#8B5CF6', color: '#fff', borderRadius: '3px', padding: '1px 4px', marginRight: '6px' }}>VBOND</span>}
                                        {groupById[r.key] && <span style={{ fontSize: '0.65rem', color: 'var(--color-primary)', fontWeight: 600, marginRight: '6px' }}>GROUP</span>}
                                        <strong>{labelOf(r.key)}</strong>
                                        {vb && (
                                            <button
                                                onClick={() => setConcretizing({ bond: vb, target: r.target, parked: u.currentValue })}
                                                style={{ marginLeft: '8px', fontSize: '0.7rem', background: '#8B5CF6', color: '#fff', border: 'none', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}
                                            >Concretizza</button>
                                        )}
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                                            {r.goals.length > 0 ? r.goals.map(g => (
                                                <span key={g.allocationId} title={g.targetDate ? `Due ${fmtDate(g.targetDate)}` : 'No date'} style={{ fontSize: '0.72rem', background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '1px 8px', color: 'var(--text-secondary)' }}>
                                                    {g.goalName} · {eur0(g.amount)}
                                                </span>
                                            )) : (
                                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>manual target</span>
                                            )}
                                        </div>
                                    </td>
                                    <td style={cell}>{fmtDate(r.dueDate)}</td>
                                    <td style={cell}>{eur2(u.currentValue)}</td>
                                    <td style={cell}><strong>{eur0(r.target)}</strong></td>
                                    <td style={{ ...cell, color: line?.gap > 0 ? 'var(--color-warning)' : 'var(--text-muted)' }}>
                                        {line?.gap > 0 ? eur0(line.gap) : line?.excess > 0 ? `+${eur0(line.excess)}` : '—'}
                                    </td>
                                    <td style={cell}>
                                        {line && line.shares > 0 ? (
                                            <>
                                                <div style={{ color: 'var(--color-success)', fontWeight: 600 }}>
                                                    {isVBond ? `park ${eur0(line.eur)}` : lots !== null ? `${lots} × lot` : `${line.shares} sh`}
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                    {isVBond ? 'at price 1' : lots !== null ? `${line.shares} units · ${eur2(line.eur)}` : eur2(line.eur)}
                                                </div>
                                            </>
                                        ) : '—'}
                                    </td>
                                    <td style={cell}>
                                        {eur0(after)}
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                            {r.target > 0 ? `${Math.min(999, (after / r.target) * 100).toFixed(0)}%` : ''}
                                        </div>
                                    </td>
                                    <td style={{ ...cell, textAlign: 'left', color: line ? STATUS_COLOR[line.status] : undefined, fontSize: '0.8rem' }}>
                                        {line ? (line.status === 'covered' && line.excess > 0 ? `✓ ${eur0(line.excess)} above — held` : STATUS_TEXT[line.status]) : ''}
                                    </td>
                                </tr>
                            );
                        })}
                        {untargeted.map(a => (
                            <tr key={a.ticker} style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                                <td style={{ ...cell, textAlign: 'left', whiteSpace: 'normal' }}>
                                    {labelOf(a.ticker)}
                                    <div style={{ fontSize: '0.72rem' }}>no target — not matched to any goal</div>
                                </td>
                                <td style={cell}>—</td>
                                <td style={cell}>{eur2(a.currentValue)}</td>
                                <td style={cell}>—</td>
                                <td style={cell}>—</td>
                                <td style={cell}>—</td>
                                <td style={cell}>{eur0(a.currentValue)}</td>
                                <td style={{ ...cell, textAlign: 'left', fontSize: '0.8rem' }}>held</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {concretizing && (
                <ConcretizeModal
                    bond={concretizing.bond}
                    brokers={brokers}
                    portfolios={portfolios}
                    targetAmount={concretizing.target}
                    parkedAmount={concretizing.parked}
                    defaultPortfolioId={portfolio.id}
                    defaultBrokerId={portfolio.preferredBrokerId}
                    onConfirm={fill => {
                        concretizeVirtualBond(concretizing.bond.id, fill);
                        setConcretizing(null);
                    }}
                    onClose={() => setConcretizing(null)}
                />
            )}
        </div>
    );
};

export default AmountTargetTable;
