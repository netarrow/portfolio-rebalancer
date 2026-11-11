import React, { useMemo } from 'react';
import type { YnabMacroCategory } from '../../types';
import {
    aggregateMonthlyLogReturns, computeDrawdownAnalysis, computeFlowAdjustedFactors, computeReturnStats, computeXIRR, type ValuePoint,
} from '../../utils/performanceCalculations';
import { COMPRESSIBLE_INCOME_SHARE_ALERT, MACRO_LABELS } from '../../utils/spendingAnalysis';
import type { useSpendingFigures } from './useSpendingFigures';
import { SPEND_COLORS } from './useSpendingFigures';
import { buildExpensePyramid } from '../../utils/expensePyramid';
import type { GoalFlowPlan } from '../../utils/goalFlows';
import { useYnabCoverage } from '../YnabImport/useYnabCoverage';
import { useExpensePlanningTargets } from '../YnabImport/useExpensePlanningTargets';
import { useSinkingSummary } from '../YnabGoals/useSinkingSummary';
import { useMaturityLadder } from '../YnabGoals/useMaturityLadder';
import { useLocalStorage } from '../../hooks/useLocalStorage';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toLocaleDateString('sv-SE');
const eur = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;
const signedEur = (v: number) => `${v >= 0 ? '+' : '−'}${eur(Math.abs(v))}`;
const pct = (v: number | null | undefined, digits = 1) => v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
const plainPct = (v: number | null | undefined, digits = 1) => v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`;
const tone = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? undefined : v >= 0 ? 'up' : 'down';

type Tone = 'up' | 'down' | 'warn' | 'accent' | undefined;

const Metric: React.FC<{ label: string; value: string; sub?: string; tone?: Tone; title?: string }> = ({ label, value, sub, tone: t, title }) => (
    <div className="home-metric" title={title}>
        <span className="home-label">{label}</span>
        <span className={`home-metric-value ${t ? `is-${t}` : ''}`}>{value}</span>
        {sub && <span className="home-kpi-sub">{sub}</span>}
    </div>
);

/** A bar filling `value` of `target` (capped at 100%), green once reached. */
const Meter: React.FC<{ value: number; target: number }> = ({ value, target }) => {
    const ratio = target > 0 ? Math.min(1, Math.max(0, value / target)) : 0;
    return (
        <div className="home-meter" role="img" aria-label={`${Math.round(ratio * 100)}% of target`}>
            <span style={{ width: `${ratio * 100}%`, background: ratio >= 0.999 ? 'var(--color-success)' : ratio >= 0.6 ? 'var(--color-warning)' : 'var(--color-danger)' }} />
        </div>
    );
};

// ── Performance ─────────────────────────────────────────────────────

/**
 * Returns over the last 1/3/6/12 months and since the start, with flows
 * removed (time-weighted: deposits are not gains), and the risk figures the
 * Performance page computes on the same stream.
 */
export const PerformanceCard: React.FC<{ base: ValuePoint[]; flows: Map<string, number>; now: Date; onOpen: () => void }> = ({ base, flows, now, onOpen }) => {
    const [riskFree] = useLocalStorage<number>('portfolio_risk_free_rate', 0);
    const m = useMemo(() => {
        const { factors, dates } = computeFlowAdjustedFactors(base, flows);
        const first = base[0]?.date;
        // Linked factors after `from`; null when the history starts later.
        const since = (from: string) => {
            if (!first || first > from) return null;
            let f = 1;
            dates.forEach((d, i) => { if (d > from) f *= factors[i]; });
            return (f - 1) * 100;
        };
        const ago = (days: number) => isoDay(new Date(now.getTime() - days * DAY));
        const monthly = aggregateMonthlyLogReturns(factors, dates).map(l => (Math.exp(l) - 1) * 100);
        return {
            periods: [
                { label: '1M', value: since(ago(30)) },
                { label: '3M', value: since(ago(91)) },
                { label: '6M', value: since(ago(182)) },
                { label: 'YTD', value: since(`${now.getFullYear() - 1}-12-31`) },
                { label: '1Y', value: since(ago(365)) },
            ],
            stats: computeReturnStats(base, flows, { riskFreePct: riskFree }),
            dd: computeDrawdownAnalysis(base, flows),
            xirr: computeXIRR(base, flows),
            best: monthly.length > 0 ? Math.max(...monthly) : null,
            worst: monthly.length > 0 ? Math.min(...monthly) : null,
            positive: monthly.length > 0 ? (monthly.filter(r => r > 0).length / monthly.length) * 100 : null,
            months: monthly.length,
        };
    }, [base, flows, now, riskFree]);

    const { stats, dd } = m;
    if (base.length < 2 || !dd) return null;
    const peakText = dd.peakDate
        ? dd.underwaterDays === 0 ? 'at its high today' : `peak ${new Date(dd.peakDate).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: '2-digit' })} · ${dd.underwaterDays} d below`
        : '';

    return (
        <section className="home-card home-span">
            <div className="home-card-head">
                <h3>Performance</h3>
                <button type="button" className="home-link-inline" onClick={onOpen}>Performance →</button>
            </div>
            <div className="home-periods">
                {m.periods.map(p => (
                    <div key={p.label} className={`home-period ${tone(p.value) ? `is-${tone(p.value)}` : ''}`}>
                        <span>{p.label}</span>
                        <b>{pct(p.value)}</b>
                    </div>
                ))}
                <div className={`home-period ${tone(m.xirr ?? stats?.annualizedReturnPct) ? `is-${tone(m.xirr ?? stats?.annualizedReturnPct)}` : ''}`}>
                    <span>Since start / yr</span>
                    <b>{pct(m.xirr ?? stats?.annualizedReturnPct)}</b>
                </div>
            </div>
            <span className="home-footnote">Time-weighted on the invested part, deposits and withdrawals removed; since start is money-weighted (XIRR).</span>
            <div className="home-metrics">
                <Metric label="From last high" value={pct(dd.currentDrawdownPct)} sub={peakText} tone={dd.currentDrawdownPct < -0.05 ? 'down' : 'up'}
                    title="Distance from the high-water mark of the flow-adjusted index" />
                <Metric label="To recover" value={dd.recoveryNeededPct > 0.05 ? pct(dd.recoveryNeededPct) : '—'} sub="gain needed to get back to the high" />
                <Metric label="Max drawdown" value={pct(stats?.maxDrawdownPct)} sub={dd.longestUnderwaterDays > 0 ? `longest below a high: ${dd.longestUnderwaterDays} d` : ''} tone="down" />
                <Metric label="Sharpe" value={stats?.sharpe != null ? stats.sharpe.toFixed(2) : '—'} sub={`risk-free ${riskFree}% · since start`}
                    tone={stats?.sharpe == null ? undefined : stats.sharpe >= 1 ? 'up' : stats.sharpe < 0 ? 'down' : undefined} />
                <Metric label="Volatility" value={plainPct(stats?.annualizedVolatilityPct)} sub="annualized" />
                <Metric label="Return / risk" value={stats?.annualizedVolatilityPct ? (stats.annualizedReturnPct / stats.annualizedVolatilityPct).toFixed(2) : '—'} sub="ann. return ÷ volatility" />
                <Metric label="Best / worst month" value={m.best != null ? `${pct(m.best)} / ${pct(m.worst)}` : '—'} sub={m.months > 0 ? `${m.months} full months` : ''} />
                <Metric label="Positive months" value={plainPct(m.positive, 0)} sub="share of full months up" />
            </div>
        </section>
    );
};

// ── Spending (YNAB) ─────────────────────────────────────────────────


export const SpendingCard: React.FC<{ figures: NonNullable<ReturnType<typeof useSpendingFigures>>; onOpen: () => void }> = ({ figures: f, onOpen }) => {
    const a = f.analysis;
    const vsAvg = f.avgConsumption > 0 ? ((f.lastConsumption - f.avgConsumption) / f.avgConsumption) * 100 : null;
    const compressible = a.macros.compressible.shareOfIncome;
    const totalMacro = f.byMacro.reduce((s, x) => s + x.value, 0);
    const monthLabel = new Date(f.lastMonth).toLocaleDateString('en-IE', { month: 'short', year: 'numeric' });
    return (
        <section className="home-card">
            <div className="home-card-head">
                <h3>Spending</h3>
                <button type="button" className="home-link-inline" onClick={onOpen}>Expense Planning →</button>
            </div>
            <span className="home-muted">YNAB, average of the last {f.months} month{f.months === 1 ? '' : 's'}</span>
            <div className="home-metrics home-metrics-2">
                <Metric label="Income / month" value={eur(f.avgIncome)} />
                <Metric label="Spending / month" value={eur(f.avgSpending)} sub={`${eur(f.avgConsumption)} operating`} />
                <Metric label="Savings rate" value={a.savingsRate == null ? '—' : plainPct(a.savingsRate * 100)}
                    sub={`${signedEur(f.avgIncome - f.avgSpending)} / month`} tone={a.savingsRate == null ? undefined : a.savingsRate >= 0.2 ? 'up' : a.savingsRate < 0 ? 'down' : 'warn'} />
                <Metric label={`Last month (${monthLabel})`} value={eur(f.lastConsumption)} sub={vsAvg == null ? 'operating' : `${pct(vsAvg, 0)} vs average`}
                    tone={vsAvg == null ? undefined : vsAvg > 10 ? 'warn' : vsAvg < -5 ? 'up' : undefined} />
                <Metric label="Operating savings" value={a.operatingSavingsRate == null ? '—' : plainPct(a.operatingSavingsRate * 100)} sub="income − operating spending" />
                <Metric label="Compressible" value={compressible == null ? '—' : plainPct(compressible * 100)} sub="of income, wants not needs"
                    tone={compressible != null && compressible > COMPRESSIBLE_INCOME_SHARE_ALERT ? 'warn' : undefined} />
            </div>
            {f.byMacro.length > 0 && (
                <>
                    <div className="home-stack" role="img" aria-label="Monthly spending by nature">
                        {f.byMacro.map(x => <span key={x.key} style={{ width: `${(x.value / totalMacro) * 100}%`, background: SPEND_COLORS[x.key] }} />)}
                    </div>
                    <ul className="home-legend home-legend-inline">
                        {f.byMacro.map(x => (
                            <li key={x.key}><span className="home-dot" style={{ background: SPEND_COLORS[x.key] }} />{MACRO_LABELS[x.key as YnabMacroCategory]} <b>{eur(x.value)}</b></li>
                        ))}
                    </ul>
                </>
            )}
        </section>
    );
};

// ── Cash & safety ───────────────────────────────────────────────────

/**
 * How spending and wealth relate: how long the cash lasts, the emergency fund
 * against its target, the liquidity Expense Planning asks for, and how many
 * years of spending the net worth stands for.
 */
export const SafetyCard: React.FC<{
    netWorth: number;
    liquidity: number;
    spending: ReturnType<typeof useSpendingFigures>;
    onOpen: () => void;
}> = ({ netWorth, liquidity, spending, onOpen }) => {
    const { report } = useYnabCoverage();
    const expense = useExpensePlanningTargets();
    const sinking = useSinkingSummary();
    const monthly = spending?.avgSpending ?? 0;
    const operating = spending?.avgConsumption ?? 0;
    const em = report.emergency;
    const annual = monthly * 12;
    // FI is about recurring spending: one-off dated spending and unmapped
    // outflows would inflate the withdrawal rate. A capex that comes back is
    // recurring, though: it counts with its yearly quota (target ÷ years), not
    // with the lump of the year it is bought in.
    const annualOperating = operating * 12 + sinking.annualQuota;
    const fiRatio = annualOperating > 0 ? netWorth / (annualOperating * 25) : null;
    const withdrawalPct = annualOperating > 0 ? (annualOperating / Math.max(1, netWorth)) * 100 : null;
    const allInPct = annual > 0 ? (annual / Math.max(1, netWorth)) * 100 : null;
    const liqGap = expense.liquidity != null ? liquidity - expense.liquidity : null;
    if (!spending && expense.liquidity == null && !(em.target > 0)) return null;

    return (
        <section className="home-card">
            <div className="home-card-head">
                <h3>Cash &amp; safety</h3>
                <button type="button" className="home-link-inline" onClick={onOpen}>Expense Planning →</button>
            </div>
            <div className="home-metrics home-metrics-2">
                <Metric label="Cash runway" value={operating > 0 ? `${(liquidity / operating).toFixed(1)} mo` : '—'} sub="broker cash ÷ operating spending"
                    tone={operating > 0 ? (liquidity / operating >= 6 ? 'up' : liquidity / operating < 3 ? 'down' : 'warn') : undefined} />
                <Metric label="Liquidity vs target" value={liqGap == null ? '—' : signedEur(liqGap)}
                    sub={expense.liquidity == null ? 'no Expense Planning target' : `${eur(liquidity)} of ${eur(expense.liquidity)} (to hold on the accounts + capex to come in)`}
                    tone={liqGap == null ? undefined : liqGap < -100 ? 'down' : liqGap > Math.max(1000, (expense.liquidity ?? 0) * 0.25) ? 'accent' : 'up'}
                    title="Above: idle cash that could be invested. Below: cash to set aside." />
                <Metric label="Years of spending" value={annual > 0 ? `${(netWorth / annual).toFixed(1)} y` : '—'} sub="net worth ÷ yearly spending" />
                <Metric label="FI progress (25×)" value={fiRatio == null ? '—' : plainPct(fiRatio * 100, 0)}
                    sub={withdrawalPct != null ? `implied withdrawal ${plainPct(withdrawalPct)}` : ''} tone={fiRatio != null && fiRatio >= 1 ? 'up' : undefined}
                    title={`Net worth against 25 times the yearly operating spending${sinking.annualQuota > 0 ? ` plus the yearly quota of the cyclical capex (${eur(sinking.annualQuota)})` : ''} (the 4% rule). Implied withdrawal: that spending ÷ net worth${allInPct != null ? `; with dated and unmapped spending it would be ${plainPct(allInPct)}` : ''}.`} />
                {sinking.funds.length > 0 && (
                    <Metric label="Cyclical capex" value={`${eur(sinking.annualQuota)} / y`}
                        sub={`${sinking.funds.length} fund${sinking.funds.length === 1 ? '' : 's'} · ${sinking.behind > 0.5 ? `${eur(sinking.behind)} behind their line` : 'in line'}`}
                        tone={sinking.behind > 0.5 ? 'warn' : 'up'}
                        title="Planned capex that come back every N years. Their yearly quota (target ÷ years) is cost of living: setting it aside is the depreciation, paid in advance." />
                )}
                {sinking.setAside > 0.5 && (
                    <Metric label="Net of set-asides" value={eur(netWorth - sinking.setAside)}
                        sub={`${eur(sinking.setAside)} already put toward planned capex`}
                        title="Net worth less the money already put toward the planned capex (cash and investments, up to each target): yours, but committed. Paying a capex takes it from the net worth, not from this." />
                )}
            </div>
            {em.target > 0 && (
                <div className="home-emergency">
                    <div className="home-bucket-top">
                        <span>Emergency fund</span>
                        <span><b>{em.monthsCovered.toFixed(1)}</b><span className="home-muted"> / {em.months} months</span></span>
                    </div>
                    <Meter value={em.current} target={em.target} />
                    <span className="home-muted">{eur(em.current)} of {eur(em.target)}{em.gap > 0.5 ? ` · ${eur(em.gap)} missing` : ' · complete'}</span>
                </div>
            )}
        </section>
    );
};

// ── Pyramid coherence ───────────────────────────────────────────────

/**
 * Whether the pyramid holds together: the Buckets against their targets, the
 * targets against what Expense Planning implies, and the capex against the
 * money ready for them in time.
 */
export const CoherenceRows: React.FC<{ plan: GoalFlowPlan; targets: Record<string, number> }> = ({ plan, targets }) => {
    const expense = useExpensePlanningTargets();
    const { ladder } = useMaturityLadder();
    const hasTargets = plan.goals.some(g => g.targetPercent > 0);
    const maxOff = hasTargets ? Math.max(0, ...plan.goals.map(g => Math.abs(g.currentPercent - g.targetPercent))) : null;
    const toMove = hasTargets ? plan.goals.reduce((s, g) => s + Math.max(0, g.gap), 0) : null;

    const pyramid = useMemo(() => expense.liquidity == null ? null : buildExpensePyramid({
        levels: plan.goals.map(g => ({
            id: g.id, title: g.title, color: g.color, kind: g.kind, currentValue: g.currentValue,
            portfolioIds: g.portfolios.filter(p => p.state !== 'excluded').map(p => p.id),
            holdsFund: g.portfolios.some(p => expense.fundPortfolioIds.includes(p.id)),
        })),
        total: plan.total,
        targetOf: id => expense.portfolios.get(id)?.total ?? 0,
        liquidity: expense.liquidity,
    }), [plan, expense]);
    const planOff = pyramid && hasTargets ? Math.max(0, ...plan.goals.map(g => Math.abs((targets[g.id] ?? 0) - (pyramid.percents[g.id] ?? 0)))) : null;

    // What is allocated to a portfolio but cannot be ready by the date is a
    // problem; what is not allocated yet is still being saved.
    const capex = [...ladder.goals.values()].filter(g => g.need > 0.5);
    const notReadyOf = (g: (typeof capex)[number]) => Math.max(0, g.missing - g.unassigned);
    const capexOk = capex.filter(g => notReadyOf(g) <= 0.5).length;
    const capexNotReady = capex.reduce((s, g) => s + notReadyOf(g), 0);
    const capexUnassigned = capex.reduce((s, g) => s + g.unassigned, 0);

    return (
        <div className="home-metrics home-metrics-2 home-coherence">
            <Metric label="Off target" value={maxOff == null ? '—' : `${maxOff.toFixed(1)} pts`} sub={toMove ? `${eur(toMove)} to move between buckets` : 'no targets set'}
                tone={maxOff == null ? undefined : maxOff < 3 ? 'up' : maxOff < 8 ? 'warn' : 'down'} />
            <Metric label="Targets vs Expense Planning" value={planOff == null ? '—' : planOff < 0.5 ? 'aligned' : `${planOff.toFixed(1)} pts`}
                sub={pyramid ? (pyramid.shortfall > 0.5 ? `plan asks ${eur(pyramid.shortfall)} more than you hold` : 'what spending implies per level') : 'needs YNAB'}
                tone={planOff == null ? undefined : planOff < 0.5 ? 'up' : planOff < 5 ? 'warn' : 'down'} />
            <Metric label="Capex covered in time" value={capex.length > 0 ? `${capexOk} / ${capex.length}` : '—'}
                sub={capex.length === 0 ? 'no planned capex'
                    : `${capexNotReady > 0.5 ? `${eur(capexNotReady)} allocated, not ready in time` : 'allocated part ready in time'}${capexUnassigned > 0.5 ? ` · ${eur(capexUnassigned)} not allocated yet` : ''}`}
                tone={capex.length === 0 ? undefined : capexOk === capex.length ? 'up' : 'warn'} />
        </div>
    );
};
