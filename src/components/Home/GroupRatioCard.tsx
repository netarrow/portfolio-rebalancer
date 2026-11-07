import React, { useMemo } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { buildMergedPortfolioView } from '../../utils/mergedPortfolioView';
import { groupRatioDrifts } from '../../utils/groupRatioDrift';
import { GROUP_MEMBER_COLORS } from '../../utils/portfolioGroups';

const eur = (v: number) => `€${Math.round(v).toLocaleString('en-IE')}`;
/** Below this the group reads as in line: nothing worth suggesting. */
const DRIFT_NOTICE_POINTS = 1;

/**
 * Parent/child groups against the ratio set on the Portfolios page, with the
 * two ways back — buy only or full rebalance — shown as options, not queued.
 */
const GroupRatioCard: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
    const { portfolios, scopedTransactions, scopedBrokers, effectiveAssetSettings, marketData } = usePortfolio();
    const drifts = useMemo(() => {
        const view = buildMergedPortfolioView({
            portfolios, transactions: scopedTransactions, brokers: scopedBrokers, assetSettings: effectiveAssetSettings, marketData,
        });
        return groupRatioDrifts(view.groups, id => portfolios.find(p => p.id === id)?.name ?? '—');
    }, [portfolios, scopedTransactions, scopedBrokers, effectiveAssetSettings, marketData]);

    if (drifts.length === 0) return null;
    const nameOf = (id: string) => portfolios.find(p => p.id === id)?.name ?? '—';

    return (
        <section className="home-card">
            <div className="home-card-head">
                <h3>Parent / child groups</h3>
                <button type="button" className="home-link-inline" onClick={onOpen}>Portfolios →</button>
            </div>
            <span className="home-muted">Against the ratio set on the Portfolios page · options only, nothing is queued</span>
            {drifts.map(d => {
                const inLine = d.driftPoints < DRIFT_NOTICE_POINTS;
                const buyers = d.members.filter(m => m.buy >= 0.5);
                return (
                    <div key={d.groupId} className="home-group">
                        <div className="home-bucket-top">
                            <span><b>{nameOf(d.parentId)}</b> <span className="home-muted">group · {eur(d.total)}</span></span>
                            <span className={`home-group-tag ${inLine ? 'is-ok' : d.driftPoints >= 5 ? 'is-bad' : 'is-warn'}`}>
                                {inLine ? 'in line' : `${d.driftPoints.toFixed(1)} pts off`}
                            </span>
                        </div>
                        <ul className="home-buckets">
                            {d.members.map((m, i) => {
                                const off = (m.currentShare - m.targetShare) * 100;
                                return (
                                    <li key={m.portfolioId}>
                                        <div className="home-bucket-top">
                                            <span><span className="home-dot" style={{ background: GROUP_MEMBER_COLORS[i % GROUP_MEMBER_COLORS.length] }} />{m.name}</span>
                                            <span>
                                                <b>{(m.currentShare * 100).toFixed(1)}%</b>
                                                <span className={`home-muted ${Math.abs(off) >= DRIFT_NOTICE_POINTS ? (off > 0 ? 'is-over' : 'is-under') : ''}`}> / {(m.targetShare * 100).toFixed(0)}% target</span>
                                            </span>
                                        </div>
                                        <div className="home-bar">
                                            <span style={{ width: `${m.currentShare * 100}%`, background: GROUP_MEMBER_COLORS[i % GROUP_MEMBER_COLORS.length] }} />
                                            <i style={{ left: `${m.targetShare * 100}%` }} title={`Target ${(m.targetShare * 100).toFixed(1)}%`} />
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                        {!inLine && (
                            <dl className="home-group-options">
                                <dt>Buy only</dt>
                                <dd>
                                    {buyers.length > 0
                                        ? <>add <b>{eur(d.buyOnlyCash)}</b>: {buyers.map((m, i) => <React.Fragment key={m.portfolioId}>{i > 0 && ', '}{m.name} <span className="home-nowrap">+{eur(m.buy)}</span></React.Fragment>)}</>
                                        : 'nothing to buy'}
                                    {d.buyOnlyPartial && <span className="home-muted"> · a member at 0% keeps its money: only a full rebalance empties it</span>}
                                </dd>
                                <dt>Full rebalance</dt>
                                <dd>
                                    move <b>{eur(d.moveTotal)}</b>: {d.moves.map((mv, i) => <React.Fragment key={`${mv.fromId}-${mv.toId}`}>{i > 0 && ', '}{nameOf(mv.fromId)} → {nameOf(mv.toId)} <span className="home-nowrap">{eur(mv.amount)}</span></React.Fragment>)}
                                </dd>
                            </dl>
                        )}
                    </div>
                );
            })}
        </section>
    );
};

export default GroupRatioCard;
