import { renderHead, renderHeader } from "./shared";

/**
 * Server-rendered /session — the live workout stage (M4), design-refresh reskin.
 *
 * Opens a RAW WebSocket to wss://<host>/agents/liftty-agent/me. Protocol (all JSON):
 *   client → server:  { type:"log_set", exercise, reps, weight?, failed?, rest?, nonce? }
 *                     { type:"set_rest", seconds }                    (configurable rest default)
 *                     { type:"set_scheme", exercise, sets?, reps? }   (editable sets×reps chips)
 *                     { type:"select_day", day }                      (switch to Day A/B/C)
 *                     { type:"session_complete" }                     (Finish button → persist history)
 *   server → client:  { type:"session_hello", day, dayLabel, lifts, activeSession, restSeconds,
 *                       week, weekDone, weekComplete }
 *                     { type:"cf_agent_state", state }
 *                     { type:"set_logged", … } { type:"rest_started", exercise, seconds }
 *                     { type:"rest_over", exercise } { type:"plugin_fired", … } { type:"error", message }
 *                     { type:"session_finalized", id, day, week, sets, summary }
 *                     { type:"session_complete_result", ok, … } { type:"select_day_result", ok, … }
 *
 * Weight is the loudest thing on the page (56px Archivo). Prescribed sets×reps are editable chips that
 * persist via set_scheme; the rest default is an editable chip that persists via set_rest. A policy
 * that adjusts a weight flashes the row orange.
 *
 * THE INPUTS ARE SACRED. What the lifter has typed but not yet logged exists nowhere else, so no
 * repaint may touch it. Rows are patched in place (patchLifts) and only rebuilt when the exercise LIST
 * changes — a day switch or a week change. Typed values are mirrored into a localStorage draft keyed
 * by week+day, so even a genuine reload (iOS Safari discards backgrounded tabs) restores them. Prefill
 * precedence is draft > last set logged this session > prescription, which is why a reconnect restores
 * the working weight rather than resetting to the program's opener. A prescription that MOVES mid-session
 * is recorded as a draft too — that is the only way a new instruction outranks the set already logged.
 *
 * The socket is assumed unreliable: frames composed while it is down are queued (and mirrored to
 * localStorage, so a discarded tab doesn't lose them) and replayed on open rather than dropped, every
 * LOG carries a nonce so a re-send after a half-open socket is deduped server-side, and reconnect
 * backs off while jumping straight back on visibilitychange. Exactly one socket and one pending retry
 * exist at a time — a superseded socket's listeners are ignored rather than left to double-handle.
 *
 * TESTED IN test/dom/session-client.spec.ts. Everything below the CSS is ES5 inside a template
 * literal, so the main suite (workerd — no DOM, no eval) can't reach it; a second vitest project
 * mounts this markup under jsdom, evaluates this exact script against a fake socket, and drives the
 * state machine directly. Change the script and those tests change with it — they read `handle`,
 * `send`, `outbox` and `drafts` out of this scope by name.
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

  /* week-complete nudge — /block is where the block actually moves; nothing advances on its own */
  #banner { display: none; border: 1px dashed var(--line-dash); color: var(--marker); font-family: var(--ui); font-size: 12px; padding: 12px 14px; margin-top: 18px; }
  #banner.on { display: block; }
  #banner a { color: var(--marker); text-decoration: underline; }

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
    <div class="eyebrow" id="eyebrow">today</div>
    <div class="focus" id="focus">—</div>
    <div id="banner"></div>

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
  var WS_URL = proto + '//' + host + '/agents/liftty-agent/me';

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

  var bannerEl = document.getElementById('banner');

  // Behavioural constants — every one of these encodes a product decision, so they get names.
  var DRAFT_TTL_MS = 8 * 3600 * 1000;   // a draft older than a gym session is noise, not a rescue
  var DRAFT_DEBOUNCE_MS = 400;          // coalesce keystrokes into one localStorage write
  var OUTBOX_TTL_MS = 12 * 3600 * 1000; // replaying yesterday's sets would corrupt today's log
  var OUTBOX_KEY = 'liftty.outbox';
  var FINISH_TIMEOUT_MS = 8000;         // re-enable FINISH if the server never answers
  var REST_CLEAR_MS = 4000;             // how long "rest over · go" stays up
  var RECONNECT_BASE_MS = 1000;
  var RECONNECT_MAX_MS = 15000;

  var ws = null;
  var restTimer = null;
  var restDoneTimer = null;
  var receiptCount = 0;
  var retry = 0;                   // reconnect attempt count, drives the backoff
  var reconnectTimer = null;       // the one pending retry — cleared before any new connect()
  var outbox = [];                 // frames composed while the socket was down — flushed on open
  var finishTimer = null;          // watchdog so a lost session_complete can't leave Finish dead

  // Session view state, so we can update prescriptions live when a policy edits the program.
  var currentFocus = null;         // the day focus we're rendering, e.g. "Front Squat"
  var currentDayLabel = '';        // "Day B" — half the draft-storage key
  var currentWeek = null;          // the week this session belongs to — the other half
  var rowsByEx = {};               // exercise -> the row's element refs, so we can patch instead of rebuild
  var renderedSig = '';            // the exercise list the current rows were built for
  var lastWeights = {};            // exercise -> last-rendered prescribed weight (change detection + flash)
  var lastScheme = {};             // exercise -> last-rendered "sets x reps"
  var haveBaseline = false;        // suppress the flash on the very first render
  var activeSets = [];             // activeSession.loggedSets — server truth, drives progress + prefill
  var drafts = {};                 // exercise -> { reps, weight } TYPED but not yet logged
  var draftSaveTimer = null;

  function setConn(state) {
    conn.className = 'conn' + (state === 'open' ? ' on' : state === 'closed' ? ' off' : '');
    connlbl.textContent = state === 'open' ? 'live' : state === 'closed' ? (outbox.length ? 'queued' : 'disconnected') : 'connecting';
  }

  // --- drafts ---------------------------------------------------------------------------------
  // What the lifter typed but hasn't logged lives ONLY in the DOM otherwise, so any repaint — and any
  // reload iOS Safari does to a backgrounded tab — silently loses it. Keyed by week+day rather than by
  // session start (which is re-stamped on the first set) so it survives a reconnect intact.
  function draftKey() { return 'liftty.draft.' + currentWeek + '.' + currentDayLabel; }

  function loadDrafts() {
    drafts = {};
    if (currentWeek == null || !currentDayLabel) return;
    try {
      var raw = localStorage.getItem(draftKey());
      if (!raw) return;
      var d = JSON.parse(raw);
      // Drop anything stale: a draft from last week's Day B is noise, not a rescue.
      if (!d || !d.savedAt || (Date.now() - d.savedAt) > DRAFT_TTL_MS) { localStorage.removeItem(draftKey()); return; }
      drafts = d.byExercise || {};
    } catch (_) { drafts = {}; }
  }

  function writeDrafts() {
    if (currentWeek == null || !currentDayLabel) return;
    try { localStorage.setItem(draftKey(), JSON.stringify({ savedAt: Date.now(), byExercise: drafts })); } catch (_) {}
  }

  function saveDrafts() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(function () { draftSaveTimer = null; writeDrafts(); }, DRAFT_DEBOUNCE_MS);
  }

  // Force the debounced write out. The tab being discarded mid-window is precisely the failure drafts
  // exist to survive, so the last keystrokes must not be sitting in a pending timer when it happens.
  function flushWrites() {
    if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }
    writeDrafts();
    saveOutbox();
  }

  function clearDrafts() {
    drafts = {};
    try { localStorage.removeItem(draftKey()); } catch (_) {}
  }

  // The outbox holds frames the lifter has already committed to (a logged set, a save). Keeping it in
  // memory only meant a discarded tab lost them silently, which is the one thing this page must not do.
  function saveOutbox() {
    try {
      if (outbox.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify({ savedAt: Date.now(), frames: outbox }));
      else localStorage.removeItem(OUTBOX_KEY);
    } catch (_) {}
  }

  function loadOutbox() {
    try {
      var raw = localStorage.getItem(OUTBOX_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      // Stale frames are worse than no frames — replaying yesterday's sets into today's session would
      // corrupt the log. The nonce makes a genuine retry safe; time makes an ancient one wrong.
      if (!d || !d.savedAt || (Date.now() - d.savedAt) > OUTBOX_TTL_MS || !d.frames || !d.frames.length) {
        localStorage.removeItem(OUTBOX_KEY);
        return;
      }
      outbox = d.frames;
    } catch (_) { outbox = []; }
  }

  // Finish the workout: persist the active session into permanent history. Server acks with
  // session_complete_result (and broadcasts session_finalized on success).
  finishEl.addEventListener('click', function () {
    // Only disable once the frame is actually on the wire. send() used to swallow it on a closed
    // socket, leaving the button permanently dead — which is what "saving is buggy" looked like.
    var sent = send({ type: 'session_complete' });
    if (!sent) addErr('offline — save queued, will send on reconnect');
    // Disable either way: the frame is committed (sent or queued, and send() collapses duplicates),
    // so further taps can only produce confusion. The watchdog re-enables if nothing comes back.
    finishEl.disabled = true;
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = setTimeout(function () {
      finishEl.disabled = false;
      addErr(sent ? 'no response — tap FINISH again' : 'still offline — save is queued');
    }, FINISH_TIMEOUT_MS);
  });

  function finishDone() {
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
    finishEl.disabled = false;
  }

  // The editable rest-default chip persists via a set_rest frame; the next logged set rests this long.
  restChip.addEventListener('change', function () {
    var s = parseInt(restChip.value, 10);
    if (!s || s < 5) s = 60;
    s = Math.min(600, Math.max(5, s));
    restChip.value = s;
    send({ type: 'set_rest', seconds: s });
  });

  /** The last set actually logged for this exercise in this session, or null. */
  function lastLogged(exercise) {
    for (var i = activeSets.length - 1; i >= 0; i--) if (activeSets[i].exercise === exercise) return activeSets[i];
    return null;
  }

  /** The working load a lift is performed at — BW+X lifts carry theirs in addedWeight. */
  function workWeight(l) { return l.weight != null ? l.weight : (l.addedWeight != null ? l.addedWeight : null); }

  /**
   * What the reps/weight fields should show, in precedence order:
   *   1. an unlogged draft — what the lifter typed and hasn't committed
   *   2. the last set they logged for this exercise THIS session — you work at the weight you're
   *      working at, not the one the program opened with
   *   3. the prescription
   * Server-authoritative from (2) down, which is what lets a reconnect restore the right numbers
   * instead of resetting them to the prescription.
   */
  function prefill(l) {
    var d = drafts[l.exercise];
    if (d) return { reps: d.reps, weight: d.weight };
    var last = lastLogged(l.exercise);
    if (last) return { reps: String(last.reps), weight: last.weight ? String(last.weight) : '' };
    var w = workWeight(l);
    return { reps: String(l.reps), weight: w != null ? String(w) : '' };
  }

  function liftsFromState(state) {
    if (!state || !state.program || !state.program.days) return null;
    var focus = (state.activeSession && state.activeSession.day) || currentFocus;
    var days = state.program.days;
    for (var i = 0; i < days.length; i++) if (days[i].focus === focus) return days[i].lifts;
    return null;
  }

  /** The set of exercises we've built rows for — a change here (day switch, week change) needs a rebuild. */
  function signature(lifts) {
    var names = [];
    for (var i = 0; i < lifts.length; i++) if (lifts[i].kind !== 'rounds') names.push(lifts[i].exercise);
    return names.join('|');
  }

  /**
   * The single entry point for "the program says this now". Rebuilds only when the exercise LIST
   * changed; otherwise patches the existing rows.
   *
   * This is the fix for the reported weight-reset. The old code rebuilt every row with innerHTML on
   * every session_hello — and the socket closes constantly on a phone (screen lock, backgrounding,
   * cell/wifi handoff), reconnecting two seconds later. Every typed weight snapped back to the
   * prescription and it looked exactly like the browser had refreshed, when nothing had reloaded.
   */
  function applyLifts(lifts, active) {
    if (active && active.loggedSets) activeSets = active.loggedSets;
    if (!lifts || !lifts.length) {
      liftsEl.innerHTML = '<div class="empty">No prescribed lifts.</div>';
      rowsByEx = {}; renderedSig = '';
      return;
    }
    var sig = signature(lifts);
    if (sig !== renderedSig) renderLifts(lifts);
    else patchLifts(lifts);
    updateProgress();
  }

  /** Refresh only the per-lift "logged N / M" line — never touches an input. */
  function updateProgress() {
    // One pass over the sets, not one scan per row: this runs on every cf_agent_state, which the
    // server broadcasts on every logged set, so per-row scanning grows quadratically as a session fills.
    var counts = {};
    for (var i = 0; i < activeSets.length; i++) {
      var ex2 = activeSets[i].exercise;
      counts[ex2] = (counts[ex2] || 0) + 1;
    }
    for (var ex in rowsByEx) {
      if (!rowsByEx.hasOwnProperty(ex)) continue;
      var r = rowsByEx[ex];
      var done = counts[ex] || 0;
      r.prog.textContent = 'logged ' + done + ' / ' + r.sets;
      r.prog.className = 'prog' + (done >= r.sets ? ' met' : '');
    }
  }

  /**
   * Update the prescription shown on existing rows — big weight, sets×reps chips, the delta + flash.
   * Inputs are only re-seeded when they are neither focused nor holding a draft, so a policy firing
   * mid-set can never take the number out from under the lifter's fingers.
   */
  function patchLifts(lifts) {
    lifts.forEach(function (l) {
      var r = rowsByEx[l.exercise];
      if (!r) return;
      var w = workWeight(l);
      var bwx = (l.weight == null && l.addedWeight != null);
      var sch = l.sets + 'x' + l.reps;
      var prev = lastWeights.hasOwnProperty(l.exercise) ? lastWeights[l.exercise] : undefined;
      var schPrev = lastScheme.hasOwnProperty(l.exercise) ? lastScheme[l.exercise] : undefined;
      var weightMoved = haveBaseline && prev !== undefined && prev !== w;
      var schemeMoved = haveBaseline && schPrev !== undefined && schPrev !== sch;

      r.big.textContent = (bwx ? 'BW+' + w : (w != null ? w : 'BW'));
      r.lb.textContent = (w != null && !bwx) ? ('lb' + (l.perSide ? ' /side' : '')) : '';
      if (document.activeElement !== r.setsChip) r.setsChip.value = l.sets;
      if (document.activeElement !== r.repsChip) r.repsChip.value = l.reps;
      r.sets = l.sets;

      r.delta.textContent = weightMoved
        ? ((w > prev ? '▲' : '▼') + ' was ' + prev)
        : (schemeMoved ? ('was ' + String(schPrev).replace('x', '×')) : '');

      if (weightMoved || schemeMoved) {
        // Restart the flash animation — reassigning className alone won't replay it.
        r.row.classList.remove('changed'); void r.row.offsetWidth; r.row.classList.add('changed');
      }
      // A prescription that MOVED is a fresh instruction — newer than both the draft and the last set
      // logged — so it takes its OWN field. Miss a rep, the policy cuts you to 100, and the next set is
      // queued at 100 rather than the 125 you just failed. (A steady-state prescription never does
      // this: that's the reset the lifter was complaining about.)
      //
      // The two moves are kept strictly separate. A scheme change is usually the lifter's own doing —
      // editing the sets×reps chip round-trips through the server and comes back as schemeMoved — so
      // letting it reach for the weight field would destroy a weight they had just typed, which is the
      // exact bug this whole change exists to fix.
      if (weightMoved && document.activeElement !== r.wt) r.wt.value = w != null ? String(w) : '';
      if (schemeMoved && document.activeElement !== r.reps) r.reps.value = String(l.reps);
      // A move that reached a field has to be REMEMBERED, not just painted, and the draft is the only
      // thing prefill() ranks above the last set logged. Without this the next repaint of any kind — a
      // rest-chip save, a policy, a reconnect, a set logged on another lift — reseeds the field from
      // that last set while the chips and the big weight go on showing the new prescription. That gap
      // is the reported bug: change 10 reps to 8, watch the row flash and the chip hold 8, then have
      // every remaining set log as 10 because the field had quietly snapped back.
      //
      // Snapshot BOTH fields, not just the one that moved, so the draft mirrors the row exactly: a
      // scheme move must carry the typed weight forward untouched, not blank it. A focused field is
      // recorded as it currently reads, since it was deliberately not written to above.
      if (weightMoved || schemeMoved) { drafts[l.exercise] = { reps: r.reps.value, weight: r.wt.value }; saveDrafts(); }
      else seedInputs(l, r);
      lastWeights[l.exercise] = w;
      lastScheme[l.exercise] = sch;
    });
    haveBaseline = true;
  }

  /**
   * Push the prefill into a row's inputs. The only guard is focus — writing over the field the lifter
   * has their cursor in would move it. A draft needs no guard of its own: prefill() already resolves
   * to the draft when there is one, so re-seeding a row mid-edit writes back the same value.
   */
  function seedInputs(l, r) {
    var p = prefill(l);
    if (document.activeElement !== r.reps) r.reps.value = p.reps;
    if (document.activeElement !== r.wt) r.wt.value = p.weight;
  }

  /** Full rebuild. Only runs when the exercise list itself changed — a day switch or a week change. */
  function renderLifts(lifts) {
    liftsEl.innerHTML = '';
    rowsByEx = {};
    lifts.forEach(function (l) {
      if (l.kind === 'rounds') return; // circuits aren't set-logged here
      // BW+X lifts (weighted pull-ups/dips) track their ADDED load as the working weight — the same
      // number is prefilled and logged, so change detection and the flash work unchanged.
      var bwx = (l.weight == null && l.addedWeight != null);
      var w = workWeight(l);
      var sch = l.sets + 'x' + l.reps;

      var row = document.createElement('div');
      row.className = 'lift';

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
        var s = parseInt(setsChip.value, 10), r2 = parseInt(repsChip.value, 10);
        var payload = { type: 'set_scheme', exercise: l.exercise };
        if (s >= 1) payload.sets = s;
        if (r2 >= 1) payload.reps = r2;
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
      var lb = document.createElement('span'); lb.className = 'lb';
      lb.textContent = (w != null && !bwx) ? ('lb' + (l.perSide ? ' /side' : '')) : '';
      var delta = document.createElement('span'); delta.className = 'delta';
      weight.appendChild(big); weight.appendChild(lb); weight.appendChild(delta);
      var prog = document.createElement('span');
      prog.className = 'prog';
      prog.textContent = 'logged 0 / ' + l.sets;
      mid.appendChild(weight); mid.appendChild(prog);

      // --- ctl: actual reps + weight fields, fail, LOG ---
      var ctl = document.createElement('div'); ctl.className = 'ctl';
      var repsField = document.createElement('label'); repsField.className = 'field';
      var reps = document.createElement('input');
      reps.type = 'number'; reps.min = '1'; reps.setAttribute('aria-label', 'reps logged');
      var ru = document.createElement('span'); ru.className = 'u'; ru.textContent = 'reps';
      repsField.appendChild(reps); repsField.appendChild(ru);
      var wtField = document.createElement('label'); wtField.className = 'field wt';
      var wt = document.createElement('input');
      wt.type = 'number'; wt.placeholder = 'BW'; wt.setAttribute('aria-label', 'weight logged');
      var wu = document.createElement('span'); wu.className = 'u'; wu.textContent = 'lb';
      wtField.appendChild(wt); wtField.appendChild(wu);
      var fail = document.createElement('button');
      fail.type = 'button'; fail.className = 'fail'; fail.textContent = 'fail';
      var logBtn = document.createElement('button');
      logBtn.type = 'button'; logBtn.className = 'log'; logBtn.textContent = 'LOG';

      var ref = { row: row, setsChip: setsChip, repsChip: repsChip, big: big, lb: lb, delta: delta, prog: prog, reps: reps, wt: wt, fail: fail, failed: false, sets: l.sets };
      rowsByEx[l.exercise] = ref;

      // Every keystroke becomes a draft, so a repaint (or a reload) has something to restore from.
      function noteDraft() { drafts[l.exercise] = { reps: reps.value, weight: wt.value }; saveDrafts(); }
      reps.addEventListener('input', noteDraft);
      wt.addEventListener('input', noteDraft);

      fail.addEventListener('click', function () { ref.failed = !ref.failed; fail.classList.toggle('on', ref.failed); });
      logBtn.addEventListener('click', function () {
        var r2 = parseInt(reps.value, 10);
        if (!r2 || r2 < 1) return;
        var wv = wt.value === '' ? null : parseFloat(wt.value);
        // A per-tap idempotency key: if the frame is lost on a half-open socket and re-sent, the
        // server recognises the retry instead of logging the set twice.
        var payload = { type: 'log_set', exercise: l.exercise, reps: r2, failed: ref.failed, nonce: mkNonce() };
        if (wv != null && !isNaN(wv)) payload.weight = wv;
        if (send(payload)) {
          // On the wire: the values are no longer an uncommitted draft, so drop it and let the
          // server's loggedSets drive the prefill from here.
          delete drafts[l.exercise]; saveDrafts();
        } else {
          // Queued only. The outbox is in memory, and the tab being discarded is exactly the case
          // drafts exist for — dropping the draft here would delete the last copy of the set.
          addErr('offline — set queued, will send on reconnect');
        }
        ref.failed = false; fail.classList.remove('on');
      });
      ctl.appendChild(repsField); ctl.appendChild(wtField); ctl.appendChild(fail); ctl.appendChild(logBtn);

      row.appendChild(top);
      if (l.note) { var noteEl = document.createElement('div'); noteEl.className = 'note'; noteEl.textContent = l.note; row.appendChild(noteEl); }
      row.appendChild(mid); row.appendChild(ctl);
      liftsEl.appendChild(row);

      seedInputs(l, ref);
      lastWeights[l.exercise] = w;
      lastScheme[l.exercise] = sch;
    });
    renderedSig = signature(lifts);
    haveBaseline = true;
  }

  function mkNonce() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

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
    restDoneTimer = setTimeout(function () { restEl.className = ''; restDoneTimer = null; }, REST_CLEAR_MS);
  }

  /**
   * Returns true if the frame reached the wire, false if it was queued.
   *
   * The old version dropped the frame silently whenever the socket was down, which swallowed every
   * LOG tap with no error and no visual — the Finish button just made it obvious by going dead.
   * readyState !== 1 means nothing was ever written, so queueing and replaying on open is safe.
   */
  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); return true; }
      catch (_) { /* raced to CLOSING between the check and the call — fall through and queue */ }
    }
    // One pending save is enough; a lifter tapping FINISH repeatedly while offline would otherwise
    // queue N of them, and all but the first come back as "nothing to save" after the reconnect.
    if (obj.type === 'session_complete') {
      for (var j = 0; j < outbox.length; j++) if (outbox[j].type === 'session_complete') { setConn('closed'); return false; }
    }
    outbox.push(obj);
    saveOutbox();
    setConn('closed');
    return false;
  }

  function flushOutbox() {
    var queued = outbox;
    outbox = [];
    for (var i = 0; i < queued.length; i++) {
      if (!(ws && ws.readyState === 1)) { outbox = queued.slice(i); break; }
      // Requeue the remainder on ANY send failure — emptying the array up front and then throwing
      // would drop every frame behind the one that failed.
      try { ws.send(JSON.stringify(queued[i])); }
      catch (_) { outbox = queued.slice(i); break; }
    }
    saveOutbox();
  }

  function handle(msg) {
    switch (msg.type) {
      case 'session_hello':
        var dayChanged = (msg.day || null) !== currentFocus;
        currentFocus = msg.day || null;
        focusEl.textContent = msg.day || 'Session';
        if (msg.dayLabel) { currentDayLabel = msg.dayLabel; document.getElementById('eyebrow').textContent = msg.dayLabel; }
        if (msg.week != null) currentWeek = msg.week;
        if (dayChanged) { lastWeights = {}; lastScheme = {}; haveBaseline = false; renderedSig = ''; loadDrafts(); }
        if (msg.restSeconds != null && document.activeElement !== restChip) restChip.value = msg.restSeconds;
        setBanner(msg.weekComplete, msg.week);
        // applyLifts patches when the exercise list is unchanged, so a plain reconnect — which is
        // constant on a phone — leaves every typed value exactly where it was.
        applyLifts(msg.lifts, msg.activeSession);
        break;
      case 'cf_agent_state':
        if (msg.state) {
          if (msg.state.settings && msg.state.settings.restSeconds != null && document.activeElement !== restChip) {
            restChip.value = msg.state.settings.restSeconds;   // reflect coach-set default (chat path)
          }
          var act = msg.state.activeSession;
          // A day switch (from /block, or another tab) changes the exercise list entirely, so the
          // usual per-exercise change detection finds no overlap and would report "nothing changed".
          if (act && act.day && act.day !== currentFocus) {
            currentFocus = act.day;
            currentDayLabel = act.dayLabel || currentDayLabel;
            if (act.week != null) currentWeek = act.week;
            focusEl.textContent = act.day;
            if (act.dayLabel) document.getElementById('eyebrow').textContent = act.dayLabel;
            lastWeights = {}; lastScheme = {}; haveBaseline = false; renderedSig = '';
            loadDrafts();
          }
          activeSets = (act && act.loggedSets) || [];
          var lifts = liftsFromState(msg.state);
          if (lifts) applyLifts(lifts, act);
          else updateProgress();
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
        // Only surface a policy that actually DID something. A policy runs on every logged set and
        // almost always returns no actions, so reporting each evaluation buried the one line that
        // matters — the weights the lifter logged — under a wall of "fired · no change".
        if (!(msg.actionsApplied > 0) && !msg.error) break;
        var changed = msg.changed && msg.changed.length ? ' · adjusted ' + msg.changed.map(esc).join(', ') : '';
        addReceipt('<span class="ink">' + esc(msg.name) + '</span> ' + (msg.error ? 'failed · ' + esc(String(msg.error)) : 'fired · ' + msg.ms + ' ms · ' + (msg.cold ? 'cold' : 'warm') + ' · <span class="ink">0 tokens</span>' + changed), true);
        break;
      case 'session_finalized':
        // Broadcast on a successful save — show the rolled-up summary as a receipt. The following
        // cf_agent_state (activeSession now null) resets the per-lift progress lines to 0 on its own.
        addReceipt('session saved · <span class="ink">' + msg.sets + ' set' + (msg.sets === 1 ? '' : 's') + '</span> · ' + esc(msg.summary || ''), false);
        clearDrafts();
        // The workout is in the books — nothing still queued belongs to it, and replaying a stray
        // log_set now would reopen a session on whatever day the server derives next.
        outbox = []; saveOutbox();
        finishDone();
        break;
      case 'session_complete_result':
        // Direct ack to THIS client. On success the receipt already came via session_finalized; only
        // surface the "nothing to save" case here so an empty Finish tap is not silent.
        if (!msg.ok) addErr('nothing to save' + (msg.reason ? ' · ' + msg.reason : ''));
        finishDone();
        break;
      case 'select_day_result':
        if (!msg.ok) addErr(msg.reason || 'could not switch day');
        break;
      case 'error':
        addErr(msg.message || 'unknown');
        break;
    }
  }

  /** Nothing advances the block on its own — when the week is done, point at where it moves. */
  function setBanner(complete, week) {
    if (!complete) { bannerEl.className = ''; bannerEl.innerHTML = ''; return; }
    bannerEl.className = 'on';
    bannerEl.innerHTML = 'week ' + esc(week != null ? week : '') + ' is complete — <a href="/block">advance the block</a>.';
  }

  function esc(s) { return String(s).replace(/[<>&]/g, function (c) { return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'; }); }

  function connect() {
    // Exactly one socket and one pending retry at a time. Without this, a pending backoff timer and a
    // visibilitychange could both call connect(), leaving an orphaned-but-OPEN socket whose listeners
    // keep firing — duplicate receipts, a restarted rest countdown, and another socket on every
    // screen-lock cycle.
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws && ws.readyState <= 1) return;

    setConn('connecting');
    var sock = new WebSocket(WS_URL);
    ws = sock;
    sock.addEventListener('open', function () {
      if (ws !== sock) return;
      retry = 0; setConn('open'); flushOutbox();
    });
    // Backoff, capped: the old fixed 2s retry hammered the agent for the whole time a phone sat asleep
    // in a gym bag, and every reconnect cost a session_hello.
    sock.addEventListener('close', function () {
      if (ws !== sock) return; // a superseded socket closing must not schedule anything
      setConn('closed');
      var wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, retry++));
      reconnectTimer = setTimeout(connect, wait);
    });
    sock.addEventListener('error', function () { if (ws === sock) setConn('closed'); });
    sock.addEventListener('message', function (e) {
      if (ws !== sock) return; // ignore anything still arriving on a socket we've replaced
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      handle(msg);
    });
  }

  // Coming back to the tab is the moment the lifter expects it to be live — don't make them wait out
  // a backoff window that was sized for a screen that was off.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { retry = 0; connect(); return; }
    flushWrites(); // going away: land the debounced draft before the tab can be discarded
  });
  // pagehide is the last event an iOS tab reliably gets before discard.
  window.addEventListener('pagehide', flushWrites);

  loadOutbox();
  connect();
</script>
</body>
</html>`;
}
