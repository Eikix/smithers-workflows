// smithers-source: custom
// smithers-display-name: CI Babysit
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, Task, Sequence } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "~/agents";
import ObservePrompt from "~/.smithers/prompts/ci-observe.mdx";
import FixPrompt from "~/.smithers/prompts/ci-fix.mdx";
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
  action: z.enum(["none", "rerun", "fix-and-rerun", "blocked"]),
  summary: z.string(),
});

const { Workflow, smithers, outputs } = createSmithers({
  inspection: inspectionSchema,
  fix: fixSchema,
  rerun: rerunSchema,
  report: reportSchema,
});

export default smithers((ctx) => {
  const run = String(ctx.input.run ?? "");
  const repo = String(ctx.input.repo ?? "");
  const inspection = ctx.outputMaybe("inspection", { nodeId: "inspect" });
  const classification = inspection?.classification ?? "unknown";
  const needsFix = classification === "deterministic";
  const needsRerun = classification === "infra" || needsFix;

  return (
    <Workflow name="ci-babysit">
      <Sequence>
        <Task id="inspect" output={outputs.inspection} agent={agents.smartTool}>
          <ObservePrompt run={run} repo={repo} />
        </Task>

        {needsFix ? (
          <Task id="fix" output={outputs.fix} agent={agents.smartTool}>
            <FixPrompt
              run={run}
              repo={repo}
              summary={inspection?.summary ?? ""}
            />
          </Task>
        ) : null}

        {needsRerun ? (
          <Task id="rerun" output={outputs.rerun} agent={agents.smartTool}>
            <RerunPrompt
              run={run}
              repo={repo}
              reason={
                classification === "infra"
                  ? "Infra-classified failure."
                  : "Deterministic failure was fixed."
              }
            />
          </Task>
        ) : null}

        <Task id="report" output={outputs.report}>
          {{
            action:
              classification === "green" || classification === "running"
                ? "none"
                : classification === "blocked"
                  ? "blocked"
                  : needsFix
                    ? "fix-and-rerun"
                    : "rerun",
            summary:
              inspection?.summary ??
              "Run inspection did not produce a summary.",
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
