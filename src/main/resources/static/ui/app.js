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

// Set to a win-context object when the user arrived at Playground via a
// "Try in Playground" button on the wins panel. Mutually exclusive with
// pgDatasetContext — setting one clears the other.
// Shape: { win: {...raw win...}, snippets: [{name, desc, sql}] }.
let pgWinContext = null;

function renderSnippets() {
  // Win-tuned mode: shows the win's own SQL, one Peek-per-dataset, and
  // related wins that share ≥1 dataset with the active one. Takes priority
  // over dataset context because a win spans several datasets — the single-
  // dataset-tuned snippets would be misleading here.
  if (pgWinContext) {
    const ctx = pgWinContext;
    $('#snippet-list').innerHTML = `
      <div class="snippet-category">${esc(ctx.win.title)}</div>
      ${ctx.snippets.map((s, i) => `
        <div class="snippet-item" data-winidx="${i}">
          <div class="snippet-name">${esc(s.name)}</div>
          <div class="snippet-desc">${esc(s.desc)}</div>
        </div>`).join('')}
    `;
    $$('#snippet-list .snippet-item').forEach(el => {
      el.addEventListener('click', () => {
        const s = ctx.snippets[+el.dataset.winidx];
        setSql(s.sql);
        if (s.semantic != null) $('#pg-semantic').checked = !!s.semantic;
        focusEditor();
      });
    });
    return;
  }

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
  pgWinContext = null;   // mutually exclusive

  $('#pg-context-name').textContent = manifest.title || tableName;
  $('#pg-context-kind').textContent = '▶ Playing with';
  $('#pg-context-meta').textContent = '— snippets + schema tuned to this dataset';
  $('#pg-context').hidden = false;
  // Ensure the Snippets sub-tab is open so the tuned list is visible.
  const lpSnippetsBtn = document.querySelector('[data-lp="lp-snippets"]');
  if (lpSnippetsBtn && !lpSnippetsBtn.classList.contains('active')) lpSnippetsBtn.click();
  renderSnippets();
  // Also flip the semantic toggle on — most of the tuned snippets are
  // USING PLACE joins that only work with it on.
  $('#pg-semantic').checked = true;
}

/**
 * Called by the Datasets tab's wins-panel "Try in Playground" buttons
 * before switching tabs. Records win context, populates snippets that
 * make sense at the intersection of several datasets (the win's SQL,
 * a Peek per involved dataset, related wins).
 *
 * @param win     the raw win object from /mesh/datasets/wins
 * @param allWins the full wins array — used to derive related wins
 */
function setPlaygroundWinContext(win, allWins) {
  const involved = new Set(win.datasets || []);
  const snippets = [];

  // The win itself — top of the list so re-clicking the snippet
  // re-drops the exact SQL if you scrolled elsewhere in the editor.
  snippets.push({
    name: `▶ ${win.title}`,
    desc: 'the query you just loaded',
    sql: win.sql,
    semantic: !!win.semantic,
  });

  // A Peek per involved dataset — quick "what's in this table?".
  // Uses the SQL table name (snake_case of id) that the mesh registers.
  (win.datasets || []).forEach(dsId => {
    const tableName = dsId.replace(/-/g, '_');
    snippets.push({
      name: `Peek ${tableName}`,
      desc: `SELECT * FROM ${tableName} LIMIT 10`,
      sql: `SELECT * FROM ${tableName} LIMIT 10`,
      semantic: false,
    });
  });

  // Related wins — any other win sharing ≥ 1 dataset with the active one.
  // Sorted by number of shared datasets DESC then title, so the most
  // related surfaces first.
  const related = (allWins || [])
    .filter(w => w !== win)
    .map(w => ({
      w,
      shared: (w.datasets || []).filter(d => involved.has(d)).length,
    }))
    .filter(x => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.w.title.localeCompare(b.w.title));
  related.forEach(({ w, shared }) => {
    snippets.push({
      name: `⇢ ${w.title}`,
      desc: `${w.kind} · ${w.hops}-hop · shares ${shared} dataset${shared > 1 ? 's' : ''}`,
      sql: w.sql,
      semantic: !!w.semantic,
    });
  });

  pgWinContext = { win, snippets };
  pgDatasetContext = null;   // mutually exclusive

  const chipRow = (win.datasets || []).map(d => `<code>${esc(d)}</code>`).join(' → ');
  $('#pg-context-name').innerHTML = `${esc(win.title)} <span class="meta">${chipRow}</span>`;
  $('#pg-context-kind').textContent = '▶ Exploring cross-dataset join:';
  $('#pg-context-meta').textContent = win.note ? win.note.split('\n')[0] : '';
  $('#pg-context').hidden = false;
  const lpSnippetsBtn = document.querySelector('[data-lp="lp-snippets"]');
  if (lpSnippetsBtn && !lpSnippetsBtn.classList.contains('active')) lpSnippetsBtn.click();
  renderSnippets();
  $('#pg-semantic').checked = !!win.semantic;
}

function clearPlaygroundDatasetContext() {
  pgDatasetContext = null;
  pgWinContext = null;
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
// Wins are static-per-jar; load once per Datasets-tab activation.
let dsWinsLoaded = false;

async function loadWins() {
  if (dsWinsLoaded) return;
  dsWinsLoaded = true;
  let wins = [];
  try { wins = await api('/mesh/datasets/wins'); } catch (_) {}
  const panel = $('#ds-wins-panel');
  const grid = $('#ds-wins-grid');
  const count = $('#ds-wins-count');
  if (!wins || wins.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  count.textContent = `${wins.length} curated cross-dataset queries`;
  grid.innerHTML = wins.map((w, i) => `
    <div class="ds-win-card" data-idx="${i}">
      <div class="ds-win-hdr">
        <span class="ds-win-kind ds-win-kind-${esc(w.kind)}">${esc(w.kind)}</span>
        <span class="ds-win-hops">${w.hops}-hop</span>
        <span class="ds-win-license ds-win-license-${esc((w.license||'').replace(/[^a-z]/g,'-'))}">${esc(w.license || '')}</span>
      </div>
      <div class="ds-win-title">${esc(w.title)}</div>
      <div class="ds-win-datasets">
        ${(w.datasets || []).map(d => `<code>${esc(d)}</code>`).join(' → ')}
      </div>
      ${w.note ? `<div class="ds-win-note">${esc(w.note)}</div>` : ''}
      <div class="ds-win-actions">
        <button class="secondary outline ds-win-try" title="send SQL to the Playground editor">▶ Try in Playground</button>
      </div>
    </div>
  `).join('');
  $$('.ds-win-card .ds-win-try').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      const w = wins[i];
      // Prime the Playground left panel with THIS win's context —
      // the win SQL as snippet #1, a Peek per involved dataset,
      // then related wins that share ≥ 1 dataset. Without this the
      // Snippets panel would keep whatever it was before (single-
      // dataset snippets or the generic library), which reads to a
      // user as "the Playground didn't tune to my join".
      setPlaygroundWinContext(w, wins);
      if (typeof setSql === 'function') setSql(w.sql);
      const pg = document.querySelector('[data-target="playground"]');
      if (pg) pg.click();
    });
  });
  $('#ds-wins-toggle').addEventListener('click', () => {
    const hidden = grid.style.display === 'none';
    grid.style.display = hidden ? '' : 'none';
    $('#ds-wins-toggle').textContent = hidden ? 'Hide' : 'Show';
  });
}

async function refreshDatasets() {
  loadWins();  // parallel — doesn't block dataset list
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
  // Group by category (same buckets as the Cluster tab's catalog view)
  // so users can scan the list by topic instead of one long alphabetic
  // wall. Category comes from /mesh/datasets (added server-side via
  // DatasetCatalogController.categoryFor).
  const groupLabels = {
    geographic:    'Geographic',
    codification:  'Codification & standards',
    scholarly:     'Scholarly',
    reference:     'Reference',
    'time-series': 'Time-series',
    other:         'Other',
  };
  const order = ['geographic', 'codification', 'scholarly', 'reference', 'time-series', 'other'];
  const byCat = {};
  for (const d of dsCatalog) {
    const c = d.category || 'other';
    (byCat[c] ||= []).push(d);
  }
  const parts = [];
  for (const c of order) {
    const items = byCat[c];
    if (!items || !items.length) continue;
    items.sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
    parts.push(`<details class="catalog-group" open>
      <summary>${esc(groupLabels[c] || c)}
        <span class="badge">${items.length}</span></summary>
      <div>${items.map(d => `
        <div class="ds-list-item ${d.id === dsSelectedId ? 'active' : ''}" data-id="${esc(d.id)}">
          <div class="name">${esc(d.title || d.id)}</div>
          <span class="meta">
            <code>${esc(d.tableName)}</code> ·
            ${esc(d.spdx || 'no-license')} ·
            ${esc(d.kind)} ·
            ${d.fields} fields
          </span>
        </div>`).join('')}</div>
    </details>`);
  }
  $('#ds-list').innerHTML = parts.join('');
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
  const shareAlike = manifest.license?.shareAlike === true;
  const attribReq = manifest.license?.attributionRequired === true;
  $('#ds-badges').innerHTML = `
    <span class="ds-badge ${licenseClass}">${esc(spdx || 'no-license')}</span>
    <span class="ds-badge kind">${esc(summary.kind || 'unknown')}</span>
    ${shareAlike ? '<span class="ds-badge license-odbl" title="Any join result inherits this share-alike obligation as a database">⚠ share-alike</span>' : ''}
    ${attribReq  ? '<span class="ds-badge license-cc-by" title="Redistributions must credit the source">© attribution required</span>' : ''}
    <span class="meta">
      · table <code>${esc(tableName)}</code>
      · PK <code>${esc(manifest.record?.primaryKey || '—')}</code>
    </span>
  `;

  // Prominent share-alike callout below the header — surfaces the
  // obligation the LicenseAlgebra would raise if this dataset joined
  // anything else. See docs/LICENSE_ALGEBRA.md.
  const oldNotice = document.getElementById('ds-license-notice');
  if (oldNotice) oldNotice.remove();
  if (shareAlike) {
    const notice = document.createElement('div');
    notice.id = 'ds-license-notice';
    notice.style.cssText =
        'margin-top: 0.75rem; padding: 0.6rem 0.75rem; background: #fef3f2;' +
        'border-left: 3px solid #C0392B; border-radius: 0.25rem; font-size: 0.85rem;';
    notice.innerHTML =
        `<strong>Share-alike source (${esc(spdx)})</strong> — any joined ` +
        `result inherits share-alike as a database. If you plan to ` +
        `redistribute a result that touches ` +
        `<code>${esc(tableName)}</code>, you probably have to release it ` +
        `under the same terms. Not legal advice; see ` +
        `<a href="https://opendatacommons.org/licenses/odbl/" target="_blank">ODbL text</a>.`;
    $('#ds-selected').querySelector('header').after(notice);
  }

  // "About this dataset" block — rendered from manifest.metadata when
  // present. Skipped entirely on datasets without a metadata block so
  // they read exactly as before.
  renderDatasetMetadata(manifest);

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

/**
 * Render the "About this dataset" section from manifest.metadata.
 * Silently skips if no metadata block exists.
 * Anchors to a single #ds-about container inserted below the header
 * (removed and re-created every time so the pane fully reflects the
 * currently-selected dataset).
 */
function renderDatasetMetadata(manifest) {
  const md = manifest.metadata;
  const old = document.getElementById('ds-about');
  if (old) old.remove();
  if (!md) return;

  const stats = md.stats || {};
  // Prefer live install-time stats over the hand-maintained manifest
  // numbers whenever an installed.json exists on the driver — those
  // numbers refresh every time the install script runs and never drift.
  // Falls back to the manifest's curated baseline when nothing is
  // installed yet (fresh clone, dataset not scoped in).
  const installed = manifest.installed || {};
  const liveRows = installed.rowCount != null;
  const liveSize = installed.sizeBytes != null;
  const rowsLabel = liveRows
      ? Number(installed.rowCount).toLocaleString()
      : (stats.rowCount != null ? Number(stats.rowCount).toLocaleString() : '—');
  const sizeLabel = liveSize
      ? humanBytes(installed.sizeBytes)
      : (stats.sizeBytes != null ? humanBytes(stats.sizeBytes) : '—');
  const cadenceLabel = stats.refreshCadence || '—';
  const coverageLabel = stats.coverage || '';
  const installedAtLabel = installed.installedAt ? relativeTime(installed.installedAt) : '';

  const useCasesHtml = (md.useCases || []).length === 0 ? '' : `
    <div class="ds-about-block">
      <h5>What's it for?</h5>
      <ul>${md.useCases.map(u => `<li>${esc(u)}</li>`).join('')}</ul>
    </div>`;
  const methodologyHtml = !md.methodology ? '' : `
    <div class="ds-about-block">
      <h5>How is it collected?</h5>
      <p>${esc(md.methodology)}</p>
    </div>`;
  const readMoreHtml = !md.furtherReading ? '' : `
    <div class="ds-about-block">
      <a href="${esc(md.furtherReading)}" target="_blank" rel="noopener">Further reading →</a>
    </div>`;

  const about = document.createElement('div');
  about.id = 'ds-about';
  about.className = 'ds-about ds-section';
  // Small "· live" badge next to the number when it came from installed.json
  // rather than the manifest's curated baseline. Users learn to trust the
  // number more when they see it's tracking reality.
  const liveBadge = '<span class="ds-live-badge" title="live from installed.json">live</span>';
  about.innerHTML = `
    <h4>About this dataset ${installedAtLabel ? `<small class="meta">— ${esc(installedAtLabel)}</small>` : ''}</h4>
    <div class="ds-stats-grid">
      <div><span class="ds-stat-num">${rowsLabel}${liveRows ? ' ' + liveBadge : ''}</span><span class="ds-stat-label">rows</span></div>
      <div><span class="ds-stat-num">${sizeLabel}${liveSize ? ' ' + liveBadge : ''}</span><span class="ds-stat-label">size</span></div>
      <div><span class="ds-stat-num">${esc(cadenceLabel)}</span><span class="ds-stat-label">refresh</span></div>
      ${coverageLabel ? `<div style="grid-column: 1 / -1;"><span class="ds-stat-label">coverage:</span> ${esc(coverageLabel)}</div>` : ''}
    </div>
    ${useCasesHtml}
    ${methodologyHtml}
    ${readMoreHtml}
  `;
  // Insert after the header (and the license-notice, if it was added).
  const header = $('#ds-selected').querySelector('header');
  const licenseNotice = document.getElementById('ds-license-notice');
  (licenseNotice || header).after(about);
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

/**
 * "installed 3 days ago" style label from an ISO-8601 UTC timestamp.
 * Deliberately coarse — no minutes-past-the-hour precision. Reader
 * cares about "recent" vs "stale", not to-the-second freshness.
 */
function relativeTime(isoStr) {
  const t = new Date(isoStr).getTime();
  if (isNaN(t)) return '';
  const ageMs = Date.now() - t;
  const min = 60 * 1000, hr = 60 * min, day = 24 * hr;
  if (ageMs < min)      return 'installed just now';
  if (ageMs < hr)       return `installed ${Math.round(ageMs / min)}m ago`;
  if (ageMs < day)      return `installed ${Math.round(ageMs / hr)}h ago`;
  if (ageMs < 30 * day) return `installed ${Math.round(ageMs / day)}d ago`;
  const months = Math.round(ageMs / (30 * day));
  return `installed ${months} month${months === 1 ? '' : 's'} ago`;
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
        if (target === 'pipelines') refreshPipelines();
        if (target === 'mesh') refreshMeshViz();
        if (target === 'search') refreshSearchTab();
        if (target === 'fleet') refreshFleetTab();
        if (target === 'jobs') refreshJobsTab();
      } else if (btn.dataset.view) {
        // Scope view-panel toggling to the nearest section OR article. Playground
        // uses article-scoped views (table/chart/json); Pipelines uses section-
        // scoped sub-tabs (Build/Run/History/Docs).
        const scope = btn.closest('section, article');
        $$('.view', scope).forEach(v => v.classList.remove('active'));
        $('#' + target, scope).classList.add('active');
        if (target === 'pg-chart') renderChart();
        if (target === 'pl-build')    refreshPlBuilder();
        if (target === 'pl-run')      refreshPipelines();
        if (target === 'pl-history')  refreshPlHistory();
        if (target === 'pl-docs')     refreshPlDocs();
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
    const [health, agents, tables, cluster, catalog, storage] = await Promise.all([
      api('/actuator/health').catch(() => ({ status: 'UNKNOWN' })),
      api('/mesh/agents'),
      api('/mesh/tables'),
      api('/mesh/cluster').catch(e => ({ error: e.message })),
      api('/mesh/catalog').catch(() => null),
      api('/mesh/storage').catch(() => null),
    ]);
    renderHealthFriendly(health);
    renderClusterFriendly(cluster);
    renderAgents(agents, cluster);
    renderTables(tables);
    if (catalog) renderCatalog(catalog);
    if (storage) renderStorage(storage);
    $('#health-json').textContent = fmtJson(health);
    $('#cluster-json').textContent = fmtJson(cluster);
  } catch (e) {
    $('#cluster-friendly').innerHTML = `<div class="cluster-status-callout err"><p class="title">Error loading cluster</p><p>${esc(e.message)}</p></div>`;
  }
}

/** Renders the Storage layer card on the Cluster tab. */
function renderStorage(s) {
  const backendEl = $('#storage-backend-badge');
  const summaryEl = $('#storage-summary');
  const matrixEl  = $('#storage-dataset-matrix');
  if (!backendEl || !summaryEl || !matrixEl) return;

  const local = s.localBackend || {};
  const s3    = s.s3Backend;

  // Backend badge — "local", "s3+local", or "local (no S3)".
  let badge;
  if (s3) {
    badge = s3.reachable ? 'MinIO / S3 + local' : 'local (S3 configured but unreachable)';
    backendEl.className = s3.reachable ? 'badge success' : 'badge warning';
  } else {
    badge = 'local only';
    backendEl.className = 'badge';
  }
  backendEl.textContent = badge;

  // Summary block.
  const parts = [];
  parts.push(`<div><b>Local</b> · <code>${esc(local.root || '?')}</code>`
    + (local.exists
        ? ` · ${(local.files || 0).toLocaleString()} files · ${humanBytes(local.bytes || 0)}`
        : ' · <span style="color:var(--danger)">does not exist</span>')
    + '</div>');
  if (s3) {
    parts.push(`<div><b>MinIO / S3</b> · <code>${esc(s3.endpoint)}</code>`
      + ` · bucket <code>${esc(s3.bucket)}</code>`
      + ` · ssl=${s3.ssl}`
      + ` · reachable=${s3.reachable}</div>`);
  } else {
    parts.push('<div class="meta">MinIO / S3 not configured. Set '
      + '<code>HITORRO_STORAGE_S3_ENDPOINT</code> et al. and restart the driver '
      + 'to enable S3-backed reads/writes. See <a href="../scripts/minio/minio-up.sh" '
      + 'title="hitorro-mesh-examples/scripts/minio/">minio-up.sh</a>.</div>');
  }
  summaryEl.innerHTML = parts.join('');

  // Per-dataset local/s3 matrix. Only shown when S3 is configured — no
  // point comparing when there's only one backend.
  const rows = s.datasets || [];
  let matrixHtml = '';
  if (s3 && rows.length) {
    matrixHtml = `
      <details>
        <summary><b>Dataset presence</b> <small class="meta">local vs MinIO</small></summary>
        <table style="width:100%;font-size:0.85rem;margin-top:0.4rem;">
          <thead><tr>
            <th style="text-align:left;padding:0.2rem 0.4rem;">dataset</th>
            <th style="text-align:center;padding:0.2rem 0.4rem;">local</th>
            <th style="text-align:center;padding:0.2rem 0.4rem;">MinIO</th>
          </tr></thead>
          <tbody>
          ${rows.map(r => `
            <tr>
              <td style="padding:0.2rem 0.4rem;"><code>${esc(r.id)}</code></td>
              <td style="text-align:center;padding:0.2rem 0.4rem;">${r.local ? '✅' : '·'}</td>
              <td style="text-align:center;padding:0.2rem 0.4rem;">${r.s3    ? '✅' : '·'}</td>
            </tr>
          `).join('')}
          </tbody>
        </table>
        <p class="meta" style="margin:0.4rem 0 0;">
          Ship any local-only dataset up with
          <code>hitorro-mesh-examples/scripts/minio/minio-sync-datasets.sh</code>.
        </p>
      </details>`;
  }

  // Storage browser — click into the S3 bucket or local datasets root.
  // Backed by /mesh/storage/browse?path=… which uses BaseFile so local
  // dirs and S3 prefixes walk uniformly. Renders inside its own <details>
  // so the card stays compact until you want to peek.
  matrixHtml += `
    <details open style="margin-top:0.5rem;">
      <summary><b>Browse</b> <small class="meta">walk the storage tree</small></summary>
      <div id="storage-browser" style="margin-top:0.4rem;">
        <div id="storage-crumbs" class="meta"
             style="font-family:ui-monospace,monospace;font-size:0.8rem;margin-bottom:0.3rem;"></div>
        <div id="storage-entries">loading…</div>
      </div>
    </details>`;
  matrixEl.innerHTML = matrixHtml;

  // Kick off the browser at the default root (server picks the S3 bucket
  // when configured, else HITORRO_DATASETS_HOME).
  browseStorage('');
}

async function browseStorage(path) {
  const crumbsEl  = $('#storage-crumbs');
  const entriesEl = $('#storage-entries');
  if (!crumbsEl || !entriesEl) return;
  entriesEl.innerHTML = '<small class="meta">loading…</small>';
  try {
    const q = path ? '?path=' + encodeURIComponent(path) : '';
    const r = await api('/mesh/storage/browse' + q);
    const resolved = r.resolved || '(root)';

    // Breadcrumb — trim the scheme prefix for readability, split remainder.
    // `file:` URIs keep an absolute path after the scheme (`file:/Users/…`),
    // so `acc` must preserve that leading `/`; `s3://bucket/…` treats the
    // first segment as the bucket and re-adds `//` after the scheme.
    let display = resolved;
    let scheme  = '';
    let sep     = '';
    for (const p of ['s3://', 'http://', 'https://', 'file:']) {
      if (display.startsWith(p)) {
        scheme  = p;
        sep     = p.endsWith('//') ? '' : (display.charAt(p.length) === '/' ? '/' : '');
        display = display.substring(p.length + sep.length);
        break;
      }
    }
    const parts = display.split('/').filter(Boolean);
    const crumbs = [`<a href="#" data-path="">${esc(scheme || '/')}</a>`];
    let acc = scheme + sep;
    parts.forEach((p, i) => {
      acc += p + (i < parts.length - 1 || display.endsWith('/') ? '/' : '');
      crumbs.push(` / <a href="#" data-path="${esc(acc)}">${esc(p)}</a>`);
    });
    crumbsEl.innerHTML = crumbs.join('')
      + (r.parent
          ? ` &nbsp;<a href="#" data-path="${esc(r.parent)}" style="float:right;">↑ up</a>`
          : '');
    crumbsEl.querySelectorAll('a[data-path]').forEach(a =>
      a.addEventListener('click', ev => {
        ev.preventDefault();
        browseStorage(a.dataset.path);
      }));

    const entries = r.entries || [];
    if (!entries.length) {
      entriesEl.innerHTML = '<small class="meta">empty</small>';
      return;
    }
    entriesEl.innerHTML = `<table style="width:100%;font-size:0.85rem;">
      <tbody>
      ${entries.map(e => `
        <tr>
          <td style="padding:0.15rem 0.4rem;">
            ${e.isDir
              ? `<a href="#" data-path="${esc(joinPath(resolved, e.name))}">📁 ${esc(e.name)}/</a>`
              : `📄 ${esc(e.name)}`}
          </td>
          <td style="padding:0.15rem 0.4rem;text-align:right;color:#888;">
            ${e.isDir ? '' : humanBytes(e.size)}
          </td>
        </tr>`).join('')}
      </tbody></table>`;
    entriesEl.querySelectorAll('a[data-path]').forEach(a =>
      a.addEventListener('click', ev => {
        ev.preventDefault();
        browseStorage(a.dataset.path);
      }));
  } catch (e) {
    entriesEl.innerHTML = `<small style="color:var(--danger)">${esc(e.message || e)}</small>`;
  }
}

/** Join a base URI with a child name — handles s3:// and file:/ uniformly. */
function joinPath(base, name) {
  return base.endsWith('/') ? base + name + '/' : base + '/' + name + '/';
}

/** kB / MB / GB with one decimal. */
function humanBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB','MB','GB','TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}

