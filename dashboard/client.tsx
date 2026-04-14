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
