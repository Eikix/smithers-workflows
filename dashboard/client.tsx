/** @jsxImportSource react */
import { startTransition, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Run = {
  id?: string;
  workflow?: string;
  status?: string;
  started?: string;
  step?: string;
  isActive?: boolean;
};

type RunsResponse = {
  runs?: Run[];
  now?: string;
};

type Step = {
  id?: string;
  state?: string;
  label?: string;
  attempt?: number;
  output?: unknown;
};

type LoopState = {
  loopId?: string;
  iteration?: number;
};

type TimerState = {
  timerId?: string;
  remaining?: string;
  firesAt?: string;
};

type InspectResponse = {
  inspect?: {
    run?: {
      id?: string;
      workflow?: string;
      status?: string;
      started?: string;
      elapsed?: string;
      input?: Record<string, unknown>;
    };
    steps?: Step[];
    loops?: LoopState[];
    timers?: TimerState[];
  };
  why?: {
    summary?: string;
    currentNodeId?: string;
    blockers?: Array<{
      kind?: string;
      reason?: string;
      context?: string;
    }>;
  };
  now?: string;
};

async function fetchJson<T>(path: string) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function statusTone(status?: string) {
  if (!status) return "tone-neutral";
  if (
    ["running", "waiting-timer", "waiting-event", "waiting-approval"].includes(
      status,
    )
  )
    return "tone-live";
  if (["finished", "success", "completed"].includes(status)) return "tone-good";
  if (["failed", "cancelled", "blocked"].includes(status)) return "tone-bad";
  return "tone-warn";
}

function prettyJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [detail, setDetail] = useState<InspectResponse | null>(null);
  const [updatedAt, setUpdatedAt] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    const loadRuns = async () => {
      try {
        const data = await fetchJson<RunsResponse>("/api/runs");
        if (!alive) return;
        startTransition(() => {
          const nextRuns = data.runs ?? [];
          setRuns(nextRuns);
          setUpdatedAt(data.now ?? new Date().toISOString());
          setSelectedRunId((current) => {
            if (current && nextRuns.some((run) => run.id === current)) {
              return current;
            }
            return nextRuns[0]?.id ?? "";
          });
          setError("");
        });
      } catch (nextError) {
        if (!alive) return;
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    };

    void loadRuns();
    const timer = window.setInterval(() => {
      void loadRuns();
    }, 5000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }

    let alive = true;

    const loadDetail = async () => {
      try {
        const data = await fetchJson<InspectResponse>(
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
    const timer = window.setInterval(() => {
      void loadDetail();
    }, 5000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [selectedRunId]);

  const run = detail?.inspect?.run;
  const blocker = detail?.why?.blockers?.[0];
  const steps = detail?.inspect?.steps ?? [];
  const loops = detail?.inspect?.loops ?? [];
  const timer = detail?.inspect?.timers?.[0];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div>
            <p className="eyebrow">Runtime</p>
            <h1>Smithers runs</h1>
          </div>
          <p className="meta-text">{updatedAt}</p>
        </div>

        {error ? <div className="notice notice-bad">{error}</div> : null}

        <div className="run-list">
          {runs.map((runItem) => {
            const id = runItem.id ?? "";
            const active = id === selectedRunId;
            return (
              <button
                key={id}
                className={`run-card${active ? " active" : ""}`}
                onClick={() => setSelectedRunId(id)}
                type="button"
              >
                <div className="run-card-top">
                  <strong>{runItem.workflow ?? "workflow"}</strong>
                  <span className={`pill ${statusTone(runItem.status)}`}>
                    {runItem.status ?? "unknown"}
                  </span>
                </div>
                <p className="run-id">{id}</p>
                <p className="meta-text">{runItem.step ?? "no active step"}</p>
                <p className="meta-text">
                  {runItem.started ?? "no start time"}
                </p>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="main">
        <section className="hero panel">
          <div>
            <p className="eyebrow">Selected run</p>
            <h2>{run?.workflow ?? "No run selected"}</h2>
            <p className="meta-text">
              {run?.id ?? "Choose a run from the left."}
            </p>
          </div>
          <div className="pill-row">
            <span className={`pill ${statusTone(run?.status)}`}>
              {run?.status ?? "idle"}
            </span>
            {blocker?.kind ? (
              <span className="pill tone-neutral">{blocker.kind}</span>
            ) : null}
          </div>
        </section>

        <section className="overview-grid">
          <article className="panel">
            <p className="eyebrow">Loop state</p>
            {loops.length ? (
              <div className="facts">
                {loops.map((loop) => (
                  <div key={loop.loopId ?? "loop"} className="fact">
                    <span>{loop.loopId ?? "loop"}</span>
                    <strong>iteration {loop.iteration ?? 0}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="meta-text">No loop metadata.</p>
            )}
          </article>

          <article className="panel">
            <p className="eyebrow">Blocker</p>
            <h3>{detail?.why?.summary ?? "No blocker summary"}</h3>
            <p className="meta-text">
              {detail?.why?.currentNodeId ?? "No current node"}
            </p>
          </article>

          <article className="panel">
            <p className="eyebrow">Timer</p>
            <pre className="code-block">
              {prettyJson(timer ?? { state: "no timer active" })}
            </pre>
          </article>
        </section>

        <section className="panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Execution path</p>
              <h3>Steps</h3>
            </div>
          </div>
          <div className="step-grid">
            {steps.length ? (
              steps.map((step, index) => (
                <article
                  key={`${step.id ?? "step"}-${index}`}
                  className={`step-card ${statusTone(step.state)}`}
                >
                  <div className="step-top">
                    <strong>{step.label ?? step.id ?? "step"}</strong>
                    <span className="step-type">
                      attempt {step.attempt ?? 0}
                    </span>
                  </div>
                  <p className="meta-text">{step.state ?? "unknown"}</p>
                  {step.output ? (
                    <pre className="code-block">{prettyJson(step.output)}</pre>
                  ) : null}
                </article>
              ))
            ) : (
              <div className="empty-state">No step data yet.</div>
            )}
          </div>
        </section>

        <section className="panel">
          <p className="eyebrow">Why</p>
          <pre className="code-block">{prettyJson(detail?.why ?? {})}</pre>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
