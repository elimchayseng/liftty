import { renderHead, renderHeader } from "./shared";

/**
 * Server-rendered /session — the live workout stage (M4), design-refresh reskin.
 *
 * Opens a RAW WebSocket to wss://<host>/agents/liftty-agent/me. Protocol (all JSON):
 *   client → server:  { type:"log_set", exercise, reps, weight?, failed?, rest? }
 *                     { type:"set_rest", seconds }                    (NEW — configurable rest default)
 *                     { type:"set_scheme", exercise, sets?, reps? }   (NEW — editable sets×reps chips)
 *                     { type:"session_complete" }                     (NEW — Finish button → persist history)
 *   server → client:  { type:"session_hello", day, lifts, activeSession, restSeconds }
 *                     { type:"cf_agent_state", state }
 *                     { type:"set_logged", … } { type:"rest_started", exercise, seconds }
 *                     { type:"rest_over", exercise } { type:"plugin_fired", … } { type:"error", message }
 *                     { type:"session_finalized", id, day, week, sets, summary }  (NEW — broadcast on save)
 *                     { type:"session_complete_result", ok, … }                    (NEW — Finish ack)
 *
 * Weight is the loudest thing on the page (56px Archivo). Prescribed sets×reps are editable chips that
 * persist via set_scheme; the rest default is an editable chip that persists via set_rest. Prescribed
 * rows re-render on every cf_agent_state ONLY when a weight/scheme actually changed, and flash orange —
 * so a policy that adjusts a weight is visible. The receipts strip proves the zero-token data plane.
 */
