import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildFundingCommit, isRegisterableOrder, type YnabFundingPlan } from '../../utils/ynabFundingPlan';
import { buildSnapshot, type SnapshotInput } from '../../utils/relocationSnapshot';
import { calculateAssets } from '../../utils/portfolioCalculations';
import RelocationWhatIf, { CompareTable, type Row } from '../FundRelocation/RelocationWhatIf';
import '../FundRelocation/FundRelocation.css';

/**
 * The funding plan's before/after: the Stats page as it reads today, and as it
 * would read the moment "Register" is pressed.
 *
 * The "after" is not modelled separately — it is `buildFundingCommit`, the same
 * function Register writes with, applied to a copy of the ledger. So the charts
 * follow the "Also credit the wires" checkbox exactly as registering would, and
 * orders that are not ready to register are absent here too.
 *
 * Both readings go through the Fund Relocation snapshot on the SCOPED data, so
 * the family/illiquid/person toggles count the same things as on Stats; a buy at
 * a broker outside the scope simply does not show.
 */

const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;
const pct1 = (v: number) => `${v.toFixed(1)}%`;
/** Cash can go below zero when the wires are not credited, and must say so legibly. */
const cashEur = (v: number) => (v < -0.5 ? `−${eur0(-v)}` : eur0(v));

interface Props {
    plan: YnabFundingPlan;
    /** Mirrors the plan card's "Also credit the wires" checkbox. */
    creditTransfers: boolean;
}

