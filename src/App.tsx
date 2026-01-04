import { useState } from 'react';
import { PortfolioProvider } from './context/PortfolioContext';
import Layout from './components/Layout/Layout';

type View = 'dashboard' | 'transactions' | 'settings' | 'portfolios';

import TransactionForm from './components/Transactions/TransactionForm';
import TransactionList from './components/Transactions/TransactionList';
import SummaryCards from './components/Dashboard/SummaryCards';
import AllocationCharts from './components/Dashboard/AllocationCharts';
import AllocationOverview from './components/Dashboard/AllocationOverview';
import TargetSettings from './components/Settings/TargetSettings';
import PortfolioList from './components/Portfolios/PortfolioList';

// Placeholders for views
const DashboardView = () => (
  <div className="dashboard-container">
    <SummaryCards />
    <AllocationCharts />
    <AllocationOverview />
  </div>
);

const TransactionsView = () => (
  <div className="transaction-container">
    <TransactionForm />
    <TransactionList />
  </div>
);

const SettingsView = () => (
  <div>
    <TargetSettings />
  </div>
);

const PortfoliosView = () => (
  <div>
    <PortfolioList />
  </div>
);

function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');

  const renderView = () => {
    switch (currentView) {
      case 'dashboard': return <DashboardView />;
      case 'transactions': return <TransactionsView />;
      case 'settings': return <SettingsView />;
      case 'portfolios': return <PortfoliosView />;
      default: return <DashboardView />;
    }
  };

  return (
    <PortfolioProvider>
      <Layout currentView={currentView} onNavigate={(view) => setCurrentView(view as View)}>
        {renderView()}
      </Layout>
    </PortfolioProvider>
  );
}

export default App;
