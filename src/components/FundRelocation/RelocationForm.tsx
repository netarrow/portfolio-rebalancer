import React from 'react';
import type { Asset, Broker, Portfolio } from '../../types';
import type { RelocationEndpoint } from '../../utils/fundRelocation';
import { isCashTicker } from '../../utils/portfolioCalculations';

/**
 * Source and destination are the same control, because they are the same union:
 * either a portfolio (optionally pinned to one asset) or cash. That symmetry is
 * what lets one screen express a divestment, an investment and a swap.
 */

interface EndpointPickerProps {
    title: string;
    side: 'from' | 'to';
    value: RelocationEndpoint;
    onChange: (endpoint: RelocationEndpoint) => void;
    portfolios: Portfolio[];
    brokers: Broker[];
    /** Holdings of the currently selected portfolio, for the asset dropdown. */
    assets: Asset[];
}

const EndpointPicker: React.FC<EndpointPickerProps> = ({
    title, side, value, onChange, portfolios, brokers, assets,
}) => {
    const isPortfolio = value.kind === 'portfolio';

    const selectPortfolio = () => {
        if (isPortfolio) return;
        onChange({ kind: 'portfolio', portfolioId: portfolios[0]?.id ?? '' });
    };

    const selectCash = () => {
        if (!isPortfolio) return;
        onChange({ kind: 'cash', brokerId: brokers[0]?.id });
    };

    // Sell side offers what is actually held; buy side also offers the targets,
    // so money can be moved into a position that does not exist yet.
    const assetOptions = React.useMemo(() => {
        const held = assets
            .filter(a => !isCashTicker(a.ticker) && a.quantity > 0)
            .map(a => ({ ticker: a.ticker, label: a.label }));
        if (side === 'from') return held;

        const portfolio = isPortfolio ? portfolios.find(p => p.id === value.portfolioId) : undefined;
        const heldTickers = new Set(held.map(h => h.ticker.toUpperCase()));
        const targets = Object.keys(portfolio?.allocations || {})
            .filter(k => !heldTickers.has(k.toUpperCase()))
            .filter(k => !(portfolio?.allocationGroups || []).some(g => g.id === k))
            .map(ticker => ({ ticker, label: undefined }));
        return [...held, ...targets];
    }, [assets, side, isPortfolio, portfolios, value]);

    return (
        <div className="reloc-endpoint">
            <h4 className="reloc-endpoint-title">{title}</h4>

            <div className="reloc-kind-switch">
                <button
                    type="button"
                    className={`reloc-kind-btn${isPortfolio ? ' active' : ''}`}
                    onClick={selectPortfolio}
                >
                    Portafoglio
                </button>
                <button
                    type="button"
                    className={`reloc-kind-btn${!isPortfolio ? ' active' : ''}`}
                    onClick={selectCash}
                >
                    Cash
                </button>
            </div>

            {isPortfolio ? (
                <>
                    <div className="reloc-field">
                        <label className="reloc-label">Portafoglio</label>
                        <select
                            className="reloc-select"
                            value={value.portfolioId}
                            onChange={e => onChange({ kind: 'portfolio', portfolioId: e.target.value })}
                        >
                            {portfolios.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                    </div>

                    <div className="reloc-field">
                        <label className="reloc-label">
                            Asset esatto <span style={{ color: 'var(--text-muted)' }}>(opzionale)</span>
                        </label>
                        <select
                            className="reloc-select"
                            value={value.ticker ?? ''}
                            onChange={e => onChange({
                                kind: 'portfolio',
                                portfolioId: value.portfolioId,
                                ticker: e.target.value || undefined,
                            })}
                        >
                            <option value="">
                                {side === 'from' ? 'Scegli tu cosa vendere' : 'Scegli tu cosa comprare'}
                            </option>
                            {assetOptions.map(a => (
                                <option key={a.ticker} value={a.ticker}>
                                    {a.label ? `${a.ticker} — ${a.label}` : a.ticker}
                                </option>
                            ))}
                        </select>
                    </div>
                </>
            ) : (
                <div className="reloc-field">
                    <label className="reloc-label">Broker</label>
                    <select
                        className="reloc-select"
                        value={value.brokerId ?? ''}
                        onChange={e => onChange({ kind: 'cash', brokerId: e.target.value || undefined })}
                    >
                        <option value="">Liquidità complessiva</option>
                        {brokers.map(b => (
                            <option key={b.id} value={b.id}>
                                {b.name} — €{Math.round(b.currentLiquidity ?? 0).toLocaleString('it-IT')}
                            </option>
                        ))}
                    </select>
                    <p className="reloc-hint">
                        {side === 'from'
                            ? 'Nessuna vendita, quindi nessuna imposta: si paga solo la commissione di acquisto.'
                            : 'Il ricavato netto resta liquidità, senza essere reinvestito.'}
                    </p>
                </div>
            )}
        </div>
    );
};

interface RelocationFormProps {
    from: RelocationEndpoint;
    to: RelocationEndpoint;
    netAmount: number;
    applyFreeBuyPromo: boolean;
    onFromChange: (endpoint: RelocationEndpoint) => void;
    onToChange: (endpoint: RelocationEndpoint) => void;
    onNetAmountChange: (amount: number) => void;
    onFreeBuyPromoChange: (enabled: boolean) => void;
    portfolios: Portfolio[];
    brokers: Broker[];
    sourceAssets: Asset[];
    destAssets: Asset[];
}

const RelocationForm: React.FC<RelocationFormProps> = ({
    from, to, netAmount, applyFreeBuyPromo,
    onFromChange, onToChange, onNetAmountChange, onFreeBuyPromoChange,
    portfolios, brokers, sourceAssets, destAssets,
}) => (
    <div className="reloc-card">
        <div className="reloc-form-grid">
            <EndpointPicker
                title="Da"
                side="from"
                value={from}
                onChange={onFromChange}
                portfolios={portfolios}
                brokers={brokers}
                assets={sourceAssets}
            />
            <div className="reloc-arrow" aria-hidden="true">→</div>
            <EndpointPicker
                title="A"
                side="to"
                value={to}
                onChange={onToChange}
                portfolios={portfolios}
                brokers={brokers}
                assets={destAssets}
            />
        </div>

        <div className="reloc-amount-row">
            <div className="reloc-amount-field">
                <label className="reloc-label">
                    {to.kind === 'cash'
                        ? 'Liquidità netta da ottenere (€)'
                        : 'Importo netto da investire in destinazione (€)'}
                </label>
                <input
                    type="number"
                    className="reloc-input reloc-amount-input"
                    value={netAmount || ''}
                    min={0}
                    step={100}
                    placeholder="es. 10000"
                    onChange={e => onNetAmountChange(Math.max(0, Number(e.target.value) || 0))}
                />
            </div>

            <label className="reloc-checkbox">
                <input
                    type="checkbox"
                    checked={applyFreeBuyPromo}
                    onChange={e => onFreeBuyPromoChange(e.target.checked)}
                />
                Applica le promo &ldquo;acquisto gratuito&rdquo; di questo mese
            </label>
        </div>

        <p className="reloc-hint">
            L&apos;importo è quello che deve <strong>arrivare a destinazione</strong>: le vendite
            vengono dimensionate a ritroso perché imposte e commissioni siano già coperte.
        </p>
    </div>
);

export default RelocationForm;
