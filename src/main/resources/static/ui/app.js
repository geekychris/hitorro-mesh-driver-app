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

let cmEditor = null;
const getSql = () => cmEditor ? cmEditor.getValue() : $('#pg-sql').value;
const setSql = (s) => { if (cmEditor) cmEditor.setValue(s); else $('#pg-sql').value = s; };
const focusEditor = () => { if (cmEditor) cmEditor.focus(); else $('#pg-sql').focus(); };
const insertAtCursor = (s) => {
  if (cmEditor) {
    cmEditor.replaceSelection(s, 'end');
    cmEditor.focus();
  } else {
    const el = $('#pg-sql');
    const p = el.selectionStart;
    el.value = el.value.slice(0, p) + s + el.value.slice(p);
    el.selectionStart = el.selectionEnd = p + s.length;
    el.focus();
  }
};

// Set to a dataset-context object when the user arrived at Playground via
// the Datasets tab's Quick queries; null when back to the generic view.
// Shape: { id, tableName, title, snippets: [{name, desc, sql}] }.
let pgDatasetContext = null;

function renderSnippets() {
  // Dataset-tuned mode: replace the generic library with per-column
  // queries built from the current dataset's manifest.
  if (pgDatasetContext) {
    const ctx = pgDatasetContext;
    $('#snippet-list').innerHTML = `
      <div class="snippet-category">${esc(ctx.title || ctx.tableName)}</div>
      ${ctx.snippets.map((s, i) => `
        <div class="snippet-item" data-dsidx="${i}">
          <div class="snippet-name">${esc(s.name)}</div>
          <div class="snippet-desc">${esc(s.desc)}</div>
        </div>`).join('')}
    `;
    $$('#snippet-list .snippet-item').forEach(el => {
      el.addEventListener('click', () => {
        const s = ctx.snippets[+el.dataset.dsidx];
        setSql(s.sql);
        focusEditor();
      });
    });
    return;
  }

  // Generic mode — the shipped snippet library.
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
      setSql(s.sql);
      if (s.name === 'Force timeout') $('#pg-timeout').value = '1';
      else $('#pg-timeout').value = '5000';
      focusEditor();
    });
  });
}

/**
 * Called by the Datasets tab's Quick-query buttons before switching tabs.
 * Records dataset context, populates dataset-specific snippets, and shows
 * the "Playing with <name>" banner at the top of the editor.
 *
 * @param manifest full manifest object from /mesh/datasets/{id}
 * @param tableName SQL name (snake_case)
 */
