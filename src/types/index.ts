export type TransactionDirection = 'Buy' | 'Sell';

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

export type AssetClass = 'Stock' | 'Bond' | 'Commodity' | 'Crypto' | 'Cash';
export type AssetSubClass =
  | 'International' | 'Local'     // Stock
  | 'Short' | 'Medium' | 'Long'   // Bond
  | 'Gold'                        // Commodity
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
}

export interface GlobalRebalancingSettings {
  weightsByPortfolioId?: Record<string, number>;
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
  source?: 'ETF' | 'MOT' | 'CPRAM';
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

