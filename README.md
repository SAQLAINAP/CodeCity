# CodeCity
### A visual trust layer for AI coding agents
*(working name — swap freely)*

---

## Page 1 — The idea and the project

### The problem
AI coding agents (Claude Code, Codex, Cursor, Windsurf, and similar CLI/GUI tools) now make dozens of file edits, tool calls, and shell commands per session. Developers — especially junior ones — habitually click "Allow" or "Always Allow" without reading diffs, because reading every diff is slow and the raw output (JSON tool calls, unified diffs) isn't built for fast human comprehension. The result: unreviewed edits, silently introduced vulnerabilities, and a generation of developers who can prompt but can't explain their own codebase. Today's fix is bolting on a *separate* static-analysis or security-scanning tool after the fact — more overhead, not more understanding, and it never explains *what the agent was doing*, only what's wrong with the result.

### The idea
Represent the project the agent is working on as a living city, rendered locally in the browser while the agent works. Every file is a building. Every agent action — writing, editing, refactoring, calling an API, reading a file — is a visible physical event happening to that building. Instead of reading a diff, the developer watches a building go up, get rewired, or get inspected, and can click it at any point for a plain-language explanation of what just happened and why. The metaphor isn't decorative — it's a compression scheme: humans parse "that building is under construction" faster than they parse a 40-line diff, and the spatial layout (which buildings are linked to which) makes dependency structure visible without reading imports.

### Who it's for
- Junior developers / students learning to work with agentic tools, who need to build intuition for what an agent is doing under the hood before they can safely rubber-stamp it.
- Teams with review anxiety — leads who worry engineers are shipping agent output they haven't actually understood.
- Security-conscious individuals/orgs who want a lightweight, always-on visual signal of risk, without a separate scanning pipeline breaking their flow.

### What v1 actually does
1. Developer runs their normal agentic coding tool (e.g. Claude Code) inside a project.
2. A single init command spins up a small local backend and opens localhost in the browser.
3. As the agent works, every tool-call event (file write, edit, read, bash, API/MCP call) streams into the visualizer in real time as a city update.
4. Clicking a building shows a short, plain-language description of the most recent actions on that file.
5. Links between buildings show import/dependency relationships, so the developer can see blast radius at a glance.

### What's explicitly out of scope for v1
- Multiple view modes (gamified / simplified / dev / layman) — ship one legible view first.
- Full DevOps-scale visualization (clusters, pods, pipelines-as-roads).
- Deep third-party code-quality/UI-UX plugin integrations — designed as a future plugin interface, not built now.

### Why this is different from existing tools
Existing code-quality and security scanners tell you *what's wrong after the fact*. CodeCity tells you *what's happening as it happens*, in a form a non-expert can parse in one glance, without adding a second tool to the workflow — it rides on the same hook/event stream the agent already produces.

---

## Page 2 — Architecture, mechanism, and the analogy system

### High-level architecture
```
Coding agent (Claude Code, etc.)
│ emits hook events (PreToolUse, PostToolUse, Stop)
▼
Local event listener ──────────────► Event log (append-only, per session)
│
▼
State graph builder
(files → buildings, imports → roads, tool type → building state)
│
▼
Deterministic renderer (Canvas/SVG, pre-built — NOT LLM-generated per frame)
│
▼
Local browser UI (localhost) ◄──── on click ──── cheap on-demand LLM call
                                                 (small/fast model, explains one file's
                                                  recent events in plain language)
```

Why it's structured this way: the visualization itself must be *deterministic code*, not something an LLM draws live — otherwise every frame burns tokens and the picture could hallucinate. The only place an LLM is invoked is the on-click "explain this building" panel, which is cheap and infrequent. This is the direct answer to the token-cost concern raised early on: separate the *rendering* (free, local, instant) from the *explaining* (LLM, on-demand, cheap).

### The mechanism, step by step
1. The agent calls a tool (e.g. `Edit`, `Write`, `Bash`, an MCP tool, or an API call).
2. A hook fires before and after the call, carrying the tool name, target file, and payload (diff, command, or API request/response).
3. The local listener normalizes this into a small JSON event: `{file, action_type, timestamp, summary}`.
4. The state graph updates: the relevant building's status changes, and any newly touched imports add or reinforce a road between buildings.
5. The renderer redraws only the changed elements (buildings/roads), keeping the update cheap and instant.
6. On click, the last N events for that file are fed to a small model with a tight prompt ("explain these 3 tool calls in one sentence, for a junior developer") — this is the only network/LLM cost in the whole loop.

### The analogy system
| City element | Code concept |
|---|---|
| Building | A file or module |
| Under construction | File is being created / written from scratch |
| Renovation / refurbishing | File is being refactored |
| Painting / finishing touches | Final polish pass, formatting, cleanup |
| Inspection | Tests running, or a scan/lint pass |
| Building health / condition | Code quality or vulnerability signal for that file |
| Roads between buildings | Import/dependency relationships |
| Material delivery truck | Incoming data from an external API |
| Worker extracting material on-site | An MCP tool call (pulling from a local/connected resource) |
| Construction crew / worker | A generic tool call or function call — the "agent doing agentic things" |
| District / neighborhood | A module, package, or service boundary |
| (v2+) Roads becoming highways, ports, clusters | DevOps scale-up: pipelines, containers, nodes |

### Illustrative principles
These are the design rules that keep the metaphor useful rather than gimmicky:

