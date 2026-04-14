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
const GRAPH_MARGIN = 40;
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
        // Only update previousOutputs when childOutputs is non-empty.
        // Empty branches/conditionals should not break the chain.
        if (childOutputs.length > 0) {
          previousOutputs = childOutputs;
        }
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
        x: col * (NODE_WIDTH + GAP_X) + GRAPH_MARGIN,
        y: row * (NODE_HEIGHT + GAP_Y) + GRAPH_MARGIN,
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

  const totalWidth =
    (maxCol + 1) * (NODE_WIDTH + GAP_X) - GAP_X + GRAPH_MARGIN * 2;
  const totalHeight =
    (maxRow + 1) * (NODE_HEIGHT + GAP_Y) - GAP_Y + GRAPH_MARGIN * 2;

  return {
    nodes: layoutNodes,
    edges,
    loops: loopBounds,
    width: totalWidth,
    height: totalHeight,
  };
}

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
    const stateRank = (state?: string) => {
      if (!state || state === "pending") return 0;
      if (state.startsWith("waiting")) return 1;
      if (state === "running" || state === "in-progress") return 2;
      if (state === "finished") return 3;
      if (state === "failed") return 3;
      return 0;
    };
    for (const step of steps) {
      const existing = map.get(step.id);
      // Keep the most advanced state (finished/running over pending)
      if (!existing || stateRank(step.state) > stateRank(existing.state)) {
        map.set(step.id, step);
      }
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
        style={{ width: layout.width, height: layout.height }}
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
