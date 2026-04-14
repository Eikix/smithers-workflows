# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the debug-oriented dashboard with an Unreal Blueprint-style node graph monitoring view that shows workflow runs grouped by repo, with rich per-node status, token usage, and agent model information.

**Architecture:** Sidebar + Canvas layout. Server queries smithers.db directly via `bun:sqlite` for run listing with repo grouping, keeps `smithers inspect`/`why`/`graph` CLI for structured run data, and adds DB queries for token usage and agent model. Client renders an auto-laid-out node graph using HTML/CSS nodes with an SVG wire overlay.

**Tech Stack:** Bun runtime, React 19, bun:sqlite, plain CSS, SVG for wires. No new dependencies.

---

## File Structure

| File                   | Action  | Responsibility                                                              |
| ---------------------- | ------- | --------------------------------------------------------------------------- |
| `dashboard/server.ts`  | Rewrite | HTTP server with bun:sqlite + smithers CLI, 3 API endpoints                 |
| `dashboard/client.tsx` | Rewrite | React app: App shell, Sidebar, Canvas, NodeCard, WireOverlay, layout engine |
| `dashboard/styles.css` | Rewrite | Blueprint dark theme with dot-grid, node cards, wire animations             |
| `dashboard/index.html` | Keep    | Unchanged HTML shell                                                        |

---

### Task 1: Rewrite server.ts — Database queries and API endpoints

**Files:**

- Rewrite: `dashboard/server.ts`

The server needs three API endpoints: `/api/runs` (direct DB), `/api/run/:id` (CLI + DB supplement), `/api/graph/:workflow` (CLI + cache). Keep the existing Bun HTTP server pattern, `runSmithers()` helper, and `withRetry()` logic. Add `bun:sqlite` for direct queries.

- [ ] **Step 1: Write the new server.ts**

Replace the contents of `dashboard/server.ts` with:

