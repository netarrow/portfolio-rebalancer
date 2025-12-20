export type TransactionType = 'ETF' | 'Bond';
export type TransactionDirection = 'Buy' | 'Sell';

export interface Transaction {
  id: string;
  date: string; // ISO date string YYYY-MM-DD
  ticker: string;
  type: TransactionType;
  direction: TransactionDirection;
  amount: number; // Quantity
  price: number; // Price per unit
  currency: string;
}

export interface Asset {
  ticker: string;
  type: TransactionType;
  quantity: number;
  averagePrice: number;
  currentValue: number; // Calculated based on input price (for now assuming fixed or manual update, but user asked for "total value", usually this requires market data. The prompt says "total value of these investments" -> "valore totale di questi investimenti". Since no backend, user might expect manual price entry or just sum of cost basis? 
  // "l'obiettivo è poi avere il valore totale... e capire di quanto si discosta rispetto un target".
  // If price changes, value changes. I should probably include a "current price" field in the Asset or allow updating it.
  // For simplicity MVP: User inputs transactions. Maybe "Current Price" is a separate input or stored in Asset?
  // Let's assume for now "Value" = Sum of (Amount * Price) from transactions (Cost Basis) OR User manually updates current prices.
  // Given "understand how much it deviates from target", likely needs CURRENT market value.
  // I will add `currentPrice` to Asset which user can update.
  currentPrice?: number;
}

export interface PortfolioSummary {
  totalValue: number;
  totalCost: number;
  allocation: {
    [key in TransactionType]: number; // Percentage 0-100
  };
}

export interface Target {
  ticker: string;
  targetPercentage: number; // 0-100
}
