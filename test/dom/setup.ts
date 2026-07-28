/**
 * jsdom under this vitest version exposes `window.localStorage` as a bare object with no Storage
 * methods, so the draft and outbox layers — the whole reason this suite exists — would silently
 * no-op. Install a real in-memory Storage instead of pinning around the incompatibility.
 *
 * Deliberately a faithful implementation, not a stub: `getItem` must return null (not undefined) for
 * a miss, values must be stringified, and `clear()` between tests must actually empty it, or the
 * tests would pass for the wrong reasons.
 */
class MemoryStorage implements Storage {
	private map = new Map<string, string>();

	get length(): number {
		return this.map.size;
	}
	key(i: number): string | null {
		return Array.from(this.map.keys())[i] ?? null;
	}
	getItem(k: string): string | null {
		return this.map.has(k) ? this.map.get(k)! : null;
	}
	setItem(k: string, v: string): void {
		this.map.set(String(k), String(v));
	}
	removeItem(k: string): void {
		this.map.delete(String(k));
	}
	clear(): void {
		this.map.clear();
	}
	[name: string]: unknown;
}

function install(target: typeof globalThis | (Window & typeof globalThis)) {
	const current = (target as { localStorage?: unknown }).localStorage;
	if (current && typeof (current as Storage).clear === "function") return; // a real one already
	Object.defineProperty(target, "localStorage", { value: new MemoryStorage(), configurable: true, writable: true });
}

install(globalThis);
if (typeof window !== "undefined") install(window);
