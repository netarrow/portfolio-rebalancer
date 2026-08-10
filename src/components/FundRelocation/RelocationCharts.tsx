import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import type { SliceLine } from '../../utils/relocationSnapshot';

/**
 * The Stats page charts, drawn twice: as they are now and as the relocation
 * would leave them.
 *
 * The one rule that makes the pair readable is that a category keeps its colour
 * across both pies. Colouring by array index — which is what every pie on the
 * Stats page does, because it only ever draws one — would recolour every slice
 * as soon as the move changes the sort order, and the comparison would be
 * worthless. So the palette is assigned from the union of both sides, in the
 * BEFORE ordering, and looked up by name.
 */

const PALETTE = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6', '#F97316'];

/** Fixed colours for the two pies whose categories are known and meaningful. */
const FIXED_COLORS: Record<string, string> = {
    Invested: '#3B82F6',
    Liquidity: '#10B981',
    Stock: '#3B82F6',
    Bond: '#10B981',
    Commodity: '#F59E0B',
    Crypto: '#8B5CF6',
    Cash: '#6B7280',
};

const eur0 = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;

const buildColorMap = (before: SliceLine[], after: SliceLine[]): Record<string, string> => {
    const map: Record<string, string> = {};
    let next = 0;
    [...before, ...after].forEach(slice => {
        if (map[slice.name]) return;
        map[slice.name] = FIXED_COLORS[slice.name] ?? PALETTE[next++ % PALETTE.length];
    });
    return map;
};

const PieTooltip: React.FC<{ active?: boolean; payload?: { name: string; value: number }[]; total: number }> = ({
    active, payload, total,
}) => {
    if (!active || !payload?.length) return null;
    const { name, value } = payload[0];
    return (
        <div className="custom-chart-tooltip">
            <div className="label">{name}</div>
            <div className="value">{eur0(value)}</div>
            <div className="percent">{total > 0 ? ((value / total) * 100).toFixed(1) : '0.0'}%</div>
        </div>
    );
};

const RADIAN = Math.PI / 180;

/**
 * Percentages drawn INSIDE the slice, like the Stats pies. Returning a bare
 * string instead would make Recharts place the label outside the radius, where
 * it is clipped by the card in a layout this narrow.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderSliceLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) => {
    if (!(percent > 0.06)) return null;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.55;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);
    return (
        <text
            x={x}
            y={y}
            fill="#fff"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={11}
            fontWeight={600}
            style={{ pointerEvents: 'none' }}
        >
            {`${(percent * 100).toFixed(0)}%`}
        </text>
    );
};

const SinglePie: React.FC<{ caption: string; data: SliceLine[]; colors: Record<string, string> }> = ({
    caption, data, colors,
}) => {
    const total = data.reduce((s, d) => s + d.value, 0);
    return (
        <div className="reloc-pie">
            <div className="reloc-pie-caption">{caption}</div>
            <div style={{ width: '100%', height: 210 }}>
                <ResponsiveContainer>
                    <PieChart>
                        <Pie
                            data={data}
                            cx="50%"
                            cy="50%"
                            outerRadius={78}
                            dataKey="value"
                            labelLine={false}
                            label={renderSliceLabel}
                            isAnimationActive={false}
                        >
                            {data.map(d => (
                                <Cell key={d.name} fill={colors[d.name] ?? '#9CA3AF'} />
                            ))}
                        </Pie>
                        <Tooltip content={<PieTooltip total={total} />} />
                    </PieChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};

interface ComparisonPieProps {
    title: string;
    before: SliceLine[];
    after: SliceLine[];
    hint?: string;
}

/**
 * One Stats chart in before/after form, with a shared legend that carries the
 * euro delta per slice — the pies show the shift in shape, the legend says how
 * much moved.
 */
export const ComparisonPie: React.FC<ComparisonPieProps> = ({ title, before, after, hint }) => {
    const colors = useMemo(() => buildColorMap(before, after), [before, after]);

    const legend = useMemo(() => {
        const names = Array.from(new Set([...before, ...after].map(s => s.name)));
        return names
            .map(name => {
                const b = before.find(s => s.name === name)?.value ?? 0;
                const a = after.find(s => s.name === name)?.value ?? 0;
                return { name, before: b, after: a, delta: a - b };
            })
            .sort((x, y) => y.before - x.before);
    }, [before, after]);

    if (before.length === 0 && after.length === 0) return null;

    return (
        <div className="reloc-chart-card">
            <h4 className="reloc-chart-title">{title}</h4>
            <div className="reloc-pie-pair">
                <SinglePie caption="Before" data={before} colors={colors} />
                <SinglePie caption="After" data={after} colors={colors} />
            </div>
            <div className="reloc-chart-legend">
                {legend.map(l => (
                    <div key={l.name} className="reloc-legend-row">
                        <span className="reloc-legend-dot" style={{ backgroundColor: colors[l.name] ?? '#9CA3AF' }} />
                        <span className="reloc-legend-name">{l.name}</span>
                        <span className="reloc-legend-value">{eur0(l.before)} → {eur0(l.after)}</span>
                        <span
                            className={
                                Math.abs(l.delta) < 0.5
                                    ? 'reloc-legend-delta zero'
                                    : `reloc-legend-delta ${l.delta > 0 ? 'up' : 'down'}`
                            }
                        >
                            {Math.abs(l.delta) < 0.5 ? '—' : `${l.delta > 0 ? '+' : '−'}${eur0(Math.abs(l.delta))}`}
                        </span>
                    </div>
                ))}
            </div>
            {hint && <p className="reloc-hint">{hint}</p>}
        </div>
    );
};

export default ComparisonPie;
