# From MVP to State-of-the-Art: The CodeCity Roadmap

*How a visual trust layer for AI coding agents grows — one version at a time — without ever letting the visualization outspend the thing it's supposed to explain.*

## The governing constraint

Before listing a single feature, one rule outranks all of them: every token spent must buy understanding, not scenery. A visualization tool built on top of an LLM has an obvious failure mode — it becomes more expensive to run than the coding task it's supposed to make legible. CodeCity avoids that by treating two disciplines as first-class from day one, not bolted on later:

- Harness engineering — designing the scaffolding *around* the model (event schemas, local heuristics, deterministic rendering, tight context windows) so the model is asked to do the least possible amount of thinking to produce the most possible amount of clarity. The harness should absorb complexity; the model should only be pulled in when nothing else can do the job.
- Loop engineering — optimizing the *repeating cycle* of perceive → represent → explain so that each iteration is as cheap as the one before it, even as the project grows. This means caching, debouncing, batching, and reusing prior explanations instead of regenerating them from scratch every time a similar event occurs.

Every version below is judged against one question: does this feature increase understanding per token, or does it just increase pixels per token? Only the former ships.

---

## V1 — MVP: Prove the metaphor works — **shipped**

Goal: a developer can watch one project being built by an agent and correctly infer what's happening, without reading a diff.

Features
- Single view mode. No customization — one clean city.
- Hook listener wired to one agentic tool (Claude Code first).
- Deterministic Canvas/SVG renderer: buildings for files, three or four status states (writing, editing, reading, inspecting).
- Click-to-explain panel, powered by a small/fast model, triggered only on click.
- Static dependency lines between files based on imports at session start.

Harness/loop discipline applied here
- The renderer is hand-built code, not model output — this is the single biggest cost lever in the entire project, and it's locked in at V1 so nothing downstream has to unwind it.
- Explanations are generated only on click, never proactively narrated — the loop stays silent unless asked.
- Event payloads sent to the explain-model are truncated to just the relevant diff/command, not the full file — the harness pre-filters context so the model doesn't have to.

Known gaps (deliberately deferred): no persistence across sessions, no multi-file dependency updates mid-session, one project at a time, ugly by design (function over form).

---

## V2 — Usable: Make it trustworthy across a real session — **shipped**

Goal: a developer can leave this running for an entire coding session and actually rely on it, not just demo it once.

Features
- Live dependency graph updates as new imports appear mid-session, not just at start.
- Building "health" coloring — a simple heuristic-driven risk signal (e.g. file touched many times in a short window, or a write followed immediately by another write with no read in between — a proxy for possibly unreviewed churn).
- Session log persistence, so closing and reopening the browser doesn't lose the city's state.
- Support for a second agentic tool (e.g. Codex or Cursor) via the same event schema, proving the harness is tool-agnostic.
- "Worker" and "material truck" representations go live: API calls and MCP tool calls get distinct, at-a-glance visual treatment instead of being lumped in with file edits.

Harness/loop discipline applied here
- Health heuristics are computed locally from the event log (pure logic, zero tokens) — the model is never asked "is this risky," because that's a solved problem with rules, not reasoning.
- Explanation calls are cached per unique event signature within a session — if the agent performs the same class of edit on similar files repeatedly, the second explanation is served from cache instead of regenerated.
- Multi-tool support is a harness change (a shared event schema), not a prompting change — this keeps the loop's cost flat regardless of which underlying agent is driving.

Known gaps: still single view, still solo-developer only.

### Deviations taken while building V2

Three decisions departed from the plan above. Recording them here so the reasoning
survives, not because they were unavoidable.

1. **The visual pass was pulled forward from V3.** V2 was supposed to ship with "no
   aesthetic investment yet". It shipped instead as a drafting-plan look — flat
   extruded plates, a dashed isometric grid, hairline roads. The justification is the
   governing constraint itself: rendering is a zero-token layer, so moving it earlier
   costs nothing per session. What V3 still owes is the *modes* (simplified, gamified)
   and the animation work, which are the parts that actually take time.

2. **Fill colour switched from tool class to attention state.** V1 gave each of the
   seven tool classes its own colour. That answers "what happened" but not "should I
   look at this", which is the question the product exists to answer. Fill now tracks
   attention — never opened, in context, cooled, changed, new ground — and the tool
   class moved to a glyph on a leader line. The 1:1 rule from the README is intact
   (every glyph is still exactly one class of tool call); it just moved channels.
   The runner-up was keeping seven fill colours and adding a separate outline for
   attention, which was rejected as two competing colour languages on one shape.