```typescript
import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const root = import.meta.dir;
const indexPath = join(root, "index.html");
const clientEntry = join(root, "client.tsx");
const buildDir = join(root, ".build");
const clientPath = join(buildDir, "client.js");
const stylesPath = join(root, "styles.css");
const workspaceRoot = process.cwd();
const databasePath = join(workspaceRoot, "smithers.db");
const smithersBin = join(workspaceRoot, "node_modules", ".bin", "smithers");

// --- Database ---

function openDatabase() {
  return new Database(databasePath, { readonly: true });
}

type RunRow = {
  run_id: string;
  workflow_name: string;
  workflow_path: string | null;
  status: string;
  vcs_root: string | null;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
};

type TokenEventRow = {
  node_id: string;
  iteration: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
};

type AgentModelRow = {
  node_id: string;
  iteration: number;
  attempt: number;
  agent_model: string | null;
};

function queryAllRuns(): RunRow[] {
  const db = openDatabase();
  try {
    return db
      .query(
        `SELECT run_id, workflow_name, workflow_path, status, vcs_root,
                created_at_ms, started_at_ms, finished_at_ms
         FROM _smithers_runs
         ORDER BY created_at_ms DESC`,
      )
      .all() as RunRow[];
  } finally {
    db.close();
  }
}

function queryTokenUsage(runId: string): TokenEventRow[] {
  const db = openDatabase();
  try {
    return db
      .query(
        `SELECT
           json_extract(payload_json, '$.nodeId') as node_id,
           json_extract(payload_json, '$.iteration') as iteration,
           SUM(json_extract(payload_json, '$.inputTokens')) as input_tokens,
           SUM(json_extract(payload_json, '$.outputTokens')) as output_tokens,
           SUM(json_extract(payload_json, '$.cacheReadTokens')) as cache_read_tokens
         FROM _smithers_events
         WHERE type = 'TokenUsageReported' AND run_id = ?
         GROUP BY node_id, iteration`,
      )
      .all(runId) as TokenEventRow[];
  } finally {
    db.close();
  }
}

function queryAgentModels(runId: string): AgentModelRow[] {
  const db = openDatabase();
  try {
    return db
      .query(
        `SELECT node_id, iteration, attempt,
                json_extract(meta_json, '$.agentModel') as agent_model
         FROM _smithers_attempts
         WHERE run_id = ? AND meta_json IS NOT NULL`,
      )
      .all(runId) as AgentModelRow[];
  } finally {
    db.close();
  }
}

function groupRunsByRepo(rows: RunRow[], nowMs: number) {
  const repoMap = new Map<
    string,
    { name: string; path: string; runs: unknown[] }
  >();

  for (const row of rows) {
    const repoPath = row.vcs_root ?? "unknown";
    const repoName = basename(repoPath);

    if (!repoMap.has(repoPath)) {
      repoMap.set(repoPath, { name: repoName, path: repoPath, runs: [] });
    }

    repoMap.get(repoPath)!.runs.push({
      id: row.run_id,
      workflow: row.workflow_name,
      workflowPath: row.workflow_path,
      status: row.status,
      startedAtMs: row.started_at_ms,
      elapsedMs: row.started_at_ms ? nowMs - row.started_at_ms : null,
      finishedAtMs: row.finished_at_ms,
    });
  }

  return Array.from(repoMap.values());
}

function buildTokenMap(rows: TokenEventRow[]) {
  const map: Record<
    string,
    { input: number; output: number; cacheRead: number; total: number }
  > = {};
  for (const row of rows) {
    const key = `${row.node_id}:${row.iteration}`;
    map[key] = {
      input: row.input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      cacheRead: row.cache_read_tokens ?? 0,
      total:
        (row.input_tokens ?? 0) +
        (row.output_tokens ?? 0) +
        (row.cache_read_tokens ?? 0),
    };
  }
  return map;
}

function buildAgentMap(rows: AgentModelRow[]) {
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.agent_model) {
      map[`${row.node_id}:${row.iteration}:${row.attempt}`] = row.agent_model;
    }
  }
  return map;
}

// --- Smithers CLI ---

type Json = Record<string, unknown>;

async function runSmithers(args: string[]) {
  const proc = Bun.spawn({
    cmd: [smithersBin, ...args, "--format", "json"],
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      stderr.trim() || stdout.trim() || `smithers exited with ${exitCode}`,
    );
  }

  return JSON.parse(stdout) as Json;
}

function shouldRetry(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("database is locked");
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || index === attempts - 1) {
        throw error;
      }
      await Bun.sleep(150 * (index + 1));
    }
  }
  throw lastError;
}

// --- Graph cache ---

const graphCache = new Map<string, { data: Json; cachedAtMs: number }>();
const GRAPH_CACHE_TTL_MS = 60_000;

async function getWorkflowGraph(workflowPath: string) {
  const cached = graphCache.get(workflowPath);
  const now = Date.now();
  if (cached && now - cached.cachedAtMs < GRAPH_CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await runSmithers(["graph", workflowPath]);
  graphCache.set(workflowPath, { data, cachedAtMs: now });
  return data;
}

// --- HTTP helpers ---

function jsonResponse(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function errorResponse(error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: message }, status);
}

// --- Build ---

async function buildDashboardBundle() {
  await mkdir(buildDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [clientEntry],
    outdir: buildDir,
    naming: "client.js",
    minify: false,
    target: "browser",
    format: "esm",
  });

  if (!result.success) {
    throw new Error(
      result.logs.map((log) => log.message).join("\n") ||
        "Failed to build dashboard client",
    );
  }
}

const dashboardBundle = buildDashboardBundle();

// --- Server ---

const server = Bun.serve({
  port: Number(process.env.PORT || 4311),
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);

    // Static assets
    if (url.pathname === "/") {
      await dashboardBundle;
      return new Response(await readFile(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/assets/client.js") {
      await dashboardBundle;
      return new Response(await readFile(clientPath), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    if (url.pathname === "/assets/styles.css") {
      return new Response(await readFile(stylesPath), {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }

    // API: list all runs grouped by repo
    if (url.pathname === "/api/runs") {
      try {
        const rows = queryAllRuns();
        const repos = groupRunsByRepo(rows, Date.now());
        return jsonResponse({ repos, now: new Date().toISOString() });
      } catch (error) {
        return errorResponse(error);
      }
    }

    // API: run detail
    const runMatch = url.pathname.match(/^\/api\/run\/([^/]+)$/);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      try {
        const [inspect, why, tokenRows, agentRows] = await Promise.all([
          withRetry(() => runSmithers(["inspect", runId])),
          withRetry(() => runSmithers(["why", runId])),
          Promise.resolve(queryTokenUsage(runId)),
          Promise.resolve(queryAgentModels(runId)),
        ]);

        return jsonResponse({
          inspect,
          why,
          tokensByNode: buildTokenMap(tokenRows),
          agentByNode: buildAgentMap(agentRows),
          now: new Date().toISOString(),
        });
      } catch (error) {
        return errorResponse(error);
      }
    }

    // API: workflow graph topology
    const graphMatch = url.pathname.match(/^\/api\/graph\/(.+)$/);
    if (graphMatch) {
      const workflowPath = decodeURIComponent(graphMatch[1]);
      try {
        const graph = await getWorkflowGraph(workflowPath);
        return jsonResponse(graph);
      } catch (error) {
        return errorResponse(error);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Smithers dashboard listening on http://127.0.0.1:${server.port}`);
```

- [ ] **Step 2: Verify the server starts and APIs respond**

Run: `bun run dashboard/server.ts &`

Then test each endpoint:

```bash
curl -s http://127.0.0.1:4311/api/runs | head -c 500
curl -s http://127.0.0.1:4311/api/run/run-1776096537305 | head -c 500
curl -s "http://127.0.0.1:4311/api/graph/.smithers/workflows/ci-watch-babysit.tsx" | head -c 500
```

Expected: JSON responses for all three. `/api/runs` should have `repos` array with runs grouped by repo name. `/api/run/:id` should include `tokensByNode` and `agentByNode` alongside `inspect` and `why`. `/api/graph/:workflow` should return the XML tree.

- [ ] **Step 3: Commit**

```bash
git add dashboard/server.ts
git commit -m "feat(dashboard): rewrite server with bun:sqlite and graph/token/agent APIs"
```

---

### Task 2: Write the Blueprint CSS theme

**Files:**

- Rewrite: `dashboard/styles.css`

Full CSS rewrite for the Unreal Blueprint aesthetic. Defines the dark dot-grid canvas, node card styles with left color bars, wire animation keyframes, sidebar with collapse states, and all status-driven color variants.

- [ ] **Step 1: Write the new styles.css**

Replace the contents of `dashboard/styles.css` with:

```css
:root {
  color-scheme: dark;
  --bg: #0d1117;
  --bg-sidebar: #010409;
  --panel: #161b22;
  --border: #30363d;
  --border-accent: rgba(87, 199, 255, 0.5);
  --text: #e6edf3;
  --muted: #7d8590;
  --accent: #57c7ff;
  --good: #56d4a7;
  --warn: #f2c66d;
  --bad: #ff7b72;

  --node-width: 220px;
  --node-gap-x: 80px;
  --node-gap-y: 60px;
  --sidebar-width: 280px;
  --sidebar-collapsed: 48px;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
}

