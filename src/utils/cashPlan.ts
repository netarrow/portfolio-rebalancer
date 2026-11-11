/**
 * The cash plan: one answer, per account, to "what is this cash for".
 *
 * Every euro on an account falls in exactly one layer, filled in this order:
 *
 *  1. operating   — day-to-day money (Expense Planning's operating cash);
 *  2. due-capex   — cash of the planned capex due within the horizon;
 *  3. set-aside   — cash set aside for dated expenses that stays cash: a
 *                   sinking fund, a capex with nothing invested, unmapped money;
 *  4. emergency   — emergency-fund cash, when no fund portfolio is configured;
 *  5. in-transit  — cash that is only waiting here: bound for the portfolios
 *                   covering its capex, for the fund portfolios, or to invest;
 *  6. free        — what no purpose claims.
 *
 * Layers 1–4 are what the account has to HOLD: the broker's linked minimum.
 * The liquidity TARGET of the whole wealth is that same hold over every
 * account, plus the cash that still has to come in for the capex due soon.
 * Layers 5–6 are what can leave: the same figures every "you can invest"
 * reads. Nothing here is computed twice: the amounts are the coverage
 * report's, only sorted by what has to happen to them.
 *
 * The moves cross the three questions — what to keep, what to move, what to
 * cover — so they never contradict each other: an account that is short is
 * topped up from the free cash of another before anything is raised, and
 * only what is left free after that is proposed for investing.
 */
import type { AccountCoverage, CoverageReport } from './ynabCoverage';
import type { CapexLiquidityItem } from './expensePlanningTargets';

export type CashLayerKind = 'operating' | 'due-capex' | 'set-aside' | 'emergency' | 'in-transit' | 'free';

export const CASH_LAYER_ORDER: CashLayerKind[] = ['operating', 'due-capex', 'set-aside', 'emergency', 'in-transit', 'free'];

/** Why a euro in transit leaves the account. */
export type CashTransitReason = 'capex' | 'fund' | 'invest';

export interface CashLayerItem {
    /** Category (or planned capex) id. */
    id: string;
    name: string;
    amount: number;
    /** In-transit only: why it leaves, and the portfolios it is bound for (empty = to be chosen). */
    reason?: CashTransitReason;
    portfolioIds?: string[];
}

export interface CashLayer {
    kind: CashLayerKind;
    /** What the layer asks for. */
    amount: number;
    /** Of which, what the account's liquidity reaches, layers filled in order. */
    covered: number;
    short: number;
    /** Has to stay on the account (layers 1–4). */
    hold: boolean;
    items: CashLayerItem[];
}

export interface AccountCashPlan {
    brokerId: string;
    brokerName: string;
    liquidity: number;
    layers: CashLayer[];
    /** Σ of the layers to hold: the account's minimum. */
    hold: number;
    /** Σ of the cash only waiting here. */
    transit: number;
    /** max(0, hold − liquidity). */
    short: number;
    /** Liquidity above the hold: in transit + free. */
    movable: number;
    /** Liquidity no purpose claims. */
    free: number;
    /** Still to come in for the capex due soon paid from here: back from investments. */
    toRecover: number;
    /** …and what neither their cash nor their investments cover. */
    missing: number;
}

export type CashMoveKind =
    | 'wire'      // free cash of one account tops up another
    | 'raise'     // nothing free covers it: to deposit (income, a sale)
    | 'sell'      // a capex due soon: its investments back to cash
    | 'place'     // cash in transit to the portfolios it is bound for
    | 'invest';   // free cash left over

export interface CashMove {
    kind: CashMoveKind;
    amount: number;
    fromBrokerId?: string;
    toBrokerId?: string;
    /** 'place': destination portfolios; empty = to be chosen. */
    portfolioIds?: string[];
    /** What it is for, in a few words. */
    reason: string;
}

export interface CashPlan {
    accounts: AccountCashPlan[];
    totals: {
        liquidity: number;
        hold: number;
        transit: number;
        free: number;
        short: number;
        /** Per layer, what is asked for over every account. */
        byLayer: Record<CashLayerKind, number>;
    };
    /** Cash to come in for the capex due soon: investments to sell + what is missing. */
    incoming: number;
    /** Cash of capex held as cash that sits on no account of the plan. */
    unlocatedCapexCash: number;
    /** The liquidity target: hold + incoming + unlocated capex cash. */
    target: number;
    moves: CashMove[];
}

const round = (x: number) => Math.round(x * 100) / 100;
const EPS = 0.005;

export interface AccountCashPlanInput {
    report: CoverageReport;
    /** Portfolios counted as emergency fund: with any, fund cash on an account is in transit to them. */
    fundPortfolioIds: string[];
    /** Active planned capex (ids): only their allocations make cash "bound for a portfolio". */
    activeGoalIds: Set<string>;
}

