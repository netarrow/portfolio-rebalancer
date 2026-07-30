import React from 'react';

type View = 'dashboard' | 'transactions' | 'settings' | 'portfolios' | 'brokers' | 'goals' | 'ynabGoals' | 'forecast' | 'stats' | 'performance' | 'disclaimer' | 'globalRebalancing' | 'ynab' | 'summary' | 'pac';

interface LayoutProps {
  currentView: View;
  onNavigate: (view: View) => void;
  children: React.ReactNode;
}

const menuStructure = [
  { label: '🏠 Dashboard', view: 'dashboard' as const },
  {
    label: '💼 Portfolio',
    items: [
      { label: '💱 Transactions', view: 'transactions' as const },
      { label: '📋 Portfolios', view: 'portfolios' as const },
      { label: '🏦 Brokers', view: 'brokers' as const },
      { label: '🎯 Asset Allocation', view: 'globalRebalancing' as const },
    ],
  },
  {
    label: '📊 Analysis',
    items: [
      { label: '📈 Stats', view: 'stats' as const },
      { label: '📉 Performance', view: 'performance' as const },
      { label: '📋 Summary', view: 'summary' as const },
    ],
  },
  {
    label: '📅 Planning',
    items: [
      { label: '🎯 Goals', view: 'goals' as const },
      { label: '🔮 Forecast', view: 'forecast' as const },
      { label: '📊 PAC', view: 'pac' as const },
      { label: '💰 YNAB', view: 'ynab' as const },
      { label: '🎯 YNAB Goals', view: 'ynabGoals' as const },
    ],
  },
  { label: '⚙️ Settings', view: 'settings' as const },
  { label: '⚠️ Disclaimer', view: 'disclaimer' as const },
];

