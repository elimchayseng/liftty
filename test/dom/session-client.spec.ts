import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderSession } from "../../src/views/session";

/**
 * Behavioural tests for the /session client.
 *
 * The page is a string: `renderSession()` returns HTML with ~500 lines of ES5 inlined in a <script>.
 * The main suite runs in workerd, which has neither a DOM nor `eval`, so none of this logic could be
 * executed there — and it is exactly where the reported bugs lived (weights resetting between sets,
 * the dead Finish button) plus two more the review found (a sets-chip edit eating a typed weight, an
 * offline LOG deleting the only copy of the set).
 *
 * `boot()` mounts the real markup, evaluates the real script against a fake WebSocket, and returns
 * the handful of internals the tests drive. Nothing is reimplemented: if the shipped script changes,
 * these tests change with it.
 */

type Frame = Record<string, any>;

/**
 * Listeners the booted script attaches to the shared jsdom document/window (visibilitychange,
 * pagehide). They must be torn down between tests: otherwise a later dispatch also runs every earlier
 * boot's handler, each reconnecting its own socket, and the tests measure the harness rather than the
 * page.
 */
let mounted: (() => void) | null = null;

function boot() {
	mounted?.();
	const page = renderSession();
	document.body.innerHTML = page.slice(page.indexOf("<body>") + "<body>".length, page.indexOf("</body>"));
	const src = /<script>([\s\S]*?)<\/script>/.exec(page)![1];

	const attached: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject }[] = [];
	for (const target of [document, window] as EventTarget[]) {
		const original = target.addEventListener.bind(target);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(target as any).addEventListener = (type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
			attached.push({ target, type, fn });
			return original(type, fn, opts as never);
		};
	}
	mounted = () => {
		for (const { target, type, fn } of attached) target.removeEventListener(type, fn);
		attached.length = 0;
	};

	const wire: Frame[] = [];
	const sockets: any[] = [];
	class FakeSocket {
		readyState = 0; // CONNECTING
		listeners: Record<string, Function[]> = {};
		constructor() {
			sockets.push(this);
		}
		addEventListener(type: string, fn: Function) {
			(this.listeners[type] ||= []).push(fn);
		}
		removeEventListener(type: string, fn: Function) {
			this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
		}
		send(raw: string) {
			if (this.readyState !== 1) throw new Error("send on a non-open socket");
			wire.push(JSON.parse(raw));
		}
		close() {
			this.fire("close");
		}
		/** Test control: complete the handshake. */
		open() {
			this.readyState = 1;
			this.fire("open");
		}
		/** Test control: drop the connection, as a screen lock would. */
		drop() {
			this.readyState = 3;
			this.fire("close");
		}
		fire(type: string, ev?: unknown) {
			for (const fn of this.listeners[type] || []) fn(ev);
		}
	}
	(globalThis as any).WebSocket = FakeSocket;

	// The script is an IIFE-able body; expose the internals the tests need to drive.
	const api = new Function(`
		${src}
		return {
			handle: handle,
			send: send,
			outbox: function () { return outbox; },
			drafts: function () { return drafts; },
			flushWrites: flushWrites,
		};
	`)() as {
		handle: (m: Frame) => void;
		send: (m: Frame) => boolean;
		outbox: () => Frame[];
		drafts: () => Record<string, { reps: string; weight: string }>;
		flushWrites: () => void;
	};

	return { api, wire, sockets, socket: () => sockets[sockets.length - 1] };
}

const LIFTS = [
	{ exercise: "Front Squat", sets: 4, reps: 8, weight: 125 },
	{ exercise: "RDL", sets: 3, reps: 8, weight: 115 },
];

function hello(over: Partial<Frame> = {}): Frame {
	return {
		type: "session_hello",
		day: "Front Squat",
		dayLabel: "Day A",
		week: 1,
		restSeconds: 60,
		weekDone: [],
		weekComplete: false,
		activeSession: { day: "Front Squat", dayLabel: "Day A", week: 1, loggedSets: [] },
		lifts: LIFTS,
		...over,
	};
}

/** A `cf_agent_state` broadcast for a one-lift day — what the server sends on every setState. */
function pressState(over: Partial<Frame>, loggedSets: Frame[] = []): Frame {
	const lift = { exercise: "DB Shoulder Press", sets: 4, reps: 10, weight: 40, ...over };
	return {
		type: "cf_agent_state",
		state: {
			program: { days: [{ day: "Day A", focus: "Front Squat", lifts: [lift] }] },
			activeSession: { day: "Front Squat", dayLabel: "Day A", week: 1, loggedSets },
		},
	};
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("#lifts .lift"));
const wtInput = (i = 0) => rows()[i].querySelectorAll<HTMLInputElement>(".ctl input")[1];
const repsInput = (i = 0) => rows()[i].querySelectorAll<HTMLInputElement>(".ctl input")[0];
const setsChip = (i = 0) => rows()[i].querySelectorAll<HTMLInputElement>(".chip")[0];
const bigWeight = (i = 0) => rows()[i].querySelector(".big")!.textContent;
const receipts = () => Array.from(document.querySelectorAll("#receipts .receipt, #receipts .err")).map((e) => e.textContent ?? "");

