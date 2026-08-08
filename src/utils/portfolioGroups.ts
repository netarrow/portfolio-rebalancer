import type { Portfolio, Asset, Transaction, AssetDefinition, Broker } from '../types';
import { isVirtualBondTicker } from '../types';
import { calculateAssets, injectCashAssets, isCashTicker, isGroupKey } from './portfolioCalculations';
import { resolveGroups } from './allocationGroups';

/**
 * Parent/child portfolio groups ("Core/Satellite"): the shared structure and
 * aggregation used by both the Allocations view (PortfolioGroupSection) and the
 * Stats page. A group is a root portfolio plus every portfolio hanging off it.
 */

/** Member colours, shared so the Allocations and Stats legends match. */
export const GROUP_MEMBER_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#06B6D4'];

export interface PortfolioGroup {
    parent: Portfolio;
    /** Descendants of `parent`, sorted by order (nesting is flattened). */
    children: Portfolio[];
    /** [parent, ...children] — the aggregation scope. */
    members: Portfolio[];
}

export interface PortfolioTree {
    groups: PortfolioGroup[];
    /** Childless roots plus orphans (parentId pointing at a deleted portfolio). */
    standalones: Portfolio[];
}

const byOrder = (a: Portfolio, b: Portfolio) => a.order - b.order;

/**
 * Split portfolios into parent/child groups and standalones.
 *
 * `deletePortfolio` doesn't clear `parentId` on the children it leaves behind,
 * so a child pointing at a missing parent is a real state: it is treated as a
 * standalone rather than dropped. Deeper nesting (A <- B <- C, reachable by
 * re-parenting or a JSON import even though the form only offers roots as
 * parents) is flattened into the root's group, so no portfolio ever ends up
 * belonging to no group and no standalone list.
 */
export function buildPortfolioTree(portfolios: Portfolio[]): PortfolioTree {
    const byId = new Map(portfolios.map(p => [p.id, p]));

    /**
     * Outermost ancestor of p — p itself when p is a root, which covers both a
     * plain root and an orphan whose parentId points nowhere. Cycle-safe.
     */
    const rootOf = (p: Portfolio): Portfolio => {
        const seen = new Set<string>([p.id]);
        let current = p;
        for (;;) {
            const parent = current.parentId ? byId.get(current.parentId) : undefined;
            if (!parent || seen.has(parent.id)) return current;
            seen.add(parent.id);
            current = parent;
        }
    };

    const childrenByRoot = new Map<string, Portfolio[]>();
    portfolios.forEach(p => {
        const root = rootOf(p);
        if (root.id === p.id) return;
        const list = childrenByRoot.get(root.id);
        if (list) list.push(p); else childrenByRoot.set(root.id, [p]);
    });

    const groups: PortfolioGroup[] = [];
    const standalones: Portfolio[] = [];
    const placed = new Set<string>();

    portfolios.forEach(p => {
        if (rootOf(p).id !== p.id) return;
        const children = (childrenByRoot.get(p.id) || []).sort(byOrder);
        if (children.length === 0) {
            standalones.push(p);
            placed.add(p.id);
        } else {
            groups.push({ parent: p, children, members: [p, ...children] });
            placed.add(p.id);
            children.forEach(c => placed.add(c.id));
        }
    });

    // Nothing may vanish: a parentId cycle leaves members without a root.
    portfolios.forEach(p => { if (!placed.has(p.id)) standalones.push(p); });

    return {
        groups: groups.sort((a, b) => byOrder(a.parent, b.parent)),
        standalones: standalones.sort(byOrder),
    };
}

export interface MemberCalc {
    portfolio: Portfolio;
    /** Invested assets + the broker cash allocated to this member. */
    assets: Asset[];
    investedValue: number;
    cashValue: number;
    /**
     * invested + allocated broker cash. `portfolio.liquidity` is deliberately
     * excluded, matching PortfolioGroupSection: it is rebalancing-only money.
     */
    totalValue: number;
    /** Share of the group total, 0 when the group is worth nothing. */
    weight: number;
}

export interface GroupAggregate {
    group: PortfolioGroup;
    /** Parent first, then children in order. */
    memberCalcs: MemberCalc[];
    /** Union holdings of every member, with per-broker cash merged. */
    assets: Asset[];
    totalValue: number;
    /** allocation key -> value-weighted target %, over the union of member keys. */
    weightedTargets: Record<string, number>;
    /** True when the group is worth 0 and the targets fell back to equal weights. */
    equalWeightFallback: boolean;
}

type MarketData = Record<string, { price: number; lastUpdated: string }>;

/**
 * Aggregate a group into one virtual portfolio: union holdings, total value and
 * a value-weighted blend of the members' target allocations. Mirrors the
 * conventions of PortfolioGroupSection so the two views reconcile.
 */
