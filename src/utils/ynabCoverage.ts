/**
 * YNAB coverage check: is the money each category says it holds really there,
 * how much should every account keep liquid, how big should the emergency fund
 * be, and how far along is each goal.
 *
 * Everything is read off data already in the app:
 *  - a category's **Available** sits on one account — its `sourceBrokerId`, the
 *    same account the funding plan wires from, else the plan's default one;
 *  - on top of that cash, a category may have money **invested**: the
 *    allocations of the YNAB goal tracking it (goal id = category id);
 *  - its **nature** is the Summary's macro class (structural / variable /
 *    compressible / sinking / investments), a category override winning over
 *    its group;
 *  - its **average spending** is YNAB's own activity over the last 12 months.
 *
 * Rules, deliberately simple:
 *  - an account is covered when its liquidity reaches the Available of the
 *    categories living on it; otherwise the difference is what to deposit;
 *  - its working capital is `workingCapitalMonths` of the average spending of
 *    its structural, variable and compressible categories, plus the cash still
 *    missing for goals due within `goalHorizonMonths` — money that has to be
 *    liquid rather than invested;
 *  - the emergency fund target is `emergencyMonths` of structural spending,
 *    against the cash and invested money of the categories marked as fund.
 */
import type {
    Broker,
    YnabCategory,
    YnabCategoryMapping,
    YnabGoal,
    YnabGoalAllocation,
    YnabMacroCategory,
    YnabMacroMappings,
} from '../types';
import { effectiveMacro } from './spendingAnalysis';
import { nativeGoalTarget, parseGoalDescriptor } from './ynabGoalParser';
import { minLiquidityOf, roundCents } from './ynabFundingPlan';

export interface CoverageSettings {
    emergencyMonths: number;
    workingCapitalMonths: number;
    goalHorizonMonths: number;
    /** Category groups whose every category is emergency fund. */
    emergencyGroupIds?: string[];
    /** Portfolios whose whole value counts toward the emergency fund. */
    emergencyPortfolioIds?: string[];
}

/** Natures whose spending is day-to-day money: it has to stay liquid. */
export const WORKING_CAPITAL_NATURES: YnabMacroCategory[] = ['structural', 'variable', 'compressible'];

export type GoalTargetSource = 'goal' | 'category';

export interface CategoryPosition {
    categoryId: string;
    name: string;
    groupId: string;
    groupName: string;
    /** YNAB Available, € (may be negative when overspent). */
    available: number;
    /** Average monthly outflow over the last 12 months, € (never negative). */
    avgSpent: number;
    /** Months the average is taken over; 0 = no history. */
    spentMonths: number;
    nature: YnabMacroCategory | null;
    /** True when the nature comes from the category group rather than the category. */
    natureFromGroup: boolean;
    /** Account the Available sits on (explicit, else the default account). */
    cashBrokerId?: string;
    cashBrokerIsDefault: boolean;
    /** € the category has invested, as its goal allocations cover it today. */
    invested: number;
    allocations: YnabGoalAllocation[];
    emergencyFund: boolean;
    goal?: {
        amount?: number;
        date?: string;
        /** 'goal' = a YNAB goal is stored for it; 'category' = read off the category. */
        source: GoalTargetSource;
    };
}

export interface CoverageInput {
    categories: YnabCategory[];
    mappings: YnabCategoryMapping[];
    macroMappings: YnabMacroMappings;
    brokers: Broker[];
    goals: YnabGoal[];
    allocations: YnabGoalAllocation[];
    /** What each allocation covers today; absent = its own amount. */
    coveredOf?: (allocation: YnabGoalAllocation) => number;
    /** Fallback averages (categoryId → €/month) when the categories carry none. */
    spentFallback?: Map<string, { avg: number; months: number }>;
    defaultSourceBrokerId?: string;
    settings: CoverageSettings;
    /** Today's ISO date; injectable so the checks stay stable. */
    today?: string;
    /** Current value of a portfolio, for the portfolios counted as emergency fund. */
    portfolioValueOf?: (portfolioId: string) => number;
    /**
     * Monthly history of the same budget (oldest first or any order): gives
     * each account its real month-by-month flow of day-to-day money.
     */
    history?: { month: string; categories: { categoryId: string; activityMilliunits: number; budgetedMilliunits: number }[] }[];
}

