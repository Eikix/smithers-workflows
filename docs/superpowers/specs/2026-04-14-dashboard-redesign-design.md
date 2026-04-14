# Dashboard Redesign — Node Graph Monitoring View

## Goal

Replace the current debug-oriented dashboard with a clean, graph-based monitoring view. Users should understand at a glance: which workflows are running across repos, where each run is in its process, how many iterations/retries occurred, and how many tokens were consumed.

## Aesthetic

Unreal Blueprint style: dark background with a subtle dot-grid pattern, node blocks with colored left bars indicating type, curved SVG bezier wires connecting nodes, and status-driven colors throughout. Read-only monitoring — no editing.

## Layout

Sidebar + Canvas. The sidebar lists all runs grouped by repository. The canvas renders the selected run's workflow as a node graph.

### Sidebar (left, ~280px, collapsible)

**Header:** "Smithers" title with a collapse/expand button.

**Collapsed state:** Thin strip (~48px) showing colored status dots per run. Hover for tooltip with workflow name. Click a dot to expand and select that run.

**Toggle:** "Hide finished" toggle at the top of the run list.

**Run list:** Grouped under repo headers extracted from `vcs_root` (e.g. `zama-ai/fhevm`). Each repo header shows the repo name and count of active runs.

**Run cards:** Each card shows:

- Workflow name (bold)
- Status pill (blue=running, green=finished, red=failed, yellow=waiting)
- Current step name
- Duration since started (e.g. "12m", "2h")
- Loop iteration if applicable (e.g. "iter 3")
- Selected run has accent-colored border

### Canvas (right, fills remaining space)

**Background:** Dark (#0d1117) with radial dot-grid pattern (`radial-gradient(#ffffff08 1px, transparent 1px)` at 20px spacing).

**Node cards:** Each node rendered as a card with:

- Left color bar (3px) — blue for task, green for completed, yellow for decision/branch, red for failed, gray for pending
- Type label — small uppercase: "TASK", "TIMER", "DECISION"
- Node name — bold (e.g. "Inspect", "Wait", "Fix")
- Status + duration (e.g. "done · 17s", "running · 2m")
- Agent model + token count (e.g. "opus-4-6 · 22k tokens")
- Iteration badge — "iter 3" pill if inside a loop
- Attempt count — "attempt 2" in muted text if retried

**Node states:**

- `pending/idle` — dimmed (opacity 0.5), gray border
- `running` — full opacity, blue border, subtle pulsing glow
- `done` — full opacity, green left bar
- `failed` — full opacity, red left bar and border
- `waiting` — full opacity, blue dashed border
- `skipped` — dimmed, dashed gray border, strikethrough label

**Wires (SVG bezier curves):**

- Color matches source node status (green if done, gray if pending)
- Animated dash pattern on active wires (source done, target running)
- Branch wires fork downward, parallel wires stack vertically

**Loop boundaries:** Dashed rounded rectangle enclosing looped nodes. Label: "watch loop · iter 3".

**Active node glow:** Currently running node gets a subtle blue box-shadow pulse animation.

## Auto-Layout

Graph topology comes from `smithers graph <workflow.tsx> --format json`, which returns the full XML tree of the workflow. The layout algorithm reads the tree structure:

1. `smithers:sequence` children → laid out left-to-right, evenly spaced
2. `smithers:branch` children → fork downward from the parent node
3. `smithers:ralph` (loop) children → enclosed in a dashed boundary box
4. `smithers:task` / `smithers:timer` → leaf nodes rendered as cards
5. Parallel nodes → stacked vertically at the same x position

Layout is computed client-side via topological sort and coordinate assignment, using the cached graph topology as input and the run's node states as overlay.

## Data Sources

Mixed approach: smithers CLI for structured run data, direct DB queries for data the CLI doesn't surface.

### From smithers CLI (reuse existing)

- **`smithers inspect <runId> --format json`** — step states, loop iterations, timers, elapsed time
- **`smithers why <runId> --format json`** — blocker info, current node, summary
- **`smithers graph <workflow.tsx> --format json`** — workflow topology (node tree, types, connections, loop membership)

### From direct DB queries (supplements)

- **Run list with repo grouping:** `SELECT run_id, workflow_name, workflow_path, status, vcs_root, created_at_ms, started_at_ms, finished_at_ms FROM _smithers_runs ORDER BY created_at_ms DESC`
- **Token usage per node:** Query `_smithers_events` where `type = 'TokenUsageReported'`, parse `payload_json` to extract `nodeId`, `iteration`, `inputTokens`, `outputTokens`, `cacheReadTokens`, then aggregate per node. Example payload: `{"type":"TokenUsageReported","nodeId":"inspect","iteration":0,"attempt":1,"model":"claude-opus-4-6","inputTokens":4,"outputTokens":361,"cacheReadTokens":21880,...}`
- **Agent model per attempt:** `SELECT node_id, iteration, attempt, json_extract(meta_json, '$.agentModel') FROM _smithers_attempts WHERE run_id = ?`

Uses `bun:sqlite` (built into Bun, zero dependencies) for direct queries.

## API Endpoints

### `GET /api/runs`

Direct DB query. Groups runs by `vcs_root`.

Response:

```json
{
  "repos": [
    {
      "name": "fhevm",
      "path": "/Users/work/code/zama/fhevm",
      "runs": [
        {
          "id": "run-123",
          "workflow": "ci-watch-babysit",
          "workflowPath": ".smithers/workflows/ci-watch-babysit.tsx",
          "status": "waiting-timer",
          "startedAtMs": 1776096537305,
          "elapsedMs": 720000
        }
      ]
    }
  ],
  "now": "2026-04-14T..."
}
```

### `GET /api/run/:id`

Calls `smithers inspect` + `smithers why` (existing), adds DB queries for tokens and agent model.

Response:

```json
{
  "inspect": { "...existing inspect response..." },
  "why": { "...existing why response..." },
  "tokensByNode": {
    "inspect:0": { "input": 4, "output": 361, "cacheRead": 21880, "total": 22245 }
  },
  "agentByNode": {
    "inspect:0:1": "claude-opus-4-6"
  },
  "now": "2026-04-14T..."
}
```

### `GET /api/graph/:workflow`

Calls `smithers graph <workflow> --format json`. Cached in memory; invalidated after 60s.

Response: raw `smithers graph` JSON output (XML tree with tasks metadata).

## Tech Stack

- **Runtime:** Bun (existing)
- **Server:** Bun HTTP server (existing)
- **Client:** React 19 (existing), single-file bundle via Bun bundler
- **DB access:** `bun:sqlite` (built-in, zero dependencies)
- **Styling:** Plain CSS (existing approach)
- **Graph rendering:** HTML/CSS nodes + SVG wire overlay (no library)
- **New dependencies:** None

## File Structure

All files remain in `dashboard/`:

- `server.ts` — rewritten: Bun HTTP + bun:sqlite + smithers CLI calls
- `client.tsx` — rewritten: sidebar, canvas, node graph components
- `styles.css` — rewritten: Blueprint dark theme
- `index.html` — unchanged

## Workflows Supported

The auto-layout handles any workflow topology produced by `smithers graph`. The four current workflows serve as the primary test cases:

- **ci-watch-babysit** — loop with conditional branches (Wait → Inspect → Classify → Fix/Rerun → Report)
- **implement-review-fix** — loop with parallel fan-out (Implement → Validate → Review×N → Summary)
- **ci-babysit** — linear sequence with conditional skips (Inspect → Fix? → Rerun? → Report)
- **pr-babysit** — linear sequence with conditional skip (Inspect → Fix? → Report)
