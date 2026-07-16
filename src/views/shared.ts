/**
 * Shared chrome for the server-rendered pages (design-refresh).
 *
 * One visual language, extending /flow: dark ground, hard hairline boxes (border-radius:0 everywhere,
 * no shadows), IBM Plex Mono for data + Archivo for display, one yellow highlighter per screen, a
 * single Cloudflare-orange accent. `renderHead()` emits the doctype→</head> block (fonts + reset +
 * design tokens); `renderHeader()` emits the wordmark + right-slot (nav / live / toggle) that sits
 * atop every page. /flow is the reference and is not rebuilt — it only gains a nav link.
 */

/** Design tokens — single source of truth, mirrored from HANDOFF §2. */
export const TOKENS = {
	bg: "#0a0a0b",
	ink: "#f5f4ef",
	sub: "#a8a79f",
	faint: "#6a6a66",
	line: "rgba(255,255,255,0.13)",
	lineStrong: "rgba(255,255,255,0.22)",
	lineDash: "rgba(255,255,255,0.28)",
	marker: "#F2CD46",
	accent: "#F6821F",
	live: "#3fb950",
} as const;

/** Nav order (also the sitemap). Landing passes active:"" so nothing is underlined. */
const NAV: { label: string; href: string }[] = [
	{ label: "plan", href: "/plan" },
	{ label: "session", href: "/session" },
	{ label: "chat", href: "/chat" },
	{ label: "flow", href: "/flow" },
];

/**
 * `<!doctype …>` through `</head>`. Loads Archivo + IBM Plex Mono, sets the tokens as CSS custom
 * properties, applies the hard-line reset (radius:0, no shadows), and appends any page-specific CSS.
 */
export function renderHead(subtitle: string, extraCss = ""): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>liftty · ${subtitle}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --bg: ${TOKENS.bg};
    --ink: ${TOKENS.ink};
    --sub: ${TOKENS.sub};
    --faint: ${TOKENS.faint};
    --line: ${TOKENS.line};
    --line-strong: ${TOKENS.lineStrong};
    --line-dash: ${TOKENS.lineDash};
    --marker: ${TOKENS.marker};
    --accent: ${TOKENS.accent};
    --live: ${TOKENS.live};
    --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    --display: 'Archivo', -apple-system, BlinkMacSystemFont, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; border-radius: 0; }
  ::selection { background: var(--marker); color: var(--bg); }
  html, body { background: var(--bg); }
  body {
    font: 16px/1.5 var(--display);
    color: var(--ink);
    max-width: 640px; margin: 0 auto;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--ink); text-decoration: none; }
  a:hover { color: var(--marker); }

  /* --- shared header --- */
  .hdr { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid var(--line); }
  .wordmark { font-family: var(--display); font-weight: 900; font-size: 22px; letter-spacing: -0.02em; color: var(--ink); display: flex; align-items: center; gap: 7px; }
  .wordmark:hover { color: var(--ink); }
  .tick { width: 7px; height: 7px; background: var(--accent); display: inline-block; margin-bottom: -2px; }
  nav.nav { display: flex; gap: 16px; font-family: var(--mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
  nav.nav a { color: var(--faint); }
  nav.nav a:hover { color: var(--marker); }
  nav.nav a.on { color: var(--ink); border-bottom: 2px solid var(--marker); padding-bottom: 2px; }

  /* --- shared bits --- */
  .hl { background: var(--marker); color: var(--bg); padding: 0 6px; }
  .cta { display: flex; align-items: center; justify-content: center; gap: 10px; background: var(--marker); color: var(--bg); font-family: var(--display); font-weight: 800; border: none; cursor: pointer; }
  .section-label { font-family: var(--mono); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--faint); }
${extraCss}
</style>
</head>`;
}

/**
 * Shared header. `active` underlines the matching nav item (""/absent → landing, nothing underlined).
 * `right` overrides the default nav for pages whose top-right is not navigation — /session (live
 * indicator) and /chat (mode toggle) pass their own markup.
 */
export function renderHeader(active = "", right?: string): string {
	const nav = `<nav class="nav">${NAV.map(
		(n) => `<a href="${n.href}"${n.label === active ? ' class="on"' : ""}>${n.label}</a>`,
	).join("")}</nav>`;
	return `<header class="hdr">
    <a class="wordmark" href="/">liftty<span class="tick"></span></a>
    ${right ?? nav}
  </header>`;
}
