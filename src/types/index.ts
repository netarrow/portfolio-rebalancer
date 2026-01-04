export type TransactionDirection = 'Buy' | 'Sell';

export type AssetClass = 'Stock' | 'Bond' | 'Commodity' | 'Crypto';
export type AssetSubClass =
  | 'International' | 'Local'     // Stock
  | 'Short' | 'Medium' | 'Long'   // Bond
  | 'Gold'                        // Commodity
  | '';                           // Crypto/None

export interface Portfolio {
  id: string;
  name: string;
  description?: string;
  allocations?: Record<string, number>; // Ticker -> Percentage (0-100)
}

export interface Transaction {
  id: string;
  ticker: string;
  assetClass?: AssetClass; // Deprecated: moved to AssetDefinition
  assetSubClass?: AssetSubClass; // Deprecated: moved to AssetDefinition
  amount: number;
  price: number;
  date: string;
  direction: TransactionDirection;
  portfolio?: string; // Deprecated: property name kept for compatibility during migration
  portfolioId?: string;
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
  assetClass?: AssetClass;
  assetSubClass?: AssetSubClass;
  // targetPercentage: number; // Removed: moved to Portfolio.allocations
  source?: 'ETF' | 'MOT' | 'CPRAM';
}

// Deprecated alias for compatibility until full refactor
export type Target = AssetDefinition & { targetPercentage?: number };

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  allocation: { [key in AssetClass]?: number }; // Percentage by class
  totalGain: number;
  totalGainPercentage: number;
}


