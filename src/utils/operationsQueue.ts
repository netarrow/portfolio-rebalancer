import type {
    AssetDefinition, Broker, OperationKind, OperationRecord, PacExecution, PacPlan, Portfolio, Transaction,
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
    /** Rebalance: the orders it would create. */
    orders?: Transaction[];
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
        if (deployable > 0) {
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
        const m = capexBondMatch(g, input.allocations, input.assetSettings, input.virtualBonds);
        if (!m.needsSearch) return;
        out.push({
            key: `capex-bond:${g.id}`, kind: 'capex-bond', goalId: g.id, dueDate: g.targetDate?.slice(0, 10),
            urgency: g.targetDate && g.targetDate.slice(0, 10) < today ? 'overdue' : 'info',
            title: `Find a bond for ${g.name}`,
            detail: `${eur0(m.toMatch)} invested in the portfolio as a whole, not yet tied to a product maturing before ${g.targetDate?.slice(0, 10)}`,
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

const KINDS = new Set<OperationKind>(['prices', 'liquidity', 'broker-cash', 'pac', 'rebalance', 'capex-notes', 'capex-bond', 'virtual-bond', 'ynab-writeback', 'ynab-revalue', 'capex-sync', 'backup']);

export function normalizeOperations(raw: unknown): OperationRecord[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is OperationRecord => !!r && typeof r === 'object'
        && typeof r.id === 'string' && typeof r.key === 'string' && KINDS.has(r.kind)
        && (r.status === 'done' || r.status === 'skipped' || r.status === 'snoozed') && typeof r.at === 'string');
}
