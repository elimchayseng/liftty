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
 * FLOW-LIVE-EVENTS redesign: the prescribed-lift rows now re-render on every `cf_agent_state`, so a
 * policy that adjusts a weight (setExerciseWeight / deload) is VISIBLE — the number changes live and
 * the row flashes. Weight is the primary value in the layout (prescribed, worked, and any policy
 * delta), and each lift shows logged-vs-target set progress. The receipts strip still proves the
 * thesis: a persistent, model-authored policy running on a WS event with no inference.
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

  /* --- lift row: weight-forward layout --- */
  .lift { display: grid; grid-template-columns: 1fr auto; column-gap: 12px; row-gap: 2px; align-items: center; padding: 12px 2px; border-top: 1px solid #232830; border-radius: 10px; }
  .lift:first-of-type { border-top: none; }
  .lift .name { grid-column: 1; font-weight: 600; }
  .lift .rx { grid-column: 1; color: #9aa0a6; font-size: 12px; font-variant-numeric: tabular-nums; }
  .lift .rx .wt { color: #f6c177; font-weight: 700; font-size: 13px; }
  .lift .rx .delta { color: #3fb950; font-weight: 700; margin-left: 6px; }
  .lift .prog { grid-column: 1; font-size: 11px; color: #6b7280; font-variant-numeric: tabular-nums; }
  .lift .prog.met { color: #3fb950; }
  .lift .ctl { grid-column: 2; grid-row: 1 / span 3; display: flex; align-items: center; gap: 6px; }
  .lift input { width: 52px; background: #0e1116; border: 1px solid #232830; border-radius: 8px; padding: 8px; color: #e8eaed; font-size: 15px; text-align: center; font-variant-numeric: tabular-nums; }
  .lift input.wt { border-color: #3a2f18; color: #f6c177; font-weight: 700; }
  .lift input:focus { outline: none; border-color: #f6821f; }
  .lift .x { color: #6b7280; font-size: 12px; }
  .lift button { background: #f6821f; color: #0b0d10; border: none; border-radius: 8px; padding: 8px 12px; font-weight: 700; font-size: 13px; }
  .lift button.fail { background: #14171c; color: #ff8f8f; border: 1px solid #3a2226; padding: 8px 10px; }
  .lift button.fail.on { background: #ff6b6b; color: #0b0d10; border-color: #ff6b6b; }
  .lift button:disabled { opacity: 0.5; }
  /* policy adjusted a weight on this row */
  .lift.changed { animation: pf_flash 1.6s ease; }
  @keyframes pf_flash {
    0% { background: #241a2f; box-shadow: inset 0 0 0 1px #7c5cff88; }
    100% { background: transparent; box-shadow: inset 0 0 0 1px transparent; }
  }

  .card { background: #14171c; border: 1px solid #232830; border-radius: 14px; padding: 14px 16px; margin-bottom: 14px; }
  .card.today { border-color: #f6821f; box-shadow: 0 0 0 1px #f6821f33; }
  h2.section { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0a6; margin: 10px 0 10px; }
  #logged .row { display: grid; grid-template-columns: 1fr auto; align-items: baseline; gap: 10px; font-size: 14px; padding: 8px 0; border-top: 1px solid #232830; }
  #logged .row:first-child { border-top: none; }
  #logged .row .lbl { color: #cbd2d9; }
  #logged .row .lbl .n { color: #6b7280; font-variant-numeric: tabular-nums; }
  #logged .row .val { font-variant-numeric: tabular-nums; white-space: nowrap; }
  #logged .row .val .reps { color: #9aa0a6; }
  #logged .row .val b { color: #fff; }
  #logged .row .val .lb { color: #6b7280; font-weight: 400; font-size: 12px; }
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

  // Session view state, so we can re-render prescriptions live when a policy edits the program.
  var currentFocus = null;         // today's day focus, e.g. "Front Squat"
  var lastWeights = {};            // exercise -> last-seen prescribed weight (change detection + flash)
  var haveBaseline = false;        // suppress the flash on the very first render
  var progRefs = [];               // [{exercise, sets, el}] so set-progress updates without a full re-render

  function setConn(state) {
    led.className = 'led ' + (state === 'open' ? 'on' : state === 'closed' ? 'off' : '');
    connlbl.textContent = state === 'open' ? 'live' : state === 'closed' ? 'disconnected' : 'connecting…';
  }

  // Count how many sets have been logged for a given exercise in the active session.
  function loggedCount(active, exercise) {
    var n = 0, sets = active && active.loggedSets ? active.loggedSets : [];
    for (var i = 0; i < sets.length; i++) if (sets[i].exercise === exercise) n++;
    return n;
  }

  // Resolve today's prescribed lifts from a full state broadcast (find the day by focus).
  function liftsFromState(state) {
    if (!state || !state.program || !state.program.days) return null;
    var focus = (state.activeSession && state.activeSession.day) || currentFocus;
    var days = state.program.days;
    for (var i = 0; i < days.length; i++) if (days[i].focus === focus) return days[i].lifts;
    return null;
  }

  // Refresh only the per-lift "logged N / M sets" line — no full re-render, so inputs the lifter is
  // mid-typing (reps/weight, fail toggle) are never clobbered on a routine logged-set broadcast.
  function updateProgress(active) {
    for (var i = 0; i < progRefs.length; i++) {
      var ref = progRefs[i];
      var done = loggedCount(active, ref.exercise);
      ref.el.textContent = 'logged ' + done + ' / ' + ref.sets + ' sets';
      ref.el.className = 'prog' + (done >= ref.sets ? ' met' : '');
    }
  }

  function renderLifts(lifts, active) {
    liftsEl.innerHTML = '';
    progRefs = [];
    if (!lifts || !lifts.length) { liftsEl.innerHTML = '<div class="muted">No prescribed lifts.</div>'; return; }
    lifts.forEach(function (l) {
      if (l.kind === 'rounds') return; // circuits aren't set-logged here
      var w = (l.weight != null ? l.weight : null);
      var prev = lastWeights.hasOwnProperty(l.exercise) ? lastWeights[l.exercise] : undefined;
      var changed = haveBaseline && prev !== undefined && prev !== w;

      var row = document.createElement('div');
      row.className = 'lift' + (changed ? ' changed' : '');

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = l.exercise;

      var rx = document.createElement('span');
      rx.className = 'rx';
      // "4 × 8 @ 125 lb"  (+ "→ was 130" delta chip when a policy just changed it)
      var rxHtml = l.sets + ' × ' + l.reps;
      if (w != null) rxHtml += ' @ <span class="wt">' + w + ' lb' + (l.perSide ? ' /side' : '') + '</span>';
      else rxHtml += ' @ <span class="wt">BW</span>';
      if (changed) rxHtml += '<span class="delta">' + (w > prev ? '▲' : '▼') + ' was ' + prev + '</span>';
      rx.innerHTML = rxHtml;

      var done = loggedCount(active, l.exercise);
      var prog = document.createElement('span');
      prog.className = 'prog' + (done >= l.sets ? ' met' : '');
      prog.textContent = 'logged ' + done + ' / ' + l.sets + ' sets';

      var ctl = document.createElement('span');
      ctl.className = 'ctl';
      var reps = document.createElement('input');
      reps.type = 'number'; reps.value = l.reps; reps.min = '1'; reps.setAttribute('aria-label', 'reps');
      var xspan = document.createElement('span'); xspan.className = 'x'; xspan.textContent = '×';
      var wt = document.createElement('input');
      wt.className = 'wt';
      wt.type = 'number'; wt.value = (w != null ? w : ''); wt.placeholder = 'BW'; wt.setAttribute('aria-label', 'weight');
      var fail = document.createElement('button');
      fail.type = 'button'; fail.className = 'fail'; fail.textContent = 'fail';
      var failed = false;
      fail.addEventListener('click', function () { failed = !failed; fail.classList.toggle('on', failed); });
      var logBtn = document.createElement('button');
      logBtn.type = 'button'; logBtn.textContent = 'log';
      logBtn.addEventListener('click', function () {
        var r = parseInt(reps.value, 10);
        if (!r || r < 1) return;
        var wv = wt.value === '' ? null : parseFloat(wt.value);
        var payload = { type: 'log_set', exercise: l.exercise, reps: r, failed: failed };
        if (wv != null && !isNaN(wv)) payload.weight = wv;
        send(payload);
        failed = false; fail.classList.remove('on');
      });

      ctl.appendChild(reps); ctl.appendChild(xspan); ctl.appendChild(wt); ctl.appendChild(fail); ctl.appendChild(logBtn);
      row.appendChild(name); row.appendChild(rx); row.appendChild(prog); row.appendChild(ctl);
      liftsEl.appendChild(row);

      progRefs.push({ exercise: l.exercise, sets: l.sets, el: prog });
      lastWeights[l.exercise] = w;
    });
    haveBaseline = true;
  }

  // True if any prescribed weight differs from what we last rendered (i.e. a policy edited the program).
  function weightsChanged(lifts) {
    if (!lifts) return false;
    for (var i = 0; i < lifts.length; i++) {
      var l = lifts[i];
      if (l.kind === 'rounds') continue;
      var w = (l.weight != null ? l.weight : null);
      if (lastWeights.hasOwnProperty(l.exercise) && lastWeights[l.exercise] !== w) return true;
    }
    return false;
  }

  function renderLogged(active) {
    var sets = active && active.loggedSets ? active.loggedSets : [];
    if (!sets.length) { loggedEl.innerHTML = '<div class="muted">No sets logged yet.</div>'; return; }
    loggedEl.innerHTML = '';
    sets.forEach(function (s, i) {
      var row = document.createElement('div');
      row.className = 'row';
      var left = document.createElement('span');
      left.className = 'lbl';
      left.innerHTML = '<span class="n">' + (i + 1) + '.</span> ' + esc(s.exercise);
      var right = document.createElement('span');
      right.className = 'val';
      right.innerHTML = '<span class="reps">' + s.reps + ' reps</span> · <b>' +
        (s.weight ? s.weight : 'BW') + '</b>' + (s.weight ? '<span class="lb"> lb</span>' : '');
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
        currentFocus = msg.day || null;
        focusEl.textContent = msg.day || 'Session';
        daylabelEl.textContent = msg.dayLabel || '';
        renderLifts(msg.lifts, msg.activeSession);   // seeds lastWeights (no flash on first paint)
        renderLogged(msg.activeSession);
        break;
      case 'cf_agent_state':
        // The SDK re-broadcasts full state on every setState — including a policy's program edit.
        // Re-render prescriptions ONLY when a weight actually changed (so we don't reset inputs the
        // lifter is mid-typing); always refresh the logged list + per-lift progress.
        if (msg.state) {
          var lifts = liftsFromState(msg.state);
          if (lifts && weightsChanged(lifts)) renderLifts(lifts, msg.state.activeSession);
          updateProgress(msg.state.activeSession);   // always: cheap, never resets inputs
          renderLogged(msg.state.activeSession);
        }
        break;
      case 'set_logged':
        addReceipt('logged <b>' + esc(msg.exercise) + '</b> ' + msg.reps + (msg.weight != null ? ' @ ' + msg.weight + ' lb' : '') + (msg.failed ? ' <span style="color:#ff8f8f">(failed)</span>' : ''), false);
        break;
      case 'rest_started':
        startRest(msg.seconds);
        break;
      case 'rest_over':
        restDone();
        break;
      case 'plugin_fired':
        var changed = msg.changed && msg.changed.length ? ' · adjusted ' + msg.changed.map(esc).join(', ') : ' · no change';
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
