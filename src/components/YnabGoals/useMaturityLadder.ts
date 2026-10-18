import { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { isVirtualBondTicker, getVirtualBondId } from '../../types';
import { calculateAssets, isCashTicker } from '../../utils/portfolioCalculations';
import { buildMaturityLadder, maturityFromLabel, type LadderHolding, type MaturityLadder } from '../../utils/maturityLadder';

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/**
 * The capex maturity ladder over every portfolio a capex is allocated to, and
 * the bonds held whose maturity is not known yet (to look up).
 */
export const useMaturityLadder = (): { ladder: MaturityLadder; unknownMaturity: { ticker: string; label: string }[] } => {
    const { portfolios, transactions, effectiveAssetSettings, marketData, virtualBonds, ynabGoals, ynabGoalAllocations } = usePortfolio();

    return useMemo(() => {
        const defByTicker = new Map(effectiveAssetSettings.map(d => [d.ticker.toUpperCase(), d]));
        const used = new Set(ynabGoalAllocations.map(a => a.portfolioId));
        const unknown = new Map<string, string>();
        const ladderPortfolios = portfolios.filter(p => used.has(p.id)).map(p => {
            const { assets } = calculateAssets(transactions.filter(t => t.portfolioId === p.id), effectiveAssetSettings, marketData);
            // A pension fund cannot be sold to pay a capex: it is left out.
            const holdings: LadderHolding[] = assets.filter(a => a.currentValue > 0 && a.assetClass !== 'PensionFund').map(a => {
                const label = a.label || a.ticker;
                if (isCashTicker(a.ticker)) return { key: a.ticker, label: 'Cash', value: a.currentValue, kind: 'cash' as const };
                if (isVirtualBondTicker(a.ticker)) {
                    const vb = virtualBonds.find(b => b.id === getVirtualBondId(a.ticker));
                    return { key: a.ticker, label: vb?.label ?? label, value: a.currentValue, kind: 'cash' as const, plannedBond: !vb?.resolvedIsin, maturityDate: vb?.targetMaturityDate };
                }
                const def = defByTicker.get(a.ticker.toUpperCase());
                const maturityDate = def?.maturityDate ?? maturityFromLabel(label);
                if (a.assetClass === 'Bond' && maturityDate) return { key: a.ticker, label, value: a.currentValue, kind: 'bond' as const, maturityDate };
                // A bond ISIN with no maturity yet: counted as sellable until looked up.
                if (a.assetClass === 'Bond' && ISIN_RE.test(a.ticker.toUpperCase()) && def?.source !== 'ETF') unknown.set(a.ticker.toUpperCase(), label);
                return { key: a.ticker, label, value: a.currentValue, kind: 'liquid' as const };
            });
            if ((p.liquidity || 0) > 0) holdings.push({ key: '_LIQ_', label: 'Portfolio cash', value: p.liquidity!, kind: 'cash' });
            // Virtual bonds a capex is pinned to with nothing parked yet: still a plan.
            ynabGoalAllocations
                .filter(a => a.portfolioId === p.id && a.ticker && isVirtualBondTicker(a.ticker) && !holdings.some(h => h.key === a.ticker))
                .forEach(a => {
                    const vb = virtualBonds.find(b => b.id === getVirtualBondId(a.ticker!));
                    if (vb && !vb.resolvedIsin) holdings.push({ key: a.ticker!, label: vb.label, value: 0, kind: 'cash', plannedBond: true, maturityDate: vb.targetMaturityDate });
                });
            return { id: p.id, name: p.name, holdings };
        });
        return {
            ladder: buildMaturityLadder({ portfolios: ladderPortfolios, goals: ynabGoals, allocations: ynabGoalAllocations }),
            unknownMaturity: [...unknown.entries()].map(([ticker, label]) => ({ ticker, label })),
        };
    }, [portfolios, transactions, effectiveAssetSettings, marketData, virtualBonds, ynabGoals, ynabGoalAllocations]);
};
