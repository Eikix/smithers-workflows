const SESSION =
  process.env.SMITHERS_SUPERVISOR_SESSION ?? "smithers-supervisor";
const INTERVAL = process.env.SMITHERS_SUPERVISOR_INTERVAL ?? "10s";
const STALE_THRESHOLD =
  process.env.SMITHERS_SUPERVISOR_STALE_THRESHOLD ?? "30s";

const ACTIVE_STATUSES = new Set([
  "running",
  "waiting-timer",
  "waiting-event",
  "waiting-approval",
]);

type RunList = {
  runs?: Array<{
    id: string;
    workflow: string;
    status: string;
    step?: string;
  }>;
};

async function sh(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    cwd: "/Users/work/code/smithers-workflows",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, code };
}

async function ensureTmux() {
  const result = await sh(["tmux", "-V"]);
  if (result.code !== 0) {
    throw new Error("tmux is required but not available");
  }
}

async function hasSession() {
  const result = await sh(["tmux", "has-session", "-t", SESSION]);
  return result.code === 0;
}

async function getRuns(): Promise<RunList> {
  const result = await sh([
    "./node_modules/.bin/smithers",
    "ps",
    "--format",
    "json",
  ]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "failed to list Smithers runs",
    );
  }
  return JSON.parse(result.stdout) as RunList;
}

async function start() {
  await ensureTmux();
  if (await hasSession()) {
    console.log(`supervisor already running in tmux session ${SESSION}`);
    return;
  }

  const cmd = [
    "tmux",
    "new",
    "-d",
    "-s",
    SESSION,
    `cd /Users/work/code/smithers-workflows && ./node_modules/.bin/smithers supervise --interval ${INTERVAL} --stale-threshold ${STALE_THRESHOLD}`,
  ];
  const result = await sh(cmd);
  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "failed to start supervisor",
    );
  }
  console.log(`started tmux session ${SESSION}`);
}

async function status() {
  const runs = await getRuns();
  const activeRuns = (runs.runs ?? []).filter((run) =>
    ACTIVE_STATUSES.has(run.status),
  );
  console.log(
    JSON.stringify(
      {
        session: SESSION,
        tmuxRunning: await hasSession(),
        activeRuns: activeRuns.map((run) => ({
          id: run.id,
          workflow: run.workflow,
          status: run.status,
          step: run.step ?? null,
        })),
      },
      null,
      2,
    ),
  );
}

async function stopIfIdle() {
  const sessionExists = await hasSession();
  if (!sessionExists) {
    console.log(`tmux session ${SESSION} is not running`);
    return;
  }

  const runs = await getRuns();
  const activeRuns = (runs.runs ?? []).filter((run) =>
    ACTIVE_STATUSES.has(run.status),
  );
  if (activeRuns.length > 0) {
    console.log(
      `supervisor left running; active runs: ${activeRuns
        .map((run) => `${run.id}:${run.status}`)
        .join(", ")}`,
    );
    return;
  }

  const result = await sh(["tmux", "kill-session", "-t", SESSION]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || "failed to stop supervisor",
    );
  }
  console.log(`stopped tmux session ${SESSION}`);
}

const command = Bun.argv[2];

try {
  if (command === "start") {
    await start();
  } else if (command === "status") {
    await status();
  } else if (command === "stop-if-idle") {
    await stopIfIdle();
  } else {
    console.error(
      "usage: bun run scripts/supervisor.ts <start|status|stop-if-idle>",
    );
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
