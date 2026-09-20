/**
 * Splitting one pot of money across a portfolio's own targets.
 *
 * A YNAB category can name a whole portfolio as its destination instead of a
 * single asset: "this money is for the Main Strategy", leaving the question of
 * *what* to buy to the portfolio's targets. This answers that question the same
 * way the rest of the app does, so the YNAB page and the rebalancing views can
 * never disagree:
 *
 *  - a **percent-mode** portfolio spreads the money over its underweight rows,
 *    proportionally to how far each one is from its target — the buy-only
 *    largest-remainder distribution used by Asset Allocation and Fund Relocation;
 *  - an **amount-mode** portfolio fills its € gaps nearest due date first, in
 *    whole bond lots, exactly as its own Amount Target table does.
 *
 * Nothing is ever sold, and a row is priced at the instrument that would
 * actually receive the order: the buy-first member of an allocation group, or
 * the real ISIN a virtual bond has been resolved to. What comes back is a € per
 * row, not a share count: the commission-aware sizing downstream does the only
 * rounding, so a contribution never loses a share to being rounded twice.
 */
import type { Asset, AssetDefinition, Portfolio, VirtualBond, YnabGoal, YnabGoalAllocation } from '../types';
import { getVirtualBondId, isVirtualBondTicker } from '../types';
import { isCashTicker } from './portfolioCalculations';
import {
    buyRecipientOf,
    largestRemainderBuyOnly,
    memberInfoFromAssets,
    resolveGroups,
    type BuyOnlyCandidate,
} from './allocationGroups';
import { lotUnitsFor, planAmountBuys, resolveAmountTargets, type AmountPlanUnit } from './amountTargets';

export interface PortfolioSplitLine {
    /** The allocation row the money was assigned to (ticker, `_GRP_` or `_VBOND_`). */
    rowKey: string;
    /** Human label of the row — the group's name, or the asset's. */
    rowLabel: string;
    /** The instrument that actually receives the order. */
    ticker: string;
    eur: number;
}

/** Why a split placed nothing. */
export type PortfolioSplitReason =
    | 'no-targets'   // the portfolio has no target rows to spread money over
    | 'on-target'    // every row is already at or above its target
    | 'no-price'     // rows want money but none of them can be priced
    | 'too-small';   // the money does not pay for one share of any row

export interface PortfolioSplit {
    lines: PortfolioSplitLine[];
    /** Money the split could not place — it stays uninvested, never hidden. */
    leftover: number;
    /** Set only when `lines` is empty, to say why. */
    reason?: PortfolioSplitReason;
}

export interface PortfolioSplitInput {
    portfolio: Portfolio;
    budget: number;
    /** Holdings of THIS portfolio (calculateAssets over its transactions). */
    assets: Asset[];
    marketData: Record<string, { price: number }>;
    assetSettings: AssetDefinition[];
    /** Amount-mode portfolios read their € targets from the goals linked to them. */
    goalAllocations?: YnabGoalAllocation[];
    goals?: YnabGoal[];
    virtualBonds?: VirtualBond[];
}

const roundCents = (value: number): number => Math.round(value * 100) / 100;

/** What a row is worth today, what it would be bought as, and at what price. */
interface RowTarget {
    key: string;
    label: string;
    ticker: string;
    price: number;
    currentValue: number;
    lotUnits: number;
}

const labelOf = (
    key: string,
    assetSettings: AssetDefinition[],
    virtualBonds: VirtualBond[],
): string => {
    if (isVirtualBondTicker(key)) {
        return virtualBonds.find(b => b.id === getVirtualBondId(key))?.label || key;
    }
    return assetSettings.find(s => s.ticker.toUpperCase() === key.toUpperCase())?.label || key;
};

/**
 * Resolves one allocation row to the instrument its money would buy.
 *
 * Returns undefined when nothing can receive the order: a group whose members
 * are all no-buy or unpriced, or a virtual bond still waiting for a real ISIN —
 * a placeholder priced at 1 is a parking slot, not something to send an order for.
 */
