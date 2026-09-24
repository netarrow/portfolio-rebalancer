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
    categoryIds: string[];
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
    const mappingById = new Map(mappings.map(m => [m.categoryId, m]));
    const goalById = new Map(goals.map(g => [g.id, g]));

    return categories.map(category => {
        const mapping = mappingById.get(category.id);
        const goalEntity = goalById.get(category.id);
        const own = allocations.filter(a => a.ynabGoalId === category.id);
        const invested = roundCents(own.reduce((s, a) => s + (coveredOf ? coveredOf(a) : a.amount), 0));

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
            emergencyFund: !!mapping?.emergencyFund,
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
    const goalById = new Map(goals.map(g => [g.categoryId, g]));

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

    const accounts: AccountCoverage[] = [...byAccount.entries()].map(([brokerId, list]) => {
        const broker = brokerById.get(brokerId)!;
        const liquidity = roundCents(broker.currentLiquidity ?? 0);
        const required = roundCents(list.reduce((s, p) => s + Math.max(0, p.available), 0));
        const monthlySpend = roundCents(list
            .filter(p => p.nature && WORKING_CAPITAL_NATURES.includes(p.nature))
            .reduce((s, p) => s + p.avgSpent, 0));
        // A goal due soon cannot wait for its investments to be sold: whatever
        // it still needs beyond its invested part has to be cash here.
        const dueGoals = roundCents(list.reduce((s, p) => {
            const g = goalById.get(p.categoryId);
            if (!g || !g.target || g.monthsLeft === null || g.monthsLeft > settings.goalHorizonMonths) return s;
            return s + Math.max(0, g.target - g.invested);
        }, 0));
        return {
            brokerId,
            brokerName: broker.name,
            liquidity,
            required,
            shortfall: roundCents(Math.max(0, required - liquidity)),
            surplus: roundCents(Math.max(0, liquidity - required)),
            categoryIds: list.map(p => p.categoryId),
            monthlySpend,
            dueGoals,
            recommendedMin: roundCents(monthlySpend * settings.workingCapitalMonths + dueGoals),
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
    const fundCurrent = roundCents(fundCash + fundInvested);
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
        },
        goals,
        totals: {
            available: roundCents(positions.reduce((s, p) => s + p.available, 0)),
            budgeted: roundCents(input.categories.reduce((s, c) => s + eur(c.budgetedMilliunits), 0)),
            avgSpent: roundCents(positions.reduce((s, p) => s + p.avgSpent, 0)),
            invested: roundCents(positions.reduce((s, p) => s + p.invested, 0)),
            spentByNature,
        },
    };
};
