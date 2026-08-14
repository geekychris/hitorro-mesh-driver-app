// Hitorro Mesh UI — vanilla JS. Talks only to the REST + SSE + Actuator
// endpoints on the same host. No build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));
const fmtJson = (o) => JSON.stringify(o, null, 2);
const short = (s, n = 60) => s && s.length > n ? s.slice(0, n) + '…' : (s || '');

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body?.message || res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ================================================================ SNIPPETS
const SNIPPETS = [
  { cat: 'Basic', name: 'All rows', desc: 'Simple SELECT',
    sql: `SELECT id, title, lang, size_kb FROM docs` },
  { cat: 'Basic', name: 'Filtered', desc: 'WHERE clause',
    sql: `SELECT id, title FROM docs WHERE lang = 'en'` },
  { cat: 'Basic', name: 'ORDER BY + LIMIT', desc: 'Top-N with N-way merge sort',
    sql: `SELECT id, size_kb FROM docs ORDER BY size_kb DESC LIMIT 5` },

  { cat: 'Aggregates', name: 'COUNT by group', desc: 'Basic GROUP BY',
    sql: `SELECT lang, COUNT(*) AS n FROM docs GROUP BY lang` },
  { cat: 'Aggregates', name: 'SUM + AVG', desc: 'AVG decomposes internally to SUM+COUNT',
    sql: `SELECT lang, COUNT(*) AS n, SUM(size_kb) AS total_kb, AVG(size_kb) AS avg_kb FROM docs GROUP BY lang` },
  { cat: 'Aggregates', name: 'HAVING', desc: 'Post-aggregate filter',
    sql: `SELECT lang, COUNT(*) AS n FROM docs GROUP BY lang HAVING n >= 1` },
  { cat: 'Aggregates', name: 'DISTINCT', desc: 'Auto-rewritten to GROUP BY',
    sql: `SELECT DISTINCT lang FROM docs` },
  { cat: 'Aggregates', name: 'Global aggregate', desc: 'Single-row result',
    sql: `SELECT COUNT(*) AS total, SUM(size_kb) AS all_kb FROM docs` },

  { cat: 'JOIN', name: 'Broadcast INNER', desc: 'Small dim replicated to every agent',
    sql: `SELECT d.id, l.name AS language FROM docs d JOIN langs l ON d.lang = l.code` },
  { cat: 'JOIN', name: 'Broadcast LEFT OUTER', desc: 'Unmatched left rows null-padded',
    sql: `SELECT d.id, l.name AS language FROM docs d LEFT JOIN langs l ON d.lang = l.code` },
  { cat: 'JOIN', name: 'Shuffle-hash INNER', desc: 'Fact × fact join',
    sql: `SELECT d.id, e.action FROM docs d JOIN events e ON d.id = e.doc_id` },
  { cat: 'JOIN', name: 'Shuffle-join + WHERE', desc: 'Per-side WHERE pushdown',
    sql: `SELECT d.id, e.action FROM docs d JOIN events e ON d.id = e.doc_id\nWHERE d.lang = 'en' AND e.action = 'view'` },
  { cat: 'JOIN', name: 'Shuffle-join + GROUP BY', desc: '3-stage combine',
    sql: `SELECT d.lang, COUNT(*) AS interactions\nFROM docs d JOIN events e ON d.id = e.doc_id\nGROUP BY d.lang` },

  { cat: 'Streaming', name: 'Windowed COUNT', desc: 'WIN_START (needs streaming source)',
    sql: `SELECT WIN_START(event_time, 60000) AS window_start, COUNT(*) AS n\nFROM events\nGROUP BY WIN_START(event_time, 60000)` },
  { cat: 'Streaming', name: 'Multi-key window', desc: 'Multiple group cols in a window',
    sql: `SELECT WIN_START(event_time, 60000) AS ws, region, COUNT(*) AS req, AVG(latency_ms) AS lat\nFROM events\nGROUP BY WIN_START(event_time, 60000), region` },

  { cat: 'Debug', name: 'Force error', desc: 'Unregistered table — see typed 400',
    sql: `SELECT * FROM does_not_exist` },
  { cat: 'Debug', name: 'Force timeout', desc: 'timeoutMs = 1',
    sql: `SELECT id FROM docs` },
  { cat: 'Debug', name: 'Unsupported', desc: 'Subquery — not distributed',
    sql: `SELECT id FROM docs WHERE lang IN (SELECT code FROM langs)` },
];

