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

YNAB writes keep their preview, single confirmation and write guard: the page
only opens those modals.

## Later (not in this step)

Persisting the Capital Allocation queue into the same store; disinvesting
before a capex is due; bond maturities and coupons; emergency fund top-ups;
YNAB funding plan orders.
