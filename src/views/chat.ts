/**
 * Server-rendered /chat — a minimal coach chat client so M2 is testable in a browser.
 * One input, a running transcript, and a badge showing which typed tools each turn used.
 * No framework: inline JS POSTs to the same agent endpoint the API uses.
 */
export function renderChat(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>liftty · chat</title>
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
  header a { margin-left: auto; color: #9aa0a6; font-size: 14px; text-decoration: none; }
  #log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 4px; }
  .msg { max-width: 88%; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; }
  .me { align-self: flex-end; background: #1f6feb; color: #fff; border-bottom-right-radius: 4px; }
  .coach { align-self: flex-start; background: #14171c; border: 1px solid #232830; border-bottom-left-radius: 4px; }
  .tools { align-self: flex-start; font-size: 11px; color: #9aa0a6; margin-top: -6px; padding-left: 6px; }
  .tools b { color: #f6821f; font-weight: 600; }
  .code { align-self: flex-start; max-width: 88%; margin-top: -4px; background: #0e1116; border: 1px solid #232830; border-left: 2px solid #f6821f; border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
  .code .cap { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; display: block; margin-bottom: 6px; }
  .code pre { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd2d9; white-space: pre; }
  .err { align-self: flex-start; color: #ff6b6b; font-size: 13px; }
  .seg { margin-left: auto; display: flex; border: 1px solid #232830; border-radius: 8px; overflow: hidden; }
  .seg button { background: #14171c; color: #9aa0a6; border: none; border-radius: 0; padding: 5px 10px; font-size: 12px; font-weight: 600; }
  .seg button.on { background: #f6821f; color: #0b0d10; }
  form { display: flex; gap: 8px; padding-top: 10px; }
  input { flex: 1; background: #14171c; border: 1px solid #232830; border-radius: 10px; padding: 12px 14px; color: #e8eaed; font-size: 16px; }
  input:focus { outline: none; border-color: #f6821f; }
  button { background: #f6821f; color: #0b0d10; border: none; border-radius: 10px; padding: 0 18px; font-weight: 700; font-size: 15px; }
  button:disabled { opacity: 0.5; }
  .hint { color: #6b7280; font-size: 12px; padding: 6px 4px 0; }
</style>
</head>
<body>
  <header>
    <h1>liftty<span class="dot">.</span> chat</h1>
    <div class="seg" id="seg" title="Code Mode: one snippet vs. Tools: one call at a time">
      <button id="cm" class="on" type="button">Code Mode</button>
      <button id="tm" type="button">Tools</button>
    </div>
    <a href="/plan" style="margin-left:10px">plan →</a>
  </header>
  <div id="log">
    <div class="msg coach">Coach here. Ask about your program or history — try "how's my front squat trending?" or "log my squats: 5x225, 5x225, 8x225 — did I PR? bump next week's front squat 5lb if so."</div>
  </div>
  <form id="f">
    <input id="m" autocomplete="off" placeholder="Message the coach…" autofocus />
    <button id="b" type="submit">Send</button>
  </form>
  <div class="hint" id="hint">Code Mode (M3): the coach writes one JS snippet against <code>training.*</code>, run in a sandbox. Toggle to Tools to see the M2 baseline — same typed API, called one at a time.</div>

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
    d.className = 'msg ' + cls;
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
