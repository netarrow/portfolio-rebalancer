# Portfolio Rebalancer

A self-hosted web app to **track, analyse and rebalance an investment portfolio** of ETFs and bonds — built to replace an over-complicated personal spreadsheet.

It answers the questions a buy-and-hold investor actually asks: *How is my net worth doing? Am I off my target allocation, and exactly what should I buy or sell to get back on track? Can I afford this planned expense over the next N years? Where is my cash sitting?*

Everything runs locally: a single Express server serves the API and the built React frontend, and all your data lives in your browser. Prices are refreshed on demand from public Italian/European market sources.

---

## What it is — and what it is *not* (constraints)

This is a **personal tool with deliberate simplifications**. Read these before using it:

| Constraint | Detail |
|---|---|
| **Single currency** | Everything is in **EUR**. There is no FX handling or multi-currency reporting. |
| **Local-first storage** | All portfolio data lives in your browser's `localStorage`. There is **no account, no server-side database**. Clearing the browser, switching device or using incognito loses the data unless you back it up. |
| **Backups are your job** | Export a JSON backup yourself, or enable the optional encrypted Azure Blob sync. Price history has its own separate backup. |
| **Prices via scraping, not official APIs** | Quotes come from a small set of fixed public sources, not a licensed market-data feed: **JustETF** (standard ETFs), **Borsa Italiana / MOT** (Italian BTPs & bonds), **CPRAM** (some active funds). No other tickers are supported out of the box. |
| **Free vs Premium price tier** | Without a Premium key, *Update Price* runs on a **throttled free tier** (server-wide concurrency cap, prices cached up to ~24h). A Premium key unlocks unlimited, real-time updates. |
| **Asset universe** | Designed around **ETFs and bonds**. No crypto, options or derivatives modelling. |
| **Not financial advice** | Returns, forecasts and rebalancing suggestions are mechanical calculations on your own inputs. They are not advice. |

If you are comfortable with the above, you are welcome to use it as-is.

---

## Running it

```bash
npm install
npm run build      # builds the Vite frontend into dist/
npm start          # Express serves API + frontend on http://localhost:3002
```

Then open the app and go to **Settings → Load Mock Data** to populate a full demo dataset that exercises every feature (this is also exactly what the screenshots below show).

**Tech stack:** React 19 + TypeScript + Vite, Recharts & ApexCharts, SweetAlert2 · Node.js + Express + Socket.IO · Puppeteer + Cheerio for scraping · `localStorage` with optional AES-256-GCM Azure Blob sync · Docker + GitHub Actions.

> All screenshots below are generated from the bundled mock dataset via `scripts/take_screenshots.js`.

---

## The app, page by page

### Dashboard

The home hub: the financial summary, broker performance, allocation charts and per-portfolio rebalancing tables.

![Dashboard summary cards](screenshots/dashboard_top.png)

**Financial summary cards** give the whole picture at a glance:

- **Total Cost** / **Invested Value** — what you paid vs what the holdings are worth now.
- **Price Appreciation** (unrealized only), **Total Appreciation** (unrealized + realized) and **Total Return** (appreciation + distributions), each with its percentage.
- **Liquidity** and **Net Worth** (holdings + cash).
- **Realized Gains** and **Distributions** (dividends / coupons) — tap either to see the breakdown.

![Broker performance & allocation](screenshots/dashboard_middle.png)

- **Broker Performance & Liquidity** — per-broker Total / Value / Cost / Return, plus available cash.
- **Allocation Overview** — donut charts for portfolio share, broker share and asset class.

![Rebalancing tables](screenshots/dashboard_bottom.png)

- **Per-portfolio rebalancing tables** — current vs target allocation with the explicit buy/sell amount needed to reach target, plus a **Buy Only** column that deploys new capital toward the target without selling.

**Withdrawal Simulation** lets you plan a divestment while keeping the portfolio close to its target weights:

![Withdrawal simulation](screenshots/dashboard_withdrawal_simulation.png)

### Stats

A composition deep-dive across portfolios and macro exposure.

![Stats — pyramid](screenshots/stats_top.png)
![Stats — macro allocation](screenshots/stats_middle.png)
![Stats — per portfolio](screenshots/stats_bottom.png)

- **Portfolio Pyramid** — wealth distribution by goal category (Growth → Protection → Security → Liquidity).
- **Macro Allocation** — aggregate exposure (Stocks, Bonds, Cash…) vs your configured targets.
- **Per-portfolio breakdowns** with cost / value / return.

### Performance

Historical net-worth and price charts, powered by the **daily price history** the app accumulates (see *Settings → Price History*).

![Performance — net worth](screenshots/performance_page.png)

