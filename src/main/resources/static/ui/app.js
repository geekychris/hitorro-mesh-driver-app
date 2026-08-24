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
        updateInventoryPolling();
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
        if (target === 'pl-examples-tab') refreshPlExamples();
      }
    });
  });
}

// ==================================================================
//  PIPELINES · EXAMPLES sub-tab
//  Curated, dataset-organised catalogue of copy-paste-ready pipelines.
//  Each entry: title / description / YAML / optional prerequisites.
//  Rendered as collapsible cards grouped by category; every card
//  offers a ▶ Load button (into the Run tab's editor) and 📋 Copy
//  (clipboard). Complements PL_DOCS (which is per-KIND reference)
//  and the Run tab's bundled-examples click-list (which loads on
//  single-click but doesn't show YAML inline).
// ==================================================================
const PL_EXAMPLES = {
  categories: [
    ['Mac Mail', [
      {
        id: 'mail-register',
        title: 'Register the Mail database as mail_messages',
        driverLocal: true,
        desc: 'Scans your Envelope Index, folds mailchimp/substack per-campaign subdomains, derives ISO dates + year_month + hour + is_newsletter, materialises to NDJSON, auto-registers with the mesh SQL layer. Run once; then query with POST /mesh/queries.',
        needs: 'Full Disk Access · macOS Mail (V10 path — adjust for older versions)',
        yaml: `job: mail-register
nodes:
  - id: extract
    pipeline:
      source:
        kind: sqlite
        path: "~/Library/Mail/V10/MailData/Envelope Index"
        query: |
          SELECT
            m.ROWID          AS id,
            m.date_received  AS received_ts,
            addr.address     AS sender_address,
            subj.subject     AS subject,
            summ.summary     AS summary,
            m.read           AS read,
            m.flagged        AS flagged,
            m.size           AS size
          FROM messages m
          LEFT JOIN addresses addr ON addr.ROWID = m.sender
          LEFT JOIN subjects  subj ON subj.ROWID = m.subject
          LEFT JOIN summaries summ ON summ.ROWID = m.summary
      steps:
        - kind: groovy-map
          script: |
            if (row.sender_address != null) {
                def at = row.sender_address.indexOf('@')
                if (at > 0) row.sender_domain = row.sender_address.substring(at + 1).toLowerCase()
            }
            if (row.received_ts != null) {
                def d = new Date((long)(row.received_ts * 1000L))
                row.year_month = new java.text.SimpleDateFormat('yyyy-MM').format(d)
            }
            row
      sinks:
        - kind: ndjson-file
          url: "/tmp/hitorro-mesh-smoke/datasets/mail_messages/data.ndjson"
          registerAsTable:
            tableName: mail_messages
            broadcast: true`,
      },
      {
        id: 'mail-to-jvs-enriched',
        title: 'Mail → JVS email → enrich → searchable Lucene (heavily annotated)',
        driverLocal: true,
        needs: 'hitorro-mesh-pipelines-jvstype on classpath · OpenNLP models · HT_HOME + HT_DATA env vars set',
        desc: 'End-to-end recipe with a fresh email JVS type (extends sysobject; adds sender_address/name/domain, recipient_count, mailbox_url, read/flagged, size_bytes, is_newsletter). Every meaningful line is commented — look for "CHANGE THIS" markers when tuning. Reads SQLite → reshapes into JVS email tree (title.mls[0]=subject, body.mls[0]=summary) → jvs-enrich populates .clean/.segmented/.pos/.segmented_ner on both → jvs-lucene sink. Search back: GET /mesh/search/mail-jvs-enriched?q=body.mls.segmented_ner.textmarkup_en_m:NE_Person',
        yaml: `job: mail-to-jvs-enriched
nodes:
  - id: enrich
    pipeline:
      source:
        kind: sqlite
        path: "~/Library/Mail/V10/MailData/Envelope Index"
        query: |
          SELECT
            m.ROWID          AS id,
            m.date_received  AS received_ts,
            addr.address     AS sender_address,
            addr.comment     AS sender_name,
            subj.subject     AS subject,
            summ.summary     AS body,
            mb.url           AS mailbox_url,
            m.read           AS read,
            m.flagged        AS flagged,
            m.size           AS size_bytes,
            (SELECT COUNT(*) FROM recipients r WHERE r.message = m.ROWID)
                             AS recipient_count
          FROM messages m
          LEFT JOIN addresses addr ON addr.ROWID = m.sender
          LEFT JOIN subjects  subj ON subj.ROWID = m.subject
          LEFT JOIN summaries summ ON summ.ROWID = m.summary
          LEFT JOIN mailboxes mb   ON mb.ROWID   = m.mailbox
          WHERE subj.subject IS NOT NULL AND summ.summary IS NOT NULL
          ORDER BY m.date_received DESC
          LIMIT 500
      steps:
        - kind: groovy-map
          # Reshape flat SQL row → JVS 'email' tree. title & body are
          # core_mls (inherited from sysobject) — enrichment writes
          # .clean/.segmented/.pos/.segmented_ner onto each mls entry.
          script: |
            def out = [ht_type: 'mail_email', id: String.valueOf(row.id)]
            out.title = [mls: [[lang: 'en', text: row.subject ?: '']]]
            if (row.body) out.body = [mls: [[lang: 'en', text: row.body]]]
            if (row.received_ts) out.times = [date_received: (long)(row.received_ts * 1000L)]
            def raw = null
            if (row.sender_address != null) {
                def at = row.sender_address.indexOf('@')
                if (at > 0) raw = row.sender_address.substring(at + 1).toLowerCase()
            }
            out.sender_address  = row.sender_address
            out.sender_name     = row.sender_name
            out.sender_domain   = raw
            out.recipient_count = row.recipient_count
            out.mailbox_url     = row.mailbox_url
            out.read            = row.read == 1
            out.flagged         = row.flagged == 1
            out.size_bytes      = row.size_bytes
            def LIST = ['mailchimpapp.com','substack.com','mailerlite.com','tinyletter.com','buttondown.email','convertkit.com']
            out.is_newsletter = raw != null && LIST.any { raw.endsWith('.' + it) || raw == it }
            out
        - kind: jvs-enrich
          tags: [basic, segmented, pos, ner]
          typeJsonResource: "classpath:/types/mail_email.json"
      sinks:
        - kind: jvs-lucene
          name: mail-jvs-enriched
          typeJsonResource: "classpath:/types/mail_email.json"`,
      },
      {
        id: 'mail-enrich',
        title: 'JVS enrichment + Lucene index (mail_message shape — older type)',
        driverLocal: true,
        desc: 'Same shape as mail-to-jvs-enriched but uses the mail_message JVS type (with a keyword sender_name analyzer) instead of the newer email type. Kept as a reference — prefer mail-to-jvs-enriched for new work.',
        needs: 'hitorro-mesh-pipelines-jvstype on classpath · OpenNLP models under $HT_DATA/opennlpmodels1.5/en-*.bin · HT_HOME + HT_DATA env vars set',
        yaml: `job: mail-enriched-index
nodes:
  - id: enrich
    pipeline:
      source:
        kind: sqlite
        path: "~/Library/Mail/V10/MailData/Envelope Index"
        query: |
          SELECT m.ROWID AS id, m.date_received AS received_ts,
                 addr.address AS sender_address,
                 subj.subject AS subject, summ.summary AS summary
          FROM messages m
          LEFT JOIN addresses addr ON addr.ROWID = m.sender
          LEFT JOIN subjects  subj ON subj.ROWID = m.subject
          LEFT JOIN summaries summ ON summ.ROWID = m.summary
          WHERE subj.subject IS NOT NULL
          ORDER BY m.date_received DESC LIMIT 500
      steps:
        - kind: groovy-map
          script: |
            def out = [id: String.valueOf(row.id), ht_type: 'mail_message']
            out.title = [mls: [[lang: 'en', text: row.subject ?: '']]]
            if (row.summary) out.body = [mls: [[lang: 'en', text: row.summary]]]
            out.sender_address = row.sender_address
            out
        - kind: jvs-enrich
          tags: [basic, segmented, pos, ner]
          typeJsonResource: "classpath:/types/mail_message.json"
      sinks:
        - kind: jvs-lucene
          name: mail-enriched
          typeJsonResource: "classpath:/types/mail_message.json"`,
      },
    ]],
    ['iMessage / SMS', [
      {
        id: 'messages-register',
        title: 'Register iMessage as messages_texts',
        driverLocal: true,
        desc: 'Joins message + handle + chat tables so every row has the message text plus the other-party contact (phone/email) and chat context. Cocoa nanosecond timestamps → ISO / year_month / hour. is_group flag derived from chat_style.',
        needs: 'Full Disk Access',
        yaml: `job: messages-register
nodes:
  - id: extract
    pipeline:
      source:
        kind: sqlite
        path: "~/Library/Messages/chat.db"
        query: |
          SELECT
            m.ROWID AS id, m.date AS date_ns, m.text AS text,
            m.is_from_me AS from_me, m.is_read AS read, m.service AS service,
            h.id AS contact, c.chat_identifier AS chat_id,
            c.display_name AS chat_name, c.style AS chat_style
          FROM message m
          LEFT JOIN handle h ON h.ROWID = m.handle_id
          LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          LEFT JOIN chat c ON c.ROWID = cmj.chat_id
          WHERE m.text IS NOT NULL
      steps:
        - kind: groovy-map
          script: |
            if (row.date_ns != null) {
                def ms = (long)(row.date_ns / 1_000_000L + 978_307_200_000L)
                def d = new Date(ms)
                row.sent_iso   = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'").tap {
                    setTimeZone(java.util.TimeZone.getTimeZone('UTC'))
                }.format(d)
                row.year_month = new java.text.SimpleDateFormat('yyyy-MM').format(d)
            }
            row.is_group = row.chat_style == 45
            row
      sinks:
        - kind: ndjson-file
          url: "/tmp/hitorro-mesh-smoke/datasets/messages_texts/data.ndjson"
          registerAsTable:
            tableName: messages_texts
            broadcast: true`,
      },
      {
        id: 'messages-top-contacts',
        title: 'Top texting contacts + sent-vs-received ratio',
        desc: 'Ad-hoc query written as a pipeline (rather than SELECT) so you can chain steps or ship the result to a file. Same output as: SELECT contact, COUNT(*) FROM messages_texts GROUP BY contact ORDER BY 2 DESC.',
        needs: 'messages-register must have been run first',
        yaml: `job: messages-top-contacts
nodes:
  - id: rollup
    pipeline:
      source: {kind: sql, sql: "SELECT contact, from_me FROM messages_texts WHERE contact IS NOT NULL"}
      reduce:
        group-by: [contact]
        aggs:
          - {name: total,    kind: COUNT}
          - {name: sent,     kind: SUM, of: from_me}
      steps:
        - kind: groovy-map
          script: |
            row.received = (row.total ?: 0) - (row.sent ?: 0)
            row.pct_sent = row.total > 0 ? Math.round(100.0 * (row.sent ?: 0) / row.total) : 0
            row
      sinks:
        - kind: ndjson-file
          url: "/tmp/hitorro-mesh-smoke/out/top-contacts.ndjson"`,
      },
    ]],
    ['Safari history', [
      {
        id: 'safari-register',
        title: 'Register Safari history as safari_visits',
        driverLocal: true,
        desc: 'One row per VISIT joined with URL / domain metadata. Cocoa-seconds timestamps → ISO. Extracts a clean lowercase domain from the URL (Safari sometimes leaves domain_expansion blank). is_search_result flag filters out Google-redirect noise.',
        needs: 'Full Disk Access',
        yaml: `job: safari-register
nodes:
  - id: extract
    pipeline:
      source:
        kind: sqlite
        path: "~/Library/Safari/History.db"
        query: |
          SELECT v.id AS visit_id, v.visit_time AS visit_ts_cocoa,
                 v.title AS title, v.load_successful AS ok,
                 hi.url AS url, hi.domain_expansion AS domain_raw,
                 hi.visit_count AS lifetime_visits
          FROM history_visits v
          JOIN history_items hi ON hi.id = v.history_item
      steps:
        - kind: groovy-map
          script: |
            if (row.visit_ts_cocoa != null) {
                def d = new Date((long)((row.visit_ts_cocoa + 978_307_200) * 1000d))
                row.visited_iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'").tap {
                    setTimeZone(java.util.TimeZone.getTimeZone('UTC'))
                }.format(d)
                row.year_month = new java.text.SimpleDateFormat('yyyy-MM').format(d)
            }
            def domain = row.domain_raw
            if ((domain == null || domain.isEmpty()) && row.url != null) {
                def m = row.url =~ ~/^https?:\\/\\/([^\\/:?#]+)/
                if (m.find()) domain = m.group(1).toLowerCase()
            }
            row.domain = domain
            row.is_search_result = row.url != null && (row.url.contains('/search?') || row.url.contains('google.com/url'))
            row
      sinks:
        - kind: ndjson-file
          url: "/tmp/hitorro-mesh-smoke/datasets/safari_visits/data.ndjson"
          registerAsTable:
            tableName: safari_visits
            broadcast: true`,
      },
    ]],
    ['Apple Photos', [
      {
        id: 'photos-register',
        title: 'Register Photos library as photos_assets',
        driverLocal: true,
        desc: 'One row per asset (photo or video) with dimensions, GPS, favorite/trash flags, HDR/portrait-mode markers, derived megapixels + aspect_ratio + orientation. year_num (not "year" — mesh SQL reserved word) for annual rollups.',
        needs: 'Full Disk Access · adjust "Photos Library.photoslibrary" if you renamed yours',
        yaml: `job: photos-register
nodes:
  - id: extract
    pipeline:
      source:
        kind: sqlite
        path: "~/Pictures/Photos Library.photoslibrary/database/Photos.sqlite"
        query: |
          SELECT Z_PK AS id, ZDATECREATED AS taken_ts_cocoa,
                 ZFILENAME AS filename, ZKIND AS kind,
                 ZWIDTH AS width, ZHEIGHT AS height, ZDURATION AS duration,
                 ZLATITUDE AS lat, ZLONGITUDE AS lng,
                 ZFAVORITE AS favorite, ZTRASHEDSTATE AS trashed,
                 ZHDRTYPE AS hdr, ZDEPTHTYPE AS depth
          FROM ZASSET
      steps:
        - kind: groovy-map
          script: |
            if (row.taken_ts_cocoa != null) {
                def d = new Date((long)((row.taken_ts_cocoa + 978_307_200) * 1000d))
                row.taken_iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'").format(d)
                row.year_month = new java.text.SimpleDateFormat('yyyy-MM').format(d)
                row.year_num = (new java.text.SimpleDateFormat('yyyy').format(d)) as Integer
            }
            row.kind_name = row.kind == 1 ? 'video' : 'photo'
            if (row.width && row.height) {
                row.megapixels = ((row.width * row.height) / 1_000_000.0d).round(2)
                row.orientation = row.width > row.height * 1.05 ? 'landscape' :
                                   row.height > row.width * 1.05 ? 'portrait' : 'square'
            }
            row.has_location = row.lat != null && row.lng != null && !(row.lat == 0 && row.lng == 0)
            row.is_favorite = row.favorite == 1
            row.is_trashed  = row.trashed == 1
            row
      sinks:
        - kind: ndjson-file
          url: "/tmp/hitorro-mesh-smoke/datasets/photos_assets/data.ndjson"
          registerAsTable:
            tableName: photos_assets
            broadcast: true`,
      },
    ]],
    ['Screen Time', [
      {
        id: 'screentime-register',
        title: 'Register app-usage events as screentime_events',
        driverLocal: true,
        desc: 'Streams ZOBJECT rows tagged /app/usage from knowledgeC.db. Each row is one foreground session — start/end Cocoa seconds → duration. Categorises apps by bundle-id prefix (Apple / Chrome / Slack / JetBrains / Microsoft / etc).',
        needs: 'Full Disk Access',
        yaml: `job: screentime-register
nodes:
  - id: extract
    pipeline:
      source:
        kind: sqlite
        path: "~/Library/Application Support/Knowledge/knowledgeC.db"
        query: |
          SELECT Z_PK AS id, ZSTARTDATE AS start_ts_cocoa,
                 ZENDDATE AS end_ts_cocoa, ZVALUESTRING AS app_bundle
          FROM ZOBJECT
          WHERE ZSTREAMNAME = '/app/usage' AND ZVALUESTRING IS NOT NULL
      steps:
        - kind: groovy-map
          script: |
            if (row.start_ts_cocoa != null) {
                def d = new Date((long)((row.start_ts_cocoa + 978_307_200) * 1000d))
                row.started_iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'").format(d)
                row.year_month = new java.text.SimpleDateFormat('yyyy-MM').format(d)
            }
            row.duration_sec = (row.end_ts_cocoa != null && row.start_ts_cocoa != null)
                ? (row.end_ts_cocoa - row.start_ts_cocoa).round(1) : 0.0d
            def b = row.app_bundle ?: ''
            row.app_category =
                b.startsWith('com.apple.') ? 'Apple' :
                b.contains('.slack')       ? 'Slack' :
                b.contains('.zoom')        ? 'Meetings' :
                b.contains('.chrome')      ? 'Chrome' :
                b.contains('.jetbrains.')  ? 'JetBrains' :
                b.contains('.microsoft.')  ? 'Microsoft' : 'Other'
            row
      sinks:
        - kind: ndjson-file
          url: "/tmp/hitorro-mesh-smoke/datasets/screentime_events/data.ndjson"
          registerAsTable:
            tableName: screentime_events
            broadcast: true`,
      },
    ]],
    ['Cross-DB', [
      {
        id: 'monthly-digital-life',
        title: 'Monthly digital-life summary',
        desc: 'Rolls up mail_messages / messages_texts / photos_assets / safari_visits by year_month into a single table you can chart. Requires all four register jobs to have been run.',
        needs: 'mail-register + messages-register + photos-register + safari-register run first',
        yaml: `job: monthly-digital-life
nodes:
  - id: mail
    pipeline:
      source: {kind: sql, sql: "SELECT year_month, 'email' AS kind FROM mail_messages"}
      reduce:
        group-by: [year_month, kind]
        aggs: [{name: n, kind: COUNT}]
      sinks: [{kind: memory-table, name: partial}]
  - id: msgs
    pipeline:
      source: {kind: sql, sql: "SELECT year_month, 'text' AS kind FROM messages_texts"}
      reduce:
        group-by: [year_month, kind]
        aggs: [{name: n, kind: COUNT}]
      sinks: [{kind: memory-table, name: partial}]
  - id: photos
    pipeline:
      source: {kind: sql, sql: "SELECT year_month, 'photo' AS kind FROM photos_assets WHERE is_trashed = FALSE"}
      reduce:
        group-by: [year_month, kind]
        aggs: [{name: n, kind: COUNT}]
      sinks: [{kind: memory-table, name: partial}]
  - id: safari
    pipeline:
      source: {kind: sql, sql: "SELECT year_month, 'browse' AS kind FROM safari_visits WHERE is_search_result = FALSE"}
      reduce:
        group-by: [year_month, kind]
        aggs: [{name: n, kind: COUNT}]
      sinks: [{kind: memory-table, name: partial}]
  - id: combine
    depends: [mail, msgs, photos, safari]
    pipeline:
      source: {kind: ref, node: partial}
      sinks:
        - kind: ndjson-file
          url: "/tmp/hitorro-mesh-smoke/out/monthly-digital-life.ndjson"`,
      },
    ]],
  ],
};

