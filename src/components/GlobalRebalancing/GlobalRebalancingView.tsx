import React, { useMemo, useState } from 'react';
import Swal from 'sweetalert2';
import { usePortfolio } from '../../context/PortfolioContext';
import { calculateAssets } from '../../utils/portfolioCalculations';
import { calculateGlobalRebalancingDistribution, getWeightForPortfolio } from '../../utils/globalRebalancing';

const parseEuroAmount = (rawValue: string): number => {
    const sanitized = rawValue.trim().replace(/[^\d,.-]/g, '');

    if (!sanitized) {
        return 0;
    }

    const lastComma = sanitized.lastIndexOf(',');
    const lastDot = sanitized.lastIndexOf('.');

    let normalized = sanitized;

    if (lastComma > lastDot) {
        normalized = sanitized.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
        normalized = sanitized.replace(/,/g, '');
    } else {
        normalized = sanitized.replace(',', '.');
    }

    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : 0;
};

const formatCurrency = (value: number): string => {
    return value.toLocaleString('en-IE', {
        style: 'currency',
        currency: 'EUR',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
};

const formatPercent = (value: number): string => `${value.toFixed(1)}%`;

const GlobalRebalancingView: React.FC = () => {
    const {
        portfolios,
        transactions,
        assetSettings,
        marketData,
        globalRebalancingSettings,
        updateGlobalPortfolioWeight,
        applyGlobalLiquidityDistribution
    } = usePortfolio();

    const [amountInput, setAmountInput] = useState('');
    const [inclusionOverrides, setInclusionOverrides] = useState<Record<string, boolean>>({});

    const includedByPortfolioId = useMemo(() => {
        return portfolios.reduce<Record<string, boolean>>((acc, portfolio) => {
            acc[portfolio.id] = inclusionOverrides[portfolio.id] ?? true;
            return acc;
        }, {});
    }, [inclusionOverrides, portfolios]);

    const transactionsByPortfolio = useMemo(() => {
        return transactions.reduce<Record<string, typeof transactions>>((acc, transaction) => {
            if (!transaction.portfolioId) {
                return acc;
            }

            if (!acc[transaction.portfolioId]) {
                acc[transaction.portfolioId] = [];
            }

            acc[transaction.portfolioId].push(transaction);
            return acc;
        }, {});
    }, [transactions]);

    const portfolioRows = useMemo(() => {
        return portfolios.map(portfolio => {
            const portfolioTransactions = transactionsByPortfolio[portfolio.id] || [];
            const { summary } = calculateAssets(portfolioTransactions, assetSettings, marketData);
            const currentLiquidity = Number.isFinite(portfolio.liquidity) ? portfolio.liquidity || 0 : 0;
            const currentTotalValue = summary.totalValue + currentLiquidity;

            return {
                portfolioId: portfolio.id,
                name: portfolio.name,
                currentInvestedValue: summary.totalValue,
                currentLiquidity,
                currentTotalValue,
                targetWeight: getWeightForPortfolio(globalRebalancingSettings, portfolio.id),
                included: includedByPortfolioId[portfolio.id] ?? true
            };
        });
    }, [assetSettings, globalRebalancingSettings, includedByPortfolioId, marketData, portfolios, transactionsByPortfolio]);

    const investmentAmount = useMemo(() => parseEuroAmount(amountInput), [amountInput]);

    const result = useMemo(() => {
        return calculateGlobalRebalancingDistribution(portfolioRows, investmentAmount);
    }, [investmentAmount, portfolioRows]);

    const totalConfiguredWeight = useMemo(() => {
        return portfolios.reduce((sum, portfolio) => {
            return sum + getWeightForPortfolio(globalRebalancingSettings, portfolio.id);
        }, 0);
    }, [globalRebalancingSettings, portfolios]);

    const handleTogglePortfolio = (portfolioId: string) => {
        setInclusionOverrides(prev => ({
            ...prev,
            [portfolioId]: !(includedByPortfolioId[portfolioId] ?? true)
        }));
    };

    const handleWeightChange = (portfolioId: string, rawValue: string) => {
        const weight = parseFloat(rawValue);
        updateGlobalPortfolioWeight(portfolioId, Number.isFinite(weight) ? weight : 0);
    };

    const handleApplyDistribution = async () => {
        if (result.blockingIssues.length > 0) {
            await Swal.fire({
                title: 'Cannot apply distribution',
                html: result.blockingIssues.map(issue => `<div>${issue}</div>`).join(''),
                icon: 'warning',
                confirmButtonColor: '#6366f1',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)'
            });
            return;
        }

        const distribution = result.portfolios.reduce<Record<string, number>>((acc, portfolio) => {
            if (portfolio.suggestedInvestment > 0) {
                acc[portfolio.portfolioId] = portfolio.suggestedInvestment;
            }
            return acc;
        }, {});

        const impactedPortfolios = Object.keys(distribution).length;

        if (impactedPortfolios === 0) {
            await Swal.fire({
                title: 'No changes to apply',
                text: 'The selected setup does not produce any liquidity allocation.',
                icon: 'info',
                confirmButtonColor: '#6366f1',
                background: 'var(--bg-surface)',
                color: 'var(--text-primary)'
            });
            return;
        }

        const warningHtml = result.warnings.length > 0
            ? `<div style="margin-top:12px;color:#f59e0b;">${result.warnings.join('<br/>')}</div>`
            : '';

        const confirmation = await Swal.fire({
            title: 'Apply global distribution?',
            html:
                `<div>This will add <strong>${formatCurrency(result.totalInvestmentAmount)}</strong> to portfolio liquidity across <strong>${impactedPortfolios}</strong> portfolio(s).</div>` +
                '<div style="margin-top:12px;font-size:0.9rem;color:var(--text-secondary)">You can then execute Buy Only from the dashboard for each portfolio.</div>' +
                warningHtml,
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Apply to liquidity',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#10b981',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)'
        });

        if (!confirmation.isConfirmed) {
            return;
        }

        applyGlobalLiquidityDistribution(distribution);
        setAmountInput('');

        await Swal.fire({
            title: 'Liquidity updated',
            text: `Distribution applied to ${impactedPortfolios} portfolio(s).`,
            icon: 'success',
            confirmButtonColor: '#6366f1',
            background: 'var(--bg-surface)',
            color: 'var(--text-primary)'
        });
    };

    if (portfolios.length === 0) {
        return (
            <div className="global-rebalancing-empty">
                <h2>Global Rebalancing</h2>
                <p>Create at least one portfolio before using the global rebalancing page.</p>
                <style>{`
                    .global-rebalancing-empty {
                        background: var(--bg-surface);
                        border: 1px solid var(--border-color);
                        border-radius: var(--radius-lg);
                        padding: var(--space-8);
                        text-align: center;
                    }
                `}</style>
            </div>
        );
    }

    return (
        <div className="global-rebalancing-page">
            <section className="global-hero-card">
                <div>
                    <h2>Global Rebalancing</h2>
                    <p>
                        Configure portfolio weights, choose which portfolios are included, and distribute a new EUR amount
                        across them with buy-only logic.
                    </p>
                </div>

                <div className="hero-metrics">
                    <div className="metric-card">
                        <span className="metric-label">Configured Weight</span>
                        <strong className={Math.abs(totalConfiguredWeight - 100) < 0.1 ? 'metric-good' : 'metric-warn'}>
                            {formatPercent(totalConfiguredWeight)}
                        </strong>
                    </div>
                    <div className="metric-card">
                        <span className="metric-label">Selected Weight</span>
                        <strong className={result.totalIncludedWeight > 0 ? 'metric-good' : 'metric-warn'}>
                            {formatPercent(result.totalIncludedWeight)}
                        </strong>
                    </div>
                    <div className="metric-card">
                        <span className="metric-label">Current Selected Value</span>
                        <strong>{formatCurrency(result.totalSelectedValue)}</strong>
                    </div>
                    <div className="metric-card">
                        <span className="metric-label">Amount to Invest</span>
                        <strong>{formatCurrency(result.totalInvestmentAmount)}</strong>
                    </div>
                </div>
            </section>

            <section className="global-controls-card">
                <div className="input-block">
                    <label htmlFor="global-investment-amount">Amount to Invest (EUR)</label>
                    <textarea
                        id="global-investment-amount"
                        rows={2}
                        value={amountInput}
                        onChange={(event) => setAmountInput(event.target.value)}
                        placeholder="Example: 2500 or 2.500,00"
                    />
                    <small>The value is applied as portfolio liquidity. Asset-level execution remains in the dashboard.</small>
                </div>

                <div className="controls-actions">
                    <button className="btn btn-primary" onClick={handleApplyDistribution}>
                        Apply Distribution to Liquidity
                    </button>
                </div>

                {result.blockingIssues.length > 0 && (
                    <div className="message-box message-error">
                        {result.blockingIssues.map(issue => (
                            <div key={issue}>{issue}</div>
                        ))}
                    </div>
                )}

                {result.warnings.length > 0 && (
                    <div className="message-box message-warning">
                        {result.warnings.map(warning => (
                            <div key={warning}>{warning}</div>
                        ))}
                    </div>
                )}
            </section>

            <section className="global-table-card">
                <div className="table-header">
                    <h3>Portfolio Distribution</h3>
                    <span>{portfolios.length} portfolio(s)</span>
                </div>

                <div className="table-scroll">
                    <table className="distribution-table">
                        <thead>
                            <tr>
                                <th>Include</th>
                                <th>Portfolio</th>
                                <th>Global Weight %</th>
                                <th>Invested</th>
                                <th>Liquidity</th>
                                <th>Total</th>
                                <th>Current Weight</th>
                                <th>Target Weight</th>
                                <th>Target Value</th>
                                <th>Suggested EUR</th>
                                <th>Projected Weight</th>
                            </tr>
                        </thead>
                        <tbody>
                            {result.portfolios.map(portfolio => (
                                <tr key={portfolio.portfolioId} className={!portfolio.included ? 'row-muted' : ''}>
                                    <td>
                                        <input
                                            type="checkbox"
                                            checked={portfolio.included}
                                            onChange={() => handleTogglePortfolio(portfolio.portfolioId)}
                                            aria-label={`Include ${portfolio.name}`}
                                        />
                                    </td>
                                    <td>
                                        <div className="portfolio-name-cell">
                                            <strong>{portfolio.name}</strong>
                                            {!portfolio.included && <span>Excluded</span>}
                                        </div>
                                    </td>
                                    <td>
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.1"
                                            className="weight-input"
                                            value={portfolio.targetWeight || ''}
                                            onChange={(event) => handleWeightChange(portfolio.portfolioId, event.target.value)}
                                            placeholder="0"
                                        />
                                    </td>
                                    <td>{formatCurrency(portfolio.currentInvestedValue)}</td>
                                    <td>{formatCurrency(portfolio.currentLiquidity)}</td>
                                    <td>{formatCurrency(portfolio.currentTotalValue)}</td>
                                    <td>{portfolio.included ? formatPercent(portfolio.currentWeight) : '-'}</td>
                                    <td>{portfolio.included ? formatPercent(portfolio.normalizedWeight) : '-'}</td>
                                    <td>{portfolio.included ? formatCurrency(portfolio.targetValue) : '-'}</td>
                                    <td className={portfolio.suggestedInvestment > 0 ? 'value-positive' : ''}>
                                        {portfolio.included ? formatCurrency(portfolio.suggestedInvestment) : '-'}
                                    </td>
                                    <td>{portfolio.included ? formatPercent(portfolio.projectedWeight) : '-'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            <style>{`
                .global-rebalancing-page {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-6);
                }

                .global-hero-card,
                .global-controls-card,
                .global-table-card {
                    background: linear-gradient(180deg, rgba(30, 41, 59, 0.96), rgba(15, 23, 42, 0.96));
                    border: 1px solid rgba(148, 163, 184, 0.16);
                    border-radius: var(--radius-lg);
                    padding: var(--space-6);
                    box-shadow: var(--shadow-md);
                }

                .global-hero-card h2,
                .global-table-card h3 {
                    margin: 0 0 var(--space-2) 0;
                }

                .global-hero-card p {
                    margin: 0;
                    color: var(--text-secondary);
                    max-width: 720px;
                    line-height: 1.5;
                }

                .hero-metrics {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: var(--space-4);
                    margin-top: var(--space-6);
                }

                .metric-card {
                    padding: var(--space-4);
                    border-radius: var(--radius-md);
                    background: rgba(15, 23, 42, 0.72);
                    border: 1px solid rgba(148, 163, 184, 0.12);
                }

                .metric-label {
                    display: block;
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    margin-bottom: var(--space-2);
                }

                .metric-card strong {
                    font-size: 1.15rem;
                }

                .metric-good {
                    color: var(--color-success);
                }

                .metric-warn {
                    color: var(--color-warning);
                }

                .global-controls-card {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-4);
                }

                .input-block {
                    display: flex;
                    flex-direction: column;
                    gap: var(--space-2);
                }

                .input-block label {
                    font-weight: 600;
                }

                .input-block textarea,
                .weight-input {
                    width: 100%;
                    border-radius: var(--radius-md);
                    border: 1px solid var(--border-color);
                    background: rgba(15, 23, 42, 0.92);
                    color: var(--text-primary);
                    padding: var(--space-3);
                    font: inherit;
                }

                .input-block textarea:focus,
                .weight-input:focus {
                    outline: none;
                    border-color: var(--color-primary);
                }

                .input-block small {
                    color: var(--text-secondary);
                }

                .controls-actions {
                    display: flex;
                    justify-content: flex-end;
                }

                .message-box {
                    border-radius: var(--radius-md);
                    padding: var(--space-3) var(--space-4);
                    line-height: 1.5;
                }

                .message-error {
                    background: rgba(239, 68, 68, 0.12);
                    border: 1px solid rgba(239, 68, 68, 0.28);
                    color: #fecaca;
                }

                .message-warning {
                    background: rgba(245, 158, 11, 0.12);
                    border: 1px solid rgba(245, 158, 11, 0.28);
                    color: #fde68a;
                }

                .table-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: var(--space-3);
                    margin-bottom: var(--space-4);
                }

                .table-header span {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                .table-scroll {
                    overflow-x: auto;
                }

                .distribution-table {
                    width: 100%;
                    border-collapse: collapse;
                    min-width: 1100px;
                }

                .distribution-table th,
                .distribution-table td {
                    padding: var(--space-3);
                    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
                    text-align: right;
                    vertical-align: middle;
                    white-space: nowrap;
                }

                .distribution-table th:first-child,
                .distribution-table td:first-child,
                .distribution-table th:nth-child(2),
                .distribution-table td:nth-child(2) {
                    text-align: left;
                }

                .portfolio-name-cell {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }

                .portfolio-name-cell span {
                    color: var(--text-secondary);
                    font-size: 0.75rem;
                }

                .weight-input {
                    min-width: 88px;
                    text-align: right;
                    padding: var(--space-2);
                }

                .row-muted {
                    opacity: 0.55;
                }

                .value-positive {
                    color: var(--color-success);
                    font-weight: 600;
                }

                @media (max-width: 768px) {
                    .global-hero-card,
                    .global-controls-card,
                    .global-table-card {
                        padding: var(--space-4);
                    }

                    .controls-actions {
                        justify-content: stretch;
                    }

                    .controls-actions .btn {
                        width: 100%;
                    }
                }
            `}</style>
        </div>
    );
};

export default GlobalRebalancingView;
