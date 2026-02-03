import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { getAssetGoal } from '../../utils/goalCalculations';
import type { FinancialGoal } from '../../utils/goalCalculations';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import PortfolioPyramid from './PortfolioPyramid';


const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

const MacroStats: React.FC = () => {
    const { assets, brokers, macroAllocations, goalAllocations, portfolios, assetSettings } = usePortfolio();

    const [addedCapital, setAddedCapital] = useState<Record<string, number>>({});

    // 1. Calculate Totals and Allocations
    const stats = useMemo(() => {
        const totalInvested = assets.reduce((sum, a) => sum + (a.currentValue || 0), 0);
        const currentLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);

        let simulatedInvestedTotal = 0;
        let simulatedLiquidityTotal = 0;

        // Process Simulated Capital Injection
        const simulatedMacroAdditions: Record<string, number> = {};
        const simulatedGoalAdditions: Record<string, number> = {};

        portfolios.forEach(portfolio => {
            const addedAmount = addedCapital[portfolio.id] || 0;
            if (addedAmount <= 0) return;

            let portfolioUsedAmount = 0;

            if (portfolio.allocations) {
                Object.entries(portfolio.allocations).forEach(([ticker, percentage]) => {
                    const amount = addedAmount * (percentage / 100);
                    portfolioUsedAmount += amount;

                    // Find Asset Info
                    // 1. Try finding in current assets
                    const asset = assets.find(a => a.ticker === ticker);
                    let assetClass = asset?.assetClass;
                    let assetSubClass = asset?.assetSubClass;

                    // 2. Fallback to settings
                    if (!assetClass) {
                        const setting = assetSettings.find(s => s.ticker === ticker);
                        assetClass = setting?.assetClass;
                        assetSubClass = setting?.assetSubClass;
                    }

                    if (assetClass) {
                        // Add to Macro
                        simulatedMacroAdditions[assetClass] = (simulatedMacroAdditions[assetClass] || 0) + amount;
                        simulatedInvestedTotal += amount;

                        // Add to Goal
                        const goal = getAssetGoal(assetClass, assetSubClass);
                        simulatedGoalAdditions[goal] = (simulatedGoalAdditions[goal] || 0) + amount;
                    } else {
                        // If we can't identify the asset, treat as unallocated/liquidity for safety? 
                        // Or just ignore? Let's treat as Liquidity to preserve total value correctness.
                        console.warn(`Could not identify class for ticker ${ticker} in portfolio ${portfolio.name}`);
                        simulatedLiquidityTotal += amount;
                    }
                });
            }

            // Remainder (if allocations < 100%) goes to Liquidity
            const remainder = addedAmount - portfolioUsedAmount;
            if (remainder > 0) {
                simulatedLiquidityTotal += remainder;
            }
        });

        const effectiveLiquidity = currentLiquidity + simulatedLiquidityTotal;
        // Total Value = Existing Invested + Existing Liquidity + All Simulated Added Capital
        // (simulatedInvestedTotal is part of the added capital)
        // (simulatedLiquidityTotal is the other part)
        const totalValue = totalInvested + currentLiquidity + (simulatedInvestedTotal + simulatedLiquidityTotal);

        if (totalValue === 0) return null;

        // Init Aggregators
        // Use maps to store value
        const macroValues: Record<string, number> = { 'Stock': 0, 'Bond': 0, 'Commodity': 0, 'Crypto': 0, 'Cash': 0 };
        const goalValues: Record<string, number> = { 'Growth': 0, 'Protection': 0, 'Security': 0 };

        // Process Existing Assets
        assets.forEach(asset => {
            if (!asset.currentValue) return;

            // Macro
            if (macroValues[asset.assetClass] !== undefined) {
                macroValues[asset.assetClass] += asset.currentValue;
            }

            // Goal
            const goal = getAssetGoal(asset.assetClass, asset.assetSubClass);
            if (goalValues[goal] !== undefined) {
                goalValues[goal] += asset.currentValue;
            }
        });

        // Add Simulated Values
        Object.entries(simulatedMacroAdditions).forEach(([key, value]) => {
            if (macroValues[key] !== undefined) macroValues[key] += value;
        });

        Object.entries(simulatedGoalAdditions).forEach(([key, value]) => {
            if (goalValues[key] !== undefined) goalValues[key] += value;
        });

        // Add Liquidity to Protection
        goalValues['Protection'] += effectiveLiquidity;

        // Prepare Data for Charts & Recommendations
        const totalInvestedWithSimulation = totalInvested + simulatedInvestedTotal;
        const macros = Object.entries(macroValues).map(([key, value]) => {
            const target = (macroAllocations as any)[key] || 0;
            const currentPercent = totalInvestedWithSimulation > 0 ? (value / totalInvestedWithSimulation) * 100 : 0;
            const diffPercent = currentPercent - target;
            const diffValue = totalInvestedWithSimulation * (target / 100) - value;

            return {
                name: key,
                currentValue: value,
                currentPercent,
                targetPercent: target,
                diffPercent,
                diffValue,
                action: diffValue > 0 ? 'Buy' : 'Sell'
            };
        });

        const goals = Object.entries(goalValues).map(([key, value]) => {
            const target = goalAllocations[key as FinancialGoal] || 0;
            const currentPercent = (value / totalValue) * 100;
            const diffPercent = currentPercent - target;
            const diffValue = totalValue * (target / 100) - value;

            return {
                name: key,
                currentValue: value,
                currentPercent,
                targetPercent: target,
                diffPercent,
                diffValue,
                action: diffValue > 0 ? 'Buy' : 'Sell'
            };
        });

        // Goals Target (for Pyramid)
        const goalColors: Record<string, string> = {
            'Growth': '#3B82F6',      // Blue
            'Protection': '#10B981',  // Green (Includes Liquidity)
            'Security': '#8B5CF6',    // Purple (Bond/Medium-Long)
        };

        const goalProjected = (() => {
            const tempProjected: Record<string, number> = {};

            Object.entries(goalValues).forEach(([key, value]) => {
                // Protection covers Liquidity + Short Bonds efficiently now
                // No need to normalize Liquidity key as it is already merged
                // const normalizedKey = key === 'Liquidity' ? 'Protection' : key;
                tempProjected[key] = (tempProjected[key] || 0) + value;
            });

            return Object.entries(tempProjected).map(([key, value]) => ({
                name: key,
                value,
                color: goalColors[key] || '#9CA3AF'
            })).filter(d => d.value > 0);
        })();


        return { totalValue, macros, goals, goalProjected };

    }, [assets, brokers, macroAllocations, goalAllocations, addedCapital, portfolios, assetSettings]);




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

    return (
        <div className="macro-stats-section">
            <h2 className="section-title" style={{ fontSize: '1.5rem', margin: '2rem 0 1rem' }}>Macro Allocation Analysis</h2>

            {/* Liquidity Simulation Input */}
            <div className="card" style={{ padding: '1rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', marginBottom: '2rem' }}>
                <h4 style={{ margin: '0 0 1rem', fontSize: '1rem' }}>Simulate Capital Injection</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem' }}>
                    {portfolios.map(p => (
                        <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            <label style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>{p.name}</label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span style={{ color: 'var(--text-muted)' }}>€</span>
                                <input
                                    type="number"
                                    min="0"
                                    placeholder="0"
                                    value={addedCapital[p.id] || ''}
                                    onChange={(e) => setAddedCapital(prev => ({ ...prev, [p.id]: Number(e.target.value) }))}
                                    style={{
                                        width: '100%',
                                        padding: '0.5rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px solid var(--border-color)',
                                        backgroundColor: 'var(--bg-input)',
                                        color: 'var(--text-primary)'
                                    }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
                    Add capital to specific portfolios to see how it affects your global allocation based on their targets.
                </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '2rem' }}>

                {/* Macro Chart & Table */}
                <div className="card" style={{ padding: '1.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3>Asset Allocation</h3>
                    </div>
                    <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={stats.macros}
                                    dataKey="currentValue"
                                    nameKey="name"
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    label={renderCustomizedLabel}
                                    outerRadius={80}
                                >
                                    {stats.macros.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip formatter={(value: number | undefined) => `€${(value || 0).toLocaleString()}`} />
                                <Legend />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                    <table style={{ width: '100%', marginTop: '1rem', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                                <th style={{ padding: '0.5rem' }}>Class</th>
                                <th style={{ textAlign: 'right' }}>Actual</th>
                                <th style={{ textAlign: 'right' }}>Target</th>
                                <th style={{ textAlign: 'right' }}>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {stats.macros.map(m => (
                                <tr key={m.name} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '0.5rem' }}>{m.name}</td>
                                    <td style={{ textAlign: 'right' }}>{m.currentPercent.toFixed(1)}%</td>
                                    <td style={{ textAlign: 'right' }}>{m.targetPercent > 0 ? m.targetPercent + '%' : '-'}</td>
                                    <td style={{
                                        textAlign: 'right',
                                        color: Math.abs(m.diffValue) < 50 ? 'var(--text-muted)' : (m.action === 'Buy' ? 'var(--color-success)' : 'var(--color-danger)'),
                                        fontWeight: 500
                                    }}>
                                        {Math.abs(m.diffValue) < 50 ? 'OK' : `${m.action} €${Math.abs(m.diffValue).toFixed(0)}`}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Goals Chart & Table */}
                <div className="card" style={{ padding: '1.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3>Goal Allocation (Projected)</h3>
                    </div>
                    <div style={{ width: '100%', minHeight: 400, display: 'flex', alignItems: 'center', marginTop: '1rem' }}>
                        {/* Replaced Pie with Pyramid */}
                        <PortfolioPyramid data={stats.goalProjected} />
                    </div>
                    <table style={{ width: '100%', marginTop: '1rem', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-color)' }}>
                                <th style={{ padding: '0.5rem' }}>Goal</th>
                                <th style={{ textAlign: 'right' }}>Actual</th>
                                <th style={{ textAlign: 'right' }}>Target</th>
                                <th style={{ textAlign: 'right' }}>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {stats.goals.map(g => (
                                <tr key={g.name} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '0.5rem' }}>{g.name}</td>
                                    <td style={{ textAlign: 'right' }}>{g.currentPercent.toFixed(1)}%</td>
                                    <td style={{ textAlign: 'right' }}>{g.targetPercent > 0 ? g.targetPercent + '%' : '-'}</td>
                                    <td style={{
                                        textAlign: 'right',
                                        color: Math.abs(g.diffValue) < 50 ? 'var(--text-muted)' : (g.action === 'Buy' ? 'var(--color-success)' : 'var(--color-danger)'),
                                        fontWeight: 500
                                    }}>
                                        {Math.abs(g.diffValue) < 50 ? 'OK' : `${g.action} €${Math.abs(g.diffValue).toFixed(0)}`}
                                    </td>
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