const YnabFundingWhatIf: React.FC<Props> = ({ plan, creditTransfers }) => {
    const {
        portfolios, goals, marketData, macroAllocations, goalAllocations,
        scopedTransactions: transactions,
        scopedBrokers: brokers,
        effectiveAssetSettings: assetSettings,
    } = usePortfolio();

    const [open, setOpen] = useState(true);

    const commit = useMemo(
        () => buildFundingCommit(plan.orders, {
            date: new Date().toISOString().slice(0, 10),
            stamp: 'preview',
            creditTransfers: creditTransfers ? plan.transfers : undefined,
        }),
        [plan, creditTransfers]
    );

    const scopedIds = useMemo(() => new Set(brokers.map(b => b.id)), [brokers]);

    const afterTransactions = useMemo(
        () => [...transactions, ...commit.transactions.filter(t => !t.brokerId || scopedIds.has(t.brokerId))],
        [transactions, commit, scopedIds]
    );
    const afterBrokers = useMemo(
        () => brokers.map(b => commit.liquidityDeltas[b.id]
            ? { ...b, currentLiquidity: (b.currentLiquidity || 0) + commit.liquidityDeltas[b.id] }
            : b),
        [brokers, commit]
    );

    const snapshotInput = useMemo<SnapshotInput>(() => ({
        transactions, brokers, portfolios, goals, assetSettings, marketData, macroAllocations, goalAllocations,
    }), [transactions, brokers, portfolios, goals, assetSettings, marketData, macroAllocations, goalAllocations]);

    const before = useMemo(() => buildSnapshot(snapshotInput), [snapshotInput]);
    const after = useMemo(
        () => buildSnapshot({ ...snapshotInput, transactions: afterTransactions, brokers: afterBrokers }),
        [snapshotInput, afterTransactions, afterBrokers]
    );

    /**
     * Net worth moves for three reasons only: money arriving from an account
     * the app does not count, the commissions, and the fees of the counted
     * accounts that send the wires. The first is derived as the remainder, so
     * the three always add up to the figure in the table.
     */
    const netWorthStory = useMemo(() => {
        const commissions = plan.orders
            .filter(o => isRegisterableOrder(o) && scopedIds.has(o.brokerId as string))
            .reduce((s, o) => s + o.commission, 0);
        const bankFees = creditTransfers
            ? plan.transfers.reduce((s, t) => s + t.legs
                .filter(l => l.sourceBrokerId && scopedIds.has(l.sourceBrokerId))
                .reduce((ls, l) => ls + l.cost, 0), 0)
            : 0;
        const delta = after.netWorth - before.netWorth;
        const fromOutside = delta + commissions + bankFees;
        const parts: string[] = [];
        if (Math.abs(fromOutside) >= 0.5) parts.push(`${fromOutside > 0 ? '+' : '−'} ${eur0(Math.abs(fromOutside))} arriving from accounts not counted here`);
        if (commissions >= 0.5) parts.push(`− ${eur0(commissions)} of commissions`);
        if (bankFees >= 0.5) parts.push(`− ${eur0(bankFees)} of bank fees`);
        return parts.length > 0 ? parts.join(' ') : 'unchanged: the money only changes shape, from cash into holdings';
    }, [plan, creditTransfers, scopedIds, before.netWorth, after.netWorth]);

    /** The assets the orders buy, with their weight in the whole net worth. */
    const assetRows = useMemo<Row[]>(() => {
        const tickers = Array.from(new Set(commit.transactions.map(t => t.ticker)));
        if (tickers.length === 0) return [];
        const read = (txs: typeof transactions) => {
            const { assets } = calculateAssets(txs.filter(t => tickers.includes(t.ticker)), assetSettings, marketData);
            return Object.fromEntries(tickers.map(tk => [tk, assets.filter(a => a.ticker === tk).reduce((s, a) => s + a.currentValue, 0)]));
        };
        const b = read(transactions);
        const a = read(afterTransactions);
        const share = (v: number, total: number) => (total > 0 ? (v / total) * 100 : 0);
        return tickers
            .map(tk => ({
                label: plan.orders.find(o => o.ticker === tk)?.label ?? tk,
                before: b[tk] ?? 0,
                after: a[tk] ?? 0,
                hint: `${pct1(share(b[tk] ?? 0, before.netWorth))} → ${pct1(share(a[tk] ?? 0, after.netWorth))} of net worth`,
            }))
            .sort((x, y) => (y.after - y.before) - (x.after - x.before));
    }, [commit, transactions, afterTransactions, assetSettings, marketData, plan.orders, before.netWorth, after.netWorth]);

    /** Cash per account the plan touches: where the wires land and leave from. */
    const cashRows = useMemo<Row[]>(() => brokers
        .filter(b => Math.abs(commit.liquidityDeltas[b.id] ?? 0) >= 0.005)
        .map(b => ({
            label: b.name,
            before: b.currentLiquidity || 0,
            after: (b.currentLiquidity || 0) + (commit.liquidityDeltas[b.id] ?? 0),
            hint: (b.currentLiquidity || 0) + (commit.liquidityDeltas[b.id] ?? 0) < 0 ? 'goes negative — wire more first' : undefined,
        })),
    [brokers, commit]);

    if (commit.transactions.length === 0 && Object.keys(commit.liquidityDeltas).length === 0) return null;

    const orderCount = commit.transactions.length;

    return (
        <div className="ynab-plan-card ynab-whatif">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div>
                    <h3 style={{ margin: 0 }}>Before / after</h3>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                        The Stats page once {orderCount} purchase{orderCount === 1 ? ' is' : 's are'} registered
                        {creditTransfers ? ' and the wires credited' : ', without crediting the wires'}.
                    </div>
                </div>
                <button type="button" className="btn btn-secondary" onClick={() => setOpen(o => !o)}>
                    {open ? 'Hide' : 'Show'}
                </button>
            </div>

            {open && (
                <div className="reloc-container ynab-whatif-body">
                    <RelocationWhatIf
                        before={before}
                        after={after}
                        friction={0}
                        moveCount={1}
                        copy={{
                            title: 'How the numbers change — after registering',
                            netWorthHint: netWorthStory,
                            realizedHint: 'nothing is sold, so nothing is realized',
                            afterLabel: 'After the plan',
                            pyramidHint: (
                                <>
                                    The pyramid total is net worth: after the plan it is{' '}
                                    {eur0(Math.abs(after.goalPyramidTotal - before.goalPyramidTotal))}{' '}
                                    {after.goalPyramidTotal >= before.goalPyramidTotal ? 'higher' : 'lower'}, the same
                                    change as the net worth above. Money wired from an account the app already counts
                                    only changes shape, so the total moves by the commissions and fees alone; what the
                                    purchases do change is how the total is split across the goals.
                                </>
                            ),
                        }}
                    >
                        {assetRows.length > 0 && <CompareTable title="Assets bought" rows={assetRows} />}
                        {cashRows.length > 0 && <CompareTable title="Cash at each account" rows={cashRows} format={cashEur} />}
                    </RelocationWhatIf>
                </div>
            )}
        </div>
    );
};

export default YnabFundingWhatIf;
