# Operations queue — plan

One new page, **Execute → Operations**, where everything still to be done
converges: what the data says is due, what has been done from here, and the
real action each one runs once confirmed. The rest of the UI is left as it is:
every view keeps its own buttons; the page reuses their functions and modals.

## Data

- **To do** is computed live by detectors (`src/utils/operationsQueue.ts`,
  pure): each one reads the state and returns items with a stable `key`,
  e.g. `pac:<planId>:<date>`, `rebalance:<portfolioId>:full`, `prices`.
  An item goes away by itself when its condition does (prices refreshed,
  instalment registered), wherever it was done.
- **History** is stored (`portfolio_operations`, in the backup and Azure sync):
  one record per operation run from the page, with what it produced
  (transaction ids, write-log entry, counts), plus snoozes (`key` until a date).
- A to-do whose action ran from a modal is recorded as done when, after the
  modal closes, its key is no longer detected: the same rule for every kind.

## To do and the action each one runs

| To do | Detected by | Action (reused) |
|---|---|---|
| Prices older than a day | `marketData[t].lastUpdated` of held/allocated tickers | `refreshPrices` |
| Broker liquidity / interest | brokers with a YNAB account or a remuneration plan; last update from history | `prepareBrokerLiquiditySync` → `BrokerLiquiditySyncModal` → `applyBrokerLiquiditySync` |
| PAC instalment due | `generateInstalments` + `pacExecutions` | `PacConfirmModal`, or skip (`skipPacInstalment`) |
| Rebalance (Full / Buy only) | `computeFullRebalance` / `computeBuyOnly`, moved from the Dashboard to `utils/rebalanceOrders.ts` unchanged | review the orders (editable quantity and price) → `addTransactionsBulk` |
| Capex categories in YNAB (note / [Invested]) | `capexNotesOutOfDate` | `CapexNotesModal` |
| Capex that needs a bond | `capexBondMatch(...).needsSearch` | `CapexBondModal` |
| Virtual bond to concretize | unresolved virtual bond with parked cash, or maturity near | `ConcretizeModal` → `concretizeVirtualBond` |
| YNAB Writeback moves / revaluation | `suggestReassignments`, `buildRevaluationPreview` (YNAB accounts read on demand) | `CapexSyncModal`, `RevalueModal` |
| Planned capex not synced for a week | `ynabConfig.lastGoalsSyncAt` | `useCapexSync` |
| Azure backup older than a week | `azureConfig.lastSync` | `syncToAzure` |
| Moves between portfolios (Buckets targets ≥ 3 points off) | `buildGoalFlowPlan` over `goalModeTargets` + Move/Freeze/Skip states; silent while the Capital Allocation queue holds moves | queue the moves in Capital Allocation and open it |
| Capital Allocation queue not executed | `relocationQueue` (now in the context, `portfolio_relocation_queue`, local only) | open Capital Allocation (sell → wire → buy, Mark as executed) |
| Capex matching (amount-mode portfolios) | `resolveAmountTargets` + `planAmountBuys` on the cash capped to the broker earmarks (`amountTargetUnits` / `amountTargetOrders`, shared with the Dashboard table) | review the orders → `addTransactionsBulk`; without cash a notice opening the Dashboard |
| Free cash on a broker with no minimum | `brokerLiquidityStatus`: cash not earmarked, ≥ €100 | invest in a portfolio or transfer (same as broker cash) |
| Price history behind (> 7 days, not CPRAM) | `priceHistory` last point / `lastHistoryFetch` of held tickers | `refreshHistory` |
| Bond matured / maturing within 30 days | `AssetDefinition.maturityDate` of held bonds | Sell at par per broker (reviewed) / notice |
| Capex due within 60 days that needs selling, or is short | `useMaturityLadder` (`fromSelling`, `missing`) | open Expense Planning |
| Free-buy list missing this month | a broker with a list in the last 3 months and none for this one | open Settings |

Buy only and capex-matching orders confirmed here spend the portfolio's own
cash: `consumePortfolioCash` lowers its Liquidity and the broker earmarks by
what was bought, so the to-do does not come back on money already used. A Buy
only leftover under €100 is not a to-do. Notices with nothing to run can be
snoozed or noted ("Got it", hidden for good).

YNAB writes keep their preview, single confirmation and write guard: the page
only opens those modals.

## Later (not in this step)

Coupons; emergency fund top-ups; YNAB funding plan orders (they need the YNAB
categories read live); Buy only from the Dashboard does not consume the
portfolio Liquidity yet (only Operations and the capex-matching table do).
