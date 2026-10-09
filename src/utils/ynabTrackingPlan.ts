/**
 * Off-budget map: from one YNAB tracking account per broker to one per purpose.
 *
 * Today the invested money sits in YNAB as one off-budget account per broker
 * ("Broker X Investments" …). What the budget wants to show is what that money is
 * FOR, so the same value is re-cut into:
 *   🎯 one account per YNAB goal (or category) that investments cover;
 *   💼 one per portfolio — a parent and its children merged into one — holding
 *      whatever no goal claims (long-term money included);
 *   🏦 the same, for a portfolio held only at illiquid brokers (pension funds);
 *   💵 the cash of a broker whose cash lives in YNAB off-budget, mixed with its
 *      securities, because it has no on-budget account of its own.
 *
 * This module is pure and read-only: it computes the expected balance of every
 * destination and the transfers that would move each broker account there. The
 * caller decides what, if anything, is ever written.
 *
 * How a goal's share ("quota") of the holdings is worked out, from the YNAB
 * goal allocations as they stand:
 *  - an allocation covers `coveredBy(a)` € — its own amount, or for a row of an
 *    amount-mode portfolio its share of what the row holds;
 *  - pinned to an asset or a market group, that value is taken from the
 *    holdings of those tickers in the allocation's portfolio, pro rata to what
 *    each holding is worth, whichever broker holds it;
 *  - on the portfolio as a whole, from every holding of the portfolio, pro rata;
 *  - a holding never gives away more than it is worth: when its claims exceed
 *    it they are scaled down together, and the plan says so.
 * The share is then expressed in units of each holding (quantity and cost
 * basis), so the goal's value follows the market from here on.
 */
import type {
    AssetDefinition,
    Broker,
    Portfolio,
    Transaction,
    VirtualBond,
    YnabAccountMappings,
    YnabGoal,
    YnabGoalAllocation,
    YnabTrackingConfig,
} from '../types';
import { isVirtualBondTicker } from '../types';
import { calculateAssets, isCashTicker } from './portfolioCalculations';
import { resolveGroups } from './allocationGroups';
import { buildPortfolioTree } from './portfolioGroups';
import { pinnedAllocationCoverage } from './goalAllocationCoverage';
import { capitalGainsRate, resolveAssetClass } from './rebalanceCosts';
import { checkYnabGuardBudget, checkYnabWriteTarget } from './ynabWriteGuard';

type MarketData = Record<string, { price: number; lastUpdated: string }>;

/** Account-name prefixes, so each kind of account reads at a glance in YNAB's sidebar. */
export const TRACKING_PREFIX = {
    goal: '🎯',
    portfolio: '💼',
    pension: '🏦',
    'broker-cash': '💵',
} as const;

export type TrackingDestinationKind = keyof typeof TRACKING_PREFIX;

export const goalDestinationKey = (goalId: string) => `goal:${goalId}`;
export const portfolioDestinationKey = (rootPortfolioId: string) => `portfolio:${rootPortfolioId}`;
export const cashDestinationKey = (brokerId: string) => `cash:${brokerId}`;

/** A YNAB account as the plan needs it: identity, kind and balances in €. */
export interface TrackingAccountRef {
    id: string;
    name: string;
    onBudget: boolean;
    balance: number;          // working balance (cleared + uncleared)
    clearedBalance: number;
}

/** One position: a ticker held in one portfolio at one broker. */
export interface TrackingHolding {
    key: string;              // `${portfolioId}|${brokerId}|${ticker}`
    portfolioId: string;
    brokerId: string;
    ticker: string;
    label: string;
    quantity: number;
    price: number;
    value: number;
    cost: number;             // quantity × average price
    taxRate: number;          // capital-gains rate of its asset class
}

/** A slice of a holding attributed to one destination. */
export interface TrackingPiece {
    holdingKey: string;
    brokerId: string;
    ticker: string;
    label: string;
    quantity: number;
    value: number;
    cost: number;
    latentTax: number;        // max(0, value − cost) × rate
}

