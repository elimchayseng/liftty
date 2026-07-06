import type { State, SessionRow, Lift, PrescribedDay } from "../server";

/**
 * Server-rendered /plan — the gym reference page. Mobile-first, dark, big type.
 * "Today" advances as sessions are logged (the day after the most recent focus).
 * Data is real (derived from prev-coach-handoff.md + workout-log.csv).
 */
export function renderPlan(data: { state: State; recentSessions: SessionRow[]; today: number }): string {
	const { state, recentSessions, today } = data;
	const { lifter, program } = state;
	const days = program.days;
	const todayDay = days[today];
	// Upcoming days in rotation order after today (wraps).
	const upcoming: PrescribedDay[] = [];
	for (let k = 1; k < days.length; k++) upcoming.push(days[(today + k) % days.length]);

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
  .brand { display: flex; align-items: baseline; gap: 10px; }
  .brand h1 { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; }
  .brand .dot { color: #f6821f; }
  .who { color: #9aa0a6; font-size: 13px; margin: 2px 0 14px; }
  .sub { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .goal { color: #9aa0a6; font-size: 13px; margin-bottom: 16px; }
  .card { background: #14171c; border: 1px solid #232830; border-radius: 14px; padding: 16px; margin-bottom: 14px; }
  .card.today { border-color: #f6821f; box-shadow: 0 0 0 1px #f6821f33; }
  .banner { background: #1c1408; border: 1px solid #7a5a1e; border-radius: 12px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; color: #f0d9a8; }
  .banner b { color: #f6b545; }
  .eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; font-weight: 700; color: #f6821f; margin-bottom: 8px; }
  .day-focus { font-size: 22px; font-weight: 700; margin-bottom: 2px; }
  .day-label { color: #9aa0a6; font-size: 13px; margin-bottom: 14px; }
  .lift { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 10px 0; border-top: 1px solid #232830; }
  .lift:first-of-type { border-top: none; }
  .lift .name { font-weight: 600; }
  .lift .note { display: block; color: #9aa0a6; font-size: 12px; font-weight: 400; margin-top: 2px; }
  .lift .rx { font-variant-numeric: tabular-nums; white-space: nowrap; color: #cfd3d8; text-align: right; }
  .lift .rx b { color: #fff; font-size: 18px; }
  .lift .rx small { color: #9aa0a6; }
  .main { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 12px 0; border-top: 1px solid #232830; }
  .main:first-of-type { border-top: none; }
  .main .mname { font-weight: 700; }
  .main .goal3 { text-align: right; font-variant-numeric: tabular-nums; }
  .main .goal3 b { color: #f6821f; }
  .main .meta { grid-column: 1 / -1; color: #9aa0a6; font-size: 12px; }
  .row { display: flex; justify-content: space-between; font-size: 14px; padding: 6px 0; color: #cfd3d8; }
  .muted { color: #9aa0a6; font-size: 14px; }
  .inj { font-size: 13px; color: #cfd3d8; padding: 8px 0; border-top: 1px solid #232830; }
  .inj:first-of-type { border-top: none; }
  .sess .top { display: flex; justify-content: space-between; font-weight: 600; }
  .sess .sum { color: #9aa0a6; font-size: 13px; margin-top: 4px; }
  .sess .date { color: #9aa0a6; font-variant-numeric: tabular-nums; font-weight: 400; }
  h2.section { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #9aa0a6; margin: 24px 0 10px; }
</style>
</head>
<body>
  <div class="brand"><h1>liftty<span class="dot">.</span></h1></div>
  <div class="who">${esc(lifter.name)} · ${esc(lifter.height)} · ${lifter.bodyweight} lb · ${esc(lifter.diet)}</div>

  <div class="sub">${esc(program.phase)} · week ${program.weekIndex}</div>
  <div class="goal">${esc(program.goal)}</div>

  ${lifter.status ? `<div class="banner"><b>Status:</b> ${esc(lifter.status)}</div>` : ""}

  ${state.activeSession && state.activeSession.loggedSets.length ? renderActive(state.activeSession) : ""}

  ${todayDay ? renderDayCard(todayDay, true) : `<div class="card muted">No program set.</div>`}

  <h2 class="section">Main lifts — where we're headed</h2>
  <div class="card">
    ${lifter.mains
			.map(
				(m) => `<div class="main">
        <span class="mname">${esc(m.name)}</span>
        <span class="goal3">goal 3RM <b>${m.goal3RM}</b></span>
        <span class="meta">Dec best: ${esc(m.decemberBest)} · rebuild opener ${m.rebuildOpener}</span>
      </div>`,
			)
			.join("")}
  </div>

  <h2 class="section">Injury notes</h2>
  <div class="card">
    ${lifter.injuries.map((i) => `<div class="inj">${esc(i)}</div>`).join("")}
  </div>

  <h2 class="section">Coming up</h2>
  ${upcoming.map((d) => renderDayCard(d, false)).join("")}

  <h2 class="section">Recent sessions <span class="muted">(Dec–Jan block)</span></h2>
  ${
		recentSessions.length
			? recentSessions.map(renderSession).join("")
			: `<div class="card muted">No logged sessions yet.</div>`
	}
</body>
</html>`;
}

function renderActive(a: NonNullable<State["activeSession"]>): string {
	return `<div class="card today">
    <div class="eyebrow">In progress · ${esc(a.day)}</div>
    ${a.loggedSets
			.map(
				(s) =>
					`<div class="lift"><span class="name">${esc(s.exercise)}</span><span class="rx">${s.reps} reps · <b>${s.weight || "BW"}</b>${s.weight ? " <small>lb</small>" : ""}</span></div>`,
			)
			.join("")}
  </div>`;
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
	let rx: string;
	if (l.kind === "rounds") {
		rx = `<span class="rx"><b>${l.sets}</b> <small>rounds</small></span>`;
	} else if (l.weight != null) {
		rx = `<span class="rx">${l.sets}×${l.reps} · <b>${l.weight}</b> <small>lb${l.perSide ? " /side" : ""}</small></span>`;
	} else {
		rx = `<span class="rx"><b>${l.sets}×${l.reps}</b> <small>${l.perSide ? "/side" : "BW"}</small></span>`;
	}
	const noteLine = l.note ? `<span class="note">${esc(l.note)}</span>` : "";
	return `<div class="lift">
    <span class="name">${esc(l.exercise)}${noteLine}</span>
    ${rx}
  </div>`;
}

function renderSession(s: SessionRow): string {
	let label = s.status;
	let summary = "";
	try {
		const a = JSON.parse(s.actuals) as { focus?: string; summary?: string; week?: number; day?: string };
		const wk = a.week ? `Wk ${a.week}` : "";
		const parts = [wk, a.day, a.focus].filter(Boolean).join(" · ");
		label = parts || s.status;
		summary = a.summary ?? "";
	} catch {
		/* leave defaults */
	}
	return `<div class="card sess">
    <div class="top"><span>${esc(label)}</span><span class="date">${esc(s.date)}</span></div>
    ${summary ? `<div class="sum">${esc(summary)}</div>` : ""}
  </div>`;
}

function esc(s: string): string {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