export interface AccountCoverage {
    brokerId: string;
    brokerName: string;
    liquidity: number;
    /** Σ Available (> 0) of the categories on this account. */
    required: number;
    /** € to deposit so the liquidity covers the categories. */
    shortfall: number;
    /** Liquidity not claimed by any category. */
    surplus: number;
    categoryIds: string[];
    /** Monthly spending of its day-to-day categories. */
    monthlySpend: number;
    /** Cash still missing for goals due within the horizon. */
    dueGoals: number;
    /** Recommended minimum liquidity: working capital + goals due soon. */
    recommendedMin: number;
    /** Minimum configured on the broker today. */
    configuredMin: number;
    // ── Working capital: the day-to-day money that passes through ─────
    /** Months of history the flow is read from (0 = averages only). */
    flowMonths: number;
    /** Average monthly assigned to its day-to-day categories (money in). */
    avgIn: number;
    /** Average monthly spent by its day-to-day categories (money out). */
    avgOut: number;
    /** The worst month of day-to-day spending in the history. */
    peakOut: number;
    /** Cash to keep for day-to-day: avgOut × working-capital months + (peak − avg). */
    operatingCash: number;
    /** Cash already set aside here for other purposes: dated expenses, money to invest, unmapped. Not the fund. */
    earmarked: number;
    /** The categories making up `earmarked` (Available > 0), largest first. */
    earmarkedCategoryIds: string[];
    /** Cash of the emergency-fund categories on this account (held apart from `earmarked`). */
    emergencyHere: number;
    /** Liquidity left after operating cash, the fund held here and set-aside money (< 0 = short). */
    free: number;
    /** Planned capex due within the horizon: € to bring back from investments. */
    capexToRecover: number;
    /**
     * The account once the capex due within the horizon are paid from it:
     * liquidity + what comes back from investments − the payments, against
     * the cash it must still hold (operating cash + what stays set aside).
     * Absent when no capex is due on this account.
     */
    afterCapex?: {
        pay: number;
        recover: number;
        liquidityAfter: number;
        needAfter: number;
        /** € to deposit to stay in line; 0 = in line. */
        topUp: number;
        /** Liquidity left above what it must hold; 0 when a top-up is needed. */
        spare: number;
    };
}

/** A planned capex due within the horizon, and what it still needs in cash. */
export interface UpcomingCapex {
    categoryId: string;
    name: string;
    date: string;
    monthsLeft: number;
    target: number;
    /** Cash already in the category. */
    cash: number;
    invested: number;
    /** € to sell and bring back to the account from the investments covering it. */
    toRecover: number;
    /** € not covered by cash nor investments. */
    stillMissing: number;
    brokerId?: string;
    allocations: YnabGoalAllocation[];
}

export interface EmergencyCoverage {
    months: number;
    /** Monthly structural spending, all accounts. */
    fixedMonthly: number;
    target: number;
    cash: number;
    invested: number;
    current: number;
    gap: number;
    /** How many months of fixed spending the fund covers today. */
    monthsCovered: number;
    /** Every category counted in the fund (flagged one by one or by group). */
    categoryIds: string[];
    /** Of which, flagged one by one. */
    flaggedCategoryIds: string[];
    groupIds: string[];
    /** Value of the portfolios counted as fund. */
    fromPortfolios: number;
    portfolios: { portfolioId: string; value: number }[];
}

export type GoalStatus = 'done' | 'on-track' | 'due-soon' | 'overdue' | 'no-target';

export interface GoalCoverage {
    categoryId: string;
    name: string;
    target?: number;
    date?: string;
    source: GoalTargetSource;
    cash: number;
    invested: number;
    covered: number;
    gap: number;
    /** 0..1, null without a target. */
    progress: number | null;
    monthsLeft: number | null;
    /** € a month still needed to hit the target by its date. */
    requiredMonthly: number | null;
    status: GoalStatus;
}