// Full dataset catalog view on the Cluster tab — grouped by category,
// shows installed vs catalog-only with a clear visual, and provides
// per-dataset actions (open in Datasets tab / jump to Playground /
// copy install command). Backed by /mesh/catalog which merges the
// shipped manifest set with a scan of $HITORRO_DATASETS_HOME.
let _lastCatalog = null;
function renderCatalog(cat) {
  _lastCatalog = cat;
  const installedOnly = $('#catalog-installed-only')?.checked;
  const totals = cat.counts?._total || {};
  $('#catalog-total-badge').textContent =
      `${totals.installed ?? 0} / ${totals.total ?? 0}`;

  const groupLabels = {
    geographic:    'Geographic',
    codification:  'Codification & standards',
    scholarly:     'Scholarly',
    reference:     'Reference',
    'time-series': 'Time-series',
    other:         'Other',
  };

  const parts = [];
  for (const [groupKey, items] of Object.entries(cat.groups || {})) {
    const filtered = installedOnly ? items.filter(i => i.installed) : items;
    if (!filtered.length) continue;
    parts.push(`<details class="catalog-group" open>
      <summary>${esc(groupLabels[groupKey] || groupKey)}
        <span class="badge">${filtered.length}</span></summary>
      <ul class="catalog-items">
        ${filtered.map(catalogRowHtml).join('')}
      </ul>
    </details>`);
  }
  $('#catalog-list').innerHTML =
      parts.join('') || '<p><small>No datasets to show.</small></p>';

  $$('#catalog-list .catalog-item').forEach(li => {
    li.addEventListener('click', ev => {
      if (ev.target.closest('button, a')) return;
      openCatalogDetail(li.dataset.dsId);
    });
  });
  $$('#catalog-list .catalog-open-datasets').forEach(b => {
    b.addEventListener('click', () => jumpToDatasetsTab(b.dataset.dsId));
  });
  $$('#catalog-list .catalog-open-playground').forEach(b => {
    b.addEventListener('click', () => jumpToPlayground(b.dataset.dsId));
  });
}

function catalogRowHtml(d) {
  const dotCls = d.installed ? 'installed' : 'catalog';
  const kindBadge = d.installed
    ? (d.broadcast
        ? '<span class="badge accent" title="This dataset ships as a broadcast table — same rows replicated at every agent. Cheap JOIN target.">broadcast</span>'
        : `<span class="cap" title="Partitioned distributed table. partitionBy=${esc(d.partitionBy || '')}.">partitioned</span>`)
    : '<span class="cap" title="Not installed — run the install command to fetch data and register the table.">catalog</span>';
  const actions = d.installed
    ? `<button class="secondary outline catalog-open-playground" data-ds-id="${esc(d.id)}"
               style="width:auto;margin:0;font-size:0.7rem;padding:0.15rem 0.5rem;"
               title="Open Playground with this dataset preloaded — schema + one-click SQL snippets.">Playground</button>`
    : `<button class="secondary outline catalog-open-datasets" data-ds-id="${esc(d.id)}"
               style="width:auto;margin:0;font-size:0.7rem;padding:0.15rem 0.5rem;"
               title="See full manifest + install instructions in the Datasets tab.">How to install</button>`;
  return `<li class="catalog-item" data-ds-id="${esc(d.id)}"
              title="${esc(d.description || d.title || d.id)}">
    <span class="catalog-item-main">
      <span class="cat-legend-dot ${dotCls}"></span>
      <span class="catalog-item-name">${esc(d.title || d.id)}</span>
      <span class="meta catalog-item-id">${esc(d.tableName || d.id)}</span>
    </span>
    <span class="catalog-item-actions">
      ${kindBadge}
      ${actions}
    </span>
  </li>`;
}

function openCatalogDetail(id) {
  if (!_lastCatalog) return;
  let hit = null;
  for (const items of Object.values(_lastCatalog.groups || {})) {
    hit = items.find(i => i.id === id);
    if (hit) break;
  }
  if (!hit) return;
  $('#catalog-detail-name').textContent = hit.title || hit.id;
  $('#catalog-detail-cat').textContent = hit.category || '?';
  const inst = $('#catalog-detail-installed');
  inst.textContent = hit.installed ? 'installed' : 'catalog-only';
  inst.className = hit.installed ? 'badge success' : 'badge';
  $('#catalog-detail-desc').textContent = hit.description || '';
  const hint = $('#catalog-detail-install-hint');
  if (hit.installed) {
    hint.hidden = true;
  } else {
    hint.hidden = false;
    $('#catalog-detail-install-cmd').textContent =
        `cd hitorro-mesh-datasets && ./scripts/${hit.installScript}`;
  }
  $('#catalog-detail-schema').innerHTML = hit.fieldCount
    ? `<p><small class="meta">${hit.fieldCount} fields · table name <code>${esc(hit.tableName || hit.id)}</code></small></p>`
    : '';
  const dlg = $('#catalog-detail-dialog');
  $('#catalog-detail-playground').onclick = () => { dlg.close(); jumpToPlayground(hit.id); };
  $('#catalog-detail-datasets').onclick   = () => { dlg.close(); jumpToDatasetsTab(hit.id); };
  dlg.showModal();
}

function jumpToDatasetsTab(id) {
  const btn = document.querySelector('button[role="tab"][data-target="datasets"]');
  if (btn) btn.click();
  // Best-effort — the Datasets tab exposes selectDataset(id) on the
  // in-page dataset list; if it isn't wired for this id yet, the tab
  // still opens on the full list.
  setTimeout(() => {
    if (typeof selectDataset === 'function') selectDataset(id);
    const link = document.querySelector(`[data-dataset-id="${CSS.escape(id)}"]`);
    if (link) link.click();
  }, 100);
}

// Jump straight from a Registered-tables row into Playground with a
// SELECT against that table typed into the editor. Uses the table name
// as-is (matches the mesh SQL surface: table names are the snake_cased
// dataset ids). Best-effort tries to load the matching manifest to
// prime dataset-tuned snippets on the left; if the table isn't a
// registered dataset (e.g. runtime-added), we just drop the SQL.
function openTableInPlayground(tableName) {
  (async () => {
    const dsId = tableName.replace(/_/g, '-');
    try {
      const m = await api('/mesh/datasets/' + encodeURIComponent(dsId));
      if (typeof setPlaygroundDatasetContext === 'function') {
        setPlaygroundDatasetContext(m, tableName);
      }
    } catch (_) { /* not a manifest-backed table — fine */ }
    const sql = `SELECT * FROM ${tableName} LIMIT 20`;
    if (typeof setSql === 'function') setSql(sql);
    const btn = document.querySelector('button[role="tab"][data-target="playground"]');
    if (btn) btn.click();
  })();
}

function jumpToPlayground(id) {
  (async () => {
    try {
      const m = await api('/mesh/datasets/' + encodeURIComponent(id));
      // Prime the playground with dataset-tuned snippets BEFORE the
      // tab switch, mirroring the flow used from the Datasets tab's
      // quick-query buttons.
      const tableName = (m.id || id).replaceAll('-', '_');
      if (typeof setPlaygroundDatasetContext === 'function') {
        setPlaygroundDatasetContext(m, tableName);
      }
    } catch (_) { /* dataset not installed → fall through, just switch tab */ }
    const btn = document.querySelector('button[role="tab"][data-target="playground"]');
    if (btn) btn.click();
  })();
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
  // Datasets that ship as broadcast get double-registered by the
  // datasets auto-registrar (registerBroadcast + registerBroadcastAsDistributed
  // — the latter so scans can hit them, not just JOINs). Users only care
  // that the name exists — collapse duplicates into a single row that
  // reports BOTH available shapes.
  const byName = new Map();
  for (const t of tables) {
    const cur = byName.get(t.name);
    if (!cur) { byName.set(t.name, {...t, kinds: [t.kind]}); continue; }
    if (!cur.kinds.includes(t.kind)) cur.kinds.push(t.kind);
    // Prefer the distributed entry's partition list when merging.
    if (t.kind === 'distributed' && (t.partitions || []).length) {
      cur.partitions = t.partitions;
    }
  }
  const merged = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  $('#table-count-inline').textContent =
      merged.length === tables.length
        ? String(merged.length)
        : `${merged.length} (${tables.length} raw registrations)`;

  if (!merged.length) {
    $('#table-list').innerHTML = '<p><small>No tables registered. Use the buttons above to add one.</small></p>';
    return;
  }
  $('#table-list').innerHTML = '<div class="entity-list"><ul>' + merged.map(t => {
    const isBroadcast = t.kinds.includes('broadcast');
    const isDistributed = t.kinds.includes('distributed');
    let kindBadges = '';
    if (isBroadcast) {
      kindBadges += '<span class="badge accent" title="Broadcast table: the SAME rows are replicated at every agent. Use for small dimension tables — JOINs against them are local at each agent (no shuffle).">broadcast</span>';
    }
    if (isDistributed) {
      const parts = (t.partitions || [])
          .map(p => `<span class="cap" title="Partition key '${esc(p.key)}' — routed to the agent holding this slice.">${esc(p.key)}</span>`)
          .join('');
      kindBadges += parts || '<small title="Distributed with a single scan partition.">(scan)</small>';
    }
    const streamBadge = t.streaming ? '<span class="badge accent" title="Streaming table: agents watch it live via NATS/Kafka.">streaming</span>' : '';
    return `<li>
       <span>
         <span class="name clickable-name" data-table="${esc(t.name)}">${esc(t.name)}</span>
         ${streamBadge}
       </span>
       <span>
         ${kindBadges}
         <button class="secondary outline table-open-playground"
                 data-table="${esc(t.name)}"
                 style="width:auto;margin:0 0 0 0.4rem;font-size:0.7rem;padding:0.15rem 0.5rem;"
                 title="Open Playground with a SELECT against this table.">▶ Playground</button>
         <button class="contrast outline delete-table"
                 data-table="${esc(t.name)}"
                 data-kind="${esc(isBroadcast && !isDistributed ? 'broadcast' : 'distributed')}"
                 style="width:auto;margin:0 0 0 0.35rem;font-size:0.75rem;padding:0.2rem 0.5rem;"
                 title="Deregister">✕</button>
       </span>
     </li>`;
  }).join('') + '</ul></div>';
  $$('#table-list .clickable-name').forEach(el => {
    el.addEventListener('click', () => showSchema(el.dataset.table, tables));
  });
  $$('#table-list .table-open-playground').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      openTableInPlayground(btn.dataset.table);
    });
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

/**
 * Live-preview where a bare-name write will land. Called as user types
 * in the path input + toggles the format dropdown; hits
 * /mesh/queries/write/resolve which knows the S3 bucket if configured.
 */
async function updateWriteResolvedHint() {
  const hintEl = $('#pg-write-resolved-hint');
  if (!hintEl) return;
  const path   = ($('#pg-write-path').value || '').trim();
  const format = $('#pg-write-format').value;
  if (!path) {
    hintEl.innerHTML = '<i>type a name or URI above</i>';
    return;
  }
  // Explicit URIs pass through — no server round-trip needed.
  if (/^(file:|s3:\/\/|hdfs:\/\/|https?:\/\/)/.test(path)) {
    hintEl.innerHTML = `<code>${esc(path)}</code> <span class="meta">(explicit URI)</span>`;
    return;
  }
  try {
    const r = await api('/mesh/queries/write/resolve?path=' + encodeURIComponent(path)
                        + '&format=' + encodeURIComponent(format));
    hintEl.innerHTML = `<code>${esc(r.resolved)}</code>`;
  } catch (e) {
    hintEl.textContent = '(resolver unavailable)';
  }
}

/**
 * Execute the Playground SQL and write results to storage as NDJson or
 * Parquet — hits POST /mesh/queries/write. Bare names ("big-cities")
 * resolve to a default location; explicit URIs pass through.
 */
