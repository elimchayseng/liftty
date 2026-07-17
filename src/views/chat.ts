import { renderHead, renderHeader } from "./shared";

/**
 * Server-rendered /chat — the coach chat client (design-refresh reskin).
 *
 * Behavior unchanged: one input, a running transcript, a badge of which typed tools each turn used,
 * and the real per-turn token cost. The POST body still carries `mode: 'codemode' | 'tools'` — only
 * the toggle LABELS change (codemode / tool call). Messages are square hairline boxes, not bubbles;
 * the user turn is marked by an orange left-tick instead of a blue fill.
 */
export function renderChat(): string {
	const css = `
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; }
  .seg { display: flex; border: 1px solid var(--line-strong); font-family: var(--ui); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .seg button { background: transparent; color: var(--faint); border: none; padding: 6px 10px; font: inherit; cursor: pointer; }
  .seg button.on { background: var(--marker); color: var(--bg); font-weight: 600; }

  .chat { flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 20px; padding-bottom: calc(20px + env(safe-area-inset-bottom)); }
  #log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; min-height: 0; }
  .msg { max-width: 88%; padding: 12px 14px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
  .coach { align-self: flex-start; border: 1px solid var(--line); color: #e8e7e0; }
  .me { align-self: flex-end; max-width: 85%; border-left: 2px solid var(--accent); background: rgba(255,255,255,0.03); color: var(--ink); }
  .tools { align-self: flex-start; font-family: var(--ui); font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .tools b { color: var(--accent); font-weight: 500; }
  .code { align-self: flex-start; max-width: 88%; border: 1px solid var(--line); border-left: 2px solid var(--accent); padding: 10px 12px; overflow-x: auto; }
  .code .cap { display: block; font-family: var(--mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--faint); margin-bottom: 7px; }
  .code pre { font-family: var(--mono); font-size: 11px; color: #cbd2d9; line-height: 1.5; white-space: pre; }
  .err { align-self: flex-start; font-family: var(--ui); color: #ff6b6b; font-size: 13px; }

  form { display: flex; gap: 8px; padding-top: 16px; }
  input { flex: 1; background: transparent; border: 1px solid var(--line-strong); padding: 13px 14px; color: var(--ink); font-family: var(--ui); font-size: 14px; }
  input::placeholder { color: var(--faint); }
  input:focus { outline: none; border-color: var(--accent); }
  button.send { padding: 0 20px; font-size: 14px; }
  button.send:disabled { opacity: 0.5; }
  .hint { font-family: var(--ui); color: var(--faint); font-size: 11px; padding: 8px 2px 0; }`;

	const toggle = `<div class="seg" id="seg" title="Code Mode: one snippet vs. Tools: one call at a time">
      <button id="cm" class="on" type="button">codemode</button>
      <button id="tm" type="button">tool call</button>
    </div>`;

	return `${renderHead("chat", css)}
<body>
  ${renderHeader("chat", toggle)}
  <div class="chat">
    <div id="log">
      <div class="msg coach">Ask about your program or history — try "how's my <span class="hl">front squat</span> trending?" or "log my squats: 5x225, 5x225, 8x225 — did I PR? bump next week's front squat 5lb if so."</div>
    </div>
    <form id="f">
      <input id="m" autocomplete="off" placeholder="message the coach" autofocus />
      <button class="cta send" id="b" type="submit">SEND</button>
    </form>
    <div class="hint" id="hint">Code Mode (M3): the coach writes one JS snippet against <code>training.*</code>, run in a sandbox. Toggle to Tools to see the M2 baseline — same typed API, called one at a time.</div>
  </div>

<script>
  const log = document.getElementById('log');
  const form = document.getElementById('f');
  const input = document.getElementById('m');
  const btn = document.getElementById('b');
  const AGENT = '/agents/liftty-agent/me';

  let mode = 'codemode';
  const cmBtn = document.getElementById('cm');
  const tmBtn = document.getElementById('tm');
  const hint = document.getElementById('hint');
  const HINTS = {
    codemode: 'Code Mode (M3): the coach writes one JS snippet against <code>training.*</code>, run in a sandbox. Toggle to Tools to see the M2 baseline — same typed API, called one at a time.',
    tools: 'Tools (M2 baseline): the coach calls the four typed Training tools one at a time. Toggle to Code Mode to have it write a single snippet instead.',
  };
  function setMode(m) {
    mode = m;
    cmBtn.classList.toggle('on', m === 'codemode');
    tmBtn.classList.toggle('on', m === 'tools');
    hint.innerHTML = HINTS[m];
  }
  cmBtn.addEventListener('click', () => setMode('codemode'));
  tmBtn.addEventListener('click', () => setMode('tools'));

  function add(cls, text) {
    const d = document.createElement('div');
    d.className = (cls === 'err' ? 'err' : 'msg ' + cls);
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  function addTools(names) {
    if (!names || !names.length) return;
    const d = document.createElement('div');
    d.className = 'tools';
    d.innerHTML = 'used: <b>' + names.map(n => n.replace(/[<>&]/g, '')).join('</b>, <b>') + '</b>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  // Real token cost of this coach turn, from the AI SDK (result.totalUsage). The AI Gateway dashboard
  // shows 0 for these streamed Heroku responses; the SDK parses the include_usage chunk, so this is real.
  function addUsage(inp, out) {
    if (inp == null && out == null) return;
    const total = (inp || 0) + (out || 0);
    const d = document.createElement('div');
    d.className = 'tools';
    d.innerHTML = 'tokens: <b>' + (inp || 0) + '</b> in · <b>' + (out || 0) + '</b> out · <b>' + total + '</b> total';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function addCode(snippets) {
    if (!snippets || !snippets.length) return;
    for (const src of snippets) {
      const d = document.createElement('div');
      d.className = 'code';
      const cap = document.createElement('span');
      cap.className = 'cap';
      cap.textContent = 'snippet the coach ran';
      const pre = document.createElement('pre');
      pre.textContent = src;
      d.appendChild(cap);
      d.appendChild(pre);
      log.appendChild(d);
    }
    log.scrollTop = log.scrollHeight;
  }
  function addPlugins(plugins) {
    if (!plugins || !plugins.length) return;
    for (const p of plugins) {
      const d = document.createElement('div');
      d.className = 'code';
      const cap = document.createElement('span');
      cap.className = 'cap';
      cap.textContent = 'plugin authored · ' + (p.name || 'policy') + ' · persists + fires on every set, 0 tokens';
      const pre = document.createElement('pre');
      pre.textContent = p.source || '';
      d.appendChild(cap);
      d.appendChild(pre);
      log.appendChild(d);
    }
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    add('me', message);
    input.value = '';
    btn.disabled = true;
    const thinking = add('coach', '…');
    try {
      const res = await fetch(AGENT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, mode }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        thinking.remove();
        add('err', 'Error: ' + (data.error || res.status));
      } else {
        thinking.textContent = data.reply || '(no reply)';
        addCode(data.code);
        addPlugins(data.plugins);
        addTools(data.toolsUsed);
        addUsage(data.usageIn, data.usageOut);
      }
    } catch (err) {
      thinking.remove();
      add('err', 'Network error: ' + err.message);
    } finally {
      btn.disabled = false;
      input.focus();
    }
    log.scrollTop = log.scrollHeight;
  });
</script>
</body>
</html>`;
}
