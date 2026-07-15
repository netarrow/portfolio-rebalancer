import { useState } from 'react';
import { PortfolioProvider } from './context/PortfolioContext';
import { SecurityProvider } from './context/SecurityContext';
import UnlockGate from './components/Security/UnlockGate';
import Layout from './components/Layout/Layout';

type View = 'dashboard' | 'transactions' | 'settings' | 'portfolios' | 'brokers' | 'goals' | 'ynabGoals' | 'forecast' | 'stats' | 'performance' | 'disclaimer' | 'globalRebalancing' | 'ynab' | 'summary';

import TransactionForm from './components/Transactions/TransactionForm';
import TransactionList from './components/Transactions/TransactionList';
import SummaryCards from './components/Dashboard/SummaryCards';
import AllocationCharts from './components/Dashboard/AllocationCharts';
import AllocationOverview from './components/Dashboard/AllocationOverview';
import BrokerPerformance from './components/Dashboard/BrokerPerformance';
import TargetSettings from './components/Settings/TargetSettings';
import PortfolioList from './components/Portfolios/PortfolioList';
import BrokerList from './components/Brokers/BrokerList';
import Disclaimer from './components/Disclaimer/Disclaimer';
import EmptyState from './components/Dashboard/EmptyState';
import { usePortfolio } from './context/PortfolioContext';

import GoalList from './components/Goals/GoalList';
import ForecastView from './components/Forecast/ForecastView';
import GlobalRebalancingView from './components/GlobalRebalancing/GlobalRebalancingView';
import YnabImportView from './components/YnabImport/YnabImportView';
import YnabGoalsView from './components/YnabGoals/YnabGoalsView';
import SummaryAnalysisView from './components/SummaryAnalysis/SummaryAnalysisView';
import PerformanceView from './components/Performance/PerformanceView';

// Placeholders for views
const DashboardView = ({ onNavigateToDisclaimer }: { onNavigateToDisclaimer: () => void }) => {
  const { transactions } = usePortfolio();

  if (transactions.length === 0) {
    return <EmptyState onNavigateToDisclaimer={onNavigateToDisclaimer} />;
  }

  return (
    <div className="dashboard-container">
      <SummaryCards />
      <BrokerPerformance />
      <AllocationOverview />
    </div>
  );
};

const StatsView = () => (
  <div className="dashboard-container">
    <AllocationCharts />
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

const BrokersView = () => (
  <div>
    <BrokerList />
  </div>
);

const GoalsView = () => (
  <div>
    <GoalList />
  </div>
);

const DisclaimerView = () => (
  <div>
    <Disclaimer />
  </div>
);

const GlobalRebalancingPage = () => (
  <div>
    <GlobalRebalancingView />
  </div>
);

function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');

  const renderView = () => {
    switch (currentView) {
      case 'dashboard': return <DashboardView onNavigateToDisclaimer={() => setCurrentView('disclaimer')} />;
      case 'transactions': return <TransactionsView />;
      case 'settings': return <SettingsView />;
      case 'portfolios': return <PortfoliosView />;
      case 'brokers': return <BrokersView />;
      case 'goals': return <GoalsView />;
      case 'ynabGoals': return <YnabGoalsView onNavigateToYnab={() => setCurrentView('ynab')} />;
      case 'summary': return <SummaryAnalysisView onNavigateToSettings={() => setCurrentView('settings')} />;
      case 'forecast': return <ForecastView />;
      case 'stats': return <StatsView />;
      case 'performance': return <PerformanceView />;
      case 'disclaimer': return <DisclaimerView />;
      case 'globalRebalancing': return <GlobalRebalancingPage />;
      case 'ynab': return <YnabImportView onNavigateToSettings={() => setCurrentView('settings')} />;
      default: return <DashboardView onNavigateToDisclaimer={() => setCurrentView('disclaimer')} />;
    }
  };

  return (
    <SecurityProvider>
      <UnlockGate>
        <PortfolioProvider>
          <Layout currentView={currentView} onNavigate={(view) => setCurrentView(view as View)}>
            {renderView()}
          </Layout>
        </PortfolioProvider>
      </UnlockGate>
    </SecurityProvider>
  );
}

export default App;
