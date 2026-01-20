import React from 'react';

interface EmptyStateProps {
    onNavigateToDisclaimer: () => void;
}

const EmptyState: React.FC<EmptyStateProps> = ({ onNavigateToDisclaimer }) => {
    return (
        <div style={{ maxWidth: '800px', margin: '4rem auto', padding: '0 1rem', fontFamily: 'var(--font-sans, system-ui, sans-serif)' }}>
            <div style={{ textAlign: 'center', marginBottom: '3rem' }}>
                <h1 style={{ fontSize: '2rem', marginBottom: '1rem', color: 'var(--text-primary)' }}>Welcome to Portfolio Rebalancer</h1>
                <p style={{ fontSize: '1.2rem', color: 'var(--text-secondary)' }}>
                    Your dashboard is looking a bit empty! Get started by adding your first transaction or explore the app with mock data.
                </p>
            </div>

            {/* Mock Data Section - Duplicated from Disclaimer */}
            <div className="card" style={{ padding: '2.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', marginBottom: '2.5rem', border: '1px solid var(--border-color)' }}>
                <h2 style={{ marginTop: 0, color: 'var(--color-primary)', fontSize: '1.5rem', marginBottom: '1.5rem' }}>🛠 Testing with Mock Data</h2>
                <p style={{ lineHeight: '1.8', marginBottom: '1.5rem' }}>
                    To safely explore the application's features without entering your real financial data, you can generate <strong>Mock Data</strong>.
                </p>
                <div style={{ padding: '1.5rem', backgroundColor: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', borderLeft: '4px solid var(--color-primary)' }}>
                    <p style={{ margin: 0, fontSize: '1.05rem' }}>
                        Go to <strong>Settings</strong> &gt; <strong>Developer Tools</strong> and click <strong>"Load Mock Data"</strong>.
                    </p>
                </div>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '1rem', fontStyle: 'italic' }}>
                    * This will overwrite your current local data. Use the Backup feature in {`Settings > Data Management`} to save your real data first!
                </p>
            </div>

            {/* Disclaimer Link Section */}
            <div style={{ textAlign: 'center' }}>
                <p style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>
                    Want to know more about this project?
                </p>
                <button
                    onClick={onNavigateToDisclaimer}
                    style={{
                        padding: '0.75rem 1.5rem',
                        backgroundColor: 'transparent',
                        border: '2px solid var(--color-primary)',
                        color: 'var(--color-primary)',
                        borderRadius: 'var(--radius-md)',
                        fontSize: '1rem',
                        cursor: 'pointer',
                        fontWeight: 600,
                        transition: 'all 0.2s'
                    }}
                    onMouseOver={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--color-primary)';
                        e.currentTarget.style.color = 'white';
                    }}
                    onMouseOut={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.color = 'var(--color-primary)';
                    }}
                >
                    Read the Disclaimer & About Page
                </button>
            </div>
        </div>
    );
};

export default EmptyState;
