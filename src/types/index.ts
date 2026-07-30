export type TransactionDirection = 'Buy' | 'Sell' | 'Dividend' | 'Coupon';

export const isIncomeDirection = (d: TransactionDirection): boolean => d === 'Dividend' || d === 'Coupon';

export type CommissionType = 'fixed' | 'percent';

export interface Broker {
  id: string;
  name: string;
  description?: string;
  // Scope flags: family = assets/liquidity belonging to the household rather
  // than the user; illiquid = not readily spendable (e.g. pension fund).
  // Views offer toggles to include/exclude flagged brokers from the counts.
  familyAsset?: boolean;
  illiquid?: boolean;
  // Person this broker belongs to, for personal (non-family) brokers only.
  // Empty = personal but unattributed: always counted, never filtered out.
  ownerId?: string;
  currentLiquidity?: number;
  minLiquidityType?: 'percent' | 'fixed';
  minLiquidityPercentage?: number;
  minLiquidityAmount?: number;
  liquidityAllocations?: Record<string, number>; // portfolioId -> EUR amount
  // Commission plan
  commissionType?: CommissionType;
  commissionFixed?: number;    // € per transaction (fixed mode)
  commissionPercent?: number;  // % of transaction value (percent mode)
  commissionMin?: number;      // optional minimum fee (percent mode)
  commissionMax?: number;      // optional maximum fee (percent mode)
}

// A household member a personal broker can be attributed to. Managed in
// Settings; referenced by Broker.ownerId.
export interface Person {
  id: string;
  name: string;
  order: number; // display order (lower = first)
}

// Which flagged brokers are counted in totals (true = included). Persisted as
// a single app-wide preference; every counting view renders the same toggles.
export interface AssetScope {
  includeFamily: boolean;
  includeIlliquid: boolean;
  // Persons whose personal brokers are left out of the counts. Modelled as an
  // exclusion list so a newly created person is counted by default, matching
  // the include-by-default behaviour of the two flags above.
  excludedPersonIds?: string[];
}

export const CASH_TICKER_PREFIX = '_CASH_';
export const getCashTicker = (brokerId: string) => `${CASH_TICKER_PREFIX}${brokerId}`;

// Allocation groups: a single target % covering several interchangeable tickers
// (e.g. "All World" = VWCE + XMAU). The group id is used as a key in
// Portfolio.allocations just like a ticker, so the "sum to 100%" math is unchanged.
export const GROUP_TICKER_PREFIX = '_GRP_';

export const VBOND_TICKER_PREFIX = '_VBOND_';
export const getVirtualBondTicker = (id: string) => `${VBOND_TICKER_PREFIX}${id}`;
export const isVirtualBondTicker = (t: string) => t.startsWith(VBOND_TICKER_PREFIX);
export const getVirtualBondId = (ticker: string) => ticker.replace(VBOND_TICKER_PREFIX, '');

export type AssetClass = 'Stock' | 'Bond' | 'Commodity' | 'Crypto' | 'Cash' | 'PensionFund';
export type AssetSubClass =
  | 'International' | 'Local'     // Stock
  | 'Short' | 'Medium' | 'Long'   // Bond
  | 'Gold'                        // Commodity
  | 'Balanced'                    // PensionFund
  | '';                           // Crypto/None

export type FinancialGoal = 'Growth' | 'Protection' | 'Security' | 'Liquidity';

export type MacroAllocation = {
  [key in AssetClass]?: number;
};

export type GoalAllocation = {
  [key in FinancialGoal]?: number;
};

export interface Goal {
  id: string;
  title: string;
  description?: string;
  order: number;
}

// Per-member rule inside an allocation group.
export interface AllocationMemberRule {
  noBuy?: boolean;   // never add to this member (e.g. a promo that ended)
  noSell?: boolean;  // never reduce this member (e.g. avoid realizing gains/tax)
  weight?: number;   // intra-group weight % (0-100); ignored when noBuy && noSell
}

