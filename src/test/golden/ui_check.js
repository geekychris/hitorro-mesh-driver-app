// usage: node ui_check.js <baseUrl> <out.json> [screenshotDir]
const { chromium } = require('playwright');
(async () => {
  const [base, out, shots] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const ev = { console: [], pageerrors: [], failed: [], http: [] };
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) ev.console.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', e => ev.pageerrors.push(String(e).slice(0, 300)));
  page.on('requestfailed', r => ev.failed.push(r.method() + ' ' + r.url().replace(base, '') + ' ' + (r.failure() || {}).errorText));
  page.on('response', r => { if (r.status() >= 400) ev.http.push(r.status() + ' ' + r.request().method() + ' ' + r.url().replace(base, '')); });
  await page.goto(base + '/ui/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const tabs = await page.$$eval('button[role=tab]', bs => bs.map(b => b.dataset.target));
  const visited = [];
  for (const t of tabs) {
    await page.click(`button[role=tab][data-target="${t}"]`);
    await page.waitForTimeout(1200);
    visited.push(t);
    if (shots) await page.screenshot({ path: `${shots}/${t}.png` });
  }
  const health = await page.textContent('#health-text').catch(() => null);
  require('fs').writeFileSync(out, JSON.stringify({ tabs: visited, health, ...ev }, null, 2));
  await browser.close();
})();
