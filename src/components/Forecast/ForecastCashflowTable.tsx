import React from 'react';
import type { CashflowTable, CashflowGranularity } from '../../utils/forecastCashflow';

interface Props {
    table: CashflowTable;
    granularity: CashflowGranularity;
    /** Shown in the caption: which path the numbers come from. */
    sourceLabel: string;
    /** Monte Carlo only: the ensemble's drawdown reference for context. */
    note?: string;
}

const fmt = (n: number) => `€${Math.round(n).toLocaleString()}`;
const fmtSigned = (n: number) => `${n >= 0 ? '+' : '−'}€${Math.round(Math.abs(n)).toLocaleString()}`;

const th: React.CSSProperties = {
    position: 'sticky',
    top: 0,
    background: 'var(--bg-card)',
    color: 'var(--text-muted)',
    fontSize: '0.7rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
    textAlign: 'right',
    padding: '0.45rem 0.35rem',
    borderBottom: '1px solid var(--border-color)',
    whiteSpace: 'nowrap',
};

const td: React.CSSProperties = {
    textAlign: 'right',
    padding: '0.4rem 0.35rem',
    fontSize: '0.8rem',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap',
};

// Footer cells stay pinned to the bottom of the scroll box: `position: sticky`
// on the row itself isn't honoured everywhere, so it goes on the cells.
const tf: React.CSSProperties = {
    ...td,
    position: 'sticky',
    bottom: 0,
    background: 'var(--bg-surface)',
    borderTop: '1px solid var(--border-color)',
};

/**
 * Cash-flow view of the forecast: one row per period, reading left to right as
 * the money actually moves — what you started with, what the income added, what
 * the planned expenses took, what the market did, and what is left. The four
 * middle columns reconcile to the closing value exactly.
 *
 * The first row is Year 0: today, before the first simulated month. It has no
 * flows of its own — every flow column is a dash — and it is there so the jump
 * to Year 1 is read against a figure in the table rather than against a caption.
 */