function renderSnippets() {
  const byCat = {};
  SNIPPETS.forEach(s => { (byCat[s.cat] = byCat[s.cat] || []).push(s); });
  $('#snippet-list').innerHTML = Object.entries(byCat).map(([cat, items]) => `
    <div class="snippet-category">${esc(cat)}</div>
    ${items.map((s, i) => `
      <div class="snippet-item" data-cat="${esc(cat)}" data-idx="${i}">
        <div class="snippet-name">${esc(s.name)}</div>
        <div class="snippet-desc">${esc(s.desc)}</div>
      </div>`).join('')}
  `).join('');
  $$('#snippet-list .snippet-item').forEach(el => {
    el.addEventListener('click', () => {
      const cat = el.dataset.cat;
      const idx = +el.dataset.idx;
      const s = byCat[cat][idx];
      $('#pg-sql').value = s.sql;
      if (s.name === 'Force timeout') $('#pg-timeout').value = '1';
      else $('#pg-timeout').value = '5000';
      $('#pg-sql').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}

// ================================================================ TABS
function bindTabs(rootSel = '.tabs') {
  $$(`${rootSel} > button`).forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.addEventListener('click', () => {
      const target = btn.dataset.target || btn.dataset.view;
      if (!target) return;
      const parent = btn.closest('.tabs');
      $$('button', parent).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.target) {
        $$('.tab-panel').forEach(p => p.classList.remove('active'));
        $('#' + target).classList.add('active');
        if (target === 'active') refreshActive();
        if (target === 'cluster') refreshCluster();
        if (target === 'metrics') refreshMetricsSnapshot();
      } else if (btn.dataset.view) {
        $$('.view', btn.closest('article')).forEach(v => v.classList.remove('active'));
        $('#' + target, btn.closest('article')).classList.add('active');
        if (target === 'pg-chart') renderChart();
      }
    });
  });
}

// ================================================================ TOP BAR
async function refreshTopBar() {
  try {
    const [agents, tables, health, active] = await Promise.all([
      api('/mesh/agents'),
      api('/mesh/tables'),
      api('/actuator/health').catch(() => ({ status: 'UNKNOWN' })),
      api('/mesh/queries').catch(() => []),
    ]);
    $('#agent-count').textContent = `${agents.length} agent${agents.length === 1 ? '' : 's'}`;
    $('#tables-count').textContent = `${tables.length} table${tables.length === 1 ? '' : 's'}`;
    $('#active-count').textContent = `${active.length} active`;
    setHealthDot(health.status || 'UNKNOWN');
  } catch (e) {
    setHealthDot('DOWN', e.message);
  }
}

function setHealthDot(status, errText) {
  const dot = $('#health-dot');
  const txt = $('#health-text');
  dot.className = 'dot';
  const s = (status || '').toUpperCase();
  if (s === 'UP') { dot.classList.add('up'); txt.textContent = 'UP'; }
  else if (s === 'OUT_OF_SERVICE') { dot.classList.add('degraded'); txt.textContent = 'DEGRADED'; }
  else if (s === 'DOWN') { dot.classList.add('down'); txt.textContent = errText ? `DOWN (${errText})` : 'DOWN'; }
  else { txt.textContent = s; }
}

// ================================================================ CLUSTER
async function refreshCluster() {
  try {
    const [health, agents, tables, cluster] = await Promise.all([
      api('/actuator/health').catch(() => ({ status: 'UNKNOWN' })),
      api('/mesh/agents'),
      api('/mesh/tables'),
      api('/mesh/cluster').catch(e => ({ error: e.message })),
    ]);
    renderHealthFriendly(health);
    renderClusterFriendly(cluster);
    renderAgents(agents, cluster);
    renderTables(tables);
    $('#health-json').textContent = fmtJson(health);
    $('#cluster-json').textContent = fmtJson(cluster);
  } catch (e) {
    $('#cluster-friendly').innerHTML = `<div class="cluster-status-callout err"><p class="title">Error loading cluster</p><p>${esc(e.message)}</p></div>`;
  }
}

function renderHealthFriendly(health) {
  const mesh = health.components?.mesh?.details || {};
  const uncovered = mesh.uncoveredPartitions || [];
  const s = health.status;
  let cls, title, body;
  if (s === 'UP') {
    cls = 'ok';
    title = 'Mesh is fully healthy';
    body = `${mesh.liveAgents ?? '?'} live agents covering ${mesh.registeredPartitions ?? '?'} partitions across ${mesh.registeredTables ?? '?'} tables. All shards have at least one eligible agent.`;
  } else if (s === 'OUT_OF_SERVICE') {
    cls = 'warn';
    title = 'Degraded — some partitions have no eligible agents';
    body = `Uncovered: <code>${uncovered.map(esc).join(', ') || '?'}</code>. Queries touching those partitions will fail. Non-fatal (rolling deploy, agent restart) — K8s readiness probe removes this driver from traffic until fixed.`;
  } else if (s === 'DOWN') {
    cls = 'err';
    title = 'Mesh is DOWN';
    body = 'No live jvssql-capable agents heartbeating. Every query will fail. Check agent logs.';
  } else {
    cls = '';
    title = `Status: ${s}`;
    body = 'Unknown state.';
  }
  $('#health-friendly').innerHTML = `<div class="cluster-status-callout ${cls}">
    <p class="title">${esc(title)}</p><p>${body}</p></div>`;
}

function renderClusterFriendly(cluster) {
  if (cluster.error) {
    $('#cluster-friendly').innerHTML = `<div class="cluster-status-callout err"><p>${esc(cluster.error)}</p></div>`;
    $('#cluster-platform-badge').textContent = 'err';
    $('#cluster-platform-badge').className = 'badge danger';
    return;
  }
  const platform = cluster.platform || 'none';
  $('#cluster-platform-badge').textContent = 'platform: ' + platform;
  $('#cluster-platform-badge').className = 'badge ' + (platform === 'none' ? '' : 'primary');

  if (platform === 'none') {
    $('#cluster-friendly').innerHTML = `
      <div class="cluster-status-callout ok">
        <p class="title">Self-registration mode — no cluster manager configured</p>
        <p>Every agent shows as <code>ORPHAN</code> below because there's no
        Orion / Kubernetes bridge to compare heartbeats against. <strong>This is normal.</strong>
        As long as the agents you expect are listed with the right capabilities,
        the mesh is fine.</p>
        <p><small>Turn on a cluster manager via <code>hitorro.mesh.driver.cluster=orion|k8s</code>
        to get HEALTHY / MISSING / ORPHAN distinctions.</small></p>
      </div>`;
  } else {
    const agents = cluster.agents || [];
    const healthy = agents.filter(a => a.status === 'HEALTHY').length;
    const missing = agents.filter(a => a.status === 'MISSING').length;
    const orphan = agents.filter(a => a.status === 'ORPHAN').length;
    let cls = 'ok', title = 'All declared agents are heartbeating';
    if (missing > 0) { cls = 'err'; title = `${missing} declared agent(s) not heartbeating`; }
    else if (orphan > 0) { cls = 'warn'; title = `${orphan} agent(s) heartbeating without a declaration`; }
    $('#cluster-friendly').innerHTML = `
      <div class="cluster-status-callout ${cls}">
        <p class="title">${esc(title)}</p>
        <p>Cluster manager: <strong>${esc(platform)}</strong> · Healthy: ${healthy} · Missing: ${missing} · Orphan: ${orphan}</p>
      </div>`;
  }
}

function renderAgents(agents, cluster) {
  $('#cluster-agent-count').textContent = agents.length;
  if (!agents.length) {
    $('#agent-list').innerHTML = '<p><small>No agents are heartbeating.</small></p>';
    return;
  }
  const platform = cluster?.platform || 'none';
  const clusterAgents = new Map((cluster?.agents || []).map(a => [a.name, a]));

  $('#agent-list').innerHTML = '<div class="entity-list"><ul>' + agents.map(a => {
    const ca = clusterAgents.get(a.agentId);
    // When platform=none, don't shame every agent as ORPHAN — call it SELF_REGISTERED
    let status = ca?.status || 'HEALTHY';
    if (platform === 'none') status = 'SELF_REGISTERED';
    const statusLabel = { HEALTHY: 'healthy', MISSING: 'missing!', ORPHAN: 'orphan', SELF_REGISTERED: 'self-registered' }[status] || status;
    return `<li>
       <span>
         <span class="name">${esc(a.agentId)}</span>
         <span class="agent-row-status ${status}">${esc(statusLabel)}</span>
       </span>
       <span>${(a.capabilities || []).map(c => `<span class="cap">${esc(c)}</span>`).join('')}</span>
     </li>`;
  }).join('') + '</ul></div>';
}

function renderTables(tables) {
  $('#table-count-inline').textContent = tables.length;
  if (!tables.length) {
    $('#table-list').innerHTML = '<p><small>No tables registered.</small></p>';
    return;
  }
  $('#table-list').innerHTML = '<div class="entity-list"><ul>' + tables.map(t => {
    const parts = (t.partitions || []).map(p => `<span class="cap">${esc(p.key)}</span>`).join('');
    return `<li>
       <span class="name clickable-name" data-table="${esc(t.name)}">${esc(t.name)}</span>
       <span>${parts || '<small>(broadcast — no partitions)</small>'}</span>
     </li>`;
  }).join('') + '</ul></div>';
  $$('#table-list .clickable-name').forEach(el => {
    el.addEventListener('click', () => showSchema(el.dataset.table, tables));
  });
}

async function showSchema(name, allTables) {
  const t = allTables.find(x => x.name === name);
  if (!t) return;
  $('#schema-panel').hidden = false;
  $('#schema-name').textContent = name;
  $('#schema-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // JVS type is not in /mesh/tables — we can infer field names by
  // fetching a sample row, or by parsing the type-json-resource.
  // Simplest: SELECT * FROM {name} LIMIT 1 → use the row's field names.
  $('#schema-fields').innerHTML = '<p><small>Loading…</small></p>';
  $('#schema-sample').innerHTML = '<p><small>Loading…</small></p>';

  try {
    const oneRow = await api('/mesh/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT * FROM ${name} LIMIT 1`, timeoutMs: 5000 }),
    });
    if (oneRow.rows.length) {
      const first = oneRow.rows[0];
      $('#schema-fields').innerHTML = '<dl>' + Object.keys(first).map(k => {
        const v = first[k];
        const inferred = v === null ? 'null' : typeof v === 'number' ? (Number.isInteger(v) ? 'core_long' : 'core_double') : typeof v === 'boolean' ? 'core_boolean' : typeof v === 'object' ? 'nested' : 'core_string';
        return `<dt>${esc(k)}</dt><dd>inferred: <code>${esc(inferred)}</code></dd>`;
      }).join('') + '</dl>';
    } else {
      $('#schema-fields').innerHTML = '<p><small>No rows to infer schema from.</small></p>';
    }
  } catch (e) {
    $('#schema-fields').innerHTML = `<p style="color:var(--danger)">${esc(e.body?.message || e.message)}</p>`;
  }

  try {
    const sample = await api('/mesh/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT * FROM ${name} LIMIT 10`, timeoutMs: 5000 }),
    });
    $('#schema-sample').innerHTML = renderTable(sample.rows);
  } catch (e) {
    $('#schema-sample').innerHTML = `<p style="color:var(--danger)">${esc(e.body?.message || e.message)}</p>`;
  }
}

