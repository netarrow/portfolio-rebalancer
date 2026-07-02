import React from 'react';
import type { ReturnStats } from '../../utils/performanceCalculations';

interface RiskMetricsRowProps {
    stats: ReturnStats | null;
    /** Optional heading rendered above the metric cards. */
    title?: string;
    /** Risk-free rate (%) used for Sharpe, shown in the tooltip. */
    riskFreePct?: number;
}

const cardStyle: React.CSSProperties = {
    background: 'var(--bg-card)',
    borderRadius: 'var(--radius-md)',
    padding: '0.9rem 1.1rem',
    minWidth: '140px',
    flex: '1 1 140px',
};

const labelStyle: React.CSSProperties = {
    color: 'var(--text-muted)',
    fontSize: '0.75rem',
    marginBottom: '0.3rem',
};

const valueStyle: React.CSSProperties = {
    fontWeight: 700,
    fontSize: '1.25rem',
    fontVariantNumeric: 'tabular-nums',
};

/**
 * Compact row of risk metric cards: annualized return, volatility, Sharpe and
 * max drawdown, read from the shared flow-adjusted ReturnStats. Renders nothing
 * when stats couldn't be computed (too little history). Shared by the
 * Performance view and the stats Overview tab, so both show identical numbers.
 */
const RiskMetricsRow: React.FC<RiskMetricsRowProps> = ({ stats, title, riskFreePct = 0 }) => {
    if (!stats) return null;

    return (
        <div>
            {title && (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                    {title}
                </div>
            )}
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={cardStyle} title="Rendimento annualizzato composto (CAGR) del flusso di rendimenti al netto dei versamenti/prelievi.">
                    <div style={labelStyle}>Rendimento (ann.)</div>
                    <div style={{ ...valueStyle, color: stats.annualizedReturnPct >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                        {stats.annualizedReturnPct >= 0 ? '+' : ''}{stats.annualizedReturnPct.toFixed(1)}%
                    </div>
                </div>
                {stats.annualizedVolatilityPct !== null && (
                    <div style={cardStyle} title="Deviazione standard annualizzata dei rendimenti (i flussi di cassa esterni sono esclusi). Misura quanto oscilla il valore.">
                        <div style={labelStyle}>Volatilità (ann.)</div>
                        <div style={{ ...valueStyle, color: 'var(--text-primary)' }}>
                            {stats.annualizedVolatilityPct.toFixed(1)}%
                        </div>
                    </div>
                )}
                {stats.sharpe !== null && (
                    <div style={cardStyle} title={`Rendimento annualizzato in eccesso (oltre il tasso privo di rischio ${riskFreePct}%) diviso per la volatilità. Più alto è, migliore è il rendimento corretto per il rischio.`}>
                        <div style={labelStyle}>Sharpe Ratio</div>
                        <div style={{ ...valueStyle, color: stats.sharpe >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            {stats.sharpe.toFixed(2)}
                        </div>
                    </div>
                )}
                <div style={cardStyle} title="Massima perdita dal picco al minimo successivo, calcolata sull'indice dei rendimenti al netto dei flussi (un prelievo non conta come perdita).">
                    <div style={labelStyle}>Max Drawdown</div>
                    <div style={{ ...valueStyle, color: stats.maxDrawdownPct < 0 ? 'var(--color-danger)' : 'var(--text-primary)' }}>
                        {stats.maxDrawdownPct.toFixed(1)}%
                    </div>
                </div>
            </div>
        </div>
    );
};

export default RiskMetricsRow;