const resolveRow = (
    key: string,
    input: PortfolioSplitInput,
    investedAssets: Asset[],
): RowTarget | undefined => {
    const { portfolio, marketData, assetSettings, virtualBonds = [] } = input;
    const { groupById } = resolveGroups(portfolio);
    const label = groupById[key]?.label ?? labelOf(key, assetSettings, virtualBonds);

    const group = groupById[key];
    if (group) {
        const info = memberInfoFromAssets(group.members, investedAssets, marketData);
        const pick = buyRecipientOf(group, info);
        if (!pick || !(pick.price > 0)) return undefined;
        const currentValue = group.members.reduce((s, m) => s + (info[m.toUpperCase()]?.currentValue ?? 0), 0);
        return {
            key, label, ticker: pick.ticker, price: pick.price, currentValue,
            lotUnits: lotUnitsFor(pick.ticker, pick.price, assetSettings),
        };
    }

    if (isVirtualBondTicker(key)) {
        const bond = virtualBonds.find(b => b.id === getVirtualBondId(key));
        const held = investedAssets.find(a => a.ticker === key);
        if (!bond?.resolvedIsin) return undefined;
        const price = marketData[bond.resolvedIsin.toUpperCase()]?.price ?? 0;
        if (!(price > 0)) return undefined;
        return {
            key, label, ticker: bond.resolvedIsin, price,
            currentValue: held?.currentValue ?? 0,
            lotUnits: lotUnitsFor(bond.resolvedIsin, price, assetSettings),
        };
    }

    const held = investedAssets.find(a => a.ticker.toUpperCase() === key.toUpperCase());
    const price = held?.currentPrice ?? marketData[key.toUpperCase()]?.price ?? 0;
    if (!(price > 0)) return undefined;
    return {
        key, label, ticker: held?.ticker ?? key, price,
        currentValue: held?.currentValue ?? 0,
        lotUnits: lotUnitsFor(key, price, assetSettings),
    };
};

const emptySplit = (budget: number, reason: PortfolioSplitReason): PortfolioSplit =>
    ({ lines: [], leftover: roundCents(Math.max(0, budget)), reason });

/** Spreads `budget` over a percent-mode portfolio's underweight rows. */
const splitByWeights = (input: PortfolioSplitInput, investedAssets: Asset[]): PortfolioSplit => {
    const { portfolio, budget } = input;
    const allocations = Object.entries(portfolio.allocations || {}).filter(([, pct]) => pct > 0);
    if (allocations.length === 0) return emptySplit(budget, 'no-targets');

    const currentTotal = investedAssets.reduce((s, a) => s + a.currentValue, 0);
    // The money is part of the pie it is being weighed against: targets are
    // measured on the portfolio as it will be once this contribution lands.
    const postTotal = currentTotal + budget;

    const rows = new Map<string, RowTarget>();
    const candidates: BuyOnlyCandidate[] = [];
    let priced = 0;

    for (const [key, pct] of allocations) {
        const row = resolveRow(key, input, investedAssets);
        if (!row) continue;
        priced++;
        const gap = postTotal * (pct / 100) - row.currentValue;
        if (gap <= 0) continue;
        rows.set(key, row);
        candidates.push({ key, gap, price: row.price });
    }

    if (priced === 0) return emptySplit(budget, 'no-price');
    if (candidates.length === 0) return emptySplit(budget, 'on-target');

    const distribution = largestRemainderBuyOnly(candidates, budget);
    const placed = Object.entries(distribution).filter(([key, eur]) => eur > 0 && rows.has(key));
    if (placed.length === 0) return emptySplit(budget, 'too-small');

    // The distribution above floors to whole shares, but it prices them without
    // the broker's commission — and the order pipeline downstream floors again,
    // with the fee, which would cost a share the money could actually afford.
    // So hand each row the rest of the money too, in the same proportions, and
    // let that single commission-aware rounding be the only one. A row never
    // takes more than its own gap: past that, the money has no home here.
    const amounts = new Map(placed.map(([key, eur]) => [key, eur]));
    const gapByKey = new Map(candidates.map(c => [c.key, c.gap]));
    let pot = budget - placed.reduce((s, [, eur]) => s + eur, 0);
    for (let pass = 0; pass < 5 && pot > 0.005; pass++) {
        const open = placed.filter(([key]) => (amounts.get(key) ?? 0) + 1e-9 < (gapByKey.get(key) ?? 0));
        const weight = open.reduce((s, [, eur]) => s + eur, 0);
        if (open.length === 0 || weight <= 0) break;
        let given = 0;
        for (const [key, eur] of open) {
            const room = (gapByKey.get(key) ?? 0) - (amounts.get(key) ?? 0);
            const add = Math.min(pot * (eur / weight), room);
            amounts.set(key, (amounts.get(key) ?? 0) + add);
            given += add;
        }
        if (given <= 0) break;
        pot -= given;
    }

    const lines: PortfolioSplitLine[] = placed.map(([key]) => {
        const row = rows.get(key) as RowTarget;
        return { rowKey: key, rowLabel: row.label, ticker: row.ticker, eur: roundCents(amounts.get(key) ?? 0) };
    });

    const total = lines.reduce((s, l) => s + l.eur, 0);
    return { lines, leftover: roundCents(Math.max(0, budget - total)) };
};