export interface CoverageReport {
    positions: CategoryPosition[];
    accounts: AccountCoverage[];
    /** Available (> 0) of categories with no account at all. */
    unlocated: { amount: number; categoryIds: string[] };
    emergency: EmergencyCoverage;
    goals: GoalCoverage[];
    /** Planned capex due within the horizon, nearest first. */
    upcoming: UpcomingCapex[];
    totals: {
        available: number;
        budgeted: number;
        avgSpent: number;
        invested: number;
        /** Monthly spending by nature. */
        spentByNature: Partial<Record<YnabMacroCategory | 'unassigned', number>>;
    };
}

const eur = (milliunits: number | undefined): number => roundCents((milliunits ?? 0) / 1000);

/** Whole months from `from` to `to` (both ISO dates), negative when past. */
export const monthsUntil = (from: string, to: string): number => {
    const a = new Date(`${from.slice(0, 10)}T00:00:00Z`);
    const b = new Date(`${to.slice(0, 10)}T00:00:00Z`);
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
};

/**
 * Average monthly outflow per category from a stored monthly history — the
 * fallback when the categories were synced before they carried their own.
 */
export const averageSpentFromHistory = (
    history: { categories: { categoryId: string; activityMilliunits: number }[] }[],
): Map<string, { avg: number; months: number }> => {
    const sums = new Map<string, { sum: number; months: number }>();
    history.forEach(month => month.categories.forEach(c => {
        const entry = sums.get(c.categoryId) ?? { sum: 0, months: 0 };
        entry.sum += -c.activityMilliunits;
        entry.months += 1;
        sums.set(c.categoryId, entry);
    }));
    return new Map([...sums].map(([id, { sum, months }]) => [id, { avg: eur(sum / months), months }]));
};

/** Where every category stands: cash, invested, nature, account, goal. */
export const buildCategoryPositions = (input: CoverageInput): CategoryPosition[] => {
    const { categories, mappings, macroMappings, goals, allocations, coveredOf, spentFallback, defaultSourceBrokerId } = input;
    const fundGroups = new Set(input.settings.emergencyGroupIds ?? []);
    const fundPortfolios = new Set(input.settings.emergencyPortfolioIds ?? []);
    const mappingById = new Map(mappings.map(m => [m.categoryId, m]));
    const goalById = new Map(goals.map(g => [g.id, g]));

    return categories.map(category => {
        const mapping = mappingById.get(category.id);
        const goalEntity = goalById.get(category.id);
        const own = allocations.filter(a => a.ynabGoalId === category.id);
        const isFund = !!mapping?.emergencyFund || fundGroups.has(category.groupId);
        // A fund category invested in a fund portfolio is already counted with
        // that portfolio's whole value: not twice.
        const invested = roundCents(own
            .filter(a => !(isFund && fundPortfolios.has(a.portfolioId)))
            .reduce((s, a) => s + (coveredOf ? coveredOf(a) : a.amount), 0));

        const hasOwnAverage = typeof category.avgSpentMilliunits === 'number';
        const fallback = spentFallback?.get(category.id);
        const avgSpent = Math.max(0, hasOwnAverage ? eur(category.avgSpentMilliunits) : fallback?.avg ?? 0);
        const spentMonths = hasOwnAverage ? category.spentMonthsCount ?? 0 : fallback?.months ?? 0;

        const categoryNature = macroMappings.categories[category.id];
        const nature = effectiveMacro(macroMappings, category.groupId, category.id);

        let goal: CategoryPosition['goal'];
        if (goalEntity && !goalEntity.archived) {
            goal = { amount: goalEntity.targetAmount, date: goalEntity.targetDate, source: 'goal' };
        } else {
            const parsed = parseGoalDescriptor(category.name, category.note);
            const native = nativeGoalTarget(category);
            const amount = parsed.amount ?? native.amount;
            const date = parsed.date ?? native.date;
            if (amount !== null || date !== null) {
                goal = { amount: amount ?? undefined, date: date ?? undefined, source: 'category' };
            }
        }

        const explicitBroker = mapping?.sourceBrokerId;
        return {
            categoryId: category.id,
            name: category.name,
            groupId: category.groupId,
            groupName: category.groupName,
            available: eur(category.balanceMilliunits),
            avgSpent,
            spentMonths,
            nature,
            natureFromGroup: !categoryNature && !!nature,
            cashBrokerId: explicitBroker ?? defaultSourceBrokerId,
            cashBrokerIsDefault: !explicitBroker && !!defaultSourceBrokerId,
            invested,
            allocations: own,
            emergencyFund: isFund,
            goal,
        };
    });
};