function setPlaygroundDatasetContext(manifest, tableName) {
  const rels = manifest.relationships || [];
  const fields = manifest.record?.fields || [];
  const pk = manifest.record?.primaryKey;

  // Build a rich per-dataset snippet library. The layout mirrors the
  // Datasets tab's Quick-queries block but pushes deeper into the schema
  // (id.* group-bys, geo.* filters, USING PLACE per relationship).
  const snippets = [];
  snippets.push({
    name: 'Peek 20 rows',
    desc: `SELECT * FROM ${tableName} LIMIT 20`,
    sql: `SELECT * FROM ${tableName} LIMIT 20`,
  });
  if (pk) {
    snippets.push({
      name: `Count by ${pk}`,
      desc: 'group by primary key',
      sql: `SELECT ${pk}, COUNT(*) AS n\nFROM ${tableName}\nGROUP BY ${pk}\nORDER BY n DESC\nLIMIT 20`,
    });
  }
  fields.filter(f => f.role && f.role.startsWith('id.') && f.name !== pk).forEach(f => {
    snippets.push({
      name: `GROUP BY ${f.name}`,
      desc: `id role: ${f.role}`,
      sql: `SELECT ${f.name}, COUNT(*) AS n\nFROM ${tableName}\nGROUP BY ${f.name}\nORDER BY n DESC\nLIMIT 20`,
    });
  });
  const popField = fields.find(f => f.role === 'geo.population');
  if (popField) {
    snippets.push({
      name: `Top ${tableName} by population`,
      desc: `${popField.name} DESC`,
      sql: `SELECT *\nFROM ${tableName}\nWHERE ${popField.name} IS NOT NULL\nORDER BY ${popField.name} DESC\nLIMIT 20`,
    });
  }
  const elevField = fields.find(f => f.role === 'geo.elevation');
  if (elevField) {
    snippets.push({
      name: `High altitude`,
      desc: `${elevField.name} > 3000`,
      sql: `SELECT *\nFROM ${tableName}\nWHERE ${elevField.name} > 3000\nORDER BY ${elevField.name} DESC\nLIMIT 20`,
    });
  }
  rels.filter(r => r.kind === 'EXACT_ID').forEach(r => {
    const target = (r.target || '').replace(/-/g, '_');
    snippets.push({
      name: `JOIN ${target}`,
      desc: 'USING PLACE — check the semantic toggle to auto-rewrite',
      sql: `SELECT a.*, b.*\nFROM ${tableName} a\nJOIN ${target} b USING PLACE\nLIMIT 10`,
    });
  });

  pgDatasetContext = {
    id: manifest.id,
    tableName,
    title: manifest.title,
    snippets,
  };

  $('#pg-context-name').textContent = manifest.title || tableName;
  $('#pg-context').hidden = false;
  // Ensure the Snippets sub-tab is open so the tuned list is visible.
  const lpSnippetsBtn = document.querySelector('[data-lp="lp-snippets"]');
  if (lpSnippetsBtn && !lpSnippetsBtn.classList.contains('active')) lpSnippetsBtn.click();
  renderSnippets();
  // Also flip the semantic toggle on — most of the tuned snippets are
  // USING PLACE joins that only work with it on.
  $('#pg-semantic').checked = true;
}

function clearPlaygroundDatasetContext() {
  pgDatasetContext = null;
  $('#pg-context').hidden = true;
  renderSnippets();
}

// ================================================================ SCHEMA TREE
async function refreshSchemaTree() {
  const container = $('#schema-tree');
  container.innerHTML = '<p><small>Loading…</small></p>';
  try {
    const tables = await api('/mesh/tables');
    if (!tables.length) {
      container.innerHTML = '<p><small>No tables registered.</small></p>';
      return;
    }
    container.innerHTML = '<div class="schema-tree">' + tables.map((t, i) =>
      `<div class="schema-table" data-table="${esc(t.name)}" data-idx="${i}">
         <div class="schema-table-head" data-toggle="${esc(t.name)}">
           <span class="arrow">▶</span>
           <span class="schema-table-name" data-insert-name="${esc(t.name)}">${esc(t.name)}</span>
           <span class="schema-badge ${t.kind}">${esc(t.kind)}</span>
           ${t.streaming ? '<span class="schema-badge streaming">stream</span>' : ''}
         </div>
         <div class="schema-cols" id="cols-${esc(t.name)}">
           <div class="schema-col meta"><small>click to expand</small></div>
         </div>
       </div>`).join('') + '</div>';

    // Toggle expand + lazy-load columns via SELECT * FROM x LIMIT 1
    $$('#schema-tree .schema-table-head').forEach(head => {
      head.addEventListener('click', async (e) => {
        // If they clicked the name specifically, insert it into the editor
        // (single click on the name), not just toggle. Detect via the name span.
        if (e.target.dataset.insertName) {
          e.stopPropagation();
          insertAtCursor(e.target.dataset.insertName);
          return;
        }
        const name = head.dataset.toggle;
        head.classList.toggle('open');
        const colsDiv = $('#cols-' + CSS.escape(name));
        if (head.classList.contains('open') && colsDiv.dataset.loaded !== 'true') {
          colsDiv.innerHTML = '<p><small class="meta">Loading columns…</small></p>';
          try {
            const one = await api('/mesh/queries', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sql: `SELECT * FROM ${name} LIMIT 1`, timeoutMs: 5000 }),
            });
            if (one.rows.length) {
              const first = one.rows[0];
              colsDiv.innerHTML = Object.keys(first).map(k => {
                const v = first[k];
                const t = v === null ? 'null' : typeof v === 'number' ? (Number.isInteger(v) ? 'long' : 'double') : typeof v === 'boolean' ? 'bool' : typeof v === 'object' ? 'json' : 'string';
                return `<div class="schema-col" data-insert-col="${esc(k)}">
                  <span class="col-name">${esc(k)}</span>
                  <span class="col-type">${esc(t)}</span>
                </div>`;
              }).join('');
              $$('#cols-' + CSS.escape(name) + ' .schema-col').forEach(c => {
                c.addEventListener('click', (e) => {
                  e.stopPropagation();
                  insertAtCursor(c.dataset.insertCol);
                });
              });
              colsDiv.dataset.loaded = 'true';
            } else {
              colsDiv.innerHTML = '<p><small class="meta">(no rows to infer columns from)</small></p>';
            }
          } catch (err) {
            colsDiv.innerHTML = `<p><small style="color:var(--danger)">Error: ${esc(err.body?.message || err.message)}</small></p>`;
          }
        }
      });
    });
  } catch (e) {
    container.innerHTML = `<p><small style="color:var(--danger)">Error loading schema: ${esc(e.message)}</small></p>`;
  }
}

