import type {
    Transaction, AssetDefinition, Portfolio, Broker, AssetAllocationSettings, MacroAllocation, GoalAllocation, Goal,
    YnabCategoryMapping, YnabFundingSettings, YnabGoal, YnabGoalAllocation, YnabMacroMappings, VirtualBond,
    FreeCommissionPeriod, PlannedForecastExpense, AssetScope, Person, YnabAccountMappings, PacPlan, PacExecution,
    GoalFlowPortfolioState, YnabTrackingConfig, YnabWriteLogEntry, YnabGoalQuote,
} from '../types';
import { DEFAULT_YNAB_FUNDING_SETTINGS } from '../types';
import { normalizeAssetAllocationSettings } from './assetAllocation';
import { normalizeYnabAccountMappings } from './ynabAccountMappings';
import { normalizeYnabTrackingConfig } from './ynabTrackingPlan';
import { normalizeYnabGoalQuotes, normalizeYnabWriteLog } from './ynabWriteBack';

// The data a backup carries — the same for the JSON file and the Azure blob,
// so the two can never drift apart: both are built by `buildBackupData` and
// restored through `parseBackupData`.
//
// Deliberately NOT here (local-only): the Azure config and passphrase, the
// YNAB API key and config, the private-tier key, the price history (own JSON
// export) and the YNAB spending history (rebuilt from YNAB with one sync).
export interface BackupData {
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    portfolios: Portfolio[];
    brokers: Broker[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    assetAllocationSettings: AssetAllocationSettings;
    macroAllocations: MacroAllocation;
    goalAllocations: GoalAllocation;
    goals: Goal[];
    aggregateExcludedTickers?: string[];
    goalModeTargets?: Record<string, number>;
    // Which portfolios the Fund Relocation pyramid may move / freeze / ignore.
    // A planner preference, not a counting one — no other view reads it.
    goalFlowPortfolioStates?: Record<string, GoalFlowPortfolioState>;
    ynabMappings?: YnabCategoryMapping[];
    // How the funding plan sizes the orders and the wires it asks for. A
    // preference, like the mappings it reads.
    ynabFundingSettings?: YnabFundingSettings;
    // brokerId -> { budgetId, accountId }: a mapping, not a credential, so it
    // travels. Older payloads hold a bare account id and are normalized on read.
    ynabAccountMappings?: YnabAccountMappings;
    ynabGoals?: YnabGoal[];
    ynabGoalAllocations?: YnabGoalAllocation[];
    // Macro-class mappings for spending analysis; the spending history itself
    // is local-only (like priceHistory) and rebuilt from YNAB on sync.
    ynabMacroMappings?: YnabMacroMappings;
    // budgetId -> 'family' | Person id: which source a budget's income and
    // expenses count as in the Forecast. A mapping, not a credential.
    ynabBudgetOwners?: Record<string, string>;
    // How the off-budget accounts are split by purpose (off-budget map). A
    // mapping of YNAB account ids, not a credential, so it travels.
    ynabTrackingConfig?: YnabTrackingConfig;
    // Every write the tool made to YNAB (ids and amounts, to show and roll
    // back) and the goal shares frozen by a migration.
    ynabWriteLog?: YnabWriteLogEntry[];
    ynabGoalQuotes?: YnabGoalQuote[];
    ynabGoalsGroupId?: string;
    ynabGoalsGroupName?: string;
    ynabLastGoalsSyncAt?: string;
    virtualBonds?: VirtualBond[];
    freeCommissionPeriods?: FreeCommissionPeriod[];
    // Forecast expenses imported from YNAB goals (with per-entry enabled flag).
    // null/absent = never seeded on the source device.
    plannedForecastExpenses?: PlannedForecastExpense[] | null;
    // Include/exclude family, illiquid and per-person brokers in the counting views.
    assetScope?: AssetScope;
    // Household members personal brokers can be attributed to.
    people?: Person[];
    // PAC (piano di accumulo) auto-tracking plans and their installment ledger.
    pacPlans?: PacPlan[];
    pacExecutions?: PacExecution[];
}

// Version of the JSON backup file. v7 carries every field of BackupData (v6
// lacked the YNAB, virtual-bond and planner fields); older files still restore.
export const BACKUP_VERSION = 7;

// Snapshot of the app state to back up. `plannedForecastExpenses` keeps its
// null ("never seeded") so the restore can tell it apart from an empty plan.
export function buildBackupData(state: BackupData): BackupData {
    return {
        transactions: state.transactions,
        assetSettings: state.assetSettings,
        portfolios: state.portfolios,
        brokers: state.brokers,
        marketData: state.marketData,
        assetAllocationSettings: state.assetAllocationSettings,
        macroAllocations: state.macroAllocations,
        goalAllocations: state.goalAllocations,
        goals: state.goals,
        aggregateExcludedTickers: state.aggregateExcludedTickers,
        goalModeTargets: state.goalModeTargets,
        goalFlowPortfolioStates: state.goalFlowPortfolioStates,
        ynabMappings: state.ynabMappings,
        ynabFundingSettings: state.ynabFundingSettings,
        ynabAccountMappings: state.ynabAccountMappings,
        ynabGoals: state.ynabGoals,
        ynabGoalAllocations: state.ynabGoalAllocations,
        ynabMacroMappings: state.ynabMacroMappings,
        ynabBudgetOwners: state.ynabBudgetOwners,
        ynabTrackingConfig: state.ynabTrackingConfig,
        ynabWriteLog: state.ynabWriteLog,
        ynabGoalQuotes: state.ynabGoalQuotes,
        ynabGoalsGroupId: state.ynabGoalsGroupId,
        ynabGoalsGroupName: state.ynabGoalsGroupName,
        ynabLastGoalsSyncAt: state.ynabLastGoalsSyncAt,
        virtualBonds: state.virtualBonds,
        freeCommissionPeriods: state.freeCommissionPeriods,
        plannedForecastExpenses: state.plannedForecastExpenses ?? null,
        assetScope: state.assetScope,
        people: state.people,
        pacPlans: state.pacPlans,
        pacExecutions: state.pacExecutions,
    };
}

// What a restore applies. The core fields are in every backup ever written and
// always replace the local ones. Every other field is `undefined` when the
// file does not carry it — an older backup or blob, written before the field
// existed — and the restore then keeps the local value instead of wiping it.
// A field that is present but malformed degrades to its empty value.
export interface ParsedBackup {
    transactions: Transaction[];
    assetSettings: AssetDefinition[];
    portfolios: Portfolio[];
    brokers: Broker[];
    marketData: Record<string, { price: number; lastUpdated: string }>;
    assetAllocationSettings: AssetAllocationSettings;
    macroAllocations: MacroAllocation;
    goalAllocations: GoalAllocation;
    goals: Goal[];
    aggregateExcludedTickers?: string[];
    goalModeTargets?: Record<string, number>;
    goalFlowPortfolioStates?: Record<string, GoalFlowPortfolioState>;
    ynabMappings?: YnabCategoryMapping[];
    ynabFundingSettings?: YnabFundingSettings;
    ynabAccountMappings?: YnabAccountMappings;
    ynabGoals?: YnabGoal[];
    ynabGoalAllocations?: YnabGoalAllocation[];
    ynabMacroMappings?: YnabMacroMappings;
    ynabBudgetOwners?: Record<string, string>;
    ynabTrackingConfig?: YnabTrackingConfig;
    ynabWriteLog?: YnabWriteLogEntry[];
    ynabGoalQuotes?: YnabGoalQuote[];
    ynabGoalsGroupId?: string;
    ynabGoalsGroupName?: string;
    ynabLastGoalsSyncAt?: string;
    virtualBonds?: VirtualBond[];
    freeCommissionPeriods?: FreeCommissionPeriod[];
    // null = never seeded: the auto-seed re-runs from the YNAB goals.
    plannedForecastExpenses?: PlannedForecastExpense[] | null;
    assetScope?: AssetScope;
    people?: Person[];
    pacPlans?: PacPlan[];
    pacExecutions?: PacExecution[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

// Runs `read` only when the backup carries the field.
function optional<T>(data: Record<string, unknown>, key: string, read: (raw: unknown) => T): T | undefined {
    return data[key] === undefined ? undefined : read(data[key]);
}

const asArray = <T>(raw: unknown): T[] => (Array.isArray(raw) ? raw as T[] : []);
const asRecord = <T>(raw: unknown): Record<string, T> => (isPlainObject(raw) ? raw as Record<string, T> : {});
const asString = (raw: unknown): string | undefined => (typeof raw === 'string' ? raw : undefined);

// Validates a backup (JSON file or decrypted Azure payload). Throws when it
// is not one at all; `fallbackBudgetId` adopts the bare account ids of v5
// account mappings.
export function parseBackupData(raw: unknown, fallbackBudgetId?: string): ParsedBackup {
    if (!isPlainObject(raw) || !Array.isArray(raw.transactions) || !Array.isArray(raw.assetSettings)) {
        throw new Error('Invalid data format');
    }
    const data = raw;
    return {
        transactions: data.transactions as Transaction[],
        assetSettings: data.assetSettings as AssetDefinition[],
        portfolios: asArray<Portfolio>(data.portfolios),
        brokers: asArray<Broker>(data.brokers),
        marketData: asRecord<{ price: number; lastUpdated: string }>(data.marketData),
        assetAllocationSettings: normalizeAssetAllocationSettings(data.assetAllocationSettings),
        macroAllocations: asRecord(data.macroAllocations) as MacroAllocation,
        goalAllocations: asRecord(data.goalAllocations) as GoalAllocation,
        goals: asArray<Goal>(data.goals),

        aggregateExcludedTickers: optional(data, 'aggregateExcludedTickers', r => asArray<string>(r)),
        goalModeTargets: optional(data, 'goalModeTargets', r => asRecord<number>(r)),
        goalFlowPortfolioStates: optional(data, 'goalFlowPortfolioStates', r => asRecord<GoalFlowPortfolioState>(r)),
        ynabMappings: optional(data, 'ynabMappings', r => asArray<YnabCategoryMapping>(r)),
        // Defaults under the stored fields, so an older shape still has a source field.
        ynabFundingSettings: optional(data, 'ynabFundingSettings', r => isPlainObject(r)
            ? { ...DEFAULT_YNAB_FUNDING_SETTINGS, ...(r as Partial<YnabFundingSettings>) }
            : DEFAULT_YNAB_FUNDING_SETTINGS),
        ynabAccountMappings: optional(data, 'ynabAccountMappings', r => normalizeYnabAccountMappings(r, fallbackBudgetId)),
        ynabGoals: optional(data, 'ynabGoals', r => asArray<YnabGoal>(r)),
        ynabGoalAllocations: optional(data, 'ynabGoalAllocations', r => asArray<YnabGoalAllocation>(r)),
        ynabMacroMappings: optional(data, 'ynabMacroMappings', r => isPlainObject(r)
            ? { groups: asRecord(r.groups), categories: asRecord(r.categories) } as YnabMacroMappings
            : { groups: {}, categories: {} }),
        ynabBudgetOwners: optional(data, 'ynabBudgetOwners', r => Object.fromEntries(
            Object.entries(asRecord<unknown>(r))
                .filter(([budgetId, owner]) => !!budgetId && typeof owner === 'string' && owner.length > 0),
        ) as Record<string, string>),
        ynabTrackingConfig: optional(data, 'ynabTrackingConfig', normalizeYnabTrackingConfig),
        ynabWriteLog: optional(data, 'ynabWriteLog', normalizeYnabWriteLog),
        ynabGoalQuotes: optional(data, 'ynabGoalQuotes', normalizeYnabGoalQuotes),
        ynabGoalsGroupId: asString(data.ynabGoalsGroupId),
        ynabGoalsGroupName: asString(data.ynabGoalsGroupName),
        ynabLastGoalsSyncAt: asString(data.ynabLastGoalsSyncAt),
        virtualBonds: optional(data, 'virtualBonds', r => asArray<VirtualBond>(r)),
        freeCommissionPeriods: optional(data, 'freeCommissionPeriods', r => asArray<FreeCommissionPeriod>(r)),
        plannedForecastExpenses: optional(data, 'plannedForecastExpenses',
            r => (Array.isArray(r) ? r as PlannedForecastExpense[] : null)),
        assetScope: optional(data, 'assetScope', r => isPlainObject(r)
            ? {
                includeFamily: r.includeFamily !== false,
                includeIlliquid: r.includeIlliquid !== false,
                excludedPersonIds: asArray<string>(r.excludedPersonIds),
            }
            : { includeFamily: true, includeIlliquid: true, excludedPersonIds: [] }),
        people: optional(data, 'people', r => asArray<Person>(r)),
        pacPlans: optional(data, 'pacPlans', r => asArray<PacPlan>(r)),
        pacExecutions: optional(data, 'pacExecutions', r => asArray<PacExecution>(r)),
    };
}

// The localStorage key each restored field is persisted under (the keys the
// PortfolioContext's useLocalStorage hooks read). The YNAB goals-group fields
// are not here: they live inside the local YNAB config and are merged into it.
export const BACKUP_STORAGE_KEYS = {
    transactions: 'portfolio_transactions',
    assetSettings: 'portfolio_assets_v1',
    portfolios: 'portfolio_list',
    brokers: 'portfolio_brokers',
    marketData: 'portfolio_market_data',
    assetAllocationSettings: 'portfolio_asset_allocation_v1',
    macroAllocations: 'portfolio_macro_targets',
    goalAllocations: 'portfolio_goal_targets',
    goals: 'portfolio_goals',
    aggregateExcludedTickers: 'aggregate-excluded-tickers',
    goalModeTargets: 'goal_mode_targets',
    goalFlowPortfolioStates: 'goal_flow_portfolio_states',
    ynabMappings: 'portfolio_ynab_mappings',
    ynabFundingSettings: 'portfolio_ynab_funding',
    ynabAccountMappings: 'portfolio_ynab_account_mappings',
    ynabGoals: 'portfolio_ynab_goals',
    ynabGoalAllocations: 'portfolio_ynab_goal_allocations',
    ynabMacroMappings: 'portfolio_ynab_macro_mappings',
    ynabBudgetOwners: 'portfolio_ynab_budget_owners',
    ynabTrackingConfig: 'portfolio_ynab_tracking_config',
    ynabWriteLog: 'portfolio_ynab_write_log',
    ynabGoalQuotes: 'portfolio_ynab_goal_quotes',
    virtualBonds: 'portfolio_virtual_bonds',
    freeCommissionPeriods: 'portfolio_free_commissions',
    plannedForecastExpenses: 'portfolio_forecast_planned_expenses',
    assetScope: 'portfolio_asset_scope',
    people: 'portfolio_people',
    pacPlans: 'portfolio_pac_plans',
    pacExecutions: 'portfolio_pac_executions',
} as const satisfies Record<Exclude<keyof ParsedBackup, 'ynabGoalsGroupId' | 'ynabGoalsGroupName' | 'ynabLastGoalsSyncAt'>, string>;

export type StoredBackupField = keyof typeof BACKUP_STORAGE_KEYS;

// The (field, storage key, value) triples a restore writes: only the fields
// the backup carries, so the others keep their local value.
export function backupStorageEntries(parsed: ParsedBackup): Array<[StoredBackupField, string, unknown]> {
    const out: Array<[StoredBackupField, string, unknown]> = [];
    for (const field of Object.keys(BACKUP_STORAGE_KEYS) as StoredBackupField[]) {
        const value = parsed[field];
        if (value !== undefined) out.push([field, BACKUP_STORAGE_KEYS[field], value]);
    }
    return out;
}
