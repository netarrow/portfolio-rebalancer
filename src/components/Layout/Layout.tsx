import React from 'react';

type View = 'dashboard' | 'transactions' | 'settings' | 'portfolios' | 'brokers' | 'forecast' | 'stats' | 'disclaimer';

interface LayoutProps {
  currentView: View;
  onNavigate: (view: View) => void;
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ currentView, onNavigate, children }) => {
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);

  const handleNavigate = (view: View) => {
    onNavigate(view);
    setIsMenuOpen(false);
  };

  return (
    <div className="layout">
      <header className="navbar">
        <div className="navbar-header">
          <div className="navbar-brand">
            <h1>Portfolio Rebalancer</h1>
          </div>
          <button 
            className="hamburger-btn" 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            aria-label="Toggle menu"
          >
            <span className={`hamburger-icon ${isMenuOpen ? 'open' : ''}`}></span>
          </button>
        </div>
        <nav className={`navbar-links ${isMenuOpen ? 'show' : ''}`}>
          <button
            className={`nav-link ${currentView === 'dashboard' ? 'active' : ''}`}
            onClick={() => handleNavigate('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`nav-link ${currentView === 'stats' ? 'active' : ''}`}
            onClick={() => handleNavigate('stats')}
          >
            Stats
          </button>
          <button
            className={`nav-link ${currentView === 'transactions' ? 'active' : ''}`}
            onClick={() => handleNavigate('transactions')}
          >
            Transactions
          </button>
          <button
            className={`nav-link ${currentView === 'portfolios' ? 'active' : ''}`}
            onClick={() => handleNavigate('portfolios')}
          >
            Portfolios
          </button>
          <button
            className={`nav-link ${currentView === 'brokers' ? 'active' : ''}`}
            onClick={() => handleNavigate('brokers')}
          >
            Brokers
          </button>
          <button
            className={`nav-link ${currentView === 'forecast' ? 'active' : ''}`}
            onClick={() => handleNavigate('forecast')}
          >
            Forecast
          </button>
          <button
            className={`nav-link ${currentView === 'settings' ? 'active' : ''}`}
            onClick={() => handleNavigate('settings')}
          >
            Settings
          </button>
          <button
            className={`nav-link ${currentView === 'disclaimer' ? 'active' : ''}`}
            onClick={() => handleNavigate('disclaimer')}
          >
            Disclaimer
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
          z-index: 100;
        }

        .navbar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
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
          width: auto;
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

        .hamburger-btn {
          display: none;
          background: transparent;
          border: none;
          cursor: pointer;
          padding: var(--space-2);
        }

        .hamburger-icon {
          display: block;
          width: 24px;
          height: 2px;
          background-color: var(--text-primary);
          position: relative;
          transition: background-color 0.2s;
        }

        .hamburger-icon::before,
        .hamburger-icon::after {
          content: '';
          position: absolute;
          width: 24px;
          height: 2px;
          background-color: var(--text-primary);
          transition: transform 0.2s, top 0.2s;
        }

        .hamburger-icon::before {
          top: -8px;
        }

        .hamburger-icon::after {
          top: 8px;
        }

        .hamburger-icon.open {
          background-color: transparent;
        }

        .hamburger-icon.open::before {
          transform: rotate(45deg);
          top: 0;
        }

        .hamburger-icon.open::after {
          transform: rotate(-45deg);
          top: 0;
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
            flex-direction: column;
            padding: var(--space-3) var(--space-4);
            align-items: flex-start;
          }
          
          .navbar-header {
            width: 100%;
          }

          .hamburger-btn {
            display: block;
          }

          .navbar-links {
            display: none;
            flex-direction: column;
            width: 100%;
            padding-top: var(--space-4);
            gap: var(--space-2);
          }

          .navbar-links.show {
            display: flex;
          }

          .nav-link {
            width: 100%;
            text-align: left;
            padding: var(--space-3) var(--space-4);
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