button,
input,
textarea,
select {
  font: inherit;
}

h1,
h2,
h3,
p,
pre {
  margin: 0;
}

/* --- App Shell --- */

.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* --- Sidebar --- */

.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition:
    width 0.2s ease,
    min-width 0.2s ease;
}

.sidebar.collapsed {
  width: var(--sidebar-collapsed);
  min-width: var(--sidebar-collapsed);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border);
  gap: 8px;
}

.sidebar-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.03em;
  white-space: nowrap;
  overflow: hidden;
}

.sidebar.collapsed .sidebar-title,
.sidebar.collapsed .toggle-finished,
.sidebar.collapsed .repo-header,
.sidebar.collapsed .run-card-details {
  display: none;
}

.collapse-button {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
}

.collapse-button:hover {
  background: var(--panel);
  color: var(--text);
}

.toggle-finished {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
}

.toggle-finished input[type="checkbox"] {
  accent-color: var(--accent);
}

.run-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.repo-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 8px 4px;
  margin-top: 8px;
}

.repo-header:first-child {
  margin-top: 0;
}

.repo-name {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent);
}

.repo-count {
  font-size: 11px;
  color: var(--muted);
}

.run-card {
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  text-align: left;
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s;
}

.run-card:hover {
  border-color: rgba(255, 255, 255, 0.15);
}

.run-card.selected {
  border-color: var(--border-accent);
}

.run-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.run-card-workflow {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.run-card-details {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.run-card-meta {
  font-size: 11px;
  color: var(--muted);
}

/* Collapsed sidebar: just dots */
.sidebar.collapsed .run-card {
  width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 4px auto;
  border-radius: 50%;
}

/* --- Status pill --- */

.pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border: 1px solid transparent;
  white-space: nowrap;
}

.pill-live {
  color: var(--accent);
  background: rgba(87, 199, 255, 0.14);
  border-color: rgba(87, 199, 255, 0.26);
}

.pill-good {
  color: var(--good);
  background: rgba(86, 212, 167, 0.14);
  border-color: rgba(86, 212, 167, 0.24);
}

.pill-warn {
  color: var(--warn);
  background: rgba(242, 198, 109, 0.14);
  border-color: rgba(242, 198, 109, 0.24);
}

.pill-bad {
  color: var(--bad);
  background: rgba(255, 123, 114, 0.14);
  border-color: rgba(255, 123, 114, 0.24);
}

.pill-neutral {
  color: var(--muted);
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--border);
}

/* Status dot for collapsed sidebar */
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.status-dot.live {
  background: var(--accent);
}
.status-dot.good {
  background: var(--good);
}
.status-dot.warn {
  background: var(--warn);
}
.status-dot.bad {
  background: var(--bad);
}
.status-dot.neutral {
  background: var(--muted);
}

/* --- Canvas --- */

.canvas {
  flex: 1;
  position: relative;
  overflow: auto;
  background-color: var(--bg);
  background-image: radial-gradient(#ffffff08 1px, transparent 1px);
  background-size: 20px 20px;
}

.canvas-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 14px;
}

.graph-container {
  position: relative;
  padding: 40px;
  min-width: fit-content;
  min-height: fit-content;
}

/* --- Wires (SVG overlay) --- */

.wire-layer {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  overflow: visible;
}

.wire {
  fill: none;
  stroke-width: 2;
}

.wire-pending {
  stroke: var(--border);
}

.wire-done {
  stroke: var(--good);
}

.wire-active {
  stroke: var(--accent);
  stroke-dasharray: 8 4;
  animation: wire-flow 0.6s linear infinite;
}

.wire-failed {
  stroke: var(--bad);
}

@keyframes wire-flow {
  to {
    stroke-dashoffset: -12;
  }
}

/* --- Node Card --- */

.node-card {
  position: absolute;
  width: var(--node-width);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  transition:
    border-color 0.2s,
    opacity 0.2s,
    box-shadow 0.2s;
}

.node-card-bar {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
}

.node-card-bar.task {
  background: var(--accent);
}
.node-card-bar.timer {
  background: var(--warn);
}
.node-card-bar.decision {
  background: var(--warn);
}
.node-card-bar.done {
  background: var(--good);
}
.node-card-bar.failed {
  background: var(--bad);
}
.node-card-bar.pending {
  background: var(--muted);
}

.node-card-body {
  padding: 10px 12px 10px 14px;
}

.node-type-label {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin-bottom: 2px;
}

.node-name {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 4px;
}

.node-status-line {
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 2px;
}

.node-detail-line {
  font-size: 10px;
  color: var(--muted);
}

