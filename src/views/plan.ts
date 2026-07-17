import type { State, SessionRow, Lift, PrescribedDay } from "../server";
import type { PluginSummary } from "../training";
import { renderHead, renderHeader } from "./shared";

/**
 * Server-rendered /plan — the gym reference page (design-refresh: today-first reskin).
 *
 * Same data as before (renderPlan(data), state, recentSessions, today, plugins) — this is a reskin +
 * reprioritize, not a data change. "Today" is the one accent-bordered hero; weights are the loudest
 * value per row; a marker CTA drops the lifter straight into /session. Long prose (status paragraph,
 * injury sentences, goal sentence) is intentionally dropped per the "no full-stop sentences" rule —
 * the data it summarized lives in the structured sections below.
 */
export function renderPlan(data: { state: State; recentSessions: SessionRow[]; today: number; plugins?: PluginSummary[] }): string {
	const { state, recentSessions, today } = data;
	const plugins = data.plugins ?? [];
	const { lifter, program } = state;
	const days = program.days;
	const todayDay = days[today];
	// Upcoming days in rotation order after today (wraps).
	const upcoming: PrescribedDay[] = [];
	for (let k = 1; k < days.length; k++) upcoming.push(days[(today + k) % days.length]);

	const css = `
  body { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
  .main { padding: 20px; }
  .lifter { font-family: var(--ui); font-size: 12px; color: var(--faint); }
  .block { font-family: var(--ui); font-size: 12px; color: var(--sub); margin-top: 2px; }

  .hero { border: 1px solid var(--accent); margin-top: 22px; padding: 20px; }
  .hero-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .eyebrow { font-family: var(--ui); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--accent); }
  .hero-tag { font-family: var(--ui); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
  .focus { font-family: var(--display); font-size: 34px; font-weight: 900; letter-spacing: -0.02em; line-height: 1; }
  .hero-lifts { margin-top: 20px; }
  .hlift { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); }
  .hlift .hname { font-family: var(--display); font-weight: 600; font-size: 15px; }
  .hlift .hsub { font-family: var(--ui); font-size: 11px; color: var(--faint); margin-top: 2px; }
  .hlift .hval { text-align: right; font-family: var(--ui); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .hlift .hval .big { font-size: 24px; font-weight: 600; color: var(--ink); }
  .hlift .hval .unit { font-size: 11px; color: var(--faint); }

  a.start { font-size: 16px; padding: 16px; margin-top: 16px; text-decoration: none; }
  a.start:hover { color: var(--bg); }

  .slabel { font-family: var(--ui); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--faint); margin: 28px 0 12px; }
  .box { border: 1px solid var(--line); padding: 4px 16px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); font-family: var(--ui); font-size: 13px; font-variant-numeric: tabular-nums; }
  .row:last-child { border-bottom: none; }
  .row .rname { color: var(--ink); font-weight: 500; }
  .row .rname .rsub { display: block; color: var(--faint); font-size: 11px; font-weight: 400; margin-top: 3px; }
  .row .goal { color: var(--sub); white-space: nowrap; }
  .row .goal b { color: var(--accent); font-weight: 500; }
  .row .date { color: var(--faint); white-space: nowrap; }
  .row .dfocus { font-family: var(--display); font-weight: 600; font-size: 14px; color: var(--ink); }
  .row .dday { color: var(--faint); }

  .policy { border: 1px dashed var(--line-dash); padding: 14px 16px; font-family: var(--ui); font-size: 12px; color: var(--sub); }
  .policy + .policy { margin-top: 8px; }
  .policy .pname { color: var(--ink); }
  .policy .zero { color: var(--live); }
  .empty { font-family: var(--ui); font-size: 12px; color: var(--faint); }`;

	const heroTag = todayDay ? `<span class="hero-tag">${esc(todayDay.day)}</span>` : "";
	return `${renderHead("plan", css)}
<body>
  ${renderHeader("plan")}
  <div class="main">
    <div class="lifter">${esc(lifter.name)} · ${esc(lifter.height)} · ${lifter.bodyweight} lb</div>
    <div class="block">${esc(program.phase)} · week <span class="hl">${program.weekIndex}</span></div>

    ${
			todayDay
				? `<div class="hero">
      <div class="hero-top"><span class="eyebrow">today</span>${heroTag}</div>
      <div class="focus">${esc(todayDay.focus)}</div>
      <div class="hero-lifts">${todayDay.lifts.map(renderHeroLift).join("")}</div>
    </div>
    <a class="cta start" href="/session">START SESSION <span>&rarr;</span></a>`
				: `<div class="box" style="margin-top:22px"><div class="row"><span class="empty">No program set.</span></div></div>`
		}

    <div class="slabel">main lifts · goal</div>
    <div class="box">
      ${lifter.mains
				.map(
					(m) => `<div class="row"><span class="rname">${esc(m.name)}</span><span class="goal">${m.rebuildOpener} &rarr; <b>${m.goal3RM}</b></span></div>`,
				)
				.join("")}
    </div>

    ${
			plugins.length
				? `<div class="slabel">active policy</div>
    ${plugins.map(renderPolicy).join("")}`
				: ""
		}

    ${
			upcoming.length
				? `<div class="slabel">coming up</div>
    <div class="box">
      ${upcoming
				.map((d) => `<div class="row"><span class="dfocus">${esc(d.focus)}</span><span class="dday">${esc(d.day)}</span></div>`)
				.join("")}
    </div>`
				: ""
		}

    <div class="slabel">recent</div>
    ${
			recentSessions.length
				? `<div class="box">${recentSessions.map(renderSession).join("")}</div>`
				: `<div class="box"><div class="row"><span class="empty">No logged sessions yet.</span></div></div>`
		}
  </div>
</body>
</html>`;
}

