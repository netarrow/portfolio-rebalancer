import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { getAssetGoal } from '../../utils/goalCalculations';
import type { FinancialGoal } from '../../utils/goalCalculations';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];
const CLASS_ORDER = ['Stock', 'Bond', 'Commodity', 'Crypto', 'PensionFund'];

const fmt = (v: number) => `€${Math.round(v).toLocaleString('it-IT')}`;

const MacroStats: React.FC = () => {
    const { assets, brokers, macroAllocations, goalAllocations, assetSettings } = usePortfolio();

    const [simulatedValues, setSimulatedValues] = useState<Record<string, number> | null>(null);
    const [includeCash, setIncludeCash] = useState(true);

    const stats = useMemo(() => {
        const totalInvested = assets.reduce((sum, a) => sum + (a.currentValue || 0), 0);
        const currentLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
        const totalValue = totalInvested + currentLiquidity;

        if (totalValue === 0) return null;

        // Build subclass-level EUR values (always include cash/liquidity in euros)
        const subclassValues: Record<string, number> = {};
        const macroValues: Record<string, number> = { Stock: 0, Bond: 0, Commodity: 0, Crypto: 0, Cash: 0 };
        const goalValues: Record<string, number> = { Growth: 0, Protection: 0, Security: 0 };

        assets.forEach(asset => {
            if (!asset.currentValue) return;

            const cls = asset.assetClass;
            const sub = asset.assetSubClass || '';

            if (cls === 'PensionFund') {
                const key = 'PensionFund:Balanced';
                subclassValues[key] = (subclassValues[key] || 0) + asset.currentValue;
                macroValues['Stock'] += asset.currentValue * 0.6;
                macroValues['Bond'] += asset.currentValue * 0.4;
            } else if (cls === 'Crypto') {
                subclassValues['Crypto'] = (subclassValues['Crypto'] || 0) + asset.currentValue;
                macroValues['Crypto'] += asset.currentValue;
            } else if (cls === 'Cash') {
                subclassValues['Cash'] = (subclassValues['Cash'] || 0) + asset.currentValue;
                macroValues['Cash'] += asset.currentValue;
            } else if (macroValues[cls] !== undefined) {
                const key = sub ? `${cls}:${sub}` : cls;
                subclassValues[key] = (subclassValues[key] || 0) + asset.currentValue;
                macroValues[cls] += asset.currentValue;
            }

            const goal = getAssetGoal(cls, sub);
            if (goalValues[goal] !== undefined) goalValues[goal] += asset.currentValue;
        });

        subclassValues['Cash'] = (subclassValues['Cash'] || 0) + currentLiquidity;
        macroValues['Cash'] = (macroValues['Cash'] || 0) + currentLiquidity;
        goalValues['Protection'] += currentLiquidity;

        const macros = Object.entries(macroValues).map(([key, value]) => {
            const target = (macroAllocations as any)[key] || 0;
            return { name: key, currentValue: value, targetPercent: target };
        });

        const goals = Object.entries(goalValues).map(([key, value]) => {
            const target = goalAllocations[key as FinancialGoal] || 0;
            return { name: key, currentValue: value, targetPercent: target };
        });

        const goalColors: Record<string, string> = { Growth: '#3B82F6', Protection: '#10B981', Security: '#8B5CF6' };
        const goalProjected = Object.entries(goalValues)
            .map(([key, value]) => ({ name: key, value, color: goalColors[key] || '#9CA3AF' }))
            .filter(d => d.value > 0);

        const stepSize = Math.max(10, Math.round(totalValue / 1000 / 10) * 10);

        return { totalInvested, totalValue, currentLiquidity, macros, goals, goalProjected, subclassValues, stepSize };
    }, [assets, brokers, macroAllocations, goalAllocations, assetSettings]);

    // Effective EUR values per subclass (simulated or actual)
    const effectiveValues = useMemo(() => {
        if (simulatedValues) return simulatedValues;
        const result: Record<string, number> = {};
        if (stats) {
            Object.assign(result, stats.subclassValues);
            if (!result['Cash']) result['Cash'] = 0;
        }
        return result;
    }, [simulatedValues, stats]);

    // Slider groups: subclasses grouped by parent class
    const sliderGroups = useMemo(() => {
        const groups: Record<string, { key: string; label: string }[]> = {};
        Object.keys(effectiveValues).forEach(key => {
            if (key === 'Cash') return;
            const [parentClass, subClass] = key.split(':');
            if (!groups[parentClass]) groups[parentClass] = [];
            groups[parentClass].push({ key, label: subClass || parentClass });
        });
        return CLASS_ORDER
            .filter(cls => groups[cls])
            .map(cls => ({ class: cls, items: groups[cls] }));
    }, [effectiveValues]);

    // Chart data: aggregate subclass EUR values back to macro class
    // Toggle controls both the chart denominator AND whether Cash is shown
    const chartData = useMemo(() => {
        if (!stats) return [];
        const macroMap: Record<string, number> = { Stock: 0, Bond: 0, Commodity: 0, Crypto: 0, Cash: 0 };
        const actualMap: Record<string, number> = { Stock: 0, Bond: 0, Commodity: 0, Crypto: 0, Cash: 0 };

        Object.entries(effectiveValues).forEach(([key, value]) => {
            if (key === 'Cash') { macroMap['Cash'] += value; return; }
            if (key === 'Crypto') { macroMap['Crypto'] += value; return; }
            if (key.startsWith('PensionFund')) { macroMap['Stock'] += value * 0.6; macroMap['Bond'] += value * 0.4; return; }
            const [cls] = key.split(':');
            if (macroMap[cls] !== undefined) macroMap[cls] += value;
        });

        Object.entries(stats.subclassValues).forEach(([key, value]) => {
            if (key === 'Cash') { actualMap['Cash'] += value; return; }
            if (key === 'Crypto') { actualMap['Crypto'] += value; return; }
            if (key.startsWith('PensionFund')) { actualMap['Stock'] += value * 0.6; actualMap['Bond'] += value * 0.4; return; }
            const [cls] = key.split(':');
            if (actualMap[cls] !== undefined) actualMap[cls] += value;
        });

        const effectiveTotal = Object.values(macroMap).reduce((s, v) => s + v, 0);
        const effectiveInvested = effectiveTotal - (macroMap['Cash'] || 0);
        const denominator = includeCash ? effectiveTotal : effectiveInvested;

        const actualTotal = Object.values(actualMap).reduce((s, v) => s + v, 0);
        const actualInvested = actualTotal - (actualMap['Cash'] || 0);
        const actualDenominator = includeCash ? actualTotal : actualInvested;

        return stats.macros
            .filter(m => includeCash || m.name !== 'Cash')
            .map(m => ({
                name: m.name,
                currentValue: macroMap[m.name] || 0,
                currentPercent: denominator > 0 ? ((macroMap[m.name] || 0) / denominator) * 100 : 0,
                actualPercent: actualDenominator > 0 ? ((actualMap[m.name] || 0) / actualDenominator) * 100 : 0,
            }))
            .filter(m => m.currentValue > 0 || (actualMap[m.name] || 0) > 0);
    }, [stats, effectiveValues, includeCash]);

    const handleSliderChange = (key: string, newValue: number) => {
        const oldValue = effectiveValues[key] || 0;
        const delta = newValue - oldValue;
        const currentCash = effectiveValues['Cash'] || 0;
        const actualDelta = delta > 0 ? Math.min(delta, currentCash) : delta;
        setSimulatedValues({
            ...effectiveValues,
            [key]: Math.max(0, oldValue + actualDelta),
            Cash: Math.max(0, currentCash - actualDelta),
        });
    };

    const isSimulated = simulatedValues !== null;

    if (!stats) return null;

    const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) => {
        const RADIAN = Math.PI / 180;
        const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
        const x = cx + radius * Math.cos(-midAngle * RADIAN);
        const y = cy + radius * Math.sin(-midAngle * RADIAN);
        return percent > 0.05 ? (
            <text x={x} y={y} fill="white" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central">
                {`${(percent * 100).toFixed(0)}%`}
            </text>
        ) : null;
    };

    const cashValue = effectiveValues['Cash'] || 0;

    return (
        <div className="macro-stats-section">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '2rem 0 1rem' }}>
                <h2 className="section-title" style={{ fontSize: '1.5rem', margin: 0 }}>Macro Allocation Analysis</h2>
                {isSimulated && (
                    <span style={{
                        fontSize: '0.75rem', padding: '0.2rem 0.6rem', borderRadius: '999px',
                        backgroundColor: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B',
                        fontWeight: 600, letterSpacing: '0.03em'
                    }}>Simulazione</span>
                )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem', alignItems: 'start' }}>

            {/* Allocation Simulator */}
            <div className="card" style={{ padding: '1.25rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                    <h4 style={{ margin: 0, fontSize: '1rem' }}>Allocation Simulator</h4>
                    {isSimulated && (
                        <button onClick={() => setSimulatedValues(null)} style={{
                            fontSize: '0.8rem', padding: '0.3rem 0.75rem', borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-input)',
                            color: 'var(--text-muted)', cursor: 'pointer', fontWeight: 500
                        }}>Reset</button>
                    )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    {sliderGroups.map(group => (
                        <div key={group.class}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                                {group.class}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                {group.items.map(item => {
                                    const val = effectiveValues[item.key] || 0;
                                    const maxVal = val + cashValue;
                                    const pct = stats.totalValue > 0 ? (val / stats.totalValue) * 100 : 0;
                                    return (
                                        <div key={item.key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 90px', alignItems: 'center', gap: '0.75rem' }}>
                                            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{item.label}</span>
                                            <input
                                                type="range"
                                                min={0}
                                                max={Math.max(maxVal, val)}
                                                step={stats.stepSize}
                                                value={val}
                                                onChange={e => handleSliderChange(item.key, parseFloat(e.target.value))}
                                                style={{ width: '100%', accentColor: 'var(--color-primary)', cursor: 'pointer' }}
                                            />
                                            <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
                                                <div style={{ fontSize: '0.82rem', color: 'var(--text-primary)' }}>{fmt(val)}</div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{pct.toFixed(1)}%</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}

                    {/* Cash — read only, always visible */}
                    <div>
                        <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.5rem' }}>
                            Cash
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 90px', alignItems: 'center', gap: '0.75rem' }}>
                            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Liquidity</span>
                            <div style={{ position: 'relative', height: '6px', borderRadius: '3px', backgroundColor: 'var(--border-color)', overflow: 'hidden' }}>
                                <div style={{
                                    position: 'absolute', left: 0, top: 0, height: '100%',
                                    width: `${stats.totalValue > 0 ? Math.min(100, (cashValue / stats.totalValue) * 100) : 0}%`,
                                    backgroundColor: '#10B981', borderRadius: '3px', transition: 'width 0.15s ease'
                                }} />
                            </div>
                            <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
                                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{fmt(cashValue)}</div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{stats.totalValue > 0 ? ((cashValue / stats.totalValue) * 100).toFixed(1) : '0.0'}%</div>
                            </div>
                        </div>
                    </div>
                </div>

                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '1rem', marginBottom: 0 }}>
                    Abbassa uno slider per aumentare la quota Cash. Alza uno slider per usare la liquidità disponibile. I dati reali non vengono modificati.
                </p>
            </div>

            <div className="card" style={{ padding: '1.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3>Asset Allocation</h3>
                        <button onClick={() => setIncludeCash(v => !v)} style={{
                            fontSize: '0.8rem', padding: '0.3rem 0.75rem', borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border-color)',
                            backgroundColor: includeCash ? 'var(--color-primary)' : 'var(--bg-input)',
                            color: includeCash ? '#fff' : 'var(--text-muted)',
                            cursor: 'pointer', fontWeight: 500, transition: 'all 0.2s'
                        }}>{includeCash ? '+ Liquidità' : 'Solo Investito'}</button>
                    </div>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie data={chartData} dataKey="currentValue" nameKey="name" cx="50%" cy="50%" labelLine={false} label={renderCustomizedLabel} outerRadius={80}>
                                    {chartData.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip formatter={(value: number | undefined) => `€${(value || 0).toLocaleString('it-IT', { maximumFractionDigits: 0 })}`} />
                                <Legend />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                    <table style={{ width: '100%', marginTop: '1rem', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                                <th style={{ padding: '0.5rem' }}>Class</th>
                                <th style={{ textAlign: 'right' }}>Actual</th>
                                {isSimulated && <th style={{ textAlign: 'right', color: 'var(--color-primary)' }}>Simulato</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {chartData.map(m => (
                                <tr key={m.name} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '0.5rem' }}>{m.name}</td>
                                    <td style={{ textAlign: 'right' }}>{m.actualPercent.toFixed(1)}%</td>
                                    {isSimulated && (
                                        <td style={{
                                            textAlign: 'right',
                                            color: Math.abs(m.currentPercent - m.actualPercent) > 0.1 ? 'var(--color-primary)' : 'var(--text-muted)',
                                            fontWeight: 500
                                        }}>
                                            {m.currentPercent.toFixed(1)}%
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default MacroStats;
