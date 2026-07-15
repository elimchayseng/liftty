# Does "Code Mode" actually save you tokens? I asked a strength coach.

**TL;DR:** I ran a bunch of experiments on writing code to call tools (Cloudflare's Code Mode) instead of calling them one at a time. It's genuinely nice for *simplification* and *isolation* — but I could not reproduce the "saves you 90-something percent" math when it comes to actual task execution. My best honest result was a **wash on Opus**, a **real ~30% win on Sonnet**, and **net losses on smaller models** (where it also wrote buggy code). My conclusion: the value of this pattern is **architectural, not economic**. Adopt it for the sandbox and the clean tool surface; treat the token savings as a conditional bonus you verify on your own stack.

---

## Background

I'd already built a running-coach agent — my own harness, my own tools, called in a specific way I designed to log and read workout data correctly. I kept seeing claims that writing code to call tools is the superior pattern because of how many tokens it saves. Numbers like **85%** and **99%** get thrown around:

- Anthropic — [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Cloudflare — [Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/)

I'd been wanting to spin up a *strength*-coach variation anyway, so I built one — new agent, new tools — specifically to see what would change if I wired in code-based tool calling. And since I've been playing with Cloudflare's agent infra, I used **Cloudflare Code Mode** (the `@cloudflare/codemode` SDK) to do it.

Then I ran the same requests both ways — as normal typed tool calls, and as Code Mode snippets — across three Claude models (Opus 4.8, Sonnet 4.5, Haiku 4.5), N=5 each, measuring real tokens. My numbers came out nothing like the headlines. Figuring out *why* turned out to be the interesting part.

*(The agent is [liftty](#), a lifting coach living in a Cloudflare Durable Object. It knows my program, my injury history, and every set I've logged, and it has exactly four abilities: `getProgram`, `getHistory`, `logSet`, `adjustProgram`. Full data and interactive version: [receipts here](#).)*

---

## The first surprise: "Code Mode saves tokens" is actually three different claims

The single most useful thing I learned is that "writing code saves tokens" bundles together **three separate mechanisms** that have nothing to do with each other, and the famous numbers all come from the one I *wasn't* testing:

| Mechanism | The headline it produces | What it actually needs | Reliable? |
|---|---|---|---|
| **① Discovery** — don't load your whole tool catalog into context; look tools up on demand | Cloudflare **99.9%**, Anthropic **85%** | Lots of tools (hundreds). **Works for normal tool-calling too.** | Yes — but not code-specific |
| **② Orchestration** — one script, intermediate results kept out of context | Anthropic PTC **37%** | A harness that hides intermediates + a capable model | Conditional |
| **③ Round-trip collapse** — a snippet instead of N serial tool calls | my Sonnet **~30%** | A model that *doesn't* batch its calls | Narrow |

Most of the hype — the 85% and 99% figures — is **mechanism ①, and specifically *lazy* discovery**: the model doesn't get the whole tool catalog up front, it fetches definitions when it needs them. That saving is real and big, but it comes entirely from *not loading schema*, which is a context-management trick. It has nothing to do with whether the model then invokes a tool as JSON or as code. You can get it with plain tool-calling — Anthropic's Tool Search Tool does ~85%, [Speakeasy got 96% explicitly "without code mode"](https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2).

Here's the kicker, and it's the correction I most want to make to my own first draft: **the out-of-the-box `@cloudflare/codemode` SDK does the *opposite* of lazy discovery.** Its `createCodeTool` inlines the *entire generated TypeScript API* into context on every single request. So the harness most people will actually `npm install` gives you **none** of the discovery savings by default. (I confirmed this directly — see the tool-scaling experiment below.)

What Code Mode *does* give you is ② and ③. Those are the conditional ones. So that's what I measured.

---

## Story 1: "Log my squats — did I PR?"

The simplest request: read the program, read history, log three sets. Five independent operations that can all happen at once — the best case for both modes.

What each model *did* with the four tools decided everything:

- **Opus** fired all five tool calls in a single turn — 2 round-trips.
- **Haiku** batched too.
- **Sonnet did not.** It called tools one at a time — 3 round-trips, re-sending the growing conversation each time.

And that difference *is* the result:

| Model | Raw input Δ | $-adjusted Δ | Round-trips (tools→code) | Verdict |
|---|---|---|---|---|
| Opus 4.8 | +15% | **−2%** | 2 → 2 | a wash |
| Sonnet 4.5 | −49% | **−29%** | 3 → 2 | **real win** |
| Haiku 4.5 | noisy | noisy | 2.4 → 3.2 | loses (3/5 correct) |

Two things to explain here.

**Why "$-adjusted."** Output tokens cost 5× input on every current Claude model, and Code Mode's terse snippets emit *less* output than tool-call JSON plus prose. Scoring on input tokens alone is biased. Opus looks like a 15% *loss* on input — but it emits ~200 fewer output tokens, and at 5× that swing cancels the input penalty, so in dollars it's a wash. (Uniform 5:1 ratio, [pricing here](https://platform.claude.com/docs/en/about-claude/pricing).)

**Why the whole thing hinges on batching.** Code Mode's one job in this flow is to collapse round-trips. If your model already fires everything in one turn (Opus, Haiku), there are no round-trips to collapse and its overhead is pure cost. If your model serializes (Sonnet), Code Mode collapses 3 turns into 2 and wins. Same prompt, same tools — opposite answer, decided by model orchestration behavior.

### "Couldn't you just tell Sonnet to batch?"

I tried, twice. A polite one-liner did nothing. Then I used [Anthropic's own documented `<use_parallel_tool_calls>` block](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use), the heavy-duty one their docs recommend "if the default isn't sufficient."

It worked and backfired at the same time. Sonnet finally batched — six-plus calls in one turn — but **corrupted a tool-call name doing it** (it emitted a tool literally named `getProgram" -->`). The endpoint's validator rejected the turn, and **4 of 5 runs died with an empty reply.** Opus, the control, was unaffected.

So the Sonnet win survives its strongest documented counterfactual, with a sharper lesson attached: **you can sometimes prompt a model into batching; you can't prompt it into batching reliably *and* correctly.** Orchestration behavior is the load-bearing variable, and it's not under your control. (Worth noting: many models *do* batch by default now — but not all, and "smarter models erased the gains" only erases the *round-trip* gains, mechanism ③. The discovery gains are a separate thing entirely.)

---

## Story 2: "Deload everything, then match my pause squat to the new weight"

This one *can't* be parallelized — the second write needs the result of the first. It's exactly the "string together multiple calls" case Cloudflare's launch post says Code Mode "really shines" at, and their docs recommend Code Mode for "composition, dependent calls."

In theory one snippet handles it: deload, read the new weight into a variable, set the matched weight. **In practice, no model wrote that snippet.** They all fragmented the work across *multiple* snippets — one to deload, another to inspect, another to fix up — and each snippet is a fresh round-trip carrying the full ~800-token API overhead again. Code Mode's round-trip count went *up*, not down.

And the smaller models didn't just get expensive — they got lost. Sonnet's Code Mode runs passed the behavioral check **1 of 5 times**; Haiku's **0 of 5**. (One Sonnet run's entire final answer was a single period.) Their token "losses" here are comparing *doing the task* against *failing at it*.

**An honest counterpoint, because it matters:** Anthropic's Programmatic Tool Calling post measured a **37% *reduction*** on dependent chains — the opposite of my result. The difference is the harness. PTC keeps every intermediate result out of context and has the model write *one* orchestration script; `@cloudflare/codemode` returns each snippet's result to the model and lets it fragment. Same idea, different plumbing, opposite outcome. And my own *Opus* numbers on this flow were noisy and sometimes cheaper — consistent with PTC. So the fair statement isn't "Code Mode loses on dependent chains." It's: **the off-the-shelf codemode SDK fragments dependent work, and only a frontier model survives that.**

---

## Story 3: "How's my training actually going?"

I stacked the deck *for* Code Mode: seeded 108 logged sessions so the history is genuinely bulky, then asked for a full-history review. This is the "crunch big data in the sandbox, return a summary" pitch both Cloudflare and Anthropic assert as obvious.

Result: **a statistical tie for all three models.** Even on its advertised home turf, the win didn't clear the noise. (Two honest limitations keep me from claiming more: I didn't verify how much history the models actually requested, and the codemode runtime silently truncates results to a ~6,000-token budget — both cut against a clean read. So: unproven either way at this size.)

### "Your agent has four tools. The pitch is about fifty."

Fair — so I grew the toolbox: 8, then 20 extra realistic (fake) abilities. Here's the thing the pitch skips: **both modes pay for tool definitions.** Tools mode ships them as JSON Schema; Code Mode ships the same tools as generated TypeScript. Every request, both modes, the whole toolbox.

So costs rose in lockstep. Opus's Code Mode *deficit* actually widened (+843 → +1,783 tokens at 20 extra tools); Sonnet's win persisted but didn't grow. Tool count never flipped a verdict. This is the direct confirmation that the SDK isn't doing lazy discovery — and that the famous "99%" comes from *not shipping the catalog*, a lever available to plain tool-calling and not what this SDK does.

---

## Two things that reshape every number above

1. **Output costs 5× input.** Pricing the output side moved Opus from "+15% loss" to a wash. Any Code Mode comparison scored on input tokens alone is mis-scored.
2. **Prompt caching discounts exactly what's being measured.** Cache hits cost 10% of input price, and the big stable prefix (system prompt + toolbox) is what caches. Turn caching on and the *input*-token gaps above compress hard — including the Sonnet win. What caching never discounts: output tokens, and the latency of extra round-trips. Under caching, judge Code Mode on round-trips and output volume, not raw input.

---

## The takeaway

> **Use Code Mode for the isolation and the tool surface. If you're adopting it for tokens, first ask *which mechanism* — and you'll usually find you can get the big savings (catalog discovery) without code mode at all, or that the code-specific savings (round-trip collapse) depend on a model behavior you don't control.**

Three questions before you turn it on:

1. **Does your model already batch parallel tool calls?** If yes (Opus, Haiku) — nothing to collapse, overhead only. If no (Sonnet) — real savings, and no, prompting doesn't reliably fix it.
2. **Is the task independent operations, or a dependent chain?** Parallelizable → best case. Dependent → the off-the-shelf SDK fragments and it costs more, contra the vendor guidance.
3. **Is your model a good enough programmer?** Frontier: yes. Below it, my coach shipped wrong weights and empty replies — and a cheap wrong answer is the most expensive kind. (Haiku's failing Code Mode runs were literally its priciest runs: it retries buggy snippets until the step budget, re-sending everything each time.)

Across 13 comparisons: **one clear win** (Sonnet × parallelizable — which, credit where due, lands inside Cloudflare's demoed 32–81% band), a bunch of washes and ties, and real losses wherever a dependent chain met a smaller model. The dependable, model-independent reasons to use Code Mode are the ones Cloudflare *originally* led with, before the token numbers got bolted on: **sandbox isolation** (`globalOutbound: null` — the snippet can reach your four methods and literally nothing else) and one clean tool surface instead of many.

The token savings are conditional. The isolation is not. Adopt it for the second thing.

---

### Sources

- [Cloudflare: Code Mode](https://blog.cloudflare.com/code-mode/) · [Code Mode: API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/) · [Dynamic Worker Loaders](https://blog.cloudflare.com/dynamic-workers/) · [codemode API reference](https://developers.cloudflare.com/agents/api-reference/codemode)
- [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) · [Advanced tool use (PTC)](https://www.anthropic.com/engineering/advanced-tool-use) · [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) · [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [CodeAct (Wang et al. 2024)](https://arxiv.org/abs/2402.01030) · [MCP design choices (2026)](https://arxiv.org/abs/2602.15945)
- Third-party measurements: [Bifrost](https://www.getmaxim.ai/bifrost/blog/code-mode-and-the-architecture-of-token-efficient-mcp-agentscode-mode) · [Block/goose](https://dev.to/goose_oss/8-things-you-didnt-know-about-code-mode-4h71) · [Speakeasy](https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2) · [WorkOS on the 81% demo](https://workos.com/blog/cloudflare-code-mode-cuts-token-usage-by-81)

*Method: N=5 per cell, medians, streaming, tokens from the AI SDK's own usage (AI Gateway doesn't log tokens for streamed custom-provider responses — a fun instrument gotcha of its own). Dollar-adjusted = input + 5×output. Runs uncached. Every flow carries a behavioral assertion; cost verdicts only count behaviorally-clean runs. One provider (Heroku via AI Gateway), three model versions, July 2026 — results have a shelf life, and the batching behavior everything hinges on is exactly what changes between model versions.*
