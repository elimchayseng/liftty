/**
 * Server-rendered /db — a read-only SQLite explorer for the FLOW-LIVE-EVENTS demo. Mirrors the
 * /chat aesthetic (dark, #f6821f accent, the .code monospace look). Key-gated at the route; the
 * page reuses the `?key=` from its own URL for every /db.json + /reset-demo call. NOT linked from
 * any other page — invisible unless you have the key.
 *
 * On load it fetches /db.json (the DO's read-only getDbSnapshot), renders a "cleanliness strip"
 * (module registry health) + one monospace table per SQLite table. plugins.source cells expand to
 * full source on click. A Refresh button + 5s auto-refresh toggle keep it live. A read-only query
 * console (SELECT/PRAGMA only, server-enforced) and a key-gated demo-reset control round it out.
 */
export function renderDb(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>liftty · db</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b0d10; color: #e8eaed;
    max-width: 1100px; margin: 0 auto; padding: 16px 14px 60px;
  }
  header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 4px 4px 14px; }
  header h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; }
  header .dot { color: #f6821f; }
  header .gen { color: #6b7280; font-size: 12px; }
  header .controls { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  button { background: #f6821f; color: #0b0d10; border: none; border-radius: 8px; padding: 7px 14px; font-weight: 700; font-size: 13px; cursor: pointer; }
  button.ghost { background: #14171c; color: #9aa0a6; border: 1px solid #232830; }
  button:disabled { opacity: 0.5; cursor: default; }
  label.toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #9aa0a6; }
  .strip { display: flex; flex-wrap: wrap; gap: 10px; background: #14171c; border: 1px solid #232830; border-radius: 12px; padding: 12px 14px; margin-bottom: 16px; align-items: center; }
  .strip .badge { font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge.ok { background: #0e1f12; color: #3fb950; border: 1px solid #2e5a37; }
  .badge.bad { background: #2a1113; color: #ff6b6b; border: 1px solid #5a2226; }
  .strip .stat { font-size: 13px; color: #cbd2d9; }
  .strip .stat b { color: #fff; font-variant-numeric: tabular-nums; }
  .strip .mods { flex-basis: 100%; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #9aa0a6; }
  .strip .mods .m { color: #f6c177; }
  .strip .mods .off { color: #ff8f8f; text-decoration: line-through; }
  h2.tbl { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #f6821f; margin: 18px 0 8px; display: flex; align-items: baseline; gap: 8px; }
  h2.tbl .n { color: #6b7280; font-weight: 600; text-transform: none; letter-spacing: 0; }
  .wrap { overflow-x: auto; border: 1px solid #232830; border-radius: 10px; background: #0e1116; }
  table { border-collapse: collapse; width: 100%; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #1b1f26; white-space: pre; vertical-align: top; }
  th { color: #9aa0a6; font-weight: 700; position: sticky; top: 0; background: #14171c; }
  td { color: #cbd2d9; max-width: 460px; overflow: hidden; text-overflow: ellipsis; }
  td.src { color: #f6c177; cursor: pointer; }
  td.src.open { white-space: pre-wrap; color: #cbd2d9; }
  .empty { color: #6b7280; padding: 10px; font-size: 12px; }
  .console { margin-top: 22px; background: #14171c; border: 1px solid #232830; border-radius: 12px; padding: 14px; }
  .console h3, .reset h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #9aa0a6; margin-bottom: 8px; }
  textarea { width: 100%; min-height: 64px; background: #0e1116; border: 1px solid #232830; border-left: 2px solid #f6821f; border-radius: 8px; padding: 10px 12px; color: #cbd2d9; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
  textarea:focus, input:focus, select:focus { outline: none; border-color: #f6821f; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .err { color: #ff6b6b; font-size: 12px; margin-top: 8px; font-family: ui-monospace, Menlo, monospace; }
  .reset { margin-top: 22px; background: #14171c; border: 1px solid #3a2226; border-radius: 12px; padding: 14px; }
  select, input.confirm { background: #0e1116; border: 1px solid #232830; border-radius: 8px; padding: 7px 10px; color: #e8eaed; font-size: 13px; }
  button.danger { background: #ff6b6b; color: #0b0d10; }
  .note { color: #6b7280; font-size: 11px; margin-top: 8px; }
</style>
</head>
<body>
  <header>
    <h1>liftty<span class="dot">.</span> db <span class="gen" id="gen"></span></h1>
    <div class="controls">
      <label class="toggle"><input type="checkbox" id="auto" /> auto-refresh 5s</label>
      <button class="ghost" id="refresh" type="button">Refresh</button>
    </div>
  </header>

  <div class="strip" id="strip"><span class="stat">Loading…</span></div>
  <div id="tables"></div>

  <div class="console">
    <h3>read-only query · SELECT / PRAGMA only</h3>
    <textarea id="q" placeholder="SELECT id, name, version, enabled FROM plugins"></textarea>
    <div class="row"><button id="run" type="button">Run</button><span class="err" id="qerr"></span></div>
    <div class="wrap" id="qwrap" style="display:none;margin-top:10px"><table id="qtable"></table></div>
  </div>

  <div class="reset">
    <h3>demo reset · destructive</h3>
    <div class="row">
      <select id="profile">
        <option value="pre-demo">pre-demo (clean slate)</option>
        <option value="post-author">post-author (installs auto-regulate)</option>
      </select>
      <input class="confirm" id="confirm" placeholder='type "reset"' autocomplete="off" />
      <button class="danger" id="reset" type="button" disabled>Reset</button>
      <span class="err" id="rerr"></span>
    </div>
    <div class="note">Backs up plugins + events + program before wiping (newest 3 kept). Broadcasts demo_reset to open /flow clients.</div>
  </div>

<script>
  var KEY = new URLSearchParams(location.search).get('key') || '';
  var qs = 'key=' + encodeURIComponent(KEY);
  var stripEl = document.getElementById('strip');
  var tablesEl = document.getElementById('tables');
  var genEl = document.getElementById('gen');
  var autoEl = document.getElementById('auto');
  var autoTimer = null;

  function esc(s) { return String(s).replace(/[<>&]/g, function (c) { return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'; }); }

  function cell(v) {
    if (v === null || v === undefined) return '<span style="color:#6b7280">null</span>';
    if (typeof v === 'object') return esc(JSON.stringify(v));
    return esc(String(v));
  }

  function renderStrip(snap) {
    var plugins = (snap.tables.find(function (t) { return t.name === 'plugins'; }) || { rows: [], rowCount: 0 });
    var sessions = (snap.tables.find(function (t) { return t.name === 'sessions'; }) || { rowCount: 0 });
    var events = (snap.tables.find(function (t) { return t.name === 'plugin_events'; }) || { rowCount: 0 });
    var usage = (snap.tables.find(function (t) { return t.name === 'model_usage'; }) || { rows: [], rowCount: 0 });
    var lastTok = (usage.rows && usage.rows[0]) ? usage.rows[0].total_tokens : null;
    var mods = plugins.rows || [];
    var anyDisabled = false, anyError = false;
    var modHtml = mods.map(function (m) {
      var enabled = m.enabled === 1 || m.enabled === true;
      if (!enabled) anyDisabled = true;
      var lr = m.last_result || '';
      if (typeof lr === 'string' && lr.indexOf('"error"') >= 0) anyError = true;
      var cls = enabled ? 'm' : 'off';
      return '<span class="' + cls + '">' + esc(m.name) + '@v' + esc(m.version) + (enabled ? '' : ' (off)') + '</span>';
    }).join(' · ') || '<span style="color:#6b7280">no modules</span>';
    var bad = anyDisabled || anyError;
    var badge = bad
      ? '<span class="badge bad">needs attention</span>'
      : '<span class="badge ok">clean</span>';
    stripEl.innerHTML =
      badge +
      '<span class="stat">modules <b>' + (plugins.rowCount || 0) + '</b></span>' +
      '<span class="stat">sessions <b>' + (sessions.rowCount || 0) + '</b></span>' +
      '<span class="stat">events buffer <b>' + (events.rowCount || 0) + '</b></span>' +
      '<span class="stat">last coach turn <b>' + (lastTok != null ? lastTok + ' tok' : '—') + '</b></span>' +
      '<span class="mods">' + modHtml + '</span>';
  }

  function renderTable(t) {
    var h = '<h2 class="tbl">' + esc(t.name) + ' <span class="n">' + t.rowCount + ' row' + (t.rowCount === 1 ? '' : 's') + '</span></h2>';
    if (!t.columns || !t.columns.length) {
      return h + '<div class="wrap"><div class="empty">count-only (' + t.rowCount + ' rows)</div></div>';
    }
    if (!t.rows || !t.rows.length) {
      return h + '<div class="wrap"><div class="empty">no rows</div></div>';
    }
    var thead = '<tr>' + t.columns.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>';
    var body = t.rows.map(function (r) {
      return '<tr>' + t.columns.map(function (c) {
        var v = r[c];
        if (t.name === 'plugins' && c === 'source' && v && typeof v === 'object') {
          return '<td class="src" data-full="' + esc(v.full || '') + '">' + esc(v.preview || '') + (v.length > 200 ? ' … (' + v.length + ' chars — click)' : '') + '</td>';
        }
        return '<td>' + cell(v) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return h + '<div class="wrap"><table><thead>' + thead + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  function wireSourceCells() {
    Array.prototype.forEach.call(document.querySelectorAll('td.src'), function (td) {
      td.addEventListener('click', function () {
        if (td.classList.contains('open')) {
          td.classList.remove('open');
          td.textContent = td.getAttribute('data-preview') || td.textContent;
        } else {
          td.setAttribute('data-preview', td.textContent);
          td.textContent = td.getAttribute('data-full') || '';
          td.classList.add('open');
        }
      });
    });
  }

  function load() {
    return fetch('/db.json?' + qs).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (snap) {
      genEl.textContent = 'as of ' + new Date(snap.generatedAt).toLocaleTimeString();
      renderStrip(snap);
      tablesEl.innerHTML = snap.tables.map(renderTable).join('');
      wireSourceCells();
    }).catch(function (e) {
      stripEl.innerHTML = '<span class="badge bad">error</span><span class="stat">' + esc(e.message) + '</span>';
    });
  }

  document.getElementById('refresh').addEventListener('click', load);
  autoEl.addEventListener('change', function () {
    if (autoEl.checked) { autoTimer = setInterval(load, 5000); } else { clearInterval(autoTimer); autoTimer = null; }
  });

  // read-only query console
  document.getElementById('run').addEventListener('click', function () {
    var q = document.getElementById('q').value;
    var errEl = document.getElementById('qerr');
    var wrap = document.getElementById('qwrap');
    var table = document.getElementById('qtable');
    errEl.textContent = '';
    fetch('/db.json?' + qs, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.error) { errEl.textContent = res.error; wrap.style.display = 'none'; return; }
        var rows = res.rows || [];
        if (!rows.length) { table.innerHTML = ''; wrap.style.display = 'block'; table.innerHTML = '<tr><td class="empty">0 rows</td></tr>'; return; }
        var cols = Object.keys(rows[0]);
        var thead = '<tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>';
        var body = rows.map(function (r) { return '<tr>' + cols.map(function (c) { return '<td>' + cell(r[c]) + '</td>'; }).join('') + '</tr>'; }).join('');
        table.innerHTML = '<thead>' + thead + '</thead><tbody>' + body + '</tbody>';
        wrap.style.display = 'block';
      })
      .catch(function (e) { errEl.textContent = e.message; });
  });

  // demo reset (type-to-confirm)
  var confirmEl = document.getElementById('confirm');
  var resetBtn = document.getElementById('reset');
  confirmEl.addEventListener('input', function () { resetBtn.disabled = confirmEl.value.trim() !== 'reset'; });
  resetBtn.addEventListener('click', function () {
    var profile = document.getElementById('profile').value;
    var rerr = document.getElementById('rerr');
    rerr.textContent = '';
    resetBtn.disabled = true;
    fetch('/reset-demo?' + qs + '&profile=' + encodeURIComponent(profile), { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) { rerr.textContent = res.error || 'reset failed'; return; }
        confirmEl.value = '';
        rerr.textContent = 'reset ok · ' + JSON.stringify(res.report);
        load();
      })
      .catch(function (e) { rerr.textContent = e.message; })
      .finally(function () { resetBtn.disabled = confirmEl.value.trim() !== 'reset'; });
  });

  load();
</script>
</body>
</html>`;
}

/** The rendered /db page (static string; the DO is queried client-side via /db.json). */
export const DB_HTML = renderDb();