// ================================================================ SAVED QUERIES
const SAVED_KEY = 'mesh-ui-saved';
const savedLoad = () => JSON.parse(localStorage.getItem(SAVED_KEY) || '{}');
const savedSave = (m) => localStorage.setItem(SAVED_KEY, JSON.stringify(m));

function renderSavedList() {
  const m = savedLoad();
  const names = Object.keys(m).sort();
  if (!names.length) {
    $('#saved-list').innerHTML = '<p><small>No saved queries yet. Use the 💾 Save button on the editor.</small></p>';
    return;
  }
  $('#saved-list').innerHTML = names.map(name => `
    <div class="saved-item" data-name="${esc(name)}">
      <span class="saved-name">${esc(name)}</span>
      <button class="saved-delete" data-del="${esc(name)}" title="Delete">✕</button>
    </div>`).join('');
  $$('#saved-list .saved-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.dataset.del) return; // let the delete button handle its own click
      const name = el.dataset.name;
      setSql(m[name]);
      focusEditor();
    });
  });
  $$('#saved-list .saved-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.del;
      if (!confirm(`Delete saved query "${name}"?`)) return;
      const m2 = savedLoad();
      delete m2[name];
      savedSave(m2);
      renderSavedList();
    });
  });
}

function saveCurrentQuery() {
  const sql = getSql().trim();
  if (!sql) { alert('Nothing to save — editor is empty.'); return; }
  const name = prompt('Save this query as:', '');
  if (!name || !name.trim()) return;
  const m = savedLoad();
  m[name.trim()] = sql;
  savedSave(m);
  renderSavedList();
  // Switch left panel to Saved so the user sees their new entry
  $$('.left-tabs > button').forEach(b => { if (b.dataset.lp === 'lp-saved') b.click(); });
}

// ================================================================ TABS
// ================================================================ DATASETS TAB
// Backed by /mesh/datasets (summary) + /mesh/datasets/{id} (full manifest).
// Both endpoints come from hitorro-mesh-datasets; when that module isn't on
// the driver's classpath, /mesh/datasets returns [] and this tab just shows
// "no installed datasets".

let dsCatalog = null;      // array of summaries from /mesh/datasets
let dsSelectedId = null;   // currently-focused dataset id