- Legibility over completeness. The city should never try to show everything the agent did — only the current state and the most recent action per building. Depth lives behind a click, not on the surface.
- The metaphor must map 1:1 to a real mechanism. Every visual state corresponds to exactly one class of tool call. If a status can't be traced back to a specific event type, it shouldn't exist — arbitrary decoration teaches nothing.
- Determinism over generation. The city is drawn by code, not prompted into existence per frame. This is both a cost control and a trust control — a hallucinated visualization of what the agent did would be worse than no visualization.
- Explain on demand, not by default. Plain-language explanations are a click-triggered, cheap LLM call — never a continuous narration, which would be both expensive and noisy.
- Spatial position encodes real structure. Distance and connection between buildings should reflect actual import/dependency graphs, not arbitrary placement — so a developer can learn "these things are coupled" just by looking.
- Escalating detail, not escalating chrome. As the project scales (v2/v3), new complexity should show up as new *information* (clusters, pipelines, ports) representing real DevOps concepts — not as visual polish for its own sake.

---

## Running it

```sh
cd /path/to/your/project
node /path/to/codecity/bin/codecity.js init   # writes the hook into .claude/settings.local.json
node /path/to/codecity/bin/codecity.js        # scans, serves, opens the browser
```

Restart Claude Code after `init` so it picks up the hook, then work normally.

| Flag | Default | Purpose |
|---|---|---|
| `--port` | `4317` | Local server port. Must match what `init` wrote. |
| `--root` | cwd | Project to visualise. |
| `--max-files` | `400` | Building cap for large repos. |
| `--shared` | off | Write the hook to `settings.json` (committed) instead of `settings.local.json`. |
| `--no-open` | off | Don't launch a browser. |
| `--fresh` | off | Ignore the previous session log instead of replaying it. |

`codecity uninstall` removes the hook again. Session events are appended to
`.codecity/session-<timestamp>.jsonl` in the watched project, and the newest log is
replayed on startup so a restart doesn't lose the city.

Controls: drag to pan, scroll to zoom, click a building or walk the city with `↑`/`↓`,
`⏎` to ask what a file does, `esc` to clear. The left index is the directory tree;
clicking a row isolates that district and everything nested inside it.

## Reading the city

The city is drawn as an architect's massing model: every file is a solid volume
whether or not the agent has been near it, so the shape of the codebase — and how
much of it is still untouched — is legible before anything happens.

**Shape answers "how big is this, and where does it sit?"**

| Form | Meaning |
|---|---|
| Height | Line count, square-rooted so one huge file can't hide a district |
| Storey bands | One band per 30 lines, so two neighbours can be compared by counting |
| Terrace elevation | Depth in the directory tree — `src/api/routes` stands one step above `src/api`, which stands above `src` |
| Plate footprint | A directory. Nested plates are nested directories, at every level |

**Fill colour answers "should I be looking at this?"** — it tracks the agent's
attention, not its tool calls. The interface chrome spends no colour at all, so
anything coloured is by definition something the agent did:

| Fill | Meaning |
|---|---|
| Graphite | Untouched this session |
| Green | Read, still in the agent's context |
| Green → grey → red | Cooling over five minutes; red means the agent is now working from memory |
| Amber | Changed by the agent — sitting in your review queue |
| Blue | New ground: a file the agent created |
| Red hatch + outline | Local risk heuristic fired (see below) |

**The glyph on the leader line answers "what did it just do?"** — one mark per tool
class, so every visual state still traces back to exactly one kind of event: crane =
`Write`, scaffolding = `Edit`, loupe = `Read`, tick = tests/lint, hard hat = `Bash`
or `Task`, drill = MCP call, truck = `WebFetch`.

Keeping these apart is what lets the fill carry a trust signal without breaking the
1:1 rule from Page 2 — the metaphor stays honest and the colour stays useful.

### Risk is a rule, never a judgment
Two heuristics run locally over the event log, costing nothing:

- **Unreviewed churn** — two or more writes with no read in between.
- **Burst** — three or more writes to one file inside two minutes.

The model is never asked "is this risky". That is a solved problem with rules.

### Blast radius
Selecting a file lights its import edges in amber and lists what it imports and what
imports it, each annotated with that file's own state. This is pure graph data — it
answers the "what else does this touch?" question for zero tokens.

### Wiring a different agent
`src/schema.js` is the only file that knows what an agent's payload looks like.
`POST /codecity/event` accepts three dialects and normalizes all of them to the same
event shape:

```jsonc
{ "tool_name": "Edit", "tool_input": { … }, "cwd": "…" }   // Claude Code hooks
{ "name": "Edit", "arguments": "{ … }", "cwd": "…" }        // OpenAI-style function calls
{ "tool": "Edit", "input": { … }, "cwd": "…" }              // already normalized
```

So adding a second agentic tool is a hook line plus, at most, an entry in `adapt()` —
not a change to the state graph, the renderer, or the prompt.

## What it still does not do

- **Explanations need a reachable Claude Code login.** The explain panel shells out to
  `claude -p --model haiku`, so it inherits whatever auth the launching shell has. If
  that login isn't reachable, the panel falls back to a deterministic local summary and
  tells you why in brackets. The city itself never depends on the model.
- **Import parsing is regex-based** and covers relative JS/TS and Python specifiers
  only. Package imports and aliased paths don't produce roads.
- **Off-site calls stay off-site.** A `WebFetch` has no building to land on, so it only
  reaches the ticker. `Bash` and MCP calls do land, but only when the target file's
  path appears in the command.

---

See [ROADMAP.md](ROADMAP.md) for the V1 → V4 progression.