function refreshPlExamples() {
  const container = $('#pl-examples-container');
  if (!container) return;
  if (container.dataset.built === '1') return;   // built once — YAML is static
  container.dataset.built = '1';
  const total = PL_EXAMPLES.categories.reduce((n, [, items]) => n + items.length, 0);
  const countEl = $('#pl-examples-count');
  if (countEl) countEl.textContent = total;

  const parts = [];
  for (const [cat, items] of PL_EXAMPLES.categories) {
    parts.push(`<h4 style="margin: 1.2rem 0 0.4rem; border-bottom: 1px solid #ddd; padding-bottom: 0.2rem; color: #2E86AB;">${esc(cat)}</h4>`);
    for (const ex of items) {
      // Driver-local badge — sqlite sources CAN'T dispatch to remote
      // agents (the DB file lives on the driver host). Highlighting
      // this up front saves users from hitting the placement guard's
      // IllegalArgumentException after clicking ▶ Run distributed.
      const localBadge = ex.driverLocal
        ? '<span class="badge" style="background:#fff4d6;color:#8a5a00;margin-left:0.5rem;font-size:0.65rem;" title="Uses a SQLite source — file is local to the driver host; ▶ Run distributed will error out. Use plain ▶ Run.">driver-local only</span>'
        : '';
      parts.push(`
        <details class="pl-example" style="margin-bottom: 0.5rem;">
          <summary style="cursor: pointer; padding: 0.4rem 0.6rem; background: #f4f7fa; border-radius: 4px;">
            <b>${esc(ex.title)}</b>${localBadge}
            <span style="float: right;">
              <button class="secondary outline pl-example-load" data-ex="${esc(ex.id)}"
                      style="width:auto;margin:0 0.3rem 0 0;padding:0.1rem 0.5rem;font-size:0.75rem;"
                      title="Send this pipeline into the Run tab's editor + switch there">▶ Load</button>
              <button class="secondary outline pl-example-copy" data-ex="${esc(ex.id)}"
                      style="width:auto;margin:0;padding:0.1rem 0.5rem;font-size:0.75rem;"
                      title="Copy the raw YAML to your clipboard">📋 Copy</button>
            </span>
          </summary>
          <div style="padding: 0.5rem 0.6rem;">
            <p style="margin: 0.2rem 0;">${esc(ex.desc)}</p>
            ${ex.needs ? `<p style="margin: 0.2rem 0 0.5rem;"><small class="meta"><b>Needs:</b> ${esc(ex.needs)}</small></p>` : ''}
            ${ex.driverLocal ? '<p style="margin: 0.2rem 0 0.5rem;padding:0.3rem 0.6rem;background:#fff8e6;border-left:3px solid var(--warning);font-size:0.8rem;"><b>Driver-local only.</b> SQLite sources require the file to be on the driver host — clicking <b>▶ Run distributed</b> will error out with <code>IllegalArgumentException: node has a sqlite source which cannot be dispatched</code>. Use plain <b>▶ Run</b> instead.</p>' : ''}
            <pre style="background:#1e2733;color:#e2e8f0;padding:0.7rem 0.9rem;border-radius:4px;font-size:0.78rem;overflow-x:auto;"><code style="background:transparent!important;color:inherit!important;padding:0!important;font-size:inherit!important;font-family:ui-monospace,monospace;">${esc(ex.yaml)}</code></pre>
          </div>
        </details>`);
    }
  }
  container.innerHTML = parts.join('');

  // Wire ▶ Load — sends YAML into the Run tab and switches to it.
  container.querySelectorAll('.pl-example-load').forEach(btn =>
    btn.addEventListener('click', () => {
      const ex = plExampleById(btn.dataset.ex);
      if (!ex) return;
      const editor = document.getElementById('pl-yaml');
      if (editor) editor.value = ex.yaml;
      const runBtn = document.querySelector('button[data-view="pl-run"]');
      if (runBtn) runBtn.click();
    }));

  // Wire 📋 Copy — clipboard the raw YAML.
  container.querySelectorAll('.pl-example-copy').forEach(btn =>
    btn.addEventListener('click', async () => {
      const ex = plExampleById(btn.dataset.ex);
      if (!ex) return;
      try {
        await navigator.clipboard.writeText(ex.yaml);
        const orig = btn.textContent;
        btn.textContent = '✓ copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      } catch (e) {
        alert('Clipboard write failed: ' + e.message);
      }
    }));
}

function plExampleById(id) {
  for (const [, items] of PL_EXAMPLES.categories) {
    const hit = items.find(x => x.id === id);
    if (hit) return hit;
  }
  return null;
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
    // Inventory matrix is a separate fetch — the probe takes ~1.5s
    // (NATS fan-out with deadline), so it doesn't block the rest of
    // the cluster panel from rendering.
    refreshInventoryMatrix();
  } catch (e) {
    $('#cluster-friendly').innerHTML = `<div class="cluster-status-callout err"><p class="title">Error loading cluster</p><p>${esc(e.message)}</p></div>`;
  }
}

/** Fetch + render the inventory matrix — tables × agents from a live
 *  NATS probe. Rows are distinct table names; columns are agents. Each
 *  cell shows a ✓ tagged with the entry's source (boot / runtime) plus
 *  the partitionKey when non-null. Empty cells mean "agent replied but
 *  didn't have this table". */
/** Polling handle so we don't stack multiple intervals on tab switches. */
let _inventoryPollHandle = null;

/** Start/stop the 15-second inventory poll. Called from the tab switcher —
 *  polls while Cluster is the active tab, stops otherwise. Also stops
 *  when the browser tab loses visibility (page hidden). */
function updateInventoryPolling() {
  const clusterActive = document.querySelector('#cluster.tab-panel.active') != null;
  const pageVisible = !document.hidden;
  const shouldPoll = clusterActive && pageVisible;
  if (shouldPoll && !_inventoryPollHandle) {
    _inventoryPollHandle = setInterval(refreshInventoryMatrix, 15000);
  } else if (!shouldPoll && _inventoryPollHandle) {
    clearInterval(_inventoryPollHandle);
    _inventoryPollHandle = null;
  }
}

