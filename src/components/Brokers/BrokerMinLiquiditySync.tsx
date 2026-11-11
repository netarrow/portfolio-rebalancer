import { useEffect } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import { useAccountCashPlans } from '../YnabImport/useCashPlan';

/**
 * Keeps the minimum liquidity of the brokers linked to Expense Planning equal
 * to the cash their account has to hold there: the hold of the cash plan
 * (operating cash + capex due soon + set aside + emergency fund held as cash;
 * cash only in transit to a portfolio is not held). Renders nothing. A linked broker with no
 * account in Expense Planning, or with YNAB disconnected, goes back to the
 * minimum typed on it. While the YNAB categories are not loaded yet, nothing
 * is touched.
 */
const BrokerMinLiquiditySync: React.FC = () => {
    const { brokers, ynabConfig, ynabCategories, syncLinkedBrokerMinimums } = usePortfolio();
    const accounts = useAccountCashPlans();
    const linked = brokers.filter(b => b.minLiquidityLinked);
    const ready = !ynabConfig?.budgetId || ynabCategories.length > 0;

    const key = linked.map(b => {
        const a = accounts.find(x => x.brokerId === b.id);
        return `${b.id}:${a ? Math.round(a.hold * 100) : 'none'}`;
    }).join('|');

    useEffect(() => {
        if (!ready || linked.length === 0) return;
        const values: Record<string, number | null> = {};
        linked.forEach(b => {
            const a = ynabConfig?.budgetId ? accounts.find(x => x.brokerId === b.id) : undefined;
            values[b.id] = a ? a.hold : null;
        });
        syncLinkedBrokerMinimums(values);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, ready]);

    return null;
};

export default BrokerMinLiquiditySync;
