/**
 * Server-rendered /session — the live workout stage (M4). Mirrors the /chat aesthetic.
 *
 * Opens a RAW WebSocket to wss://<host>/agents/liftty-agent/me (the routeAgentRequest fallthrough
 * in server.ts routes it into the LifttyAgent DO). No framework, no agents/client — a plain socket,
 * so the demo shows the primitive.
 *
 * Protocol (all JSON):
 *   client → server:  { type:"log_set", exercise, reps, weight?, failed?, rest? }
 *   server → client:  { type:"session_hello", day, dayLabel, lifts, activeSession }   (on connect)
 *                     { type:"cf_agent_state", state }   (SDK auto-broadcast on every setState)
 *                     { type:"set_logged", exercise, reps, weight, activeSets, message }
 *                     { type:"rest_started", exercise, seconds }
 *                     { type:"rest_over", exercise }
 *                     { type:"plugin_fired", name, ms, cold, changed }   (M5 receipt)
 *                     { type:"error", message }
 *
 * The receipts strip renders plugin_fired as "auto-regulate fired · 4 ms · 0 tokens" — the thesis
 * in one UI element: a persistent, model-authored policy running on a WS event with no inference.
 */
export function renderSession(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>liftty · session</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b0d10; color: #e8eaed;
    display: flex; flex-direction: column;
    max-width: 640px; margin: 0 auto;
    padding: max(12px, env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom));
  }
  header { display: flex; align-items: baseline; gap: 10px; padding: 4px 4px 12px; }
  header h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; }
  header .dot { color: #f6821f; }
  header .conn { margin-left: auto; font-size: 12px; color: #9aa0a6; display: flex; align-items: center; gap: 6px; }
  header .conn .led { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; }
  header .conn .led.on { background: #3fb950; }
  header .conn .led.off { background: #ff6b6b; }
  header a { color: #9aa0a6; font-size: 14px; text-decoration: none; margin-left: 10px; }
  .eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; font-weight: 700; color: #f6821f; margin-bottom: 4px; }
  .day-focus { font-size: 22px; font-weight: 700; }
  .day-label { color: #9aa0a6; font-size: 13px; margin-bottom: 6px; }
  #rest { display: none; background: #1c1408; border: 1px solid #7a5a1e; border-radius: 12px; padding: 12px 14px; margin: 8px 0 14px; color: #f0d9a8; font-size: 14px; align-items: center; gap: 10px; }
  #rest.on { display: flex; }
  #rest.done { background: #0e1f12; border-color: #2e5a37; color: #a8f0bb; }
  #rest .num { font-variant-numeric: tabular-nums; font-size: 20px; font-weight: 800; color: #f6b545; }
  #rest.done .num { color: #3fb950; }
  .lift { display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; align-items: center; padding: 12px 0; border-top: 1px solid #232830; }
  .lift:first-of-type { border-top: none; }
  .lift .name { font-weight: 600; }
  .lift .rx { grid-column: 1; color: #9aa0a6; font-size: 12px; font-variant-numeric: tabular-nums; }
  .lift .ctl { grid-column: 2; grid-row: 1 / span 2; display: flex; align-items: center; gap: 6px; }
  .lift input { width: 52px; background: #0e1116; border: 1px solid #232830; border-radius: 8px; padding: 8px; color: #e8eaed; font-size: 15px; text-align: center; font-variant-numeric: tabular-nums; }
  .lift input:focus { outline: none; border-color: #f6821f; }
  .lift .x { color: #6b7280; font-size: 12px; }
  .lift button { background: #f6821f; color: #0b0d10; border: none; border-radius: 8px; padding: 8px 12px; font-weight: 700; font-size: 13px; }
  .lift button.fail { background: #14171c; color: #ff8f8f; border: 1px solid #3a2226; padding: 8px 10px; }
  .lift button.fail.on { background: #ff6b6b; color: #0b0d10; border-color: #ff6b6b; }
  .lift button:disabled { opacity: 0.5; }
  .card { background: #14171c; border: 1px solid #232830; border-radius: 14px; padding: 14px 16px; margin-bottom: 14px; }
  .card.today { border-color: #f6821f; box-shadow: 0 0 0 1px #f6821f33; }
  h2.section { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0a6; margin: 10px 0 10px; }
  #logged .row { display: flex; justify-content: space-between; font-size: 14px; padding: 8px 0; border-top: 1px solid #232830; }
  #logged .row:first-child { border-top: none; }
  #logged .row b { color: #fff; }
  .muted { color: #9aa0a6; font-size: 14px; }
  #receipts { display: flex; flex-direction: column; gap: 6px; }
  .receipt { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd2d9; background: #0e1116; border: 1px solid #232830; border-left: 2px solid #3fb950; border-radius: 8px; padding: 8px 10px; }
  .receipt.plugin { border-left-color: #f6821f; color: #f6c177; }
  .receipt b { color: #fff; }
  .err { color: #ff6b6b; font-size: 13px; padding: 6px 4px; }
</style>
</head>
<body>
  <header>
    <h1>liftty<span class="dot">.</span> session</h1>
    <span class="conn"><span class="led" id="led"></span><span id="connlbl">connecting…</span></span>
    <a href="/plan">plan →</a>
  </header>

  <div class="card today">
    <div class="eyebrow">Today</div>
    <div class="day-focus" id="focus">—</div>
    <div class="day-label" id="daylabel"></div>
  </div>

  <div id="rest">
    <span id="restlbl">Rest</span>
    <span class="num" id="restnum">0</span>
    <span>s</span>
  </div>

  <div class="card" id="lifts"><div class="muted">Loading today's session…</div></div>

  <h2 class="section">Logged this session</h2>
  <div class="card" id="logged"><div class="muted">No sets logged yet.</div></div>

  <h2 class="section">Receipts <span class="muted">— every set on the data plane, no tokens</span></h2>
  <div id="receipts"><div class="muted">Log a set to see receipts.</div></div>

<script>
  var host = location.host;
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var URL = proto + '//' + host + '/agents/liftty-agent/me';

  var led = document.getElementById('led');
  var connlbl = document.getElementById('connlbl');
  var focusEl = document.getElementById('focus');
  var daylabelEl = document.getElementById('daylabel');
  var liftsEl = document.getElementById('lifts');
  var loggedEl = document.getElementById('logged');
  var receiptsEl = document.getElementById('receipts');
  var restEl = document.getElementById('rest');
  var restNum = document.getElementById('restnum');
  var restLbl = document.getElementById('restlbl');

  var ws = null;
  var restTimer = null;
  var receiptCount = 0;

  function setConn(state) {
    led.className = 'led ' + (state === 'open' ? 'on' : state === 'closed' ? 'off' : '');
    connlbl.textContent = state === 'open' ? 'live' : state === 'closed' ? 'disconnected' : 'connecting…';
  }

  function renderLifts(day, lifts) {
    focusEl.textContent = day || 'Session';
    daylabelEl.textContent = '';
    liftsEl.innerHTML = '';
    if (!lifts || !lifts.length) { liftsEl.innerHTML = '<div class="muted">No prescribed lifts.</div>'; return; }
    lifts.forEach(function (l) {
      if (l.kind === 'rounds') return; // circuits aren't set-logged here
      var row = document.createElement('div');
      row.className = 'lift';

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = l.exercise;

      var rx = document.createElement('span');
      rx.className = 'rx';
      rx.textContent = l.sets + '×' + l.reps + (l.weight != null ? ' @ ' + l.weight + (l.perSide ? ' /side' : '') : '');

      var ctl = document.createElement('span');
      ctl.className = 'ctl';
      var reps = document.createElement('input');
      reps.type = 'number'; reps.value = l.reps; reps.min = '1'; reps.setAttribute('aria-label', 'reps');
      var xspan = document.createElement('span'); xspan.className = 'x'; xspan.textContent = '×';
      var wt = document.createElement('input');
      wt.type = 'number'; wt.value = (l.weight != null ? l.weight : ''); wt.placeholder = 'BW'; wt.setAttribute('aria-label', 'weight');
      var fail = document.createElement('button');
      fail.type = 'button'; fail.className = 'fail'; fail.textContent = 'fail';
      var failed = false;
      fail.addEventListener('click', function () { failed = !failed; fail.classList.toggle('on', failed); });
      var log = document.createElement('button');
      log.type = 'button'; log.textContent = 'log';
      log.addEventListener('click', function () {
        var r = parseInt(reps.value, 10);
        if (!r || r < 1) return;
        var wv = wt.value === '' ? null : parseFloat(wt.value);
        var payload = { type: 'log_set', exercise: l.exercise, reps: r, failed: failed };
        if (wv != null && !isNaN(wv)) payload.weight = wv;
        send(payload);
        failed = false; fail.classList.remove('on');
      });

      ctl.appendChild(reps); ctl.appendChild(xspan); ctl.appendChild(wt); ctl.appendChild(fail); ctl.appendChild(log);
      row.appendChild(name); row.appendChild(rx); row.appendChild(ctl);
      liftsEl.appendChild(row);
    });
  }

  function renderLogged(active) {
    var sets = active && active.loggedSets ? active.loggedSets : [];
    if (!sets.length) { loggedEl.innerHTML = '<div class="muted">No sets logged yet.</div>'; return; }
    loggedEl.innerHTML = '';
    sets.forEach(function (s, i) {
      var row = document.createElement('div');
      row.className = 'row';
      var left = document.createElement('span');
      left.textContent = (i + 1) + '. ' + s.exercise;
      var right = document.createElement('span');
      right.innerHTML = s.reps + ' × <b>' + (s.weight ? s.weight + ' lb' : 'BW') + '</b>';
      row.appendChild(left); row.appendChild(right);
      loggedEl.appendChild(row);
    });
  }

  function addReceipt(text, isPlugin) {
    if (receiptCount === 0) receiptsEl.innerHTML = '';
    receiptCount++;
    var d = document.createElement('div');
    d.className = 'receipt' + (isPlugin ? ' plugin' : '');
    d.innerHTML = text;
    receiptsEl.insertBefore(d, receiptsEl.firstChild);
  }

  function addErr(text) {
    var d = document.createElement('div');
    d.className = 'err';
    d.textContent = 'Error: ' + text;
    receiptsEl.insertBefore(d, receiptsEl.firstChild);
  }

  function startRest(seconds) {
    if (restTimer) clearInterval(restTimer);
    var left = seconds;
    restEl.className = 'on';
    restLbl.textContent = 'Rest';
    restNum.textContent = left;
    restTimer = setInterval(function () {
      left--;
      restNum.textContent = left > 0 ? left : 0;
      if (left <= 0) { clearInterval(restTimer); restTimer = null; }
    }, 1000);
  }

  function restDone() {
    if (restTimer) { clearInterval(restTimer); restTimer = null; }
    restEl.className = 'on done';
    restLbl.textContent = 'Rest over —';
    restNum.textContent = 'go';
    setTimeout(function () { restEl.className = ''; }, 4000);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function handle(msg) {
    switch (msg.type) {
      case 'session_hello':
        renderLifts(msg.day, msg.lifts);
        if (msg.dayLabel) daylabelEl.textContent = msg.dayLabel;
        renderLogged(msg.activeSession);
        break;
      case 'cf_agent_state':
        if (msg.state && msg.state.activeSession) renderLogged(msg.state.activeSession);
        break;
      case 'set_logged':
        addReceipt('logged <b>' + esc(msg.exercise) + '</b> ' + msg.reps + (msg.weight != null ? ' @ ' + msg.weight : '') + (msg.failed ? ' <span style="color:#ff8f8f">(failed)</span>' : ''), false);
        break;
      case 'rest_started':
        startRest(msg.seconds);
        break;
      case 'rest_over':
        restDone();
        break;
      case 'plugin_fired':
        var changed = msg.changed && msg.changed.length ? ' · ' + msg.changed.map(esc).join(', ') : ' · no change';
        addReceipt('<b>' + esc(msg.name) + '</b> fired · ' + msg.ms + ' ms · ' + (msg.cold ? 'cold' : 'warm') + ' · <b>0 tokens</b>' + changed, true);
        break;
      case 'error':
        addErr(msg.message || 'unknown');
        break;
    }
  }

  function esc(s) { return String(s).replace(/[<>&]/g, function (c) { return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'; }); }

  function connect() {
    setConn('connecting');
    ws = new WebSocket(URL);
    ws.addEventListener('open', function () { setConn('open'); });
    ws.addEventListener('close', function () { setConn('closed'); setTimeout(connect, 2000); });
    ws.addEventListener('error', function () { setConn('closed'); });
    ws.addEventListener('message', function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      handle(msg);
    });
  }
  connect();
</script>
</body>
</html>`;
}