/** The layers of each account. Needs the coverage report only. */
export const buildAccountCashPlans = (input: AccountCashPlanInput): AccountCashPlan[] => {
    const { report, fundPortfolioIds, activeGoalIds } = input;
    const positionById = new Map(report.positions.map(p => [p.categoryId, p]));
    const item = (id: string): CashLayerItem => {
        const p = positionById.get(id);
        return { id, name: p?.name ?? id, amount: round(Math.max(0, p?.available ?? 0)) };
    };

    return report.accounts.map((a: AccountCoverage) => {
        const due = report.upcoming.filter(u => u.brokerId === a.brokerId && u.cash > EPS)
            .map(u => ({ id: u.categoryId, name: u.name, amount: u.cash }));

        // Set aside: cash bound for the portfolios covering its capex is only
        // waiting here; everything else stays.
        const stay: CashLayerItem[] = [];
        const transit: CashLayerItem[] = [];
        a.earmarkedCategoryIds.forEach(id => {
            const p = positionById.get(id);
            const portfolioIds = activeGoalIds.has(id)
                ? [...new Set((p?.allocations ?? []).filter(x => x.amount > 0 && x.portfolioId).map(x => x.portfolioId))]
                : [];
            if (portfolioIds.length > 0) transit.push({ ...item(id), reason: 'capex', portfolioIds });
            else stay.push(item(id));
        });

        // Emergency fund: with fund portfolios it belongs there, else it is held.
        const fundCash = report.positions
            .filter(p => p.cashBrokerId === a.brokerId && p.emergencyFund && p.available > EPS)
            .sort((x, y) => y.available - x.available);
        const emergency: CashLayerItem[] = [];
        fundCash.forEach(p => {
            if (fundPortfolioIds.length > 0) {
                transit.push({ ...item(p.categoryId), reason: 'fund', portfolioIds: p.fundDestinationId ? [p.fundDestinationId] : [...fundPortfolioIds] });
            } else emergency.push(item(p.categoryId));
        });

        a.toInvestCategoryIds.forEach(id => transit.push({ ...item(id), reason: 'invest', portfolioIds: [] }));

        const sum = (xs: { amount: number }[]) => round(xs.reduce((s, x) => s + x.amount, 0));
        const asked: { kind: CashLayerKind; amount: number; hold: boolean; items: CashLayerItem[] }[] = [
            { kind: 'operating', amount: a.operatingCash, hold: true, items: [] },
            { kind: 'due-capex', amount: sum(due), hold: true, items: due },
            { kind: 'set-aside', amount: sum(stay), hold: true, items: stay },
            { kind: 'emergency', amount: sum(emergency), hold: true, items: emergency },
            { kind: 'in-transit', amount: sum(transit), hold: false, items: transit },
        ];
        let left = Math.max(0, a.liquidity);
        const layers: CashLayer[] = asked.map(l => {
            const covered = round(Math.min(left, l.amount));
            left = round(left - covered);
            return { ...l, amount: round(l.amount), covered, short: round(l.amount - covered) };
        });
        layers.push({ kind: 'free', amount: left, covered: left, short: 0, hold: false, items: [] });

        const hold = round(layers.filter(l => l.hold).reduce((s, l) => s + l.amount, 0));
        const dueHere = report.upcoming.filter(u => u.brokerId === a.brokerId);
        return {
            brokerId: a.brokerId,
            brokerName: a.brokerName,
            liquidity: a.liquidity,
            layers,
            hold,
            transit: layers[4].amount,
            short: round(Math.max(0, hold - a.liquidity)),
            movable: round(Math.max(0, a.liquidity - hold)),
            free: left,
            toRecover: round(dueHere.reduce((s, u) => s + u.toRecover, 0)),
            missing: round(dueHere.reduce((s, u) => s + u.stillMissing, 0)),
        };
    });
};

export interface CashPlanInput extends AccountCashPlanInput {
    /**
     * Capex held as cash, as Expense Planning routes them (`capexRouting`):
     * with the maturity ladder, what comes back in time and what is missing
     * for the ones due soon. Absent = read off the coverage report.
     */
    capexLiquidity?: CapexLiquidityItem[];
}