// ================================================================ PLAYGROUND
const HISTORY_KEY = 'mesh-ui-history';
const historyLoad = () => JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
const historySave = (h) => localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 20)));

function pushHistory(sql, meta) {
  const h = historyLoad();
  h.unshift({ sql, at: Date.now(), meta });
  historySave(h);
  renderHistory();
}
function renderHistory() {
  const h = historyLoad();
  if (!h.length) { $('#pg-history').innerHTML = '<p><small>No queries yet.</small></p>'; return; }
  $('#pg-history').innerHTML = h.map((item, i) => `
    <div class="history-item" data-idx="${i}">
      <span class="history-sql">${esc(short(item.sql, 80))}</span>
      <span class="history-meta">${esc(item.meta || '')} · ${new Date(item.at).toLocaleTimeString()}</span>
    </div>`).join('');
  $$('#pg-history .history-item').forEach(el => {
    el.addEventListener('click', () => {
      $('#pg-sql').value = h[+el.dataset.idx].sql;
      $('#pg-sql').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

let lastResult = null;

async function runPlaygroundQuery() {
  const sql = $('#pg-sql').value.trim();
  const timeoutMs = +$('#pg-timeout').value || 5000;
  const retries = +$('#pg-retries').value || 0;
  if (!sql) return;
  $('#pg-result').hidden = false;
  $('#pg-meta').textContent = 'Running…';
  $('#pg-table').innerHTML = '';
  $('#pg-json').textContent = '';
  const t0 = performance.now();
  try {
    const body = await api('/mesh/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, timeoutMs, retries }),
    });
    const dt = Math.round(performance.now() - t0);
    const meta = `${body.rowCount} rows · ${dt}ms · attempts=${body.attempts}${body.timedOut ? ' · TIMED OUT' : ''}`;
    $('#pg-meta').textContent = meta;
    $('#pg-json').textContent = fmtJson(body);
    $('#pg-table').innerHTML = renderTable(body.rows);
    lastResult = body;
    populateChartControls(body.rows);
    pushHistory(sql, meta);
  } catch (e) {
    $('#pg-meta').textContent = `error: ${e.status || ''} ${e.body?.error || ''}`;
    $('#pg-json').textContent = fmtJson(e.body || { error: e.message });
    $('#pg-table').innerHTML = `<p><small style="color:var(--danger)">${esc(e.body?.message || e.message)}</small></p>`;
    lastResult = null;
  }
}

function renderTable(rows) {
  if (!rows || !rows.length) return '<p><small>Empty result set.</small></p>';
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
  const header = cols.map(c => `<th>${esc(c)}</th>`).join('');
  const bodyHtml = rows.map(r => `<tr>${cols.map(c => `<td>${esc(fmtCell(r[c]))}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table class="result"><thead><tr>${header}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}
function fmtCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ================================================================ CHART
let currentChart = null;

function populateChartControls(rows) {
  if (!rows || !rows.length) return;
  const cols = Object.keys(rows[0]);
  const numericCols = cols.filter(c => rows.every(r => r[c] === null || typeof r[c] === 'number'));
  const xSel = $('#pg-chart-x');
  const ySel = $('#pg-chart-y');
  xSel.innerHTML = cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  ySel.innerHTML = (numericCols.length ? numericCols : cols).map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  // Sensible defaults: first col as X, first numeric col as Y
  xSel.value = cols[0];
  ySel.value = numericCols[0] || cols[1] || cols[0];
}

function renderChart() {
  if (!lastResult || !lastResult.rows || !lastResult.rows.length) return;
  const rows = lastResult.rows;
  const type = $('#pg-chart-type').value;
  const xCol = $('#pg-chart-x').value;
  const yCol = $('#pg-chart-y').value;
  if (!xCol || !yCol) return;
  const labels = rows.map(r => String(r[xCol] ?? ''));
  const data = rows.map(r => Number(r[yCol]) || 0);
  const canvas = $('#pg-chart-canvas');
  if (currentChart) currentChart.destroy();
  currentChart = new Chart(canvas, {
    type,
    data: {
      labels,
      datasets: [{
        label: yCol,
        data,
        backgroundColor: type === 'doughnut'
          ? ['#2E86AB', '#F18F01', '#27AE60', '#C0392B', '#8E44AD', '#16A085', '#E67E22', '#2980B9']
          : 'rgba(46, 134, 171, 0.6)',
        borderColor: '#2E86AB',
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: type === 'doughnut' } },
    },
  });
}

// ================================================================ EXPLAIN
async function runExplain() {
  const sql = $('#ex-sql').value.trim();
  if (!sql) return;
  const resArt = $('#ex-result');
  resArt.hidden = false;
  try {
    const body = await api('/mesh/queries/explain?sql=' + encodeURIComponent(sql));
    $('#ex-type').textContent = body.planType;
    $('#ex-type').className = 'badge primary';
    const overview = [
      ['Plan type', body.planType],
      ['Table', body.tableName],
      ['Join kind', body.joinKind],
      ['Left table', body.leftTable],
      ['Right table', body.rightTable],
      ['Left key', body.leftKey],
      ['Right key', body.rightKey],
      ['Group columns', (body.groupColumns || []).join(', ')],
      ['Left WHERE pushdown', body.leftPushdown],
      ['Right WHERE pushdown', body.rightPushdown],
      ['Partial SQL', body.partialSql],
      ['Combine SQL', body.combineSql],
      ['Original SQL', body.originalSql],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    $('#ex-overview').innerHTML = '<dl>' + overview.map(([k, v]) =>
      `<dt><strong>${esc(k)}</strong></dt><dd><code>${esc(v)}</code></dd>`
    ).join('') + '</dl>';
    $('#ex-partitions').innerHTML = (body.partitions || []).length
      ? '<div class="entity-list"><ul>' + body.partitions.map(p =>
          `<li>
             <span class="name">${esc(p.key)}</span>
             <span>
               required: ${(p.requiredCapabilities || []).map(c => `<span class="cap">${esc(c)}</span>`).join('')}
               → eligible: ${(p.eligibleAgents || []).length
                 ? p.eligibleAgents.map(a => `<span class="cap">${esc(a)}</span>`).join('')
                 : '<span style="color:var(--danger);font-weight:600;">NONE — query will fail</span>'}
             </span>
           </li>`
        ).join('') + '</ul></div>'
      : '<p><small>No partitions for this plan.</small></p>';
    $('#ex-json').textContent = fmtJson(body);
  } catch (e) {
    $('#ex-overview').innerHTML = `<p style="color:var(--danger)">${esc(e.body?.message || e.message)}</p>`;
    $('#ex-partitions').innerHTML = '';
    $('#ex-json').textContent = fmtJson(e.body || { error: e.message });
    $('#ex-type').textContent = 'error';
    $('#ex-type').className = 'badge danger';
  }
}

// ================================================================ STREAMING
let streamState = { es: null, queryId: null, rows: 0, lastRateAt: 0, rateWin: [] };

function startStream() {
  const sql = $('#stream-sql').value.trim();
  const timeoutMs = +$('#stream-timeout').value || 60000;
  if (!sql) return;
  cancelStream();
  const url = '/mesh/queries/stream?sql=' + encodeURIComponent(sql) + '&timeoutMs=' + timeoutMs;
  const es = new EventSource(url);
  streamState = { es, queryId: null, rows: 0, lastRateAt: performance.now(), rateWin: [] };
  $('#stream-panel').hidden = false;
  $('#stream-meta').textContent = '';
  $('#stream-row-count').textContent = '0';
  $('#stream-rate').textContent = '0';
  $('#stream-status').textContent = 'connecting…';
  $('#stream-rows').innerHTML = '';
  $('#stream-stop').disabled = false;
  $('#stream-run').disabled = true;

  es.addEventListener('opened', (e) => {
    const data = JSON.parse(e.data);
    streamState.queryId = data.queryId;
    $('#stream-meta').textContent = `queryId=${data.queryId} · agents=${(data.assignedAgents || []).join(', ')}`;
    $('#stream-status').textContent = 'streaming';
    appendStreamRow('event-opened', 'opened: ' + JSON.stringify(data));
  });
  es.addEventListener('row', (e) => {
    streamState.rows++;
    $('#stream-row-count').textContent = streamState.rows;
    updateStreamRate();
    appendStreamRow('event-row', e.data);
  });
  es.addEventListener('complete', (e) => {
    $('#stream-status').textContent = 'complete';
    appendStreamRow('event-complete', 'complete: ' + e.data);
    stopStreamClient();
  });
  es.addEventListener('error', (e) => {
    const detail = e.data ? 'error: ' + e.data : 'connection closed';
    $('#stream-status').textContent = detail;
    appendStreamRow('event-error', detail);
    stopStreamClient();
  });
}

function updateStreamRate() {
  const now = performance.now();
  streamState.rateWin.push(now);
  streamState.rateWin = streamState.rateWin.filter(t => now - t < 2000);
  const rate = Math.round(streamState.rateWin.length / 2);
  $('#stream-rate').textContent = rate;
}

function appendStreamRow(cls, text) {
  const div = document.createElement('div');
  div.className = 'stream-row ' + cls;
  div.textContent = text;
  const c = $('#stream-rows');
  c.appendChild(div);
  // Cap at 200 rows to avoid growing the DOM unboundedly.
  while (c.children.length > 200) c.removeChild(c.firstChild);
  c.scrollTop = c.scrollHeight;
}

function stopStreamClient() {
  if (streamState.es) { streamState.es.close(); streamState.es = null; }
  $('#stream-stop').disabled = true;
  $('#stream-run').disabled = false;
}

async function cancelStream() {
  if (streamState.queryId) {
    try {
      await api('/mesh/queries/' + streamState.queryId, { method: 'DELETE' });
      appendStreamRow('event-error', 'cancel sent for queryId=' + streamState.queryId);
    } catch (e) { /* ignore */ }
  }
  stopStreamClient();
}

// ================================================================ ACTIVE
let activeTimer = null;
function armActiveAutoRefresh() {
  clearInterval(activeTimer);
  activeTimer = setInterval(() => {
    if ($('#active').classList.contains('active')) refreshActive();
  }, 3000);
}

async function refreshActive() {
  try {
    const list = await api('/mesh/queries');
    if (!list.length) {
      $('#active-list').innerHTML = '<p><small>No in-flight queries.</small></p>';
      return;
    }
    $('#active-list').innerHTML = '<div class="entity-list"><ul>' + list.map(q =>
      `<li>
         <span class="name">${esc(q.queryId)}</span>
         <span>agents: ${(q.assignedAgents || []).map(a => `<span class="cap">${esc(a)}</span>`).join('')}</span>
         <button class="contrast" data-qid="${esc(q.queryId)}" style="width:auto;margin:0;">✕ Cancel</button>
       </li>`
    ).join('') + '</ul></div>';
    $$('#active-list button[data-qid]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await api('/mesh/queries/' + btn.dataset.qid, { method: 'DELETE' }); }
        catch { /* ignore */ }
        refreshActive();
      });
    });
  } catch (e) {
    $('#active-list').innerHTML = `<p><small style="color:var(--danger)">${esc(e.message)}</small></p>`;
  }
}

// ================================================================ SPARKLINES
const SPARK = { queries: [], latency: [], agents: [], rows: [], lastCounts: null };

function drawSparkline(canvasId, values, colour) {
  const canvas = $(canvasId);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!values.length) return;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const step = w / Math.max(values.length - 1, 1);
  // Fill under curve
  ctx.fillStyle = colour + '22';
  ctx.beginPath();
  ctx.moveTo(0, h);
  values.forEach((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    ctx.lineTo(x, y);
  });
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  // Line
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // Latest point marker
  const lx = (values.length - 1) * step;
  const ly = h - ((values[values.length - 1] - min) / range) * (h - 8) - 4;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function parsePrometheus(text) {
  // Returns a Map<meterName+labels, value>. Bare minimum parser.
  const out = new Map();
  text.split('\n').forEach(line => {
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?)\s+([-+e0-9.]+)/);
    if (m) out.set(m[1], parseFloat(m[2]));
  });
  return out;
}

async function refreshSparklines() {
  try {
    const text = await api('/actuator/prometheus');
    const m = parsePrometheus(text);
    const queriesOk = m.get('mesh_queries_total{outcome="ok",}') || m.get('mesh_queries_total{outcome="ok"}') || 0;
    const queriesErr = m.get('mesh_queries_total{outcome="error",}') || m.get('mesh_queries_total{outcome="error"}') || 0;
    const totalQueries = queriesOk + queriesErr;

    const rowsReturned = m.get('mesh_rows_returned_total') || 0;

    // For latency, use the histogram's sum / count median approximation
    const durSum = m.get('mesh_query_duration_seconds_sum{outcome="ok",}') || m.get('mesh_query_duration_seconds_sum{outcome="ok"}') || 0;
    const durCnt = m.get('mesh_query_duration_seconds_count{outcome="ok",}') || m.get('mesh_query_duration_seconds_count{outcome="ok"}') || 0;
    const avgLatencyMs = durCnt > 0 ? Math.round(1000 * durSum / durCnt) : 0;

    const agentsLive = m.get('mesh_agents_live') || 0;

    // Delta since last snapshot for counters
    const last = SPARK.lastCounts || { totalQueries, rowsReturned };
    const dQueries = Math.max(0, totalQueries - last.totalQueries);
    const dRows = Math.max(0, rowsReturned - last.rowsReturned);
    SPARK.lastCounts = { totalQueries, rowsReturned };

    push(SPARK.queries, dQueries, 12);
    push(SPARK.latency, avgLatencyMs, 12);
    push(SPARK.agents, agentsLive, 12);
    push(SPARK.rows, dRows, 12);

    drawSparkline('#spark-queries', SPARK.queries, '#2E86AB');
    drawSparkline('#spark-latency', SPARK.latency, '#F18F01');
    drawSparkline('#spark-agents', SPARK.agents, '#27AE60');
    drawSparkline('#spark-rows', SPARK.rows, '#8E44AD');

    $('#spark-queries-value').textContent = dQueries + '';
    $('#spark-latency-value').textContent = avgLatencyMs + 'ms';
    $('#spark-agents-value').textContent = agentsLive + '';
    $('#spark-rows-value').textContent = dRows + '';
  } catch (e) {
    // Silent — sparklines are best-effort.
  }
}
function push(arr, v, cap) { arr.push(v); while (arr.length > cap) arr.shift(); }

// ================================================================ METRICS SNAPSHOT
async function refreshMetricsSnapshot() {
  try {
    const raw = await api('/actuator/prometheus');
    const meshLines = raw.split('\n').filter(l => l.startsWith('mesh_')).slice(0, 80).join('\n');
    $('#metrics-snapshot').textContent = meshLines || '(no mesh_ meters — driver may not be scraping)';
  } catch (e) {
    $('#metrics-snapshot').textContent = 'error: ' + e.message;
  }
}

// ================================================================ BOOT
document.addEventListener('DOMContentLoaded', () => {
  bindTabs('.tabs');
  bindTabs('.sub-tabs');
  renderSnippets();

  $('#pg-run').addEventListener('click', runPlaygroundQuery);
  $('#pg-clear').addEventListener('click', () => {
    $('#pg-sql').value = '';
    $('#pg-result').hidden = true;
    lastResult = null;
  });
  $('#pg-explain-btn').addEventListener('click', () => {
    $('#ex-sql').value = $('#pg-sql').value;
    $$('.tabs > button').forEach(b => { if (b.dataset.target === 'explain') b.click(); });
    runExplain();
  });
  $('#pg-history-clear').addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  });
  $('#pg-chart-type').addEventListener('change', renderChart);
  $('#pg-chart-x').addEventListener('change', renderChart);
  $('#pg-chart-y').addEventListener('change', renderChart);

  $('#ex-run').addEventListener('click', runExplain);
  $('#stream-run').addEventListener('click', startStream);
  $('#stream-stop').addEventListener('click', cancelStream);
  $('#active-refresh').addEventListener('click', refreshActive);
  $('#schema-close').addEventListener('click', () => { $('#schema-panel').hidden = true; });

  renderHistory();
  refreshTopBar();
  refreshCluster();
  refreshSparklines();
  setInterval(refreshTopBar, 5000);
  setInterval(refreshSparklines, 5000);
  armActiveAutoRefresh();
});