async function writePlaygroundQuery() {
  const sql       = getSql().trim();
  const format    = $('#pg-write-format').value;
  const path      = ($('#pg-write-path').value || '').trim();
  const timeoutMs = Math.max(+$('#pg-timeout').value || 5000, 30000); // writes get ≥ 30s
  const statusEl  = $('#pg-write-status');
  if (!sql)  { statusEl.textContent = 'no SQL — nothing to write'; return; }
  if (!path) { statusEl.textContent = 'destination is required (name, or file:/… / s3://…)'; return; }

  statusEl.style.color = '';
  statusEl.textContent = `writing ${format} → ${path} …`;
  const t0 = performance.now();
  try {
    const r = await api('/mesh/queries/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql, format, path, timeoutMs }),
    });
    const dtMs = Math.round(performance.now() - t0);
    if (r.success) {
      statusEl.style.color = 'var(--success)';
      // Show where it actually landed — critical when the user typed a
      // bare name and the resolver picked the destination.
      statusEl.innerHTML = `✅ wrote <b>${r.rowsWritten.toLocaleString()}</b> rows `
        + `→ <code>${esc(r.resolved || r.path)}</code> in ${dtMs}ms`;
    } else {
      statusEl.style.color = 'var(--danger)';
      statusEl.textContent = 'write failed: ' + (r.error || 'unknown error');
    }
  } catch (e) {
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = 'write failed: ' + (e.message || e);
  }
}

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
  $('#pg-write-btn')?.addEventListener('click', writePlaygroundQuery);
  // Live-preview the resolved path as user types + changes format
  $('#pg-write-path')?.addEventListener('input',  updateWriteResolvedHint);
  $('#pg-write-format')?.addEventListener('change', updateWriteResolvedHint);
  updateWriteResolvedHint();
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

  // Catalog view — installed-only filter re-renders from cache, dialog close.
  $('#catalog-installed-only')?.addEventListener('change', () => {
    if (_lastCatalog) renderCatalog(_lastCatalog);
  });
  $('#catalog-detail-close')?.addEventListener('click',
      () => $('#catalog-detail-dialog').close());

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

// ================================================================ MESH VIZ
// Flowing SVG graph of the whole mesh: driver at top, one column per agent
// below, cards for each agent's partitions + broadcasts + active pipeline
// nodes. Refreshes every 2s while the tab is visible. Layout is column-based
// with animated CSS transitions on card positions + pulsing on running items.

let meshVizTimer = null;

// ================================================================ SEARCH TAB

let searchIndexTimer = null;

async function refreshSearchTab() {
  wireSearchBackendToggle();
  wireStageBuilder();
  await loadSearchIndexes();
  const runBtn = $('#search-run');
  if (runBtn && !runBtn._wired) {
    runBtn._wired = true;
    runBtn.addEventListener('click', runSearch);
  }
  const refreshBtn = $('#search-refresh');
  if (refreshBtn && !refreshBtn._wired) {
    refreshBtn._wired = true;
    refreshBtn.addEventListener('click', loadSearchIndexes);
  }
  updateQueryPreview();
  // Auto-refresh the indexes list while the tab is active so freshly
  // pipeline-written indexes show up without needing a tab-switch.
  if (searchIndexTimer) clearInterval(searchIndexTimer);
  searchIndexTimer = setInterval(() => {
    if (!$('#search').classList.contains('active')) return;
    loadSearchIndexes();
  }, 5000);
}

function wireStageBuilder() {
  const inputs = [
    '#search-q', '#search-offset', '#search-limit', '#search-facets', '#search-lang',
    '#stage-fetch',
    '#stage-fixup', '#stage-fixup-tags',
    '#stage-page', '#stage-page-rows', '#stage-page-page',
    '#stage-summarize', '#stage-summarize-maxdocs', '#stage-summarize-maxwords',
  ];
  inputs.forEach(sel => {
    const el = $(sel);
    if (!el || el._wiredPreview) return;
    el._wiredPreview = true;
    el.addEventListener('input', updateQueryPreview);
    el.addEventListener('change', updateQueryPreview);
  });
}

function buildRetrievalQuery() {
  const q = ($('#search-q')?.value || '').trim() || '*:*';
  const offset = parseInt($('#search-offset')?.value, 10) || 0;
  const limit = parseInt($('#search-limit')?.value, 10) || 20;
  const facetsRaw = ($('#search-facets')?.value || '').trim();
  const facets = facetsRaw ? facetsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const lang = ($('#search-lang')?.value || 'en').trim();

  const query = {
    search: {query: q, offset, limit, lang, facets}
  };
  if ($('#stage-fetch')?.checked) {
    // Send an empty object. DocumentRetriever.participate() returns true
    // when query.exists("fetch") and there is no fetch.enabled sub-key —
    // sending {enabled: true} tripped a bug where the stage read the
    // boolean via getString, got null, and silently skipped.
    query.fetch = {};
  }
  if ($('#stage-fixup')?.checked) {
    const tags = ($('#stage-fixup-tags')?.value || '').trim()
                 .split(',').map(s => s.trim()).filter(Boolean);
    query.fixup = {tags: tags.length ? tags : ['basic']};
  }
  if ($('#stage-page')?.checked) {
    query.page = {
      rows: parseInt($('#stage-page-rows')?.value, 10) || 10,
      page: parseInt($('#stage-page-page')?.value, 10) || 0,
    };
  }
  if ($('#stage-summarize')?.checked) {
    query.summarize = {
      maxDocs:  parseInt($('#stage-summarize-maxdocs')?.value, 10) || 10,
      maxWords: parseInt($('#stage-summarize-maxwords')?.value, 10) || 200,
    };
  }
  return query;
}

function updateQueryPreview() {
  const pre = $('#search-query-preview');
  if (!pre) return;
  const idx = ($('#search-index')?.value || '<pick an index>').trim();
  const body = {indexName: idx, query: buildRetrievalQuery()};
  pre.textContent = JSON.stringify(body, null, 2);
}

function wireSearchBackendToggle() {
  const sel = $('#search-backend');
  if (!sel || sel._wired) return;
  sel._wired = true;
  const urlIn  = $('#search-fleet-url');
  const urlLab = $('#search-fleet-url-label');
  const hint   = $('#search-backend-hint');
  const apply  = () => {
    const isFleet = sel.value === 'fleet';
    urlIn.hidden = urlLab.hidden = !isFleet;
    if (isFleet) {
      hint.innerHTML = `Calls <code>POST ${esc(urlIn.value)}/api/retrieval/execute</code> — full pipeline, aggregates + KV fallback.`;
    } else {
      hint.innerHTML = 'In-driver LuceneSearchService — lightweight, single index, no aggregates.';
    }
    loadSearchIndexes();
  };
  sel.addEventListener('change', apply);
  urlIn.addEventListener('input', () => {
    if (sel.value === 'fleet') hint.innerHTML =
      `Calls <code>POST ${esc(urlIn.value)}/api/retrieval/execute</code>`;
  });
  apply();
}

function fleetBase() {
  const sel = $('#search-backend');
  if (!sel || sel.value !== 'fleet') return null;
  return ($('#search-fleet-url').value || '').replace(/\/+$/, '');
}

