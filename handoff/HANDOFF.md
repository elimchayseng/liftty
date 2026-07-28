# liftty — design refresh handoff

Refresh the four server-rendered pages (`/plan`, `/chat`, `/session`) plus a new landing route (`/`) and a shared header, extending the existing `/flow` visual language (dark ground, hard hairline boxes, monospace data, sparing yellow highlighter). `/flow` itself is the reference and is **not** rebuilt — it only gains a nav link.

- **Branch:** `design-refresh`
- **Visual source of truth:** `Liftty Refresh Board.dc.html` (open in the design tool) — one panel per screen, tightly speced. This doc is the written spec that mirrors it.
- **Assets:** `assets/liftty_avatar.png` (pixel-art lifter, already in repo at `assets/`), `flow-reference.html` (the live `/flow` bundle, for motif reference only).
- **Files to touch:** `src/views/plan.ts`, `src/views/chat.ts`, `src/views/session.ts`, new `src/views/landing.ts`, new `src/views/shared.ts`, `src/server.ts` (routes + rest-timer config).

---

## 1. Design principles

**Do**
- Dark ground `#0a0a0b`. White ink, warm-neutral.
- **Hard lines only:** `border: 1px solid <line>`, `border-radius: 0` everywhere. No `box-shadow`, ever.
- Boxes are **hairline outlines**, not filled cards. Secondary/optional boxes use `1px dashed`.
- **Monospace (IBM Plex Mono)** for all data, labels, tags, numbers, nav, receipts. **Archivo** (700–900) for display headings and big numbers.
- One **yellow highlighter** (`#F2CD46` block behind dark text) per screen, max. It is a signature, not decoration.
- Cloudflare orange `#F6821F` for accent borders, values, the "today/live" eyebrow, and the wordmark tick.
- Minimal copy. No full-stop sentences, no taglines. Labels and data only. (`/flow` is the exception — it keeps its explanatory prose because it's the demo.)
- Big numbers. Weights/reps are the loudest thing on `/session`.

**Don't**
- No rounded corners, no drop shadows, no filled "cards", no gradients.
- No emoji. No decorative SVG illustration (the pixel avatar is the only illustration).
- No taglines or marketing sentences anywhere outside `/flow`.

---

## 2. Design tokens

Define once (a `TOKENS` object in `src/views/shared.ts`, or inline consts). Current pages hardcode `#0b0d10 / #14171c / #232830 / 14px radius` — replace all of it.

```
/* ground + ink */
--bg:        #0a0a0b   /* page ground (was #0b0d10) */
--ink:       #f5f4ef   /* primary text, warm white */
--sub:       #a8a79f   /* secondary text */
--faint:     #6a6a66   /* labels, meta, disabled */

/* lines (replace all borders + old cards) */
--line:        rgba(255,255,255,0.13)  /* default hairline */
--line-strong: rgba(255,255,255,0.22)  /* inputs, editable chips */
--line-dash:   rgba(255,255,255,0.28)  /* dashed secondary */

/* accents */
--marker:  #F2CD46   /* yellow highlighter + primary CTA fill */
--accent:  #F6821F   /* orange: today/active, values, wordmark tick */
--live:    #3fb950   /* live / success / receipts */

/* type */
font-display: 'Archivo', sans-serif;        /* 700, 800, 900 */
font-mono:    'IBM Plex Mono', monospace;   /* 400, 500, 600 */
```

**Fonts:** load in every page `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```
Keep `color-scheme: dark`, `box-sizing: border-box`, and `viewport-fit=cover`. `::selection { background:#F2CD46; color:#0a0a0b; }`.

**Radius / shadow:** global `border-radius: 0`. Delete every `border-radius` and `box-shadow` in the three view files.

**Spacing:** page padding `20px` (mobile), section gap `20–28px`, row padding `12–14px`. Max width stays `640px`, centered.

---

## 3. Shared components (put in `src/views/shared.ts`)

### 3.1 Header / nav (new, used on every page incl. landing)
- Row, space-between, `padding:18px 20px`, `border-bottom:1px solid var(--line)`.
- **Wordmark:** `liftty` in Archivo 900, `~22px`, `letter-spacing:-0.02em`, followed by a **7×7px solid `--accent` square** (baseline-nudged `margin-bottom:-2px`). This square replaces the old orange `.`.
- **Nav:** mono, `12px`, uppercase, `letter-spacing:0.08em`, color `--faint`, gap `16px`: `plan  session  chat  flow`.
- **Active item:** color `--ink` + `border-bottom:2px solid var(--marker)`, `padding-bottom:2px`.
- `<a>` default + hover colors must be defined (inherit `--ink`, hover `--marker`) so links never render browser-blue.

### 3.2 Buttons / tags
- **Primary CTA:** `background:var(--marker)`, `color:#0a0a0b`, Archivo 800, sharp corners, no border. e.g. `START SESSION →`, `LOG`, `SEND`.
- **Ghost button:** `background:transparent`, `1px solid var(--line-strong)`, `color:var(--sub)`, mono (e.g. `fail`).
- **Tag chip:** `1px solid var(--accent)` or `1px dashed var(--line-dash)`, mono `10–11px`, uppercase, `letter-spacing:0.1em`, `padding:4px 9px` (e.g. `RUNS ×1`, `TODAY`).
- **Editable chip:** `1px solid var(--line-strong)`, mono, larger (`15–17px`) — signals an inline-editable value (sets, reps, rest).

### 3.3 Highlighter
`<span style="background:#F2CD46;color:#0a0a0b;padding:0 6px">word</span>`. One per screen.

### 3.4 Receipt line (from `/flow`, reused on `/session` + `/chat`)
Mono `11px`, `border-left:2px solid` (`--accent` for policy, `--live` for set-logged), subtle `background:rgba(255,255,255,0.02)`, `padding:8px 12px`. Values in `--ink`/`--live`.

---

## 4. Per-page specs

### 4.1 `/` — landing (NEW → `src/views/landing.ts`, route in `server.ts`)
- Shared header (no active item).
- Body: pixel avatar `assets/liftty_avatar.png` in a hairline frame (`1px solid var(--line)`, `padding:18px`, centered), `width:160px; image-rendering:pixelated`.
- `liftty` wordmark, Archivo 900, `~60px`, below it a **56×3px `--marker` accent rule**.
- Bottom: four hard-line entry rows (top+bottom `1px solid var(--line)`), each = label (Archivo 700, `19px`) + mono sub + `→` in `--accent`: **Plan** (`today · what's next`), **Session** (`log sets live`), **Chat** (`ask the coach`), and a fainter **flow** (`how it runs`).
- No tagline. No sentences.

### 4.2 `/plan` — `src/views/plan.ts` (today-first)
Keep all existing data (`renderPlan(data)`, `state`, `recentSessions`, `today`, `plugins`) — this is a **reskin + reprioritize**, not a data change.
- Shared header, `plan` active.
- Lifter line + phase/week: mono, `--faint`/`--sub` (drop the big `.brand`/`.who` block).
- **TODAY hero** (the one bordered-in-`--accent` box on the page): `TODAY` eyebrow (mono, `--accent`), focus title in Archivo 900 `~34px`, then prescribed lifts as rows separated by `1px solid var(--line)`: name (Archivo 600) + mono scheme sub, **weight is the big value** (mono, `~24px`, `--ink`) right-aligned; `BW` when bodyweight.
- **Primary CTA** directly under the hero: `START SESSION →` (marker fill) linking to `/session`.
- Below, compact sections with mono `11px` uppercase `--faint` labels:
  - **MAIN LIFTS · GOAL** — hairline box, rows `current → goal` (goal in `--accent`).
  - **ACTIVE POLICY** — dashed box, mono, `0 tokens` in `--live` (from `plugins[]`).
  - **COMING UP** / **RECENT** — keep, but strip to mono rows in hairline boxes; no rounded cards.
- Remove: `.card{border-radius:14px}`, `box-shadow`, the amber `.banner` gradient look → make status a plain dashed row if kept.

### 4.3 `/chat` — `src/views/chat.ts` (coach)
Behavior unchanged. Endpoint `/agents/liftty-agent/me`, `mode` values stay `'codemode'` / `'tools'` in the POST body — **only the labels change.**
- Shared header + the mode toggle on the right: a single hairline box, two segments — **`codemode`** (active = marker fill, `color:#0a0a0b`, weight 600) and **`tool call`** (inactive = `--faint`). (Renames the old "Code Mode" / "Tools".) Keep the `title`/hint copy that explains the product path.
- Messages: **no bubbles / no radius.** Coach = `1px solid var(--line)` box, left-aligned. User = right-aligned, `border-left:2px solid var(--accent)` + `background:rgba(255,255,255,0.03)` (replaces the blue `#1f6feb` bubble).
- `used: <tools>` and `tokens: N in · N out` lines → mono `11px`, numbers in `--accent` (keep `addTools`/`addUsage`).
- Code snippet (`addCode`) + plugin-authored (`addPlugins`): hairline box, `border-left:2px solid var(--accent)`, mono, sharp. Keep the `plugin authored · … · 0 tokens` caption.
- Input: `1px solid var(--line-strong)`, sharp, mono placeholder `message the coach`; `SEND` = marker CTA. Remove `border-radius`.

### 4.4 `/session` — `src/views/session.ts` (calm, big numbers, log fast)
Behavior/WS protocol unchanged. Reskin + two functional additions (adjustable sets×reps, configurable rest — see §5).
- Shared header; right side = live indicator: **7×7px square** (`--live` when open, `--faint` connecting, `#ff6b6b` closed) + mono `live`/`connecting`/`disconnected`. (Old code used a round `.led` — make it a square.)
- `TODAY` eyebrow + focus in Archivo 900 `~34px`.
- **Rest timer row** (see §5.2): dashed box; idle shows the editable default (`60 s · default`); running shows big mono count in `--marker`; done flips to `--live`.
- **Lift row (weight-forward):**
  - Scheme line, prominent: name (mono `13px`, `--sub`) on the left; on the right the **editable `sets × reps` chips** (bordered, mono `17px`) + tiny `sets×reps` hint (see §5.1).
  - The working **weight is a 56px Archivo 900 number** with mono `lb`. `logged N / M sets` mono on the right (`--live` when met).
  - Controls row: reps field, weight field (weight field tinted `--marker`, `border-color:#3a2f18`), `fail` ghost button, `LOG` marker CTA. Keep number-spinner removal.
  - **Policy-changed flash:** when a `cf_agent_state` broadcast changes a prescribed weight/scheme, flash the row with `inset 0 0 0 1px rgba(246,130,31,0.5)` + `background:rgba(246,130,31,0.05)` and show a `▼ was 215` delta in `--accent` (keep existing change-detection logic; restyle only).
- **Receipts** strip: mono lines, `border-left` `--accent` (policy) / `--live` (set) — `auto-regulate fired · 4 ms · 0 tokens`.

### 4.5 `/flow` — unchanged
Only add the `flow` nav link to the shared header when/if flow adopts it. Do not rebuild.

---

## 5. Backend / functional changes

### 5.1 Adjustable sets × reps (session)
The per-set **reps `<input>`** already lets a lifter log actual reps ≠ prescribed, and `logSet` already accepts `reps`/`weight` — that path is fine as-is. The new UI makes the prescribed **sets × reps** visible as editable chips. Wire the chips to the existing `adjustProgram` path (op already whitelisted) so editing them updates the day's prescription (optional but low-cost); if out of scope for v1, render them as prominent read-only values and keep only the per-set reps field editable. No schema change.

### 5.2 Configurable rest timer (NEW — must be wired)
Default **60s**, per-user configurable, overridable per set.
- **State:** add `settings.restSeconds` (default `60`) to the agent state seed in `src/server.ts` (alongside `program`/`lifter`). Persists in the DO like the rest of state.
- **Authoring:** allow the coach to set it (`"rest 90 seconds"`) via a typed method / tool (`setRestSeconds({seconds})`) and via the chip on `/session`.
- **Live path:** in the M4 `onMessage` `log_set` handler, replace the hardcoded `restSeconds` with `this.state.settings.restSeconds` (fallback `60`), still overridable by an optional `rest` field on the `log_set` message. The `rest_started` broadcast already carries `seconds`; `/session`'s `startRest(seconds)` already renders whatever it's given — so the client needs no protocol change, just the editable chip that sends the new default back (via the tool/method above).
- **Acceptance:** default is 60s; changing it (chat or chip) persists across reconnect and redeploy; next logged set rests for the configured value.

### 5.3 Landing route
Add `/` (and keep `/plan` as an alias, per current sitemap) in the `fetch` router next to `/chat`/`/session`, returning `renderLanding()`.

---

## 6. File-by-file change plan

| File | Change |
|---|---|
| `src/views/shared.ts` | **NEW.** Export `renderHead()` (font links + reset + tokens `<style>`), `renderHeader(active)` (wordmark + nav), and shared style snippets. |
| `src/views/landing.ts` | **NEW.** `renderLanding()` — header + avatar + wordmark + accent rule + 4 entry rows. |
| `src/views/plan.ts` | Reskin to tokens; TODAY hero in `--accent` box; weight-forward rows; add `START SESSION` CTA; strip radius/shadow/banner-gradient; mono section labels. Keep `renderPlan` signature + data. |
| `src/views/chat.ts` | Toggle labels → `codemode`/`tool call` (keep `mode` values); de-bubble messages (hairline + orange-tick); reskin snippet/token/input to tokens; remove radius. |
| `src/views/session.ts` | Reskin; square live indicator; 56px weight; editable sets×reps chips; configurable rest row; restyle flash + receipts. Keep WS logic. |
| `src/server.ts` | Add `/` route (+ `/plan` alias) → `renderLanding()`; seed `settings.restSeconds=60`; use it (with per-msg override) in `onMessage` rest scheduling; add `setRestSeconds` method/tool. |
| `test/index.spec.ts` | Add: `/` serves 200 + wordmark markup; `/session` contains rest-config markup; existing `/plan` `/chat` `/session` assertions updated for new labels. |

Keep the established workflow: branch → build → `wrangler dev` → `/review` → PR → merge. `/flow` is regenerated from `plugins-flow-v2.1.html`; don't hand-edit `src/views/flow.ts`.

---

## 7. Acceptance criteria

**Global**
- [ ] No `border-radius` and no `box-shadow` remain in any of `plan.ts`, `chat.ts`, `session.ts`, `landing.ts`.
- [ ] Archivo + IBM Plex Mono load on every page; no system-font fallback flash of the old look.
- [ ] Exactly one yellow-highlighter usage per page (none on `/flow`, which keeps prose).
- [ ] All borders use the token line colors; ground is `#0a0a0b`.
- [ ] No full-stop sentences / taglines outside `/flow`.

**Header** — appears identically on all pages; wordmark has the orange square tick; active nav item underlined in marker.

**Landing** — avatar renders pixelated; 56×3px marker rule under wordmark; 4 entry rows link to `/plan`, `/session`, `/chat`, `/flow`; no tagline.

**/plan** — TODAY hero is the only orange-bordered box; weights are the largest value per row; `START SESSION` links to `/session`; policies show `0 tokens` in green.

**/chat** — toggle reads `codemode` / `tool call` and still POSTs `mode: 'codemode'|'tools'`; messages are square hairline boxes (no blue bubble); tokens/tools/snippets render.

**/session** — live indicator is a square; working weight is ~56px; sets×reps shown as editable chips; rest row shows editable `60 s` default; policy-change flash still fires on weight/scheme change; receipts render.

**Rest config** — default 60s; editable via chat and chip; persists across reconnect + redeploy; drives the next `rest_started`.

---

## 8. Artifacts in this handoff
- `HANDOFF.md` (this file)
- `Liftty Refresh Board.dc.html` — interactive visual spec, all screens
- `assets/liftty_avatar.png` — landing illustration
- `flow-reference.html` — the shipped `/flow` page (motif reference; do not rebuild)
