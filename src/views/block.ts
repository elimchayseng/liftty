import type { BlockView, BlockWeek, BlockCell } from "../server";
import { renderHead, renderHeader, esc } from "./shared";

/**
 * Server-rendered /block — the whole committed block in one view.
 *
 * This is the page that answers "what's next, what have I done, and how do I move on". /plan stays
 * the today-first gym reference; /block is the map: every week × day, completed cells carrying their
 * own numbers, the current week highlighted, and the two writes the app was missing — pick the day
 * you're actually doing, and advance the block when you say so.
 *
 * No client JS. Actions are plain form POSTs back to /block answered with a 303, because the natural
 * end state of picking a day is a navigation to /session anyway. That buys correct back-button
 * behaviour and no flash of stale content for free, which fetch + reload would have to re-earn.
 */
export function renderBlock(data: BlockView, err?: string | null): string {
	const css = `
  body { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
  .main { padding: 20px; }
  .blockname { font-family: var(--display); font-weight: 900; font-size: 26px; letter-spacing: -0.02em; line-height: 1.05; }
  .blockmeta { font-family: var(--ui); font-size: 12px; color: var(--faint); margin-top: 6px; }

  .err { border-left: 2px solid #ff6b6b; background: rgba(255,107,107,0.06); color: #ff6b6b; font-family: var(--ui); font-size: 12px; padding: 10px 12px; margin-top: 18px; }
  .lock { border: 1px dashed var(--line-dash); color: var(--marker); font-family: var(--ui); font-size: 12px; padding: 12px 14px; margin-top: 18px; }
  .lock a { color: var(--marker); text-decoration: underline; }

  .wk { margin-top: 26px; border: 1px solid var(--line); padding: 14px; }
  .wk.current { border-color: var(--accent); }
  .wk.done { border-style: dashed; }
  .wk-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .wk-n { font-family: var(--ui); font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--faint); }
  .wk.current .wk-n { color: var(--accent); }
  .wk-tag { font-family: var(--ui); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--bg); background: var(--marker); padding: 1px 6px; margin-left: 6px; }
  .wk-state { font-family: var(--ui); font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }

  .cells { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); }
  /* A selectable cell is a <button> inside its own <form>, so the FORM is the grid item. Make it a
     stretching flex container, or the button sizes to its content and the grid's line colour shows
     through the gap underneath it. */
  .cells > form.act { display: flex; background: var(--bg); }
  .cells > form.act > .cell { flex: 1; }
  .cell { background: var(--bg); padding: 12px 10px; min-height: 96px; display: flex; flex-direction: column; gap: 4px; text-align: left; font: inherit; color: var(--ink); border: none; width: 100%; }
  button.cell { cursor: pointer; }
  button.cell:hover { background: rgba(255,255,255,0.04); }
  .cell .cday { font-family: var(--ui); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); display: flex; justify-content: space-between; gap: 6px; }
  .cell .cfocus { font-family: var(--display); font-weight: 600; font-size: 14px; line-height: 1.15; }
  .cell .cbrief { font-family: var(--ui); font-size: 11px; color: var(--sub); font-variant-numeric: tabular-nums; }
  .cell .cstats { font-family: var(--ui); font-size: 11px; color: var(--live); font-variant-numeric: tabular-nums; margin-top: auto; }
  .cell .cdate { font-family: var(--ui); font-size: 10px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .cell .ctop { font-family: var(--ui); font-size: 10px; color: var(--faint); font-variant-numeric: tabular-nums; }

  .cell.done { border-left: 2px solid var(--live); }
  .cell.next { border-left: 2px solid var(--accent); }
  .cell.next .cday { color: var(--accent); }
  .cell.active { border-left: 2px solid var(--marker); }
  .cell.active .cday { color: var(--marker); }
  .cell.future { opacity: 0.55; }
  .cell .mark { color: var(--live); }

  .wk-act { margin-top: 12px; }
  button.cta { width: 100%; font-size: 14px; letter-spacing: 0.08em; padding: 14px; }
  button.ghost { width: 100%; background: transparent; color: var(--sub); border: 1px solid var(--line-strong); font-family: var(--display); font-weight: 800; font-size: 12px; letter-spacing: 0.08em; padding: 11px; cursor: pointer; }
  button.ghost:hover { border-color: var(--accent); color: var(--ink); }
  .empty { font-family: var(--ui); font-size: 12px; color: var(--faint); }`;

	const errStrip = err ? `<div class="err">${esc(err)}</div>` : "";
	const lockNote = data.locked
		? `<div class="lock">${data.activeSession?.sets ?? 0} set${data.activeSession?.sets === 1 ? "" : "s"} logged on ${esc(
				data.activeSession?.dayLabel || data.activeSession?.day || "the open session",
			)} — <a href="/session">finish the session</a> to switch days or change week.</div>`
		: "";
	const beyond = data.beyondBlock
		? `<div class="lock">week ${data.currentWeek} is past the end of this ${data.totalWeeks}-week block — pick a week below to drop back into the plan.</div>`
		: "";

	return `${renderHead("block", css)}
<body>
  ${renderHeader("block")}
  <div class="main">
    <div class="blockname">${esc(data.name)}</div>
    <div class="blockmeta">week <span class="hl">${data.currentWeek}</span> of ${data.totalWeeks}${
			data.weekComplete ? " · this week is complete" : ""
		}</div>
    ${errStrip}${beyond}${lockNote}
    ${data.weeks.map((w) => renderWeek(w, data)).join("")}
  </div>
</body>
</html>`;
}

