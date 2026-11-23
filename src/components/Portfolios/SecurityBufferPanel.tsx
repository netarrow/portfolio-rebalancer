import React, { useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import type { PyramidRole, SecurityBufferSettings } from '../../types';
import type { SecurityBufferGroupReport, SecurityBufferWarning } from '../../utils/securityBuffer';
import { RF_STALE_MONTHS } from '../../utils/securityBuffer';
import { useSecurityBuffer } from './useSecurityBuffer';
import './SecurityBuffer.css';

/**
 * Security Buffer target, on the Portfolios page next to the parent/child
 * ratio it proposes to change: the settings (age, risk-free rate, floor,
 * credit, the pyramid role of each portfolio), the pyramid coverage, and per
 * CRESCITA group the buffer target, the gap, the proposed ratio and where new
 * money should go. Nothing is saved without a confirmation, and no sale is
 * ever suggested.
 */

const eur = (v: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(v);
const pct = (v: number | null | undefined, digits = 1) => v === null || v === undefined ? '—' : `${v.toFixed(digits)}%`;
const ratio = (v: number) => `${(v * 100).toFixed(0)}%`;

const ROLE_LABELS: Record<PyramidRole, string> = {
    emergency: 'EMERGENZA (L1)',
    goal: 'GOAL (L2)',
    growth: 'CRESCITA (L3)',
    excluded: 'ESCLUSO',
};

const parseNum = (raw: string): number | undefined => {
    const t = raw.trim().replace(',', '.');
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
};

const SecurityBufferPanel: React.FC = () => {
    const { portfolios, securityBufferSettings: settings, setSecurityBufferSettings, updatePortfolio } = usePortfolio();
    const { report, emergencyMonths, fixedMonthly } = useSecurityBuffer();
    const [open, setOpen] = useState(true);
    const nameOf = (id: string) => portfolios.find(p => p.id === id)?.name ?? id;

    const set = (patch: Partial<SecurityBufferSettings>) => setSecurityBufferSettings({ ...settings, ...patch });
    const setRole = (id: string, role: PyramidRole | '') => {
        const roles = { ...settings.roles };
        if (role === '') delete roles[id];
        else roles[id] = role;
        set({ roles });
    };

    const warningText = (w: SecurityBufferWarning): string => {
        switch (w.kind) {
            case 'missing-birth-year': return 'Year of birth missing: no target until it is set.';
            case 'missing-rf': return 'Risk-free rate missing: no target until it is set.';
            case 'missing-rf-date': return 'Reference date of the risk-free rate missing.';
            case 'stale-rf': return `The risk-free rate dates from ${w.date} (${w.months} months ago, more than ${RF_STALE_MONTHS}): update it.`;
            case 'missing-l1-target': return 'No emergency fund target from Expense Planning (set the months and classify fixed spending as Structural): L1 counts as covered.';
            case 'no-growth-group': return 'No portfolio has the CRESCITA role: assign it to the parent of the growth group.';
            case 'no-buffer-child': return `${nameOf(w.parentId)} has no child portfolio: there is no BUFFER to size.`;
            case 'goal-no-cycle': return `"${w.name}" is more than 12 months away and has no cycle: the whole amount is required now.`;
            case 'goal-incomplete': return `"${w.name}" has no amount or no due date: left out of L2.`;
            case 'funding-outside-goal-portfolios': return `"${w.name}": ${eur(w.amount)} allocated from ${w.portfolioIds.map(nameOf).join(', ')} (not GOAL portfolios) is not counted as funded.`;
            case 'unassigned-portfolios': return `No role for ${w.portfolioIds.map(nameOf).join(', ')}: not counted.`;
            case 'max-raised-to-min': return 'b · L3 is below the floor: Max is raised to Min.';
        }
    };

    const applyRatio = async (g: SecurityBufferGroupReport) => {
        if (!g.proposedRatio) return;
        const members = [g.parentId, ...g.childIds];
        const rows = members.map(id => {
            const p = portfolios.find(x => x.id === id);
            const before = p?.groupSharePercent;
            return `<tr><td style="text-align:left;padding:2px 8px">${p?.name ?? id}</td><td style="padding:2px 8px">${before === undefined ? 'by value' : `${before}%`}</td><td style="padding:2px 8px"><b>${g.proposedRatio![id]}%</b></td></tr>`;
        }).join('');
        const res = await Swal.fire({
            title: 'Update the group ratio?',
            html: `<table style="margin:0 auto;font-size:0.9rem"><tr><th style="text-align:left;padding:2px 8px">Portfolio</th><th style="padding:2px 8px">Now</th><th style="padding:2px 8px">Proposed</th></tr>${rows}</table>
                <p style="font-size:0.8rem;margin-top:0.75rem">Only the ratio changes: no order is created, nothing is sold. New money will follow the new split.</p>`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Save ratio',
        });
        if (!res.isConfirmed) return;
        members.forEach(id => {
            const p = portfolios.find(x => x.id === id);
            if (p) updatePortfolio({ ...p, groupSharePercent: g.proposedRatio![id] });
        });
    };

    const ordered = [...portfolios].sort((a, b) => a.order - b.order);
    const hasGrowth = report.groups.length > 0;

    return (
        <section className="sb-panel">
            <button type="button" className="sb-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
                <span>{open ? '▾' : '▸'} Security Buffer target</span>
                {hasGrowth && report.groups[0].target && (
                    <span className="sb-toggle-sum">
                        {report.groups.map(g => `${nameOf(g.parentId)}: ${eur(g.target!.target)} (${pct(g.childShareTarget)})`).join(' · ')}
                    </span>
                )}
            </button>
            {open && (
                <div className="sb-body">
                    <p className="sb-intro">
                        How much of each growth group to hold in its BUFFER children. The more the pyramid underneath is
                        uncovered — emergency fund below target, goals behind their saving plan — the higher the buffer;
                        it comes down by itself once the pyramid is rebuilt.
                    </p>

                    {report.warnings.length > 0 && (
                        <ul className="sb-warnings">
                            {report.warnings.map((w, i) => <li key={i}>⚠ {warningText(w)}</li>)}
                        </ul>
                    )}

                    <div className="sb-grid">
                        {/* ── Settings ─────────────────────────────── */}
                        <div className="sb-card">
                            <h4>Settings</h4>
                            <label className="sb-field">
                                <span>Year of birth</span>
                                <input type="number" className="form-input" min={1900} max={2100} value={settings.birthYear ?? ''}
                                    onChange={e => set({ birthYear: parseNum(e.target.value) })} />
                                <small>{report.age !== null ? `age ${report.age}` : ''}</small>
                            </label>
                            <label className="sb-field">
                                <span>Risk-free rate %</span>
                                <input type="number" className="form-input" step={0.05} value={settings.riskFreePct ?? ''}
                                    onChange={e => set({ riskFreePct: parseNum(e.target.value) })} />
                            </label>
                            <label className="sb-field">
                                <span>… as of</span>
                                <input type="date" className="form-input" value={settings.riskFreeDate ?? ''}
                                    onChange={e => set({ riskFreeDate: e.target.value || undefined })} />
                            </label>
                            <label className="sb-field">
                                <span>Floor (% of L3)</span>
                                <input type="number" className="form-input" min={0} max={100} step={1} value={settings.minPct}
                                    onChange={e => set({ minPct: parseNum(e.target.value) ?? 0 })} />
                            </label>
                            <label className="sb-field">
                                <span>Pyramid credit</span>
                                <input type="number" className="form-input" min={0} max={1} step={0.05} value={settings.pyramidCredit}
                                    onChange={e => set({ pyramidCredit: parseNum(e.target.value) ?? 0 })} />
                            </label>
                            <div className="sb-field">
                                <span>L1 target</span>
                                <strong>{eur(report.l1Target)}</strong>
                                <small>Expense Planning: {emergencyMonths} months × {eur(fixedMonthly)} fixed spending</small>
                            </div>
                        </div>

                        {/* ── Roles ────────────────────────────────── */}
                        <div className="sb-card">
                            <h4>Pyramid roles</h4>
                            <div className="sb-roles">
                                {ordered.map(p => {
                                    const derived = report.roleOf[p.id] === 'buffer';
                                    return (
                                        <label key={p.id} className="sb-role">
                                            <span className="sb-role-name">{p.parentId ? '↳ ' : ''}{p.name}</span>
                                            {derived ? (
                                                <span className="sb-role-derived" title="Child of a CRESCITA parent: the buffer by derivation">BUFFER (child)</span>
                                            ) : (
                                                <select className="form-input" value={settings.roles[p.id] ?? ''}
                                                    onChange={e => setRole(p.id, e.target.value as PyramidRole | '')}>
                                                    <option value="">— not set —</option>
                                                    {(Object.keys(ROLE_LABELS) as PyramidRole[]).map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                                                </select>
                                            )}
                                        </label>
                                    );
                                })}
                            </div>
                            <small className="sb-note">Operating cash on the accounts is never L1. Values are market values of the holdings, broker cash excluded, in the current counting scope.</small>
                        </div>

                        {/* ── Pyramid coverage ─────────────────────── */}
                        <div className="sb-card">
                            <h4>Pyramid coverage</h4>
                            <dl className="sb-dl">
                                <div><dt>L1 · emergency</dt><dd>{eur(report.l1)} / {eur(report.l1Target)}</dd></div>
                                <div><dt>C<sub>L1</sub></dt><dd>{ratio(report.cL1)}</dd></div>
                                <div><dt>L2 · goals covered / required</dt><dd>{eur(report.goals.covered)} / {eur(report.goals.required)}</dd></div>
                                <div><dt>C<sub>L2</sub></dt><dd>{ratio(report.cL2)}</dd></div>
                                <div className="sb-strong"><dt>C</dt><dd>{ratio(report.coverage)}</dd></div>
                                {report.goalFreeValue > 0 && (
                                    <div className="sb-muted"><dt>Free in GOAL portfolios (not counted)</dt><dd>{eur(report.goalFreeValue)}</dd></div>
                                )}
                            </dl>
                            {report.goals.goals.length > 0 && (
                                <table className="sb-table">
                                    <thead><tr><th>Goal</th><th>Due</th><th>Required</th><th>Covered</th></tr></thead>
                                    <tbody>
                                        {[...report.goals.goals].sort((a, b) => a.yearsLeft - b.yearsLeft).map(g => (
                                            <tr key={g.id}>
                                                <td>{g.name}{g.basis === 'no-cycle' && <span title="No cycle: whole amount required"> ⚠</span>}</td>
                                                <td>{g.targetDate.slice(0, 7)}{g.cycleYears ? ` · ${g.cycleYears}y` : ''}</td>
                                                <td>{eur(g.required)}<small> / {eur(g.amount)}</small></td>
                                                <td className={g.covered + 0.5 < g.required ? 'sb-bad' : 'sb-ok'}>{eur(g.covered)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>

                    {/* ── Per growth group ─────────────────────────── */}
                    {report.groups.map(g => (
                        <div key={g.parentId} className="sb-card sb-group">
                            <h4>{nameOf(g.parentId)} {g.childIds.length > 0 && <small>+ {g.childIds.map(nameOf).join(', ')}</small>}</h4>
                            {g.target ? (
                                <>
                                    <div className="sb-kpis">
                                        <div><span>b</span><strong>{g.target.b.toFixed(3)}</strong></div>
                                        <div><span>L3</span><strong>{eur(g.l3)}</strong></div>
                                        <div><span>Max</span><strong>{eur(g.target.max)}</strong></div>
                                        <div><span>Min</span><strong>{eur(g.target.min)}</strong></div>
                                        <div className="sb-kpi-main"><span>Target</span><strong>{eur(g.target.target)}</strong></div>
                                        <div><span>Buffer now</span><strong>{eur(g.bufferValue)}</strong></div>
                                        <div className={g.gap! > 0 ? 'sb-kpi-bad' : 'sb-kpi-ok'}>
                                            <span>Gap</span>
                                            <strong>{g.gap! > 0 ? '+' : ''}{eur(g.gap!)} <small>({g.gapPctOfL3! > 0 ? '+' : ''}{pct(g.gapPctOfL3)} of L3)</small></strong>
                                        </div>
                                    </div>
                                    <div className="sb-shares">
                                        <span>Child share: now <b>{pct(g.childShareNow)}</b> by value
                                            {g.childShareConfigured !== null && <> · ratio <b>{pct(g.childShareConfigured)}</b></>}
                                            {' '}→ target <b>{pct(g.childShareTarget)}</b> (parent {pct(g.parentShareTarget)})</span>
                                        {g.proposedRatio && (
                                            <button type="button" className="btn btn-secondary sb-apply" onClick={() => applyRatio(g)}>
                                                Update group ratio…
                                            </button>
                                        )}
                                    </div>
                                    <div className="sb-flows">
                                        <span className="sb-flows-title">New money, in this order (never a sale):</span>
                                        <ol>
                                            {g.flows.map((f, i) => (
                                                <li key={i}>
                                                    <b>{f.level}</b>{' '}
                                                    {f.amount !== null ? eur(f.amount) : 'the rest'} — {f.level === 'L2' ? `goal "${f.label}"` : f.label}
                                                    {f.portfolioIds.length > 0 && <> → {f.portfolioIds.map(nameOf).join(', ')}</>}
                                                </li>
                                            ))}
                                        </ol>
                                        {g.gap !== null && g.gap < 0 && (
                                            <small className="sb-note">The buffer is {eur(-g.gap)} above target: keep it, and let new money go to growth until the share is back.</small>
                                        )}
                                    </div>
                                </>
                            ) : (
                                <p className="sb-note">Set the year of birth and the risk-free rate to compute the target.</p>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};

export default SecurityBufferPanel;