async function refreshDatasets() {
  try {
    dsCatalog = await api('/mesh/datasets');
  } catch (e) {
    $('#ds-list').innerHTML = `<p><small style="color:var(--danger)">error: ${esc(e.message)}</small></p>`;
    return;
  }
  $('#ds-count').textContent = `${dsCatalog.length} installed`;
  if (dsCatalog.length === 0) {
    $('#ds-list').innerHTML =
      '<p class="meta">No datasets installed yet.<br>' +
      'Run <code>./scripts/install-all.sh</code> in the hitorro-mesh-datasets repo.</p>';
    return;
  }
  $('#ds-list').innerHTML = dsCatalog.map(d => `
    <div class="ds-list-item ${d.id === dsSelectedId ? 'active' : ''}" data-id="${esc(d.id)}">
      <div class="name">${esc(d.title || d.id)}</div>
      <span class="meta">
        <code>${esc(d.tableName)}</code> ·
        ${esc(d.spdx || 'no-license')} ·
        ${esc(d.kind)} ·
        ${d.fields} fields
      </span>
    </div>
  `).join('');
  $$('#ds-list .ds-list-item').forEach(el => {
    el.addEventListener('click', () => selectDataset(el.dataset.id));
  });
  // Auto-select the first dataset when nothing chosen yet, so the right
  // pane isn't blank when the user first opens the tab.
  if (!dsSelectedId && dsCatalog.length > 0) selectDataset(dsCatalog[0].id);
}

async function selectDataset(id) {
  dsSelectedId = id;
  $$('#ds-list .ds-list-item').forEach(el =>
    el.classList.toggle('active', el.dataset.id === id));
  $('#ds-empty').hidden = true;
  $('#ds-selected').hidden = false;

  let manifest;
  try {
    manifest = await api('/mesh/datasets/' + encodeURIComponent(id));
  } catch (e) {
    $('#ds-schema-body').innerHTML =
      `<p><small style="color:var(--danger)">manifest fetch failed: ${esc(e.message)}</small></p>`;
    return;
  }

  const tableName = id.replace(/-/g, '_');
  const summary = (dsCatalog || []).find(d => d.id === id) || {};

  // Header + badges
  $('#ds-title').textContent = manifest.title || id;
  const spdx = manifest.license?.spdx || '';
  const licenseClass = spdx.startsWith('CC0') ? 'license-cc0'
                     : spdx.startsWith('CC-BY') ? 'license-cc-by'
                     : spdx.startsWith('Public') ? 'license-pd'
                     : spdx.startsWith('ODbL') ? 'license-odbl'
                     : '';
  $('#ds-badges').innerHTML = `
    <span class="ds-badge ${licenseClass}">${esc(spdx || 'no-license')}</span>
    <span class="ds-badge kind">${esc(summary.kind || 'unknown')}</span>
    <span class="meta">
      · table <code>${esc(tableName)}</code>
      · PK <code>${esc(manifest.record?.primaryKey || '—')}</code>
    </span>
  `;

  // Schema table — highlight fields with a role (that's the whole story
  // of semantic joins).
  const fields = manifest.record?.fields || [];
  $('#ds-schema-body').innerHTML = fields.length === 0 ? '<p class="meta">no fields declared</p>' : `
    <table>
      <thead>
        <tr><th>Name</th><th>Type</th><th>Role</th><th>Description</th></tr>
      </thead>
      <tbody>
      ${fields.map(f => `
        <tr>
          <td><code>${esc(f.name)}</code></td>
          <td>${esc(f.type || '')}</td>
          <td>${f.role ? `<span class="ds-role">${esc(f.role)}</span>` : ''}</td>
          <td>${esc(f.description || '')}</td>
        </tr>
      `).join('')}
      </tbody>
    </table>
  `;

  // Relationships — one card per declared join edge.
  const rels = manifest.relationships || [];
  $('#ds-rels-body').innerHTML = rels.length === 0 ? '<p class="meta">no relationships declared</p>' : rels.map(r => {
    const cls = (r.kind || '').toLowerCase();
    const via = Array.isArray(r.via) ? r.via.join(', ') : (r.via || '');
    return `
      <div class="ds-rel ${esc(cls)}">
        <span class="kind">${esc(r.kind)}</span>
        → <code>${esc((r.target || '').replace(/-/g, '_'))}</code>
        via <code>${esc(via)}</code>
      </div>
    `;
  }).join('');

  // Sample rows are lazy — click Refresh to fetch. Avoids hammering the
  // driver with a query per dataset click.
  $('#ds-sample-body').innerHTML = 'click Refresh to run <code>SELECT * LIMIT 10</code>';

  // Quick queries — build off the declared roles + relationships.
  $('#ds-quick').innerHTML = buildQuickQueries(tableName, manifest, rels);
  $$('#ds-quick button').forEach(b => {
    b.addEventListener('click', () => {
      // Prime Playground with this dataset's context BEFORE switching
      // tabs — so the left panel shows tuned snippets, the context
      // banner appears, and the semantic toggle turns on where useful.
      setPlaygroundDatasetContext(manifest, tableName);
      // Then drop the specific SQL into the editor.
      const sql = b.dataset.sql;
      if (typeof setSql === 'function') setSql(sql);
      // Finally switch tabs — the "click Playground tab" click.
      const pg = document.querySelector('[data-target="playground"]');
      if (pg) pg.click();
    });
  });

  // Raw manifest (for the curious / for copy-paste)
  $('#ds-raw').textContent = fmtJson(manifest);
}