export function renderSession(): string {
	const css = `
  html, body { height: 100%; }
  .stage { padding: 20px; padding-bottom: calc(20px + env(safe-area-inset-bottom)); }

  /* live indicator (square, per spec) */
  .conn { display: flex; align-items: center; gap: 8px; font-family: var(--ui); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
  .conn .sq { width: 7px; height: 7px; display: inline-block; background: var(--faint); }
  .conn.on { color: var(--live); } .conn.on .sq { background: var(--live); }
  .conn.off { color: #ff6b6b; } .conn.off .sq { background: #ff6b6b; }

  .eyebrow { font-family: var(--ui); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--accent); margin-bottom: 6px; }
  .focus { font-family: var(--display); font-size: 34px; font-weight: 900; letter-spacing: -0.02em; line-height: 1; }

  /* rest timer row */
  #rest { border: 1px dashed var(--line-dash); margin-top: 20px; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; font-family: var(--ui); color: var(--faint); font-size: 13px; }
  #rest .right { display: flex; align-items: center; gap: 8px; }
  #rest #rest-run { display: none; }
  #rest.on #rest-idle { display: none; }
  #rest.on #rest-run { display: flex; }
  #restchip { width: 56px; border: 1px solid var(--line-strong); padding: 5px 8px; background: transparent; color: var(--ink); font-family: var(--ui); font-size: 17px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield; }
  #restchip::-webkit-outer-spin-button, #restchip::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  #restchip:focus { outline: none; border-color: var(--accent); }
  .resthint { font-size: 11px; color: var(--faint); }
  #restnum { font-size: 20px; font-weight: 800; color: var(--marker); font-variant-numeric: tabular-nums; }
  #rest.done #restnum { color: var(--live); }

  /* lift row — weight-forward */
  .lift { border-top: 1px solid var(--line); padding: 20px 0; }
  .lift:first-child { border-top: none; }
  /* policy-changed flash: an inset orange ring (via outline, not box-shadow) + tint, per HANDOFF §4.4 */
  .lift.changed { animation: pf_flash 1.6s ease; }
  @keyframes pf_flash {
    0% { background: rgba(246,130,31,0.05); outline: 1px solid rgba(246,130,31,0.5); outline-offset: -1px; }
    100% { background: transparent; outline: 1px solid rgba(246,130,31,0); outline-offset: -1px; }
  }
  .lift .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .lift .lname { font-family: var(--ui); font-size: 13px; color: var(--sub); letter-spacing: 0.08em; text-transform: uppercase; }
  .lift .chips { display: flex; align-items: center; gap: 7px; font-family: var(--ui); }
  .lift .chip { width: 40px; border: 1px solid var(--line-strong); padding: 5px 8px; background: transparent; color: var(--ink); font-family: var(--ui); font-size: 17px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield; }
  .lift .chip::-webkit-outer-spin-button, .lift .chip::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .lift .chip:focus { outline: none; border-color: var(--accent); }
  .lift .cx { color: var(--faint); font-size: 14px; }
  .lift .chint { font-size: 10px; color: var(--faint); margin-left: 2px; }
  .lift .mid { display: flex; align-items: flex-end; justify-content: space-between; margin-top: 12px; }
  .lift .weight { display: flex; align-items: baseline; gap: 6px; }
  .lift .weight .big { font-family: var(--display); font-size: 56px; font-weight: 900; letter-spacing: -0.03em; line-height: 0.85; }
  .lift .weight .lb { font-family: var(--ui); font-size: 13px; color: var(--faint); }
  .lift .note { font-family: var(--ui); font-size: 11px; color: var(--faint); margin-top: 4px; }
  .lift .delta { font-family: var(--ui); font-size: 11px; color: var(--accent); margin-left: 8px; align-self: center; font-variant-numeric: tabular-nums; }
  .lift .prog { text-align: right; font-family: var(--ui); font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .lift .prog.met { color: var(--live); }
  .lift .ctl { display: flex; gap: 8px; margin-top: 16px; align-items: stretch; }
  .lift .field { flex: 1; border: 1px solid var(--line-strong); padding: 0 10px; display: flex; align-items: center; justify-content: center; gap: 6px; font-family: var(--ui); }
  .lift .field input { width: 100%; min-width: 0; background: transparent; border: none; color: var(--ink); font-family: var(--ui); font-size: 16px; text-align: center; padding: 12px 0; font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield; }
  .lift .field input:focus { outline: none; }
  .lift .field input::-webkit-outer-spin-button, .lift .field input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .lift .field .u { color: var(--faint); font-size: 12px; }
  .lift .field.wt { border-color: #3a2f18; }
  .lift .field.wt input { color: var(--marker); font-weight: 600; }
  .lift .fail { border: 1px solid var(--line-strong); background: transparent; color: var(--sub); font-family: var(--ui); font-size: 12px; padding: 0 14px; cursor: pointer; }
  .lift .fail.on { background: #ff6b6b; color: var(--bg); border-color: #ff6b6b; }
  .lift .log { border: none; background: var(--marker); color: var(--bg); font-family: var(--display); font-weight: 800; font-size: 13px; padding: 0 18px; cursor: pointer; }

  .slabel { font-family: var(--ui); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--faint); margin: 24px 0 12px; }
  #receipts { display: flex; flex-direction: column; gap: 8px; }
  .receipt { border-left: 2px solid var(--live); padding: 8px 12px; font-family: var(--mono); font-size: 11px; color: var(--sub); background: rgba(255,255,255,0.02); }
  .receipt b, .receipt .ink { color: var(--ink); }
  .receipt.plugin { border-left-color: var(--accent); color: var(--marker); }
  .err { font-family: var(--ui); color: #ff6b6b; font-size: 12px; padding: 6px 2px; }
  .empty { font-family: var(--ui); font-size: 12px; color: var(--faint); }

  /* finish: persist the live workout into permanent history (getHistory + plugins then see it) */
  #finish { width: 100%; margin-top: 28px; border: 1px solid var(--line-strong); background: transparent; color: var(--sub); font-family: var(--display); font-weight: 800; font-size: 13px; letter-spacing: 0.08em; padding: 16px; cursor: pointer; }
  #finish:hover { border-color: var(--accent); color: var(--ink); }
  #finish:disabled { opacity: 0.4; cursor: default; }`;

	const live = `<span class="conn" id="conn"><span class="sq"></span><span id="connlbl">connecting</span></span>`;

	return `${renderHead("session", css)}
<body>
  ${renderHeader("session", live)}
  <div class="stage">
    <div class="eyebrow">today</div>
    <div class="focus" id="focus">—</div>

    <div id="rest">
      <span id="restlbl">rest timer</span>
      <div class="right" id="rest-idle">
        <input id="restchip" type="number" min="5" max="600" step="5" value="60" aria-label="default rest seconds" />
        <span class="resthint">s · default</span>
      </div>
      <div class="right" id="rest-run"><span id="restnum">0</span><span class="resthint">s</span></div>
    </div>

    <div id="lifts"><div class="empty">Loading today's session…</div></div>

    <div class="slabel">receipts</div>
    <div id="receipts"><div class="empty">Log a set to see receipts.</div></div>

    <button id="finish" type="button">FINISH SESSION</button>
  </div>

<script>
  var host = location.host;
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var URL = proto + '//' + host + '/agents/liftty-agent/me';

  var conn = document.getElementById('conn');
  var connlbl = document.getElementById('connlbl');
  var focusEl = document.getElementById('focus');
  var liftsEl = document.getElementById('lifts');
  var receiptsEl = document.getElementById('receipts');
  var restEl = document.getElementById('rest');
  var restNum = document.getElementById('restnum');
  var restLbl = document.getElementById('restlbl');
  var restChip = document.getElementById('restchip');
  var finishEl = document.getElementById('finish');

  var ws = null;
  var restTimer = null;
  var restDoneTimer = null;
  var receiptCount = 0;

  // Session view state, so we can re-render prescriptions live when a policy edits the program.
  var currentFocus = null;         // today's day focus, e.g. "Front Squat"
  var lastWeights = {};            // exercise -> last-seen prescribed weight (change detection + flash)
  var lastScheme = {};             // exercise -> last-seen "sets x reps" (scheme change detection + flash)
  var haveBaseline = false;        // suppress the flash on the very first render
  var progRefs = [];               // [{exercise, sets, el}] so set-progress updates without a full re-render
  var latestState = null;          // newest full state broadcast (source for a deferred re-render)
  var pendingRerender = false;     // a prescription change arrived while the lifter was mid-edit — flush on blur

  // A full renderLifts() rebuilds every row (innerHTML), which would steal focus and wipe an in-progress
  // value if it ran while the lifter is typing in a chip/field. True when the focus is inside a lift row.
  function isEditingLifts() { return liftsEl.contains(document.activeElement); }

  function setConn(state) {
    conn.className = 'conn' + (state === 'open' ? ' on' : state === 'closed' ? ' off' : '');
    connlbl.textContent = state === 'open' ? 'live' : state === 'closed' ? 'disconnected' : 'connecting';
  }

  // When focus leaves the lift area entirely, flush any re-render we deferred to protect an in-progress
  // edit. The setTimeout(0) lets activeElement settle first, so tabbing between chips in the same area
  // (still editing) keeps waiting rather than rebuilding under the lifter's fingers.
  liftsEl.addEventListener('focusout', function () {
    setTimeout(function () {
      if (!pendingRerender || isEditingLifts()) return;
      pendingRerender = false;
      var lifts = latestState ? liftsFromState(latestState) : null;
      if (lifts) renderLifts(lifts, latestState.activeSession);
      updateProgress(latestState ? latestState.activeSession : null);
    }, 0);
  });

  // Finish the workout: persist the active session into permanent history. Server acks with
  // session_complete_result (and broadcasts session_finalized on success). Briefly disabled to avoid
  // a double-tap saving twice; re-enabled once the server responds.
  finishEl.addEventListener('click', function () {
    finishEl.disabled = true;
    send({ type: 'session_complete' });
  });

  // The editable rest-default chip persists via a set_rest frame; the next logged set rests this long.
  restChip.addEventListener('change', function () {
    var s = parseInt(restChip.value, 10);
    if (!s || s < 5) s = 60;
    s = Math.min(600, Math.max(5, s));
    restChip.value = s;
    send({ type: 'set_rest', seconds: s });
  });

  function loggedCount(active, exercise) {
    var n = 0, sets = active && active.loggedSets ? active.loggedSets : [];
    for (var i = 0; i < sets.length; i++) if (sets[i].exercise === exercise) n++;
    return n;
  }

  function liftsFromState(state) {
    if (!state || !state.program || !state.program.days) return null;
    var focus = (state.activeSession && state.activeSession.day) || currentFocus;
    var days = state.program.days;
    for (var i = 0; i < days.length; i++) if (days[i].focus === focus) return days[i].lifts;
    return null;
  }

  // Refresh only the per-lift "logged N / M" line — never a full re-render, so inputs the lifter is
  // mid-typing (reps/weight, fail toggle, sets×reps chips) are never clobbered on a routine broadcast.
  function updateProgress(active) {
    for (var i = 0; i < progRefs.length; i++) {
      var ref = progRefs[i];
      var done = loggedCount(active, ref.exercise);
      ref.el.textContent = 'logged ' + done + ' / ' + ref.sets;
      ref.el.className = 'prog' + (done >= ref.sets ? ' met' : '');
    }
  }

  function renderLifts(lifts, active) {
    liftsEl.innerHTML = '';
    progRefs = [];
    if (!lifts || !lifts.length) { liftsEl.innerHTML = '<div class="empty">No prescribed lifts.</div>'; return; }
    lifts.forEach(function (l) {
      if (l.kind === 'rounds') return; // circuits aren't set-logged here
      // BW+X lifts (weighted pull-ups/dips) track their ADDED load as the working weight — the same
      // number is prefilled and logged, so change detection and the flash work unchanged.
      var bwx = (l.weight == null && l.addedWeight != null);
      var w = (l.weight != null ? l.weight : (bwx ? l.addedWeight : null));
      var sch = l.sets + 'x' + l.reps;
      var prev = lastWeights.hasOwnProperty(l.exercise) ? lastWeights[l.exercise] : undefined;
      var schPrev = lastScheme.hasOwnProperty(l.exercise) ? lastScheme[l.exercise] : undefined;
      var weightMoved = haveBaseline && prev !== undefined && prev !== w;
      var schemeMoved = haveBaseline && schPrev !== undefined && schPrev !== sch;
      var changed = weightMoved || schemeMoved;

      var row = document.createElement('div');
      row.className = 'lift' + (changed ? ' changed' : '');

      // --- top: name + editable sets×reps chips ---
      var top = document.createElement('div'); top.className = 'top';
      var name = document.createElement('span'); name.className = 'lname'; name.textContent = l.exercise;
      var chips = document.createElement('div'); chips.className = 'chips';
      var setsChip = document.createElement('input');
      setsChip.className = 'chip'; setsChip.type = 'number'; setsChip.min = '1'; setsChip.value = l.sets; setsChip.setAttribute('aria-label', 'sets');
      var cx = document.createElement('span'); cx.className = 'cx'; cx.textContent = '×';
      var repsChip = document.createElement('input');
      repsChip.className = 'chip'; repsChip.type = 'number'; repsChip.min = '1'; repsChip.value = l.reps; repsChip.setAttribute('aria-label', 'reps');
      var chint = document.createElement('span'); chint.className = 'chint'; chint.textContent = 'sets×reps';
      function commitScheme() {
        var s = parseInt(setsChip.value, 10), r = parseInt(repsChip.value, 10);
        var payload = { type: 'set_scheme', exercise: l.exercise };
        if (s >= 1) payload.sets = s;
        if (r >= 1) payload.reps = r;
        if (payload.sets != null || payload.reps != null) send(payload);
      }
      setsChip.addEventListener('change', commitScheme);
      repsChip.addEventListener('change', commitScheme);
      chips.appendChild(setsChip); chips.appendChild(cx); chips.appendChild(repsChip); chips.appendChild(chint);
      top.appendChild(name); top.appendChild(chips);

      // --- mid: big working weight + logged progress ---
      var mid = document.createElement('div'); mid.className = 'mid';
      var weight = document.createElement('div'); weight.className = 'weight';
      var big = document.createElement('span'); big.className = 'big'; big.textContent = (bwx ? 'BW+' + w : (w != null ? w : 'BW'));
      weight.appendChild(big);
      if (w != null && !bwx) { var lb = document.createElement('span'); lb.className = 'lb'; lb.textContent = 'lb' + (l.perSide ? ' /side' : ''); weight.appendChild(lb); }
      if (weightMoved) { var d = document.createElement('span'); d.className = 'delta'; d.textContent = (w > prev ? '▲' : '▼') + ' was ' + prev; weight.appendChild(d); }
      else if (schemeMoved) { var d2 = document.createElement('span'); d2.className = 'delta'; d2.textContent = 'was ' + schPrev.replace('x', '×'); weight.appendChild(d2); }
      var done = loggedCount(active, l.exercise);
      var prog = document.createElement('span');
      prog.className = 'prog' + (done >= l.sets ? ' met' : '');
      prog.textContent = 'logged ' + done + ' / ' + l.sets;
      mid.appendChild(weight); mid.appendChild(prog);

      // --- ctl: actual reps + weight fields, fail, LOG ---
      var ctl = document.createElement('div'); ctl.className = 'ctl';
      var repsField = document.createElement('label'); repsField.className = 'field';
      var reps = document.createElement('input');
      reps.type = 'number'; reps.value = l.reps; reps.min = '1'; reps.setAttribute('aria-label', 'reps logged');
      var ru = document.createElement('span'); ru.className = 'u'; ru.textContent = 'reps';
      repsField.appendChild(reps); repsField.appendChild(ru);
      var wtField = document.createElement('label'); wtField.className = 'field wt';
      var wt = document.createElement('input');
      wt.type = 'number'; wt.value = (w != null ? w : ''); wt.placeholder = 'BW'; wt.setAttribute('aria-label', 'weight logged');
      var wu = document.createElement('span'); wu.className = 'u'; wu.textContent = 'lb';
      wtField.appendChild(wt); wtField.appendChild(wu);
      var fail = document.createElement('button');
      fail.type = 'button'; fail.className = 'fail'; fail.textContent = 'fail';
      var failed = false;
      fail.addEventListener('click', function () { failed = !failed; fail.classList.toggle('on', failed); });
      var logBtn = document.createElement('button');
      logBtn.type = 'button'; logBtn.className = 'log'; logBtn.textContent = 'LOG';
      logBtn.addEventListener('click', function () {
        var r = parseInt(reps.value, 10);
        if (!r || r < 1) return;
        var wv = wt.value === '' ? null : parseFloat(wt.value);
        var payload = { type: 'log_set', exercise: l.exercise, reps: r, failed: failed };
        if (wv != null && !isNaN(wv)) payload.weight = wv;
        send(payload);
        failed = false; fail.classList.remove('on');
      });
      ctl.appendChild(repsField); ctl.appendChild(wtField); ctl.appendChild(fail); ctl.appendChild(logBtn);

      row.appendChild(top);
      if (l.note) { var noteEl = document.createElement('div'); noteEl.className = 'note'; noteEl.textContent = l.note; row.appendChild(noteEl); }
      row.appendChild(mid); row.appendChild(ctl);
      liftsEl.appendChild(row);

      progRefs.push({ exercise: l.exercise, sets: l.sets, el: prog });
      lastWeights[l.exercise] = w;
      lastScheme[l.exercise] = sch;
    });
    haveBaseline = true;
  }

  // True if any prescribed weight OR sets×reps scheme differs from what we last rendered.
  function programChanged(lifts) {
    if (!lifts) return false;
    for (var i = 0; i < lifts.length; i++) {
      var l = lifts[i];
      if (l.kind === 'rounds') continue;
      var w = (l.weight != null ? l.weight : (l.addedWeight != null ? l.addedWeight : null));
      if (lastWeights.hasOwnProperty(l.exercise) && lastWeights[l.exercise] !== w) return true;
      if (lastScheme.hasOwnProperty(l.exercise) && lastScheme[l.exercise] !== (l.sets + 'x' + l.reps)) return true;
    }
    return false;
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
    if (restDoneTimer) { clearTimeout(restDoneTimer); restDoneTimer = null; }  // don't let a prior rest's reset hide this countdown
    var left = seconds;
    restEl.className = 'on';
    restLbl.textContent = 'rest';
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
    restLbl.textContent = 'rest over';
    restNum.textContent = 'go';
    restDoneTimer = setTimeout(function () { restEl.className = ''; restDoneTimer = null; }, 4000);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function handle(msg) {
    switch (msg.type) {
      case 'session_hello':
        currentFocus = msg.day || null;
        focusEl.textContent = msg.day || 'Session';
        if (msg.restSeconds != null) restChip.value = msg.restSeconds;
        renderLifts(msg.lifts, msg.activeSession);   // seeds lastWeights (no flash on first paint)
        break;
      case 'cf_agent_state':
        if (msg.state) {
          latestState = msg.state;
          if (msg.state.settings && msg.state.settings.restSeconds != null && document.activeElement !== restChip) {
            restChip.value = msg.state.settings.restSeconds;   // reflect coach-set default (chat path)
          }
          var lifts = liftsFromState(msg.state);
          if (lifts && programChanged(lifts)) {
            // Defer the rebuild if the lifter is mid-edit in a row — flush it on focusout instead, so a
            // committed sets edit (or a policy firing) never yanks focus or wipes a half-typed value.
            if (isEditingLifts()) pendingRerender = true;
            else renderLifts(lifts, msg.state.activeSession);
          }
          updateProgress(msg.state.activeSession);   // always: cheap, never resets inputs
        }
        break;
      case 'set_logged':
        addReceipt('logged <span class="ink">' + esc(msg.exercise) + '</span> ' + msg.reps + (msg.weight != null ? ' @ ' + msg.weight + ' lb' : '') + (msg.failed ? ' (failed)' : ''), false);
        break;
      case 'rest_started':
        startRest(msg.seconds);
        break;
      case 'rest_over':
        restDone();
        break;
      case 'plugin_fired':
        var changed = msg.changed && msg.changed.length ? ' · adjusted ' + msg.changed.map(esc).join(', ') : ' · no change';
        addReceipt('<span class="ink">' + esc(msg.name) + '</span> fired · ' + msg.ms + ' ms · ' + (msg.cold ? 'cold' : 'warm') + ' · <span class="ink">0 tokens</span>' + changed, true);
        break;
      case 'session_finalized':
        // Broadcast on a successful save — show the rolled-up summary as a receipt. The following
        // cf_agent_state (activeSession now null) resets the per-lift progress lines to 0 on its own.
        addReceipt('session saved · <span class="ink">' + msg.sets + ' set' + (msg.sets === 1 ? '' : 's') + '</span> · ' + esc(msg.summary || ''), false);
        finishEl.disabled = false;
        break;
      case 'session_complete_result':
        // Direct ack to THIS client. On success the receipt already came via session_finalized; only
        // surface the "nothing to save" case here so an empty Finish tap is not silent.
        if (!msg.ok) addErr('nothing to save' + (msg.reason ? ' · ' + msg.reason : ''));
        finishEl.disabled = false;
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
