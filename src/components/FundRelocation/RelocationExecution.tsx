import React, { useMemo } from 'react';
import type { ExecutionMove, ExecutionStep } from '../../utils/relocationExecution';

/**
 * The queue as a to-do list, and the button that turns it into history.
 *
 * A relocation is not one order: it is a sale, a wire, and a purchase that can
 * only happen once the money has landed. Each of those is a line here — the
 * wire included, because "move €12,700 from Degiro to Directa" is something the
 * user has to go and do, not a footnote. Marking it executed records the trades
 * and settles the broker balances; the wire moves cash without ever becoming a
 * transaction.
 */

const eur = (v: number) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;

const StepRow: React.FC<{ step: ExecutionStep; n: number }> = ({ step, n }) => {
    if (step.kind === 'transfer') {
        return (
            <div className={`reloc-exec-step transfer${step.required ? ' required' : ''}`}>
                <span className="reloc-exec-num">{n}</span>
                <span className="reloc-badge transfer">MOVE</span>
                <span className="reloc-exec-main">
                    <span className="reloc-exec-title">
                        {step.fromBrokerName}
                        <span className="reloc-exec-arrow" aria-hidden="true">→</span>
                        {step.toBrokerName}
                    </span>
                    <span className="reloc-exec-sub">
                        {step.required
                            ? 'wire it before placing the buys — they cannot clear otherwise'
                            : 'settles the proceeds where they belong; the buys clear either way'}
                    </span>
                </span>
                <span className="reloc-exec-amount">{eur0(step.amount)}</span>
            </div>
        );
    }

    const isSell = step.kind === 'sell';
    return (
        <div className="reloc-exec-step">
            <span className="reloc-exec-num">{n}</span>
            <span className={`reloc-badge ${isSell ? 'sell' : 'buy'}`}>{isSell ? 'SELL' : 'BUY'}</span>
            <span className="reloc-exec-main">
                <span className="reloc-exec-title">
                    {step.ticker}
                    <span className="reloc-exec-qty">× {step.shares.toLocaleString('en-IE')} @ {eur(step.price)}</span>
                </span>
                <span className="reloc-exec-sub">
                    {step.label ? `${step.label} · ` : ''}{step.portfolioName}
                    {step.brokerName ? ` · ${step.brokerName}` : ' · no broker on record'}
                    {isSell
                        ? ` — credits ${eur0(step.net)} after ${eur0(step.tax)} tax and ${eur(step.commission)} fee`
                        : ` — costs ${eur0(step.gross + step.commission)}${step.freeCommission ? ' (promo: no fee)' : ` including ${eur(step.commission)} fee`}`}
                </span>
            </span>
            <span className="reloc-exec-amount">{isSell ? eur0(step.gross) : eur0(step.gross)}</span>
        </div>
    );
};

export interface RelocationExecutionProps {
    moves: ExecutionMove[];
    onExecute: () => void;
    busy?: boolean;
}

const RelocationExecution: React.FC<RelocationExecutionProps> = ({ moves, onExecute, busy = false }) => {
    // Numbered across the whole queue, not per move: the list is one procedure
    // to follow top to bottom, and step 4 of move 2 is really step 7.
    const numbered = useMemo(() => {
        let n = 0;
        return moves.map(move => ({
            move,
            steps: move.steps.map(step => ({ step, n: ++n })),
        }));
    }, [moves]);
    const total = numbered.reduce((s, m) => s + m.steps.length, 0);
    if (total === 0) return null;

    return (
        <div className="reloc-card">
            <div className="reloc-sequence-header">
                <h3 className="reloc-section-title reloc-section-title--flush">
                    Actions to perform
                    <span className="reloc-count-badge">{total}</span>
                </h3>
                <button type="button" className="reloc-btn primary" onClick={onExecute} disabled={busy}>
                    ✓ Mark as executed
                </button>
            </div>

            {numbered.map(({ move, steps }) => (
                <div className="reloc-exec-move" key={move.index}>
                    <div className="reloc-exec-move-head">
                        Move {move.index} · {move.fromLabel}
                        <span className="reloc-exec-arrow" aria-hidden="true">→</span>
                        {move.toLabel}
                        <span className="reloc-exec-move-amount">{eur0(move.netAmount)}</span>
                    </div>
                    {steps.map(({ step, n }, i) => (
                        <StepRow key={`${move.index}-${i}`} step={step} n={n} />
                    ))}
                </div>
            ))}

            <p className="reloc-exec-note">
                Executing records the sells and the buys as transactions, and settles every broker's cash:
                up by what a sale actually credits (gross minus tax and fee), down and up again for each wire,
                down by what a purchase costs. <strong>The wire is never written to the ledger</strong> — no
                position changes and no gain is realised — so only the trades show up in Transactions.
            </p>
        </div>
    );
};

export default RelocationExecution;