function type(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
	mounted?.();
	mounted = null;
	localStorage.clear();
	vi.useRealTimers();
});

describe("/session client — typed values are sacred", () => {
	it("prefills from the prescription on a first paint", () => {
		const { api } = boot();
		api.handle(hello());
		expect(rows()).toHaveLength(2);
		expect(wtInput().value).toBe("125");
		expect(repsInput().value).toBe("8");
	});

	// THE reported bug: the socket drops constantly on a phone and a reconnect re-sends session_hello.
	// The old client rebuilt every row from the prescription, so typed weights snapped back.
	it("keeps a typed weight across a reconnect", () => {
		const { api, socket } = boot();
		api.handle(hello());
		type(wtInput(), "140");
		socket().drop();
		api.handle(hello()); // identical hello, as a reconnect delivers
		expect(wtInput().value).toBe("140");
	});

	// Found by the review: the sets chip round-trips through the server and comes back as a scheme
	// change, which used to take the same branch as a policy weight cut and reset the weight field.
	it("does not touch the weight field when only the scheme moves", () => {
		const { api } = boot();
		api.handle(hello());
		type(wtInput(), "130");
		api.handle(hello({ lifts: [{ ...LIFTS[0], sets: 5 }, LIFTS[1]] }));
		expect(wtInput().value).toBe("130");
		expect(setsChip().value).toBe("5");
		expect(repsInput().value).toBe("8");
	});

	// …but a prescription that actually moves IS newer information than the draft, and takes its field.
	it("lets a changed prescribed weight take the weight field", () => {
		const { api } = boot();
		api.handle(hello());
		type(wtInput(), "130");
		api.handle(hello({ lifts: [{ ...LIFTS[0], weight: 100 }, LIFTS[1]] })); // policy cut after a miss
		expect(wtInput().value).toBe("100");
		expect(bigWeight()).toBe("100");
		expect(rows()[0].className).toContain("changed");
	});

	// THE reported bug, second report: change the reps chip 10 → 8 partway through a session and every
	// remaining set still logged as 10. patchLifts painted the moved prescription into the field but
	// recorded nothing, and prefill() ranks the last set logged ABOVE the prescription — so the next
	// repaint of any kind read the field back to the previous set while the chip went on showing 8.
	// The lifter saw the change hold on screen and had no reason to look at the field again.
	it("keeps a mid-session scheme change in the reps field across later repaints", () => {
		const { api, wire, socket } = boot();
		socket().open();
		api.handle(hello({ lifts: [{ exercise: "DB Shoulder Press", sets: 4, reps: 10, weight: 40 }] }));

		rows()[0].querySelector<HTMLButtonElement>(".log")!.click(); // set 1 at the prescribed 10
		const logged = [{ exercise: "DB Shoulder Press", reps: 10, weight: 40 }];
		api.handle(pressState({ reps: 10 }, logged));

		// "too heavy — I'll do 8s": the chip round-trips and comes back as a scheme change.
		const repsChip = rows()[0].querySelectorAll<HTMLInputElement>(".chip")[1];
		repsChip.value = "8";
		repsChip.dispatchEvent(new Event("change", { bubbles: true }));
		api.handle(pressState({ reps: 8 }, logged));
		expect(repsInput().value).toBe("8");

		// …and now any other repaint at all — a rest save, a policy, a reconnect.
		api.handle(pressState({ reps: 8 }, logged));
		expect(repsInput().value).toBe("8");
		expect(rows()[0].querySelectorAll<HTMLInputElement>(".chip")[1].value).toBe("8");

		rows()[0].querySelector<HTMLButtonElement>(".log")!.click();
		expect(wire.filter((f) => f.type === "log_set").slice(-1)[0].reps).toBe(8);
	});

	// Same hole, weight side: a policy cut held for exactly one repaint and then reverted to the weight
	// of the last set logged, while the big number kept showing the cut.
	it("keeps a policy weight cut in the weight field across later repaints", () => {
		const { api, wire, socket } = boot();
		socket().open();
		api.handle(hello({ lifts: [{ exercise: "DB Shoulder Press", sets: 4, reps: 10, weight: 40 }] }));

		rows()[0].querySelector<HTMLButtonElement>(".log")!.click();
		const logged = [{ exercise: "DB Shoulder Press", reps: 10, weight: 40 }];
		api.handle(pressState({ reps: 10, weight: 40 }, logged));

		api.handle(pressState({ reps: 10, weight: 30 }, logged)); // the cut
		expect(wtInput().value).toBe("30");
		api.handle(pressState({ reps: 10, weight: 30 }, logged)); // the next repaint
		expect(wtInput().value).toBe("30");
		expect(bigWeight()).toBe("30");

		rows()[0].querySelector<HTMLButtonElement>(".log")!.click();
		expect(wire.filter((f) => f.type === "log_set").slice(-1)[0].weight).toBe(30);
	});

	it("prefills the next set from the last one logged, not the prescription", () => {
		const { api } = boot();
		api.handle(hello());
		api.handle({
			type: "cf_agent_state",
			state: {
				program: { days: [{ day: "Day A", focus: "Front Squat", lifts: LIFTS }] },
				activeSession: { day: "Front Squat", dayLabel: "Day A", week: 1, loggedSets: [{ exercise: "Front Squat", reps: 5, weight: 145 }] },
			},
		});
		expect(wtInput().value).toBe("145");
		expect(repsInput().value).toBe("5");
		expect(rows()[0].querySelector(".prog")!.textContent).toBe("logged 1 / 4");
	});

	it("restores a draft after a full reload and drops it once stale", () => {
		const first = boot();
		first.api.handle(hello());
		type(wtInput(), "152");
		first.api.flushWrites();

		const second = boot(); // a fresh page, as an iOS tab discard produces
		second.api.handle(hello());
		expect(wtInput().value).toBe("152");

		// Backdate the stored draft past its TTL — a draft from a previous session is noise.
		const key = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).find((k) => k.startsWith("liftty.draft"))!;
		expect(key).toBeTruthy();
		const blob = JSON.parse(localStorage.getItem(key)!);
		blob.savedAt = Date.now() - 9 * 3600 * 1000;
		localStorage.setItem(key, JSON.stringify(blob));

		const third = boot();
		third.api.handle(hello());
		expect(wtInput().value).toBe("125"); // back to the prescription
	});

	it("rebuilds rather than patches when the day's exercise list changes", () => {
		const { api } = boot();
		api.handle(hello());
		type(wtInput(), "140");
		const firstRow = rows()[0];
		api.handle(hello({ day: "Incline Bench", dayLabel: "Day B", lifts: [{ exercise: "Incline Bench", sets: 4, reps: 8, weight: 100 }] }));
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).not.toBe(firstRow);
		expect(wtInput().value).toBe("100");
		expect(document.getElementById("focus")!.textContent).toBe("Incline Bench");
	});
});