function buildQuickQueries(tableName, manifest, rels) {
  const buttons = [];
  buttons.push({
    label: 'SELECT * LIMIT 20',
    sql: `SELECT * FROM ${tableName} LIMIT 20`,
  });
  const pk = manifest.record?.primaryKey;
  if (pk) {
    buttons.push({
      label: `COUNT by ${pk} …`,
      sql: `SELECT ${pk}, COUNT(*) AS n FROM ${tableName} GROUP BY ${pk} ORDER BY n DESC LIMIT 20`,
    });
  }
  // Any field with role starting id.* → group-by is usually informative
  // (country codes, network flags, etc.).
  const roleGroups = (manifest.record?.fields || []).filter(f =>
    f.role && f.role.startsWith('id.') && f.name !== pk);
  roleGroups.slice(0, 3).forEach(f => {
    buttons.push({
      label: `GROUP BY ${f.name}`,
      sql: `SELECT ${f.name}, COUNT(*) AS n FROM ${tableName} GROUP BY ${f.name} ORDER BY n DESC LIMIT 20`,
    });
  });
  // Relationships → USING PLACE join examples.
  (rels || []).filter(r => r.kind === 'EXACT_ID').slice(0, 3).forEach(r => {
    const target = (r.target || '').replace(/-/g, '_');
    buttons.push({
      label: `JOIN ${target} USING PLACE`,
      sql: `SELECT *\nFROM ${tableName} a\nJOIN ${target} b USING PLACE\nLIMIT 10`,
    });
  });
  return buttons.map(b => `
    <button data-sql="${esc(b.sql)}" title="${esc(b.sql)}">${esc(b.label)}</button>
  `).join('');
}

