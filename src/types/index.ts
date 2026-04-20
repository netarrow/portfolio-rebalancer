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

export interface Portfolio {
  id: string;
  name: string;
  description?: string;
  allocations?: Record<string, number>; // Ticker -> Percentage (0-100)
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

// Formerly "Target", now acts as Asset Registry/Settings
export interface AssetDefinition {
  ticker: string;
  label?: string;
  source?: 'ETF' | 'MOT' | 'CPRAM' | 'COMETA';
  assetClass?: AssetClass;
  assetSubClass?: AssetSubClass;
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  allocation: { [key in AssetClass]?: number }; // Percentage by class
  totalGain: number;
  totalGainPercentage: number;
}