async function loadSearchIndexes() {
  const listEl = $('#search-index-list');
  const countEl = $('#search-index-count');
  const fleet = fleetBase();
  let indexes = [];
  try {
    if (fleet) {
      // fleet-retrieval /api/retrieval/indexes now returns docCount + lastModifiedMs
      const resp = await fetch(`${fleet}/api/retrieval/indexes`, {mode: 'cors'});
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arr = await resp.json();
      indexes = arr.map(i => ({
        name: i.name,
        docCount: (typeof i.docCount === 'number') ? i.docCount : -1,
        lastModifiedMs: i.lastModifiedMs,
      }));
    } else {
      indexes = await api('/mesh/search');
    }
  } catch (e) {
    listEl.innerHTML =
        `<p><small style="color:var(--danger)">error: ${esc(e.message)}</small>
         ${fleet ? `<br><small class="meta">Is <code>${esc(fleet)}</code> reachable? Start hitorro-fleet-retrieval or point at another instance.</small>` : ''}</p>`;
    if (countEl) countEl.textContent = '—';
    return;
  }
  if (countEl) countEl.textContent = `${indexes.length} indexes`;
  if (!indexes.length) {
    listEl.innerHTML =
        `<p class="meta">No indexes yet. Run a pipeline with a <code>lucene</code> sink first
         (e.g. the bundled <b>enrich-and-index</b> example)${fleet ? ` — or ingest via <code>POST ${esc(fleet)}/api/ingest/indexes/&lt;name&gt;/documents</code>` : ''}.</p>`;
    return;
  }
  const nowMs = Date.now();
  listEl.innerHTML = indexes.map(i => {
    const ageMs = i.lastModifiedMs ? (nowMs - i.lastModifiedMs) : null;
    const fresh = ageMs != null && ageMs < 10_000;   // written in the last 10s
    const recent = ageMs != null && ageMs < 60_000;  // written in the last minute
    const dot = fresh ? '<span title="written in the last 10s" style="color:var(--ins-color,#4c9);">●</span> '
              : recent ? '<span title="written in the last 60s" style="color:#c9a;">●</span> '
              : '';
    return `
    <div class="ds-list-item" data-name="${esc(i.name)}"
         title="${i.docCount >= 0 ? i.docCount + ' documents' : ''}${ageMs != null ? ' · updated ' + fmtAge(ageMs) : ''} · click to load into query">
      <div class="name">${dot}${esc(i.name)}</div>
      <span class="meta">${i.docCount >= 0 ? i.docCount + ' docs' : ''}${ageMs != null ? ' · ' + fmtAge(ageMs) : ''}</span>
    </div>`;
  }).join('');
  $$('#search-index-list .ds-list-item').forEach(el => {
    el.addEventListener('click', () => {
      $$('#search-index-list .ds-list-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      $('#search-index').value = el.dataset.name;
      updateQueryPreview();
      $('#search-q').focus();
    });
  });
}

async function runSearch() {
  const idx = ($('#search-index').value || '').trim();
  const q   = ($('#search-q').value || '').trim();
  const lim = parseInt($('#search-limit').value, 10) || 20;
  if (!idx) { plToast('pick an index from the list first', 'warn'); return; }
  updateQueryPreview();
  const runBtn = $('#search-run');
  runBtn.disabled = true;
  runBtn.textContent = '⋯ Running';
  const fleet = fleetBase();
  try {
    if (fleet) {
      const body = {indexName: idx, query: buildRetrievalQuery()};
      const resp = await fetch(`${fleet}/api/retrieval/execute`, {
        method: 'POST', mode: 'cors',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      renderFleetResult(await resp.json(), q);
    } else {
      const url = `/mesh/search/${encodeURIComponent(idx)}?q=${encodeURIComponent(q)}&limit=${lim}`;
      renderSearchResult(await api(url));
    }
  } catch (e) {
    $('#search-result').innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`;
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = '🔍 Run';
  }
}

function renderSearchResult(r) {
  const host = $('#search-result');
  if (!host) return;
  if (!r.hits || !r.hits.length) {
    host.innerHTML = `<p class="meta">No hits (${r.totalDocsInIndex} docs in index, took ${r.tookMs} ms)
                      for <code>${esc(r.query || '(match all)')}</code>.</p>`;
    return;
  }
  const cols = Array.from(new Set(r.hits.flatMap(h => Object.keys(h))));
  host.innerHTML = `
    <div class="meta" style="margin-bottom: 0.4rem;">
      <b>${r.hitCount}</b> hits · ${r.totalDocsInIndex} total docs · ${r.tookMs} ms ·
      query <code>${esc(r.query || '(match all)')}</code>
    </div>
    <div style="overflow-x: auto; max-height: 500px; overflow-y: auto;">
      <table style="width:100%; font-size: 0.75rem;">
        <thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${r.hits.map(h => `
          <tr>${cols.map(c => {
            const v = h[c];
            if (v == null) return '<td class="meta">—</td>';
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return `<td>${esc(s.length > 80 ? s.slice(0, 77) + '…' : s)}</td>`;
          }).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderFleetResult(r, queryText) {
  const host = $('#search-result');
  if (!host) return;
  if (!r.success) {
    host.innerHTML = `<p style="color:var(--danger)">${esc(r.error || 'unknown error')}</p>`;
    return;
  }
  const docs = r.documents || [];

  // Aggregates: SearchSummary emits {_aggregate:"summary", ...}; Facet: {_aggregate:"facet", ...}; Summarization: {_aggregate:"summarization", ...}
  const aggs = r.aggregates || [];
  const aggHtml = aggs.length ? `
    <details class="ret-agg" open style="margin-bottom:0.5rem;">
      <summary><b>${aggs.length}</b> aggregate${aggs.length===1?'':'s'} — SearchSummary / Facet / Summarization</summary>
      <div style="padding:0.4rem 0.6rem;">
        ${aggs.map(a => `<pre style="margin:0 0 0.4rem 0; font-size:0.7rem; white-space:pre-wrap; word-break:break-word;">${esc(JSON.stringify(a, null, 2))}</pre>`).join('')}
      </div>
    </details>` : '';

  const facetsHtml = r.facets ? renderFacetsPanel(r.facets) : '';

  const stagesHtml = r.stagesUsed && r.stagesUsed.length
    ? `<small class="meta">Stages: ${r.stagesUsed.map(s => `<code>${esc(s)}</code>`).join(' → ')}</small>` : '';
  const ctxHtml = r.contextAttributes ? Object.entries(r.contextAttributes)
      .map(([k,v]) => `<code>${esc(k)}=${esc(String(v))}</code>`).join(' · ') : '';

  const usedFetch = r.stagesUsed && r.stagesUsed.includes('DocumentRetriever');

  host.innerHTML = `
    <div class="meta" style="margin-bottom: 0.4rem;">
      <b>${docs.length}</b> docs · totalHits <b>${r.totalHits ?? '?'}</b> · ${r.searchTimeMs ?? '?'} ms search · ${r.totalTimeMs ?? '?'} ms wall
      · query <code>${esc(queryText || '*:*')}</code>
    </div>
    ${stagesHtml}
    ${ctxHtml ? `<div class="meta" style="margin:0.2rem 0 0.4rem 0;">${ctxHtml}</div>` : ''}
    ${aggHtml}
    ${facetsHtml}
    ${docs.length ? `
      <div class="meta" style="margin:0.3rem 0 0.2rem 0;">
        Source per doc:
        ${usedFetch ? '<span title="DocumentRetriever fetched from KV store — full rich JSON">📦 KV</span>'
                    : '<span title="Reconstructed from stored fields in Lucene index — only projected fields, no nested structure">🔎 index</span>'}
        · click any row to expand full JSON
      </div>
      <div id="search-hits" style="border-top:1px solid var(--muted-border-color,#e0e0e0); max-height:500px; overflow-y:auto;">
        ${docs.map((d, i) => renderHitRow(d, i, usedFetch)).join('')}
      </div>` : '<p class="meta">No documents returned.</p>'}
    ${r.errors && r.errors.length ? `
      <div style="margin-top:0.5rem; color:var(--danger); font-size:0.75rem;">
        ${r.errors.map(e => `<div>${esc(e)}</div>`).join('')}
      </div>` : ''}`;

  // Wire per-row expand toggles + copy buttons.
  docs.forEach((d, i) => {
    const head = $(`#hit-head-${i}`);
    if (head) head.addEventListener('click', () => {
      const body = $(`#hit-body-${i}`);
      body.hidden = !body.hidden;
      $(`#hit-caret-${i}`).textContent = body.hidden ? '▸' : '▾';
    });
    const copy = $(`#hit-copy-${i}`);
    if (copy) copy.addEventListener('click', (ev) => {
      ev.stopPropagation();
      navigator.clipboard.writeText(JSON.stringify(d, null, 2)).then(
        () => plToast('JSON copied', 'ok'),
        () => plToast('Copy failed', 'warn'));
    });
  });
}

function renderHitRow(doc, idx, usedFetch) {
  // Try to pick a natural title + subtitle for the collapsed row.
  const title = doc.title || doc.name || doc.iata || doc.id
                || doc._uid || Object.values(doc)[0] || `hit ${idx+1}`;
  const subtitle = [];
  if (doc.id && doc.id !== title)         subtitle.push(`id=${doc.id}`);
  if (doc.type)                            subtitle.push(`type=${doc.type}`);
  if (doc.country)                         subtitle.push(`country=${doc.country}`);
  if (typeof doc._score === 'number')      subtitle.push(`score=${doc._score.toFixed(2)}`);
  // Field count as a stand-in "richness" indicator so users can eyeball
  // whether they got the index projection (few fields) vs the full JVS
  // from KV (nested arrays / objects push the count up).
  const nFields = Object.keys(doc).length;
  const nested  = Object.values(doc).filter(v => v && typeof v === 'object').length;
  subtitle.push(`${nFields} field${nFields===1?'':'s'}${nested ? ', '+nested+' nested' : ''}`);
  return `
    <div style="border-bottom:1px solid var(--muted-border-color,#e8e8e8);">
      <div id="hit-head-${idx}" style="display:flex; align-items:center; gap:0.5rem;
           padding:0.35rem 0.5rem; cursor:pointer;"
           title="Click to show full JSON">
        <span id="hit-caret-${idx}" style="width:1rem;">▸</span>
        <div style="flex:1; overflow:hidden;">
          <div><b>${esc(String(title))}</b></div>
          <div class="meta" style="font-size:0.72rem;">${subtitle.map(esc).join(' · ')}</div>
        </div>
        <button id="hit-copy-${idx}" class="secondary outline"
                style="margin:0; padding:0.05rem 0.4rem; font-size:0.7rem;"
                title="Copy this doc's JSON to clipboard">📋</button>
      </div>
      <pre id="hit-body-${idx}" hidden
           style="margin:0 0 0.4rem 1.5rem; padding:0.4rem 0.6rem; font-size:0.7rem;
                  line-height:1.35; white-space:pre-wrap; word-break:break-word;
                  background:var(--card-sectioning-background-color,#f7f7f7);
                  border-radius:4px; max-height:400px; overflow:auto;">${esc(JSON.stringify(doc, null, 2))}</pre>
    </div>`;
}

function renderFacetsPanel(facets) {
  const keys = Object.keys(facets || {});
  if (!keys.length) return '';
  return `
    <details class="ret-facets" open style="margin-bottom:0.5rem;">
      <summary><b>${keys.length}</b> facet${keys.length===1?'':'s'}</summary>
      <div style="padding:0.4rem 0.6rem; display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:0.5rem;">
        ${keys.map(k => {
          const f = facets[k];
          const vals = (f.values || []).slice(0, 12);
          return `<div style="border:1px solid var(--muted-border-color,#e0e0e0); border-radius:4px; padding:0.35rem 0.5rem;">
            <div><b>${esc(k)}</b> <small class="meta">${f.totalCount ?? 0}</small></div>
            <ul style="margin:0.2rem 0 0 0.9rem; padding:0; font-size:0.75rem;">
              ${vals.map(v => `<li>${esc(v.value)} <small class="meta">(${v.count})</small></li>`).join('')}
              ${(f.values||[]).length > vals.length ? `<li class="meta">… ${(f.values||[]).length - vals.length} more</li>` : ''}
            </ul>
          </div>`;
        }).join('')}
      </div>
    </details>`;
}

// ================================================================ FLEET TAB

let fleetTimer = null;

async function refreshFleetTab() {
  wireFleetHandlers();
  await loadFleetServices();
  if (fleetTimer) clearInterval(fleetTimer);
  fleetTimer = setInterval(() => {
    if (!$('#fleet').classList.contains('active')) return;
    if (!$('#fleet-autorefresh').checked) return;
    loadFleetServices();
  }, 5000);
}

function wireFleetHandlers() {
  const refresh = $('#fleet-refresh');
  if (refresh && !refresh._wired) {
    refresh._wired = true;
    refresh.addEventListener('click', loadFleetServices);
  }
  ['fleet-log-close', 'fleet-manifest-close'].forEach(id => {
    const b = $('#' + id);
    if (b && !b._wired) { b._wired = true; b.addEventListener('click', () => b.closest('dialog').close()); }
  });
  const copy = $('#fleet-manifest-copy');
  if (copy && !copy._wired) {
    copy._wired = true;
    copy.addEventListener('click', () => {
      const text = $('#fleet-manifest-body').textContent;
      navigator.clipboard.writeText(text).then(
        () => plToast('Manifest copied', 'ok'),
        () => plToast('Copy failed — select + Cmd/Ctrl-C', 'warn'));
    });
  }
}

async function loadFleetServices() {
  let services = [], driverDbg = null;
  try {
    [services, driverDbg] = await Promise.all([
      api('/mesh/fleet/services'),
      api('/mesh/fleet/driver-debug').catch(() => null),
    ]);
  } catch (e) {
    $('#fleet-list').innerHTML = `<p style="color:var(--danger)">error: ${esc(e.message)}</p>`;
    return;
  }
  $('#fleet-last-refresh').textContent = 'refreshed ' + new Date().toLocaleTimeString();
  const driverRow = driverRowHtml(driverDbg);
  if (!services.length && !driverRow) {
    $('#fleet-list').innerHTML = '<p class="meta">No fleet members registered.</p>';
    return;
  }
  $('#fleet-list').innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%; font-size:0.8rem;">
        <thead>
          <tr>
            <th>Member</th>
            <th>Port</th>
            <th>Status</th>
            <th>Debug (JDWP)</th>
            <th>Managed PID / Uptime</th>
            <th>Jar</th>
            <th style="text-align:right; min-width: 24rem;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${driverRow}
          ${services.map(fleetRowHtml).join('')}
        </tbody>
      </table>
    </div>`;
  services.forEach(s => {
    $(`#fleet-start-${s.name}`)?.addEventListener('click', () => fleetStart(s.name));
    $(`#fleet-stop-${s.name}`)?.addEventListener('click', () => fleetStop(s.name));
    $(`#fleet-logs-${s.name}`)?.addEventListener('click', () => fleetShowLogs(s.name));
    $(`#fleet-k8s-${s.name}`)?.addEventListener('click', () => fleetShowManifest(s.name, 'k8s'));
    $(`#fleet-orion-${s.name}`)?.addEventListener('click', () => fleetShowManifest(s.name, 'orion'));
    $(`#fleet-local-${s.name}`)?.addEventListener('click', () => fleetShowManifest(s.name, 'local'));
    $(`#fleet-idea-${s.name}`)?.addEventListener('click', () => fleetShowManifest(s.name, 'intellij'));
    $(`#fleet-dbg-${s.name}`)?.addEventListener('click', () => fleetShowDebug(s.debug, s.name));
  });
  if (driverDbg && driverDbg.jdwpEnabled) {
    $('#fleet-dbg-mesh-driver')?.addEventListener('click',
      () => fleetShowDebug({host:'localhost', port:driverDbg.debugPort, connectString:driverDbg.connectString,
                            jdbCommand:driverDbg.jdbCommand, jdwpArg:driverDbg.jdwpArg,
                            jdwpProbeOpen:driverDbg.jdwpProbeOpen}, 'mesh-driver'));
  }
}

function driverRowHtml(d) {
  if (!d) return '';
  const dbgCell = d.jdwpEnabled
    ? `<a href="#" id="fleet-dbg-mesh-driver" title="Connection details + IntelliJ hint"
         style="text-decoration:none;">
         <code>:${d.debugPort}</code> ${d.jdwpProbeOpen
            ? '<span style="color:var(--ins-color,#4c9);">●</span>'
            : '<span style="color:var(--muted-color,#888);">○</span>'}
         <small class="meta">jdb / IntelliJ</small></a>`
    : `<small class="meta" title="Restart driver with -agentlib:jdwp=...address=*:5085 to enable">not enabled</small>`;
  return `<tr style="background:rgba(0,120,255,0.03);">
    <td><b>mesh-driver</b><br><small class="meta">this JVM (query planner + dispatcher + Fleet panel)</small></td>
    <td><code>8085</code></td>
    <td><span title="you're talking to it right now" style="color:var(--ins-color,#4c9); font-weight:bold;">● UP</span></td>
    <td>${dbgCell}</td>
    <td>PID <code>${d.pid}</code></td>
    <td><small class="meta">managed by mesh-up.sh (or however you launch it)</small></td>
    <td style="text-align:right;"><small class="meta">not managed here — Fleet actions only apply to fleet-* members</small></td>
  </tr>`;
}

function fleetRowHtml(s) {
  const dot = s.alive
    ? `<span title="responding at ${esc(s.healthPath)} (${s.probeMs}ms)"
             style="color:var(--ins-color,#4c9); font-weight:bold;">● UP</span>`
    : `<span title="no response on port ${s.defaultPort}${s.healthPath}"
             style="color:var(--muted-color,#888);">○ down</span>`;
  const managed = s.managedPid
    ? `PID <code>${s.managedPid}</code> · ${fmtUptime(s.uptimeSec)}`
    : `<small class="meta">not managed by driver</small>`;
  const jar = s.jarFound
    ? `<small class="meta" title="${esc(s.jarPath)}">${esc(shortPath(s.jarPath))}</small>`
    : `<small style="color:var(--warn,#c93);">jar missing — build first</small>`;
  const dbg = s.debug ? (s.debug.jdwpProbeOpen
    ? `<a href="#" id="fleet-dbg-${esc(s.name)}" style="text-decoration:none;"
         title="Attach jdb or IntelliJ Remote JVM Debug"><code>:${s.debug.port}</code>
         <span style="color:var(--ins-color,#4c9);">●</span>
         <small class="meta">jdb / IntelliJ</small></a>`
    : `<a href="#" id="fleet-dbg-${esc(s.name)}" style="text-decoration:none;"
         title="Debug port not listening — service down or JDWP not on"><code>:${s.debug.port}</code>
         <span style="color:var(--muted-color,#888);">○</span>
         <small class="meta">not listening</small></a>`) : '';
  const canStart = s.jarFound && !s.alive;
  const canStop  = !!s.managedPid;
  return `<tr>
    <td><b>${esc(s.name)}</b><br><small class="meta">${esc(s.description || '')}</small></td>
    <td><code>${s.defaultPort}</code></td>
    <td>${dot}</td>
    <td>${dbg}</td>
    <td>${managed}</td>
    <td>${jar}</td>
    <td style="text-align:right; white-space:nowrap;">
      <button id="fleet-start-${esc(s.name)}" ${canStart?'':'disabled'}
              style="margin:0 0.15rem; padding:0.1rem 0.5rem;"
              title="${canStart?'Spawn java -jar in the driver JVM (JDWP enabled)':'Already up, or jar missing'}">▶ start</button>
      <button id="fleet-stop-${esc(s.name)}" ${canStop?'':'disabled'} class="secondary outline"
              style="margin:0 0.15rem; padding:0.1rem 0.5rem;"
              title="Kill the process the driver spawned">■ stop</button>
      <button id="fleet-logs-${esc(s.name)}" class="secondary outline"
              style="margin:0 0.15rem; padding:0.1rem 0.5rem;">📜 logs</button>
      <button id="fleet-local-${esc(s.name)}" class="secondary outline"
              style="margin:0 0.15rem; padding:0.1rem 0.5rem;" title="Shell one-liner (JDWP on)">$_ cli</button>
      <button id="fleet-idea-${esc(s.name)}" class="secondary outline"
              style="margin:0 0.15rem; padding:0.1rem 0.5rem;" title="IntelliJ IDEA run-configuration XML">💡 IntelliJ</button>
      <button id="fleet-k8s-${esc(s.name)}" class="secondary outline"
              style="margin:0 0.15rem; padding:0.1rem 0.5rem;">☸ k8s</button>
      <button id="fleet-orion-${esc(s.name)}" class="secondary outline"
              style="margin:0 0.15rem; padding:0.1rem 0.5rem;">⊛ orion</button>
    </td>
  </tr>`;
}

function fleetShowDebug(dbg, name) {
  if (!dbg) return;
  const dlg = $('#fleet-manifest-dialog');
  $('#fleet-manifest-title').textContent = `Debug info — ${name}`;
  const body = $('#fleet-manifest-body');
  const intelliJ =
    `IntelliJ IDEA:\n` +
    `  Run → Edit Configurations → + → Remote JVM Debug\n` +
    `  Debugger mode:  Attach to remote JVM\n` +
    `  Host:           ${dbg.host}\n` +
    `  Port:           ${dbg.port}\n` +
    `  Transport:      Socket\n` +
    `  JDK 9+ VM args: ${dbg.jdwpArg}\n`;
  const listening = dbg.jdwpProbeOpen
    ? '● port ' + dbg.port + ' is LISTENING\n'
    : '○ port ' + dbg.port + ' is NOT LISTENING — process down or JDWP not enabled\n\n';
  body.textContent =
    `# ${name} — JDWP debug\n\n` +
    listening + '\n' +
    `Connect string:   ${dbg.connectString}\n` +
    `Launched with:    ${dbg.jdwpArg}\n\n` +
    `jdb (command-line JVM debugger):\n  ${dbg.jdbCommand}\n\n` +
    intelliJ + '\n' +
    `For K8s: kubectl port-forward svc/hitorro-${name} ${dbg.port}:${dbg.port}\n` +
    `For Orion: orion port-forward svc/hitorro-${name} ${dbg.port}:${dbg.port}\n`;
  dlg.showModal();
}

function fmtAge(ms) {
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return Math.floor(ms/1000) + 's ago';
  if (ms < 3_600_000) return Math.floor(ms/60_000) + 'm ago';
  if (ms < 86_400_000) return Math.floor(ms/3_600_000) + 'h ago';
  return Math.floor(ms/86_400_000) + 'd ago';
}

function shortPath(p) {
  if (!p) return '';
  const home = '/Users/' + (p.split('/Users/')[1] || '').split('/')[0];
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function fmtUptime(sec) {
  if (sec == null) return '';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec/60) + 'm ' + (sec%60) + 's';
  return Math.floor(sec/3600) + 'h ' + Math.floor((sec%3600)/60) + 'm';
}

async function fleetStart(name) {
  try {
    const r = await api(`/mesh/fleet/services/${encodeURIComponent(name)}/start`, {method: 'POST'});
    if (r.success) plToast(`Started ${name} (pid ${r.pid})`, 'ok');
    else plToast(`Start failed: ${r.error || 'unknown'}`, 'warn');
  } catch (e) { plToast(`Start error: ${e.message}`, 'warn'); }
  setTimeout(loadFleetServices, 800);
}

async function fleetStop(name) {
  try {
    const r = await api(`/mesh/fleet/services/${encodeURIComponent(name)}/stop`, {method: 'POST'});
    plToast(r.killed ? `Stopped ${name}` : `${name} was not managed by driver`, r.killed ? 'ok' : 'warn');
  } catch (e) { plToast(`Stop error: ${e.message}`, 'warn'); }
  setTimeout(loadFleetServices, 500);
}

async function fleetShowLogs(name) {
  const dlg = $('#fleet-log-dialog');
  $('#fleet-log-title').textContent = `Logs — ${name}`;
  const body = $('#fleet-log-body');
  body.textContent = 'loading…';
  dlg.showModal();
  const refresh = $('#fleet-log-refresh');
  const load = async () => {
    try {
      const r = await api(`/mesh/fleet/services/${encodeURIComponent(name)}/logs?tail=200`);
      body.textContent = (r.lines || []).join('\n') || '(empty)';
      body.scrollTop = body.scrollHeight;
    } catch (e) {
      body.textContent = 'error: ' + e.message;
    }
  };
  refresh.onclick = load;
  load();
}

async function fleetShowManifest(name, target) {
  const dlg = $('#fleet-manifest-dialog');
  $('#fleet-manifest-title').textContent = `${target === 'local' ? 'Local launch command' :
                                             target === 'orion' ? 'Orion manifest' : 'K8s manifest'} — ${name}`;
  const body = $('#fleet-manifest-body');
  body.textContent = 'loading…';
  dlg.showModal();
  try {
    const url = `/mesh/fleet/services/${encodeURIComponent(name)}/manifest?target=${target}`;
    const resp = await fetch(url);
    body.textContent = await resp.text();
  } catch (e) { body.textContent = 'error: ' + e.message; }
}

// ================================================================ JOBS TAB

let jobsTimer = null;

async function refreshJobsTab() {
  wireJobsHandlers();
  await loadJobs();
  if (jobsTimer) clearInterval(jobsTimer);
  jobsTimer = setInterval(() => {
    if (!$('#jobs').classList.contains('active')) return;
    loadJobs();
  }, 5000);
}

function wireJobsHandlers() {
  const btn = $('#jobs-refresh');
  if (btn && !btn._wired) { btn._wired = true; btn.addEventListener('click', loadJobs); }
}

async function loadJobs() {
  let history = [], running = [];
  try {
    [history, running] = await Promise.all([
      api('/mesh/jobs/history?limit=500'),
      api('/mesh/jobs'),
    ]);
  } catch (e) {
    $('#jobs-list').innerHTML = `<p style="color:var(--danger)">error: ${esc(e.message)}</p>`;
    return;
  }
  // Merge — running jobs on top, history below. Dedup by jobId.
  const runningIds = new Set(running.filter(r => r.state === 'RUNNING').map(r => r.jobId));
  const all = [];
  running.filter(r => r.state === 'RUNNING').forEach(r => all.push({...r, _running: true}));
  history.forEach(h => { if (!runningIds.has(h.jobId)) all.push(h); });
  $('#jobs-count').textContent = `${all.length} jobs — ${runningIds.size} running`;
  if (!all.length) {
    $('#jobs-list').innerHTML = '<p class="meta">No jobs yet. Run a bundled example from the Pipelines tab.</p>';
    return;
  }
  $('#jobs-list').innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%; font-size:0.78rem; border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid var(--muted-border-color,#e0e0e0);">
            <th style="text-align:left; padding:0.3rem;">Job</th>
            <th style="text-align:left; padding:0.3rem;">State</th>
            <th style="text-align:left; padding:0.3rem;">Started</th>
            <th style="text-align:right; padding:0.3rem;">Duration</th>
            <th style="text-align:right; padding:0.3rem;">Nodes</th>
            <th style="text-align:right; padding:0.3rem;">Rows out</th>
            <th style="text-align:left; padding:0.3rem;">Error</th>
          </tr>
        </thead>
        <tbody>
          ${all.map((j,i) => jobRowHtml(j,i)).join('')}
        </tbody>
      </table>
    </div>`;
  all.forEach((j, i) => {
    const head = $(`#job-row-${i}`);
    if (head) head.addEventListener('click', () => {
      const body = $(`#job-body-${i}`);
      body.hidden = !body.hidden;
    });
  });
}

function jobRowHtml(j, i) {
  const state = j.state || 'RUNNING';
  const color = state === 'SUCCEEDED' ? 'var(--ins-color,#4c9)'
              : state === 'FAILED'    ? 'var(--danger,#c33)'
              : state === 'RUNNING'   ? '#3af'
              : state === 'CANCELLED' ? '#c93'
              : 'var(--muted-color,#888)';
  const started = j.startedAt || '';
  const startedShort = started ? started.replace('T',' ').replace(/\.\d+Z?/, '') : '—';
  const durationMs = j.durationMs != null ? j.durationMs
                     : (j.finishedAt && j.startedAt
                        ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()
                        : 0);
  const dur = durationMs > 0 ? fmtDuration(durationMs) : '—';
  const rowsOut = j.totalRowsOut != null ? j.totalRowsOut
                 : (j.nodes || []).reduce((s,n) => s + (n.rowsOut||0), 0);
  const nodeCount = j.nodeCount != null ? j.nodeCount : (j.nodes || []).length;
  const nodes = j.nodes || [];
  return `
    <tr id="job-row-${i}" style="cursor:pointer; border-bottom:1px solid var(--muted-border-color,#eee);">
      <td style="padding:0.3rem;">
        <b>${esc(j.jobSpecName || '?')}</b>
        <br><small class="meta">${esc(j.jobId || '?')}</small>
      </td>
      <td style="padding:0.3rem;"><span style="color:${color}; font-weight:bold;">${esc(state)}</span></td>
      <td style="padding:0.3rem;"><small>${esc(startedShort)}</small></td>
      <td style="padding:0.3rem; text-align:right;">${dur}</td>
      <td style="padding:0.3rem; text-align:right;">${nodeCount}</td>
      <td style="padding:0.3rem; text-align:right;">${rowsOut.toLocaleString()}</td>
      <td style="padding:0.3rem;"><small style="color:var(--danger);">${j.error ? esc(j.error).slice(0,60) : ''}</small></td>
    </tr>
    <tr id="job-body-${i}" hidden>
      <td colspan="7" style="padding:0.4rem 1rem; background:var(--card-sectioning-background-color,#fafafa);">
        ${nodes.length ? `
          <table style="width:100%; font-size:0.72rem;">
            <thead><tr>
              <th style="text-align:left;">node</th><th>state</th>
              <th style="text-align:right;">in</th><th style="text-align:right;">out</th>
              <th style="text-align:right;">dur</th><th style="text-align:left;">sinks</th>
              <th style="text-align:left;">assigned</th>
            </tr></thead>
            <tbody>${nodes.map(n => nodeRowHtml(n)).join('')}</tbody>
          </table>` : '<small class="meta">no per-node detail (replayed from history)</small>'}
      </td>
    </tr>`;
}
function nodeRowHtml(n) {
  const sc = n.sinkCounts || {};
  const sinks = Object.entries(sc).map(([k,v]) => `${esc(k)}=${v}`).join(', ');
  const dur = (n.startedAt && n.finishedAt)
    ? fmtDuration(new Date(n.finishedAt).getTime() - new Date(n.startedAt).getTime())
    : '—';
  return `<tr>
    <td>${esc(n.id||'?')}</td>
    <td>${esc(n.state||'?')}</td>
    <td style="text-align:right;">${(n.rowsIn||0).toLocaleString()}</td>
    <td style="text-align:right;">${(n.rowsOut||0).toLocaleString()}</td>
    <td style="text-align:right;">${dur}</td>
    <td><small class="meta">${sinks}</small></td>
    <td><small class="meta">${esc(n.assignedAgent||'')}</small></td>
  </tr>`;
}
function fmtDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60_000) return (ms/1000).toFixed(1) + 's';
  const m = Math.floor(ms/60_000);
  const s = Math.floor((ms%60_000)/1000);
  return `${m}m ${s}s`;
}

