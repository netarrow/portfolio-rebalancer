import type {
    AssetDefinition, Broker, FreeCommissionPeriod, Goal, GoalFlowPortfolioState, OperationKind, PriceHistoryMap, OperationRecord, PacExecution, PacPlan, Portfolio, Transaction,
    VirtualBond, YnabGoal, YnabGoalAllocation,
} from '../types';
import { getVirtualBondTicker, isVirtualBondTicker } from '../types';
import { calculateAssets, isCashTicker, isGroupKey } from './portfolioCalculations';
import { memberInfoFromAssets, resolveGroups } from './allocationGroups';
import { buildPortfolioCalc, buildRebalanceOrders, computeBuyOnly, computeFullRebalance } from './rebalanceOrders';
import { generateInstalments } from './pacSchedule';
import { computeBrokerAccrual } from './brokerRemuneration';
import { brokerLiquidityStatus } from './brokerLiquidity';
import { capexBondMatch } from './capexBondMatch';
import { capexNotesOutOfDate } from './ynabCapexNotes';
import { amountTargetOrders, amountTargetUnits, planAmountBuys, resolveAmountTargets } from './amountTargets';
import { buildGoalFlowPlan, goalFlowMoveToRequest, LIQUIDITY_LEVEL_ID } from './goalFlows';
import type { RelocationRequest } from './fundRelocation';
import type { MaturityLadder } from './maturityLadder';

/**
 * Execute → Operations: everything still to be done, detected from the data.
 * Each detector is pure and returns to-dos with a stable key; a to-do goes
 * away by itself when its condition does, wherever the action was taken.
 * What the page runs is recorded (OperationRecord), and a snoozed key stays
 * hidden until its date.
 */
export type OperationUrgency = 'overdue' | 'due' | 'info';

export interface OperationTodo {
    key: string;
    kind: OperationKind;
    title: string;
    detail: string;
    urgency: OperationUrgency;
    dueDate?: string;
    portfolioId?: string;
    mode?: 'Full' | 'BuyOnly';
    planId?: string;
    goalId?: string;
    virtualBondId?: string;
    brokerId?: string;
    /** Broker cash: € below (< 0) or above (> 0) what the broker must keep. */
    amount?: number;
    /** Rebalance / capex matching / bond redemption: the orders it would create. */
    orders?: Transaction[];
    /** Buckets moves: what goes into the Capital Allocation queue. */
    requests?: RelocationRequest[];
    /** Where its own page is, for the to-dos that are done there. */
    view?: 'fundRelocation' | 'settings' | 'summary' | 'dashboard';
}

// How old something may get before it is due again.
export const PRICES_MAX_AGE_HOURS = 24;
export const LIQUIDITY_MAX_AGE_DAYS = 7;
/** Interest below this (€, net) is not worth a to-do: it is credited with the next update. */
export const LIQUIDITY_MIN_INTEREST = 1;
export const CAPEX_SYNC_MAX_AGE_DAYS = 7;
export const BACKUP_MAX_AGE_DAYS = 7;
/**
 * Broker cash off what it must keep by at least this (€) is a to-do: the
 * Dashboard's "You can invest" / "You need to save" line appears from the same
 * amount.
 */
export const BROKER_CASH_TOLERANCE = 100;
/** A portfolio is due for a rebalance once one of its rows is this many points off target. */
export const REBALANCE_DRIFT_POINTS = 5;
/** A bucket (or the cash level) this many points off its target asks for moves between portfolios. */
export const GOAL_FLOW_DRIFT_POINTS = 3;
/** Price history older than this (days) is due for a refresh. */
export const HISTORY_MAX_AGE_DAYS = 7;
/** A bond maturing within this many days is announced, to plan where the money goes. */
export const BOND_MATURITY_NOTICE_DAYS = 30;
/** A capex due within this many days that counts on selling, or is short, is a to-do. */
export const CAPEX_SELL_NOTICE_DAYS = 60;

const DAY = 86_400_000;
const ageDays = (iso: string | null | undefined, now: Date) => iso ? (now.getTime() - new Date(iso).getTime()) / DAY : Infinity;
const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;
const isoDay = (d: Date) => d.toLocaleDateString('sv-SE');

/** The last time an operation of this kind was run from the page. */
export const lastDone = (records: OperationRecord[], kind: OperationKind): string | undefined =>
    records.filter(r => r.kind === kind && r.status === 'done').map(r => r.at).sort().pop();

// ── Detectors ───────────────────────────────────────────────────────