const Layout: React.FC<LayoutProps> = ({ currentView, onNavigate, children }) => {
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const [expandedMenus, setExpandedMenus] = React.useState<Record<string, boolean>>({});

  const handleNavigate = (view: View) => {
    onNavigate(view);
    setIsMenuOpen(false);
  };

  const toggleMenu = (label: string) => {
    setExpandedMenus(prev => ({ ...prev, [label]: !prev[label] }));
  };

  return (
    <div className={`layout ${isMenuOpen ? 'menu-open' : ''}`.trim()}>
      <header className="navbar">
        <div className="navbar-header">
          <div className="navbar-brand">
            <h1>Portfolio Rebalancer</h1>
            <span className="app-version" title="Build version">v{__APP_VERSION__}</span>
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
          {menuStructure.map((item, idx) => {
            if ('items' in item && item.items) {
              return (
                <div key={idx} className="nav-group">
                  <button
                    className="nav-group-toggle"
                    onClick={() => toggleMenu(item.label)}
                  >
                    {item.label}
                    <span className={`toggle-icon ${expandedMenus[item.label] ? 'open' : ''}`}>›</span>
                  </button>
                  {expandedMenus[item.label] && (
                    <div className="nav-submenu">
                      {item.items.map((subitem, subidx) => (
                        <button
                          key={subidx}
                          className={`nav-sublink ${currentView === subitem.view ? 'active' : ''}`}
                          onClick={() => handleNavigate(subitem.view)}
                        >
                          {subitem.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            const link = item as { label: string; view: View };
            return (
              <button
                key={idx}
                className={`nav-link ${currentView === link.view ? 'active' : ''}`}
                onClick={() => handleNavigate(link.view)}
              >
                {link.label}
              </button>
            );
          })}
        </nav>
      </header>
      <main className={`content ${currentView === 'transactions' || currentView === 'forecast' || currentView === 'globalRebalancing' || currentView === 'pac' ? 'full-width' : ''}`}>
        {children}
      </main>

      <style>{`
        .layout {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          padding-top: 72px;
        }

        .navbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--space-4) var(--space-8);
          background-color: var(--bg-surface);
          border-bottom: 1px solid var(--bg-card);
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 1000;
        }

        .navbar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
        }

        .navbar-brand {
          display: flex;
          align-items: flex-start;
          gap: var(--space-1);
        }

        .navbar-brand h1 {
          font-size: 1.25rem;
          font-weight: 600;
          white-space: nowrap;
          background: linear-gradient(to right, var(--color-primary), var(--color-accent));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .app-version {
          flex-shrink: 0;
          margin-top: 1px;
          padding: 1px 6px;
          border-radius: 999px;
          background-color: var(--bg-card);
          color: var(--text-muted);
          font-size: 0.65rem;
          font-weight: 600;
          line-height: 1.4;
          letter-spacing: 0.02em;
          white-space: nowrap;
        }

        .navbar-links {
          display: flex;
          gap: var(--space-4);
          width: auto;
          min-width: 0;
          overflow-x: auto;
          scrollbar-width: thin;
          /* Scroll shadows (background-attachment: local trick): the edge
             shadow only shows when links are clipped on that side, giving a
             scroll affordance even with overlay scrollbars. */
          background:
            linear-gradient(to right, var(--bg-surface) 30%, transparent),
            linear-gradient(to left, var(--bg-surface) 30%, transparent) 100% 0,
            radial-gradient(farthest-side at 0 50%, rgba(0, 0, 0, 0.45), transparent),
            radial-gradient(farthest-side at 100% 50%, rgba(0, 0, 0, 0.45), transparent) 100% 0;
          background-repeat: no-repeat;
          background-size: 40px 100%, 40px 100%, 14px 100%, 14px 100%;
          background-attachment: local, local, scroll, scroll;
        }

        .nav-link {
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-weight: 500;
          padding: var(--space-2) var(--space-4);
          border-radius: var(--radius-md);
          transition: all 0.2s;
          flex-shrink: 0;
          white-space: nowrap;
        }

        /* Mid desktop widths: tighten spacing so all links fit more often
           before falling back to horizontal scrolling. */
        @media (max-width: 1600px) {
          .navbar-links {
            gap: var(--space-1);
          }

          .nav-link {
            padding: var(--space-2) var(--space-2);
          }
        }

        .nav-link:hover {
          color: var(--text-primary);
          background-color: var(--bg-card);
        }

        .nav-link.active {
          color: var(--text-primary);
          background-color: var(--color-primary);
        }

        .nav-group {
          display: flex;
          flex-direction: column;
          flex-shrink: 0;
        }

        .nav-group-toggle {
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-weight: 500;
          padding: var(--space-2) var(--space-4);
          border-radius: var(--radius-md);
          transition: all 0.2s;
          flex-shrink: 0;
          white-space: nowrap;
          display: flex;
          align-items: center;
          gap: var(--space-2);
          cursor: pointer;
        }

        .nav-group-toggle:hover {
          color: var(--text-primary);
          background-color: var(--bg-card);
        }

        .toggle-icon {
          display: inline-block;
          transition: transform 0.2s;
          font-size: 1.25rem;
          line-height: 1;
        }

        .toggle-icon.open {
          transform: rotate(90deg);
        }

        .nav-submenu {
          display: flex;
          flex-direction: column;
          gap: 0;
          background-color: rgba(255, 255, 255, 0.03);
          border-left: 2px solid var(--color-primary);
          margin-left: var(--space-2);
          padding-left: var(--space-2);
          animation: slideDown 0.2s ease-out;
        }

        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .nav-sublink {
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-weight: 400;
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-sm);
          transition: all 0.2s;
          text-align: left;
          white-space: nowrap;
          font-size: 0.9rem;
        }

        .nav-sublink:hover {
          color: var(--text-primary);
          background-color: var(--bg-card);
        }

        .nav-sublink.active {
          color: var(--text-primary);
          background-color: var(--color-primary);
          font-weight: 500;
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
          .layout {
            padding-top: 64px;
          }

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
            overflow-x: hidden;
            background: none;
          }

          .nav-link {
            flex-shrink: 1;
            white-space: normal;
          }

          .navbar-links.show {
            display: flex;
            max-height: calc(100vh - 64px);
            /* dvh tracks the iOS Safari collapsing address bar; vh above is
               the fallback for older browsers */
            max-height: calc(100dvh - 64px);
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            overscroll-behavior: contain;
          }

          .nav-link {
            width: 100%;
            text-align: left;
            padding: var(--space-3) var(--space-4);
          }

          .nav-group {
            width: 100%;
          }

          .nav-group-toggle {
            width: 100%;
            justify-content: space-between;
            padding: var(--space-3) var(--space-4);
          }

          .nav-submenu {
            margin-left: 0;
            padding-left: var(--space-6);
            border-left: none;
            background: transparent;
          }

          .nav-sublink {
            width: 100%;
            padding: var(--space-2) var(--space-3);
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
