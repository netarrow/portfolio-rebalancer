import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { usePortfolio } from '../../context/PortfolioContext';
import './Dashboard.css';

const RADIAN = Math.PI / 180;
const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) => {
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return percent > 0.05 ? (
        <text x={x} y={y} fill="white" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={12} style={{ pointerEvents: 'none' }}>
            {`${(percent * 100).toFixed(0)}%`}
        </text>
    ) : null;
};

// Custom Tooltip
const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload;
        return (
            <div className="custom-chart-tooltip">
                <p className="label"><strong>{data.name}</strong></p>
                <p className="value">€{data.value.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                <p className="percent">{data.percent ? `${(data.percent * 100).toFixed(1)}%` : ''}</p>
            </div>
        );
    }
    return null;
};

const AllocationCharts: React.FC = () => {
    const { assets, summary } = usePortfolio();

    // 1. Group by Asset Class
    const classData = useMemo(() => {
        const grouped: Record<string, number> = {};
        assets.filter(a => a.currentValue > 0).forEach(asset => {
            const cls = asset.assetClass || 'Other';
            grouped[cls] = (grouped[cls] || 0) + asset.currentValue;
        });

        return Object.entries(grouped)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value); // Descending
    }, [assets]);

    // 2. Group by Asset SubClass
    const subClassData = useMemo(() => {
        const grouped: Record<string, number> = {};
        assets.filter(a => a.currentValue > 0).forEach(asset => {
            const sub = asset.assetSubClass || 'Other';
            // Optional: combine Class + Subclass for uniqueness if needed, but simple name is fine for now
            grouped[sub] = (grouped[sub] || 0) + asset.currentValue;
        });

        return Object.entries(grouped)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value);
    }, [assets]);

    // 3. Group by Asset Name (Ticker or Label)
    const nameData = useMemo(() => {
        return assets
            .filter(a => a.currentValue > 0)
            .map(a => ({ name: a.label || a.ticker, value: a.currentValue }))
            .sort((a, b) => b.value - a.value);
    }, [assets]);


    // Colors (consistent palette)
    // Matches Dashboard.css logic usually, but defined here for Recharts
    const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6'];

    if (summary.totalValue === 0) return null;

    return (
        <div className="charts-section">
            <h3 className="section-title">Portfolio Distribution</h3>

            <div className="charts-grid">
                {/* By Class */}
                <div className="chart-card">
                    <h4>By Class</h4>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={classData}
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    label={renderCustomizedLabel}
                                    outerRadius={80}
                                    fill="#8884d8"
                                    dataKey="value"
                                >
                                    {classData.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip />} />
                                <Legend wrapperStyle={{ fontSize: '12px' }} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* By Subclass */}
                <div className="chart-card">
                    <h4>By Subclass</h4>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={subClassData}
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    label={renderCustomizedLabel}
                                    outerRadius={80}
                                    fill="#8884d8"
                                    dataKey="value"
                                >
                                    {subClassData.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[(index + 2) % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip />} />
                                <Legend wrapperStyle={{ fontSize: '12px' }} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                {/* By Name */}
                <div className="chart-card">
                    <h4>By Asset</h4>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={nameData}
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    // label={renderCustomizedLabel} // Might be too crowded for names
                                    outerRadius={80}
                                    fill="#8884d8"
                                    dataKey="value"
                                >
                                    {nameData.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip />} />
                                <Legend wrapperStyle={{ fontSize: '12px' }} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AllocationCharts;