export function aggregateGroup(
    group: PortfolioGroup,
    transactions: Transaction[],
    assetSettings: AssetDefinition[],
    marketData: MarketData,
    brokers: Broker[],
): GroupAggregate {
    const rawCalcs = group.members.map(portfolio => {
        const memberTxs = transactions.filter(t => t.portfolioId === portfolio.id);
        const { assets: rawAssets, summary } = calculateAssets(memberTxs, assetSettings, marketData);
        const assets = injectCashAssets(rawAssets, brokers, portfolio.id);
        const cashValue = assets.filter(a => isCashTicker(a.ticker)).reduce((s, a) => s + a.currentValue, 0);
        return { portfolio, assets, investedValue: summary.totalValue, cashValue };
    });

    const totalValue = rawCalcs.reduce((s, c) => s + c.investedValue + c.cashValue, 0);
    const memberCalcs: MemberCalc[] = rawCalcs.map(c => {
        const memberTotal = c.investedValue + c.cashValue;
        return { ...c, totalValue: memberTotal, weight: totalValue > 0 ? memberTotal / totalValue : 0 };
    });

    // Union holdings: a ticker bought in the parent and sold in a child has to
    // net out, so recompute from the combined transactions rather than summing
    // the members' asset rows. Cash is merged per broker — two members funded
    // from the same broker must not yield two identical _CASH_<brokerId> rows.
    const memberIds = new Set(group.members.map(p => p.id));
    const groupTxs = transactions.filter(t => t.portfolioId && memberIds.has(t.portfolioId));
    const { assets: unionAssets } = calculateAssets(groupTxs, assetSettings, marketData);
    const cashMap = new Map<string, Asset>();
    memberCalcs.forEach(mc => {
        mc.assets.filter(a => isCashTicker(a.ticker)).forEach(cash => {
            const existing = cashMap.get(cash.ticker);
            if (existing) {
                const value = existing.currentValue + cash.currentValue;
                cashMap.set(cash.ticker, { ...existing, currentValue: value, averagePrice: value, currentPrice: value });
            } else {
                cashMap.set(cash.ticker, { ...cash });
            }
        });
    });

    // Value-weighted blend of the members' targets. With nothing invested yet
    // every weight would be 0 and the blended target would be an all-zero (i.e.
    // invisible) pie, so fall back to equal member weights.
    const equalWeightFallback = totalValue <= 0 && memberCalcs.length > 0;
    const weightedTargets: Record<string, number> = {};
    memberCalcs.forEach(mc => {
        const weight = equalWeightFallback ? 1 / memberCalcs.length : mc.weight;
        if (weight <= 0) return;
        Object.entries(mc.portfolio.allocations || {}).forEach(([key, percent]) => {
            weightedTargets[key] = (weightedTargets[key] || 0) + weight * percent;
        });
    });

    return {
        group,
        memberCalcs,
        assets: [...unionAssets, ...Array.from(cashMap.values())],
        totalValue,
        weightedTargets,
        equalWeightFallback,
    };
}

// A type alias rather than an interface: recharts' data prop expects an implicit
// index signature, which only anonymous object types provide.
export type TargetSlice = { name: string; value: number };

export interface TargetClassOptions {
    /** Portfolios defining the `_GRP_` ids used in `allocations`. */
    groupSources: Portfolio[];
    /** Current value per ticker, used to split a group target across members. */
    valueByTicker?: Record<string, number>;
}

/**
 * Group target allocations into asset classes.
 *
 * Cash tickers are Cash and unresolved virtual bonds are Bond (same convention
 * as `resolveAssetClass`). A multi-asset allocation group holds a single target
 * under its `_GRP_` id: it is split across the group's members by their current
 * value (equally when the group holds nothing) and each member resolved on its
 * own, so a group target no longer collapses into an "Other" slice.
 */
export function targetClassSlices(
    allocations: Record<string, number>,
    assetSettings: AssetDefinition[],
    opts: TargetClassOptions,
): TargetSlice[] {
    const classOf = (ticker: string): string => {
        if (isCashTicker(ticker)) return 'Cash';
        if (isVirtualBondTicker(ticker)) return 'Bond';
        return assetSettings.find(s => s.ticker === ticker)?.assetClass || 'Other';
    };

    const groupById: Record<string, { members: string[] }> = {};
    opts.groupSources.forEach(p => {
        Object.entries(resolveGroups(p).groupById).forEach(([id, group]) => {
            if (!groupById[id]) groupById[id] = group;
        });
    });

    const grouped: Record<string, number> = {};
    const add = (cls: string, value: number) => { grouped[cls] = (grouped[cls] || 0) + value; };

    Object.entries(allocations).forEach(([key, percent]) => {
        if (!isGroupKey(key)) { add(classOf(key), percent); return; }

        const members = groupById[key]?.members || [];
        if (members.length === 0) { add('Other', percent); return; }

        const values = members.map(m => opts.valueByTicker?.[m] ?? 0);
        const totalValue = values.reduce((s, v) => s + v, 0);
        members.forEach((member, i) => {
            const share = totalValue > 0 ? values[i] / totalValue : 1 / members.length;
            add(classOf(member), percent * share);
        });
    });

    return Object.entries(grouped)
        .map(([name, value]) => ({ name, value }))
        .filter(s => s.value > 0)
        .sort((a, b) => b.value - a.value);
}