async function refreshInventoryMatrix() {
  const badge = $('#inventory-badge');
  const body = $('#inventory-body');
  if (!body) return;
  body.innerHTML = '<small class="meta">probing agents…</small>';
  try {
    const inv = await api('/mesh/queries/inventory');
    const replies = inv.replies || [];
    if (badge) {
      badge.textContent = `${inv.agentsReplied}/${inv.agentsAsked}`;
      badge.className = 'badge ' + (inv.agentsReplied === inv.agentsAsked ? 'success' : 'warning');
    }
    if (!replies.length) {
      body.innerHTML = '<small class="meta">no agent responded</small>';
      return;
    }
    // Build the set of (agentId, tableName) with the source tag.
    const agents = replies.map(r => r.agentId).sort();
    const cells = new Map();  // key = agentId|tableName|pk → source
    const tableNames = new Set();
    for (const rep of replies) {
      for (const t of (rep.tables || [])) {
        const pk = t.partitionKey ?? '';
        cells.set(rep.agentId + '|' + t.name + '|' + pk, {source: t.source, pk});
        tableNames.add(t.name);
      }
    }
    const sortedTables = [...tableNames].sort();
    body.innerHTML = `
      <div class="scroll" style="max-height:26rem;overflow:auto;">
      <table style="width:100%;font-size:0.78rem;border-collapse:collapse;">
        <thead><tr>
          <th style="text-align:left;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;background:#eef;">table</th>
          <th style="text-align:center;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;background:#eef;">source</th>
          ${agents.map(a => `<th style="text-align:center;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;background:#eef;"><code>${esc(a)}</code></th>`).join('')}
          <th style="padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;background:#eef;"></th>
        </tr></thead>
        <tbody>
          ${sortedTables.map(name => {
            // Dedup by (name, pk) across agents — one row per partition key.
            const pks = new Set();
            for (const a of agents) {
              for (const [k, v] of cells) {
                const [ag, nm, p] = k.split('|');
                if (ag === a && nm === name) pks.add(p);
              }
            }
            return [...pks].map(pk => `
              <tr>
                <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">
                  <a href="#" class="inventory-open-playground" data-table="${esc(name)}"
                     title="Open Playground with SELECT * FROM ${esc(name)} LIMIT 100"
                     style="text-decoration:none;">
                    <code>${esc(name)}</code>
                  </a>${pk ? ` <span class="meta">${esc(pk)}</span>` : ''}
                </td>
                <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;text-align:center;color:#888;">
                  ${[...agents].map(a => cells.get(a + '|' + name + '|' + pk)?.source).filter(Boolean)[0] || ''}
                </td>
                ${agents.map(a => {
                  const cell = cells.get(a + '|' + name + '|' + pk);
                  return `<td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;text-align:center;">${cell ? (cell.source === 'runtime' ? '⚡' : '✓') : ''}</td>`;
                }).join('')}
                <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;text-align:right;">
                  <button class="secondary outline inventory-open-playground"
                          data-table="${esc(name)}"
                          style="width:auto;margin:0;font-size:0.7rem;padding:0.1rem 0.5rem;"
                          title="Open Playground with a SELECT against ${esc(name)}">▶ Playground</button>
                </td>
              </tr>`).join('');
          }).join('')}
        </tbody>
      </table>
      </div>
      <p class="meta" style="margin:0.4rem 0 0;font-size:0.75rem;">
        ✓ = boot-time (from AgentProperties) · ⚡ = runtime (RegisterTableMessage). Partition key shown after table name when non-null.
        Click the table name (or the ▶ Playground button) to jump to a pre-filled query.
      </p>`;
    // Wire up the jump-to-playground handlers. Runtime tables (mail_messages,
    // any user-registered NDJSON/Parquet) show up here as ⚡ but not in
    // /mesh/tables, so this is the only place on the Cluster tab from which
    // they're clickable — without this, users have to hand-type SELECTs into
    // the Playground even though the table is visibly present here.
    body.querySelectorAll('.inventory-open-playground').forEach(el =>
      el.addEventListener('click', ev => {
        ev.preventDefault();
        openTableInPlayground(el.dataset.table);
      }));
  } catch (e) {
    body.innerHTML = `<small style="color:var(--danger)">${esc(e.message || e)}</small>`;
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
  }
  // Lifecycle controls — GET/POST /mesh/storage/minio. Present whether or
  // not S3 is currently configured; the button hot-wires the driver via
  // BaseFileSystem + Spring singleton so no restart is needed.
  parts.push(`<div id="minio-lifecycle" style="margin-top:0.4rem;">
    <span class="meta">MinIO lifecycle</span>
    <span id="minio-status-badge" class="badge">…</span>
    <button id="minio-start-btn" class="secondary" style="margin-left:0.5rem;">▶ Start MinIO</button>
    <button id="minio-sync-btn"  class="secondary">↻ Sync datasets</button>
    <button id="minio-stop-btn"  class="secondary">■ Stop</button>
    <div id="minio-status-detail" class="meta"
         style="font-family:ui-monospace,monospace;font-size:0.75rem;margin-top:0.3rem;"></div>
    <div id="minio-status-msg" class="meta" style="margin-top:0.3rem;"></div>
  </div>`);
  summaryEl.innerHTML = parts.join('');

  // Wire lifecycle controls after the innerHTML swap.
  $('#minio-start-btn').addEventListener('click', () => minioAction('start'));
  // Full-tree sync uses the SSE stream so the button shows live mc output
  // instead of blocking for the whole script duration.
  $('#minio-sync-btn').addEventListener('click', () => streamSync(''));
  $('#minio-stop-btn').addEventListener('click', () => minioAction('stop'));
  refreshMinioStatus();

  // Per-dataset sync links in the presence matrix.
  document.querySelectorAll('.dataset-sync').forEach(a => {
    a.addEventListener('click', ev => {
      ev.preventDefault();
      syncOneDataset(a.dataset.ds);
    });
  });

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
            <th style="text-align:center;padding:0.2rem 0.4rem;">action</th>
          </tr></thead>
          <tbody>
          ${rows.map(r => `
            <tr>
              <td style="padding:0.2rem 0.4rem;"><code>${esc(r.id)}</code></td>
              <td style="text-align:center;padding:0.2rem 0.4rem;">${r.local ? '✅' : '·'}</td>
              <td style="text-align:center;padding:0.2rem 0.4rem;">${r.s3    ? '✅' : '·'}</td>
              <td style="text-align:center;padding:0.2rem 0.4rem;">
                <a href="#" class="dataset-sync"
                   data-ds="${esc(r.id)}"
                   title="Sync ${esc(r.id)} to MinIO"
                   style="text-decoration:none;">↻</a>
              </td>
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
    const anyFiles = entries.some(e => !e.isDir);
    entriesEl.innerHTML = `
      <div id="storage-bulk-bar" style="display:none;margin-bottom:0.3rem;">
        <span class="meta" id="storage-bulk-count"></span>
        <button id="storage-bulk-delete" class="secondary" style="margin-left:0.5rem;padding:0.15rem 0.5rem;color:var(--danger);">🗑 Delete selected</button>
      </div>
      <table style="width:100%;font-size:0.85rem;">
      <tbody>
      ${entries.map(e => `
        <tr>
          <td style="padding:0.15rem 0.4rem;width:1.5rem;">
            ${e.isDir ? '' : `<input type="checkbox" class="storage-check" data-path="${esc(joinFile(resolved, e.name))}" style="margin:0;">`}
          </td>
          <td style="padding:0.15rem 0.4rem;">
            ${e.isDir
              ? `<a href="#" data-path="${esc(joinPath(resolved, e.name))}" data-kind="dir">📁 ${esc(e.name)}/</a>`
              : `<a href="#" data-path="${esc(joinFile(resolved, e.name))}" data-kind="file">📄 ${esc(e.name)}</a>`}
          </td>
          <td style="padding:0.15rem 0.4rem;text-align:right;color:#888;">
            ${e.isDir ? '' : humanBytes(e.size)}
          </td>
          <td style="padding:0.15rem 0.4rem;text-align:right;white-space:nowrap;">
            ${e.isDir ? '' : `
              <a href="/mesh/storage/download?path=${encodeURIComponent(joinFile(resolved, e.name))}"
                 title="Download ${esc(e.name)}"
                 style="text-decoration:none;">⬇</a>
              <a href="#" class="storage-delete" data-path="${esc(joinFile(resolved, e.name))}"
                 title="Delete ${esc(e.name)}"
                 style="margin-left:0.3rem;text-decoration:none;color:var(--danger);">🗑</a>
            `}
          </td>
        </tr>`).join('')}
      </tbody></table>
      <div id="storage-preview" style="display:none;margin-top:0.5rem;"></div>`;
    // Wire bulk-select behaviours.
    const bar   = $('#storage-bulk-bar');
    const count = $('#storage-bulk-count');
    const bulkBtn = $('#storage-bulk-delete');
    const refreshBar = () => {
      const checked = document.querySelectorAll('.storage-check:checked');
      if (checked.length === 0) {
        bar.style.display = 'none';
      } else {
        bar.style.display = 'block';
        count.textContent = `${checked.length} file(s) selected`;
      }
    };
    document.querySelectorAll('.storage-check').forEach(cb =>
      cb.addEventListener('change', refreshBar));
    if (bulkBtn) bulkBtn.addEventListener('click', async () => {
      const paths = [...document.querySelectorAll('.storage-check:checked')].map(cb => cb.dataset.path);
      if (!paths.length) return;
      if (!confirm(`Delete ${paths.length} object(s)? This cannot be undone.`)) return;
      bulkBtn.disabled = true;
      const results = await Promise.allSettled(paths.map(p =>
        api('/mesh/storage/object?path=' + encodeURIComponent(p), {method: 'DELETE'})));
      const ok = results.filter(r => r.status === 'fulfilled' && !r.value?.error).length;
      const fail = results.length - ok;
      browseStorage(resolved);
      const target = $('#storage-preview');
      if (target) {
        target.style.display = 'block';
        target.innerHTML = fail
          ? `<small><span style="color:var(--success)">${ok} deleted</span> · <span style="color:var(--danger)">${fail} failed</span></small>`
          : `<small style="color:var(--success)">🗑 deleted ${ok} object(s)</small>`;
      }
    });
    entriesEl.querySelectorAll('a[data-path]').forEach(a => {
      // Skip download links (they should do the browser's native GET).
      if (a.classList.contains('storage-delete')) {
        a.addEventListener('click', ev => {
          ev.preventDefault();
          deleteStorageObject(a.dataset.path);
        });
      } else if (!a.getAttribute('href')?.startsWith('/mesh/storage/download')) {
        a.addEventListener('click', ev => {
          ev.preventDefault();
          if (a.dataset.kind === 'dir') browseStorage(a.dataset.path);
          else previewStorageFile(a.dataset.path);
        });
      }
    });
  } catch (e) {
    entriesEl.innerHTML = `<small style="color:var(--danger)">${esc(e.message || e)}</small>`;
  }
}

/** Join a base URI with a child dir name — trailing '/' matters. */
function joinPath(base, name) {
  return base.endsWith('/') ? base + name + '/' : base + '/' + name + '/';
}

/** Same as joinPath but for a file — NO trailing '/' (which would be
 *  read as a dir by the S3 adapter). */
function joinFile(base, name) {
  return base.endsWith('/') ? base + name : base + '/' + name;
}

/** Delete an object from storage after a confirm. Refreshes the browse
 *  view on success so the row disappears; leaves an error message
 *  behind the preview panel on failure. */
async function deleteStorageObject(fileUri) {
  if (!confirm(`Delete ${fileUri}? This cannot be undone.`)) return;
  const target = $('#storage-preview');
  try {
    const r = await api('/mesh/storage/object?path=' + encodeURIComponent(fileUri),
                        { method: 'DELETE' });
    if (r.error) throw new Error(r.error);
    // Reload the current directory listing to reflect the removal.
    // We know the parent by trimming the last path segment.
    const parent = fileUri.replace(/\/[^\/]+$/, '/');
    browseStorage(parent);
    if (target) {
      target.style.display = 'block';
      target.innerHTML = `<small style="color:var(--success)">🗑 deleted <code>${esc(fileUri)}</code></small>`;
    }
  } catch (e) {
    if (target) {
      target.style.display = 'block';
      target.innerHTML = `<small style="color:var(--danger)">delete failed: ${esc(e.message || e)}</small>`;
    }
  }
}

/** Fetch and render a head-of-file preview inline under the entries
 *  table. Parquet returns Avro schema, everything else returns text.
 *  Kept scoped to the current browser state — clicking another file
 *  replaces the preview; clicking away closes it. */
async function previewStorageFile(fileUri) {
  const target = $('#storage-preview');
  if (!target) return;
  target.style.display = 'block';
  target.innerHTML = `<small class="meta">loading preview of <code>${esc(fileUri)}</code>…</small>`;
  try {
    const r = await api('/mesh/storage/head?path=' + encodeURIComponent(fileUri) + '&lines=25');
    if (r.error) throw new Error(r.error);

    // CSV/TSV get rendered as a small HTML table instead of raw text.
    // Delimiter picked from extension; naive split (no quote handling)
    // is fine for previews — the raw preview remains available via
    // the "raw" toggle.
    const lower = fileUri.toLowerCase();
    const isCsv = lower.endsWith('.csv') || lower.endsWith('.csv.gz') || lower.endsWith('.csv.bz2');
    const isTsv = lower.endsWith('.tsv') || lower.endsWith('.tsv.gz') || lower.endsWith('.tsv.bz2');
    let body;
    if ((isCsv || isTsv) && r.preview) {
      const delim = isCsv ? ',' : '\t';
      body = renderCsvTable(r.preview, delim);
    } else {
      const langHint = r.kind === 'parquet' ? '' : ' language-json';
      body = `<pre class="scroll${langHint}" style="margin:0.4rem 0 0;max-height:24rem;overflow:auto;font-size:0.78rem;">${esc(r.preview || '')}</pre>`;
    }
    target.innerHTML = `
      <div style="border:1px solid #d5d5d5;border-radius:4px;padding:0.5rem;background:#fafafa;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <b>📄 ${esc(fileUri)}</b>
          <span class="meta" style="font-size:0.75rem;">
            ${(isCsv || isTsv) ? (isCsv ? 'csv' : 'tsv') : r.kind} · ${humanBytes(r.size || 0)}
            ${r.truncated ? ' · truncated' : ''}
            <a href="#" id="storage-preview-close" style="margin-left:0.5rem;">✕ close</a>
          </span>
        </div>
        ${body}
      </div>`;
    $('#storage-preview-close')?.addEventListener('click', ev => {
      ev.preventDefault();
      target.style.display = 'none';
      target.innerHTML = '';
    });
  } catch (e) {
    target.innerHTML = `<small style="color:var(--danger)">preview failed: ${esc(e.message || e)}</small>`;
  }
}

/** Naive CSV/TSV → HTML table. Splits on the delimiter without quote
 *  awareness — good enough for previews. First row rendered as thead. */
function renderCsvTable(text, delim) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (!lines.length) return '<small class="meta">(empty)</small>';
  const rows = lines.map(l => l.split(delim));
  const [head, ...body] = rows;
  return `
    <div class="scroll" style="max-height:24rem;overflow:auto;margin:0.4rem 0 0;">
      <table style="width:100%;font-size:0.78rem;border-collapse:collapse;">
        <thead>
          <tr>${head.map(h => `<th style="text-align:left;padding:0.2rem 0.4rem;border-bottom:1px solid #d5d5d5;background:#eef;">${esc(h)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${body.map(r => `<tr>${r.map(c => `<td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">${esc(c)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/** Refresh the MinIO status pill + detail line without touching the rest of
 *  the storage summary. Safe to call whether or not the pill is currently
 *  in the DOM (renderStorage may not have run yet). */
async function refreshMinioStatus() {
  const badge  = $('#minio-status-badge');
  const detail = $('#minio-status-detail');
  const startB = $('#minio-start-btn');
  const stopB  = $('#minio-stop-btn');
  if (!badge) return;
  try {
    const s = await api('/mesh/storage/minio');
    const up = !!s.reachable;
    badge.textContent = up ? 'running' : (s.dockerAvailable ? 'stopped' : 'docker missing');
    badge.className = 'badge ' + (up ? 'success' : (s.dockerAvailable ? 'warning' : 'danger'));
    const syncB = $('#minio-sync-btn');
    startB.disabled = up || !s.dockerAvailable;
    stopB.disabled  = !up || !s.dockerAvailable;
    if (syncB) syncB.disabled = !up;
    detail.innerHTML = up
      ? `endpoint <code>${esc(s.endpoint)}</code> · bucket <code>${esc(s.bucket)}</code>`
        + ` · console <a href="${esc(s.consoleUrl)}" target="_blank">${esc(s.consoleUrl)}</a>`
        + ` · user <code>${esc(s.username)}</code> · adapter=${s.adapterRegistered ? 'wired' : 'not wired'}`
      : `endpoint <code>${esc(s.endpoint)}</code> · bucket <code>${esc(s.bucket)}</code>`
        + (s.scriptsDir
            ? ` · scripts <code>${esc(s.scriptsDir)}</code>`
            : ' · <span style="color:var(--danger)">scripts dir not found</span>')
        + (s.dockerAvailable ? '' : ' · <span style="color:var(--danger)">docker not on PATH</span>');
  } catch (e) {
    badge.textContent = 'unknown';
    badge.className = 'badge';
    detail.textContent = e.message || String(e);
  }
}

/** Sync one dataset via SSE — streams mc-mirror stdout live to the
 *  status message so long syncs show progress instead of freezing. */
function syncOneDataset(datasetId) { streamSync(datasetId); }

/** SSE-driven sync — used by both per-dataset and full-tree buttons.
 *  Empty datasetId = full tree. Handles reconnect/complete transparently. */
function streamSync(datasetId) {
  const msg = $('#minio-status-msg');
  const label = datasetId || 'all datasets';
  const url = '/mesh/storage/minio/sync/stream'
            + (datasetId ? '?dataset=' + encodeURIComponent(datasetId) : '');
  if (msg) msg.innerHTML = `<span class="meta">syncing ${esc(label)}… <span id="sync-tail" style="font-family:ui-monospace,monospace;font-size:0.75rem;color:#666;"></span></span>`;
  const es = new EventSource(url);
  let lastLine = '';
  es.addEventListener('line', ev => {
    lastLine = ev.data;
    const tail = $('#sync-tail');
    if (tail) {
      // Show the last line only — mc mirror updates the same status
      // line repeatedly, so a full log would be noisy.
      tail.textContent = ' · ' + (lastLine.length > 100
          ? '…' + lastLine.substring(lastLine.length - 100)
          : lastLine);
    }
  });
  es.addEventListener('done', async ev => {
    es.close();
    let rc = -1;
    try { rc = JSON.parse(ev.data).exitCode; } catch (_) { }
    if (rc === 0) {
      if (msg) msg.innerHTML = `<span style="color:var(--success)">✓ synced ${esc(label)} — refreshing matrix…</span>`;
      await new Promise(r => setTimeout(r, 500));
      const storage = await api('/mesh/storage');
      renderStorage(storage);
      if (msg) msg.innerHTML = `<span style="color:var(--success)">✓ synced ${esc(label)}</span>`;
      // Only notify if the user probably tabbed away — sync can take
      // minutes and they'd want a signal.
      if (document.hidden) notify('MinIO sync complete', `Synced ${label}`);
    } else {
      if (msg) msg.innerHTML = `<span style="color:var(--danger)">sync ${esc(label)} exited ${rc} — see driver logs</span>`;
      if (document.hidden) notify('MinIO sync failed', `${label} exited ${rc}`);
    }
  });
  es.addEventListener('error', ev => {
    es.close();
    if (msg) msg.innerHTML = `<span style="color:var(--danger)">sync stream error${ev.data ? ': ' + esc(ev.data) : ''}</span>`;
  });
}

/** Kick /mesh/storage/minio/{start|stop}, then reload storage summary +
 *  browser so the whole card reflects the new backend state. */
async function minioAction(action) {
  const msg = $('#minio-status-msg');
  const startB = $('#minio-start-btn');
  const stopB  = $('#minio-stop-btn');
  if (startB) startB.disabled = true;
  if (stopB)  stopB.disabled  = true;
  if (msg) msg.innerHTML = `<span class="meta">${action}ing MinIO…</span>`;
  try {
    const r = await api('/mesh/storage/minio/' + action, {method: 'POST'});
    if (r.success === false) throw new Error(r.error || 'failed');
    if (msg) msg.innerHTML = `<span style="color:var(--success)">${action} ok</span>`
      + (r.alreadyRunning ? ' <span class="meta">(was already up)</span>' : '');
    // MinIO's bucket listing can lag by a few hundred ms after a fresh
    // sync writes; short pause so the matrix refresh actually sees them.
    if (action === 'sync' || action === 'start') {
      await new Promise(r => setTimeout(r, 500));
    }
    // Reload full storage panel so the S3 line + browser refresh.
    const storage = await api('/mesh/storage');
    renderStorage(storage);
    browseStorage('');
  } catch (e) {
    if (msg) msg.innerHTML = `<span style="color:var(--danger)">${esc(e.message || e)}</span>`;
    refreshMinioStatus();
  }
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
    let primed = false;
    // First choice: shipped dataset manifest (Geonames / ISO4217 / etc.) —
    // gets us the rich cross-dataset JOIN snippets.
    try {
      const m = await api('/mesh/datasets/' + encodeURIComponent(dsId));
      if (typeof setPlaygroundDatasetContext === 'function') {
        setPlaygroundDatasetContext(m, tableName);
        primed = true;
      }
    } catch (_) { /* not a shipped dataset — try runtime table next */ }
    // Fallback: runtime-registered table (mail_messages, any user
    // /register-existing). Pull the type from /mesh/queries/registered
    // and synthesise a minimal manifest so setPlaygroundRuntimeContext
    // can build a schema-derived snippet library — otherwise the user
    // lands on the Playground with stale snippets from whatever dataset
    // was previously in context, which is exactly the bug this fixes.
    if (!primed) {
      try {
        const all = await api('/mesh/queries/registered');
        const rt  = (all || []).find(r => r.name === tableName);
        if (rt && rt.typeJson) {
          setPlaygroundRuntimeContext(tableName, JSON.parse(rt.typeJson));
          primed = true;
        }
      } catch (_) { /* nothing to prime with — SQL only */ }
    }
    // Reset stale context so the user isn't misled — old snippets stay
    // in the left rail but the header stops claiming "Playing with X".
    if (!primed) {
      pgDatasetContext = null;
      pgWinContext = null;
      const ctxEl = document.getElementById('pg-context');
      if (ctxEl) ctxEl.hidden = true;
      if (typeof renderSnippets === 'function') renderSnippets();
    }
    const sql = `SELECT * FROM ${tableName} LIMIT 20`;
    if (typeof setSql === 'function') setSql(sql);
    const btn = document.querySelector('button[role="tab"][data-target="playground"]');
    if (btn) btn.click();
  })();
}

/**
 * Set the Playground's context to a runtime-registered table (created
 * via /register-existing — mail_messages, user Parquet imports, etc.).
 * Builds a snippet library derived from the table's inferred typeJson:
 * Peek, GROUP BY per string field, ORDER BY DESC per number field, and
 * time-shape queries when *_iso / year_month / hour_of_day columns are
 * present.
 *
 * <p>Mirrors {@link setPlaygroundDatasetContext} in shape (both write
 * to the same pgDatasetContext store + call renderSnippets) but skips
 * the shipped-dataset niceties (USING PLACE joins, relationship-derived
 * snippets) that don't apply to arbitrary user tables.</p>
 */
function setPlaygroundRuntimeContext(tableName, typeJson) {
  const fields = (typeJson.fields || []).map(f => f.name);
  const strings = (typeJson.fields || []).filter(f => f.type === 'core_string').map(f => f.name);
  const numbers = (typeJson.fields || []).filter(f => f.type === 'core_long' || f.type === 'core_double').map(f => f.name);
  const bools   = (typeJson.fields || []).filter(f => f.type === 'core_boolean').map(f => f.name);

  const snippets = [];
  snippets.push({
    name: 'Peek 20 rows',
    desc: `SELECT * FROM ${tableName} LIMIT 20`,
    sql: `SELECT * FROM ${tableName} LIMIT 20`,
  });
  // Time-shape snippets — recognise the year_month / hour_of_day /
  // day_of_week columns the mail-register pipeline synthesises. Cheap
  // & broadly useful for any table with those columns.
  if (fields.includes('year_month')) {
    snippets.push({
      name: 'Volume by month',
      desc: 'year_month rollup',
      sql: `SELECT year_month, COUNT(*) AS n\nFROM ${tableName}\nGROUP BY year_month\nORDER BY year_month DESC\nLIMIT 24`,
    });
  }
  if (fields.includes('hour_of_day')) {
    snippets.push({
      name: 'Busiest hour of day',
      desc: 'UTC',
      sql: `SELECT hour_of_day, COUNT(*) AS n\nFROM ${tableName}\nGROUP BY hour_of_day\nORDER BY hour_of_day`,
    });
  }
  if (fields.includes('day_of_week')) {
    snippets.push({
      name: 'By day of week',
      desc: '',
      sql: `SELECT day_of_week, COUNT(*) AS n\nFROM ${tableName}\nGROUP BY day_of_week`,
    });
  }
  // Categorical rollups — first N string fields whose name isn't
  // obviously a body/summary/preview blob.
  for (const s of strings.slice(0, 6)) {
    if (['subject', 'summary', 'subject_full', 'body', 'content', 'text', 'description'].includes(s)) continue;
    snippets.push({
      name: `GROUP BY ${s}`,
      desc: 'top-N rollup',
      sql: `SELECT ${s}, COUNT(*) AS n\nFROM ${tableName}\nWHERE ${s} IS NOT NULL\nGROUP BY ${s}\nORDER BY n DESC\nLIMIT 20`,
    });
  }
  // Numeric ORDER BY — top-N by first non-id numeric field.
  const numCandidate = numbers.find(n => !['id', 'received_ts', 'sent_ts'].includes(n) && !n.endsWith('_ts'));
  if (numCandidate) {
    snippets.push({
      name: `Top by ${numCandidate}`,
      desc: 'ORDER BY DESC',
      sql: `SELECT *\nFROM ${tableName}\nORDER BY ${numCandidate} DESC\nLIMIT 20`,
    });
  }
  // Boolean flag rollups (read / flagged / is_newsletter on the mail
  // table; would fire for any table with core_boolean columns).
  for (const b of bools.slice(0, 3)) {
    snippets.push({
      name: `Count by ${b}`,
      desc: 'boolean split',
      sql: `SELECT ${b}, COUNT(*) AS n\nFROM ${tableName}\nGROUP BY ${b}`,
    });
  }

  pgDatasetContext = {
    id: tableName,
    tableName,
    title: tableName + ' (runtime-registered)',
    snippets,
  };
  pgWinContext = null;

  const nameEl = document.getElementById('pg-context-name');
  const kindEl = document.getElementById('pg-context-kind');
  const metaEl = document.getElementById('pg-context-meta');
  const ctxEl  = document.getElementById('pg-context');
  if (nameEl) nameEl.textContent = tableName;
  if (kindEl) kindEl.textContent = '⚡ Runtime table';
  if (metaEl) metaEl.textContent = `— snippets derived from ${fields.length} inferred fields`;
  if (ctxEl)  ctxEl.hidden = false;
  // Snippets sub-tab visible so the user immediately sees the tuned list.
  const lpSnippetsBtn = document.querySelector('[data-lp="lp-snippets"]');
  if (lpSnippetsBtn && !lpSnippetsBtn.classList.contains('active')) lpSnippetsBtn.click();
  if (typeof renderSnippets === 'function') renderSnippets();
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
/** Pull the runtime-registered tables list and render an inline table
 *  under the Playground write panel. Each row has an unregister button
 *  that DELETEs the table (driver-side entry + agent fan-out). */
async function refreshRuntimeTablesPanel() {
  const fs = $('#pg-runtime-tables-fs');
  const target = $('#pg-runtime-tables');
  if (!fs || !target) return;
  try {
    // Parallel — tracker list is cheap; inventory probe takes ~1.5s but
    // enriches every row with a "N/M installed" badge derived from the
    // live probe. Both loads share the same first paint.
    const [rows, invRaw] = await Promise.all([
      api('/mesh/queries/registered'),
      api('/mesh/queries/inventory').catch(() => null),
    ]);
    if (!rows || !rows.length) {
      fs.hidden = true;
      target.innerHTML = '';
      return;
    }
    // Precompute per-table install counts from the inventory probe.
    const installedByName = new Map();
    const agentsAsked = invRaw?.agentsAsked || 0;
    for (const rep of (invRaw?.replies || [])) {
      const seen = new Set();
      for (const t of (rep.tables || [])) {
        if (t.source === 'runtime') seen.add(t.name);
      }
      for (const name of seen) {
        installedByName.set(name, (installedByName.get(name) || 0) + 1);
      }
    }
    fs.hidden = false;
    target.innerHTML = `
      <div id="runtime-bulk-bar" style="display:none;margin-bottom:0.3rem;">
        <span class="meta" id="runtime-bulk-count"></span>
        <button id="runtime-bulk-unregister" class="secondary" style="margin-left:0.5rem;padding:0.15rem 0.5rem;color:var(--danger);">🗑 Unregister selected</button>
      </div>
      <table style="width:100%;font-size:0.85rem;">
        <thead><tr>
          <th style="width:1.5rem;padding:0.15rem 0.4rem;"><input type="checkbox" id="runtime-check-all" title="Select all" style="margin:0;"></th>
          <th style="text-align:left;padding:0.15rem 0.4rem;">table</th>
          <th style="text-align:left;padding:0.15rem 0.4rem;">format</th>
          <th style="text-align:left;padding:0.15rem 0.4rem;">uri</th>
          <th style="text-align:center;padding:0.15rem 0.4rem;">agents</th>
          <th style="text-align:right;padding:0.15rem 0.4rem;"></th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td style="padding:0.15rem 0.4rem;"><input type="checkbox" class="runtime-check" data-name="${esc(r.name)}" style="margin:0;"></td>
              <td style="padding:0.15rem 0.4rem;">
                <a href="#" class="runtime-detail" data-name="${esc(r.name)}"
                   title="Show schema, sample rows, and agent fan-out for ${esc(r.name)}">
                  <code>${esc(r.name)}</code>
                </a>
              </td>
              <td style="padding:0.15rem 0.4rem;">${esc(r.format)}</td>
              <td style="padding:0.15rem 0.4rem;font-family:ui-monospace,monospace;font-size:0.78rem;color:#555;">
                <a href="#" class="runtime-browse" data-uri="${esc(r.uri)}"
                   title="Jump to storage browser, parent dir, preview this file"
                   style="color:inherit;text-decoration:underline dotted;">${esc(r.uri)}</a>
              </td>
              <td style="padding:0.15rem 0.4rem;text-align:center;">
                ${invRaw ? (() => {
                  const installed = installedByName.get(r.name) || 0;
                  const cls = installed === agentsAsked ? 'success' : (installed === 0 ? 'danger' : 'warning');
                  return `<span class="badge ${cls}"
                             title="${installed} of ${agentsAsked} agents currently hold this table (live probe)">
                            ${installed}/${agentsAsked}
                          </span>`;
                })() : r.agentsNotified}
              </td>
              <td style="padding:0.15rem 0.4rem;text-align:right;white-space:nowrap;">
                <a href="#" class="runtime-select" data-name="${esc(r.name)}"
                   title="Paste SELECT * FROM ${esc(r.name)} into the editor"
                   style="text-decoration:none;margin-right:0.5rem;">▶</a>
                <a href="#" class="runtime-unregister" data-name="${esc(r.name)}"
                   title="Unregister ${esc(r.name)} (driver + all agents)"
                   style="text-decoration:none;color:var(--danger);">🗑</a>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
    // Bulk-select wiring — mirrors the storage browser pattern.
    const bar = $('#runtime-bulk-bar');
    const cnt = $('#runtime-bulk-count');
    const refreshBar = () => {
      const n = document.querySelectorAll('.runtime-check:checked').length;
      if (bar) bar.style.display = n ? 'block' : 'none';
      if (cnt) cnt.textContent = `${n} table(s) selected`;
    };
    document.querySelectorAll('.runtime-check').forEach(cb =>
      cb.addEventListener('change', refreshBar));
    $('#runtime-check-all')?.addEventListener('change', ev => {
      document.querySelectorAll('.runtime-check').forEach(cb => cb.checked = ev.target.checked);
      refreshBar();
    });
    $('#runtime-bulk-unregister')?.addEventListener('click', async () => {
      const names = [...document.querySelectorAll('.runtime-check:checked')].map(cb => cb.dataset.name);
      if (!names.length) return;
      if (!confirm(`Unregister ${names.length} runtime table(s)? Removes from driver + all agents.`)) return;
      await Promise.allSettled(names.map(n =>
        api('/mesh/tables/' + encodeURIComponent(n) + '?partitionKey=broadcast',
            { method: 'DELETE' })));
      refreshRuntimeTablesPanel();
    });
    target.querySelectorAll('.runtime-unregister').forEach(a =>
      a.addEventListener('click', ev => {
        ev.preventDefault();
        unregisterRuntimeTable(a.dataset.name);
      }));
    target.querySelectorAll('.runtime-select').forEach(a =>
      a.addEventListener('click', ev => {
        ev.preventDefault();
        setSql('SELECT * FROM ' + a.dataset.name + ' LIMIT 100');
      }));
    // Clicking the table name opens the detail modal.
    target.querySelectorAll('.runtime-detail').forEach(a =>
      a.addEventListener('click', ev => {
        ev.preventDefault();
        openRuntimeTableDetail(a.dataset.name);
      }));
    // Clicking the URI jumps to the Cluster tab's storage browser +
    // preview so the operator can see the underlying file.
    target.querySelectorAll('.runtime-browse').forEach(a =>
      a.addEventListener('click', ev => {
        ev.preventDefault();
        jumpToStorageBrowser(a.dataset.uri);
      }));
  } catch (e) {
    target.innerHTML = `<small style="color:var(--danger)">${esc(e.message || e)}</small>`;
  }
}

/** Open the runtime-table detail modal — fetches:
 *   1. the tracker entry for schema/uri/timestamp,
 *   2. SELECT * FROM &lt;name&gt; LIMIT 20 for a data sample,
 *   3. /mesh/agents to show which agents received the fan-out.
 *  All three run concurrently; the modal renders whatever came back. */
async function openRuntimeTableDetail(name) {
  const dlg = $('#runtime-table-dialog');
  const title = $('#runtime-table-title');
  const body = $('#runtime-table-body');
  if (!dlg || !title || !body) return;
  title.textContent = 'Table: ' + name;
  body.innerHTML = '<small class="meta">loading…</small>';
  dlg.showModal();

  const [entryRes, sampleRes, holdersRes] = await Promise.allSettled([
    api('/mesh/queries/registered').then(rows => rows.find(r => r.name === name)),
    api('/mesh/queries', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({sql: 'SELECT * FROM ' + name + ' LIMIT 20', timeoutMs: 10000}),
    }),
    api('/mesh/queries/registered/' + encodeURIComponent(name) + '/agents'),
  ]);

  const entry = entryRes.status === 'fulfilled' ? entryRes.value : null;
  const sample = sampleRes.status === 'fulfilled' ? sampleRes.value : {rows: [], error: sampleRes.reason?.message};
  const holdersInfo = holdersRes.status === 'fulfilled' ? holdersRes.value : {holders: [], agentsAsked: 0, agentsReplied: 0};

  let schemaHtml = '<em>no tracker entry (perhaps registered before driver restart)</em>';
  if (entry) {
    let fields = [];
    try { fields = JSON.parse(entry.typeJson).fields || []; } catch (_) {}
    schemaHtml = `
      <table style="width:100%;font-size:0.82rem;border-collapse:collapse;">
        <thead><tr>
          <th style="text-align:left;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;">field</th>
          <th style="text-align:left;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;">type</th>
        </tr></thead>
        <tbody>${fields.map(f => `
          <tr>
            <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;"><code>${esc(f.name)}</code></td>
            <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">${esc(f.type)}</td>
          </tr>`).join('')}</tbody>
      </table>`;
  }

  const sampleRows = sample.rows || [];
  let sampleHtml;
  if (sample.error) {
    sampleHtml = `<span style="color:var(--danger)">${esc(sample.error || 'sample failed')}</span>`;
  } else if (!sampleRows.length) {
    sampleHtml = '<em>no rows returned</em>';
  } else {
    const cols = Object.keys(sampleRows[0]);
    sampleHtml = `
      <div class="scroll" style="max-height:20rem;overflow:auto;">
      <table style="width:100%;font-size:0.78rem;border-collapse:collapse;">
        <thead><tr>${cols.map(c => `
          <th style="text-align:left;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;background:#eef;">${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${sampleRows.map(r => `<tr>${cols.map(c => `
          <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">${esc(String(r[c] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
  }

  const holders = holdersInfo.holders || [];
  const holdersHtml = holders.length
    ? holders.map(h => `<li><code>${esc(h.agentId)}</code> <span class="meta">— ${esc(h.source)}, pk=${esc(h.partitionKey ?? 'null')}</span></li>`).join('')
    : '<li><em>no agent responded with this table installed</em></li>';

  body.innerHTML = `
    <section style="margin-top:0.4rem;">
      <h4 style="margin:0 0 0.3rem;">Metadata</h4>
      <table style="font-size:0.8rem;">
        <tr><td class="meta">uri</td><td><code>${esc(entry?.uri || '?')}</code></td></tr>
        <tr><td class="meta">format</td><td>${esc(entry?.format || '?')}</td></tr>
        <tr><td class="meta">broadcast</td><td>${entry?.broadcast ? 'yes' : 'no'}</td></tr>
        <tr><td class="meta">registered at</td><td>${esc(entry?.registeredAt || '?')}</td></tr>
        <tr><td class="meta">agents notified (at fan-out)</td><td>${entry?.agentsNotified ?? '?'}</td></tr>
      </table>
    </section>
    <section style="margin-top:0.6rem;">
      <h4 style="margin:0 0 0.3rem;">Schema <span class="meta">— induced from first row</span></h4>
      ${schemaHtml}
      <div style="margin-top:0.3rem;">
        <button id="runtime-copy-json" class="secondary outline"
                style="padding:0.1rem 0.5rem;font-size:0.8rem;">📋 Copy JSON</button>
        <button id="runtime-copy-yaml" class="secondary outline"
                style="padding:0.1rem 0.5rem;font-size:0.8rem;">📋 Copy YAML</button>
        <span id="runtime-copy-msg" class="meta" style="margin-left:0.5rem;font-size:0.75rem;"></span>
      </div>
      <details style="margin-top:0.4rem;">
        <summary style="cursor:pointer;font-size:0.85rem;">
          <b>Refine schema</b> <span class="meta">— override types (e.g. force <code>core_long</code>)</span>
        </summary>
        <textarea id="runtime-schema-editor" style="width:100%;min-height:10rem;font-family:ui-monospace,monospace;font-size:0.78rem;margin-top:0.3rem;">${esc(entry?.typeJson || '')}</textarea>
        <div style="margin-top:0.3rem;">
          <button id="runtime-schema-save" class="secondary" data-name="${esc(name)}"
                  style="padding:0.15rem 0.5rem;">Update schema on all agents</button>
          <span id="runtime-schema-msg" class="meta" style="margin-left:0.5rem;"></span>
        </div>
      </details>
    </section>
    <section style="margin-top:0.6rem;">
      <h4 style="margin:0 0 0.3rem;">Sample rows <span class="meta">— SELECT * LIMIT 20</span></h4>
      ${sampleHtml}
    </section>
    <section style="margin-top:0.6rem;">
      <h4 style="margin:0 0 0.3rem;">Agents actually holding this table
        <span class="meta">— ${holdersInfo.agentsReplied}/${holdersInfo.agentsAsked} agents responded</span></h4>
      <ul style="margin:0;padding-left:1.2rem;">${holdersHtml}</ul>
    </section>`;

  // Copy-as-JSON / YAML buttons for the induced type.
  $('#runtime-copy-json')?.addEventListener('click', () => copyTypeSchema(entry?.typeJson, 'json'));
  $('#runtime-copy-yaml')?.addEventListener('click', () => copyTypeSchema(entry?.typeJson, 'yaml'));

  // Wire the schema-save button — validates JSON client-side, POSTs to
  // /mesh/queries/registered/{name}/schema which re-fan-outs.
  $('#runtime-schema-save')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    const msgEl = $('#runtime-schema-msg');
    const editor = $('#runtime-schema-editor');
    let typeJson = (editor.value || '').trim();
    try { JSON.parse(typeJson); }
    catch (e) {
      msgEl.style.color = 'var(--danger)';
      msgEl.textContent = 'invalid JSON: ' + e.message;
      return;
    }
    btn.disabled = true;
    msgEl.style.color = '';
    msgEl.textContent = 'updating on agents…';
    try {
      const r = await api('/mesh/queries/registered/' + encodeURIComponent(btn.dataset.name) + '/schema',
        { method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({typeJson}) });
      if (r.error) throw new Error(r.error);
      msgEl.style.color = 'var(--success)';
      msgEl.textContent = `✓ updated on ${r.agentsNotified} agent(s)`;
    } catch (e) {
      msgEl.style.color = 'var(--danger)';
      msgEl.textContent = 'update failed: ' + (e.message || e);
    } finally {
      btn.disabled = false;
    }
  });
}

/** Switch to the Cluster tab, walk the storage browser to the file's
 *  parent dir, preview the file. Called from runtime-tables panel URI
 *  clicks so operators can verify what's actually on disk. */
/** Fire a browser Notification (if the user granted permission) for
 *  long-running operations that finished. Silently no-ops when
 *  permission is denied/default or Notifications aren't supported. */
function notify(title, body) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, {body, silent: false, tag: 'hitorro-mesh'});
    } else if (Notification.permission === 'default') {
      // Ask once — subsequent calls will hit "granted" or "denied".
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') new Notification(title, {body, silent: false, tag: 'hitorro-mesh'});
      });
    }
  } catch (_) { /* Notification unavailable — silent */ }
}

