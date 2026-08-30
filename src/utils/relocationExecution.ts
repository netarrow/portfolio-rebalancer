import type { Portfolio, Transaction } from '../types';
import type { RelocationStep } from './fundRelocation';

/**
 * Turning a priced plan into things to actually do — and, once done, into the
 * ledger.
 *
 * The chain a relocation really is never fits in one order ticket: you sell at
 * one broker, wait for the wire to reach another, and only then buy. So the
 * queue is flattened into ordered steps that read like the actions themselves,
 * and executing writes exactly what happened:
 *
 *  - the sells and the buys become transactions, because those are positions;
 *  - the wire does NOT, because nothing is bought, sold or earned by it;
 *  - broker cash moves for all three, including the tax and the commissions
 *    that the generic per-trade sync (gross only) cannot know about.
 *
 * A move that ends in a SPEND is the exception to all of it: it is a simulation
 * and nothing more. It is listed here so the chain reads in full — and so a
 * spend funded by a sale still shows which sale — but it writes nothing, not
 * the spend and not the sale behind it. Committing half of it (the trade
 * without the money leaving) would leave the ledger disagreeing with the very
 * what-if the move was made for.
 *
 * The cash figures are the plan's own — `sell.net` is already gross − tax −
 * commission — so what lands in the brokers after executing equals what the
 * what-if predicted. They are applied instead of, never on top of, the
 * automatic sync (see `addTransactionsBulk(txs, { skipCashSync: true })`).
 */

export interface SellStep {
    kind: 'sell';
    /** 1-based position of the queued move this belongs to. */
    moveIndex: number;
    ticker: string;
    label?: string;
    shares: number;
    price: number;
    gross: number;
    tax: number;
    commission: number;
    /** gross − tax − commission: what the broker actually credits. */
    net: number;
    brokerId?: string;
    brokerName?: string;
    portfolioId?: string;
    portfolioName: string;
}

export interface TransferStep {
    kind: 'transfer';
    moveIndex: number;
    fromBrokerId: string;
    fromBrokerName: string;
    toBrokerId: string;
    toBrokerName: string;
    amount: number;
    required: boolean;
}

/**
 * Money consumed: it leaves the net worth and lands nowhere. Simulation only —
 * never a transaction, never a cash adjustment.
 */
export interface SpendStep {
    kind: 'spend';
    moveIndex: number;
    amount: number;
    /** Where the money is taken from, for the line's caption. */
    fromLabel: string;
}

export interface BuyStep {
    kind: 'buy';
    moveIndex: number;
    ticker: string;
    label?: string;
    shares: number;
    price: number;
    gross: number;
    commission: number;
    freeCommission: boolean;
    brokerId?: string;
    brokerName?: string;
    portfolioId?: string;
    portfolioName: string;
}

export type ExecutionStep = SellStep | TransferStep | BuyStep | SpendStep;

export interface ExecutionMove {
    /** 1-based, matching the queue's own numbering. */
    index: number;
    fromLabel: string;
    toLabel: string;
    netAmount: number;
    steps: ExecutionStep[];
    /** A spend: shown, but never committed — not its spend and not its sells. */
    simulationOnly: boolean;
}

/** Virtual tickers (`_CASH_`, `_VBOND_`) are placeholders: no cash changes hands. */
const movesCash = (ticker: string): boolean => !ticker.startsWith('_');

const endpointLabel = (
    endpoint: RelocationStep['request']['from'],
    portfolios: Portfolio[]
): string => {
    if (endpoint.kind === 'cash') return 'Cash';
    if (endpoint.kind === 'spend') return 'Spent';
    return portfolios.find(p => p.id === endpoint.portfolioId)?.name ?? 'Portfolio';
};

/**
 * The queue as an ordered list of actions, grouped by move. Sells first, then
 * the wires they fund, then the buys: that is the order the money can actually
 * travel in.
 */
