import React from 'react';

const Disclaimer: React.FC = () => {
    return (
        <div style={{ maxWidth: '900px', margin: '3rem auto', padding: '0 1rem', fontFamily: 'var(--font-sans, system-ui, sans-serif)' }}>
            <h1 className="section-title" style={{
                marginBottom: '2.5rem',
                fontSize: '2.5rem',
                borderBottom: '2px solid var(--border-color)',
                paddingBottom: '1rem'
            }}>
                About & Disclaimer
            </h1>

            {/* Agentic Experiment Section */}
            <div className="card" style={{
                padding: '2.5rem',
                backgroundColor: 'var(--bg-card)',
                borderRadius: 'var(--radius-lg)',
                marginBottom: '2.5rem',
                border: '1px solid var(--color-accent)',
                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
            }}>
                <h2 style={{ marginTop: 0, color: 'var(--color-accent)', fontSize: '1.5rem', marginBottom: '1.5rem' }}>
                    🤖 Agentic Development Experiment
                </h2>
                <p style={{ lineHeight: '1.8', fontSize: '1.1rem', marginBottom: '1.5rem' }}>
                    The true purpose of this application was to experiment with <strong>Agentic AI Development</strong>.
                </p>
                <p style={{ lineHeight: '1.8', fontSize: '1.05rem', color: 'var(--text-secondary)' }}>
                    It was built by leveraging <strong>Google's Antigravity</strong> agentic capabilities with Gemini PRO and <strong>Codex</strong> models as checker and analisys agent.
                    The development process focused on testing autonomous coding, decision-making, and problem-solving capabilities of AI agents in a real-world scenario.
                </p>
            </div>

            {/* Disclaimer Section */}
            <div className="card" style={{
                padding: '2.5rem',
                backgroundColor: 'rgba(239, 68, 68, 0.05)',
                borderRadius: 'var(--radius-lg)',
                marginBottom: '2.5rem',
                border: '1px solid rgba(239, 68, 68, 0.2)'
            }}>
                <h2 style={{
                    color: 'var(--color-danger)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    marginTop: 0,
                    fontSize: '1.5rem',
                    marginBottom: '1.5rem'
                }}>
                    ⚠️ Important Disclaimer
                </h2>
                <p style={{ lineHeight: '1.8', fontSize: '1.1rem', marginBottom: '1rem' }}>
                    This application is a <strong>Portfolio Management Experiment</strong> created for <strong>personal, non-commercial use</strong>.
                </p>
                <p style={{ lineHeight: '1.8', marginBottom: '1rem' }}>
                    It is provided <strong>"as-is"</strong> without any warranty, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement.
                </p>
                <p style={{ lineHeight: '1.8', fontWeight: 500 }}>
                    Use at your own risk. The authors and contributors are not responsible for any financial losses, data loss, or other damages resulting from the use of this software. Always verify calculations and data independently before making investment decisions.
                </p>
            </div>

            {/* Privacy Policy Section */}
            <div className="card" style={{ padding: '2.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', marginBottom: '2.5rem' }}>
                <h2 style={{ marginTop: 0, fontSize: '1.5rem', marginBottom: '1.5rem' }}>🔒 Privacy Policy</h2>

                <div style={{ display: 'grid', gap: '2rem' }}>
                    <div>
                        <h3 style={{ fontSize: '1.1rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Data Storage</h3>
                        <p style={{ lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
                            Portfolio data (transactions, settings, targets, market data) is saved <strong>only in your browser's <code>localStorage</code></strong>. No portfolio data is sent to our server or to third parties.
                        </p>
                    </div>

                    <div>
                        <h3 style={{ fontSize: '1.1rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Cookies</h3>
                        <p style={{ lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
                            The app does not set or read cookies for its own functionality.
                        </p>
                    </div>

                    <div>
                        <h3 style={{ fontSize: '1.1rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Data Transmission</h3>
                        <p style={{ lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
                            Price lookups send only the ISIN and selected source to the local server proxy; no personal identifiers or portfolio balances are transmitted.
                        </p>
                    </div>

                    <div>
                        <h3 style={{ fontSize: '1.1rem', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>Data Removal</h3>
                        <p style={{ lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
                            You can erase all locally stored data from the <strong>Settings</strong> page using the "Delete All Data" button. Clearing your browser's cache/localStorage also removes it permanently.
                        </p>
                    </div>
                </div>
            </div>

            {/* Mock Data Section */}
            <div className="card" style={{ padding: '2.5rem', backgroundColor: 'var(--bg-card)', borderRadius: 'var(--radius-lg)' }}>
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
        </div>
    );
};

export default Disclaimer;