const ForecastCashflowTable: React.FC<Props> = ({ table, granularity, sourceLabel, note }) => {
    const { rows, totals } = table;
    if (rows.length === 0) {
        return (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '2rem', textAlign: 'center' }}>
                Nothing to project yet — set a time horizon and at least one portfolio.
            </div>
        );
    }

    const growth = totals.closingValue - totals.openingValue;

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.6rem', lineHeight: 1.45 }}>
                Starting net worth today, in the Year 0 row: <strong style={{ color: 'var(--text-secondary)' }}>{fmt(totals.openingValue)}</strong>. {sourceLabel}
                {note && <> · {note}</>}
            </div>

            <div style={{ flex: 1, overflow: 'auto', minHeight: 0, borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr>
                            <th style={{ ...th, textAlign: 'left' }}>{granularity === 'year' ? 'Year' : 'Month'}</th>
                            <th style={th} title="Recurring income minus recurring expenses over the period">Income</th>
                            <th style={th} title="One-off planned expenses (manual + YNAB goals) due in the period. They erode liquidity first, then the portfolios allowed by their goal.">Expenses</th>
                            <th style={th} title="What the market added or took away: the return on the invested capital over the period">Market</th>
                            <th style={th} title="Deepest dip below the high-water mark reached inside the period">Dip</th>
                            <th style={th} title="Liquidity left on the brokers at the end of the period, and how much it moved">Cash</th>
                            <th style={th} title="Net worth at the end of the period — opening + income − planned expenses + market P/L">Net worth</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(r => {
                            const flagged = r.insolvencyStarts || r.ruleBreachStarts;
                            // Today: nothing has happened yet, so the flow columns
                            // are dashes rather than a row of zeros pretending to
                            // be a period.
                            if (r.isOpening) {
                                return (
                                    <tr key={r.key} style={{ borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface)' }}>
                                        <td style={{ ...td, textAlign: 'left', color: 'var(--text-secondary)' }}>
                                            {r.label}
                                            <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>today</span>
                                        </td>
                                        <td colSpan={4} style={{ ...td, color: 'var(--text-muted)', fontSize: '0.75rem', textAlign: 'right' }}>
                                            where the money stands before the first simulated month
                                        </td>
                                        <td style={{ ...td, fontSize: '0.78rem', color: 'var(--text-secondary)' }} title="Broker liquidity today">
                                            {fmt(r.liquidityValue)}
                                        </td>
                                        <td style={{ ...td, fontWeight: 600 }} title="Net worth today — every row below builds on this">
                                            {fmt(r.closingValue)}
                                        </td>
                                    </tr>
                                );
                            }
                            return (
                                <tr
                                    key={r.key}
                                    style={{
                                        borderBottom: '1px solid var(--border-color)',
                                        background: flagged ? 'rgba(239, 68, 68, 0.08)' : undefined,
                                    }}
                                >
                                    <td style={{ ...td, textAlign: 'left', color: 'var(--text-secondary)' }}>
                                        {r.label}
                                        {r.insolvencyStarts && (
                                            <span title="From here the plan cannot pay an expense at all" style={{ marginLeft: '0.4rem', color: '#EF4444' }}>⛔</span>
                                        )}
                                        {!r.insolvencyStarts && r.ruleBreachStarts && (
                                            <span title="From here an expense has to be paid from portfolios its goal does not allow" style={{ marginLeft: '0.4rem', color: '#F59E0B' }}>⚠</span>
                                        )}
                                    </td>
                                    <td style={{ ...td, color: r.income >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                        {r.income === 0 ? '—' : fmtSigned(r.income)}
                                    </td>
                                    <td style={{ ...td, color: r.plannedExpenses > 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                        {r.plannedExpenses > 0 ? `−${fmt(r.plannedExpenses)}` : '—'}
                                    </td>
                                    <td style={{ ...td, color: r.marketPnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                        {fmtSigned(r.marketPnl)}
                                    </td>
                                    <td
                                        style={{ ...td, color: r.drawdownPct < -0.05 ? 'var(--color-danger)' : 'var(--text-muted)', fontSize: '0.78rem' }}
                                        title={r.drawdownPct < -0.05 ? `Down to ${fmt(r.troughValue)} at the worst point of the period` : 'Never below the high-water mark'}
                                    >
                                        {r.drawdownPct < -0.05 ? `${r.drawdownPct.toFixed(1)}%` : '—'}
                                    </td>
                                    <td
                                        style={{
                                            ...td,
                                            fontSize: '0.78rem',
                                            color: Math.abs(r.liquidityDelta) < 1
                                                ? 'var(--text-secondary)'
                                                : r.liquidityDelta > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                                        }}
                                        title={Math.abs(r.liquidityDelta) < 1
                                            ? 'Broker liquidity unchanged over the period'
                                            : `Broker liquidity ${r.liquidityDelta > 0 ? 'up' : 'down'} ${fmtSigned(r.liquidityDelta)} over the period`}
                                    >
                                        {fmt(r.liquidityValue)}
                                    </td>
                                    <td
                                        style={{ ...td, fontWeight: 600 }}
                                        title={`Opened at ${fmt(r.openingValue)} · ${fmt(r.openingValue)} ${r.income >= 0 ? '+' : '−'} ${fmt(Math.abs(r.income))}${r.plannedExpenses > 0 ? ` − ${fmt(r.plannedExpenses)}` : ''} ${r.marketPnl >= 0 ? '+' : '−'} ${fmt(Math.abs(r.marketPnl))} = ${fmt(r.closingValue)}`}
                                    >
                                        {fmt(r.closingValue)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td style={{ ...tf, textAlign: 'left', fontWeight: 700, color: 'var(--text-secondary)' }}>Total</td>
                            <td style={{ ...tf, fontWeight: 600, color: totals.income >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {fmtSigned(totals.income)}
                            </td>
                            <td style={{ ...tf, fontWeight: 600, color: totals.plannedExpenses > 0 ? 'var(--color-danger)' : 'var(--text-muted)' }}>
                                {totals.plannedExpenses > 0 ? `−${fmt(totals.plannedExpenses)}` : '—'}
                            </td>
                            <td style={{ ...tf, fontWeight: 600, color: totals.marketPnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                {fmtSigned(totals.marketPnl)}
                            </td>
                            <td style={{ ...tf, color: table.worstDrawdownPct < -0.05 ? 'var(--color-danger)' : 'var(--text-muted)', fontSize: '0.78rem' }}
                                title={table.worstDrawdownLabel ? `Deepest dip of the whole path, in ${table.worstDrawdownLabel}` : 'The path never dips below its high-water mark'}>
                                {table.worstDrawdownPct < -0.05 ? `${table.worstDrawdownPct.toFixed(1)}%` : '—'}
                            </td>
                            <td style={{ ...tf }} />
                            <td style={{ ...tf, fontWeight: 700 }} title={`${growth >= 0 ? 'Growth' : 'Loss'} over the whole horizon`}>
                                {fmt(totals.closingValue)}
                                <div style={{ fontSize: '0.7rem', fontWeight: 500, color: growth >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                                    {fmtSigned(growth)}
                                </div>
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    );
};

export default ForecastCashflowTable;
