import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { createPortal } from 'react-dom';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets, calculateRequiredLiquidityForOnlyBuy, injectCashAssets, isCashTicker, isGroupKey, isVirtualBondTicker, calculateRealizedGains, calculateCommission, calculateCashFlows, estimateTradeCost } from '../../utils/portfolioCalculations';
import type { Broker, VirtualBond } from '../../types';
import { getVirtualBondId } from '../../types';
import { resolveGroups, distributeGroupDelta, largestRemainderBuyOnly, distributeBuyOnlyWithPac, pacPriorityFor, requiredLiquidityForFullBuyOnly, buyRecipientOf, memberInfoFromAssets, groupWeightConfig, isFullyFrozen, type BuyOnlyCandidate, type MemberAction, type GroupBlockReason } from '../../utils/allocationGroups';
import { isFreeBuyIsin, currentMonthKey } from '../../utils/freeCommissions';
import { CASH_TICKER_PREFIX } from '../../types';
import ConcretizeModal from '../modals/ConcretizeModal';
import { calculateAssetAllocation } from '../../utils/assetAllocation';
import { WithdrawalModal } from './WithdrawalModal';
import { RealizedGainsModal } from './RealizedGainsModal';
import { CashFlowModal } from './CashFlowModal';
import PortfolioGroupSection from './PortfolioGroupSection';
import BrokerAllocationSection from './BrokerAllocationSection';
import GoalRebalanceWidget from './GoalRebalanceWidget';
import type { GoalItem } from './GoalRebalanceWidget';
import './Dashboard.css';

// Palette used to assign colors to user-defined goals by order
const GOAL_COLOR_PALETTE = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EC4899', '#6366F1'];

// Small badge flagging a PAC entry (with its priority) in the rebalancing table.
const PacBadge: React.FC<{ priority?: number }> = ({ priority }) =>
    priority === undefined ? null : (
        <span
            title={`PAC — priority ${priority} (1 = highest): new liquidity funds this entry first`}
            style={{
                fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.03em',
                background: 'rgba(245,158,11,0.15)', color: '#B45309',
                border: '1px solid rgba(245,158,11,0.5)', borderRadius: '3px',
                padding: '1px 4px', marginLeft: '6px', verticalAlign: 'middle',
                whiteSpace: 'nowrap',
            }}
        >PAC P{priority}</span>
    );

const fmtEur = (n: number, dp = 2) =>
    `€${n.toLocaleString('en-IE', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.4375;

/** Whole-ish months elapsed since an ISO date (0 if future/invalid). */
const monthsSince = (iso?: string): number => {
    if (!iso) return 0;
    const from = new Date(iso).getTime();
    if (!Number.isFinite(from)) return 0;
    const diff = Date.now() - from;
    return diff > 0 ? diff / MS_PER_MONTH : 0;
};

/** Earliest Buy date across a ticker's transactions (used to date the position). */
const firstBuyDate = (txs: { date: string; direction?: string }[]): string | undefined => {
    const buys = txs.filter(t => (t.direction ?? 'Buy') === 'Buy').map(t => t.date).filter(Boolean);
    return buys.length ? buys.reduce((a, b) => (a < b ? a : b)) : undefined;
};

/**
 * Wraps an Action / Buy-Only cell and, on hover/tap, shows a popover estimating
 * what trading this asset would actually cost: the implicit spread cost ("danno")
 * plus the simulated broker commission. The popover compares EVERY broker (plus a
 * commission-free scenario) and lets the user pick which broker drives the headline
 * total drag — so two interchangeable instruments (e.g. commission-bearing VWCE vs
 * commission-free, wider-spread ALLW) can be compared broker by broker.
 *
 * It renders even when there is no pending action (Action "OK" / Buy Only "−"):
 * in that case it estimates the cost of buying a single share so the trading
 * cost is always visible.
 */
const TradeCostInfo: React.FC<{
    shares: number;            // signed pending action: + buy, − sell, 0 = none
    price: number;
    spreadPercent?: number | null;
    brokers: Broker[];
    defaultBrokerId?: string;  // broker resolved for this ticker (default selection)
    gainPercent?: number | null;  // asset's total return % so far
    monthsHeld?: number;          // months since first buy (to annualise the return)
    taxRate?: number;             // decimal capital-gains rate for this asset class
    ticker?: string;              // ISIN/ticker, to match the free-buy promo lists
    children: React.ReactNode;
}> = ({ shares, price, spreadPercent, brokers, defaultBrokerId, gainPercent, monthsHeld, taxRate, ticker, children }) => {
    const { freeCommissionPeriods } = usePortfolio();
    const [open, setOpen] = useState(false);
    const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // For rows with a suggested trade, let the user re-base the estimate on a
    // single share instead of the suggested amount.
    const [qtyMode, setQtyMode] = useState<'suggested' | 'single'>('suggested');
    // Free-buy promo applied on top of the selected broker (waives the buy fee only).
    // Promos are broker-specific: pre-armed only when the ISIN is in the current
    // month's free-buy list of the broker driving the headline (default resolved
    // broker, or the one picked in the popover).
    const promoMonthKey = currentMonthKey();
    const effectiveBrokerId = selectedId ?? defaultBrokerId ?? brokers[0]?.id;
    const freeBuyPromo = isFreeBuyIsin(freeCommissionPeriods, ticker, promoMonthKey, effectiveBrokerId);
    const [freeBuy, setFreeBuy] = useState(freeBuyPromo);
    useEffect(() => { setFreeBuy(freeBuyPromo); }, [freeBuyPromo]);
    const ref = useRef<HTMLSpanElement>(null);

    if (price <= 0) return <>{children}</>;

    const isAction = shares !== 0;
    const suggestedQty = Math.abs(shares);
    // No pending action → always 1 share. Otherwise honour the toggle.
    const qty = !isAction ? 1 : (qtyMode === 'single' ? 1 : suggestedQty);
    const isEstimate = !isAction || qtyMode === 'single';

    const value = qty * price;
    const sp = spreadPercent ?? null;
    const spreadCost = sp != null ? (value * (sp / 100)) / 2 : 0;
    const actionLabel = isAction ? (shares > 0 ? 'Buy' : 'Sell') : 'Buy';

    // One row per broker (commission simulated from its plan). The broker is the
    // commission plan; the free-buy toggle is applied on top, not a pseudo-broker.
    const brokerRows = brokers.map(b => {
        const est = estimateTradeCost({ shares: qty, price, spreadPercent, broker: b });
        return {
            id: b.id, name: b.name,
            commission: est.commission ?? 0, hasPlan: est.hasCommissionPlan,
            totalCost: est.totalCost, totalCostPercent: est.totalCostPercent,
            promo: isFreeBuyIsin(freeCommissionPeriods, ticker, promoMonthKey, b.id),
        };
    });
    const effectiveId = effectiveBrokerId;
    const selectedRow = brokerRows.find(r => r.id === effectiveId) ?? brokerRows[0];
    const selectedCommission = selectedRow?.commission ?? 0;
    const selectedName = selectedRow?.name ?? 'No broker';

    // Free-buy promo: waives the commission on the BUY leg only — the eventual sell
    // still pays the broker's commission.
    const isBuyTrade = isAction ? shares > 0 : true;
    const buyCommission = freeBuy ? 0 : selectedCommission;
    const sellCommission = selectedCommission;
    // Headline = cost of the displayed single trade (free-buy waives a buy's fee).
    const headlineCommission = (isBuyTrade && freeBuy) ? 0 : selectedCommission;
    const headlineDrag = spreadCost + headlineCommission;
    const headlineDragPct = value > 0 ? (headlineDrag / value) * 100 : 0;

    // Break-even holding period: how long the asset's own historical return needs
    // to offset a full buy→sell round trip (spread both sides + buy & sell
    // commission + tax on the gain), so you end up back at capital + expected return.
    const monthlyReturnPct = (gainPercent != null && monthsHeld && monthsHeld > 0)
        ? gainPercent / monthsHeld
        : null;
    // Round trip = spread on entry + exit (= full spread) + buy fee (waivable) + sell fee.
    const roundTripFriction = spreadCost * 2 + buyCommission + sellCommission;
    const roundTripFrictionPct = value > 0 ? (roundTripFriction / value) * 100 : 0;
    const tr = taxRate ?? 0;
    // Gross appreciation needed so that, after tax on the gain, it still covers the friction.
    const requiredGainPct = tr < 1 ? roundTripFrictionPct / (1 - tr) : roundTripFrictionPct;

    // The broker only affects the cost to recover, never the return estimate, so
    // resolve the cost case first: no modelled cost (e.g. free commission + no/zero
    // spread) ⇒ nothing to recover ⇒ 0 months, regardless of history. Only when there
    // IS a cost do we need a positive historical return to project a recovery time.
    let holdMonths: number | null = null;
    let holdNote: string | null = null;
    if (requiredGainPct <= 0) {
        holdMonths = 0;
    } else if (monthlyReturnPct == null) {
        holdNote = 'Not enough history to estimate a hold time.';
    } else if (monthlyReturnPct <= 0) {
        holdNote = "Asset hasn't appreciated — hold time can't be estimated.";
    } else {
        holdMonths = Math.ceil(requiredGainPct / monthlyReturnPct);
    }
    const showHoldSection = gainPercent != null;

    const place = () => {
        const r = ref.current?.getBoundingClientRect();
        if (r) {
            // Clamp so the 290px-wide popover stays inside the viewport (mobile).
            const half = 145 + 8;
            const x = Math.min(Math.max(r.left + r.width / 2, half), Math.max(window.innerWidth - half, half));
            setCoords({ x, y: r.bottom });
        }
    };

    return (
        <span
            ref={ref}
            onMouseEnter={() => { place(); setOpen(true); }}
            onMouseLeave={() => setOpen(false)}
            onClick={e => { e.stopPropagation(); place(); setOpen(o => !o); }}
            style={{ cursor: 'help', borderBottom: '1px dotted var(--text-muted)', display: 'inline-block' }}
        >
            {children}
            {freeBuyPromo && shares > 0 && (
                <span style={{
                    display: 'inline-block', marginLeft: 4, verticalAlign: 'text-top',
                    fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.03em',
                    color: 'var(--color-success)', border: '1px solid var(--color-success)',
                    borderRadius: 3, padding: '0 3px', lineHeight: 1.4,
                }}>FREE</span>
            )}
            {open && createPortal(
                <div
                    style={{
                        position: 'fixed', left: coords.x, top: coords.y + 6,
                        transform: 'translateX(-50%)', zIndex: 9999,
                        background: 'var(--bg-card)', color: 'var(--text-primary)',
                        border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.25)', padding: 'var(--space-3)',
                        width: 290, fontSize: '0.8rem', textAlign: 'left', cursor: 'default',
                    }}
                    onMouseEnter={() => setOpen(true)}
                    onClick={e => e.stopPropagation()}
                >
                    <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.68rem' }}>
                        Estimated trade cost
                    </div>
                    {isAction && (
                        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                            {([
                                { mode: 'suggested' as const, label: `Suggested (${suggestedQty})` },
                                { mode: 'single' as const, label: '1 share' },
                            ]).map(opt => {
                                const active = qtyMode === opt.mode;
                                return (
                                    <button
                                        key={opt.mode}
                                        onClick={e => { e.stopPropagation(); setQtyMode(opt.mode); }}
                                        style={{
                                            flex: 1, padding: '3px 6px', fontSize: '0.72rem', cursor: 'pointer',
                                            borderRadius: 'var(--radius-sm)',
                                            border: active ? '1px solid #3B82F6' : '1px solid var(--border-color)',
                                            background: active ? 'rgba(59,130,246,0.12)' : 'transparent',
                                            color: active ? '#3B82F6' : 'var(--text-muted)',
                                            fontWeight: active ? 600 : 400,
                                        }}
                                    >{opt.label}</button>
                                );
                            })}
                        </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ color: 'var(--text-muted)' }}>
                            {actionLabel} {qty} @ {fmtEur(price)}{isEstimate ? ' (est.)' : ''}
                        </span>
                        <strong>{fmtEur(value, 0)}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                        <span>Spread{sp != null ? ` (${sp.toFixed(2)}%)` : ''}</span>
                        <span style={{ color: sp != null ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {sp != null ? `−${fmtEur(spreadCost)}` : 'n/a'}
                        </span>
                    </div>

                    <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '6px 0' }} />
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                        Commission &amp; total drag by broker
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {brokerRows.length === 0 && (
                            <div style={{ color: 'var(--text-muted)', padding: '3px 4px' }}>No broker configured.</div>
                        )}
                        {brokerRows.map(row => {
                            const isSel = row.id === effectiveId;
                            return (
                                <div
                                    key={row.id}
                                    onClick={e => { e.stopPropagation(); setSelectedId(row.id); }}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: 6, padding: '3px 4px',
                                        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                        background: isSel ? 'rgba(59,130,246,0.12)' : 'transparent',
                                    }}
                                >
                                    <span style={{ color: isSel ? '#3B82F6' : 'var(--text-muted)', fontSize: '0.7rem', width: 12 }}>
                                        {isSel ? '●' : '○'}
                                    </span>
                                    <span style={{ flex: 1 }}>
                                        {row.name}
                                        {row.promo && (
                                            <span style={{
                                                marginLeft: 4, fontSize: '0.58rem', fontWeight: 700,
                                                color: 'var(--color-success)', border: '1px solid var(--color-success)',
                                                borderRadius: 3, padding: '0 3px', verticalAlign: 'text-top',
                                            }}>FREE BUY</span>
                                        )}
                                    </span>
                                    <span style={{ width: 64, textAlign: 'right', color: row.commission > 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                        {row.commission > 0 ? `−${fmtEur(row.commission)}` : 'free'}
                                    </span>
                                    <span style={{ width: 78, textAlign: 'right', fontWeight: 600, color: row.totalCost > 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                        −{fmtEur(row.totalCost)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    <label
                        onClick={e => e.stopPropagation()}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, cursor: 'pointer', userSelect: 'none' }}
                    >
                        <input
                            type="checkbox"
                            checked={freeBuy}
                            onChange={e => { e.stopPropagation(); setFreeBuy(e.target.checked); }}
                            style={{ cursor: 'pointer' }}
                        />
                        <span>
                            Free buy commission{' '}
                            <span style={{ color: freeBuyPromo ? 'var(--color-success)' : 'var(--text-muted)' }}>
                                {freeBuyPromo ? '(in this month’s free ISIN list)' : '(promo — sell still pays)'}
                            </span>
                        </span>
                    </label>

                    <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '6px 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                        <span>Total drag <span style={{ fontWeight: 'normal', color: 'var(--text-muted)' }}>({selectedName}{isBuyTrade && freeBuy ? ', free buy' : ''})</span></span>
                        <span style={{ color: headlineDrag > 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            −{fmtEur(headlineDrag)} ({headlineDragPct.toFixed(2)}%)
                        </span>
                    </div>

                    {showHoldSection && (
                        <>
                            <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '6px 0' }} />
                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                                <span style={{ color: 'var(--text-muted)' }}>
                                    Return so far{monthsHeld && monthsHeld >= 1 ? ` (${Math.round(monthsHeld)} mo)` : ''}
                                </span>
                                <span style={{ color: (gainPercent ?? 0) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                    {(gainPercent ?? 0) >= 0 ? '+' : ''}{(gainPercent ?? 0).toFixed(1)}%
                                    {monthlyReturnPct != null ? ` · ${monthlyReturnPct >= 0 ? '+' : ''}${monthlyReturnPct.toFixed(2)}%/mo` : ''}
                                </span>
                            </div>
                            {holdMonths != null ? (
                                holdMonths === 0 ? (
                                    <div style={{ color: 'var(--color-success)', marginTop: 2 }}>
                                        No round-trip cost — no minimum hold.
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 2 }}>
                                        <strong>Hold for at least</strong>
                                        <strong style={{ color: '#3B82F6' }}>{holdMonths} month{holdMonths !== 1 ? 's' : ''}</strong>
                                    </div>
                                )
                            ) : (
                                <div style={{ color: 'var(--color-warning)', marginTop: 2 }}>
                                    {holdNote}
                                </div>
                            )}
                        </>
                    )}

                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.35 }}>
                        Spread = half the bid/ask (one fill). Commission per broker's plan; free-buy waives the buy fee only.
                        {showHoldSection && holdMonths != null && holdMonths > 0
                            ? ` Hold time = months for this asset's past return to offset a buy→sell round trip (spread ×2, buy fee${freeBuy ? ' waived' : ''} + sell fee, ${(tr * 100).toFixed(1)}% tax).`
                            : ''}
                    </div>
                </div>,
                document.body
            )}
        </span>
    );
};


