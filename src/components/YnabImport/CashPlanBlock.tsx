import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { CashLayerKind, CashMove } from '../../utils/cashPlan';
import { useCashPlan } from './useCashPlan';

const eur = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;

const LAYERS: Record<CashLayerKind, { label: string; color: string; hint: string }> = {
    operating: { label: 'Operating', color: '#6366f1', hint: 'Day-to-day money: the operating cash' },
    'due-capex': { label: 'Capex due soon', color: '#f59e0b', hint: 'Cash of the planned capex due within the look-ahead' },
    'set-aside': { label: 'Set aside', color: '#a855f7', hint: 'Set aside for dated expenses, staying cash: sinking funds, capex with nothing invested, unmapped money' },
    emergency: { label: 'Emergency fund', color: '#14b8a6', hint: 'Emergency-fund cash held here: no fund portfolio is configured' },
    'in-transit': { label: 'In transit', color: '#06b6d4', hint: 'Only waiting here: bound for the portfolio covering its capex, for the fund portfolios, or to invest' },
    free: { label: 'Free', color: '#10b981', hint: 'No purpose claims it' },
};

/**
 * The cash plan, read-only: every account's cash by what it is for, and the
 * moves that follow — what to keep, what to move, what to cover, crossed so
 * they never contradict each other.
 */
const CashPlanBlock: React.FC = () => {
    const { portfolios } = usePortfolio();
    const plan = useCashPlan();
    if (!plan || plan.accounts.length === 0) return null;

    const account = (id?: string) => plan.accounts.find(a => a.brokerId === id)?.brokerName ?? 'an account';
    const portfolioNames = (ids?: string[]) => {
        const names = (ids ?? []).map(id => portfolios.find(p => p.id === id)?.name).filter(Boolean);
        return names.length > 0 ? names.join(' / ') : 'the portfolios';
    };
    const describe = (m: CashMove): { verb: string; text: string } => {
        switch (m.kind) {
            case 'wire': return { verb: 'Wire', text: `${eur(m.amount)} from ${account(m.fromBrokerId)} to ${account(m.toBrokerId)}` };
            case 'raise': return { verb: 'Deposit', text: `${eur(m.amount)} on ${account(m.toBrokerId)}: no free cash covers it` };
            case 'sell': return { verb: 'Sell', text: `${eur(m.amount)} back to ${account(m.toBrokerId)}` };
            case 'place': return { verb: 'Move', text: `${eur(m.amount)} from ${account(m.fromBrokerId)} to ${portfolioNames(m.portfolioIds)}` };
            default: return { verb: 'Invest', text: `${eur(m.amount)} from ${account(m.fromBrokerId)}` };
        }
    };
    const { totals } = plan;

    return (
        <section className="cov-block cov-block-wide">
            <h4>Cash plan</h4>
            <div className="cp-summary">
                <div>
                    <div className="cov-big">{eur(totals.hold)}</div>
                    <div className="cov-caption">to hold, of {eur(totals.liquidity)} on the accounts</div>
                </div>
                <dl className="cov-list cp-totals">
                    <div title={LAYERS['in-transit'].hint}><dt>In transit to the portfolios</dt><dd>{eur(totals.transit)}</dd></div>
                    <div title={LAYERS.free.hint}><dt>Free</dt><dd>{eur(totals.free)}</dd></div>
                    <div title="What the accounts lack to hold what they have to"><dt>Short</dt><dd className={totals.short > 0.5 ? 'cp-bad' : ''}>{eur(totals.short)}</dd></div>
                    <div title="To hold, plus the cash still to come in for the capex due soon (investments to sell, what is missing). The broker minimums linked to Expense Planning and the liquidity target of the Buckets read these same figures.">
                        <dt>Liquidity target</dt>
                        <dd>{eur(plan.target)}{plan.incoming > 0.5 && <small> · {eur(plan.incoming)} to come in</small>}</dd>
                    </div>
                </dl>
            </div>

            {plan.accounts.map(a => {
                const shown = a.layers.filter(l => l.amount > 0.5);
                const total = shown.reduce((s, l) => s + l.amount, 0);
                return (
                    <div key={a.brokerId} className="cp-account">
                        <div className="cov-aside-head">
                            <strong>{a.brokerName}</strong>
                            <span>
                                {eur(a.liquidity)} · to hold {eur(a.hold)}{' '}
                                {a.short > 0.5
                                    ? <span className="pill pill-bad">short {eur(a.short)}</span>
                                    : <span className="pill pill-ok">in line</span>}
                            </span>
                        </div>
                        {total > 0 && (
                            <div className="cp-bar" role="img" aria-label={shown.map(l => `${LAYERS[l.kind].label} ${eur(l.amount)}`).join(', ')}>
                                {shown.map(l => (
                                    <React.Fragment key={l.kind}>
                                        {l.covered > 0.5 && <div style={{ width: `${(l.covered / total) * 100}%`, background: LAYERS[l.kind].color }} />}
                                        {l.short > 0.5 && <div className="cp-bar-short" style={{ width: `${(l.short / total) * 100}%`, color: LAYERS[l.kind].color }} />}
                                    </React.Fragment>
                                ))}
                            </div>
                        )}
                        <ul className="cp-legend">
                            {shown.map(l => (
                                <li key={l.kind} title={[LAYERS[l.kind].hint, ...l.items.map(i => `${i.name}: ${eur(i.amount)}`)].join('\n')}>
                                    <i style={{ background: LAYERS[l.kind].color }} />
                                    {LAYERS[l.kind].label} <b>{eur(l.amount)}</b>
                                    {l.short > 0.5 && <span className="cp-bad"> · {eur(l.short)} not there</span>}
                                </li>
                            ))}
                        </ul>
                    </div>
                );
            })}

            {plan.moves.length > 0 && (
                <div className="cp-moves">
                    <div className="cov-caption">What follows, in order — free cash tops up what is short before anything is deposited, and only what is left is proposed for investing:</div>
                    <ol>
                        {plan.moves.map((m, i) => {
                            const d = describe(m);
                            return <li key={i}><b>{d.verb}</b> {d.text} <small>· {m.reason}</small></li>;
                        })}
                    </ol>
                </div>
            )}

            <style>{`
                .cp-summary { display: flex; gap: 2rem; flex-wrap: wrap; align-items: flex-start; }
                .cp-totals { flex: 1; min-width: 260px; margin-top: 0; }
                .cp-bad { color: var(--color-danger); }
                .cp-account { border-top: 1px solid var(--border-color); padding-top: 0.5rem; margin-top: 0.3rem; display: flex; flex-direction: column; gap: 0.35rem; }
                .cp-bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--bg-card); }
                .cp-bar > div { min-width: 2px; }
                .cp-bar-short { background: repeating-linear-gradient(135deg, currentColor 0 3px, transparent 3px 6px); opacity: 0.55; }
                .cp-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 0.8rem; color: var(--text-secondary); }
                .cp-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 0.35rem; }
                .cp-legend b { font-variant-numeric: tabular-nums; color: var(--text-primary); }
                .cp-moves { border-top: 1px solid var(--border-color); padding-top: 0.5rem; margin-top: 0.3rem; }
                .cp-moves ol { margin: 0.4rem 0 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
                .cp-moves small { color: var(--text-muted); }
            `}</style>
        </section>
    );
};

export default CashPlanBlock;