/** Fills an amount-mode portfolio's € gaps, nearest due date first. */
const splitByAmountTargets = (input: PortfolioSplitInput, investedAssets: Asset[]): PortfolioSplit => {
    const { portfolio, budget, goalAllocations = [], goals = [], virtualBonds = [] } = input;
    const targetRows = resolveAmountTargets(portfolio, goalAllocations, goals, virtualBonds);
    if (targetRows.length === 0) return emptySplit(budget, 'no-targets');

    const rows = new Map<string, RowTarget>();
    const units: AmountPlanUnit[] = [];
    let priced = 0;

    targetRows.forEach((r, order) => {
        const row = resolveRow(r.key, input, investedAssets);
        if (!row) return;
        priced++;
        rows.set(r.key, row);
        units.push({
            key: r.key,
            price: row.price,
            currentValue: row.currentValue,
            target: r.target,
            dueDate: r.dueDate,
            lotUnits: row.lotUnits,
            order,
        });
    });

    if (priced === 0) return emptySplit(budget, 'no-price');

    const plan = planAmountBuys(units, budget);
    const lines: PortfolioSplitLine[] = [];
    for (const line of Object.values(plan.lines)) {
        const row = rows.get(line.key);
        if (!row || !(line.eur > 0)) continue;
        lines.push({ rowKey: line.key, rowLabel: row.label, ticker: row.ticker, eur: roundCents(line.eur) });
    }
    if (lines.length === 0) {
        const wanted = Object.values(plan.lines).some(l => l.gap > 0);
        return emptySplit(budget, wanted ? 'too-small' : 'on-target');
    }

    return { lines, leftover: roundCents(Math.max(0, plan.leftover)) };
};

/**
 * Splits `budget` across the portfolio's targets, by weights or by € targets
 * depending on how the portfolio expresses them. Pure: the caller passes the
 * portfolio's own holdings, and gets back what to buy and what is left over.
 */
export const splitPortfolioBudget = (input: PortfolioSplitInput): PortfolioSplit => {
    if (!(input.budget > 0)) return { lines: [], leftover: 0, reason: 'too-small' };
    const investedAssets = input.assets.filter(a => !isCashTicker(a.ticker) && !isVirtualBondTicker(a.ticker));
    return input.portfolio.targetMode === 'amount'
        ? splitByAmountTargets(input, input.assets.filter(a => !isCashTicker(a.ticker)))
        : splitByWeights(input, investedAssets);
};