.node-badges {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.node-badge {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  border: 1px solid var(--border);
}

/* Node states */

.node-card.pending {
  opacity: 0.5;
}

.node-card.running {
  border-color: var(--accent);
  box-shadow: 0 0 12px rgba(87, 199, 255, 0.2);
  animation: node-pulse 2s ease-in-out infinite;
}

.node-card.done {
  border-color: rgba(86, 212, 167, 0.3);
}

.node-card.failed {
  border-color: var(--bad);
}

.node-card.waiting {
  border-color: var(--accent);
  border-style: dashed;
}

.node-card.skipped {
  opacity: 0.4;
  border-style: dashed;
}

.node-card.skipped .node-name {
  text-decoration: line-through;
}

@keyframes node-pulse {
  0%,
  100% {
    box-shadow: 0 0 12px rgba(87, 199, 255, 0.2);
  }
  50% {
    box-shadow: 0 0 20px rgba(87, 199, 255, 0.35);
  }
}

/* --- Loop boundary --- */

.loop-boundary {
  position: absolute;
  border: 1px dashed rgba(87, 199, 255, 0.25);
  border-radius: 12px;
  pointer-events: none;
}

.loop-label {
  position: absolute;
  top: -10px;
  left: 16px;
  background: var(--bg);
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
}

/* --- Error notice --- */

.notice-error {
  margin: 16px;
  padding: 12px 16px;
  border-radius: 8px;
  background: rgba(255, 123, 114, 0.1);
  border: 1px solid rgba(255, 123, 114, 0.25);
  color: var(--bad);
  font-size: 13px;
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/styles.css
git commit -m "feat(dashboard): blueprint dark theme with node cards, wires, and sidebar"
```

---

### Task 3: Write the React client — Types and data fetching

**Files:**

- Rewrite: `dashboard/client.tsx` (first part — types and hooks)

Start the client rewrite with shared types, fetch helpers, and the two data-fetching hooks. This establishes the foundation that all UI components will use.

- [ ] **Step 1: Write the types and hooks portion of client.tsx**

Replace `dashboard/client.tsx` with the following (we'll add components in subsequent tasks, building up the file incrementally):

```tsx
/** @jsxImportSource react */
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

// ---- Types ----

type RepoGroup = {
  name: string;
  path: string;
  runs: RunSummary[];
};

type RunSummary = {
  id: string;
  workflow: string;
  workflowPath: string | null;
  status: string;
  startedAtMs: number | null;
  elapsedMs: number | null;
  finishedAtMs: number | null;
};

type RunsResponse = {
  repos: RepoGroup[];
  now: string;
};

type Step = {
  id: string;
  state: string;
  label?: string;
  attempt?: number;
  output?: unknown;
};

type LoopState = {
  loopId: string;
  iteration: number;
};

type TimerState = {
  timerId: string;
  remaining?: string;
  firesAt?: string;
};

type Blocker = {
  kind: string;
  nodeId: string;
  reason?: string;
};

type RunDetailResponse = {
  inspect: {
    run?: {
      id: string;
      workflow: string;
      status: string;
      started?: string;
      elapsed?: string;
    };
    steps?: Step[];
    loops?: LoopState[];
    timers?: TimerState[];
  };
  why: {
    summary?: string;
    currentNodeId?: string;
    blockers?: Blocker[];
  };
  tokensByNode: Record<
    string,
    { input: number; output: number; cacheRead: number; total: number }
  >;
  agentByNode: Record<string, string>;
  now: string;
};

type XmlNode = {
  kind: "element" | "text";
  tag?: string;
  props?: Record<string, string>;
  children?: XmlNode[];
  text?: string;
};

type GraphResponse = {
  xml: XmlNode;
  tasks: Array<{
    nodeId: string;
    ordinal: number;
    iteration: number;
    ralphId?: string;
  }>;
};

type LayoutNode = {
  id: string;
  type: "task" | "timer" | "branch" | "sequence" | "loop";
  label: string;
  x: number;
  y: number;
  loopId?: string;
  parentIds: string[];
  childIds: string[];
};

type LayoutEdge = {
  sourceId: string;
  targetId: string;
};

type LayoutResult = {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  loops: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
  }>;
  width: number;
  height: number;
};

// ---- Constants ----

const NODE_WIDTH = 220;
const NODE_HEIGHT = 120;
const GAP_X = 80;
const GAP_Y = 60;
const LOOP_PADDING = 24;
const POLL_INTERVAL_MS = 5000;

// ---- Fetch helpers ----

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return (await response.json()) as T;
}

// ---- Status helpers ----

function statusTone(status?: string): string {
  if (!status) return "neutral";
  if (
    [
      "running",
      "waiting-timer",
      "waiting-event",
      "waiting-approval",
      "in-progress",
    ].includes(status)
  )
    return "live";
  if (["finished", "success", "completed"].includes(status)) return "good";
  if (["failed", "cancelled"].includes(status)) return "bad";
  return "warn";
}