// A market group: one target % shared by several interchangeable tickers.
export interface AllocationGroup {
  id: string;            // group key (GROUP_TICKER_PREFIX + uuid); also a key in Portfolio.allocations
  label: string;         // e.g. "All World"
  members: string[];     // ordered priority tickers (index 0 = buy-first / sell-last)
  memberRules?: Record<string, AllocationMemberRule>;
}

export interface Portfolio {
  id: string;
  name: string;
  description?: string;
  allocations?: Record<string, number>; // Ticker | groupId -> Percentage (0-100)
  allocationGroups?: AllocationGroup[];  // multi-asset "market" groups (target stored in allocations[groupId])
  liquidity?: number; // Cash available for rebalancing
  // Broker this portfolio trades through ("broker di appoggio"). When set, the
  // full rebalance prices every leg against this broker's commission plan,
  // checks the plan against its cash, and stamps generated transactions with it.
  // Unset = multi-broker: the per-ticker last-transaction heuristic, no cash
  // check — the right mode for a portfolio spread across several brokers.
  preferredBrokerId?: string;
  goalId?: string;
  parentId?: string; // ID of parent portfolio for nested Core/Satellite grouping
  order: number; // Display order (lower = left)
}

export type PortfolioTargetMode =
  | 'excluded'   // Not counted in total, no target
  | 'locked'     // Counts in total, target = current value (does not move)
  | 'fixed'      // Target = fixed EUR amount
  | 'percent'    // Target = X% of eligible total
  | 'ratio';     // Part of a ratio group (share a group budget by relative weight)

export interface PortfolioTargetConfig {
  mode: PortfolioTargetMode;
  value: number;          // fixed: EUR | percent: 0-100 | ratio: relative weight | excluded/locked: ignored
  ratioGroupId?: string;  // required only for mode === 'ratio'
}

export type LiquidityTargetMode = 'fixed' | 'percent';

export interface LiquidityTargetConfig {
  mode: LiquidityTargetMode;
  value: number; // EUR if fixed, 0-100 if percent
}

export type RatioGroupTargetMode = 'fixed' | 'percent' | 'remainder';

export interface RatioGroupConfig {
  id: string;
  name: string;
  groupTargetMode: RatioGroupTargetMode;
  groupTargetValue: number; // fixed: EUR | percent: 0-100 | remainder: ignored
}

export interface AssetAllocationSettings {
  liquidityTarget?: LiquidityTargetConfig;
  portfolioTargets: Record<string, PortfolioTargetConfig>;
  ratioGroups: RatioGroupConfig[];
}

// Free-buy promo list: ISINs whose BUY commission is waived by a specific
// broker in a given month (e.g. a rotating "free purchase" promotion). Entered
// in Settings as free text + reference month + broker; one entry per
// month/broker pair.
export interface FreeCommissionPeriod {
    monthKey: string;   // 'YYYY-MM'
    brokerId?: string;  // broker running the promo; absent = legacy entry, matches any broker
    isins: string[];    // uppercase ISINs free to buy in that month at that broker
}

export interface Transaction {
  id: string;
  ticker: string;
  amount: number;
  price: number;
  date: string;
  direction: TransactionDirection;
  portfolioId?: string;
  brokerId?: string;
  freeCommission?: boolean;
}

export interface Asset {
  ticker: string;
  label?: string;
  assetClass: AssetClass;
  assetSubClass?: AssetSubClass;
  quantity: number;
  averagePrice: number;
  currentPrice?: number;
  currentValue: number;
  lastUpdated?: string;
  gain?: number;
  gainPercentage?: number;
}

// Daily/monthly close-price history per ticker, accumulated by price updates
// and backfilled from the chart APIs of the scraped sources. Kept compact
// ([date, price] tuples) because the whole map lives in localStorage.
export type PricePoint = [string, number]; // ['YYYY-MM-DD', closePrice]

export interface TickerPriceHistory {
  points: PricePoint[]; // ascending by date, unique dates
  granularity: 'D' | 'M';
  // 'clean' = corso secco (MOT bonds from the chart API, no accrued interest);
  // 'dirty' = market price / NAV. Daily tel-quel snapshots must never be
  // appended to a clean series.
  priceBasis?: 'clean' | 'dirty';
  lastHistoryFetch?: string;
}