describe("/session client — the socket is unreliable", () => {
	it("queues a frame composed while down and replays it on open", () => {
		const { api, wire, socket } = boot();
		api.handle(hello());
		expect(api.send({ type: "log_set", exercise: "Front Squat", reps: 5 })).toBe(false);
		expect(wire).toHaveLength(0);
		expect(api.outbox()).toHaveLength(1);

		socket().open();
		expect(wire.map((f) => f.type)).toEqual(["log_set"]);
		expect(api.outbox()).toHaveLength(0);
	});

	// The review's data-loss finding: the draft was deleted on a queued LOG while the outbox lived
	// only in memory, so a discarded tab lost the set with no trace.
	it("keeps the draft and persists the outbox when a LOG is only queued", () => {
		const { api } = boot();
		api.handle(hello());
		type(wtInput(), "99");
		rows()[0].querySelector<HTMLButtonElement>(".log")!.click();

		expect(api.drafts()["Front Squat"]).toEqual({ reps: "8", weight: "99" });
		api.flushWrites();
		const stored = JSON.parse(localStorage.getItem("liftty.outbox")!);
		expect(stored.frames).toHaveLength(1);
		expect(stored.frames[0]).toMatchObject({ type: "log_set", exercise: "Front Squat", weight: 99 });
		expect(receipts()[0]).toContain("queued");
	});

	it("rehydrates a persisted outbox on the next page load and sends it once", () => {
		const first = boot();
		first.api.handle(hello());
		type(wtInput(), "99");
		rows()[0].querySelector<HTMLButtonElement>(".log")!.click();
		first.api.flushWrites();

		const second = boot();
		second.socket().open();
		expect(second.wire.filter((f) => f.type === "log_set")).toHaveLength(1);
		expect(localStorage.getItem("liftty.outbox")).toBeNull();
	});

	it("drops a stale outbox rather than replaying it into a later session", () => {
		const first = boot();
		first.api.handle(hello());
		first.api.send({ type: "log_set", exercise: "Front Squat", reps: 5 });
		first.api.flushWrites();
		const blob = JSON.parse(localStorage.getItem("liftty.outbox")!);
		blob.savedAt = Date.now() - 13 * 3600 * 1000;
		localStorage.setItem("liftty.outbox", JSON.stringify(blob));

		const second = boot();
		second.socket().open();
		expect(second.wire).toHaveLength(0);
	});

	it("collapses repeated FINISH taps while offline into one queued save", () => {
		const { api } = boot();
		api.handle(hello());
		const finish = document.getElementById("finish") as HTMLButtonElement;
		finish.click();
		finish.disabled = false;
		finish.click();
		finish.disabled = false;
		finish.click();
		expect(api.outbox().filter((f) => f.type === "session_complete")).toHaveLength(1);
	});

	it("leaves FINISH usable when the save could not be sent", () => {
		const { api, socket } = boot();
		api.handle(hello());
		socket().open();
		const finish = document.getElementById("finish") as HTMLButtonElement;
		finish.click();
		expect(finish.disabled).toBe(true); // in flight
		api.handle({ type: "session_complete_result", ok: false, reason: "no sets logged" });
		expect(finish.disabled).toBe(false);
		expect(receipts()[0]).toContain("nothing to save");
	});

	// The review's connection-storm finding: a pending backoff timer AND visibilitychange both called
	// connect(), leaving an orphaned-but-OPEN socket whose listeners kept double-handling frames.
	it("keeps exactly one live socket across a drop and a visibility change", () => {
		const { sockets, socket } = boot();
		expect(sockets).toHaveLength(1);
		socket().drop();
		document.dispatchEvent(new Event("visibilitychange"));
		expect(sockets).toHaveLength(2); // the retry, not a third from the pending timer

		// The superseded socket must be inert: its frames are ignored, and its close schedules nothing.
		sockets[0].fire("message", { data: JSON.stringify({ type: "error", message: "from the dead socket" }) });
		expect(receipts().join(" ")).not.toContain("from the dead socket");
	});

	it("clears the outbox once the session is saved", () => {
		const { api } = boot();
		api.handle(hello());
		api.send({ type: "log_set", exercise: "Front Squat", reps: 5 });
		expect(api.outbox()).toHaveLength(1);
		api.handle({ type: "session_finalized", sets: 3, summary: "Front Squat 3×5 @ 125" });
		expect(api.outbox()).toHaveLength(0);
		expect(localStorage.getItem("liftty.outbox")).toBeNull();
	});

	it("mints a distinct nonce per LOG so a re-send is deduplicable", () => {
		const { api, wire, socket } = boot();
		api.handle(hello());
		socket().open();
		rows()[0].querySelector<HTMLButtonElement>(".log")!.click();
		rows()[0].querySelector<HTMLButtonElement>(".log")!.click();
		const logs = wire.filter((f) => f.type === "log_set");
		expect(logs).toHaveLength(2);
		expect(logs[0].nonce).toBeTruthy();
		expect(logs[0].nonce).not.toBe(logs[1].nonce);
	});
});