async function refreshSample() {
  if (!dsSelectedId) return;
  const tableName = dsSelectedId.replace(/-/g, '_');
  $('#ds-sample-body').innerHTML = '<span class="meta">running…</span>';
  try {
    const body = await api('/mesh/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: `SELECT * FROM ${tableName} LIMIT 10`, timeoutMs: 8000 }),
    });
    if (!body.rows || body.rows.length === 0) {
      $('#ds-sample-body').innerHTML = '<p class="meta">no rows</p>';
      return;
    }
    const cols = Object.keys(body.rows[0]);
    $('#ds-sample-body').innerHTML = `
      <div style="overflow-x: auto;">
        <table>
          <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${body.rows.map(r => `<tr>${cols.map(c =>
              `<td>${esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      <small class="meta">${body.rowCount} rows · queryId ${esc(body.queryId)}</small>
    `;
  } catch (e) {
    $('#ds-sample-body').innerHTML =
      `<p><small style="color:var(--danger)">${esc(e.body?.error || e.message)}</small></p>`;
  }
}

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
        if (target === 'datasets') refreshDatasets();
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
    $('#table-list').innerHTML = '<p><small>No tables registered. Use the buttons above to add one.</small></p>';
    return;
  }
  $('#table-list').innerHTML = '<div class="entity-list"><ul>' + tables.map(t => {
    const isBroadcast = t.kind === 'broadcast';
    const parts = isBroadcast
      ? '<span class="badge accent">broadcast</span>'
      : ((t.partitions || []).map(p => `<span class="cap">${esc(p.key)}</span>`).join('') || '<small>(no partitions)</small>');
    const streamBadge = t.streaming ? '<span class="badge accent">streaming</span>' : '';
    return `<li>
       <span>
         <span class="name clickable-name" data-table="${esc(t.name)}">${esc(t.name)}</span>
         ${streamBadge}
       </span>
       <span>
         ${parts}
         <button class="contrast outline delete-table"
                 data-table="${esc(t.name)}"
                 data-kind="${esc(t.kind || 'distributed')}"
                 style="width:auto;margin:0 0 0 0.5rem;font-size:0.75rem;padding:0.2rem 0.5rem;"
                 title="Deregister">✕</button>
       </span>
     </li>`;
  }).join('') + '</ul></div>';
  $$('#table-list .clickable-name').forEach(el => {
    el.addEventListener('click', () => showSchema(el.dataset.table, tables));
  });
  $$('#table-list .delete-table').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.dataset.table;
      const kind = btn.dataset.kind;
      if (!confirm(`Deregister ${kind} table "${name}"? (data on agents is not touched)`)) return;
      try {
        const path = kind === 'broadcast'
          ? '/mesh/broadcast-tables/' + encodeURIComponent(name)
          : '/mesh/tables/' + encodeURIComponent(name);
        await api(path, { method: 'DELETE' });
        refreshCluster();
        refreshTopBar();
      } catch (err) {
        alert('Failed: ' + (err.body?.message || err.message));
      }
    });
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
let tableSort = { col: null, dir: 1 };   // 1 = asc, -1 = desc

