import React from 'react';
import { usePortfolio } from '../../context/PortfolioContext';

// App-wide scope chips: include/exclude family-asset and illiquid brokers from
// the counts. The preference is shared across views (Dashboard, Stats,
// Forecast, Performance all render these chips and react to the same state).
// Renders nothing until at least one broker carries a scope flag, so the UI
// stays clean for users who don't use the feature.
const AssetScopeToggles: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
    const { assetScope, setAssetScope, hasScopeFlaggedBrokers, brokers } = usePortfolio();

    if (!hasScopeFlaggedBrokers) return null;

    const hasFamily = brokers.some(b => b.familyAsset);
    const hasIlliquid = brokers.some(b => b.illiquid);

    const chip = (
        active: boolean,
        label: string,
        title: string,
        onClick: () => void
    ) => (
        <button
            onClick={onClick}
            title={title}
            style={{
                padding: '0.25rem 0.7rem',
                borderRadius: '14px',
                fontSize: '0.78rem',
                cursor: 'pointer',
                background: active ? 'var(--color-primary)' : 'var(--bg-card)',
                color: active ? 'white' : 'var(--text-tertiary)',
                border: active ? '1px solid var(--color-primary)' : '1px solid var(--border-color)',
                textDecoration: active ? 'none' : 'line-through',
                opacity: active ? 1 : 0.75,
            }}
        >
            {label}
        </button>
    );

    return (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', ...style }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>Counting scope:</span>
            {hasFamily && chip(
                assetScope.includeFamily,
                '👪 Family',
                assetScope.includeFamily
                    ? 'Family brokers are included in the counts — click to exclude them'
                    : 'Family brokers are excluded from the counts — click to include them',
                () => setAssetScope(prev => ({ ...prev, includeFamily: !prev.includeFamily }))
            )}
            {hasIlliquid && chip(
                assetScope.includeIlliquid,
                '🔒 Illiquid',
                assetScope.includeIlliquid
                    ? 'Illiquid brokers (e.g. pension funds) are included — click to exclude them'
                    : 'Illiquid brokers (e.g. pension funds) are excluded — click to include them',
                () => setAssetScope(prev => ({ ...prev, includeIlliquid: !prev.includeIlliquid }))
            )}
        </div>
    );
};

export default AssetScopeToggles;
