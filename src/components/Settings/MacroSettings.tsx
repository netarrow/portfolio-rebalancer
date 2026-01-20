import React, { useState, useEffect } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { AssetClass, FinancialGoal } from '../../types';

const MacroSettings: React.FC = () => {
    const { macroAllocations, goalAllocations, updateMacroAllocation, updateGoalAllocation } = usePortfolio();

    // Local state for editing
    const [macroInputs, setMacroInputs] = useState<Record<string, string>>({});
    const [goalInputs, setGoalInputs] = useState<Record<string, string>>({});

    // Initialize inputs from context
    useEffect(() => {
        const macros: Record<string, string> = {};
        (['Stock', 'Bond', 'Commodity', 'Crypto', 'Cash'] as AssetClass[]).forEach(cls => {
            macros[cls] = (macroAllocations[cls] || 0).toString();
        });
        setMacroInputs(macros);

        const goals: Record<string, string> = {};
        (['Liquidity', 'Protection', 'Security', 'Growth'] as FinancialGoal[]).forEach(g => {
            goals[g] = (goalAllocations[g] || 0).toString();
        });
        setGoalInputs(goals);
    }, [macroAllocations, goalAllocations]);


    const handleMacroChange = (cls: AssetClass, value: string) => {
        setMacroInputs(prev => ({ ...prev, [cls]: value }));
    };

    const handleGoalChange = (goal: FinancialGoal, value: string) => {
        setGoalInputs(prev => ({ ...prev, [goal]: value }));
    };

    const saveMacros = () => {
        const newAlloc: any = {};
        let sum = 0;
        Object.entries(macroInputs).forEach(([k, v]) => {
            const val = parseFloat(v) || 0;
            newAlloc[k] = val;
            sum += val;
        });
        updateMacroAllocation(newAlloc);
        if (Math.abs(sum - 100) > 0.1) {
            alert(`Warning: Macro allocations sum to ${sum}%, not 100%.`);
        }
    };

    const saveGoals = () => {
        const newAlloc: any = {};
        let sum = 0;
        Object.entries(goalInputs).forEach(([k, v]) => {
            const val = parseFloat(v) || 0;
            newAlloc[k] = val;
            sum += val;
        });
        updateGoalAllocation(newAlloc);
        if (Math.abs(sum - 100) > 0.1) {
            alert(`Warning: Goal allocations sum to ${sum}%, not 100%.`);
        }
    };

    const macroSum = Object.values(macroInputs).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
    const goalSum = Object.values(goalInputs).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);

    return (
        <div style={{ maxWidth: '800px', margin: '2rem auto' }}>
            <h2 className="section-title">Macro & Goal Targets</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>
                Define your high-level allocation targets. These are used for aggregate analysis and portfolio recommendations.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
                {/* Macro Allocations */}
                <div className="card" style={{ padding: '1.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                    <h3 style={{ marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                        By Asset Class
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {(['Stock', 'Bond', 'Commodity', 'Crypto', 'Cash'] as AssetClass[]).map(cls => (
                            <div key={cls} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <label style={{ fontWeight: 500 }}>{cls}</label>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <input
                                        type="number"
                                        step="0.1"
                                        value={macroInputs[cls] || ''}
                                        onChange={e => handleMacroChange(cls, e.target.value)}
                                        style={{ width: '70px', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}
                                    />
                                    <span>%</span>
                                </div>
                            </div>
                        ))}
                        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px dashed var(--border-color)', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                            <span>Total</span>
                            <span style={{ color: Math.abs(macroSum - 100) < 0.1 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {macroSum.toFixed(1)}%
                            </span>
                        </div>
                        <button
                            onClick={saveMacros}
                            style={{
                                marginTop: '1rem',
                                padding: '0.5rem',
                                backgroundColor: 'var(--color-primary)',
                                color: 'white',
                                border: 'none',
                                borderRadius: 'var(--radius-md)',
                                cursor: 'pointer'
                            }}
                        >
                            Save Asset Targets
                        </button>
                    </div>
                </div>

                {/* Goal Allocations */}
                <div className="card" style={{ padding: '1.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
                    <h3 style={{ marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
                        By Goal
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        {(['Liquidity', 'Protection', 'Security', 'Growth'] as FinancialGoal[]).map(goal => (
                            <div key={goal} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <label style={{ fontWeight: 500 }}>{goal}</label>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <input
                                        type="number"
                                        step="0.1"
                                        value={goalInputs[goal] || ''}
                                        onChange={e => handleGoalChange(goal, e.target.value)}
                                        style={{ width: '70px', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}
                                    />
                                    <span>%</span>
                                </div>
                            </div>
                        ))}
                        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px dashed var(--border-color)', display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
                            <span>Total</span>
                            <span style={{ color: Math.abs(goalSum - 100) < 0.1 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {goalSum.toFixed(1)}%
                            </span>
                        </div>
                        <button
                            onClick={saveGoals}
                            style={{
                                marginTop: '1rem',
                                padding: '0.5rem',
                                backgroundColor: 'var(--color-primary)',
                                color: 'white',
                                border: 'none',
                                borderRadius: 'var(--radius-md)',
                                cursor: 'pointer'
                            }}
                        >
                            Save Goal Targets
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MacroSettings;
