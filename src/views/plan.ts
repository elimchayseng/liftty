import type { State, SessionRow, Lift, PrescribedDay } from "../server";

/**
 * Server-rendered /plan — the gym reference page. Mobile-first, dark, big type,
 * "today" (first program day for the demo) surfaced on top. No framework, no build step.
 */
export function renderPlan(data: { state: State; recentSessions: SessionRow[] }): string {
	const { state, recentSessions } = data;
	const { lifter, program } = state;
	const today = program.days[0];
	const rest = program.days.slice(1);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>liftty · plan</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b0d10; color: #e8eaed;
    padding: max(16px, env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom));
    max-width: 640px; margin: 0 auto;
  }
  a { color: inherit; }
  .brand { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
  .brand h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; }
  .brand .dot { color: #f6821f; }
  .sub { color: #9aa0a6; font-size: 14px; margin-bottom: 20px; }
  .card { background: #14171c; border: 1px solid #232830; border-radius: 14px; padding: 16px; margin-bottom: 14px; }
  .card.today { border-color: #f6821f; box-shadow: 0 0 0 1px #f6821f33; }
  .eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; font-weight: 700; color: #f6821f; margin-bottom: 8px; }
  .day-focus { font-size: 22px; font-weight: 700; margin-bottom: 2px; }
  .day-label { color: #9aa0a6; font-size: 13px; margin-bottom: 14px; }
  .lift { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 10px 0; border-top: 1px solid #232830; }
  .lift:first-of-type { border-top: none; }
  .lift .name { font-weight: 600; }
  .lift .note { display: block; color: #9aa0a6; font-size: 12px; font-weight: 400; margin-top: 2px; }
  .lift .rx { font-variant-numeric: tabular-nums; white-space: nowrap; color: #cfd3d8; }
  .lift .rx b { color: #fff; font-size: 18px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .stat { background: #0f1216; border: 1px solid #232830; border-radius: 10px; padding: 10px; text-align: center; }
  .stat .k { display: block; font-size: 11px; color: #9aa0a6; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .row { display: flex; justify-content: space-between; font-size: 14px; padding: 6px 0; color: #cfd3d8; }
  .muted { color: #9aa0a6; font-size: 14px; }
  h2.section { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0a6; margin: 24px 0 10px; }
</style>
</head>
<body>
  <div class="brand"><h1>liftty<span class="dot">.</span></h1></div>
  <div class="sub">${esc(program.phase)} · week ${program.weekIndex} · ${esc(program.goal)}</div>

  ${today ? renderDayCard(today, true) : `<div class="card muted">No program set.</div>`}

  <h2 class="section">Training maxes</h2>
  <div class="card">
    <div class="grid">
      ${Object.entries(lifter.trainingMaxes)
				.map(([k, v]) => `<div class="stat"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`)
				.join("")}
    </div>
    <div class="row" style="margin-top:12px"><span class="muted">Bodyweight</span><span>${lifter.bodyweight ?? "—"} lb</span></div>
    ${lifter.injuries.length ? `<div class="row"><span class="muted">Injuries</span><span>${lifter.injuries.map(esc).join(", ")}</span></div>` : ""}
  </div>

  <h2 class="section">Rest of the week</h2>
  ${rest.map((d) => renderDayCard(d, false)).join("")}

  <h2 class="section">Recent sessions</h2>
  ${
		recentSessions.length
			? recentSessions
					.map(
						(s) =>
							`<div class="card"><div class="row"><span>${esc(s.date)}</span><span class="muted">${esc(s.status)}</span></div></div>`,
					)
					.join("")
			: `<div class="card muted">No logged sessions yet — they'll appear here once you train (M2/M4).</div>`
	}
</body>
</html>`;
}

function renderDayCard(day: PrescribedDay, isToday: boolean): string {
	return `<div class="card${isToday ? " today" : ""}">
    ${isToday ? `<div class="eyebrow">Today</div>` : ""}
    <div class="day-focus">${esc(day.focus)}</div>
    <div class="day-label">${esc(day.day)}</div>
    ${day.lifts.map(renderLift).join("")}
  </div>`;
}

function renderLift(l: Lift): string {
	const rx = l.weight
		? `<span class="rx">${l.sets}×${l.reps} · <b>${l.weight}</b> lb</span>`
		: `<span class="rx"><b>${l.sets}×${l.reps}</b></span>`;
	return `<div class="lift">
    <span class="name">${esc(l.exercise)}${l.note ? `<span class="note">${esc(l.note)}</span>` : ""}</span>
    ${rx}
  </div>`;
}

function esc(s: string): string {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
