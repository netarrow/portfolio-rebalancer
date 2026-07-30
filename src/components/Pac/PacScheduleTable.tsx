import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import type { PacExecution, PacPlan } from '../../types';
import { generateInstalments } from '../../utils/pacSchedule';
import PacConfirmModal from './PacConfirmModal';
import Swal from 'sweetalert2';

const todayISO = () => new Date().toISOString().slice(0, 10);

type RowStatus = 'due' | 'upcoming' | 'registered' | 'skipped';

interface Row {
    plan: PacPlan;
    dueDate: string;
    status: RowStatus;
    execution?: PacExecution;
}

const PacScheduleTable: React.FC = () => {
    const { pacPlans, pacExecutions, portfolios, brokers, skipPacInstalment, unskipPacInstalment, undoPacInstalment } = usePortfolio();
    const [confirmTarget, setConfirmTarget] = useState<{ plan: PacPlan; dueDate: string } | null>(null);
    const today = todayISO();

    const rows: Row[] = useMemo(() => {
        const result: Row[] = [];
        for (const plan of pacPlans) {
            const dueDates = generateInstalments(plan, today, plan.active ? 1 : 0);
            for (const dueDate of dueDates) {
                const execution = pacExecutions.find(e => e.planId === plan.id && e.dueDate === dueDate);
                if (!execution && !plan.active) continue;
                let status: RowStatus;
                if (execution?.skipped) status = 'skipped';
                else if (execution?.transactionId) status = 'registered';
                else if (dueDate > today) status = 'upcoming';
                else status = 'due';
                result.push({ plan, dueDate, status, execution });
            }
        }
        return result.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
    }, [pacPlans, pacExecutions, today]);

    const handleSkip = (row: Row) => {
        Swal.fire({
            title: 'Skip this installment?',
            text: `Skip the ${row.dueDate} installment for "${row.plan.name}"? No transaction will be recorded.`,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, skip it',
        }).then(result => {
            if (result.isConfirmed) skipPacInstalment(row.plan.id, row.dueDate);
        });
    };

    const handleUndo = (row: Row) => {
        Swal.fire({
            title: 'Undo this installment?',
            text: `This removes the recorded transaction for "${row.plan.name}" on ${row.dueDate} and reverts any parked residue.`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'Yes, undo it',
        }).then(result => {
            if (result.isConfirmed) undoPacInstalment(row.plan.id, row.dueDate);
        });
    };

    if (pacPlans.length === 0) return null;

    return (
        <div className="pac-schedule-card">
            <h2>Installments</h2>
            {rows.length === 0 ? (
                <p className="pac-empty-note">No installments to show yet.</p>
            ) : (
                <div className="pac-schedule-scroll">
                    <table className="pac-schedule-table">
                        <thead>
                            <tr>
                                <th>Due date</th>
                                <th>Plan</th>
                                <th>Ticker</th>
                                <th>Status</th>
                                <th>Quantity</th>
                                <th>Price</th>
                                <th>Fee</th>
                                <th>Residue parked</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => {
                                const portfolio = portfolios.find(p => p.id === row.plan.portfolioId);
                                const broker = brokers.find(b => b.id === row.plan.brokerId);
                                return (
                                    <tr key={`${row.plan.id}-${row.dueDate}`}>
                                        <td>{row.dueDate}</td>
                                        <td>{row.plan.name}</td>
                                        <td>{row.plan.ticker}</td>
                                        <td><span className={`pac-status-badge pac-status-${row.status}`}>{row.status}</span></td>
                                        <td>{row.execution?.quantity !== undefined ? row.execution.quantity.toLocaleString('en-IE', { maximumFractionDigits: 6 }) : '—'}</td>
                                        <td>{row.execution?.price !== undefined ? `€${row.execution.price.toFixed(2)}` : '—'}</td>
                                        <td>{row.execution?.cost !== undefined ? `€${row.execution.cost.toFixed(2)}` : '—'}</td>
                                        <td>
                                            {row.execution?.carryOut ? `€${row.execution.carryOut.toFixed(2)} on ${broker?.name || '?'} / ${portfolio?.name || '?'}` : '—'}
                                        </td>
                                        <td>
                                            {row.status === 'due' && (
                                                <div style={{ display: 'flex', gap: '6px' }}>
                                                    <button className="btn btn-primary" style={{ padding: '4px 10px', fontSize: '0.8rem' }} onClick={() => setConfirmTarget({ plan: row.plan, dueDate: row.dueDate })}>Confirm</button>
                                                    <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '0.8rem' }} onClick={() => handleSkip(row)}>Skip</button>
                                                </div>
                                            )}
                                            {row.status === 'registered' && (
                                                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '0.8rem' }} onClick={() => handleUndo(row)}>Undo</button>
                                            )}
                                            {row.status === 'skipped' && (
                                                <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '0.8rem' }} onClick={() => unskipPacInstalment(row.plan.id, row.dueDate)}>Unskip</button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {confirmTarget && (
                <PacConfirmModal plan={confirmTarget.plan} dueDate={confirmTarget.dueDate} onClose={() => setConfirmTarget(null)} />
            )}

            <style>{`
                .pac-schedule-card {
                    background-color: var(--bg-surface);
                    border-radius: var(--radius-lg);
                    padding: var(--space-4);
                    margin-top: var(--space-6);
                }
                .pac-schedule-card h2 { margin: 0 0 var(--space-4) 0; font-size: 1.25rem; color: var(--text-primary); }
                .pac-empty-note { color: var(--text-secondary); font-size: 0.9rem; }
                .pac-schedule-scroll { overflow-x: auto; }
                .pac-schedule-table { width: 100%; border-collapse: collapse; min-width: 760px; }
                .pac-schedule-table th {
                    text-align: left;
                    padding: var(--space-2) var(--space-3);
                    color: var(--text-muted);
                    font-weight: 500;
                    border-bottom: 1px solid var(--bg-card);
                    font-size: 0.8rem;
                    white-space: nowrap;
                }
                .pac-schedule-table td {
                    padding: var(--space-2) var(--space-3);
                    border-bottom: 1px solid var(--bg-card);
                    color: var(--text-primary);
                    font-size: 0.85rem;
                    white-space: nowrap;
                }
                .pac-status-badge {
                    display: inline-block;
                    padding: 2px 8px;
                    border-radius: var(--radius-full);
                    font-size: 0.75rem;
                    font-weight: 600;
                    text-transform: capitalize;
                }
                .pac-status-due { background-color: rgba(245, 158, 11, 0.15); color: #b45309; }
                .pac-status-upcoming { background-color: var(--bg-card); color: var(--text-secondary); }
                .pac-status-registered { background-color: rgba(16, 185, 129, 0.15); color: var(--color-success); }
                .pac-status-skipped { background-color: rgba(148, 163, 184, 0.15); color: var(--text-muted); }
            `}</style>
        </div>
    );
};

export default PacScheduleTable;