export const buildCashPlan = (input: CashPlanInput): CashPlan => {
    const accounts = buildAccountCashPlans(input);
    const { report } = input;
    const byId = new Map(accounts.map(a => [a.brokerId, a]));
    const nameOf = (id?: string) => (id && byId.get(id)?.brokerName) || 'an account';

    // ── Cash still to come in for the capex due soon ───────────────────
    // Per capex: what to sell back, what nothing covers, the account paying it.
    const upcomingById = new Map(report.upcoming.map(u => [u.categoryId, u]));
    const dueItems: { id: string; name: string; divest: number; missing: number; brokerId?: string }[] = input.capexLiquidity
        ? input.capexLiquidity.filter(c => c.reason === 'due-soon').map(c => ({
            id: c.goalId, name: c.name, divest: c.divest, missing: c.missing ?? 0, brokerId: upcomingById.get(c.goalId)?.brokerId,
        }))
        : report.upcoming.map(u => ({ id: u.categoryId, name: u.name, divest: u.toRecover, missing: u.stillMissing, brokerId: u.brokerId }));
    const incoming = round(dueItems.reduce((s, d) => s + d.divest + d.missing, 0));

    // Capex cash Expense Planning knows of but no account of the plan holds
    // (its category is on no account): it is liquidity all the same.
    const located = new Set<string>();
    accounts.forEach(a => a.layers.forEach(l => l.items.forEach(i => located.add(i.id))));
    const unlocatedCapexCash = round((input.capexLiquidity ?? [])
        .filter(c => !located.has(c.goalId))
        .reduce((s, c) => s + c.cash, 0));

    // ── Moves ──────────────────────────────────────────────────────────
    const moves: CashMove[] = [];
    const spare = new Map(accounts.map(a => [a.brokerId, a.free]));
    const takeFrom = (brokerId: string, amount: number) => {
        const used = Math.min(spare.get(brokerId) ?? 0, amount);
        spare.set(brokerId, round((spare.get(brokerId) ?? 0) - used));
        return used;
    };

    // What each account lacks: its hold, and the capex due there nothing covers.
    const needs: { brokerId?: string; amount: number; reason: string }[] = [];
    accounts.filter(a => a.short > EPS).forEach(a => needs.push({ brokerId: a.brokerId, amount: a.short, reason: `cash ${a.brokerName} has to hold` }));
    dueItems.filter(d => d.missing > EPS).forEach(d => needs.push({ brokerId: d.brokerId, amount: d.missing, reason: `${d.name}: not covered in time` }));
    needs.sort((x, y) => y.amount - x.amount).forEach(need => {
        let left = need.amount;
        // Free cash already on the paying account needs no move at all.
        if (need.brokerId) left = round(left - takeFrom(need.brokerId, left));
        const donors = [...spare.entries()].filter(([id, v]) => id !== need.brokerId && v > EPS).sort((x, y) => y[1] - x[1]);
        for (const [id] of donors) {
            if (left <= EPS) break;
            const used = round(takeFrom(id, left));
            if (used <= EPS) continue;
            left = round(left - used);
            moves.push({ kind: 'wire', amount: used, fromBrokerId: id, toBrokerId: need.brokerId, reason: need.reason });
        }
        if (left > EPS) moves.push({ kind: 'raise', amount: left, toBrokerId: need.brokerId, reason: need.reason });
    });

    dueItems.filter(d => d.divest > EPS).forEach(d => moves.push({
        kind: 'sell', amount: round(d.divest), toBrokerId: d.brokerId, reason: `${d.name}: back from its investments`,
    }));

    // In transit: only what the account's liquidity actually reaches.
    accounts.forEach(a => {
        const layer = a.layers.find(l => l.kind === 'in-transit')!;
        let reach = layer.covered;
        layer.items.forEach(i => {
            const amount = round(Math.min(reach, i.amount));
            reach = round(reach - amount);
            if (amount <= EPS) return;
            moves.push({
                kind: 'place', amount, fromBrokerId: a.brokerId, portfolioIds: i.portfolioIds ?? [],
                reason: i.reason === 'fund' ? `${i.name}: emergency fund` : i.reason === 'capex' ? `${i.name}: to the portfolio covering it` : `${i.name}: to invest`,
            });
        });
    });

    [...spare.entries()].filter(([, v]) => v > EPS).forEach(([id, v]) => moves.push({
        kind: 'invest', amount: round(v), fromBrokerId: id, reason: `free on ${nameOf(id)}`,
    }));

    const total = (f: (a: AccountCashPlan) => number) => round(accounts.reduce((s, a) => s + f(a), 0));
    const byLayer = Object.fromEntries(CASH_LAYER_ORDER.map(kind => [
        kind, total(a => a.layers.find(l => l.kind === kind)?.amount ?? 0),
    ])) as Record<CashLayerKind, number>;
    const hold = total(a => a.hold);

    return {
        accounts,
        totals: { liquidity: total(a => a.liquidity), hold, transit: total(a => a.transit), free: total(a => a.free), short: total(a => a.short), byLayer },
        incoming,
        unlocatedCapexCash,
        target: round(hold + incoming + unlocatedCapexCash),
        moves,
    };
};
