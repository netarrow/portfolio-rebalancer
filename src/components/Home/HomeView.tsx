import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { isVirtualBondTicker } from '../../types';
import { aggregateMacroValues } from '../../utils/macroAggregation';
import {
    computeXIRR, getCashFlowsByDate, getNetWorthSeries, getPortfolioValueSeries, type ValuePoint,
} from '../../utils/performanceCalculations';
import { buildGoalFlowPlan } from '../../utils/goalFlows';
import { generateInstalments } from '../../utils/pacSchedule';
import { useOperationsTodos, OPERATION_ICON } from '../Operations/useOperationsTodos';
import AssetScopeToggles from '../Layout/AssetScopeToggles';
import EmptyState from '../Dashboard/EmptyState';
import QuickActions from './QuickActions';
import { CoherenceRows, PerformanceCard, SafetyCard, SpendingCard } from './HomeIndicators';
import { useSpendingFigures } from './useSpendingFigures';
import './Home.css';

type HomeTarget = 'operations' | 'performance' | 'stats' | 'fundRelocation' | 'summary' | 'pac' | 'dashboard' | 'disclaimer';

interface Props {
    onNavigate: (view: HomeTarget) => void;
}

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toLocaleDateString('sv-SE');
const eur = (v: number, digits = 0) => `€${v.toLocaleString('en-IE', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const signedEur = (v: number) => `${v >= 0 ? '+' : '−'}${eur(Math.abs(v))}`;
const pct = (v: number | null | undefined, digits = 1) => v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' });

/** The last point on or before `date`. */
const valueAt = (series: ValuePoint[], date: string): number | null => {
    let v: number | null = null;
    for (const p of series) { if (p.date > date) break; v = p.value; }
    return v;
};

const MACRO_COLORS: Record<string, string> = {
    Stock: '#6366f1', Bond: '#10b981', Commodity: '#f59e0b', Crypto: '#ec4899', Cash: '#64748b',
};
const MACRO_LABEL: Record<string, string> = { Stock: 'Equity', Bond: 'Bonds', Commodity: 'Commodities', Crypto: 'Crypto', Cash: 'Cash' };

/** A filled area of the series, scaled to its own min/max. */
const Sparkline: React.FC<{ series: ValuePoint[]; up: boolean }> = ({ series, up }) => {
    if (series.length < 2) return null;
    const W = 600, H = 120;
    const values = series.map(p => p.value);
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const pts = series.map((p, i) => [(i / (series.length - 1)) * W, H - 8 - ((p.value - min) / span) * (H - 16)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const color = up ? 'var(--color-success)' : 'var(--color-danger)';
    return (
        <svg className="home-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Net worth over the last 12 months">
            <defs>
                <linearGradient id="home-spark-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                    <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
            </defs>
            <path d={`${line} L${W},${H} L0,${H} Z`} fill="url(#home-spark-fill)" />
            <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
    );
};

interface UpcomingItem { date: string; icon: string; title: string; detail: string; target: HomeTarget }

/**
 * Home: the one screen to open first. How the wealth is doing (net worth,
 * its trend and the risk/return figures Performance computes), what is left
 * to do (the Operations queue, same detectors), where the money sits (asset
 * classes, Buckets against their targets) and what is coming up next.
 */
const HomeView: React.FC<Props> = ({ onNavigate }) => {
    const {
        transactions, scopedTransactions, scopedBrokers, scopedSummary, scopedAssets, priceHistory, portfolios, goals,
        goalModeTargets, goalFlowPortfolioStates, effectiveAssetSettings, marketData, ynabGoals, pacPlans, pacExecutions,
    } = usePortfolio();
    const [now] = useState(() => new Date());
    const { todos, detected, tracking, writebackInUse, priceTickers } = useOperationsTodos(now);
    const today = isoDay(now);

    // ── Wealth ──
    const liquidity = scopedBrokers.reduce((s, b) => s + (b.currentLiquidity || 0), 0);
    const netWorth = scopedSummary.totalValue + liquidity;
    const unrealized = scopedSummary.totalValue - scopedSummary.totalCost;
    const unrealizedPct = scopedSummary.totalCost > 0 ? (unrealized / scopedSummary.totalCost) * 100 : 0;

    const yearAgo = isoDay(new Date(now.getTime() - 365 * DAY));
    const nwSeries = useMemo(
        () => getNetWorthSeries(scopedTransactions, priceHistory, { from: yearAgo, liquidity }),
        [scopedTransactions, priceHistory, yearAgo, liquidity],
    );
    const lastNw = nwSeries[nwSeries.length - 1]?.value ?? netWorth;
    const changeSince = (date: string) => {
        const v = valueAt(nwSeries, date);
        return v == null || v <= 0 ? null : { abs: lastNw - v, rel: ((lastNw - v) / v) * 100 };
    };
    const monthChange = changeSince(isoDay(new Date(now.getTime() - 30 * DAY)));
    const ytdStart = `${now.getFullYear()}-01-01`;
    const ytdChange = changeSince(ytdStart);
    const yearChange = changeSince(yearAgo);

    // Returns on the invested part, flows removed (the Performance figures).
    const { base, flows, xirr } = useMemo(() => {
        const base = getPortfolioValueSeries(scopedTransactions, priceHistory);
        const flows = getCashFlowsByDate(scopedTransactions, undefined, { includeDistributions: true });
        return { base, flows, xirr: computeXIRR(base, flows) };
    }, [scopedTransactions, priceHistory]);
    const spending = useSpendingFigures();

    // Cash the queue says can be invested now, and what is missing.
    const freeCash = detected.filter(t => t.kind === 'broker-cash' && (t.amount ?? 0) > 0).reduce((s, t) => s + (t.amount ?? 0), 0);

    // ── Where the money sits ──
    const macro = useMemo(() => aggregateMacroValues(scopedAssets, liquidity), [scopedAssets, liquidity]);
    const macroRows = Object.entries(macro.macroValues).filter(([, v]) => v > 0.5).sort((a, b) => b[1] - a[1]);

    const buckets = useMemo(() => {
        if (goals.length === 0) return null;
        const plan = buildGoalFlowPlan({
            goals, portfolios, transactions: scopedTransactions, brokers: scopedBrokers, assetSettings: effectiveAssetSettings, marketData,
            targets: goalModeTargets, portfolioStates: goalFlowPortfolioStates,
        });
        const hasTargets = plan.goals.some(g => g.targetPercent > 0);
        return { plan, goals: plan.goals.filter(g => g.currentValue > 0.5 || g.targetPercent > 0), hasTargets };
    }, [goals, portfolios, scopedTransactions, scopedBrokers, effectiveAssetSettings, marketData, goalModeTargets, goalFlowPortfolioStates]);

    // ── Coming up (next 90 days) ──
    const upcoming = useMemo((): UpcomingItem[] => {
        const horizon = isoDay(new Date(now.getTime() + 90 * DAY));
        const out: UpcomingItem[] = [];
        pacPlans.filter(p => p.active !== false).forEach(plan => {
            const next = generateInstalments(plan, horizon, 0)
                .find(d => d > today && !pacExecutions.some(e => e.planId === plan.id && e.dueDate === d));
            if (next) out.push({
                date: next, icon: '📊', target: 'pac', title: plan.name || plan.ticker,
                detail: plan.mode === 'amount' && plan.amount ? `PAC · ${eur(plan.amount)}` : 'PAC instalment',
            });
        });
        ynabGoals.filter(g => !g.archived && g.targetDate && g.targetDate.slice(0, 10) >= today && g.targetDate.slice(0, 10) <= horizon)
            .forEach(g => out.push({
                date: g.targetDate!.slice(0, 10), icon: '🎯', target: 'summary', title: g.name,
                detail: `Capex${g.targetAmount ? ` · ${eur(g.targetAmount)}` : ''}${g.cashCoverage ? ` · ${eur(g.cashCoverage)} in cash` : ''}`,
            }));
        const held = new Set(scopedAssets.filter(a => a.quantity > 0).map(a => a.ticker.toUpperCase()));
        effectiveAssetSettings
            .filter(d => d.maturityDate && !isVirtualBondTicker(d.ticker) && held.has(d.ticker.toUpperCase())
                && d.maturityDate.slice(0, 10) >= today && d.maturityDate.slice(0, 10) <= horizon)
            .forEach(d => {
                const value = scopedAssets.find(a => a.ticker.toUpperCase() === d.ticker.toUpperCase())?.currentValue ?? 0;
                out.push({ date: d.maturityDate!.slice(0, 10), icon: '📅', target: 'dashboard', title: d.label || d.ticker, detail: `Bond maturity · ${eur(value)}` });
            });
        return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
    }, [pacPlans, pacExecutions, ynabGoals, scopedAssets, effectiveAssetSettings, now, today]);

    if (transactions.length === 0) return <EmptyState onNavigateToDisclaimer={() => onNavigate('disclaimer')} />;

    const counts = {
        overdue: todos.filter(t => t.urgency === 'overdue').length,
        due: todos.filter(t => t.urgency === 'due').length,
        info: todos.filter(t => t.urgency === 'info').length,
    };
    const trendUp = (yearChange?.abs ?? monthChange?.abs ?? 0) >= 0;
    const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';

    return (
        <div className="home">
            <header className="home-head">
                <div>
                    <h2>{greeting}</h2>
                    <p>{now.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
                </div>
                <AssetScopeToggles />
            </header>

            {/* Wealth */}
            <section className="home-card home-hero">
                <div className="home-hero-main">
                    <span className="home-label">Net worth</span>
                    <span className="home-big">{eur(netWorth)}</span>
                    <div className="home-deltas">
                        {([['1M', monthChange], ['YTD', ytdChange], ['1Y', yearChange]] as const).map(([label, c]) => (
                            <span key={label} className={`home-delta ${c == null ? '' : c.abs >= 0 ? 'is-up' : 'is-down'}`}>
                                <b>{label}</b> {c == null ? '—' : `${signedEur(c.abs)} · ${pct(c.rel)}`}
                            </span>
                        ))}
                    </div>
                    <span className="home-footnote">Change in net worth, deposits and withdrawals included</span>
                </div>
                <button type="button" className="home-spark-wrap" onClick={() => onNavigate('performance')} title="Open Performance">
                    <Sparkline series={nwSeries} up={trendUp} />
                    <span className="home-spark-caption">Last 12 months →</span>
                </button>
                <div className="home-kpis">
                    <Kpi label="Invested" value={eur(scopedSummary.totalValue)} sub={`${netWorth > 0 ? ((scopedSummary.totalValue / netWorth) * 100).toFixed(0) : 0}% of net worth`} />
                    <Kpi label="Cash" value={eur(liquidity)} sub={freeCash >= 1 ? `${eur(freeCash)} ready to invest` : 'nothing idle'} tone={freeCash >= 1 ? 'accent' : undefined} />
                    <Kpi label="Unrealized gain" value={signedEur(unrealized)} sub={pct(unrealizedPct)} tone={unrealized >= 0 ? 'up' : 'down'} />
                    <Kpi label="Annualized" value={pct(xirr)} sub="money-weighted, since start" tone={xirr == null ? undefined : xirr >= 0 ? 'up' : 'down'} />
                    {spending && <Kpi label="Savings / month" value={signedEur(spending.avgIncome - spending.avgSpending)} sub={spending.analysis.savingsRate == null ? 'YNAB' : `${(spending.analysis.savingsRate * 100).toFixed(0)}% of income`} tone={spending.avgIncome >= spending.avgSpending ? 'up' : 'down'} />}
                </div>
            </section>

            <QuickActions tracking={tracking} writebackInUse={writebackInUse} priceCount={priceTickers.length} />

            <div className="home-grid">
                {/* To do */}
                <section className="home-card home-todo">
                    <div className="home-card-head">
                        <h3>To do</h3>
                        <div className="home-pills">
                            {counts.overdue > 0 && <span className="home-pill is-overdue">{counts.overdue} overdue</span>}
                            {counts.due > 0 && <span className="home-pill is-due">{counts.due} due</span>}
                            {counts.info > 0 && <span className="home-pill">{counts.info} notices</span>}
                        </div>
                    </div>
                    {todos.length === 0
                        ? <div className="home-empty">✓ All caught up.</div>
                        : (
                            <ul className="home-list">
                                {todos.slice(0, 6).map(t => (
                                    <li key={t.key}>
                                        <button type="button" className={`home-row is-${t.urgency}`} onClick={() => onNavigate('operations')}>
                                            <span className="home-row-icon" aria-hidden>{OPERATION_ICON[t.kind]}</span>
                                            <span className="home-row-text">
                                                <span className="home-row-title">{t.title}</span>
                                                <span className="home-row-detail">{t.detail}</span>
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    <button type="button" className="home-link" onClick={() => onNavigate('operations')}>
                        {todos.length > 6 ? `See all ${todos.length} in Operations →` : 'Open Operations →'}
                    </button>
                </section>

                {/* Coming up */}
                <section className="home-card home-upcoming">
                    <div className="home-card-head"><h3>Coming up</h3><span className="home-muted">next 90 days</span></div>
                    {upcoming.length === 0
                        ? <div className="home-empty">Nothing scheduled.</div>
                        : (
                            <ul className="home-list">
                                {upcoming.map((u, i) => (
                                    <li key={`${u.date}-${i}`}>
                                        <button type="button" className="home-row" onClick={() => onNavigate(u.target)}>
                                            <span className="home-date"><b>{shortDate(u.date).split(' ')[0]}</b>{shortDate(u.date).split(' ')[1]}</span>
                                            <span className="home-row-text">
                                                <span className="home-row-title">{u.icon} {u.title}</span>
                                                <span className="home-row-detail">{u.detail}</span>
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                </section>

                <PerformanceCard base={base} flows={flows} now={now} onOpen={() => onNavigate('performance')} />

                {spending && <SpendingCard figures={spending} onOpen={() => onNavigate('summary')} />}
                <SafetyCard netWorth={netWorth} liquidity={liquidity} spending={spending} onOpen={() => onNavigate('summary')} />

                {/* Asset classes */}
                <section className="home-card">
                    <div className="home-card-head">
                        <h3>Asset classes</h3>
                        <button type="button" className="home-link-inline" onClick={() => onNavigate('stats')}>Stats →</button>
                    </div>
                    <div className="home-stack" role="img" aria-label="Net worth by asset class">
                        {macroRows.map(([k, v]) => (
                            <span key={k} style={{ width: `${(v / (macro.totalValue || 1)) * 100}%`, background: MACRO_COLORS[k] ?? '#94a3b8' }} />
                        ))}
                    </div>
                    <ul className="home-legend">
                        {macroRows.map(([k, v]) => (
                            <li key={k}>
                                <span className="home-dot" style={{ background: MACRO_COLORS[k] ?? '#94a3b8' }} />
                                <span>{MACRO_LABEL[k] ?? k}</span>
                                <span className="home-legend-val">{((v / (macro.totalValue || 1)) * 100).toFixed(1)}%</span>
                                <span className="home-muted">{eur(v)}</span>
                            </li>
                        ))}
                    </ul>
                </section>

                {/* Buckets */}
                {buckets && buckets.goals.length > 0 && (
                    <section className="home-card">
                        <div className="home-card-head">
                            <h3>Buckets</h3>
                            <button type="button" className="home-link-inline" onClick={() => onNavigate('fundRelocation')}>Capital Allocation →</button>
                        </div>
                        <ul className="home-buckets">
                            {buckets.goals.map(g => {
                                const off = g.currentPercent - g.targetPercent;
                                const scale = Math.max(100, ...buckets.goals.map(x => Math.max(x.currentPercent, x.targetPercent))) ;
                                return (
                                    <li key={g.id}>
                                        <div className="home-bucket-top">
                                            <span><span className="home-dot" style={{ background: g.color }} />{g.title}</span>
                                            <span>
                                                <b>{g.currentPercent.toFixed(1)}%</b>
                                                {buckets.hasTargets && <span className={`home-muted ${Math.abs(off) >= 3 ? (off > 0 ? 'is-over' : 'is-under') : ''}`}> / {g.targetPercent.toFixed(0)}% target</span>}
                                            </span>
                                        </div>
                                        <div className="home-bar">
                                            <span style={{ width: `${(g.currentPercent / scale) * 100}%`, background: g.color }} />
                                            {buckets.hasTargets && <i style={{ left: `${(g.targetPercent / scale) * 100}%` }} title={`Target ${g.targetPercent.toFixed(1)}%`} />}
                                        </div>
                                        <span className="home-muted">{eur(g.currentValue)}{buckets.hasTargets && Math.abs(g.gap) >= 100 ? ` · ${g.gap > 0 ? 'needs' : 'over by'} ${eur(Math.abs(g.gap))}` : ''}</span>
                                    </li>
                                );
                            })}
                        </ul>
                        <CoherenceRows plan={buckets.plan} targets={goalModeTargets} />
                    </section>
                )}
            </div>

            <button type="button" className="home-link home-classic" onClick={() => onNavigate('dashboard')}>
                Portfolio tables and rebalancing are in the Dashboard →
            </button>
        </div>
    );
};

const Kpi: React.FC<{ label: string; value: string; sub?: string; tone?: 'up' | 'down' | 'accent' }> = ({ label, value, sub, tone }) => (
    <div className="home-kpi">
        <span className="home-label">{label}</span>
        <span className={`home-kpi-value ${tone ? `is-${tone}` : ''}`}>{value}</span>
        {sub && <span className="home-kpi-sub">{sub}</span>}
    </div>
);

export default HomeView;
