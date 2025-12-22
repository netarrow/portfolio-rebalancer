# Portfolio Rebalancer

This project is an **Agentic Development Experiment** created with **Antigravity** and **Gemini PRO**.

It was built in a **few hours** while multitasking, demonstrating the capabilities of agentic AI in handling end-to-end development, for a tool I actually needed for my own portfolio management.
Tasks included:
- Architecture refactoring (Unified Frontend/Backend)
- Complex feature implementation (Multi-source scraping, Inline editing)
- UI/UX layout and design optimization

## Project Overview

Portfolio Rebalancer is a React+Express application designed to help investors track and rebalance their portfolios efficiently.

### Key Features
- **Smart Rebalancing**: Calculates exactly how much to buy/sell to meet target allocations.
- **Multi-Source Price Scraping**:
    - **JustETF**: For standard ETFs.
    - **Borsa Italiana (MOT)**: Custom Puppeteer scraper for Italian BTPs/Bonds.
- **Asset Classification**: Hierarchical organization (Class -> Subclass) for better grouping.
- **Unified Architecture**: Single Express server handling both API requests and serving the Vite frontend.
- **Transactions Import**: Import transactions from Excel files (.xlsx).
- **Custom Labels**: Assign custom display names to assets (e.g. rename an ISIN to "S&P 500").
- **Asset Links**: Direct links to JustETF or Borsa Italiana MOT from the transaction history.

## Screenshots

### Dashboard
The central hub showing real-time asset allocation, total value, and actionable rebalancing recommendations.
![Dashboard](screenshots/dashboard.png)

### Transactions
A detailed history of all trades with inline editing capabilities and **Excel Import**.
![Transactions](screenshots/transactions.png)

### Settings
Configuration page to set target portfolio allocations, choose price sources for each asset, and **assign custom labels**.
![Settings](screenshots/settings.png)

## Tech Stack
- **Frontend**: React, TypeScript, Vite
- **Backend**: Node.js, Express
- **Scraping**: Puppeteer
- **Styles**: Vanilla CSS (Variables & Responsive Layout)

---
*Experiment conducted with Antigravity*