// Dashboard rebalance mode: plain localStorage (UI preference, not synced/encrypted)
const REBAL_MODE_KEY = 'dashboard_rebalance_mode_v1';
type RebalanceMode = 'portfolio' | 'broker';

const AllocationOverview: React.FC = () => {
    const { portfolios, brokers, transactions, assetSettings, effectiveAssetSettings, marketData, updatePortfolio, addTransactionsBulk, goals: rawGoals, goalModeTargets: storedGoalModeTargets, setGoalModeTargets } = usePortfolio();

    const [rebalanceMode, setRebalanceMode] = useState<RebalanceMode>(
        () => localStorage.getItem(REBAL_MODE_KEY) === 'broker' ? 'broker' : 'portfolio'
    );
    const switchMode = (m: RebalanceMode) => {
        setRebalanceMode(m);
        localStorage.setItem(REBAL_MODE_KEY, m);
    };

    // Goals sorted by order, with assigned colors
    const goalItems = useMemo<GoalItem[]>(() => {
        return [...rawGoals]
            .sort((a, b) => a.order - b.order)
            .map((g, i) => ({ id: g.id, title: g.title, color: GOAL_COLOR_PALETTE[i % GOAL_COLOR_PALETTE.length] }));
    }, [rawGoals]);

    /**
     * Current goal values — portfolio-based, fully consistent with aggregateTotalValue.
     * Each portfolio contributes: invested assets + broker cash allocations (liquidityAllocations).
     * Per-portfolio liquidity (portfolio.liquidity) is rebalancing-only and is NOT
     * summed here, so these totals match exactly what the Aggregate table counts.
     */
    const currentGoalValues = useMemo<Record<string, number>>(() => {
        const vals: Record<string, number> = {};
        rawGoals.forEach(g => { vals[g.id] = 0; });

        portfolios.forEach(p => {
            if (!p.goalId) return;
            const pTxs = transactions.filter(t => t.portfolioId === p.id);
            const { assets: pRawAssets, summary } = calculateAssets(pTxs, assetSettings, marketData);
            const pCash = injectCashAssets(pRawAssets, brokers, p.id)
                .filter(a => isCashTicker(a.ticker))
                .reduce((s, a) => s + a.currentValue, 0);
            vals[p.goalId] = (vals[p.goalId] ?? 0) + summary.totalValue + pCash;
        });

        return vals;
    }, [portfolios, transactions, assetSettings, marketData, rawGoals, brokers]);

    const goalsTotalValue = useMemo(
        () => Object.values(currentGoalValues).reduce((s, v) => s + v, 0),
        [currentGoalValues]
    );

    // Target allocations: persisted via context (localStorage + Azure sync).
    // If goals change and stored targets are missing/incomplete, reinitialise to equal split.
    useEffect(() => {
        const hasAll = goalItems.length > 0 && goalItems.every(g => g.id in storedGoalModeTargets);
        if (hasAll) return;
        if (goalItems.length === 0) return;
        const equalPct = parseFloat((100 / goalItems.length).toFixed(2));
        const allocs: Record<string, number> = {};
        goalItems.forEach((g, i) => {
            allocs[g.id] = i < goalItems.length - 1 ? equalPct : 100 - equalPct * (goalItems.length - 1);
        });
        setGoalModeTargets(allocs);
    }, [goalItems, storedGoalModeTargets, setGoalModeTargets]);

    const targetGoalAllocs = storedGoalModeTargets;

    // Split portfolios into groups (parent + children) and standalones
    const { groups, standalones } = useMemo(() => {
        const parentPortfolios = portfolios.filter(
            p => !p.parentId && portfolios.some(c => c.parentId === p.id)
        ).sort((a, b) => a.order - b.order);
        // Children whose parent exists
        const validChildren = portfolios.filter(
            p => p.parentId && portfolios.some(par => par.id === p.parentId)
        );
        // Orphan children (parentId set but parent doesn't exist) → render standalone
        const orphans = portfolios.filter(
            p => p.parentId && !portfolios.some(par => par.id === p.parentId)
        );
        // Portfolios with no parent and no children
        const trueStandalones = portfolios.filter(
            p => !p.parentId && !portfolios.some(c => c.parentId === p.id)
        );

        const groups = parentPortfolios.map(parent => ({
            parent,
            children: validChildren.filter(c => c.parentId === parent.id).sort((a, b) => a.order - b.order),
        }));

        return { groups, standalones: [...trueStandalones, ...orphans].sort((a, b) => a.order - b.order) };
    }, [portfolios]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {portfolios.length === 0 ? (
                <div className="allocation-card">
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>
                        No portfolios configured. Create a portfolio to see allocation analysis.
                    </p>
                </div>
            ) : (
                <>
                    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                        {(['portfolio', 'broker'] as const).map(m => (
                            <button
                                key={m}
                                onClick={() => switchMode(m)}
                                style={{
                                    fontSize: '0.8rem', padding: '0.25rem 0.75rem', borderRadius: 'var(--radius-md)',
                                    border: '1px solid var(--border-color)',
                                    backgroundColor: rebalanceMode === m ? 'var(--color-primary)' : 'var(--bg-input)',
                                    color: rebalanceMode === m ? '#fff' : 'var(--text-muted)',
                                    cursor: 'pointer', fontWeight: 500, transition: 'all 0.2s', whiteSpace: 'nowrap',
                                }}
                            >
                                {m === 'portfolio' ? 'By Portfolio' : 'By Broker'}
                            </button>
                        ))}
                        {rebalanceMode === 'broker' && (
                            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                Targets = current weights at each broker
                            </span>
                        )}
                    </div>
                    {rebalanceMode === 'broker' && (
                        <BrokerAllocationSection
                            brokers={brokers}
                            transactions={transactions}
                            assetSettings={effectiveAssetSettings}
                            marketData={marketData}
                            onAddTransactions={addTransactionsBulk}
                        />
                    )}
                    {rebalanceMode === 'portfolio' && <>
                    {groups.map(({ parent, children }) => (
                        <PortfolioGroupSection
                            key={parent.id}
                            parent={parent}
                            children={children}
                            allTransactions={transactions}
                            assetSettings={effectiveAssetSettings}
                            marketData={marketData}
                            brokers={brokers}
                            onUpdatePortfolio={updatePortfolio}
                            onAddTransactions={addTransactionsBulk}
                        />
                    ))}
                    {standalones.map(portfolio => (
                        <PortfolioAllocationTable
                            key={portfolio.id}
                            portfolio={portfolio}
                            allTransactions={transactions}
                            assetSettings={effectiveAssetSettings}
                            marketData={marketData}
                            brokers={brokers}
                            onUpdatePortfolio={updatePortfolio}
                            onAddTransactions={addTransactionsBulk}
                        />
                    ))}
                    {goalItems.length > 0 && (
                        <GoalRebalanceWidget
                            goals={goalItems}
                            targetAllocs={targetGoalAllocs}
                            onTargetChange={setGoalModeTargets}
                            currentGoalValues={currentGoalValues}
                            totalCurrentValue={goalsTotalValue}
                        />
                    )}
                    <AggregateAllocationSection
                        goalModeTargets={targetGoalAllocs}
                    />
                    </>}
                </>
            )}
        </div>
    );
};

interface AggregateAllocationSectionProps {
    goalModeTargets: Record<string, number>;  // goalId → target %
}