// ================================================================ MESH LOG TAIL

let meshLogTimer = null;
let meshLogComponent = null;

function openMeshLog(component) {
  const dlg = $('#mesh-log-dialog');
  if (!dlg) return;
  meshLogComponent = component;
  $('#mesh-log-title').textContent = `${component} — log tail`;
  $('#mesh-log-path').textContent = '';
  $('#mesh-log-body').textContent = 'loading…';
  // Wire buttons once
  const refresh = $('#mesh-log-refresh');
  const close   = $('#mesh-log-close');
  if (!refresh._wired) { refresh._wired = true; refresh.addEventListener('click', loadMeshLog); }
  if (!close._wired)   { close._wired   = true; close.addEventListener('click', () => {
    if (meshLogTimer) clearInterval(meshLogTimer);
    meshLogTimer = null;
    dlg.close();
  }); }
  dlg.showModal();
  loadMeshLog();
  if (meshLogTimer) clearInterval(meshLogTimer);
  meshLogTimer = setInterval(() => {
    if (!dlg.open) return;
    if (!$('#mesh-log-follow').checked) return;
    loadMeshLog();
  }, 2000);
}

async function loadMeshLog() {
  if (!meshLogComponent) return;
  const body = $('#mesh-log-body');
  try {
    const r = await api(`/mesh/logs/${encodeURIComponent(meshLogComponent)}?tail=300`);
    $('#mesh-log-path').textContent = r.path ? '· ' + shortPath(r.path) : '';
    const scrolled = body.scrollTop + body.clientHeight >= body.scrollHeight - 10;
    body.textContent = (r.lines || []).join('\n') || '(empty)';
    if (scrolled) body.scrollTop = body.scrollHeight;
  } catch (e) {
    body.textContent = 'error: ' + e.message
      + (e.responseBody ? '\n' + JSON.stringify(e.responseBody, null, 2) : '');
  }
}

// ================================================================ MESH VIZ

async function refreshMeshViz() {
  await drawMeshViz();
  if (meshVizTimer) clearInterval(meshVizTimer);
  // 1s cadence so brief pipeline runs (they finish in <500ms on the
  // driver JVM) still register at least once with the "recent activity"
  // fade-out logic in drawMeshViz.
  meshVizTimer = setInterval(() => {
    if (!$('#mesh').classList.contains('active')) return;
    drawMeshViz();
  }, 1000);
}

async function drawMeshViz() {
  let topo, jobs;
  try {
    [topo, jobs] = await Promise.all([
      api('/mesh/topology'),
      api('/mesh/jobs').catch(() => []),
    ]);
  } catch (e) {
    $('#mesh-viz').innerHTML = `<text x="20" y="30" fill="var(--danger)">error: ${esc(e.message)}</text>`;
    return;
  }

  // Data-flow narrative panel below the SVG.
  const flowsEl = $('#mesh-flows');
  if (flowsEl) {
    const flowsHtml = Object.entries(topo.dataFlow || {}).map(([k, v]) =>
      `<div style="margin:0.35rem 0;"><b style="color:var(--primary-mesh);">${esc(k)}:</b> ${esc(v)}</div>`).join('');
    flowsEl.innerHTML = flowsHtml || '<span class="meta">no flow info</span>';
  }

  const svg = $('#mesh-viz');
  const W = svg.clientWidth || 900;
  const agents = topo.agents || [];
  const nAgents = Math.max(1, agents.length);

  const COL_W       = Math.min(360, Math.max(260, Math.floor((W - 40) / nAgents)));
  const DRIVER_H    = 96;
  const AGENT_HDR_H = 68;
  const CARD_H      = 30;
  const CARD_GAP    = 5;
  const PADDING     = 20;
  // Vertical gap between driver + agent row grows so the pipelines-on-
  // driver panel fits between them without overlapping.
  const GAP_TB      = 260;

  // Show every RUNNING pipeline plus anything that finished in the last
  // 30s — otherwise Phase-1 jobs (which complete on the driver JVM in
  // well under a second) are invisible by the time a user tabs over.
  const now = Date.now();
  const RECENT_MS = 30_000;
  const activeJobs = (jobs || []).filter(j => {
    if (j.state === 'RUNNING') return true;
    if (j.finishedAt) {
      const end = Date.parse(j.finishedAt);
      if (!isNaN(end) && now - end < RECENT_MS) return true;
    }
    return false;
  });
  const runningJobs = activeJobs.filter(j => j.state === 'RUNNING');
  const runningNodesByAgent = {};
  activeJobs.forEach(j => {
    (j.nodes || []).forEach(n => {
      const key = n.assignedAgent || '__driver__';
      const isRunning = j.state === 'RUNNING' && n.state === 'RUNNING';
      const isRecent  = j.state !== 'RUNNING';
      if (!isRunning && !isRecent) return;
      (runningNodesByAgent[key] = runningNodesByAgent[key] || [])
          .push({ jobId: j.jobId, jobName: j.jobSpecName,
                  jobState: j.state, ...n });
    });
  });

  // Building-block cards per agent — pulled directly from topology payload.
  const broadcasts = topo.broadcasts || [];
  const cardsByAgent = agents.map(a => {
    const cards = [];
    (a.buildingBlocks || []).forEach(b => {
      const lname = (b.name || '').toLowerCase();
      let kind = 'generic';
      if (lname.includes('partition')) kind = 'partition';
      else if (lname.includes('broadcast')) kind = 'broadcast-summary';
      else if (lname.includes('pipeline')) kind = 'pipeline-cap';
      else if (lname.includes('sql')) kind = 'sql';
      else if (lname.includes('task')) kind = 'task';
      else if (lname.includes('nats')) kind = 'nats';
      cards.push({ kind, label: b.name, desc: b.desc });
    });
    (a.partitions || []).forEach(p => cards.push({
      kind: 'partition-detail',
      label: `→ ${p.table}[${p.key}]`,
      desc: `Partition of "${p.table}" identified by key "${p.key}". Scans of ${p.table} filtered to this key route here.`,
    }));
    return { agent: a, cards };
  });

  const maxCards = Math.max(1, ...cardsByAgent.map(x => x.cards.length),
                            ...Object.values(runningNodesByAgent).map(a => a.length));
  const agentCol_H = AGENT_HDR_H + (CARD_H + CARD_GAP) * (maxCards + 2) + 20;
  const totalH = DRIVER_H + GAP_TB + agentCol_H + 40;
  svg.setAttribute('height', totalH);

  const defs = svg.querySelector('defs');
  const defsHtml = defs ? defs.outerHTML : '';
  let body = defsHtml;

  // ---- Driver box (hoverable) ----
  const driverW = 300;
  const driverX = (W - driverW) / 2;
  const driverDesc   = topo.driver?.description || '';
  const driverBlocks = topo.driver?.buildingBlocks || [];
  body += `
    <g class="mesh-driver-g mesh-hoverable" transform="translate(${driverX}, ${PADDING})"
       data-info-title="DRIVER"
       data-info-desc="${esc(driverDesc)}"
       data-info-blocks='${esc(JSON.stringify(driverBlocks))}'>
      <rect class="mesh-box mesh-driver" width="${driverW}" height="${DRIVER_H}" rx="8"/>
      <text class="mesh-title" x="${driverW/2}" y="26" text-anchor="middle">DRIVER</text>
      <text class="mesh-sub"   x="${driverW/2}" y="46" text-anchor="middle">planner · dispatcher · result collector</text>
      <text class="mesh-sub"   x="${driverW/2}" y="64" text-anchor="middle">
        uptime ${Math.floor((topo.driver?.uptimeMs || 0) / 1000)}s · pipelines: ${runningJobs.length} running · ${activeJobs.length - runningJobs.length} recent
      </text>
      <text class="mesh-sub"   x="${driverW/2}" y="82" text-anchor="middle">
        ${broadcasts.length} broadcasts · ${(topo.distributed || []).length} distributed tables · hover for details
      </text>
    </g>
  `;

  // Broadcast fan-out reminder between driver + agents.
  if (broadcasts.length && nAgents >= 1) {
    body += `
      <g class="mesh-hoverable"
         data-info-title="Broadcast fan-out (${broadcasts.length} tables)"
         data-info-desc="Every broadcast table is pre-loaded at every agent — the SAME data replicated everywhere. Small dimension tables travel this way (country_info, iso codes, un-m49-areas, ...) so JOINs against them are constant-time at the agent's local cache. Contrast with partitioned tables where each agent holds a slice.">
        <text x="${W/2}" y="${PADDING + DRIVER_H + 26}" text-anchor="middle" class="mesh-fanout-label">
          ⇊ BROADCAST — same ${broadcasts.length} tables at every agent ⇊
        </text>
      </g>
    `;
  }

  // ---- Agent columns ----
  const rowY = PADDING + DRIVER_H + GAP_TB;
  const totalColsW = COL_W * nAgents + Math.max(0, nAgents - 1) * 20;
  const startX = Math.max(PADDING, (W - totalColsW) / 2);
  cardsByAgent.forEach((entry, i) => {
    const x = startX + i * (COL_W + 20);
    const a = entry.agent;
    const partCount = (a.partitions || []).length;
    const running = runningNodesByAgent[a.id] || [];

    body += `
      <g class="mesh-agent-g mesh-hoverable" transform="translate(${x}, ${rowY})"
         data-agent="${esc(a.id)}"
         data-info-title="${esc(a.id)}"
         data-info-desc="${esc(a.description || '')}"
         data-info-caps='${esc(JSON.stringify(Array.from(a.capabilities || [])))}'>
        <rect class="mesh-box mesh-agent" width="${COL_W}" height="${agentCol_H}" rx="8"/>
        <text class="mesh-title" x="${COL_W/2}" y="22" text-anchor="middle">${esc(a.id)}</text>
        <text class="mesh-sub"   x="${COL_W/2}" y="40" text-anchor="middle">
          ${partCount} partition(s) · ${a.capabilities.length} capabilities${a.hasPipelineNode ? ' · pipelines' : ''}
        </text>
        <text class="mesh-sub"   x="${COL_W/2}" y="56" text-anchor="middle" style="font-style:italic;">
          hover column for description · hover blocks for detail
        </text>
        <line x1="8" x2="${COL_W-8}" y1="${AGENT_HDR_H-4}" y2="${AGENT_HDR_H-4}"
              stroke="rgba(46,134,171,0.2)" stroke-width="1"/>
    `;
    entry.cards.forEach((c, ci) => {
      const y = AGENT_HDR_H + 6 + ci * (CARD_H + CARD_GAP);
      const cls = 'mesh-' + c.kind.replace(/[^a-z-]/g, '');
      body += `
        <g class="mesh-card mesh-hoverable ${cls}" transform="translate(6, ${y})"
           data-info-title="${esc(c.label)}"
           data-info-desc="${esc(c.desc || '')}">
          <rect width="${COL_W-12}" height="${CARD_H}" rx="4"/>
          <text x="10" y="${CARD_H/2 + 4}" >${esc(c.label)}</text>
        </g>
      `;
    });
    if (running.length) {
      const baseY = AGENT_HDR_H + 6 + entry.cards.length * (CARD_H + CARD_GAP) + 10;
      running.forEach((n, ni) => {
        const y = baseY + ni * (CARD_H + CARD_GAP);
        body += `
          <g class="mesh-card mesh-pipeline mesh-pulse mesh-hoverable" transform="translate(6, ${y})"
             data-info-title="Running: ${esc(n.id)}"
             data-info-desc="Node ${esc(n.id)} from job '${esc(n.jobName)}'. Currently RUNNING with ${n.rowsOut||0} rows emitted so far.">
            <rect width="${COL_W-12}" height="${CARD_H}" rx="4"/>
            <text x="10" y="${CARD_H/2 + 4}">▶ ${esc(n.jobName)} · ${esc(n.id)} · ${n.rowsOut||0} rows</text>
          </g>
        `;
      });
    }
    body += `</g>`;

    // Driver → agent curved edge with data-flow label.
    const driverBottomX = W / 2;
    const driverBottomY = PADDING + DRIVER_H;
    const agentTopX = x + COL_W / 2;
    const agentTopY = rowY;
    const midY = (driverBottomY + agentTopY) / 2;
    const edgeClass = partCount > 0 ? 'mesh-edge mesh-edge-partitioned' : 'mesh-edge mesh-edge-broadcast';
    const edgeLabel = partCount > 0 ? 'SQL tasks (partitioned)' : 'SQL tasks (broadcast-only)';
    body += `
      <g class="mesh-hoverable"
         data-info-title="${esc(edgeLabel)} · driver → ${esc(a.id)}"
         data-info-desc="${esc(partCount > 0
           ? 'The driver hands scan tasks for the ' + a.partitions.map(p=>p.table+'['+p.key+']').join(', ') + ' partition(s) to this agent by publishing TaskDescriptor envelopes on mesh.agent.task.' + a.id + '. Row results flow back on mesh.query.result.<queryId>.<partitionKey>.'
           : 'This agent holds no distributed table partitions but has the full broadcast dimension cache — the driver still routes broadcast-JOIN sub-plans here.')}">
        <path class="${edgeClass}" d="M ${driverBottomX} ${driverBottomY}
                                     C ${driverBottomX} ${midY}, ${agentTopX} ${midY}, ${agentTopX} ${agentTopY}"
              fill="none" stroke-width="1.5" marker-end="url(#mesh-arrow)" stroke-dasharray="4 4"/>
        <text x="${(driverBottomX + agentTopX) / 2}" y="${midY - 4}" text-anchor="middle"
              class="mesh-edge-label">${esc(edgeLabel)}</text>
      </g>
    `;
  });

  // ---- Pipelines-on-driver panel — big, centered under the driver box,
  // between it and the agent row. Shows the "you started a pipeline; it's
  // running HERE on the driver JVM" story explicitly. Grows with content;
  // stays visible with empty-state hint so users know where to look.
  const driverJobs = runningNodesByAgent['__driver__'] || [];
  const pipelinePanelW = Math.min(W - 2 * PADDING, 720);
  const pipelinePanelX = (W - pipelinePanelW) / 2;
  const pipelinePanelY = PADDING + DRIVER_H + 44;   // just under the broadcast label
  const pipelineRowH   = 28;
  const pipelinePanelH = Math.max(70, 40 + Math.max(1, driverJobs.length) * (pipelineRowH + 4) + (driverJobs.length ? 0 : 6));
  body += `
    <g class="mesh-hoverable" transform="translate(${pipelinePanelX}, ${pipelinePanelY})"
       data-info-title="Pipelines on the driver JVM (Phase 1)"
       data-info-desc="Every pipeline you submit via /mesh/jobs/run runs INSIDE the driver process here — not on the agents. The agents only serve SQL tasks (see the columns below). To distribute pipelines across agents you need to install hitorro-mesh-agent-pipelines on at least one agent and use /mesh/jobs/run-distributed. This panel shows every pipeline that is currently RUNNING plus anything that finished in the last 30 seconds.">
      <rect width="${pipelinePanelW}" height="${pipelinePanelH}" rx="8"
            class="mesh-box mesh-pipeline-panel ${driverJobs.length ? 'has-activity' : ''}"/>
      <text x="12" y="20" class="mesh-title" style="font-size: 0.85rem;">
        ⚙ Pipelines running in the driver JVM
      </text>
      <text x="12" y="36" class="mesh-sub" style="font-size:0.7rem;">
        Phase 1 · pipeline nodes execute here, not on agents · 30-s recent-activity window
      </text>
  `;
  if (driverJobs.length) {
    driverJobs.forEach((n, i) => {
      const rowY = 44 + i * (pipelineRowH + 4);
      const stateClass = n.jobState === 'RUNNING' ? 'mesh-pulse'
                       : n.jobState === 'FAILED'  ? 'mesh-node-failed'
                       : 'mesh-node-succeeded';
      const marker = n.jobState === 'RUNNING' ? '▶' : n.jobState === 'FAILED' ? '✕' : '✓';
      body += `
        <g class="mesh-card mesh-pipeline ${stateClass} mesh-hoverable"
           transform="translate(8, ${rowY})"
           data-info-title="${esc(n.jobState)}: ${esc(n.id)}"
           data-info-desc="Pipeline node '${esc(n.id)}' from job '${esc(n.jobName)}' — executed in the driver JVM. ${n.jobState === 'RUNNING' ? 'Currently emitting rows' : 'Completed ' + (n.rowsOut||0) + ' rows'}. When agents advertise pipeline-node capability the Phase-2 scheduler moves these onto agent columns.">
          <rect width="${pipelinePanelW - 16}" height="${pipelineRowH}" rx="4"/>
          <text x="12" y="${pipelineRowH/2 + 4}" style="font-size:0.78rem;">
            ${marker} ${esc(n.jobName)} · node "${esc(n.id)}" · ${n.rowsOut||0} rows ${n.jobState === 'RUNNING' ? '(running)' : n.jobState === 'FAILED' ? '(failed)' : '(finished)'}
          </text>
        </g>
      `;
    });
  } else {
    body += `
      <text x="12" y="60" class="mesh-sub" style="font-size:0.72rem; fill:var(--muted);">
        no pipeline activity in last 30 s · run one from the Pipelines tab and switch back here
      </text>
    `;
  }
  body += `</g>`;

  // Client → driver dashed line when there's live activity — makes the
  // "you submitted from a browser and it landed on the driver JVM" flow
  // visible. Only render when at least one pipeline is on the panel.
  if (driverJobs.length) {
    const clientY = pipelinePanelY + pipelinePanelH / 2;
    const clientCircleX = pipelinePanelX - 40;
    const arrowStartX = pipelinePanelX;
    body += `
      <g class="mesh-hoverable"
         data-info-title="Client → driver"
         data-info-desc="Pipelines arrive via POST /mesh/jobs/run from any HTTP client (this UI, curl, or another service). The driver's PipelinesController accepts the YAML, hands it to the JobRunner, which drains source → steps → sinks node by node.">
        <circle cx="${clientCircleX}" cy="${clientY}" r="14"
                class="mesh-client-node" fill="#eaf3f8" stroke="var(--primary-mesh)" stroke-width="1.5"/>
        <text x="${clientCircleX}" y="${clientY + 4}" text-anchor="middle" style="font-size:0.7rem; fill:var(--primary-mesh); font-weight:600;">GUI</text>
        <line x1="${clientCircleX + 15}" y1="${clientY}" x2="${arrowStartX - 4}" y2="${clientY}"
              class="mesh-client-edge" stroke="var(--primary-mesh)" stroke-width="1.5"
              marker-end="url(#mesh-arrow)" stroke-dasharray="4 3"/>
      </g>
    `;
  }

  svg.innerHTML = body;

  // Wire hover popovers.
  $$('#mesh-viz .mesh-hoverable').forEach(g => {
    g.addEventListener('mouseenter', (ev) => showMeshInfo(g, ev));
    g.addEventListener('mousemove',  (ev) => showMeshInfo(g, ev));
    g.addEventListener('mouseleave', hideMeshInfo);
  });
  // Click driver / agent boxes → open log-tail modal for that component.
  // Only wire on the outer group (mesh-driver-g / mesh-agent-g), not on
  // every card inside — cards would open the wrong log.
  const meshClick = (comp) => (ev) => {
    ev.stopPropagation();
    hideMeshInfo();
    openMeshLog(comp);
  };
  const driverG = document.querySelector('#mesh-viz .mesh-driver-g');
  if (driverG && !driverG._logWired) {
    driverG._logWired = true;
    driverG.style.cursor = 'pointer';
    driverG.addEventListener('click', meshClick('driver'));
  }
  $$('#mesh-viz .mesh-agent-g').forEach(g => {
    if (g._logWired) return;
    g._logWired = true;
    g.style.cursor = 'pointer';
    // agent id lives in data-info-title
    const agentId = g.getAttribute('data-info-title');
    if (agentId) g.addEventListener('click', meshClick(agentId));
  });
}

