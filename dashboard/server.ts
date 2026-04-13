import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const indexPath = join(root, "index.html");
const smithersBin = join(process.cwd(), "node_modules", ".bin", "smithers");

type Json = Record<string, unknown>;

async function runSmithers(args: string[]) {
  const proc = Bun.spawn({
    cmd: [smithersBin, ...args, "--format", "json"],
    cwd: process.cwd(),
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

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function errorResponse(error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, status);
}

function activeStatus(status: string) {
  return [
    "running",
    "waiting-timer",
    "waiting-event",
    "waiting-approval",
  ].includes(status);
}

const server = Bun.serve({
  port: Number(process.env.PORT || 4311),
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(await readFile(indexPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/runs") {
      try {
        const runs = (await withRetry(() => runSmithers(["ps"]))) as {
          runs?: Array<Record<string, unknown>>;
        };
        const items = (runs.runs ?? []).map((run) => ({
          ...run,
          isActive: activeStatus(String(run.status ?? "")),
        }));
        return json({ runs: items, now: new Date().toISOString() });
      } catch (error) {
        return errorResponse(error);
      }
    }

    const match = url.pathname.match(/^\/api\/run\/([^/]+)$/);
    if (match) {
      const runId = decodeURIComponent(match[1]);
      try {
        const inspect = await withRetry(() => runSmithers(["inspect", runId]));
        const why = await withRetry(() => runSmithers(["why", runId]));
        return json({ inspect, why, now: new Date().toISOString() });
      } catch (error) {
        return errorResponse(error);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Smithers dashboard listening on http://127.0.0.1:${server.port}`);
