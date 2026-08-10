import React from 'react';
import type { PortfolioSnapshot } from '../../utils/relocationSnapshot';
import { GoalDistributionChart } from '../Dashboard/AllocationCharts';

const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;
const signedEur = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${eur0(Math.abs(v))}`;
const signedPct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} pp`;

const deltaClass = (v: number, invert = false) => {
    if (Math.abs(v) < 0.5) return 'reloc-delta-zero';
    const good = invert ? v < 0 : v > 0;
    return good ? 'reloc-delta-positive' : 'reloc-delta-negative';
};

interface Row {
    label: string;
    before: number;
    after: number;
    /** A drop is the good outcome (e.g. cost basis is not a goal to maximise). */
    neutral?: boolean;
    hint?: string;
}

const CompareTable: React.FC<{ title: string; rows: Row[]; format?: (v: number) => string; deltaFormat?: (v: number) => string }> = ({
    title, rows, format = eur0, deltaFormat = signedEur,
}) => (
    <div className="reloc-card">
        <h3 className="reloc-section-title">{title}</h3>
        <div className="reloc-table-wrap">
            <table className="reloc-table reloc-compare-table">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Before</th>
                        <th>After</th>
                        <th>Change</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(r => {
                        const delta = r.after - r.before;
                        return (
                            <tr key={r.label}>
                                <td>
                                    {r.label}
                                    {r.hint && <span className="reloc-ticker-label">{r.hint}</span>}
                                </td>
                                <td>{format(r.before)}</td>
                                <td>{format(r.after)}</td>
                                <td className={r.neutral ? 'reloc-delta-zero' : deltaClass(delta)}>
                                    {Math.abs(delta) < 0.5 ? '—' : deltaFormat(delta)}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    </div>
);

interface RelocationWhatIfProps {
    before: PortfolioSnapshot;
    after: PortfolioSnapshot;
    /** tax + commissions — should equal the net worth drop. */
    friction: number;
}

const RelocationWhatIf: React.FC<RelocationWhatIfProps> = ({ before, after, friction }) => {
    const headline: Row[] = [
        {
            label: 'Net worth',
            before: before.netWorth,
            after: after.netWorth,
            hint: friction > 0 ? `falls by exactly the friction (${eur0(friction)})` : undefined,
        },
        { label: 'Invested', before: before.invested, after: after.invested },
        { label: 'Liquidity', before: before.liquidity, after: after.liquidity },
        { label: 'Cost basis', before: before.cost, after: after.cost, neutral: true },
        { label: 'Unrealized gains', before: before.unrealizedGain, after: after.unrealizedGain },
        {
            label: 'Realized gains',
            before: before.realizedGain,
            after: after.realizedGain,
            neutral: true,
            hint: 'the sale turns unrealized gain into realized — and taxed',
        },
    ];

    const macroRows: Row[] = before.macro.map(m => {
        const a = after.macro.find(x => x.name === m.name);
        return { label: m.name, before: m.percent, after: a?.percent ?? 0 };
    });

    const portfolioIds = Array.from(new Set([...before.byPortfolio, ...after.byPortfolio].map(p => p.id)));
    const portfolioRows: Row[] = portfolioIds
        .map(id => {
            const b = before.byPortfolio.find(p => p.id === id);
            const a = after.byPortfolio.find(p => p.id === id);
            return { label: b?.name ?? a?.name ?? id, before: b?.value ?? 0, after: a?.value ?? 0 };
        })
        .filter(r => r.before > 0 || r.after > 0)
        .sort((x, y) => y.before - x.before);

    return (
        <>
            <CompareTable title="How the numbers change" rows={headline} />

            <div className="reloc-card">
                <h3 className="reloc-section-title">Macro allocation</h3>
                <div className="reloc-table-wrap">
                    <table className="reloc-table reloc-compare-table">
                        <thead>
                            <tr>
                                <th>Class</th>
                                <th>Before</th>
                                <th>After</th>
                                <th>Change</th>
                                <th>Target</th>
                                <th>Gap vs target</th>
                            </tr>
                        </thead>
                        <tbody>
                            {macroRows.map(r => {
                                const target = before.macro.find(m => m.name === r.label)?.targetPercent ?? 0;
                                const gapBefore = target > 0 ? r.before - target : 0;
                                const gapAfter = target > 0 ? r.after - target : 0;
                                const closer = Math.abs(gapAfter) < Math.abs(gapBefore);
                                return (
                                    <tr key={r.label}>
                                        <td>{r.label}</td>
                                        <td>{r.before.toFixed(1)}%</td>
                                        <td>{r.after.toFixed(1)}%</td>
                                        <td className={deltaClass(r.after - r.before)}>
                                            {Math.abs(r.after - r.before) < 0.05 ? '—' : signedPct(r.after - r.before)}
                                        </td>
                                        <td>{target > 0 ? `${target.toFixed(1)}%` : '—'}</td>
                                        <td className={target > 0 ? (closer ? 'reloc-delta-positive' : 'reloc-delta-negative') : 'reloc-delta-zero'}>
                                            {target > 0 ? `${signedPct(gapAfter)}` : '—'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <p className="reloc-hint">
                    A pension fund is not a class of its own: its value counts 57% as equity and 43% as
                    bonds, exactly as on the Stats page.
                </p>
            </div>

            {portfolioRows.length > 0 && (
                <CompareTable title="Value by portfolio" rows={portfolioRows} />
            )}

            {before.goalPyramid.length > 0 && (
                <div className="reloc-card">
                    <h3 className="reloc-section-title">Goal pyramid</h3>
                    <div className="reloc-pyramids">
                        <GoalDistributionChart data={before.goalPyramid} total={before.goalPyramidTotal} title="Before" />
                        <GoalDistributionChart data={after.goalPyramid} total={after.goalPyramidTotal} title="After" />
                    </div>
                    <p className="reloc-hint">
                        The pyramid total is net worth: after the move it is{' '}
                        {eur0(before.goalPyramidTotal - after.goalPyramidTotal)} lower, which is exactly tax plus
                        commissions. That is the cost the ordinary views never show.
                    </p>
                </div>
            )}
        </>
    );
};

export default RelocationWhatIf;