export interface TrackingDestination {
    key: string;
    kind: TrackingDestinationKind;
    /** Name the account would get: prefix + goal / portfolio / broker name. */
    accountName: string;
    baseName: string;
    goalId?: string;
    portfolioId?: string;     // root of the parent/child group
    memberNames?: string[];   // portfolios merged into it, root first
    brokerId?: string;
    value: number;            // gross market value (or cash)
    cost: number;
    latentTax: number;
    net: number;              // value − latentTax
    pieces: TrackingPiece[];
    accountId?: string;
    account?: TrackingAccountRef;
    /**
     * expected value − the linked account's working balance; when the account
     * is also a broker's source, its balance once the securities have left.
     */
    accountDifference?: number;
    /** The linked account is also a broker account the split moves money out of. */
    sharesSourceAccount?: boolean;
}

export type TrackingBrokerKind = 'A' | 'B';

export interface TrackingBroker {
    brokerId: string;
    name: string;
    /**
     * 'A' = its cash is an on-budget YNAB account (the one the liquidity sync
     * reads), so its off-budget account holds securities only. 'B' = no
     * on-budget account: its off-budget account holds cash and securities.
     */
    kind: TrackingBrokerKind;
    included: boolean;
    excludedBy?: 'family' | 'manual';
    illiquid: boolean;
    ownerId?: string;
    securities: number;
    /** Cash expected in its off-budget account — type B only, 0 otherwise. */
    cash: number;
    expected: number;         // securities + cash
    sourceAccountId?: string;
    sourceAccount?: TrackingAccountRef;
    /** expected − the source account's working balance: what a realignment would book. */
    realignment?: number;
}

export interface TrackingTransfer {
    toKey: string;
    amount: number;
    /** Destination is the source account itself: the money just stays. */
    staysInPlace: boolean;
}

export interface TrackingMigration {
    brokerId: string;
    sourceAccountId?: string;
    transfers: TrackingTransfer[];
    total: number;
}

export type TrackingWarningKind =
    | 'unbacked-allocation'   // pinned to something the portfolio does not hold
    | 'over-allocated'        // claims on a holding exceed what it is worth
    | 'excluded-broker-claim' // a goal's share sits at an excluded broker
    | 'no-broker'             // holdings with no broker on their transactions
    | 'missing-source'        // an included broker with holdings but no YNAB account
    | 'account-reused'        // one YNAB account linked to two different roles
    | 'account-on-budget'     // a source or destination that is not a tracking account
    | 'account-missing'       // a linked account is gone (closed/deleted)
    | 'guard'                 // the write guard does not allow this budget
    | 'account-not-allowed';  // a linked account is outside the write guard

export interface TrackingWarning {
    kind: TrackingWarningKind;
    message: string;
}

export interface TrackingPlan {
    holdings: TrackingHolding[];
    brokers: TrackingBroker[];
    destinations: TrackingDestination[];
    migrations: TrackingMigration[];
    totals: {
        securities: number;   // included holdings
        cash: number;         // included type-B cash
        destinations: number;
    };
    /** Destinations add up to securities + cash, to the cent. */
    balanced: boolean;
    warnings: TrackingWarning[];
}

export interface TrackingPlanInput {
    portfolios: Portfolio[];
    transactions: Transaction[];
    brokers: Broker[];
    assetSettings: AssetDefinition[];
    marketData: MarketData;
    goals: YnabGoal[];
    allocations: YnabGoalAllocation[];
    virtualBonds: VirtualBond[];
    /** Broker ↔ on-budget account links of the liquidity sync: they make a broker type A. */
    liquidityMappings: YnabAccountMappings;
    config: YnabTrackingConfig;
    /** Accounts of the primary budget, when loaded; balances are then compared. */
    accounts?: TrackingAccountRef[];
    /** Budget the accounts belong to (the primary one), checked against the write guard. */
    budgetId?: string;
}