export const buildCoverageReport = (input: CoverageInput): CoverageReport => {
    const { brokers, settings } = input;
    const today = input.today ?? new Date().toISOString().slice(0, 10);
    const positions = buildCategoryPositions(input);
    const brokerById = new Map(brokers.map(b => [b.id, b]));

    // ── Goals ──────────────────────────────────────────────────────────
    // A goal is a category with a target or a date, or one classed as a
    // sinking fund. The emergency fund has its own check below.
    const goals: GoalCoverage[] = positions
        .filter(p => !p.emergencyFund && (p.goal || p.nature === 'sinking'))
        .map(p => {
            const cash = Math.max(0, p.available);
            const covered = roundCents(cash + p.invested);
            const target = p.goal?.amount;
            const date = p.goal?.date;
            const gap = target ? roundCents(Math.max(0, target - covered)) : 0;
            const monthsLeft = date ? monthsUntil(today, date) : null;
            const requiredMonthly = target && monthsLeft !== null && gap > 0
                ? roundCents(gap / Math.max(1, monthsLeft))
                : null;
            let status: GoalStatus;
            if (!target) status = 'no-target';
            else if (gap <= 0) status = 'done';
            else if (monthsLeft !== null && monthsLeft < 0) status = 'overdue';
            else if (monthsLeft !== null && monthsLeft <= settings.goalHorizonMonths) status = 'due-soon';
            else status = 'on-track';
            return {
                categoryId: p.categoryId,
                name: p.name,
                target,
                date,
                source: p.goal?.source ?? 'category',
                cash,
                invested: p.invested,
                covered,
                gap,
                progress: target ? Math.min(1, covered / target) : null,
                monthsLeft,
                requiredMonthly,
                status,
            };
        })
        .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.name.localeCompare(b.name));

    // ── Accounts ───────────────────────────────────────────────────────
    const byAccount = new Map<string, CategoryPosition[]>();
    const unlocatedIds: string[] = [];
    let unlocatedAmount = 0;
    positions.forEach(p => {
        if (!p.cashBrokerId || !brokerById.has(p.cashBrokerId)) {
            if (p.available > 0) {
                unlocatedIds.push(p.categoryId);
                unlocatedAmount += p.available;
            }
            return;
        }
        const list = byAccount.get(p.cashBrokerId) ?? [];
        list.push(p);
        byAccount.set(p.cashBrokerId, list);
    });

    // ── Planned capex due soon ─────────────────────────────────────────
    // Whatever a dated target due within the horizon needs beyond the cash
    // already in its category must come back from its investments now.
    const positionById = new Map(positions.map(p => [p.categoryId, p]));
    // Read from the planned capex themselves (the YNAB goals entity): cash is
    // the category's Available when the category is synced, else the cash the
    // goal carries; invested is what its allocations cover today.
    // Dated targets read off a category's name or YNAB fields but not synced
    // into Planned Capex yet count too.
    const entityIds = new Set(input.goals.map(g => g.id));
    const fromCategories = goals
        .filter(g => g.source === 'category' && !entityIds.has(g.categoryId) && g.target && g.date)
        .map(g => ({ id: g.categoryId, name: g.name, targetAmount: g.target, targetDate: g.date, cashCoverage: g.cash, archived: false }));
    const upcoming: UpcomingCapex[] = [...input.goals, ...fromCategories]
        .filter(g => !g.archived && g.targetAmount && g.targetAmount > 0 && g.targetDate)
        .map(g => {
            const p = positionById.get(g.id);
            const monthsLeft = monthsUntil(today, g.targetDate!);
            const cash = roundCents(Math.max(0, p ? p.available : g.cashCoverage));
            const own = input.allocations.filter(a => a.ynabGoalId === g.id);
            const invested = roundCents(own.reduce((s, a) => s + (input.coveredOf ? input.coveredOf(a) : a.amount), 0));
            const needFromCash = Math.max(0, g.targetAmount! - cash);
            const toRecover = roundCents(Math.min(invested, needFromCash));
            return {
                categoryId: g.id,
                name: g.name,
                date: g.targetDate!,
                monthsLeft,
                target: g.targetAmount!,
                cash,
                invested,
                toRecover,
                stillMissing: roundCents(Math.max(0, needFromCash - toRecover)),
                brokerId: p?.cashBrokerId ?? input.defaultSourceBrokerId,
                allocations: own,
            };
        })
        // Already covered by cash ones stay listed: they are spending on its way.
        .filter(u => u.monthsLeft <= settings.goalHorizonMonths)
        .sort((a, b) => a.date.localeCompare(b.date));

    // Month-by-month day-to-day flow of every category, from the history.
    const months = input.history ?? [];
    const flowOf = (ids: Set<string>) => {
        const outs: number[] = [];
        const ins: number[] = [];
        months.forEach(m => {
            let out = 0, inn = 0;
            m.categories.forEach(c => {
                if (!ids.has(c.categoryId)) return;
                out += Math.max(0, -c.activityMilliunits) / 1000;
                inn += Math.max(0, c.budgetedMilliunits) / 1000;
            });
            outs.push(out);
            ins.push(inn);
        });
        const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
        return { months: months.length, avgIn: avg(ins), avgOut: avg(outs), peakOut: outs.length ? Math.max(...outs) : 0 };
    };

    const accounts: AccountCoverage[] = [...byAccount.entries()].map(([brokerId, list]) => {
        const broker = brokerById.get(brokerId)!;
        const liquidity = roundCents(broker.currentLiquidity ?? 0);
        const required = roundCents(list.reduce((s, p) => s + Math.max(0, p.available), 0));
        const monthlySpend = roundCents(list
            .filter(p => p.nature && WORKING_CAPITAL_NATURES.includes(p.nature))
            .reduce((s, p) => s + p.avgSpent, 0));
        // A goal due soon cannot wait for its investments to be sold: whatever
        // it still needs beyond its invested part has to be cash here.
        const dueGoals = roundCents(upcoming
            .filter(u => u.brokerId === brokerId)
            .reduce((s, u) => s + Math.max(0, u.target - u.invested), 0));
        const dayToDay = list.filter(p => p.nature && WORKING_CAPITAL_NATURES.includes(p.nature) && !p.emergencyFund);
        const flow = flowOf(new Set(dayToDay.map(p => p.categoryId)));
        const avgOut = flow.months > 0 ? flow.avgOut : monthlySpend;
        const peakOut = flow.months > 0 ? flow.peakOut : monthlySpend;
        const operatingCash = roundCents(avgOut * settings.workingCapitalMonths + Math.max(0, peakOut - avgOut));
        const dayToDayIds = new Set(dayToDay.map(p => p.categoryId));
        const earmarkedList = list
            // The emergency fund is held apart (emergencyHere), not set aside here.
            .filter(p => !dayToDayIds.has(p.categoryId) && !p.emergencyFund && p.available > 0)
            .sort((a, b) => b.available - a.available);
        const earmarked = roundCents(earmarkedList.reduce((s, p) => s + p.available, 0));
        const emergencyHere = roundCents(list.filter(p => p.emergencyFund).reduce((s, p) => s + Math.max(0, p.available), 0));
        const dueHere = upcoming.filter(u => u.brokerId === brokerId);
        const capexToRecover = roundCents(dueHere.reduce((s, u) => s + u.toRecover, 0));
        // Paying the capex due soon: their full target leaves the account, what
        // their investments cover comes back first, and their own cash stops
        // being set aside.
        let afterCapex: AccountCoverage['afterCapex'];
        if (dueHere.length > 0) {
            const pay = roundCents(dueHere.reduce((s, u) => s + u.target, 0));
            const ownCash = dueHere.reduce((s, u) => s + (list.some(p => p.categoryId === u.categoryId) ? u.cash : 0), 0);
            const liquidityAfter = roundCents(liquidity + capexToRecover - pay);
            const needAfter = roundCents(operatingCash + emergencyHere + Math.max(0, earmarked - ownCash));
            afterCapex = {
                pay,
                recover: capexToRecover,
                liquidityAfter,
                needAfter,
                topUp: roundCents(Math.max(0, needAfter - liquidityAfter)),
                spare: roundCents(Math.max(0, liquidityAfter - needAfter)),
            };
        }
        return {
            brokerId,
            brokerName: broker.name,
            liquidity,
            flowMonths: flow.months,
            avgIn: roundCents(flow.months > 0 ? flow.avgIn : 0),
            avgOut: roundCents(avgOut),
            peakOut: roundCents(peakOut),
            operatingCash,
            earmarked,
            earmarkedCategoryIds: earmarkedList.map(p => p.categoryId),
            emergencyHere,
            free: roundCents(liquidity - operatingCash - emergencyHere - earmarked),
            capexToRecover,
            afterCapex,
            required,
            shortfall: roundCents(Math.max(0, required - liquidity)),
            surplus: roundCents(Math.max(0, liquidity - required)),
            categoryIds: list.map(p => p.categoryId),
            monthlySpend,
            dueGoals,
            // Day-to-day cash (average month, plus the swing of the worst one)
            // and the cash goals due soon need on hand.
            recommendedMin: roundCents(operatingCash + dueGoals),
            configuredMin: roundCents(minLiquidityOf(broker)),
        };
    }).sort((a, b) => b.required - a.required);

    // ── Emergency fund ─────────────────────────────────────────────────
    const fixedMonthly = roundCents(positions
        .filter(p => p.nature === 'structural')
        .reduce((s, p) => s + p.avgSpent, 0));
    const fund = positions.filter(p => p.emergencyFund);
    const fundCash = roundCents(fund.reduce((s, p) => s + Math.max(0, p.available), 0));
    const fundInvested = roundCents(fund.reduce((s, p) => s + p.invested, 0));
    const fundPortfolioList = (settings.emergencyPortfolioIds ?? [])
        .map(portfolioId => ({ portfolioId, value: roundCents(input.portfolioValueOf?.(portfolioId) ?? 0) }));
    const fromPortfolios = roundCents(fundPortfolioList.reduce((s, x) => s + x.value, 0));
    const fundCurrent = roundCents(fundCash + fundInvested + fromPortfolios);
    const flaggedIds = new Set(input.mappings.filter(m => m.emergencyFund).map(m => m.categoryId));
    const emergencyTarget = roundCents(fixedMonthly * settings.emergencyMonths);

    const spentByNature: CoverageReport['totals']['spentByNature'] = {};
    positions.forEach(p => {
        const key = p.nature ?? 'unassigned';
        spentByNature[key] = roundCents((spentByNature[key] ?? 0) + p.avgSpent);
    });

    return {
        positions,
        accounts,
        unlocated: { amount: roundCents(unlocatedAmount), categoryIds: unlocatedIds },
        emergency: {
            months: settings.emergencyMonths,
            fixedMonthly,
            target: emergencyTarget,
            cash: fundCash,
            invested: fundInvested,
            current: fundCurrent,
            gap: roundCents(Math.max(0, emergencyTarget - fundCurrent)),
            monthsCovered: fixedMonthly > 0 ? Math.round((fundCurrent / fixedMonthly) * 10) / 10 : 0,
            categoryIds: fund.map(p => p.categoryId),
            flaggedCategoryIds: fund.filter(p => flaggedIds.has(p.categoryId)).map(p => p.categoryId),
            groupIds: settings.emergencyGroupIds ?? [],
            fromPortfolios,
            portfolios: fundPortfolioList,
        },
        goals,
        upcoming,
        totals: {
            available: roundCents(positions.reduce((s, p) => s + p.available, 0)),
            budgeted: roundCents(input.categories.reduce((s, c) => s + eur(c.budgetedMilliunits), 0)),
            avgSpent: roundCents(positions.reduce((s, p) => s + p.avgSpent, 0)),
            invested: roundCents(positions.reduce((s, p) => s + p.invested, 0)),
            spentByNature,
        },
    };
};