function showMeshInfo(g, ev) {
  const info = $('#mesh-info');
  if (!info) return;
  const title = g.getAttribute('data-info-title') || '';
  const desc  = g.getAttribute('data-info-desc')  || '';
  const caps  = g.getAttribute('data-info-caps');
  const blocks = g.getAttribute('data-info-blocks');
  let html = `<div class="mesh-info-title">${esc(title)}</div>`;
  if (desc) html += `<div class="mesh-info-desc">${esc(desc)}</div>`;
  if (caps) {
    try {
      const list = JSON.parse(caps);
      if (list.length) html += `<div class="mesh-info-list"><b>Capabilities:</b> ${list.map(c=>`<code>${esc(c)}</code>`).join(' ')}</div>`;
    } catch(_) {}
  }
  if (blocks) {
    try {
      const list = JSON.parse(blocks);
      if (list.length) html += `<div class="mesh-info-list"><b>Building blocks:</b><ul>${
        list.map(b=>`<li><b>${esc(b.name)}</b> — ${esc(b.desc)}</li>`).join('')
      }</ul></div>`;
    } catch(_) {}
  }
  info.innerHTML = html;
  info.hidden = false;
  const wrapper = $('#mesh-viz-wrapper');
  const rect = wrapper.getBoundingClientRect();
  const w = 400;
  const x = Math.min(ev.clientX - rect.left + 12, rect.width - w - 6);
  const y = Math.min(ev.clientY - rect.top  + 12, rect.height - 260);
  info.style.left = Math.max(6, x) + 'px';
  info.style.top  = Math.max(6, y) + 'px';
  info.style.maxWidth = w + 'px';
}

function hideMeshInfo() {
  const info = $('#mesh-info');
  if (info) info.hidden = true;
}

// ================================================================ PIPELINES
// The Jobs / pipelines tab: bundled examples on the left, YAML editor + status
// panel on the right, plus a rolling "recent runs" article at the bottom.
// State loads lazily when the tab first activates.

let plBundledLoaded = false;
let plBundledCache  = {};
let plActivePoll    = null;

async function refreshPipelines() {
  if (!plBundledLoaded) {
    plBundledLoaded = true;
    await loadBundledExamples();
  }
  await refreshRunHistory();
}

async function loadBundledExamples() {
  try {
    plBundledCache = await api('/mesh/jobs/bundled');
  } catch (e) {
    $('#pl-examples').innerHTML = `<p><small style="color:var(--danger)">error: ${esc(e.message)}</small></p>`;
    return;
  }
  const names = Object.keys(plBundledCache);
  if (names.length === 0) {
    $('#pl-examples').innerHTML = '<p class="meta">No bundled examples on the classpath.</p>';
    return;
  }
  $('#pl-examples').innerHTML = names.map(name => `
    <div class="ds-list-item" data-name="${esc(name)}">
      <div class="name">${esc(name)}</div>
      <span class="meta">click to load into editor</span>
    </div>
  `).join('');
  $$('#pl-examples .ds-list-item').forEach(el => {
    el.addEventListener('click', () => {
      $$('#pl-examples .ds-list-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      $('#pl-yaml').value = plBundledCache[el.dataset.name];
    });
  });
  if (!$('#pl-yaml').value) {
    $('#pl-yaml').value = plBundledCache[names[0]];
    $('#pl-examples .ds-list-item')?.classList.add('active');
  }
}

// Track per-node rowsOut samples so we can compute rows/sec throughput
// on running jobs. Keyed by "<jobId>:<nodeId>".
const plRateSamples = {};

function computeRate(jobId, nodeId, rowsOut) {
  const k = jobId + ':' + nodeId;
  const now = Date.now();
  const prev = plRateSamples[k];
  plRateSamples[k] = { rowsOut, at: now };
  if (!prev) return null;
  const dt = (now - prev.at) / 1000;
  if (dt < 0.3) return null;   // too soon
  const dr = rowsOut - prev.rowsOut;
  return dr < 0 ? null : Math.round(dr / dt);
}

async function refreshRunHistory() {
  let runs = [];
  try { runs = await api('/mesh/jobs'); } catch (_) { }
  if (!runs.length) {
    $('#pl-runs').innerHTML = '<p class="meta">no runs yet — click a bundled example above and hit ▶ Run</p>';
    return;
  }
  $('#pl-runs').innerHTML = runs.map(r => `
    <div class="pl-run-card pl-node-${esc(r.state.toLowerCase())}" data-job="${esc(r.jobId)}">
      <div class="pl-run-hdr">
        <b>${esc(r.jobSpecName || '?')}</b>
        <span class="badge pl-state-${esc(r.state.toLowerCase())}">${esc(r.state)}</span>
      </div>
      <div class="meta">
        <code>${esc(r.jobId)}</code><br>
        started ${esc(fmtTime(r.startedAt))}${r.finishedAt ? ' · finished ' + esc(fmtTime(r.finishedAt)) : ''}
      </div>
      <div style="margin-top: 0.4rem; display:flex; gap: 0.3rem; flex-wrap: wrap;">
        ${(r.nodes || []).map(n => {
          const rate = (r.state === 'RUNNING' && n.state === 'RUNNING')
              ? computeRate(r.jobId, n.id, n.rowsOut) : null;
          const rateChip = rate != null ? ` · ${rate}/s` : '';
          return `
          <span class="pl-mini-node pl-state-${esc(n.state.toLowerCase())}"
                title="${esc(n.id)}: ${esc(n.state)} · ${n.rowsIn}→${n.rowsOut}${rate!=null?' · '+rate+' rows/sec':''}">
            ${esc(n.id)} ${n.rowsOut > 0 ? '· ' + n.rowsOut : ''}${rateChip}
          </span>`;
        }).join('')}
      </div>
      ${r.state === 'RUNNING' ? `
        <div style="margin-top: 0.4rem;">
          <button class="secondary outline pl-cancel-btn" type="button"
                  data-job="${esc(r.jobId)}"
                  style="padding: 0.1rem 0.5rem; font-size: 0.75rem; margin: 0;">
            × cancel
          </button>
        </div>` : ''}
    </div>
  `).join('');
  // Cancel-button wiring — one DELETE per click, non-blocking.
  $$('.pl-cancel-btn').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const jobId = b.dataset.job;
    try {
      await api('/mesh/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' });
    } catch (err) {
      alert('cancel failed: ' + err.message);
    }
  }));
  // Click-a-card → pin the status panel to that job.
  $$('.pl-run-card').forEach(c => c.addEventListener('click', () => {
    const jobId = c.dataset.job;
    if (!jobId) return;
    $('#pl-status').hidden = false;
    $('#pl-status-id').textContent = jobId;
    startPolling(jobId);
  }));

  // If any RUNNING, schedule another refresh in 1s.
  if (runs.some(r => r.state === 'RUNNING')) {
    if (plHistoryTimer) clearTimeout(plHistoryTimer);
    plHistoryTimer = setTimeout(refreshRunHistory, 1000);
  }
}

function fmtTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString(); } catch (_) { return iso; }
}

let plHistoryTimer = null;

// ================================================================ PIPELINE BUILDER (multi-node DAG)
// Data model lives entirely in `pbJob`; every UI event mutates it, then
// `pbRefresh()` re-renders the node list, the selected-node editor, and
// the live YAML preview. Two-way with the Run tab's YAML editor via the
// "Send to Run tab" / "Load from YAML" buttons — see pbPushToRun /
// pbLoadFromYaml. Kind metadata is centralized in PB_SOURCE/STEP/SINK_KINDS
// so adding a new kind is one entry, not a scatter of switch cases.

let pbJob = { id: 'my-job', nodes: [] };
let pbSelected = -1;   // index into pbJob.nodes, -1 = none

// -- Kind catalog --------------------------------------------------------
// Each field is one input row. `type` defaults to 'text'; `csv:true` splits
// on comma on save and joins on render; `textarea:true` renders a multi-
// line box. `default` primes the value on `+ add`. `doc` deep-links into
// the Docs sub-tab so users can read the shape without leaving Build.
const PB_SOURCE_KINDS = {
  inline:       { fields: [], doc: 'source-inline',
                  hint: 'literal rows in the YAML — edit them in the Run tab editor for now' },
  'ndjson-file':{ fields: [{name:'url', placeholder:'file:./data.ndjson[.gz]'}], doc: 'source-ndjson-file' },
  'json-file':  { fields: [{name:'url', placeholder:'file:./data.json'}], doc: 'source-json-file' },
  'csv-file':   { fields: [{name:'url', placeholder:'file:./data.csv'}], doc: 'source-csv-file' },
  sql:          { fields: [{name:'sql', textarea:true, rows:3, placeholder:'SELECT * FROM my_table'}], doc: 'source-sql' },
  kvstore:      { fields: [{name:'name', placeholder:'store-name'}], doc: 'source-kvstore' },
  lucene:       { fields: [{name:'name', placeholder:'index-name'}, {name:'query', placeholder:'*:*', default:'*:*'}], doc: 'source-lucene' },
  ref:          { fields: [{name:'node', placeholder:'upstream-node-id'}], doc: 'source-ref',
                  hint: 'consumes rows from the specified upstream node — remember to add its id to depends[]' },
  nats:         { fields: [{name:'servers', default:'nats://localhost:4222'}, {name:'subject', placeholder:'my.subject'}], doc: 'source-nats' },
  kafka:        { fields: [{name:'bootstrap', default:'localhost:9092'}, {name:'topic'}, {name:'groupId', default:'ui-builder'}], doc: 'source-kafka' },
};
const PB_STEP_KINDS = {
  filter:       { fields: [{name:'expr', placeholder:'e.g. population > 50000000'}], doc: 'step-filter' },
  project:      { fields: [{name:'cols', csv:true, placeholder:'comma-separated field names'}], doc: 'step-project' },
  'set-field':  { fields: [{name:'name'}, {name:'value'}], doc: 'step-set-field',
                  hint: 'value is parsed as number/boolean when it looks like one' },
  'groovy-map': { fields: [{name:'script', textarea:true, rows:5, placeholder:"row.upper = row.name?.toUpperCase(); return row"}], doc: 'step-groovy-map' },
  'jvs-enrich': { fields: [{name:'typeJsonResource', placeholder:'classpath:/types/my_type.json'},
                           {name:'tags', csv:true, default:['basic','segmented','pos']}], doc: 'step-jvs-enrich',
                  hint: 'runs the JVS enrichment projection — populates dynamic sub-fields (segmented, pos, segmented_ner)' },
  'jvs-translate':{ fields: [{name:'sourceLang', default:'en'}, {name:'targetLangs', csv:true, default:['es','fr','de']},
                             {name:'mlsFields', csv:true, default:['title','body']},
                             {name:'ollamaUrl', default:'http://localhost:11434'}, {name:'model', default:'llama3.2'}], doc: 'step-jvs-translate' },
};
const PB_SINK_KINDS = {
  'memory-table':{ fields: [{name:'name'}], doc: 'sink-memory-table',
                   hint: 'in-process buffer — read from other nodes via source: {kind: ref, node: X}' },
  counting:      { fields: [{name:'label'}], doc: 'sink-counting' },
  'ndjson-file': { fields: [{name:'url', placeholder:'file:./out.ndjson[.gz]'}], doc: 'sink-ndjson-file' },
  kvstore:       { fields: [{name:'name'}, {name:'keyExpr', default:'id', placeholder:'dotted path'}], doc: 'sink-kvstore' },
  lucene:        { fields: [{name:'name'}, {name:'storeSource', type:'checkbox', default:true}], doc: 'sink-lucene' },
  'jvs-lucene':  { fields: [{name:'name'}, {name:'typeJsonResource', placeholder:'classpath:/types/my_type.json'},
                            {name:'storeSource', type:'checkbox'}], doc: 'sink-jvs-lucene' },
  nats:          { fields: [{name:'servers', default:'nats://localhost:4222'}, {name:'subject'}], doc: 'sink-nats' },
};

// -- Model mutations -----------------------------------------------------
function pbAddNode() {
  const n = 1 + pbJob.nodes.length;
  const base = { id: 'node' + n, depends: [], source: {kind: 'inline'},
                 steps: [], reduce: null, sinks: [{kind: 'counting', label: 'node' + n}] };
  pbJob.nodes.push(base);
  pbSelected = pbJob.nodes.length - 1;
  pbRefresh();
}
function pbDeleteNode() {
  if (pbSelected < 0) return;
  const removed = pbJob.nodes[pbSelected].id;
  pbJob.nodes.splice(pbSelected, 1);
  // Drop dangling depends[] references.
  for (const n of pbJob.nodes) n.depends = n.depends.filter(d => d !== removed);
  pbSelected = -1;
  pbRefresh();
}
function pbSelectNode(idx) { pbSelected = idx; pbRefresh(); }

