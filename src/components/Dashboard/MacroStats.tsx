import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { getAssetGoal } from '../../utils/goalCalculations';
import type { FinancialGoal } from '../../utils/goalCalculations';
import type { AssetClass } from '../../types';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import PortfolioPyramid from './PortfolioPyramid';
import ProposedDistributionModal from './ProposedDistributionModal';

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

const MacroStats: React.FC = () => {
    const { assets, brokers, macroAllocations, goalAllocations, updateGoalAllocation, updateMacroAllocation } = usePortfolio();

    const [isGoalProposalOpen, setIsGoalProposalOpen] = useState(false);
    const [isAssetProposalOpen, setIsAssetProposalOpen] = useState(false);
    const [proposedGoalData, setProposedGoalData] = useState<Record<string, number>>({});
    const [proposedAssetData, setProposedAssetData] = useState<Record<string, number>>({});

    // 1. Calculate Totals and Allocations
    const stats = useMemo(() => {
        const totalInvested = assets.reduce((sum, a) => sum + (a.currentValue || 0), 0);
        const totalLiquidity = brokers.reduce((sum, b) => sum + (b.currentLiquidity || 0), 0);
        const totalValue = totalInvested + totalLiquidity;

        if (totalValue === 0) return null;

        // Init Aggregators
        // Use maps to store value
        const macroValues: Record<AssetClass, number> = { 'Stock': 0, 'Bond': 0, 'Commodity': 0, 'Crypto': 0 };
        // Explicitly type to allow 'Liquidity' which might not be in base type depending on update latency
        const goalValues: Record<string, number> = { 'Growth': 0, 'Protection': 0, 'Emergency Fund': 0, 'Speculative': 0, 'Liquidity': 0 };

        // Process Assets
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

        // Add Liquidity to Goal (Explicitly 'Liquidity' category requested, though 'Emergency Fund' usually holds cash too)
        // User asked for "liquidity, emergency fund, protection...". 
        // Logic: Broker Cash -> Liquidity Goal. Liquid Assets (XEON) -> Emergency Fund Goal.
        goalValues['Liquidity'] += totalLiquidity;

        // Prepare Data for Charts & Recommendations
        const macros = Object.entries(macroValues).map(([key, value]) => {
            const target = macroAllocations[key as AssetClass] || 0;
            // Use totalInvested for Macro calculation to exclude Liquidity
            const currentPercent = totalInvested > 0 ? (value / totalInvested) * 100 : 0;
            const diffPercent = currentPercent - target;
            // Calculate diff value based on invested capital
            const diffValue = totalInvested * (target / 100) - value; // Positive = Buy, Negative = Sell

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
            'Speculative': '#EC4899', // Pink
            'Growth': '#3B82F6',      // Blue
            'Protection': '#10B981',  // Green
            'Emergency Fund': '#F59E0B', // Amber
            'Liquidity': '#F59E0B' // Amber
        };

        const goalTargets = (() => {
            const tempTargets: Record<string, number> = {};

            Object.entries(goalAllocations).forEach(([key, inputTarget]) => {
                const targetPercent = inputTarget || 0;
                const targetValue = totalValue * (targetPercent / 100);

                // Merge 'Liquidity' into 'Emergency Fund'
                const normalizedKey = key === 'Liquidity' ? 'Emergency Fund' : key;
                tempTargets[normalizedKey] = (tempTargets[normalizedKey] || 0) + targetValue;
            });

            return Object.entries(tempTargets).map(([key, value]) => ({
                name: key,
                value,
                color: goalColors[key] || '#9CA3AF'
            })).filter(d => d.value > 0);
        })();


        return { totalValue, macros, goals, goalTargets };

    }, [assets, brokers, macroAllocations, goalAllocations]);

    const handleProposeGoal = () => {
        // Based on Macro Allocations (Asset Class)
        // Strategy: 
        // Stock -> Growth
        // Bond -> Protection
        // Crypto/Commodity -> Speculative
        // Remaining ? -> Emergency Fund (Assume 0 or user manages manually, usually Macro ignores Liquidity)

        const proposal: Record<string, number> = {
            'Growth': macroAllocations['Stock'] || 0,
            'Protection': macroAllocations['Bond'] || 0,
            'Speculative': (macroAllocations['Crypto'] || 0) + (macroAllocations['Commodity'] || 0),
            'Emergency Fund': 0 // Macro doesn't cover this well as it excludes liquidity
        };

        // Normalize? Macro targets sum to 100 (ideally). 
        // But Goal targets should include Liquidity/Emergency Fund which is OUTSIDE Macro (Invested) usually?
        // Wait, Goal Allocation covers Total Net Worth (Invested + Liquidity).
        // Macro Allocation covers Invested Only.
        // So we cannot map 1:1 if we want to be precise.
        // However, user asked for "Coherent distribution".

        // Let's assume we keep the 'invested' proportions for goals, and leave Emergency Fund as is (current Goal setting).
        const currentEmergency = goalAllocations['Emergency Fund'] || 0;
        const currentLiquidity = goalAllocations['Liquidity'] || 0; // If any
        const totalSafety = currentEmergency + currentLiquidity;

        // Remaining text for invested part
        const remainingForInvested = 100 - totalSafety;

        // Now scale the Macro targets (sum=100 of invested) to fit into 'remainingForInvested'
        proposal['Growth'] = (proposal['Growth'] / 100) * remainingForInvested;
        proposal['Protection'] = (proposal['Protection'] / 100) * remainingForInvested;
        proposal['Speculative'] = (proposal['Speculative'] / 100) * remainingForInvested;
        proposal['Emergency Fund'] = currentEmergency; // Keep existing
        if (goalAllocations['Liquidity']) proposal['Liquidity'] = currentLiquidity;

        setProposedGoalData(proposal);
        setIsGoalProposalOpen(true);
    };

    const handleProposeAsset = () => {
        // Based on Goal Allocations
        // Growth -> Stock
        // Protection -> Bond
        // Speculative -> Crypto (mostly)

        // We need to ignore Emergency Fund / Liquidity as Asset/Macro Allocation is only for Invested.
        const relevantGoals = {
            'Growth': goalAllocations['Growth'] || 0,
            'Protection': goalAllocations['Protection'] || 0,
            'Speculative': goalAllocations['Speculative'] || 0
        };

        const totalRelevant = Object.values(relevantGoals).reduce((a, b) => a + b, 0);

        if (totalRelevant === 0) {
            import('sweetalert2').then(Swal => {
                Swal.default.fire({
                    icon: 'warning',
                    title: 'Missing Goal Targets',
                    text: 'Please set your Goal Allocations (Growth, Protection, etc.) first so we can propose a matching asset distribution.',
                    confirmButtonColor: '#3B82F6'
                });
            });
            return;
        }

        const proposal: Record<string, number> = {
            'Stock': (relevantGoals['Growth'] / totalRelevant) * 100,
            'Bond': (relevantGoals['Protection'] / totalRelevant) * 100,
            'Crypto': (relevantGoals['Speculative'] / totalRelevant) * 100,
            'Commodity': 0 // Default to 0 or split speculative? Hard to say.
        };

        setProposedAssetData(proposal);
        setIsAssetProposalOpen(true);
    };


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

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '2rem' }}>

                {/* Macro Chart & Table */}
                <div className="card" style={{ padding: '1.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3>Asset Allocation</h3>
                        <button
                            className="btn-text"
                            onClick={handleProposeGoal}
                            style={{ fontSize: '0.85rem', color: 'var(--color-primary)', textDecoration: 'underline', cursor: 'pointer', background: 'none', border: 'none', padding: 0, zIndex: 1000 }}
                        >
                            Propose Goal Distribution
                        </button>
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
                                    {stats.macros.map((entry, index) => (
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
                        <h3>Goal Allocation (Target)</h3>
                        <button
                            className="btn-text"
                            onClick={handleProposeAsset}
                            style={{ fontSize: '0.85rem', color: 'var(--color-primary)', textDecoration: 'underline', cursor: 'pointer', background: 'none', border: 'none', padding: 0, zIndex: 1000 }}
                        >
                            Propose Asset Distribution
                        </button>
                    </div>
                    <div style={{ width: '100%', height: 250, display: 'flex', alignItems: 'center' }}>
                        {/* Replaced Pie with Pyramid */}
                        <PortfolioPyramid data={stats.goalTargets} />
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

            <ProposedDistributionModal
                isOpen={isGoalProposalOpen}
                onClose={() => setIsGoalProposalOpen(false)}
                title="Propose Goal Distribution"
                currentData={goalAllocations as any}
                proposedData={proposedGoalData}
                onApply={() => updateGoalAllocation(proposedGoalData as any)}
            />

            <ProposedDistributionModal
                isOpen={isAssetProposalOpen}
                onClose={() => setIsAssetProposalOpen(false)}
                title="Propose Asset Distribution"
                currentData={macroAllocations as any}
                proposedData={proposedAssetData}
                onApply={() => updateMacroAllocation(proposedAssetData as any)}
            />
        </div>
    );
};

export default MacroStats;
