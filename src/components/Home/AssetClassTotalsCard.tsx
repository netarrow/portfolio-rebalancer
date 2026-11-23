import React, { useMemo, useState } from 'react';
import type { Asset } from '../../types';
import { PENSION_FUND_BOND_SHARE, PENSION_FUND_EQUITY_SHARE } from '../../utils/macroAggregation';

const eur = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;
const signedEur = (v: number) => `${v >= 0 ? '+' : '−'}${eur(Math.abs(v))}`;

const MACRO_COLORS: Record<string, string> = {
    Stock: '#6366f1', Bond: '#10b981', Commodity: '#f59e0b', Crypto: '#ec4899', Cash: '#64748b',
};
const MACRO_LABEL: Record<string, string> = { Stock: 'Equity', Bond: 'Bonds', Commodity: 'Commodities', Crypto: 'Crypto', Cash: 'Cash' };
const ORDER = ['Stock', 'Bond', 'Commodity', 'Crypto', 'Cash'];
const STORAGE_KEY = 'home.assetClassTotals.includeCash';

interface ClassRow {
    key: string;
    value: number;
    cost: number;
    /** Subclass -> EUR, for the detail line. */
    subs: Record<string, number>;
}

const readPref = (): boolean => {
    try { return localStorage.getItem(STORAGE_KEY) !== 'false'; } catch { return true; }
};

/**
 * Euro totals per macro asset class, with the same conventions as the Stats
 * macro readout (a pension fund split 57/43 between equity and bonds). Cash —
 * broker liquidity plus cash-like holdings — can be left out, so the shares
 * then read as the split of the invested part only.
 */
const AssetClassTotalsCard: React.FC<{ assets: Asset[]; liquidity: number; onOpen: () => void }> = ({ assets, liquidity, onOpen }) => {
    const [includeCash, setIncludeCash] = useState(readPref);
    const toggleCash = () => {
        const next = !includeCash;
        setIncludeCash(next);
        try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* preference only */ }
    };

    const rows = useMemo(() => {
        const byClass: Record<string, ClassRow> = {};
        const add = (cls: string, sub: string, value: number, cost: number) => {
            const row = byClass[cls] ??= { key: cls, value: 0, cost: 0, subs: {} };
            row.value += value;
            row.cost += cost;
            if (sub) row.subs[sub] = (row.subs[sub] || 0) + value;
        };
        assets.forEach(a => {
            if (!a.currentValue) return;
            const cost = a.quantity * a.averagePrice;
            if (a.assetClass === 'PensionFund') {
                add('Stock', 'Pension fund', a.currentValue * PENSION_FUND_EQUITY_SHARE, cost * PENSION_FUND_EQUITY_SHARE);
                add('Bond', 'Pension fund', a.currentValue * PENSION_FUND_BOND_SHARE, cost * PENSION_FUND_BOND_SHARE);
            } else if (ORDER.includes(a.assetClass)) {
                add(a.assetClass, a.assetClass === 'Cash' ? 'Cash holdings' : a.assetSubClass || '', a.currentValue, cost);
            }
        });
        if (liquidity > 0) add('Cash', 'Broker cash', liquidity, liquidity);
        return ORDER.map(k => byClass[k]).filter((r): r is ClassRow => !!r && r.value > 0.5);
    }, [assets, liquidity]);

    const hasCash = rows.some(r => r.key === 'Cash');
    const shown = includeCash ? rows : rows.filter(r => r.key !== 'Cash');
    const total = shown.reduce((s, r) => s + r.value, 0);

    if (rows.length === 0) return null;

    return (
        <section className="home-card">
            <div className="home-card-head">
                <h3>Asset class totals</h3>
                <div className="home-actotals-tools">
                    {hasCash && (
                        <label className="home-actotals-toggle">
                            <input type="checkbox" checked={includeCash} onChange={toggleCash} />
                            Include cash
                        </label>
                    )}
                    <button type="button" className="home-link-inline" onClick={onOpen}>Stats →</button>
                </div>
            </div>
            <span className="home-muted">
                {includeCash ? 'Market value per asset class, broker cash included' : 'Market value per asset class, cash left out'}
                {' · pension funds split 57% equity / 43% bonds'}
            </span>
            <ul className="home-ptotals">
                {shown.map(r => {
                    const share = total > 0 ? (r.value / total) * 100 : 0;
                    const gain = r.value - r.cost;
                    const gainPct = r.cost > 0 ? (gain / r.cost) * 100 : null;
                    const subs = Object.entries(r.subs).filter(([, v]) => v >= 1).sort((a, b) => b[1] - a[1]);
                    const color = MACRO_COLORS[r.key] ?? '#94a3b8';
                    return (
                        <li key={r.key}>
                            <div className="home-bucket-top">
                                <span className="home-ptotals-name"><span className="home-dot" style={{ background: color }} />{MACRO_LABEL[r.key] ?? r.key}</span>
                                <b className="home-ptotals-value">{eur(r.value)}</b>
                            </div>
                            <div className="home-bar"><span style={{ width: `${share}%`, background: color }} /></div>
                            <span className="home-muted">
                                {share.toFixed(1)}% of total
                                {r.key !== 'Cash' && Math.abs(gain) >= 1 && (
                                    <span className={gain >= 0 ? 'home-ptotals-up' : 'home-ptotals-down'}>
                                        {' · '}{signedEur(gain)}{gainPct != null && ` (${gainPct >= 0 ? '+' : '−'}${Math.abs(gainPct).toFixed(1)}%)`}
                                    </span>
                                )}
                            </span>
                            {subs.length > 1 && (
                                <span className="home-muted home-actotals-subs">
                                    {subs.map(([s, v]) => `${s} ${eur(v)}`).join(' · ')}
                                </span>
                            )}
                        </li>
                    );
                })}
            </ul>
            <div className="home-bucket-top home-ptotals-sum">
                <span>{includeCash || !hasCash ? 'Total' : 'Total invested'}</span>
                <b className="home-ptotals-value">{eur(total)}</b>
            </div>
        </section>
    );
};

export default AssetClassTotalsCard;