// -- Rendering -----------------------------------------------------------
function pbRefresh() {
  if (!$('#pb-node-list')) return;
  pbRenderNodeList();
  pbRenderEditor();
  pbRenderYaml();
}
function pbRenderNodeList() {
  $('#pb-node-count').textContent = pbJob.nodes.length;
  const host = $('#pb-node-list');
  if (!pbJob.nodes.length) {
    host.innerHTML = '<li class="meta" style="border-color:transparent;cursor:default;">no nodes yet</li>';
    return;
  }
  host.innerHTML = pbJob.nodes.map((n, i) => `
    <li data-idx="${i}" class="${i===pbSelected?'active':''}">
      <span>${esc(n.id)}</span>
      <span class="pb-node-summary">${esc(n.source?.kind || '?')} → ${n.sinks?.length || 0} sink${n.sinks?.length===1?'':'s'}</span>
    </li>`).join('');
  host.querySelectorAll('li[data-idx]').forEach(li =>
    li.addEventListener('click', () => pbSelectNode(+li.dataset.idx)));
}
function pbRenderEditor() {
  const empty = $('#pb-editor-empty');
  const ed = $('#pb-editor');
  const del = $('#pb-delete-node');
  if (pbSelected < 0 || !pbJob.nodes[pbSelected]) {
    empty.hidden = false; ed.hidden = true; del.style.display = 'none';
    $('#pb-editor-title').textContent = 'Select a node →';
    return;
  }
  empty.hidden = true; ed.hidden = false; del.style.display = '';
  const node = pbJob.nodes[pbSelected];
  $('#pb-editor-title').textContent = 'node: ' + node.id;
  $('#pb-node-id').value = node.id;
  pbRenderDepends(node);
  pbRenderSource(node);
  pbRenderSteps(node);
  pbRenderReduce(node);
  pbRenderSinks(node);
}
function pbRenderDepends(node) {
  const host = $('#pb-node-depends');
  const others = pbJob.nodes.filter((_, i) => i !== pbSelected);
  if (!others.length) { host.innerHTML = '<span class="meta">(no other nodes yet)</span>'; return; }
  host.innerHTML = others.map(o => `
    <label><input type="checkbox" data-dep="${esc(o.id)}"
             ${node.depends.includes(o.id)?'checked':''}/> ${esc(o.id)}</label>`).join('');
  host.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', () => {
      const id = cb.dataset.dep;
      if (cb.checked) { if (!node.depends.includes(id)) node.depends.push(id); }
      else node.depends = node.depends.filter(d => d !== id);
      pbRenderYaml();
    }));
}
function pbRenderSource(node) {
  const host = $('#pb-source-editor');
  const kind = node.source?.kind || 'inline';
  const opts = Object.keys(PB_SOURCE_KINDS).map(k =>
      `<option value="${k}"${k===kind?' selected':''}>${k}</option>`).join('');
  host.innerHTML = `
    <div class="pb-field-row"><label>kind</label>
      <select id="pb-source-kind">${opts}</select>
      <a href="#" class="meta" data-doc="${PB_SOURCE_KINDS[kind]?.doc||''}" title="Open in Docs">📖</a>
    </div>
    ${pbFieldsHtml(PB_SOURCE_KINDS[kind]?.fields || [], node.source, 'src')}
    ${PB_SOURCE_KINDS[kind]?.hint
      ? `<p class="meta" style="margin:0.2rem 0 0.4rem 6.9rem;">${esc(PB_SOURCE_KINDS[kind].hint)}</p>` : ''}`;
  host.querySelector('#pb-source-kind').addEventListener('change', e => {
    node.source = {kind: e.target.value};
    // Seed defaults from field defs.
    (PB_SOURCE_KINDS[node.source.kind]?.fields || []).forEach(f => {
      if (f.default !== undefined) node.source[f.name] = f.default;
    });
    pbRenderEditor(); pbRenderYaml();
  });
  pbWireFieldChange(host, 'src', node.source);
  pbWireDocLinks(host);
}
function pbRenderSteps(node) {
  const host = $('#pb-steps-editor');
  if (!node.steps.length) {
    host.innerHTML = '<p class="meta">no steps · rows flow source → sinks unmodified</p>';
    return;
  }
  host.innerHTML = node.steps.map((s, i) => pbCardHtml('step', s, i)).join('');
  host.querySelectorAll('.pb-step-card').forEach((card, i) => {
    pbWireFieldChange(card, 'step', node.steps[i]);
    card.querySelector('button.remove').addEventListener('click', () => {
      node.steps.splice(i, 1); pbRenderEditor(); pbRenderYaml();
    });
  });
  pbWireDocLinks(host);
}
function pbRenderReduce(node) {
  const host = $('#pb-reduce-editor');
  const enabled = $('#pb-reduce-enable');
  enabled.checked = !!node.reduce;
  enabled.onchange = () => {
    node.reduce = enabled.checked ? {groupBy: [], aggs: []} : null;
    pbRenderReduce(node); pbRenderYaml();
  };
  if (!node.reduce) { host.innerHTML = '<p class="meta">reduce disabled — flip the checkbox above to add group-by + aggs</p>'; return; }
  const r = node.reduce;
  host.innerHTML = `
    <div class="pb-field-row"><label>group-by</label>
      <input type="text" data-red="groupBy" placeholder="comma-separated cols" value="${esc((r.groupBy||[]).join(', '))}"/></div>
    <p class="meta" style="margin:0.2rem 0 0.4rem 6.9rem;">aggregations (name = kind of col):</p>
    ${(r.aggs || []).map((a, i) => `
      <div class="pb-field-row" data-agg="${i}">
        <label></label>
        <input type="text" placeholder="output name" data-af="name" value="${esc(a.name||'')}" style="width:9rem;flex:0 0 auto;"/>
        <select data-af="kind" style="width:7rem;flex:0 0 auto;">
          ${['COUNT','SUM','AVG','MIN','MAX'].map(k => `<option ${a.kind===k?'selected':''}>${k}</option>`).join('')}
        </select>
        <input type="text" placeholder="of column (skip for COUNT)" data-af="of" value="${esc(a.of||'')}"/>
        <button type="button" class="remove secondary outline" style="padding:0.05rem 0.4rem;">×</button>
      </div>`).join('')}
    <div class="pb-field-row"><label></label>
      <button type="button" id="pb-add-agg" class="secondary outline" style="width:auto;padding:0.1rem 0.5rem;">+ agg</button></div>`;
  host.querySelector('[data-red="groupBy"]').addEventListener('input', e => {
    r.groupBy = e.target.value.split(',').map(s => s.trim()).filter(Boolean); pbRenderYaml();
  });
  host.querySelectorAll('[data-agg]').forEach((row, i) => {
    row.querySelectorAll('[data-af]').forEach(inp => inp.addEventListener('input', e => {
      const f = inp.dataset.af;
      r.aggs[i][f] = f === 'kind' ? e.target.value : e.target.value.trim();
      pbRenderYaml();
    }));
    row.querySelector('button.remove').addEventListener('click', () => {
      r.aggs.splice(i, 1); pbRenderReduce(node); pbRenderYaml();
    });
  });
  host.querySelector('#pb-add-agg').addEventListener('click', () => {
    r.aggs.push({name: 'n', kind: 'COUNT'}); pbRenderReduce(node); pbRenderYaml();
  });
}
function pbRenderSinks(node) {
  const host = $('#pb-sinks-editor');
  if (!node.sinks.length) {
    host.innerHTML = '<p class="meta">no sinks · pipeline results discarded — add at least one</p>';
    return;
  }
  host.innerHTML = node.sinks.map((s, i) => pbCardHtml('sink', s, i)).join('');
  host.querySelectorAll('.pb-sink-card').forEach((card, i) => {
    pbWireFieldChange(card, 'sink', node.sinks[i]);
    card.querySelector('button.remove').addEventListener('click', () => {
      node.sinks.splice(i, 1); pbRenderEditor(); pbRenderYaml();
    });
  });
  pbWireDocLinks(host);
}

// -- Kind-agnostic field renderers --------------------------------------
function pbCardHtml(kindClass, entry, idx) {
  const catalog = kindClass === 'step' ? PB_STEP_KINDS : PB_SINK_KINDS;
  const meta = catalog[entry.kind] || {fields: []};
  const doc = meta.doc || '';
  return `<div class="pb-${kindClass}-card" data-idx="${idx}">
    <div class="pb-card-hdr">
      <span class="pb-kind">${esc(entry.kind)}
        <a href="#" class="meta" data-doc="${esc(doc)}" title="Open in Docs">📖</a>
      </span>
      <button type="button" class="remove">remove</button>
    </div>
    ${pbFieldsHtml(meta.fields, entry, kindClass)}
    ${meta.hint ? `<p class="meta" style="margin:0.2rem 0 0 0;">${esc(meta.hint)}</p>` : ''}
  </div>`;
}
function pbFieldsHtml(fields, entry, scope) {
  return fields.map(f => {
    const val = entry[f.name];
    if (f.type === 'checkbox') {
      const on = val === undefined ? !!f.default : !!val;
      return `<div class="pb-field-row"><label>${esc(f.name)}</label>
        <label style="min-width:0;"><input type="checkbox" data-f="${esc(f.name)}" ${on?'checked':''}/>
        <small class="meta">${esc(f.name)}=${on}</small></label></div>`;
    }
    if (f.textarea) {
      const rows = f.rows || 3;
      return `<div class="pb-field-row" style="align-items:flex-start;">
        <label>${esc(f.name)}</label>
        <textarea data-f="${esc(f.name)}" rows="${rows}" placeholder="${esc(f.placeholder||'')}"
                  style="width:100%;font-family:ui-monospace,monospace;font-size:0.8rem;">${esc(pbFieldToString(val, f))}</textarea></div>`;
    }
    return `<div class="pb-field-row"><label>${esc(f.name)}</label>
      <input type="text" data-f="${esc(f.name)}" placeholder="${esc(f.placeholder||'')}"
             value="${esc(pbFieldToString(val, f))}"/></div>`;
  }).join('');
}
function pbFieldToString(v, f) {
  if (v == null) return f.default != null ? pbFieldToString(f.default, {csv:f.csv}) : '';
  if (f.csv && Array.isArray(v)) return v.join(', ');
  return String(v);
}
function pbWireFieldChange(root, scope, target) {
  root.querySelectorAll('[data-f]').forEach(inp => {
    const fname = inp.dataset.f;
    const catalog = scope === 'src'   ? PB_SOURCE_KINDS
                  : scope === 'step'  ? PB_STEP_KINDS
                  :                     PB_SINK_KINDS;
    const meta = catalog[target.kind];
    const fdef = (meta?.fields || []).find(f => f.name === fname) || {};
    inp.addEventListener(inp.type === 'checkbox' ? 'change' : 'input', () => {
      let v;
      if (inp.type === 'checkbox') v = inp.checked;
      else if (fdef.csv) v = inp.value.split(',').map(s => s.trim()).filter(Boolean);
      else v = inp.value;
      // Drop empties so YAML preview stays clean.
      if (v === '' || (Array.isArray(v) && !v.length)) delete target[fname];
      else target[fname] = v;
      pbRenderYaml();
      // Re-render the node list summary if this was a source kind change etc.
      if (scope === 'src') pbRenderNodeList();
    });
  });
}
function pbWireDocLinks(root) {
  root.querySelectorAll('a[data-doc]').forEach(a =>
    a.addEventListener('click', e => {
      e.preventDefault();
      const id = a.dataset.doc;
      if (!id) return;
      document.querySelector('[data-view="pl-docs"]').click();
      setTimeout(() => {
        const link = document.querySelector(`#pl-docs-nav a[data-anchor="${CSS.escape(id)}"]`);
        if (link) link.click();
      }, 30);
    }));
}

// -- YAML preview -------------------------------------------------------
function pbRenderYaml() {
  const yaml = pbToYaml();
  $('#pb-yaml-preview').innerHTML = '<code>' + esc(yaml) + '</code>';
  return yaml;
}
function pbToYaml() {
  if (!pbJob.nodes.length) return '(add a node to start)';
  const lines = [`job: ${pbJob.id || 'my-job'}`, 'version: "1"', 'nodes:'];
  for (const n of pbJob.nodes) {
    lines.push(`  - id: ${n.id}`);
    if (n.depends && n.depends.length) lines.push(`    depends: [${n.depends.join(', ')}]`);
    lines.push('    pipeline:');
    lines.push('      source: ' + JSON.stringify(pbCleanEntry(n.source, 'src')));
    if (n.steps && n.steps.length) {
      lines.push('      steps:');
      for (const s of n.steps) lines.push('        - ' + JSON.stringify(pbCleanEntry(s, 'step')));
    }
    if (n.reduce) {
      lines.push('      reduce:');
      lines.push('        group-by: [' + (n.reduce.groupBy || []).join(', ') + ']');
      lines.push('        aggs:');
      for (const a of (n.reduce.aggs || [])) {
        const o = a.of ? `, of: ${a.of}` : '';
        lines.push(`          - {name: ${a.name || 'n'}, kind: ${a.kind || 'COUNT'}${o}}`);
      }
    }
    if (n.sinks && n.sinks.length) {
      lines.push('      sinks:');
      for (const s of n.sinks) lines.push('        - ' + JSON.stringify(pbCleanEntry(s, 'sink')));
    }
  }
  return lines.join('\n');
}
function pbCleanEntry(entry, scope) {
  const catalog = scope === 'src' ? PB_SOURCE_KINDS
                : scope === 'step' ? PB_STEP_KINDS
                :                    PB_SINK_KINDS;
  const meta = catalog[entry.kind];
  const out = {kind: entry.kind};
  if (!meta) return {...entry};
  for (const f of meta.fields) {
    let v = entry[f.name];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (f.type === 'checkbox') { out[f.name] = !!v; continue; }
    // Parse numbers / booleans for scalar text fields when it's obvious.
    if (!f.csv && typeof v === 'string') {
      const n = Number(v);
      if (v !== '' && !isNaN(n)) v = n;
      else if (v === 'true') v = true;
      else if (v === 'false') v = false;
    }
    out[f.name] = v;
  }
  return out;
}

