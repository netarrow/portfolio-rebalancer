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
const URL = process.env.APP_URL || 'http://localhost:3002';
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

// Navbar entries carry an emoji prefix, and most views live inside a dropdown
// group (Portfolio / Analysis / Planning) that has to be opened first — so
// match on the emoji-stripped label and fall back to walking the groups.
/**
 * Fills a React-controlled field matched by the text of its <label>, so the
 * screenshots show forms in use rather than empty. Scoped to the topmost open
 * modal when there is one. `labelSource` is a case-insensitive regex source.
 */
async function fillField(page, labelSource, value) {
  const ok = await page.evaluate(
    (labelSource, value) => {
      const re = new RegExp(labelSource, 'i');
      const root = [...document.querySelectorAll('.modal-overlay')].pop() || document;
      const label = [...root.querySelectorAll('label')].find((l) => re.test(l.textContent || ''));
      if (!label) return false;
      const field =
        label.querySelector('input, select, textarea') ||
        label.parentElement?.querySelector('input, select, textarea');
      if (!field) return false;
      const proto =
        field instanceof HTMLSelectElement
          ? HTMLSelectElement
          : field instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement
            : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    labelSource,
    value
  );
  if (!ok) console.warn(`  !! field not found: ${labelSource}`);
  await sleep(200);
  return ok;
}

async function navTo(page, label) {
  let clicked = await page.evaluate((label) => {
    const norm = (s) => (s || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().toLowerCase();
    const link = [...document.querySelectorAll('.nav-link')].find(
      (a) => norm(a.textContent) === norm(label)
    );
    if (link) { link.click(); return true; }
    return false;
  }, label);
  if (!clicked) {
    const groupCount = await page.evaluate(
      () => document.querySelectorAll('.nav-group-toggle').length
    );
    for (let i = 0; i < groupCount && !clicked; i++) {
      await page.evaluate((i) => document.querySelectorAll('.nav-group-toggle')[i]?.click(), i);
      await sleep(250);
      clicked = await page.evaluate((label) => {
        const norm = (s) => (s || '').replace(/[^\p{L}\p{N} ]/gu, '').trim().toLowerCase();
        const sub = [...document.querySelectorAll('.nav-sublink')].find(
          (b) => norm(b.textContent) === norm(label)
        );
        if (sub) { sub.click(); return true; }
        return false;
      }, label);
      // Navigating closes the dropdown itself; otherwise close it by hand
      // so it does not float over the next screenshot.
      if (!clicked) {
        await page.evaluate((i) => document.querySelectorAll('.nav-group-toggle')[i]?.click(), i);
        await sleep(150);
      }
    }
  }
  if (!clicked) console.warn(`  !! nav entry not found: ${label}`);
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

  // Withdrawal simulation: open the "Simulate Withdrawal" popup
  const withdrawalClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /simulate withdrawal/i.test(b.textContent)
    );
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }
    return false;
  });
  if (withdrawalClicked) {
    await sleep(600);
    // Enter an amount and run the simulation, so the shot shows the resulting
    // sell plan (gross vs net, tax and commissions) rather than an empty form.
    await fillField(page, 'net cash needed', '10000');
    await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('.modal-overlay')].pop();
      const btn = [...(overlay?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent.trim() === 'Calculate'
      );
      if (btn) btn.click();
    });
    await sleep(700);
    await shot(page, 'dashboard_withdrawal_simulation');
    // The withdrawal modal does not close on Escape — click its × button.
    await page.evaluate(() => {
      const overlay = document.querySelector('.modal-overlay') || document.body;
      const x = [...overlay.querySelectorAll('button')].find((b) =>
        /^[×✕☒x]$/i.test(b.textContent.trim())
      );
      if (x) x.click();
      else document.querySelector('.modal-close-btn, .modal-close, .close-btn')?.click();
    });
    await sleep(400);
  }

  // Trade-cost popover: click an Action / Buy Only cell (TradeCostInfo span)
  // in the first rebalancing table to reveal spread + commission estimates.
  const tradeCostClicked = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('span[style*="help"]')];
    const target = spans.find((s) => s.getBoundingClientRect().width > 0);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      return true;
    }
    return false;
  });
  if (tradeCostClicked) {
    await sleep(400);
    await page.evaluate(() => {
      const spans = [...document.querySelectorAll('span[style*="help"]')];
      const target = spans.find((s) => {
        const r = s.getBoundingClientRect();
        return r.width > 0 && r.top > 100 && r.top < 700;
      });
      if (target) target.click();
    });
    await sleep(600);
    await shot(page, 'dashboard_trade_cost_popover');
    // The popover is a click-toggle: re-click the same span to close it.
    await page.evaluate(() => {
      const spans = [...document.querySelectorAll('span[style*="help"]')];
      const target = spans.find((s) => {
        const r = s.getBoundingClientRect();
        return r.width > 0 && r.top > 100 && r.top < 700;
      });
      if (target) target.click();
    });
    await sleep(400);
  }

  // Concretize a virtual bond: the "Concretizza" button on the placeholder's
  // row opens the proposal modal with real bonds matching the maturity window.
  const concretizeClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Concretizza'
    );
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }
    return false;
  });
  if (concretizeClicked) {
    // Wait for the bond proposals to load (server-side scrape, up to ~20 s)
    for (let i = 0; i < 20; i++) {
      const loaded = await page.evaluate(() => {
        const overlay = [...document.querySelectorAll('.modal-overlay')].pop();
        return overlay ? overlay.querySelectorAll('tbody tr').length > 0 : false;
      });
      if (loaded) break;
      await sleep(1000);
    }
    // Select the top proposal (fills ISIN + label), then fill quantity/price
    await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('.modal-overlay')].pop();
      const row = overlay?.querySelector('tbody tr');
      if (row) row.click();
    });
    await sleep(300);
    const numInputs = await page.$$('.modal-overlay input[type="number"]');
    if (numInputs.length >= 2) {
      await numInputs[0].type('3000');
      await numInputs[1].type('0.95');
    }
    // Destination of the concretized bond — the same broker/portfolio the
    // placeholder was parked on.
    await fillField(page, '^broker$', 'b2');
    await fillField(page, '^portfolio$', 'mock-p-safe');
    await sleep(300);
    await shot(page, 'dashboard_concretize_modal');
    await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('.modal-overlay')].pop();
      const x = [...(overlay?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent.trim() === '×'
      );
      if (x) x.click();
    });
    await sleep(400);
  }

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
    // back to Net Worth scope for the risk-metrics shot
    await page.evaluate(() => {
      const sel = document.querySelector('select');
      if (sel) {
        sel.value = sel.options[0].value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await sleep(900);
  }
  // Risk metrics row (ann. return / volatility / Sharpe / max drawdown)
  const riskFound = await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && /sharpe/i.test(e.textContent || '')
    );
    if (el) {
      el.scrollIntoView({ block: 'center' });
      return true;
    }
    return false;
  });
  if (riskFound) {
    await sleep(500);
    await shot(page, 'performance_risk_metrics');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
  }

  // ---------- SUMMARY ANALYSIS ----------
  console.log('Summary');
  await navTo(page, 'Summary');
  await sleep(1000);
  await scrollAndShoot(page, 'summary_analysis');
  // Expand the macro-class mapping editor (collapsed behind "Configure")
  const mappingOpened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Configure'
    );
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (mappingOpened) {
    await sleep(500);
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('h3')].find((e) =>
        /macro category mapping/i.test(e.textContent)
      );
      if (h) h.scrollIntoView({ block: 'start' });
    });
    await sleep(400);
    await shot(page, 'summary_macro_mapping');
  }

  // ---------- TRANSACTIONS ----------
  console.log('Transactions');
  await navTo(page, 'Transactions');
  await sleep(700);
  // Fill (never submit) the quick-add form so the shot shows it in use
  await fillField(page, 'ticker / symbol', 'IE00B4L5Y983');
  await fillField(page, '^quantity', '10');
  await fillField(page, 'price per unit', '95.50');
  await fillField(page, '^portfolio', 'mock-p-main');
  await fillField(page, '^broker', 'b3');
  await sleep(300);
  await shot(page, 'transactions_page');
  // Cycle the Group By button: None → Portfolio → Broker → Asset (Ticker)
  const groupShots = [
    ['transactions_group_by_portfolio', 'Portfolio'],
    ['transactions_group_by_broker', 'Broker'],
    ['transactions_group_by_asset', 'Ticker'],
  ];
  for (const [shotName] of groupShots) {
    const cycled = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /group by:/i.test(b.textContent)
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (!cycled) break;
    await sleep(600);
    await shot(page, shotName);
  }
  // back to ungrouped
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /group by:/i.test(b.textContent)
    );
    if (btn) btn.click();
  });
  await sleep(400);
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
    // Close the import modal via its close button (Escape alone does not dismiss it)
    await page.evaluate(() => {
      const x = document.querySelector('.modal-close-btn, .modal-close, .close-btn, button[aria-label="Close"]');
      if (x) x.click();
    });
    await sleep(400);
    // Safety net: if any modal overlay is still mounted, click its close button
    await page.evaluate(() => {
      const overlay = document.querySelector('.modal-overlay');
      if (overlay) {
        const x = overlay.querySelector('.modal-close-btn, .modal-close, .close-btn');
        if (x) x.click();
      }
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
  // Helper: expand an allocation group row (its ▸ button has title="Expand")
  // by matching the group label inside the row that owns the button.
  const expandGroup = (label) =>
    page.evaluate((label) => {
      const btns = [...document.querySelectorAll('button[title="Expand"]')];
      for (const b of btns) {
        let row = b;
        while (row.parentElement && row.parentElement.querySelectorAll('button[title="Expand"]').length === 1) {
          row = row.parentElement;
        }
        if (row.textContent && row.textContent.toLowerCase().includes(label.toLowerCase())) {
          b.click();
          return true;
        }
      }
      if (btns.length === 1) { btns[0].click(); return true; }
      return false;
    }, label);
  const targets = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Manage allocations"], button[title="Allocations"]');
    if (btn) { btn.click(); return true; }
    return false;
  });
  // The allocations modal does not close on Escape — click its "Done" button.
  const closeAllocationsModal = async () => {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Done'
      );
      if (btn) btn.click();
    });
    await sleep(400);
  };
  if (targets) {
    await sleep(700);
    await shot(page, 'portfolio_targets');
    // Expand the World Equity allocation group to reveal members, priority and rules
    const expanded = await expandGroup('world equity');
    if (expanded) {
      await sleep(500);
      await shot(page, 'portfolio_allocation_group');
    }
    await closeAllocationsModal();
  }

  // Helper: open "Manage allocations" for the card containing a given name.
  // For each button, find the widest ancestor still containing only THAT
  // button (= its portfolio card) and match the portfolio name there —
  // matching on any shared ancestor would always pick the first card.
  const openAllocationsFor = (name) =>
    page.evaluate((name) => {
      const sel = 'button[aria-label="Manage allocations"], button[title="Allocations"]';
      const btns = [...document.querySelectorAll(sel)];
      for (const b of btns) {
        let card = b;
        while (card.parentElement && card.parentElement.querySelectorAll(sel).length === 1) {
          card = card.parentElement;
        }
        if (card.textContent && card.textContent.includes(name)) {
          b.click();
          return true;
        }
      }
      return false;
    }, name);

  // Safety Net → allocations with the virtual-bond placeholder row
  if (await openAllocationsFor('Safety Net')) {
    await sleep(700);
    await shot(page, 'portfolio_virtual_bond');
    // Open the "+ Add Virtual Bond" form
    const vbFormOpened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /add virtual bond/i.test(b.textContent)
      );
      if (btn) {
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      }
      return false;
    });
    if (vbFormOpened) {
      await sleep(500);
      await fillField(page, '^label$', 'BTP ladder ~2035');
      await fillField(page, 'maturity date', '2035-03-01');
      await fillField(page, '^universe$', 'IT');
      await sleep(300);
      await shot(page, 'portfolio_virtual_bond_form');
    }
    await closeAllocationsModal();
  }

  // Tactical Tilt → weighted allocation group (intra-group weight %)
  if (await openAllocationsFor('Tactical Tilt')) {
    await sleep(700);
    const tiltExpanded = await expandGroup('em + dividend tilt');
    if (tiltExpanded) {
      await sleep(500);
      await shot(page, 'portfolio_group_weighted');
    }
    await closeAllocationsModal();
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
    await fillField(page, '^title', 'Education');
    await fillField(page, '^description', 'University fees, 15-year horizon');
    await fillField(page, '^order', '4');
    await sleep(300);
    await shot(page, 'goal_form_modal');
    await page.keyboard.press('Escape');
    await sleep(300);
  }

  // ---------- BROKERS ----------
  console.log('Brokers');
  await navTo(page, 'Brokers');
  await sleep(700);
  await shot(page, 'brokers_page');
  // Edit Broker modal — shows commission plan & minimum liquidity settings
  const brokerEditClicked = await page.evaluate(() => {
    const btn = document.querySelector('button[title*="Edit" i], button[aria-label*="Edit" i]');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (brokerEditClicked) {
    await sleep(500);
    await shot(page, 'brokers_edit_modal_commission');
    await page.keyboard.press('Escape');
    await sleep(300);
  }

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
  // Push the plan into risky/failed by inflating the monthly expense. The field
  // is disabled while the YNAB averages drive the cashflow, so untick those
  // first — otherwise the typing is a no-op and both shots stay "Sustainable".
  const averagesOff = await page.evaluate(() => {
    const label = [...document.querySelectorAll('label')].find((l) => /use these averages/i.test(l.textContent));
    const cb = label?.parentElement?.querySelector('input[type="checkbox"]');
    if (!cb) return false;
    if (cb.checked) cb.click();
    return true;
  });
  if (!averagesOff) console.warn('  !! "Use these averages" toggle not found');
  await sleep(600);
  const expenseInputs = await page.$$('input[type="number"]');
  if (expenseInputs.length) {
    const idx = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[type="number"]')];
      return inputs.findIndex((inp) =>
        /monthly expenses/i.test(inp.previousElementSibling?.textContent || '')
      );
    });
    if (idx >= 0) {
      // Tuned against the mock dataset: the fragile band is narrow, and past it
      // the plan goes straight to insolvency.
      await expenseInputs[idx].click({ clickCount: 3 });
      await expenseInputs[idx].type('6660');
      await sleep(800);
      await shot(page, 'forecast_riskyplan');
      await expenseInputs[idx].click({ clickCount: 3 });
      await expenseInputs[idx].type('9000');
      await sleep(800);
      await shot(page, 'forecast_failed');
      // restore: hand the cashflow back to the YNAB averages
      await page.evaluate(() => {
        const label = [...document.querySelectorAll('label')].find((l) => /use these averages/i.test(l.textContent));
        const cb = label?.parentElement?.querySelector('input[type="checkbox"]');
        if (cb && !cb.checked) cb.click();
      });
      await sleep(400);
    } else {
      console.warn('  !! Monthly Expenses input not found');
    }
  }

  // ---------- PAC ----------
  console.log('PAC');
  await navTo(page, 'PAC');
  await sleep(800);
  await shot(page, 'pac_plans');
  // Installments table (registered / skipped / due rows)
  const scheduleFound = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2')].find((e) => /installments/i.test(e.textContent));
    if (h) { h.scrollIntoView({ block: 'start' }); return true; }
    return false;
  });
  if (scheduleFound) {
    await sleep(400);
    await shot(page, 'pac_schedule');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
  }
  // New-plan form, filled in: assets are picked by their descriptive label,
  // and the live preview shows the resulting quantity / fee / residue.
  const pacFormOpened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /new plan/i.test(b.textContent));
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (pacFormOpened) {
    await sleep(500);
    await fillField(page, '^name$', 'Monthly world-equity accumulation');
    await fillField(page, '^asset$', 'IE00B4L5Y983');
    await fillField(page, 'amount per installment', '500');
    await fillField(page, '^rounding$', 'floor-carry');
    await sleep(500);
    // The filled form is taller than the standard viewport (the modal caps at
    // 90vh): grow the window for this one shot so the rounding rule and the
    // live installment preview are visible too.
    await page.setViewport({ width: VIEW.width, height: 1300 });
    await sleep(500);
    await shot(page, 'pac_plan_form');
    await page.setViewport(VIEW);
    await sleep(300);
    await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('.modal-overlay')].pop();
      const cancel = [...(overlay?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent.trim() === 'Cancel'
      );
      if (cancel) cancel.click();
    });
    await sleep(400);
  }
  // Confirm-installment modal on the first due row (price resolved from the
  // local history, with quantity / fee / parked residue preview).
  const pacConfirmOpened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.pac-schedule-table button')].find(
      (b) => b.textContent.trim() === 'Confirm'
    );
    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
    return false;
  });
  if (pacConfirmOpened) {
    await sleep(600);
    await shot(page, 'pac_confirm_modal');
    await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('.modal-overlay')].pop();
      const cancel = [...(overlay?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent.trim() === 'Cancel'
      );
      if (cancel) cancel.click();
    });
    await sleep(400);
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
  // Free Buy Promotions card + its "Add free ISIN list" popup
  const freeBuyFound = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2, h3')].find((e) =>
      /free buy promotions/i.test(e.textContent)
    );
    if (h) {
      h.scrollIntoView({ block: 'center' });
      return true;
    }
    return false;
  });
  if (freeBuyFound) {
    await sleep(400);
    await shot(page, 'settings_free_buy');
    const promoOpened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /add free isin list/i.test(b.textContent)
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (promoOpened) {
      await sleep(500);
      // Fill the free-text area with a sample promo list
      const ta = await page.$('textarea');
      if (ta) {
        await ta.type('Promo di luglio: IE00B4L5Y983 (SWDA), IE00B3RBWM25 (VWRL)');
        await sleep(300);
      }
      await shot(page, 'settings_free_buy_modal');
      // Close without saving
      await page.evaluate(() => {
        const h3 = [...document.querySelectorAll('h3')].find((e) =>
          /free buy isins/i.test(e.textContent)
        );
        const x = h3?.parentElement?.querySelector('button');
        if (x) x.click();
      });
      await sleep(400);
    }
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
  await navTo(page, 'Transactions');
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
    // Free tier: a "Limited free update" warning appears first — document it,
    // then confirm to reach the live per-ISIN progress modal.
    const freeTierWarning = await page.evaluate(() =>
      !!document.querySelector('.swal2-confirm')
    );
    if (freeTierWarning) {
      await shot(page, 'price_update_free_tier');
      await page.evaluate(() => document.querySelector('.swal2-confirm')?.click());
      await sleep(1800);
    }
    await shot(page, 'updating_prices');
    // Wait for the batch to finish and capture the completed state with the
    // free-tier "cached · may be delayed" flags + spread/volatility extras.
    for (let i = 0; i < 30; i++) {
      const done = await page.evaluate(() =>
        [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Close')
      );
      if (done) break;
      await sleep(1000);
    }
    await shot(page, 'updating_prices_done');
    await page.evaluate(() => {
      const close = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close');
      if (close) close.click();
    });
    await sleep(500);
    // Restore mock prices so later shots stay consistent with the demo dataset
    await loadMock(page);
  }

  // ---------- MOBILE (dense expandable rows) ----------
  console.log('Mobile');
  await page.setViewport({ width: 390, height: 844 });
  await navTo(page, 'Dashboard');
  await sleep(900);
  await shot(page, 'mobile_dashboard');
  await navTo(page, 'Transactions');
  await sleep(900);
  await shot(page, 'mobile_transactions');
  // Scroll down to the dense history list and expand the first row
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h2, h3')].find((e) =>
      /history/i.test(e.textContent)
    );
    if (h) h.scrollIntoView({ block: 'start' });
  });
  await sleep(500);
  await page.evaluate(() => {
    const row = document.querySelector('tbody tr, .tx-row, [class*="dense"]');
    if (row) row.click();
  });
  await sleep(500);
  await shot(page, 'mobile_transactions_expanded');

  await browser.close();
  console.log('Done.');
})();
