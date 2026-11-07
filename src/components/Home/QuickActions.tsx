import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import type { BrokerLiquiditySyncRow, OperationKind } from '../../types';
import { lastDone } from '../../utils/operationsQueue';
import { formatCurrencyExact } from '../YnabGoals/goalRows';
import { useCapexSync } from '../YnabImport/useCapexSync';
import type { useTrackingPlan } from '../YnabTracking/useTrackingPlan';
import BrokerLiquiditySyncModal from '../Brokers/BrokerLiquiditySyncModal';
import CapexSyncModal from '../YnabTracking/CapexSyncModal';
import RevalueModal from '../YnabTracking/RevalueModal';

interface Props {
    /** The YNAB Writeback plan the Home already holds (from useOperationsTodos). */
    tracking: ReturnType<typeof useTrackingPlan>;
    writebackInUse: boolean;
    /** Tickers Update prices refreshes, for the record. */
    priceCount: number;
}

interface QuickAction {
    id: OperationKind;
    icon: string;
    label: string;
    /** When it was last done, as a short phrase. */
    last?: string;
    run: () => Promise<void> | void;
}

const ago = (iso?: string | null): string | undefined => {
    if (!iso) return undefined;
    const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
    if (!Number.isFinite(mins)) return undefined;
    if (mins < 60) return `${Math.max(1, Math.round(mins))} min ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
    return `${Math.round(mins / 60 / 24)} d ago`;
};

/**
 * One-click maintenance from the Home: the same actions Operations runs, with
 * the same modals and write guards, recorded in its history. Only what is set
 * up is offered (YNAB, the Writeback, Azure).
 */
const QuickActions: React.FC<Props> = ({ tracking, writebackInUse, priceCount }) => {
    const {
        refreshPrices, refreshHistory, prepareBrokerLiquiditySync, applyBrokerLiquiditySync, syncToAzure, recordOperation,
        operations, marketData, priceHistory, ynabConfig, azureConfig,
    } = usePortfolio();
    const capexSync = useCapexSync();
    const fmt = (v: number) => formatCurrencyExact(v, ynabConfig?.currencyIso || 'EUR');
    const [busy, setBusy] = useState<string | null>(null);
    const [liquidityRows, setLiquidityRows] = useState<BrokerLiquiditySyncRow[] | null>(null);
    const [ynabModal, setYnabModal] = useState<'writeback' | 'revalue' | null>(null);

    const record = (kind: OperationKind, title: string, detail: string) =>
        recordOperation({ key: kind, kind, title, status: 'done', detail });

    const withBusy = (id: string, fn: () => Promise<void>) => async () => {
        setBusy(id);
        try { await fn(); } finally { setBusy(null); }
    };

    const newest = (values: (string | undefined)[]) => values.filter((v): v is string => !!v).sort().pop();
    const ynabReady = !!(ynabConfig?.apiKey && ynabConfig?.budgetId);

    const actions: QuickAction[] = [
        {
            id: 'prices', icon: '💱', label: 'Update prices',
            last: ago(newest(Object.values(marketData).map(m => m.lastUpdated))),
            run: withBusy('prices', async () => { await refreshPrices(); record('prices', 'Update prices', `${priceCount} tickers refreshed`); }),
        },
        {
            id: 'price-history', icon: '📉', label: 'Update history',
            last: ago(newest(Object.values(priceHistory).map(h => h.lastHistoryFetch ?? h.points[h.points.length - 1]?.[0]))),
            run: withBusy('price-history', async () => { await refreshHistory(); record('price-history', 'Update the price history', 'History update started'); }),
        },
        {
            id: 'liquidity', icon: '🏦', label: 'Update brokers',
            last: ago(lastDone(operations, 'liquidity')),
            run: withBusy('liquidity', async () => {
                const res = await prepareBrokerLiquiditySync();
                if (res.ok && res.rows && res.rows.length > 0) { setLiquidityRows(res.rows); return; }
                if (res.reason === 'empty' || (res.ok && res.rows?.length === 0)) {
                    record('liquidity', 'Update broker liquidity', 'Already up to date');
                    Swal.fire({ title: 'Nothing to update', text: res.error || 'Every broker is already in line.', icon: 'info' });
                } else Swal.fire({ title: 'Unable to read YNAB', text: res.error, icon: 'error' });
            }),
        },
        ...(writebackInUse && ynabReady ? [
            {
                id: 'ynab-writeback' as const, icon: '🔁', label: 'YNAB Writeback',
                last: ago(lastDone(operations, 'ynab-writeback')),
                run: withBusy('ynab-writeback', async () => { await tracking.loadAccounts(); setYnabModal('writeback'); }),
            },
            {
                id: 'ynab-revalue' as const, icon: '📈', label: 'Revalue in YNAB',
                last: ago(lastDone(operations, 'ynab-revalue')),
                run: withBusy('ynab-revalue', async () => { await tracking.loadAccounts(); setYnabModal('revalue'); }),
            },
        ] : []),
        ...(capexSync.canSync && ynabReady ? [{
            id: 'capex-sync' as const, icon: '↻', label: 'Sync capex',
            last: ago(ynabConfig?.lastGoalsSyncAt),
            run: withBusy('capex-sync', async () => { await capexSync.prepare(); }),
        }] : []),
        ...(azureConfig?.enabled ? [{
            id: 'backup' as const, icon: '☁️', label: 'Back up',
            last: ago(azureConfig.lastSync),
            run: withBusy('backup', async () => {
                const res = await syncToAzure();
                if (res.ok) record('backup', 'Back up to Azure', 'Backed up to Azure');
                else Swal.fire({ title: 'Backup failed', text: res.error, icon: 'error' });
            }),
        }] : []),
    ];

    return (
        <section className="home-card home-quick">
            <div className="home-card-head"><h3>Quick actions</h3></div>
            <div className="home-quick-grid">
                {actions.map(a => (
                    <button key={a.id} type="button" className="home-quick-btn" onClick={a.run} disabled={busy !== null}>
                        <span className="home-quick-icon" aria-hidden>{busy === a.id ? '⏳' : a.icon}</span>
                        <span className="home-quick-text">
                            <span className="home-quick-label">{a.label}</span>
                            <span className="home-quick-last">{busy === a.id ? 'Working…' : a.last ? `last ${a.last}` : 'never run'}</span>
                        </span>
                    </button>
                ))}
            </div>

            {liquidityRows && (
                <BrokerLiquiditySyncModal
                    rows={liquidityRows}
                    currencyIso={ynabConfig?.currencyIso || 'EUR'}
                    onConfirm={rows => {
                        const res = applyBrokerLiquiditySync(rows);
                        record('liquidity', 'Update broker liquidity', `${res.updated} broker${res.updated === 1 ? '' : 's'} updated${res.credits > 0 ? `, ${fmt(res.interest)} interest credited` : ''}`);
                        setLiquidityRows(null);
                    }}
                    onCancel={() => setLiquidityRows(null)}
                />
            )}
            {ynabModal === 'writeback' && (
                <CapexSyncModal
                    plan={tracking.plan}
                    accounts={tracking.accounts}
                    loadAccounts={tracking.loadAccounts}
                    format={fmt}
                    onClose={changed => { if (changed) record('ynab-writeback', 'Update the YNAB Writeback accounts', 'Moves written to YNAB'); setYnabModal(null); }}
                />
            )}
            {ynabModal === 'revalue' && (
                <RevalueModal
                    plan={tracking.plan}
                    accounts={tracking.accounts}
                    format={fmt}
                    onClose={changed => { if (changed) record('ynab-revalue', 'Revalue the YNAB Writeback accounts', 'Accounts revalued in YNAB'); setYnabModal(null); void tracking.loadAccounts(); }}
                />
            )}
            {capexSync.modal}
        </section>
    );
};

export default QuickActions;
