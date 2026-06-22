const MONITORS = {
    IT: 'https://www.simpletoolsforinvestors.eu/monitor_info.php?monitor=btp&yieldtype=G&timescale=DUR',
    EU: 'https://www.simpletoolsforinvestors.eu/monitor_info.php?monitor=altri_europa&yieldtype=G&timescale=DUR',
};

const bondProposalCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function getCacheKey(universe) {
    return `bonds_${universe}`;
}

async function scrapeBondMonitor(page, universe) {
    const cached = bondProposalCache.get(getCacheKey(universe));
    if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
        console.log(`[BondMonitor] cache hit for ${universe}`);
        return cached.data;
    }

    const url = MONITORS[universe];
    if (!url) throw new Error(`Unknown bond universe: ${universe}`);

    console.log(`[BondMonitor] scraping ${universe} from ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Accept cookies if prompted
    try {
        const cookieSelectors = [
            '#ccc-recommended-settings',
            '#cookiewall-container button',
            '#onetrust-accept-btn-handler',
            '.qc-cmp2-summary-buttons button:last-child',
            'button[id*="cookie"]',
            'button[class*="cookie"]',
        ];
        for (const sel of cookieSelectors) {
            if (await page.$(sel)) {
                await page.click(sel);
                await new Promise(r => setTimeout(r, 1000));
                break;
            }
        }
    } catch (e) { /* ignore */ }

    // Wait for the table to render
    await new Promise(r => setTimeout(r, 3000));

    const bonds = await page.evaluate((uni) => {
        const results = [];

        // Strategy 1: Look for HTML table rows with bond data
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
            const rows = table.querySelectorAll('tr');
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length < 3) continue;

                const text = row.textContent || '';
                // Look for ISIN pattern (2 letters + 10 alphanumeric)
                const isinMatch = text.match(/\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/);
                // Look for date pattern (DD/MM/YYYY or YYYY-MM-DD)
                const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
                const isoDateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
                // Look for yield (percentage)
                const yieldMatch = text.match(/(\d+[.,]\d+)\s*%/);

                if (isinMatch) {
                    let maturityDate = null;
                    if (isoDateMatch) {
                        maturityDate = isoDateMatch[1];
                    } else if (dateMatch) {
                        const parts = dateMatch[1].split('/');
                        maturityDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
                    }

                    // Try to extract name from cells
                    let name = '';
                    for (const cell of cells) {
                        const t = (cell.textContent || '').trim();
                        if (t.length > 5 && !t.match(/^\d/) && t !== isinMatch[1]) {
                            name = t;
                            break;
                        }
                    }

                    const yieldVal = yieldMatch
                        ? parseFloat(yieldMatch[1].replace(',', '.'))
                        : null;

                    results.push({
                        isin: isinMatch[1],
                        name: name || isinMatch[1],
                        maturityDate,
                        yield: yieldVal,
                        currency: 'EUR',
                        universe: uni,
                    });
                }
            }
        }

        // Strategy 2: Look for the chart/data JS objects the page builds
        if (results.length === 0) {
            try {
                for (const script of document.scripts) {
                    const txt = script.textContent || '';
                    // simpletoolsforinvestors stores bond data in JS arrays
                    const isinMatches = txt.matchAll(/["']([A-Z]{2}[A-Z0-9]{9}[0-9])["']/g);
                    for (const m of isinMatches) {
                        if (!results.find(r => r.isin === m[1])) {
                            results.push({
                                isin: m[1],
                                name: m[1],
                                maturityDate: null,
                                yield: null,
                                currency: 'EUR',
                                universe: uni,
                            });
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }

        // Strategy 3: Look for SVG chart tooltips or data attributes
        if (results.length === 0) {
            const elements = document.querySelectorAll('[data-isin], [title*="IT00"], [title*="DE00"], [title*="FR00"]');
            elements.forEach(el => {
                const isin = el.getAttribute('data-isin') || '';
                const title = el.getAttribute('title') || '';
                const isinVal = isin || (title.match(/([A-Z]{2}[A-Z0-9]{9}[0-9])/) || [])[1];
                if (isinVal && !results.find(r => r.isin === isinVal)) {
                    results.push({
                        isin: isinVal,
                        name: title || isinVal,
                        maturityDate: null,
                        yield: null,
                        currency: 'EUR',
                        universe: uni,
                    });
                }
            });
        }

        return results;
    }, universe);

    // Deduplicate
    const seen = new Set();
    const unique = bonds.filter(b => {
        if (seen.has(b.isin)) return false;
        seen.add(b.isin);
        return true;
    });

    bondProposalCache.set(getCacheKey(universe), { data: unique, time: Date.now() });
    console.log(`[BondMonitor] found ${unique.length} bonds for ${universe}`);
    return unique;
}

function filterByMaturityWindow(bonds, targetDate, minMonthsBefore, maxMonthsBefore) {
    const target = new Date(targetDate);
    const latestMaturity = new Date(target);
    latestMaturity.setMonth(latestMaturity.getMonth() - minMonthsBefore);
    const earliestMaturity = new Date(target);
    earliestMaturity.setMonth(earliestMaturity.getMonth() - maxMonthsBefore);

    return bonds
        .filter(b => {
            if (!b.maturityDate) return false;
            const mat = new Date(b.maturityDate);
            return mat >= earliestMaturity && mat <= latestMaturity;
        })
        .sort((a, b) => {
            // Sort by yield descending, tie-break by closest to target
            if (a.yield != null && b.yield != null && a.yield !== b.yield) {
                return b.yield - a.yield;
            }
            const aDist = Math.abs(new Date(a.maturityDate).getTime() - target.getTime());
            const bDist = Math.abs(new Date(b.maturityDate).getTime() - target.getTime());
            return aDist - bDist;
        });
}

export { scrapeBondMonitor, filterByMaturityWindow, bondProposalCache };