export const detectPrices = (input: {
    tickers: string[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    now: Date;
}): OperationTodo[] => {
    const stale = input.tickers.filter(t => {
        const md = input.marketData[t] ?? input.marketData[t.toUpperCase()];
        return !md || !(md.price > 0) || ageDays(md.lastUpdated, input.now) * 24 > PRICES_MAX_AGE_HOURS;
    });
    if (stale.length === 0) return [];
    return [{
        key: 'prices', kind: 'prices', urgency: 'due',
        title: 'Update prices',
        detail: `${stale.length} of ${input.tickers.length} ticker${input.tickers.length === 1 ? '' : 's'} older than a day: ${stale.slice(0, 4).join(', ')}${stale.length > 4 ? '…' : ''}`,
    }];
};

export const detectLiquidity = (input: {
    brokers: Broker[];
    /** Brokers whose liquidity is read from a YNAB account. */
    ynabBrokerIds: Set<string>;
    records: OperationRecord[];
    now: Date;
}): OperationTodo[] => {
    const today = isoDay(input.now);
    const interest = input.brokers
        .map(b => ({ b, accrual: computeBrokerAccrual(b, today) }))
        .filter((x): x is { b: Broker; accrual: NonNullable<ReturnType<typeof computeBrokerAccrual>> } => !!x.accrual && x.accrual.amount >= LIQUIDITY_MIN_INTEREST);
    const mapped = input.brokers.filter(b => input.ynabBrokerIds.has(b.id));
    const age = ageDays(lastDone(input.records, 'liquidity'), input.now);
    const ynabDue = mapped.length > 0 && age > LIQUIDITY_MAX_AGE_DAYS;
    if (interest.length === 0 && !ynabDue) return [];
    const parts: string[] = [];
    if (ynabDue) parts.push(`${mapped.length} broker${mapped.length === 1 ? '' : 's'} read from YNAB, ${Number.isFinite(age) ? `last updated here ${Math.floor(age)} days ago` : 'never updated here'}`);
    if (interest.length > 0) parts.push(`interest to credit: ${interest.map(x => `${x.b.name} €${x.accrual.amount.toFixed(2)}`).join(', ')}`);
    return [{ key: 'liquidity', kind: 'liquidity', urgency: 'due', title: 'Update broker liquidity', detail: parts.join(' · ') }];
};

/**
 * Brokers whose cash is out of range, as the Dashboard's Broker Performance &
 * Liquidity cards show it: below the minimum (plus the cash allocated to
 * portfolios, when that is reserved too), or well above it.
 */
export const detectBrokerCash = (input: {
    brokers: Broker[];
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    reserveAllocatedCash: boolean;
}): OperationTodo[] => input.brokers.flatMap(b => {
    const invested = calculateAssets(input.transactions.filter(t => t.brokerId === b.id), input.assetSettings, input.marketData).summary.totalValue;
    const st = brokerLiquidityStatus(b, invested, input.reserveAllocatedCash);
    // Without a minimum only negative cash is out of range: it cannot settle anything.
    if (!st.hasReserve && st.liquidity > -BROKER_CASH_TOLERANCE) return [];
    const reserveText = `${eur0(st.liquidity)} against ${eur0(st.reserve)} to keep${input.reserveAllocatedCash && st.allocatedReserve > 0 ? ` (minimum ${eur0(st.targetValue)} + ${eur0(st.allocatedReserve)} allocated to portfolios)` : ''}${b.minLiquidityLinked ? ' · minimum from Expense Planning' : ''}`;
    if (st.deviation <= -BROKER_CASH_TOLERANCE) return [{
        key: `broker-cash:${b.id}`, kind: 'broker-cash', brokerId: b.id, amount: st.deviation, urgency: 'due',
        title: st.hasReserve ? `Top up ${b.name}: ${eur0(-st.deviation)} below its minimum` : `Top up ${b.name}: its cash is negative (−${eur0(-st.liquidity)})`,
        detail: st.hasReserve ? reserveText : 'no minimum set; a negative balance cannot settle any order',
    } as OperationTodo];
    if (st.hasReserve && st.deviation >= BROKER_CASH_TOLERANCE) return [{
        key: `broker-cash:${b.id}`, kind: 'broker-cash', brokerId: b.id, amount: st.deviation, urgency: 'due',
        title: `You can invest ${eur0(st.deviation)} from ${b.name}`, detail: `${reserveText} · invest it in a portfolio, or move it`,
    } as OperationTodo];
    return [];
});

export const detectPac = (input: { plans: PacPlan[]; executions: PacExecution[]; now: Date }): OperationTodo[] => {
    const today = isoDay(input.now);
    return input.plans.filter(p => p.active !== false).flatMap(plan => generateInstalments(plan, today, 0)
        // Dates before the plan was created were not instalments of it: the
        // plan describes them, it did not ask for them.
        .filter(dueDate => !plan.createdAt || dueDate >= plan.createdAt.slice(0, 10))
        .filter(dueDate => dueDate <= today
            && !input.executions.some(e => e.planId === plan.id && e.dueDate === dueDate && (e.skipped || e.transactionId)))
        .map((dueDate): OperationTodo => ({
            key: `pac:${plan.id}:${dueDate}`, kind: 'pac', planId: plan.id, dueDate,
            urgency: dueDate < today ? 'overdue' : 'due',
            title: `PAC instalment: ${plan.name || plan.ticker}`,
            detail: `${plan.ticker} · due ${dueDate}`,
        })));
};

export const detectRebalance = (input: {
    portfolios: Portfolio[];
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    brokers: Broker[];
    driftPoints?: number;
}): OperationTodo[] => {
    const threshold = input.driftPoints ?? REBALANCE_DRIFT_POINTS;
    // Orders are for real money: a broker's cash allocations are cut down to
    // what the broker actually holds when they add up to more.
    const brokers = input.brokers.map(realCashAllocations);
    return input.portfolios.flatMap(portfolio => {
        // Amount-mode portfolios buy toward € targets, never sell: their own table drives them.
        if (portfolio.targetMode === 'amount') return [];
        const allocations = portfolio.allocations || {};
        if (Object.values(allocations).reduce((s, v) => s + (v || 0), 0) <= 0) return [];
        const pc = buildPortfolioCalc(portfolio, input.transactions, input.assetSettings, input.marketData, brokers);
        if (pc.totalValue <= 0) return [];
        const resolved = resolveGroups(portfolio);
        const preferredBroker = brokers.find(b => b.id === portfolio.preferredBrokerId);
        // Buy only deploys the cash set on the portfolio, but never more than
        // the cash its brokers really hold for it.
        const realCash = brokers
            .filter(b => !preferredBroker || b.id === preferredBroker.id)
            .reduce((sum, b) => sum + (b.liquidityAllocations?.[portfolio.id] || 0), 0);
        const deployable = Math.max(0, Math.min(portfolio.liquidity || 0, realCash));
        const buyPc = { ...pc, portfolio: { ...portfolio, liquidity: deployable } };
        const buyOnly = computeBuyOnly(buyPc, resolved, input.marketData);
        const out: OperationTodo[] = [];

        // Points off target, per row (a group is one row).
        let drift = 0;
        let worst = '';
        const consider = (label: string, value: number, target: number) => {
            const d = Math.abs((value / pc.totalValue) * 100 - target);
            if (d > drift) { drift = d; worst = label; }
        };
        new Set([...pc.assets.map(a => a.ticker), ...Object.keys(allocations)]).forEach(t => {
            if (isCashTicker(t) || isGroupKey(t) || isVirtualBondTicker(t) || resolved.tickerToGroupId[t.toUpperCase()]) return;
            consider(t, pc.assets.find(a => a.ticker === t)?.currentValue || 0, allocations[t] || 0);
        });
        Object.values(resolved.groupById).forEach(g => {
            const info = memberInfoFromAssets(g.members, pc.assets, input.marketData);
            consider(g.label || g.id, Object.values(info).reduce((s, m) => s + m.currentValue, 0), allocations[g.id] || 0);
        });

        if (drift >= threshold) {
            const fullRebalance = computeFullRebalance(pc, resolved, input.marketData, input.assetSettings, input.brokers, preferredBroker);
            const orders = buildRebalanceOrders({ mode: 'Full', portfolioCalc: pc, resolved, marketData: input.marketData, buyOnly, fullRebalance, allTransactions: input.transactions, preferredBroker });
            if (orders.length > 0) out.push({
                key: `rebalance:${portfolio.id}:full`, kind: 'rebalance', portfolioId: portfolio.id, mode: 'Full', orders,
                urgency: 'due', title: `Rebalance ${portfolio.name}`,
                detail: `${worst} is ${drift.toFixed(1)} points off target · ${orders.length} order${orders.length === 1 ? '' : 's'}`,
            });
        }
        // Leftovers under the cash tolerance are not worth an order of their own.
        if (deployable >= BROKER_CASH_TOLERANCE) {
            const orders = buildRebalanceOrders({ mode: 'BuyOnly', portfolioCalc: buyPc, resolved, marketData: input.marketData, buyOnly, allTransactions: input.transactions, preferredBroker });
            const capped = deployable < (portfolio.liquidity || 0) - 0.5;
            if (orders.length > 0) out.push({
                key: `rebalance:${portfolio.id}:buyonly`, kind: 'rebalance', portfolioId: portfolio.id, mode: 'BuyOnly', orders,
                urgency: 'due', title: `Invest ${portfolio.name}'s cash (Buy only)`,
                detail: `${eur0(deployable)} to deploy${capped ? ` (${eur0(portfolio.liquidity || 0)} set on the portfolio, capped to the cash at the broker${preferredBroker ? '' : 's'})` : ''} · ${orders.length} order${orders.length === 1 ? '' : 's'}`,
            });
        }
        return out;
    });
};

/**
 * Buy only orders investing `amount` of a broker's free cash in a portfolio:
 * the portfolio's own Buy only plan, sized on that amount, every order at
 * that broker.
 */
export const buildCashInvestOrders = (input: {
    portfolio: Portfolio;
    amount: number;
    broker: Broker;
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    brokers: Broker[];
}): Transaction[] => {
    const portfolio = { ...input.portfolio, liquidity: Math.max(0, input.amount) };
    const pc = buildPortfolioCalc(portfolio, input.transactions, input.assetSettings, input.marketData, input.brokers.map(realCashAllocations));
    const resolved = resolveGroups(portfolio);
    const buyOnly = computeBuyOnly(pc, resolved, input.marketData);
    return buildRebalanceOrders({ mode: 'BuyOnly', portfolioCalc: pc, resolved, marketData: input.marketData, buyOnly, allTransactions: input.transactions, preferredBroker: input.broker });
};

/** A broker whose cash allocations exceed its liquidity, scaled down to it. */
export const realCashAllocations = (b: Broker): Broker => {
    const allocations = b.liquidityAllocations ?? {};
    const total = Object.values(allocations).reduce((s, v) => s + Math.max(0, v || 0), 0);
    const available = Math.max(0, b.currentLiquidity || 0);
    if (total <= available + 0.005) return b;
    const k = total > 0 ? available / total : 0;
    return { ...b, liquidityAllocations: Object.fromEntries(Object.entries(allocations).map(([id, v]) => [id, Math.max(0, v || 0) * k])) };
};

export const detectCapex = (input: {
    goals: YnabGoal[];
    allocations: YnabGoalAllocation[];
    assetSettings: AssetDefinition[];
    virtualBonds: VirtualBond[];
    tagOf: (goalId: string) => boolean;
    goalsGroupSet: boolean;
    /** The maturity ladder: a portfolio's bonds maturing in time and its cash already pay a capex. */
    ladder?: MaturityLadder;
    now: Date;
}): OperationTodo[] => {
    const out: OperationTodo[] = [];
    const notes = input.goalsGroupSet ? capexNotesOutOfDate(input.goals, input.tagOf) : [];
    if (notes.length > 0) out.push({
        key: 'capex-notes', kind: 'capex-notes', urgency: 'due',
        title: 'Update capex categories in YNAB',
        detail: `${notes.length} categor${notes.length === 1 ? 'y' : 'ies'}: [PRB] target line or [Invested] postfix (${notes.slice(0, 3).map(g => g.name).join(', ')}${notes.length > 3 ? '…' : ''})`,
    });
    const today = isoDay(input.now);
    input.goals.filter(g => !g.archived).forEach(g => {
        const m = capexBondMatch(g, input.allocations, input.assetSettings, input.virtualBonds, input.ladder?.goals.get(g.id));
        if (!m.needsSearch) return;
        out.push({
            key: `capex-bond:${g.id}`, kind: 'capex-bond', goalId: g.id, dueDate: g.targetDate?.slice(0, 10),
            urgency: g.targetDate && g.targetDate.slice(0, 10) < today ? 'overdue' : 'info',
            title: `Find a bond for ${g.name}`,
            detail: `${eur0(m.toMatch)} invested in the portfolio as a whole that no bond maturing before ${g.targetDate?.slice(0, 10)} nor cash covers: it would have to be sold${m.readyInTime > 0.5 ? ` (${eur0(m.readyInTime)} already paid by maturing bonds and cash)` : ''}`,
        });
    });
    return out;
};

/** Virtual bonds with cash parked on them: the real bond is to be chosen and bought. */
export const detectVirtualBonds = (input: { virtualBonds: VirtualBond[]; transactions: Transaction[] }): OperationTodo[] =>
    input.virtualBonds.filter(vb => !vb.resolvedIsin).flatMap(vb => {
        const ticker = getVirtualBondTicker(vb.id);
        const parked = input.transactions.filter(t => t.ticker === ticker)
            .reduce((s, t) => s + (t.direction === 'Sell' ? -1 : 1) * t.amount * t.price, 0);
        if (parked <= 0.5) return [];
        return [{
            key: `virtual-bond:${vb.id}`, kind: 'virtual-bond', virtualBondId: vb.id, dueDate: vb.targetMaturityDate,
            urgency: 'due', title: `Concretize ${vb.label}`,
            detail: `${eur0(parked)} parked · matures around ${vb.targetMaturityDate}`,
        } as OperationTodo];
    });

export const detectSyncs = (input: {
    goalsGroupSet: boolean;
    lastGoalsSyncAt?: string;
    azureEnabled: boolean;
    azureLastSync?: string | null;
    now: Date;
}): OperationTodo[] => {
    const out: OperationTodo[] = [];
    const goalsAge = ageDays(input.lastGoalsSyncAt, input.now);
    if (input.goalsGroupSet && goalsAge > CAPEX_SYNC_MAX_AGE_DAYS) out.push({
        key: 'capex-sync', kind: 'capex-sync', urgency: 'info', title: 'Sync planned capex from YNAB',
        detail: Number.isFinite(goalsAge) ? `last sync ${Math.floor(goalsAge)} days ago` : 'never synced',
    });
    const backupAge = ageDays(input.azureLastSync, input.now);
    if (input.azureEnabled && backupAge > BACKUP_MAX_AGE_DAYS) out.push({
        key: 'backup', kind: 'backup', urgency: 'info', title: 'Back up to Azure',
        detail: Number.isFinite(backupAge) ? `last backup ${Math.floor(backupAge)} days ago` : 'never backed up',
    });
    return out;
};

/**
 * Moves between portfolios: the Buckets split (Capital Allocation's goal
 * planner) off its targets by at least GOAL_FLOW_DRIFT_POINTS on some level.
 * Nothing is proposed while the Capital Allocation queue holds moves.
 */
export const detectGoalFlows = (input: {
    goals: Goal[];
    portfolios: Portfolio[];
    transactions: Transaction[];
    brokers: Broker[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    targets: Record<string, number>;
    portfolioStates: Record<string, GoalFlowPortfolioState>;
    queued: RelocationRequest[];
}): OperationTodo[] => {
    // With moves already queued the split is measured against a state that
    // will change: the queue's own to-do comes first, the Buckets are checked
    // again once it is executed (or cleared).
    if (input.goals.length === 0 || input.queued.length > 0) return [];
    const plan = buildGoalFlowPlan({ ...input });
    // Targets the planner would still reconcile (a new bucket, none set yet)
    // say nothing about what the user wants: no to-do until they add up.
    const sum = plan.goals.reduce((s, g) => s + (input.targets[g.id] ?? 0), 0);
    if (plan.total <= 0 || !plan.goals.every(g => g.id in input.targets) || Math.abs(sum - 100) > 0.5) return [];
    const worst = [...plan.goals].sort((a, b) => Math.abs(b.currentPercent - b.targetPercent) - Math.abs(a.currentPercent - a.targetPercent))[0];
    const drift = worst ? Math.abs(worst.currentPercent - worst.targetPercent) : 0;
    if (drift < GOAL_FLOW_DRIFT_POINTS) return [];
    const open = plan.moves;
    if (open.length === 0) return [];
    const total = open.reduce((s, m) => s + m.amount, 0);
    const names = open.slice(0, 2).map(m => `${m.from.name} → ${m.to.name} ${eur0(m.amount)}`).join(', ');
    return [{
        key: 'goal-flows', kind: 'goal-flows', urgency: 'due', view: 'fundRelocation',
        requests: open.map(goalFlowMoveToRequest),
        title: 'Rebalance between portfolios (Buckets targets)',
        detail: `${worst.id === LIQUIDITY_LEVEL_ID ? 'Liquidity' : worst.title} is at ${worst.currentPercent.toFixed(1)}% against ${worst.targetPercent.toFixed(1)}% · ${open.length} move${open.length === 1 ? '' : 's'}, ${eur0(total)}: ${names}${open.length > 2 ? '…' : ''}`,
    }];
};

/** Moves sitting in the Capital Allocation queue, not executed yet. */
export const detectRelocationQueue = (input: { queue: RelocationRequest[]; portfolios: Portfolio[] }): OperationTodo[] => {
    if (input.queue.length === 0) return [];
    const name = (e: RelocationRequest['from']) => e.kind === 'portfolio'
        ? input.portfolios.find(p => p.id === e.portfolioId)?.name ?? 'portfolio'
        : e.kind === 'cash' ? 'Cash' : 'Spend';
    const total = input.queue.reduce((s, r) => s + r.netAmount, 0);
    return [{
        key: 'relocation-queue', kind: 'relocation-queue', urgency: 'due', view: 'fundRelocation',
        title: `Execute ${input.queue.length} queued move${input.queue.length === 1 ? '' : 's'} in Capital Allocation`,
        detail: `${eur0(total)} · ${input.queue.slice(0, 3).map(r => `${name(r.from)} → ${name(r.to)}`).join(', ')}${input.queue.length > 3 ? '…' : ''} · sell → wire → buy, then mark as executed (the Buckets split is checked again afterwards)`,
    }];
};

/**
 * Amount-mode portfolios (capex matching): the cash set on the portfolio,
 * capped to what its brokers hold for it, buys toward the € targets nearest
 * due date first, never sells.
 */
export const detectCapexMatching = (input: {
    portfolios: Portfolio[];
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    brokers: Broker[];
    goals: YnabGoal[];
    allocations: YnabGoalAllocation[];
    virtualBonds: VirtualBond[];
    now: Date;
}): OperationTodo[] => {
    const brokers = input.brokers.map(realCashAllocations);
    return input.portfolios.filter(p => p.targetMode === 'amount').flatMap(portfolio => {
        const rows = resolveAmountTargets(portfolio, input.allocations, input.goals, input.virtualBonds);
        if (rows.length === 0) return [];
        const txs = input.transactions.filter(t => t.portfolioId === portfolio.id);
        const { assets } = calculateAssets(txs, input.assetSettings, input.marketData);
        const units = amountTargetUnits({ portfolio, rows, assets, assetSettings: input.assetSettings, marketData: input.marketData });
        const preferred = brokers.find(b => b.id === portfolio.preferredBrokerId);
        const realCash = brokers.filter(b => !preferred || b.id === preferred.id)
            .reduce((sum, b) => sum + (b.liquidityAllocations?.[portfolio.id] || 0), 0);
        const budget = Math.max(0, Math.min(portfolio.liquidity || 0, realCash));
        const plan = planAmountBuys(units.map(u => u.unit), budget);
        if (plan.totalGap <= 0.5) return [];
        const orders = budget > 0
            ? amountTargetOrders({ portfolio, units, plan, portfolioTransactions: txs, date: isoDay(input.now), brokerId: portfolio.preferredBrokerId })
            : [];
        const nearest = rows.map(r => r.dueDate).filter((d): d is string => !!d).sort()[0];
        if (orders.length > 0) return [{
            key: `capex-match:${portfolio.id}`, kind: 'capex-match', portfolioId: portfolio.id, orders, dueDate: nearest,
            urgency: 'due', title: `Fund the € targets of ${portfolio.name}`,
            detail: `${eur0(plan.totalGap)} still missing · ${eur0(plan.spent)} of ${eur0(budget)} cash buys ${orders.length} order${orders.length === 1 ? '' : 's'}, nearest due date first`,
        } as OperationTodo];
        // Gaps the cash cannot reach: say what it takes, nothing to buy yet.
        if (plan.required <= 0.5) return [];
        return [{
            key: `capex-match:${portfolio.id}`, kind: 'capex-match', portfolioId: portfolio.id, dueDate: nearest,
            urgency: 'info', view: 'dashboard', title: `Add cash to ${portfolio.name} for its € targets`,
            detail: `${eur0(plan.totalGap)} missing; ${eur0(plan.required - plan.spent)} more cash buys the next lots (${eur0(budget)} available for it now)`,
        } as OperationTodo];
    });
};

/** Free cash on a broker with no minimum set: not earmarked to any portfolio. */
export const detectFreeBrokerCash = (input: { brokers: Broker[]; reserveAllocatedCash: boolean }): OperationTodo[] =>
    input.brokers.flatMap(b => {
        const st = brokerLiquidityStatus(b, 0, input.reserveAllocatedCash);
        // A broker with a minimum is already handled by detectBrokerCash.
        if (st.targetValue > 0) return [];
        const free = st.liquidity - st.allocatedReserve;
        if (free < BROKER_CASH_TOLERANCE) return [];
        // With the allocated cash reserved detectBrokerCash already saw it (hasReserve).
        if (st.hasReserve) return [];
        return [{
            key: `broker-cash:${b.id}`, kind: 'broker-cash', brokerId: b.id, amount: free, urgency: 'info',
            title: `You can invest ${eur0(free)} from ${b.name}`,
            detail: `${eur0(st.liquidity)} of cash, ${eur0(st.allocatedReserve)} allocated to portfolios, no minimum set · invest it in a portfolio, or move it`,
        } as OperationTodo];
    });

/**
 * Held tickers whose day-by-day history (Performance) is behind: never
 * fetched, or nothing newer than HISTORY_MAX_AGE_DAYS. Update Prices appends
 * today's point, except on clean-price bond series, which only a history
 * update refreshes.
 */
export const detectPriceHistory = (input: {
    tickers: string[];
    history: PriceHistoryMap;
    assetSettings: AssetDefinition[];
    now: Date;
}): OperationTodo[] => {
    const stale = input.tickers.filter(t => {
        // CPRAM has no history endpoint: only snapshots, nothing to update.
        if (input.assetSettings.find(a => a.ticker.toUpperCase() === t.toUpperCase())?.source === 'CPRAM') return false;
        const h = input.history[t.toUpperCase()] ?? input.history[t];
        if (!h || h.points.length === 0) return true;
        const last = [h.points[h.points.length - 1][0], h.lastHistoryFetch].filter(Boolean).sort().pop();
        return ageDays(last, input.now) > HISTORY_MAX_AGE_DAYS;
    });
    if (stale.length === 0) return [];
    return [{
        key: 'price-history', kind: 'price-history', urgency: 'info',
        title: 'Update the price history',
        detail: `${stale.length} ticker${stale.length === 1 ? '' : 's'} with no history newer than ${HISTORY_MAX_AGE_DAYS} days (Performance): ${stale.slice(0, 4).join(', ')}${stale.length > 4 ? '…' : ''}`,
    }];
};

/**
 * Bonds with a known maturity: past it, the redemption is to be registered
 * (a Sell at par, which credits the broker); within the notice, where the
 * money goes is to be planned.
 */
export const detectBondMaturities = (input: {
    portfolios: Portfolio[];
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    now: Date;
}): OperationTodo[] => {
    const today = isoDay(input.now);
    const notice = isoDay(new Date(input.now.getTime() + BOND_MATURITY_NOTICE_DAYS * DAY));
    const dated = input.assetSettings.filter(a => a.maturityDate && !isVirtualBondTicker(a.ticker) && a.maturityDate.slice(0, 10) <= notice);
    if (dated.length === 0) return [];
    return dated.flatMap(def => {
        const maturity = def.maturityDate!.slice(0, 10);
        const ticker = def.ticker;
        const label = def.label || ticker;
        const holders = input.portfolios.flatMap(p => {
            const txs = input.transactions.filter(t => t.portfolioId === p.id && t.ticker.toUpperCase() === ticker.toUpperCase());
            if (txs.length === 0) return [];
            const asset = calculateAssets(txs, input.assetSettings, input.marketData).assets.find(a => a.ticker.toUpperCase() === ticker.toUpperCase());
            if (!asset || asset.quantity <= 0) return [];
            // Quantity left per broker: each sells where it is held.
            const byBroker = new Map<string | undefined, number>();
            txs.forEach(t => byBroker.set(t.brokerId, (byBroker.get(t.brokerId) ?? 0) + (t.direction === 'Sell' ? -1 : 1) * t.amount));
            return [...byBroker.entries()].filter(([, q]) => q > 1e-6).map(([brokerId, quantity]) => ({ portfolio: p, brokerId, quantity, price: asset.currentPrice }));
        });
        if (holders.length === 0) return [];
        // MOT bonds are quoted per 100 of nominal; a price below 5 is per 1.
        const par = (holders[0].price || input.marketData[ticker.toUpperCase()]?.price || 100) >= 5 ? 100 : 1;
        const value = holders.reduce((s, h) => s + h.quantity * par, 0);
        const where = [...new Set(holders.map(h => h.portfolio.name))].join(', ');
        if (maturity <= today) {
            const orders: Transaction[] = holders.map(h => ({
                id: `auto-redeem-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                portfolioId: h.portfolio.id, ticker, date: maturity, amount: h.quantity, price: par, direction: 'Sell', brokerId: h.brokerId,
            } as Transaction));
            return [{
                key: `bond-maturity:${ticker}`, kind: 'bond-maturity', dueDate: maturity, orders, urgency: 'overdue',
                title: `Register the redemption of ${label}`,
                detail: `matured on ${maturity} · ${eur0(value)} at par back to the broker (${where}); then reinvest it`,
            } as OperationTodo];
        }
        return [{
            key: `bond-maturity:${ticker}:soon`, kind: 'bond-maturity', dueDate: maturity, urgency: 'info',
            title: `${label} matures on ${maturity}`,
            detail: `${eur0(value)} at par back in ${where} · plan where the money goes (a capex it pays, or the next bond)`,
        } as OperationTodo];
    });
};

/**
 * Free-buy promotions are entered month by month: a broker that had a list
 * in one of the last three months and has none for this one is a reminder.
 */
export const detectFreeBuyPromos = (input: { periods: FreeCommissionPeriod[]; brokers: Broker[]; now: Date }): OperationTodo[] => {
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const current = key(input.now);
    const recent = [1, 2, 3].map(n => key(new Date(input.now.getFullYear(), input.now.getMonth() - n, 1)));
    const missing = input.brokers.filter(b =>
        input.periods.some(p => p.brokerId === b.id && recent.includes(p.monthKey))
        && !input.periods.some(p => p.brokerId === b.id && p.monthKey === current));
    if (missing.length === 0) return [];
    return [{
        key: `free-buy:${current}`, kind: 'free-buy', urgency: 'info', view: 'settings',
        title: "Enter this month's free-buy lists",
        detail: `${missing.map(b => b.name).join(', ')}: a list in the last months, none for ${current} yet (Settings → Free Buy Promotions)`,
    }];
};

/**
 * Capex due soon whose money is not ready: it counts on selling liquid
 * assets (the maturity ladder's 'selling'), or the portfolios cannot provide
 * it in time ('missing').
 */
export const detectCapexSelling = (input: { ladder: MaturityLadder; now: Date }): OperationTodo[] => {
    const today = isoDay(input.now);
    const horizon = isoDay(new Date(input.now.getTime() + CAPEX_SELL_NOTICE_DAYS * DAY));
    return [...input.ladder.goals.values()].flatMap(gl => {
        if (!gl.date || gl.date > horizon) return [];
        const selling = gl.fromSelling.reduce((s, p) => s + p.amount, 0);
        if (gl.missing > 0.5) return [{
            key: `capex-sell:${gl.goalId}`, kind: 'capex-sell', goalId: gl.goalId, dueDate: gl.date, view: 'summary',
            urgency: gl.date < today ? 'overdue' : 'due',
            title: `${gl.name}: ${eur0(gl.missing)} not available by ${gl.date}`,
            detail: `${gl.unassigned > 0.5 ? `${eur0(gl.unassigned)} not allocated to any portfolio · ` : ''}what the portfolios hold for it cannot be ready in time`,
        } as OperationTodo];
        if (selling > 0.5) return [{
            key: `capex-sell:${gl.goalId}`, kind: 'capex-sell', goalId: gl.goalId, dueDate: gl.date, view: 'summary',
            urgency: gl.date < today ? 'overdue' : 'due',
            title: `Sell to pay ${gl.name} by ${gl.date}`,
            detail: `${eur0(selling)} from ${gl.fromSelling.slice(0, 3).map(p => p.label).join(', ')}${gl.fromSelling.length > 3 ? '…' : ''} (no bond maturing in time covers it)`,
        } as OperationTodo];
        return [];
    });
};

// ── Records ─────────────────────────────────────────────────────────

/** The to-dos left once snoozed and skipped keys are taken out. */
export const visibleTodos = (todos: OperationTodo[], records: OperationRecord[], now: Date): OperationTodo[] => {
    const hidden = new Set(records
        .filter(r => r.status === 'skipped' || (r.status === 'snoozed' && !!r.until && new Date(r.until) > now))
        .map(r => r.key));
    const rank: Record<OperationUrgency, number> = { overdue: 0, due: 1, info: 2 };
    return todos.filter(t => !hidden.has(t.key))
        .sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
};

/** Newest first, capped: the page shows history, it is not a ledger. */
export const MAX_OPERATION_RECORDS = 500;
export const addOperationRecord = (records: OperationRecord[], record: OperationRecord): OperationRecord[] => {
    // A new snooze or skip of a key replaces the previous one.
    const rest = record.status === 'done' ? records : records.filter(r => !(r.key === record.key && r.status !== 'done'));
    return [record, ...rest].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_OPERATION_RECORDS);
};

const KINDS = new Set<OperationKind>([
    'prices', 'liquidity', 'broker-cash', 'pac', 'rebalance', 'capex-notes', 'capex-bond', 'virtual-bond', 'ynab-writeback', 'ynab-revalue', 'capex-sync', 'backup',
    'goal-flows', 'relocation-queue', 'capex-match', 'price-history', 'bond-maturity', 'free-buy', 'capex-sell',
]);

export function normalizeOperations(raw: unknown): OperationRecord[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is OperationRecord => !!r && typeof r === 'object'
        && typeof r.id === 'string' && typeof r.key === 'string' && KINDS.has(r.kind)
        && (r.status === 'done' || r.status === 'skipped' || r.status === 'snoozed') && typeof r.at === 'string');
}
