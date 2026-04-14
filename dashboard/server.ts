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
  input_payload: string | null;
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

const STALE_HEARTBEAT_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function queryAllRuns(): RunRow[] {
  const db = openDatabase();
  try {
    const nowMs = Date.now();
    // Exclude "running" rows with a stale heartbeat — these are
    // continued-as-new predecessors that smithers never marked finished.
    return db
      .query(
        `SELECT r.run_id, r.workflow_name, r.workflow_path, r.status,
                r.vcs_root, r.created_at_ms, r.started_at_ms,
                r.finished_at_ms, i.payload AS input_payload
         FROM _smithers_runs r
         LEFT JOIN input i ON i.run_id = r.run_id
         WHERE NOT (
           r.status = 'running'
           AND r.heartbeat_at_ms IS NOT NULL
           AND r.heartbeat_at_ms < ?
         )
         ORDER BY r.created_at_ms DESC`,
      )
      .all(nowMs - STALE_HEARTBEAT_THRESHOLD_MS) as RunRow[];
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

    // Parse input payload to extract useful context (e.g. target repo, PR)
    let inputContext: Record<string, string> | undefined;
    if (row.input_payload) {
      try {
        inputContext = JSON.parse(row.input_payload);
      } catch {
        // Ignore invalid JSON
      }
    }

    repoMap.get(repoPath)!.runs.push({
      id: row.run_id,
      workflow: row.workflow_name,
      workflowPath: row.workflow_path,
      status: row.status,
      startedAtMs: row.started_at_ms,
      elapsedMs: row.started_at_ms
        ? (row.finished_at_ms ?? nowMs) - row.started_at_ms
        : null,
      finishedAtMs: row.finished_at_ms,
      input: inputContext,
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