async function runPlaygroundQuery() {
  const sql = getSql().trim();
  const timeoutMs = +$('#pg-timeout').value || 5000;
  const retries = +$('#pg-retries').value || 0;
  const semantic = $('#pg-semantic').checked;
  if (!sql) return;
  $('#pg-result').hidden = false;
  $('#pg-meta').textContent = 'Running…';
  $('#pg-table-body').innerHTML = '';
  $('#pg-json').textContent = '';
  // Reset the rewrite banner — populated below only when semantic:true
  // returns a rewrittenSql distinct from the input.
  $('#pg-rewrite').hidden = true;
  $('#pg-rewrite-sql').textContent = '';
  const t0 = performance.now();
  try {
    const reqBody = { sql, timeoutMs, retries };
    if (semantic) reqBody.semantic = true;
    const body = await api('/mesh/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    const dt = Math.round(performance.now() - t0);
    const semanticTag = body.rewrittenSql ? ' · rewritten' : (semantic ? ' · semantic:pass-through' : '');
    const meta = `${body.rowCount} rows · ${dt}ms · attempts=${body.attempts}${body.timedOut ? ' · TIMED OUT' : ''}${semanticTag}`;
    $('#pg-meta').textContent = meta;
    $('#pg-table-info').textContent = `${body.rowCount} rows · queryId ${body.queryId}`;
    $('#pg-json').textContent = fmtJson(body);
    if (body.rewrittenSql) {
      // Open by default the first time so users see it fire; they can
      // collapse afterwards.
      $('#pg-rewrite').hidden = false;
      $('#pg-rewrite').open = true;
      $('#pg-rewrite-sql').textContent = body.rewrittenSql;
    }
    lastResult = body;
    tableSort = { col: null, dir: 1 };
    renderResultTable();
    populateChartControls(body.rows);
    pushHistory(sql, meta);
  } catch (e) {
    $('#pg-meta').textContent = `error: ${e.status || ''} ${e.body?.error || ''}`;
    $('#pg-json').textContent = fmtJson(e.body || { error: e.message });
    $('#pg-table-body').innerHTML = `<p><small style="color:var(--danger)">${esc(e.body?.message || e.message)}</small></p>`;
    $('#pg-table-info').textContent = 'error';
    lastResult = null;
  }
}

function renderResultTable() {
  const rows = lastResult?.rows || [];
  const body = $('#pg-table-body');
  if (!rows.length) { body.innerHTML = '<p><small>Empty result set.</small></p>'; return; }
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));

  // Apply current sort (non-destructive on lastResult.rows)
  let sortedRows = rows;
  if (tableSort.col) {
    sortedRows = rows.slice().sort((a, b) => {
      const va = a[tableSort.col];
      const vb = b[tableSort.col];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const ta = typeof va, tb = typeof vb;
      if (ta === 'number' && tb === 'number') return (va - vb) * tableSort.dir;
      return String(va).localeCompare(String(vb)) * tableSort.dir;
    });
  }

  const header = '<th class="row-num-header">#</th>' + cols.map(c => {
    const cls = tableSort.col === c ? (tableSort.dir === 1 ? 'sort-asc' : 'sort-desc') : 'sortable';
    return `<th class="${cls} sortable" data-col="${esc(c)}">${esc(c)}</th>`;
  }).join('');
  const bodyHtml = sortedRows.map((r, i) =>
    `<tr>
       <td class="row-num">${i + 1}</td>
       ${cols.map(c => `<td>${esc(fmtCell(r[c]))}</td>`).join('')}
     </tr>`).join('');
  body.innerHTML = `<div class="scroll"><table class="result"><thead><tr>${header}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;

  $$('#pg-table-body th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (tableSort.col === col) tableSort.dir = -tableSort.dir;
      else { tableSort.col = col; tableSort.dir = 1; }
      renderResultTable();
    });
  });
}

function fmtCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Simple non-sortable table renderer — used by the schema panel's sample-rows view.
function renderTable(rows) {
  if (!rows || !rows.length) return '<p><small>Empty result set.</small></p>';
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
  const header = cols.map(c => `<th>${esc(c)}</th>`).join('');
  const bodyHtml = rows.map(r => `<tr>${cols.map(c => `<td>${esc(fmtCell(r[c]))}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table class="result"><thead><tr>${header}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

// ================================================================ EXPORT
function exportCsv() {
  const rows = lastResult?.rows;
  if (!rows || !rows.length) return;
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set()));
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  download('result.csv', 'text/csv', lines.join('\n'));
}

function exportJson() {
  if (!lastResult) return;
  download('result.json', 'application/json', fmtJson(lastResult));
}

function download(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function copyJsonToClipboard() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(fmtJson(lastResult));
    const btn = $('#pg-copy-json');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch (e) {
    alert('Copy failed: ' + e.message);
  }
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

// ================================================================ LEFT PANEL TABS
function bindLeftPanelTabs() {
  $$('.left-tabs > button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.left-tabs > button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.lp-view').forEach(v => v.classList.remove('active'));
      $('#' + btn.dataset.lp).classList.add('active');
      if (btn.dataset.lp === 'lp-schema') refreshSchemaTree();
    });
  });
}

// ================================================================ CODEMIRROR
function initCodeMirror() {
  const textarea = $('#pg-sql');
  if (!textarea || typeof CodeMirror === 'undefined') return;
  cmEditor = CodeMirror.fromTextArea(textarea, {
    mode: 'text/x-sql',
    lineNumbers: true,
    matchBrackets: true,
    indentWithTabs: false,
    smartIndent: true,
    lineWrapping: true,
    extraKeys: {
      'Ctrl-Enter': runPlaygroundQuery,
      'Cmd-Enter': runPlaygroundQuery,
      'Ctrl-S': (cm) => { saveCurrentQuery(); return false; },
      'Cmd-S': (cm) => { saveCurrentQuery(); return false; },
    },
  });
}

// ================================================================ BOOT
document.addEventListener('DOMContentLoaded', () => {
  bindTabs('.tabs');
  bindTabs('.sub-tabs');
  bindLeftPanelTabs();
  initCodeMirror();
  renderSnippets();
  renderSavedList();

  $('#pg-run').addEventListener('click', runPlaygroundQuery);
  $('#pg-clear').addEventListener('click', () => {
    setSql('');
    $('#pg-result').hidden = true;
    lastResult = null;
  });
  $('#pg-explain-btn').addEventListener('click', () => {
    $('#ex-sql').value = getSql();
    $$('.tabs > button').forEach(b => { if (b.dataset.target === 'explain') b.click(); });
    runExplain();
  });
  $('#pg-save').addEventListener('click', saveCurrentQuery);
  $('#pg-export-csv').addEventListener('click', exportCsv);
  $('#pg-export-json').addEventListener('click', exportJson);
  $('#pg-copy-json').addEventListener('click', copyJsonToClipboard);
  $('#schema-refresh').addEventListener('click', refreshSchemaTree);
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
  $('#ds-sample-refresh').addEventListener('click', refreshSample);
  // Context banner buttons on the Playground.
  $('#pg-context-back').addEventListener('click', () => {
    const dsBtn = document.querySelector('[data-target="datasets"]');
    if (dsBtn) dsBtn.click();
  });
  $('#pg-context-close').addEventListener('click', clearPlaygroundDatasetContext);

  // Phase 7p — runtime table/broadcast registration forms.
  $('#add-table-btn').addEventListener('click', () => {
    $('#add-table-panel').hidden = !$('#add-table-panel').hidden;
    $('#add-broadcast-panel').hidden = true;
    if (!$('#add-table-panel').hidden) $('#add-table-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#add-broadcast-btn').addEventListener('click', () => {
    $('#add-broadcast-panel').hidden = !$('#add-broadcast-panel').hidden;
    $('#add-table-panel').hidden = true;
    if (!$('#add-broadcast-panel').hidden) $('#add-broadcast-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#add-table-close').addEventListener('click', () => { $('#add-table-panel').hidden = true; });
  $('#add-broadcast-close').addEventListener('click', () => { $('#add-broadcast-panel').hidden = true; });

  $('#new-table-submit').addEventListener('click', async () => {
    const name = $('#new-table-name').value.trim();
    const typeJson = $('#new-table-type').value.trim();
    const partsStr = $('#new-table-partitions').value.trim();
    const status = $('#new-table-status');
    if (!name || !typeJson || !partsStr) {
      status.textContent = 'error: name, typeJson, and partitions all required';
      return;
    }
    const partitions = partsStr.split(',').map(k => ({ key: k.trim() })).filter(p => p.key);
    status.textContent = 'registering…';
    try {
      const body = await api('/mesh/tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, typeJson, partitions }),
      });
      status.textContent = `registered ${body.registered} (${body.partitions} partitions)`;
      $('#new-table-name').value = '';
      $('#new-table-type').value = '';
      $('#new-table-partitions').value = '';
      $('#add-table-panel').hidden = true;
      refreshCluster();
      refreshTopBar();
    } catch (e) {
      status.textContent = 'error: ' + (e.body?.message || e.message);
    }
  });

  $('#new-broadcast-submit').addEventListener('click', async () => {
    const name = $('#new-broadcast-name').value.trim();
    const status = $('#new-broadcast-status');
    if (!name) { status.textContent = 'error: name required'; return; }
    status.textContent = 'registering…';
    try {
      const body = await api('/mesh/broadcast-tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      status.textContent = 'registered ' + body.registered;
      $('#new-broadcast-name').value = '';
      $('#add-broadcast-panel').hidden = true;
      refreshCluster();
      refreshTopBar();
    } catch (e) {
      status.textContent = 'error: ' + (e.body?.message || e.message);
    }
  });

  renderHistory();
  refreshTopBar();
  refreshCluster();
  refreshSparklines();
  setInterval(refreshTopBar, 5000);
  setInterval(refreshSparklines, 5000);
  armActiveAutoRefresh();
});
