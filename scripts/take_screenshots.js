/* eslint-disable */
// Walks every page of the running app on http://localhost:3002 and writes
// screenshots to ./screenshots/. Assumes the server is already running.
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots');
const URL = 'http://localhost:3002';
const VIEW = { width: 1440, height: 900 };

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log('  ->', path.relative(ROOT, file));
}

async function fullShot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('  ->', path.relative(ROOT, file));
}

async function navTo(page, label) {
  await page.evaluate((label) => {
    const link = [...document.querySelectorAll('.nav-link')].find(
      (a) => a.textContent.trim() === label
    );
    if (link) link.click();
  }, label);
  await sleep(900);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
}

async function loadMock(page) {
  await navTo(page, 'Settings');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Load Mock Data')
    );
    if (btn) {
      btn.scrollIntoView();
      btn.click();
    }
  });
  await sleep(600);
  await page.evaluate(() => {
    const ok = document.querySelector('.swal2-confirm');
    if (ok) ok.click();
  });
  await sleep(800);
  await page.evaluate(() => {
    const ok = document.querySelector('.swal2-confirm');
    if (ok) ok.click();
  });
  await sleep(800);
}

async function scrollAndShoot(page, base) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await shot(page, `${base}_top`);
  const max = await page.evaluate(() => document.documentElement.scrollHeight);
  const vh = VIEW.height;
  if (max > vh * 1.4) {
    await page.evaluate((y) => window.scrollTo(0, y), Math.floor((max - vh) / 2));
    await sleep(400);
    await shot(page, `${base}_middle`);
    await page.evaluate((y) => window.scrollTo(0, y), max);
    await sleep(400);
    await shot(page, `${base}_bottom`);
  }
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', defaultViewport: VIEW });
  const page = await browser.newPage();
  await page.setViewport(VIEW);

  console.log('Loading app…');
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await sleep(800);

  console.log('Loading mock data…');
  await loadMock(page);

  // ---------- DASHBOARD ----------
  console.log('Dashboard');
  await navTo(page, 'Dashboard');
  await sleep(800);
  await scrollAndShoot(page, 'dashboard');

  // Withdrawal simulation: find a button or section labeled accordingly
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(400);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('h2,h3,h4')].find((h) =>
      /withdrawal/i.test(h.textContent)
    );
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await sleep(400);
  await shot(page, 'dashboard_withdrawal_simulation');

  // ---------- STATS ----------
  console.log('Stats');
  await navTo(page, 'Stats');
  await sleep(700);
  await scrollAndShoot(page, 'stats');
  // Try to switch tabs/sections if present (Allocations / Macro / Total)
  const statsTabs = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map((b) => b.textContent.trim())
      .filter((t) => /allocation|macro|portfolio|total/i.test(t))
  );
  console.log('  stats tabs found:', statsTabs);
  for (const label of ['Allocations', 'Macro', 'Total Portfolios']) {
    const clicked = await page.evaluate((label) => {
      const btn = [...document.querySelectorAll('button,a')].find(
        (b) => b.textContent.trim().toLowerCase() === label.toLowerCase()
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    }, label);
    if (clicked) {
      await sleep(600);
      const slug = label.toLowerCase().replace(/\s+/g, '_');
      await shot(page, `stats_${slug}`);
    }
  }

  // ---------- PERFORMANCE ----------
  console.log('Performance');
  await navTo(page, 'Performance');
  await sleep(1200);
  await shot(page, 'performance_page');
  // Switch the scope selector to a single asset to show the per-asset price series + caveat badges
  const assetScoped = await page.evaluate(() => {
    const sel = document.querySelector('select');
    if (!sel) return false;
    const opt = [...sel.options].find((o) => o.value.startsWith('a:'));
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  if (assetScoped) {
    await sleep(900);
    await shot(page, 'performance_asset');
  }

  // ---------- TRANSACTIONS ----------
  console.log('Transactions');
  await navTo(page, 'Transactions');
  await sleep(700);
  await shot(page, 'transactions_page');
  // Open Import modal
  const importClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /import/i.test(b.textContent)
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (importClicked) {
    await sleep(600);
    await shot(page, 'transactions_import_modal');
    await page.keyboard.press('Escape');
    await sleep(300);
    // Close any lingering modal
    await page.evaluate(() => {
      const x = document.querySelector('.modal-close, .close-btn, button[aria-label="Close"]');
      if (x) x.click();
    });
    await sleep(300);
  }
  // Try inline edit: click first row's edit pencil if any
  const edited = await page.evaluate(() => {
    const btn = document.querySelector('button[title*="Edit" i], button[aria-label*="Edit" i]');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (edited) {
    await sleep(500);
    await shot(page, 'transaction_edit_inline');
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  // Bulk edit toolbar — check first row checkbox
  const bulk = await page.evaluate(() => {
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb) {
      cb.click();
      return true;
    }
    return false;
  });
  if (bulk) {
    await sleep(400);
    await shot(page, 'transactions_bulk_edit');
    await page.evaluate(() => {
      const cb = document.querySelector('input[type="checkbox"]');
      if (cb && cb.checked) cb.click();
    });
    await sleep(200);
  }

  // ---------- PORTFOLIOS ----------
  console.log('Portfolios');
  await navTo(page, 'Portfolios');
  await sleep(700);
  await shot(page, 'portfolios_page');
  // Open the first portfolio's allocation editor (Main Strategy → has the
  // "World Equity" market group) via the "Manage allocations" button.
  const targets = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Manage allocations"], button[title="Allocations"]');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (targets) {
    await sleep(700);
    await shot(page, 'portfolio_targets');
    // Expand the World Equity allocation group to reveal members, priority and rules
    const expanded = await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find(
        (e) => e.children.length === 0 && /world equity/i.test(e.textContent || '')
      );
      if (el) { el.click(); return true; }
      return false;
    });
    if (expanded) {
      await sleep(500);
      await shot(page, 'portfolio_allocation_group');
    }
    await page.keyboard.press('Escape');
    await sleep(300);
  }

  // ---------- ASSET ALLOCATION (Global Rebalancing) ----------
  console.log('Asset Allocation / Global Rebalancing');
  await navTo(page, 'Asset Allocation');
  await sleep(800);
  await scrollAndShoot(page, 'global_rebalancing');

  // ---------- GOALS ----------
  console.log('Goals');
  await navTo(page, 'Goals');
  await sleep(800);
  await shot(page, 'goals_page');
  const newGoal = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /new goal|add goal|create goal|\+ goal/i.test(b.textContent)
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (newGoal) {
    await sleep(600);
    await shot(page, 'goal_form_modal');
    await page.keyboard.press('Escape');
    await sleep(300);
  }

  // ---------- BROKERS ----------
  console.log('Brokers');
  await navTo(page, 'Brokers');
  await sleep(700);
  await shot(page, 'brokers_page');

  // ---------- FORECAST ----------
  console.log('Forecast');
  await navTo(page, 'Forecast');
  await sleep(800);
  await shot(page, 'forecast_ok');
  // Monte Carlo (volatility) simulation toggle
  const mcOn = await page.evaluate(() => {
    const label = [...document.querySelectorAll('label')].find((l) => /monte carlo/i.test(l.textContent));
    const cb = label?.parentElement?.querySelector('input[type="checkbox"]');
    if (cb) { cb.click(); return true; }
    return false;
  });
  if (mcOn) {
    await sleep(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    await shot(page, 'forecast_montecarlo');
    // turn it back off so the risky/failed shots below use the deterministic plan
    await page.evaluate(() => {
      const label = [...document.querySelectorAll('label')].find((l) => /monte carlo/i.test(l.textContent));
      const cb = label?.parentElement?.querySelector('input[type="checkbox"]');
      if (cb) cb.click();
    });
    await sleep(500);
  }
  // Try to push the plan into risky/failed by inflating annual expense
  const expenseInputs = await page.$$('input[type="number"]');
  if (expenseInputs.length) {
    // Find an "expense" labeled input
    const idx = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[type="number"]')];
      const i = inputs.findIndex((inp) => {
        const label = inp.closest('label')?.textContent || inp.previousElementSibling?.textContent || '';
        return /expense|spese|withdraw|annual/i.test(label);
      });
      return i;
    });
    if (idx >= 0) {
      await expenseInputs[idx].click({ clickCount: 3 });
      await expenseInputs[idx].type('50000');
      await sleep(600);
      await shot(page, 'forecast_riskyplan');
      await expenseInputs[idx].click({ clickCount: 3 });
      await expenseInputs[idx].type('500000');
      await sleep(600);
      await shot(page, 'forecast_failed');
      // restore
      await expenseInputs[idx].click({ clickCount: 3 });
      await expenseInputs[idx].type('15000');
      await sleep(400);
    }
  }

  // ---------- YNAB ----------
  console.log('YNAB');
  await navTo(page, 'YNAB');
  await sleep(700);
  await shot(page, 'ynab_import');

  // ---------- YNAB GOALS ----------
  console.log('YNAB Goals');
  await navTo(page, 'YNAB Goals');
  await sleep(800);
  await shot(page, 'ynab_goals');

  // ---------- SETTINGS ----------
  console.log('Settings');
  await navTo(page, 'Settings');
  await sleep(700);
  await scrollAndShoot(page, 'settings');
  // Premium Update Price card (free tier vs unlocked)
  const premiumFound = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((e) => /premium update price/i.test(e.textContent));
    if (h) { h.scrollIntoView({ block: 'center' }); return true; }
    return false;
  });
  if (premiumFound) {
    await sleep(400);
    await shot(page, 'settings_premium');
  }
  // Price History backup / Update History section
  const historyFound = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((e) => /price history/i.test(e.textContent));
    if (h) { h.scrollIntoView({ block: 'center' }); return true; }
    return false;
  });
  if (historyFound) {
    await sleep(400);
    await shot(page, 'settings_price_history');
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await sleep(300);
  // Mock-data confirm popup
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Load Mock Data')
    );
    if (btn) {
      btn.scrollIntoView();
      btn.click();
    }
  });
  await sleep(600);
  await shot(page, 'settings_mock_confirm');
  await page.evaluate(() => {
    const cancel = document.querySelector('.swal2-cancel');
    if (cancel) cancel.click();
  });
  await sleep(400);

  // ---------- DISCLAIMER ----------
  console.log('Disclaimer');
  await navTo(page, 'Disclaimer');
  await sleep(700);
  await shot(page, 'disclaimer_page');

  // ---------- PRICE UPDATE MODAL ----------
  console.log('Price Update');
  await navTo(page, 'Dashboard');
  await sleep(700);
  const priceClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /update.*price|refresh.*price/i.test(b.textContent)
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (priceClicked) {
    await sleep(1200);
    await shot(page, 'updating_prices');
  }

  await browser.close();
  console.log('Done.');
})();