describe("/session client — the receipts strip", () => {
	it("shows logged weights", () => {
		const { api } = boot();
		api.handle(hello());
		api.handle({ type: "set_logged", exercise: "Front Squat", reps: 8, weight: 125, failed: false });
		expect(receipts()[0]).toContain("Front Squat");
		expect(receipts()[0]).toContain("125");
	});

	// The reported noise: a policy runs on every set and almost always does nothing.
	it("stays silent for a policy that ran but changed nothing", () => {
		const { api } = boot();
		api.handle(hello());
		api.handle({ type: "plugin_fired", name: "auto-regulate", ms: 3, cold: false, actionsApplied: 0, changed: [] });
		expect(receipts()).toHaveLength(0);
	});

	it("reports a policy that applied an action, or errored", () => {
		const { api } = boot();
		api.handle(hello());
		api.handle({ type: "plugin_fired", name: "auto-regulate", ms: 3, cold: false, actionsApplied: 1, changed: ["Front Squat"] });
		expect(receipts()[0]).toContain("auto-regulate");
		expect(receipts()[0]).toContain("Front Squat");
		api.handle({ type: "plugin_fired", name: "boom", ms: 1, cold: true, actionsApplied: 0, error: "TypeError" });
		expect(receipts()[0]).toContain("boom");
	});

	it("escapes server-supplied text rather than injecting it", () => {
		const { api } = boot();
		api.handle(hello());
		api.handle({ type: "plugin_fired", name: "<img src=x onerror=alert(1)>", ms: 1, cold: false, actionsApplied: 1, changed: [] });
		expect(document.querySelector("#receipts img")).toBeNull();
		expect(receipts()[0]).toContain("<img src=x");
	});

	it("surfaces the week-complete banner and links to /block", () => {
		const { api } = boot();
		api.handle(hello({ weekComplete: true, week: 3 }));
		const banner = document.getElementById("banner")!;
		expect(banner.className).toBe("on");
		expect(banner.textContent).toContain("week 3");
		expect(banner.querySelector("a")!.getAttribute("href")).toBe("/block");
	});
});
