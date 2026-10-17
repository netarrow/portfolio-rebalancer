import React, { useState } from 'react';
import SummaryAnalysisView from '../SummaryAnalysis/SummaryAnalysisView';
import YnabGoalsView from '../YnabGoals/YnabGoalsView';

export type ExpensePlanningSection = 'opex' | 'capex';

interface Props {
    initialSection?: ExpensePlanningSection;
    onNavigateToSettings?: () => void;
}

const SECTIONS: { id: ExpensePlanningSection; label: string; hint: string }[] = [
    { id: 'opex', label: 'Opex', hint: 'Recurring spending, savings and liquidity' },
    { id: 'capex', label: 'Capex', hint: 'Planned dated expenses and how they are funded' },
];

/**
 * One place for the spending plan: recurring spending (opex) and the planned
 * dated expenses (capex) as two sections of the same page.
 */
const ExpensePlanningView: React.FC<Props> = ({ initialSection = 'opex', onNavigateToSettings }) => {
    const [section, setSection] = useState<ExpensePlanningSection>(initialSection);

    return (
        <div>
            <div className="ep-head">
                <h2 style={{ margin: 0 }}>Expense Planning</h2>
                <div className="ep-section-tabs" role="tablist" aria-label="Section">
                    {SECTIONS.map(s => (
                        <button
                            key={s.id}
                            type="button"
                            role="tab"
                            aria-selected={section === s.id}
                            className={section === s.id ? 'active' : ''}
                            title={s.hint}
                            onClick={() => setSection(s.id)}
                        >
                            {s.label}
                            <span className="ep-section-hint">{s.hint}</span>
                        </button>
                    ))}
                </div>
            </div>

            {section === 'opex'
                ? <SummaryAnalysisView embedded onNavigateToSettings={onNavigateToSettings} />
                : <YnabGoalsView embedded />}

            <style>{`
                .ep-head { max-width: 1100px; margin: 0 auto 1.25rem; display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
                .ep-section-tabs { display: inline-flex; gap: 4px; padding: 4px; border-radius: var(--radius-lg); background: var(--bg-card); }
                .ep-section-tabs button { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer;
                    padding: 0.45rem 1rem; border-radius: var(--radius-md); font-weight: 700; font-size: 0.95rem;
                    display: flex; flex-direction: column; align-items: flex-start; text-align: left; }
                .ep-section-tabs button.active { background: var(--color-primary); color: white; }
                .ep-section-hint { font-weight: 400; font-size: 0.72rem; opacity: 0.8; }
                @media (max-width: 600px) { .ep-section-hint { display: none; } }
            `}</style>
        </div>
    );
};

export default ExpensePlanningView;
