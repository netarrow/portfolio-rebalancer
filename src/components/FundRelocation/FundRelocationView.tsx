import React, { useMemo, useState } from 'react';
import { usePortfolio } from '../../context/PortfolioContext';
import {
    applyRelocationToState,
    planFundRelocation,
    portfolioAssets,
    type RelocationContext,
    type RelocationEndpoint,
    type RelocationRequest,
} from '../../utils/fundRelocation';
import { buildSnapshot, type SnapshotInput } from '../../utils/relocationSnapshot';
import RelocationForm from './RelocationForm';
import RelocationActions from './RelocationActions';
import RelocationWhatIf from './RelocationWhatIf';
import './FundRelocation.css';

/**
 * Fund Relocation — what moving money actually costs.
 *
 * Portfolios are logical buckets over transactions, so a relocation is a real
 * sell → buy round trip that leaks capital-gains tax and two commissions. This
 * page prices that round trip and then shows the resulting state measured with
 * the SAME calculators the Stats page uses, so the "before" column is not a
 * second opinion — it is the Stats page's own arithmetic.
 */
const FundRelocationView: React.FC = () => {
    const {
        portfolios, brokers, transactions, assetSettings, marketData,
        macroAllocations, goalAllocations, goals, freeCommissionPeriods,
    } = usePortfolio();

    const [from, setFrom] = useState<RelocationEndpoint>({ kind: 'portfolio', portfolioId: '' });
    const [to, setTo] = useState<RelocationEndpoint>({ kind: 'portfolio', portfolioId: '' });
    const [netAmount, setNetAmount] = useState(0);
    const [applyFreeBuyPromo, setApplyFreeBuyPromo] = useState(false);

    // Default the two ends to different portfolios once the data is loaded,
    // without fighting a choice the user has already made.
    const resolvedFrom = useMemo<RelocationEndpoint>(() => {
        if (from.kind === 'cash' || portfolios.some(p => p.id === from.portfolioId)) return from;
        return { kind: 'portfolio', portfolioId: portfolios[0]?.id ?? '' };
    }, [from, portfolios]);

    const resolvedTo = useMemo<RelocationEndpoint>(() => {
        if (to.kind === 'cash' || portfolios.some(p => p.id === to.portfolioId)) return to;
        const fallback = portfolios.find(p => p.id !== (resolvedFrom.kind === 'portfolio' ? resolvedFrom.portfolioId : ''));
        return { kind: 'portfolio', portfolioId: (fallback ?? portfolios[0])?.id ?? '' };
    }, [to, portfolios, resolvedFrom]);

    const ctx = useMemo<RelocationContext>(() => ({
        portfolios, brokers, transactions, assetSettings, marketData, freeCommissionPeriods,
    }), [portfolios, brokers, transactions, assetSettings, marketData, freeCommissionPeriods]);

    const sourceAssets = useMemo(
        () => (resolvedFrom.kind === 'portfolio' && resolvedFrom.portfolioId ? portfolioAssets(resolvedFrom.portfolioId, ctx) : []),
        [resolvedFrom, ctx]
    );
    const destAssets = useMemo(
        () => (resolvedTo.kind === 'portfolio' && resolvedTo.portfolioId ? portfolioAssets(resolvedTo.portfolioId, ctx) : []),
        [resolvedTo, ctx]
    );

    const request = useMemo<RelocationRequest>(
        () => ({ from: resolvedFrom, to: resolvedTo, netAmount, applyFreeBuyPromo }),
        [resolvedFrom, resolvedTo, netAmount, applyFreeBuyPromo]
    );

    const sameEndpoint =
        resolvedFrom.kind === 'portfolio' && resolvedTo.kind === 'portfolio'
            ? resolvedFrom.portfolioId === resolvedTo.portfolioId
            : resolvedFrom.kind === 'cash' && resolvedTo.kind === 'cash';

    const plan = useMemo(
        () => (netAmount > 0 && !sameEndpoint ? planFundRelocation(request, ctx) : null),
        [request, ctx, netAmount, sameEndpoint]
    );

    const snapshotInput = useMemo<SnapshotInput>(() => ({
        transactions, brokers, portfolios, goals, assetSettings, marketData, macroAllocations, goalAllocations,
    }), [transactions, brokers, portfolios, goals, assetSettings, marketData, macroAllocations, goalAllocations]);

    const before = useMemo(() => buildSnapshot(snapshotInput), [snapshotInput]);

    const after = useMemo(() => {
        if (!plan || (plan.sells.length === 0 && plan.buys.length === 0)) return null;
        const moved = applyRelocationToState(transactions, brokers, request, plan);
        return buildSnapshot({ ...snapshotInput, transactions: moved.transactions, brokers: moved.brokers });
    }, [plan, request, transactions, brokers, snapshotInput]);

    if (portfolios.length === 0) {
        return (
            <div className="reloc-container">
                <div className="reloc-card">
                    <p className="reloc-empty">
                        Serve almeno un portafoglio per simulare uno spostamento. Creane uno dalla pagina Portfolios.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="reloc-container">
            <h2 className="section-title" style={{ fontSize: '1.5rem', marginBottom: 'var(--space-2)' }}>
                Fund Relocation
            </h2>
            <p style={{ color: 'var(--text-secondary)', marginTop: 0, marginBottom: 'var(--space-6)', maxWidth: '70ch' }}>
                I portafogli sono contenitori logici sulle transazioni: spostare fondi significa
                <strong> vendere di là e ricomprare di qua</strong>, e per strada si lasciano imposte e
                commissioni. Qui vedi le azioni esatte, quanto costa davvero il passaggio e come
                resterebbero statistiche e piramide.
            </p>

            <RelocationForm
                from={resolvedFrom}
                to={resolvedTo}
                netAmount={netAmount}
                applyFreeBuyPromo={applyFreeBuyPromo}
                onFromChange={setFrom}
                onToChange={setTo}
                onNetAmountChange={setNetAmount}
                onFreeBuyPromoChange={setApplyFreeBuyPromo}
                portfolios={portfolios}
                brokers={brokers}
                sourceAssets={sourceAssets}
                destAssets={destAssets}
            />

            {sameEndpoint && (
                <div className="reloc-warning critical">
                    <span aria-hidden="true">⛔</span>
                    <span>Origine e destinazione coincidono: scegli due estremi diversi.</span>
                </div>
            )}

            {!sameEndpoint && netAmount <= 0 && (
                <div className="reloc-card">
                    <p className="reloc-empty">Indica l&apos;importo netto da spostare per vedere il piano.</p>
                </div>
            )}

            {plan && <RelocationActions plan={plan} />}

            {plan && after && (
                <RelocationWhatIf before={before} after={after} friction={plan.friction} />
            )}
        </div>
    );
};

export default FundRelocationView;
