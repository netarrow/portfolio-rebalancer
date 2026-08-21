import React, { useCallback, useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { GoalFlowPortfolioState } from '../../types';
import {
    applyRelocationToState,
    isSameEndpoint,
    planFundRelocation,
    planHasEffect,
    planRelocationSequence,
    portfolioAssets,
    type RelocationContext,
    type RelocationEndpoint,
    type RelocationRequest,
} from '../../utils/fundRelocation';
import { buildSnapshot, type SnapshotInput } from '../../utils/relocationSnapshot';
import RelocationForm from './RelocationForm';
import RelocationActions from './RelocationActions';
import RelocationSequenceView from './RelocationSequence';
import RelocationWhatIf from './RelocationWhatIf';
import GoalFlowPlanner from './GoalFlowPlanner';
import RelocationExecution from './RelocationExecution';
import { buildExecutionCommit, buildExecutionMoves } from '../../utils/relocationExecution';
import AssetScopeToggles from '../Layout/AssetScopeToggles';
import './FundRelocation.css';

/**
 * Fund Relocation — what moving money actually costs.
 *
 * Portfolios are logical buckets over transactions, so a relocation is a real
 * sell → buy round trip that leaks capital-gains tax and two commissions. This
 * page prices that round trip and then shows the resulting state measured with
 * the SAME calculators the Stats page uses, so the "before" column is not a
 * second opinion — it is the Stats page's own arithmetic.
 *
 * Moves can be queued into a SEQUENCE, and that is not a convenience wrapper
 * around several independent simulations: every step is planned against the
 * state the previous ones produce, and the what-if at the bottom always
 * compares today against the end of the whole chain. That is the only way to
 * answer "where do I end up if I do all of this", because the friction of a
 * chain is strictly worse than the sum of its parts priced in isolation.
 */
const FundRelocationView: React.FC = () => {
    const {
        portfolios, goals, marketData, macroAllocations, goalAllocations, freeCommissionPeriods,
        goalModeTargets, setGoalModeTargets, goalFlowPortfolioStates, setGoalFlowPortfolioStates,
        addTransactionsBulk, adjustBrokerLiquidity,
        // Scoped + effective, so this page counts exactly what the Stats page
        // counts: the family/illiquid/person toggles apply here too, and
        // unresolved virtual bonds carry their synthetic Bond definition
        // instead of falling back to the Stock default.
        scopedTransactions: transactions,
        scopedBrokers: brokers,
        effectiveAssetSettings: assetSettings,
    } = usePortfolio();

    const [from, setFrom] = useState<RelocationEndpoint>({ kind: 'portfolio', portfolioId: '' });
    const [to, setTo] = useState<RelocationEndpoint>({ kind: 'portfolio', portfolioId: '' });
    const [netAmount, setNetAmount] = useState(0);
    const [applyFreeBuyPromo, setApplyFreeBuyPromo] = useState(false);
    /** Moves already pinned, in execution order. The form always edits the next one. */
    const [queue, setQueue] = useState<RelocationRequest[]>([]);

    // Default the two ends to different portfolios once the data is loaded,
    // without fighting a choice the user has already made.
    const resolvedFrom = useMemo<RelocationEndpoint>(() => {
        if (from.kind === 'cash' || portfolios.some(p => p.id === from.portfolioId)) return from;
        return { kind: 'portfolio', portfolioId: portfolios[0]?.id ?? '' };
    }, [from, portfolios]);

    const resolvedTo = useMemo<RelocationEndpoint>(() => {
        if (to.kind === 'cash' || portfolios.some(p => p.id === to.portfolioId)) return to;
        const fallback = portfolios.find(p => p.id !== (resolvedFrom.kind === 'portfolio' ? resolvedFrom.portfolioId : ''));
        return { kind: 'portfolio', portfolioId: (fallback ?? portfolios[0])?.id ?? '' };
    }, [to, portfolios, resolvedFrom]);

    /** Today's state — the baseline every comparison is measured against. */
    const baseCtx = useMemo<RelocationContext>(() => ({
        portfolios, brokers, transactions, assetSettings, marketData, freeCommissionPeriods,
    }), [portfolios, brokers, transactions, assetSettings, marketData, freeCommissionPeriods]);

    const sequence = useMemo(() => planRelocationSequence(queue, baseCtx), [queue, baseCtx]);

    /**
     * The move being edited starts where the queue ends, so the dropdowns offer
     * the holdings the earlier moves created and the plan is priced on the cash
     * they raised.
     */
    const draftCtx = sequence.ctx;

    const sourceAssets = useMemo(
        () => (resolvedFrom.kind === 'portfolio' && resolvedFrom.portfolioId ? portfolioAssets(resolvedFrom.portfolioId, draftCtx) : []),
        [resolvedFrom, draftCtx]
    );
    const destAssets = useMemo(
        () => (resolvedTo.kind === 'portfolio' && resolvedTo.portfolioId ? portfolioAssets(resolvedTo.portfolioId, draftCtx) : []),
        [resolvedTo, draftCtx]
    );

    const request = useMemo<RelocationRequest>(
        () => ({ from: resolvedFrom, to: resolvedTo, netAmount, applyFreeBuyPromo }),
        [resolvedFrom, resolvedTo, netAmount, applyFreeBuyPromo]
    );

    const sameEndpoint = isSameEndpoint(resolvedFrom, resolvedTo);

    const plan = useMemo(
        () => (netAmount > 0 && !sameEndpoint ? planFundRelocation(request, draftCtx) : null),
        [request, draftCtx, netAmount, sameEndpoint]
    );

    /** State after the queue AND the move currently in the form. */
    const previewCtx = useMemo(() => {
        if (!plan) return draftCtx;
        const moved = applyRelocationToState(draftCtx.transactions, draftCtx.brokers, request, plan, '__reloc_draft');
        return { ...draftCtx, transactions: moved.transactions, brokers: moved.brokers };
    }, [plan, request, draftCtx]);

    const snapshotInput = useMemo<SnapshotInput>(() => ({
        transactions, brokers, portfolios, goals, assetSettings, marketData, macroAllocations, goalAllocations,
    }), [transactions, brokers, portfolios, goals, assetSettings, marketData, macroAllocations, goalAllocations]);

    const before = useMemo(() => buildSnapshot(snapshotInput), [snapshotInput]);

    // A move that cannot raise or deploy anything leaves the state untouched, so
    // it must not be counted as "included" in a what-if that would show no
    // change at all — its warnings already say why nothing happened.
    const previewCount = useMemo(
        () => sequence.steps.filter(s => planHasEffect(s.plan)).length + (plan && planHasEffect(plan) ? 1 : 0),
        [sequence, plan]
    );

    const after = useMemo(() => {
        if (previewCount === 0) return null;
        return buildSnapshot({ ...snapshotInput, transactions: previewCtx.transactions, brokers: previewCtx.brokers });
    }, [previewCount, previewCtx, snapshotInput]);

    const totalFriction = sequence.totals.friction + (plan?.friction ?? 0);

    /** The queue as ordered actions: sell here, wire there, buy at the other end. */
    const executionMoves = useMemo(
        () => buildExecutionMoves(sequence.steps.filter(s => planHasEffect(s.plan)), portfolios),
        [sequence.steps, portfolios]
    );

    const [executing, setExecuting] = useState(false);

    /**
     * Records what was done. The trades become transactions; the wires never do
     * — they only move broker cash, together with the tax and the fees, which
     * is why the generic per-trade cash sync is switched off here: this page
     * knows the exact figures, having priced them.
     */
    const executeQueue = useCallback(async () => {
        const commit = buildExecutionCommit(
            executionMoves,
            new Date().toISOString().slice(0, 10),
            `reloc-${Date.now()}`
        );
        if (commit.transactions.length === 0 && Object.keys(commit.liquidityDeltas).length === 0) return;

        const Swal = (await import('sweetalert2')).default;
        const cashLines = Object.entries(commit.liquidityDeltas)
            .map(([brokerId, delta]) => {
                const name = brokers.find(b => b.id === brokerId)?.name ?? brokerId;
                const sign = delta >= 0 ? '+' : '−';
                return `<div>${name}: <b>${sign}€${Math.abs(delta).toLocaleString('en-IE', { maximumFractionDigits: 0 })}</b></div>`;
            })
            .join('');

        const result = await Swal.fire({
            title: 'Mark these actions as executed?',
            html:
                `This records <b>${commit.counts.sells}</b> sell${commit.counts.sells === 1 ? '' : 's'} and ` +
                `<b>${commit.counts.buys}</b> buy${commit.counts.buys === 1 ? '' : 's'} as transactions` +
                (commit.counts.transfers > 0
                    ? `, and moves the cash for <b>${commit.counts.transfers}</b> transfer${commit.counts.transfers === 1 ? '' : 's'} between brokers (never written to the ledger).`
                    : '.') +
                '<br/><br/><div style="text-align:left;display:inline-block">' + cashLines + '</div>' +
                '<br/><small style="color:var(--text-muted)">Broker liquidity is updated with tax and commissions included. Re-align it by hand afterwards if your statement disagrees.</small>',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, I did all of this',
            cancelButtonText: 'Not yet',
            confirmButtonColor: '#10B981',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
        });
        if (!result.isConfirmed) return;

        setExecuting(true);
        // Cash first: the trades are what the user will look at, so they should
        // land last and leave the page on a consistent state either way.
        adjustBrokerLiquidity(commit.liquidityDeltas);
        addTransactionsBulk(commit.transactions, { skipCashSync: true });
        setQueue([]);
        setNetAmount(0);
        setExecuting(false);

        Swal.fire({
            title: 'Recorded',
            text: `${commit.transactions.length} transaction${commit.transactions.length === 1 ? '' : 's'} created and broker cash updated.`,
            icon: 'success',
            timer: 2200,
            showConfirmButton: false,
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
        });
    }, [executionMoves, brokers, addTransactionsBulk, adjustBrokerLiquidity]);

    const addToSequence = useCallback(() => {
        if (!plan) return;
        setQueue(prev => [...prev, request]);
        // Only the amount is cleared: the endpoints are the most likely start of
        // the next move, and leaving them alone keeps the form where the eye is.
        setNetAmount(0);
    }, [plan, request]);

    /** The goal planner hands over whole moves; they queue like any other. */
    /**
     * 'active' is the default, so it is stored as the ABSENCE of an entry: the
     * map only ever holds the portfolios the user took out of the planner's
     * hands, and a deleted portfolio leaves nothing behind.
     */
    const setPortfolioState = useCallback((portfolioId: string, state: GoalFlowPortfolioState) => {
        setGoalFlowPortfolioStates(prev => {
            const next = { ...prev };
            if (state === 'active') delete next[portfolioId];
            else next[portfolioId] = state;
            return next;
        });
    }, [setGoalFlowPortfolioStates]);

    const queueMoves = useCallback((requests: RelocationRequest[]) => {
        if (requests.length === 0) return;
        setQueue(prev => [...prev, ...requests]);
    }, []);

    const removeStep = useCallback((index: number) => {
        setQueue(prev => prev.filter((_, i) => i !== index));
    }, []);

    const reorderStep = useCallback((index: number, target: number) => {
        setQueue(prev => {
            if (target < 0 || target >= prev.length) return prev;
            const next = [...prev];
            const [moved] = next.splice(index, 1);
            next.splice(target, 0, moved);
            return next;
        });
    }, []);

    if (portfolios.length === 0) {
        return (
            <div className="reloc-container">
                <div className="reloc-card">
                    <p className="reloc-empty">
                        You need at least one portfolio to simulate a move. Create one from the Portfolios page.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="reloc-container">
            <AssetScopeToggles style={{ marginBottom: '0.75rem' }} />
            <h2 className="section-title reloc-page-title">Fund Relocation</h2>
            <p className="reloc-intro">
                Portfolios are logical containers over transactions, so moving funds means
                <strong> selling there and buying back here</strong> — and the round trip leaves tax and
                commissions behind. This page shows the exact actions, what the move really costs, and how
                the stats and the pyramid would end up. Queue several moves and the chain is priced in
                order, each one on the state the previous left behind. Start from the goal split below to
                let the gaps between your goals propose the moves.
            </p>

            <GoalFlowPlanner
                goals={goals}
                portfolios={portfolios}
                transactions={transactions}
                brokers={brokers}
                assetSettings={assetSettings}
                marketData={marketData}
                targets={goalModeTargets}
                onTargetsChange={setGoalModeTargets}
                portfolioStates={goalFlowPortfolioStates}
                onPortfolioStateChange={setPortfolioState}
                onQueueMoves={queueMoves}
            />

            <RelocationForm
                from={resolvedFrom}
                to={resolvedTo}
                netAmount={netAmount}
                applyFreeBuyPromo={applyFreeBuyPromo}
                onFromChange={setFrom}
                onToChange={setTo}
                onNetAmountChange={setNetAmount}
                onFreeBuyPromoChange={setApplyFreeBuyPromo}
                portfolios={portfolios}
                brokers={brokers}
                sourceAssets={sourceAssets}
                destAssets={destAssets}
                queuedCount={queue.length}
                onAddToSequence={addToSequence}
                canAddToSequence={plan !== null}
            />

            <RelocationSequenceView
                steps={sequence.steps}
                totals={sequence.totals}
                portfolios={portfolios}
                brokers={brokers}
                draftFriction={plan?.friction ?? 0}
                onRemove={removeStep}
                onReorder={reorderStep}
                onClear={() => setQueue([])}
            />

            <RelocationExecution moves={executionMoves} onExecute={executeQueue} busy={executing} />

            {sameEndpoint && (
                <div className="reloc-warning critical">
                    <span aria-hidden="true">⛔</span>
                    <span>Source and destination are the same: pick two different endpoints.</span>
                </div>
            )}

            {!sameEndpoint && netAmount <= 0 && (
                <div className="reloc-card">
                    <p className="reloc-empty">
                        {queue.length > 0
                            ? 'Enter the net amount to add another move — the totals below cover the queued ones.'
                            : 'Enter the net amount to move to see the plan.'}
                    </p>
                </div>
            )}

            {plan && (
                <>
                    {queue.length > 0 && (
                        <h3 className="reloc-draft-title">Move {queue.length + 1}, not yet queued</h3>
                    )}
                    <RelocationActions plan={plan} />
                </>
            )}

            {after && (
                <RelocationWhatIf
                    before={before}
                    after={after}
                    friction={totalFriction}
                    moveCount={previewCount}
                />
            )}
        </div>
    );
};

export default FundRelocationView;