const AggregateAllocationSection: React.FC<AggregateAllocationSectionProps> = ({ goalModeTargets }) => {
    const { portfolios, brokers, transactions, assetSettings, effectiveAssetSettings, marketData, assetAllocationSettings, aggregateExcludedTickers: excludedTickers, setAggregateExcludedTickers: setExcludedTickers, virtualBonds, concretizeVirtualBond, parkVirtualBond } = usePortfolio();
    const [concretizingVBond, setConcretizingVBond] = useState<VirtualBond | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [additionalLiquidity, setAdditionalLiquidity] = useState<number | undefined>(undefined);

    const { assets: rawAggregateAssets, summary } = useMemo(
        () => calculateAssets(transactions, effectiveAssetSettings, marketData),
        [transactions, effectiveAssetSettings, marketData]
    );

    // Per-portfolio total values (needed for aggregated cash and as input to asset allocation engine)
    const portfolioCalcs = useMemo(() => {
        return portfolios.map(portfolio => {
            const pTxs = transactions.filter(t => t.portfolioId === portfolio.id);
            const { assets: pRawAssets, summary: pSummary } = calculateAssets(pTxs, effectiveAssetSettings, marketData);
            const pAssets = injectCashAssets(pRawAssets, brokers, portfolio.id);
            const cashAssetsValue = pAssets
                .filter(a => isCashTicker(a.ticker))
                .reduce((s, a) => s + a.currentValue, 0);
            // Total = invested assets + broker cash allocated to this portfolio.
            // Per-portfolio liquidity is rebalancing-only (info row + Buy-Only
            // what-if) and is deliberately NOT summed into the total.
            const totalValue = pSummary.totalValue + cashAssetsValue;
            return { portfolio, assets: pAssets, totalValue, investedValue: pSummary.totalValue, portfolioLiquidity: portfolio.liquidity || 0 };
        });
    }, [portfolios, transactions, effectiveAssetSettings, marketData, brokers]);

    // Run the Asset Allocation engine to get configured target weights per portfolio
    const allocationResult = useMemo(() => {
        const brokerLiquidity = brokers.reduce((s, b) => {
            const alloc = b.liquidityAllocations || {};
            return s + Object.values(alloc).reduce((a, v) => a + (v || 0), 0);
        }, 0);
        return calculateAssetAllocation({
            portfolios: portfolioCalcs.map(pc => ({
                portfolioId: pc.portfolio.id,
                name: pc.portfolio.name,
                currentInvestedValue: pc.investedValue,
                currentPortfolioLiquidity: pc.portfolioLiquidity,
                currentTotalValue: pc.totalValue,
            })),
            brokerLiquidity,
            settings: assetAllocationSettings,
        });
    }, [portfolioCalcs, brokers, assetAllocationSettings]);

    // Map portfolioId → configured target weight (%)
    const portfolioTargetWeightById = useMemo(() => {
        const map: Record<string, number> = {};
        allocationResult.portfolios.forEach(r => { map[r.portfolioId] = r.targetWeight; });
        return map;
    }, [allocationResult]);

    // Aggregate cash assets across portfolios
    const aggregateCashAssets = useMemo<import('../../types').Asset[]>(() => {
        const cashMap = new Map<string, import('../../types').Asset>();
        portfolioCalcs.forEach(pc => {
            pc.assets.filter(a => isCashTicker(a.ticker)).forEach(cashAsset => {
                const existing = cashMap.get(cashAsset.ticker);
                if (existing) {
                    const newValue = existing.currentValue + cashAsset.currentValue;
                    cashMap.set(cashAsset.ticker, { ...existing, currentValue: newValue, averagePrice: newValue, currentPrice: newValue });
                } else {
                    cashMap.set(cashAsset.ticker, { ...cashAsset });
                }
            });
        });
        return Array.from(cashMap.values());
    }, [portfolioCalcs]);

    // All assets (quantity > 0) — used to render rows (including excluded in edit mode)
    const allVisibleAssets = useMemo(() => {
        // Unresolved virtual bonds appear even at quantity 0 (ghost rows) so the
        // user can see the rebalance € target and reach the "Concretizza" button.
        const real = rawAggregateAssets.filter(a => !isCashTicker(a.ticker) && (a.quantity > 0 || isVirtualBondTicker(a.ticker)));
        return [...real, ...aggregateCashAssets].sort((a, b) => a.ticker.localeCompare(b.ticker));
    }, [rawAggregateAssets, aggregateCashAssets]);

    // Only included assets — used for totals and rebalance calculations
    const includedAssets = useMemo(
        () => allVisibleAssets.filter(a => !excludedTickers.includes(a.ticker)),
        [allVisibleAssets, excludedTickers]
    );

    // Aggregate total value counts only included assets (which already include
    // broker cash). Per-portfolio liquidity is rebalancing-only and not summed.
    const aggregateTotalValue = useMemo(
        () => includedAssets.reduce((s, a) => s + a.currentValue, 0),
        [includedAssets]
    );

    // Total value including the additional liquidity input
    const liq = additionalLiquidity ?? 0;
    const calcTotalValue = aggregateTotalValue + liq;

    // Realized + distributions
    const { totalRealized, details: realizedDetails, totalCommissions: realizedCommissions, totalTax: realizedTax } = useMemo(
        () => calculateRealizedGains(transactions, brokers, assetSettings),
        [transactions, brokers, assetSettings]
    );
    const [showRealizedModal, setShowRealizedModal] = React.useState(false);

    const { totalIncome, totalDividends, totalCoupons, byTicker: cashFlowDetails } = useMemo(
        () => calculateCashFlows(transactions),
        [transactions]
    );
    const [showCashFlowModal, setShowCashFlowModal] = React.useState(false);

    const includedGain = includedAssets.reduce((s, a) => s + (a.gain || 0), 0);
    const includedCost = includedAssets.reduce((s, a) => s + a.quantity * a.averagePrice, 0);
    const aggregateTotalReturn = includedGain + totalRealized + totalIncome;
    const aggregateTotalReturnPerc = includedCost > 0 ? (aggregateTotalReturn / includedCost) * 100 : 0;

    const getLabel = (ticker: string) => {
        if (isVirtualBondTicker(ticker)) {
            const vb = virtualBonds.find(b => b.id === getVirtualBondId(ticker));
            return vb?.label || ticker;
        }
        return assetSettings.find(s => s.ticker === ticker)?.label || ticker;
    };

    // ticker → broker to simulate trade commission against: the broker of the most
    // recent transaction for that ticker; falls back to the only broker if there's one.
    const tickerToBroker = useMemo<Record<string, import('../../types').Broker | undefined>>(() => {
        const lastBrokerId: Record<string, string | undefined> = {};
        [...transactions]
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
            .forEach(t => { if (t.brokerId) lastBrokerId[t.ticker.toUpperCase()] = t.brokerId; });
        const map: Record<string, import('../../types').Broker | undefined> = {};
        Object.entries(lastBrokerId).forEach(([ticker, bid]) => {
            map[ticker] = brokers.find(b => b.id === bid) ?? (brokers.length === 1 ? brokers[0] : undefined);
        });
        return map;
    }, [transactions, brokers]);

    // ticker → months since first buy (for the break-even hold estimate in the popover)
    const tickerToMonthsHeld = useMemo<Record<string, number>>(() => {
        const firstBuy: Record<string, string> = {};
        transactions.forEach(t => {
            if ((t.direction ?? 'Buy') !== 'Buy') return;
            const k = t.ticker.toUpperCase();
            if (!firstBuy[k] || t.date < firstBuy[k]) firstBuy[k] = t.date;
        });
        const map: Record<string, number> = {};
        Object.entries(firstBuy).forEach(([k, d]) => { map[k] = monthsSince(d); });
        return map;
    }, [transactions]);

    const toggleExcluded = (ticker: string) => {
        setExcludedTickers(prev =>
            prev.includes(ticker) ? prev.filter(t => t !== ticker) : [...prev, ticker]
        );
    };

    // Weighted target % per ticker (memoised map)
    const totalConfiguredWeight = useMemo(() => {
        return portfolioCalcs.reduce((sum, pc) => sum + (portfolioTargetWeightById[pc.portfolio.id] ?? 0), 0);
    }, [portfolioCalcs, portfolioTargetWeightById]);

    const weightedTargets = useMemo(() => {
        const normFactor = totalConfiguredWeight > 0 ? 100 / totalConfiguredWeight : 0;
        const result: Record<string, number> = {};
        allVisibleAssets.forEach(a => {
            if (isCashTicker(a.ticker)) return;
            result[a.ticker] = portfolioCalcs.reduce((sum, pc) => {
                const tw = portfolioTargetWeightById[pc.portfolio.id] ?? 0;
                const w = (tw * normFactor) / 100;
                const tgt = (pc.portfolio.allocations || {})[a.ticker] || 0;
                return sum + w * tgt;
            }, 0);
        });
        return result;
    }, [allVisibleAssets, portfolioCalcs, portfolioTargetWeightById, totalConfiguredWeight]);

    // Buy-only allocations (largest remainder method on included non-cash assets)
    const aggregateBuyOnlyAllocations = useMemo(() => {
        if (liq <= 0) return {} as Record<string, number>;

        const candidates = includedAssets
            .filter(a => !isCashTicker(a.ticker))
            .map(a => {
                const tgt = weightedTargets[a.ticker] || 0;
                const targetValue = calcTotalValue * (tgt / 100);
                const gap = targetValue - a.currentValue;
                const price = a.currentPrice || 0;
                return { ticker: a.ticker, gap, price };
            })
            .filter(c => c.gap > 0 && c.price > 0);

        const totalGap = candidates.reduce((s, c) => s + c.gap, 0);
        if (totalGap <= 0) return {} as Record<string, number>;

        const distribution = candidates.map(c => {
            const rawAlloc = (c.gap / totalGap) * liq;
            const idealShares = rawAlloc / c.price;
            const flooredShares = Math.floor(idealShares);
            return { ...c, shares: flooredShares, fraction: idealShares - flooredShares, cost: flooredShares * c.price };
        });

        let remaining = liq - distribution.reduce((s, d) => s + d.cost, 0);
        const sortedIdx = distribution.map((_, i) => i).sort((a, b) => distribution[b].fraction - distribution[a].fraction);
        for (const idx of sortedIdx) {
            if (remaining >= distribution[idx].price) {
                distribution[idx].shares += 1;
                distribution[idx].cost += distribution[idx].price;
                remaining -= distribution[idx].price;
            }
        }

        const result: Record<string, number> = {};
        distribution.forEach(d => { if (d.shares > 0) result[d.ticker] = d.shares * d.price; });
        return result;
    }, [includedAssets, liq, calcTotalValue, weightedTargets]);

    const excludedCount = excludedTickers.filter(t => allVisibleAssets.some(a => a.ticker === t)).length;

    // Current goal values for goal-rebalance calculation — portfolio-based (robust against any goal title)
    const currentGoalValuesInAggregate = useMemo<Record<string, number>>(() => {
        const vals: Record<string, number> = {};
        // Use totalValue (invested + broker cash allocations) so that
        // sum(vals) ≈ aggregateTotalValue and gaps are accurate.
        portfolioCalcs.forEach(pc => {
            const gid = pc.portfolio.goalId;
            if (!gid) return;
            vals[gid] = (vals[gid] ?? 0) + pc.totalValue;
        });
        return vals;
    }, [portfolioCalcs]);

    /**
     * ticker → goalId via portfolio membership (robust against any goal title).
     * If a ticker appears in portfolios with different goals, use the goal of the
     * portfolio where it has the highest current value.
     */
    const tickerToGoalId = useMemo<Record<string, string>>(() => {
        const map: Record<string, { goalId: string; value: number }> = {};
        portfolioCalcs.forEach(pc => {
            const gid = pc.portfolio.goalId;
            if (!gid) return;
            pc.assets.filter(a => !isCashTicker(a.ticker) && a.quantity > 0).forEach(a => {
                const existing = map[a.ticker];
                if (!existing || a.currentValue > existing.value) {
                    map[a.ticker] = { goalId: gid, value: a.currentValue };
                }
            });
        });
        const result: Record<string, string> = {};
        Object.entries(map).forEach(([ticker, { goalId }]) => { result[ticker] = goalId; });
        return result;
    }, [portfolioCalcs]);

    /**
     * Portfolio ids configured as 'locked' or 'excluded' in Asset Allocation settings.
     * These portfolios are off-limits for both buy and sell suggestions.
     */
    const lockedPortfolioIds = useMemo<Set<string>>(() => {
        const ids = new Set<string>();
        Object.entries(assetAllocationSettings?.portfolioTargets ?? {}).forEach(([pid, t]) => {
            if (t.mode === 'locked' || t.mode === 'excluded') ids.add(pid);
        });
        return ids;
    }, [assetAllocationSettings]);

    /**
     * Tickers frozen by Asset Allocation constraints: assets belonging exclusively
     * to locked/excluded portfolios. Off-limits for BOTH buy and sell suggestions.
     */
    const frozenTickers = useMemo<Set<string>>(() => {
        if (lockedPortfolioIds.size === 0) return new Set();
        const tickers = new Set<string>();
        portfolioCalcs.forEach(pc => {
            if (!lockedPortfolioIds.has(pc.portfolio.id)) return;
            pc.assets.filter(a => !isCashTicker(a.ticker) && a.quantity > 0).forEach(a => {
                const appearsElsewhere = portfolioCalcs.some(
                    other => !lockedPortfolioIds.has(other.portfolio.id) &&
                             other.assets.some(oa => oa.ticker === a.ticker && oa.quantity > 0)
                );
                if (!appearsElsewhere) tickers.add(a.ticker);
            });
        });
        return tickers;
    }, [portfolioCalcs, lockedPortfolioIds]);

    /**
     * Cash assets grouped by goalId. Cash is fungible: 'lock at current' /
     * 'excluded' portfolio modes apply to non-cash assets, not to liquidity,
     * so cash from those portfolios is still drainable for goal rebalance.
     * Only user-excluded cash tickers are filtered out.
     */
    const cashByGoal = useMemo<Record<string, { ticker: string; value: number }[]>>(() => {
        const map: Record<string, Record<string, number>> = {};
        portfolioCalcs.forEach(pc => {
            const gid = pc.portfolio.goalId;
            if (!gid) return;
            pc.assets
                .filter(a => isCashTicker(a.ticker) && a.currentValue > 0 && !excludedTickers.includes(a.ticker))
                .forEach(a => {
                    if (!map[gid]) map[gid] = {};
                    map[gid][a.ticker] = (map[gid][a.ticker] ?? 0) + a.currentValue;
                });
        });
        const result: Record<string, { ticker: string; value: number }[]> = {};
        Object.entries(map).forEach(([gid, byTicker]) => {
            result[gid] = Object.entries(byTicker).map(([ticker, value]) => ({ ticker, value }));
        });
        return result;
    }, [portfolioCalcs, excludedTickers]);

    /**
     * Non-cash value actually held within each goal (per-portfolio aware).
     * goalId → ticker → € summed across non-locked portfolios that belong to
     * the goal. A ticker can appear under multiple goals when it's held in
     * portfolios with different goalIds — each goal only sees its own slice.
     * Frozen and user-excluded tickers are filtered out.
     */
    const nonCashValueByGoal = useMemo<Record<string, Record<string, number>>>(() => {
        const map: Record<string, Record<string, number>> = {};
        portfolioCalcs.forEach(pc => {
            if (lockedPortfolioIds.has(pc.portfolio.id)) return;
            const gid = pc.portfolio.goalId;
            if (!gid) return;
            pc.assets
                .filter(a => !isCashTicker(a.ticker) && a.quantity > 0
                    && !excludedTickers.includes(a.ticker)
                    && !frozenTickers.has(a.ticker))
                .forEach(a => {
                    if (!map[gid]) map[gid] = {};
                    map[gid][a.ticker] = (map[gid][a.ticker] ?? 0) + a.currentValue;
                });
        });
        return map;
    }, [portfolioCalcs, lockedPortfolioIds, excludedTickers, frozenTickers]);

    /**
     * Goal-Rebalance allocations.
     *
     * postTotal = aggregateTotalValue + liq
     * gap_per_goal = target€ − current€  →  Σ gaps = liq
     *
     * For each goal with gap < 0 (must shrink): drain own-goal cash FIRST, then
     * (only if needed) sell own-goal non-cash proportional to currentValue.
     * For each goal with gap > 0 (must grow): buy non-frozen assets of that goal
     * proportional to weightedTargets.
     *
     * Frozen tickers (assets exclusively in locked/excluded portfolios) and cash
     * sitting in locked portfolios are completely off-limits.
     *
     * Returns: ticker → € signed (positive = buy, negative = sell).
     */
    const goalRebalanceAllocations = useMemo<Record<string, number>>(() => {
        const goalIds = Object.keys(goalModeTargets);
        if (goalIds.length === 0) return {};

        const postTotal = aggregateTotalValue + liq;

        const goalGaps: Record<string, number> = {};
        goalIds.forEach(gid => {
            const targetEur = ((goalModeTargets[gid] ?? 0) / 100) * postTotal;
            const currentEur = currentGoalValuesInAggregate[gid] ?? 0;
            goalGaps[gid] = targetEur - currentEur;
        });

        const result: Record<string, number> = {};
        const addToResult = (ticker: string, eur: number) => {
            if (!Number.isFinite(eur) || eur === 0) return;
            result[ticker] = (result[ticker] ?? 0) + eur;
        };

        // Largest-remainder distribution: split |target| € across items in integer
        // shares, then redistribute leftover € to the items with the highest
        // fractional residue. Guarantees Σ shares*price ≈ |target| (loss ≤ price).
        type LRMItem = { ticker: string; weight: number; price: number };
        const distributeLRM = (signedTarget: number, items: LRMItem[]) => {
            const filtered = items.filter(i => i.price > 0);
            if (filtered.length === 0 || Math.abs(signedTarget) < 0.5) return;
            const sign = signedTarget > 0 ? 1 : -1;
            const absTarget = Math.abs(signedTarget);
            const totalWeight = filtered.reduce((s, i) => s + i.weight, 0);
            const useEqual = totalWeight <= 0;

            const dist = filtered.map(i => {
                const ideal = useEqual ? absTarget / filtered.length : absTarget * (i.weight / totalWeight);
                const idealShares = ideal / i.price;
                const flooredShares = Math.floor(idealShares);
                return { ticker: i.ticker, price: i.price, shares: flooredShares, fraction: idealShares - flooredShares };
            });

            let remaining = absTarget - dist.reduce((s, d) => s + d.shares * d.price, 0);
            const sortedIdx = dist.map((_, i) => i).sort((a, b) => dist[b].fraction - dist[a].fraction);
            for (const idx of sortedIdx) {
                if (remaining >= dist[idx].price) {
                    dist[idx].shares += 1;
                    remaining -= dist[idx].price;
                }
            }
            dist.forEach(d => {
                if (d.shares > 0) addToResult(d.ticker, sign * d.shares * d.price);
            });
        };

        goalIds.forEach(gid => {
            const gap = goalGaps[gid] ?? 0;
            if (Math.abs(gap) < 1) return;

            // Per-goal non-cash slice: each ticker appears with the € value held
            // by this goal's portfolios only (non-locked, non-frozen).
            const goalNonCash = nonCashValueByGoal[gid] ?? {};
            const assets = Object.entries(goalNonCash).map(([ticker, valueInGoal]) => {
                const a = includedAssets.find(x => x.ticker === ticker);
                return { ticker, valueInGoal, price: a?.currentPrice || 0 };
            }).filter(a => a.price > 0);

            if (gap > 0) {
                // Buy: LRM proportional to current value held in the goal.
                // Asset Allocation target % is intentionally NOT used here — the
                // goal % targets take priority; only lock/excluded constraints
                // (already filtered into `assets`) are respected.
                distributeLRM(gap, assets.map(a => ({
                    ticker: a.ticker, weight: a.valueInGoal, price: a.price,
                })));
            } else {
                // Sell: drain own-goal cash first (cash is fungible, exact €)
                let remaining = -gap;
                const cashAssets = cashByGoal[gid] ?? [];
                const totalCashInGoal = cashAssets.reduce((s, c) => s + c.value, 0);
                if (totalCashInGoal > 0) {
                    const cashSell = Math.min(remaining, totalCashInGoal);
                    cashAssets.forEach(c => {
                        const amt = cashSell * (c.value / totalCashInGoal);
                        addToResult(c.ticker, -Math.round(amt));
                    });
                    remaining -= cashSell;
                }
                // Residual: sell own-goal non-cash via LRM proportional to value-in-goal
                if (remaining > 0.5) {
                    distributeLRM(-remaining, assets.map(a => ({
                        ticker: a.ticker, weight: a.valueInGoal, price: a.price,
                    })));
                }
            }
        });

        // Drop sub-€ noise
        const cleaned: Record<string, number> = {};
        Object.entries(result).forEach(([ticker, eur]) => {
            if (Math.abs(eur) >= 1) cleaned[ticker] = eur;
        });
        return cleaned;
    }, [goalModeTargets, aggregateTotalValue, liq, currentGoalValuesInAggregate,
        includedAssets, cashByGoal, nonCashValueByGoal]);

    /**
     * Min‑liquidity warnings for the goal rebalance: this section ignores broker
     * minimal liquidity when computing buys/sells, but flags any broker whose
     * post‑rebalance cash would fall below its configured threshold.
     */
    const brokerLiquidityWarnings = useMemo<{
        brokerId: string; brokerName: string; postCash: number; threshold: number; deficit: number;
    }[]>(() => {
        // brokerId → drained € (negative) from goalRebalanceAllocations cash entries
        const drainByBroker: Record<string, number> = {};
        Object.entries(goalRebalanceAllocations).forEach(([ticker, eur]) => {
            if (!ticker.startsWith(CASH_TICKER_PREFIX)) return;
            const brokerId = ticker.slice(CASH_TICKER_PREFIX.length);
            drainByBroker[brokerId] = (drainByBroker[brokerId] ?? 0) + eur;
        });

        const warnings: { brokerId: string; brokerName: string; postCash: number; threshold: number; deficit: number }[] = [];
        brokers.forEach(b => {
            const drain = drainByBroker[b.id] ?? 0;
            if (drain >= 0) return; // only flag drains
            const currentBrokerCash = Object.values(b.liquidityAllocations || {}).reduce((s, v) => s + (v || 0), 0);
            const postCash = currentBrokerCash + drain;
            let threshold = 0;
            if (b.minLiquidityType === 'fixed') {
                threshold = b.minLiquidityAmount || 0;
            } else if (b.minLiquidityType === 'percent') {
                threshold = currentBrokerCash * ((b.minLiquidityPercentage || 0) / 100);
            }
            if (threshold > 0 && postCash < threshold) {
                warnings.push({
                    brokerId: b.id,
                    brokerName: b.name,
                    postCash,
                    threshold,
                    deficit: threshold - postCash,
                });
            }
        });
        return warnings;
    }, [goalRebalanceAllocations, brokers]);

    return (
        <div className="allocation-card" style={{ border: '1.5px dashed rgba(148,163,184,0.45)', background: 'var(--bg-surface)' }}>
            <div className="allocation-header-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                <h3 className="section-title" style={{ margin: 0 }}>
                    <span style={{ fontSize: '0.8em', fontWeight: 500, color: 'var(--text-muted)', marginRight: 'var(--space-2)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>∑</span>Aggregate <span style={{ fontSize: '0.9em', fontWeight: 'normal', color: 'var(--text-secondary)' }}>
                        ({aggregateTotalValue.toLocaleString('en-IE', { style: 'currency', currency: 'EUR' })})
                    </span>
                    {realizedDetails.length > 0 && (
                        <span
                            style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: totalRealized >= 0 ? 'var(--color-success)' : 'var(--color-danger)', borderBottom: '1px dashed currentColor', cursor: 'pointer' }}
                            onClick={e => { e.stopPropagation(); setShowRealizedModal(true); }}
                        >
                            Realized: {totalRealized >= 0 ? '+' : ''}€{totalRealized.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {cashFlowDetails.length > 0 && (
                        <span
                            style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: '#3B82F6', borderBottom: '1px dashed currentColor', cursor: 'pointer' }}
                            onClick={e => { e.stopPropagation(); setShowCashFlowModal(true); }}
                        >
                            Distributions: +€{totalIncome.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {(includedGain !== 0 || totalRealized !== 0 || totalIncome !== 0) && (
                        <span style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: aggregateTotalReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            Total Return: {aggregateTotalReturn >= 0 ? '+' : ''}€{aggregateTotalReturn.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({aggregateTotalReturnPerc.toFixed(1)}%)
                        </span>
                    )}
                    <RealizedGainsModal isOpen={showRealizedModal} onClose={() => setShowRealizedModal(false)} title="Realized — Aggregate" details={realizedDetails} totalRealized={totalRealized} totalCommissions={realizedCommissions} totalTax={realizedTax} getLabel={getLabel} />
                    <CashFlowModal isOpen={showCashFlowModal} onClose={() => setShowCashFlowModal(false)} details={cashFlowDetails} totalDividends={totalDividends} totalCoupons={totalCoupons} totalIncome={totalIncome} getLabel={getLabel} />
                </h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    <div className="allocation-liquidity-controls" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Liquidity:</label>
                        <input
                            type="number"
                            placeholder="0.00"
                            value={additionalLiquidity !== undefined ? additionalLiquidity : ''}
                            onChange={e => setAdditionalLiquidity(e.target.value === '' ? undefined : parseFloat(e.target.value))}
                            style={{ borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', width: '100px', textAlign: 'right' }}
                        />
                    </div>
                    <button
                        onClick={() => setIsEditing(e => !e)}
                        style={{
                            fontSize: '0.78rem', padding: '3px 10px', borderRadius: 'var(--radius-sm)',
                            border: isEditing ? '1px solid rgba(148,163,184,0.5)' : '1px solid var(--border-color)',
                            background: isEditing ? 'rgba(148,163,184,0.12)' : 'transparent',
                            color: isEditing ? 'var(--text-primary)' : 'var(--text-muted)',
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', flexShrink: 0,
                        }}
                        title="Include/exclude assets from calculation"
                    >
                        {isEditing ? '✓ Done' : `⚙ Filter${excludedCount > 0 ? ` (${excludedCount} excluded)` : ''}`}
                    </button>
                </div>
            </div>

            {brokerLiquidityWarnings.length > 0 && (
                <div style={{
                    marginBottom: 'var(--space-3)',
                    padding: 'var(--space-2) var(--space-3)',
                    border: '1px solid rgba(245,158,11,0.45)',
                    background: 'rgba(245,158,11,0.08)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.82rem',
                    color: 'var(--text-primary)',
                }}>
                    <div style={{ fontWeight: 600, marginBottom: '4px', color: '#B45309' }}>
                        ⚠ Goal rebalance: some brokers would fall below min liquidity
                    </div>
                    {brokerLiquidityWarnings.map(w => (
                        <div key={w.brokerId} style={{ lineHeight: 1.5 }}>
                            <strong>{w.brokerName}</strong>: post-rebalance cash €{w.postCash.toLocaleString('en-IE', { maximumFractionDigits: 0 })} &lt; min required €{w.threshold.toLocaleString('en-IE', { maximumFractionDigits: 0 })} (Δ −€{w.deficit.toLocaleString('en-IE', { maximumFractionDigits: 0 })})
                        </div>
                    ))}
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                        Buy/sell orders are calculated regardless, ignoring the constraint.
                    </div>
                </div>
            )}

            <div className="allocation-details" style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                <div className="allocation-row desktop-only" style={{ fontWeight: 600, color: 'var(--text-muted)', border: 'none' }}>
                    {isEditing && <div style={{ width: '36px' }} />}
                    <div style={{ flex: 1 }}>Asset</div>
                    <div style={{ width: '100px', textAlign: 'center' }}>Qty</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Pmc</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Mkt Price</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Value</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Gain</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Target (w)</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Actual</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Action</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Post Act %</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Buy Only</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Post Buy %</div>
                    <div style={{ width: '130px', textAlign: 'center', color: '#8B5CF6' }}>Goal Rebalance</div>
                    <div style={{ width: '80px', textAlign: 'center', color: '#8B5CF6' }}>Post Goal %</div>
                </div>

                {allVisibleAssets.length === 0 ? (
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>No assets currently held.</p>
                ) : (
                    allVisibleAssets.map(asset => {
                        const isExcluded = excludedTickers.includes(asset.ticker);
                        const isCash = isCashTicker(asset.ticker);
                        const isVBond = isVirtualBondTicker(asset.ticker);
                        const vb = isVBond ? virtualBonds.find(b => b.id === getVirtualBondId(asset.ticker)) : undefined;
                        const setting = assetSettings.find(s => s.ticker === asset.ticker);
                        const assetClass = isCash ? 'Cash' : isVBond ? 'Bond' : (setting?.assetClass || asset.assetClass || 'Stock');
                        const label = isCash ? (asset.label || asset.ticker) : isVBond ? (vb?.label || asset.ticker) : (setting?.label || asset.label || asset.ticker);

                        // Use calcTotalValue (includes additional liquidity) for % calcs
                        const currentPerc = calcTotalValue > 0 ? (asset.currentValue / calcTotalValue) * 100 : 0;
                        const targetPerc = isCash ? 0 : (weightedTargets[asset.ticker] ?? 0);

                        // Rebalance (full) — only for included, non-cash assets
                        let rebalanceShares = 0;
                        let rebalanceAmount = 0;
                        let postRebalancePerc = currentPerc;

                        if (!isCash && !isExcluded && calcTotalValue > 0) {
                            const targetValue = calcTotalValue * (targetPerc / 100);
                            const idealDiff = targetValue - asset.currentValue;
                            const price = asset.currentPrice || 0;
                            if (price > 0) {
                                rebalanceShares = Math.round(idealDiff / price);
                                rebalanceAmount = rebalanceShares * price;
                            }
                            const postValue = asset.currentValue + rebalanceAmount;
                            postRebalancePerc = calcTotalValue > 0 ? (postValue / calcTotalValue) * 100 : 0;
                        }

                        // Buy-only — only for included, non-cash assets
                        const buyOnlyAmountRaw = (!isCash && !isExcluded) ? (aggregateBuyOnlyAllocations[asset.ticker] || 0) : 0;
                        let buyOnlyShares = 0;
                        let buyOnlyAmount = 0;
                        let projectedPerc = currentPerc;

                        if (buyOnlyAmountRaw > 0) {
                            const price = asset.currentPrice || 0;
                            if (price > 0) {
                                buyOnlyShares = Math.round(buyOnlyAmountRaw / price);
                                buyOnlyAmount = buyOnlyAmountRaw;
                            }
                            const postBuyValue = asset.currentValue + buyOnlyAmount;
                            projectedPerc = calcTotalValue > 0 ? (postBuyValue / calcTotalValue) * 100 : 0;
                        }

                        // Goal rebalance — buy/sell with no new money. Cash rows show
                        // the € drained (negative) when their goal must shrink — no shares.
                        const goalRebalanceRaw = !isExcluded ? (goalRebalanceAllocations[asset.ticker] ?? 0) : 0;
                        let goalModeShares = 0;
                        let goalModeEur = 0;
                        let postGoalPerc = currentPerc;

                        if (goalRebalanceRaw !== 0) {
                            goalModeEur = goalRebalanceRaw;
                            if (!isCash) {
                                const price = asset.currentPrice || 0;
                                if (price > 0) {
                                    goalModeShares = Math.round(goalRebalanceRaw / price);
                                }
                            }
                            // Post-rebalance total = aggregateTotalValue + liq (liquidity deployed)
                            const postGoalValue = asset.currentValue + goalModeEur;
                            const postTotal = aggregateTotalValue + liq;
                            postGoalPerc = postTotal > 0 ? (postGoalValue / postTotal) * 100 : 0;
                        }

                        return (
                            <AggregateRow
                                key={asset.ticker}
                                ticker={asset.ticker}
                                label={label}
                                assetClass={assetClass}
                                isCash={isCash}
                                isVBond={isVBond}
                                vbondMaturity={vb?.targetMaturityDate}
                                quantity={asset.quantity}
                                averagePrice={asset.averagePrice}
                                currentPrice={asset.currentPrice || 0}
                                currentValue={asset.currentValue}
                                gain={asset.gain || 0}
                                gainPerc={asset.gainPercentage || 0}
                                currentPerc={currentPerc}
                                targetPerc={targetPerc}
                                rebalanceAmount={rebalanceAmount}
                                rebalanceShares={rebalanceShares}
                                buyOnlyAmount={buyOnlyAmount}
                                buyOnlyShares={buyOnlyShares}
                                postRebalancePerc={postRebalancePerc}
                                projectedPerc={projectedPerc}
                                goalModeEur={goalModeEur}
                                goalModeShares={goalModeShares}
                                postGoalPerc={postGoalPerc}
                                spreadPercent={marketData[asset.ticker.toUpperCase()]?.spreadPercent ?? marketData[asset.ticker]?.spreadPercent ?? null}
                                brokers={brokers}
                                tradeBroker={tickerToBroker[asset.ticker.toUpperCase()]}
                                monthsHeld={tickerToMonthsHeld[asset.ticker.toUpperCase()]}
                                isEditing={isEditing}
                                isExcluded={isExcluded}
                                onToggleExclude={() => toggleExcluded(asset.ticker)}
                                onConcretize={isVBond && vb ? () => setConcretizingVBond(vb) : undefined}
                            />
                        );
                    })
                )}
            </div>

            {concretizingVBond && (
                <ConcretizeModal
                    bond={concretizingVBond}
                    brokers={brokers}
                    portfolios={portfolios}
                    onConfirm={(fill) => {
                        concretizeVirtualBond(concretizingVBond.id, fill);
                        setConcretizingVBond(null);
                    }}
                    onClose={() => setConcretizingVBond(null)}
                />
            )}
        </div>
    );
};

interface AggregateRowProps {
    ticker: string;
    label: string;
    assetClass: string;
    isCash: boolean;
    isVBond?: boolean;
    vbondMaturity?: string;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    currentValue: number;
    gain: number;
    gainPerc: number;
    currentPerc: number;
    targetPerc: number;
    rebalanceAmount: number;
    rebalanceShares: number;
    buyOnlyAmount: number;
    buyOnlyShares: number;
    postRebalancePerc: number;
    projectedPerc: number;
    goalModeEur: number;
    goalModeShares: number;
    postGoalPerc: number;
    spreadPercent?: number | null;
    brokers: Broker[];
    tradeBroker?: Broker;
    monthsHeld?: number;
    isEditing: boolean;
    isExcluded: boolean;
    onToggleExclude: () => void;
    onConcretize?: () => void;
}

const AggregateRow: React.FC<AggregateRowProps> = ({
    ticker, label, assetClass, isCash, isVBond, vbondMaturity, quantity, averagePrice, currentPrice, currentValue,
    gain, gainPerc, currentPerc, targetPerc,
    rebalanceAmount, rebalanceShares, buyOnlyAmount, buyOnlyShares, postRebalancePerc, projectedPerc,
    goalModeEur, goalModeShares, postGoalPerc,
    spreadPercent, brokers, tradeBroker, monthsHeld,
    isEditing, isExcluded, onToggleExclude, onConcretize,
}) => {
    const [mExpanded, setMExpanded] = React.useState(false);
    const taxRate = assetClass === 'Bond' ? 0.125 : 0.26;
    const diff = currentPerc - targetPerc;
    const colorMap: Record<string, string> = {
        'Stock': 'dot-etf',
        'Bond': 'dot-bond',
        'Commodity': 'dot-commodity',
        'Crypto': 'dot-crypto'
    };
    const colorClass = colorMap[assetClass] || 'dot-neutral';
    const rowOpacity = isExcluded ? 0.35 : 1;

    return (
        <>
            {/* Desktop */}
            <div className="allocation-row desktop-only" style={{ padding: 'var(--space-3) 0', opacity: rowOpacity, transition: 'opacity 0.15s' }}>
                {isEditing && (
                    <button
                        onClick={onToggleExclude}
                        title={isExcluded ? 'Include in calculation' : 'Exclude from calculation'}
                        style={{
                            width: '24px', height: '24px', borderRadius: '50%', border: '1.5px solid',
                            borderColor: isExcluded ? 'var(--text-muted)' : 'var(--color-success)',
                            background: isExcluded ? 'transparent' : 'rgba(16,185,129,0.12)',
                            color: isExcluded ? 'var(--text-muted)' : 'var(--color-success)',
                            cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center',
                            justifyContent: 'center', flexShrink: 0, marginRight: '8px',
                        }}
                    >{isExcluded ? '✕' : '✓'}</button>
                )}
                <div className="allocation-type" style={{ flex: 1 }}>
                    <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                    <div>
                        {isVBond && <span style={{ fontSize: '0.65rem', background: '#8B5CF6', color: '#fff', borderRadius: '3px', padding: '1px 4px', marginRight: '6px', verticalAlign: 'middle' }}>VBOND</span>}
                        <strong>{label || ticker}</strong>
                        {isVBond && vbondMaturity && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '6px' }}>mat. {vbondMaturity}</span>}
                        {isVBond && onConcretize && <button onClick={onConcretize} style={{ marginLeft: '8px', fontSize: '0.7rem', background: '#8B5CF6', color: '#fff', border: 'none', borderRadius: '4px', padding: '2px 8px', cursor: 'pointer' }}>Concretizza</button>}
                    </div>
                </div>
                <div style={{ width: '100px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : parseFloat(quantity.toFixed(4))}
                </div>
                <div style={{ width: '110px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : `€${averagePrice.toFixed(2)}`}
                </div>
                <div style={{ width: '110px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : `€${currentPrice.toFixed(2)}`}
                </div>
                <div style={{ width: '110px', textAlign: 'center' }}>
                    €{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{ width: '110px', textAlign: 'center', fontSize: '0.9rem' }}>
                    {isCash ? (
                        <div style={{ color: 'var(--text-muted)' }}>-</div>
                    ) : (
                        <>
                            <div style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: gainPerc >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gainPerc.toFixed(1)}%
                            </div>
                        </>
                    )}
                </div>
                <div style={{ width: '80px', textAlign: 'center' }}>
                    {isCash ? <span style={{ color: 'var(--text-muted)' }}>-</span> : `${targetPerc.toFixed(1)}%`}
                </div>
                <div style={{ width: '80px', textAlign: 'center' }}>
                    <div className="allocation-perc">{currentPerc.toFixed(1)}%</div>
                    {!isCash && targetPerc > 0 && (
                        <div className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ fontSize: '0.75rem' }}>
                            {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                        </div>
                    )}
                </div>
                {/* Action (full rebalance) */}
                <div style={{ width: '130px', textAlign: 'center' }}>
                    {(isCash || isExcluded) ? (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                    ) : (
                        <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {rebalanceShares === 0 ? (
                                <TradeCostInfo shares={0} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                    <span className="trend-neutral">OK</span>
                                </TradeCostInfo>
                            ) : (
                                <TradeCostInfo shares={rebalanceShares} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                        <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                </TradeCostInfo>
                            )}
                        </div>
                    )}
                </div>
                <div style={{ width: '80px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {(isCash || isExcluded) ? '-' : `${postRebalancePerc.toFixed(1)}%`}
                </div>
                {/* Buy Only */}
                <div style={{ width: '130px', textAlign: 'center' }}>
                    {(isCash || isExcluded) ? (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                    ) : (
                        <div style={{ fontWeight: 600, color: buyOnlyAmount > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                            {buyOnlyShares === 0 ? (
                                <TradeCostInfo shares={0} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                    <span className="trend-neutral">-</span>
                                </TradeCostInfo>
                            ) : (
                                <TradeCostInfo shares={buyOnlyShares} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                        <span>Buy {Math.abs(buyOnlyShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                </TradeCostInfo>
                            )}
                        </div>
                    )}
                </div>
                <div style={{ width: '80px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {(isCash || isExcluded) ? '-' : `${projectedPerc.toFixed(1)}%`}
                </div>
                {/* Goal Rebalance */}
                <div style={{ width: '130px', textAlign: 'center' }}>
                    {isExcluded ? (
                        <span style={{ color: 'var(--text-muted)' }}>-</span>
                    ) : (
                        <div style={{ fontWeight: 600, color: goalModeEur > 0 ? '#8B5CF6' : goalModeEur < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {goalModeEur === 0 ? (
                                <span className="trend-neutral">-</span>
                            ) : isCash ? (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                    <span>{goalModeEur > 0 ? 'Add' : 'Sell'}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        −€{Math.abs(goalModeEur).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                    <span>{goalModeShares > 0 ? 'Buy' : 'Sell'} {Math.abs(goalModeShares)}</span>
                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                        €{Math.abs(goalModeEur).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div style={{ width: '80px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {isExcluded ? '-' : goalModeEur !== 0 ? `${postGoalPerc.toFixed(1)}%` : '-'}
                </div>
            </div>

            {/* Mobile dense expandable row (mrow pattern) — all 14 desktop columns. */}
            <div className={`mobile-only mrow ${mExpanded ? 'is-open' : ''}`} style={{ opacity: rowOpacity, transition: 'opacity 0.15s' }}>
                <div className="mrow-head" onClick={() => setMExpanded(v => !v)}>
                    {isEditing && (
                        <button
                            onClick={e => { e.stopPropagation(); onToggleExclude?.(); }}
                            title={isExcluded ? 'Include' : 'Exclude'}
                            style={{
                                width: '22px', height: '22px', borderRadius: '50%', border: '1.5px solid',
                                borderColor: isExcluded ? 'var(--text-muted)' : 'var(--color-success)',
                                background: isExcluded ? 'transparent' : 'rgba(16,185,129,0.12)',
                                color: isExcluded ? 'var(--text-muted)' : 'var(--color-success)',
                                cursor: 'pointer', fontSize: '0.7rem', display: 'flex', alignItems: 'center',
                                justifyContent: 'center', flexShrink: 0,
                            }}
                        >{isExcluded ? '✕' : '✓'}</button>
                    )}
                    <span className="mrow-chevron">▶</span>
                    <div className="mrow-main">
                        <div className="mrow-line1">
                            <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass), flex: '0 0 auto' }} />
                            {isVBond && <span style={{ fontSize: '0.6rem', background: '#8B5CF6', color: '#fff', borderRadius: '3px', padding: '1px 4px', flex: '0 0 auto' }}>VBOND</span>}
                            <span className="mrow-title">{label || ticker}</span>
                        </div>
                        <div className="mrow-line2">
                            {!isCash && (
                                <span style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)', flex: '0 0 auto' }}>
                                    {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                                </span>
                            )}
                            <span>
                                {currentPerc.toFixed(1)}%{!isCash && ` / T ${targetPerc.toFixed(1)}%`}
                                {!isCash && targetPerc > 0 && (
                                    <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px' }}>
                                        ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                                    </span>
                                )}
                            </span>
                        </div>
                    </div>
                    <div className="mrow-side">
                        <div className="mrow-side-primary">€{currentValue.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</div>
                        {!isCash && !isExcluded && (
                            <div className="mrow-side-secondary" style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                {rebalanceShares === 0
                                    ? 'OK'
                                    : `${rebalanceShares > 0 ? 'Buy' : 'Sell'} ${Math.abs(rebalanceShares)} · €${Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}`}
                            </div>
                        )}
                    </div>
                </div>

                {mExpanded && (
                    <div className="mrow-details">
                        {!isCash && (
                            <>
                                <div className="mrow-detail">
                                    <span className="mrow-label">Qty</span>
                                    <span className="mrow-value">{parseFloat(quantity.toFixed(4))}</span>
                                </div>
                                <div className="mrow-detail">
                                    <span className="mrow-label">Pmc</span>
                                    <span className="mrow-value">€{averagePrice.toFixed(2)}</span>
                                </div>
                                <div className="mrow-detail">
                                    <span className="mrow-label">Mkt Price</span>
                                    <span className="mrow-value">€{currentPrice.toFixed(2)}</span>
                                </div>
                            </>
                        )}
                        <div className="mrow-detail">
                            <span className="mrow-label">Value</span>
                            <span className="mrow-value">€{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Target (w)</span>
                            <span className="mrow-value">{isCash ? '-' : `${targetPerc.toFixed(1)}%`}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Actual</span>
                            <span className="mrow-value">
                                {currentPerc.toFixed(1)}%
                                {!isCash && targetPerc > 0 && (
                                    <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px', fontSize: '0.72rem' }}>
                                        ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                                    </span>
                                )}
                            </span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Post Act %</span>
                            <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>{(isCash || isExcluded) ? '-' : `${postRebalancePerc.toFixed(1)}%`}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Post Buy %</span>
                            <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>{(isCash || isExcluded) ? '-' : `${projectedPerc.toFixed(1)}%`}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Post Goal %</span>
                            <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>{(isExcluded || goalModeEur === 0) ? '-' : `${postGoalPerc.toFixed(1)}%`}</span>
                        </div>
                        {isVBond && vbondMaturity && (
                            <div className="mrow-detail">
                                <span className="mrow-label">Maturity</span>
                                <span className="mrow-value">{vbondMaturity}</span>
                            </div>
                        )}
                        {isVBond && onConcretize && (
                            <div className="mrow-detail--wide">
                                <button
                                    onClick={e => { e.stopPropagation(); onConcretize(); }}
                                    style={{ fontSize: '0.75rem', background: '#8B5CF6', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer' }}
                                >Concretizza</button>
                            </div>
                        )}
                        {!isExcluded && (rebalanceShares !== 0 || buyOnlyShares !== 0 || goalModeEur !== 0) && (
                            <div className="mrow-actions">
                                {!isCash && rebalanceShares !== 0 && (
                                    <div className="mrow-action-box">
                                        <span className="mrow-label">Rebalance</span>
                                        <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                            <TradeCostInfo shares={rebalanceShares} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                                    <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                                        €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                                    </span>
                                                </div>
                                            </TradeCostInfo>
                                        </div>
                                    </div>
                                )}
                                {!isCash && buyOnlyShares !== 0 && (
                                    <div className="mrow-action-box">
                                        <span className="mrow-label">Buy Only</span>
                                        <div style={{ fontWeight: 600, color: 'var(--color-success)' }}>
                                            <TradeCostInfo shares={buyOnlyShares} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                                    <span>Buy {Math.abs(buyOnlyShares)}</span>
                                                    <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                                        €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                                    </span>
                                                </div>
                                            </TradeCostInfo>
                                        </div>
                                    </div>
                                )}
                                {goalModeEur !== 0 && (
                                    <div className="mrow-action-box">
                                        <span className="mrow-label" style={{ color: goalModeEur > 0 ? '#8B5CF6' : 'var(--color-danger)' }}>Goal Rebalance</span>
                                        <div style={{ fontWeight: 600, color: goalModeEur > 0 ? '#8B5CF6' : 'var(--color-danger)' }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                                {isCash ? (
                                                    <span>{goalModeEur > 0 ? 'Add' : 'Sell'}</span>
                                                ) : (
                                                    <span>{goalModeShares > 0 ? 'Buy' : 'Sell'} {Math.abs(goalModeShares)}</span>
                                                )}
                                                <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                                    {isCash && goalModeEur < 0 ? '−' : ''}€{Math.abs(goalModeEur).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    );
};

interface AllocationTableProps {
    portfolio: import('../../types').Portfolio;
    allTransactions: import('../../types').Transaction[];
    assetSettings: import('../../types').AssetDefinition[];
    marketData: Record<string, { price: number, lastUpdated: string, spreadPercent?: number | null, volatility?: number | null, indexationCoefficient?: number | null }>;
    brokers: import('../../types').Broker[];
    onUpdatePortfolio: (portfolio: import('../../types').Portfolio) => void;
    onAddTransactions: (transactions: import('../../types').Transaction[]) => void;
}

export const PortfolioAllocationTable: React.FC<AllocationTableProps> = ({ portfolio, allTransactions, assetSettings, marketData, brokers, onUpdatePortfolio, onAddTransactions }) => {
    const [isWithdrawalModalOpen, setIsWithdrawalModalOpen] = React.useState(false);
    const [expandedGroupRows, setExpandedGroupRows] = React.useState<Record<string, boolean>>({});

    // Filter Txs for this portfolio
    const portfolioTxs = useMemo(() => {
        return allTransactions.filter(t => t.portfolioId === portfolio.id);
    }, [allTransactions, portfolio.id]);

    // Realized gains for this portfolio
    const { totalRealized, details: realizedDetails, totalCommissions: realizedCommissions, totalTax: realizedTax } = useMemo(
        () => calculateRealizedGains(portfolioTxs, brokers, assetSettings),
        [portfolioTxs, brokers, assetSettings]
    );
    const [showRealizedModal, setShowRealizedModal] = React.useState(false);

    // Cash flows (distributions) for this portfolio
    const { totalIncome: portfolioIncome, totalDividends: portfolioDividends, totalCoupons: portfolioCoupons, byTicker: portfolioCashFlowDetails } = useMemo(
        () => calculateCashFlows(portfolioTxs),
        [portfolioTxs]
    );
    const [showCashFlowModal, setShowCashFlowModal] = React.useState(false);
    const getCashFlowLabel = (ticker: string) => assetSettings.find(s => s.ticker === ticker)?.label || ticker;

    const fmtNum = (n: number) => n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const getRealizedLabel = (ticker: string) => assetSettings.find(s => s.ticker === ticker)?.label || ticker;

    // Calculate Assets for this portfolio, then inject virtual Cash assets from broker allocations
    const { assets, summary } = useMemo(() => {
        const result = calculateAssets(portfolioTxs, assetSettings, marketData);
        return {
            assets: injectCashAssets(result.assets, brokers, portfolio.id),
            summary: result.summary
        };
    }, [portfolioTxs, assetSettings, marketData, brokers, portfolio.id]);

    const portfolioTotalReturn = summary.totalGain + totalRealized + portfolioIncome;
    const portfolioTotalReturnPerc = summary.totalCost > 0 ? (portfolioTotalReturn / summary.totalCost) * 100 : 0;

    const allocations = portfolio.allocations || {};

    // Total value of injected cash assets (broker liquidity allocated to this portfolio)
    const cashAssetsValue = useMemo(() => {
        return assets.filter(a => isCashTicker(a.ticker)).reduce((sum, a) => sum + a.currentValue, 0);
    }, [assets]);

    const assetTickers = assets.map(a => a.ticker);
    const targetTickers = Object.keys(allocations);
    const allTickers = Array.from(new Set([...assetTickers, ...targetTickers])).sort();

    // Portfolio total = invested assets + broker cash allocated here. Per-portfolio
    // liquidity is shown in the Liquidity field and only deployed by Buy-Only, so it
    // is not summed into the total (nor the rebalancing target base).
    const totalPortfolioValue = summary.totalValue + cashAssetsValue;

    // --- Multi-asset market groups (per-portfolio) ---
    const groupList = useMemo(() => portfolio.allocationGroups || [], [portfolio.allocationGroups]);
    const { tickerToGroupId } = useMemo(() => resolveGroups(portfolio), [portfolio]);

    // Standalone tickers = everything that is not a group id and not a member of a group.
    const standaloneTickers = useMemo(
        () => allTickers.filter(t => !isGroupKey(t) && !tickerToGroupId[t.toUpperCase()]),
        [allTickers, tickerToGroupId]
    );

    // Per-group aggregates + full-rebalance member actions.
    const groupComputations = useMemo(() => {
        return groupList.map(group => {
            const memberInfo = memberInfoFromAssets(group.members, assets, marketData);
            const memberAssets = group.members.map(m => assets.find(a => a.ticker.toUpperCase() === m.toUpperCase()));
            const currentValue = Object.values(memberInfo).reduce((s, mi) => s + mi.currentValue, 0);
            const gain = memberAssets.reduce((s, a) => s + (a?.gain || 0), 0);
            const targetPerc = allocations[group.id] || 0;
            const targetValue = totalPortfolioValue * (targetPerc / 100);
            const delta = targetValue - currentValue;
            const full = distributeGroupDelta({ deltaEur: delta, members: group.members, memberInfo, rules: group.memberRules });
            const currentPerc = totalPortfolioValue > 0 ? (currentValue / totalPortfolioValue) * 100 : 0;
            const actionEur = Object.values(full.actions).reduce((s, a) => s + a.eur, 0);
            const postRebalancePerc = totalPortfolioValue > 0 ? ((currentValue + actionEur) / totalPortfolioValue) * 100 : 0;
            return { group, memberInfo, currentValue, gain, targetPerc, targetValue, delta, full, currentPerc, actionEur, postRebalancePerc };
        });
    }, [groupList, assets, allocations, totalPortfolioValue, marketData]);

    const groupCompById = useMemo(() => {
        const map: Record<string, typeof groupComputations[number]> = {};
        groupComputations.forEach(gc => { map[gc.group.id] = gc; });
        return map;
    }, [groupComputations]);

    // Helper to calculate Buy Only amounts with integer share optimization
    // Strategy: Proportional Gap Filling + Largest Remainder Method
    // Each competing unit is a standalone ticker OR a whole group (priced at its buy-recipient
    // member). After liquidity is assigned per unit, group euro is routed to member buy actions.
    const buyOnly = useMemo(() => {
        const liq = portfolio.liquidity || 0;
        const empty = { byUnit: {} as Record<string, number>, memberBuy: {} as Record<string, MemberAction> };
        if (liq <= 0) return empty;

        const totalVal = summary.totalValue + liq + cashAssetsValue;
        const candidates: BuyOnlyCandidate[] = [];

        // Standalone tickers
        standaloneTickers.filter(t => !isCashTicker(t)).forEach(ticker => {
            const asset = assets.find(a => a.ticker === ticker);
            const currentValue = asset?.currentValue ?? 0;
            const price = asset?.currentPrice ?? 0;
            const targetPerc = allocations[ticker] || 0;
            const gap = totalVal * (targetPerc / 100) - currentValue;
            candidates.push({ key: ticker, gap, price, pacPriority: pacPriorityFor(portfolio.pacConfigs, ticker) });
        });

        // Groups — one candidate each. Priority groups are priced at the buy-recipient
        // member; weighted groups at the cheapest buy-eligible active member (buys can
        // split across members). Weighted groups with an invalid setup are skipped so
        // they don't soak up liquidity they can't deploy.
        groupComputations.forEach(gc => {
            const wcfg = groupWeightConfig(gc.group.members, gc.group.memberRules);
            let price: number | undefined;
            if (wcfg.weighted) {
                if (!wcfg.valid) return;
                gc.group.members.forEach(m => {
                    const rule = gc.group.memberRules?.[m] ?? gc.group.memberRules?.[m.toUpperCase()] ?? {};
                    if (isFullyFrozen(rule) || rule.noBuy) return;
                    const mi = gc.memberInfo[m.toUpperCase()];
                    if (mi && mi.price > 0 && (price === undefined || mi.price < price)) price = mi.price;
                });
            } else {
                price = buyRecipientOf(gc.group, gc.memberInfo)?.price;
            }
            if (price === undefined) return;
            const gap = totalVal * (gc.targetPerc / 100) - gc.currentValue;
            candidates.push({ key: gc.group.id, gap, price, pacPriority: pacPriorityFor(portfolio.pacConfigs, gc.group.id) });
        });

        // PAC entries drink first (by priority tier), the rest shares the leftover.
        const byUnit = distributeBuyOnlyWithPac(candidates, liq);

        // Route each group's assigned euro to its member buy action(s).
        const memberBuy: Record<string, MemberAction> = {};
        groupComputations.forEach(gc => {
            const euro = byUnit[gc.group.id] || 0;
            if (euro <= 0) return;
            const dist = distributeGroupDelta({ deltaEur: euro, members: gc.group.members, memberInfo: gc.memberInfo, rules: gc.group.memberRules });
            Object.values(dist.actions).forEach(a => { memberBuy[a.ticker.toUpperCase()] = a; });
        });

        return { byUnit, memberBuy };
    }, [standaloneTickers, groupComputations, allocations, assets, portfolio.liquidity, portfolio.pacConfigs, summary.totalValue, cashAssetsValue]);

    const hasPacs = useMemo(
        () => Object.values(portfolio.pacConfigs || {}).some(c => c.enabled),
        [portfolio.pacConfigs]
    );

    // Extra cash needed — beyond the liquidity already entered (which PAC entries
    // absorb first) — to complete a buy-only rebalance of what's left behind
    // (the non-PAC underweights). Group-aware: a group counts as one unit.
    const nonPacExtraLiquidity = useMemo(() => {
        if (!hasPacs) return 0;
        const units: { currentValue: number; targetPerc: number }[] = [];
        standaloneTickers.forEach(t => {
            const asset = assets.find(a => a.ticker === t);
            units.push({ currentValue: asset?.currentValue ?? 0, targetPerc: allocations[t] || 0 });
        });
        groupComputations.forEach(gc => {
            units.push({ currentValue: gc.currentValue, targetPerc: gc.targetPerc });
        });
        const required = requiredLiquidityForFullBuyOnly(units);
        return Math.max(0, required - (portfolio.liquidity || 0));
    }, [hasPacs, standaloneTickers, groupComputations, assets, allocations, portfolio.liquidity]);

    // --- Execution Handlers ---
    const handleExecuteRebalance = async (mode: 'Full' | 'BuyOnly') => {
        const Swal = (await import('sweetalert2')).default;

        const transactionsToCreate: import('../../types').Transaction[] = [];

        const pushTx = (ticker: string, shares: number, price: number) => {
            if (shares === 0 || price <= 0) return;
            const lastTx = allTransactions.filter(t => t.ticker === ticker && t.portfolioId === portfolio.id).pop();
            transactionsToCreate.push({
                id: `auto-rebal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                portfolioId: portfolio.id,
                ticker,
                date: new Date().toISOString().split('T')[0],
                amount: Math.abs(shares),
                price,
                direction: shares > 0 ? 'Buy' : 'Sell',
                brokerId: lastTx?.brokerId,
            });
        };

        // Standalone tickers
        standaloneTickers.forEach(ticker => {
            if (isCashTicker(ticker)) return;
            const asset = assets.find(a => a.ticker === ticker);
            const currentPrice = asset?.currentPrice || 0;
            const targetPerc = allocations[ticker] || 0;
            const quantity = asset?.quantity || 0;
            if (quantity <= 0 && targetPerc <= 0) return;

            let shares = 0;
            if (mode === 'Full') {
                const targetValue = totalPortfolioValue * (targetPerc / 100);
                const idealDiff = targetValue - (asset ? asset.currentValue : 0);
                if (currentPrice > 0) shares = Math.round(idealDiff / currentPrice);
            } else {
                const buyOnlyAmountIdeal = buyOnly.byUnit[ticker] || 0;
                if (currentPrice > 0) shares = Math.round(buyOnlyAmountIdeal / currentPrice);
            }
            pushTx(ticker, shares, currentPrice);
        });

        // Group members
        groupComputations.forEach(gc => {
            const actions: MemberAction[] = mode === 'Full'
                ? Object.values(gc.full.actions)
                : gc.group.members
                    .map(m => buyOnly.memberBuy[m.toUpperCase()])
                    .filter((a): a is MemberAction => !!a);
            actions.forEach(a => {
                const price = gc.memberInfo[a.ticker.toUpperCase()]?.price || 0;
                pushTx(a.ticker, a.shares, price);
            });
        });

        if (transactionsToCreate.length === 0) {
            Swal.fire({
                title: 'No Actions',
                text: 'There are no actions to execute for this mode.',
                icon: 'info',
                confirmButtonColor: '#3B82F6'
            });
            return;
        }

        const modeLabel = mode === 'Full' ? 'Full Rebalance' : 'Buy Only Rebalance';

        const result = await Swal.fire({
            title: `Execute ${modeLabel}?`,
            html: `This will create <b>${transactionsToCreate.length}</b> transactions based on current market prices.<br/><br/>` +
                `<small style="color:var(--text-muted)">Ensure prices are displayed correctly! Transactions will be created at the current dashboard price.</small>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, Create Transactions',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#10B981',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)'
        });

        if (result.isConfirmed) {
            onAddTransactions(transactionsToCreate);
            Swal.fire({
                title: 'Success',
                text: `${transactionsToCreate.length} transactions created!`,
                icon: 'success',
                timer: 2000,
                showConfirmButton: false,
                background: 'var(--bg-card)',
                color: 'var(--text-primary)'
            });
        }
    };

    // Renders a single asset row. Used for standalone tickers (target-based actions) and,
    // when `member` is provided, for a group member (actions come from the group distribution).
    const renderTickerRow = (ticker: string, opts?: {
        hideTarget?: boolean;
        indent?: boolean;
        member?: { fullEur: number; fullShares: number; buyEur: number; buyShares: number };
    }) => {
        const asset = assets.find(a => a.ticker === ticker);
        const currentValue = asset ? asset.currentValue : 0;
        const currentPrice = asset?.currentPrice || 0;
        const currentPerc = totalPortfolioValue > 0 ? (currentValue / totalPortfolioValue) * 100 : 0;
        const targetPerc = opts?.member ? 0 : (allocations[ticker] || 0);
        const quantity = asset?.quantity || 0;

        // Standalone: hide if neither held nor targeted.
        if (!opts?.member && quantity <= 0 && targetPerc <= 0) return null;

        // Full rebalance action
        let rebalanceShares = 0;
        let rebalanceAmount = 0;
        if (opts?.member) {
            rebalanceShares = opts.member.fullShares;
            rebalanceAmount = opts.member.fullEur;
        } else {
            const idealDiff = totalPortfolioValue * (targetPerc / 100) - currentValue;
            rebalanceAmount = idealDiff;
            if (currentPrice > 0) {
                rebalanceShares = Math.round(idealDiff / currentPrice);
                rebalanceAmount = rebalanceShares * currentPrice;
            }
        }
        const postRebalancePerc = totalPortfolioValue > 0 ? ((currentValue + rebalanceAmount) / totalPortfolioValue) * 100 : 0;

        // Buy-only action
        let buyOnlyShares = 0;
        let buyOnlyAmount = 0;
        if (opts?.member) {
            buyOnlyShares = opts.member.buyShares;
            buyOnlyAmount = opts.member.buyEur;
        } else {
            buyOnlyAmount = buyOnly.byUnit[ticker] || 0;
            if (currentPrice > 0) buyOnlyShares = Math.round(buyOnlyAmount / currentPrice);
        }
        const projectedPerc = totalPortfolioValue > 0 ? ((currentValue + buyOnlyAmount) / totalPortfolioValue) * 100 : 0;

        const isCash = isCashTicker(ticker);
        const isVBond = isVirtualBondTicker(ticker);
        const setting = assetSettings.find(s => s.ticker === ticker);
        const assetClass = isCash ? 'Cash' : isVBond ? 'Bond' : (setting?.assetClass || asset?.assetClass || 'Stock');
        const label = isCash ? asset?.label : (setting?.label || asset?.label);

        const tickerTxs = portfolioTxs.filter(t => t.ticker === ticker);
        const totalFees = tickerTxs.reduce((sum, t) => {
            if (t.freeCommission) return sum;
            const broker = brokers.find(b => b.id === t.brokerId);
            return sum + (calculateCommission(t, broker) || 0);
        }, 0);

        // Broker to simulate the trade against: the most recent transaction's broker
        // for this ticker; fall back to the only broker if there's a single one.
        const lastBrokerId = tickerTxs[tickerTxs.length - 1]?.brokerId;
        const tradeBroker = brokers.find(b => b.id === lastBrokerId)
            ?? (brokers.length === 1 ? brokers[0] : undefined);
        const spreadPercent = marketData[ticker.toUpperCase()]?.spreadPercent
            ?? marketData[ticker]?.spreadPercent ?? null;
        const indexationCoefficient = marketData[ticker.toUpperCase()]?.indexationCoefficient
            ?? marketData[ticker]?.indexationCoefficient ?? null;
        const monthsHeld = monthsSince(firstBuyDate(tickerTxs));

        const assetCashFlow = portfolioCashFlowDetails.find(d => d.ticker === ticker.toUpperCase());
        const assetDistributions = assetCashFlow?.totalIncome ?? 0;
        const assetDistributionEvents = assetCashFlow?.events.length ?? 0;

        return (
            <AllocationRow
                key={ticker}
                ticker={ticker}
                label={label}
                assetClass={assetClass}
                isCash={isCash}
                isVBond={isVBond}
                currentPerc={currentPerc}
                targetPerc={targetPerc}
                hideTarget={opts?.hideTarget}
                indent={opts?.indent}
                rebalanceAmount={rebalanceAmount}
                rebalanceShares={rebalanceShares}
                buyOnlyAmount={buyOnlyAmount}
                buyOnlyShares={buyOnlyShares}
                currentValue={asset?.currentValue || 0}
                quantity={asset?.quantity || 0}
                averagePrice={asset?.averagePrice || 0}
                currentPrice={asset?.currentPrice || 0}
                gain={asset?.gain || 0}
                gainPerc={asset?.gainPercentage || 0}
                postRebalancePerc={postRebalancePerc}
                projectedPerc={projectedPerc}
                totalFees={totalFees}
                assetDistributions={assetDistributions}
                assetDistributionEvents={assetDistributionEvents}
                spreadPercent={spreadPercent}
                indexationCoefficient={indexationCoefficient}
                brokers={brokers}
                tradeBroker={tradeBroker}
                monthsHeld={monthsHeld}
                pacPriority={opts?.member ? undefined : pacPriorityFor(portfolio.pacConfigs, ticker)}
            />
        );
    };

    return (
        <div className="allocation-card">
            <div className="allocation-header-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)' }}>
                <h3 className="section-title" style={{ margin: 0 }}>
                    Rebalancing: {portfolio.name} <span style={{ fontSize: '0.9em', fontWeight: 'normal', color: 'var(--text-secondary)' }}>
                        ({totalPortfolioValue.toLocaleString('en-IE', { style: 'currency', currency: 'EUR' })})
                    </span>
                    {(() => {
                        const totalTargetPerc = Object.values(allocations).reduce((sum, v) => sum + v, 0);
                        const isComplete = Math.abs(totalTargetPerc - 100) < 0.01;
                        return (
                            <span style={{ fontSize: '0.75em', fontWeight: 'normal', marginLeft: 'var(--space-3)', color: isComplete ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                Target: {totalTargetPerc.toFixed(1)}%
                            </span>
                        );
                    })()}
                    {realizedDetails.length > 0 && (
                        <span
                            style={{
                                fontSize: '0.75em',
                                fontWeight: 'normal',
                                marginLeft: 'var(--space-3)',
                                color: totalRealized >= 0 ? 'var(--color-success)' : 'var(--color-danger)',
                                borderBottom: '1px dashed currentColor',
                                cursor: 'pointer',
                            }}
                            onClick={e => { e.stopPropagation(); setShowRealizedModal(true); }}
                        >
                            Realized: {totalRealized >= 0 ? '+' : ''}€{totalRealized.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {portfolioCashFlowDetails.length > 0 && (
                        <span
                            style={{
                                fontSize: '0.75em',
                                fontWeight: 'normal',
                                marginLeft: 'var(--space-3)',
                                color: '#3B82F6',
                                borderBottom: '1px dashed currentColor',
                                cursor: 'pointer',
                            }}
                            onClick={e => { e.stopPropagation(); setShowCashFlowModal(true); }}
                        >
                            Distributions: +€{portfolioIncome.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    )}
                    {(summary.totalGain !== 0 || totalRealized !== 0 || portfolioIncome !== 0) && (
                        <span
                            style={{
                                fontSize: '0.75em',
                                fontWeight: 'normal',
                                marginLeft: 'var(--space-3)',
                                color: portfolioTotalReturn >= 0 ? 'var(--color-success)' : 'var(--color-danger)',
                            }}
                        >
                            Total Return: {portfolioTotalReturn >= 0 ? '+' : ''}€{portfolioTotalReturn.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({portfolioTotalReturnPerc.toFixed(1)}%)
                        </span>
                    )}
                    <RealizedGainsModal
                        isOpen={showRealizedModal}
                        onClose={() => setShowRealizedModal(false)}
                        title={`Realized — ${portfolio.name}`}
                        details={realizedDetails}
                        totalRealized={totalRealized}
                        totalCommissions={realizedCommissions}
                        totalTax={realizedTax}
                        getLabel={getRealizedLabel}
                    />
                    <CashFlowModal
                        isOpen={showCashFlowModal}
                        onClose={() => setShowCashFlowModal(false)}
                        details={portfolioCashFlowDetails}
                        totalDividends={portfolioDividends}
                        totalCoupons={portfolioCoupons}
                        totalIncome={portfolioIncome}
                        getLabel={getCashFlowLabel}
                    />
                </h3>
                <div className="allocation-liquidity-controls" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Liquidity:</label>
                    <input
                        type="number"
                        placeholder="0.00"
                        value={portfolio.liquidity !== undefined ? portfolio.liquidity : ''}
                        onChange={(e) => {
                            const val = e.target.value === '' ? undefined : parseFloat(e.target.value);
                            onUpdatePortfolio({ ...portfolio, liquidity: val });
                        }}
                        style={{
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-color)',
                            width: '100px',
                            textAlign: 'right'
                        }}
                    />
                    {(() => {
                        const requiredTotalLiq = calculateRequiredLiquidityForOnlyBuy(assets, allocations);
                        // existing liquidity is portfolio.liquidity. We need to add the difference?
                        // "Liquidity to Invest" usually means "Cash Available to Buy".
                        // The user asked: "indicare la quantità di liquidità da investire per poter portare le % ... correttamente con solo azioni Only Buy"
                        // If I have 0 cash, I need X cash.
                        // If I have 100 cash, and need 100 total, I need 0 more.
                        // But usually the user wants to know the Total Amount of Cash required to make the "Only Buy" rebalance work.
                        // Let's show "Req for Only Buy: €X".

                        // Wait, if I already HAVE liquidity in the input, does the user want to know how much MORE?
                        // "indicare la quantità di liquidità da investire" -> "Amount of liquidity to invest".
                        // Use case: User asks "How much money do I need to deposit to balance this?"
                        // So it means "Total Required Liquidity" (assuming current cash is 0 or part of it).
                        // If I have 500 cash in input, and I need 1000 total. Do I interpret "Liquidity to invest" as 1000? Or 500 more?
                        // Let's display "Min Liq: €X" where X is the TOTAL liquidity needed.
                        // The user can then type that into the input. 

                        return (
                            <div
                                className="allocation-liquidity-hint"
                                style={{ fontSize: '0.8rem', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'var(--space-2)' }}
                                title="Click to set Liquidity to this value"
                                onClick={() => onUpdatePortfolio({ ...portfolio, liquidity: parseFloat(requiredTotalLiq.toFixed(2)) })}
                            >
                                (Rebalancing Buy Only Liquidity: <span style={{ textDecoration: 'underline' }}>€{requiredTotalLiq.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</span>)
                            </div>
                        );
                    })()}
                    {hasPacs && (
                        <div
                            className="allocation-liquidity-hint"
                            style={{ fontSize: '0.8rem', color: '#F59E0B', marginLeft: 'var(--space-2)' }}
                            title="PAC entries absorb the entered liquidity first. This is the extra cash needed, on top of it, to also bring the remaining (non-PAC) assets back to target buying only."
                        >
                            (Non-PAC full rebalance: +€{nonPacExtraLiquidity.toLocaleString('en-IE', { maximumFractionDigits: 0 })})
                        </div>
                    )}
                </div>
            </div>


            {/* Rebalancing Actions Toolbar */}
            <div className="rebalancing-toolbar" style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-4)', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                    className="btn-secondary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => setIsWithdrawalModalOpen(true)}
                >
                    Simulate Withdrawal
                </button>
                <button
                    className="btn-secondary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => handleExecuteRebalance('BuyOnly')}
                >
                    Exec Buy Only
                </button>
                <button
                    className="btn-primary"
                    style={{ fontSize: '0.85rem', padding: '4px 8px' }}
                    onClick={() => handleExecuteRebalance('Full')}
                >
                    Exec Full Rebalance
                </button>
            </div>

            <div className="allocation-details" style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                <div className="allocation-row desktop-only" style={{ fontWeight: 600, color: 'var(--text-muted)', border: 'none' }}>
                    <div style={{ flex: 1 }}>Asset</div>
                    <div style={{ width: '100px', textAlign: 'center' }}>Qty</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Pmc</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Mkt Price</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Value</div>
                    <div style={{ width: '110px', textAlign: 'center' }}>Gain</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Target</div>
                    <div style={{ width: '80px', textAlign: 'center' }}>Actual</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Action</div>
                    <div style={{ width: '90px', textAlign: 'center' }}>Post Act %</div>
                    <div style={{ width: '130px', textAlign: 'center' }}>Buy Only</div>
                    <div style={{ width: '90px', textAlign: 'center' }}>Post Buy %</div>
                </div>

                {allTickers.length === 0 ? (
                    <p style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>No activity or targets.</p>
                ) : (
                    <>
                        {/* Market group rows (summary + expandable members) */}
                        {groupComputations.map(gc => {
                            const expanded = !!expandedGroupRows[gc.group.id];
                            const buyOnlyEur = buyOnly.byUnit[gc.group.id] || 0;
                            const postBuyPerc = totalPortfolioValue > 0
                                ? ((gc.currentValue + buyOnlyEur) / totalPortfolioValue) * 100
                                : 0;
                            return (
                                <React.Fragment key={gc.group.id}>
                                    <GroupSummaryRow
                                        label={gc.group.label}
                                        expanded={expanded}
                                        onToggle={() => setExpandedGroupRows(prev => ({ ...prev, [gc.group.id]: !expanded }))}
                                        currentValue={gc.currentValue}
                                        gain={gc.gain}
                                        targetPerc={gc.targetPerc}
                                        currentPerc={gc.currentPerc}
                                        actionEur={gc.actionEur}
                                        blocked={gc.full.blocked}
                                        blockReason={gc.full.blockReason}
                                        postRebalancePerc={gc.postRebalancePerc}
                                        buyOnlyEur={buyOnlyEur}
                                        postBuyPerc={postBuyPerc}
                                        pacPriority={pacPriorityFor(portfolio.pacConfigs, gc.group.id)}
                                    />
                                    {expanded && gc.group.members.map(m => {
                                        const full = gc.full.actions[m.toUpperCase()];
                                        const buy = buyOnly.memberBuy[m.toUpperCase()];
                                        return renderTickerRow(m, {
                                            hideTarget: true,
                                            indent: true,
                                            member: {
                                                fullEur: full?.eur || 0,
                                                fullShares: full?.shares || 0,
                                                buyEur: buy?.eur || 0,
                                                buyShares: buy?.shares || 0,
                                            },
                                        });
                                    })}
                                </React.Fragment>
                            );
                        })}

                        {/* Standalone ticker rows */}
                        {standaloneTickers.map(ticker => renderTickerRow(ticker))}
                    </>
                )}
            </div>

            <WithdrawalModal
                isOpen={isWithdrawalModalOpen}
                onClose={() => setIsWithdrawalModalOpen(false)}
                assets={assets}
                portfolio={portfolio}
                brokers={brokers}
                transactions={portfolioTxs}
            />
        </div >
    );
};

interface RowProps {
    ticker: string;
    label?: string;
    assetClass: string;
    isCash?: boolean;
    isVBond?: boolean;

    currentPerc: number;
    targetPerc: number;
    rebalanceAmount: number;
    rebalanceShares: number;
    buyOnlyAmount: number;
    buyOnlyShares: number;
    currentValue: number;
    quantity: number;
    averagePrice: number;
    currentPrice: number;
    gain: number;
    gainPerc: number;
    postRebalancePerc: number;
    projectedPerc: number;
    totalFees: number;
    assetDistributions: number;
    assetDistributionEvents: number;
    /** Spread % loaded for this asset (for the trade-cost popover). */
    spreadPercent?: number | null;
    /** Inflation-linked bonds only: indexation coefficient already folded into the price. */
    indexationCoefficient?: number | null;
    /** All brokers (the popover compares commission across every one). */
    brokers: Broker[];
    /** Broker resolved for this ticker — the popover's default selection. */
    tradeBroker?: Broker;
    /** Months since the first buy of this ticker (for the break-even hold estimate). */
    monthsHeld?: number;
    /** Hide the Target column + drift (used for group members, whose target lives on the group). */
    hideTarget?: boolean;
    /** Visually nest this row under a group summary row. */
    indent?: boolean;
    /** PAC priority of this entry (undefined = not a PAC). */
    pacPriority?: number;
}

const AllocationRow: React.FC<RowProps> = ({ ticker, label, assetClass, isCash, isVBond, currentPerc, targetPerc, rebalanceAmount, rebalanceShares, buyOnlyAmount, buyOnlyShares, currentValue, quantity, averagePrice, currentPrice, gain, gainPerc, postRebalancePerc, projectedPerc, totalFees, assetDistributions, assetDistributionEvents, spreadPercent, indexationCoefficient, brokers, tradeBroker, monthsHeld, hideTarget, indent, pacPriority }) => {
    const [isModalOpen, setIsModalOpen] = React.useState(false);
    const [mExpanded, setMExpanded] = React.useState(false);
    const diff = currentPerc - targetPerc;

    const taxRate = assetClass === 'Bond' ? 0.125 : 0.26;
    const estimatedTax = gain > 0 ? gain * taxRate : 0;
    const netGain = gain - totalFees - estimatedTax;

    const totalReturnWithDistributions = gain + assetDistributions;
    const totalReturnPerc = (averagePrice > 0 && quantity > 0)
        ? (totalReturnWithDistributions / (averagePrice * quantity)) * 100
        : 0;

    const colorMap: Record<string, string> = {
        'Stock': 'dot-etf',
        'Bond': 'dot-bond',
        'Commodity': 'dot-commodity',
        'Crypto': 'dot-crypto'
    };

    const colorClass = colorMap[assetClass] || 'dot-neutral';

    return (
        <React.Fragment>
            {/* Desktop Table Row */}
            <div className="allocation-row desktop-only" style={{ padding: 'var(--space-3) 0', ...(indent ? { paddingLeft: 'var(--space-5)', borderLeft: '2px solid var(--border-color)' } : {}) }}>
                <div className="allocation-type" style={{ flex: 1, opacity: indent ? 0.9 : 1 }}>
                    {indent && <span style={{ color: 'var(--text-muted)', marginRight: 'var(--space-1)' }}>↳</span>}
                    <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass) }} />
                    <div>
                        {isVBond && <span style={{ fontSize: '0.65rem', background: '#8B5CF6', color: '#fff', borderRadius: '3px', padding: '1px 4px', marginRight: '6px', verticalAlign: 'middle' }}>VBOND</span>}
                        <strong style={{ fontWeight: indent ? 400 : undefined }}>{label || ticker}</strong>
                        <PacBadge priority={pacPriority} />
                    </div>
                </div>

                <div style={{ width: '100px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : parseFloat(quantity.toFixed(4))}
                </div>

                <div style={{ width: '110px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : `€${averagePrice.toFixed(2)}`}
                </div>

                <div style={{ width: '110px', textAlign: 'center', color: isCash ? 'var(--text-muted)' : undefined }}>
                    {isCash ? '-' : `€${currentPrice.toFixed(2)}`}
                    {!isCash && indexationCoefficient != null && (
                        <span
                            title={`Inflation-linked: price includes indexation coefficient ${indexationCoefficient.toFixed(5)}`}
                            style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: 3, cursor: 'help' }}
                        >CI</span>
                    )}
                </div>

                <div style={{ width: '110px', textAlign: 'center' }}>
                    €{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>

                <div style={{ width: '110px', textAlign: 'center', fontSize: '0.9rem' }}>
                    {isCash ? (
                        <div style={{ color: 'var(--text-muted)' }}>-</div>
                    ) : (
                        <div
                            style={{ display: 'inline-block', cursor: 'pointer' }}
                            onClick={() => setIsModalOpen(true)}
                            title="Click for P/L breakdown"
                        >
                            <div style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)', borderBottom: '1px dashed currentColor' }}>
                                {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: gainPerc >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gainPerc.toFixed(1)}%
                            </div>
                        </div>
                    )}
                </div>

                {isModalOpen && createPortal(
                    <div className="realized-modal-overlay" onClick={() => setIsModalOpen(false)}>
                        <div className="realized-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
                            <div className="realized-modal-header">
                                <span className="realized-modal-title">P/L Breakdown — {label || ticker}</span>
                                <button className="realized-modal-close" onClick={() => setIsModalOpen(false)} aria-label="Close">✕</button>
                            </div>
                            <div className="realized-modal-body">
                                <div className="realized-tooltip-section-label" style={{ color: 'var(--text-muted)' }}>Position</div>
                                <div className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">Avg buy price</span>
                                    <span className="realized-tooltip-amount">€{averagePrice.toFixed(2)}</span>
                                </div>
                                <div className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">Current price</span>
                                    <span className="realized-tooltip-amount">€{currentPrice.toFixed(2)}</span>
                                </div>
                                {indexationCoefficient != null && (
                                    <div className="realized-tooltip-row">
                                        <span className="realized-tooltip-label">
                                            Indexation coeff.
                                            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: 4 }}>
                                                (inflation-revalued principal, included in price)
                                            </span>
                                        </span>
                                        <span className="realized-tooltip-amount">{indexationCoefficient.toFixed(5)}</span>
                                    </div>
                                )}
                                <div className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">Quantity</span>
                                    <span className="realized-tooltip-amount">{parseFloat(quantity.toFixed(4))}</span>
                                </div>

                                <hr className="realized-tooltip-divider" />

                                <div className="realized-tooltip-row">
                                    <span className="realized-tooltip-label">Gross P/L</span>
                                    <span className="realized-tooltip-amount" style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                        {gain >= 0 ? '+' : ''}€{gain.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        <span style={{ fontWeight: 'normal', marginLeft: 4, fontSize: '0.78rem' }}>({gainPerc.toFixed(1)}%)</span>
                                    </span>
                                </div>

                                {totalFees > 0 && (
                                    <div className="realized-tooltip-row">
                                        <span className="realized-tooltip-label">Commissions paid</span>
                                        <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                            -€{totalFees.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </span>
                                    </div>
                                )}

                                {estimatedTax > 0 && (
                                    <div className="realized-tooltip-row">
                                        <span className="realized-tooltip-label">Tax est. ({(taxRate * 100).toFixed(1)}%)</span>
                                        <span className="realized-tooltip-amount" style={{ color: 'var(--color-danger)' }}>
                                            -€{estimatedTax.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </span>
                                    </div>
                                )}

                                <hr className="realized-tooltip-divider" />
                                <div className="realized-tooltip-total">
                                    <span>Net P/L {(totalFees > 0 || estimatedTax > 0) ? '(est.)' : ''}</span>
                                    <span style={{ color: netGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                        {netGain >= 0 ? '+' : ''}€{netGain.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </span>
                                </div>
                                {estimatedTax > 0 && (
                                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 'var(--space-2)', textAlign: 'center' }}>
                                        Tax is estimated on unrealized gain if sold today
                                    </div>
                                )}

                                {assetDistributions > 0 && (
                                    <>
                                        <hr className="realized-tooltip-divider" />
                                        <div className="realized-tooltip-section-label" style={{ color: '#8B5CF6' }}>Distributions received</div>
                                        <div className="realized-tooltip-row">
                                            <span className="realized-tooltip-label">
                                                Income
                                                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginLeft: 4 }}>
                                                    ({assetDistributionEvents} payment{assetDistributionEvents !== 1 ? 's' : ''}, net at source)
                                                </span>
                                            </span>
                                            <span className="realized-tooltip-amount" style={{ color: '#8B5CF6' }}>
                                                +€{assetDistributions.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                            </span>
                                        </div>
                                        <hr className="realized-tooltip-divider" />
                                        <div className="realized-tooltip-total">
                                            <span>Total Return</span>
                                            <span style={{ color: totalReturnWithDistributions >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                                {totalReturnWithDistributions >= 0 ? '+' : ''}€{totalReturnWithDistributions.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                <span style={{ fontWeight: 'normal', marginLeft: 4, fontSize: '0.78rem' }}>({totalReturnPerc.toFixed(1)}%)</span>
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>,
                    document.body
                )}

                <div style={{ width: '80px', textAlign: 'center', color: hideTarget ? 'var(--text-muted)' : undefined }}>
                    {hideTarget ? '—' : `${targetPerc}%`}
                </div>

                <div style={{ width: '80px', textAlign: 'center' }}>
                    <div className="allocation-perc">{currentPerc.toFixed(1)}%</div>
                    {!hideTarget && (
                        <div className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ fontSize: '0.75rem' }}>
                            {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                        </div>
                    )}
                </div>

                <div style={{ width: '130px', textAlign: 'center' }}>
                    {isCash ? (
                        <div style={{ color: 'var(--text-muted)' }}>-</div>
                    ) : (
                        <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                            {rebalanceShares === 0 ? (
                                <TradeCostInfo shares={0} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                    <span className="trend-neutral">OK</span>
                                </TradeCostInfo>
                            ) : (
                                <TradeCostInfo shares={rebalanceShares} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                        <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                </TradeCostInfo>
                            )}
                        </div>
                    )}
                </div>

                <div style={{ width: '90px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text-muted)' }}>{isCash ? '-' : `${postRebalancePerc.toFixed(1)}%`}</div>
                </div>

                <div style={{ width: '130px', textAlign: 'center' }}>
                    {isCash ? (
                        <div style={{ color: 'var(--text-muted)' }}>-</div>
                    ) : (
                        <div style={{ fontWeight: 600, color: buyOnlyAmount > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                            {buyOnlyShares === 0 ? (
                                <TradeCostInfo shares={0} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                    <span className="trend-neutral">-</span>
                                </TradeCostInfo>
                            ) : (
                                <TradeCostInfo shares={buyOnlyShares} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: '1.2' }}>
                                        <span>Buy {Math.abs(buyOnlyShares)}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                            €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                        </span>
                                    </div>
                                </TradeCostInfo>
                            )}
                        </div>
                    )}
                </div>

                <div style={{ width: '90px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text-muted)' }}>{isCash ? '-' : `${projectedPerc.toFixed(1)}%`}</div>
                </div>
            </div>

            {/* Mobile dense expandable row (mrow pattern, styles/mobile-list.css).
                Collapsed: 2 text lines with the key data; tap the head to expand
                a labeled grid with every desktop column. */}
            <div className={`mobile-only mrow ${mExpanded ? 'is-open' : ''} ${indent ? 'mrow--indent' : ''}`}>
                <div className="mrow-head" onClick={() => setMExpanded(v => !v)}>
                    <span className="mrow-chevron">▶</span>
                    <div className="mrow-main">
                        <div className="mrow-line1">
                            <div className={`dot ${colorClass}`} style={{ backgroundColor: getColorForClass(assetClass), flex: '0 0 auto' }} />
                            {isVBond && <span style={{ fontSize: '0.6rem', background: '#8B5CF6', color: '#fff', borderRadius: '3px', padding: '1px 4px', flex: '0 0 auto' }}>VBOND</span>}
                            <span className="mrow-title">{label || ticker}</span>
                            <PacBadge priority={pacPriority} />
                        </div>
                        <div className="mrow-line2">
                            {!isCash && (
                                <span style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)', flex: '0 0 auto' }}>
                                    {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                                </span>
                            )}
                            <span>
                                {currentPerc.toFixed(1)}%{!hideTarget && ` / T ${targetPerc}%`}
                                {!hideTarget && (
                                    <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px' }}>
                                        ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                                    </span>
                                )}
                            </span>
                        </div>
                    </div>
                    <div className="mrow-side">
                        <div className="mrow-side-primary">€{currentValue.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</div>
                        {!isCash && (
                            <div className="mrow-side-secondary" style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                {rebalanceShares === 0
                                    ? 'OK'
                                    : `${rebalanceShares > 0 ? 'Buy' : 'Sell'} ${Math.abs(rebalanceShares)} · €${Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}`}
                            </div>
                        )}
                    </div>
                </div>

                {mExpanded && (
                    <div className="mrow-details">
                        {!isCash && (
                            <>
                                <div className="mrow-detail">
                                    <span className="mrow-label">Qty</span>
                                    <span className="mrow-value">{parseFloat(quantity.toFixed(4))}</span>
                                </div>
                                <div className="mrow-detail">
                                    <span className="mrow-label">Pmc</span>
                                    <span className="mrow-value">€{averagePrice.toFixed(2)}</span>
                                </div>
                                <div className="mrow-detail">
                                    <span className="mrow-label">Mkt Price</span>
                                    <span className="mrow-value">
                                        €{currentPrice.toFixed(2)}
                                        {indexationCoefficient != null && (
                                            <span
                                                title={`Inflation-linked: price includes indexation coefficient ${indexationCoefficient.toFixed(5)}`}
                                                style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: 3 }}
                                            >CI</span>
                                        )}
                                    </span>
                                </div>
                            </>
                        )}
                        <div className="mrow-detail">
                            <span className="mrow-label">Value</span>
                            <span className="mrow-value">€{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Target</span>
                            <span className="mrow-value">{hideTarget ? '—' : `${targetPerc}%`}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Actual</span>
                            <span className="mrow-value">
                                {currentPerc.toFixed(1)}%
                                {!hideTarget && (
                                    <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px', fontSize: '0.72rem' }}>
                                        ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                                    </span>
                                )}
                            </span>
                        </div>
                        {!isCash && (
                            <>
                                <div className="mrow-detail">
                                    <span className="mrow-label">Post Act %</span>
                                    <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>{postRebalancePerc.toFixed(1)}%</span>
                                </div>
                                <div className="mrow-detail">
                                    <span className="mrow-label">Post Buy %</span>
                                    <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>{projectedPerc.toFixed(1)}%</span>
                                </div>
                                <div
                                    className="mrow-detail mrow-detail--wide"
                                    onClick={e => { e.stopPropagation(); setIsModalOpen(true); }}
                                    style={{ cursor: 'pointer' }}
                                >
                                    <span className="mrow-label">Gain · tap for P/L breakdown</span>
                                    <span className="mrow-value">
                                        <span style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)', borderBottom: '1px dashed currentColor' }}>
                                            {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)} ({gainPerc.toFixed(1)}%)
                                        </span>
                                        <span style={{ color: netGain >= 0 ? 'var(--color-success)' : 'var(--color-danger)', marginLeft: 8 }}>
                                            Net: {netGain >= 0 ? '+' : ''}€{netGain.toFixed(0)}
                                        </span>
                                        {assetDistributions > 0 && (
                                            <span style={{ color: '#8B5CF6', marginLeft: 8 }}>
                                                +€{assetDistributions.toFixed(0)} dist.
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <div className="mrow-actions">
                                    <div className="mrow-action-box">
                                        <span className="mrow-label">Rebalance</span>
                                        <div style={{ fontWeight: 600, color: rebalanceAmount > 0 ? 'var(--color-success)' : rebalanceAmount < 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                            {rebalanceShares === 0 ? (
                                                <TradeCostInfo shares={0} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                                    <span>OK</span>
                                                </TradeCostInfo>
                                            ) : (
                                                <TradeCostInfo shares={rebalanceShares} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                                        <span>{rebalanceShares > 0 ? 'Buy' : 'Sell'} {Math.abs(rebalanceShares)}</span>
                                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                                            €{Math.abs(rebalanceAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                                        </span>
                                                    </div>
                                                </TradeCostInfo>
                                            )}
                                        </div>
                                    </div>
                                    <div className="mrow-action-box">
                                        <span className="mrow-label">Buy Only</span>
                                        <div style={{ fontWeight: 600, color: buyOnlyAmount > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                                            {buyOnlyShares === 0 ? (
                                                <TradeCostInfo shares={0} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                                    <span>-</span>
                                                </TradeCostInfo>
                                            ) : (
                                                <TradeCostInfo shares={buyOnlyShares} price={currentPrice} spreadPercent={spreadPercent} brokers={brokers} defaultBrokerId={tradeBroker?.id} gainPercent={gainPerc} monthsHeld={monthsHeld} taxRate={taxRate} ticker={ticker}>
                                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                                        <span>Buy {Math.abs(buyOnlyShares)}</span>
                                                        <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>
                                                            €{Math.abs(buyOnlyAmount).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                                                        </span>
                                                    </div>
                                                </TradeCostInfo>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </React.Fragment>
    );
}

/**
 * The "Not eligible" chip shown when a group has a pending delta but no member
 * can take it. Click (or hover) to reveal a popover explaining, per member,
 * exactly why nothing could be actioned (missing price / Never buy / Never sell
 * / not held).
 */
const NotEligibleInfo: React.FC<{ reason?: GroupBlockReason }> = ({ reason }) => {
    const [open, setOpen] = useState(false);
    const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const ref = useRef<HTMLSpanElement>(null);

    const place = () => {
        const r = ref.current?.getBoundingClientRect();
        if (r) {
            const half = 150 + 8;
            const x = Math.min(Math.max(r.left + r.width / 2, half), Math.max(window.innerWidth - half, half));
            setCoords({ x, y: r.bottom });
        }
    };

    if (!reason) {
        // Defensive: shouldn't happen, but keep the chip informative.
        return (
            <span
                style={{ color: 'var(--color-warning)', fontSize: '0.8rem', fontWeight: 600 }}
                title="No eligible member to act on (check Never buy / Never sell rules)"
            >
                Not eligible
            </span>
        );
    }

    const invalidWeights = reason.kind === 'invalidWeights';
    const hasMissingWeight = reason.members.some(m => m.reason === 'No weight set');
    const directionText = invalidWeights
        ? (hasMissingWeight
            ? 'This group uses member weights, but some members have no weight set:'
            : `Member weights sum to ${Math.round((reason.weightSum ?? 0) * 100) / 100}%, must be 100%:`)
        : reason.direction === 'buy'
            ? `This group is underweight and needs to buy about ${fmtEur(Math.abs(reason.deltaEur), 0)}, but no member can be bought:`
            : `This group is overweight and needs to sell about ${fmtEur(Math.abs(reason.deltaEur), 0)}, but no member can be sold:`;

    return (
        <span
            ref={ref}
            onMouseEnter={() => { place(); setOpen(true); }}
            onMouseLeave={() => setOpen(false)}
            onClick={e => { e.stopPropagation(); place(); setOpen(o => !o); }}
            style={{
                color: 'var(--color-warning)', fontSize: '0.8rem', fontWeight: 600,
                cursor: 'pointer', borderBottom: '1px dotted var(--color-warning)',
                display: 'inline-block',
            }}
        >
            Not eligible ⓘ
            {open && createPortal(
                <div
                    style={{
                        position: 'fixed', left: coords.x, top: coords.y + 6,
                        transform: 'translateX(-50%)', zIndex: 9999,
                        background: 'var(--bg-card)', color: 'var(--text-primary)',
                        border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.25)', padding: 'var(--space-3)',
                        width: 300, fontSize: '0.8rem', textAlign: 'left', cursor: 'default',
                        fontWeight: 400,
                    }}
                    onMouseEnter={() => setOpen(true)}
                    onClick={e => e.stopPropagation()}
                >
                    <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--color-warning)', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.68rem' }}>
                        Why not eligible
                    </div>
                    <div style={{ marginBottom: 8, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                        {directionText}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {reason.members.map(m => (
                            <div key={m.ticker} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                <span style={{ fontWeight: 600 }}>{m.ticker}</span>
                                <span style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{m.reason}</span>
                            </div>
                        ))}
                    </div>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '8px 0 6px' }} />
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                        {invalidWeights
                            ? "Fix the member weights in this portfolio's Allocations settings so the active members sum to 100%."
                            : reason.direction === 'buy'
                                ? 'Remove a "Never buy" rule on a member, or update its price, to let the buy land.'
                                : 'Remove a "Never sell" rule on a held member, or update its price, to let the sell drain.'}
                    </div>
                </div>,
                document.body
            )}
        </span>
    );
};

interface GroupSummaryRowProps {
    label: string;
    expanded: boolean;
    onToggle: () => void;
    currentValue: number;
    gain: number;
    targetPerc: number;
    currentPerc: number;
    actionEur: number;
    blocked: boolean;
    blockReason?: GroupBlockReason;
    postRebalancePerc: number;
    buyOnlyEur: number;
    postBuyPerc: number;
    pacPriority?: number;
}

const GroupSummaryRow: React.FC<GroupSummaryRowProps> = ({
    label, expanded, onToggle, currentValue, gain, targetPerc, currentPerc,
    actionEur, blocked, blockReason, postRebalancePerc, buyOnlyEur, postBuyPerc, pacPriority,
}) => {
    const diff = currentPerc - targetPerc;
    const tint = 'rgba(59, 130, 246, 0.06)';

    const ActionCell = (
        blocked ? (
            <NotEligibleInfo reason={blockReason} />
        ) : Math.abs(actionEur) < 0.5 ? (
            <span className="trend-neutral">OK</span>
        ) : (
            <div style={{ fontWeight: 600, color: actionEur > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                {actionEur > 0 ? 'Buy' : 'Sell'} €{Math.abs(actionEur).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
            </div>
        )
    );

    return (
        <React.Fragment>
            {/* Desktop Table Row */}
            <div className="allocation-row desktop-only" style={{ padding: 'var(--space-3) 0', backgroundColor: tint, cursor: 'pointer', position: 'relative' }} onClick={onToggle}>
                <span style={{ position: 'absolute', left: '-16px', top: '50%', transform: 'translateY(-50%)', color: '#3B82F6', fontSize: '0.95rem', fontWeight: 700 }}>{expanded ? '▾' : '▸'}</span>
                <div className="allocation-type" style={{ flex: 1 }}>
                    <div className="dot" style={{ backgroundColor: '#3B82F6' }} />
                    <div>
                        <strong>{label}</strong>
                        <PacBadge priority={pacPriority} />
                    </div>
                </div>

                <div style={{ width: '100px', textAlign: 'center', color: 'var(--text-muted)' }}>-</div>
                <div style={{ width: '110px', textAlign: 'center', color: 'var(--text-muted)' }}>-</div>
                <div style={{ width: '110px', textAlign: 'center', color: 'var(--text-muted)' }}>-</div>

                <div style={{ width: '110px', textAlign: 'center', fontWeight: 600 }}>
                    €{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>

                <div style={{ width: '110px', textAlign: 'center', fontSize: '0.9rem' }}>
                    <div style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                        {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                    </div>
                </div>

                <div style={{ width: '80px', textAlign: 'center' }}>{targetPerc}%</div>

                <div style={{ width: '80px', textAlign: 'center' }}>
                    <div className="allocation-perc">{currentPerc.toFixed(1)}%</div>
                    <div className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ fontSize: '0.75rem' }}>
                        {diff > 0 ? '+' : ''}{diff.toFixed(1)}%
                    </div>
                </div>

                <div style={{ width: '130px', textAlign: 'center' }}>{ActionCell}</div>

                <div style={{ width: '90px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text-muted)' }}>{postRebalancePerc.toFixed(1)}%</div>
                </div>

                <div style={{ width: '130px', textAlign: 'center' }}>
                    {buyOnlyEur > 0 ? (
                        <div style={{ fontWeight: 600, color: 'var(--color-success)' }}>
                            Buy €{Math.abs(buyOnlyEur).toLocaleString('en-IE', { maximumFractionDigits: 0 })}
                        </div>
                    ) : (
                        <span className="trend-neutral">-</span>
                    )}
                </div>

                <div style={{ width: '90px', textAlign: 'center' }}>
                    <div style={{ color: 'var(--text-muted)' }}>{postBuyPerc.toFixed(1)}%</div>
                </div>
            </div>

            {/* Mobile dense expandable row. One tap (the existing expanded/onToggle
                contract with the parent) reveals both the group's detail grid and
                its indented member rows below. */}
            <div className={`mobile-only mrow mrow--tinted ${expanded ? 'is-open' : ''}`}>
                <div className="mrow-head" onClick={onToggle}>
                    <span className="mrow-chevron" style={{ color: '#3B82F6' }}>▶</span>
                    <div className="mrow-main">
                        <div className="mrow-line1">
                            <div className="dot" style={{ backgroundColor: '#3B82F6', flex: '0 0 auto' }} />
                            <span className="mrow-title">{label}</span>
                            <PacBadge priority={pacPriority} />
                        </div>
                        <div className="mrow-line2">
                            <span style={{ color: gain >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {gain >= 0 ? '+' : ''}€{Math.abs(gain).toFixed(0)}
                            </span>
                            <span>
                                {currentPerc.toFixed(1)}% / T {targetPerc}%
                                <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px' }}>
                                    ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                                </span>
                            </span>
                        </div>
                    </div>
                    <div className="mrow-side">
                        <div className="mrow-side-primary">€{currentValue.toLocaleString('en-IE', { maximumFractionDigits: 0 })}</div>
                        <div className="mrow-side-secondary">{ActionCell}</div>
                    </div>
                </div>

                {expanded && (
                    <div className="mrow-details">
                        <div className="mrow-detail">
                            <span className="mrow-label">Value</span>
                            <span className="mrow-value">€{currentValue.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Target</span>
                            <span className="mrow-value">{targetPerc}%</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Actual</span>
                            <span className="mrow-value">
                                {currentPerc.toFixed(1)}%
                                <span className={`allocation-diff ${diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral'}`} style={{ marginLeft: '4px', fontSize: '0.72rem' }}>
                                    ({diff > 0 ? '+' : ''}{diff.toFixed(1)}%)
                                </span>
                            </span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Post Act %</span>
                            <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>{postRebalancePerc.toFixed(1)}%</span>
                        </div>
                        <div className="mrow-detail">
                            <span className="mrow-label">Post Buy %</span>
                            <span className="mrow-value" style={{ color: 'var(--text-muted)' }}>{postBuyPerc.toFixed(1)}%</span>
                        </div>
                        <div className="mrow-actions">
                            <div className="mrow-action-box">
                                <span className="mrow-label">Rebalance</span>
                                <div>{ActionCell}</div>
                            </div>
                            <div className="mrow-action-box">
                                <span className="mrow-label">Buy Only</span>
                                <div style={{ fontWeight: 600, color: buyOnlyEur > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                                    {buyOnlyEur > 0 ? `Buy €${Math.abs(buyOnlyEur).toLocaleString('en-IE', { maximumFractionDigits: 0 })}` : '-'}
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </React.Fragment>
    );
};

// Inline helper for colors until CSS is fully updated (though existing classes work too)
function getColorForClass(assetClass: string): string {
    switch (assetClass) {
        case 'Stock': return '#3B82F6';
        case 'Bond': return '#10B981';
        case 'Commodity': return '#F59E0B';
        case 'Crypto': return '#8B5CF6';
        case 'Cash': return '#6B7280';
        default: return '#9CA3AF';
    }
}

export default AllocationOverview;