export type PriceHistoryMap = Record<string, TickerPriceHistory>;

// Formerly "Target", now acts as Asset Registry/Settings
export interface AssetDefinition {
  ticker: string;
  label?: string;
  source?: 'ETF' | 'MOT' | 'CPRAM' | 'COMETA';
  assetClass?: AssetClass;
  assetSubClass?: AssetSubClass;
}

export type BondUniverse = 'IT' | 'EU';

export interface VirtualBond {
  id: string;
  label: string;
  targetMaturityDate: string;
  universe: BondUniverse;
  minMonthsBefore: number;
  maxMonthsBefore: number;
  resolvedIsin?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface BondProposal {
  isin: string;
  name: string;
  maturityDate: string;
  yield?: number;
  currency?: string;
  universe: BondUniverse;
}

// YNAB integration

// A budget of the connected YNAB token, as needed to label and address it.
export interface YnabBudgetRef {
  id: string;
  name: string;
  currencyIso: string;
}

export interface YnabConfig {
  apiKey: string;
  // Primary budget: the one categories and Goals read from.
  // Broker ↔ account mappings and the Summary analysis can point at any budget
  // of the token.
  budgetId: string;
  budgetName?: string;
  currencyIso?: string;
  // Budgets visible to the token, cached so the broker mapping UI can offer
  // them without a fresh "Verify". Device-local, like the API key.
  budgets?: YnabBudgetRef[];
  // Budget the Summary analysis is currently looking at. Independent of the
  // primary budget: switching it must not move categories, Goals or forecast.
  // Unset = analyse the primary budget.
  summaryBudgetId?: string;
  lastSyncAt?: string;
  avgMonthsWindow?: number;
  goalsGroupId?: string;
  goalsGroupName?: string;
  lastGoalsSyncAt?: string;
  lastAccountsSyncAt?: string;
}

// A YNAB account, qualified by the budget that holds it: account ids are only
// unique within a budget, and a broker may be backed by any budget's account.
export interface YnabAccountMapping {
  budgetId: string;
  accountId: string;
}

// brokerId -> YNAB account. Strictly 1:1 per (budgetId, accountId): an account
// backs a single broker, so assigning it elsewhere moves it. The same account
// id in a different budget is a different account and maps independently.
export type YnabAccountMappings = Record<string, YnabAccountMapping>;

// One row of the "update broker liquidity from YNAB" preview.
export interface BrokerLiquiditySyncRow {
  brokerId: string;
  brokerName: string;
  ynabBudgetId: string;
  ynabBudgetName: string;
  ynabAccountId: string;
  ynabAccountName: string;
  currentLiquidity: number;
  newLiquidity: number;
  delta: number;
  // 'account-missing' = the mapped account is gone/closed in YNAB;
  // 'budget-missing' = its budget is unreachable with the current token.
  // Both are shown for context but can never be applied.
  status: 'ok' | 'account-missing' | 'budget-missing';
  allocatedTotal: number; // sum of liquidityAllocations, to warn on shortfalls
}

export interface YnabCategory {
  id: string;
  groupId: string;
  groupName: string;
  name: string;
  balanceMilliunits: number;
  budgetedMilliunits?: number;
  avgBudgetedMilliunits?: number;
  avgMonthsCount?: number;
  note?: string;
  goalType?: string;
  goalTargetMilliunits?: number;
  // YNAB's own goal target date ('YYYY-MM-DD'), set on dated goals (TBD/NEED).
  goalTargetMonth?: string;
  // YNAB goal cadence: 0 = one-off target by date, 1+ = recurring (monthly,
  // weekly, yearly…). Tells a one-time NEED target apart from a repeating one.
  goalCadence?: number;
  activityMilliunits?: number;
}

export interface YnabCategoryGroupSummary {
  id: string;
  name: string;
  categoryCount: number;
}

// Where a goal's target amount/date came from. 'ynab-goal' = YNAB's own goal
// fields (goal_target / goal_target_month), used when the category name and
// note carry no explicit target of their own.
export type YnabGoalTargetSource = 'parsed-name' | 'parsed-note' | 'ynab-goal' | 'manual-override';

export interface YnabGoal {
  id: string;
  ynabBudgetId: string;
  name: string;
  targetAmount?: number;
  targetDate?: string;
  cashCoverage: number;
  ynabMonthlyFunding?: number;
  ynabActivityThisMonth?: number;
  goalType?: string;
  targetSource: YnabGoalTargetSource;
  lastSyncedAt: string;
  archived?: boolean;
}

export interface YnabGoalAllocation {
  id: string;
  portfolioId: string;
  ynabGoalId: string;
  amount: number;
  createdAt: string;
  updatedAt: string;
}

// Where a single field (target amount or target date) of a sync candidate was
// taken from. 'local' = kept from the goal already stored in YNAB Goals, so a
// re-sync proposes it again instead of blanking it.
export type YnabGoalFieldSource = 'parsed-name' | 'parsed-note' | 'ynab-goal' | 'local';

export interface YnabGoalSyncCandidate {
  ynabCategoryId: string;
  ynabCategoryName: string;
  rawNote: string | null;
  // Values that will be applied: the name/note parse when it found something,
  // otherwise YNAB's own goal target, otherwise the value already stored in
  // YNAB Goals. Editable in the sync modal before confirming.
  parsedAmount: number | null;
  parsedDate: string | null;
  // Provenance of each of the two values above, for the modal's captions.
  amountSource: YnabGoalFieldSource | null;
  dateSource: YnabGoalFieldSource | null;
  confidence: 'high' | 'medium' | 'low';
  cashCoverage: number;
  ynabMonthlyFunding: number | null;
  ynabActivityThisMonth: number | null;
  // YNAB's own goal target, kept for display even when the parse wins.
  ynabTargetAmount: number | null;
  ynabTargetDate: string | null;
  goalType: string | null;
  matchedYnabGoalId: string | null;
  parsedSource: 'parsed-name' | 'parsed-note' | 'ynab-goal' | null;
  existingTargetSource: YnabGoalTargetSource | null;
  existingTargetAmount: number | null;
  existingTargetDate: string | null;
  action: 'create' | 'update' | 'skip';
}

// Forecast planned expense imported from a YNAB Goal. The forecast year is
// derived at render time from targetDate (so entries stay correct as calendar
// years pass). `enabled` toggles the expense in the simulation without losing
// it; removing it from the list is a hard delete until the next "Restore from
// YNAB Goals", which rebuilds the whole list from the current goals.
export interface PlannedForecastExpense {
  id: string;             // stable: equals the source ynabGoalId
  ynabGoalId: string;
  description: string;    // goal name at import time
  targetDate: string;     // 'YYYY-MM-DD'
  amount: number;         // goal targetAmount at import time
  enabled: boolean;
  allowedGoalIds: string[];  // manual Goal ids allowed to fund it (empty = all portfolios)
  erosionAllowed: boolean;
  importedAt: string;
}

export type YnabMappingTarget =
  | { kind: 'asset'; ticker: string }
  | { kind: 'cash'; brokerId: string }
  | { kind: 'unmapped' };

export interface YnabCategoryMapping {
  categoryId: string;
  target: YnabMappingTarget;
}

// ── YNAB spending analysis (rolling 12 months) ──────────────────────

export type YnabMacroCategory = 'structural' | 'variable' | 'compressible' | 'investments' | 'sinking';

export interface YnabMacroMappings {
  // groupId → macro class; a category override (categoryId key) wins over its group.
  groups: Record<string, YnabMacroCategory>;
  categories: Record<string, YnabMacroCategory>;
}

export interface YnabMonthCategorySnapshot {
  categoryId: string;
  name: string;
  groupId: string;
  groupName: string;
  budgetedMilliunits: number;
  activityMilliunits: number; // negative = outflow
}

export interface YnabMonthSnapshot {
  month: string; // 'YYYY-MM-01'
  incomeMilliunits: number;
  budgetedMilliunits: number;
  activityMilliunits: number;
  categories: YnabMonthCategorySnapshot[];
  syncedAt: string;
}

// budgetId -> rolling window of that budget's months. Every budget of the token
// keeps its own history, so switching the Summary between them needs no re-sync.
export type YnabSpendingHistoryByBudget = Record<string, YnabMonthSnapshot[]>;

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  allocation: { [key in AssetClass]?: number }; // Percentage by class
  totalGain: number;
  totalGainPercentage: number;
}

