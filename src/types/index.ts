export type TransactionDirection = 'Buy' | 'Sell' | 'Dividend' | 'Coupon';

export const isIncomeDirection = (d: TransactionDirection): boolean => d === 'Dividend' || d === 'Coupon';

export type CommissionType = 'fixed' | 'percent';

export interface Broker {
  id: string;
  name: string;
  description?: string;
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

// PAC (piano di accumulo) flag on an allocation entry (ticker or group id).
// When new liquidity is deployed (Buy Only), PAC entries are funded first by
// ascending priority (1 = highest); equal-priority PACs share the budget
// proportionally to how far behind target they are. Whatever is left flows
// to the remaining (non-PAC) underweight entries.
export interface PacConfig {
    enabled: boolean;
    priority: number; // 1 = highest
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
  pacConfigs?: Record<string, PacConfig>; // Ticker | groupId -> PAC flag + priority for new liquidity
  liquidity?: number; // Cash available for rebalancing
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

export interface YnabConfig {
  apiKey: string;
  budgetId: string;
  budgetName?: string;
  currencyIso?: string;
  lastSyncAt?: string;
  avgMonthsWindow?: number;
  goalsGroupId?: string;
  goalsGroupName?: string;
  lastGoalsSyncAt?: string;
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
  activityMilliunits?: number;
}

export interface YnabCategoryGroupSummary {
  id: string;
  name: string;
  categoryCount: number;
}

export type YnabGoalTargetSource = 'parsed-name' | 'parsed-note' | 'manual-override';

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

export interface YnabGoalSyncCandidate {
  ynabCategoryId: string;
  ynabCategoryName: string;
  rawNote: string | null;
  parsedAmount: number | null;
  parsedDate: string | null;
  confidence: 'high' | 'medium' | 'low';
  cashCoverage: number;
  ynabMonthlyFunding: number | null;
  ynabActivityThisMonth: number | null;
  goalType: string | null;
  matchedYnabGoalId: string | null;
  parsedSource: 'parsed-name' | 'parsed-note' | null;
  existingTargetSource: YnabGoalTargetSource | null;
  existingTargetAmount: number | null;
  existingTargetDate: string | null;
  action: 'create' | 'update' | 'skip';
}

export type YnabMappingTarget =
  | { kind: 'asset'; ticker: string }
  | { kind: 'cash'; brokerId: string }
  | { kind: 'unmapped' };

export interface YnabCategoryMapping {
  categoryId: string;
  target: YnabMappingTarget;
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  allocation: { [key in AssetClass]?: number }; // Percentage by class
  totalGain: number;
  totalGainPercentage: number;
}

// Second-Layer Encryption: persisted opt-in config (itself stored in plaintext).
export interface SLEConfig {
  enabled: boolean;
  salt: string;                  // base64-encoded random salt for PBKDF2
  verifier: string;              // enc:v1:... of a known plaintext, used to validate passphrase
  idleTimeoutMinutes: number;    // auto-lock after N minutes of inactivity
}