export const NO_BROKER_ID = '';

const cents = (v: number): number => Math.round(v * 100) / 100;
const EPS = 0.005;

const sameTicker = (a: string, b: string): boolean =>
    isVirtualBondTicker(a) || isVirtualBondTicker(b) ? a === b : a.toUpperCase() === b.toUpperCase();

const stringRecord = (raw: unknown): Record<string, string> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
        .filter((e): e is [string, string] => !!e[0] && typeof e[1] === 'string' && e[1].length > 0));
};

/** Reads a stored or imported config, dropping anything malformed. */
export function normalizeYnabTrackingConfig(raw: unknown): YnabTrackingConfig {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const inclusion = obj.brokerInclusion && typeof obj.brokerInclusion === 'object' && !Array.isArray(obj.brokerInclusion)
        ? Object.fromEntries(Object.entries(obj.brokerInclusion as Record<string, unknown>).filter(([k, v]) => k && typeof v === 'boolean')) as Record<string, boolean>
        : {};
    const guardBudgetId = typeof obj.guardBudgetId === 'string' && obj.guardBudgetId ? obj.guardBudgetId : undefined;
    const guardAccountIds = guardBudgetId && Array.isArray(obj.guardAccountIds)
        ? [...new Set(obj.guardAccountIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        : [];
    return {
        brokerSources: stringRecord(obj.brokerSources),
        destinationAccounts: stringRecord(obj.destinationAccounts),
        ...(Object.keys(inclusion).length > 0 ? { brokerInclusion: inclusion } : {}),
        ...(guardBudgetId ? { guardBudgetId, guardAccountIds } : {}),
    };
}

/** Sets (or clears, with null) one entry of a record, returning a new record. */
export const withEntry = <T,>(record: Record<string, T> | undefined, key: string, value: T | null): Record<string, T> => {
    const next = { ...(record ?? {}) };
    if (value === null) delete next[key];
    else next[key] = value;
    return next;
};

/** Default inclusion: family brokers (the household's, e.g. a child's PAC) stay out. */
export const isBrokerIncluded = (broker: Broker | undefined, config: YnabTrackingConfig): { included: boolean; excludedBy?: 'family' | 'manual' } => {
    const forced = broker ? config.brokerInclusion?.[broker.id] : undefined;
    if (forced === true) return { included: true };
    if (forced === false) return { included: false, excludedBy: 'manual' };
    if (broker?.familyAsset) return { included: false, excludedBy: 'family' };
    return { included: true };
};

/** Every non-cash position, split by portfolio and broker. */
export function buildTrackingHoldings(input: Pick<TrackingPlanInput, 'transactions' | 'assetSettings' | 'marketData'>): TrackingHolding[] {
    const groups = new Map<string, Transaction[]>();
    for (const tx of input.transactions) {
        if (!tx.portfolioId || isCashTicker(tx.ticker)) continue;
        const k = `${tx.portfolioId}|${tx.brokerId ?? NO_BROKER_ID}`;
        const list = groups.get(k);
        if (list) list.push(tx); else groups.set(k, [tx]);
    }
    const out: TrackingHolding[] = [];
    for (const [k, txs] of groups) {
        const [portfolioId, brokerId] = k.split('|');
        const { assets } = calculateAssets(txs, input.assetSettings, input.marketData);
        for (const a of assets) {
            if (!(a.quantity > 1e-9) || !(a.currentValue > 0)) continue;
            out.push({
                key: `${portfolioId}|${brokerId}|${a.ticker}`,
                portfolioId,
                brokerId,
                ticker: a.ticker,
                label: a.label || a.ticker,
                quantity: a.quantity,
                price: a.currentPrice ?? (a.currentValue / a.quantity),
                value: a.currentValue,
                cost: a.quantity * a.averagePrice,
                taxRate: capitalGainsRate(resolveAssetClass(a, input.assetSettings)),
            });
        }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function buildTrackingPlan(input: TrackingPlanInput): TrackingPlan {
    const { portfolios, brokers, goals, allocations, config } = input;
    const warnings: TrackingWarning[] = [];
    const warn = (kind: TrackingWarningKind, message: string) => warnings.push({ kind, message });

    const brokerById = new Map(brokers.map(b => [b.id, b]));
    const portfolioById = new Map(portfolios.map(p => [p.id, p]));
    const goalById = new Map(goals.filter(g => !g.archived).map(g => [g.id, g]));
    const accountById = new Map((input.accounts ?? []).map(a => [a.id, a]));
    const brokerName = (id: string) => id === NO_BROKER_ID ? '(no broker)' : (brokerById.get(id)?.name ?? id);
    const portfolioName = (id: string) => portfolioById.get(id)?.name ?? id;

    const holdings = buildTrackingHoldings(input);
    const holdingByKey = new Map(holdings.map(h => [h.key, h]));

    // ── Goal claims on the holdings ──────────────────────────────────
    const coverage = pinnedAllocationCoverage({
        portfolios,
        transactions: input.transactions,
        assetSettings: input.assetSettings,
        marketData: input.marketData,
        allocations,
        goals,
        virtualBonds: input.virtualBonds,
    });
    // holdingKey -> goalId -> € claimed
    const claims = new Map<string, Map<string, number>>();
    const addClaim = (holdingKey: string, goalId: string, value: number) => {
        let byGoal = claims.get(holdingKey);
        if (!byGoal) { byGoal = new Map(); claims.set(holdingKey, byGoal); }
        byGoal.set(goalId, (byGoal.get(goalId) ?? 0) + value);
    };

    for (const a of allocations) {
        const goal = goalById.get(a.ynabGoalId);
        if (!goal) continue;
        const value = coverage.get(a.id) ?? a.amount;
        if (!(value > 0)) continue;
        const portfolio = portfolioById.get(a.portfolioId);
        let tickers: string[] | null = null;
        if (a.ticker) {
            const group = portfolio ? resolveGroups(portfolio).groupById[a.ticker] : undefined;
            tickers = group ? group.members : [a.ticker];
        }
        const eligible = holdings.filter(h =>
            h.portfolioId === a.portfolioId && (!tickers || tickers.some(t => sameTicker(t, h.ticker))));
        const total = eligible.reduce((s, h) => s + h.value, 0);
        if (!(total > 0)) {
            warn('unbacked-allocation',
                `"${goal.name}": ${cents(value)} € on ${portfolioName(a.portfolioId)}${a.ticker ? ` › ${a.ticker}` : ''} is not backed by any holding, so it is left out.`);
            continue;
        }
        eligible.forEach(h => addClaim(h.key, goal.id, value * (h.value / total)));
    }

    // A holding never gives away more than it is worth.
    for (const [holdingKey, byGoal] of claims) {
        const h = holdingByKey.get(holdingKey)!;
        const claimed = [...byGoal.values()].reduce((s, v) => s + v, 0);
        if (claimed > h.value + EPS) {
            const ratio = h.value / claimed;
            for (const [goalId, v] of byGoal) byGoal.set(goalId, v * ratio);
            warn('over-allocated',
                `${h.label} in ${portfolioName(h.portfolioId)} at ${brokerName(h.brokerId)} is worth ${cents(h.value)} € but goals claim ${cents(claimed)} €: every claim is scaled down by the same ratio.`);
        }
    }

    // ── Brokers ──────────────────────────────────────────────────────
    const brokerIdsWithHoldings = new Set(holdings.map(h => h.brokerId));
    const relevantBrokerIds = new Set<string>([
        ...brokerIdsWithHoldings,
        ...Object.keys(config.brokerSources).filter(id => brokerById.has(id)),
    ]);
    const trackingBrokers: TrackingBroker[] = [];
    const includedBroker = new Map<string, boolean>();
    for (const brokerId of relevantBrokerIds) {
        const broker = brokerById.get(brokerId);
        const { included, excludedBy } = isBrokerIncluded(broker, config);
        includedBroker.set(brokerId, included);
        const kind: TrackingBrokerKind = brokerId !== NO_BROKER_ID && input.liquidityMappings[brokerId] ? 'A' : 'B';
        const securities = holdings.filter(h => h.brokerId === brokerId).reduce((s, h) => s + h.value, 0);
        const cash = kind === 'B' && broker ? Math.max(0, broker.currentLiquidity ?? 0) : 0;
        const sourceAccountId = config.brokerSources[brokerId];
        const sourceAccount = sourceAccountId ? accountById.get(sourceAccountId) : undefined;
        trackingBrokers.push({
            brokerId,
            name: brokerName(brokerId),
            kind,
            included,
            excludedBy,
            illiquid: !!broker?.illiquid,
            ownerId: broker?.ownerId,
            securities: cents(securities),
            cash: cents(cash),
            expected: cents(securities + cash),
            sourceAccountId,
            sourceAccount,
            realignment: sourceAccount ? cents(securities + cash - sourceAccount.balance) : undefined,
        });
        if (brokerId === NO_BROKER_ID && securities > 0) {
            warn('no-broker', `${cents(securities)} € of holdings have no broker on their transactions: they cannot be traced to a YNAB account.`);
        }
        if (included && securities + cash > EPS && !sourceAccountId && brokerId !== NO_BROKER_ID) {
            warn('missing-source', `${brokerName(brokerId)} holds ${cents(securities + cash)} € but no YNAB off-budget account is linked to it yet.`);
        }
    }
    trackingBrokers.sort((a, b) => Number(b.included) - Number(a.included) || a.name.localeCompare(b.name));

    // ── Destinations ─────────────────────────────────────────────────
    const tree = buildPortfolioTree(portfolios);
    const rootOf = new Map<string, { root: Portfolio; members: Portfolio[] }>();
    tree.groups.forEach(g => g.members.forEach(m => rootOf.set(m.id, { root: g.parent, members: g.members })));
    tree.standalones.forEach(p => rootOf.set(p.id, { root: p, members: [p] }));

    const destinations = new Map<string, TrackingDestination>();
    const destination = (key: string, init: () => Omit<TrackingDestination, 'value' | 'cost' | 'latentTax' | 'net' | 'pieces'>) => {
        let d = destinations.get(key);
        if (!d) {
            d = { ...init(), value: 0, cost: 0, latentTax: 0, net: 0, pieces: [] };
            destinations.set(key, d);
        }
        return d;
    };
    const addPiece = (d: TrackingDestination, h: TrackingHolding, value: number) => {
        if (!(value > 1e-9)) return;
        const share = value / h.value;
        const cost = h.cost * share;
        const latentTax = Math.max(0, value - cost) * h.taxRate;
        d.pieces.push({
            holdingKey: h.key, brokerId: h.brokerId, ticker: h.ticker, label: h.label,
            quantity: h.quantity * share, value, cost, latentTax,
        });
        d.value += value;
        d.cost += cost;
        d.latentTax += latentTax;
    };

    // A portfolio bucket is "pension" when everything it holds sits at illiquid brokers.
    const bucketIlliquid = new Map<string, boolean>();
    for (const h of holdings) {
        if (!includedBroker.get(h.brokerId)) continue;
        const rootId = rootOf.get(h.portfolioId)?.root.id ?? h.portfolioId;
        const illiquid = !!brokerById.get(h.brokerId)?.illiquid;
        bucketIlliquid.set(rootId, (bucketIlliquid.get(rootId) ?? true) && illiquid);
    }

    const excludedClaims = new Map<string, number>(); // goalId -> €
    for (const h of holdings) {
        const byGoal = claims.get(h.key);
        if (!includedBroker.get(h.brokerId)) {
            byGoal?.forEach((v, goalId) => excludedClaims.set(goalId, (excludedClaims.get(goalId) ?? 0) + v));
            continue;
        }
        let claimed = 0;
        byGoal?.forEach((v, goalId) => {
            const goal = goalById.get(goalId)!;
            const d = destination(goalDestinationKey(goalId), () => ({
                key: goalDestinationKey(goalId),
                kind: 'goal',
                accountName: `${TRACKING_PREFIX.goal} ${goal.name}`,
                baseName: goal.name,
                goalId,
            }));
            addPiece(d, h, v);
            claimed += v;
        });
        const rest = h.value - claimed;
        if (rest > EPS) {
            const group = rootOf.get(h.portfolioId);
            const root = group?.root;
            const rootId = root?.id ?? h.portfolioId;
            const kind: TrackingDestinationKind = bucketIlliquid.get(rootId) ? 'pension' : 'portfolio';
            const d = destination(portfolioDestinationKey(rootId), () => ({
                key: portfolioDestinationKey(rootId),
                kind,
                accountName: `${TRACKING_PREFIX[kind]} ${root?.name ?? portfolioName(rootId)}`,
                baseName: root?.name ?? portfolioName(rootId),
                portfolioId: rootId,
                memberNames: (group?.members ?? []).map(m => m.name),
            }));
            addPiece(d, h, rest);
        }
    }
    excludedClaims.forEach((v, goalId) => {
        if (v > EPS) warn('excluded-broker-claim',
            `${cents(v)} € of "${goalById.get(goalId)?.name ?? goalId}" sit at excluded brokers and are left out of its account.`);
    });

    // Type-B cash stays at the broker, in an account of its own.
    for (const b of trackingBrokers) {
        if (!b.included || b.kind !== 'B' || !(b.cash > 0)) continue;
        const d = destination(cashDestinationKey(b.brokerId), () => ({
            key: cashDestinationKey(b.brokerId),
            kind: 'broker-cash',
            accountName: `${TRACKING_PREFIX['broker-cash']} ${b.name}`,
            baseName: b.name,
            brokerId: b.brokerId,
        }));
        d.value += b.cash;
        d.cost += b.cash;
    }

    // Goals with an account linked but nothing invested still get their row.
    for (const key of Object.keys(config.destinationAccounts)) {
        if (destinations.has(key) || !key.startsWith('goal:')) continue;
        const goal = goalById.get(key.slice('goal:'.length));
        if (!goal) continue;
        destination(key, () => ({
            key, kind: 'goal', accountName: `${TRACKING_PREFIX.goal} ${goal.name}`, baseName: goal.name, goalId: goal.id,
        }));
    }

    const kindOrder: Record<TrackingDestinationKind, number> = { goal: 0, portfolio: 1, pension: 2, 'broker-cash': 3 };
    const destinationList = [...destinations.values()].map(d => {
        const accountId = config.destinationAccounts[d.key];
        const account = accountId ? accountById.get(accountId) : undefined;
        const value = cents(d.value);
        const latentTax = cents(d.latentTax);
        return {
            ...d,
            value,
            cost: cents(d.cost),
            latentTax,
            net: cents(value - latentTax),
            pieces: d.pieces.sort((a, b) => b.value - a.value),
            accountId,
            account,
            accountDifference: account ? cents(value - account.balance) : undefined,
        };
    }).sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.baseName.localeCompare(b.baseName));

    // ── Migration: what leaves each broker account, and where to ─────
    const migrations: TrackingMigration[] = [];
    for (const b of trackingBrokers) {
        if (!b.included) continue;
        const byDest = new Map<string, number>();
        for (const d of destinationList) {
            for (const p of d.pieces) {
                if (p.brokerId === b.brokerId) byDest.set(d.key, (byDest.get(d.key) ?? 0) + p.value);
            }
            if (d.kind === 'broker-cash' && d.brokerId === b.brokerId) byDest.set(d.key, (byDest.get(d.key) ?? 0) + b.cash);
        }
        const transfers: TrackingTransfer[] = [...byDest.entries()]
            .map(([toKey, amount]) => ({
                toKey,
                amount: cents(amount),
                staysInPlace: !!b.sourceAccountId && config.destinationAccounts[toKey] === b.sourceAccountId,
            }))
            .filter(t => t.amount > 0)
            .sort((x, y) => y.amount - x.amount);
        if (transfers.length === 0) continue;
        migrations.push({
            brokerId: b.brokerId,
            sourceAccountId: b.sourceAccountId,
            transfers,
            total: cents(transfers.reduce((s, t) => s + t.amount, 0)),
        });
    }

    // A destination that is also a broker's own account (its cash, or a
    // pension fund left where it is) still holds that broker's securities
    // today: compare it with what it will hold once they have moved out.
    for (const d of destinationList) {
        if (!d.account) continue;
        const outflow = migrations
            .filter(m => m.sourceAccountId === d.accountId)
            .reduce((s, m) => s + m.transfers.filter(t => !t.staysInPlace).reduce((x, t) => x + t.amount, 0), 0);
        if (outflow > 0) {
            d.accountDifference = cents(d.value - (d.account.balance - outflow));
            d.sharesSourceAccount = true;
        }
    }

    // ── Account sanity: each YNAB account plays one role, off budget ─
    const roles = new Map<string, string[]>();
    const role = (accountId: string, label: string) => {
        const list = roles.get(accountId);
        if (list) list.push(label); else roles.set(accountId, [label]);
    };
    Object.entries(config.brokerSources).forEach(([brokerId, accountId]) => role(accountId, `source of ${brokerName(brokerId)}`));
    Object.entries(config.destinationAccounts).forEach(([key, accountId]) => {
        const d = destinationList.find(x => x.key === key);
        role(accountId, `destination ${d?.accountName ?? key}`);
    });
    const guardBudget = checkYnabGuardBudget(config, input.budgetId);
    if (!guardBudget.ok) warn('guard', guardBudget.message);
    for (const [accountId, labels] of roles) {
        const account = accountById.get(accountId);
        const name = account?.name ?? accountId;
        if (guardBudget.ok) {
            const verdict = checkYnabWriteTarget(config, { budgetId: input.budgetId!, accountId, onBudget: account?.onBudget, accountName: account?.name });
            if (!verdict.ok && verdict.reason === 'account-not-allowed') {
                warn('account-not-allowed', `${verdict.message} It is linked as ${labels.join(', ')}.`);
            }
        }
        // A source may also be its own broker's destination: that is the money staying put.
        const destinations = labels.filter(l => l.startsWith('destination'));
        const sources = labels.filter(l => l.startsWith('source'));
        if (sources.length > 1 || destinations.length > 1) {
            warn('account-reused', `YNAB account "${name}" is linked more than once (${labels.join(', ')}).`);
        }
        if (input.accounts) {
            if (!account) warn('account-missing', `A linked YNAB account (${labels.join(', ')}) no longer exists or is closed.`);
            else if (account.onBudget) warn('account-on-budget', `"${name}" is an on-budget account: only tracking (off-budget) accounts can be ${labels.join(', ')}.`);
        }
    }

    const securities = holdings.filter(h => includedBroker.get(h.brokerId)).reduce((s, h) => s + h.value, 0);
    const cash = trackingBrokers.filter(b => b.included && b.kind === 'B').reduce((s, b) => s + b.cash, 0);
    const destinationsTotal = destinationList.reduce((s, d) => s + d.value, 0);

    return {
        holdings,
        brokers: trackingBrokers,
        destinations: destinationList,
        migrations,
        totals: { securities: cents(securities), cash: cents(cash), destinations: cents(destinationsTotal) },
        balanced: Math.abs(destinationsTotal - (securities + cash)) < 0.01 * Math.max(1, destinationList.length),
        warnings,
    };
}