// -- Round-trip helpers -------------------------------------------------
function pbPushToRun() {
  const y = pbToYaml();
  if (!$('#pl-yaml')) return;
  $('#pl-yaml').value = y;
  const runTab = document.querySelector('[data-view="pl-run"]');
  if (runTab) runTab.click();
  pbStatus('sent to Run tab · click ▶ Run', 'ok');
}
function pbLoadFromYaml() {
  const src = $('#pl-yaml')?.value?.trim();
  if (!src) { pbStatus('Run tab editor is empty', 'err'); return; }
  try {
    const parsed = pbParseYaml(src);
    pbJob = parsed;
    pbSelected = pbJob.nodes.length ? 0 : -1;
    $('#pb-job-id').value = pbJob.id;
    pbRefresh();
    pbStatus(`loaded ${pbJob.nodes.length} node(s)`, 'ok');
  } catch (e) {
    pbStatus('parse failed: ' + e.message, 'err');
  }
}
// Minimal YAML→JobSpec parser. Handles the shape our own emitter produces
// plus the shipped examples: top-level scalars, nodes[] with pipeline{}
// containing source (object literal), steps[] (object literals), reduce
// with group-by + aggs, sinks[] (object literals). Object literals must
// be JSON-shaped ({key: value, ...}) — the same format pbToYaml() writes.
function pbParseYaml(src) {
  const lines = src.split('\n');
  const job = {id: 'my-job', nodes: []};
  let curNode = null, curPipeSect = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m2 = raw.match(/^(\s*)/);
    const indent = m2[1].length;
    const trimmed = raw.trim();
    if (indent === 0 && /^job:\s*/.test(trimmed))     { job.id = trimmed.replace(/^job:\s*/, '').replace(/["']/g,''); continue; }
    if (indent === 0 && /^version:/.test(trimmed))    continue;
    if (indent === 0 && /^nodes:/.test(trimmed))      continue;
    // New node — line like "  - id: X" at indent 2
    let nm;
    if (indent === 2 && (nm = trimmed.match(/^-\s*id:\s*(\S+)/))) {
      curNode = {id: nm[1], depends: [], source: {kind:'inline'}, steps: [], reduce: null, sinks: []};
      job.nodes.push(curNode); curPipeSect = null; continue;
    }
    if (!curNode) continue;
    // depends
    let dm;
    if ((dm = trimmed.match(/^depends:\s*\[(.*)\]/))) {
      curNode.depends = dm[1].split(',').map(s => s.trim()).filter(Boolean); continue;
    }
    if (/^pipeline:/.test(trimmed)) { curPipeSect = null; continue; }
    if (/^source:/.test(trimmed)) {
      const body = trimmed.replace(/^source:\s*/, '');
      curNode.source = body.startsWith('{') ? pbParseInlineObj(body) : {kind:'inline'};
      curPipeSect = 'source'; continue;
    }
    if (/^steps:/.test(trimmed))   { curPipeSect = 'steps';  continue; }
    if (/^reduce:/.test(trimmed))  { curPipeSect = 'reduce'; curNode.reduce = {groupBy:[], aggs:[]}; continue; }
    if (/^sinks:/.test(trimmed))   { curPipeSect = 'sinks';  continue; }
    if (curPipeSect === 'steps' && trimmed.startsWith('-')) {
      curNode.steps.push(pbParseInlineObj(trimmed.replace(/^-\s*/, '')));
    } else if (curPipeSect === 'sinks' && trimmed.startsWith('-')) {
      curNode.sinks.push(pbParseInlineObj(trimmed.replace(/^-\s*/, '')));
    } else if (curPipeSect === 'reduce' && /^group-by:/.test(trimmed)) {
      const m = trimmed.match(/^group-by:\s*\[(.*)\]/);
      if (m) curNode.reduce.groupBy = m[1].split(',').map(s => s.trim()).filter(Boolean);
    } else if (curPipeSect === 'reduce' && /^aggs:/.test(trimmed)) {
      // aggs entries handled by "- " prefix at deeper indent below
    } else if (curPipeSect === 'reduce' && trimmed.startsWith('-')) {
      curNode.reduce.aggs.push(pbParseInlineObj(trimmed.replace(/^-\s*/, '')));
    }
  }
  return job;
}
function pbParseInlineObj(s) {
  // Convert {key: value, key: "value"} style to JSON: quote unquoted keys.
  // Handles our own emitter output (JSON-shaped) AND the shipped examples
  // (YAML-flow-shape with unquoted keys/vals).
  s = s.trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (_) { /* fall through */ }
    // Loose fix: quote bare keys and bare string values, drop trailing
    // commas. Handles: {kind: inline, url: file:foo, cols: [a, b]}.
    const jsonish = s
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":')     // keys
      .replace(/:\s*([A-Za-z_][A-Za-z0-9_./:-]*)\s*([,}])/g, ':"$1"$2') // bare scalar values
      .replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(jsonish); } catch (e) { throw new Error(`cannot parse: ${s.substr(0,60)}`); }
  }
  return {kind: 'inline'};
}
function pbStatus(msg, kind) {
  const el = $('#pb-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === 'err' ? '#c0392b' : '#27ae60';
  setTimeout(() => { el.textContent = ''; }, 4000);
}

// Called when the Build sub-tab is activated (first time or on click).
function refreshPlBuilder() {
  if (!$('#pb-node-list')) return;
  pbRefresh();
}

// ================================================================ PIPELINES HISTORY
// Slice of /mesh/jobs — filters to pipeline-shaped runs (has jobSpecName),
// newest first. Reuses the Jobs tab's summary card.
async function refreshPlHistory() {
  const host = $('#pl-history-list');
  if (!host) return;
  host.innerHTML = '<p><small>loading…</small></p>';
  try {
    const jobs = await api('/mesh/jobs');
    const pl = jobs.filter(j => j.jobSpecName);
    pl.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    $('#pl-history-count').textContent = pl.length;
    if (!pl.length) { host.innerHTML = '<p class="meta">no pipeline runs yet</p>'; return; }
    host.innerHTML = '<table style="width:100%;font-size:0.85rem;"><thead><tr>'
      + '<th style="text-align:left;padding:0.3rem;">job</th>'
      + '<th style="text-align:left;padding:0.3rem;">state</th>'
      + '<th style="text-align:left;padding:0.3rem;">started</th>'
      + '<th style="text-align:left;padding:0.3rem;">nodes</th>'
      + '<th style="text-align:left;padding:0.3rem;">rows</th></tr></thead><tbody>'
      + pl.map(j => {
          const stateCls = j.state === 'SUCCEEDED' ? 'success'
                        : j.state === 'FAILED'    ? 'danger'
                        : j.state === 'RUNNING'   ? 'accent' : '';
          const rows = (j.nodes || []).reduce((s, n) => s + (n.rowsOut || 0), 0);
          return `<tr>
            <td style="padding:0.25rem 0.3rem;"><code>${esc(j.jobSpecName || j.jobId)}</code></td>
            <td style="padding:0.25rem 0.3rem;"><span class="badge ${stateCls}">${esc(j.state || '?')}</span></td>
            <td style="padding:0.25rem 0.3rem;font-size:0.75rem;">${esc((j.startedAt || '').replace('T', ' ').substr(0,19))}</td>
            <td style="padding:0.25rem 0.3rem;">${(j.nodes || []).length}</td>
            <td style="padding:0.25rem 0.3rem;">${rows.toLocaleString()}</td>
          </tr>`;
        }).join('') + '</tbody></table>';
  } catch (e) {
    host.innerHTML = `<p style="color:var(--danger)"><small>error: ${esc(e.message)}</small></p>`;
  }
}

// ================================================================ PIPELINES DOCS
// Per-kind YAML reference. Populated once — pure static content.
const PL_DOCS = {
  categories: [
    ['Sources', [
      ['source-inline',      'source: inline',        'literal rows in YAML',
       `source: {kind: inline, rows: [{msg: hello}, {msg: world}]}`],
      ['source-ndjson-file', 'source: ndjson-file',   'one JSON per line, gz/bz2/zst decoded by extension',
       `source: {kind: ndjson-file, url: "file:./data.ndjson.gz"}`],
      ['source-json-file',   'source: json-file',     'top-level array',
       `source: {kind: json-file, url: "file:./items.json"}`],
      ['source-csv-file',    'source: csv-file',      'first row is header, all cells parsed as strings',
       `source: {kind: csv-file, url: "src/test/resources/countries.csv"}`],
      ['source-sql',         'source: sql',           'runs a mesh query, streams result rows',
       `source: {kind: sql, sql: "SELECT * FROM iso_currencies LIMIT 10"}`],
      ['source-kvstore',     'source: kvstore',       'iterates a RocksDB store; each row is the stored value',
       `source: {kind: kvstore, name: articles}`],
      ['source-lucene',      'source: lucene',        'streams hits from a Lucene index — needs mesh-pipelines-lucene',
       `source: {kind: lucene, name: articles, query: "London"}`],
      ['source-ref',         'source: ref',           'consumes rows from an upstream node — add its id to depends[]',
       `source: {kind: ref, node: countries}`],
      ['source-nats',        'source: nats',          'subscribes to a subject (streaming)',
       `source: {kind: nats, servers: "nats://localhost:4222", subject: "events.>"}`],
      ['source-kafka',       'source: kafka',         'consumes a topic (streaming) — needs kafka-clients',
       `source: {kind: kafka, bootstrap: "localhost:9092", topic: "events", groupId: "pl"}`],
    ]],
    ['Steps', [
      ['step-filter',        'step: filter',          'Groovy boolean expression; rows evaluating false are dropped',
       `- {kind: filter, expr: "row.population > 50000000"}`],
      ['step-project',       'step: project',         'keep only the listed columns',
       `- {kind: project, cols: [id, name, region]}`],
      ['step-set-field',     'step: set-field',       'set/overwrite one field with a constant',
       `- {kind: set-field, name: source, value: "seed"}`],
      ['step-groovy-map',    'step: groovy-map',      'Groovy row→row; return null to drop the row',
       `- {kind: groovy-map, script: |
    row.upper = row.name?.toUpperCase()
    return row}`],
      ['step-jvs-enrich',    'step: jvs-enrich',      'runs JVS enrichment projection — populates dynamic sub-fields (segmented, pos, segmented_ner, clean)',
       `- {kind: jvs-enrich, typeJsonResource: "classpath:/types/demo_enriched_article.json",
     tags: [basic, segmented, pos, ner]}`],
      ['step-jvs-translate', 'step: jvs-translate',   'translates mls text fields via local Ollama; idempotent (skips langs already present)',
       `- {kind: jvs-translate, sourceLang: en, targetLangs: [es, fr, de],
     mlsFields: [title, body], ollamaUrl: "http://localhost:11434", model: llama3.2}`],
    ]],
    ['Reduce', [
      ['reduce-groupby',     'reduce: group-by + aggs', 'group rows and aggregate — routed through JvsSqlEngine',
       `reduce:
  group-by: [region]
  aggs:
    - {name: n, kind: COUNT}
    - {name: total_pop, kind: SUM, of: population}
    - {name: max_pop, kind: MAX, of: population}`],
    ]],
    ['Extending', [
      ['ext-transforms',     'Add a row-by-row transform', 'implement StepAdapter — 4 files (SinkSpec case + adapter + META-INF/services + optional UI hint). For one-off logic, prefer kind: groovy-map (no code changes).',
       `# Zero code — inline Groovy:
- kind: groovy-map
  script: |
    row.upper = row.name?.toUpperCase()
    return row

# Or a full StepAdapter (see hitorro-mesh-pipelines/docs/pipeline-framework.adoc):
1. StepSpec.java  → add @JsonSubTypes.Type(name = "my-kind")
2. MyStepAdapter  → implements StepAdapter, handles + compile
3. META-INF/services/com.hitorro.mesh.pipelines.runtime.StepAdapter
4. app.js         → add to PL_STEP_KINDS + PL_DOCS.categories.Steps`],
      ['ext-sinks',          'Add a sink',            'implement Sink + SinkAdapter — 4 files. Overriding addIdempotent(taskId, seq, row) gives you exactly-once on retry.',
       `1. SinkSpec.java  → add @JsonSubTypes.Type(name = "my-sink")
2. MySink         → implements Sink (open, add, count, close, [addIdempotent])
3. MySinkAdapter  → implements SinkAdapter, handles + create
4. META-INF/services/com.hitorro.mesh.pipelines.sinks.SinkAdapter

# Existing reference impls:
#   memory-table (built-in)  ndjson-file (built-in)  counting (built-in)
#   kvstore  (hitorro-mesh-pipelines-kvstore)
#   lucene   (hitorro-mesh-pipelines-lucene)
#   jvs-lucene (hitorro-mesh-pipelines-jvstype)
#   nats, kafka (built-in, optional dep)`],
      ['ext-dynamic-mapper', 'Add an enrichment mapper', 'implement DynamicFieldMapper — computes a dynamic field (NER, POS, sentiment, embedding) on the JVS.',
       `1. class MyMapper extends DynamicFieldMapper { JsonNode map(jvs, pa, depth) {...} }
2. Reference from a type Group:
   { "name": "sentiment", "method": "double", "tags": ["sentiment"],
     "dynamic": { "class": "com.example.MyMapper",
                  "fields": [".clean", ".lang"] } }
3. Run enrichment with your tag:
   { kind: jvs-enrich, typeJsonResource: "...", tags: [basic, sentiment] }`],
      ['ext-retrieval',      'Add a retrieval stage', 'implement Retriever — participates in the search → fetch → fixup → paginate → facet → summarize pipeline.',
       `1. class MyStage implements Retriever {
     boolean participate(RetrievalContext ctx) { ... }
     void execute(JVS query, RetrievalContext ctx, RetrievalResult result) { ... }
   }
2. Wire into RetrievalPipelineBuilder in RetrievalService.buildPipeline`],
      ['ext-dataset',        'Add a dataset',         'Author install-<id>.sh + manifest yaml + type json in hitorro-mesh-datasets. mesh-init-data.sh (auto-run by mesh-up.sh) picks it up.',
       `# hitorro-mesh-datasets/
#   scripts/install-my-dataset.sh
#   src/main/resources/manifests/my-dataset.yaml
#   src/main/resources/types/my_dataset.json

# See hitorro-mesh-datasets/docs/authoring-datasets.adoc for the full walkthrough.
./scripts/install-my-dataset.sh
./mesh-down.sh && ./mesh-up.sh`],
    ]],
    ['Sinks', [
      ['sink-memory-table',  'sink: memory-table',    'in-process buffer other nodes can read via source: {kind: ref}',
       `- {kind: memory-table, name: countries-mem}`],
      ['sink-counting',      'sink: counting',        'discards rows, counts them — good for a dry-run leaf',
       `- {kind: counting, label: seed-count}`],
      ['sink-ndjson-file',   'sink: ndjson-file',     'one JSON per line; .gz suffix → gzip on write',
       `- {kind: ndjson-file, url: "target/pipelines-test/out.ndjson.gz"}`],
      ['sink-kvstore',       'sink: kvstore',         'RocksDB put keyed by keyExpr — needs mesh-pipelines-kvstore',
       `- {kind: kvstore, name: articles, keyExpr: "id.id"}`],
      ['sink-lucene',        'sink: lucene',          'generic (schema-less) Lucene indexer — needs mesh-pipelines-lucene',
       `- {kind: lucene, name: airports-search, storeSource: true}`],
      ['sink-jvs-lucene',    'sink: jvs-lucene',      'type-aware Lucene sink via JVSLuceneIndexWriter — needs mesh-pipelines-jvstype',
       `- {kind: jvs-lucene, name: articles,
     typeJsonResource: "classpath:/types/demo_enriched_article.json", storeSource: false}`],
      ['sink-nats',          'sink: nats',            'publishes each row to a subject',
       `- {kind: nats, servers: "nats://localhost:4222", subject: "articles.enriched"}`],
    ]],
  ],
};
let plDocsSelected = null;
function refreshPlDocs() {
  const nav = $('#pl-docs-nav'); const body = $('#pl-docs-body');
  if (!nav) return;
  if (nav.dataset.built === '1') { if (plDocsSelected) plDocsShow(plDocsSelected); return; }
  const parts = [];
  parts.push('<ul style="list-style:none;padding:0;margin:0;">');
  for (const [cat, items] of PL_DOCS.categories) {
    parts.push(`<li class="pl-docs-cat">${esc(cat)}</li>`);
    for (const [id, title] of items) {
      parts.push(`<li><a href="#" data-anchor="${esc(id)}">${esc(title)}</a></li>`);
    }
  }
  parts.push('</ul>');
  nav.innerHTML = parts.join('');
  nav.dataset.built = '1';
  nav.querySelectorAll('a[data-anchor]').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); plDocsShow(a.dataset.anchor); }));
  const first = PL_DOCS.categories[0][1][0][0];
  plDocsShow(first);
}
function plDocsShow(id) {
  plDocsSelected = id;
  $$('#pl-docs-nav a').forEach(a => a.classList.toggle('active', a.dataset.anchor === id));
  for (const [cat, items] of PL_DOCS.categories) {
    for (const [aid, title, desc, sample] of items) {
      if (aid !== id) continue;
      $('#pl-docs-body').innerHTML = `
        <h3>${esc(title)}</h3>
        <p class="meta">${esc(desc)}</p>
        <p><small>YAML shape:</small></p>
        <pre><code>${esc(sample)}</code></pre>
      `;
      return;
    }
  }
}

// -- Wire-up ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  if (!$('#pb-add-node')) return;   // Pipelines tab not on page — nothing to bind
  $('#pb-add-node').addEventListener('click', pbAddNode);
  $('#pb-delete-node').addEventListener('click', pbDeleteNode);
  $('#pb-node-id').addEventListener('input', () => {
    if (pbSelected < 0) return;
    const old = pbJob.nodes[pbSelected].id;
    const nu  = $('#pb-node-id').value.trim() || old;
    pbJob.nodes[pbSelected].id = nu;
    // Re-target any depends[] pointing at the old id.
    for (const n of pbJob.nodes) n.depends = n.depends.map(d => d === old ? nu : d);
    $('#pb-editor-title').textContent = 'node: ' + nu;
    pbRenderNodeList(); pbRenderYaml();
  });
  $('#pb-job-id').addEventListener('input', () => {
    pbJob.id = $('#pb-job-id').value.trim() || 'my-job';
    pbRenderYaml();
  });
  document.querySelectorAll('.pb-add-step').forEach(b => b.addEventListener('click', () => {
    if (pbSelected < 0) { pbStatus('no node selected', 'err'); return; }
    const kind = b.dataset.kind;
    const s = {kind};
    (PB_STEP_KINDS[kind]?.fields || []).forEach(f => {
      if (f.default !== undefined) s[f.name] = f.default;
    });
    pbJob.nodes[pbSelected].steps.push(s);
    pbRenderEditor(); pbRenderYaml();
  }));
  document.querySelectorAll('.pb-add-sink').forEach(b => b.addEventListener('click', () => {
    if (pbSelected < 0) { pbStatus('no node selected', 'err'); return; }
    const kind = b.dataset.kind;
    const s = {kind};
    (PB_SINK_KINDS[kind]?.fields || []).forEach(f => {
      if (f.default !== undefined) s[f.name] = f.default;
    });
    if (!s.name && kind !== 'counting' && kind !== 'ndjson-file' && kind !== 'nats') {
      s.name = pbJob.nodes[pbSelected].id + '-' + kind;
    }
    pbJob.nodes[pbSelected].sinks.push(s);
    pbRenderEditor(); pbRenderYaml();
  }));
  $('#pb-push-run').addEventListener('click', pbPushToRun);
  $('#pb-load-yaml').addEventListener('click', pbLoadFromYaml);
  $('#pb-copy-yaml').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pbToYaml()); pbStatus('YAML copied', 'ok'); }
    catch (e) { pbStatus('copy failed: ' + e.message, 'err'); }
  });
});

/** Lightweight toast for pipeline-tab feedback. Auto-dismisses. */
function plToast(msg, kind = 'ok') {
  let el = $('#pl-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pl-toast';
    document.body.appendChild(el);
  }
  el.className = 'pl-toast pl-toast-' + kind;
  el.textContent = msg;
  el.classList.add('pl-toast-visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('pl-toast-visible'), 3000);
}

// (removed a stray $(document).body?... line — $ is querySelector, so
// passing document as the CSS selector threw TypeError at load time and
// silently killed every DOMContentLoaded handler that followed. That is
// exactly what caused the "Run does nothing / bundled examples don't
// click" bug reports — the handler wire-up never registered.)

document.addEventListener('DOMContentLoaded', () => {
  const runBtn = $('#pl-run');
  const runDistBtn = $('#pl-run-dist');
  if (!runBtn) return;
  runBtn.addEventListener('click', () => submitRun('/mesh/jobs/run', runBtn, '▶ Run', 'local'));
  if (runDistBtn) {
    runDistBtn.addEventListener('click',
        () => submitRun('/mesh/jobs/run-distributed', runDistBtn, '▶ Run distributed', 'distributed'));
  }
});

async function submitRun(endpoint, btn, label, mode) {
  let yaml = $('#pl-yaml').value.trim();
  if (!yaml && plBundledCache && Object.keys(plBundledCache).length) {
    const firstName = Object.keys(plBundledCache)[0];
    yaml = plBundledCache[firstName];
    $('#pl-yaml').value = yaml;
    plToast(`auto-loaded "${firstName}" example — click again if you want a different one`, 'warn');
  }
  if (!yaml) {
    plToast('editor is empty — click a bundled example on the left first', 'warn');
    return;
  }
  btn.disabled = true;
  btn.textContent = '⋯ ' + (mode === 'distributed' ? 'Dispatching' : 'Running');
  $('#pl-status').hidden = false;
  $('#pl-status-id').textContent = 'submitting…';
  $('#pl-status-state').textContent = 'SUBMITTING';
  $('#pl-status-state').className = 'badge pl-state-running';
  $('#pl-dag').innerHTML = `<div class="meta">${mode === 'distributed'
      ? 'dispatching to agents advertising pipeline-node capability…'
      : 'contacting driver…'}</div>`;
  $('#pl-status').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const r = await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/yaml' },
      body: yaml,
    });
    $('#pl-status-id').textContent = r.jobId;
    $('#pl-status-state').textContent = 'RUNNING';
    $('#pl-status-state').className = 'badge pl-state-running';
    startPolling(r.jobId);
    plToast(`▶ started job ${r.jobId} (${mode})`, 'ok');
    refreshRunHistory();
  } catch (e) {
    $('#pl-status-id').textContent = 'error';
    $('#pl-status-state').textContent = 'FAILED';
    $('#pl-status-state').className = 'badge pl-state-failed';
    $('#pl-dag').innerHTML = `<div style="color:var(--danger); padding:0.5rem;">${esc(e.message)}</div>`;
    plToast(`${mode} run failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function startPolling(jobId) {
  if (plActivePoll) clearInterval(plActivePoll);
  const started = Date.now();
  const poll = async () => {
    const s = await api('/mesh/jobs/' + jobId);
    $('#pl-status-state').textContent = s.state;
    $('#pl-status-state').className = 'badge pl-state-' + s.state.toLowerCase();
    $('#pl-status-timing').textContent = ((Date.now() - started) / 1000).toFixed(1) + 's';
    renderDag(s);
    const events = await api('/mesh/jobs/' + jobId + '/events').catch(() => []);
    $('#pl-events').innerHTML = events.map(e =>
      `<div><code>${esc(e.at.slice(11,19))}</code> <b>${esc(e.nodeId)}</b> ${esc(e.kind)}: ${esc(e.message)}</div>`
    ).join('');
    if (s.state === 'SUCCEEDED' || s.state === 'FAILED' || s.state === 'CANCELLED') {
      clearInterval(plActivePoll); plActivePoll = null;
      refreshRunHistory();
    }
  };
  poll();
  plActivePoll = setInterval(poll, 500);
}

function renderDag(status) {
  const nodes = status.nodes || [];
  if (!nodes.length) { $('#pl-dag').innerHTML = '<p class="meta">no nodes</p>'; return; }
  // Simple flow: one card per node, left-to-right. Arrows would need a real
  // topological layout — Phase 2. This gives us state + counts today.
  $('#pl-dag').innerHTML = `
    <div style="display:flex; gap: 0.6rem; flex-wrap: wrap;">
      ${nodes.map(n => `
        <div class="pl-node pl-node-${esc(n.state.toLowerCase())}">
          <div class="pl-node-hdr">
            <b>${esc(n.id)}</b>
            <span class="badge pl-state-${esc(n.state.toLowerCase())}">${esc(n.state)}</span>
          </div>
          <div class="pl-node-body">
            <span class="meta">rowsIn:</span> <b>${n.rowsIn}</b>
            &nbsp;<span class="meta">rowsOut:</span> <b>${n.rowsOut}</b>
          </div>
          <div class="pl-node-sinks">
            ${Object.entries(n.sinkCounts || {}).map(([k, v]) =>
              `<div><code>${esc(k)}</code> ${v}</div>`).join('')}
          </div>
          ${n.error ? `<div class="pl-node-err">${esc(n.error)}</div>` : ''}
        </div>
      `).join('')}
    </div>`;
}