3. **The visual identity is a massing model, not a tactical map.** The first cut of
   the V2 look leaned too hard on its reference: warm olive ground, amber chrome,
   untouched files as dashed empty plots, one flat plane. Three things changed, and
   each is an argument rather than a taste call.

   *Untouched files are solid, not wireframe.* Dashed plots make a codebase look
   like a construction site with nothing built yet, which is the opposite of true —
   the code exists, the agent just hasn't read it. Solid graphite massing means the
   first thing you see is the shape and scale of the whole repo, and the honest
   question becomes "how much of this has the agent actually looked at".

   *The chrome spends no colour.* Amber was doing double duty as both the interface
   accent and the "changed by the agent" state, which is two meanings on one hue.
   Chrome is now bone-white on graphite, and green/amber/red/blue mean agent
   attention and nothing else. Anything coloured is worth looking at, by
   construction.

   *Depth is elevation.* A flat plane can show which directory a file is in but not
   that `src/api/routes` lives inside `src/api`. Each nesting level is now a terrace
   standing proud of its parent, and the sidebar index is the same tree with
   subtree-rollup bars instead of a flat list of paths.

   The runner-up for the layout was a treemap — better area efficiency, but it
   throws away the constant-footprint building, and once footprint varies you can no
   longer read height as line count without also doing area arithmetic. Nested
   terraces keep one variable per channel.

4. **A second agent is supported by a seam, not an adapter.** The plan said "support
   for a second agentic tool (e.g. Codex or Cursor)". Rather than guess at a dialect
   we can't test against, `adapt()` accepts Claude Code hooks, OpenAI-style function
   calls, and pre-normalized events. The tool-agnostic claim is therefore demonstrable
   today, and a real Codex integration is a few lines when there's a payload to test.

---

## V3 — Beautiful: Make it something people want to leave open

Goal: the tool earns a permanent spot on a second monitor because it's pleasant to look at, not just useful.

Features
- Multiple view modes: developer (dense, technical labels), simplified (plain-language only), and a lightly gamified mode (progress bars, "project health score") for onboarding and team visibility.
- Smooth, CSS/canvas-driven animations for state transitions (a building "going up," a road lighting up when a dependency is touched) — motion communicates activity without needing new text.
- Building history timeline — hovering shows a lightweight sparkline of that file's edit frequency and risk trend over the session, computed locally.
- Visual polish pass: consistent lighting/shadow system, a proper color language audited for accessibility, a real layout algorithm so the city doesn't look randomly scattered as project size grows.

Harness/loop discipline applied here
- Every animation and view mode is a *rendering-layer* decision — none of it touches the model. The cost of the product does not increase between V2 and V3, only its polish does. This is the clearest test of the "understanding per token, not pixels per token" rule: an entire version ships with zero increase in LLM spend.
- View-mode switching reuses the same underlying state graph and the same cached explanations — three presentations, one source of truth, one cost.

Known gaps: still no team/multi-developer awareness, no integration with external quality tools yet, no DevOps-scale view.

---

## V4 — State-of-the-art: Plug into the real engineering org

Goal: CodeCity stops being a personal window and becomes a shared, extensible layer teams standardize on.

Features
- Plugin interface for third-party quality tools (security scanners, linters, UI/UX inspectors, accessibility checkers) — their findings surface as building "health" annotations rather than separate reports.
- Multi-developer / team view: multiple agents or multiple engineers working across the same repo show up as concurrent activity in the same city, so leads can see review load and hot spots in real time.
- DevOps-scale zoom-out: roads become pipelines, buildings cluster into districts representing services, and infrastructure concepts (containers, nodes, ports) render using the same visual language established in V1 — no new metaphor to learn, just a new zoom level.
- Predictive risk scoring: pattern recognition over accumulated session history (still mostly local statistics, not live model calls) flags files that historically tend to break after a certain class of edit.
- Exportable session replays — a compressed, shareable timeline of what an agent did on a PR, for async code review.

Harness/loop discipline applied here
- Third-party tool findings are ingested as structured data (pass/fail, severity, line) and mapped to visual states by rules — plugins do not get to prompt the explain-model directly; they go through the same cheap, deterministic pipeline every other event does.
- Predictive risk scoring is built on local statistical history first; a model call is only the fallback for genuinely ambiguous cases, keeping the expensive path rare by construction.
- Session replay export reuses the existing event log verbatim — no re-summarization pass required unless a human explicitly asks for a narrated recap.

---

## The thread that ties every version together

At no point does the roadmap add a feature that requires the model to run continuously, narrate proactively, or regenerate the visualization itself. The renderer is deterministic in V1 and stays deterministic in V4. What grows across versions is the *quality of the harness* — better event schemas, better local heuristics, better caching — not the *frequency of model calls*. That's the whole bet: understanding scales with engineering discipline, not with token spend.
