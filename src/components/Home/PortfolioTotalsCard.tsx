import React, { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets, injectCashAssets, isCashTicker } from '../../utils/portfolioCalculations';
import { buildPortfolioTree } from '../../utils/portfolioGroups';

const eur = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;
const signedEur = (v: number) => `${v >= 0 ? '+' : '−'}${eur(Math.abs(v))}`;

interface Row {
    id: string;
    name: string;
    depth: number;
    invested: number;
    cash: number;
    total: number;
    gain: number;
    gainPct: number | null;
}

/**
 * Euro totals for every portfolio, in the Dashboard convention: invested value
 * plus the broker cash earmarked for it. Children sit indented under their
 * parent, with the group subtotal on the parent row's side.
 */
const PortfolioTotalsCard: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
    const { portfolios, scopedTransactions, scopedBrokers, effectiveAssetSettings, marketData } = usePortfolio();

    const { rows, groupTotals, grandTotal, unassigned } = useMemo(() => {
        const rowOf = (id: string, name: string, depth: number): Row => {
            const txs = scopedTransactions.filter(t => t.portfolioId === id);
            const { summary } = calculateAssets(txs, effectiveAssetSettings, marketData);
            const cash = injectCashAssets([], scopedBrokers, id)
                .filter(a => isCashTicker(a.ticker))
                .reduce((s, a) => s + a.currentValue, 0);
            const gain = summary.totalValue - summary.totalCost;
            return {
                id, name, depth,
                invested: summary.totalValue, cash, total: summary.totalValue + cash, gain,
                gainPct: summary.totalCost > 0 ? (gain / summary.totalCost) * 100 : null,
            };
        };

        const { groups, standalones } = buildPortfolioTree(portfolios);
        const groupByParent = new Map(groups.map(g => [g.parent.id, g]));
        const roots = [...groups.map(g => g.parent), ...standalones].sort((a, b) => a.order - b.order);

        const rows: Row[] = [];
        const groupTotals: Record<string, number> = {};
        roots.forEach(root => {
            const group = groupByParent.get(root.id);
            if (!group) { rows.push(rowOf(root.id, root.name, 0)); return; }
            const members = [rowOf(root.id, root.name, 0), ...group.children.map(c => rowOf(c.id, c.name, 1))];
            groupTotals[root.id] = members.reduce((s, r) => s + r.total, 0);
            rows.push(...members);
        });

        const known = new Set(portfolios.map(p => p.id));
        const orphanTxs = scopedTransactions.filter(t => !t.portfolioId || !known.has(t.portfolioId));
        const unassigned = orphanTxs.length > 0 ? calculateAssets(orphanTxs, effectiveAssetSettings, marketData).summary.totalValue : 0;

        const grandTotal = rows.reduce((s, r) => s + r.total, 0) + unassigned;
        return { rows, groupTotals, grandTotal, unassigned };
    }, [portfolios, scopedTransactions, scopedBrokers, effectiveAssetSettings, marketData]);

    if (rows.length === 0) return null;

    return (
        <section className="home-card">
            <div className="home-card-head">
                <h3>Portfolios</h3>
                <button type="button" className="home-link-inline" onClick={onOpen}>Portfolios →</button>
            </div>
            <span className="home-muted">Invested value plus the broker cash earmarked for each portfolio</span>
            <ul className="home-ptotals">
                {rows.map(r => {
                    const share = grandTotal > 0 ? (r.total / grandTotal) * 100 : 0;
                    const groupTotal = groupTotals[r.id];
                    return (
                        <li key={r.id} className={r.depth > 0 ? 'is-child' : undefined}>
                            <div className="home-bucket-top">
                                <span className="home-ptotals-name">
                                    {r.depth > 0 && <span className="home-muted" aria-hidden>↳ </span>}
                                    {r.name}
                                    {groupTotal != null && <span className="home-muted"> · group {eur(groupTotal)}</span>}
                                </span>
                                <b className="home-ptotals-value">{eur(r.total)}</b>
                            </div>
                            <div className="home-bar"><span style={{ width: `${share}%`, background: 'var(--color-primary)' }} /></div>
                            <span className="home-muted">
                                {share.toFixed(1)}% of total
                                {r.cash >= 1 && ` · ${eur(r.invested)} invested + ${eur(r.cash)} cash`}
                                {r.invested >= 1 && (
                                    <span className={r.gain >= 0 ? 'home-ptotals-up' : 'home-ptotals-down'}>
                                        {' · '}{signedEur(r.gain)}{r.gainPct != null && ` (${r.gainPct >= 0 ? '+' : '−'}${Math.abs(r.gainPct).toFixed(1)}%)`}
                                    </span>
                                )}
                            </span>
                        </li>
                    );
                })}
                {unassigned >= 1 && (
                    <li>
                        <div className="home-bucket-top">
                            <span className="home-ptotals-name home-muted">Not assigned to a portfolio</span>
                            <b className="home-ptotals-value">{eur(unassigned)}</b>
                        </div>
                    </li>
                )}
            </ul>
            <div className="home-bucket-top home-ptotals-sum">
                <span>Total</span>
                <b className="home-ptotals-value">{eur(grandTotal)}</b>
            </div>
        </section>
    );
};

export default PortfolioTotalsCard;