/** One week row: header + the three day cells + whatever action that week offers. */
function renderWeek(w: BlockWeek, data: BlockView): string {
	const done = w.cells.filter((c) => c.status === "done").length;
	const past = w.week < data.currentWeek;
	const state = w.complete
		? "complete"
		: done
			? `${done}/${w.cells.length} done`
			: w.current
				? `0/${w.cells.length} done`
				: past
					? "not logged" // a week we moved past without training it — "upcoming" would be a lie
					: "upcoming";
	const tag = w.label ? `<span class="wk-tag">${esc(w.label)}</span>` : "";
	return `<div class="wk${w.current ? " current" : ""}${w.complete && !w.current ? " done" : ""}">
    <div class="wk-top">
      <span class="wk-n">week ${w.week}${tag}</span>
      <span class="wk-state">${esc(state)}</span>
    </div>
    <div class="cells">${w.cells.map((c) => renderCell(c, w, data)).join("")}</div>
    ${renderWeekAction(w, data)}
  </div>`;
}

/**
 * One day cell. Cells in the CURRENT week are submit buttons that open that session; everywhere else
 * (and while a session is locked) they render inert, so we never show an affordance that would bounce.
 */
function renderCell(c: BlockCell, w: BlockWeek, data: BlockView): string {
	// U+FE0E forces text presentation — without it the check renders as a colour emoji on iOS/macOS and
	// breaks out of the monochrome palette.
	const tick = c.status === "done" ? `<span class="mark">✓︎</span>` : c.status === "active" ? `<span>●︎</span>` : c.status === "next" ? `<span>←</span>` : "";
	const stats = c.stats
		? `<div class="cstats">${c.stats.sets} set${c.stats.sets === 1 ? "" : "s"}${c.stats.volume > 0 ? ` · ${c.stats.volume.toLocaleString("en-US")} lb` : ""}</div>
       ${c.stats.top[0] ? `<div class="ctop">top ${esc(c.stats.top[0].exercise)} ${c.stats.top[0].reps}×${c.stats.top[0].weight || "BW"}</div>` : ""}
       <div class="cdate">${esc(c.date ?? "")}${c.extra ? ` · +${c.extra} more` : ""}</div>`
		: "";
	const inner = `<div class="cday"><span>${esc(c.day)}</span>${tick}</div>
    <div class="cfocus">${esc(c.focus)}</div>
    <div class="cbrief">${esc(c.brief)}</div>
    ${stats}`;

	const selectable = w.current && !data.locked && c.status !== "active";
	if (!selectable) return `<div class="cell ${c.status}">${inner}</div>`;
	return `<form class="act" method="post" action="/block">
    <input type="hidden" name="intent" value="day" />
    <input type="hidden" name="day" value="${esc(c.day)}" />
    <button class="cell ${c.status}" type="submit">${inner}</button>
  </form>`;
}

/**
 * The week's action. The current week offers ADVANCE once every day is logged (never automatically —
 * moving the block is always the lifter's call); every other week offers a quiet jump, which doubles
 * as the way back without inventing a second concept.
 */
function renderWeekAction(w: BlockWeek, data: BlockView): string {
	if (data.locked) return "";
	if (w.current) {
		if (!data.weekComplete || w.week >= data.totalWeeks) return "";
		return `<div class="wk-act"><form class="act" method="post" action="/block">
      <input type="hidden" name="intent" value="week" />
      <input type="hidden" name="week" value="${w.week + 1}" />
      <button class="cta" type="submit">ADVANCE TO WEEK ${w.week + 1} &rarr;</button>
    </form></div>`;
	}
	return `<div class="wk-act"><form class="act" method="post" action="/block">
    <input type="hidden" name="intent" value="week" />
    <input type="hidden" name="week" value="${w.week}" />
    <button class="ghost" type="submit">GO TO WEEK ${w.week}</button>
  </form></div>`;
}