// ── PAC (piano di accumulo) auto-tracking ───────────────────────────
// Recurring investment plan: every N periods, buy a fixed EUR amount or a
// fixed quantity of a ticker in a given portfolio at a given broker. There is
// no background scheduler, so installments are only ever generated on the fly
// (pacSchedule.ts) from startDate/frequency and materialized into a real
// Transaction only when the user explicitly confirms one.
export type PacFrequency = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'quarterly' | 'semiannual' | 'annual';
export type PacContributionMode = 'amount' | 'quantity';
// 'fractional': buy the exact (possibly fractional) share count, no residue.
// 'floor': buy whole units only; the leftover cash is parked on the broker's
//          liquidityAllocations for this portfolio and left there.
// 'floor-carry': same leftover parking, but the residue is also reused as
//          extra budget for the next installment (see carryInFor).
export type PacRoundingMode = 'fractional' | 'floor' | 'floor-carry';
// How the trade fee is sourced: the broker's own commission plan, a flat
// override, a percent-of-trade-value override, or no fee at all.
export type PacCostMode = 'broker' | 'fixed' | 'percent' | 'none';

export interface PacPlan {
    id: string;
    name: string;
    ticker: string;
    portfolioId: string;
    brokerId: string;
    mode: PacContributionMode;
    amount?: number;    // EUR budget per installment, mode 'amount'
    quantity?: number;  // fixed unit count per installment, mode 'quantity'
    frequency: PacFrequency;
    startDate: string;  // 'YYYY-MM-DD', first due date
    endDate?: string;   // 'YYYY-MM-DD', last due date (inclusive); absent = open-ended
    costMode: PacCostMode;
    costFixed?: number;    // EUR, costMode 'fixed'
    costPercent?: number;  // % of trade value, costMode 'percent'
    // true: the fee is deducted from `amount` itself (less is invested);
    // false: the fee is an outlay on top of `amount` (full amount invested).
    // Ignored in mode 'quantity' (there is no budget to net against).
    costsIncluded: boolean;
    rounding: PacRoundingMode; // only meaningful in mode 'amount'
    active: boolean; // paused plans keep their history but stop surfacing new due installments
    createdAt: string;
}