export const buildExecutionMoves = (steps: RelocationStep[], portfolios: Portfolio[]): ExecutionMove[] =>
    steps.map(({ request, plan }, i) => {
        const moveIndex = i + 1;
        const fromLabel = endpointLabel(request.from, portfolios);
        const toLabel = endpointLabel(request.to, portfolios);
        const fromPortfolioId = request.from.kind === 'portfolio' ? request.from.portfolioId : undefined;
        const toPortfolioId = request.to.kind === 'portfolio' ? request.to.portfolioId : undefined;

        const sells: ExecutionStep[] = plan.sells.map(s => ({
            kind: 'sell',
            moveIndex,
            ticker: s.ticker,
            label: s.label,
            shares: s.shares,
            price: s.price,
            gross: s.gross,
            tax: s.tax,
            commission: s.commission,
            net: s.net,
            brokerId: s.brokerId,
            brokerName: s.brokerName,
            portfolioId: fromPortfolioId,
            portfolioName: fromLabel,
        }));

        const transfers: ExecutionStep[] = plan.transfers.map(t => ({
            kind: 'transfer',
            moveIndex,
            fromBrokerId: t.fromBrokerId,
            fromBrokerName: t.fromBrokerName,
            toBrokerId: t.toBrokerId,
            toBrokerName: t.toBrokerName,
            amount: t.amount,
            required: t.required,
        }));

        const buys: ExecutionStep[] = plan.buys.map(b => ({
            kind: 'buy',
            moveIndex,
            ticker: b.ticker,
            label: b.label,
            shares: b.shares,
            price: b.price,
            gross: b.gross,
            commission: b.commission,
            freeCommission: b.freeCommission,
            brokerId: b.brokerId,
            brokerName: b.brokerName,
            portfolioId: toPortfolioId,
            portfolioName: toLabel,
        }));

        const spends: ExecutionStep[] = request.to.kind === 'spend' && plan.spent > 0
            ? [{ kind: 'spend', moveIndex, amount: plan.spent, fromLabel }]
            : [];

        return {
            index: moveIndex,
            fromLabel,
            toLabel,
            netAmount: request.netAmount,
            steps: [...sells, ...transfers, ...buys, ...spends],
            simulationOnly: request.to.kind === 'spend',
        };
    });

export interface ExecutionCommit {
    /** Only the trades: a wire is not a transaction and never becomes one. */
    transactions: Transaction[];
    /** brokerId → € to add to `currentLiquidity`, tax and commissions included. */
    liquidityDeltas: Record<string, number>;
    counts: { sells: number; buys: number; transfers: number };
}

/**
 * What executing writes. `date` is the trade date stamped on the transactions
 * and `idPrefix` namespaces their ids, both injected so the caller stays in
 * charge of the clock and of id collisions.
 */
export const buildExecutionCommit = (
    moves: ExecutionMove[],
    date: string,
    idPrefix: string
): ExecutionCommit => {
    const transactions: Transaction[] = [];
    const liquidityDeltas: Record<string, number> = {};
    const counts = { sells: 0, buys: 0, transfers: 0 };

    const bump = (brokerId: string | undefined, amount: number) => {
        if (!brokerId || !Number.isFinite(amount) || amount === 0) return;
        liquidityDeltas[brokerId] = (liquidityDeltas[brokerId] ?? 0) + amount;
    };

    // A spend move is a what-if from end to end: skipped whole, so no sale of
    // its own reaches the ledger either.
    moves.filter(move => !move.simulationOnly).forEach(move => {
        move.steps.forEach((step, i) => {
            const id = `${idPrefix}-${move.index}-${i}`;
            if (step.kind === 'sell') {
                counts.sells += 1;
                transactions.push({
                    id,
                    ticker: step.ticker,
                    amount: step.shares,
                    price: step.price,
                    date,
                    direction: 'Sell',
                    portfolioId: step.portfolioId,
                    brokerId: step.brokerId,
                });
                // Net of the tax on the gain and of the sale commission: that is
                // what the account is credited with, and what the buys were sized on.
                if (movesCash(step.ticker)) bump(step.brokerId, step.net);
            } else if (step.kind === 'buy') {
                counts.buys += 1;
                transactions.push({
                    id,
                    ticker: step.ticker,
                    amount: step.shares,
                    price: step.price,
                    date,
                    direction: 'Buy',
                    portfolioId: step.portfolioId,
                    brokerId: step.brokerId,
                    freeCommission: step.freeCommission || undefined,
                });
                if (movesCash(step.ticker)) bump(step.brokerId, -(step.gross + step.commission));
            } else if (step.kind === 'transfer') {
                counts.transfers += 1;
                bump(step.fromBrokerId, -step.amount);
                bump(step.toBrokerId, step.amount);
            }
        });
    });

    // Sub-cent residue is noise in a balance the user reconciles by hand.
    Object.keys(liquidityDeltas).forEach(id => {
        liquidityDeltas[id] = Math.round(liquidityDeltas[id] * 100) / 100;
        if (liquidityDeltas[id] === 0) delete liquidityDeltas[id];
    });

    return { transactions, liquidityDeltas, counts };
};
