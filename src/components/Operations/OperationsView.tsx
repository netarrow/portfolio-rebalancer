import React, { useEffect, useMemo, useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import type { BrokerLiquiditySyncRow, OperationRecord, Transaction } from '../../types';
import { isVirtualBondTicker } from '../../types';
import { calculateAssets, isCashTicker, isGroupKey } from '../../utils/portfolioCalculations';
import {
    detectBrokerCash, detectCapex, detectLiquidity, detectPac, detectPrices, detectRebalance, detectSyncs, detectVirtualBonds,
    visibleTodos, type OperationTodo,
} from '../../utils/operationsQueue';
import { pinnedAllocationCoverage } from '../../utils/goalAllocationCoverage';
import { capexBondMatch } from '../../utils/capexBondMatch';
import { wantsInvestedTag } from '../../utils/ynabCapexNotes';
import { buildRevaluationPreview, suggestReassignments } from '../../utils/ynabWriteBack';
import { checkYnabGuardBudget } from '../../utils/ynabWriteGuard';
import { buildGoalRow, formatCurrencyExact } from '../YnabGoals/goalRows';
import { useTrackingPlan } from '../YnabTracking/useTrackingPlan';
import { useCapexSync } from '../YnabImport/useCapexSync';
import OrdersReviewModal from './OrdersReviewModal';
import CashTransferModal, { OUTSIDE } from './CashTransferModal';
import InvestCashModal from './InvestCashModal';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { RESERVE_ALLOCATED_CASH_KEY } from '../../utils/brokerLiquidity';
import BrokerLiquiditySyncModal from '../Brokers/BrokerLiquiditySyncModal';
import PacConfirmModal from '../Pac/PacConfirmModal';
import CapexNotesModal from '../YnabGoals/CapexNotesModal';
import CapexBondModal from '../YnabGoals/CapexBondModal';
import ConcretizeModal from '../modals/ConcretizeModal';
import CapexSyncModal from '../YnabTracking/CapexSyncModal';
import RevalueModal from '../YnabTracking/RevalueModal';

const KIND_ICON: Record<OperationTodo['kind'], string> = {
    prices: '💱', liquidity: '🏦', 'broker-cash': '💶', pac: '📊', rebalance: '⚖️', 'capex-notes': '🧾', 'capex-bond': '🔎',
    'virtual-bond': '🧩', 'ynab-writeback': '🔁', 'ynab-revalue': '📈', 'capex-sync': '↻', backup: '☁️',
};

const SNOOZE_DAYS = 7;

/**
 * Execute → Operations: one list of what is still to be done, wherever it was
 * found, with the real action behind each item, and the history of what was
 * run from here. Every action reuses the flow its own page already has; YNAB
 * writes keep their preview, confirmation and write guard.
 */
const OperationsView: React.FC = () => {
    const {
        portfolios, scopedTransactions, scopedBrokers, transactions, brokers, assetSettings, effectiveAssetSettings, marketData,
        pacPlans, pacExecutions, skipPacInstalment, ynabGoals, ynabGoalAllocations, virtualBonds, ynabConfig,
        ynabAccountMappings, azureConfig, syncToAzure, refreshPrices, prepareBrokerLiquiditySync,
        applyBrokerLiquiditySync, adjustBrokerLiquidity, addTransactionsBulk, concretizeVirtualBond, operations, recordOperation,
        ynabMigratedBrokerIds, ynabTrackingConfig, ynabWriteLog,
    } = usePortfolio();
    const currencyIso = ynabConfig?.currencyIso || 'EUR';
    const fmt = (v: number) => formatCurrencyExact(v, currencyIso);
    const [now, setNow] = useState(() => new Date());
    // The Dashboard's "Reserve cash allocated to portfolios" setting, read as is.
    const [reserveAllocatedCash] = useLocalStorage<boolean>(RESERVE_ALLOCATED_CASH_KEY, true);

    // ── Inputs the detectors need ──
    const priceTickers = useMemo(() => {
        const { assets } = calculateAssets(transactions, effectiveAssetSettings, marketData);
        const out = new Set(assets.filter(a => a.quantity > 0 && !isCashTicker(a.ticker) && !isVirtualBondTicker(a.ticker)).map(a => a.ticker));
        portfolios.forEach(p => {
            const groups = Object.fromEntries((p.allocationGroups || []).map(g => [g.id, g]));
            Object.entries(p.allocations || {}).forEach(([k, perc]) => {
                if ((perc || 0) < 1) return;
                const tickers = isGroupKey(k) ? groups[k]?.members ?? [] : [k];
                tickers.forEach(t => { if (!isCashTicker(t) && !isVirtualBondTicker(t) && !isGroupKey(t)) out.add(t); });
            });
        });
        return [...out];
    }, [transactions, effectiveAssetSettings, marketData, portfolios]);

    const pinnedCoverage = useMemo(() => pinnedAllocationCoverage({
        portfolios, transactions, assetSettings: effectiveAssetSettings, marketData,
        allocations: ynabGoalAllocations, goals: ynabGoals, virtualBonds,
    }), [portfolios, transactions, effectiveAssetSettings, marketData, ynabGoalAllocations, ynabGoals, virtualBonds]);
    const tagOf = useMemo(() => {
        const wants = new Map(ynabGoals.map(g => [g.id, wantsInvestedTag(buildGoalRow(
            g, ynabGoalAllocations.filter(a => a.ynabGoalId === g.id), a => pinnedCoverage.get(a.id) ?? a.amount,
        ))]));
        return (id: string) => wants.get(id) ?? false;
    }, [ynabGoals, ynabGoalAllocations, pinnedCoverage]);

    // YNAB Writeback: accounts are read on demand, only when the Writeback is in use.
    const writebackInUse = ynabMigratedBrokerIds.length > 0;
    const tracking = useTrackingPlan(false);
    const guard = checkYnabGuardBudget(ynabTrackingConfig, ynabConfig?.budgetId);

    const detected = useMemo((): OperationTodo[] => {
        const list: OperationTodo[] = [
            ...detectPac({ plans: pacPlans, executions: pacExecutions, now }),
            ...detectPrices({ tickers: priceTickers, marketData, now }),
            ...detectLiquidity({ brokers, ynabBrokerIds: new Set(Object.keys(ynabAccountMappings)), records: operations, now }),
            // The Dashboard's Broker Performance cards read the stored asset settings.
            ...detectBrokerCash({ brokers: scopedBrokers, transactions: scopedTransactions, assetSettings, marketData, reserveAllocatedCash }),
            ...detectRebalance({ portfolios, transactions: scopedTransactions, assetSettings: effectiveAssetSettings, marketData, brokers: scopedBrokers }),
            ...detectVirtualBonds({ virtualBonds, transactions }),
            ...detectCapex({
                goals: ynabGoals, allocations: ynabGoalAllocations, assetSettings: effectiveAssetSettings, virtualBonds,
                tagOf, goalsGroupSet: !!ynabConfig?.goalsGroupId, now,
            }),
            ...detectSyncs({
                goalsGroupSet: !!ynabConfig?.goalsGroupId, lastGoalsSyncAt: ynabConfig?.lastGoalsSyncAt,
                azureEnabled: !!azureConfig?.enabled, azureLastSync: azureConfig?.lastSync, now,
            }),
        ];
        if (tracking.accounts) {
            const moves = suggestReassignments(tracking.plan);
            if (moves.length > 0) list.push({
                key: 'ynab-writeback', kind: 'ynab-writeback', urgency: 'due', title: 'Update the YNAB Writeback accounts',
                detail: `${moves.length} move${moves.length === 1 ? '' : 's'} (${fmt(moves.reduce((s, m) => s + m.amount, 0))}) between the accounts by purpose`,
            });
            if (guard.ok && writebackInUse) {
                const p = buildRevaluationPreview({ plan: tracking.plan, accounts: tracking.accounts, config: ynabTrackingConfig, budgetId: ynabConfig?.budgetId ?? '', entryId: 'check', date: '2000-01-01', log: ynabWriteLog });
                const n = p.accounts.filter(a => !a.suspicious && !a.blocked && (Math.abs(a.delta) >= 1 || Math.abs(a.taxTarget - a.taxSeen) >= 1)).length;
                if (n > 0) list.push({
                    key: 'ynab-revalue', kind: 'ynab-revalue', urgency: 'info', title: 'Revalue the YNAB Writeback accounts',
                    detail: `${n} account${n === 1 ? '' : 's'} to bring to market value (P/L and latent tax)`,
                });
            }
        }
        return list;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pacPlans, pacExecutions, priceTickers, marketData, brokers, ynabAccountMappings, operations, portfolios, scopedTransactions,
        effectiveAssetSettings, scopedBrokers, virtualBonds, transactions, ynabGoals, ynabGoalAllocations, tagOf, ynabConfig,
        azureConfig, reserveAllocatedCash, assetSettings, tracking.accounts, tracking.plan, guard.ok, writebackInUse, ynabTrackingConfig, ynabWriteLog, now]);

    const todos = useMemo(() => visibleTodos(detected, operations, now), [detected, operations, now]);
    const snoozed = operations.filter(r => r.status === 'snoozed' && r.until && new Date(r.until) > now);
    const history = operations.filter(r => r.status === 'done');

    // ── Running an item ──
    const [active, setActive] = useState<OperationTodo | null>(null);
    // Broker cash: invest it (default when there is cash to spare) or transfer it.
    const [cashMode, setCashMode] = useState<'invest' | 'transfer' | 'review'>('transfer');
    const [investOrders, setInvestOrders] = useState<{ title: string; orders: Transaction[] } | null>(null);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [liquidityRows, setLiquidityRows] = useState<BrokerLiquiditySyncRow[] | null>(null);
    // An item run through a modal is done when, once the modal is closed, it is no longer detected.
    const [settling, setSettling] = useState<OperationTodo | null>(null);
    const capexSync = useCapexSync();

    const record = (todo: OperationTodo, detail: string, extra: Partial<OperationRecord> = {}) =>
        recordOperation({ key: todo.key, kind: todo.kind, title: todo.title, status: 'done', detail, ...extra });

    const closeAndSettle = () => { if (active) setSettling(active); setActive(null); };

    useEffect(() => {
        if (!settling || capexSync.modal) return;
        if (!detected.some(t => t.key === settling.key)) record(settling, settledDetail(settling));
        setSettling(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settling, detected, capexSync.modal]);

    const run = async (todo: OperationTodo) => {
        switch (todo.kind) {
            case 'prices': {
                setBusyKey(todo.key);
                try { await refreshPrices(); record(todo, `${priceTickers.length} tickers refreshed`); }
                finally { setBusyKey(null); setNow(new Date()); }
                return;
            }
            case 'liquidity': {
                setBusyKey(todo.key);
                const res = await prepareBrokerLiquiditySync();
                setBusyKey(null);
                if (!res.ok || !res.rows || res.rows.length === 0) {
                    if (res.reason === 'empty' || (res.ok && res.rows?.length === 0)) {
                        record(todo, 'Already up to date');
                        Swal.fire({ title: 'Nothing to update', text: res.error || 'Every broker is already in line.', icon: 'info' });
                    } else Swal.fire({ title: 'Unable to read YNAB', text: res.error, icon: 'error' });
                    return;
                }
                setActive(todo);
                setLiquidityRows(res.rows);
                return;
            }
            case 'backup': {
                setBusyKey(todo.key);
                const res = await syncToAzure();
                setBusyKey(null);
                if (res.ok) record(todo, 'Backed up to Azure');
                else Swal.fire({ title: 'Backup failed', text: res.error, icon: 'error' });
                return;
            }
            case 'capex-sync':
                setSettling(todo);
                await capexSync.prepare();
                return;
            case 'ynab-writeback':
            case 'ynab-revalue':
                setBusyKey(todo.key);
                await tracking.loadAccounts();
                setBusyKey(null);
                setActive(todo);
                return;
            case 'broker-cash':
                setCashMode((todo.amount ?? 0) > 0 ? 'invest' : 'transfer');
                setActive(todo);
                return;
            default:
                setActive(todo);
        }
    };

    const snooze = (todo: OperationTodo) => recordOperation({
        key: todo.key, kind: todo.kind, title: todo.title, status: 'snoozed',
        until: new Date(Date.now() + SNOOZE_DAYS * 86_400_000).toISOString(),
    });
    const unsnooze = (r: OperationRecord) => recordOperation({ key: r.key, kind: r.kind, title: r.title, status: 'snoozed', until: new Date().toISOString() });

    const skipPac = (todo: OperationTodo) => {
        if (!todo.planId || !todo.dueDate) return;
        skipPacInstalment(todo.planId, todo.dueDate);
        record(todo, `Instalment of ${todo.dueDate} skipped`);
    };

    const confirmOrders = (todo: OperationTodo, orders: Transaction[]) => {
        addTransactionsBulk(orders);
        record(todo, `${orders.length} transaction${orders.length === 1 ? '' : 's'} recorded`, { transactionIds: orders.map(o => o.id) });
        setActive(null);
    };

    // A broker short of cash is topped up from the one with the most to spare,
    // a broker with too much sends it to the one most short (or outside).
    const transferFor = (todo: OperationTodo) => {
        const others = detected.filter(t => t.kind === 'broker-cash' && t.brokerId !== todo.brokerId);
        const short = (todo.amount ?? 0) < 0;
        const peer = others
            .filter(t => short ? (t.amount ?? 0) > 0 : (t.amount ?? 0) < 0)
            .sort((a, b) => Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0))[0];
        const amount = Math.abs(todo.amount ?? 0);
        return short
            ? { from: peer?.brokerId ?? OUTSIDE, to: todo.brokerId!, amount: peer ? Math.min(amount, peer.amount ?? 0) : amount }
            : { from: todo.brokerId!, to: peer?.brokerId ?? OUTSIDE, amount: peer ? Math.min(amount, -(peer.amount ?? 0)) : amount };
    };

    const confirmTransfer = (todo: OperationTodo, move: { from: string; to: string; amount: number }) => {
        const deltas: Record<string, number> = {};
        if (move.from !== OUTSIDE) deltas[move.from] = -move.amount;
        if (move.to !== OUTSIDE) deltas[move.to] = (deltas[move.to] ?? 0) + move.amount;
        adjustBrokerLiquidity(deltas);
        const name = (id: string) => id === OUTSIDE ? 'outside' : brokers.find(b => b.id === id)?.name ?? id;
        record(todo, `${fmt(move.amount)} moved from ${name(move.from)} to ${name(move.to)}`);
        setActive(null);
    };

    const checkYnab = async () => { setBusyKey('ynab-check'); await tracking.loadAccounts(); setBusyKey(null); };

    // ── Modals of the active item ──
    const activeGoal = active?.goalId ? ynabGoals.find(g => g.id === active.goalId) : undefined;
    const activePlan = active?.planId ? pacPlans.find(p => p.id === active.planId) : undefined;
    const activeBond = active?.virtualBondId ? virtualBonds.find(v => v.id === active.virtualBondId) : undefined;

    const dateTime = (iso: string) => new Date(iso).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

    return (
        <div className="ops">
            <div className="ops-head">
                <div>
                    <h2>Operations</h2>
                    <p className="ops-hint">What is still to be done across the app, and the action behind each item. Items go away by themselves once done, here or on their own page.</p>
                </div>
                <div className="ops-head-actions">
                    {writebackInUse && ynabConfig?.apiKey && (
                        <button type="button" className="btn btn-sm" onClick={checkYnab} disabled={busyKey === 'ynab-check'}>
                            {busyKey === 'ynab-check' ? 'Reading YNAB…' : tracking.accounts ? '↻ Re-check YNAB Writeback' : 'Check YNAB Writeback'}
                        </button>
                    )}
                    <button type="button" className="btn btn-sm" onClick={() => setNow(new Date())}>↻ Refresh</button>
                </div>
            </div>

            <section className="ops-section">
                <h3 className="ops-title">To do <span className="ops-count">{todos.length}</span></h3>
                {todos.length === 0 && <div className="ops-empty">Nothing to do right now.</div>}
                <ul className="ops-list">
                    {todos.map(t => (
                        <li key={t.key} className={`ops-item is-${t.urgency}`}>
                            <span className="ops-icon" aria-hidden>{KIND_ICON[t.kind]}</span>
                            <div className="ops-main">
                                <div className="ops-item-title">
                                    {t.title}
                                    {t.urgency === 'overdue' && <span className="ops-tag ops-tag-overdue">overdue</span>}
                                </div>
                                <div className="ops-detail">{t.detail}</div>
                            </div>
                            <div className="ops-actions">
                                {t.kind === 'pac' && <button type="button" className="btn btn-sm" onClick={() => skipPac(t)}>Skip</button>}
                                {t.kind === 'broker-cash' && (t.amount ?? 0) > 0 && (
                                    <button type="button" className="btn btn-sm" onClick={() => { setCashMode('transfer'); setActive(t); }}>Transfer…</button>
                                )}
                                <button type="button" className="btn btn-sm" onClick={() => snooze(t)} title={`Hide for ${SNOOZE_DAYS} days`}>Snooze</button>
                                <button type="button" className="btn btn-sm btn-primary" onClick={() => run(t)} disabled={busyKey === t.key}>
                                    {busyKey === t.key ? 'Working…' : actionLabel(t)}
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            </section>

            {snoozed.length > 0 && (
                <section className="ops-section">
                    <h3 className="ops-title">Snoozed <span className="ops-count">{snoozed.length}</span></h3>
                    <ul className="ops-list">
                        {snoozed.map(r => (
                            <li key={r.id} className="ops-item is-snoozed">
                                <span className="ops-icon" aria-hidden>{KIND_ICON[r.kind]}</span>
                                <div className="ops-main">
                                    <div className="ops-item-title">{r.title}</div>
                                    <div className="ops-detail">hidden until {dateTime(r.until!)}</div>
                                </div>
                                <div className="ops-actions">
                                    <button type="button" className="btn btn-sm" onClick={() => unsnooze(r)}>Show again</button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section className="ops-section">
                <h3 className="ops-title">Done <span className="ops-count">{history.length}</span></h3>
                {history.length === 0 && <div className="ops-empty">Nothing run from here yet.</div>}
                <ul className="ops-list ops-history">
                    {history.slice(0, 50).map(r => (
                        <li key={r.id} className="ops-item is-done">
                            <span className="ops-icon" aria-hidden>{KIND_ICON[r.kind]}</span>
                            <div className="ops-main">
                                <div className="ops-item-title">{r.title}</div>
                                <div className="ops-detail">{r.detail}</div>
                            </div>
                            <span className="ops-when">{dateTime(r.at)}</span>
                        </li>
                    ))}
                </ul>
            </section>

            {active?.kind === 'rebalance' && active.orders && (
                <OrdersReviewModal
                    title={active.title}
                    orders={active.orders}
                    brokers={brokers}
                    onConfirm={orders => confirmOrders(active, orders)}
                    onClose={() => setActive(null)}
                />
            )}
            {active?.kind === 'broker-cash' && active.brokerId && cashMode === 'invest' && (() => {
                const broker = brokers.find(b => b.id === active.brokerId);
                return broker ? (
                    <InvestCashModal
                        broker={broker}
                        amount={active.amount ?? 0}
                        portfolios={portfolios}
                        transactions={scopedTransactions}
                        brokers={scopedBrokers}
                        assetSettings={effectiveAssetSettings}
                        marketData={marketData}
                        onReview={(p, orders) => { setInvestOrders({ title: `Invest from ${broker.name} in ${p.name}`, orders }); setCashMode('review'); }}
                        onClose={() => setActive(null)}
                    />
                ) : null;
            })()}
            {active?.kind === 'broker-cash' && cashMode === 'review' && investOrders && (
                <OrdersReviewModal
                    title={investOrders.title}
                    orders={investOrders.orders}
                    brokers={brokers}
                    onConfirm={orders => { setInvestOrders(null); confirmOrders(active, orders); }}
                    onClose={() => { setInvestOrders(null); setActive(null); }}
                />
            )}
            {active?.kind === 'broker-cash' && active.brokerId && cashMode === 'transfer' && (() => {
                const t = transferFor(active);
                return (
                    <CashTransferModal
                        title={active.title}
                        brokers={brokers}
                        from={t.from}
                        to={t.to}
                        amount={t.amount}
                        onConfirm={move => confirmTransfer(active, move)}
                        onClose={() => setActive(null)}
                    />
                );
            })()}
            {active?.kind === 'liquidity' && liquidityRows && (
                <BrokerLiquiditySyncModal
                    rows={liquidityRows}
                    currencyIso={currencyIso}
                    onConfirm={rows => {
                        const res = applyBrokerLiquiditySync(rows);
                        record(active, `${res.updated} broker${res.updated === 1 ? '' : 's'} updated${res.credits > 0 ? `, ${fmt(res.interest)} interest credited` : ''}`);
                        setLiquidityRows(null);
                        setActive(null);
                    }}
                    onCancel={() => { setLiquidityRows(null); setActive(null); }}
                />
            )}
            {active?.kind === 'pac' && activePlan && active.dueDate && (
                <PacConfirmModal plan={activePlan} dueDate={active.dueDate} onClose={closeAndSettle} />
            )}
            {active?.kind === 'capex-notes' && <CapexNotesModal tagOf={tagOf} onClose={closeAndSettle} />}
            {active?.kind === 'capex-bond' && activeGoal && (() => {
                const m = capexBondMatch(activeGoal, ynabGoalAllocations, effectiveAssetSettings, virtualBonds);
                return <CapexBondModal goal={activeGoal} gap={m.toMatch} plannedIncluded currencyIso={currencyIso} onClose={closeAndSettle} />;
            })()}
            {active?.kind === 'virtual-bond' && activeBond && (
                <ConcretizeModal
                    bond={activeBond}
                    brokers={brokers}
                    portfolios={portfolios}
                    onConfirm={fill => {
                        concretizeVirtualBond(activeBond.id, fill);
                        record(active, `Bought ${fill.quantity} × ${fill.isin}`);
                        setActive(null);
                    }}
                    onClose={() => setActive(null)}
                />
            )}
            {active?.kind === 'ynab-writeback' && (
                <CapexSyncModal
                    plan={tracking.plan}
                    accounts={tracking.accounts}
                    loadAccounts={tracking.loadAccounts}
                    format={fmt}
                    onClose={changed => { if (changed) record(active, 'Moves written to YNAB'); setActive(null); }}
                />
            )}
            {active?.kind === 'ynab-revalue' && (
                <RevalueModal
                    plan={tracking.plan}
                    accounts={tracking.accounts}
                    format={fmt}
                    onClose={changed => { if (changed) record(active, 'Accounts revalued in YNAB'); setActive(null); void tracking.loadAccounts(); }}
                />
            )}
            {capexSync.modal}

            <style>{`
                .ops { display: flex; flex-direction: column; gap: var(--space-5); max-width: 980px; margin: 0 auto; width: 100%; }
                .ops-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap; }
                .ops-head h2 { margin: 0 0 var(--space-1); }
                .ops-hint { margin: 0; font-size: 0.85rem; color: var(--text-secondary); max-width: 60ch; line-height: 1.45; }
                .ops-head-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
                .ops-section { display: flex; flex-direction: column; gap: var(--space-3); }
                .ops-title { margin: 0; font-size: 1rem; display: flex; align-items: center; gap: 0.5rem; }
                .ops-count { font-size: 0.72rem; font-weight: 700; background: var(--bg-secondary); color: var(--text-secondary); border-radius: 999px; padding: 0.1rem 0.5rem; }
                .ops-empty { font-size: 0.85rem; color: var(--text-secondary); padding: var(--space-3) var(--space-4); border: 1px dashed var(--border-color); border-radius: var(--radius-md); }
                .ops-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
                .ops-item { display: flex; align-items: center; gap: var(--space-3); padding: 0.7rem 0.9rem; background: var(--bg-card); border: 1px solid var(--border-color); border-left: 3px solid var(--color-primary); border-radius: var(--radius-md); }
                .ops-item.is-overdue { border-left-color: var(--color-danger); }
                .ops-item.is-info { border-left-color: var(--border-color); }
                .ops-item.is-done, .ops-item.is-snoozed { border-left-color: var(--border-color); padding: 0.5rem 0.9rem; }
                .ops-icon { font-size: 1.1rem; width: 1.6rem; text-align: center; flex-shrink: 0; }
                .ops-main { flex: 1; min-width: 0; }
                .ops-item-title { font-weight: 600; font-size: 0.9rem; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
                .ops-detail { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.15rem; overflow-wrap: anywhere; }
                .ops-tag { font-size: 0.66rem; font-weight: 700; border-radius: 999px; padding: 0.05rem 0.45rem; text-transform: uppercase; }
                .ops-tag-overdue { color: var(--color-danger); background: rgba(239, 68, 68, 0.14); }
                .ops-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
                .ops-when { font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; }
                .ops-history .ops-item-title { font-weight: 500; }
                @media (max-width: 640px) {
                    .ops-item { flex-wrap: wrap; }
                    .ops-actions { width: 100%; justify-content: flex-end; }
                }
            `}</style>
        </div>
    );
};

/** What a to-do run through its modal did, once it is no longer detected. */
const settledDetail = (t: OperationTodo): string => {
    switch (t.kind) {
        case 'pac': return `Instalment of ${t.dueDate} registered`;
        case 'capex-notes': return 'Capex categories updated in YNAB';
        case 'capex-bond': return 'Bond chosen for the capex';
        case 'capex-sync': return 'Planned capex synced from YNAB';
        default: return 'Done';
    }
};

const actionLabel = (t: OperationTodo): string => {
    switch (t.kind) {
        case 'prices': return 'Update prices';
        case 'liquidity': return 'Update…';
        case 'broker-cash': return (t.amount ?? 0) > 0 ? 'Invest…' : 'Transfer…';
        case 'pac': return 'Register…';
        case 'rebalance': return 'Review orders…';
        case 'capex-notes': return 'Update YNAB…';
        case 'capex-bond': return 'Find bond…';
        case 'virtual-bond': return 'Concretize…';
        case 'ynab-writeback': return 'Update YNAB…';
        case 'ynab-revalue': return 'Revalue…';
        case 'capex-sync': return 'Sync…';
        case 'backup': return 'Back up';
    }
};

export default OperationsView;