function jumpToStorageBrowser(fileUri) {
  const tabBtn = document.querySelector('[role="tab"][data-target="cluster"]');
  if (tabBtn) tabBtn.click();
  // Give the tab a beat to render the storage panel before poking it.
  setTimeout(() => {
    const parent = fileUri.replace(/\/[^\/]+$/, '/');
    browseStorage(parent);
    setTimeout(() => previewStorageFile(fileUri), 250);
  }, 150);
}

/** Copy a JVS type either as JSON (pretty-printed) or as YAML. YAML
 *  conversion is client-side — no round-trip through YAML.stringify;
 *  we just format the well-known JVS shape by hand for readability. */
function copyTypeSchema(typeJson, fmt) {
  const msg = $('#runtime-copy-msg');
  if (!typeJson) return;
  let out;
  try {
    if (fmt === 'yaml') {
      out = jvsTypeToYaml(JSON.parse(typeJson));
    } else {
      out = JSON.stringify(JSON.parse(typeJson), null, 2);
    }
  } catch (e) {
    if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = 'parse error: ' + e.message; }
    return;
  }
  navigator.clipboard.writeText(out).then(() => {
    if (msg) { msg.style.color = 'var(--success)'; msg.textContent = `✓ copied as ${fmt}`; }
  }).catch(e => {
    if (msg) { msg.style.color = 'var(--danger)'; msg.textContent = 'clipboard denied: ' + e.message; }
  });
}

