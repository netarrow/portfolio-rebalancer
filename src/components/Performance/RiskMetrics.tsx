import React from 'react';
import type { RiskMetrics } from '../../utils/performanceCalculations';

interface RiskMetricsRowProps {
    metrics: RiskMetrics | null;
    /** Optional heading rendered above the metric cards. */
    title?: string;
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
 * Compact row of risk metric cards: annualized volatility, Sharpe ratio and
 * max drawdown. Renders nothing when metrics couldn't be computed (too little
 * history). Shared by the Performance view and the stats Overview tab.
 */
const RiskMetricsRow: React.FC<RiskMetricsRowProps> = ({ metrics, title }) => {
    if (!metrics) return null;

    const sharpeColor = metrics.sharpe >= 0 ? 'var(--color-success)' : 'var(--color-danger)';

    return (
        <div>
            {title && (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                    {title}
                </div>
            )}
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                <div style={cardStyle} title="Deviazione standard annualizzata dei rendimenti (i flussi di cassa esterni sono esclusi). Misura quanto oscilla il valore.">
                    <div style={labelStyle}>Volatilità (ann.)</div>
                    <div style={{ ...valueStyle, color: 'var(--text-primary)' }}>
                        {metrics.volatility.toFixed(1)}%
                    </div>
                </div>
                <div style={cardStyle} title="Rendimento annualizzato in eccesso diviso per la volatilità (tasso privo di rischio = 0%). Più alto è, migliore è il rendimento corretto per il rischio.">
                    <div style={labelStyle}>Sharpe Ratio</div>
                    <div style={{ ...valueStyle, color: sharpeColor }}>
                        {metrics.sharpe.toFixed(2)}
                    </div>
                </div>
                <div style={cardStyle} title="Massima perdita dal picco al minimo successivo, calcolata sull'indice dei rendimenti composti.">
                    <div style={labelStyle}>Max Drawdown</div>
                    <div style={{ ...valueStyle, color: 'var(--color-danger)' }}>
                        -{metrics.maxDrawdown.toFixed(1)}%
                    </div>
                </div>
            </div>
        </div>
    );
};

export default RiskMetricsRow;
