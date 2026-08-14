// Hitorro Mesh UI — single-file vanilla JS. No build step.
// Talks to the driver's REST + SSE + Actuator endpoints on the same host.

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

// ---------------------------------------------------------------- tabs
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
      // Find sibling panels or view containers.
      const scope = parent.dataset.scope ? $(parent.dataset.scope) : document;
      if (btn.dataset.target) {
        $$('.tab-panel', scope).forEach(p => p.classList.remove('active'));
        $('#' + target, scope).classList.add('active');
        if (target === 'active') refreshActive();
        if (target === 'cluster') refreshCluster();
        if (target === 'metrics') refreshMetricsSnapshot();
      } else if (btn.dataset.view) {
        $$('.view', btn.closest('article')).forEach(v => v.classList.remove('active'));
        $('#' + target, btn.closest('article')).classList.add('active');
      }
    });
  });
}

// ---------------------------------------------------------------- top nav
async function refreshTopBar() {
  try {
    const [agents, tables, health] = await Promise.all([
      api('/mesh/agents'),
      api('/mesh/tables'),
      api('/actuator/health').catch(() => ({ status: 'UNKNOWN' })),
    ]);
    $('#agent-count').textContent = `${agents.length} agent${agents.length === 1 ? '' : 's'}`;
    $('#tables-count').textContent = `${tables.length} table${tables.length === 1 ? '' : 's'}`;
    setHealthDot(health.status || 'UNKNOWN', (health.components && health.components.mesh) || null);
  } catch (e) {
    setHealthDot('DOWN', null, e.message);
  }
}

function setHealthDot(status, meshComponent, errText) {
  const dot = $('#health-dot');
  const txt = $('#health-text');
  dot.className = 'dot';
  const s = (status || '').toUpperCase();
  if (s === 'UP') { dot.classList.add('up'); txt.textContent = 'UP'; }
  else if (s === 'OUT_OF_SERVICE') { dot.classList.add('degraded'); txt.textContent = 'DEGRADED'; }
  else if (s === 'DOWN') { dot.classList.add('down'); txt.textContent = errText ? `DOWN (${errText})` : 'DOWN'; }
  else { txt.textContent = s; }
}

// ---------------------------------------------------------------- cluster
async function refreshCluster() {
  try {
    const [health, agents, tables, cluster] = await Promise.all([
      api('/actuator/health').catch(() => ({ status: 'UNKNOWN' })),
      api('/mesh/agents'),
      api('/mesh/tables'),
      api('/mesh/cluster').catch(e => ({ error: e.message })),
    ]);
    $('#health-json').textContent = fmtJson(health);
    $('#cluster-json').textContent = fmtJson(cluster);
    renderAgents(agents);
    renderTables(tables);
  } catch (e) {
    $('#health-json').textContent = 'error: ' + e.message;
  }
}

function renderAgents(agents) {
  $('#cluster-agent-count').textContent = agents.length;
  if (!agents.length) {
    $('#agent-list').innerHTML = '<p><small>No agents are heartbeating.</small></p>';
    return;
  }
  $('#agent-list').innerHTML = '<div class="entity-list"><ul>' + agents.map(a =>
    `<li>
       <span class="name">${esc(a.agentId)}</span>
       <span>${(a.capabilities || []).map(c => `<span class="cap">${esc(c)}</span>`).join('')}</span>
     </li>`
  ).join('') + '</ul></div>';
}

function renderTables(tables) {
  $('#tables-count').textContent = `${tables.length} table${tables.length === 1 ? '' : 's'}`;
  $('#table-count-inline').textContent = tables.length;
  if (!tables.length) {
    $('#table-list').innerHTML = '<p><small>No tables registered.</small></p>';
    return;
  }
  $('#table-list').innerHTML = '<div class="entity-list"><ul>' + tables.map(t => {
    const parts = (t.partitions || []).map(p => `<span class="cap">${esc(p.key)}</span>`).join('');
    return `<li>
       <span class="name">${esc(t.name)}</span>
       <span>${parts || '<small>(broadcast — no partitions)</small>'}</span>
     </li>`;
  }).join('') + '</ul></div>';
}

