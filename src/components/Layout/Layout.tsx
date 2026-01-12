import React from 'react';

type View = 'dashboard' | 'transactions' | 'settings' | 'portfolios' | 'brokers' | 'forecast';

interface LayoutProps {
  currentView: View;
  onNavigate: (view: View) => void;
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ currentView, onNavigate, children }) => {
  return (
    <div className="layout">
      <header className="navbar">
        <div className="navbar-brand">
          <h1>Portfolio Rebalancer</h1>
        </div>
        <nav className="navbar-links">
          <button
            className={`nav-link ${currentView === 'dashboard' ? 'active' : ''}`}
            onClick={() => onNavigate('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`nav-link ${currentView === 'transactions' ? 'active' : ''}`}
            onClick={() => onNavigate('transactions')}
          >
            Transactions
          </button>
          <button
            className={`nav-link ${currentView === 'portfolios' ? 'active' : ''}`}
            onClick={() => onNavigate('portfolios')}
          >
            Portfolios
          </button>
          <button
            className={`nav-link ${currentView === 'brokers' ? 'active' : ''}`}
            onClick={() => onNavigate('brokers')}
          >
            Brokers
          </button>
          <button
            className={`nav-link ${currentView === 'forecast' ? 'active' : ''}`}
            onClick={() => onNavigate('forecast')}
          >
            Forecast
          </button>
          <button
            className={`nav-link ${currentView === 'settings' ? 'active' : ''}`}
            onClick={() => onNavigate('settings')}
          >
            Settings
          </button>
        </nav>
      </header>
      <main className={`content ${currentView === 'transactions' || currentView === 'forecast' ? 'full-width' : ''}`}>
        {children}
      </main>

      <style>{`
        .layout {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }

        .navbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--space-4) var(--space-8);
          background-color: var(--bg-surface);
          border-bottom: 1px solid var(--bg-card);
          position: sticky;
          top: 0;
          z-index: 10;
        }

        .navbar-brand h1 {
          font-size: 1.25rem;
          font-weight: 600;
          background: linear-gradient(to right, var(--color-primary), var(--color-accent));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .navbar-links {
          display: flex;
          gap: var(--space-4);
        }

        .nav-link {
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-weight: 500;
          padding: var(--space-2) var(--space-4);
          border-radius: var(--radius-md);
          transition: all 0.2s;
        }

        .nav-link:hover {
          color: var(--text-primary);
          background-color: var(--bg-card);
        }

        .nav-link.active {
          color: var(--text-primary);
          background-color: var(--color-primary);
        }

        .content {
          flex: 1;
          padding: var(--space-6) var(--space-8);
          max-width: 1200px;
          margin: 0 auto;
          width: 100%;
        }

        .content.full-width {
            max-width: 100%;
            padding: var(--space-6) var(--space-4);
        }

        @media (max-width: 768px) {
          .navbar {
            padding: var(--space-4);
            flex-direction: column;
            gap: var(--space-4);
          }
          
          .content {
            padding: var(--space-4);
          }
        }
      `}</style>
    </div>
  );
};

export default Layout;