// One row per due date of a plan. Absence of an entry for a due date means
// "not yet actioned" (still pending in the summary view). Keyed by
// (planId, dueDate) rather than its own id since a plan has at most one
// installment per due date.
export interface PacExecution {
    planId: string;
    dueDate: string;
    skipped?: boolean;        // user explicitly skipped this installment
    transactionId?: string;   // id of the Transaction created on confirm
    executedDate?: string;    // date recorded on the Transaction (usually === dueDate)
    price?: number;           // unit price used
    quantity?: number;        // units bought
    cost?: number;            // fee applied, EUR
    carryIn?: number;         // residue consumed from a prior installment's carryOut ('floor-carry' only)
    carryOut?: number;        // residue left by this installment, parked on the broker
    parkedDelta?: number;     // carryOut − carryIn: net change applied to Broker.liquidityAllocations
    priceSource?: 'history' | 'manual';
    confirmedAt?: string;     // when the user actually clicked confirm/skip (audit only)
}

// Second-Layer Encryption: persisted opt-in config (itself stored in plaintext).
export interface SLEConfig {
  enabled: boolean;
  salt: string;                  // base64-encoded random salt for PBKDF2
  verifier: string;              // enc:v1:... of a known plaintext, used to validate passphrase
  idleTimeoutMinutes: number;    // auto-lock after N minutes of inactivity
}