// ---------------------------------------------------------------- playground
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
      <span class="history-meta">${item.meta || ''} · ${new Date(item.at).toLocaleTimeString()}</span>
    </div>`).join('');
  $$('#pg-history .history-item').forEach(el => {
    el.addEventListener('click', () => {
      $('#pg-sql').value = h[+el.dataset.idx].sql;
      $('#pg-sql').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

async function runPlaygroundQuery() {
  const sql = $('#pg-sql').value.trim();
  const timeoutMs = +$('#pg-timeout').value || 5000;
  const retries = +$('#pg-retries').value || 0;
  if (!sql) return;
  const resArt = $('#pg-result');
  resArt.hidden = false;
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
    pushHistory(sql, meta);
  } catch (e) {
    $('#pg-meta').textContent = `error: ${e.status || ''} ${e.body?.error || ''}`;
    $('#pg-json').textContent = fmtJson(e.body || { error: e.message });
    $('#pg-table').innerHTML = `<p><small style="color:var(--danger)">${esc(e.body?.message || e.message)}</small></p>`;
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

// ---------------------------------------------------------------- explain
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
      ['Left pushdown', body.leftPushdown],
      ['Right pushdown', body.rightPushdown],
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
               ${(p.requiredCapabilities || []).map(c => `<span class="cap">${esc(c)}</span>`).join('')}
               → eligible: ${(p.eligibleAgents || []).map(a => `<span class="cap">${esc(a)}</span>`).join('') || '<span style="color:var(--danger)">none</span>'}
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

// ---------------------------------------------------------------- streaming
let streamState = { es: null, queryId: null, rows: 0 };

function startStream() {
  const sql = $('#stream-sql').value.trim();
  const timeoutMs = +$('#stream-timeout').value || 60000;
  if (!sql) return;
  cancelStream();
  const url = '/mesh/queries/stream?sql=' + encodeURIComponent(sql) + '&timeoutMs=' + timeoutMs;
  const es = new EventSource(url);
  streamState.es = es;
  streamState.rows = 0;
  streamState.queryId = null;
  $('#stream-panel').hidden = false;
  $('#stream-meta').textContent = '';
  $('#stream-row-count').textContent = '0';
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

function appendStreamRow(cls, text) {
  const div = document.createElement('div');
  div.className = 'stream-row ' + cls;
  div.textContent = text;
  const c = $('#stream-rows');
  c.appendChild(div);
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
    } catch (e) {
      // Ignore — query might have already completed.
    }
  }
  stopStreamClient();
}

// ---------------------------------------------------------------- active queries
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
         <button class="contrast" data-qid="${esc(q.queryId)}" style="width:auto;margin:0;">Cancel</button>
       </li>`
    ).join('') + '</ul></div>';
    $$('#active-list button[data-qid]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try { await api('/mesh/queries/' + btn.dataset.qid, { method: 'DELETE' }); }
        catch { /* ignore, will show gone on next refresh */ }
        refreshActive();
      });
    });
  } catch (e) {
    $('#active-list').innerHTML = `<p><small style="color:var(--danger)">${esc(e.message)}</small></p>`;
  }
}

// ---------------------------------------------------------------- metrics snapshot
async function refreshMetricsSnapshot() {
  try {
    const raw = await api('/actuator/prometheus');
    const meshLines = raw.split('\n').filter(l => l.startsWith('mesh_')).slice(0, 60).join('\n');
    $('#metrics-snapshot').textContent = meshLines || '(no mesh_ meters)';
  } catch (e) {
    $('#metrics-snapshot').textContent = 'error: ' + e.message;
  }
}

// ---------------------------------------------------------------- boot
document.addEventListener('DOMContentLoaded', () => {
  bindTabs('.tabs');
  bindTabs('.sub-tabs');

  $('#pg-run').addEventListener('click', runPlaygroundQuery);
  $('#pg-explain-btn').addEventListener('click', () => {
    $('#ex-sql').value = $('#pg-sql').value;
    $$('.tabs > button').forEach(b => { if (b.dataset.target === 'explain') b.click(); });
    runExplain();
  });
  $('#ex-run').addEventListener('click', runExplain);
  $('#stream-run').addEventListener('click', startStream);
  $('#stream-stop').addEventListener('click', cancelStream);
  $('#active-refresh').addEventListener('click', refreshActive);

  renderHistory();
  refreshTopBar();
  refreshCluster();
  setInterval(refreshTopBar, 5000);
  armActiveAutoRefresh();
});