/** One prescribed lift in the TODAY hero: name + scheme sub on the left, weight as the big value right. */
function renderHeroLift(l: Lift): string {
	let val: string;
	let scheme: string;
	if (l.kind === "rounds") {
		val = `<span class="big">${l.sets}</span> <span class="unit">rounds</span>`;
		scheme = `${l.sets} rounds`;
	} else if (l.weight != null) {
		val = `<span class="big">${l.weight}</span> <span class="unit">lb${l.perSide ? " /side" : ""}</span>`;
		scheme = `${l.sets} × ${l.reps}`;
	} else {
		val = `<span class="big">BW</span>`;
		scheme = `${l.sets} × ${l.reps}${l.perSide ? " /side" : ""}`;
	}
	return `<div class="hlift">
    <div><div class="hname">${esc(l.exercise)}</div><div class="hsub">${scheme}</div></div>
    <div class="hval">${val}</div>
  </div>`;
}

/** A saved plugin as a dashed policy row — "name vN · runs every set · 0 tokens" (0 in green). */
function renderPolicy(p: PluginSummary): string {
	const badge = p.enabled ? "runs every set" : "disabled";
	return `<div class="policy"><span class="pname">${esc(p.name)} v${p.version}</span> · ${esc(badge)} · <span class="zero">0 tokens</span></div>`;
}

function renderSession(s: SessionRow): string {
	let label = s.status;
	let summary = "";
	try {
		const a = JSON.parse(s.actuals) as { focus?: string; summary?: string; week?: number; day?: string };
		const wk = a.week ? `wk ${a.week}` : "";
		const parts = [wk, a.day, a.focus].filter(Boolean).join(" · ");
		label = parts || s.status;
		summary = a.summary ?? "";
	} catch {
		/* leave defaults */
	}
	const sub = summary ? `<span class="rsub">${esc(summary)}</span>` : "";
	return `<div class="row"><span class="rname">${esc(label)}${sub}</span><span class="date">${esc(s.date)}</span></div>`;
}

function esc(s: string): string {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
