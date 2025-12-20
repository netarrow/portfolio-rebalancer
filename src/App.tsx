import { useState } from 'react';
import { PortfolioProvider } from './context/PortfolioContext';
import Layout from './components/Layout/Layout';

type View = 'dashboard' | 'transactions' | 'settings';

import TransactionForm from './components/Transactions/TransactionForm';
import TransactionList from './components/Transactions/TransactionList';
import SummaryCards from './components/Dashboard/SummaryCards';
import AllocationOverview from './components/Dashboard/AllocationOverview';
import TargetSettings from './components/Settings/TargetSettings';

// Placeholders for views
const DashboardView = () => (
  <div className="dashboard-container">
    <SummaryCards />
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

function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');

  const renderView = () => {
    switch (currentView) {
      case 'dashboard': return <DashboardView />;
      case 'transactions': return <TransactionsView />;
      case 'settings': return <SettingsView />;
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
