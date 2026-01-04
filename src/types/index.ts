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
}

export interface Transaction {
  id: string;
  ticker: string;
  assetClass?: AssetClass; // Deprecated: moved to Target
  assetSubClass?: AssetSubClass; // Deprecated: moved to Target
  amount: number;
  price: number;
  date: string;
  direction: TransactionDirection;
  portfolio?: string; // Deprecated: property name kept for compatibility during migration, but content should be ignored in favor of portfolioId
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

export interface Target {
  ticker: string;
  label?: string;
  assetClass?: AssetClass;
  assetSubClass?: AssetSubClass;
  targetPercentage: number; // 0-100
  source?: 'ETF' | 'MOT';
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  allocation: { [key in AssetClass]?: number }; // Percentage by class
  totalGain: number;
  totalGainPercentage: number;
}


