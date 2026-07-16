import { renderHead, renderHeader } from "./shared";
import { AVATAR_DATA_URI } from "./avatar";

/**
 * Server-rendered `/` — the landing route (design-refresh).
 *
 * Shared header (no active nav item), the pixel avatar in a hairline frame, the wordmark with its
 * marker accent rule, and four hard-line entry rows into the app. No tagline, no sentences — labels
 * and data only, per HANDOFF §4.1.
 */
export function renderLanding(): string {
	const css = `
  body { min-height: 100vh; display: flex; flex-direction: column; }
  .land { padding: 32px 20px calc(20px + env(safe-area-inset-bottom)); flex: 1; display: flex; flex-direction: column; }
  .avatar-frame { border: 1px solid var(--line); padding: 18px; display: flex; justify-content: center; margin-bottom: 24px; }
  .avatar-frame img { width: 160px; height: 160px; image-rendering: pixelated; display: block; }
  .land .mark { font-family: var(--display); font-weight: 900; font-size: 60px; letter-spacing: -0.03em; line-height: 0.9; }
  .land .rule { width: 56px; height: 3px; background: var(--marker); margin-top: 16px; }
  .entries { margin-top: auto; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
  .entry { display: flex; align-items: center; justify-content: space-between; padding: 20px 4px; border-bottom: 1px solid var(--line); color: var(--ink); }
  .entry:hover { color: var(--ink); }
  .entry .label { font-family: var(--display); font-weight: 700; font-size: 19px; }
  .entry .desc { font-family: var(--mono); font-size: 11px; color: var(--faint); margin-top: 2px; }
  .entry .arrow { font-family: var(--mono); color: var(--accent); }
  .entry.faint { padding: 16px 4px; color: var(--faint); font-family: var(--mono); font-size: 12px; }
  .entry.faint:hover { color: var(--marker); }`;

	return `${renderHead("today", css)}
<body>
  ${renderHeader("")}
  <div class="land">
    <div class="avatar-frame"><img src="${AVATAR_DATA_URI}" alt="liftty" width="160" height="160" /></div>
    <div class="mark">liftty</div>
    <div class="rule"></div>
    <div class="entries">
      <a class="entry" href="/plan">
        <div><div class="label">Plan</div><div class="desc">today · what's next</div></div>
        <span class="arrow">&rarr;</span>
      </a>
      <a class="entry" href="/session">
        <div><div class="label">Session</div><div class="desc">log sets live</div></div>
        <span class="arrow">&rarr;</span>
      </a>
      <a class="entry" href="/chat">
        <div><div class="label">Chat</div><div class="desc">ask the coach</div></div>
        <span class="arrow">&rarr;</span>
      </a>
      <a class="entry faint" href="/flow">
        <span>flow · how it runs</span><span>&rarr;</span>
      </a>
    </div>
  </div>
</body>
</html>`;
}