/** Format a parsed JVS type as YAML. Trivial for this well-known shape
 *  ({name, fields:[{name,type}]}) — no generic YAML lib needed. */
function jvsTypeToYaml(t) {
  const lines = [`name: ${t.name}`, `fields:`];
  for (const f of (t.fields || [])) {
    lines.push(`  - name: ${f.name}`);
    lines.push(`    type: ${f.type}`);
  }
  return lines.join('\n') + '\n';
}

/** Open the batch-write modal. User pastes SQL statements separated by
 *  ";;" (or newlines with no separator), picks format + prefix + whether
 *  to register each, hits Run. Sequential POST /mesh/queries/write/batch. */
function openBatchWriteDialog() {
  const dlg = $('#batch-write-dialog');
  const results = $('#batch-write-results');
  if (!dlg) return;
  results.innerHTML = '';
  $('#batch-write-summary').textContent = '';
  dlg.showModal();
}

async function runBatchWrite() {
  const raw = $('#batch-write-sqls').value || '';
  const format = $('#batch-write-format').value;
  const register = $('#batch-write-register').checked;
  const prefix = ($('#batch-write-prefix').value || 'batch').trim();
  const results = $('#batch-write-results');
  const summary = $('#batch-write-summary');

  // Split on ";;" first; fall back to newline splitting if that produced
  // one item (means user wrote one SQL per line without the separator).
  let sqls = raw.split(';;').map(s => s.trim()).filter(Boolean);
  if (sqls.length <= 1 && raw.includes('\n')) {
    sqls = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  if (!sqls.length) {
    summary.style.color = 'var(--danger)';
    summary.textContent = 'no SQL statements';
    return;
  }

  const queries = sqls.map((sql, i) => ({
    sql,
    tableName: `${prefix}_${i}`,
  }));

  summary.style.color = '';
  summary.textContent = `running ${queries.length} query(s)…`;
  results.innerHTML = '';

  try {
    const r = await api('/mesh/queries/write/batch', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({format, register, queries}),
    });
    summary.style.color = r.success ? 'var(--success)' : 'var(--danger)';
    summary.textContent = `${r.successes}/${r.totalQueries} succeeded · ${r.totalRowsWritten} total rows · ${r.elapsedMs}ms`;
    results.innerHTML = `
      <table style="width:100%;font-size:0.82rem;border-collapse:collapse;">
        <thead><tr>
          <th style="text-align:left;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;">#</th>
          <th style="text-align:left;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;">status</th>
          <th style="text-align:left;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;">table</th>
          <th style="text-align:right;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;">rows</th>
          <th style="text-align:right;padding:0.2rem 0.4rem;border-bottom:1px solid #ccc;">ms</th>
        </tr></thead>
        <tbody>
          ${r.results.map(x => `
            <tr>
              <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">${x.index}</td>
              <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">
                ${x.success ? '<span style="color:var(--success)">✓</span>' : `<span style="color:var(--danger)" title="${esc(x.error || '')}">✗</span>`}
              </td>
              <td style="padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">${x.registered?.tableName ? '<code>' + esc(x.registered.tableName) + '</code>' : (x.error ? '<span class="meta">' + esc(x.error).substring(0, 60) + '</span>' : '<span class="meta">—</span>')}</td>
              <td style="text-align:right;padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">${x.rowsWritten ?? '-'}</td>
              <td style="text-align:right;padding:0.15rem 0.4rem;border-bottom:1px solid #eee;">${x.elapsedMs ?? '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
    if (register) refreshRuntimeTablesPanel();
    // Long batches — signal the user if they've tabbed away.
    if (queries.length >= 5 && document.hidden) {
      notify(r.success ? 'Batch write done' : 'Batch write finished with errors',
             `${r.successes}/${r.totalQueries} succeeded · ${r.totalRowsWritten} rows`);
    }
  } catch (e) {
    summary.style.color = 'var(--danger)';
    summary.textContent = 'batch failed: ' + (e.message || e);
    if (queries.length >= 5 && document.hidden) {
      notify('Batch write failed', e.message || String(e));
    }
  }
}

/** Register an existing file (no SQL, no sink). Reads form values off
 *  the Register-existing panel, POSTs to /mesh/queries/register-existing,
 *  refreshes the runtime-tables panel on success. */
async function registerExistingFromPanel() {
  const uri       = ($('#pg-re-uri').value || '').trim();
  const name      = ($('#pg-re-tablename').value || '').trim();
  const format    = $('#pg-re-format').value;
  const broadcast = $('#pg-re-broadcast').checked;
  const pk        = ($('#pg-re-pk').value || '').trim();
  const status    = $('#pg-re-status');

  if (!uri)  { status.style.color = 'var(--danger)'; status.textContent = 'uri is required'; return; }
  if (!name) { status.style.color = 'var(--danger)'; status.textContent = 'table name is required'; return; }
  if (!broadcast && !pk) {
    status.style.color = 'var(--danger)';
    status.textContent = 'partitionKey is required when broadcast is off';
    return;
  }

  status.style.color = '';
  status.textContent = 'registering…';
  try {
    const body = {name, uri, format, broadcast};
    if (!broadcast) body.partitionKey = pk;
    const r = await api('/mesh/queries/register-existing', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    if (r.error) throw new Error(r.error);
    status.style.color = 'var(--success)';
    status.innerHTML = `✓ registered <code>${esc(r.tableName)}</code> on ${r.agentsNotified} agent(s)`
      + ` — try <code>SELECT * FROM ${esc(r.tableName)}</code>`;
    refreshRuntimeTablesPanel();
  } catch (e) {
    status.style.color = 'var(--danger)';
    status.textContent = 'register failed: ' + (e.message || e);
  }
}

async function unregisterRuntimeTable(name) {
  if (!confirm(`Unregister "${name}" from the mesh? This drops the driver-side entry AND removes it from every agent's runtime registry.`)) return;
  try {
    const r = await api('/mesh/tables/' + encodeURIComponent(name) + '?partitionKey=broadcast',
                        { method: 'DELETE' });
    if (r.error) throw new Error(r.error);
    refreshRuntimeTablesPanel();
  } catch (e) {
    alert('unregister failed: ' + (e.message || e));
  }
}

/** Trigger the reactive re-hash — POST to /reconcile-partitions.
 *  Shows outcome counts inline, refreshes inventory matrix on completion. */
async function rehashPartitions() {
  const badge = $('#inventory-badge');
  const body = $('#inventory-body');
  if (!body) return;
  const priorHtml = body.innerHTML;
  body.innerHTML = '<small class="meta">re-hashing partitions…</small>';
  try {
    const r = await api('/mesh/queries/registered/reconcile-partitions', {method: 'POST'});
    await refreshInventoryMatrix();
    // Overlay a summary line above the matrix.
    const summary = `<div style="margin:0 0 0.4rem;padding:0.3rem 0.5rem;background:#f8f9fa;border-left:3px solid #2E86AB;font-size:0.85rem;">`
      + `re-hashed <b>${r.rehashed.length}</b> · `
      + `still-live <b>${r.stillLive.length}</b> · `
      + `skipped-explicit <b>${r.skippedExplicit.length}</b> · `
      + `within-grace <b>${r.withinGrace?.length ?? 0}</b> · `
      + `refused <b>${r.refused.length}</b>`
      + `</div>`;
    body.innerHTML = summary + body.innerHTML;
  } catch (e) {
    body.innerHTML = priorHtml
      + `<div style="color:var(--danger);margin-top:0.4rem;">re-hash failed: ${esc(e.message || e)}</div>`;
  }
}

async function reconcileRuntimeTables() {
  const dlg = $('#reconcile-dialog');
  const body = $('#reconcile-body');
  const summary = $('#reconcile-summary');
  if (!dlg || !body) return;
  body.innerHTML = '<small class="meta">probing agents…</small>';
  summary.textContent = '';
  dlg.showModal();
  try {
    const r = await api('/mesh/queries/registered/reconcile/preview');
    if (!r.count) {
      body.innerHTML = '<em>no runtime entries found on any agent — nothing to reconcile.</em>';
      summary.textContent = `${r.agentsReplied}/${r.agentsAsked} agents replied`;
      return;
    }
    const orphanCount = r.candidates.filter(c => !c.trackedByDriver).length;
    body.innerHTML = `
      <p class="meta" style="margin:0 0 0.4rem;">
        ${r.count} distinct runtime entries across ${r.agentsReplied}/${r.agentsAsked} agent(s).
        ${orphanCount > 0
          ? `<b>${orphanCount} orphan(s)</b> pre-selected (agents hold entries the driver's tracker doesn't know about).`
          : 'No orphans — everything is tracked. Selection empty by default to prevent accidents.'}
      </p>
      <div style="margin:0.3rem 0;font-size:0.8rem;">
        <a href="#" id="reconcile-select-orphans">select orphans</a> ·
        <a href="#" id="reconcile-select-all-link">select all</a> ·
        <a href="#" id="reconcile-select-none">clear</a>
      </div>
      <table style="width:100%;font-size:0.85rem;">
        <thead><tr>
          <th style="width:1.5rem;padding:0.15rem 0.4rem;"></th>
          <th style="text-align:left;padding:0.15rem 0.4rem;">table</th>
          <th style="text-align:left;padding:0.15rem 0.4rem;">pk</th>
          <th style="text-align:left;padding:0.15rem 0.4rem;">held by</th>
          <th style="text-align:center;padding:0.15rem 0.4rem;">tracked</th>
        </tr></thead>
        <tbody>
          ${r.candidates.map((c, i) => `
            <tr>
              <td style="padding:0.15rem 0.4rem;">
                <input type="checkbox" class="reconcile-check"
                       ${c.trackedByDriver ? '' : 'checked'}
                       data-name="${esc(c.name)}"
                       data-pk="${esc(c.partitionKey ?? '')}"
                       data-orphan="${c.trackedByDriver ? '0' : '1'}"
                       style="margin:0;">
              </td>
              <td style="padding:0.15rem 0.4rem;"><code>${esc(c.name)}</code></td>
              <td style="padding:0.15rem 0.4rem;">${esc(c.partitionKey ?? 'null')}</td>
              <td style="padding:0.15rem 0.4rem;font-size:0.78rem;color:#666;">${(c.heldBy || []).map(a => `<code>${esc(a)}</code>`).join(', ')}</td>
              <td style="padding:0.15rem 0.4rem;text-align:center;">${c.trackedByDriver ? '✓' : '⚠ orphan'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
    const updateSelectedCount = () => {
      const n = document.querySelectorAll('.reconcile-check:checked').length;
      summary.textContent = `${n} of ${r.count} selected`;
    };
    document.querySelectorAll('.reconcile-check').forEach(cb =>
      cb.addEventListener('change', updateSelectedCount));
    $('#reconcile-select-orphans')?.addEventListener('click', ev => {
      ev.preventDefault();
      document.querySelectorAll('.reconcile-check').forEach(cb =>
        cb.checked = cb.dataset.orphan === '1');
      updateSelectedCount();
    });
    $('#reconcile-select-all-link')?.addEventListener('click', ev => {
      ev.preventDefault();
      document.querySelectorAll('.reconcile-check').forEach(cb => cb.checked = true);
      updateSelectedCount();
    });
    $('#reconcile-select-none')?.addEventListener('click', ev => {
      ev.preventDefault();
      document.querySelectorAll('.reconcile-check').forEach(cb => cb.checked = false);
      updateSelectedCount();
    });
    updateSelectedCount();
  } catch (e) {
    body.innerHTML = `<small style="color:var(--danger)">preview failed: ${esc(e.message || e)}</small>`;
  }
}

async function applyReconcile() {
  const picks = [...document.querySelectorAll('.reconcile-check:checked')].map(cb => ({
    name: cb.dataset.name,
    partitionKey: cb.dataset.pk || null,
  }));
  if (!picks.length) {
    alert('nothing selected');
    return;
  }
  if (!confirm(`Unregister ${picks.length} runtime entries mesh-wide? This cannot be undone.`)) return;
  const btn = $('#reconcile-apply');
  btn.disabled = true;
  try {
    const r = await api('/mesh/queries/registered/reconcile/apply', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({targets: picks}),
    });
    $('#reconcile-dialog').close();
    refreshRuntimeTablesPanel();
    refreshInventoryMatrix();
    const st = $('#pg-write-status');
    if (st) {
      st.style.color = 'var(--success)';
      st.innerHTML = `🧹 reconciled ${r.count} runtime entries`;
    }
  } catch (e) {
    alert('apply failed: ' + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}

async function clearAllRuntimeTables() {
  const count = document.querySelectorAll('#pg-runtime-tables tbody tr').length;
  if (!count) return;
  if (!confirm(`Unregister ALL ${count} runtime-registered table(s)? This drops driver-side entries AND removes them from every agent. This cannot be undone.`)) return;
  try {
    const r = await api('/mesh/queries/registered/clear', {method: 'POST'});
    refreshRuntimeTablesPanel();
    const st = $('#pg-write-status');
    if (st) {
      st.style.color = 'var(--success)';
      st.innerHTML = `🗑 cleared ${r.count} table(s)`;
    }
  } catch (e) {
    alert('clear-all failed: ' + (e.message || e));
  }
}

async function writePlaygroundQuery() {
  const sql       = getSql().trim();
  const format    = $('#pg-write-format').value;
  const path      = ($('#pg-write-path').value || '').trim();
  const register  = $('#pg-write-register')?.checked || false;
  const tableName = ($('#pg-write-tablename')?.value || '').trim();
  const timeoutMs = Math.max(+$('#pg-timeout').value || 5000, 30000); // writes get ≥ 30s
  const statusEl  = $('#pg-write-status');
  if (!sql)  { statusEl.textContent = 'no SQL — nothing to write'; return; }
  if (!path) { statusEl.textContent = 'destination is required (name, or file:/… / s3://…)'; return; }

  statusEl.style.color = '';
  statusEl.textContent = `writing ${format} → ${path} …`;
  const t0 = performance.now();
  try {
    const body = { sql, format, path, timeoutMs, register };
    if (tableName) body.tableName = tableName;
    const r = await api('/mesh/queries/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const dtMs = Math.round(performance.now() - t0);
    if (r.success) {
      statusEl.style.color = 'var(--success)';
      // Show where it actually landed — critical when the user typed a
      // bare name and the resolver picked the destination.
      let msg = `✅ wrote <b>${r.rowsWritten.toLocaleString()}</b> rows `
        + `→ <code>${esc(r.resolved || r.path)}</code> in ${dtMs}ms`;
      if (r.registered && r.registered.tableName) {
        msg += ` · registered as <code>${esc(r.registered.tableName)}</code>`
             + ` on ${r.registered.agentsNotified} agent(s)`
             + ` — try <code>SELECT * FROM ${esc(r.registered.tableName)}</code>`
             + ` <a href="#" id="pg-write-copy-yaml"`
             + ` data-type-json='${esc(r.registered.typeJson)}'`
             + ` title="Copy the induced JVS type as YAML"`
             + ` style="margin-left:0.5rem;text-decoration:none;font-size:0.85em;">📋 YAML</a>`;
        refreshRuntimeTablesPanel();
      } else if (r.registered && r.registered.skipped) {
        msg += ` · registration skipped: ${esc(r.registered.skipped)}`;
      }
      statusEl.innerHTML = msg;
      // Wire the copy-as-YAML link if present (write-with-register only).
      $('#pg-write-copy-yaml')?.addEventListener('click', ev => {
        ev.preventDefault();
        const tj = ev.currentTarget.dataset.typeJson;
        try {
          navigator.clipboard.writeText(jvsTypeToYaml(JSON.parse(tj)));
          ev.currentTarget.textContent = '✓ copied';
          setTimeout(() => { if (ev.currentTarget) ev.currentTarget.textContent = '📋 YAML'; }, 2000);
        } catch (e) {
          alert('copy failed: ' + (e.message || e));
        }
      });
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
  $('#pg-write-batch-btn')?.addEventListener('click', openBatchWriteDialog);
  $('#batch-write-run')?.addEventListener('click', runBatchWrite);
  $('#pg-re-btn')?.addEventListener('click', registerExistingFromPanel);
  // Live-preview the resolved path as user types + changes format
  $('#pg-write-path')?.addEventListener('input',  updateWriteResolvedHint);
  $('#pg-write-format')?.addEventListener('change', updateWriteResolvedHint);
  updateWriteResolvedHint();
  refreshRuntimeTablesPanel();
  $('#pg-runtime-clear-all')?.addEventListener('click', ev => {
    ev.preventDefault();
    clearAllRuntimeTables();
  });
  $('#pg-runtime-reconcile')?.addEventListener('click', ev => {
    ev.preventDefault();
    reconcileRuntimeTables();
  });
  // Live filter over rendered runtime-table rows.
  $('#pg-runtime-search')?.addEventListener('input', ev => {
    const q = (ev.target.value || '').toLowerCase().trim();
    document.querySelectorAll('#pg-runtime-tables tbody tr').forEach(tr => {
      const name = tr.querySelector('code')?.textContent?.toLowerCase() || '';
      tr.style.display = (!q || name.includes(q)) ? '' : 'none';
    });
  });
  // Auto-refresh runtime tables panel when the tab regains focus —
  // catches unregisters/registers done from another tab or curl.
  window.addEventListener('focus', () => {
    if (document.querySelector('#playground.tab-panel.active')) {
      refreshRuntimeTablesPanel();
    }
  });
  // Inventory matrix refresh + reconcile buttons.
  $('#inventory-refresh')?.addEventListener('click', ev => {
    ev.preventDefault();
    refreshInventoryMatrix();
  });
  $('#inventory-reconcile')?.addEventListener('click', ev => {
    ev.preventDefault();
    reconcileRuntimeTables();
  });
  $('#inventory-rehash')?.addEventListener('click', ev => {
    ev.preventDefault();
    rehashPartitions();
  });
  // Polling on/off with tab visibility.
  document.addEventListener('visibilitychange', updateInventoryPolling);
  updateInventoryPolling();
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
    '#search-index',
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
  // curl / .http format + coordinator / simple GET toggles — refresh
  // the request preview when either changes.
  document.querySelectorAll('input[name="req-fmt"], input[name="req-style"]').forEach(r => {
    if (r._wiredPreview) return;
    r._wiredPreview = true;
    r.addEventListener('change', updateRequestPreview);
  });
  // 📋 copy — grabs whatever curl / .http text is currently rendered.
  const copyBtn = $('#search-req-copy');
  if (copyBtn && !copyBtn._wired) {
    copyBtn._wired = true;
    copyBtn.addEventListener('click', async () => {
      const txt = $('#search-request-preview')?.textContent || '';
      try {
        await navigator.clipboard.writeText(txt);
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓ copied';
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      } catch (_) { plToast('clipboard blocked — select the box and Cmd-C', 'warn'); }
    });
  }
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
  updateRequestPreview();
}

/**
 * Live preview of the HTTP request the search page would fire.
 *
 * The RIGHT target is always the retrieval coordinator at
 * {@code POST /api/retrieval/execute} — it takes a JVS query with
 * {@code search}/{@code fetch}/{@code fixup}/{@code page}/{@code summarize}
 * stages, exactly what the UI's stage builder assembles. The driver's
 * bare {@code GET /mesh/search/{index}?q=…} endpoint is a Lucene-only
 * shortcut with no stage support, so previewing it would mislead
 * anyone reproducing the full pipeline outside the UI. Two modes:
 *
 *  · "coordinator" (default) — POST to the fleet-retrieval service
 *    ({@code {fleet}/api/retrieval/execute}), body is the full JVS
 *    query. Always the correct target when any stage is checked.
 *
 *  · "simple GET" (opt-in) — the driver's in-process shortcut when
 *    the user is only doing a plain Lucene search with no stages.
 */
function updateRequestPreview() {
  const pre = $('#search-request-preview');
  if (!pre) return;
  const fmt   = (document.querySelector('input[name="req-fmt"]:checked')?.value)   || 'curl';
  const style = (document.querySelector('input[name="req-style"]:checked')?.value) || 'coord';
  const fleet = fleetBase();
  const idx = ($('#search-index')?.value || '<pick-an-index>').trim();
  const q = ($('#search-q')?.value || '').trim();
  const lim = parseInt($('#search-limit')?.value, 10) || 20;

  let text;
  if (style === 'simple') {
    // Driver's Lucene-only shortcut. Stages are ignored server-side —
    // useful only for a plain query.
    const origin = window.location.origin;
    const params = new URLSearchParams();
    params.set('q', q);
    params.set('limit', String(lim));
    const url = `${origin}/mesh/search/${encodeURIComponent(idx)}?${params.toString()}`;
    if (fmt === 'http') {
      text =
        `### Simple Lucene search — ${idx} (no stages)\n` +
        `GET ${url}\n` +
        `Accept: application/json\n`;
    } else {
      text = `curl -sS '${url}'`;
    }
  } else {
    // Coordinator — the full JVS query pipeline (search + optional
    // fetch/fixup/page/summarize). Points at the fleet-retrieval URL
    // when configured, else at a self-descriptive placeholder so users
    // know what to fill in.
    const url = (fleet ? fleet : 'http://<fleet-retrieval-host>') + '/api/retrieval/execute';
    const body = {indexName: idx, query: buildRetrievalQuery()};
    const pretty = JSON.stringify(body, null, 2);
    if (fmt === 'http') {
      text =
        `### Coordinator retrieval — ${idx}\n` +
        `POST ${url}\n` +
        `Content-Type: application/json\n\n` +
        `${pretty}\n`;
    } else {
      // Single-quote the JSON body and escape any embedded single
      // quotes (bash-safe: close ', insert \', re-open ').
      const shellQuoted = "'" + pretty.replace(/'/g, "'\\''") + "'";
      text =
        `curl -sS -X POST '${url}' \\\n` +
        `  -H 'content-type: application/json' \\\n` +
        `  -d ${shellQuoted}`;
    }
  }
  pre.textContent = text;
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
    updateRequestPreview();   // switching backend swaps GET ↔ POST shape
  };
  sel.addEventListener('change', apply);
  urlIn.addEventListener('input', () => {
    if (sel.value === 'fleet') hint.innerHTML =
      `Calls <code>POST ${esc(urlIn.value)}/api/retrieval/execute</code>`;
    updateRequestPreview();   // URL is baked into the preview
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
  ['fleet-log-close', 'fleet-manifest-close', 'runtime-table-close', 'reconcile-close', 'batch-write-close'].forEach(id => {
    const b = $('#' + id);
    if (b && !b._wired) { b._wired = true; b.addEventListener('click', () => b.closest('dialog').close()); }
  });
  const applyBtn = $('#reconcile-apply');
  if (applyBtn && !applyBtn._wired) { applyBtn._wired = true; applyBtn.addEventListener('click', applyReconcile); }
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
  scheduleJobsPoll();
}

// Adaptive poll: 1s while any job is RUNNING (so newly-submitted jobs
// appear near-instantly), 5s otherwise. Re-schedules itself after every
// tick so the interval matches current state without racing.
function scheduleJobsPoll() {
  if (jobsTimer) clearTimeout(jobsTimer);
  const hasRunning = (jobsLastRunning || 0) > 0;
  const delay = hasRunning ? 1000 : 5000;
  jobsTimer = setTimeout(async () => {
    if ($('#jobs').classList.contains('active')) {
      await loadJobs();
    }
    scheduleJobsPoll();
  }, delay);
}
let jobsLastRunning = 0;

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
  // Split into running vs finished. Running jobs get their own
  // dedicated section at the top of the panel so the user can't miss a
  // job that was just submitted — this was the previous UX bug.
  const runningJobs = running.filter(r => r.state === 'RUNNING');
  const runningIds = new Set(runningJobs.map(r => r.jobId));
  const doneJobs = history.filter(h => !runningIds.has(h.jobId));
  jobsLastRunning = runningJobs.length;   // drives scheduleJobsPoll cadence

  $('#jobs-count').textContent = `${runningJobs.length + doneJobs.length} jobs — ${runningJobs.length} running`;

  if (!runningJobs.length && !doneJobs.length) {
    $('#jobs-list').innerHTML = '<p class="meta">No jobs yet. Run a bundled example from the Pipelines tab.</p>';
    return;
  }

  const tableHtml = (jobs, idPrefix) => `
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
          ${jobs.map((j,i) => jobRowHtml(j, idPrefix + i)).join('')}
        </tbody>
      </table>
    </div>`;

  const runningBlock = runningJobs.length
    ? `<div style="margin-bottom: 1rem; padding: 0.5rem 0.75rem; border-left: 3px solid #3af; background: rgba(51,170,255,0.06); border-radius: 3px;">
         <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.4rem;">
           <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#3af; animation: pulse 1.5s ease-in-out infinite;"></span>
           <strong style="font-size:0.9rem;">${runningJobs.length} running now</strong>
           <small class="meta">auto-refreshes every 1s while running</small>
         </div>
         ${tableHtml(runningJobs, 'r')}
       </div>`
    : '';

  const doneBlock = doneJobs.length
    ? `<div>
         <div style="font-size:0.85rem; color:var(--muted-color,#777); margin-bottom:0.35rem;">Recent (${doneJobs.length})</div>
         ${tableHtml(doneJobs, 'd')}
       </div>`
    : '';

  $('#jobs-list').innerHTML = `
    <style>@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }</style>
    ${runningBlock}
    ${doneBlock}`;

  runningJobs.forEach((j, i) => {
    const head = $(`#job-row-r${i}`);
    if (head) head.addEventListener('click', () => {
      const body = $(`#job-body-r${i}`);
      if (body) body.hidden = !body.hidden;
    });
  });
  doneJobs.forEach((j, i) => {
    const head = $(`#job-row-d${i}`);
    if (head) head.addEventListener('click', () => {
      const body = $(`#job-body-d${i}`);
      if (body) body.hidden = !body.hidden;
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
  // Local timezone — API returns UTC ISO strings.
  const startedShort = fmtLocalTs(started);
  const startedUtcTitle = started ? `UTC: ${started}` : '';
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
      <td style="padding:0.3rem;"><small title="${esc(startedUtcTitle)}">${esc(startedShort)}</small></td>
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
  // Setting .value programmatically does NOT fire the 'input' event that
  // updatePipelineRequestPreview listens on, so bundle-example loads
  // would leave the copy-as-curl preview stale. dispatchEvent fixes it.
  const setYaml = v => {
    const ta = $('#pl-yaml');
    if (!ta) return;
    ta.value = v;
    ta.dispatchEvent(new Event('input'));
  };
  $$('#pl-examples .ds-list-item').forEach(el => {
    el.addEventListener('click', () => {
      $$('#pl-examples .ds-list-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      setYaml(plBundledCache[el.dataset.name]);
    });
  });
  if (!$('#pl-yaml').value) {
    setYaml(plBundledCache[names[0]]);
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
        <span style="display:flex; gap: 0.25rem; align-items:center;">
          ${r.restartable ? '<span class="badge pl-restartable" title="Persisted to disk — resumes after driver restart">↻ restartable</span>' : ''}
          <span class="badge pl-state-${esc(r.state.toLowerCase())}">${esc(r.state)}</span>
        </span>
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

/** Local-timezone date + time, compact. All backend timestamps are
 *  UTC ISO strings ("2026-08-23T16:19:18.949177Z") — showing them
 *  raw is misleading (users read them as local). This coerces to
 *  the browser's timezone and drops the fractional seconds. */
function fmtLocalTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  const ta = $('#pl-yaml');
  if (!ta) return;
  ta.value = y;
  ta.dispatchEvent(new Event('input'));   // refresh copy-as-curl preview
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
            <td style="padding:0.25rem 0.3rem;font-size:0.75rem;" title="${esc(j.startedAt ? 'UTC: ' + j.startedAt : '')}">${esc(fmtLocalTs(j.startedAt))}</td>
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
  // #pl-run-btn (not #pl-run) — the sub-tab container also has id="pl-run"
  // and returning the div here would cause the click handler to bubble-catch
  // and then wipe the whole sub-tab via btn.textContent assignment.
  const runBtn = $('#pl-run-btn');
  const runDistBtn = $('#pl-run-dist');
  if (!runBtn) return;
  runBtn.addEventListener('click', () => submitRun('/mesh/jobs/run', runBtn, '▶ Run', 'local'));
  if (runDistBtn) {
    runDistBtn.addEventListener('click',
        () => submitRun('/mesh/jobs/run-distributed', runDistBtn, '▶ Run distributed', 'distributed'));
  }
  wirePipelineRequestPreview();
});

/**
 * Live preview of the HTTP request the ▶ Run / ▶ Run distributed
 * buttons would fire, rendered as a shell-safe `curl` (heredoc) or a
 * JetBrains IntelliJ / VS Code REST Client `.http` block. Users copy
 * this to reproduce the same submission from a terminal or `.http`
 * scratch file without leaving the UI.
 *
 * Endpoint follows the selected mode (local → /mesh/jobs/run,
 * distributed → /mesh/jobs/run-distributed). Body is the YAML from
 * the editor verbatim.
 */
function updatePipelineRequestPreview() {
  const pre = $('#pl-request-preview');
  if (!pre) return;
  const fmt  = (document.querySelector('input[name="pl-req-fmt"]:checked')?.value)  || 'curl';
  const mode = (document.querySelector('input[name="pl-req-mode"]:checked')?.value) || 'local';
  const yaml = ($('#pl-yaml')?.value || '# paste or load a pipeline YAML above\n').trimEnd() + '\n';
  const origin = window.location.origin;
  const path = mode === 'distributed' ? '/mesh/jobs/run-distributed' : '/mesh/jobs/run';
  const url = origin + path;
  let text;
  if (fmt === 'http') {
    // IntelliJ / VS Code REST Client format — the blank line after
    // headers is required; the YAML then reads until the next ### or EOF.
    text =
      `### ${mode === 'distributed' ? 'Distributed' : 'Local'} pipeline run\n` +
      `POST ${url}\n` +
      `Content-Type: application/x-yaml\n\n` +
      yaml;
  } else {
    // curl with a bash heredoc — safest way to embed multi-line YAML
    // that may contain single quotes, backticks, $ signs, etc. The
    // 'YAML' delimiter is single-quoted so bash doesn't expand $vars
    // inside the payload.
    text =
      `curl -sS -X POST '${url}' \\\n` +
      `  -H 'content-type: application/x-yaml' \\\n` +
      `  --data-binary @- <<'YAML'\n` +
      yaml +
      `YAML`;
  }
  pre.textContent = text;
}

function wirePipelineRequestPreview() {
  const editor = $('#pl-yaml');
  if (editor && !editor._reqPreviewWired) {
    editor._reqPreviewWired = true;
    editor.addEventListener('input', updatePipelineRequestPreview);
  }
  document.querySelectorAll('input[name="pl-req-fmt"], input[name="pl-req-mode"]').forEach(r => {
    if (r._reqPreviewWired) return;
    r._reqPreviewWired = true;
    r.addEventListener('change', updatePipelineRequestPreview);
  });
  const copyBtn = $('#pl-req-copy');
  if (copyBtn && !copyBtn._wired) {
    copyBtn._wired = true;
    copyBtn.addEventListener('click', async () => {
      const txt = $('#pl-request-preview')?.textContent || '';
      try {
        await navigator.clipboard.writeText(txt);
        const orig = copyBtn.textContent;
        copyBtn.textContent = '✓ copied';
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      } catch (_) { plToast('clipboard blocked — select the box and Cmd-C', 'warn'); }
    });
  }
  // Prime it once so the preview isn't empty before the user types.
  updatePipelineRequestPreview();
}

async function submitRun(endpoint, btn, label, mode) {
  let yaml = $('#pl-yaml').value.trim();
  if (!yaml && plBundledCache && Object.keys(plBundledCache).length) {
    const firstName = Object.keys(plBundledCache)[0];
    yaml = plBundledCache[firstName];
    const ta = $('#pl-yaml');
    ta.value = yaml;
    ta.dispatchEvent(new Event('input'));   // refresh copy-as-curl preview
    plToast(`auto-loaded "${firstName}" example — click again if you want a different one`, 'warn');
  }
  if (!yaml) {
    plToast('editor is empty — click a bundled example on the left first', 'warn');
    return;
  }
  // Guard: /mesh/jobs/run-distributed rejects driver-local sources
  // (sqlite path, file:// on the driver host) at the placement stage
  // with an IllegalArgumentException 14ms after submit. Users hit it
  // when they click "▶ Run distributed" on any pipeline that reads
  // from their local Mail / Photos / Messages DBs. Auto-route to the
  // local endpoint instead and tell them why — no round-trip failure,
  // no confusing red row in the Jobs tab.
  if (mode === 'distributed' && /^\s*kind:\s*sqlite\b/m.test(yaml)) {
    plToast(
      'pipeline has a sqlite source — falling back to local run (the DB file lives on the driver, not the agents)',
      'warn'
    );
    endpoint = '/mesh/jobs/run';
    mode = 'local';
    label = '▶ Run';
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
  $('#pl-status').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const r = await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/yaml' },
      body: yaml,
    });
    $('#pl-status-id').textContent = r.jobId;
    $('#pl-status-state').textContent = 'RUNNING';
    $('#pl-status-state').className = 'badge pl-state-running';
    // Wire the copy + "view in Jobs" affordances so the user always
    // has a way to grab the jobId even after the toast fades.
    const copyBtn = $('#pl-status-copy');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(r.jobId);
          const orig = copyBtn.textContent;
          copyBtn.textContent = '✓ copied';
          setTimeout(() => { copyBtn.textContent = orig; }, 1200);
        } catch (_) { plToast('clipboard blocked — jobId: ' + r.jobId, 'warn'); }
      };
    }
    const jobsLink = $('#pl-status-jobs-link');
    if (jobsLink) {
      jobsLink.onclick = (e) => {
        e.preventDefault();
        const jobsTabBtn = document.querySelector('[role="tab"][data-target="jobs"]');
        if (jobsTabBtn) jobsTabBtn.click();
      };
    }
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
  let lastRowsOut = 0, lastSampleAt = started;

  // Wired here (not in submitRun) so the refresh button also works
  // when a card in the history is clicked to resume watching.
  const refreshBtn = $('#pl-status-refresh');
  if (refreshBtn) refreshBtn.onclick = () => { poll().catch(e => console.error('manual refresh:', e)); };

  const poll = async () => {
    // Fetch state first — everything after this is best-effort rendering.
    // Any failure below MUST NOT prevent the terminal-state check from
    // firing, or the poll wedges (this was the "just says running" bug).
    let s;
    try {
      s = await api('/mesh/jobs/' + jobId);
    } catch (e) {
      console.error('[pl-poll] state fetch failed:', e);
      return;   // try again next tick
    }

    // State + badge update — separate try so a render failure below
    // doesn't leave the user staring at a stale label.
    try {
      $('#pl-status-state').textContent = s.state || '?';
      $('#pl-status-state').className = 'badge pl-state-' + (s.state || 'unknown').toLowerCase();
      $('#pl-status-restartable').hidden = !s.restartable;
      const elapsedS = (Date.now() - started) / 1000;
      // Aggregate progress across all nodes so a bare "RUNNING" turns into
      // "RUNNING · 150/500 rows · 12/s" — visible confirmation work is
      // happening, not the pipeline wedged. Rate is instantaneous (last
      // poll interval), not lifetime average.
      const nodes = s.nodes || [];
      const rowsOut = nodes.reduce((sum, n) => sum + (n.rowsOut || 0), 0);
      const rowsIn  = nodes.reduce((sum, n) => sum + (n.rowsIn  || 0), 0);
      const dt = (Date.now() - lastSampleAt) / 1000;
      const rate = dt > 0.2 ? Math.max(0, Math.round((rowsOut - lastRowsOut) / dt)) : 0;
      if (dt > 0.2) { lastSampleAt = Date.now(); lastRowsOut = rowsOut; }
      const progress = rowsIn > 0
        ? `${rowsOut.toLocaleString()}/${rowsIn.toLocaleString()} rows${rate ? ` · ${rate}/s` : ''}`
        : (rowsOut ? `${rowsOut.toLocaleString()} rows${rate ? ` · ${rate}/s` : ''}` : '');
      $('#pl-status-timing').textContent = `${elapsedS.toFixed(1)}s${progress ? ' · ' + progress : ''}`;
    } catch (e) { console.error('[pl-poll] status update failed:', e); }

    // DAG render + events — non-critical. Isolate so failures here
    // (unexpected node shape, missing state, etc.) don't wedge polling.
    try { renderDag(s); }
    catch (e) { console.error('[pl-poll] renderDag failed:', e); }
    try {
      const events = await api('/mesh/jobs/' + jobId + '/events').catch(() => []);
      $('#pl-events').innerHTML = events.map(e =>
        `<div><code>${esc(e.at.slice(11,19))}</code> <b>${esc(e.nodeId)}</b> ${esc(e.kind)}: ${esc(e.message)}</div>`
      ).join('');
    } catch (e) { console.error('[pl-poll] events fetch failed:', e); }

    // Terminal-state check — MUST always run so the loop stops cleanly.
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

  // Group nodes by their rank (populated by JobRunner during topoRank).
  // Nodes with no explicit rank field (older backends) all collapse to
  // rank 0 — degrades to a single column, still readable.
  const ranks = new Map();
  for (const n of nodes) {
    const r = (typeof n.rank === 'number') ? n.rank : 0;
    if (!ranks.has(r)) ranks.set(r, []);
    ranks.get(r).push(n);
  }
  const rankKeys = [...ranks.keys()].sort((a, b) => a - b);

  // Build column HTML. Each node gets a stable data-node-id so the
  // SVG-arrow pass can find it via querySelector to compute geometry.
  const cols = rankKeys.map(r => `
    <div class="pl-dag-col" data-rank="${r}">
      ${ranks.get(r).map(n => `
        <div class="pl-node pl-node-${esc(n.state.toLowerCase())}" data-node-id="${esc(n.id)}">
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
    </div>
  `).join('');

  $('#pl-dag').innerHTML = `
    <div class="pl-dag-wrap">
      <div class="pl-dag-grid">${cols}</div>
      <svg class="pl-dag-svg" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="pl-arrowhead" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#b3b3b3"/>
          </marker>
        </defs>
      </svg>
    </div>`;

  // After layout paints, measure each node's position and stroke arrows
  // from every dep's right edge to this node's left edge. requestAnimationFrame
  // waits for the grid to lay out — the SVG needs real geometry, not the
  // pre-render zeros.
  requestAnimationFrame(() => drawDagArrows(status));
}

/** Draw one SVG <path> per (dep, node) edge. Curves as a smooth
 *  cubic bezier so long-distance skips (rank 0 → rank 3) don't
 *  cut through intermediate node cards. Colour follows dep state
 *  so users see the wave of "done" cascading through the DAG. */
function drawDagArrows(status) {
  const wrap = document.querySelector('#pl-dag .pl-dag-wrap');
  const svg  = wrap && wrap.querySelector('.pl-dag-svg');
  if (!wrap || !svg) return;

  const wrapRect = wrap.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${wrapRect.width} ${wrapRect.height}`);
  svg.setAttribute('width',  wrapRect.width);
  svg.setAttribute('height', wrapRect.height);

  // Clear old paths (keep <defs>).
  [...svg.querySelectorAll('path.pl-dag-arrow')].forEach(p => p.remove());

  const nodeById = {};
  for (const n of (status.nodes || [])) nodeById[n.id] = n;

  const rectOf = (id) => {
    const el = wrap.querySelector(`.pl-node[data-node-id="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x0: r.left - wrapRect.left, y0: r.top    - wrapRect.top,
      x1: r.right - wrapRect.left, y1: r.bottom - wrapRect.top,
      cy: (r.top + r.bottom) / 2 - wrapRect.top,
    };
  };

  for (const n of (status.nodes || [])) {
    const deps = n.deps || [];
    for (const depId of deps) {
      const from = rectOf(depId);
      const to   = rectOf(n.id);
      if (!from || !to) continue;

      const x1 = from.x1;                   // dep right edge
      const y1 = from.cy;
      const x2 = to.x0;                     // this node left edge
      const y2 = to.cy;
      const dx = Math.max(30, (x2 - x1) / 2);
      const d  = `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;

      const dep = nodeById[depId] || {};
      const cls = 'pl-dag-arrow ' +
        (dep.state === 'RUNNING'    ? 'pl-dag-arrow-live' :
         dep.state === 'SUCCEEDED'  ? 'pl-dag-arrow-done' :
         dep.state === 'FAILED'     ? 'pl-dag-arrow-fail' : '');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      path.setAttribute('marker-end', 'url(#pl-arrowhead)');
      svg.appendChild(path);
    }
  }
}

