import React from 'react';
import type { Asset, Broker, Portfolio } from '../../types';
import type { RelocationEndpoint } from '../../utils/fundRelocation';
import { isCashTicker } from '../../utils/portfolioCalculations';

/**
 * Source and destination are the same control, because they are the same union:
 * either a portfolio (optionally pinned to one asset) or cash. That symmetry is
 * what lets one screen express a divestment, an investment and a swap.
 *
 * The destination has one option the source cannot have: SPEND. Money that is
 * spent has no other end — it leaves, and the picker says so by offering
 * nothing else to configure.
 */

/** A parent/child group offered as one endpoint, next to the real portfolios. */
export interface GroupOption {
    id: string;
    name: string;
    /** "Core + Satellite", for the caption under the picker. */
    memberNames: string;
}

interface EndpointPickerProps {
    title: string;
    side: 'from' | 'to';
    value: RelocationEndpoint;
    onChange: (endpoint: RelocationEndpoint) => void;
    portfolios: Portfolio[];
    groups: GroupOption[];
    brokers: Broker[];
    /** Holdings of the currently selected portfolio or group, for the asset dropdown. */
    assets: Asset[];
}

const EndpointPicker: React.FC<EndpointPickerProps> = ({
    title, side, value, onChange, portfolios, groups, brokers, assets,
}) => {
    const isPortfolio = value.kind === 'portfolio';
    const isCash = value.kind === 'cash';
    const isSpend = value.kind === 'spend';
    const selectedGroup = value.kind === 'portfolio' ? groups.find(g => g.id === value.portfolioId) : undefined;

    const selectPortfolio = () => {
        if (isPortfolio) return;
        onChange({ kind: 'portfolio', portfolioId: portfolios[0]?.id ?? '' });
    };

    const selectCash = () => {
        if (isCash) return;
        onChange({ kind: 'cash', brokerId: brokers[0]?.id });
    };

    // Sell side offers what is actually held; buy side also offers the targets,
    // so money can be moved into a position that does not exist yet.
    const assetOptions = React.useMemo(() => {
        const held = assets
            .filter(a => !isCashTicker(a.ticker) && a.quantity > 0)
            .map(a => ({ ticker: a.ticker, label: a.label }));
        if (side === 'from') return held;

        // A group has no stored allocations of its own, so its buy-side targets
        // are the union of its members'.
        const sources: Portfolio[] = isPortfolio
            ? (groups.some(g => g.id === value.portfolioId)
                ? portfolios
                : portfolios.filter(p => p.id === value.portfolioId))
            : [];
        const heldTickers = new Set(held.map(h => h.ticker.toUpperCase()));
        const seen = new Set<string>();
        const targets = sources.flatMap(portfolio =>
            Object.keys(portfolio.allocations || {})
                .filter(k => !heldTickers.has(k.toUpperCase()))
                .filter(k => !(portfolio.allocationGroups || []).some(g => g.id === k))
                .filter(k => {
                    const key = k.toUpperCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .map(ticker => ({ ticker, label: undefined }))
        );
        return [...held, ...targets];
    }, [assets, side, isPortfolio, portfolios, groups, value]);

    return (
        <div className="reloc-endpoint">
            <h4 className="reloc-endpoint-title">{title}</h4>

            <div className="reloc-kind-switch">
                <button
                    type="button"
                    className={`reloc-kind-btn${isPortfolio ? ' active' : ''}`}
                    onClick={selectPortfolio}
                >
                    Portfolio
                </button>
                <button
                    type="button"
                    className={`reloc-kind-btn${isCash ? ' active' : ''}`}
                    onClick={selectCash}
                >
                    Cash
                </button>
                {side === 'to' && (
                    <button
                        type="button"
                        className={`reloc-kind-btn${isSpend ? ' active' : ''}`}
                        onClick={() => { if (!isSpend) onChange({ kind: 'spend' }); }}
                    >
                        Spend
                    </button>
                )}
            </div>

            {value.kind === 'portfolio' ? (
                <>
                    <div className="reloc-field">
                        <label className="reloc-label">Portfolio</label>
                        <select
                            className="reloc-select"
                            value={value.portfolioId}
                            onChange={e => onChange({ kind: 'portfolio', portfolioId: e.target.value })}
                        >
                            {groups.length > 0 && (
                                <optgroup label="Groups (parent + children as one)">
                                    {groups.map(g => (
                                        <option key={g.id} value={g.id}>{g.name}</option>
                                    ))}
                                </optgroup>
                            )}
                            {groups.length > 0 ? (
                                <optgroup label="Single portfolios">
                                    {portfolios.map(p => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                                </optgroup>
                            ) : (
                                portfolios.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))
                            )}
                        </select>
                        {selectedGroup && (
                            <span className="reloc-hint">
                                {selectedGroup.memberNames} — the move is carried out on the members,
                                {side === 'from' ? ' taken from' : ' delivered to'} whichever is furthest
                                from the group ratio.
                            </span>
                        )}
                    </div>

                    <div className="reloc-field">
                        <label className="reloc-label">
                            Exact asset <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
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
                                {side === 'from' ? 'Let the solver choose what to sell' : 'Let the solver choose what to buy'}
                            </option>
                            {assetOptions.map(a => (
                                <option key={a.ticker} value={a.ticker}>
                                    {a.label ? `${a.ticker} — ${a.label}` : a.ticker}
                                </option>
                            ))}
                        </select>
                    </div>
                </>
            ) : value.kind === 'spend' ? (
                <div className="reloc-field">
                    <p className="reloc-hint">
                        The money is <strong>spent</strong>: it leaves your net worth and lands nowhere.
                        Nothing is bought, and nothing is written to Transactions — this end exists only
                        to see what the stats look like once the money is gone.
                    </p>
                </div>
            ) : (
                <div className="reloc-field">
                    <label className="reloc-label">Broker</label>
                    <select
                        className="reloc-select"
                        value={value.brokerId ?? ''}
                        onChange={e => onChange({ kind: 'cash', brokerId: e.target.value || undefined })}
                    >
                        <option value="">Total liquidity</option>
                        {brokers.map(b => (
                            <option key={b.id} value={b.id}>
                                {b.name} — €{Math.round(b.currentLiquidity ?? 0).toLocaleString('en-IE')}
                            </option>
                        ))}
                    </select>
                    <p className="reloc-hint">
                        {side === 'from'
                            ? 'No sale, so no tax: only the buy commission is charged.'
                            : 'The net proceeds stay in cash instead of being reinvested.'}
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
    /** Parent/child groups, offered as single endpoints alongside the portfolios. */
    groups: GroupOption[];
    brokers: Broker[];
    sourceAssets: Asset[];
    destAssets: Asset[];
    /** Moves already queued — this form always edits the one after them. */
    queuedCount: number;
    /** Pin the current move to the sequence and start a new one. */
    onAddToSequence: () => void;
    canAddToSequence: boolean;
}

const RelocationForm: React.FC<RelocationFormProps> = ({
    from, to, netAmount, applyFreeBuyPromo,
    onFromChange, onToChange, onNetAmountChange, onFreeBuyPromoChange,
    portfolios, groups, brokers, sourceAssets, destAssets,
    queuedCount, onAddToSequence, canAddToSequence,
}) => (
    <div className="reloc-card">
        {queuedCount > 0 && (
            <div className="reloc-form-badge">
                Move {queuedCount + 1} — planned on the state the {queuedCount === 1 ? 'first move leaves' : `first ${queuedCount} moves leave`} behind
            </div>
        )}

        <div className="reloc-form-grid">
            <EndpointPicker
                title="From"
                side="from"
                value={from}
                onChange={onFromChange}
                portfolios={portfolios}
                groups={groups}
                brokers={brokers}
                assets={sourceAssets}
            />
            <div className="reloc-arrow" aria-hidden="true">→</div>
            <EndpointPicker
                title="To"
                side="to"
                value={to}
                onChange={onToChange}
                portfolios={portfolios}
                groups={groups}
                brokers={brokers}
                assets={destAssets}
            />
        </div>

        <div className="reloc-amount-row">
            <div className="reloc-amount-field">
                <label className="reloc-label">
                    {to.kind === 'spend'
                        ? 'Amount to spend (€)'
                        : to.kind === 'cash'
                            ? 'Net cash to raise (€)'
                            : 'Net amount to invest in the destination (€)'}
                </label>
                <input
                    type="number"
                    className="reloc-input reloc-amount-input"
                    value={netAmount || ''}
                    min={0}
                    step={100}
                    placeholder="e.g. 10000"
                    onChange={e => onNetAmountChange(Math.max(0, Number(e.target.value) || 0))}
                />
            </div>

            <label className="reloc-checkbox">
                <input
                    type="checkbox"
                    checked={applyFreeBuyPromo}
                    onChange={e => onFreeBuyPromoChange(e.target.checked)}
                />
                Apply this month&rsquo;s free-buy promotions
            </label>
        </div>

        <div className="reloc-form-actions">
            <button
                type="button"
                className="reloc-btn primary"
                onClick={onAddToSequence}
                disabled={!canAddToSequence}
            >
                + Add this move to the sequence
            </button>
            <span className="reloc-hint reloc-form-actions-hint">
                Queue it and plan the next one on top of it, to see what a chain of moves does to the stats.
            </span>
        </div>

        <p className="reloc-hint">
            {to.kind === 'spend'
                ? <>The amount is what actually <strong>leaves</strong>: a sale funding it is sized
                    backwards from the spend, so tax and commissions are already covered, and any change
                    whole shares leave behind stays in cash instead of being spent by accident.</>
                : <>The amount is what must <strong>land in the destination</strong>: the sales are sized
                    backwards from it, so tax and commissions are already covered.</>}
        </p>
    </div>
);

export default RelocationForm;
