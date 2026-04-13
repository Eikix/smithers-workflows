// smithers-source: custom
// smithers-display-name: CI Watch Babysit
/** @jsxImportSource smithers-orchestrator */
import {
  Branch,
  Loop,
  Sequence,
  Task,
  Timer,
  createSmithers,
} from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "~/agents";
import FixPrompt from "~/.smithers/prompts/ci-fix.mdx";
import ObservePrompt from "~/.smithers/prompts/ci-observe.mdx";
import RerunPrompt from "~/.smithers/prompts/ci-rerun.mdx";

const inspectionSchema = z.object({
  status: z.enum(["queued", "in_progress", "completed", "unknown"]),
  conclusion: z.string().nullable().default(null),
  classification: z.enum([
    "green",
    "running",
    "infra",
    "deterministic",
    "blocked",
    "unknown",
  ]),
  failedJobs: z.array(z.string()).default([]),
  summary: z.string(),
});

const fixSchema = z.object({
  changedFiles: z.array(z.string()).default([]),
  summary: z.string(),
});

const rerunSchema = z.object({
  rerunTriggered: z.boolean(),
  summary: z.string(),
});

const reportSchema = z.object({
  outcome: z.enum(["green", "blocked", "unknown"]),
  iterations: z.number(),
  summary: z.string(),
});

const { Workflow, smithers, outputs } = createSmithers({
  inspection: inspectionSchema,
  fix: fixSchema,
  rerun: rerunSchema,
  report: reportSchema,
});

function backoffForIteration(iteration: number) {
  if (iteration <= 0) return null;
  if (iteration === 1) return "30s";
  if (iteration === 2) return "2m";
  if (iteration <= 4) return "10m";
  return "30m";
}

export default smithers((ctx) => {
  const run = String(ctx.input.run ?? "");
  const repo = String(ctx.input.repo ?? "");
  const inspection = ctx.latest("inspection", "inspect");
  const classification = inspection?.classification ?? "unknown";
  const waitDuration = backoffForIteration(ctx.iteration);
  const done =
    classification === "green" ||
    classification === "blocked" ||
    classification === "unknown";

  return (
    <Workflow name="ci-watch-babysit">
      <Loop
        id="watch"
        until={done}
        maxIterations={1000}
        continueAsNewEvery={100}
        onMaxReached="return-last"
      >
        <Sequence>
          {waitDuration ? <Timer id="backoff" duration={waitDuration} /> : null}

          <Task
            id="inspect"
            output={outputs.inspection}
            agent={agents.smartTool}
          >
            <ObservePrompt run={run} repo={repo} />
          </Task>

          <Branch
            if={classification === "deterministic"}
            then={
              <Sequence>
                <Task id="fix" output={outputs.fix} agent={agents.smartTool}>
                  <FixPrompt
                    run={run}
                    repo={repo}
                    summary={inspection?.summary ?? ""}
                  />
                </Task>
                <Task
                  id="rerun-after-fix"
                  output={outputs.rerun}
                  agent={agents.smartTool}
                >
                  <RerunPrompt
                    run={run}
                    repo={repo}
                    reason="Deterministic failure was fixed."
                  />
                </Task>
              </Sequence>
            }
            else={
              classification === "infra" ? (
                <Task
                  id="rerun-infra"
                  output={outputs.rerun}
                  agent={agents.smartTool}
                >
                  <RerunPrompt
                    run={run}
                    repo={repo}
                    reason="Infra-classified failure."
                  />
                </Task>
              ) : null
            }
          />
        </Sequence>
      </Loop>

      <Task id="report" output={outputs.report}>
        {{
          outcome:
            classification === "green"
              ? "green"
              : classification === "blocked"
                ? "blocked"
                : "unknown",
          iterations: ctx.iterationCount("inspection", "inspect") ?? 0,
          summary:
            inspection?.summary ??
            "CI watch ended without a terminal inspection summary.",
        }}
      </Task>
    </Workflow>
  );
});