function nodeStateFromStep(step?: Step): string {
  if (!step) return "pending";
  const state = step.state ?? "";
  if (state === "finished") return "done";
  if (state === "failed") return "failed";
  if (state === "running" || state === "in-progress") return "running";
  if (state.startsWith("waiting")) return "waiting";
  if (state === "skipped") return "skipped";
  return "pending";
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatTokenCount(total: number): string {
  if (total < 1000) return `${total}`;
  return `${Math.round(total / 1000)}k`;
}

function shortenModelName(model: string): string {
  return model.replace("claude-", "").replace("gpt-", "");
}

// Components and layout engine will follow in Tasks 4-7.
// For now, render a placeholder to verify the build works.

function App() {
  return (
    <div className="app-shell">
      <div className="canvas-empty">Dashboard loading...</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 2: Verify the build works**

Run: `bun run dashboard`

Open `http://127.0.0.1:4311` — should see "Dashboard loading..." text on a dark background.

- [ ] **Step 3: Commit**

```bash
git add dashboard/client.tsx
git commit -m "feat(dashboard): client types, fetch helpers, and status utilities"
```

---

### Task 4: Layout engine — convert XML tree to positioned nodes

**Files:**

- Modify: `dashboard/client.tsx` (add layout engine before the `App` component)

The layout engine takes the `smithers graph` XML tree and produces positioned nodes and edges. It walks the tree recursively: sequences go left-to-right, branches fork downward, loops get boundary boxes, parallel nodes stack vertically.

- [ ] **Step 1: Add the layout engine to client.tsx**

Insert the following code in `dashboard/client.tsx` directly before the `// Components and layout engine will follow` comment (replace that comment and the placeholder `App`):

```tsx
// ---- Layout engine ----

function extractNodesFromXml(
  xml: XmlNode,
): { id: string; type: LayoutNode["type"]; label: string; loopId?: string }[] {
  const result: {
    id: string;
    type: LayoutNode["type"];
    label: string;
    loopId?: string;
  }[] = [];

  function walk(node: XmlNode, currentLoopId?: string) {
    if (node.kind !== "element" || !node.tag) return;

    const tag = node.tag.replace("smithers:", "");
    const id = node.props?.id;

    if (tag === "task" && id) {
      result.push({ id, type: "task", label: id, loopId: currentLoopId });
    } else if (tag === "timer" && id) {
      result.push({ id, type: "timer", label: id, loopId: currentLoopId });
    } else if (tag === "ralph" && id) {
      // Loop — descend into children with this loop id
      for (const child of node.children ?? []) {
        walk(child, id);
      }
      return; // Don't descend again below
    }

    // Descend for structural nodes (sequence, branch, parallel, workflow)
    for (const child of node.children ?? []) {
      walk(child, currentLoopId);
    }
  }

  walk(xml);
  return result;
}

function buildEdgesFromXml(xml: XmlNode): LayoutEdge[] {
  const edges: LayoutEdge[] = [];

  function walkStructure(node: XmlNode): string[] {
    if (node.kind !== "element" || !node.tag) return [];
    const tag = node.tag.replace("smithers:", "");

    if (tag === "task" || tag === "timer") {
      const id = node.props?.id;
      return id ? [id] : [];
    }

    if (tag === "sequence" || tag === "ralph") {
      const elementChildren = (node.children ?? []).filter(
        (child) => child.kind === "element" && child.tag,
      );

      let previousOutputs: string[] = [];
      let allOutputs: string[] = [];

      for (const child of elementChildren) {
        const childOutputs = walkStructure(child);
        // Connect previous group outputs to this group inputs
        if (previousOutputs.length > 0 && childOutputs.length > 0) {
          // For sequences: connect last of previous to first of current
          // We need the "first" nodes of this child — the inputs
          const childInputs = getInputNodes(child);
          for (const from of previousOutputs) {
            for (const to of childInputs) {
              edges.push({ sourceId: from, targetId: to });
            }
          }
        }
        previousOutputs = childOutputs;
        if (allOutputs.length === 0) allOutputs = childOutputs;
      }

      return previousOutputs; // The outputs of the last child
    }

    if (tag === "parallel") {
      const allOutputs: string[] = [];
      for (const child of node.children ?? []) {
        const childOutputs = walkStructure(child);
        allOutputs.push(...childOutputs);
      }
      return allOutputs;
    }

    if (tag === "branch") {
      // Branch children are conditional — each is an independent path
      const allOutputs: string[] = [];
      for (const child of node.children ?? []) {
        const childOutputs = walkStructure(child);
        allOutputs.push(...childOutputs);
      }
      return allOutputs;
    }

    if (tag === "workflow") {
      // Treat workflow like a sequence
      return walkStructure({
        kind: "element",
        tag: "smithers:sequence",
        props: {},
        children: node.children,
      });
    }

    return [];
  }

  function getInputNodes(node: XmlNode): string[] {
    if (node.kind !== "element" || !node.tag) return [];
    const tag = node.tag.replace("smithers:", "");

    if (tag === "task" || tag === "timer") {
      const id = node.props?.id;
      return id ? [id] : [];
    }

    if (tag === "sequence" || tag === "ralph") {
      const firstChild = (node.children ?? []).find(
        (child) => child.kind === "element" && child.tag,
      );
      return firstChild ? getInputNodes(firstChild) : [];
    }

    if (tag === "parallel" || tag === "branch") {
      const inputs: string[] = [];
      for (const child of node.children ?? []) {
        inputs.push(...getInputNodes(child));
      }
      return inputs;
    }

    return [];
  }

  walkStructure(xml);
  return edges;
}

function computeLayout(graph: GraphResponse): LayoutResult {
  const xmlNodes = extractNodesFromXml(graph.xml);
  const edges = buildEdgesFromXml(graph.xml);

  // Build adjacency for topological positioning
  const nodeMap = new Map(xmlNodes.map((node) => [node.id, node]));
  const inDegree = new Map<string, number>();
  const outEdges = new Map<string, string[]>();

  for (const node of xmlNodes) {
    inDegree.set(node.id, 0);
    outEdges.set(node.id, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.targetId, (inDegree.get(edge.targetId) ?? 0) + 1);
    outEdges.get(edge.sourceId)?.push(edge.targetId);
  }

  // Assign columns via topological sort (BFS)
  const column = new Map<string, number>();
  const queue: string[] = [];

  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const col = column.get(id) ?? 0;

    for (const targetId of outEdges.get(id) ?? []) {
      const nextCol = Math.max(column.get(targetId) ?? 0, col + 1);
      column.set(targetId, nextCol);
      inDegree.set(targetId, (inDegree.get(targetId) ?? 0) - 1);
      if (inDegree.get(targetId) === 0) queue.push(targetId);
    }
  }

  // Group nodes by column, assign rows
  const columnGroups = new Map<number, string[]>();
  for (const node of xmlNodes) {
    const col = column.get(node.id) ?? 0;
    if (!columnGroups.has(col)) columnGroups.set(col, []);
    columnGroups.get(col)!.push(node.id);
  }

  const layoutNodes: LayoutNode[] = [];
  let maxCol = 0;
  let maxRow = 0;

  for (const [col, ids] of columnGroups) {
    maxCol = Math.max(maxCol, col);
    maxRow = Math.max(maxRow, ids.length - 1);

    for (let row = 0; row < ids.length; row++) {
      const id = ids[row];
      const xmlNode = nodeMap.get(id)!;
      const incomingEdges = edges.filter((edge) => edge.targetId === id);
      const outgoingEdges = edges.filter((edge) => edge.sourceId === id);

      layoutNodes.push({
        id,
        type: xmlNode.type,
        label: xmlNode.label,
        x: col * (NODE_WIDTH + GAP_X),
        y: row * (NODE_HEIGHT + GAP_Y),
        loopId: xmlNode.loopId,
        parentIds: incomingEdges.map((edge) => edge.sourceId),
        childIds: outgoingEdges.map((edge) => edge.targetId),
      });
    }
  }

  // Compute loop boundaries
  const loopBounds: LayoutResult["loops"] = [];
  const loopIds = new Set(
    xmlNodes.filter((node) => node.loopId).map((node) => node.loopId!),
  );

  for (const loopId of loopIds) {
    const loopNodes = layoutNodes.filter((node) => node.loopId === loopId);
    if (loopNodes.length === 0) continue;

    const minX = Math.min(...loopNodes.map((node) => node.x));
    const minY = Math.min(...loopNodes.map((node) => node.y));
    const maxX = Math.max(...loopNodes.map((node) => node.x));
    const maxY = Math.max(...loopNodes.map((node) => node.y));

    loopBounds.push({
      id: loopId,
      x: minX - LOOP_PADDING,
      y: minY - LOOP_PADDING,
      width: maxX - minX + NODE_WIDTH + LOOP_PADDING * 2,
      height: maxY - minY + NODE_HEIGHT + LOOP_PADDING * 2,
      label: loopId,
    });
  }

  const totalWidth = (maxCol + 1) * (NODE_WIDTH + GAP_X) - GAP_X;
  const totalHeight = (maxRow + 1) * (NODE_HEIGHT + GAP_Y) - GAP_Y;

  return {
    nodes: layoutNodes,
    edges,
    loops: loopBounds,
    width: totalWidth,
    height: totalHeight,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/client.tsx
git commit -m "feat(dashboard): auto-layout engine for workflow graph topology"
```

---

### Task 5: Sidebar component

**Files:**

- Modify: `dashboard/client.tsx` (add Sidebar component after layout engine)

The Sidebar component shows runs grouped by repo, supports collapsing, and has a "hide finished" toggle.

- [ ] **Step 1: Add the Sidebar component to client.tsx**

Insert after the layout engine code:

```tsx
// ---- Sidebar ----

function Sidebar({
  repos,
  selectedRunId,
  onSelectRun,
  collapsed,
  onToggleCollapse,
}: {
  repos: RepoGroup[];
  selectedRunId: string;
  onSelectRun: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [hideFinished, setHideFinished] = useState(false);

  const filteredRepos = useMemo(() => {
    if (!hideFinished) return repos;
    return repos
      .map((repo) => ({
        ...repo,
        runs: repo.runs.filter(
          (run) =>
            !["finished", "completed", "success", "cancelled"].includes(
              run.status,
            ),
        ),
      }))
      .filter((repo) => repo.runs.length > 0);
  }, [repos, hideFinished]);

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        <span className="sidebar-title">Smithers</span>
        <button
          className="collapse-button"
          onClick={onToggleCollapse}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          type="button"
        >
          {collapsed ? "→" : "←"}
        </button>
      </div>

      <label className="toggle-finished">
        <input
          type="checkbox"
          checked={hideFinished}
          onChange={(event) => setHideFinished(event.target.checked)}
        />
        Hide finished
      </label>

      <div className="run-list">
        {filteredRepos.map((repo) => (
          <div key={repo.path}>
            <div className="repo-header">
              <span className="repo-name">{repo.name}</span>
              <span className="repo-count">
                {
                  repo.runs.filter((run) => statusTone(run.status) === "live")
                    .length
                }{" "}
                active
              </span>
            </div>
            {repo.runs.map((run) => (
              <button
                key={run.id}
                className={`run-card${run.id === selectedRunId ? " selected" : ""}`}
                onClick={() => onSelectRun(run.id)}
                type="button"
                title={`${run.workflow} — ${run.status}`}
              >
                <div className="run-card-top">
                  <span className="run-card-workflow">
                    {collapsed ? null : run.workflow}
                  </span>
                  {collapsed ? (
                    <span className={`status-dot ${statusTone(run.status)}`} />
                  ) : (
                    <span className={`pill pill-${statusTone(run.status)}`}>
                      {run.status}
                    </span>
                  )}
                </div>
                <div className="run-card-details">
                  <span className="run-card-meta">
                    {formatDuration(run.elapsedMs)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        ))}
        {filteredRepos.length === 0 ? (
          <div className="canvas-empty" style={{ padding: "24px 0" }}>
            No runs to show.
          </div>
        ) : null}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/client.tsx
git commit -m "feat(dashboard): sidebar component with repo grouping and collapse"
```

---

### Task 6: Canvas components — NodeCard, WireOverlay, LoopBoundary

**Files:**

- Modify: `dashboard/client.tsx` (add canvas components after Sidebar)

The canvas renders the node graph: positioned NodeCards, SVG bezier wires, and loop boundary boxes.

- [ ] **Step 1: Add canvas components to client.tsx**

Insert after the Sidebar component:

```tsx
// ---- Canvas components ----

function NodeCard({
  node,
  step,
  tokens,
  agentModel,
  loopIteration,
}: {
  node: LayoutNode;
  step?: Step;
  tokens?: { input: number; output: number; cacheRead: number; total: number };
  agentModel?: string;
  loopIteration?: number;
}) {
  const state = nodeStateFromStep(step);
  const duration = step?.state === "finished" ? "" : ""; // Duration comes from attempt timing
  const barClass =
    state === "done"
      ? "done"
      : state === "failed"
        ? "failed"
        : state === "pending"
          ? "pending"
          : node.type;

  return (
    <div className={`node-card ${state}`} style={{ left: node.x, top: node.y }}>
      <div className={`node-card-bar ${barClass}`} />
      <div className="node-card-body">
        <div className="node-type-label">{node.type}</div>
        <div className="node-name">{node.label}</div>
        <div className="node-status-line">
          {step?.state ?? "pending"}
          {step?.attempt && step.attempt > 1
            ? ` · attempt ${step.attempt}`
            : ""}
        </div>
        {tokens || agentModel ? (
          <div className="node-detail-line">
            {agentModel ? shortenModelName(agentModel) : ""}
            {agentModel && tokens ? " · " : ""}
            {tokens ? `${formatTokenCount(tokens.total)} tokens` : ""}
          </div>
        ) : null}
        {loopIteration != null ? (
          <div className="node-badges">
            <span className="node-badge">iter {loopIteration}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function computeBezierPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): string {
  const midX = (sourceX + targetX) / 2;
  return `M ${sourceX} ${sourceY} C ${midX} ${sourceY}, ${midX} ${targetY}, ${targetX} ${targetY}`;
}

function WireOverlay({
  layout,
  steps,
}: {
  layout: LayoutResult;
  steps: Step[];
}) {
  const nodePositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const node of layout.nodes) {
      map.set(node.id, { x: node.x, y: node.y });
    }
    return map;
  }, [layout.nodes]);

  const stepMap = useMemo(() => {
    const map = new Map<string, Step>();
    for (const step of steps) {
      // Use the latest step entry per id (steps can appear multiple times for different iterations)
      map.set(step.id, step);
    }
    return map;
  }, [steps]);

  return (
    <svg
      className="wire-layer"
      width={layout.width + 80}
      height={layout.height + 80}
    >
      {layout.edges.map((edge) => {
        const source = nodePositions.get(edge.sourceId);
        const target = nodePositions.get(edge.targetId);
        if (!source || !target) return null;

        const sourceStep = stepMap.get(edge.sourceId);
        const targetStep = stepMap.get(edge.targetId);
        const sourceState = nodeStateFromStep(sourceStep);
        const targetState = nodeStateFromStep(targetStep);

        let wireClass = "wire wire-pending";
        if (sourceState === "done" && targetState === "running") {
          wireClass = "wire wire-active";
        } else if (sourceState === "done") {
          wireClass = "wire wire-done";
        } else if (sourceState === "failed") {
          wireClass = "wire wire-failed";
        }

        const path = computeBezierPath(
          source.x + NODE_WIDTH,
          source.y + NODE_HEIGHT / 2,
          target.x,
          target.y + NODE_HEIGHT / 2,
        );

        return (
          <path
            key={`${edge.sourceId}-${edge.targetId}`}
            className={wireClass}
            d={path}
          />
        );
      })}
    </svg>
  );
}

function LoopBoundary({
  loop,
  iteration,
}: {
  loop: LayoutResult["loops"][number];
  iteration?: number;
}) {
  return (
    <div
      className="loop-boundary"
      style={{
        left: loop.x,
        top: loop.y,
        width: loop.width,
        height: loop.height,
      }}
    >
      <span className="loop-label">
        {loop.label}
        {iteration != null ? ` · iter ${iteration}` : ""}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/client.tsx
git commit -m "feat(dashboard): NodeCard, WireOverlay, and LoopBoundary components"
```

---

### Task 7: App shell — wire everything together

**Files:**

- Modify: `dashboard/client.tsx` (replace placeholder App with final App component)

The App component manages all state: fetches runs list, fetches run detail + graph for the selected run, and renders the Sidebar + Canvas.

- [ ] **Step 1: Replace the placeholder App and render**

Replace the placeholder `App` function and `createRoot` call at the bottom of `client.tsx` with:

```tsx
// ---- App ----

function Canvas({
  detail,
  graph,
}: {
  detail: RunDetailResponse | null;
  graph: GraphResponse | null;
}) {
  const layout = useMemo(() => {
    if (!graph) return null;
    return computeLayout(graph);
  }, [graph]);

  if (!detail || !layout) {
    return (
      <div className="canvas">
        <div className="canvas-empty">
          Select a run to view its workflow graph.
        </div>
      </div>
    );
  }

  const steps = detail.inspect.steps ?? [];
  const loops = detail.inspect.loops ?? [];
  const loopIterationMap = new Map(
    loops.map((loop) => [loop.loopId, loop.iteration]),
  );

  return (
    <div className="canvas">
      <div
        className="graph-container"
        style={{ width: layout.width + 80, height: layout.height + 80 }}
      >
        <WireOverlay layout={layout} steps={steps} />

        {layout.loops.map((loop) => (
          <LoopBoundary
            key={loop.id}
            loop={loop}
            iteration={loopIterationMap.get(loop.id)}
          />
        ))}

        {layout.nodes.map((node) => {
          const step = steps.find((step) => step.id === node.id);
          const loopIteration = node.loopId
            ? loopIterationMap.get(node.loopId)
            : undefined;
          const tokenKey = `${node.id}:${loopIteration ?? 0}`;
          const tokens = detail.tokensByNode[tokenKey];
          // Find latest agent model for this node
          const agentKey = Object.keys(detail.agentByNode)
            .filter((key) => key.startsWith(`${node.id}:`))
            .sort()
            .pop();
          const agentModel = agentKey
            ? detail.agentByNode[agentKey]
            : undefined;

          return (
            <NodeCard
              key={node.id}
              node={node}
              step={step}
              tokens={tokens}
              agentModel={agentModel}
              loopIteration={loopIteration}
            />
          );
        })}
      </div>
    </div>
  );
}

function App() {
  const [repos, setRepos] = useState<RepoGroup[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedWorkflowPath, setSelectedWorkflowPath] = useState<
    string | null
  >(null);
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [error, setError] = useState("");

  // Poll runs list
  useEffect(() => {
    let alive = true;

    const loadRuns = async () => {
      try {
        const data = await fetchJson<RunsResponse>("/api/runs");
        if (!alive) return;
        startTransition(() => {
          setRepos(data.repos);
          setError("");
          // Auto-select first run if none selected
          setSelectedRunId((current) => {
            const allRuns = data.repos.flatMap((repo) => repo.runs);
            if (current && allRuns.some((run) => run.id === current))
              return current;
            return allRuns[0]?.id ?? "";
          });
        });
      } catch (nextError) {
        if (!alive) return;
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    };

    void loadRuns();
    const timer = setInterval(() => void loadRuns(), POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Track selected workflow path when run changes
  useEffect(() => {
    const allRuns = repos.flatMap((repo) => repo.runs);
    const selectedRun = allRuns.find((run) => run.id === selectedRunId);
    setSelectedWorkflowPath(selectedRun?.workflowPath ?? null);
  }, [selectedRunId, repos]);

  // Poll run detail
  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }

    let alive = true;

    const loadDetail = async () => {
      try {
        const data = await fetchJson<RunDetailResponse>(
          `/api/run/${encodeURIComponent(selectedRunId)}`,
        );
        if (!alive) return;
        startTransition(() => {
          setDetail(data);
          setError("");
        });
      } catch (nextError) {
        if (!alive) return;
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    };

    void loadDetail();
    const timer = setInterval(() => void loadDetail(), POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedRunId]);

  // Fetch graph topology (once per workflow, cached server-side)
  useEffect(() => {
    if (!selectedWorkflowPath) {
      setGraph(null);
      return;
    }

    let alive = true;

    const loadGraph = async () => {
      try {
        const data = await fetchJson<GraphResponse>(
          `/api/graph/${encodeURIComponent(selectedWorkflowPath)}`,
        );
        if (!alive) return;
        startTransition(() => setGraph(data));
      } catch (nextError) {
        if (!alive) return;
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    };

    void loadGraph();
    return () => {
      alive = false;
    };
  }, [selectedWorkflowPath]);

  const handleSelectRun = useCallback((id: string) => {
    setSelectedRunId(id);
  }, []);

  const handleToggleCollapse = useCallback(() => {
    setSidebarCollapsed((current) => !current);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar
        repos={repos}
        selectedRunId={selectedRunId}
        onSelectRun={handleSelectRun}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleCollapse}
      />
      {error ? <div className="notice-error">{error}</div> : null}
      <Canvas detail={detail} graph={graph} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 2: Restart the dashboard and verify end-to-end**

Kill any running dashboard and restart:

```bash
bun run dashboard
```

Open `http://127.0.0.1:4311`. Expected:

- Left sidebar shows runs grouped by repo
- Clicking a run loads the node graph on the canvas
- Nodes show status, token counts, agent model
- Wires connect nodes with status-driven colors
- Loop boundaries appear for looping workflows
- Sidebar collapses when clicking the collapse button
- "Hide finished" toggle filters the run list

- [ ] **Step 3: Commit**

```bash
git add dashboard/client.tsx
git commit -m "feat(dashboard): complete app shell wiring sidebar, canvas, and data polling"
```

---

### Task 8: Visual polish and screenshot verification

**Files:**

- Modify: `dashboard/styles.css` (minor tweaks based on visual review)
- Modify: `dashboard/client.tsx` (minor tweaks based on visual review)

Use the preview tool to screenshot the dashboard and fix any visual issues: spacing, alignment, overflow, colors, wire positioning.

- [ ] **Step 1: Start the preview server and take a screenshot**

Ensure the dashboard is running via the Claude Preview tool. Take a screenshot and review:

- Do nodes render at correct positions?
- Do wires connect properly between nodes?
- Does the sidebar collapse/expand work?
- Are status colors correct?
- Does the loop boundary appear?

- [ ] **Step 2: Fix any visual issues found**

Apply CSS or component tweaks. Common things to check:

- Node card overflow (long labels)
- Wire SVG viewport size
- Loop boundary positioning relative to nodes
- Collapsed sidebar dot alignment
- Canvas scroll behavior when graph is large

- [ ] **Step 3: Commit**

```bash
git add dashboard/styles.css dashboard/client.tsx
git commit -m "fix(dashboard): visual polish after screenshot review"
```

---

### Task 9: Final typecheck and lint

**Files:**

- All dashboard files

- [ ] **Step 1: Run typecheck**

```bash
bun run typecheck
```

Expected: No type errors.

- [ ] **Step 2: Run lint**

```bash
bun run lint
```

Expected: No lint errors (or only pre-existing ones).

- [ ] **Step 3: Run formatter**

```bash
bun run format
```

- [ ] **Step 4: Commit any formatting changes**

```bash
git add dashboard/
git commit -m "chore(dashboard): format and lint cleanup"
```
