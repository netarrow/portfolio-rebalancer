export type TransactionDirection = 'Buy' | 'Sell';

export type AssetClass = 'Stock' | 'Bond' | 'Commodity' | 'Crypto';
export type AssetSubClass =
  | 'International' | 'Local'     // Stock
  | 'Short' | 'Medium' | 'Long'   // Bond
  | 'Gold'                        // Commodity
  | '';                           // Crypto/None

export interface Transaction {
  id: string;
  ticker: string;
  assetClass: AssetClass;
  assetSubClass?: AssetSubClass;
  amount: number;
  price: number;
  date: string;
  direction: TransactionDirection;
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