- **Scope selector** — chart your whole **Net Worth**, a single **portfolio**, or a single **asset**.
- **Ranges** — 1M / 6M / 1Y / MAX.
- **Net worth** can optionally overlay today's liquidity as a constant line.
- **Return toggle** — switch between **TWR** (Time-Weighted Return, strips out deposits/withdrawals) and **MWR** (Money-Weighted Return, which on MAX matches the Dashboard's Total Appreciation).
- **Caveat badges** flag where history isn't directly comparable — e.g. bonds held at *corso secco* (clean price, no accrued interest), monthly-NAV sources, or assets with no history yet.

Per-asset view, here a long-duration govt bond priced at *corso secco*:

![Performance — single asset](screenshots/performance_asset.png)

### Transactions

The full history of buys, sells, dividends and coupons, with a quick-add form.

![Transactions list](screenshots/transactions_page.png)

- **Add Transaction** (left) — ticker, direction (Buy / Sell / Dividend / Coupon), quantity, price, date, portfolio, broker, and a *free commission* flag.
- **History** (right) — sortable table, **Group by Portfolio or Broker**; each group header shows running totals and **total fees** (toggleable between EUR and %).
- **Inline & modal editing** for quick fixes vs full entry.
- **Update Prices** triggers the live multi-source price refresh (see below).

**Bulk Edit** — select multiple rows to change broker / portfolio / fees together; unchanged fields keep a "keep original" label so you know exactly what will change.

![Bulk edit toolbar](screenshots/transactions_bulk_edit.png)

**Excel Import** — import an `.xlsx` history from your broker; the importer recognises a `Broker` column and maps it onto each transaction.

![Import modal](screenshots/transactions_import_modal.png)

### Portfolios

Organise investments into distinct portfolios (e.g. *Main Strategy*, *Bond Allocation*, *Safety Net*), including nested parent/child portfolios.

![Portfolios](screenshots/portfolios_page.png)

Each portfolio has its own **target allocation**, edited from the *Manage allocations* dialog. Targets must total 100%.

![Portfolio allocations](screenshots/portfolio_targets.png)

**Allocation (Market) Groups** — several interchangeable tickers can share a **single target %**. In the demo, *World Equity* holds one target of 70% over SWDA + VWRL:

![Allocation group](screenshots/portfolio_allocation_group.png)

- **Member priority** — the order decides which member is bought first / sold last.
- **Per-member rules** — flag a member *no-buy* (held but never topped up) or *no-sell* (never trimmed, e.g. to avoid realising a gain). The rebalancer respects these when splitting the group's target across its members.

### Asset Allocation (Global Rebalancing)

A top-down split of **total wealth** across portfolios — the complement to the per-portfolio drift on the Dashboard.

![Global rebalancing — targets](screenshots/global_rebalancing_top.png)
![Global rebalancing — deltas](screenshots/global_rebalancing_middle.png)
![Global rebalancing — actions](screenshots/global_rebalancing_bottom.png)

Each portfolio's target can be:

- **Fixed EUR** — an absolute amount.
- **% of total** — a percentage of the eligible wealth.
- **Locked** — counts toward the total but never moves.
- **Excluded** — ignored entirely.
- **Ratio Group** — shares a remainder pool with other portfolios, split by relative weights.

There is a dedicated **Liquidity Target** (broker cash) row, a **sustainability indicator**, and per-portfolio delta vs current value with suggested buy/sell actions.

### Goals

Define ordered goals — Growth, Protection, Security, Liquidity… — and attach portfolios to them. Goals drive the pyramid visualisations on the Stats and Dashboard pages.

![Goals](screenshots/goals_page.png)
![New goal](screenshots/goal_form_modal.png)

### Brokers

Manage brokers, their commission model and their cash positions.

![Brokers](screenshots/brokers_page.png)

- **Commission models** — fixed, or percentage with min/max.
- **Liquidity tracking** — available cash per broker, with an optional **minimum threshold** the forecast and rebalancer respect.
- **Liquidity allocations** — earmark part of a broker's cash to specific portfolios.

### Forecast

Project net worth and liquidity over a configurable horizon.

![Forecast — sustainable](screenshots/forecast_ok.png)

- **Inputs** — time horizon, monthly income/expenses, an annual-rebalance toggle, and **planned annual expenses** with their source goals and an *allow erosion of liquidity* control.
- **Per-portfolio expected return** (annualised), derived from each portfolio's realised performance.
- **Verdict** updates live: **Sustainable**, **Risky** (expenses covered but a liquidity threshold is breached) or **Failed** (insolvency before the horizon ends).

**Monte Carlo (Volatility)** turns the single deterministic line into a distribution: it samples monthly returns from each portfolio's volatility (lognormal, uncorrelated) over hundreds of simulations, draws **10–90 and 25–75 percentile bands** plus the median, and reports a **probability of success**. Volatility is estimated from each portfolio's asset mix and downloaded/realised data, and can be overridden per portfolio.

![Forecast — Monte Carlo](screenshots/forecast_montecarlo.png)

Risky and failed plans:

![Forecast — risky](screenshots/forecast_riskyplan.png)
![Forecast — failed](screenshots/forecast_failed.png)

### YNAB

Pull your [YNAB](https://www.youneedabudget.com/) budget category balances and map each one to an investment asset or to broker cash.

![YNAB import](screenshots/ynab_import.png)

- **Current** vs **average N-month budgeted** columns (configurable window).
- Per-category mapping to an asset or broker cash; search / filter; summary by mapped asset; *Sync now*.
- Credentials and mappings stay on the device.

### YNAB Goals

Sync a chosen "Investment Goals" YNAB category group and fund each goal from one or more portfolios.

![YNAB goals](screenshots/ynab_goals.png)

- Each goal card shows the YNAB **target**, **target date**, **cash coverage** and **total covered** (cash + earmarked investments).
- **Allocations** link portfolios to a goal with an amount; **suggested monthly funding** is compared against YNAB's own monthly funding, with warnings when they drift apart.

### Settings

The control room for data, sync, price refresh and integrations.

![Settings — premium & encryption](screenshots/settings_premium.png)

- **Premium Update Price** — paste a Premium key to unlock unlimited real-time price updates; without it, *Update Price* uses the throttled, cached free tier. The key is stored only in this browser and is never uploaded with the Azure backup.
- **Local data encryption** — optional second-layer AES encryption for everything stored in this browser (transactions, portfolios, YNAB key, Azure passphrase…). When enabled, the app asks for your passphrase on every load. **If you forget it and have no Azure backup, the data is unrecoverable.**

![Settings — price history](screenshots/settings_price_history.png)

- **Data Management** — JSON backup / restore of all local data (plaintext).
- **Price History** — a *separate* backup for the daily price-history series; **Update History** backfills each asset from its first purchase date.
- **Cloud Sync (Azure)** — optional encrypted Blob sync: data is encrypted with AES-256-GCM in the browser before upload, so Azure only ever stores an opaque blob.

![Settings — definitions & developer tools](screenshots/settings_bottom.png)

- **YNAB** — personal access token, budget selection and the "Investment Goals" category group.
- **Asset Registry & Settings** — asset classes/subclasses, custom labels, macro and goal targets.
- **Developer Tools** — *Load Mock Data* (full feature coverage) and the *Danger Zone* clear-all.

![Load Mock Data confirm](screenshots/settings_mock_confirm.png)

### Live Price Updates

Real-time feedback during the multi-source refresh, over WebSockets.

![Updating prices](screenshots/updating_prices.png)

- Per-ISIN progress with success / error states; one failing asset never aborts the batch.
- Where the source exposes it, the result also shows **bid/ask spread %** and **volatility %**; free-tier results are flagged *cached · may be delayed*.

### Disclaimer

A dedicated page documenting local-only storage, data usage and the non-commercial nature of the tool.

![Disclaimer](screenshots/disclaimer_page.png)

---

## Privacy Policy

This reflects how the app actually handles data today.

- **What is stored, and where.** All portfolio data — transactions (including broker details and fees), portfolios and allocation groups, targets, market data, daily price history, goals, broker liquidity, and YNAB configuration/mappings — is stored **only in your browser's `localStorage`** (keys such as `portfolio_transactions`, `portfolio_targets_v2`, `portfolio_market_data`, `portfolio_price_history`, `portfolio_goals`, `portfolio_ynab_*`). None of it is sent to our server or to third parties as part of normal use.

- **Optional local encryption.** You may enable second-layer AES encryption so that everything above is encrypted at rest in the browser, gated by a passphrase requested on every load. The passphrase is never transmitted; if lost, encrypted local data cannot be recovered without an Azure backup.

- **Optional cloud sync (Azure).** If you enable Azure Blob sync, the data is encrypted with **AES-256-GCM in the browser** using a passphrase you choose, and only the resulting **opaque ciphertext blob** is uploaded to your own Azure container via a SAS URL. The passphrase is never sent to Azure. **YNAB credentials and the Premium price key are intentionally excluded from the Azure payload**; price history is backed up separately.

- **Data sent to price sources.** Price lookups send **only the ISIN and the chosen source** to the `/api/price` endpoint, which fetches the quote from the relevant public page (JustETF, Borsa Italiana/MOT, CPRAM). No personal identifiers, balances or portfolio data are transmitted. On the free tier, responses may be served from a short-lived server-side cache.

- **Data sent to YNAB.** YNAB calls go **directly from your browser to YNAB** using your personal access token. The token is stored locally and is never synced to Azure.

- **Cookies.** The app sets no cookies for its own functionality. Server-side scraping only dismisses third-party cookie banners (e.g. Borsa Italiana) while fetching prices; it does not create cookies for you.

- **Your device, your responsibility.** Because the data lives in your browser, its safety depends on your device and browser security (login, screen lock, user profiles, disk encryption). Enabling local encryption adds a layer, but device hygiene still matters.

- **Removing your data.** Use **Settings → Danger Zone → Clear all data**, or clear the browser's site data / `localStorage`. Private/incognito sessions discard everything on close.

---

## A note on how this was built

This project was developed with the help of agentic AI tools — **Antigravity**, **Codex** and **Claude Code** — used for implementation, refactoring, scraper development, testing, screenshotting and documentation.

**The product design, the feature decisions and the technical direction were entirely human.** The AI executed against goals, constraints and architectural choices defined by a person; it did not decide what to build or where the project should go.
